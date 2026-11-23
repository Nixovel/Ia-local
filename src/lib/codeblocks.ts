// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import type { Message } from '../store'

export type CodeFile = {
  key: string // `${msgId}:${index}`, `${msgId}:att:${attachmentId}` ou `${msgId}:tool:${callId}`
  msgId: string
  index: number
  filename: string // chemin tel qu'annoncé (« src/app.py ») ou nom généré
  lang: string
  code: string
  complete: boolean
  named: boolean
  source: 'assistant' | 'upload' | 'agent' // agent = écrit sur le disque par l'outil write_file
  createdAt: number
}

const EXT: Record<string, string> = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
  html: 'html', css: 'css', scss: 'scss', json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', bash: 'sh',
  sh: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', sql: 'sql', go: 'go', rust: 'rs', rs: 'rs', java: 'java',
  kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', php: 'php',
  ruby: 'rb', rb: 'rb', markdown: 'md', md: 'md', xml: 'xml', svg: 'svg', lua: 'lua', r: 'r', dart: 'dart',
  vue: 'vue', svelte: 'svelte', ini: 'ini', graphql: 'graphql', text: 'txt', txt: 'txt', plaintext: 'txt',
  diff: 'diff', powershell: 'ps1', ps1: 'ps1',
}

const LANG_FROM_EXT: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  jsx: 'javascript', html: 'html', htm: 'html', css: 'css', scss: 'scss', json: 'json', yml: 'yaml',
  yaml: 'yaml', toml: 'ini', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', rb: 'ruby', md: 'markdown', xml: 'xml', svg: 'xml', lua: 'lua', r: 'r', dart: 'dart',
  vue: 'xml', ini: 'ini', diff: 'diff', ps1: 'powershell', txt: 'plaintext', log: 'plaintext', csv: 'plaintext',
}

const FILE_RE = /^[\w.\-/@]+\.[A-Za-z0-9]{1,10}$|^(Dockerfile|Makefile)$/

export function langFromFilename(f: string): string {
  const lower = f.toLowerCase().split('/').pop() ?? ''
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  return LANG_FROM_EXT[ext] ?? ext
}

const extFor = (lang: string) => EXT[lang.toLowerCase()] ?? (lang ? lang.toLowerCase().replace(/[^a-z0-9]/g, '') : 'txt')

/** Interprète la ligne d'ouverture : ```python, ```python:app.py, ```py title="app.py", ```app.py */
export function parseInfo(info: string): { lang: string; filename?: string } {
  const parts = info.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return { lang: '' }
  let first = parts[0]
  let filename: string | undefined
  const colon = first.indexOf(':')
  if (colon > 0) {
    filename = first.slice(colon + 1) || undefined
    first = first.slice(0, colon)
  }
  if (!filename && first.includes('.') && FILE_RE.test(first)) {
    filename = first
    first = langFromFilename(first)
  }
  for (const p of parts.slice(1)) {
    const m = p.match(/^(?:title|file|filename|name|path)=["']?([^"']+)["']?$/i)
    if (m) filename = m[1]
    else if (!filename && FILE_RE.test(p)) filename = p
  }
  return { lang: first.toLowerCase(), filename }
}

const COMMENT_FILE =
  /^\s*(?:\/\/|#|--|;|<!--|\/\*)\s*(?:fichier|file|filename|path)?\s*:?\s*([\w.\-/@]+\.[A-Za-z0-9]{1,10})\s*(?:-->|\*\/)?\s*$/i

export const fileFromComment = (code: string) => code.split('\n', 1)[0].match(COMMENT_FILE)?.[1]

// « ### `app.py` », « **templates/index.html** : », « 3. Fichier `static/app.js` » …
const LABEL_FILE =
  /(?:^|[\s`*_"'([:])((?:[\w.@-]+\/)*(?:[\w.@-]+\.(?:py|pyi|js|mjs|cjs|jsx|ts|tsx|html?|css|scss|less|json|ya?ml|toml|md|txt|sh|bash|sql|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|rb|vue|svelte|ini|cfg|conf|env|xml|svg|lock|gradle|properties|example)|Dockerfile|Makefile|\.env(?:\.\w+)?|\.gitignore))(?=$|[\s`*_"'):\],.])/i

const CANON: Record<string, string> = {
  py: 'python', js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yml: 'yaml', md: 'markdown', txt: 'plaintext', text: 'plaintext', ini: 'ini', toml: 'ini', env: 'ini',
}
const canon = (l: string) => CANON[l.toLowerCase()] ?? l.toLowerCase()

/** Nom de fichier annoncé sur la ligne qui précède le bloc, s'il est cohérent avec le langage du bloc. */
export function fileFromLabel(label: string | undefined, lang: string): string | undefined {
  if (!label || label.length > 160) return undefined
  const name = label.match(LABEL_FILE)?.[1]
  if (!name) return undefined
  if (!lang) return name
  const fromName = langFromFilename(name)
  // Évite de nommer « requirements.txt » le bloc bash qui l'installe.
  if (!fromName || canon(fromName) === canon(lang) || canon(lang) === 'plaintext') return name
  return undefined
}

type Block = { info: string; code: string; complete: boolean; label?: string; heading?: string }

// Titre Markdown, ligne en gras ou élément numéroté : « ### 3. app.py », « **app.py** », « 2) `models.py` »
const HEADING = /^(#{1,6}\s|\*\*|__|\d+[.)]\s)/

/** Découpe les blocs ``` / ~~~ d'un texte Markdown (le dernier peut être encore ouvert pendant le streaming). */
export function extractBlocks(md: string): Block[] {
  const out: Block[] = []
  let open: { fence: string; info: string; buf: string[]; indent: number; label?: string; heading?: string } | null = null
  let prev: string | undefined // dernière ligne non vide avant le bloc
  let heading: string | undefined // dernier titre depuis le bloc précédent
  for (const line of md.split('\n')) {
    if (!open) {
      const m = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/)
      if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
        open = { fence: m[2], info: m[3].trim(), buf: [], indent: m[1].length, label: prev, heading }
      } else if (line.trim()) {
        prev = line.trim()
        if (HEADING.test(prev)) heading = prev
      }
      continue
    }
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      out.push({ info: open.info, code: open.buf.join('\n'), complete: true, label: open.label, heading: open.heading })
      open = null
      prev = undefined
      heading = undefined
    } else {
      open.buf.push(open.indent ? line.replace(new RegExp(`^ {0,${open.indent}}`), '') : line)
    }
  }
  if (open) out.push({ info: open.info, code: open.buf.join('\n'), complete: false, label: open.label, heading: open.heading })
  return out
}

export const normCode = (s: string) => s.replace(/\n$/, '')

/** Tous les fichiers d'une conversation : blocs de code du modèle + fichiers joints par l'utilisateur. */
export function conversationFiles(messages: Message[]): CodeFile[] {
  const files: CodeFile[] = []
  let unnamed = 0
  for (const m of messages) {
    if (m.role === 'user') {
      for (const a of m.attachments ?? []) {
        if (a.kind !== 'file' || a.text == null) continue
        files.push({
          key: `${m.id}:att:${a.id}`, msgId: m.id, index: -1, filename: a.name, lang: langFromFilename(a.name),
          code: a.text, complete: true, named: true, source: 'upload', createdAt: m.createdAt,
        })
      }
      continue
    }
    // Fichiers réellement écrits sur le disque par l'agent
    for (const t of m.toolCalls ?? []) {
      if ((t.name !== 'write_file' && t.name !== 'lab_write_file') || t.status !== 'done' || typeof t.args.path !== 'string') continue
      const path = t.args.path
      files.push({
        key: `${m.id}:tool:${t.id}`, msgId: m.id, index: -1, filename: path, lang: langFromFilename(path),
        code: typeof t.args.content === 'string' ? t.args.content : '', complete: true, named: true, source: 'agent', createdAt: m.createdAt,
      })
    }
    extractBlocks(m.content).forEach((b, i) => {
      const code = normCode(b.code)
      if (!code.trim()) return
      const { lang, filename } = parseInfo(b.info)
      const fname = filename ?? fileFromComment(code) ?? fileFromLabel(b.label, lang) ?? fileFromLabel(b.heading, lang)
      const l = lang || (fname ? langFromFilename(fname) : '')
      let name = fname
      if (!name) {
        const ext = extFor(l || 'txt')
        name = `extrait-${++unnamed}.${ext}`
      }
      files.push({
        key: `${m.id}:${i}`, msgId: m.id, index: i, filename: name, lang: l, code, complete: b.complete,
        named: !!fname, source: 'assistant', createdAt: m.createdAt,
      })
    })
  }
  return files
}

/** Regroupe les versions successives d'un même fichier (même nom). */
export function groupVersions(files: CodeFile[]): Map<string, CodeFile[]> {
  const map = new Map<string, CodeFile[]>()
  for (const f of files) {
    const list = map.get(f.filename) ?? []
    list.push(f)
    map.set(f.filename, list)
  }
  return map
}

/** Diff ligne à ligne (LCS) : indices des lignes ajoutées dans `b`, et nombre de lignes retirées de `a`. */
export function lineDiff(a: string, b: string): { added: Set<number>; addedCount: number; removedCount: number } {
  const A = a.split('\n')
  const B = b.split('\n')
  if (A.length * B.length > 4_000_000) return { added: new Set(), addedCount: 0, removedCount: 0 }
  const n = A.length
  const m = B.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const added = new Set<number>()
  let i = 0
  let j = 0
  let removed = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed++
      i++
    } else {
      added.add(j++)
    }
  }
  while (j < m) added.add(j++)
  removed += n - i
  return { added, addedCount: added.size, removedCount: removed }
}

export const canPreview = (lang: string, filename: string) =>
  /^(html|xml|svg|markdown|md)$/i.test(lang) || /\.(html?|svg|md|markdown)$/i.test(filename)
