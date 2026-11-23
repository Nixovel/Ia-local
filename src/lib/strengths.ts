// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Points forts des modèles et détection du type de demande, pour suggérer (sans imposer) le modèle le plus doué.
import type { ModelInfo, RunningModel } from './ollama'
import { isChatModel } from './models'

export type Strength = 'frontend' | 'code' | 'vision' | 'image' | 'reasoning' | 'writing' | 'general'

export const STRENGTHS: { id: Strength; label: string; task: string }[] = [
  { id: 'frontend', label: 'Frontend', task: 'du frontend' },
  { id: 'code', label: 'Code', task: 'du code' },
  { id: 'vision', label: 'Vision', task: 'la lecture d’images' },
  { id: 'image', label: 'Images', task: 'la création d’images' },
  { id: 'reasoning', label: 'Raisonnement', task: 'le raisonnement' },
  { id: 'writing', label: 'Rédaction', task: 'la rédaction' },
  { id: 'general', label: 'Polyvalent', task: 'la discussion générale' },
]
export const strengthInfo = (s: Strength) => STRENGTHS.find((x) => x.id === s)!

// Mots entiers, accents compris (\b ne gère pas « é »).
const words = (list: string[]) => new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${list.join('|')})(?=$|[^\\p{L}\\p{N}_])`, 'giu')

const RULES: [Strength, RegExp][] = [
  ['frontend', words(['html', 'css', 'scss', 'tailwind', 'bootstrap', 'react', 'vue', 'svelte', 'angular', 'next\\.?js', 'jsx', 'tsx', 'front[- ]?end', 'interface', 'ui', 'ux', 'landing', 'portfolio', 'site', 'site web', 'page web', 'composant', 'bouton', 'navbar', 'responsive', 'maquette', 'design'])],
  ['code', words(['code', 'coder', 'python', 'script', 'fonction', 'function', 'classe', 'bug', 'erreur', 'exception', 'stack ?trace', 'api', 'backend', 'back[- ]?end', 'sql', 'regex', 'algorithme', 'java', 'rust', 'golang', 'typescript', 'javascript', 'node', 'flask', 'django', 'fastapi', 'docker', 'bash', 'shell', 'compile', 'refactor\\w*', 'programme'])],
  ['image', words(['dessine\\w*', 'dessin', 'dessins', 'logo', 'logos', 'icône', 'icônes', 'icone', 'icones', 'illustration', 'illustrations', 'pictogrammes?', 'svg', 'mascotte', 'avatar', 'bannière', 'affiche', 'emoji'])],
  ['reasoning', words(['pourquoi', 'démontre', 'prouve', 'calcule\\w*', 'logique', 'maths?', 'équation', 'problème', 'raisonne\\w*', 'stratégie', 'compare\\w*', 'analyse\\w*', 'optimise\\w*', 'énigme'])],
  ['writing', words(['rédige\\w*', 'écris un texte', 'article', 'mail', 'e-mail', 'lettre', 'traduis', 'traduction', 'résume\\w*', 'reformule\\w*', 'orthographe', 'poème', 'histoire', 'discours', 'post linkedin'])],
]

// « crée / génère / fais-moi une image, un dessin, une illustration… »
const IMAGE_ASK = /(?:^|[^\p{L}])(?:cr[ée]+e?r?|g[ée]n[èée]re?r?|fai[st]?|faire|produi[st]|r[ée]alise)[\s-]+(?:moi[\s-]+|nous[\s-]+)?(?:une?|des|l['’])?\s*(?:image|photo|illustration|dessin|visuel|fond d['’][ée]cran)/iu

/** Devine le type de demande à partir du texte (et des images jointes). */
export function detectTask(text: string, hasImages: boolean): Strength | null {
  const t = text.trim()
  if (hasImages && !IMAGE_ASK.test(t)) return 'vision'
  if (t.length < 8) return null
  let best: Strength | null = null
  let score = 0
  for (const [id, re] of RULES) {
    const n = (t.match(re)?.length ?? 0) + (id === 'image' && IMAGE_ASK.test(t) ? 2 : 0)
    // À égalité, le frontend (plus spécifique, testé en premier) l'emporte sur le code
    if (n > score) {
      best = id
      score = n
    }
  }
  return best
}

/** Taille en milliards de paramètres (« 26.9B » → 26.9, « 137M » → 0.137). */
function paramsOf(m: ModelInfo): number {
  const raw = (m.details?.parameter_size ?? '').trim().toUpperCase()
  const v = parseFloat(raw) || 0
  if (raw.endsWith('M')) return v / 1000
  if (raw.endsWith('K')) return v / 1_000_000
  if (raw.endsWith('T')) return v * 1000
  return v
}

/** Points forts déduits du nom, des capacités et de la taille du modèle. */
export function autoStrengths(m: ModelInfo): Strength[] {
  const n = m.name.toLowerCase()
  const caps = m.capabilities ?? []
  const params = paramsOf(m)
  const s = new Set<Strength>()
  if (/coder|codestral|devstral|starcoder|codegemma|codellama|code-?llama/.test(n)) {
    s.add('code')
    s.add('frontend')
  }
  if (caps.includes('vision') || /(^|[-_:/])vl([-_:]|$)|vision|llava|moondream/.test(n)) s.add('vision')
  // Dessin vectoriel (SVG) : les modèles de code et les Qwen3 généralistes s'en sortent le mieux
  if (s.has('code') || (/qwen3/.test(n) && !s.has('vision') && params >= 1.5) || params >= 20) s.add('image')
  if (caps.includes('thinking') || /(^|[-_:/])r1([-_:]|$)|qwq|reason/.test(n)) s.add('reasoning')
  if (params >= 20) {
    s.add('general')
    s.add('writing')
  }
  if (params >= 25) {
    s.add('code')
    s.add('frontend')
  }
  if (!s.size) s.add('general')
  return STRENGTHS.map((x) => x.id).filter((id) => s.has(id))
}

export const strengthsOf = (m: ModelInfo, overrides: Record<string, Strength[]>) => overrides[m.name] ?? autoStrengths(m)

/** Meilleur autre modèle pour cette tâche, ou null si le modèle actuel est déjà doué pour ça. */
export function suggestModel(
  task: Strength,
  currentName: string,
  models: ModelInfo[],
  running: RunningModel[],
  overrides: Record<string, Strength[]>,
): ModelInfo | null {
  const current = models.find((m) => m.name === currentName)
  if (current && strengthsOf(current, overrides).includes(task)) return null
  const loaded = new Set(running.map((r) => r.name))
  const candidates = models
    .filter((m) => isChatModel(m) && m.name !== currentName && strengthsOf(m, overrides).includes(task))
    .sort((a, b) => Number(loaded.has(b.name)) - Number(loaded.has(a.name)) || paramsOf(b) - paramsOf(a))
  return candidates[0] ?? null
}
