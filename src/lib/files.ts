// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { strToU8, zipSync } from 'fflate'

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export const downloadText = (text: string, filename: string, mime = 'text/plain') =>
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename)

export async function downloadDataUrl(dataUrl: string, filename: string) {
  downloadBlob(await (await fetch(dataUrl)).blob(), filename)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Image illisible"))
    img.src = src
  })
}

export async function copyImage(dataUrl: string): Promise<boolean> {
  try {
    const img = await loadImage(dataUrl)
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (!blob) return false
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}

export const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })

export type NormalizedImage = { dataUrl: string; width: number; height: number; mime: string }

/** Réduit les très grandes images (captures Retina…) pour garder des requêtes raisonnables. */
export async function normalizeImage(dataUrl: string, maxSide = 2048): Promise<NormalizedImage> {
  const img = await loadImage(dataUrl)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const mime = dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png'
  const scale = Math.min(1, maxSide / Math.max(w, h))
  const supported = ['image/png', 'image/jpeg', 'image/webp'].includes(mime)
  if (scale === 1 && supported) return { dataUrl, width: w, height: h, mime }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  const out = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  return { dataUrl: canvas.toDataURL(out, 0.92), width: canvas.width, height: canvas.height, mime: out }
}

/** Capture d'écran via l'API du navigateur (l'utilisateur choisit l'écran, la fenêtre ou l'onglet). */
export async function captureScreen(): Promise<NormalizedImage> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  try {
    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    await video.play()
    await new Promise((r) => setTimeout(r, 180))
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    return normalizeImage(canvas.toDataURL('image/png'))
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
}

const TEXT_EXT =
  /\.(txt|md|markdown|mdx|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|xml|html?|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|py|pyi|ipynb|rb|go|rs|java|kt|kts|swift|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|fish|ps1|bat|sql|graphql|gql|vue|svelte|astro|lua|r|dart|scala|ex|exs|erl|hs|ml|clj|tf|gradle|mk|proto|sol|zig|nim|svg|lock|properties)$/i
const TEXT_NAMES = /^(Dockerfile|Makefile|Procfile|\.env.*|\.gitignore|\.dockerignore|\.editorconfig|LICENSE|README)$/i

export const isTextFile = (f: File) =>
  f.type.startsWith('text/') ||
  TEXT_EXT.test(f.name) ||
  TEXT_NAMES.test(f.name) ||
  ['application/json', 'application/xml', 'application/javascript', 'application/x-sh', 'application/sql'].includes(f.type)

export function zipFiles(files: { name: string; content: string }[]): Blob {
  const entries: Record<string, Uint8Array> = {}
  for (const f of files) {
    let name = f.name.replace(/^\/+/, '')
    let i = 2
    while (entries[name]) name = f.name.replace(/(\.[^.]+)?$/, `-${i++}$1`)
    entries[name] = strToU8(f.content)
  }
  return new Blob([new Uint8Array(zipSync(entries))], { type: 'application/zip' })
}

export const basename = (path: string) => path.split('/').pop() || path
