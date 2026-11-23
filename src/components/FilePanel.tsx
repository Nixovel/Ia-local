// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FileArchive, FileCode, Upload, X } from 'lucide-react'
import { useStore } from '../store'
import { canPreview, groupVersions, lineDiff, type CodeFile } from '../lib/codeblocks'
import { highlight, langLabel } from '../lib/highlight'
import { basename, downloadBlob, downloadText, zipFiles } from '../lib/files'
import { formatBytes } from '../lib/format'
import { Markdown } from './Markdown'
import { Button, IconButton, Tag, useCopy } from './ui'

const LINE_H = 21
const PAD = 16

// ---------- Aperçu « projet » : assemble HTML + templates + CSS + JS de la conversation ----------
const isExternal = (url: string) => /^(https?:)?\/\//i.test(url) || url.startsWith('data:')

function findFile(all: CodeFile[], ref: string): CodeFile | undefined {
  const clean = ref.split(/[?#]/)[0].replace(/^\.?\/+/, '')
  if (!clean) return undefined
  return (
    all.find((f) => f.filename === clean) ??
    all.find((f) => f.filename.endsWith('/' + clean) || clean.endsWith('/' + f.filename)) ??
    all.find((f) => basename(f.filename) === basename(clean))
  )
}

const BLOCK = /\{%-?\s*block\s+(\w+)\s*-?%\}([\s\S]*?)\{%-?\s*endblock(?:\s+\w+)?\s*-?%\}/g

/** Simule le strict nécessaire de Jinja/Django pour un aperçu statique (pas de serveur dans l'aperçu). */
function renderTemplate(src: string, all: CodeFile[], depth = 0): string {
  let s = src.replace(/\{#[\s\S]*?#\}/g, '')
  const ext = s.match(/\{%-?\s*extends\s+["']([^"']+)["']\s*-?%\}/)
  if (ext && depth < 4) {
    const base = findFile(all, ext[1]) ?? findFile(all, `templates/${ext[1]}`)
    if (base) {
      const blocks = new Map<string, string>()
      for (const m of s.matchAll(BLOCK)) blocks.set(m[1], m[2])
      s = base.code.replace(BLOCK, (_m, name: string, def: string) => blocks.get(name) ?? def)
      return renderTemplate(s, all, depth + 1)
    }
  }
  return s
    .replace(/\{%-?\s*include\s+["']([^"']+)["'][^%]*%\}/g, (_m, p: string) => findFile(all, p)?.code ?? '')
    .replace(/\{\{\s*url_for\(\s*['"]static['"]\s*,\s*filename\s*=\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, 'static/$1')
    .replace(/\{%-?\s*(?:else|elif\b[^%]*)-?%\}[\s\S]*?(?=\{%-?\s*endif\s*-?%\})/g, '') // garde la 1re branche des if
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '')
}

/** HTML prêt pour l'iframe : templates résolus, CSS et JS locaux intégrés. */
function buildPreview(file: CodeFile, all: CodeFile[]): { html: string; jinja: boolean } {
  const jinja = /\{%|\{\{/.test(file.code)
  let s = jinja ? renderTemplate(file.code, all) : file.code
  s = s.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1]
    if (!href || isExternal(href) || !/stylesheet/i.test(tag)) return tag
    const css = findFile(all, href)
    return css ? `<style>/* ${css.filename} */\n${css.code}\n</style>` : tag
  })
  s = s.replace(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a: string, src: string, b: string) => {
    if (isExternal(src)) return tag
    const js = findFile(all, src)
    return js ? `<script${a}${b}>/* ${js.filename} */\n${js.code.replace(/<\/script/gi, '<\\/script')}\n</script>` : tag
  })
  return { html: s, jinja }
}

/** Ouvre l'aperçu dans un vrai onglet du navigateur. */
function openInTab(html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function FilePanel({ files, selectedKey, autoPreview }: { files: CodeFile[]; selectedKey: string; autoPreview?: boolean }) {
  const openPanel = useStore((s) => s.openPanel)
  const [copied, copy] = useCopy()
  const [mode, setMode] = useState<'code' | 'preview'>(autoPreview ? 'preview' : 'code')
  const groups = useMemo(() => groupVersions(files), [files])
  const tabs = useMemo(() => Array.from(groups.values()).map((list) => list[list.length - 1]), [groups])
  const current = files.find((f) => f.key === selectedKey) ?? files[files.length - 1]
  const versions = current ? (groups.get(current.filename) ?? [current]) : []
  const vi = current ? versions.findIndex((v) => v.key === current.key) : -1
  const prev = vi > 0 ? versions[vi - 1] : null
  const diff = useMemo(() => (prev && current ? lineDiff(prev.code, current.code) : null), [prev, current])
  const html = useMemo(() => (current ? highlight(current.code, current.lang) : ''), [current])
  const previewable = current ? canPreview(current.lang, current.filename) : false
  const isMd = !!current && /markdown|md/i.test(current.lang + current.filename.split('.').pop())
  const preview = useMemo(
    () => (current && previewable && !isMd && mode === 'preview' ? buildPreview(current, tabs) : null),
    [current, previewable, isMd, mode, tabs],
  )

  useEffect(() => setMode(autoPreview ? 'preview' : 'code'), [current?.filename, autoPreview])

  if (!current) return null
  const lines = current.code.split('\n')
  const latest = tabs.map((f) => ({ name: f.filename, content: f.code }))

  return (
    <aside className="panel file-panel">
      <div className="panel-tabs">
        <div className="tabs-scroll">
          {tabs.map((t) => {
            const active = t.filename === current.filename
            return (
              <button
                type="button"
                key={t.filename}
                className={`ftab${active ? ' is-active' : ''}`}
                onClick={() => openPanel({ type: 'code', key: t.key })}
                title={t.filename}
              >
                {t.source === 'upload' ? <Upload size={13} /> : <FileCode size={14} strokeWidth={1.5} />}
                <span>{basename(t.filename)}</span>
              </button>
            )
          })}
        </div>
        <IconButton icon={copied ? Check : Copy} label="Copier le fichier" onClick={() => void copy(current.code)} />
        <IconButton icon={Download} label="Télécharger le fichier" onClick={() => downloadText(current.code, basename(current.filename))} />
        {tabs.length > 1 && (
          <IconButton icon={FileArchive} label="Tout télécharger (.zip)" onClick={() => downloadBlob(zipFiles(latest), 'lumen-fichiers.zip')} />
        )}
        <IconButton icon={X} label="Fermer le panneau" onClick={() => openPanel(null)} />
      </div>

      <div className="panel-bar">
        {previewable && (
          <div className="segmented">
            <button type="button" className={mode === 'code' ? 'is-on' : ''} onClick={() => setMode('code')}>
              Code
            </button>
            <button type="button" className={mode === 'preview' ? 'is-on' : ''} onClick={() => setMode('preview')}>
              Aperçu
            </button>
          </div>
        )}
        {versions.length > 1 && (
          <div className="versions">
            <button type="button" disabled={vi <= 0} onClick={() => openPanel({ type: 'code', key: versions[vi - 1].key })} aria-label="Version précédente">
              <ChevronLeft size={14} />
            </button>
            <span className="caption secondary">
              Version {vi + 1} / {versions.length}
            </span>
            <button
              type="button"
              disabled={vi >= versions.length - 1}
              onClick={() => openPanel({ type: 'code', key: versions[vi + 1].key })}
              aria-label="Version suivante"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
        <span className="spacer" />
        {diff && (diff.addedCount > 0 || diff.removedCount > 0) && (
          <>
            {diff.addedCount > 0 && <Tag tone="success">+{diff.addedCount}</Tag>}
            {diff.removedCount > 0 && <Tag tone="danger">−{diff.removedCount}</Tag>}
          </>
        )}
        {current.source === 'upload' && <Tag tone="info">Joint</Tag>}
        {!current.complete && <Tag tone="accent">En cours…</Tag>}
        {preview?.jinja && (
          <Tag tone="violet" title="Les balises Jinja sont simulées : pas de serveur Python dans l'aperçu.">
            Jinja simulé
          </Tag>
        )}
        {preview && <IconButton icon={ExternalLink} label="Ouvrir l'aperçu dans un onglet" onClick={() => openInTab(preview.html)} />}
        <Tag>{langLabel(current.lang)}</Tag>
      </div>

      {mode === 'preview' && previewable ? (
        isMd ? (
          <div className="preview-md">
            <Markdown content={current.code} />
          </div>
        ) : (
          <iframe
            className="preview-frame"
            title={`Aperçu de ${basename(current.filename)}`}
            sandbox="allow-scripts allow-modals allow-forms"
            srcDoc={preview?.html ?? current.code}
          />
        )
      ) : (
        <div className="editor">
          <div className="editor-inner" style={{ minHeight: lines.length * LINE_H + PAD * 2 }}>
            {diff &&
              [...diff.added].map((i) => <div key={i} className="line-add" style={{ top: PAD + i * LINE_H, height: LINE_H }} />)}
            <pre className="gutter" aria-hidden>
              {lines.map((_, i) => i + 1).join('\n')}
            </pre>
            <pre className="code">
              <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
          </div>
        </div>
      )}

      <div className="panel-foot">
        <span className="mono-sm muted">
          {lines.length} lignes · {formatBytes(new Blob([current.code]).size)} · UTF-8
        </span>
        <span className="spacer" />
        <Button icon={copied ? Check : Copy} onClick={() => void copy(current.code)}>
          {copied ? 'Copié' : 'Copier'}
        </Button>
        <Button variant="primary" icon={Download} onClick={() => downloadText(current.code, basename(current.filename))}>
          Télécharger
        </Button>
      </div>
    </aside>
  )
}
