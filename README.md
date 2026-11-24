# Lumen — interface pour vos modèles IA locaux

> Conçu et développé par **[Nixovel](https://github.com/Nixovel)** · © 2026 · tous droits réservés — voir [LICENSE](LICENSE)
> et [AUTHORSHIP.md](AUTHORSHIP.md). Dépôt officiel : https://github.com/Nixovel/Ia-local

Interface de chat premium (React + Vite + TypeScript) branchée sur **Ollama**. Tout tourne sur votre machine :
les conversations sont stockées dans le navigateur (IndexedDB), rien n'est envoyé en ligne.

Maquette Figma : https://www.figma.com/design/ZhCQJQa6sali7FNecXlQJa

## Installation (une commande, Mac, Windows, Linux)

L'installateur détecte le système et le processeur, puis installe ce qui manque — sans droits administrateur
quand c'est possible — et vérifie que tout fonctionne :

1. **Node.js** 24 LTS portable (dans `~/.lumen/node` ou `%LOCALAPPDATA%\Lumen\node`, empreinte SHA-256 vérifiée), s'il n'est
   pas déjà là ;
2. **Ollama**, depuis ses téléchargements officiels (Mac : application ; Windows : installateur silencieux ou winget ;
   Linux : script officiel), puis le démarre ;
3. les dépendances et la construction de Lumen ;
4. un **modèle de départ** adapté à la RAM (qwen3 8b / 4b / 1.7b, avec confirmation) — l'assistant de Lumen propose
   ensuite un pack complet par usage ;
5. une **vérification complète** (`lumen doctor` : Node, dépendances, moteurs vocaux, Ollama, et l'IA qui répond pour de vrai) ;
6. la commande **`lumen`**, une application (Mac : `~/Applications/Lumen.app`), un raccourci (Menu Démarrer et Bureau sous
   Windows, menu des applications sous Linux) — puis lance Lumen dans le navigateur.

**macOS / Linux** (Terminal) :

```bash
curl -fsSL https://raw.githubusercontent.com/Nixovel/Ia-local/main/install.sh | bash
```

**Windows 10 / 11** (PowerShell) :

```powershell
irm https://raw.githubusercontent.com/Nixovel/Ia-local/main/install.ps1 | iex
```

Ou depuis le dépôt cloné : `./install.sh` (Mac, Linux) ou `powershell -ExecutionPolicy Bypass -File install.ps1` (Windows).

Ensuite : **`lumen`** lance l'application, **`lumen doctor`** vérifie tout, **`lumen update`** met à jour. Dans l'application,
si Ollama manque ou est arrêté, l'accueil propose de l'**installer ou le démarrer automatiquement** ; Réglages → Diagnostic
refait la vérification.

Options : `LUMEN_HOME` (dossier d'installation), `LUMEN_NO_MODEL=1`, `LUMEN_NO_LAUNCH=1`, `LUMEN_NO_SHORTCUTS=1`,
`LUMEN_SKIP_OLLAMA=1`, `OLLAMA_URL=http://autre-machine:11434`. Désinstaller : supprimer `~/.lumen`
(`%LOCALAPPDATA%\Lumen` sous Windows), `~/Applications/Lumen.app` et la ligne `# lumen-path` de `~/.zshrc` / `~/.bashrc`.

Testé : macOS 27 (Apple Silicon) de bout en bout ; Ubuntu 24.04 (ARM, conteneur) de bout en bout ; Windows : syntaxe de
l'installateur et du lanceur validées avec PowerShell, exécution réelle à confirmer sur un PC Windows.

## Développement

```bash
npm install
npm run dev           # http://127.0.0.1:5173
npm run doctor        # vérification
```

Ollama sur une autre machine ou un autre port : `OLLAMA_URL=http://192.168.1.20:11434 npm run dev`.
Version installée (plus légère) : `npm run build && npm start` (http://127.0.0.1:4173, même proxy et même agent).

## Fonctionnalités

- **Chat en streaming** avec Markdown, tableaux, et affichage de la **réflexion** pour les modèles qui la supportent
  (bouton « Réflexion » : Auto par défaut — réfléchit seulement pour les demandes complexes —, Toujours ou Jamais ; « Répondre directement » coupe une réflexion en cours).
- **Écriture fluide** : le texte s'affiche au rythme réel du modèle (pas par paquets), chaque nouveau bloc apparaît
  en fondu, un curseur lumineux suit la fin du texte et le fil défile tout seul.
- **Blocs de code** colorés avec numéros de ligne, boutons **Copier**, **Télécharger** et **Ouvrir dans le panneau**.
- **Panneau fichier** : onglets par fichier, versions successives avec diff (+/− lignes surlignées), aperçu HTML/SVG
  (iframe isolée) et Markdown, téléchargement de tous les fichiers en `.zip`.
  Les noms de fichiers sont reconnus dans la ligne d'ouverture (` ```python:api/users.py `), en 1ʳᵉ ligne du code
  (`# api/users.py`) ou dans le titre qui précède le bloc (`### 3. app.py`).
- **Aperçu automatique** : quand une réponse se termine avec une page web, le panneau s'ouvre sur l'aperçu
  (de préférence `index.html`). Pour un projet, l'aperçu assemble les fichiers : `{% extends %}` / `{% block %}`
  Jinja résolus, CSS et JS locaux intégrés, autres balises Jinja simulées (pas de serveur dans l'aperçu ;
  les ressources CDN référencées par le code, comme Bootstrap, sont chargées depuis Internet).
- **Mode Agent** (bouton « Agent » dans la zone de saisie, modèles avec la capacité « Outils ») : le modèle agit sur
  l'ordinateur comme Claude Code — changer de dossier (`set_working_dir`), lister / lire / écrire des fichiers, lancer des
  commandes shell, ouvrir des applications, fichiers ou URL, AppleScript, capture d'écran. Exemple : « Travaille dans
  Documents/projet : crée un dossier test et fais dedans un portfolio HTML ». Les fichiers écrits apparaissent dans le
  panneau, et l'aperçu s'ouvre à la fin.
  - **Validation** : lire / lister dans le dossier de travail passe directement ; toute autre action affiche une carte
    « Autoriser · Toujours (pour cette conversation) · Refuser ». « Arrêter » annule les actions en attente.
  - **Pont local** (`agent/bridge.ts`, dans le serveur Vite) : uniquement sur 127.0.0.1, jeton aléatoire à chaque démarrage,
    requêtes d'autres sites refusées. Il n'existe que quand `npm run dev` / `npm run preview` tourne.
  - Dossier de travail par défaut : réglable dans Réglages (dossier personnel sinon).
  - Les modèles qui écrivent leurs appels d'outils en texte (JSON) sont aussi pris en charge.
- **Modèles adaptés à chaque PC** : Lumen détecte la machine (RAM, processeur, GPU Apple / NVIDIA / AMD, VRAM, disque
  libre) et classe chaque modèle « Fluide / Possible / Trop lourd ». « Modèles locaux » affiche « Votre machine » (limite
  fluide en Go et en milliards de paramètres) et, dans « Découvrir », le modèle conseillé pour chaque usage. Le sélecteur
  de modèle signale les modèles trop lourds. La logique est dans `src/lib/hardware.ts` (réutilisable par un futur
  installateur) ; la détection dans `agent/bridge.ts` (`GET /agent/system`).
- **Tous les usages** : Généraliste, Bureautique (mails, rédaction, résumés, traduction : Llama 3.2, Mistral, Mistral
  Nemo, Mistral Small, Gemma), Code, Raisonnement, Vision (lire des images) et Images (dessin). Le catalogue (61 modèles,
  noms et tailles vérifiés sur le registre Ollama) se filtre par usage dans « Découvrir ».
- **Standard ou non censuré** : un choix « Standard / Non censuré » (accueil et « Découvrir », mémorisé) propose soit les
  versions officielles, soit des versions modifiées qui refusent beaucoup moins (« abliterated » de huihui_ai, Dolphin),
  marquées « Non censuré ». Si aucune version non censurée ne tient sur le PC pour un usage, la version standard est
  proposée à la place.
- **Même un PC de 4 Go fait tourner au moins 3 modèles** : le catalogue contient des modèles minuscules (gemma3:270m/1b,
  qwen3:0.6b/1.7b, qwen2.5-coder:0.5b/1.5b, deepseek-r1:1.5b, llama3.2:1b, moondream et leurs versions non censurées) ;
  les recommandations ne proposent jamais deux fois le même modèle (4 Go : 4 modèles fluides en standard, 5 en non
  censuré) ; sur ≤ 6 Go, le contexte par défaut passe à 4k (mode petite mémoire). Les modèles se chargent un par un :
  Ollama change de modèle automatiquement.
- **Création d'images** : Ollama ne génère plus d'images de type photo (fonction expérimentale retirée en juillet 2026 ;
  il répond « image generation models are not currently supported »). Quand on demande une image (« dessine-moi… »,
  « crée un logo… »), le modèle la dessine en SVG : le dessin se construit en direct dans la conversation, puis se
  télécharge en SVG ou en PNG (bouton « Code » pour voir le source). Les modèles de code et Qwen3 dessinent le mieux.
- **Recherche Internet (option, désactivée par défaut)** : bouton « Web » dans la zone de saisie ou Réglages →
  « Recherche Internet ». Le modèle (avec la capacité « Outils ») appelle lui-même :
  - `weather` : météo actuelle et prévisions sur 7 jours (Open-Meteo, gratuit, sans compte) ; ville par défaut réglable ;
  - `web_search` : recherche web d'Ollama (gratuite, il suffit de relier Ollama à un compte ollama.com une fois, bouton
    « Relier Ollama » ou `ollama signin`) ; sans compte, recherche dans Wikipédia ;
  - `web_fetch` : lecture d'une page (via Ollama, sinon par le pont local, qui refuse les adresses locales et privées).
  Il reçoit la date et l'heure, et cite ses sources. Les modèles restent locaux ; seules les recherches partent en ligne
  (l'interface l'indique : « Recherche web » au lieu de « Mode hors ligne »).
- **Labos isolés Linux, Windows et Android** (bouton « Labo » dans la zone de saisie, ou Réglages → « Labos ») : le
  modèle écrit, compile, lance et teste ses programmes dans des machines à part (conteneurs Docker), sans toucher à
  l'ordinateur ; seul le dossier `~/Lumen Labo/<labo>` est partagé. Outils `lab_run`, `lab_write_file`,
  `lab_read_file`, `lab_screenshot`, `lab_copy_in` (copie d'un projet de l'ordinateur, avec votre accord) et `android_adb`.
  - **Linux** : Ubuntu 26.04 LTS, Python, Node.js LTS (dernière, choisie à la construction), GCC, CMake, Git… ; le
    modèle est root (`apt-get`, `pip`, `npm`).
  - **Windows** : Wine 11 (WineHQ, dernière version), MinGW-w64 (C/C++ → `.exe`), C# avec Wine Mono (`csc`),
    PowerShell 7 ; `C:\labo` = dossier partagé. Ce n'est pas un vrai Windows ; sur Mac Apple (émulation Rosetta), seuls
    les programmes 64 bits tournent et seule la bibliothèque de base de .NET se charge (pour du .NET complet, le labo
    Linux installe `dotnet-sdk-10.0`).
  - **Android** : JDK 25, Gradle, SDK Android (dernière plateforme), commande `android create` de Google (projets passés
    au dernier Android Gradle Plugin) ; les applis sont testées sur un **téléphone virtuel** (émulateur Android de
    l'ordinateur, accéléré, appareil dédié « Lumen Labo » démarré tout seul) : installation, tapotements, saisie,
    captures d'écran, journaux.
  - Programmes graphiques : écran virtuel (captures, pilotage avec `xdotool`). Serveurs : les ports 8000–8004 d'un labo
    s'ouvrent sur `127.0.0.1:18000+` (Linux), `19000+` (Windows), `20000+` (Android).
  - Sécurité : conteneurs sans privilèges, mémoire / processeurs / processus limités, Internet coupable à chaud, `adb`
    limité à l'émulateur du labo et au dossier du labo.
  - Chaque labo se prépare une fois (de 2 à 15 min ; Linux ≈ 1,7 Go, Windows ≈ 8 Go, Android ≈ 6 Go) et se met à jour d'un clic (« Mettre à jour » reconstruit avec les
    dernières versions, vos fichiers restent). Prérequis : Docker (OrbStack ou Docker Desktop sur Mac, Docker Desktop sur
    Windows, Docker Engine sur Linux) ; téléphone virtuel : Android Studio.
  - **Écran du labo** (bouton « écran » en haut de la conversation) : l'écran du labo s'affiche **en direct à côté du
    chat** (Windows complet, Linux, Windows Wine, téléphone Android). Vous voyez ce que fait le modèle et vous pouvez
    piloter vous-même : clic, clic droit, molette, clavier (⌘ = Ctrl sous Windows). Il s'ouvre tout seul quand le modèle
    travaille dans la machine Windows ou sur le téléphone.
- **Windows complet** (labo `windows-vm`, Mac à processeur Apple) : un **vrai Windows 11 ARM64** en machine virtuelle,
  pour ce que Wine ne sait pas faire (.NET complet, PowerShell, registre, services, programmes Windows récents).
  - Moteur : QEMU (`brew install qemu`) avec l'hyperviseur du Mac (`-accel hvf`), machine `virt`, UEFI edk2 fourni avec
    QEMU, disque NVMe, réseau virtio. Sur ce Mac, Docker (OrbStack) n'offre pas `/dev/kvm` : un vrai Windows ne peut pas
    tourner en conteneur, d'où la machine virtuelle. Le contrôleur d'interruptions est le GICv3 émulé par QEMU avec ITS
    (`kernel-irqchip=off,its=on`) : sans lui, pas d'interruptions MSI, et les disques et l'USB de Windows plafonnent
    à ≈ 4 Mo/s (installation mesurée 10 fois plus lente).
  - Installation **sans intervention** (Réglages → Labos → « Windows complet » → Préparer, ≈ 15 min, une seule fois ; le
    Mac doit rester éveillé, branché et ouvert : en veille, la machine virtuelle est suspendue) :
    1. téléchargez l'ISO officielle « Windows 11 (ISO édition multiple pour Arm64) » sur
       [microsoft.com/software-download/windows11arm64](https://www.microsoft.com/fr-fr/software-download/windows11arm64)
       (≈ 8,5 Go) : Lumen la trouve dans Téléchargements (ou « Choisir… ») ;
    2. acceptez la licence de Windows 11 dans Lumen (Windows 11 Pro **non activé**, installé avec la clé générique
       d'installation publiée par Microsoft) ;
    3. Lumen télécharge les pilotes virtio ARM64 de Red Hat (virtio-win, ≈ 840 Mo, seuls les pilotes sont gardés), crée
       un CD d'installation (`lab/windows-vm/autounattend.xml` rempli : langue de l'ISO, fuseau horaire du Mac, compte
       local `lumen`, mot de passe aléatoire) et lance l'installation. Au premier démarrage,
       `lab/windows-vm/setup.ps1` installe les pilotes, **OpenSSH Server** (clé SSH propre à Lumen ; dernière version de
       Win32-OpenSSH sur GitHub, sinon la fonctionnalité de Windows, limitée à 10 min car Windows Update peut rester
       occupé des heures après l'installation), PowerShell 7 et LLVM-MinGW (dernières versions publiées), puis Lumen
       prend un **instantané « propre »** du disque.
    Testé sur Mac M5 : Windows 11 26H2 (build 26300) installé en ≈ 6 min, configuration en quelques minutes selon la
    connexion ; PowerShell 7.7, LLVM-MinGW (clang 23).
  - L'agent y travaille avec les mêmes outils, `lab: "windows-vm"` : `lab_run` exécute du **PowerShell 7 par SSH**
    (administrateur, `C:\labo` par défaut), `lab_write_file` / `lab_read_file` passent par SSH (copie des fichiers de
    `C:\labo` dans `~/Lumen Labo/windows-vm`), `lab_copy_in` par `scp`, et `lab_screenshot` capture l'écran par QMP
    (`screendump`). Compilation : `clang prog.c -o prog.exe` (ARM64 natif) ou `x86_64-w64-mingw32-clang` (x64, lancé par
    l'émulation x64 de Windows 11) ; programme graphique sur le bureau : `lumen-gui C:\labo\app.exe`.
  - Démarre tout seul quand le modèle s'en sert (≈ 20 s), s'arrête proprement (≈ 10 s), revient à Windows tout juste
    installé en ≈ 10 s (« Réinitialiser »), se supprime pour libérer la place (disque ≈ 20 Go ; l'ISO de 8,5 Go peut être
    effacée de Téléchargements après l'installation). Internet coupable (la machine redémarre), serveurs des ports
    8000–8004 sur `127.0.0.1:21000+`, SSH sur `127.0.0.1:21022` (clé `~/.lumen/windows-vm/id_ed25519`). Fichiers de la
    machine : `~/.lumen/windows-vm`. Affichage de base (écran du micrologiciel `ramfb`, pas de pilote graphique) :
    800 × 600.
- **Conversation vocale façon Jarvis** (bouton « onde sonore » à côté d'Envoyer) : vous parlez, Lumen transcrit, le
  modèle répond et Lumen **lit sa réponse à voix haute pendant qu'elle s'écrit**, puis se remet à écouter. Dites « stop »
  ou appuyez sur Échap pour terminer ; Espace ou « Interrompre » coupe la parole. Les blocs de code ne sont pas lus
  (« Je vous affiche le code à l'écran »), les unités sont dites en toutes lettres. Bouton « Écouter » sur chaque réponse.
  - 100 % local, identique sur tous les ordinateurs : détection de parole Silero VAD (2 Mo) ; reconnaissance **Whisper**
    (transformers.js) — « Très précise » **large-v3-turbo** sur la carte graphique (WebGPU, 564 Mo), « Précise » small sur
    le processeur (249 Mo), « Légère » base, « Rapide » tiny ; voix naturelles **Supertonic 3** (Supertone, licence
    OpenRAIL, ~400 Mo) — Louis (voix d'homme grave et posée, par défaut), Victor, Marc, Paul, Hugo, Claire, Léa — et voix
    légères **Piper** pour les petits PC (Gilles, Tom, Siwis). Choix automatique selon la machine.
  - Démarrage en 2,5 s : la reconnaissance commence avec « small » (1 s) pendant que « turbo » se prépare en arrière-plan
    (~30 s la première fois) puis prend le relais toute seule.
  - **Le texte suit la voix** : pendant une conversation vocale, la réponse s'affiche au rythme où elle est dite (comme des
    sous-titres) ; la voix démarre dès les premiers mots écrits.
  - Léger et fluide : tout calcule dans un worker (plusieurs cœurs grâce à l'isolation cross-origin). Mesuré sur M5 :
    Supertonic ≈ 3 × plus vite que le temps réel, une phrase comprise en ~1 s par « turbo », presque sans erreur
    (« Mulhouse », « Daft Punk », « script Python », « Vacances 2026 »).
  - Les modèles vocaux se téléchargent une fois (Réglages → « Préparer la voix ») et restent dans le navigateur ;
    les moteurs (onnxruntime, phonémiseur, VAD) sont servis en local sous `/vendor/` (`agent/voice-assets.ts`).
  - Le micro demande l'autorisation du navigateur (Chrome, Safari, Edge, Firefox sur http://127.0.0.1:5173).
- **Agent, Web et Réflexion s'activent tout seuls** (option, activée par défaut) : pendant la saisie, les boutons
  s'allument quand la demande le justifie, et à l'envoi « ouvre Discord » active le mode Agent, « cherche… » ou
  « quelle météo… » la recherche web (au clavier comme à la voix). Les actions sur l'ordinateur demandent toujours votre
  accord.
- **Utilisation en direct** : « Modèles locaux » mesure toutes les 2 s la mémoire utilisée (part des modèles, reste du
  système, mémoire libre), le GPU (Mac Apple Silicon et NVIDIA) et le processeur ; la carte « Runtime » de la barre
  latérale aussi (`GET /agent/usage`).
- **Accueil au premier lancement** : Lumen vérifie qu'Ollama tourne (sinon, explique comment l'installer), affiche la
  machine détectée et propose un **pack conseillé** (un modèle fluide par catégorie, cases à cocher, taille totale,
  espace disque) installable en un clic ; on peut fermer pendant le téléchargement. Relançable depuis Réglages
  (« Assistant de configuration ») et « Modèles locaux ». Le texte en cours de saisie est conservé même si la page se recharge.
- **Agent multi-plateforme** : commandes via zsh/bash (Mac, Linux) ou PowerShell (Windows), ouverture d'applications
  (`open`, `Start-Process`, `gtk-launch`/`xdg-open`), capture d'écran (screencapture, System.Drawing, grim/gnome-screenshot/scrot) ;
  AppleScript seulement sur Mac.
- **L'agent connaît la machine** : outil `system_info` (lecture seule, sans validation) et `install_model` (avec
  validation) ; il propose les deux versions (standard et non censurée) pour chaque usage. Exemple : « Quel modèle me
  conseilles-tu pour écrire mes mails sur mon PC ? Installe-le si besoin. »
- **Suggestion du modèle le plus doué** (désactivable dans Réglages) : chaque modèle a des points forts (Frontend, Code,
  Vision, Raisonnement, Rédaction, Polyvalent), détectés automatiquement et modifiables dans « Modèles locaux ».
  Quand votre demande correspond mieux à un autre modèle installé, une bulle le propose (« Utiliser » ou ×).
- **Changement de modèle en cours de conversation** : le nouveau modèle est prévenu qu'il prend le relais et relit tout
  l'historique (ou reçoit un résumé, au choix dans Réglages). Un séparateur l'indique dans le fil (« A → B · a relu les
  N messages » / « a reçu un résumé », avec « Voir le résumé »). Si la conversation dépasse la mémoire du modèle, elle est
  résumée automatiquement.
- **Images & captures d'écran** : glisser-déposer, coller (⌘V), bouton capture d'écran, visionneuse avec zoom,
  copie et téléchargement. Les images sont envoyées aux modèles « Vision ».
- **Fichiers texte / code joints** (jusqu'à 512 Ko) envoyés au modèle comme contexte.
- **Modèles locaux** : liste avec capacités (Vision, Réflexion, Outils), VRAM utilisée, charger / décharger / supprimer,
  téléchargement avec progression (`ollama pull`), paramètres par modèle (température, top-p, contexte, prompt système…).
- **Fichiers & captures** : bibliothèque de toutes les images et fichiers générés.
- Recherche (⌘K), nouvelle conversation (⌘⇧O), renommer / supprimer, export Markdown ou JSON.

## Structure

```
src/
  lib/ollama.ts        client API Ollama (streaming NDJSON)
  store.ts             état global (zustand) + sauvegarde IndexedDB
  chat.ts              envoi, régénération, arrêt, pièces jointes
  components/          Sidebar, Composer, Message, CodeBlock, FilePanel, ImageViewer…
  views/               ChatView (accueil + conversation), ModelsView, LibraryView
  voice/               conversation vocale : worker (Whisper + Piper), micro (VAD), lecture, découpage en phrases
  styles.css           tokens du design system (identiques aux variables Figma)
agent/
  bridge.ts            pont local de l'agent (outils, Ollama, diagnostic, usage)
  lab.ts               labos isolés : conteneurs Docker, téléphone virtuel Android, outils lab_* et android_adb, écran en direct
  winvm.ts             labo « Windows complet » : machine virtuelle Windows 11 ARM (QEMU, SSH, QMP)
  proc.ts              lancement de processus partagé par les labos
lab/                   recettes des labos (linux, windows, android .Dockerfile) et « android create » à jour
  windows-vm/          installation sans intervention de Windows 11 ARM (autounattend.xml, setup.ps1)
```

## Auteur et licence

Lumen (code, architecture, interface, maquette, textes) est l'œuvre de **Nixovel** — https://github.com/Nixovel.
© 2026 Nixovel, **tous droits réservés** ([LICENSE](LICENSE)) : vous pouvez l'installer et l'utiliser pour vous, mais pas le
republier, le revendre, ni le présenter comme le vôtre — y compris réécrit, restructuré, renommé ou reformulé par une IA —
sans accord écrit. Les preuves de paternité (historique daté, empreinte du code, mentions dans l'application) sont décrites
dans [AUTHORSHIP.md](AUTHORSHIP.md). Les composants tiers (Ollama, modèles, voix, bibliothèques) gardent leurs propres licences.

