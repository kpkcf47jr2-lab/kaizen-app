#!/usr/bin/env python3
"""
Kaizen — SFT with QLoRA on Qwen3-8B.

Runs on a single 16-24GB GPU (T4, L4, A10, RTX 4090). Target host:
Lightning AI (~80h/mo free), Kaggle P100 (backup), Colab (smoke tests).

Deps (install once):
  pip install -U torch transformers accelerate peft trl bitsandbytes datasets

Usage:
  python training/scripts/sft_qlora.py \\
      --data-dir  datasets/curated \\
      --out-dir   training/adapters/kaizen-8b-v0.1 \\
      --base-model Qwen/Qwen3-8B \\
      --epochs    3
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir",  type=Path, required=True)
    ap.add_argument("--out-dir",   type=Path, required=True)
    # Qwen2.5-7B-Instruct: Apache 2.0, tool-use trained, fits T4 15GB in 4-bit
    # with room for activations. Qwen3-8B overflows T4 device_map=auto. Upgrade
    # to 8B or 14B when we move to L4/A100.
    ap.add_argument("--base-model", type=str, default="Qwen/Qwen2.5-7B-Instruct")
    ap.add_argument("--epochs",    type=int, default=3)
    ap.add_argument("--batch-size", type=int, default=1,
                    help="Per-device train batch size. Keep 1 on T4/L4 with grad-accum.")
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-seq-len", type=int, default=1024,
                    help="Sequence length cap. 1024 fits Qwen3-8B QLoRA on T4/15GB; "
                         "bump to 2048 on L4/24GB or 4096 on A100.")
    ap.add_argument("--lora-r",     type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--lora-dropout", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--wandb-project", type=str, default=None)
    return ap.parse_args()


def main() -> int:
    args = parse_args()

    # Deferred imports so the file is readable without heavy deps installed.
    import torch
    from datasets import load_dataset
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
    )
    from peft import LoraConfig, prepare_model_for_kbit_training, get_peft_model
    from trl import SFTConfig, SFTTrainer

    torch.manual_seed(args.seed)

    print(f"→ loading tokenizer: {args.base_model}")
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print(f"→ loading base model in 4-bit: {args.base_model}")
    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    # SDPA is built into PyTorch — no extra install. FlashAttention2 is faster
    # but requires `pip install flash-attn`, which is heavy and not on the free
    # studio image. Ship works everywhere first, optimize later.
    attn_impl = "sdpa" if torch.cuda.is_available() else "eager"
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        quantization_config=bnb,
        device_map="auto",
        trust_remote_code=True,
        attn_implementation=attn_impl,
    )
    model = prepare_model_for_kbit_training(model)

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    print(f"→ loading dataset from {args.data_dir}")
    ds = load_dataset(
        "json",
        data_files={
            "train": str(args.data_dir / "train.jsonl"),
            "val":   str(args.data_dir / "val.jsonl"),
        },
    )
    print(ds)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    sft_config = SFTConfig(
        output_dir=str(args.out_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=10,               # trl 1.x dropped warmup_ratio; ~3% of typical run
        max_length=args.max_seq_len,   # was `max_seq_length` in trl<1.0
        bf16=True,
        gradient_checkpointing=True,
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=50,
        save_strategy="steps",
        save_steps=100,
        save_total_limit=3,
        report_to=("wandb" if args.wandb_project else "none"),
        run_name=os.environ.get("RUN_NAME", "kaizen-sft"),
        seed=args.seed,
        packing=True,
    )

    trainer = SFTTrainer(
        model=model,
        args=sft_config,
        train_dataset=ds["train"],
        eval_dataset=ds["val"],
        processing_class=tokenizer,
    )

    print("→ training…")
    trainer.train()
    trainer.save_model(str(args.out_dir))
    tokenizer.save_pretrained(str(args.out_dir))

    metrics = trainer.evaluate()
    (args.out_dir / "eval_metrics.json").write_text(json.dumps(metrics, indent=2))
    print(f"→ eval metrics: {metrics}")

    print(f"✅ saved adapter + tokenizer to {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
