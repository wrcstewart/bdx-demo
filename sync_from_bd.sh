#!/bin/sh
# Refresh the files this demo COPIES from ButterflyDreaming.
#
# Three files here come from BD, and they are copies for a reason: the demo has
# to stand on its own, which is the entire point of it. But a copy rots. This
# repository's parent has watched two copies of music_module.html diverge, and
# a frozen standalone drift four ways from the live renderer.
#
# So the copying is DELIBERATE rather than accidental: this script is the only
# way they are refreshed, and each copy carries a header naming its source and
# the date it was taken. A copy that announces itself is survivable.
#
# bd_relay.js is the exception that proves it — it is byte-identical to the
# file BD's own server runs, and that is checked below rather than hoped for.
set -e
BD="${BD_REPO:-$HOME/butterflydreaming_graphviewer1}"
[ -d "$BD" ] || { echo "set BD_REPO to the ButterflyDreaming checkout"; exit 1; }
STAMP=$(date +%Y-%m-%d)

copy() {
  src="$BD/$1"; dst="$2"; note="$3"
  [ -f "$src" ] || { echo "missing: $src"; exit 1; }
  { printf '%s\n' "$note" | sed "s/@DATE@/$STAMP/"; cat "$src"; } > "$dst"
  echo "  $1 -> $dst"
}

echo "syncing from $BD"
cp "$BD/bd_relay.js" ./bd_relay.js
echo "  bd_relay.js (verbatim — must stay identical)"
copy AV/bd_av_client.js  ./bd_av_client.js \
  "/* Copied from ButterflyDreaming AV/bd_av_client.js on @DATE@ by sync_from_bd.sh.
   Do not edit here — edit it there and re-run the script. */"
copy V_Kolam/visual_module.html ./renderer.html \
  "<!-- Copied from ButterflyDreaming V_Kolam/visual_module.html on @DATE@ by
     sync_from_bd.sh. Do not edit here — edit it there and re-run the script. -->"

if cmp -s "$BD/bd_relay.js" ./bd_relay.js; then
  echo "bd_relay.js is identical to BD's — as it must be"
else
  echo "WARNING: bd_relay.js differs from BD's. It is meant to be one file, not two."
  exit 1
fi
