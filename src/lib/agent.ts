// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Côté interface de l'agent : définition des outils, appels au pont local, politique d'autorisation.
import type { OllamaTool } from './ollama'

export type ToolName =
  | 'set_working_dir' | 'run_command' | 'read_file' | 'write_file' | 'list_dir' | 'open' | 'screenshot' | 'applescript'
  | 'system_info' | 'install_model' | 'web_search' | 'web_fetch' | 'weather'
  | 'lab_run' | 'lab_write_file' | 'lab_read_file' | 'lab_screenshot' | 'lab_copy_in' | 'android_adb' | 'build_exe'
  | 'vpn'
export type ToolResult = { ok: boolean; output: string; image?: string; cwd?: string }
export type AgentInfo = { token: string; home: string; platform: string; arch?: string; shell: string }

type Param = { type: string; description: string; enum?: string[] }
const fn = (name: ToolName, description: string, properties: Record<string, Param>, required: string[]): OllamaTool => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
})

export const TOOLS: OllamaTool[] = [
  fn('set_working_dir', "Change le dossier de travail (comme « cd »). À utiliser en premier quand l'utilisateur demande de travailler dans un dossier.", {
    path: { type: 'string', description: 'Dossier, ex. « ~/Documents/projet »' },
  }, ['path']),
  fn('run_command', "Exécute une commande shell (zsh) sur l'ordinateur et renvoie sa sortie. Pas de commande interactive.", {
    command: { type: 'string', description: 'La commande à exécuter, ex. « ls -la » ou « python3 script.py »' },
    cwd: { type: 'string', description: 'Dossier où exécuter la commande (optionnel, dossier de travail par défaut)' },
  }, ['command']),
  fn('list_dir', 'Liste le contenu d’un dossier (fichiers avec leur taille, sous-dossiers).', {
    path: { type: 'string', description: 'Chemin du dossier (« ~ » = dossier personnel, « . » = dossier de travail)' },
  }, ['path']),
  fn('read_file', "Lit le contenu d'un fichier texte.", {
    path: { type: 'string', description: 'Chemin du fichier' },
  }, ['path']),
  fn('write_file', 'Crée ou remplace un fichier texte avec le contenu donné (les dossiers manquants sont créés).', {
    path: { type: 'string', description: 'Chemin du fichier' },
    content: { type: 'string', description: 'Contenu complet du fichier' },
  }, ['path', 'content']),
  fn('open', 'Ouvre une application (ex. « Safari », « Calculator »), un fichier/dossier, ou une URL.', {
    target: { type: 'string', description: "Nom de l'application, chemin, ou URL" },
  }, ['target']),
  fn('screenshot', "Prend une capture de l'écran pour voir ce qui est affiché.", {}, []),
  fn('applescript', 'Exécute un AppleScript pour piloter une application macOS (Finder, Safari, Musique, System Events…).', {
    script: { type: 'string', description: 'Le code AppleScript' },
  }, ['script']),
  fn('system_info', "Analyse l'ordinateur (RAM, processeur, GPU, disque) et indique quels modèles d'IA y tournent bien : modèles installés et modèles conseillés.", {}, []),
  fn('install_model', 'Télécharge et installe un modèle Ollama (ex. « qwen2.5-coder:14b »). Vérifie d’abord avec system_info qu’il est adapté à la machine.', {
    name: { type: 'string', description: 'Nom du modèle dans la bibliothèque Ollama' },
  }, ['name']),
  fn('vpn', "Lumen VPN : change la localisation apparente de l'ordinateur (les sites et les navigateurs voient le pays choisi), ou la remet. Actions : « connect » (lancer, ou changer de pays s'il tourne déjà), « disconnect » (arrêter), « new_ip » (nouvelle adresse dans le même pays), « status » (état et pays vu par les sites), « countries » (pays possibles).", {
    action: { type: 'string', description: 'Ce qu’il faut faire', enum: ['connect', 'disconnect', 'new_ip', 'status', 'countries'] },
    country: { type: 'string', description: 'Pour « connect » : le pays, en code ISO à 2 lettres (« de », « fr », « us », « ch », « nl »…) ou en toutes lettres (« Allemagne ») ; vide = le plus rapide' },
  }, ['action']),
]

/** Accès Internet (option « Recherche Internet ») : disponibles aussi hors mode agent, sans validation (lecture seule). */
export const WEB_TOOLS: OllamaTool[] = [
  fn('web_search', "Cherche sur Internet : actualité, informations récentes, prix, horaires, résultats sportifs, tout ce que tu ne sais pas avec certitude. Renvoie des titres, liens et extraits.", {
    query: { type: 'string', description: 'La recherche, formulée comme dans un moteur de recherche' },
    max_results: { type: 'number', description: 'Nombre de résultats (1 à 10, 5 par défaut)' },
  }, ['query']),
  fn('web_fetch', "Lit le contenu texte d'une page web (par exemple un résultat de web_search) pour obtenir le détail.", {
    url: { type: 'string', description: 'Adresse complète de la page (https://…)' },
  }, ['url']),
  fn('weather', "Météo actuelle et prévisions (jusqu'à 7 jours) pour une ville. Sans ville, utilise celle de l'utilisateur.", {
    location: { type: 'string', description: 'Ville, éventuellement avec le pays : « Mulhouse » ou « Paris, France »' },
    days: { type: 'number', description: 'Nombre de jours de prévisions (1 à 7, 3 par défaut)' },
  }, []),
]
export const WEB_TOOL_NAMES = new Set<string>(WEB_TOOLS.map((t) => t.function.name))

/** Labos isolés (option « Labo ») : Linux, Windows complet (VM) et Android, sans risque pour l'ordinateur. */
const LAB: Param = {
  type: 'string',
  description: 'Le labo : « linux », « windows-vm » (vrai Windows 11, PowerShell) ou « android »',
  enum: ['linux', 'windows-vm', 'android'],
}
export const LAB_TOOLS: OllamaTool[] = [
  fn('lab_run', "Exécute une commande dans un labo isolé pour installer, compiler, lancer et tester des programmes sans risque pour l'ordinateur : bash (linux, android) ou PowerShell (windows-vm, vrai Windows 11). Renvoie la sortie et le code de sortie.", {
    lab: LAB,
    command: { type: 'string', description: 'La commande : bash, ex. « python3 app.py », « gcc main.c -o main && ./main », « ./gradlew assembleDebug » ; PowerShell pour windows-vm, ex. « clang hello.c -o hello.exe; .\\hello.exe »' },
    cwd: { type: 'string', description: 'Dossier dans le labo (optionnel : /workspace par défaut, C:\\labo pour windows-vm)' },
    timeout: { type: 'number', description: 'Durée maximale en secondes (optionnel, 300 par défaut, 900 pour android)' },
  }, ['lab', 'command']),
  fn('lab_write_file', "Crée ou remplace un fichier dans un labo (chemin relatif = /workspace, ou C:\\labo pour windows-vm ; les dossiers manquants sont créés). Écris le fichier complet.", {
    lab: LAB,
    path: { type: 'string', description: 'Chemin du fichier, ex. « projet/main.py » (windows-vm : aussi « C:\\labo\\prog.c »)' },
    content: { type: 'string', description: 'Contenu complet du fichier' },
  }, ['lab', 'path', 'content']),
  fn('lab_read_file', "Lit un fichier texte d'un labo (ou liste le contenu d'un dossier).", {
    lab: LAB,
    path: { type: 'string', description: 'Chemin du fichier ou du dossier (relatif = /workspace, ou C:\\labo pour windows-vm)' },
  }, ['lab', 'path']),
  fn('lab_screenshot', "Capture l'écran d'un labo pour voir un programme graphique : bureau de Windows (windows-vm), écran virtuel Linux, ou écran du téléphone virtuel Android.", {
    lab: LAB,
  }, ['lab']),
  fn('lab_copy_in', "Copie un fichier ou un dossier de l'ordinateur de l'utilisateur dans un labo, pour le tester.", {
    lab: LAB,
    source: { type: 'string', description: "Chemin sur l'ordinateur, ex. « ~/Documents/mon-projet »" },
    dest: { type: 'string', description: 'Destination dans le labo (optionnel, /workspace/<nom> par défaut)' },
  }, ['lab', 'source']),
  fn('android_adb', "Pilote le téléphone virtuel Android du labo (démarré automatiquement) avec une commande adb : install, uninstall, shell, logcat, push, pull. Chemins de fichiers relatifs = /workspace du labo android.", {
    args: { type: 'string', description: "Arguments d'adb, ex. « install -r MonApp/app/build/outputs/apk/debug/app-debug.apk », « shell monkey -p com.exemple.monapp 1 », « shell input tap 540 1200 », « logcat -d -t 200 »" },
  }, ['args']),
  fn('build_exe', "Compile un programme en exécutable Windows (.exe), le teste dans le vrai Windows 11 (labo « Windows complet », s'il est installé) et le dépose dans « ~/Lumen Labo/exe ». Langages : C, C++, C#, Go, Rust, Python. Les compilateurs (dernières versions) s'installent tout seuls.", {
    language: { type: 'string', description: 'Le langage', enum: ['c', 'cpp', 'csharp', 'go', 'rust', 'python'] },
    code: { type: 'string', description: 'Le code complet d’un programme en un seul fichier (sinon, utilise « source »)' },
    source: { type: 'string', description: 'Fichier ou dossier du projet dans un labo, ex. « projet » ou « /workspace/projet » (labo « from »)' },
    from: { type: 'string', description: 'Labo où se trouve « source » (linux par défaut)', enum: ['linux', 'windows-vm', 'android'] },
    name: { type: 'string', description: 'Nom de l’exe, sans « .exe » (ex. « calculatrice »)' },
    arch: { type: 'string', description: 'x64 (par défaut : tous les PC Windows) ou arm64', enum: ['x64', 'arm64'] },
    gui: { type: 'boolean', description: 'true SEULEMENT pour une vraie application à fenêtre (WinMain/CreateWindow, WinForms, tkinter…). Un programme qui affiche du texte (printf, print, Console.WriteLine) : false (par défaut)' },
    where: { type: 'string', description: 'Où compiler : auto (labo Linux ; Python : Windows VM) ou windows-vm (C/C++ compilés dans le vrai Windows)', enum: ['auto', 'windows-vm'] },
    test: { type: 'string', description: 'Test après compilation : auto (par défaut), vm ou none', enum: ['auto', 'vm', 'none'] },
    args: { type: 'string', description: 'Arguments de la ligne de commande pour le test (optionnel)' },
    input: { type: 'string', description: 'Texte envoyé au programme pendant le test, comme s’il était tapé au clavier (optionnel)' },
    entry: { type: 'string', description: 'Python : fichier principal (optionnel, main.py par défaut)' },
  }, []),
]
export const LAB_TOOL_NAMES = new Set<string>(LAB_TOOLS.map((t) => t.function.name))

export const TOOL_NAMES = new Set<string>([...TOOLS, ...WEB_TOOLS, ...LAB_TOOLS].map((t) => t.function.name))

/** Outils exécutés dans l'interface (pas par le pont local). */
export const CLIENT_TOOLS = new Set(['system_info', 'install_model', ...WEB_TOOL_NAMES])
// Le labo est isolé de l'ordinateur : on n'y demande pas de validation, sauf pour y copier des fichiers de l'ordinateur.
const NO_APPROVAL = new Set(['system_info', ...WEB_TOOL_NAMES, ...[...LAB_TOOL_NAMES].filter((n) => n !== 'lab_copy_in')])

const READ_ONLY = new Set(['list_dir', 'read_file'])

// ---------- Pont local ----------
let infoPromise: Promise<AgentInfo> | null = null
export function agentInfo(): Promise<AgentInfo> {
  infoPromise ??= fetch('/agent/token', { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error(`Pont de l'agent indisponible (${r.status})`)
      return r.json() as Promise<AgentInfo>
    })
    .catch((e) => {
      infoPromise = null
      throw e
    })
  return infoPromise
}

/** Le serveur a redémarré (nouveau jeton) : la prochaine requête redemande le jeton. */
export const resetAgentInfo = () => {
  infoPromise = null
}

export async function callTool(name: string, args: Record<string, unknown>, cwd: string, retry = true): Promise<ToolResult> {
  const info = await agentInfo()
  const res = await fetch('/agent/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lumen-token': info.token },
    body: JSON.stringify({ name, args, cwd }),
  })
  if (res.status === 401 && retry) {
    infoPromise = null // le serveur a redémarré : on récupère le nouveau jeton et on réessaie une fois
    return callTool(name, args, cwd, false)
  }
  return (await res.json()) as ToolResult
}

// ---------- Autorisations ----------
const resolvePath = (p: string, cwd: string, home: string) => {
  const raw = (p || '.').trim()
  const abs = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw.startsWith('/') ? raw : `${cwd.replace(/\/$/, '')}/${raw}`
  const parts: string[] = []
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

/** La lecture dans le dossier de travail passe sans demander ; tout le reste demande une validation. */
export function needsApproval(name: string, args: Record<string, unknown>, cwd: string, home: string, allowed: string[]): boolean {
  if (allowed.includes(name) || NO_APPROVAL.has(name)) return false
  // VPN : seul le lancement (ou le changement de pays) modifie les réglages réseau du Mac. Arrêter remet tout comme avant.
  if (name === 'vpn') return args.action === 'connect'
  if (!READ_ONLY.has(name)) return true
  const target = resolvePath(String(args.path ?? '.'), cwd, home)
  const root = resolvePath(cwd, cwd, home)
  return !(target === root || target.startsWith(root + '/'))
}

// ---------- Prompt système ----------
/**
 * Date et heure arrondie à l'heure : les consignes ne changent qu'une fois par heure. Ollama réutilise ainsi
 * la conversation déjà lue (cache) au lieu de tout relire à chaque minute, et la réponse démarre plus vite.
 */
function nowRounded(): string {
  const d = new Date()
  return `${d.toLocaleDateString('fr-FR', { dateStyle: 'full' })}, entre ${d.getHours()} h et ${(d.getHours() + 1) % 24} h`
}

export function agentSystemPrompt(info: AgentInfo, cwd: string): string {
  const os = info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : info.platform === 'linux' ? 'Linux' : info.platform
  const shell =
    info.platform === 'win32'
      ? 'Les commandes de run_command passent par PowerShell (syntaxe PowerShell, chemins Windows).'
      : `Les commandes de run_command passent par ${info.shell.split('/').pop() || 'le shell'}.`
  const date = nowRounded()
  return [
    `Tu es Lumen, un agent qui travaille directement sur l'ordinateur de l'utilisateur (${os}) grâce à des outils.`,
    `Dossier de travail : ${cwd}. Dossier personnel : ${info.home}. Date : ${date}. ${shell}`,
    "Règles :",
    "- Agis avec les outils au lieu de dire à l'utilisateur quoi faire (lister, lire, écrire, lancer des commandes, ouvrir des apps).",
    "- Si l'utilisateur te demande de travailler dans un dossier, appelle d'abord set_working_dir. Les chemins relatifs partent du dossier de travail.",
    '- write_file crée automatiquement les dossiers manquants : écris chaque fichier complet (pas de « … »).',
    "- Pour conseiller ou installer un modèle d'IA, appelle d'abord system_info, propose un modèle « Fluide », puis install_model si l'utilisateur est d'accord. (Commande manuelle équivalente : « ollama pull <nom> ».)",
    '- Une étape à la fois : lis le résultat de chaque outil avant la suivante. Si un outil échoue, corrige et réessaie.',
    "- VPN : si l'utilisateur veut changer de pays ou de localisation, masquer son adresse, ou lancer / arrêter le VPN, appelle vpn (connect avec le pays, disconnect, new_ip, status). Ne le lance jamais sans qu'on te le demande.",
    "- L'utilisateur valide les actions sensibles : s'il refuse, ne recommence pas, propose autre chose.",
    '- Avant une action destructive (suppression, écrasement), explique ce que tu vas faire.',
    '- Quand la tâche est terminée, résume en quelques lignes ce que tu as fait. Réponds en français.',
  ].join('\n')
}

/** Consignes quand la recherche Internet est activée (date et ville pour la météo et l'actualité). */
export function webSystemPrompt(city: string): string {
  const date = nowRounded()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return [
    `Tu as accès à Internet grâce à des outils. Nous sommes le ${date} (fuseau ${tz}).${city ? ` L'utilisateur habite à ${city}.` : ''}`,
    "- Météo : appelle weather (sans ville, celle de l'utilisateur ; si elle est inconnue, demande-la).",
    "- Actualité, faits récents, prix, horaires, ou toute information dont tu n'es pas sûr : appelle web_search, puis web_fetch pour lire une page si les extraits ne suffisent pas.",
    '- Réponds à partir des résultats, sans rien inventer, et cite tes sources en liens Markdown [titre](url).',
    "- Pour une question générale que tu connais bien, réponds directement, sans outil.",
  ].join('\n')
}

/** Consignes quand les labos sont activés : ce que contient chaque labo et comment tester pour de vrai. */
export function labSystemPrompt(arch?: string): string {
  const cpu = arch === 'arm64' ? 'ARM 64 bits' : 'x86-64'
  return [
    "Tu disposes de labos isolés pour écrire, compiler, exécuter et tester des programmes sans risque pour l'ordinateur de l'utilisateur (outils lab_* et android_adb). Dès qu'il faut exécuter ou tester du code, fais-le dans un labo au lieu de seulement l'écrire.",
    `- « linux » : Ubuntu 26.04 LTS (${cpu}), tu es root. Python 3, pip, Node.js LTS, npm, gcc/g++, make, cmake, gdb, git, curl, sqlite3. Installe le reste toi-même : « apt-get update && apt-get install -y … » (ex. dotnet-sdk-10.0, golang, rustc, openjdk-25-jdk), « pip install … », « npm install -g … ».`,
    `- « windows-vm » : un VRAI Windows 11 ARM64 (machine virtuelle${arch === 'arm64' ? ' accélérée par le Mac' : ''}) : .NET complet, pilotes, programmes Windows récents, PowerShell, registre, services. Disponible s'il a été installé (Réglages → Labos → Windows complet), sinon l'outil le dit. lab_run y exécute du PowerShell 7 (pas bash) en administrateur, dans C:\\labo par défaut (relatif = C:\\labo ; « cmd /c … » pour l'invite de commandes). Compile en C/C++ avec LLVM-MinGW : « clang hello.c -o hello.exe » (ARM64 natif), « x86_64-w64-mingw32-clang hello.c -o hello-x64.exe » (x64, lancé par l'émulation de Windows 11), puis « .\\hello.exe ». Installe le reste avec winget (« winget install --id Python.Python.3.13 -e --accept-source-agreements --accept-package-agreements ») ou .NET (« Invoke-WebRequest https://dot.net/v1/dotnet-install.ps1 -OutFile d.ps1; ./d.ps1 -Channel LTS »). Pour du C# / .NET complet tu peux aussi utiliser le labo linux (« apt-get install -y dotnet-sdk-10.0 », puis « dotnet new console -o App && cd App && dotnet run »). Programme graphique : « lumen-gui C:\\labo\\app.exe » (il s'ouvre sur le bureau de Windows), attends (« Start-Sleep 3 »), puis lab_screenshot (lab « windows-vm »). L'utilisateur voit cet écran en direct à côté du chat. Serveurs : ports 8000 à 8004 → http://127.0.0.1:21000 à 21004 sur l'ordinateur.`,
    "- « android » : construit des applis Android (JDK 25, Gradle, SDK Android). Nouveau projet : « android create empty-activity --name \"Mon App\" --application-id com.exemple.monapp -o MonApp », puis « cd MonApp && ./gradlew assembleDebug » (APK : MonApp/app/build/outputs/apk/debug/app-debug.apk). Teste sur le téléphone virtuel avec android_adb : « install -r MonApp/app/build/outputs/apk/debug/app-debug.apk », « shell monkey -p com.exemple.monapp 1 » (lance l'appli), « shell input tap X Y », « shell input text Bonjour », « shell uiautomator dump /sdcard/ui.xml » puis « shell cat /sdcard/ui.xml » (boutons et coordonnées), « logcat -d -t 200 » (erreurs). Regarde l'écran avec lab_screenshot (lab « android »).",
    "- Programme Windows (.exe) demandé : utilise build_exe (C, C++, C#, Go, Rust, Python), avec le code complet dans « code » (ou un projet du labo dans « source »), un nom et gui=true pour une fenêtre. Il compile avec les derniers compilateurs, teste l'exe dans le vrai Windows 11 (labo « Windows complet », s'il est installé ; capture d'écran pour une fenêtre) et le dépose dans « ~/Lumen Labo/exe » : lis le résultat du test, corrige et recompile si besoin, puis donne le chemin de l'exe à l'utilisateur. x64 par défaut (tous les PC) ; arm64 sur demande.",
    "- Fichiers : lab_write_file / lab_read_file (chemins relatifs = /workspace). /workspace est le dossier « ~/Lumen Labo/<labo> » de l'utilisateur : il y retrouve tes fichiers (windows-vm : C:\\labo, dont les fichiers que tu écris sont copiés dans « ~/Lumen Labo/windows-vm »). Pour tester un projet de l'ordinateur, copie-le d'abord avec lab_copy_in.",
    "- Programmes graphiques (labo Linux) : lance-les en arrière-plan (« nohup python3 app.py > /tmp/app.log 2>&1 & »), attends (« sleep 3 »), puis lab_screenshot ; clique et tape avec xdotool (« xdotool mousemove 400 300 click 1 », « xdotool type 'texte' »).",
    "- Serveurs : lance-les en arrière-plan avec nohup, sur 0.0.0.0 et un port de 8000 à 8004 ; l'utilisateur les ouvre à http://127.0.0.1:18000 à 18004 (android : 20000 à 20004 ; Windows complet : 21000 à 21004).",
    "- Une commande qui attend une saisie au clavier bloque : donne l'entrée (« echo 5 | ./prog ») ou des arguments.",
    "- Le premier usage d'un labo peut prendre quelques minutes (préparation). Teste vraiment : exécute, lis les erreurs, corrige et relance jusqu'à ce que ça marche, puis résume ce que tu as testé et le résultat.",
  ].join('\n')
}

// ---------- Appels d'outils écrits en texte (modèles sans support natif) ----------
type TextCall = { name: string; args: Record<string, unknown> }

function asCall(v: unknown): TextCall | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const f = (o.function && typeof o.function === 'object' ? o.function : o) as Record<string, unknown>
  const name = typeof f.name === 'string' ? f.name : null
  let args = f.arguments ?? f.parameters ?? {}
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      args = {}
    }
  }
  return name && TOOL_NAMES.has(name) && typeof args === 'object' ? { name, args: args as Record<string, unknown> } : null
}

/** Repère des appels d'outils écrits en JSON dans le texte (```json …```, <tool_call>…</tool_call>, JSON seul). */
export function parseTextToolCalls(content: string): { calls: TextCall[]; cleaned: string } {
  const calls: TextCall[] = []
  let cleaned = content
  const patterns = [/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, /```[a-z]*\s*\n?(\{[\s\S]*?\})\s*```/gi]
  for (const re of patterns) {
    cleaned = cleaned.replace(re, (whole, json: string) => {
      try {
        const c = asCall(JSON.parse(json))
        if (c) {
          calls.push(c)
          return ''
        }
      } catch {
        /* pas du JSON : on laisse le texte tel quel */
      }
      return whole
    })
  }
  if (!calls.length) {
    const t = content.trim()
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        const c = asCall(JSON.parse(t))
        if (c) return { calls: [c], cleaned: '' }
      } catch {
        /* ignore */
      }
    }
  }
  return { calls, cleaned: cleaned.trim() }
}
