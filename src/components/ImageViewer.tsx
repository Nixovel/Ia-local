// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect, useState } from 'react'
import { Check, Copy, Download, Image as ImageIcon, Scan, X, ZoomIn, ZoomOut } from 'lucide-react'
import { toast, useStore, type Attachment } from '../store'
import { copyImage, downloadDataUrl } from '../lib/files'
import { formatBytes } from '../lib/format'
import { Button, IconButton } from './ui'

export function ImageViewer({ images, currentId }: { images: Attachment[]; currentId: string }) {
  const openPanel = useStore((s) => s.openPanel)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [copied, setCopied] = useState(false)
  const idx = Math.max(0, images.findIndex((i) => i.id === currentId))
  const img = images[idx]

  useEffect(() => setZoom('fit'), [currentId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('textarea, input')) return
      if (e.key === 'ArrowRight' && idx < images.length - 1) openPanel({ type: 'image', id: images[idx + 1].id })
      if (e.key === 'ArrowLeft' && idx > 0) openPanel({ type: 'image', id: images[idx - 1].id })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [idx, images, openPanel])

  if (!img?.dataUrl) return null
  const z = zoom === 'fit' ? null : zoom
  const step = (dir: 1 | -1) => setZoom((cur) => {
    const base = cur === 'fit' ? 1 : cur
    if (cur === 'fit') return dir > 0 ? 1 : 0.5
    return Math.min(4, Math.max(0.1, Math.round(base * (dir > 0 ? 1.25 : 0.8) * 100) / 100))
  })
  const ext = img.mime.split('/')[1]?.toUpperCase() ?? 'PNG'

  return (
    <aside className="panel image-panel">
      <div className="panel-head">
        <span className="ftile tone-violet sm">
          <ImageIcon size={14} strokeWidth={1.6} />
        </span>
        <div className="panel-title">
          <span className="label-sm ellipsis">{img.name}</span>
          <span className="caption muted">
            Image {idx + 1} sur {images.length}
            {img.width ? ` · ${img.width}×${img.height}` : ''}
          </span>
        </div>
        <span className="spacer" />
        <IconButton icon={ZoomOut} label="Zoom arrière" onClick={() => step(-1)} />
        <span className="mono-sm secondary zoom-val">{z ? `${Math.round(z * 100)} %` : 'Ajusté'}</span>
        <IconButton icon={ZoomIn} label="Zoom avant" onClick={() => step(1)} />
        <IconButton icon={Scan} label="Ajuster à la fenêtre" active={zoom === 'fit'} onClick={() => setZoom('fit')} />
        <span className="vdivider" />
        <IconButton icon={X} label="Fermer" onClick={() => openPanel(null)} />
      </div>

      <div className={`viewer-canvas${z ? ' is-zoomed' : ''}`} onDoubleClick={() => setZoom((c) => (c === 'fit' ? 1 : 'fit'))}>
        <img src={img.dataUrl} alt={img.name} style={z && img.width ? { width: img.width * z, maxWidth: 'none', maxHeight: 'none' } : undefined} draggable={false} />
      </div>

      {images.length > 1 && (
        <div className="viewer-strip">
          {images.map((i) => (
            <button
              type="button"
              key={i.id}
              className={`strip-thumb${i.id === img.id ? ' is-active' : ''}`}
              onClick={() => openPanel({ type: 'image', id: i.id })}
              title={i.name}
            >
              <img src={i.dataUrl} alt="" />
            </button>
          ))}
        </div>
      )}

      <div className="panel-foot">
        <span className="mono-sm muted">
          {img.width ? `${img.width} × ${img.height} · ` : ''}
          {ext} · {formatBytes(img.size)}
        </span>
        <span className="spacer" />
        <Button
          icon={copied ? Check : Copy}
          onClick={async () => {
            if (await copyImage(img.dataUrl!)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            } else toast("Copie de l'image refusée par le navigateur", 'danger')
          }}
        >
          {copied ? 'Copiée' : "Copier l'image"}
        </Button>
        <Button variant="primary" icon={Download} onClick={() => void downloadDataUrl(img.dataUrl!, img.name)}>
          Télécharger
        </Button>
      </div>
    </aside>
  )
}
