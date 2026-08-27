# Kaizen Training

End-to-end pipeline for fine-tuning Kaizen. Runs on any single GPU with
≥16GB VRAM. Primary host: Lightning AI (~80h/mo free). Backups: Kaggle
P100, Colab T4/L4.

## Flow

```
Oracle server                       Local / Lightning AI
─────────────                       ─────────────────────
kaizenDataset.js  ─── scp ──►       datasets/raw/*.jsonl
  (writes JSONL                          │
   per user turn)                        ▼
                                    curate_dataset.py
                                         │
                                         ▼
                                    datasets/curated/
                                     ├── train.jsonl
                                     ├── val.jsonl
                                     └── test.jsonl
                                         │
                                         ▼
                                    eval_baseline.py  → baseline_report.json
                                         │
                                         ▼
                                    sft_qlora.py
                                         │
                                         ▼
                                    training/adapters/kaizen-8b-v0.1/
                                     ├── adapter_model.safetensors  (small)
                                     ├── adapter_config.json
                                     └── eval_metrics.json
                                         │
                                         ▼
                                    eval_baseline.py --candidate ...
                                         │
                                         ▼
                                    Compare vs baseline
                                    │
                                    └── If perplexity ↓  AND  smoke pass ≥ baseline
                                        → promote adapter to production
                                        → push to HF Hub (private repo)
                                        → deploy via vLLM
```

## 0. Copy raw data from Oracle

Owner runs (has SSH key on Oracle):

```bash
# From your laptop, into this repo
cd /path/to/kaizen-app
mkdir -p datasets/raw
scp -r kairos@129.153.46.146:/opt/kairos/backend/data/kaizen-training/*.jsonl \
       datasets/raw/
```

## 1. Curate

```bash
python training/scripts/curate_dataset.py \
    --raw-dir     datasets/raw \
    --out-dir     datasets/curated \
    --system-prompt training/configs/kaizen_system_prompt.txt \
    --target-size 5000
```

Prints per-split stats. Manually eyeball a few `datasets/curated/train.jsonl`
rows to check quality before training.

## 2. Baseline eval (Lightning AI GPU session)

```bash
pip install -U torch transformers accelerate peft trl bitsandbytes datasets

python training/scripts/eval_baseline.py \
    --data-dir   datasets/curated \
    --report-out training/adapters/baseline_report.json
```

## 3. Train SFT + QLoRA

```bash
python training/scripts/sft_qlora.py \
    --data-dir   datasets/curated \
    --out-dir    training/adapters/kaizen-8b-v0.1 \
    --base-model Qwen/Qwen3-8B \
    --epochs     3
```

Expect ~2-4h on a single L4 / T4 for 5k rows × 3 epochs. Watch GPU RAM;
bump `--grad-accum` up if you OOM at seq-len 2048.

## 4. Compare vs baseline

```bash
python training/scripts/eval_baseline.py \
    --data-dir   datasets/curated \
    --candidate  training/adapters/kaizen-8b-v0.1 \
    --report-out training/adapters/kaizen-8b-v0.1/eval.json
```

Promote only if `eval.json["perplexity"] < baseline_report.json["perplexity"]`
AND smoke passes ≥ baseline.

## 5. Publish

Only adapters, never full weights (adapter ≈ 40-100 MB vs 16 GB base).

```bash
huggingface-cli login   # once
huggingface-cli repo create kaizen-llc/kaizen-8b-v0.1 --private
cd training/adapters/kaizen-8b-v0.1
huggingface-cli upload kaizen-llc/kaizen-8b-v0.1 .
```

## Notes

- Never distill from Claude, GPT-4, or any closed model's outputs. Anthropic /
  OpenAI TOS both prohibit training competitors. Use self-instruct with
  Qwen or DeepSeek if you need synthetic data.
- Never commit raw datasets — they contain user chats (hashed but still).
  `.gitignore` blocks `datasets/raw/` and `training/adapters/**/*.safetensors`.
- Every candidate adapter must beat the previous winner on perplexity AND
  the smoke set. Never deploy just because "it's newer".
