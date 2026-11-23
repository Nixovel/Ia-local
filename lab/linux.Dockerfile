# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# Labo Linux de Lumen : machine de développement isolée où l'IA écrit, compile et teste des programmes.
# Seul le dossier « Lumen Labo/linux » de l'utilisateur y est partagé (monté sur /workspace).
# Versions : la dernière Ubuntu LTS, et la dernière Node.js LTS, choisie au moment de la construction.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Europe/Paris DISPLAY=:99 \
    PIP_BREAK_SYSTEM_PACKAGES=1 PIP_ROOT_USER_ACTION=ignore PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config gdb git curl wget ca-certificates gnupg \
      python3 python3-pip python3-venv python3-dev python3-tk \
      jq sqlite3 zip unzip xz-utils file less nano vim-tiny procps psmisc lsof \
      iproute2 iputils-ping bind9-dnsutils net-tools tzdata tini \
      xvfb x11-utils x11-apps xdotool imagemagick fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Node.js : dernière version LTS officielle (empreinte SHA-256 vérifiée)
RUN set -eu; \
    case "$(dpkg --print-architecture)" in amd64) a=x64 ;; arm64) a=arm64 ;; *) echo "architecture non prise en charge" >&2; exit 1 ;; esac; \
    v="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version')"; \
    file="node-$v-linux-$a.tar.xz"; base="https://nodejs.org/dist/$v"; \
    curl -fsSL "$base/$file" -o "/tmp/$file"; \
    curl -fsSL "$base/SHASUMS256.txt" | grep " $file\$" | (cd /tmp && sha256sum -c -); \
    tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "/tmp/$file"; node -v; npm -v

COPY entrypoint.sh /usr/local/bin/lumen-lab
RUN chmod +x /usr/local/bin/lumen-lab && mkdir -p /workspace
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/lumen-lab"]
