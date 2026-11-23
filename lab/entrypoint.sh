#!/bin/sh
# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# Démarrage d'un labo Lumen : écran virtuel pour les programmes graphiques (captures avec lab_screenshot,
# pilotage avec xdotool), puis le conteneur attend les commandes de l'agent (docker exec).
# Avec des arguments (« docker run image commande »), exécute simplement la commande.
if command -v Xvfb >/dev/null 2>&1; then
  rm -f /tmp/.X99-lock
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
fi
if [ "$#" -gt 0 ]; then exec "$@"; fi
exec sleep infinity
