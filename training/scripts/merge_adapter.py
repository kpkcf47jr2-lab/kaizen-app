#!/usr/bin/env python3
"""
Merge a LoRA adapter into its base model → single full-weight checkpoint
ready for vLLM / Ollama / hosted inference.

Usage:
  python training/scripts/merge_adapter.py \\
      --base-model Qwen/Qwen3-8B \\
      --adapter    training/adapters/kaizen-8b-v0.2 \\
      --out-dir    models/kaizen-8b-v0.2-merged \\
      --dtype      float16
"""

from __future__ import annotations
import argparse
from pathlib import Path


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-model", required=True)
    ap.add_argument("--adapter",    type=Path, required=True)
    ap.add_argument("--out-dir",    type=Path, required=True)
    ap.add_argument("--dtype",      default="float16", choices=["float16", "bfloat16", "float32"])
    ap.add_argument("--device",     default="auto")
    return ap.parse_args()


def main() -> int:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    dtype = {"float16": torch.float16, "bfloat16": torch.bfloat16, "float32": torch.float32}[args.dtype]

    print(f"→ loading tokenizer from {args.base_model}")
    tok = AutoTokenizer.from_pretrained(args.base_model)

    print(f"→ loading base model from {args.base_model} (dtype={args.dtype})")
    base = AutoModelForCausalLM.from_pretrained(args.base_model, torch_dtype=dtype, device_map=args.device)

    print(f"→ loading LoRA adapter from {args.adapter}")
    m = PeftModel.from_pretrained(base, str(args.adapter))

    print("→ merging LoRA weights into base...")
    m = m.merge_and_unload()

    print(f"→ writing merged model to {args.out_dir}")
    m.save_pretrained(args.out_dir, safe_serialization=True, max_shard_size="2GB")
    tok.save_pretrained(args.out_dir)
    print(f"✓ done. Merged model at {args.out_dir}")
    print(f"  → next: serve with vLLM:  vllm serve {args.out_dir} --tensor-parallel-size 1 --gpu-memory-utilization 0.9")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
