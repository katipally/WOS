#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
ROLE_SET = {"system", "user", "assistant", "tool"}
THINK_TAG_RE = re.compile(r"<\s*/?\s*think\s*>", re.IGNORECASE)
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
APP_LINE_RE = re.compile(r"^-\s+(.*)$")


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


def has_required_system_policy(system_prompt: str) -> bool:
    return (
        BASE_SYSTEM_PROMPT in system_prompt
        and "## Reuse what you already know" in system_prompt
        and "## Asking the user" in system_prompt
        and "## Subagent routing" in system_prompt
    )


def extract_connected_apps(system_prompt: str) -> tuple[list[str], bool]:
    if not system_prompt.startswith("## Connected Apps"):
        return [], False
    first_section = system_prompt.split("\n\n", 1)[0]
    connected_apps: list[str] = []
    malformed = False
    for line in first_section.splitlines()[1:]:
        match = APP_LINE_RE.match(line)
        if not match:
            malformed = True
            continue
        normalized = normalize_app_name(match.group(1))
        if normalized:
            connected_apps.append(normalized)
        else:
            malformed = True
    return connected_apps, malformed


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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Strict Qwen3 JSONL audit for orchestration dataset")
    p.add_argument(
        "--dataset",
        type=Path,
        default=Path("training-data/orchestration/qwen3_orchestrator_dataset.jsonl"),
        help="Path to JSONL dataset",
    )
    p.add_argument(
        "--max-examples",
        type=int,
        default=30,
        help="Max failing examples to print",
    )
    return p.parse_args(argv)


def add_error(
    errors: Counter[str],
    examples: dict[str, list[dict[str, Any]]],
    code: str,
    rec_id: str,
    line_no: int,
    detail: str,
    max_examples: int,
) -> None:
    errors[code] += 1
    bucket = examples[code]
    if len(bucket) < max_examples:
        bucket.append({"line": line_no, "id": rec_id, "detail": detail})


def safe_json_loads(text: str) -> tuple[Any | None, str | None]:
    try:
        return json.loads(text), None
    except json.JSONDecodeError as exc:
        return None, f"{exc.msg} at col {exc.colno}"


def audit_record(
    rec: dict[str, Any],
    line_no: int,
    errors: Counter[str],
    examples: dict[str, list[dict[str, Any]]],
    max_examples: int,
    model_counts: Counter[str],
    split_counts: Counter[str],
    role_pattern_counts: Counter[str],
) -> None:
    rec_id = str(rec.get("id", f"line-{line_no}"))
    runtime_tools = load_runtime_tool_names()

    if not isinstance(rec.get("messages"), list):
        add_error(errors, examples, "record.messages_missing", rec_id, line_no, "messages not list", max_examples)
        return

    metadata = rec.get("metadata")
    if not isinstance(metadata, dict):
        add_error(errors, examples, "record.metadata_missing", rec_id, line_no, "metadata not object", max_examples)
    else:
        split = metadata.get("split")
        if isinstance(split, str):
            split_counts[split] += 1
        model = metadata.get("model")
        if isinstance(model, str) and model:
            model_counts[model] += 1
        else:
            add_error(errors, examples, "metadata.model_missing", rec_id, line_no, "metadata.model missing or empty", max_examples)

    messages: list[dict[str, Any]] = rec["messages"]
    if len(messages) < 3:
        add_error(errors, examples, "messages.too_short", rec_id, line_no, f"len={len(messages)}", max_examples)
        return

    metadata_apps_raw = metadata.get("apps") if isinstance(metadata, dict) else []
    normalized_metadata_apps = []
    if isinstance(metadata_apps_raw, list):
        normalized_metadata_apps = merge_apps(metadata_apps_raw, [])
    elif metadata_apps_raw not in (None, []):
        add_error(errors, examples, "metadata.apps_invalid", rec_id, line_no, f"metadata.apps type={type(metadata_apps_raw).__name__}", max_examples)

    used_apps = infer_used_apps(messages)
    repaired_apps = merge_apps(normalized_metadata_apps, used_apps)

    if used_apps and not set(used_apps).issubset(set(normalized_metadata_apps)):
        add_error(
            errors,
            examples,
            "metadata.apps_missing_used_tool_family",
            rec_id,
            line_no,
            f"metadata.apps={normalized_metadata_apps} used_apps={used_apps}",
            max_examples,
        )

    first_message = messages[0] if messages and isinstance(messages[0], dict) else None
    if isinstance(first_message, dict) and first_message.get("role") == "system":
        system_content = first_message.get("content")
        if not isinstance(system_content, str):
            add_error(errors, examples, "system.content_not_string", rec_id, line_no, "msg[0]", max_examples)
        else:
            if "Available tools" in system_content:
                add_error(errors, examples, "system.prompt_embeds_tool_schema", rec_id, line_no, f"msg[0] starts: {system_content[:120]!r}", max_examples)
            if not has_required_system_policy(system_content):
                add_error(errors, examples, "system.prompt_missing_core_sections", rec_id, line_no, f"msg[0] starts: {system_content[:120]!r}", max_examples)
            expected_system_prompt = build_system_prompt(repaired_apps)
            if system_content != expected_system_prompt:
                add_error(errors, examples, "system.prompt_not_canonical", rec_id, line_no, f"msg[0] starts: {system_content[:120]!r}", max_examples)
            connected_apps, malformed = extract_connected_apps(system_content)
            if malformed:
                add_error(errors, examples, "system.connected_apps_malformed", rec_id, line_no, f"msg[0] starts: {system_content[:120]!r}", max_examples)
            if used_apps and connected_apps and not set(used_apps).issubset(set(connected_apps)):
                add_error(
                    errors,
                    examples,
                    "system.connected_apps_missing_used_tool_family",
                    rec_id,
                    line_no,
                    f"connected_apps={connected_apps} used_apps={used_apps}",
                    max_examples,
                )

    role_seq: list[str] = []
    for i, msg in enumerate(messages):
        if not isinstance(msg, dict):
            add_error(errors, examples, "messages.item_not_object", rec_id, line_no, f"msg[{i}] type={type(msg).__name__}", max_examples)
            continue
        role = msg.get("role")
        if role not in ROLE_SET:
            add_error(errors, examples, "messages.invalid_role", rec_id, line_no, f"msg[{i}].role={role!r}", max_examples)
            role_seq.append("?")
        else:
            role_seq.append(role)

    role_pattern_counts[" -> ".join(role_seq)] += 1

    if role_seq and role_seq[0] != "system":
        add_error(errors, examples, "roles.first_not_system", rec_id, line_no, role_seq[0], max_examples)
    if len(role_seq) > 1 and role_seq[1] != "user":
        add_error(errors, examples, "roles.second_not_user", rec_id, line_no, role_seq[1], max_examples)
    if role_seq and role_seq[-1] != "assistant":
        add_error(errors, examples, "roles.last_not_assistant", rec_id, line_no, role_seq[-1], max_examples)

    pending_calls: dict[str, str] = {}
    any_pretool_mono = False

    for i, msg in enumerate(messages):
        if not isinstance(msg, dict):
            continue

        extra_keys = sorted(set(msg.keys()) - ALLOWED_MESSAGE_KEYS)
        if extra_keys:
            add_error(
                errors,
                examples,
                "message.unexpected_keys",
                rec_id,
                line_no,
                f"msg[{i}] extra_keys={extra_keys}",
                max_examples,
            )

        role = msg.get("role")
        content = msg.get("content")
        reasoning = msg.get("reasoning_content")
        tool_calls = msg.get("tool_calls")

        if isinstance(content, str) and THINK_TAG_RE.search(content):
            add_error(errors, examples, "content.contains_think_tags", rec_id, line_no, f"msg[{i}]", max_examples)
        if isinstance(reasoning, str) and THINK_TAG_RE.search(reasoning):
            add_error(errors, examples, "reasoning.contains_think_tags", rec_id, line_no, f"msg[{i}]", max_examples)

        if role == "assistant":
            if tool_calls:
                # Qwen3 tool-call turn should keep natural language out of content.
                if not isinstance(content, str):
                    add_error(errors, examples, "assistant_tool.content_not_string", rec_id, line_no, f"msg[{i}] type={type(content).__name__}", max_examples)
                elif content.strip() != "":
                    any_pretool_mono = True
                    add_error(
                        errors,
                        examples,
                        "assistant_tool.content_not_empty",
                        rec_id,
                        line_no,
                        f"msg[{i}] content starts: {content[:120]!r}",
                        max_examples,
                    )

                if not isinstance(reasoning, str) or not reasoning.strip():
                    add_error(errors, examples, "assistant_tool.reasoning_missing", rec_id, line_no, f"msg[{i}]", max_examples)

                if not isinstance(tool_calls, list) or not tool_calls:
                    add_error(errors, examples, "assistant_tool.tool_calls_invalid", rec_id, line_no, f"msg[{i}]", max_examples)
                    continue

                for j, tc in enumerate(tool_calls):
                    if not isinstance(tc, dict):
                        add_error(errors, examples, "tool_call.not_object", rec_id, line_no, f"msg[{i}].tool_calls[{j}]", max_examples)
                        continue
                    tc_id = tc.get("id")
                    if not isinstance(tc_id, str) or not tc_id:
                        add_error(errors, examples, "tool_call.id_missing", rec_id, line_no, f"msg[{i}].tool_calls[{j}]", max_examples)
                        continue
                    tc_type = tc.get("type")
                    if tc_type != "function":
                        add_error(errors, examples, "tool_call.type_not_function", rec_id, line_no, f"msg[{i}].tool_calls[{j}].type={tc_type!r}", max_examples)
                    fn = tc.get("function")
                    if not isinstance(fn, dict):
                        add_error(errors, examples, "tool_call.function_missing", rec_id, line_no, f"msg[{i}].tool_calls[{j}]", max_examples)
                        continue
                    fn_name = fn.get("name")
                    if not isinstance(fn_name, str) or not fn_name:
                        add_error(errors, examples, "tool_call.function_name_missing", rec_id, line_no, f"msg[{i}].tool_calls[{j}]", max_examples)
                        continue
                    if fn_name not in runtime_tools:
                        add_error(errors, examples, "tool_call.function_name_unknown_runtime", rec_id, line_no, f"msg[{i}].tool_calls[{j}].name={fn_name!r}", max_examples)
                    fn_args = fn.get("arguments")
                    if not isinstance(fn_args, str):
                        add_error(errors, examples, "tool_call.arguments_not_string", rec_id, line_no, f"msg[{i}].tool_calls[{j}]", max_examples)
                    else:
                        _, parse_err = safe_json_loads(fn_args)
                        if parse_err:
                            add_error(errors, examples, "tool_call.arguments_bad_json", rec_id, line_no, f"msg[{i}].tool_calls[{j}] {parse_err}", max_examples)
                    pending_calls[tc_id] = fn_name
            else:
                # Final assistant turn should be natural language answer.
                c = content if isinstance(content, str) else ""
                r = reasoning if isinstance(reasoning, str) else ""
                if i != len(messages) - 1:
                    add_error(
                        errors,
                        examples,
                        "assistant.nonfinal_without_tool_calls",
                        rec_id,
                        line_no,
                        f"msg[{i}]",
                        max_examples,
                    )
                if not c.strip() and not r.strip():
                    add_error(errors, examples, "assistant_final.empty", rec_id, line_no, f"msg[{i}]", max_examples)
                if i == len(messages) - 1:
                    if c.strip() and r.strip() and c.strip() == r.strip():
                        add_error(
                            errors,
                            examples,
                            "assistant_final.reasoning_equals_content",
                            rec_id,
                            line_no,
                            f"msg[{i}]",
                            max_examples,
                        )
                    if looks_like_unresolved_planning(c):
                        add_error(
                            errors,
                            examples,
                            "assistant_final.unresolved_planning",
                            rec_id,
                            line_no,
                            f"msg[{i}] content starts: {c[:120]!r}",
                            max_examples,
                        )
                    if looks_like_tool_execution_plan(c):
                        add_error(
                            errors,
                            examples,
                            "assistant_final.tool_plan_instead_of_trajectory",
                            rec_id,
                            line_no,
                            f"msg[{i}] content starts: {c[:120]!r}",
                            max_examples,
                        )
                    if looks_like_error_placeholder(c):
                        add_error(
                            errors,
                            examples,
                            "assistant_final.error_placeholder",
                            rec_id,
                            line_no,
                            f"msg[{i}] content starts: {c[:120]!r}",
                            max_examples,
                        )
                    if looks_like_plain_followup_question(c):
                        add_error(
                            errors,
                            examples,
                            "assistant_final.followup_question_without_askuser",
                            rec_id,
                            line_no,
                            f"msg[{i}] content starts: {c[:120]!r}",
                            max_examples,
                        )

        elif role == "tool":
            tcid = msg.get("tool_call_id")
            name = msg.get("name")
            if isinstance(name, str) and name not in runtime_tools:
                add_error(errors, examples, "tool_message.name_unknown_runtime", rec_id, line_no, f"msg[{i}].name={name!r}", max_examples)
            if not isinstance(tcid, str) or not tcid:
                add_error(errors, examples, "tool_msg.tool_call_id_missing", rec_id, line_no, f"msg[{i}]", max_examples)
                continue
            if tcid not in pending_calls:
                add_error(errors, examples, "tool_msg.unmatched_tool_call_id", rec_id, line_no, f"msg[{i}] tcid={tcid}", max_examples)
            else:
                expected_name = pending_calls.pop(tcid)
                if isinstance(name, str) and name != expected_name:
                    add_error(errors, examples, "tool_msg.name_mismatch", rec_id, line_no, f"msg[{i}] name={name} expected={expected_name}", max_examples)
            if not isinstance(content, str):
                add_error(errors, examples, "tool_msg.content_not_string", rec_id, line_no, f"msg[{i}]", max_examples)

        elif role in {"system", "user"}:
            if tool_calls:
                add_error(errors, examples, "non_assistant_has_tool_calls", rec_id, line_no, f"msg[{i}] role={role}", max_examples)

    if pending_calls:
        add_error(
            errors,
            examples,
            "tool_call.no_tool_response",
            rec_id,
            line_no,
            f"unanswered={list(pending_calls.keys())[:5]}",
            max_examples,
        )

    if any_pretool_mono:
        add_error(errors, examples, "qwen3.pretool_monologue_in_content", rec_id, line_no, "assistant tool-call turn has non-empty content", max_examples)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    path = args.dataset
    if not path.exists():
        print(json.dumps({"ok": False, "error": f"Dataset not found: {path}"}, indent=2))
        return 2

    errors: Counter[str] = Counter()
    examples: dict[str, list[dict[str, Any]]] = defaultdict(list)
    model_counts: Counter[str] = Counter()
    split_counts: Counter[str] = Counter()
    role_pattern_counts: Counter[str] = Counter()

    line_count = 0
    valid_json_lines = 0

    with path.open("r", encoding="utf-8") as f:
        for line_no, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line:
                continue
            line_count += 1
            rec, parse_err = safe_json_loads(line)
            if parse_err:
                add_error(errors, examples, "jsonl.bad_line_json", f"line-{line_no}", line_no, parse_err, args.max_examples)
                continue
            if not isinstance(rec, dict):
                add_error(errors, examples, "jsonl.line_not_object", f"line-{line_no}", line_no, type(rec).__name__, args.max_examples)
                continue
            valid_json_lines += 1
            audit_record(
                rec=rec,
                line_no=line_no,
                errors=errors,
                examples=examples,
                max_examples=args.max_examples,
                model_counts=model_counts,
                split_counts=split_counts,
                role_pattern_counts=role_pattern_counts,
            )

    total_errors = sum(errors.values())
    report = {
        "dataset": str(path),
        "lines_nonempty": line_count,
        "lines_valid_json": valid_json_lines,
        "error_total": total_errors,
        "error_types": dict(errors.most_common()),
        "split_counts": dict(split_counts),
        "model_counts": dict(model_counts),
        "top_role_patterns": role_pattern_counts.most_common(10),
        "examples": {k: v for k, v in examples.items()},
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if total_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
