#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# Kaizen — one-shot first training run.
#
# Runs entirely INSIDE the Lightning AI studio (SSH into kaizen-training
# once L4 is enabled, then execute this script). It:
#
#   1. Clones this repo from GitHub.
#   2. Installs the training deps.
#   3. Downloads the dataset (curated JSONL) — you scp it up first, see
#      the note below.
#   4. Runs baseline eval on Qwen3-8B (no adapter).
#   5. Trains Kaizen-8B-v0.1 with QLoRA on the curated dataset.
#   6. Runs comparative eval (baseline vs candidate).
#   7. Prints promote-or-discard verdict.
#
# BEFORE running:
#   From your laptop, upload the curated dataset to the studio:
#     lightning studio cp -r datasets/curated \
#       kairos-777-inc/default-project/kaizen-training:/teamspace/studios/this_studio/kaizen-app/datasets/
#
#   (or just push a public/private release of the dataset to HF Hub and
#    pull it here instead; scp is simplest for the first run.)
#
# Then, inside the studio shell:
#   bash training/scripts/run_first_training.sh
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/kpkcf47jr2-lab/kaizen-app.git}"
REPO_DIR="${REPO_DIR:-$HOME/kaizen-app}"
BASE_MODEL="${BASE_MODEL:-Qwen/Qwen3-8B}"
ADAPTER_NAME="${ADAPTER_NAME:-kaizen-8b-v0.1}"
EPOCHS="${EPOCHS:-3}"

echo "── [1/7] Environment check ──"
python3 -c "import torch; print(f'torch={torch.__version__}, cuda={torch.cuda.is_available()}, gpus={torch.cuda.device_count()}')" || {
    echo "torch missing; installing training stack…"
}

echo "── [2/7] Repo clone ──"
if [ ! -d "$REPO_DIR/.git" ]; then
    git clone "$REPO_URL" "$REPO_DIR"
else
    (cd "$REPO_DIR" && git pull --ff-only)
fi
cd "$REPO_DIR"

echo "── [3/7] Install deps ──"
pip install -q -U pip
pip install -q -U \
    torch \
    "transformers>=4.44" \
    accelerate \
    peft \
    "trl>=0.11" \
    bitsandbytes \
    datasets \
    sentencepiece

echo "── [4/7] Verify dataset present ──"
if [ ! -f datasets/curated/train.jsonl ]; then
    echo "✗ datasets/curated/train.jsonl missing."
    echo "  Upload it from your laptop first:"
    echo "  lightning studio cp -r datasets/curated kairos-777-inc/default-project/kaizen-training:$REPO_DIR/datasets/"
    exit 2
fi
wc -l datasets/curated/*.jsonl

echo "── [5/7] Baseline eval (Qwen3-8B, no adapter) ──"
python training/scripts/eval_baseline.py \
    --data-dir  datasets/curated \
    --base-model "$BASE_MODEL" \
    --report-out training/adapters/baseline_report.json

echo "── [6/7] SFT + QLoRA training (this is the slow step) ──"
python training/scripts/sft_qlora.py \
    --data-dir   datasets/curated \
    --out-dir    "training/adapters/$ADAPTER_NAME" \
    --base-model "$BASE_MODEL" \
    --epochs     "$EPOCHS"

echo "── [7/7] Comparative eval (candidate adapter vs baseline) ──"
python training/scripts/eval_baseline.py \
    --data-dir   datasets/curated \
    --base-model "$BASE_MODEL" \
    --candidate  "training/adapters/$ADAPTER_NAME" \
    --report-out "training/adapters/$ADAPTER_NAME/eval.json"

echo "── Verdict ──"
python3 - <<'PY'
import json, pathlib
base = json.loads(pathlib.Path("training/adapters/baseline_report.json").read_text())
cand = json.loads(pathlib.Path(f"training/adapters/${ADAPTER_NAME}/eval.json").read_text())
print(f"baseline  ppl={base['perplexity']:.3f}  smoke={base['smoke']['passed']}/{base['smoke']['total']}")
print(f"candidate ppl={cand['perplexity']:.3f}  smoke={cand['smoke']['passed']}/{cand['smoke']['total']}")
better_ppl = cand["perplexity"] < base["perplexity"]
same_or_better_smoke = cand["smoke"]["passed"] >= base["smoke"]["passed"]
if better_ppl and same_or_better_smoke:
    print("✅ PROMOTE — candidate beats baseline. Push adapter to HF Hub.")
else:
    print("❌ DISCARD — candidate did not clearly beat baseline. Iterate.")
PY

echo ""
echo "Done. Remember to stop the studio to conserve credits:"
echo "  # from your laptop:"
echo "  python training/scripts/lightning_setup.py --stop"
