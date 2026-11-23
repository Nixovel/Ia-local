// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Paternité du projet : affichée dans l'interface (Réglages → À propos, accueil), la console et le code compilé.

export const AUTHOR = 'Nixovel'
export const AUTHOR_URL = 'https://github.com/Nixovel'
export const REPO_URL = 'https://github.com/Nixovel/Ia-local'
export const COPYRIGHT = `© 2026 ${AUTHOR}. Tous droits réservés.`

/** Signature au démarrage : console du navigateur et attribut sur la page. */
export function signature() {
  document.documentElement.dataset.lumenAuthor = AUTHOR
  console.info(
    `%c Lumen %c conçu et développé par ${AUTHOR} — ${REPO_URL}\n${COPYRIGHT} Toute republication sans accord est interdite (voir LICENSE).`,
    'background:#f2a65a;color:#1a1207;font-weight:700;border-radius:4px;padding:2px 4px',
    'color:inherit',
  )
}
