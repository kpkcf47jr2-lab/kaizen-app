#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  Espera a que Oracle libere capacidad Ampere A1 y lanza la VM de Kaizen.
#
#  El free tier de Oracle da 2 OCPU / 12 GB de A1 gratis para siempre, pero
#  en Ashburn casi nunca hay hardware libre: al 2026-09-03 los tres dominios
#  daban OUT_OF_HOST_CAPACITY hasta para 1 OCPU / 6 GB. La capacidad se
#  libera de a ratos, así que la estrategia es esperarla, no forzarla.
#
#  Consultar el reporte de capacidad NO crea nada y no cuesta nada, así que
#  se puede sondear seguido. Sólo se intenta el lanzamiento cuando el
#  dominio dice AVAILABLE, y se corta apenas una instancia queda RUNNING.
#
#  Uso:
#    bash deploy/wait-for-a1.sh              # en primer plano
#    nohup bash deploy/wait-for-a1.sh > ~/kaizen-a1.log 2>&1 &   # de fondo
#
#  Parar:  pkill -f wait-for-a1.sh
#  Mirar:  tail -f ~/kaizen-a1.log
# ═══════════════════════════════════════════════════════════════════════
set -u

PROFILE="${OCI_PROFILE:-APIKEY}"
T=ocid1.tenancy.oc1..aaaaaaaav3e3gg4qaif2yyjtd22iy6ra4kl3umb2tyx2orunkbjug73qb2ta
SUBNET=ocid1.subnet.oc1.iad.aaaaaaaadka4ij6r4hmrhg4a3kobnwal63rioeivyuk5nh2yazkkidwts7yq
IMG=ocid1.image.oc1.iad.aaaaaaaacuygljashkvpqu5qqmlausq2vwrwasp3lxpbpitxjhvbhsktlhma
NAME="${KAIZEN_VM_NAME:-kaizen-01}"
KEY="${KAIZEN_SSH_PUBKEY:-$HOME/.ssh/kaizen-deploy.pub}"
OCPUS="${KAIZEN_OCPUS:-2}"
RAM="${KAIZEN_RAM_GB:-12}"
SLEEP="${KAIZEN_POLL_SECONDS:-90}"
ADS=(lSkf:US-ASHBURN-AD-1 lSkf:US-ASHBURN-AD-2 lSkf:US-ASHBURN-AD-3)

log() { printf "[%s] %s\n" "$(date '+%F %T')" "$*"; }

[[ -f "$KEY" ]] || { log "FALTA la llave pública: $KEY"; exit 1; }

# Si ya existe, no hay nada que hacer. Evita duplicar la VM si el vigía
# se relanza por error mientras otra corrida ya la creó.
if oci --profile "$PROFILE" compute instance list --compartment-id "$T" --all \
     --query "data[?\"display-name\"=='$NAME' && \"lifecycle-state\"!='TERMINATED'] | length(@)" \
     --raw-output 2>/dev/null | grep -qvx 0; then
  log "Ya existe una instancia '$NAME'. Nada que hacer."
  exit 0
fi

log "Vigilando capacidad A1 ($OCPUS OCPU / $RAM GB) cada ${SLEEP}s. Ctrl+C para parar."
INTENTO=0

while true; do
  INTENTO=$((INTENTO + 1))
  for AD in "${ADS[@]}"; do
    ESTADO=$(oci --profile "$PROFILE" compute compute-capacity-report create \
      --compartment-id "$T" --availability-domain "$AD" \
      --shape-availabilities "[{\"instanceShape\":\"VM.Standard.A1.Flex\",\"instanceShapeConfig\":{\"ocpus\":$OCPUS.0,\"memoryInGBs\":$RAM.0}}]" \
      2>/dev/null | grep -oE '"availability-status": "[^"]*"' | head -1 | cut -d'"' -f4)

    [[ "$ESTADO" == "AVAILABLE" ]] || continue

    log "¡Capacidad en ${AD##*:}! Lanzando…"
    SALIDA=$(oci --profile "$PROFILE" compute instance launch \
      --compartment-id "$T" --availability-domain "$AD" \
      --shape VM.Standard.A1.Flex \
      --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$RAM}" \
      --image-id "$IMG" --subnet-id "$SUBNET" \
      --display-name "$NAME" --assign-public-ip true \
      --ssh-authorized-keys-file "$KEY" \
      --wait-for-state RUNNING --wait-interval-seconds 10 2>&1)

    if grep -q '"lifecycle-state": "RUNNING"' <<<"$SALIDA"; then
      IP=$(oci --profile "$PROFILE" compute instance list-vnics \
        --instance-id "$(grep -oE '"id": "ocid1\.instance[^"]*"' <<<"$SALIDA" | head -1 | cut -d'"' -f4)" \
        --query 'data[0]."public-ip"' --raw-output 2>/dev/null)
      log "✅ LISTA. IP pública: ${IP:-(consultá la consola)}"
      log "   Probá:  ssh -i ${KEY%.pub} ubuntu@${IP}"
      exit 0
    fi

    # Otro cliente puede habérsela llevado entre la consulta y el lanzamiento.
    log "   El lanzamiento no prosperó: $(grep -iEm1 'out of host capacity|message' <<<"$SALIDA" | tr -s ' ')"
  done

  [[ $((INTENTO % 20)) -eq 0 ]] && log "sigo esperando… ($INTENTO rondas)"
  sleep "$SLEEP"
done
