#!/usr/bin/env python3
"""
WOS Orchestrator Dataset Generator
===================================
Generates Qwen3-32B-compatible JSONL fine-tuning trajectories using NVIDIA NIM.

Methodology
-----------
ToolFlow  – graph-based workflow motifs group tools that logically connect
            instead of sampling them at random.
ToolWeave – two-phase scaffolding (plan → execute) plus 15% error-injection
            trajectories to train robust recovery behaviour.
Coverage  – each record index deterministically picks (motif, scenario_seed) in
            round-robin so ~6–8k runs spread evenly across many user intents
            instead of collapsing on a few duplicated templates.

Output format
-------------
Each line is a JSON object with:
  id          – UUID4
  metadata    – motif, apps, error_injected, difficulty, policy_tags,
                split (train | validation | blind_test via stable hash of motif+scenario)
  messages    – Qwen3 chat messages array; assistant turns include
                reasoning_content (maps to <think> block) + optional tool_calls

Usage
-----
  python generate_dataset.py                          # 6 500 records, default model
  python generate_dataset.py --count 8000 --workers 64
  python generate_dataset.py --model nemotron        # explicit model choice
  python generate_dataset.py --out my_dataset.jsonl  # custom output path
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path
from typing import Any

from orchestration_splits import orchestration_split

# ---------------------------------------------------------------------------
# Dependency check
# ---------------------------------------------------------------------------
try:
    from openai import OpenAI, RateLimitError, APIStatusError
except ImportError:
    sys.exit("openai package is required.  Run: pip install openai")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parent.parent
NV_KEY_FILE = REPO_ROOT / "nv-key"
DEFAULT_OUTPUT = REPO_ROOT / "training-data/orchestration/qwen3_orchestrator_nim_batch.jsonl"
RUNTIME_TOOL_NAME_RE = re.compile(r"name:\s*'([A-Za-z0-9_-]+)'")

# ---------------------------------------------------------------------------
# NIM configuration
# ---------------------------------------------------------------------------
NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"

# Exact NVIDIA NIM catalog IDs — update if the catalog changes.
NIM_MODELS: dict[str, str] = {
    "deepseek-flash": "deepseek-ai/deepseek-v4-flash",
    "llama": "meta/llama-3.3-70b-instruct",
    "nemotron-super": "nvidia/nemotron-3-super-120b-a12b",
    "gemma-4-31b": "google/gemma-4-31b-it",
    "qwen-coder-moe": "qwen/qwen3-coder-480b-a35b-instruct",
}

DEFAULT_MODEL_KEY = "deepseek-flash"
DEFAULT_COUNT = 5_200
ERROR_INJECTION_RATE = 0.15   # 15 % of trajectories get a simulated tool error
# Frontier-alignment augmentation: add some long-horizon trajectories that include
# ambiguity + revisions + extra constraints delivered via AskUser tool replies.
LONG_HORIZON_RATE = 0.12
MAX_RETRIES = 5
RETRY_BACKOFF_BASE = 3.0      # seconds; exponential
MAX_WORKERS = 64              # default workers for NIM pools; use --workers 0 for auto
KEY_MIN_GAP = 1.6             # minimum seconds between consecutive calls on the same NIM key
AUTO_WORKERS_MAX = 64        # safety cap for auto worker selection
RECORD_MAX_ATTEMPTS = 3       # retries inside a worker before returning a failed status
MAX_SLOT_RETRIES = 20          # retries for a target output slot before aborting generation
PLAN_TEMPERATURE = 0.35       # lower randomness improves deterministic step formatting
TRAJECTORY_TEMPERATURE = 0.58 # slight lift for lexical diversity; keep below ~0.65 for JSON safety
MIN_MODEL_SHARE = 0.08        # each model gets at least this share of issued attempts

# ---------------------------------------------------------------------------
# Load NIM API keys (round-robin across all keys in nv-key)
# ---------------------------------------------------------------------------
def load_nim_keys() -> list[str]:
    if NV_KEY_FILE.exists():
        raw = NV_KEY_FILE.read_text(encoding="utf-8")
        keys = [line.strip() for line in raw.splitlines() if line.strip().startswith("nvapi-")]
        if keys:
            return keys
    env_key = os.environ.get("NVIDIA_NIM_API_KEY", "").strip()
    if env_key:
        return [env_key]
    sys.exit(
        f"No NIM API key found.\n"
        f"  • Add keys to {NV_KEY_FILE}\n"
        f"  • or set NVIDIA_NIM_API_KEY environment variable."
    )


class IndependentKeyManager:
    def __init__(self, keys: list[str], min_gap: float = KEY_MIN_GAP) -> None:
        self._keys = keys
        self._min_gap = min_gap
        self._locks = [threading.Lock() for _ in keys]
        self._next_allowed = [0.0 for _ in keys]
        self._clients: dict[str, OpenAI] = {}
        self._client_lock = threading.Lock()

    def acquire_key_for_slot(self, slot_idx: int) -> tuple[str, int]:
        ki = slot_idx % len(self._keys)
        with self._locks[ki]:
            now = time.time()
            wait = max(0.0, self._next_allowed[ki] - now)
            self._next_allowed[ki] = now + wait + self._min_gap
            
        if wait > 2.0:
            print(f"  [queue] slot {slot_idx} waiting {wait:.1f}s for key {ki} to unlock...", flush=True)
            
        if wait > 0:
            time.sleep(wait)
            
        return self._keys[ki], ki

    def report_429(self, ki: int, backoff_seconds: float) -> None:
        with self._locks[ki]:
            self._next_allowed[ki] = max(self._next_allowed[ki], time.time() + backoff_seconds)

    def make_client(self, key: str) -> OpenAI:
        with self._client_lock:
            client = self._clients.get(key)
            if client is None:
                client = OpenAI(base_url=NIM_BASE_URL, api_key=key)
                self._clients[key] = client
            return client


def _initial_model_latency_hint(model: str) -> float:
    """Best-effort initial latency hint in seconds for adaptive scheduling."""
    m = model.lower()
    if "flash" in m:
        return 8.0
    if "70b" in m:
        return 14.0
    if "120b" in m or "122b" in m or "k2" in m:
        return 18.0
    if "pro" in m or "405b" in m or "671b" in m or "r1" in m:
        return 30.0
    return 20.0


class ModelRotator:
    """Adaptive model scheduler with minimum-share guarantees for slower models."""

    def __init__(self, models: list[str], min_share: float = MIN_MODEL_SHARE) -> None:
        if not models:
            raise ValueError("ModelRotator requires at least one model.")
        if min_share < 0.0 or min_share >= 1.0:
            raise ValueError("min_share must be in [0.0, 1.0).")
        if min_share * len(models) >= 1.0:
            raise ValueError(
                f"min_share={min_share} is too high for {len(models)} models; reduce it below {1.0/len(models):.4f}."
            )
        self._models = models
        self._min_share = min_share
        self._lock = threading.Lock()
        self._total_issued = 0
        self._stats = {
            m: {
                "issued": 0,
                "completed": 0,
                "failed": 0,
                "in_flight": 0,
                "ema_latency": _initial_model_latency_hint(m),
            }
            for m in models
        }

    def next(self) -> str:
        """Pick a model by adaptive speed score while honoring min-share guarantees."""
        with self._lock:
            next_total = self._total_issued + 1
            under_target = [
                m for m in self._models
                if self._stats[m]["issued"] < (next_total * self._min_share)
            ]
            candidates = under_target if under_target else self._models

            def score(model: str) -> tuple[float, int]:
                st = self._stats[model]
                projected = st["ema_latency"] * (st["in_flight"] + 1)
                return projected, st["issued"]

            model = min(candidates, key=score)
            st = self._stats[model]
            st["issued"] += 1
            st["in_flight"] += 1
            self._total_issued += 1
            return model

    def report_result(self, model: str, elapsed_s: float, ok: bool) -> None:
        """Report latency/outcome so future scheduling adapts to real model speed."""
        with self._lock:
            st = self._stats.get(model)
            if not st:
                return
            if st["in_flight"] > 0:
                st["in_flight"] -= 1
            if ok:
                st["completed"] += 1
            else:
                st["failed"] += 1
            alpha = 0.20
            elapsed = max(0.1, elapsed_s)
            st["ema_latency"] = max(0.5, (1.0 - alpha) * st["ema_latency"] + alpha * elapsed)

    def summary(self) -> dict[str, dict[str, float]]:
        with self._lock:
            total_issued = max(1, self._total_issued)
            return {
                model: {
                    "issued": float(st["issued"]),
                    "completed": float(st["completed"]),
                    "failed": float(st["failed"]),
                    "in_flight": float(st["in_flight"]),
                    "ema_latency": float(st["ema_latency"]),
                    "share": float(st["issued"] / total_issued),
                }
                for model, st in self._stats.items()
            }


def compute_auto_workers(
    key_count: int,
    models: list[str],
    min_model_share: float,
    key_min_gap: float,
) -> int:
    """Estimate workers needed to keep key rate saturated under model latency."""
    if key_count <= 0:
        return 4
    hints = [_initial_model_latency_hint(m) for m in models] if models else [20.0]
    avg_hint = sum(hints) / max(1, len(hints))
    max_hint = max(hints)
    # Blend average and tail latency because some slow models are intentionally retained.
    blended_latency = (0.65 * avg_hint) + (0.35 * max_hint)
    # Increase estimate when non-trivial minimum share is reserved for slower models.
    share_penalty = 1.0 + min(0.6, min_model_share * max(1, len(models)) * 1.5)
    target_rps = key_count / max(0.1, key_min_gap)
    estimate = math.ceil(target_rps * blended_latency * 0.8 * share_penalty)
    return max(key_count * 4, min(AUTO_WORKERS_MAX, estimate))


@lru_cache(maxsize=1)
def load_runtime_tool_names() -> frozenset[str]:
    names: set[str] = set()
    source_dirs = [REPO_ROOT / "electron" / "main" / "tools", REPO_ROOT / "electron" / "main" / "apps"]
    for source_dir in source_dirs:
        if not source_dir.exists():
            continue
        for path in source_dir.rglob("*.ts"):
            if source_dir.name == "apps" and path.name != "tools.ts":
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            names.update(RUNTIME_TOOL_NAME_RE.findall(text))
    return frozenset(names)


@lru_cache(maxsize=1)
def allowed_tool_names() -> frozenset[str]:
    allowed = frozenset(TOOL_SCHEMAS.keys())
    runtime = load_runtime_tool_names()
    stale = sorted(allowed - runtime)
    if stale:
        raise RuntimeError(
            "TOOL_SCHEMAS drift from runtime registry; update the generator before creating more data: "
            + ", ".join(stale[:20])
        )
    return allowed


# ---------------------------------------------------------------------------
# Exact tool schemas extracted from the runtime source files:
#   electron/main/tools/askUser.ts
#   electron/main/tools/subAgent.ts
#   electron/main/tools/automations.ts
#   electron/main/apps/slack/tools.ts
#   electron/main/apps/github/tools.ts
#   electron/main/apps/jira/tools.ts
#   electron/main/apps/google/tools.ts
# ---------------------------------------------------------------------------
TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    # ── Core ────────────────────────────────────────────────────────────────
    "AskUser": {
        "name": "AskUser",
        "description": (
            "Pause execution and ask the user a question. The agent waits for the response before continuing.\n\n"
            "Render kinds (declare with `kind`):\n"
            "  • text     — free-form text input (default).\n"
            "  • choice   — pick one of `choices`. Set `allowFreeform:true` to also accept typed input.\n"
            "  • confirm  — yes/no confirmation. Returns \"yes\" | \"no\".\n"
            "  • fileDrop — drop one or more files inline. `accept` filters file types.\n"
            "  • picker   — pick from a list. Either set `source` (built-in: channel|repo|meeting|calendar) "
            "OR pass `pickerChoices:[{id,label,description?},…]` you fetched yourself. Set `allowFreeform:true` "
            "to accept a typed custom value too. Returns selected id(s).\n"
            "  • form     — multi-field form using `fields`. Returns JSON {key:value,…}.\n\n"
            "PREFERRED PATTERN for resource selection: call the listing tool first, then pass results as "
            "`pickerChoices` with `allowFreeform:true`."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["question"],
            "properties": {
                "question": {"type": "string", "description": "The question or prompt shown to the user."},
                "kind": {
                    "type": "string",
                    "enum": ["text", "choice", "confirm", "fileDrop", "picker", "form"],
                    "description": "Render kind.",
                },
                "choices": {"type": "array", "items": {"type": "string"}, "description": "For kind=choice: quick-reply options."},
                "allowFreeform": {"type": "boolean", "description": "For kind=choice or kind=picker: also allow a typed custom answer."},
                "accept": {"type": "array", "items": {"type": "string"}, "description": "For kind=fileDrop: accepted file types."},
                "source": {
                    "type": "string",
                    "enum": ["channel", "repo", "meeting", "calendar"],
                    "description": "For kind=picker: built-in snapshot-backed source. Omit when supplying pickerChoices directly.",
                },
                "pickerChoices": {
                    "type": "array",
                    "description": "For kind=picker: inline list of options the agent already fetched. Overrides source.",
                    "items": {
                        "type": "object",
                        "required": ["id", "label"],
                        "properties": {
                            "id": {"type": "string"},
                            "label": {"type": "string"},
                            "description": {"type": "string"},
                        },
                    },
                },
                "multi": {"type": "boolean", "description": "For kind=picker: allow multi-select."},
                "fields": {
                    "type": "array",
                    "description": "For kind=form: field schema.",
                    "items": {
                        "type": "object",
                        "required": ["key", "label", "type"],
                        "properties": {
                            "key": {"type": "string"},
                            "label": {"type": "string"},
                            "type": {"type": "string", "enum": ["text", "textarea", "number", "boolean"]},
                            "placeholder": {"type": "string"},
                            "required": {"type": "boolean"},
                        },
                    },
                },
            },
        },
    },
    "Task": {
        "name": "Task",
        "description": (
            "Spawn a subagent to handle a specific task. The subagent has its own context and tools. "
            "Use for parallelizable or complex subtasks. Set `fork: true` to inherit parent context "
            "for prefix cache reuse (recommended for tightly-coupled subtasks)."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["description", "prompt"],
            "properties": {
                "description": {"type": "string", "description": "Brief description of what this subagent will do."},
                "prompt": {"type": "string", "description": "Detailed instructions for the subagent."},
                "preset": {"type": "string", "description": "Optional preset agent key, e.g. \"meeting\" or \"projects\"."},
                "presetKey": {"type": "string", "description": "Alias for preset."},
                "fork": {"type": "boolean", "description": "If true, inherit parent conversation context (cache-efficient)."},
            },
        },
    },

    # ── Slack ────────────────────────────────────────────────────────────────
    "SlackSendMessage": {
        "name": "SlackSendMessage",
        "description": "Send a message to a Slack channel, DM, or thread. Use channel ID or `#channel-name`.",
        "inputSchema": {
            "type": "object",
            "required": ["channel", "text"],
            "properties": {
                "channel": {"type": "string", "description": "Channel ID (preferred) or #channel-name or user ID for DMs."},
                "text": {"type": "string", "description": "Message text (mrkdwn supported)."},
                "thread_ts": {"type": "string", "description": "Optional parent message ts to reply in thread."},
            },
        },
    },
    "SlackListChannels": {
        "name": "SlackListChannels",
        "description": "List Slack channels (public + private + DMs) the bot can see.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "types": {
                    "type": "string",
                    "description": "Comma-separated: public_channel,private_channel,mpim,im",
                    "default": "public_channel,private_channel",
                },
                "limit": {"type": "number", "default": 100},
            },
        },
    },
    "SlackSearchMessages": {
        "name": "SlackSearchMessages",
        "description": "Search Slack messages (requires user token). Slack search query syntax supported.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string"},
                "count": {"type": "number", "default": 20},
            },
        },
    },
    "SlackGetChannelHistory": {
        "name": "SlackGetChannelHistory",
        "description": "Fetch recent messages from a channel.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["channel"],
            "properties": {
                "channel": {"type": "string"},
                "limit": {"type": "number", "default": 50},
                "oldest": {"type": "string", "description": "Optional unix ts (inclusive)."},
            },
        },
    },
    "SlackGetUserInfo": {
        "name": "SlackGetUserInfo",
        "description": "Look up a Slack user by ID.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["user"],
            "properties": {
                "user": {"type": "string"},
            },
        },
    },
    "SlackUploadFile": {
        "name": "SlackUploadFile",
        "description": "Upload a text snippet as a file into a channel.",
        "inputSchema": {
            "type": "object",
            "required": ["channels", "content", "filename"],
            "properties": {
                "channels": {"type": "string", "description": "Comma-separated channel IDs."},
                "content": {"type": "string", "description": "File content (text)."},
                "filename": {"type": "string"},
                "title": {"type": "string"},
                "initial_comment": {"type": "string"},
            },
        },
    },
    "SlackCreateChannel": {
        "name": "SlackCreateChannel",
        "description": "Create a new public or private channel.",
        "inputSchema": {
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": {"type": "string"},
                "is_private": {"type": "boolean", "default": False},
            },
        },
    },
    "SlackReactToMessage": {
        "name": "SlackReactToMessage",
        "description": "Add an emoji reaction to a message.",
        "inputSchema": {
            "type": "object",
            "required": ["channel", "timestamp", "name"],
            "properties": {
                "channel": {"type": "string"},
                "timestamp": {"type": "string"},
                "name": {"type": "string", "description": "Emoji name without colons (e.g. \"thumbsup\")."},
            },
        },
    },
    "SlackUpdateMessage": {
        "name": "SlackUpdateMessage",
        "description": "Edit a previously sent message by ts.",
        "inputSchema": {
            "type": "object",
            "required": ["channel", "ts", "text"],
            "properties": {
                "channel": {"type": "string"},
                "ts": {"type": "string"},
                "text": {"type": "string"},
            },
        },
    },
    "SlackDeleteMessage": {
        "name": "SlackDeleteMessage",
        "description": "Delete a message.",
        "inputSchema": {
            "type": "object",
            "required": ["channel", "ts"],
            "properties": {
                "channel": {"type": "string"},
                "ts": {"type": "string"},
            },
        },
    },
    "SlackStartThread": {
        "name": "SlackStartThread",
        "description": "Reply to a message to start/continue a thread.",
        "inputSchema": {
            "type": "object",
            "required": ["channel", "thread_ts", "text"],
            "properties": {
                "channel": {"type": "string"},
                "thread_ts": {"type": "string", "description": "Parent message ts."},
                "text": {"type": "string"},
            },
        },
    },

    # ── GitHub ───────────────────────────────────────────────────────────────
    "GitHubListRepos": {
        "name": "GitHubListRepos",
        "description": "List GitHub repositories for the authenticated user.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "visibility": {"type": "string", "enum": ["all", "public", "private"], "description": "Filter by visibility."},
                "sort": {"type": "string", "enum": ["created", "updated", "pushed", "full_name"], "description": "Sort field."},
                "per_page": {"type": "number", "description": "Results per page (max 100)."},
                "page": {"type": "number", "description": "Page number."},
            },
        },
    },
    "GitHubGetRepo": {
        "name": "GitHubGetRepo",
        "description": "Get details about a specific GitHub repository.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo"],
            "properties": {
                "owner": {"type": "string", "description": "Repository owner (username or org)."},
                "repo": {"type": "string", "description": "Repository name."},
            },
        },
    },
    "GitHubCreateRepo": {
        "name": "GitHubCreateRepo",
        "description": "Create a new GitHub repository.",
        "inputSchema": {
            "type": "object",
            "required": ["name"],
            "properties": {
                "name": {"type": "string", "description": "Repository name."},
                "description": {"type": "string"},
                "private": {"type": "boolean", "description": "Make the repo private (default: false)."},
                "auto_init": {"type": "boolean", "description": "Initialize with README."},
            },
        },
    },
    "GitHubListBranches": {
        "name": "GitHubListBranches",
        "description": "List branches in a GitHub repository.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
            },
        },
    },
    "GitHubCreateBranch": {
        "name": "GitHubCreateBranch",
        "description": "Create a new branch in a GitHub repository from a given commit SHA.",
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo", "branch_name", "from_sha"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "branch_name": {"type": "string", "description": "Name for the new branch."},
                "from_sha": {"type": "string", "description": "Commit SHA to branch from."},
            },
        },
    },
    "GitHubListIssues": {
        "name": "GitHubListIssues",
        "description": "List issues in a GitHub repository.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "state": {"type": "string", "enum": ["open", "closed", "all"], "description": "Issue state (default: open)."},
                "labels": {"type": "string", "description": "Comma-separated label names to filter by."},
                "assignee": {"type": "string", "description": "Filter by assignee username."},
                "per_page": {"type": "number"},
                "page": {"type": "number"},
            },
        },
    },
    "GitHubGetIssue": {
        "name": "GitHubGetIssue",
        "description": "Get a specific GitHub issue with its comments.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo", "issue_number"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "issue_number": {"type": "number", "description": "Issue number."},
            },
        },
    },
    "GitHubCreateIssue": {
        "name": "GitHubCreateIssue",
        "description": "Create a new issue in a GitHub repository.",
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo", "title"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "title": {"type": "string", "description": "Issue title."},
                "body": {"type": "string", "description": "Issue body (markdown)."},
                "labels": {"type": "array", "items": {"type": "string"}, "description": "Label names."},
                "assignees": {"type": "array", "items": {"type": "string"}, "description": "Usernames to assign."},
            },
        },
    },
    "GitHubUpdateIssue": {
        "name": "GitHubUpdateIssue",
        "description": "Update a GitHub issue (title, body, state, labels).",
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo", "issue_number"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "issue_number": {"type": "number"},
                "title": {"type": "string"},
                "body": {"type": "string"},
                "state": {"type": "string", "enum": ["open", "closed"]},
                "labels": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
    "GitHubAddIssueComment": {
        "name": "GitHubAddIssueComment",
        "description": "Add a comment to a GitHub issue or pull request.",
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo", "issue_number", "comment"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "issue_number": {"type": "number"},
                "comment": {"type": "string", "description": "Comment body (markdown)."},
            },
        },
    },
    "GitHubListPRs": {
        "name": "GitHubListPRs",
        "description": "List pull requests in a GitHub repository.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "state": {"type": "string", "enum": ["open", "closed", "all"]},
                "per_page": {"type": "number"},
                "page": {"type": "number"},
            },
        },
    },
    "GitHubGetPR": {
        "name": "GitHubGetPR",
        "description": "Get a specific GitHub pull request with review status.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo", "pr_number"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "pr_number": {"type": "number"},
            },
        },
    },
    "GitHubCreatePR": {
        "name": "GitHubCreatePR",
        "description": "Create a pull request on GitHub.",
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo", "title", "head", "base"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "title": {"type": "string"},
                "head": {"type": "string", "description": "Branch with changes (e.g. feature/my-branch)."},
                "base": {"type": "string", "description": "Branch to merge into (e.g. main)."},
                "body": {"type": "string", "description": "PR description (markdown)."},
                "draft": {"type": "boolean"},
            },
        },
    },
    "GitHubGetFileContent": {
        "name": "GitHubGetFileContent",
        "description": "Read the content of a file from a GitHub repository.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["owner", "repo", "path"],
            "properties": {
                "owner": {"type": "string"},
                "repo": {"type": "string"},
                "path": {"type": "string", "description": "File path within the repo."},
                "ref": {"type": "string", "description": "Branch, tag, or commit SHA (default: default branch)."},
            },
        },
    },
    "GitHubSearchCode": {
        "name": "GitHubSearchCode",
        "description": "Search code across GitHub repositories using the code search API.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string", "description": "Search query (e.g. \"useState repo:owner/repo language:typescript\")."},
                "per_page": {"type": "number", "description": "Results per page (max 30 for code search)."},
            },
        },
    },
    "GitHubListNotifications": {
        "name": "GitHubListNotifications",
        "description": "List GitHub notifications for the authenticated user.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "all": {"type": "boolean", "description": "Include read notifications (default: false = unread only)."},
            },
        },
    },
    "GitHubMarkNotificationsRead": {
        "name": "GitHubMarkNotificationsRead",
        "description": "Mark all GitHub notifications as read.",
        "inputSchema": {"type": "object", "properties": {}},
    },

    # ── Jira ─────────────────────────────────────────────────────────────────
    "JiraListProjects": {
        "name": "JiraListProjects",
        "description": "List all accessible Jira projects.",
        "readOnly": True,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "JiraSearchIssues": {
        "name": "JiraSearchIssues",
        "description": (
            "Search Jira issues using JQL (Jira Query Language). Returns at most max_results issues plus an "
            "optional next_page_token. To page through more results, call again with the returned next_page_token. "
            "(Atlassian CHANGE-2046, April 2026: pagination is token-based; offsets are no longer supported and "
            "the `total` field is no longer returned by Jira.)"
        ),
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["jql"],
            "properties": {
                "jql": {"type": "string", "description": "JQL query, e.g. \"project=ENG AND status=Open ORDER BY created DESC\"."},
                "max_results": {"type": "number", "description": "Max issues to return per page (default: 50)."},
                "next_page_token": {"type": "string", "description": "Opaque pagination token returned by a prior call. Omit on the first call."},
            },
        },
    },
    "JiraGetIssue": {
        "name": "JiraGetIssue",
        "description": "Get details of a specific Jira issue including comments.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["issue_key"],
            "properties": {
                "issue_key": {"type": "string", "description": "Issue key, e.g. ENG-123."},
            },
        },
    },
    "JiraCreateIssue": {
        "name": "JiraCreateIssue",
        "description": "Create a new Jira issue.",
        "inputSchema": {
            "type": "object",
            "required": ["project_key", "issue_type", "summary"],
            "properties": {
                "project_key": {"type": "string", "description": "Project key, e.g. ENG."},
                "issue_type": {"type": "string", "description": "Issue type, e.g. Bug, Story, Task, Epic."},
                "summary": {"type": "string", "description": "Issue title/summary."},
                "description": {"type": "string", "description": "Issue description (plain text)."},
                "priority": {"type": "string", "description": "Priority: Highest, High, Medium, Low, Lowest."},
            },
        },
    },
    "JiraUpdateIssue": {
        "name": "JiraUpdateIssue",
        "description": "Update fields on a Jira issue (summary, priority, etc.).",
        "inputSchema": {
            "type": "object",
            "required": ["issue_key"],
            "properties": {
                "issue_key": {"type": "string"},
                "summary": {"type": "string"},
                "priority": {"type": "string"},
            },
        },
    },
    "JiraAddComment": {
        "name": "JiraAddComment",
        "description": "Add a comment to a Jira issue.",
        "inputSchema": {
            "type": "object",
            "required": ["issue_key", "comment"],
            "properties": {
                "issue_key": {"type": "string"},
                "comment": {"type": "string", "description": "Comment text."},
            },
        },
    },
    "JiraAssignIssue": {
        "name": "JiraAssignIssue",
        "description": "Assign a Jira issue to a user by their account ID.",
        "inputSchema": {
            "type": "object",
            "required": ["issue_key", "account_id"],
            "properties": {
                "issue_key": {"type": "string"},
                "account_id": {"type": "string", "description": "Atlassian account ID of the assignee."},
            },
        },
    },
    "JiraTransitionIssue": {
        "name": "JiraTransitionIssue",
        "description": "Move a Jira issue to a different status (e.g. \"In Progress\", \"Done\").",
        "inputSchema": {
            "type": "object",
            "required": ["issue_key", "status_name"],
            "properties": {
                "issue_key": {"type": "string"},
                "status_name": {"type": "string", "description": "Target status name (e.g. \"In Progress\", \"Done\")."},
            },
        },
    },
    "JiraGetBoards": {
        "name": "JiraGetBoards",
        "description": "List Jira boards (Scrum/Kanban).",
        "readOnly": True,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "JiraListSprints": {
        "name": "JiraListSprints",
        "description": "List sprints for a Jira board.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["board_id"],
            "properties": {
                "board_id": {"type": "number", "description": "Board ID."},
                "state": {"type": "string", "enum": ["active", "future", "closed"], "description": "Sprint state filter."},
            },
        },
    },

    # ── Google / Gmail ────────────────────────────────────────────────────────
    "GmailListEmails": {
        "name": "GmailListEmails",
        "description": "List emails from Gmail inbox. Optionally filter by label or search query.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Gmail search query (e.g. \"is:unread from:boss@co.com\")."},
                "max_results": {"type": "number", "description": "Max emails to return (default: 20)."},
            },
        },
    },
    "GmailGetEmail": {
        "name": "GmailGetEmail",
        "description": "Read the full content of a Gmail email by message ID.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["message_id"],
            "properties": {
                "message_id": {"type": "string", "description": "Gmail message ID (from GmailListEmails)."},
            },
        },
    },
    "GmailSendEmail": {
        "name": "GmailSendEmail",
        "description": "Send an email via Gmail.",
        "inputSchema": {
            "type": "object",
            "required": ["to", "subject", "body"],
            "properties": {
                "to": {"type": "string", "description": "Recipient email address."},
                "cc": {"type": "string", "description": "CC email address (optional)."},
                "subject": {"type": "string", "description": "Email subject."},
                "body": {"type": "string", "description": "Email body (plain text)."},
                "thread_id": {"type": "string", "description": "Thread ID to reply to (optional)."},
            },
        },
    },
    "GmailSearchEmails": {
        "name": "GmailSearchEmails",
        "description": "Search Gmail using Gmail query syntax.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string", "description": "Gmail search query, e.g. \"from:alice@co.com after:2024/01/01 subject:invoice\"."},
                "max_results": {"type": "number", "description": "Max results (default: 10)."},
            },
        },
    },
    "GmailCreateDraft": {
        "name": "GmailCreateDraft",
        "description": "Create a Gmail draft without sending.",
        "inputSchema": {
            "type": "object",
            "required": ["to", "subject", "body"],
            "properties": {
                "to": {"type": "string"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
        },
    },
    "GoogleCalendarListEvents": {
        "name": "GoogleCalendarListEvents",
        "description": "List upcoming Google Calendar events.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "time_min": {"type": "string", "description": "Start time (ISO 8601). Defaults to now."},
                "time_max": {"type": "string", "description": "End time (ISO 8601)."},
                "max_results": {"type": "number", "description": "Max events to return (default: 20)."},
            },
        },
    },
    "GoogleCalendarGetEvent": {
        "name": "GoogleCalendarGetEvent",
        "description": "Get details of a specific Google Calendar event.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["event_id"],
            "properties": {
                "event_id": {"type": "string", "description": "Calendar event ID."},
            },
        },
    },
    "GoogleCalendarCreateEvent": {
        "name": "GoogleCalendarCreateEvent",
        "description": "Create a Google Calendar event. Can include a Google Meet video conference link.",
        "inputSchema": {
            "type": "object",
            "required": ["summary", "start_time", "end_time"],
            "properties": {
                "summary": {"type": "string", "description": "Event title."},
                "description": {"type": "string", "description": "Event description."},
                "start_time": {"type": "string", "description": "Start time in ISO 8601 (e.g. 2025-06-15T14:00:00)."},
                "end_time": {"type": "string", "description": "End time in ISO 8601."},
                "time_zone": {"type": "string", "description": "Timezone (e.g. America/New_York). Defaults to UTC."},
                "attendees": {"type": "array", "items": {"type": "string"}, "description": "Email addresses of attendees."},
                "add_meet_link": {"type": "boolean", "description": "Generate a Google Meet link for this event."},
            },
        },
    },
    "GoogleCalendarUpdateEvent": {
        "name": "GoogleCalendarUpdateEvent",
        "description": "Update an existing Google Calendar event.",
        "inputSchema": {
            "type": "object",
            "required": ["event_id"],
            "properties": {
                "event_id": {"type": "string"},
                "summary": {"type": "string"},
                "description": {"type": "string"},
                "start_time": {"type": "string"},
                "end_time": {"type": "string"},
                "time_zone": {"type": "string"},
            },
        },
    },
    "GoogleDriveListFiles": {
        "name": "GoogleDriveListFiles",
        "description": "List files in Google Drive.",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Drive query, e.g. \"name contains 'report'\" or \"mimeType='application/pdf'\"."},
                "page_size": {"type": "number", "description": "Max files to return (default: 20)."},
            },
        },
    },
    "GoogleDriveGetFile": {
        "name": "GoogleDriveGetFile",
        "description": "Get a Google Drive file's metadata and content (for text files).",
        "readOnly": True,
        "inputSchema": {
            "type": "object",
            "required": ["file_id"],
            "properties": {
                "file_id": {"type": "string", "description": "Google Drive file ID."},
            },
        },
    },

    # ── Automations ───────────────────────────────────────────────────────────
    "automation_listConnectedApps": {
        "name": "automation_listConnectedApps",
        "description": "List apps the user has connected (Slack, GitHub, Google, …). Use to discover what tools the automation can call.",
        "readOnly": True,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "automation_listMcpServers": {
        "name": "automation_listMcpServers",
        "description": "List configured MCP servers and (optionally) their tools.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "includeTools": {"type": "boolean", "description": "When true, include each server's exposed tool names."},
            },
        },
    },
    "automation_listTools": {
        "name": "automation_listTools",
        "description": "List all tools currently available to the WOS agent (built-ins + connected apps + MCP). Use to understand what the automation runtime will have access to.",
        "readOnly": True,
        "inputSchema": {"type": "object", "properties": {}},
    },
    "automation_create": {
        "name": "automation_create",
        "description": (
            "Create or replace an automation in ONE call. Returns { ok:true, id, kind, summary } on success "
            "or { ok:false, error:{field,expected,got,hint} } on validation failure.\n\n"
            "Three primitives:\n"
            "  • schedule — runs on a clock. Required: schedule:{ mode:\"at\"|\"every\"|\"cron\", ... }\n"
            "      mode=\"at\"    → schedule:{ mode:\"at\",    at:\"<ISO 8601 or relative like 20m, 2h, 45s>\" }   one-shot\n"
            "      mode=\"every\" → schedule:{ mode:\"every\", every:\"<duration like 30s, 5m, 2h>\" }              recurring\n"
            "      mode=\"cron\"  → schedule:{ mode:\"cron\",  cron:\"0 9 * * *\", tz:\"America/Los_Angeles\" }\n"
            "  • hook    — runs when a WOS event fires. Required: hook:{ event:\"meeting:saved\" | \"session:new\" | ... }\n"
            "  • webhook — runs on inbound HTTPS POST. webhook:{ slug?, secret? }\n\n"
            "The message field is THE MOST IMPORTANT FIELD. It must be a direct, self-contained task instruction "
            "with all resources fully resolved — no placeholders like 'the specified channel'.\n\n"
            "WRONG: message: \"Summarize the Slack channel\"\n"
            "RIGHT: message: \"Read the last 24 hours of messages from #engineering on Slack. Summarize key "
            "discussions, decisions, and action items. Post the summary to #engineering.\"\n\n"
            "toolsAllow: Leave as [] in almost all cases — the runtime uses whatever tools are available."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["name", "kind", "message"],
            "properties": {
                "id": {"type": "string", "description": "Optional. When provided, replaces an existing automation with the same id."},
                "name": {"type": "string"},
                "kind": {"type": "string", "enum": ["schedule", "hook", "webhook"]},
                "enabled": {"type": "boolean"},
                "message": {"type": "string", "description": "The natural-language prompt the agent runs when this automation fires."},
                "toolsAllow": {"type": "array", "items": {"type": "string"}},
                "schedule": {
                    "type": "object",
                    "description": "Required when kind=\"schedule\".",
                    "properties": {
                        "mode": {"type": "string", "enum": ["at", "every", "cron"]},
                        "at": {"type": "string", "description": "ISO 8601 timestamp OR relative duration (\"20m\", \"2h\", \"45s\"). Used when mode=\"at\"."},
                        "every": {"type": "string", "description": "Duration like \"30s\", \"5m\", \"2h\". Used when mode=\"every\". Min 5 seconds."},
                        "cron": {"type": "string", "description": "5- or 6-field cron expression. Used when mode=\"cron\"."},
                        "tz": {"type": "string", "description": "IANA timezone (e.g. \"America/Los_Angeles\"). Defaults to the user's configured zone."},
                        "deleteAfterRun": {"type": "boolean", "description": "For mode=\"at\" only. Default true."},
                        "jitterSec": {"type": "number", "description": "For mode=\"every\" only. Random additional delay in seconds."},
                    },
                },
                "hook": {
                    "type": "object",
                    "description": "Required when kind=\"hook\".",
                    "properties": {
                        "event": {"type": "string"},
                    },
                },
                "webhook": {
                    "type": "object",
                    "description": "Optional config when kind=\"webhook\". Slug + secret are minted automatically.",
                    "properties": {
                        "slug": {"type": "string"},
                        "secret": {"type": "string"},
                    },
                },
                "delivery": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": ["inline", "channel", "webhook", "silent", "notify", "chat", "external"]},
                        "channel": {"type": "string"},
                        "url": {"type": "string"},
                    },
                },
            },
        },
    },
}

# Error strings from the actual WOS app error handlers (used in error injection)
APP_ERRORS = {
    "slack": [
        ("channel_not_found", "Channel not found. Make sure the channel ID is correct and the bot is a member."),
        ("not_in_channel", "The bot is not in this channel. Invite it with /invite @bot-name first."),
        ("invalid_auth", "Slack token is invalid. Please check your Bot Token in Settings → Apps → Slack."),
        ("rate_limited", "Slack rate limit exceeded. Wait a moment before retrying."),
    ],
    "github": [
        ("not_found", "Repository or resource not found. Check the owner and repo name."),
        ("unauthorized", "Invalid token. Regenerate your GitHub Personal Access Token at github.com/settings/tokens."),
        ("forbidden", "Access denied. Make sure the token has the required scopes (repo, notifications)."),
        ("rate_limit", "GitHub rate limit reached. Please wait a minute before trying again."),
    ],
    "jira": [
        ("unauthorized", "Invalid credentials. Check your Atlassian email and API token."),
        ("forbidden", "Access denied. Make sure your Atlassian account has access to this Jira workspace."),
        ("not_found", "Jira workspace not found. Check your Base URL (e.g. https://yourorg.atlassian.net)."),
    ],
    "google": [
        ("session_expired", "Google session expired. Please reconnect Google in Settings → Apps → Google."),
        ("insufficient_scope", "Google permission denied. Make sure you granted the required scopes when connecting Google."),
        ("not_found", "Google resource not found. Check that the ID or path is correct."),
    ],
}

# ---------------------------------------------------------------------------
# Workflow motifs — ToolFlow graph-based tool groupings
# Each motif describes a realistic workspace scenario with a defined tool graph.
# ---------------------------------------------------------------------------
WORKFLOW_MOTIFS: list[dict[str, Any]] = [
    {
        "name": "engineering_triage",
        "domain": "Engineering Triage",
        "apps": ["github", "slack"],
        "tools": ["GitHubListRepos", "GitHubListIssues", "GitHubGetIssue", "SlackListChannels", "SlackSendMessage", "AskUser"],
        "difficulty": "medium",
        "policy_tags": ["use_askuser", "use_picker_for_resource_selection"],
        "scenario_seeds": [
            "What open P1 bugs do we have in the platform-api repo? Post a summary to #engineering.",
            "Find any GitHub issues assigned to @maya-chen and draft a Slack summary for the team.",
            "Check for unresolved security-label issues in acme/backend and notify the on-call channel.",
            "List all open issues labelled 'customer-blocking' in acme/api and post them to #customer-escalations.",
            "Summarize all open regression issues in acme/payments-service for #release-coordination.",
            "Who is working on the API timeout bug? Check GitHub assignments and post findings to #backend.",
            "Pull every issue tagged perf in acme/web-app and Slack a bulleted digest to #frontend.",
            "Find stale issues in acme/data-pipeline with no activity in 14 days; notify #data-platform.",
            "List blockers for the 2.4 milestone in acme/mobile-sdk and post to #mobile-core.",
            "What high-severity issues are still open in acme/infra? Message #sre with the list.",
            "Gather all bugs mentioning memory leak across acme monorepos and send a summary to #quality.",
            "Show me open P2 items in acme/checkout and post the count plus titles to #commerce.",
            "Check GitHub for issues labelled incident-follow-up in acme/core-api and alert #incident-response.",
            "Any unassigned P0s in acme/auth-service? Post a heads-up to #identity.",
            "Draft a Slack update on open documentation issues in acme/docs-site for #tech-writing.",
            "Find issues with label good-first-issue in acme/starter-kit and broadcast in #community.",
        ],
        "error_tool": "SlackSendMessage",
        "error_app": "slack",
    },
    {
        "name": "meeting_routing",
        "domain": "Meeting Intelligence",
        "apps": ["slack"],
        "tools": ["Task", "SlackSendMessage", "AskUser"],
        "difficulty": "easy",
        "policy_tags": ["route_meeting_to_subagent", "use_askuser"],
        "scenario_seeds": [
            "Summarize yesterday's engineering standup and list the action items.",
            "What were the key decisions from the Q3 planning meeting last week?",
            "Pull together all action items from today's cross-functional meeting and send them to #launch-war-room.",
            "Who owns the SSO migration follow-up from the Atlas weekly sync?",
            "Extract decisions and risks from the Atlas design review recording.",
            "What follow-ups came out of the customer advisory board call?",
            "Summarize the weekly product sync and list owners for each action item.",
            "Did we decide on the pricing change in the executive roadmap meeting?",
            "Pull action items from the incident postmortem meeting and route them appropriately.",
            "What blockers were raised in the mobile guild meeting last Tuesday?",
            "Condense the hiring pipeline discussion from the people ops check-in.",
            "List every commitment made in today's partner enablement call.",
            "What did Legal flag during the compliance deep dive?",
            "Recap the architecture council meeting focusing on migration risks.",
            "Summarize the QBR with the finance team and capture next steps.",
            "What open questions remain after the security roadmap session?",
        ],
        "error_tool": "Task",
        "error_app": "slack",
    },
    {
        "name": "project_routing",
        "domain": "Project Management",
        "apps": ["github", "jira", "slack"],
        "tools": ["Task", "AskUser"],
        "difficulty": "easy",
        "policy_tags": ["route_project_to_subagent", "use_askuser"],
        "scenario_seeds": [
            "What's the status of the Atlas project? Give me a risk summary.",
            "Is the Mercury project on track for the Q3 release?",
            "What are the open blockers on the Titan project right now?",
            "Give me a health check on all active projects.",
            "Give me a timeline risk readout on the Nova initiative.",
            "How is the Phoenix rollout going against milestones?",
            "Surface blockers for the Orion redesign program.",
            "Compare Titan vs Mercury delivery confidence for exec review.",
            "What dependencies is the Andromeda effort waiting on?",
            "Health check: is the Zephyr compliance track still green?",
            "Summarize stakeholder concerns on the Luna platform upgrade.",
            "Where does the Helios analytics program stand on resourcing?",
            "Any scope creep signals on the Pegasus migration project?",
            "Quick pulse on the Sirius customer pilot program.",
            "What decisions are pending on the Vega reliability program?",
            "Flag schedule slip indicators on the Comet data migration project.",
        ],
        "error_tool": "Task",
        "error_app": "slack",
    },
    {
        "name": "cross_app_orchestration",
        "domain": "Cross-App Workflow",
        "apps": ["github", "jira", "slack"],
        "tools": ["GitHubListIssues", "GitHubGetIssue", "JiraListProjects", "JiraCreateIssue", "JiraTransitionIssue", "SlackSendMessage", "AskUser"],
        "difficulty": "hard",
        "policy_tags": ["use_askuser", "use_picker_for_resource_selection", "repair_after_tool_error"],
        "scenario_seeds": [
            "Take the open P0 GitHub issues in acme/platform-api and create corresponding Jira tickets, then notify #engineering on Slack.",
            "Find all GitHub issues labelled 'needs-jira' and create a Jira Epic for each, posting a summary to #product-ops.",
            "Create a Jira bug for the crash reported in GitHub issue #4412 in acme/mobile-app and assign it to the mobile team channel.",
            "Mirror GitHub milestone closure announcements into Jira comments for acme/orders-api.",
            "Open Jira stories for each open bug labelled launch-blocker in acme/gateway, then Slack #launch.",
            "File Jira tasks for screenshots-needed issues in acme/ios-app and notify mobile triage on Slack.",
            "Create Jira sub-tasks for every open question-type issue in acme/ml-pipeline, then post summary to #ml-ops.",
            "For each severity-critical GitHub issue in acme/billing, ensure a Jira ticket exists and post diff to #billing-team.",
            "Link GitHub PR feedback threads that need PM input into Jira epics and ping #product in Slack.",
            "Take top-voted GitHub feature requests in acme/widgets and convert to Jira epics with Slack summary to #roadmap.",
            "Sync GitHub security advisories affecting acme/monolith into Jira tasks and notify #appsec.",
            "For each regression label issue in acme/edge-worker, create matching Jira bugs and post roll-up to #edge.",
            "Convert GitHub discussion items marked decision-needed in acme/policy into Jira tasks and alert #governance.",
            "Backfill Jira defects for flaky-test GitHub issues in acme/ci-images and announce in #devtools.",
            "Create Jira spikes for open investigation issues in acme/realtime and Slack #streaming.",
            "Triage GitHub customer-reported defects in acme/support-portal into Jira and notify #cx-ops.",
        ],
        "error_tool": "JiraCreateIssue",
        "error_app": "jira",
    },
    {
        "name": "automation_scheduling",
        "domain": "Automation Creation",
        "apps": ["slack", "github"],
        "tools": ["automation_listConnectedApps", "automation_listTools", "SlackListChannels", "GitHubListIssues", "AskUser", "automation_create"],
        "difficulty": "hard",
        "policy_tags": [
            "use_askuser",
            "automation_requires_exact_resources",
            "automation_no_placeholders",
            "use_picker_for_resource_selection",
        ],
        "scenario_seeds": [
            "Set up a daily 9am Slack digest of all open P1 GitHub issues in acme/backend to #engineering.",
            "Create a weekly Monday automation that posts unresolved customer-blocking GitHub issues to #customer-escalations.",
            "Schedule a Friday 4pm reminder in #launch-war-room to review the release checklist from acme/mobile-app.",
            "After every meeting ends, automatically summarize it and save to memory.",
            "When a GitHub release is published in acme/cli, post release notes to #cli-users automatically.",
            "Nudge #standups every weekday if open review requests exceed 5 in acme/kernel.",
            "On Fridays, post unresolved Sev-1 Jira items to #war-room if any exist.",
            "When sprint ends, auto-summarize carry-over WIP to #delivery-council.",
            "At 5pm local, post count of open dependabot PRs in acme/libs to #maintainers.",
            "Monday mornings: dump open tech-debt GitHub issues from acme/platform into #architecture.",
            "After each deploy to staging, announce commit range and owners in #deploys.",
            "Daily digest of new external issues filed against acme/sdk to #sdk-support.",
            "Weekly automation: highlight stale PRs older than 5 days in acme/services to #eng-leads.",
            "When someone labels an issue help-wanted in acme/tutorials, forward to #oss-community.",
            "Twice a day, list new blocker-labelled Jira items for ENG to #triage.",
            "End of sprint: automation to post velocity deltas versus last sprint in #delivery-metrics.",
        ],
        "error_tool": "SlackListChannels",
        "error_app": "slack",
    },
    {
        "name": "calendar_email_coordination",
        "domain": "Calendar and Email",
        "apps": ["google"],
        "tools": ["GoogleCalendarListEvents", "GoogleCalendarCreateEvent", "GoogleCalendarUpdateEvent", "GmailSendEmail", "GmailListEmails", "AskUser"],
        "difficulty": "medium",
        "policy_tags": ["use_askuser", "prefer_direct_answer_when_sufficient"],
        "scenario_seeds": [
            "Schedule a 30-minute architecture review with the platform team for next Tuesday at 2pm PT and send invites.",
            "Block my calendar for Q3 planning next Friday from 10am to 12pm and email the engineering leads.",
            "Create a recurring weekly standup for the Atlas team on Mondays at 9am with a Google Meet link.",
            "What meetings do I have tomorrow? Send me a summary email.",
            "Invite backend leads to a post-mortem next Wednesday 3pm and email the agenda draft.",
            "Move my 1:1 with Jordan to Thursday 4pm and send both of us updates.",
            "Find a 45-minute slot next week for architecture review and send calendar invites plus prep email.",
            "Email the sales team a summary of tomorrow's customer workshops and block the prep time.",
            "Schedule customer demo dry-run for Friday morning and loop in SE via email.",
            "Add focus blocks for deep work Tue/Thu afternoons and notify my manager by email.",
            "Set up biweekly sync with vendor success starting next month with Meet link and intro email.",
            "Cancel conflicting duplicate invites for the platform summit and confirm via email to attendees.",
            "What is on my calendar next Monday? Email me a concise agenda.",
            "Book travel buffer before the Berlin offsite and email ops the flight constraints.",
            "Reschedule the design critique to avoid overlap with all-hands and notify participants by email.",
            "Send a recap email after tomorrow's vendor review and hold 30 minutes for notes on my calendar.",
        ],
        "error_tool": "GoogleCalendarCreateEvent",
        "error_app": "google",
    },
    {
        "name": "workspace_research",
        "domain": "Workspace Research",
        "apps": [],
        "tools": ["Task", "AskUser"],
        "difficulty": "medium",
        "policy_tags": ["prefer_direct_answer_when_sufficient"],
        "scenario_seeds": [
            "Look into how dictation is implemented in this codebase and give me a 3-paragraph summary.",
            "Find all places where we call the Anthropic API and summarise the patterns used.",
            "How does the agent runner persist conversation history? Walk me through the code.",
            "Trace how WebSocket reconnect logic works across the stack.",
            "Where do we validate automation webhooks before execution?",
            "Explain the meeting transcription consent flow end-to-end in code.",
            "Map how project snapshots are persisted and loaded.",
            "Show me how rate limiting is implemented for outbound provider calls.",
            "How does the SQLite migration runner work? Point to key modules.",
            "Find where subagent tasks are dispatched and summarized.",
            "Where is the Anthropic tool schema assembled for the agent runner?",
            "Summarize error handling in the IPC settings layer.",
            "Outline how the model picker resolves provider-specific capabilities.",
            "How are Slack OAuth tokens refreshed in this codebase?",
        ],
        "error_tool": "Task",
        "error_app": "slack",
    },
    {
        "name": "slack_channel_research",
        "domain": "Slack Research and Notification",
        "apps": ["slack"],
        "tools": ["SlackListChannels", "SlackGetChannelHistory", "SlackSearchMessages", "SlackSendMessage", "SlackGetUserInfo", "AskUser"],
        "difficulty": "medium",
        "policy_tags": ["use_askuser", "use_picker_for_resource_selection", "reuse_known_context"],
        "scenario_seeds": [
            "What has been discussed in #incident-ops in the last 24 hours? Send me a digest.",
            "Search Slack for any messages about the SSO migration and summarise the key threads.",
            "Pull the last 20 messages from #launch-war-room and identify any unresolved blockers.",
            "Find all Slack messages mentioning 'API rate limit' from the last week.",
            "What did #platform-reliability discuss about cache rollout yesterday?",
            "Summarize chatter in #design-system about the token migration.",
            "Search Slack for mentions of database failover in the past 48 hours.",
            "Pull threads from #customer-success about renewal risks this week.",
            "What decisions were made in #legal-hold regarding data retention?",
            "Digest #marketing-launch discussions on campaign timing.",
            "Flag any unresolved threads in #infra-cost about AWS spend.",
            "Recap #ai-lab experiments channel from last week with bullet owners.",
            "What escalations appeared in #on-call-handoff in the last 12 hours?",
            "Surface action items buried in long #product-strategy threads from Monday.",
            "Find who committed to the latency SLO fix in #performance-guild.",
            "Compare sentiment in #beta-users vs #general about the new navigation.",
        ],
        "error_tool": "SlackGetChannelHistory",
        "error_app": "slack",
    },
    {
        "name": "github_pr_workflow",
        "domain": "GitHub PR and Code Review",
        "apps": ["github", "slack"],
        "tools": ["GitHubListRepos", "GitHubListPRs", "GitHubGetPR", "GitHubListBranches", "GitHubCreatePR", "GitHubAddIssueComment", "SlackSendMessage", "AskUser"],
        "difficulty": "hard",
        "policy_tags": ["use_askuser", "use_picker_for_resource_selection"],
        "scenario_seeds": [
            "List all open PRs in acme/backend that have been open more than 3 days and post a review-needed summary to #engineering.",
            "Create a PR from the feature/auth-refactor branch to main in acme/api and notify the team on Slack.",
            "Find all draft PRs in acme/mobile-app and post a list to #engineering asking for reviews.",
            "Request reviews on all ready-to-merge PRs in acme/api-gateway and announce in #review-crew.",
            "Merge-queue status: list queued PRs for acme/kernel and post to #devtools.",
            "Open a hotfix PR from hotfix/null-deref into main for acme/runtime and notify #release-train.",
            "Compare coverage delta on open PRs in acme/analytics and Slack summary to #data.",
            "List PRs authored by bots that still need human sign-off in acme/bots.",
            "Surface draft PRs older than one week in acme/experiments to #lab.",
            "Prepare cherry-pick PR for the patch release from acme/lts branch and ping #sustaining.",
            "Close the loop: which PRs referenced Jira ENG-8899? Post status in #delivery.",
            "Enumerate PRs touching auth codepaths in acme/identity and ask for sec review in #appsec.",
            "Post a diffstat summary of open large PRs in acme/monolith to #architecture.",
            "Find PRs with failing checks in acme/payments and notify authors in #commerce-core.",
            "List backport candidates from main to release/3.2 in acme/firmware and Slack #field-support.",
            "Highlight PRs missing descriptions in acme/docs and nudge #tech-writing.",
        ],
        "error_tool": "GitHubCreatePR",
        "error_app": "github",
    },
    {
        "name": "jira_sprint_management",
        "domain": "Jira Sprint Management",
        "apps": ["jira", "slack"],
        "tools": ["JiraListProjects", "JiraGetBoards", "JiraListSprints", "JiraSearchIssues", "JiraGetIssue", "JiraTransitionIssue", "JiraAddComment", "SlackSendMessage", "AskUser"],
        "difficulty": "hard",
        "policy_tags": ["use_askuser", "use_picker_for_resource_selection", "repair_after_tool_error"],
        "scenario_seeds": [
            "What issues are in the current sprint for the ENG board? Post a status summary to #engineering.",
            "Find all Jira issues in the ENG project that are still In Progress but the sprint ends tomorrow.",
            "Transition all Done tickets from the last sprint to Closed and post a completion summary to #product.",
            "Add a comment to ENG-1234 with the deployment steps we discussed.",
            "Move stalled In-Review items on ENG board back to In Progress and announce in #eng-process.",
            "Which stories in the current sprint lack story points? Post list to #scrum-masters.",
            "Bulk-transition all Cancelled tickets from sprint 42 to archived workflow state; confirm in #program-office.",
            "Export a burndown-friendly list of remaining sprint work items to #atlas-pulse.",
            "Highlight scope additions after sprint start for ENG and notify #product-ops.",
            "Find tickets blocked by external vendor on ENG board; escalate summary to #vendor-mgmt.",
            "What is carrying over from sprint N to N+1 for ENG? Post details in #planning.",
            "List QA-failed items in active sprint for ENG and ping #quality-guild.",
            "Summarize risk flags on ENG sprint board for exec readout in #leadership-sync.",
            "Close duplicate ENG tickets that reference the same GitHub issue and post cleanup note to #triage.",
            "Identify ENG issues missing acceptance criteria and notify assignees in #delivery.",
            "Post sprint goal versus actual completion delta for ENG to #delivery-metrics.",
        ],
        "error_tool": "JiraTransitionIssue",
        "error_app": "jira",
    },
]

# ---------------------------------------------------------------------------
# Stable system prompt contract for orchestration fine-tuning.
# The live app passes tool definitions through the provider tool-calling API;
# the training prompt intentionally models only the stable system-policy core.
# ---------------------------------------------------------------------------
BASE_SYSTEM_PROMPT = (
    "You are WOS, an AI agent assistant. You have access to tools to help accomplish tasks.\n"
    "When using tools, be precise and thorough. Always explain what you are doing.\n"
    "If you need clarification, use the AskUser tool."
)
APP_DISPLAY_NAMES = {
    "github": "GitHub",
    "google": "Google",
    "jira": "Jira",
    "slack": "Slack",
}
APP_ORDER = ("github", "google", "jira", "slack")

WOS_POLICY = """
## Reuse what you already know
Before calling `AskUser`, scan this conversation. If the user already supplied the answer (channel name, target, time, message body, etc.) in an earlier turn - even if a previous attempt failed - reuse it. Never re-ask for information that is already in scope.

## Asking the user
Any clarifying question, confirmation, choice, or request for missing input must go through the `AskUser` tool. Never ask the user a question in plain prose. Ask at most one focused question per turn.

## Subagent routing
When the request is primarily about meetings, recordings, calendar events, transcripts, action items, or discussion follow-ups, delegate to the meeting subagent via the `Task` tool with `preset: "meeting"`.

When the request is about a specific WOS Project, first call `wos_projects_find` to resolve the name, then delegate to the projects subagent via the `Task` tool with `preset: "projects"`.

Otherwise handle the request yourself.
"""


def normalize_app_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized == "gmail":
        return "google"
    if normalized in APP_DISPLAY_NAMES:
        return normalized
    return None


def sort_apps(apps: list[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for app in apps:
        normalized = normalize_app_name(app)
        if normalized and normalized not in seen:
            ordered.append(normalized)
            seen.add(normalized)
    return sorted(ordered, key=APP_ORDER.index)


def build_system_prompt(apps: list[str]) -> str:
    parts = []
    ordered_apps = sort_apps(apps)
    if ordered_apps:
        app_lines = "\n".join(f"- {APP_DISPLAY_NAMES[a]}" for a in ordered_apps)
        parts.append(f"## Connected Apps\n{app_lines}")
    parts.append(BASE_SYSTEM_PROMPT)
    parts.append(WOS_POLICY.strip())
    return "\n\n".join(parts)

def tool_name_to_app(tool_name: str) -> str | None:
    # Keep aligned with audit/repair scripts (tool prefix → app family).
    if tool_name.startswith("GitHub"):
        return "github"
    if tool_name.startswith("Jira"):
        return "jira"
    if tool_name.startswith("Slack"):
        return "slack"
    if tool_name.startswith("Google") or tool_name.startswith("Gmail"):
        return "google"
    return None

def extract_used_apps(messages: list[dict]) -> list[str]:
    used: list[str] = []
    seen: set[str] = set()
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        if msg.get("role") == "assistant" and isinstance(msg.get("tool_calls"), list):
            for tc in msg["tool_calls"]:
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function")
                if not isinstance(fn, dict):
                    continue
                name = fn.get("name")
                if not isinstance(name, str):
                    continue
                app = tool_name_to_app(name)
                if app and app not in seen:
                    used.append(app)
                    seen.add(app)
        elif msg.get("role") == "tool":
            name = msg.get("name")
            if not isinstance(name, str):
                continue
            app = tool_name_to_app(name)
            if app and app not in seen:
                used.append(app)
                seen.add(app)
    return sort_apps(used)

def merge_apps(configured_apps: list[str], used_apps: list[str]) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for app in configured_apps:
        normalized = normalize_app_name(app)
        if normalized and normalized not in seen:
            merged.append(normalized)
            seen.add(normalized)
    for app in used_apps:
        if app not in seen:
            merged.append(app)
            seen.add(app)
    return sort_apps(merged)

def looks_like_tool_schema_blob(text: str) -> bool:
    # Guardrail: tool schemas sometimes leak into the system prompt in model output.
    normalized = text.strip().lower()
    return (
        "# tools" in normalized
        or "available tools" in normalized
        or "\"inputschema\"" in normalized
        or "\"tool_calls\"" in normalized
        or "\"askuser\"" in normalized
        or "\"task\"" in normalized
        or "reference only" in normalized
    )


# ---------------------------------------------------------------------------
# NIM completion with retry + key rotation
# ---------------------------------------------------------------------------
def nim_complete(
    key_manager: IndependentKeyManager,
    slot_idx: int,
    model: str,
    messages: list[dict],
    *,
    response_format: dict | None = None,
    temperature: float = 0.8,
    max_tokens: int = 4096,
) -> str:
    for attempt in range(MAX_RETRIES):
        try:
            key, ki = key_manager.acquire_key_for_slot(slot_idx)
            client = key_manager.make_client(key)
            kwargs: dict[str, Any] = dict(
                model=model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            if response_format:
                kwargs["response_format"] = response_format
                
            short_model = model.split("/")[-1][:15]
            print(f"  [req] slot {slot_idx} -> {short_model} (attempt {attempt+1}/{MAX_RETRIES})...", flush=True)
            
            t0 = time.time()
            resp = client.chat.completions.create(**kwargs)
            elapsed = time.time() - t0
            
            print(f"  [ok] slot {slot_idx} finished in {elapsed:.1f}s", flush=True)
            return resp.choices[0].message.content or ""
            
        except RateLimitError:
            wait = RETRY_BACKOFF_BASE ** attempt
            print(f"  [429-rate-limit] slot {slot_idx} (key {ki}), backing off {wait}s", flush=True)
            key_manager.report_429(ki, wait)
        except APIStatusError as exc:
            if exc.status_code in (429, 503, 529):
                wait = RETRY_BACKOFF_BASE ** attempt
                print(f"  [{exc.status_code}-status] slot {slot_idx} (key {ki}), backing off {wait}s", flush=True)
                key_manager.report_429(ki, wait)
            else:
                print(f"  [api-error] slot {slot_idx} (key {ki}) failed: {exc}", flush=True)
                raise
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            wait = RETRY_BACKOFF_BASE ** attempt
            print(f"  [error] slot {slot_idx} (key {ki}) {type(e).__name__}, backing off {wait}s", flush=True)
            time.sleep(wait)
    raise RuntimeError("exhausted all nim retries.")


# ---------------------------------------------------------------------------
# Phase 1 — scenario seeding (balanced coverage across motifs + seeds)
# ---------------------------------------------------------------------------
def pick_motif_and_scenario(record_index: int) -> tuple[dict[str, Any], str]:
    """
    Deterministic pairing: equal motif mass and even rotation through each motif's
    scenario seeds. Avoids i.i.d. sampling that over-represents a handful of
    templates when generating thousands of trajectories.
    """
    n_motifs = len(WORKFLOW_MOTIFS)
    motif = WORKFLOW_MOTIFS[record_index % n_motifs]
    seeds = motif["scenario_seeds"]
    scenario = seeds[(record_index // n_motifs) % len(seeds)]
    return motif, scenario


# ---------------------------------------------------------------------------
# Phase 2 — execution plan (ToolWeave scaffolding step 1)
# ---------------------------------------------------------------------------
PLAN_SYSTEM = (
    "You are an expert AI workflow architect. "
    "You design precise execution plans for an AI workspace orchestrator called WOS. "
    "WOS has access to tools for Slack, GitHub, Jira, Google Workspace, and workspace research. "
    "Your plans are terse, numbered, and enumerate exact tool calls."
)


def generate_plan(
    key_manager: IndependentKeyManager,
    slot_idx: int,
    model: str,
    motif: dict[str, Any],
    scenario: str,
    inject_error: bool,
    long_horizon: bool,
) -> str:
    tools_str = ", ".join(motif["tools"])
    error_hint = (
        f"\n\nIMPORTANT: Step 3 must show a FAILED call to {motif['error_tool']} "
        f"that returns an error. Step 4 must show the orchestrator using AskUser to "
        f"get the correct resource, then retrying successfully."
        if inject_error
        else ""
    )
    long_hint = (
        "\n\nIMPORTANT: This scenario is long-horizon. Your plan MUST include at least one AskUser step "
        "to confirm/clarify, and then proceed after the user's reply introduces a small revision "
        "(e.g., corrected target, additional constraint, or scope change). Avoid using Task for trivial logic."
        if long_horizon
        else ""
    )
    planning_prompt = f"""Domain: {motif['domain']}
Available tools: {tools_str}
User request: "{scenario}"{error_hint}{long_hint}

Write a numbered 4-to-6 step execution plan for WOS. Each step must:
- Name the exact tool called (or say "respond to user" for the final turn)
- Specify the key arguments
- Note if the step asks the user for clarification (AskUser)
- Note if a subagent is dispatched (Task)

Be concrete. No filler. Output only the numbered list."""

    return nim_complete(
        key_manager,
        slot_idx,
        model,
        [{"role": "system", "content": PLAN_SYSTEM}, {"role": "user", "content": planning_prompt}],
        temperature=PLAN_TEMPERATURE,
        max_tokens=512,
    )


# ---------------------------------------------------------------------------
# Phase 3 — trajectory generation (ToolWeave scaffolding step 2)
# ---------------------------------------------------------------------------
TRAJECTORY_SYSTEM = """You are simulating a complete multi-turn conversation for training an AI orchestrator called WOS.

STRICT OUTPUT RULES
1. Output a single valid JSON object with a "messages" array.
2. Messages alternate: system → user → assistant → tool → assistant → … → assistant(final).
3. Every assistant message that calls a tool MUST have:
   - "reasoning_content": a string of 2-4 sentences of internal thinking
   - "content": empty string ""
   - "tool_calls": array of {id, type:"function", function:{name, arguments:"{...escaped JSON...}"}}
4. Every tool message MUST have:
   - "role": "tool"
   - "tool_call_id": matching the assistant tool_calls id
   - "name": the tool name
   - "content": a realistic mock API response string
5. The FINAL assistant message MUST have:
   - "reasoning_content": 1-2 sentences of synthesis thinking
   - "content": a clear, complete natural-language response to the user
   - NO tool_calls
6. AskUser tool calls produce a tool message whose content is the user's spoken reply.
7. Task (subagent) tool calls produce a tool message whose content is the subagent's final text output.
8. Output ONLY the JSON object. No markdown fences, no commentary."""


def generate_trajectory(
    key_manager: IndependentKeyManager,
    slot_idx: int,
    model: str,
    motif: dict[str, Any],
    scenario: str,
    plan: str,
    system_prompt: str,
    tools_json: str,
    inject_error: bool,
    long_horizon: bool,
) -> tuple[dict | None, str]:
    error_rule = ""
    if inject_error:
        app = motif["error_app"]
        _, err_msg = random.choice(APP_ERRORS[app])
        error_rule = (
            f'\n\nERROR INJECTION: One tool call must fail with this exact error in the tool message content: '
            f'"Error: {err_msg}". The assistant must then use AskUser to get the corrected resource '
            f'and retry successfully.'
        )

    long_rule = ""
    if long_horizon:
        long_rule = (
            "\n\nLONG-HORIZON BEHAVIOR (STRICT):\n"
            "- Include AT LEAST one AskUser tool call.\n"
            "- The AskUser tool response MUST introduce a revision or extra constraint (e.g., corrected channel/repo/time window).\n"
            "- The assistant MUST reuse prior context and continue without re-asking answered questions.\n"
            "- Do NOT call Task for trivial computation (filtering a small list, date arithmetic, formatting).\n"
        )

    synthesis_prompt = f"""Execution plan:
{plan}

User request: "{scenario}"{error_rule}{long_rule}

System prompt the orchestrator uses (verbatim — include it as the first message with role "system"):
{system_prompt}

Available tools (reference only — do not include in output):
{tools_json}

Generate the complete multi-turn trajectory as a JSON object with a "messages" array.
Follow all rules in the system instructions exactly."""

    raw = nim_complete(
        key_manager,
        slot_idx,
        model,
        [{"role": "system", "content": TRAJECTORY_SYSTEM}, {"role": "user", "content": synthesis_prompt}],
        response_format={"type": "json_object"},
        temperature=TRAJECTORY_TEMPERATURE,
        max_tokens=4096,
    )

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r'\{[\s\S]*\}', raw)
        if not match:
            return None, "json_parse_fail:no_json_object"
        try:
            parsed = json.loads(match.group())
        except json.JSONDecodeError:
            return None, "json_parse_fail:invalid_extracted_json"

    messages = parsed.get("messages")
    if not isinstance(messages, list) or len(messages) < 3:
        return None, "schema_fail:messages_missing_or_too_short"

    return {"messages": messages}, "ok"


def normalize_trajectory(traj: dict) -> dict:
    """Normalize model output into canonical tool-call schema without weakening quality."""
    messages = traj.get("messages")
    if not isinstance(messages, list):
        return traj

    allowed_message_keys = {"role", "content", "reasoning_content", "tool_calls", "name", "tool_call_id"}

    for msg in messages:
        if not isinstance(msg, dict):
            continue

        for extra_key in list(msg.keys()):
            if extra_key not in allowed_message_keys:
                msg.pop(extra_key, None)

        role = msg.get("role")

        # Canonicalize assistant tool-call message shape.
        if role == "assistant" and msg.get("tool_calls"):
            if msg.get("content") is None:
                msg["content"] = ""
            tool_calls = msg.get("tool_calls")
            if isinstance(tool_calls, list):
                for tc in tool_calls:
                    if not isinstance(tc, dict):
                        continue
                    if "type" not in tc:
                        tc["type"] = "function"
                    fn = tc.get("function")
                    if isinstance(fn, dict):
                        args = fn.get("arguments")
                        if isinstance(args, (dict, list)):
                            fn["arguments"] = json.dumps(args, ensure_ascii=False)
                        elif args is None:
                            fn["arguments"] = "{}"

        # Canonicalize tool message content to string.
        if role == "tool":
            content = msg.get("content")
            if isinstance(content, (dict, list)):
                msg["content"] = json.dumps(content, ensure_ascii=False)
            elif content is None:
                msg["content"] = ""

    compacted_messages: list[dict] = []
    for index, msg in enumerate(messages):
        if (
            isinstance(msg, dict)
            and msg.get("role") == "assistant"
            and not msg.get("tool_calls")
            and not str(msg.get("content") or "").strip()
            and not str(msg.get("reasoning_content") or "").strip()
            and index + 1 < len(messages)
            and isinstance(messages[index + 1], dict)
            and messages[index + 1].get("role") == "assistant"
        ):
            continue
        compacted_messages.append(msg)

    traj["messages"] = compacted_messages
    messages = compacted_messages

    last = messages[-1] if messages else None
    if isinstance(last, dict) and last.get("role") == "assistant":
        content = last.get("content")
        reasoning = last.get("reasoning_content")
        if isinstance(content, str) and isinstance(reasoning, str) and content.strip() and content.strip() == reasoning.strip():
            last["reasoning_content"] = ""

    return traj


UNRESOLVED_PLANNING_PREFIXES = (
    "i need to",
    "i'll",
    "i will",
    "let me",
    "first, i",
    "first i",
    "now i need to",
    "the user wants",
    "we need to",
)
UNRESOLVED_PLANNING_SUBSTRINGS = (
    "i need to ask the user",
    "i need to clarify",
    "need clarification",
    "must ask the user",
    "must clarify",
    "before i can",
    "to proceed, i need",
    "i'll ask the user",
    "i will ask the user",
    "i should ask the user",
    "execution plan",
)
FOLLOWUP_QUESTION_MARKERS = (
    "would you like me",
    "would you like us",
    "would you like",
    "do any of these need",
    "do you want me",
    "should i ",
    "which slack channel",
    "could you confirm",
    "what email address should i",
    "action needed for",
)
TOOL_PLAN_LINE_RE = re.compile(
    r"^\d+[\.)]\s*(?:Use\s+)?(AskUser|Task|Slack[A-Z][A-Za-z0-9_]*|GitHub[A-Z][A-Za-z0-9_]*|Jira[A-Z][A-Za-z0-9_]*|Google[A-Z][A-Za-z0-9_]*|Gmail[A-Z][A-Za-z0-9_]*|wos_projects_find)\b"
)


def looks_like_unresolved_planning(text: str) -> bool:
    normalized = " ".join(text.strip().lower().split())
    if not normalized:
        return False
    return normalized.startswith(UNRESOLVED_PLANNING_PREFIXES) or any(
        token in normalized for token in UNRESOLVED_PLANNING_SUBSTRINGS
    )


def looks_like_tool_execution_plan(text: str) -> bool:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return False
    tool_plan_lines = [line for line in lines[:6] if TOOL_PLAN_LINE_RE.match(line)]
    if tool_plan_lines and TOOL_PLAN_LINE_RE.match(lines[0]):
        return True

    normalized = " ".join(text.strip().lower().split())
    return (
        ("execution plan" in normalized or "numbered list of steps" in normalized)
        and bool(tool_plan_lines)
    )


def looks_like_error_placeholder(text: str) -> bool:
    normalized = text.strip().lower()
    return normalized.startswith("[error:") or normalized.startswith("error:")


def looks_like_plain_followup_question(text: str) -> bool:
    normalized = " ".join(text.strip().lower().split())
    return normalized.endswith("?") and any(marker in normalized for marker in FOLLOWUP_QUESTION_MARKERS)


# ---------------------------------------------------------------------------
# Validation — basic structural checks before writing
# ---------------------------------------------------------------------------
def validate_trajectory(traj: dict) -> tuple[bool, str]:
    messages = traj.get("messages", [])
    if not isinstance(messages, list) or not messages:
        return False, "messages_missing_or_empty"

    if len(messages) < 3:
        return False, "messages_too_short"

    roles = [m.get("role") if isinstance(m, dict) else None for m in messages]
    if roles[0] != "system":
        return False, "first_role_not_system"
    if roles[1] != "user":
        return False, "second_role_not_user"
    if roles[-1] != "assistant":
        return False, "last_role_not_assistant"

    allowed_tools = allowed_tool_names()
    allowed_message_keys = {"role", "content", "reasoning_content", "tool_calls", "name", "tool_call_id"}
    pending_calls: dict[str, str] = {}

    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            return False, f"message_not_object_at_{idx}"
        extra_keys = sorted(set(msg.keys()) - allowed_message_keys)
        if extra_keys:
            return False, f"message_unexpected_keys_{'_'.join(extra_keys)}_at_{idx}"

        role = msg.get("role")
        content = msg.get("content")
        reasoning = msg.get("reasoning_content")
        tool_calls = msg.get("tool_calls")

        if role == "assistant":
            if tool_calls:
                # Qwen-style tool-call assistant turns: reasoning in reasoning_content only,
                # with empty textual content.
                if not isinstance(reasoning, str) or not reasoning.strip():
                    return False, f"assistant_tool_reasoning_missing_at_{idx}"
                if not isinstance(content, str):
                    return False, f"assistant_tool_content_not_string_at_{idx}"
                if content.strip():
                    return False, f"assistant_tool_content_not_empty_at_{idx}"

                if not isinstance(tool_calls, list) or not tool_calls:
                    return False, f"assistant_tool_calls_invalid_at_{idx}"

                for j, tc in enumerate(tool_calls):
                    if not isinstance(tc, dict):
                        return False, f"tool_call_not_object_at_{idx}_{j}"
                    tc_id = tc.get("id")
                    if not isinstance(tc_id, str) or not tc_id:
                        return False, f"tool_call_id_missing_at_{idx}_{j}"
                    if tc.get("type") != "function":
                        return False, f"tool_call_type_not_function_at_{idx}_{j}"

                    fn = tc.get("function")
                    if not isinstance(fn, dict):
                        return False, f"tool_call_function_missing_at_{idx}_{j}"
                    fn_name = fn.get("name")
                    if not isinstance(fn_name, str) or not fn_name:
                        return False, f"tool_call_function_name_missing_at_{idx}_{j}"
                    if fn_name not in allowed_tools:
                        return False, f"tool_call_function_not_allowed_{fn_name}_at_{idx}_{j}"

                    fn_args = fn.get("arguments")
                    if not isinstance(fn_args, str):
                        return False, f"tool_call_arguments_not_string_at_{idx}_{j}"
                    try:
                        parsed_args = json.loads(fn_args)
                    except json.JSONDecodeError:
                        return False, f"tool_call_arguments_bad_json_at_{idx}_{j}"
                    if not isinstance(parsed_args, dict):
                        return False, f"tool_call_arguments_not_object_at_{idx}_{j}"

                    pending_calls[tc_id] = fn_name
            else:
                # Final assistant response must contain a natural-language answer.
                c = content if isinstance(content, str) else ""
                r = reasoning if isinstance(reasoning, str) else ""
                if idx != len(messages) - 1:
                    return False, f"assistant_nonfinal_without_tool_calls_at_{idx}"
                if idx == len(messages) - 1 and not c.strip():
                    return False, "final_assistant_content_empty"
                if idx == len(messages) - 1 and looks_like_unresolved_planning(c):
                    return False, "final_assistant_unresolved_planning"
                if idx == len(messages) - 1 and looks_like_tool_execution_plan(c):
                    return False, "final_assistant_tool_plan_instead_of_trajectory"
                if idx == len(messages) - 1 and looks_like_error_placeholder(c):
                    return False, "final_assistant_error_placeholder"
                if idx == len(messages) - 1 and looks_like_plain_followup_question(c):
                    return False, "final_assistant_followup_question_without_askuser"
                if idx != len(messages) - 1 and not c.strip() and not r.strip():
                    return False, f"assistant_message_empty_at_{idx}"

        elif role == "tool":
            tcid = msg.get("tool_call_id")
            tool_name = msg.get("name")
            if not isinstance(tcid, str) or not tcid:
                return False, f"tool_message_missing_tool_call_id_at_{idx}"
            if tcid not in pending_calls:
                return False, f"tool_message_unmatched_tool_call_id_{tcid}_at_{idx}"
            expected_name = pending_calls.pop(tcid)
            if not isinstance(tool_name, str) or not tool_name:
                return False, f"tool_message_missing_name_at_{idx}"
            if tool_name != expected_name:
                return False, f"tool_message_name_mismatch_{tool_name}_vs_{expected_name}_at_{idx}"
            if not isinstance(content, str):
                return False, f"tool_message_content_not_string_at_{idx}"

        elif role in {"system", "user"}:
            if tool_calls:
                return False, f"non_assistant_has_tool_calls_at_{idx}"
        else:
            return False, f"invalid_role_{role}_at_{idx}"

    if pending_calls:
        return False, "tool_calls_missing_tool_responses"

    return True, "ok"


# ---------------------------------------------------------------------------
# Record assembly — wraps a trajectory in the full output envelope
# ---------------------------------------------------------------------------
def assemble_record(
    trajectory: dict,
    motif: dict[str, Any],
    scenario: str,
    inject_error: bool,
    split: str,
    *,
    apps: list[str] | None = None,
) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "messages": trajectory["messages"],
        "metadata": {
            "motif": motif["name"],
            "domain": motif["domain"],
            "apps": apps if apps is not None else motif["apps"],
            "difficulty": motif["difficulty"],
            "policy_tags": motif["policy_tags"],
            "error_injected": inject_error,
            "scenario": scenario,
            "split": split,
        },
    }


# ---------------------------------------------------------------------------
# Single-record worker (called from ThreadPoolExecutor)
# ---------------------------------------------------------------------------
def _generate_one_record(
    key_manager: IndependentKeyManager,
    model_rotator: ModelRotator,
    tools_json_str: str,
    idx: int,
    count: int,
) -> tuple[dict | None, str]:
    motif, scenario = pick_motif_and_scenario(idx)
    split = orchestration_split(motif["name"], scenario)
    inject_error = random.random() < ERROR_INJECTION_RATE
    long_horizon = random.random() < LONG_HORIZON_RATE
    system_prompt = build_system_prompt(motif["apps"])

    last_status = "unknown"
    for attempt in range(1, RECORD_MAX_ATTEMPTS + 1):
        model = model_rotator.next()
        attempt_start = time.time()
        model_ok = False
        try:
            plan = generate_plan(key_manager, idx, model, motif, scenario, inject_error, long_horizon)
            trajectory, traj_status = generate_trajectory(
                key_manager, idx, model, motif, scenario, plan,
                system_prompt, tools_json_str, inject_error, long_horizon,
            )
        except Exception as exc:
            last_status = f"generation_error:{type(exc).__name__}"
            if attempt == RECORD_MAX_ATTEMPTS:
                print(f"  [generation-error] record {idx}: {exc}")
            model_rotator.report_result(model, time.time() - attempt_start, False)
            continue

        if trajectory is None:
            last_status = traj_status
            print(f"  [debug] slot {idx} attempt {attempt} failed generation: {traj_status}", flush=True)
            if attempt == RECORD_MAX_ATTEMPTS:
                print(f"  [validation-fail] record {idx}: {traj_status}")
            model_rotator.report_result(model, time.time() - attempt_start, False)
            continue

        trajectory = normalize_trajectory(trajectory)

        # Repair-in-generator: keep strict canonical system prompt and apps metadata.
        # This reduces downstream cleaning and keeps audit_qwen3_jsonl happy.
        merged_apps: list[str] = list(motif.get("apps", []))
        try:
            msgs = trajectory.get("messages")
            if isinstance(msgs, list) and msgs and isinstance(msgs[0], dict) and msgs[0].get("role") == "system":
                used_apps = extract_used_apps([m for m in msgs if isinstance(m, dict)])
                merged_apps = merge_apps(motif.get("apps", []), used_apps)
                canonical_system = build_system_prompt(merged_apps)
                # If the model leaked tool schemas into the system prompt, overwrite.
                current_system = str(msgs[0].get("content") or "")
                if looks_like_tool_schema_blob(current_system) or current_system.strip() != canonical_system.strip():
                    msgs[0]["content"] = canonical_system
        except Exception:
            pass

        is_valid, reason = validate_trajectory(trajectory)
        if not is_valid:
            last_status = f"validation_fail:{reason}"
            print(f"  [debug] slot {idx} attempt {attempt} failed validation: {reason}", flush=True)
            if attempt == RECORD_MAX_ATTEMPTS:
                print(f"  [validation-fail] record {idx}: {reason}")
            model_rotator.report_result(model, time.time() - attempt_start, False)
            continue

        record = assemble_record(trajectory, motif, scenario, inject_error, split, apps=merged_apps)
        record["metadata"]["model"] = model
        model_ok = True
        model_rotator.report_result(model, time.time() - attempt_start, model_ok)
        return record, "ok"

    return None, last_status


# ---------------------------------------------------------------------------
# Main generation loop
# ---------------------------------------------------------------------------
def generate_dataset(
    count: int,
    models: list[str],
    output_path: Path,
    resume: bool = True,
    workers: int = MAX_WORKERS,
    min_model_share: float = MIN_MODEL_SHARE,
    key_min_gap: float = KEY_MIN_GAP,
) -> None:
    keys = load_nim_keys()
    key_manager = IndependentKeyManager(keys, min_gap=key_min_gap)
    model_rotator = ModelRotator(models, min_share=min_model_share)
    effective_workers = workers if workers > 0 else compute_auto_workers(
        key_count=len(keys),
        models=models,
        min_model_share=min_model_share,
        key_min_gap=key_min_gap,
    )
    seed_total = sum(len(m["scenario_seeds"]) for m in WORKFLOW_MOTIFS)
    per_motif = count // max(len(WORKFLOW_MOTIFS), 1)
    print(f"Loaded {len(keys)} NIM key(s).  Primary: …{keys[0][-6:]}")
    print(
        f"Coverage: {len(WORKFLOW_MOTIFS)} motifs, {seed_total} scenario seeds "
        f"(~{per_motif} trajectories/motif at count={count})"
    )
    print(f"Models ({len(models)}): {', '.join(models)}")
    print(
        f"Workers: {effective_workers}  |  Key min gap: {key_min_gap:.2f}s  |  Min model share: {min_model_share:.1%}  "
        f"|  Target: {count} records  |  Error injection: {ERROR_INJECTION_RATE:.0%}"
    )
    print(f"Output: {output_path}")

    # Fail fast if the generator's tool schemas drift from the live runtime.
    allowed_tool_names()

    # Prepare compact tool JSON for use in prompts (names + *descriptions only*).
    # Full input schemas are large and increase the chance the model copies them
    # into the system prompt (prompt leakage). Runtime already passes schemas via
    # provider tool-calling APIs; the fine-tune should emphasize behavior, not schema.
    tools_for_prompt = {
        name: {"description": schema["description"]}
        for name, schema in TOOL_SCHEMAS.items()
    }
    tools_json_str = json.dumps(tools_for_prompt, indent=2)

    # Resume support: count already-written lines
    start_index = 0
    if resume and output_path.exists():
        start_index = sum(1 for _ in output_path.open(encoding="utf-8") if _.strip())
        if start_index >= count:
            print(f"Output already has {start_index} records (>= target {count}). Nothing to do.")
            return
        print(f"Resuming from record {start_index}.")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if resume and start_index > 0 else "w"

    remaining = count - start_index
    active_workers = min(effective_workers, remaining)
    write_lock = threading.Lock()
    written = [start_index]
    total_failures = [0]
    slot_failures: dict[int, int] = {}
    motif_counts: dict[str, int] = {}
    processed = [0]

    with output_path.open(mode, encoding="utf-8") as fout:
        with ThreadPoolExecutor(max_workers=active_workers) as pool:
            futures: dict[Any, int] = {}

            def submit_slot(slot_idx: int) -> None:
                future = pool.submit(
                    _generate_one_record,
                    key_manager,
                    model_rotator,
                    tools_json_str,
                    slot_idx,
                    count,
                )
                futures[future] = slot_idx

            next_slot = start_index
            for _ in range(active_workers):
                submit_slot(next_slot)
                next_slot += 1

            while futures:
                future = next(as_completed(futures))
                idx = futures.pop(future)
                with write_lock:
                    processed[0] += 1
                try:
                    record, status = future.result()
                except Exception as exc:
                    print(f"  [exception] record {idx}: {exc}")
                    with write_lock:
                        total_failures[0] += 1
                        slot_failures[idx] = slot_failures.get(idx, 0) + 1
                        if slot_failures[idx] >= MAX_SLOT_RETRIES:
                            sys.exit(
                                f"Record slot {idx} failed {slot_failures[idx]} times. "
                                f"Aborting to preserve strict quality."
                            )
                    submit_slot(idx)
                    continue

                if status != "ok" or record is None:
                    with write_lock:
                        total_failures[0] += 1
                        slot_failures[idx] = slot_failures.get(idx, 0) + 1
                        if slot_failures[idx] >= MAX_SLOT_RETRIES:
                            sys.exit(
                                f"Record slot {idx} failed {slot_failures[idx]} times "
                                f"(last status: {status}). Aborting to preserve strict quality."
                            )
                    submit_slot(idx)
                    continue

                # Slot succeeded; if any retries were tracked for this slot, clear them.
                slot_failures.pop(idx, None)

                with write_lock:
                    fout.write(json.dumps(record, ensure_ascii=False) + "\n")
                    fout.flush()
                    written[0] += 1
                    w = written[0]
                    meta = record["metadata"]
                    motif_counts[meta["motif"]] = motif_counts.get(meta["motif"], 0) + 1

                if w % 50 == 0 or w == count:
                    print(
                        f"  [{w}/{count}]  split={meta['split']}  motif={meta['motif']}"
                        f"  model={meta['model'].split('/')[-1]}  error_injected={meta['error_injected']}"
                    )

                if processed[0] % 100 == 0:
                    model_summary = model_rotator.summary()
                    fast_model = min(model_summary.items(), key=lambda kv: kv[1]["ema_latency"])
                    slow_model = max(model_summary.items(), key=lambda kv: kv[1]["ema_latency"])
                    print(
                        f"  [progress] processed={processed[0]} written={written[0]} "
                        f"failures={total_failures[0]} in_flight={len(futures)} "
                        f"fastest={fast_model[0].split('/')[-1]}@{fast_model[1]['ema_latency']:.1f}s "
                        f"slowest={slow_model[0].split('/')[-1]}@{slow_model[1]['ema_latency']:.1f}s"
                    )

                if next_slot < count:
                    submit_slot(next_slot)
                    next_slot += 1

    written = written[0]

    # Final stats
    split_counts: dict[str, int] = {}
    error_count = 0
    with output_path.open(encoding="utf-8") as fin:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            meta = rec.get("metadata", {})
            s = meta.get("split", "train")
            split_counts[s] = split_counts.get(s, 0) + 1
            if meta.get("error_injected"):
                error_count += 1

    print("\n=== Dataset Summary ===")
    print(f"Total records : {written}")
    print(f"Failures      : {total_failures[0]}")
    print(f"Split counts  : {split_counts}")
    print(f"Error-injected: {error_count} ({error_count/max(written,1):.1%})")
    print(f"Motif counts  : {motif_counts}")
    model_summary = model_rotator.summary()
    print("Model stats   :")
    for model, st in model_summary.items():
        print(
            f"  - {model}: issued={int(st['issued'])} ok={int(st['completed'])} "
            f"fail={int(st['failed'])} share={st['share']:.1%} ema_latency={st['ema_latency']:.1f}s"
        )
    print(f"Output file   : {output_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="WOS Qwen3 orchestrator dataset generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Model rotation examples:\n"
            "  --models nemotron deepseek-flash    # adaptive scheduling over chosen models\n"
            "  --models nemotron                   # single model (no rotation)\n"
            "  (default: all available models round-robin)"
        ),
    )
    p.add_argument(
        "--count", type=int, default=DEFAULT_COUNT,
        help=f"Number of trajectories to generate (default {DEFAULT_COUNT})",
    )
    p.add_argument(
        "--models", nargs="+", choices=list(NIM_MODELS.keys()), default=list(NIM_MODELS.keys()),
        metavar="MODEL",
        help=(
            f"One or more model keys to rotate through (choices: {', '.join(NIM_MODELS.keys())}; "
            f"default: all models)"
        ),
    )
    p.add_argument(
        "--out", type=Path, default=DEFAULT_OUTPUT,
        help=f"Output JSONL path (default {DEFAULT_OUTPUT})",
    )
    p.add_argument(
        "--workers", type=int, default=MAX_WORKERS,
        help=f"Parallel generation workers (default {MAX_WORKERS}; use 0 for adaptive auto)",
    )
    p.add_argument(
        "--min-model-share", type=float, default=MIN_MODEL_SHARE,
        help=f"Minimum fraction of issued attempts per model (default {MIN_MODEL_SHARE:.2f})",
    )
    p.add_argument(
        "--key-min-gap", type=float, default=KEY_MIN_GAP,
        help=f"Minimum seconds between calls per API key (default {KEY_MIN_GAP})",
    )
    p.add_argument(
        "--no-resume", action="store_true",
        help="Start from scratch even if the output file already exists",
    )
    p.add_argument(
        "--list-models", action="store_true",
        help="Print available NIM model IDs and exit",
    )
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if args.list_models:
        print("Available NIM models:")
        for key, model_id in NIM_MODELS.items():
            print(f"  {key:12s}  {model_id}")
        return

    model_ids = [NIM_MODELS[k] for k in args.models]
    if args.workers < 0:
        sys.exit("--workers must be >= 0 (use 0 for auto mode).")
    if args.key_min_gap <= 0.0:
        sys.exit("--key-min-gap must be > 0.0")
    if args.min_model_share < 0.0:
        sys.exit("--min-model-share must be >= 0.0")
    max_share = 1.0 / max(len(model_ids), 1)
    if args.min_model_share >= max_share:
        sys.exit(
            f"--min-model-share ({args.min_model_share}) is too high for {len(model_ids)} models; "
            f"it must be < {max_share:.4f}."
        )

    generate_dataset(
        count=args.count,
        models=model_ids,
        output_path=args.out,
        resume=not args.no_resume,
        workers=args.workers,
        min_model_share=args.min_model_share,
        key_min_gap=args.key_min_gap,
    )


if __name__ == "__main__":
    main()
