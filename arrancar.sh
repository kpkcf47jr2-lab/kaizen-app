#!/usr/bin/env bash
# Levanta el backend de Kaizen en local con el modo laboratorio activo.
#
#  El modo laboratorio le deja encadenar observar → actuar → ver resultado →
#  decidir de nuevo, en vez de un solo disparo por tick. Los topes de dinero
#  de la Policy Engine se aplican igual en CADA paso.
#
#  Uso:   bash ~/kaizen-app/arrancar.sh
#  Parar: pkill -f "tsx backend/server.ts"
#  Logs:  tail -f /tmp/kaizen-server.log
set -u
cd "$(dirname "$0")" || exit 1

[[ -f .env ]] || { echo "Falta el archivo .env"; exit 1; }

pkill -f "tsx backend/server.ts" 2>/dev/null
sleep 2

nohup bash -c 'set -a; source .env; set +a; export KAIZEN_LAB_MODE=1; export KAIZEN_LAB_MAX_STEPS=10; exec npm run server' \
  > /tmp/kaizen-server.log 2>&1 &
disown

for i in $(seq 1 20); do
  sleep 2
  if curl -sf -m 3 http://127.0.0.1:4711/healthz >/dev/null 2>&1; then
    echo "Kaizen viva en http://127.0.0.1:4711 (modo laboratorio, 10 pasos)"
    echo "Soltarla:  bash ~/kaizen-app/soltar.sh"
    exit 0
  fi
done

echo "No levantó. Últimas líneas del log:"
tail -20 /tmp/kaizen-server.log
exit 1
