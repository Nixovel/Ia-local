#!/usr/bin/env node
// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Empreinte de l'œuvre : SHA-256 de chaque fichier du dépôt (AUTHORSHIP.sha256) et empreinte globale.
// Publiée avec un commit daté, elle prouve que ce code exact existait, sous le nom de Nixovel, à cette date.
//   node scripts/fingerprint.mjs           écrit AUTHORSHIP.sha256 et affiche l'empreinte globale
//   node scripts/fingerprint.mjs --check   vérifie que les fichiers correspondent toujours à AUTHORSHIP.sha256
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = 'AUTHORSHIP.sha256'
const EXCLUDED = new Set([MANIFEST, 'AUTHORSHIP.md']) // le document de paternité cite l'empreinte : il ne peut pas en faire partie

const sha = (data) => createHash('sha256').update(data).digest('hex')

// Fichiers suivis par git (ou qui le seront), dans un ordre stable
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !EXCLUDED.has(f) && existsSync(path.join(ROOT, f)))
  .sort()

// Fins de ligne normalisées : même empreinte sous Windows (CRLF) et ailleurs
const lines = files.map((f) => {
  const buf = readFileSync(path.join(ROOT, f))
  const text = buf.includes(0) ? buf : Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'))
  return `${sha(text)}  ${f}`
})
const manifest = `# Lumen — empreinte de l'œuvre de Nixovel (https://github.com/Nixovel/Ia-local)\n# sha256  fichier\n${lines.join('\n')}\n`
const root = sha(manifest)

if (process.argv.includes('--check')) {
  const saved = existsSync(path.join(ROOT, MANIFEST)) ? readFileSync(path.join(ROOT, MANIFEST), 'utf8').replace(/\r\n/g, '\n') : ''
  if (saved === manifest) {
    console.log(`✓ Le code correspond à l'empreinte publiée (${files.length} fichiers) — ${root}`)
  } else {
    const before = new Map(saved.split('\n').filter((l) => /^[0-9a-f]{64}  /.test(l)).map((l) => [l.slice(66), l.slice(0, 64)]))
    const changed = lines.filter((l) => before.get(l.slice(66)) !== l.slice(0, 64)).map((l) => l.slice(66))
    console.log(`✗ ${changed.length} fichier(s) différent(s) de l'empreinte publiée :\n  ${changed.slice(0, 20).join('\n  ')}`)
    process.exit(1)
  }
} else {
  writeFileSync(path.join(ROOT, MANIFEST), manifest)
  console.log(`${files.length} fichiers · empreinte globale (SHA-256) :\n${root}`)
}
