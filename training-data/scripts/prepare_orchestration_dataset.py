#!/usr/bin/env python3
"""
Dedupe / trim legacy orchestration JSONL and merge with NIM-generated batches.

Split policy (production + blind generalization)
-----------------------------------------------
`orchestration_splits.orchestration_split` assigns each row from (motif, scenario):
  ~90%% train | ~5%% validation | ~5%% blind_test

Blind rows never share the same user-intent key as train/val — scenarios are
bucket-disjoint by stable hash. Training JSONL should contain ONLY train+validation;
blind_test is written to a separate file for post-train evaluation (Colab).

Workflow
--------
  python prepare_orchestration_dataset.py trim \\
      --in training-data/orchestration/qwen3_orchestrator_dataset.cleaned.jsonl \\
      --out training-data/orchestration/qwen3_orchestrator_dataset.legacy_trimmed.jsonl \\
      --max-per-key 8

  python training-data/scripts/generate_dataset.py --count 5200 --workers 64

  python prepare_orchestration_dataset.py build \\
      --legacy-in training-data/orchestration/qwen3_orchestrator_dataset.legacy_trimmed.jsonl \\
      --nim-in training-data/orchestration/qwen3_orchestrator_nim_batch.jsonl \\
      --out-train-val training-data/orchestration/qwen3_orchestrator_train_val.jsonl \\
      --out-blind training-data/orchestration/qwen3_orchestrator_blind_test.jsonl \\
      --seed 42

  python prepare_orchestration_dataset.py stats --in training-data/orchestration/qwen3_orchestrator_train_val.jsonl
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from orchestration_splits import orchestration_split

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent

DEFAULT_LEGACY_CLEANED = REPO_ROOT / "training-data/orchestration/qwen3_orchestrator_dataset.cleaned.jsonl"
DEFAULT_NIM_BATCH = REPO_ROOT / "training-data/orchestration/qwen3_orchestrator_nim_batch.jsonl"
DEFAULT_OUT_TRAIN_VAL = REPO_ROOT / "training-data/orchestration/qwen3_orchestrator_train_val.jsonl"
DEFAULT_OUT_BLIND = REPO_ROOT / "training-data/orchestration/qwen3_orchestrator_blind_test.jsonl"


def _fingerprint(record: dict[str, Any]) -> tuple[Any, ...]:
    meta = record.get("metadata") or {}
    scenario = meta.get("scenario")
    if not isinstance(scenario, str):
        scenario = ""
    return (
        meta.get("motif", ""),
        scenario,
        str(meta.get("error_injected", "")),
        tuple(meta.get("apps") or ()) if isinstance(meta.get("apps"), list) else (),
    )


def _content_digest(record: dict[str, Any]) -> str:
    blob = json.dumps(record.get("messages", []), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fout:
        for rec in rows:
            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")


def trim_record_list(rows: list[dict[str, Any]], max_per_key: int) -> list[dict[str, Any]]:
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = defaultdict(list)
    for rec in rows:
        groups[_fingerprint(rec)].append(rec)

    kept: list[dict[str, Any]] = []
    dropped = 0
    for key, bucket in groups.items():
        bucket_sorted = sorted(bucket, key=lambda r: (r.get("id") or "", _content_digest(r)))
        take = bucket_sorted[:max_per_key]
        kept.extend(take)
        dropped += len(bucket) - len(take)

    kept.sort(key=lambda r: _fingerprint(r) + (_content_digest(r),))
    return kept


def merge_prefer_first(primary: list[dict], secondary: list[dict], dedupe_digest: bool) -> tuple[list[dict], int]:
    """Primary rows win on duplicate message payloads."""
    seen: set[str] = set()
    out: list[dict] = []
    skipped = 0

    for rec in primary + secondary:
        if dedupe_digest:
            d = _content_digest(rec)
            if d in seen:
                skipped += 1
                continue
            seen.add(d)
        out.append(rec)
    return out, skipped


def assign_splits_inplace(rows: list[dict[str, Any]]) -> None:
    for rec in rows:
        meta = rec.setdefault("metadata", {})
        motif = str(meta.get("motif", ""))
        scen = meta["scenario"] if isinstance(meta.get("scenario"), str) else ""
        meta["split"] = orchestration_split(motif, scen)


def cmd_trim(ns: argparse.Namespace) -> None:
    rows = load_jsonl(ns.in_path)
    kept = trim_record_list(rows, ns.max_per_key)
    write_jsonl(ns.out_path, kept)

    fp_count = len({ _fingerprint(r) for r in rows })
    print(f"Trim complete: {ns.in_path}")
    print(f"  Unique keys: {fp_count}")
    print(f"  Input rows : {len(rows)}")
    print(f"  Output rows: {len(kept)}  (cap {ns.max_per_key} per key)")
    print(f"  Dropped    : {len(rows) - len(kept)}")
    print(f"  Written    : {ns.out_path}")


def cmd_merge(ns: argparse.Namespace) -> None:
    merged: list[dict[str, Any]] = []
    skipped = 0
    seen: set[str] = set()

    for p in ns.inputs:
        for rec in load_jsonl(Path(p)):
            if ns.dedupe_digest:
                d = _content_digest(rec)
                if d in seen:
                    skipped += 1
                    continue
                seen.add(d)
            merged.append(rec)

    rng = random.Random(ns.seed)
    rng.shuffle(merged)

    write_jsonl(ns.out_path, merged)

    print(f"Merge complete → {ns.out_path}")
    print(f"  Input files : {len(ns.inputs)}")
    print(f"  Output rows : {len(merged)}")
    if ns.dedupe_digest:
        print(f"  Skipped dup : {skipped}")


def cmd_rewrite_splits(ns: argparse.Namespace) -> None:
    rows = load_jsonl(ns.in_path)
    assign_splits_inplace(rows)
    write_jsonl(ns.out_path, rows)
    splits = Counter(str((r.get("metadata") or {}).get("split", "")) for r in rows)
    print(f"Rewrote splits → {ns.out_path} ({len(rows)} rows)")
    print(f"  Split counts: {dict(splits)}")


def cmd_build(ns: argparse.Namespace) -> None:
    legacy_rows = load_jsonl(ns.legacy_in)
    legacy_kept = trim_record_list(legacy_rows, ns.max_per_key)
    nim_rows = load_jsonl(ns.nim_in)

    merged, skipped = merge_prefer_first(nim_rows, legacy_kept, dedupe_digest=ns.dedupe_digest)
    assign_splits_inplace(merged)

    train_val: list[dict[str, Any]] = []
    blind: list[dict[str, Any]] = []
    for rec in merged:
        sp = str((rec.get("metadata") or {}).get("split", ""))
        if sp == "blind_test":
            blind.append(rec)
        else:
            train_val.append(rec)

    rng = random.Random(ns.seed)
    rng.shuffle(train_val)

    write_jsonl(ns.out_train_val, train_val)
    write_jsonl(ns.out_blind, blind)

    print("Build complete")
    # ASCII-only output for Windows consoles (avoid cp1252 encode errors).
    print(f"  Legacy in     : {ns.legacy_in} ({len(legacy_rows)} -> trimmed {len(legacy_kept)})")
    print(f"  NIM in        : {ns.nim_in} ({len(nim_rows)})")
    print(f"  Digest dedupe skipped: {skipped}")
    print(f"  Train+val out : {ns.out_train_val} ({len(train_val)} rows)")
    print(f"  Blind out     : {ns.out_blind} ({len(blind)} rows)")


def cmd_stats(ns: argparse.Namespace) -> None:
    path = Path(ns.in_path)
    n = 0
    fps = Counter()
    scenarios = Counter()
    motifs = Counter()
    splits = Counter()

    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            n += 1
            rec = json.loads(line)
            meta = rec.get("metadata") or {}
            fps[_fingerprint(rec)] += 1
            scen = meta.get("scenario") if isinstance(meta.get("scenario"), str) else ""
            scenarios[scen] += 1
            motifs[str(meta.get("motif", ""))] += 1
            splits[str(meta.get("split", ""))] += 1

    repeats = sum(1 for _k, c in fps.items() if c > 1)
    worst = fps.most_common(5)

    print(f"Stats for {path} ({n} rows)")
    print(f"  Unique fingerprints (motif+scenario+error+apps): {len(fps)}")
    print(f"  Fingerprints with >1 row: {repeats}")
    print(f"  Top fingerprint counts   : {worst}")
    print(f"  Unique scenario strings  : {len(scenarios)}")
    print(f"  Motifs                   : {dict(most_common(motifs, 20))}")
    print(f"  Splits                   : {dict(splits)}")


def most_common(c: Counter, k: int) -> list[tuple[str, int]]:
    return [(a, int(b)) for a, b in c.most_common(k)]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Trim, merge, and split orchestration JSONL for WOS SFT.")
    subs = p.add_subparsers(dest="cmd", required=True)

    t = subs.add_parser("trim", help="Cap rows per semantic fingerprint.")
    t.add_argument("--in", dest="in_path", type=Path, required=True)
    t.add_argument("--out", dest="out_path", type=Path, required=True)
    t.add_argument("--max-per-key", type=int, default=8)
    t.set_defaults(func=cmd_trim)

    m = subs.add_parser("merge", help="Shuffle-concatenate JSONLs (optional digest dedupe).")
    m.add_argument("--inputs", nargs="+", type=Path, required=True)
    m.add_argument("--out", dest="out_path", type=Path, required=True)
    m.add_argument("--seed", type=int, default=42)
    m.add_argument("--dedupe-digest", action="store_true")
    m.set_defaults(func=cmd_merge)

    r = subs.add_parser(
        "rewrite-splits",
        help="Recompute metadata.split from (motif, scenario) for every row.",
    )
    r.add_argument("--in", dest="in_path", type=Path, required=True)
    r.add_argument("--out", dest="out_path", type=Path, required=True)
    r.set_defaults(func=cmd_rewrite_splits)

    b = subs.add_parser(
        "build",
        help="Trim legacy + merge NIM batch + assign splits → train_val + blind_test files.",
    )
    b.add_argument("--legacy-in", type=Path, default=DEFAULT_LEGACY_CLEANED)
    b.add_argument("--nim-in", type=Path, default=DEFAULT_NIM_BATCH)
    b.add_argument("--out-train-val", type=Path, default=DEFAULT_OUT_TRAIN_VAL)
    b.add_argument("--out-blind", type=Path, default=DEFAULT_OUT_BLIND)
    b.add_argument("--max-per-key", type=int, default=8)
    b.add_argument("--seed", type=int, default=42)
    b.add_argument(
        "--no-dedupe-digest",
        dest="dedupe_digest",
        action="store_false",
        help="Keep duplicate trajectories (same message-array hash) when merging.",
    )
    b.set_defaults(dedupe_digest=True, func=cmd_build)

    s = subs.add_parser("stats", help="Print diversity metrics for a JSONL.")
    s.add_argument("--in", dest="in_path", type=Path, required=True)
    s.set_defaults(func=cmd_stats)

    return p


def main() -> None:
    parser = build_parser()
    ns = parser.parse_args()
    ns.func(ns)


if __name__ == "__main__":
    main()
