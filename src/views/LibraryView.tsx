// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useMemo, useState } from 'react'
import { Check, Copy, Download, FileArchive, FileCode, PanelLeft, Search, Upload } from 'lucide-react'
import { useStore, type Attachment, type Conversation } from '../store'
import { conversationFiles, type CodeFile } from '../lib/codeblocks'
import { basename, downloadBlob, downloadDataUrl, downloadText, zipFiles } from '../lib/files'
import { formatBytes } from '../lib/format'
import { langLabel } from '../lib/highlight'
import { Button, IconButton, Tag, useCopy } from '../components/ui'

type Img = { a: Attachment; conv: Conversation }
type FileItem = { f: CodeFile; conv: Conversation }

export function LibraryView() {
  const conversations = useStore((s) => s.conversations)
  const order = useStore((s) => s.order)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const [q, setQ] = useState('')

  const { images, files } = useMemo(() => {
    const images: Img[] = []
    const files: FileItem[] = []
    for (const id of order) {
      const conv = conversations[id]
      if (!conv) continue
      for (const m of conv.messages) for (const a of m.attachments ?? []) if (a.kind === 'image') images.push({ a, conv })
      // Dernière version de chaque fichier nommé (ou joint) de la conversation
      const latest = new Map<string, CodeFile>()
      for (const f of conversationFiles(conv.messages)) if (f.named) latest.set(f.filename, f)
      for (const f of latest.values()) files.push({ f, conv })
    }
    return { images, files }
  }, [conversations, order])

  const query = q.trim().toLowerCase()
  const imgs = images.filter(({ a, conv }) => !query || a.name.toLowerCase().includes(query) || conv.title.toLowerCase().includes(query))
  const fls = files.filter(({ f, conv }) => !query || f.filename.toLowerCase().includes(query) || conv.title.toLowerCase().includes(query))

  const open = (convId: string, panel: Parameters<ReturnType<typeof useStore.getState>['openPanel']>[0]) => {
    const s = useStore.getState()
    s.openConversation(convId)
    s.openPanel(panel)
  }

  return (
    <div className="page">
      <div className="page-main">
        <div className="page-head">
          {!sidebarOpen && <IconButton icon={PanelLeft} label="Afficher la barre latérale" onClick={() => useStore.getState().toggleSidebar()} />}
          <div className="page-head-text">
            <h1 className="h1">Fichiers & captures</h1>
            <span className="secondary">
              {images.length} image{images.length > 1 ? 's' : ''} · {files.length} fichier{files.length > 1 ? 's' : ''} — tout reste sur cette machine
            </span>
          </div>
          <div className="input-icon">
            <Search size={14} className="muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher…" />
          </div>
          <Button
            icon={FileArchive}
            disabled={!fls.length}
            onClick={() => downloadBlob(zipFiles(fls.map(({ f }) => ({ name: f.filename, content: f.code }))), 'lumen-fichiers.zip')}
          >
            Tout télécharger (.zip)
          </Button>
        </div>

        <section className="lib-section">
          <span className="overline">Captures & images</span>
          {imgs.length ? (
            <div className="lib-grid">
              {imgs.map(({ a, conv }) => (
                <div key={a.id} className="lib-img">
                  <button type="button" className="lib-img-open" onClick={() => open(conv.id, { type: 'image', id: a.id })} title="Ouvrir dans la conversation">
                    <img src={a.dataUrl} alt={a.name} loading="lazy" />
                  </button>
                  <div className="row">
                    <div className="tcell-name">
                      <span className="label-sm ellipsis">{a.name}</span>
                      <span className="caption muted ellipsis">{conv.title}</span>
                    </div>
                    <span className="spacer" />
                    <IconButton icon={Download} label="Télécharger" onClick={() => void downloadDataUrl(a.dataUrl!, a.name)} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">Aucune image pour l'instant. Collez, glissez ou capturez l'écran depuis la zone de saisie.</div>
          )}
        </section>

        <section className="lib-section">
          <span className="overline">Fichiers de code</span>
          {fls.length ? (
            <div className="lib-list">
              {fls.map(({ f, conv }) => (
                <FileRow key={f.key} f={f} conv={conv} onOpen={() => open(conv.id, { type: 'code', key: f.key })} />
              ))}
            </div>
          ) : (
            <div className="empty">Les fichiers générés par vos modèles (blocs de code nommés) et vos fichiers joints apparaîtront ici.</div>
          )}
        </section>
      </div>
    </div>
  )
}

function FileRow({ f, conv, onOpen }: { f: CodeFile; conv: Conversation; onOpen: () => void }) {
  const [copied, copy] = useCopy()
  return (
    <div className="lib-row" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <span className={`ftile ${f.source === 'upload' ? 'tone-info' : 'tone-accent'}`}>
        {f.source === 'upload' ? <Upload size={16} /> : <FileCode size={18} strokeWidth={1.5} />}
      </span>
      <div className="tcell-name">
        <span className="label ellipsis">{basename(f.filename)}</span>
        <span className="caption muted ellipsis">
          {langLabel(f.lang)} · {f.code.split('\n').length} lignes · {formatBytes(new Blob([f.code]).size)} · {conv.title}
        </span>
      </div>
      <span className="spacer" />
      {f.source === 'upload' && <Tag tone="info">Joint</Tag>}
      <span onClick={(e) => e.stopPropagation()} className="row">
        <IconButton icon={copied ? Check : Copy} label="Copier" onClick={() => void copy(f.code)} />
        <IconButton icon={Download} label="Télécharger" onClick={() => downloadText(f.code, basename(f.filename))} />
      </span>
    </div>
  )
}
