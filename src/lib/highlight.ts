// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import hljs from 'highlight.js/lib/common'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Renvoie le HTML coloré (classes .hljs-*) ou le texte échappé si le langage est inconnu. */
export function highlight(code: string, lang: string): string {
  const l = (lang || '').toLowerCase()
  if (l && hljs.getLanguage(l)) {
    try {
      return hljs.highlight(code, { language: l, ignoreIllegals: true }).value
    } catch {
      /* repli sur le texte brut */
    }
  }
  return escapeHtml(code)
}

const LABELS: Record<string, string> = {
  py: 'Python', python: 'Python', js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', ts: 'TypeScript',
  typescript: 'TypeScript', tsx: 'TSX', html: 'HTML', xml: 'XML', svg: 'SVG', css: 'CSS', scss: 'SCSS', json: 'JSON',
  yaml: 'YAML', yml: 'YAML', bash: 'Bash', sh: 'Shell', shell: 'Shell', zsh: 'Zsh', sql: 'SQL', go: 'Go', rust: 'Rust',
  rs: 'Rust', java: 'Java', kotlin: 'Kotlin', swift: 'Swift', c: 'C', cpp: 'C++', csharp: 'C#', cs: 'C#', php: 'PHP',
  ruby: 'Ruby', markdown: 'Markdown', md: 'Markdown', dockerfile: 'Dockerfile', makefile: 'Makefile', lua: 'Lua',
  toml: 'TOML', ini: 'INI', diff: 'Diff', text: 'Texte', txt: 'Texte', plaintext: 'Texte',
}
export const langLabel = (lang: string) => LABELS[lang.toLowerCase()] ?? (lang ? lang : 'Texte')
