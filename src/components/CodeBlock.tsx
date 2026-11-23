// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { memo, useMemo } from 'react'
import { Check, Copy, Download, FileCode, Maximize2 } from 'lucide-react'
import { useStore } from '../store'
import { highlight, langLabel } from '../lib/highlight'
import { basename, downloadText } from '../lib/files'
import type { CodeFile } from '../lib/codeblocks'
import { Button, IconButton, Tag, useCopy } from './ui'

export const CodeBlock = memo(function CodeBlock({ code, lang, file }: { code: string; lang: string; file?: CodeFile }) {
  const [copied, copy] = useCopy()
  const html = useMemo(() => highlight(code, lang), [code, lang])
  const lineCount = code.split('\n').length
  const gutter = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount])
  const openPanel = useStore((s) => s.openPanel)
  const active = useStore((s) => s.panel?.type === 'code' && s.panel.key === file?.key)
  const name = file?.named ? file.filename : null
  const downloadName = basename(file?.filename ?? `extrait.${lang || 'txt'}`)

  return (
    <div className={`codeblock${active ? ' is-active' : ''}`}>
      <div className="codeblock-head">
        <FileCode size={14} strokeWidth={1.5} className="muted" />
        {name && <span className="mono-sm secondary ellipsis">{name}</span>}
        <Tag>{langLabel(lang)}</Tag>
        <span className="spacer" />
        <Button variant="ghost" small icon={copied ? Check : Copy} className={copied ? 'is-success' : ''} onClick={() => void copy(code)}>
          {copied ? 'Copié' : 'Copier'}
        </Button>
        <Button variant="ghost" small icon={Download} onClick={() => downloadText(code, downloadName)}>
          Télécharger
        </Button>
        {file && <IconButton icon={Maximize2} label="Ouvrir dans le panneau" onClick={() => openPanel({ type: 'code', key: file.key })} />}
      </div>
      <div className="codeblock-body">
        <pre className="gutter" aria-hidden>
          {gutter}
        </pre>
        <pre className="code">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  )
})
