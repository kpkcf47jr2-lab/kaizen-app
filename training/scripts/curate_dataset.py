#!/usr/bin/env python3
"""
Kaizen — Dataset curation pipeline.

Reads raw JSONL emitted by backend/src/services/kaizenDataset.js:
  { ts, route, userHash, model, routedVia, kind, elapsedMs, usage,
    optOut, messages: [{role, content}], response }

Filters:
  - drop optOut=true (no content stored)
  - drop response is None or empty
  - drop very short exchanges (< 20 chars user or < 40 chars assistant)
  - drop obvious errors (assistant contains "Error:" only)
  - dedupe by (user_msg_hash, response_hash)

Converts each row to the Qwen chat format expected by TRL SFTTrainer:
  { "messages": [
      {"role": "system",    "content": "..."},
      {"role": "user",      "content": "..."},
      {"role": "assistant", "content": "..."}
  ]}

Splits 90 / 5 / 5 (train / val / test) with deterministic seed.
Writes to datasets/curated/{train,val,test}.jsonl.

Usage:
  # Copy raw JSONL from Oracle first (owner has ssh):
  #   scp -r kairos@129.153.46.146:/opt/kairos/backend/data/kaizen-training \\
  #          datasets/raw/
  #
  python training/scripts/curate_dataset.py \\
      --raw-dir datasets/raw \\
      --out-dir datasets/curated \\
      --system-prompt training/configs/kaizen_system_prompt.txt \\
      --target-size 5000
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import Counter
from pathlib import Path


SYSTEM_PROMPT_DEFAULT = (
    "You are Kaizen, an autonomous entrepreneur AI. You reason step by step, "
    "you plan before acting, you call tools when action is needed, you never "
    "invent facts, and you keep answers tight. When you don't know, you say so."
)


def load_raw(raw_dir: Path) -> list[dict]:
    """Load every JSONL line from raw_dir/**/*.jsonl."""
    rows = []
    files = sorted(raw_dir.rglob("*.jsonl"))
    for f in files:
        with f.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    print(f"loaded {len(rows)} raw rows from {len(files)} files")
    return rows


def keep(row: dict) -> bool:
    """Quality filter — return True if row is worth keeping."""
    if row.get("optOut"):
        return False
    resp = row.get("response")
    msgs = row.get("messages")
    if not resp or not msgs:
        return False
    if not isinstance(msgs, list) or len(msgs) < 1:
        return False
    user_msg = next((m for m in msgs if m.get("role") == "user"), None)
    if not user_msg or not user_msg.get("content"):
        return False
    if len(user_msg["content"]) < 20:
        return False
    if len(resp) < 40:
        return False
    # Filter obvious failure responses.
    lower = resp.strip().lower()
    if lower.startswith("error:") and len(resp) < 200:
        return False
    if "i cannot help with that" in lower or "as an ai" in lower[:40]:
        return False
    return True


def dedupe(rows: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for r in rows:
        user_msg = next((m for m in r["messages"] if m.get("role") == "user"), None)
        if not user_msg:
            continue
        key = (
            hashlib.sha256(user_msg["content"].encode()).hexdigest()[:16],
            hashlib.sha256(r["response"].encode()).hexdigest()[:16],
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    print(f"deduped to {len(out)} unique rows")
    return out


def to_qwen_chat(row: dict, system_prompt: str) -> dict:
    """Convert one raw row to Qwen/TRL chat format."""
    msgs = [{"role": "system", "content": system_prompt}]
    for m in row["messages"]:
        role = m.get("role")
        content = m.get("content") or ""
        if role in ("user", "system") and content:
            # Skip additional system messages — we control the system prompt.
            if role == "system":
                continue
            msgs.append({"role": "user", "content": content.strip()})
    msgs.append({"role": "assistant", "content": row["response"].strip()})
    return {"messages": msgs, "meta": {"route": row.get("route"), "kind": row.get("kind")}}


def split(rows: list[dict], seed: int = 42) -> tuple[list, list, list]:
    rng = random.Random(seed)
    shuffled = rows[:]
    rng.shuffle(shuffled)
    n = len(shuffled)
    n_val = max(1, n // 20)   # 5%
    n_test = max(1, n // 20)  # 5%
    test = shuffled[:n_test]
    val = shuffled[n_test:n_test + n_val]
    train = shuffled[n_test + n_val:]
    return train, val, test


def write_jsonl(rows: list[dict], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")


def summarize(name: str, rows: list[dict]) -> None:
    kinds = Counter(r["meta"].get("kind") or "unknown" for r in rows)
    routes = Counter(r["meta"].get("route") or "unknown" for r in rows)
    print(f"\n[{name}] n={len(rows)}")
    print(f"  by kind:  {dict(kinds.most_common(8))}")
    print(f"  by route: {dict(routes.most_common(8))}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw-dir", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--system-prompt", type=Path, default=None,
                    help="Path to file with system prompt. Falls back to default.")
    ap.add_argument("--target-size", type=int, default=5000,
                    help="Cap total curated rows to this many (best-quality first).")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    system_prompt = SYSTEM_PROMPT_DEFAULT
    if args.system_prompt and args.system_prompt.exists():
        system_prompt = args.system_prompt.read_text(encoding="utf-8").strip()

    raw = load_raw(args.raw_dir)
    if not raw:
        print("no raw rows — nothing to curate")
        return 1

    filtered = [r for r in raw if keep(r)]
    print(f"after quality filter: {len(filtered)}")

    unique = dedupe(filtered)

    # Best-quality-first: prefer longer assistant responses, capped to target.
    unique.sort(key=lambda r: len(r["response"]), reverse=True)
    if len(unique) > args.target_size:
        unique = unique[: args.target_size]
        print(f"capped to target size {args.target_size}")

    converted = [to_qwen_chat(r, system_prompt) for r in unique]

    train, val, test = split(converted, seed=args.seed)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    write_jsonl(train, args.out_dir / "train.jsonl")
    write_jsonl(val,   args.out_dir / "val.jsonl")
    write_jsonl(test,  args.out_dir / "test.jsonl")

    summarize("TRAIN", train)
    summarize("VAL",   val)
    summarize("TEST",  test)

    print(f"\n✅ wrote curated dataset to {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
