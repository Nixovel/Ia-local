# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# Labo Windows de Lumen : exécute des programmes Windows (.exe, .bat, .msi, .NET) avec Wine, compile des programmes
# Windows (MinGW-w64 : C/C++ → .exe) et des scripts PowerShell. Processeur x86-64 (émulé sur les Mac Apple).
# Le dossier « Lumen Labo/windows » de l'utilisateur y est monté sur /workspace, vu par Windows comme C:\labo.
# Versions : dernière Ubuntu LTS, dernière Wine (WineHQ, branche de développement), dernier PowerShell.
FROM --platform=linux/amd64 ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Europe/Paris DISPLAY=:99 \
    WINEPREFIX=/root/.wine WINEARCH=win64 WINEDEBUG=-all WINEDLLOVERRIDES="mshtml=" \
    POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off DOTNET_CLI_TELEMETRY_OPTOUT=1

# Wine officiel (dépôt WineHQ) : la dernière version, en mode WoW64 (pas de bibliothèques i386)
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && mkdir -pm755 /etc/apt/keyrings \
    && curl -fsSL https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key \
    && curl -fsSL https://dl.winehq.org/wine-builds/ubuntu/dists/resolute/winehq-resolute.sources -o /etc/apt/sources.list.d/winehq-resolute.sources \
    && apt-get update && apt-get install -y --install-recommends winehq-devel \
    && apt-get install -y --no-install-recommends \
      mingw-w64 cabextract build-essential git wget python3 jq zip unzip xz-utils file less nano procps psmisc tzdata tini libicu-dev \
      libarchive-tools xvfb x11-utils x11-apps xdotool imagemagick fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    # Sous Rosetta (Mac Apple), GNU tar ne sait pas créer de sous-dossiers : « tar » = bsdtar (mêmes options courantes),
    # GNU tar reste disponible sous le nom « gtar ».
    && ln -s /usr/bin/bsdtar /usr/local/bin/tar && ln -s /usr/bin/tar /usr/local/bin/gtar

# PowerShell : dernière version publiée par Microsoft (empreinte SHA-256 vérifiée ; fichier d'empreintes en UTF-16)
RUN set -eu; \
    tag="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/PowerShell/PowerShell/releases/latest | sed 's#.*/tag/##')"; \
    file="powershell-${tag#v}-linux-x64.tar.gz"; base="https://github.com/PowerShell/PowerShell/releases/download/$tag"; \
    curl -fsSL "$base/$file" -o "/tmp/$file"; \
    curl -fsSL "$base/hashes.sha256" -o /tmp/hashes; \
    python3 -c "d=open('/tmp/hashes','rb').read(); print((d.decode('utf-16') if d[:2] in (b'\xff\xfe', b'\xfe\xff') else d.decode('utf-8-sig')).replace('\r', ''))" \
      | grep " \*$file\$" | sed 's/ \*/  /' > /tmp/sum; \
    test -s /tmp/sum; (cd /tmp && sha256sum -c /tmp/sum); \
    mkdir -p /opt/powershell; bsdtar -xzf "/tmp/$file" -C /opt/powershell; rm -f "/tmp/$file" /tmp/hashes /tmp/sum; \
    chmod +x /opt/powershell/pwsh; ln -sf /opt/powershell/pwsh /usr/local/bin/pwsh; \
    pwsh -NoProfile -c 'Get-Date -Format yyyy | Out-Null; "PowerShell " + $PSVersionTable.PSVersion.ToString()'

# Préfixe Wine prêt à l'emploi : Wine Mono (programmes .NET) dans la version attendue par cette Wine,
# C:\labo = le dossier partagé, et « cmd » = l'invite de commandes Windows
ARG MONO_FALLBACK=11.3.0
RUN set -eu; mkdir -p /workspace; \
    wv="$(wine --version | sed 's/^wine-//; s/ .*//')"; \
    mono="$(curl -fsSL "https://gitlab.winehq.org/wine/wine/-/raw/wine-$wv/dlls/appwiz.cpl/addons.c" | sed -n 's/^#define MONO_VERSION "\(.*\)"/\1/p')"; \
    mono="${mono:-$MONO_FALLBACK}"; \
    curl -fsSL "https://dl.winehq.org/wine/wine-mono/$mono/wine-mono-$mono-x86.msi" -o /tmp/wine-mono.msi; \
    wineboot --init; wineserver -w; \
    wine msiexec /i /tmp/wine-mono.msi /qn; wineserver -w; rm -f /tmp/wine-mono.msi; \
    test -d "$WINEPREFIX/drive_c/windows/mono"; \
    ln -s /workspace "$WINEPREFIX/drive_c/labo"; \
    printf '#!/bin/sh\n# Invite de commandes Windows (Wine) : cmd dir, cmd ver, cmd script.bat\nexec wine cmd /c "$@"\n' > /usr/local/bin/cmd; \
    chmod +x /usr/local/bin/cmd; echo "Wine $wv · Wine Mono $mono"

# « csc Prog.cs » : compilateur C# de Wine Mono. Sous Rosetta (Mac Apple), seule la bibliothèque de base de .NET se
# charge : en cas d'échec (CS0009), nouvel essai avec elle seule (-noconfig).
RUN printf '%s\n' '#!/bin/sh' \
      'csc=/root/.wine/drive_c/windows/mono/mono-2.0/lib/mono/4.5/csc.exe' \
      'out=$(wine "$csc" -nologo "$@" 2>&1); code=$?' \
      'if printf "%s" "$out" | grep -q CS0009; then' \
      '  echo "(références .NET indisponibles ici : compilation avec la bibliothèque de base seulement)" >&2' \
      '  exec wine "$csc" -nologo -noconfig "$@"' \
      'fi' \
      'printf "%s\n" "$out"; exit $code' > /usr/local/bin/csc \
    && chmod +x /usr/local/bin/csc

COPY entrypoint.sh /usr/local/bin/lumen-lab
RUN chmod +x /usr/local/bin/lumen-lab
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/lumen-lab"]
