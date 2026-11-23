#!/bin/bash
# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# Commande « android » du labo Android : la commande officielle de Google, avec un « android create » amélioré.
#  - Le projet créé passe aux dernières versions du greffon Android pour Gradle (AGP) et de Gradle : le modèle
#    officiel en fixe d'anciennes, qui ne reconnaissent pas le dernier SDK.
#  - Les modèles téléchargés restent en cache hors du dossier du projet.
real=/opt/android-sdk/cmdline-tools/latest/bin/android
[[ "${1:-}" == create ]] || exec "$real" "$@"

args=()
out="$PWD"
next=0
for a in "$@"; do
  if ((next)); then out="$a"; next=0; continue; fi
  case "$a" in
    -o | --output) next=1 ;;
    --output=*) out="${a#--output=}" ;;
    --list | -h | --help) exec "$real" "$@" ;;
    *) args+=("$a") ;;
  esac
done
[[ "$out" == /* ]] || out="$PWD/$out"

mkdir -p /opt/lumen/cache && cd /opt/lumen/cache || exit 1
"$real" "${args[@]}" -o "$out" || exit $?
cd "$out" || exit 1

agp="$(cat /opt/lumen/AGP_VERSION)"
gradle="$(cat /opt/gradle/VERSION)"
if [[ -f gradle/libs.versions.toml ]]; then
  sed -i -E "s/^(androidGradlePlugin|agp|android-gradle-plugin) *= *\"[^\"]+\"/\1 = \"$agp\"/" gradle/libs.versions.toml
fi
if [[ -f gradle/wrapper/gradle-wrapper.properties ]]; then
  sed -i -E "s#gradle-[0-9][0-9.]*-(bin|all)\.zip#gradle-$gradle-bin.zip#; /distributionSha256Sum/d" gradle/wrapper/gradle-wrapper.properties
fi
echo "Projet prêt : $out (Android Gradle Plugin $agp · Gradle $gradle)"
echo "Compiler : cd \"$out\" && ./gradlew assembleDebug   →   app/build/outputs/apk/debug/app-debug.apk"
