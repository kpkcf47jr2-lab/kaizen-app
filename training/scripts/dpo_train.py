#!/usr/bin/env python3
"""
Kaizen — DPO training (Improvement.3)

Consumes the preference pairs produced by AutoCurator (dpo.jsonl) and
does a Direct Preference Optimization pass on top of an existing
SFT-trained model. DPO teaches the model to prefer high-ROI decisions
over low-ROI ones without needing an explicit reward model.

Runs on the same 16-24GB GPUs the SFT script targets (T4 / L4 / A100).

Deps:
  pip install -U torch transformers accelerate peft trl bitsandbytes datasets

Usage:
  python training/scripts/dpo_train.py \\
      --data-file  datasets/curated/dpo-latest.jsonl \\
      --base-model Qwen/Qwen3-8B \\
      --sft-adapter training/adapters/kaizen-8b-v0.2 \\
      --out-dir    training/adapters/kaizen-8b-v0.3-dpo \\
      --epochs     1 \\
      --beta       0.1
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-file",   type=Path, required=True)
    ap.add_argument("--base-model",  required=True)
    ap.add_argument("--sft-adapter", type=Path, required=True,
                    help="LoRA adapter from the previous SFT round — DPO starts from here.")
    ap.add_argument("--out-dir",     type=Path, required=True)
    ap.add_argument("--epochs",      type=int,   default=1)
    ap.add_argument("--batch-size",  type=int,   default=1)
    ap.add_argument("--grad-accum",  type=int,   default=8)
    ap.add_argument("--lr",          type=float, default=5e-6,
                    help="DPO lr is much lower than SFT — larger will diverge.")
    ap.add_argument("--beta",        type=float, default=0.1,
                    help="KL divergence weight. 0.1 = mild, 0.3 = tight tether to SFT.")
    ap.add_argument("--max-seq-len", type=int,   default=1024)
    ap.add_argument("--seed",        type=int,   default=42)
    return ap.parse_args()


def load_pairs(path: Path):
    """AutoCurator emits { prompt, chosen, rejected, strategy, meta }.
    `chosen` and `rejected` are JSON strings of {content, tool_call}."""
    rows = []
    for line in path.read_text(encoding="utf8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        # DPOTrainer expects string prompts + string chosen + string rejected.
        # Serialize the tool_call inside chosen/rejected so the model
        # learns which tool_call is preferred, not just the prose.
        rows.append({
            "prompt":   r["prompt"],
            "chosen":   r["chosen"]   if isinstance(r["chosen"], str)   else json.dumps(r["chosen"]),
            "rejected": r["rejected"] if isinstance(r["rejected"], str) else json.dumps(r["rejected"]),
        })
    return rows


def main() -> int:
    import torch
    from datasets import Dataset
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
    from peft import PeftModel, LoraConfig
    from trl import DPOTrainer, DPOConfig

    args = parse_args()
    print(f"→ loading tokenizer from {args.base_model}")
    tok = AutoTokenizer.from_pretrained(args.base_model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    print(f"→ loading base model in 4-bit + SFT adapter {args.sft_adapter}")
    bnb = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.float16,
                             bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True)
    base = AutoModelForCausalLM.from_pretrained(args.base_model, quantization_config=bnb, device_map="auto")
    policy = PeftModel.from_pretrained(base, str(args.sft_adapter), is_trainable=True)

    # Reference model: the same SFT-trained model but frozen. TRL will
    # compute KL(policy || ref) internally.
    print("→ loading frozen reference model (same SFT adapter, no grad)")
    base_ref = AutoModelForCausalLM.from_pretrained(args.base_model, quantization_config=bnb, device_map="auto")
    ref = PeftModel.from_pretrained(base_ref, str(args.sft_adapter), is_trainable=False)

    print(f"→ loading preference pairs from {args.data_file}")
    pairs = load_pairs(args.data_file)
    if len(pairs) < 8:
        print(f"⚠ only {len(pairs)} pairs — DPO usually needs ≥100 for signal. "
              "Skipping or running as smoke test.")
    ds = Dataset.from_list(pairs)
    print(f"  {len(pairs)} pairs loaded")

    print("→ configuring DPO")
    dpo_cfg = DPOConfig(
        output_dir=str(args.out_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        beta=args.beta,
        max_length=args.max_seq_len,
        max_prompt_length=args.max_seq_len // 2,
        seed=args.seed,
        logging_steps=5,
        save_strategy="epoch",
        report_to="none",
        remove_unused_columns=False,
    )

    trainer = DPOTrainer(
        model=policy,
        ref_model=ref,
        args=dpo_cfg,
        tokenizer=tok,
        train_dataset=ds,
        peft_config=LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05,
                               target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
                               task_type="CAUSAL_LM"),
    )
    print("→ training…")
    trainer.train()
    print(f"→ saving adapter to {args.out_dir}")
    trainer.save_model(str(args.out_dir))
    tok.save_pretrained(str(args.out_dir))
    print("✓ done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
