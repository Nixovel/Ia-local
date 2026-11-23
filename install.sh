#!/usr/bin/env bash
# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# ──────────────────────────────────────────────────────────────────────────────
#  Installateur de Lumen — macOS et Linux (Windows : install.ps1)
#
#  Une commande installe tout, en détectant la machine :
#    curl -fsSL https://raw.githubusercontent.com/Nixovel/Ia-local/main/install.sh | bash
#  ou, depuis le dossier du dépôt :  ./install.sh
#
#  Étapes : système et processeur → Lumen → Node.js (portable, sans droits admin) → Ollama
#           → dépendances et build → modèle de départ adapté à la RAM → vérification → raccourcis → lancement.
#
#  Options (variables d'environnement) :
#    LUMEN_REPO=compte/depot   dépôt GitHub à installer      LUMEN_HOME=~/.lumen   dossier d'installation
#    LUMEN_NO_MODEL=1          ne pas télécharger de modèle   LUMEN_NO_LAUNCH=1     ne pas lancer Lumen à la fin
#    LUMEN_NO_SHORTCUTS=1      ni raccourci ni commande « lumen »
#    LUMEN_SKIP_OLLAMA=1       ne pas installer Ollama         OLLAMA_URL=http://…   Ollama sur une autre machine
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="${LUMEN_REPO:-Nixovel/Ia-local}"
BRANCH="${LUMEN_BRANCH:-main}"
LUMEN_HOME="${LUMEN_HOME:-$HOME/.lumen}"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
NODE_LINE="v24" # Node.js LTS installé si besoin

bold=$'\033[1m'; amber=$'\033[38;5;215m'; green=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; reset=$'\033[0m'
[ -t 1 ] || { bold=; amber=; green=; red=; dim=; reset=; }
step() { printf '\n%s▸ %s%s\n' "$amber$bold" "$1" "$reset"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
info() { printf '  %s%s%s\n' "$dim" "$1" "$reset"; }
warn() { printf '  %s!%s %s\n' "$amber" "$reset" "$1"; }
die() { printf '\n  %s✗ %s%s\n\n' "$red" "$1" "$reset" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
# Barre de progression seulement dans un terminal (sinon des centaines de lignes dans les journaux)
PROGRESS="-s"
[ -t 2 ] && PROGRESS="--progress-bar"
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false

# Questions : lues sur le terminal même quand le script arrive par « curl | bash » ; « oui » par défaut sans terminal
ask() {
  local answer=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '  %s %s[O/n]%s ' "$1" "$dim" "$reset" >/dev/tty
    read -r answer </dev/tty || answer=""
  fi
  case "$answer" in [nN]*) return 1 ;; *) return 0 ;; esac
}

printf '\n%s  Lumen%s — installation de votre interface IA locale\n' "$amber$bold" "$reset"
printf '%s  par Nixovel · https://github.com/Nixovel/Ia-local · © 2026, tous droits réservés%s\n' "$dim" "$reset"

# ── 1. Machine ────────────────────────────────────────────────────────────────
step "Analyse de la machine"
case "$(uname -s)" in
  Darwin) OS=darwin; OS_NAME="macOS $(sw_vers -productVersion 2>/dev/null || true)" ;;
  Linux) OS=linux; OS_NAME="$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo Linux)" ;;
  *) die "Système non pris en charge : $(uname -s). Sous Windows, utilisez install.ps1." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) die "Processeur non pris en charge : $(uname -m)" ;;
esac
if [ "$OS" = darwin ]; then
  RAM_GB=$(($(sysctl -n hw.memsize) / 1073741824))
else
  RAM_GB=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1048576))
fi
ok "$OS_NAME · processeur $ARCH · ${RAM_GB} Go de RAM"
has curl || die "« curl » est nécessaire. Installez-le (ex. sudo apt install curl) puis relancez."

# ── 2. Lumen ──────────────────────────────────────────────────────────────────
step "Lumen"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"name": "lumen"' "$SCRIPT_DIR/package.json"; then
  APP_DIR="$SCRIPT_DIR"
  ok "Dossier du dépôt : $APP_DIR"
else
  APP_DIR="$LUMEN_HOME/app"
  if has git; then
    if [ -d "$APP_DIR/.git" ]; then
      git -C "$APP_DIR" pull --ff-only --quiet && ok "Mis à jour : $APP_DIR"
    else
      mkdir -p "$LUMEN_HOME"
      git clone --quiet --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$APP_DIR" && ok "Téléchargé dans $APP_DIR"
    fi
  else
    # Sans git : archive du dépôt
    tmp="$(mktemp -d)"
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$tmp"
    rm -rf "$APP_DIR"
    mkdir -p "$LUMEN_HOME"
    mv "$tmp"/*/ "$APP_DIR"
    rm -rf "$tmp"
    ok "Téléchargé dans $APP_DIR"
  fi
fi

# ── 3. Node.js ────────────────────────────────────────────────────────────────
step "Node.js"
node_ok() {
  # Vite 8 : Node 20.19+ ou 22.12+
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)' 2>/dev/null
}
NODE_DIR="$LUMEN_HOME/node"
if has node && node_ok node; then
  ok "Node.js $(node -v) déjà installé"
elif [ -x "$NODE_DIR/bin/node" ] && node_ok "$NODE_DIR/bin/node"; then
  export PATH="$NODE_DIR/bin:$PATH"
  ok "Node.js $(node -v) (portable, $NODE_DIR)"
else
  info "Installation de Node.js $NODE_LINE (portable, dans $NODE_DIR, sans droits administrateur)…"
  base="https://nodejs.org/dist/latest-$NODE_LINE.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  file="$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v[0-9.]+-$OS-$ARCH\.tar\.gz$" | head -1)"
  [ -n "$file" ] || die "Aucune version de Node.js pour $OS-$ARCH."
  expected="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')"
  tmp="$(mktemp -d)"
  curl -fL $PROGRESS "$base/$file" -o "$tmp/$file"
  if has sha256sum; then actual="$(sha256sum "$tmp/$file" | awk '{print $1}')"; else actual="$(shasum -a 256 "$tmp/$file" | awk '{print $1}')"; fi
  [ "$actual" = "$expected" ] || die "Empreinte SHA-256 de Node.js incorrecte : téléchargement corrompu."
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components 1
  rm -rf "$tmp"
  export PATH="$NODE_DIR/bin:$PATH"
  ok "Node.js $(node -v) installé (empreinte vérifiée)"
fi

# ── 4. Ollama ─────────────────────────────────────────────────────────────────
step "Ollama (fait tourner les modèles d'IA)"
ollama_up() { curl -fsS --max-time 3 "$OLLAMA_URL/api/version" >/dev/null 2>&1; }
start_ollama() {
  if [ "$OS" = darwin ] && [ -d /Applications/Ollama.app -o -d "$HOME/Applications/Ollama.app" ]; then
    open -ga Ollama 2>/dev/null || true
  elif has systemctl && systemctl list-unit-files ollama.service >/dev/null 2>&1 && systemctl is-enabled ollama >/dev/null 2>&1; then
    systemctl is-active --quiet ollama || sudo systemctl start ollama || true
  elif has ollama; then
    nohup ollama serve >"$LUMEN_HOME/ollama.log" 2>&1 &
  fi
  for _ in $(seq 1 40); do ollama_up && return 0; sleep 1; done
  return 1
}
mkdir -p "$LUMEN_HOME"
if ollama_up; then
  ok "Ollama répond ($(curl -fsS "$OLLAMA_URL/api/version" | sed -E 's/.*"version":"([^"]+)".*/\1/'))"
elif [ "${LUMEN_SKIP_OLLAMA:-}" = 1 ]; then
  warn "Installation d'Ollama ignorée (LUMEN_SKIP_OLLAMA=1)"
else
  if ! has ollama && [ ! -d /Applications/Ollama.app ] && [ ! -d "$HOME/Applications/Ollama.app" ]; then
    if [ "$OS" = darwin ]; then
      info "Téléchargement de l'application Ollama officielle…"
      tmp="$(mktemp -d)"
      curl -fL $PROGRESS https://ollama.com/download/Ollama-darwin.zip -o "$tmp/Ollama.zip"
      dest=/Applications
      [ -w "$dest" ] || dest="$HOME/Applications"
      mkdir -p "$dest"
      ditto -xk "$tmp/Ollama.zip" "$dest"
      rm -rf "$tmp"
      ok "Ollama installé dans $dest"
    else
      info "Installation d'Ollama avec le script officiel (votre mot de passe peut être demandé)…"
      curl -fsSL https://ollama.com/install.sh | sh
      ok "Ollama installé"
    fi
  fi
  if start_ollama; then ok "Ollama démarré"; else warn "Ollama ne répond pas encore : lancez l'application Ollama (ou « ollama serve »), puis « lumen »."; fi
fi

# ── 5. Dépendances et build ───────────────────────────────────────────────────
step "Dépendances de Lumen"
cd "$APP_DIR"
info "npm install (quelques minutes la première fois)…"
npm ci --no-audit --no-fund --loglevel=error
ok "Dépendances installées"
info "Construction de l'application…"
npm run build --silent >"$LUMEN_HOME/build.log" 2>&1 || die "La construction a échoué : voir $LUMEN_HOME/build.log"
ok "Application construite"

# ── 6. Modèle de départ ───────────────────────────────────────────────────────
if [ "${LUMEN_NO_MODEL:-}" != 1 ] && ollama_up; then
  step "Modèle d'IA de départ"
  installed="$(curl -fsS "$OLLAMA_URL/api/tags" | grep -o '"name":"[^"]*"' | wc -l | tr -d ' ')"
  # Choisi selon la RAM (agent, réflexion et outils) ; l'assistant de Lumen propose ensuite un pack complet par usage
  if [ "$RAM_GB" -ge 15 ]; then MODEL=qwen3:8b; SIZE="5,2 Go"
  elif [ "$RAM_GB" -ge 7 ]; then MODEL=qwen3:4b; SIZE="2,5 Go"
  else MODEL=qwen3:1.7b; SIZE="1,4 Go"; fi
  if [ "$installed" -gt 0 ]; then
    ok "$installed modèle(s) déjà installé(s) — l'assistant de Lumen vous en proposera d'autres"
  elif ask "Télécharger $MODEL ($SIZE, adapté à ${RAM_GB} Go de RAM) pour commencer ?"; then
    info "Téléchargement de $MODEL…"
    curl -fsSN "$OLLAMA_URL/api/pull" -d "{\"model\":\"$MODEL\"}" | while IFS= read -r line; do
      total=$(printf '%s' "$line" | grep -o '"total":[0-9]*' | cut -d: -f2 || true)
      done_=$(printf '%s' "$line" | grep -o '"completed":[0-9]*' | cut -d: -f2 || true)
      if [ -n "$total" ] && [ -n "$done_" ] && [ "$total" -gt 0 ]; then printf '\r  %s %3d %%' "$MODEL" $((done_ * 100 / total)); fi
      case "$line" in *'"error"'*) printf '\n'; warn "$line" ;; esac
    done
    printf '\n'
    ok "$MODEL installé"
  fi
fi

# ── 7. Vérification ───────────────────────────────────────────────────────────
step "Vérification"
OLLAMA_URL="$OLLAMA_URL" node scripts/doctor.mjs --quiet || warn "Certaines vérifications ont échoué (détails ci-dessus)."

# ── 8. Commande « lumen » et raccourcis ───────────────────────────────────────
if [ "${LUMEN_NO_SHORTCUTS:-}" != 1 ]; then
  step "Raccourcis"
  mkdir -p "$LUMEN_HOME/bin"
  NODE_BIN="$(dirname "$(command -v node)")"
  cat >"$LUMEN_HOME/bin/lumen" <<LAUNCHER
#!/usr/bin/env bash
# Lance Lumen : démarre Ollama si besoin, le serveur local, puis ouvre le navigateur.
#   lumen          lancer       lumen update   mettre à jour       lumen doctor   tout vérifier
export PATH="$NODE_BIN:\$PATH"
APP_DIR="$APP_DIR"
OLLAMA_URL="$OLLAMA_URL"
URL="http://127.0.0.1:4173"
cd "\$APP_DIR" || exit 1
case "\${1:-}" in
  update) exec bash "\$APP_DIR/install.sh" ;;
  doctor) exec node scripts/doctor.mjs ;;
esac
up() { curl -fsS --max-time 2 "\$1" >/dev/null 2>&1; }
openurl() { if [ "$OS" = darwin ]; then open "\$1"; else (xdg-open "\$1" >/dev/null 2>&1 &); fi; }
if ! up "\$OLLAMA_URL/api/version"; then
  if [ "$OS" = darwin ]; then open -ga Ollama 2>/dev/null || (nohup ollama serve >/dev/null 2>&1 &)
  else (systemctl is-active --quiet ollama 2>/dev/null) || (nohup ollama serve >/dev/null 2>&1 &); fi
  for _ in \$(seq 1 30); do up "\$OLLAMA_URL/api/version" && break; sleep 1; done
fi
if up "\$URL"; then openurl "\$URL"; exit 0; fi # déjà lancé
OLLAMA_URL="\$OLLAMA_URL" node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort >"$LUMEN_HOME/lumen.log" 2>&1 &
pid=\$!
trap 'kill \$pid 2>/dev/null' INT TERM EXIT
for _ in \$(seq 1 60); do up "\$URL" && break; sleep 0.5; done
openurl "\$URL"
echo "Lumen tourne sur \$URL — fermez cette fenêtre (ou Ctrl+C) pour l'arrêter."
wait \$pid
LAUNCHER
  chmod +x "$LUMEN_HOME/bin/lumen"
  ok "Commande : $LUMEN_HOME/bin/lumen"

  # Commande « lumen » dans le terminal (ligne ajoutée une seule fois)
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$rc" ] || { [ "$rc" = "$HOME/.zshrc" ] && [ "$OS" = darwin ]; }; then
      grep -q '# lumen-path' "$rc" 2>/dev/null || printf '\nexport PATH="%s/bin:$PATH" # lumen-path\n' "$LUMEN_HOME" >>"$rc"
    fi
  done

  if [ "$OS" = darwin ]; then
    # Petite application « Lumen » dans ~/Applications (Launchpad, Spotlight, Dock)
    APP="$HOME/Applications/Lumen.app"
    mkdir -p "$APP/Contents/MacOS"
    cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Lumen</string>
  <key>CFBundleIdentifier</key><string>local.lumen.app</string>
  <key>CFBundleExecutable</key><string>Lumen</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
PLIST
    printf '#!/bin/bash\nexec "%s/bin/lumen"\n' "$LUMEN_HOME" >"$APP/Contents/MacOS/Lumen"
    chmod +x "$APP/Contents/MacOS/Lumen"
    ok "Application : ~/Applications/Lumen.app (Spotlight : « Lumen »)"
  else
    mkdir -p "$HOME/.local/share/applications"
    cat >"$HOME/.local/share/applications/lumen.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Lumen
Comment=Interface pour vos modèles d'IA locaux
Exec=$LUMEN_HOME/bin/lumen
Terminal=false
Categories=Utility;Development;
DESKTOP
    ok "Raccourci ajouté au menu des applications"
  fi
fi

# ── 9. Lancement ──────────────────────────────────────────────────────────────
printf '\n%s  Lumen est installé.%s\n' "$green$bold" "$reset"
info "Lancer plus tard : « lumen » dans un nouveau terminal, ou l'application Lumen. Vérifier : « lumen doctor »."
if [ "${LUMEN_NO_LAUNCH:-}" != 1 ] && [ "${LUMEN_NO_SHORTCUTS:-}" != 1 ]; then
  exec "$LUMEN_HOME/bin/lumen"
fi
