// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { memo, useMemo, useState } from 'react'
import { CodeXml, Download, ImageDown, Maximize2, PenTool } from 'lucide-react'
import { useStore, toast } from '../store'
import { basename, downloadBlob, downloadText, loadImage } from '../lib/files'
import type { CodeFile } from '../lib/codeblocks'
import { CodeBlock } from './CodeBlock'
import { Button, IconButton, Tag } from './ui'

/** Bloc de code qui contient un dessin SVG (```svg, ou ```xml / ```html qui commence par <svg). */
export const isSvgCode = (code: string, lang: string, filename = '') =>
  lang === 'svg' || /\.svg$/i.test(filename) || (/^(xml|html|)$/i.test(lang) && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(code))

/**
 * SVG → data URL affichable dans une <img>. Le parseur HTML, tolérant, referme les balises d'un dessin
 * encore en cours d'écriture (on le voit ainsi se construire) ; XMLSerializer produit ensuite un SVG bien formé,
 * avec l'espace de noms même si le modèle l'a oublié. Dans une <img>, scripts et ressources externes sont ignorés.
 */
function toImage(code: string): { url: string; xml: string; width: number; height: number; shapes: number } | null {
  const doc = new DOMParser().parseFromString(code, 'text/html')
  const svg = doc.querySelector('svg')
  if (!svg) return null
  const num = (v: string | null) => (v && /^\s*[\d.]+\s*(px)?\s*$/.test(v) ? parseFloat(v) : 0)
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  let width = num(svg.getAttribute('width'))
  let height = num(svg.getAttribute('height'))
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    if (!width && !height) [width, height] = [vb[2], vb[3]]
    else if (!height) height = (width * vb[3]) / vb[2]
    else if (!width) width = (height * vb[2]) / vb[3]
  } else if (width && height) svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  width ||= 512
  height ||= 512
  // Taille explicite : sans elle, certains navigateurs donnent 300 × 150 à l'image
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  const shapes = svg.querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon, text').length
  const xml = new XMLSerializer().serializeToString(svg)
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, xml, width, height, shapes }
}

async function downloadPng(url: string, width: number, height: number, name: string) {
  try {
    const img = await loadImage(url)
    // Au moins 1024 px sur le grand côté, sans dépasser 4096
    const scale = Math.min(4096 / Math.max(width, height), Math.max(2, 1024 / Math.max(width, height)))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (!blob) throw new Error('conversion impossible')
    downloadBlob(blob, name)
  } catch (e) {
    toast(`Export PNG impossible : ${(e as Error).message}`, 'danger')
  }
}

/** Dessin SVG du modèle affiché comme une image : aperçu qui se construit pendant l'écriture, puis SVG / PNG / code. */
export const SvgImage = memo(function SvgImage({ code, file, streaming }: { code: string; file?: CodeFile; streaming: boolean }) {
  const img = useMemo(() => toImage(code), [code])
  const [showCode, setShowCode] = useState(false)
  const openPanel = useStore((s) => s.openPanel)
  const done = /<\/svg>/i.test(code)
  const drawing = streaming && !done
  const base = basename(file?.filename ?? 'dessin.svg').replace(/\.[^.]+$/, '') || 'dessin'

  return (
    <div className={`svgimg${drawing ? ' is-drawing' : ''}`}>
      <div className="svgimg-stage">
        {img ? <img src={img.url} alt={file?.named ? base : 'Dessin généré'} draggable={false} /> : <PenTool size={22} className="muted" />}
        {drawing && (
          <span className="svgimg-status caption">
            <PenTool size={12} /> Dessin en cours… {img?.shapes ? `${img.shapes} forme${img.shapes > 1 ? 's' : ''}` : ''}
          </span>
        )}
      </div>
      <div className="svgimg-bar">
        <Tag tone="violet">Image SVG</Tag>
        {img && done && <span className="mono-sm muted">{`${Math.round(img.width)} × ${Math.round(img.height)}`}</span>}
        {!done && !streaming && <span className="caption danger">Dessin incomplet</span>}
        <span className="spacer" />
        <Button variant="ghost" small icon={CodeXml} className={showCode ? 'is-on' : ''} onClick={() => setShowCode((v) => !v)}>
          Code
        </Button>
        <Button variant="ghost" small icon={Download} disabled={!img || drawing} onClick={() => img && downloadText(img.xml, `${base}.svg`, 'image/svg+xml')}>
          SVG
        </Button>
        <Button variant="ghost" small icon={ImageDown} disabled={!img || drawing} onClick={() => img && void downloadPng(img.url, img.width, img.height, `${base}.png`)}>
          PNG
        </Button>
        {file && <IconButton icon={Maximize2} label="Ouvrir dans le panneau" onClick={() => openPanel({ type: 'code', key: file.key })} />}
      </div>
      {showCode && <CodeBlock code={code} lang="xml" file={file} />}
    </div>
  )
})
