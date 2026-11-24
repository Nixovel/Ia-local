#!/bin/bash
# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# Compilateur .exe du labo Linux (outil build_exe de l'agent) : compile un programme en exécutable Windows.
#   lumen-exe.sh <c|cpp|csharp|go|rust> <nom> <x64|arm64> <console|gui> <dossier des sources> <fichier .exe>
# Les compilateurs (dernières versions publiées) s'installent au premier besoin dans /workspace/.outils et y restent :
# LLVM-MinGW (C, C++ et éditeur de liens de Rust), Go, .NET, Rust.
set -euo pipefail
lang=$1 name=$2 arch=$3 kind=$4 src=$5 out=$6
T=/workspace/.outils
mkdir -p "$T"
A=$(uname -m) # aarch64 ou x86_64 : outils natifs du labo
say() { echo "› $*"; }
triple=$([ "$arch" = arm64 ] && echo aarch64-w64-mingw32 || echo x86_64-w64-mingw32)

need_llvm_mingw() {
  if [ ! -x "$T/llvm-mingw/bin/clang" ]; then
    say "Installation de LLVM-MinGW (dernière version)…"
    local u
    u=$(curl -fsSL https://api.github.com/repos/mstorsjo/llvm-mingw/releases/latest |
      jq -r --arg a "$A" '.assets[].browser_download_url | select(test("-ucrt-ubuntu-[0-9.]+-" + $a + "\\.tar\\.xz$"))' | head -1)
    [ -n "$u" ] || { echo "LLVM-MinGW introuvable pour $A" >&2; exit 1; }
    curl -fsSL "$u" -o /tmp/llvm-mingw.tar.xz
    rm -rf "$T/llvm-mingw.tmp" && mkdir -p "$T/llvm-mingw.tmp"
    tar -xJf /tmp/llvm-mingw.tar.xz -C "$T/llvm-mingw.tmp" --strip-components=1
    rm -f /tmp/llvm-mingw.tar.xz
    rm -rf "$T/llvm-mingw" && mv "$T/llvm-mingw.tmp" "$T/llvm-mingw"
  fi
  export PATH="$T/llvm-mingw/bin:$PATH"
}

need_go() {
  if [ ! -x "$T/go/bin/go" ]; then
    local ga j f s
    ga=$([ "$A" = aarch64 ] && echo arm64 || echo amd64)
    j=$(curl -fsSL 'https://go.dev/dl/?mode=json')
    f=$(jq -r --arg a "$ga" '.[0].files[] | select(.os=="linux" and .arch==$a and .kind=="archive") | .filename' <<<"$j")
    s=$(jq -r --arg a "$ga" '.[0].files[] | select(.os=="linux" and .arch==$a and .kind=="archive") | .sha256' <<<"$j")
    say "Installation de Go (${f%%.linux*})…"
    curl -fsSL "https://go.dev/dl/$f" -o /tmp/go.tgz
    echo "$s  /tmp/go.tgz" | sha256sum -c - >/dev/null
    rm -rf "$T/go" && tar -xzf /tmp/go.tgz -C "$T" && rm -f /tmp/go.tgz
  fi
  export PATH="$T/go/bin:$PATH" GOPATH="$T/gopath" GOMODCACHE="$T/gopath/pkg/mod" GOCACHE="$T/gocache" GOTOOLCHAIN=local GOFLAGS=-modcacherw
}

need_dotnet() {
  if [ ! -x "$T/dotnet/dotnet" ]; then
    local ch
    # Dernière version de .NET en support actif (ni préversion, ni fin de vie)
    ch=$(curl -fsSL https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json |
      jq -r '[."releases-index"[] | select(."support-phase"=="active")] | sort_by(."channel-version" | split(".") | map(tonumber)) | last | ."channel-version"')
    say "Installation de .NET $ch (dernière version)…"
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh
    bash /tmp/dotnet-install.sh --channel "$ch" --install-dir "$T/dotnet" --no-path >/dev/null
    rm -f /tmp/dotnet-install.sh
  fi
  export DOTNET_ROOT="$T/dotnet" PATH="$T/dotnet:$PATH" DOTNET_CLI_HOME="$T/dotnet-home" NUGET_PACKAGES="$T/nuget" \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
}

need_rust() {
  export RUSTUP_HOME="$T/rustup" CARGO_HOME="$T/cargo" PATH="$T/cargo/bin:$PATH"
  if [ ! -x "$T/cargo/bin/cargo" ]; then
    say "Installation de Rust (dernière version stable)…"
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path >/dev/null 2>&1
  fi
}

cd "$src"
mkdir -p "$(dirname "$out")"
rm -f "$out"
case "$lang" in
c | cpp)
  need_llvm_mingw
  if [ "$lang" = c ]; then
    cc="$triple-clang"
    mapfile -t files < <(find . -type f -name '*.c' -not -path './.*' | sort)
  else
    cc="$triple-clang++"
    mapfile -t files < <(find . -type f \( -name '*.cpp' -o -name '*.cc' -o -name '*.cxx' -o -name '*.c' \) -not -path './.*' | sort)
  fi
  [ "${#files[@]}" -gt 0 ] || { echo "Aucun fichier source $lang dans $src" >&2; exit 1; }
  flags=(-O2 -s -static -I.)
  [ "$kind" = gui ] && flags+=(-mwindows)
  if grep -qE '\b(wmain|wWinMain)\b' "${files[@]}"; then flags+=(-municode); fi
  # Ressources Windows (icône, version…) : fichiers .rc
  mapfile -t rcs < <(find . -type f -name '*.rc' -not -path './.*' | sort)
  objs=()
  for rc in "${rcs[@]}"; do
    "$triple-windres" "$rc" -O coff -o "/tmp/$(basename "$rc").res.o"
    objs+=("/tmp/$(basename "$rc").res.o")
  done
  say "$("$cc" --version | head -1) → $triple"
  "$cc" "${flags[@]}" "${files[@]}" "${objs[@]}" -o "$out" \
    -luser32 -lgdi32 -lcomctl32 -lcomdlg32 -lshell32 -lole32 -loleaut32 -luuid -lws2_32 -ladvapi32 -lwinmm
  ;;
go)
  need_go
  [ -f go.mod ] || go mod init "$(echo "$name" | tr 'A-Z' 'a-z')" >/dev/null 2>&1
  go mod tidy >/dev/null 2>&1 || true
  ld="-s -w"
  [ "$kind" = gui ] && ld="$ld -H windowsgui"
  say "$(go version)"
  CGO_ENABLED=0 GOOS=windows GOARCH=$([ "$arch" = arm64 ] && echo arm64 || echo amd64) go build -trimpath -ldflags "$ld" -o "$out" .
  ;;
csharp)
  need_dotnet
  proj=$(find . -maxdepth 2 -name '*.csproj' -not -path './.*' | head -1)
  if [ -z "$proj" ]; then
    # Pas de projet : celui du modèle officiel (console, ou fenêtre WinForms), avec les sources de l'utilisateur
    tpl=$([ "$kind" = gui ] && echo winforms || echo console)
    tmp=$(mktemp -d)
    dotnet new "$tpl" -n "$name" -o "$tmp" >/dev/null
    cp "$tmp/$name.csproj" .
    ls ./*.cs >/dev/null 2>&1 || cp "$tmp"/*.cs .
    rm -rf "$tmp"
    proj="./$name.csproj"
  fi
  rid=$([ "$arch" = arm64 ] && echo win-arm64 || echo win-x64)
  say ".NET $(dotnet --version) → $rid (exécutable autonome)"
  pub=$(mktemp -d)
  dotnet publish "$proj" -c Release -r "$rid" --self-contained true -o "$pub" --nologo -v q \
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true \
    -p:EnableWindowsTargeting=true -p:DebugType=none -p:AssemblyName="$name"
  cp "$pub/$name.exe" "$out"
  rm -rf "$pub"
  ;;
rust)
  need_llvm_mingw
  need_rust
  t=$([ "$arch" = arm64 ] && echo aarch64-pc-windows-gnullvm || echo x86_64-pc-windows-gnullvm)
  rustup target add "$t" >/dev/null 2>&1
  if [ ! -f Cargo.toml ]; then
    mkdir -p src
    [ -f main.rs ] && mv main.rs src/main.rs
    printf '[package]\nname = "%s"\nversion = "0.1.0"\nedition = "2024"\n\n[profile.release]\nstrip = true\n' \
      "$(echo "$name" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_\n' '_')" >Cargo.toml
  fi
  if [ "$kind" = gui ] && [ -f src/main.rs ] && ! grep -q windows_subsystem src/main.rs; then
    sed -i '1i #![windows_subsystem = "windows"]' src/main.rs
  fi
  export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER=x86_64-w64-mingw32-clang \
    CARGO_TARGET_AARCH64_PC_WINDOWS_GNULLVM_LINKER=aarch64-w64-mingw32-clang CARGO_TARGET_DIR=/tmp/lumen-rust-target
  say "$(rustc --version) → $t"
  cargo build --release --target "$t" --quiet
  bin=$(cargo metadata --no-deps --format-version 1 | jq -r '[.packages[0].targets[] | select(.kind[] == "bin")][0].name')
  cp "/tmp/lumen-rust-target/$t/release/$bin.exe" "$out"
  ;;
*)
  echo "Langage non pris en charge ici : $lang" >&2
  exit 1
  ;;
esac
say "$(file -b "$out")"
