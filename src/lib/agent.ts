// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Côté interface de l'agent : définition des outils, appels au pont local, politique d'autorisation.
import type { OllamaTool } from './ollama'

export type ToolName =
  | 'set_working_dir' | 'run_command' | 'read_file' | 'write_file' | 'list_dir' | 'open' | 'screenshot' | 'applescript'
  | 'system_info' | 'install_model' | 'web_search' | 'web_fetch' | 'weather'
export type ToolResult = { ok: boolean; output: string; image?: string; cwd?: string }
export type AgentInfo = { token: string; home: string; platform: string; shell: string }

const fn = (name: ToolName, description: string, properties: Record<string, { type: string; description: string }>, required: string[]): OllamaTool => ({
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

export const TOOL_NAMES = new Set<string>([...TOOLS, ...WEB_TOOLS].map((t) => t.function.name))

/** Outils exécutés dans l'interface (pas par le pont local). */
export const CLIENT_TOOLS = new Set(['system_info', 'install_model', ...WEB_TOOL_NAMES])
const NO_APPROVAL = new Set(['system_info', ...WEB_TOOL_NAMES])

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
