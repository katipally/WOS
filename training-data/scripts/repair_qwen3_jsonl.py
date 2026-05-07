#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
ALLOWED_MESSAGE_KEYS = {"role", "content", "reasoning_content", "tool_calls", "name", "tool_call_id"}
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
WOS_POLICY = """
## Reuse what you already know
Before calling `AskUser`, scan this conversation. If the user already supplied the answer (channel name, target, time, message body, etc.) in an earlier turn - even if a previous attempt failed - reuse it. Never re-ask for information that is already in scope.

## Asking the user
Any clarifying question, confirmation, choice, or request for missing input must go through the `AskUser` tool. Never ask the user a question in plain prose. Ask at most one focused question per turn.

## Subagent routing
When the request is primarily about meetings, recordings, calendar events, transcripts, action items, or discussion follow-ups, delegate to the meeting subagent via the `Task` tool with `preset: "meeting"`.

When the request is about a specific WOS Project, first call `wos_projects_find` to resolve the name, then delegate to the projects subagent via the `Task` tool with `preset: "projects"`.

Otherwise handle the request yourself.
""".strip()
APP_TOOL_PREFIXES = {
    "github": ("GitHub",),
    "jira": ("Jira",),
    "slack": ("Slack",),
    "google": ("Google", "Gmail"),
}
APP_ORDER = ("github", "google", "jira", "slack")
RUNTIME_TOOL_NAME_RE = re.compile(r"name:\s*'([A-Za-z0-9_-]+)'")
UNRESOLVED_PLANNING_PREFIXES = (
    "i need to",
    "i'll",
    "i will",
    "let me",
    "first, i",
    "first i",
    "now i need to",
    "now i'll",
    "now i will",
    "next, i",
    "next i",
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
    "next i'll",
    "next i will",
    "the next step",
    "i'll retry",
    "i will retry",
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


def normalize_app_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized == "gmail":
        return "google"
    if normalized in APP_TOOL_PREFIXES:
        return normalized
    return None


def tool_name_to_app(tool_name: str) -> str | None:
    for app, prefixes in APP_TOOL_PREFIXES.items():
        if any(tool_name.startswith(prefix) for prefix in prefixes):
            return app
    return None


def infer_used_apps(messages: list[dict[str, Any]]) -> list[str]:
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
                tool_name = fn.get("name")
                if not isinstance(tool_name, str):
                    continue
                app = tool_name_to_app(tool_name)
                if app and app not in seen:
                    used.append(app)
                    seen.add(app)
        elif msg.get("role") == "tool":
            tool_name = msg.get("name")
            if not isinstance(tool_name, str):
                continue
            app = tool_name_to_app(tool_name)
            if app and app not in seen:
                used.append(app)
                seen.add(app)
    return used


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
    return sorted(merged, key=APP_ORDER.index)


def build_system_prompt(apps: list[str]) -> str:
    parts: list[str] = []
    if apps:
        app_lines = "\n".join(f"- {APP_DISPLAY_NAMES[app]}" for app in apps)
        parts.append(f"## Connected Apps\n{app_lines}")
    parts.append(BASE_SYSTEM_PROMPT)
    parts.append(WOS_POLICY)
    return "\n\n".join(parts)


def looks_like_tool_error_result(text: str) -> bool:
    normalized = text.strip().lower()
    return (
        normalized.startswith("error:")
        or normalized.startswith("[error:")
        or normalized.startswith("resource not found:")
        or normalized.startswith("not found")
        or normalized.startswith("403 forbidden")
        or normalized.startswith("404 not found")
        or " workspace not found" in normalized
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Repair Qwen3 orchestration JSONL in place")
    p.add_argument("--dataset", type=Path, required=True, help="Input JSONL path")
    p.add_argument("--output", type=Path, default=None, help="Output JSONL path (default: overwrite input)")
    p.add_argument("--report", type=Path, default=None, help="Optional repair report JSON path")
    return p.parse_args()


def to_str_content(v: Any) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    if v is None:
        return ""
    return str(v)


def safe_load_json(s: str) -> tuple[Any | None, bool]:
    try:
        return json.loads(s), True
    except Exception:
        return None, False


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


def strip_plain_followup_question(text: str) -> tuple[str, bool]:
    stripped = text.rstrip()
    lowered = stripped.lower()
    if not stripped.endswith("?"):
        return text, False
    start = max(lowered.rfind(marker) for marker in FOLLOWUP_QUESTION_MARKERS)
    if start < 0:
        return text, False
    suffix = stripped[start:].strip()
    if not suffix.endswith("?") or len(suffix) > 240:
        return text, False
    trimmed = stripped[:start].rstrip()
    while trimmed.endswith((":", "-", "—", ";")):
        trimmed = trimmed[:-1].rstrip()
    return (trimmed, True) if trimmed else (text, False)


def replace_file_with_fallback(tmp: Path, out: Path) -> None:
    try:
        tmp.replace(out)
        return
    except PermissionError:
        pass

    with tmp.open("r", encoding="utf-8") as src, out.open("w", encoding="utf-8", newline="\n") as dst:
        for chunk in src:
            dst.write(chunk)

    tmp.unlink(missing_ok=True)


def repair_record(rec: dict[str, Any], counters: Counter[str]) -> tuple[dict[str, Any] | None, str | None]:
    msgs = rec.get("messages")
    if not isinstance(msgs, list) or len(msgs) < 3:
        return None, "messages_missing_or_short"
    runtime_tools = load_runtime_tool_names()

    metadata = rec.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        rec["metadata"] = metadata
        counters["fixed_metadata_missing_object"] += 1

    metadata_apps_raw = metadata.get("apps")
    normalized_metadata_apps: list[str] = []
    if isinstance(metadata_apps_raw, list):
        normalized_metadata_apps = merge_apps(metadata_apps_raw, [])
        if normalized_metadata_apps != metadata_apps_raw:
            counters["fixed_metadata_apps_normalized"] += 1
    elif metadata_apps_raw not in (None, []):
        counters["fixed_metadata_apps_invalid_reset"] += 1

    compacted_msgs: list[dict[str, Any]] = []
    for index, msg in enumerate(msgs):
        if (
            isinstance(msg, dict)
            and msg.get("role") == "assistant"
            and not msg.get("tool_calls")
            and not to_str_content(msg.get("content")).strip()
            and not to_str_content(msg.get("reasoning_content")).strip()
            and index + 1 < len(msgs)
            and isinstance(msgs[index + 1], dict)
            and msgs[index + 1].get("role") == "assistant"
        ):
            counters["fixed_removed_empty_assistant_bridge"] += 1
            continue
        compacted_msgs.append(msg)

    msgs = compacted_msgs
    rec["messages"] = msgs

    pending_calls: dict[str, str] = {}

    for i, msg in enumerate(msgs):
        if not isinstance(msg, dict):
            return None, f"message_not_object_at_{i}"

        for extra_key in sorted(set(msg.keys()) - ALLOWED_MESSAGE_KEYS):
            msg.pop(extra_key, None)
            counters["fixed_removed_unexpected_message_key"] += 1

        role = msg.get("role")
        if role not in {"system", "user", "assistant", "tool"}:
            return None, f"invalid_role_at_{i}"

        if role in {"system", "user"}:
            if "tool_calls" in msg and msg.get("tool_calls"):
                return None, f"non_assistant_tool_calls_at_{i}"
            msg["content"] = to_str_content(msg.get("content"))
            continue

        if role == "assistant":
            tool_calls = msg.get("tool_calls")
            if tool_calls:
                # Canonical content/reasoning for pre-tool assistant turns.
                content = to_str_content(msg.get("content"))
                reasoning = msg.get("reasoning_content")
                reasoning = reasoning if isinstance(reasoning, str) else ""

                if content.strip() and not reasoning.strip():
                    msg["reasoning_content"] = content.strip()
                    msg["content"] = ""
                    counters["fixed_moved_content_to_reasoning"] += 1
                elif content.strip() and reasoning.strip():
                    msg["reasoning_content"] = reasoning.strip() + "\n\n" + content.strip()
                    msg["content"] = ""
                    counters["fixed_merged_content_into_reasoning"] += 1
                else:
                    msg["reasoning_content"] = reasoning
                    msg["content"] = ""

                if not msg.get("reasoning_content", "").strip():
                    return None, f"assistant_tool_reasoning_missing_at_{i}"

                if not isinstance(tool_calls, list) or not tool_calls:
                    return None, f"assistant_tool_calls_invalid_at_{i}"

                repaired_calls: list[dict[str, Any]] = []
                for j, tc in enumerate(tool_calls):
                    if not isinstance(tc, dict):
                        return None, f"tool_call_not_object_at_{i}_{j}"

                    tc_id = tc.get("id")
                    if not isinstance(tc_id, str) or not tc_id:
                        tc_id = f"auto_call_{i}_{j}"
                        counters["fixed_tool_call_id_missing"] += 1

                    fn = tc.get("function")
                    if not isinstance(fn, dict):
                        return None, f"tool_call_function_missing_at_{i}_{j}"

                    fn_name = fn.get("name")
                    if not isinstance(fn_name, str) or not fn_name:
                        return None, f"tool_call_name_missing_at_{i}_{j}"
                    if fn_name not in runtime_tools:
                        return None, f"tool_call_name_unknown_runtime_at_{i}_{j}"

                    fn_args = fn.get("arguments")
                    if isinstance(fn_args, str):
                        _, ok = safe_load_json(fn_args)
                        if not ok:
                            return None, f"tool_call_args_bad_json_at_{i}_{j}"
                        args_text = fn_args
                    elif isinstance(fn_args, (dict, list)):
                        args_text = json.dumps(fn_args, ensure_ascii=False)
                        counters["fixed_tool_call_args_object_to_string"] += 1
                    elif fn_args is None:
                        args_text = "{}"
                        counters["fixed_tool_call_args_none_to_empty_object"] += 1
                    else:
                        return None, f"tool_call_args_invalid_type_at_{i}_{j}"

                    repaired = {
                        "id": tc_id,
                        "type": "function",
                        "function": {
                            "name": fn_name,
                            "arguments": args_text,
                        },
                    }
                    repaired_calls.append(repaired)
                    pending_calls[tc_id] = fn_name

                msg["tool_calls"] = repaired_calls
            else:
                # Non-tool assistant turns
                msg["content"] = to_str_content(msg.get("content"))
                if "reasoning_content" in msg and not isinstance(msg.get("reasoning_content"), str):
                    msg["reasoning_content"] = to_str_content(msg.get("reasoning_content"))
                if i != len(msgs) - 1:
                    return None, f"assistant_nonfinal_without_tool_calls_at_{i}"

        if role == "tool":
            msg["content"] = to_str_content(msg.get("content"))
            tcid = msg.get("tool_call_id")
            tname = msg.get("name")

            # Missing tool_call_id: attempt deterministic recovery when only one pending call exists.
            if (not isinstance(tcid, str) or not tcid) and len(pending_calls) == 1:
                tcid = next(iter(pending_calls.keys()))
                msg["tool_call_id"] = tcid
                counters["fixed_tool_msg_missing_id_single_pending"] += 1

            if not isinstance(tcid, str) or not tcid:
                return None, f"tool_msg_missing_tool_call_id_at_{i}"

            if tcid not in pending_calls:
                # Attempt recover by matching name uniquely among pending calls.
                if isinstance(tname, str):
                    matches = [k for k, v in pending_calls.items() if v == tname]
                    if len(matches) == 1:
                        tcid = matches[0]
                        msg["tool_call_id"] = tcid
                        counters["fixed_tool_msg_relinked_by_name"] += 1
                    else:
                        return None, f"tool_msg_unmatched_tool_call_id_at_{i}"
                else:
                    return None, f"tool_msg_unmatched_tool_call_id_at_{i}"

            expected_name = pending_calls[tcid]
            if not isinstance(tname, str) or not tname:
                msg["name"] = expected_name
                counters["fixed_tool_msg_name_missing"] += 1
            elif tname != expected_name:
                msg["name"] = expected_name
                counters["fixed_tool_msg_name_mismatch"] += 1

            pending_calls.pop(tcid, None)

    # Final role checks and final assistant content fallback
    roles = [m.get("role") if isinstance(m, dict) else None for m in msgs]
    if roles[0] != "system" or roles[1] != "user" or roles[-1] != "assistant":
        return None, "role_sequence_invalid"

    used_apps = infer_used_apps(msgs)
    repaired_apps = merge_apps(normalized_metadata_apps, used_apps)
    if metadata.get("apps") != repaired_apps:
        metadata["apps"] = repaired_apps
        counters["fixed_metadata_apps_augmented"] += 1

    first = msgs[0]
    if isinstance(first, dict):
        if isinstance(first.get("content"), str) and "Available tools" in first["content"]:
            counters["fixed_system_prompt_removed_tool_schema"] += 1
        expected_system_prompt = build_system_prompt(repaired_apps)
        if first.get("content") != expected_system_prompt:
            first["content"] = expected_system_prompt
            counters["fixed_system_prompt_canonicalized"] += 1

    last = msgs[-1]
    if isinstance(last, dict):
        last_content = to_str_content(last.get("content"))
        last_reasoning = last.get("reasoning_content") if isinstance(last.get("reasoning_content"), str) else ""
        if not last_content.strip() and last_reasoning.strip():
            last["content"] = last_reasoning.strip()
            counters["fixed_final_assistant_content_from_reasoning"] += 1
            last_content = last["content"]
        if last_content.strip() and last_reasoning.strip() and last_content.strip() == last_reasoning.strip():
            last["reasoning_content"] = ""
            counters["fixed_final_reasoning_equals_content"] += 1
        stripped_followup, changed = strip_plain_followup_question(last.get("content", ""))
        if changed:
            last["content"] = stripped_followup
            counters["fixed_final_plain_followup_question_removed"] += 1
        if looks_like_unresolved_planning(last.get("content", "")):
            return None, "assistant_final_unresolved_planning"
        if looks_like_tool_execution_plan(last.get("content", "")):
            return None, "assistant_final_tool_plan_instead_of_trajectory"
        if looks_like_error_placeholder(last.get("content", "")):
            return None, "assistant_final_error_placeholder"
        if looks_like_plain_followup_question(last.get("content", "")):
            return None, "assistant_final_followup_question_without_askuser"

    has_tool_error = any(
        isinstance(msg, dict)
        and msg.get("role") == "tool"
        and isinstance(msg.get("content"), str)
        and looks_like_tool_error_result(msg["content"])
        for msg in msgs
    )
    current_error_injected = bool(metadata.get("error_injected"))
    if current_error_injected != has_tool_error:
        metadata["error_injected"] = has_tool_error
        counters["fixed_metadata_error_injected"] += 1

    if pending_calls:
        return None, "tool_calls_missing_tool_responses"

    return rec, None


def main() -> int:
    args = parse_args()
    inp = args.dataset
    out = args.output or args.dataset
    report_path = args.report

    if not inp.exists():
        print(json.dumps({"ok": False, "error": f"dataset not found: {inp}"}, indent=2))
        return 2

    counters: Counter[str] = Counter()
    dropped_examples: list[dict[str, Any]] = []
    kept_lines: list[str] = []

    with inp.open("r", encoding="utf-8") as f:
        for line_no, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line:
                continue

            try:
                rec = json.loads(line)
            except json.JSONDecodeError as exc:
                counters["dropped_json_decode_error"] += 1
                if len(dropped_examples) < 100:
                    dropped_examples.append({"line": line_no, "id": None, "reason": f"json_decode_error:{exc.msg}"})
                continue

            if not isinstance(rec, dict):
                counters["dropped_not_object"] += 1
                if len(dropped_examples) < 100:
                    dropped_examples.append({"line": line_no, "id": None, "reason": "record_not_object"})
                continue

            rec_id = rec.get("id")
            repaired, reason = repair_record(rec, counters)
            if repaired is None:
                counters[f"dropped_{reason}"] += 1
                if len(dropped_examples) < 100:
                    dropped_examples.append({"line": line_no, "id": rec_id, "reason": reason})
                continue

            kept_lines.append(json.dumps(repaired, ensure_ascii=False))
            counters["kept_records"] += 1

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as w:
        for s in kept_lines:
            w.write(s + "\n")
    replace_file_with_fallback(tmp, out)

    report = {
        "input": str(inp),
        "output": str(out),
        "summary": dict(counters),
        "dropped_examples": dropped_examples,
    }

    if report_path is not None:
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
