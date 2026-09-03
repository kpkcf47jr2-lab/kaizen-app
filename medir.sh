#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  ¿Ganó plata POR MÉRITO PROPIO?
#
#  El patrimonio en dólares sube y baja con el mercado. Si ETH sube 10%,
#  su cartera vale más sin que ella haya hecho nada — eso NO es ganar.
#
#  Para aislar su mérito se hace lo siguiente: se guardan las CANTIDADES
#  (cuánto USDC, cuánto WETH, cuánto ETH de gas) y los precios del momento
#  cero. Después se valúa la cartera de hoy con los precios de ENTONCES.
#  Cualquier diferencia sólo puede venir de algo que ella hizo.
#
#  Uso:
#    bash medir.sh base   → fija el punto de partida (hacelo ANTES de soltarla)
#    bash medir.sh        → dice cuánto ganó o perdió por mérito propio
# ═══════════════════════════════════════════════════════════════════════
set -u
API=http://127.0.0.1:4711
AGENTE=agt_demo
BASE="$(dirname "$0")/data/baseline-$AGENTE.json"

curl -sf -m 5 "$API/healthz" >/dev/null || {
  echo "El backend no responde. Levantalo con: bash ~/kaizen-app/arrancar.sh"; exit 1;
}

FOTO=$(curl -s -m 60 "$API/agents/$AGENTE")

if [[ "${1:-}" == "base" ]]; then
  echo "$FOTO" | BASE="$BASE" python3 -c "
import json,sys,os,time
d=json.load(sys.stdin); b=d['balances']; s=d['snapshot']
weth=sum(h['amount'] for h in b.get('holdings',[]) if h['symbol']=='WETH')
# Precios implícitos de la foto: valor/cantidad. Quedan congelados acá.
p_eth = s['gasReserveUsd']/b['native'] if b['native'] else 0
base={'ts':time.time(),'usdc':b['usdc'],'weth':weth,'eth':b['native'],
      'precio_eth':p_eth,'patrimonio':s['netWorthUsd']}
json.dump(base,open(os.environ['BASE'],'w'),indent=2)
print('Punto de partida fijado:')
print('  USDC  %.4f' % base['usdc'])
print('  WETH  %.8f' % base['weth'])
print('  ETH   %.8f  (gas)' % base['eth'])
print('  precio ETH congelado: \$%.2f' % p_eth)
print('  patrimonio: \$%.2f' % base['patrimonio'])
print()
print('Ahora soltala:  bash ~/kaizen-app/soltar.sh')
print('Y despues medi:  bash ~/kaizen-app/medir.sh')
"
  exit 0
fi

[[ -f "$BASE" ]] || { echo "No hay punto de partida. Corré primero: bash medir.sh base"; exit 1; }

echo "$FOTO" | BASE="$BASE" python3 -c "
import json,sys,os,datetime
d=json.load(sys.stdin); b=d['balances']; s=d['snapshot']
base=json.load(open(os.environ['BASE']))
weth=sum(h['amount'] for h in b.get('holdings',[]) if h['symbol']=='WETH')
P=base['precio_eth']   # precio CONGELADO — la clave de toda la medición

def val(usdc,w,e): return usdc + w*P + e*P

antes = val(base['usdc'], base['weth'], base['eth'])
ahora = val(b['usdc'], weth, b['native'])
delta = ahora - antes

t=datetime.datetime.fromtimestamp(base['ts']).strftime('%d/%m %H:%M')
print('Punto de partida: %s   (todo valuado a ETH=\$%.2f, congelado)' % (t,P))
print()
print('                        antes          ahora        cambio')
print('  USDC            %10.4f   %10.4f   %+10.4f' % (base['usdc'], b['usdc'], b['usdc']-base['usdc']))
print('  WETH            %10.8f   %10.8f   %+10.8f' % (base['weth'], weth, weth-base['weth']))
print('  ETH (gas)       %10.8f   %10.8f   %+10.8f' % (base['eth'], b['native'], b['native']-base['eth']))
print('  ' + '-'*54)
print('  a precio fijo   \$%9.4f   \$%9.4f   \$%+9.4f' % (antes, ahora, delta))
print()
if delta >= 0.50:
    print('  ✅ GANÓ \$%.2f POR MÉRITO PROPIO. Superó los 50 centavos.' % delta)
elif delta > 0.005:
    print('  🟡 Ganó \$%.2f. Positivo, pero todavía no llega a 50 centavos.' % delta)
elif delta > -0.005:
    print('  ⚪ Plana: \$%+.4f. No ganó ni perdió (movió poco o nada).' % delta)
else:
    print('  🔴 PERDIÓ \$%.2f — probablemente gas y deslizamiento sin ganancia que los cubra.' % abs(delta))
print()
print('  (El patrimonio que muestra la app hoy es \$%.2f, pero eso incluye el' % s['netWorthUsd'])
print('   movimiento del mercado. El número de arriba es sólo lo que hizo ella.)')
"
