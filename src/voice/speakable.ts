// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Transforme la réponse (Markdown, en cours d'écriture) en phrases à dire, au fur et à mesure :
// la voix commence dès la première phrase terminée, sans attendre la fin de la réponse.

/** Texte écrit → texte prononçable (pas de symboles Markdown, d'URL, d'emojis ; unités en toutes lettres). */
export function toSpeech(md: string): string {
  return (
    md
      .replace(/^\s*\|.*\|\s*$/gm, ' ') // tableaux
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // liens : leur texte seulement
      .replace(/https?:\/\/\S+/g, 'ce lien')
      .replace(/<[^>]+>/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/^\s*>\s?/gm, '')
      // éléments de liste : chacun devient une phrase
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+(.+?)\s*$/gm, (_, t: string) => (/[.!?:;…]$/.test(t) ? t : `${t}.`))
      .replace(/\p{Extended_Pictographic}️?/gu, '')
      .replace(/(\d)\s*°\s*C\b/g, '$1 degrés')
      .replace(/(\d)\s*%/g, '$1 pour cent')
      .replace(/(\d)\s*km\/h/g, '$1 kilomètres heure')
      .replace(/(\d)\s*mm\b/g, '$1 millimètres')
      .replace(/(\d)\s*[–-]\s*(\d)/g, '$1 à $2')
      .replace(/(\d)\.(\d)/g, '$1,$2') // 10.6 → « 10,6 » (lu « dix virgule six »)
      .replace(/[*_~#|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** Découpe en phrases de taille raisonnable (les très courtes sont regroupées, les très longues coupées aux virgules). */
export function sentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? []
  const out: string[] = []
  for (const p of parts) {
    if (p.length > 260) {
      let cur = ''
      for (const piece of p.split(/(?<=[,;:])\s+/)) {
        if ((cur + ' ' + piece).length > 220 && cur) {
          out.push(cur)
          cur = piece
        } else cur = cur ? `${cur} ${piece}` : piece
      }
      if (cur) out.push(cur)
    } else if (out.length && out[out.length - 1].length < 30) out[out.length - 1] += ` ${p}`
    else out.push(p)
  }
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s))
}

/**
 * Suit une réponse en streaming : `feed(contenu complet jusqu'ici)` renvoie les nouveaux morceaux prêts à dire.
 * Pour parler en même temps que le texte s'écrit, la voix démarre dès les premiers mots (première virgule ou ~8 mots),
 * puis avance de phrase en phrase (ou de virgule en virgule dans les longues phrases).
 * Les blocs de code ne sont pas lus : une phrase les annonce (« Je vous affiche le code. »).
 */
/** Un morceau à dire, et sa place dans le texte écrit (pour afficher le texte au rythme de la voix). */
export type Chunk = { text: string; from: number; to: number }

export class SpeechChunker {
  private pos = 0
  private spoken = 0 // morceaux déjà rendus pour ce message

  /**
   * Où couper le texte encore en cours d'écriture (0 = attendre encore un peu).
   * `hungry` : la voix va bientôt manquer de texte (début de réponse, ou tout ce qui était prêt a été dit) :
   * on prend alors ce qui est déjà écrit, à la dernière virgule ou au dernier mot, pour rester collé au texte.
   * Sinon on attend les fins de phrase, pour une intonation naturelle.
   */
  private cut(region: string, hungry: boolean): number {
    const ends = [...region.matchAll(/[.!?…](?=\s)|\n\s*\n|\n(?=\s*(?:[-*+•]|\d+[.)])\s)/g)]
    const last = ends[ends.length - 1]
    if (last) return last.index! + last[0].length
    const clauses = [...region.matchAll(/[,;:—–](?=\s)/g)]
    if (hungry) {
      const clause = clauses.filter((m) => m.index! >= 6).pop()
      if (clause) return clause.index! + clause[0].length
      const words = [...region.matchAll(/\S+\s+/g)]
      if (words.length >= (this.spoken === 0 ? 5 : 7)) {
        const w = words[words.length - 1]
        return w.index! + w[0].length
      }
      return 0
    }
    // Très longue phrase : on avance quand même à une virgule
    const clause = clauses.filter((m) => m.index! >= 90).pop()
    return clause ? clause.index! + clause[0].length : 0
  }

  feed(content: string, final: boolean, hungry = false): Chunk[] {
    const out: Chunk[] = []
    for (;;) {
      const rest = content.slice(this.pos)
      const fence = rest.search(/^ {0,3}(```|~~~)/m)
      if (fence === 0) {
        // Bloc de code : on attend sa fin, puis on l'annonce sans le lire
        const open = rest.match(/^ {0,3}(```|~~~)([^\n]*)\n?/)!
        const close = rest.slice(open[0].length).search(new RegExp(`^ {0,3}${open[1]}\\s*$`, 'm'))
        if (close < 0 && !final) break
        const lang = open[2].trim().toLowerCase()
        const body = rest.slice(open[0].length, close < 0 ? undefined : open[0].length + close)
        const from = this.pos
        const end = close < 0 ? -1 : rest.indexOf('\n', open[0].length + close)
        this.pos = close < 0 || end < 0 ? content.length : this.pos + end + 1
        out.push({ text: lang.startsWith('svg') || /^\s*<svg/i.test(body) ? 'Voici le dessin.' : 'Je vous affiche le code à l’écran.', from, to: this.pos })
        this.spoken++
        if (close < 0) break
        continue
      }
      const region = fence > 0 ? rest.slice(0, fence) : rest
      const take = fence < 0 && !final ? this.cut(region, hungry || this.spoken === 0) : region.length
      if (take > 0) {
        // Les morceaux se partagent le passage écrit au prorata de leur longueur (approximation suffisante pour l'affichage)
        const parts = sentences(toSpeech(region.slice(0, take)))
        const total = parts.reduce((n, p) => n + p.length, 0) || 1
        let from = this.pos
        let acc = 0
        for (const p of parts) {
          acc += p.length
          const to = this.pos + Math.round((take * acc) / total)
          out.push({ text: p, from, to })
          from = to
        }
        this.spoken += parts.length
      }
      this.pos += take
      if (fence < 0 || take < region.length) break
    }
    return out
  }
}
