"""
Deterministic train / validation / blind_test assignment for orchestration JSONL.

Blind_test rows use disjoint scenario buckets from train and validation so the
same user intent (motif + scenario string) never appears in training and blind
evaluation — improving generalization measurement vs tuning on validation.

Buckets are stable across merges and regenerations given the same motif name +
scenario text (the core user-request identity in our generator).
"""

from __future__ import annotations

import hashlib


def orchestration_split_hash(motif_name: str, scenario: str) -> float:
    payload = f"{motif_name.strip()}\n{scenario.strip()}".encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()[:8]
    return int(digest, 16) / 0xFFFFFFFF


def orchestration_split(
    motif_name: str,
    scenario: str,
    *,
    blind_fraction: float = 0.05,
    validation_fraction: float = 0.05,
) -> str:
    """
    Returns 'blind_test', 'validation', or 'train'.

    blind_fraction + validation_fraction must be < 1.0.
    Order: blind bucket first (lowest hashes), then validation, then train.
    """
    u = orchestration_split_hash(motif_name, scenario)
    if u < blind_fraction:
        return "blind_test"
    if u < blind_fraction + validation_fraction:
        return "validation"
    return "train"
