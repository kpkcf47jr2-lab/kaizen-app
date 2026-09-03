#!/usr/bin/env bash
# Levanta el backend de Kaizen en local, en modo autónomo real.
#
#  MODO LABORATORIO  — encadena observar → actuar → ver resultado → decidir.
#  PASOS SIN TOPE    — sigue hasta que ella deje de pedir herramientas. Se
#                      corta sola sólo si repite la MISMA llamada con los
#                      MISMOS argumentos: eso no es trabajar, es girar en
#                      el vacío quemando tokens.
#  MODO HAMBRE       — existir le cuesta. Sin esto, esperar sale gratis y
#                      por eso siempre gana: en cuatro corridas investigó
#                      bien, concluyó que no había nada bueno, y no hizo
#                      nada. Con costo de vida, la inacción se paga.
#
#  Los topes de dinero de la Policy Engine siguen aplicándose en CADA paso,
#  y las prohibiciones absolutas (custodia de terceros, jurisdicciones
#  sancionadas, export de claves) siguen intactas. Eso es la capa de
#  delitos, y ninguna le impide ganar dinero.
#
#  Uso:   bash ~/kaizen-app/arrancar.sh
#  Parar: pkill -f "tsx backend/server.ts"
#  Logs:  tail -f /tmp/kaizen-server.log
set -u
cd "$(dirname "$0")" || exit 1

[[ -f .env ]] || { echo "Falta el archivo .env"; exit 1; }

pkill -f "tsx backend/server.ts" 2>/dev/null
sleep 2

nohup bash -c 'set -a; source .env; set +a
export KAIZEN_LAB_MODE=1
export KAIZEN_LAB_MAX_STEPS=${KAIZEN_LAB_MAX_STEPS:-0}
export KAIZEN_HAMBRE=${KAIZEN_HAMBRE:-1}
export KAIZEN_HAMBRE_USD_DIA=${KAIZEN_HAMBRE_USD_DIA:-3.00}
export KAIZEN_HAMBRE_PISO_USD=${KAIZEN_HAMBRE_PISO_USD:-1}
exec npm run server' > /tmp/kaizen-server.log 2>&1 &
disown

for i in $(seq 1 25); do
  sleep 2
  if curl -sf -m 3 http://127.0.0.1:4711/healthz >/dev/null 2>&1; then
    echo "Kaizen viva en http://127.0.0.1:4711/panel"
    grep -i "precios" /tmp/kaizen-server.log || true
    echo
    echo "  pasos por ciclo : sin tope"
    echo "  modo hambre     : \$3.00/día · se apaga bajo \$1.00 (~44h de autonomía)"
    echo "  memoria         : corto plazo (12 turnos) + lecciones acumuladas"
    echo
    echo "Abrí el panel y apretá 'Ponerla en bucle continuo'."
    exit 0
  fi
done

echo "No levantó. Últimas líneas del log:"
tail -20 /tmp/kaizen-server.log
exit 1
