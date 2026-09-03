#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  Levanta el CEREBRO PROPIO de Kaizen: Qwen3-8B + su adaptador LoRA,
#  servido por vLLM en un endpoint compatible con OpenAI.
#
#  Por qué existe: los adaptadores están entrenados desde el 28/08
#  (v0.1 eval_loss 0.526, v0.2 0.518 · 87.2% de precisión por token) pero
#  producción seguía llamando a deepseek-v4-flash en los servidores de
#  NVIDIA — un modelo alquilado, compartido y sin estado, que no aprende
#  nada de lo que ella hace. Su cerebro estaba en el disco, sin enchufar.
#
#  Corre en cualquier host con GPU: la propia, o una alquilada por ella
#  misma en modo producción. Necesita ≥20 GB de VRAM para 8B en bf16 con
#  LoRA; con 24 GB (RTX 4090 / L4 / A10) va holgado.
#
#  Uso en el host con GPU:
#     bash training/scripts/serve_brain.sh                  # v0.2 (la mejor)
#     bash training/scripts/serve_brain.sh kaizen-8b-v0.1   # otra versión
#
#  Al final imprime la línea exacta que hay que poner en el .env del
#  backend para que la agente deje de alquilar cerebro y use el suyo.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

VERSION="${1:-kaizen-8b-v0.2}"
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
ADAPTADOR="$RAIZ/training/adapters/$VERSION"
BASE="${KAIZEN_BASE_MODEL:-Qwen/Qwen3-8B}"
PUERTO="${KAIZEN_VLLM_PORT:-8000}"
HOST="${KAIZEN_VLLM_HOST:-0.0.0.0}"
MAXLEN="${KAIZEN_VLLM_MAX_LEN:-8192}"

log() { printf "\033[1;36m[cerebro]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[cerebro:error]\033[0m %s\n" "$*" >&2; exit 1; }

[[ -d "$ADAPTADOR" ]] || die "No existe el adaptador: $ADAPTADOR
Versiones disponibles: $(ls "$RAIZ/training/adapters" 2>/dev/null | tr '\n' ' ')"
[[ -f "$ADAPTADOR/adapter_model.safetensors" ]] || die "Falta adapter_model.safetensors en $ADAPTADOR"

# ── GPU ───────────────────────────────────────────────────────────────
if ! command -v nvidia-smi >/dev/null 2>&1; then
  die "No hay GPU NVIDIA en esta máquina.
Este script va en el host con GPU: la propia, o una alquilada.
Desde el backend, la agente puede alquilar una con la herramienta compute.rentGpu."
fi
VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
log "GPU detectada con ${VRAM} MiB de VRAM"
[[ "$VRAM" -ge 20000 ]] || log "AVISO: menos de 20 GB. Si se queda sin memoria, bajá KAIZEN_VLLM_MAX_LEN."

# ── vLLM ──────────────────────────────────────────────────────────────
if ! python3 -c "import vllm" 2>/dev/null; then
  log "vLLM no está instalado; instalando (tarda unos minutos)…"
  pip install --quiet "vllm>=0.6.0" || die "Falló la instalación de vLLM"
fi

METRICAS="$ADAPTADOR/eval_metrics.json"
if [[ -f "$METRICAS" ]]; then
  log "Sirviendo $VERSION — $(python3 -c "
import json;d=json.load(open('$METRICAS'))
print(f\"eval_loss {d.get('eval_loss',0):.4f} · precisión {d.get('eval_mean_token_accuracy',0)*100:.1f}%\")
" 2>/dev/null || echo "$VERSION")"
fi

log "Base: $BASE   ·   Adaptador: $VERSION   ·   Puerto: $PUERTO"
log "Arrancando vLLM… (la primera vez descarga el modelo base, ~16 GB)"

# --enable-lora sirve el adaptador SIN fusionarlo: así se puede cambiar de
# versión sin volver a descargar ni fusionar los 8B del modelo base.
python3 -m vllm.entrypoints.openai.api_server \
  --model "$BASE" \
  --enable-lora \
  --lora-modules "kaizen=$ADAPTADOR" \
  --max-model-len "$MAXLEN" \
  --host "$HOST" \
  --port "$PUERTO" \
  --served-model-name "$BASE" "kaizen" &
VLLM_PID=$!

limpiar() { kill "$VLLM_PID" 2>/dev/null || true; }
trap limpiar EXIT INT TERM

log "Esperando a que el cerebro despierte…"
for i in $(seq 1 90); do
  sleep 10
  if curl -sf -m 5 "http://127.0.0.1:$PUERTO/v1/models" >/dev/null 2>&1; then
    IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo
    log "✅ Cerebro propio en línea."
    echo
    echo "  Poné esto en el .env del backend y reinicialo:"
    echo
    echo "    KAIZEN_LLM_BASE_URL=http://${IP:-127.0.0.1}:$PUERTO/v1"
    echo "    KAIZEN_LLM_MODEL=kaizen"
    echo "    KAIZEN_LLM_API_KEY="
    echo
    echo "  A partir de ahí deja de alquilar cerebro: piensa con el suyo,"
    echo "  entrenado con lo que ella misma hizo."
    echo
    wait "$VLLM_PID"
    exit 0
  fi
done

die "vLLM no respondió en 15 minutos. Revisá la salida de arriba."
