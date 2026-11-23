// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Accès Internet des modèles (option « Recherche Internet », désactivée par défaut) : recherche, lecture de pages, météo.
//  - Recherche et lecture : API web d'Ollama (gratuite, compte ollama.com relié avec « ollama signin »),
//    sinon Wikipédia pour la recherche et le pont local pour lire une page.
//  - Météo : Open-Meteo (gratuit, sans compte ni clé).
import { getBaseUrl } from './ollama'
import { callTool, type ToolResult } from './agent'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s)
const post = (path: string, body: unknown, signal?: AbortSignal) =>
  fetch(getBaseUrl() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })

// ---------- Compte Ollama (débloque la recherche web complète) ----------
export type OllamaAccount = { signedIn: true; name?: string } | { signedIn: false; signinUrl?: string }

/** null = Ollama injoignable (ou trop ancien pour la recherche web). */
export async function ollamaAccount(): Promise<OllamaAccount | null> {
  try {
    const r = await post('/api/me', {})
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>
    if (r.ok) return { signedIn: true, name: String(body.name ?? body.Name ?? body.email ?? '') || undefined }
    if (r.status === 401) {
      const url = typeof body.signin_url === 'string' && body.signin_url.startsWith('https://ollama.com/') ? body.signin_url : undefined
      return { signedIn: false, signinUrl: url }
    }
    return null
  } catch {
    return null
  }
}

const NOT_SIGNED_IN =
  "Recherche web complète indisponible : Ollama n'est relié à aucun compte ollama.com (gratuit). L'utilisateur peut le relier dans Réglages → Recherche Internet, ou avec la commande « ollama signin »."

// ---------- Recherche ----------
type Hit = { title: string; url: string; content: string }

async function wikipedia(query: string, max: number): Promise<Hit[]> {
  const url = `https://fr.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&utf8=1&srlimit=${max}&srsearch=${encodeURIComponent(query)}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Wikipédia : ${r.status}`)
  const data = (await r.json()) as { query?: { search?: { title: string; snippet: string }[] } }
  const strip = (h: string) => new DOMParser().parseFromString(h, 'text/html').body.textContent ?? ''
  return (data.query?.search ?? []).map((s) => ({
    title: s.title,
    url: `https://fr.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
    content: strip(s.snippet),
  }))
}

const formatHits = (query: string, hits: Hit[], note = '') =>
  [
    note,
    hits.length ? `Résultats pour « ${query} » :` : `Aucun résultat pour « ${query} ».`,
    ...hits.map((h, i) => `\n[${i + 1}] ${h.title}\n${h.url}\n${clip(h.content.replace(/\s+/g, ' ').trim(), 900)}`),
  ]
    .filter(Boolean)
    .join('\n')

export async function webSearch(query: string, maxResults = 5): Promise<ToolResult> {
  const q = query.trim()
  if (!q) return { ok: false, output: 'Paramètre « query » manquant.' }
  const max = Math.min(10, Math.max(1, Math.round(maxResults) || 5))
  const r = await post('/api/experimental/web_search', { query: q, max_results: max }).catch(() => null)
  if (r?.ok) {
    const data = (await r.json()) as { results?: Hit[] }
    return { ok: true, output: formatHits(q, data.results ?? []) }
  }
  // Pas de compte relié (ou Ollama trop ancien) : Wikipédia, pour les faits encyclopédiques
  try {
    const hits = await wikipedia(q, max)
    return { ok: true, output: formatHits(q, hits, `${NOT_SIGNED_IN}\nRésultats de Wikipédia seulement (pas d'actualité).\n`) }
  } catch (e) {
    return { ok: false, output: `${NOT_SIGNED_IN}\nWikipédia injoignable : ${(e as Error).message}` }
  }
}

// ---------- Lecture d'une page ----------
export async function webFetch(url: string): Promise<ToolResult> {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return { ok: false, output: `URL invalide : ${url}` }
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, output: 'Seules les adresses http(s) sont acceptées.' }
  const r = await post('/api/experimental/web_fetch', { url: u.href }).catch(() => null)
  if (r?.ok) {
    const data = (await r.json()) as { title?: string; content?: string; links?: string[] }
    const links = (data.links ?? []).slice(0, 15)
    return {
      ok: true,
      output: [`${data.title ?? u.href}\n${u.href}`, clip(data.content ?? '', 12_000), links.length ? `Liens :\n${links.join('\n')}` : '']
        .filter(Boolean)
        .join('\n\n'),
    }
  }
  // Sans compte : le pont local télécharge la page lui-même (adresses locales et privées refusées)
  return callTool('fetch_url', { url: u.href }, '~')
}

// ---------- Météo (Open-Meteo) ----------
const WMO: Record<number, string> = {
  0: 'ciel dégagé', 1: 'plutôt dégagé', 2: 'partiellement nuageux', 3: 'couvert', 45: 'brouillard', 48: 'brouillard givrant',
  51: 'bruine légère', 53: 'bruine', 55: 'bruine forte', 56: 'bruine verglaçante', 57: 'bruine verglaçante forte',
  61: 'pluie faible', 63: 'pluie', 65: 'pluie forte', 66: 'pluie verglaçante', 67: 'pluie verglaçante forte',
  71: 'neige faible', 73: 'neige', 75: 'neige forte', 77: 'grains de neige', 80: 'averses faibles', 81: 'averses',
  82: 'averses violentes', 85: 'averses de neige', 86: 'fortes averses de neige', 95: 'orage', 96: 'orage avec grêle', 99: 'orage avec forte grêle',
}
const sky = (code: number) => WMO[code] ?? `code météo ${code}`

type Place = { name: string; latitude: number; longitude: number; country?: string; country_code?: string; admin1?: string; timezone?: string }

async function geocode(location: string): Promise<Place | null> {
  const [name, ...rest] = location.split(',').map((x) => x.trim())
  const hint = rest.join(' ').toLowerCase()
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=5&language=fr&format=json&name=${encodeURIComponent(name)}`)
  if (!r.ok) throw new Error(`géocodage : ${r.status}`)
  const places = ((await r.json()) as { results?: Place[] }).results ?? []
  // « Paris, Texas » : on préfère le résultat qui correspond au pays / à la région donnés
  return (
    (hint && places.find((p) => [p.country, p.country_code, p.admin1].some((v) => v && hint.includes(v.toLowerCase())))) ||
    places[0] ||
    null
  )
}

export async function weather(location: string, days = 3): Promise<ToolResult> {
  if (!location.trim()) return { ok: false, output: "Ville inconnue : demande à l'utilisateur dans quelle ville il se trouve (il peut aussi la renseigner dans Réglages)." }
  const place = await geocode(location)
  if (!place) return { ok: false, output: `Lieu introuvable : « ${location} ». Demande une orthographe plus précise.` }
  const n = Math.min(7, Math.max(1, Math.round(days) || 3))
  const q = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    timezone: 'auto',
    forecast_days: String(n),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
  })
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`)
  if (!r.ok) return { ok: false, output: `Service météo indisponible (${r.status}).` }
  const w = (await r.json()) as {
    current: Record<string, number | string>
    daily: Record<string, (number | string)[]>
  }
  const c = w.current
  const d = w.daily
  const hm = (iso: unknown) => String(iso).slice(11, 16)
  const day = (iso: string) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
  const where = [place.name, place.admin1, place.country].filter(Boolean).join(', ')
  const lines = [
    `Météo pour ${where} (source : Open-Meteo, heure locale ${hm(c.time)}).`,
    `Maintenant : ${sky(Number(c.weather_code))}, ${c.temperature_2m} °C (ressenti ${c.apparent_temperature} °C), humidité ${c.relative_humidity_2m} %, vent ${c.wind_speed_10m} km/h (rafales ${c.wind_gusts_10m} km/h), précipitations ${c.precipitation} mm.`,
    '',
    'Prévisions :',
    ...(d.time as string[]).map(
      (t, i) =>
        `- ${day(t)} : ${sky(Number(d.weather_code[i]))}, ${d.temperature_2m_min[i]} à ${d.temperature_2m_max[i]} °C, pluie ${d.precipitation_sum[i]} mm (risque ${d.precipitation_probability_max[i] ?? '?'} %), vent max ${d.wind_speed_10m_max[i]} km/h, soleil ${hm(d.sunrise[i])}–${hm(d.sunset[i])}`,
    ),
  ]
  return { ok: true, output: lines.join('\n') }
}
