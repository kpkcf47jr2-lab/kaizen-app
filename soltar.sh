#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  Suelta a agt_demo con libertad total y muestra qué hizo.
#
#  Mueve DINERO REAL: agt_demo tiene ~$3 en USDC y ~$1.96 en WETH sobre
#  Base. Los topes de la Policy Engine (por transacción, diario, semanal y
#  por caída) siguen activos en CADA paso — son el airbag, no se tocan.
#
#  Uso:   bash ~/kaizen-app/soltar.sh
#  Parar: pkill -f "tsx backend/server.ts"
# ═══════════════════════════════════════════════════════════════════════
set -u
API=http://127.0.0.1:4711
AGENTE=agt_demo

curl -sf -m 5 "$API/healthz" >/dev/null || {
  echo "El backend no responde en $API"
  echo "Levantalo con:  cd ~/kaizen-app && bash arrancar.sh"
  exit 1
}

foto() {
  curl -s -m 60 "$API/agents/$AGENTE" | python3 -c "
import json,sys
d=json.load(sys.stdin); s=d['snapshot']
print('  patrimonio \$%.2f  | efectivo \$%.2f | invertido \$%.2f | caída %.1f%% | %s'
      % (s['netWorthUsd'], s['cashUsd'], s['investedUsd'], s['drawdownPct'], s['suggestedStatus']))
"
}

echo "═══ ANTES ═══"; foto
echo
echo "Soltándola… (puede tardar varios minutos, encadena hasta 10 pasos)"
echo

curl -s -m 900 -X POST "$API/agents/$AGENTE/tick" \
  -H 'content-type: application/json' \
  -d '{"operatorPrompt":"LIBERTAD TOTAL. El dueño quiere ver de qué sos capaz sola.\n\nObjetivo: llevar tu patrimonio de $7.55 a $10. No hay guion: el camino lo elegís vos. Podés investigar en la web, operar en cadena, vender algo, montar una landing, lo que se te ocurra y esté a tu alcance.\n\nUna sola cosa te pido: antes de gastar, investigá. Tenés web.search, web.fetch y web.scrape. Buscá una oportunidad concreta y verificable en vez de adivinar. Si vas a operar, pedí la cotización antes de ejecutar.\n\nEmpezá ahora. Encadená los pasos que necesites."}' \
  > /tmp/kaizen-tick.json 2>&1

python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/kaizen-tick.json'))
except Exception as e:
    print('No se pudo leer la respuesta:', e)
    print(open('/tmp/kaizen-tick.json').read()[:500])
    raise SystemExit(1)

print('═══ LO QUE HIZO ═══')
pasos = d.get('steps') or []
if not pasos:
    o = d.get('outcome', {})
    print('  No ejecutó herramientas. Desenlace:', o.get('kind'))
    print('  Razón:', str(o.get('reason') or o.get('error') or '')[:400])
else:
    for i, x in enumerate(pasos, 1):
        o = x['outcome']
        det = o.get('reason') or o.get('error') or ''
        print(f"  {i}. {x['tool']:26s} → {o['kind']:14s} {str(det)[:70]}")

print()
print('═══ LO QUE DIJO ═══')
print(' ', str(d.get('llmContent') or '(sin texto)')[:900])
u = d.get('usage') or {}
if u.get('total'):
    print()
    print('  tokens:', u['total'])
PY

echo
echo "═══ DESPUÉS ═══"; foto
echo
echo "Detalle completo en /tmp/kaizen-tick.json"
