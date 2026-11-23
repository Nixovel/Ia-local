# Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
# Labo Android de Lumen : construit des applications Android (Gradle, Kotlin/Java, SDK Android) à l'écart de
# l'ordinateur. Les applications sont testées sur un téléphone virtuel (émulateur Android de l'ordinateur,
# accéléré par le processeur), piloté par l'outil android_adb de l'agent.
# Le dossier « Lumen Labo/android » de l'utilisateur y est monté sur /workspace.
# Versions : dernière Ubuntu LTS, dernier JDK LTS, derniers Gradle, outils, plateforme et build-tools Android.
# Licences du SDK : celles que l'utilisateur a acceptées (contexte de construction « licenses »).
# Processeur x86-64 : les outils Android pour Linux (aapt2…) n'existent qu'en x86-64 (émulé sur les Mac Apple).
FROM --platform=linux/amd64 ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=Europe/Paris \
    ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk GRADLE_USER_HOME=/root/.gradle \
    PATH=/opt/lumen/bin:/opt/gradle/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:$PATH \
    GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.welcome=never"

RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-25-jdk-headless git curl wget ca-certificates unzip zip jq python3 file less nano procps psmisc tzdata tini xz-utils libarchive-tools \
    && rm -rf /var/lib/apt/lists/* \
    # Sous Rosetta (Mac Apple), GNU tar ne sait pas créer de sous-dossiers : « tar » = bsdtar, GNU tar = « gtar »
    && ln -s /usr/bin/bsdtar /usr/local/bin/tar && ln -s /usr/bin/tar /usr/local/bin/gtar

# Outils en ligne de commande Android : la dernière version publiée par Google
RUN set -eu; \
    zip="$(curl -fsSL https://dl.google.com/android/repository/repository2-3.xml | grep -oE 'commandlinetools-linux-[0-9]+_latest\.zip' \
      | sed 's/^commandlinetools-linux-\([0-9]*\)_latest\.zip$/\1 &/' | sort -n | tail -1 | cut -d' ' -f2)"; \
    curl -fsSL "https://dl.google.com/android/repository/$zip" -o /tmp/tools.zip; \
    mkdir -p "$ANDROID_HOME/cmdline-tools" && unzip -q /tmp/tools.zip -d /tmp/tools && mv /tmp/tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"; \
    rm -rf /tmp/tools /tmp/tools.zip; echo "outils : $zip"

COPY --from=licenses . /opt/android-sdk/licenses/

# Dernières plateforme et build-tools stables, avec la nouvelle commande « android » de Google (qui remplace
# sdkmanager). Gradle téléchargera seul les autres versions qu'un projet demande.
RUN set -eu; all="$(android sdk list --all 2>/dev/null | awk '{print $1}')"; \
    platform="$(printf '%s\n' "$all" | grep -E '^platforms/android-[0-9]+(\.[0-9]+)?$' | sort -t- -k2 -V | tail -1)"; \
    tools="$(printf '%s\n' "$all" | grep -E '^build-tools/[0-9]+\.[0-9]+\.[0-9]+$' | sort -t/ -k2 -V | tail -1)"; \
    test -n "$platform" && test -n "$tools"; \
    android sdk install platform-tools "$platform" "$tools"; \
    echo "SDK : $platform · $tools"

# Gradle : dernière version stable (empreinte SHA-256 vérifiée)
RUN set -eu; j="$(curl -fsSL https://services.gradle.org/versions/current)"; \
    url="$(printf '%s' "$j" | jq -r .downloadUrl)"; sum="$(curl -fsSL "$(printf '%s' "$j" | jq -r .checksumUrl)")"; \
    curl -fsSL "$url" -o /tmp/gradle.zip; echo "$sum  /tmp/gradle.zip" | sha256sum -c -; \
    unzip -q /tmp/gradle.zip -d /opt && mv /opt/gradle-* /opt/gradle && rm /tmp/gradle.zip; \
    printf '%s' "$j" | jq -r .version > /opt/gradle/VERSION; gradle --version | grep -E '^(Gradle|JVM)'

# « android create » à jour : dernière version stable du greffon Android pour Gradle (AGP), appliquée aux projets créés
COPY android-create.sh /opt/lumen/bin/android
RUN set -eu; chmod +x /opt/lumen/bin/android; \
    agp="$(curl -fsSL https://dl.google.com/android/maven2/com/android/tools/build/gradle/maven-metadata.xml \
      | grep -oE '<version>[0-9]+\.[0-9]+\.[0-9]+</version>' | sed 's/<[^>]*>//g' | sort -V | tail -1)"; \
    test -n "$agp"; echo "$agp" > /opt/lumen/AGP_VERSION; echo "AGP $agp"

# Préchauffage : une application exemple (modèle officiel « android create ») est compilée une fois, ce qui vérifie
# toute la chaîne et remplit le cache Gradle (copié dans le volume du labo au premier démarrage).
RUN set -eu; mkdir -p /tmp/warm && cd /tmp/warm; \
    android create empty-activity --name "Lumen" --application-id dev.lumen.prechauffage -o app; \
    cd app && ./gradlew assembleDebug --no-daemon --console=plain; \
    ls -la app/build/outputs/apk/debug/; cd / && rm -rf /tmp/warm

COPY entrypoint.sh /usr/local/bin/lumen-lab
RUN chmod +x /usr/local/bin/lumen-lab && mkdir -p /workspace
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/lumen-lab"]
