// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { createContext, memo, useContext } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { normCode, parseInfo, type CodeFile } from '../lib/codeblocks'
import { CodeBlock } from './CodeBlock'
import { isSvgCode, SvgImage } from './SvgImage'

type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
  data?: { meta?: string | null }
}

const textOf = (n: HastNode): string => (n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(textOf).join(''))

// Les fichiers extraits du message passent par un contexte : les composants ci-dessous gardent ainsi
// une identité stable. (Recréés à chaque rendu, React démonterait et remonterait chaque bloc de code
// à chaque image du streaming, ce qui relançait son animation en boucle.)
const FilesContext = createContext<CodeFile[] | undefined>(undefined)
const StreamingContext = createContext(false)

function Pre({ node }: { node?: unknown }) {
  const files = useContext(FilesContext)
  const streaming = useContext(StreamingContext)
  const n = node as HastNode | undefined
  const codeEl = n?.children?.find((c) => c.type === 'element' && c.tagName === 'code')
  if (!codeEl) return <pre>{n ? textOf(n) : null}</pre>
  const classes = (codeEl.properties?.className as string[] | undefined) ?? []
  const langClass = classes.find((c) => c.startsWith('language-'))
  const info = `${langClass ? langClass.slice(9) : ''} ${codeEl.data?.meta ?? ''}`
  const code = normCode(textOf(codeEl))
  // Bloc complet : même code. Bloc en cours d'écriture : son code est le début du fichier.
  const file = files?.find((f) => f.code === code) ?? (code ? files?.find((f) => f.code.startsWith(code)) : undefined)
  const lang = file?.lang || parseInfo(info).lang
  // Un dessin SVG s'affiche comme une image (qui se construit pendant l'écriture), son code reste accessible
  if (isSvgCode(code, parseInfo(info).lang || lang, file?.filename)) return <SvgImage code={code} file={file} streaming={streaming} />
  return <CodeBlock code={code} lang={lang} file={file} />
}

const COMPONENTS: Components = {
  pre: Pre,
  code: ({ children, className }) => <code className={`inline-code ${className ?? ''}`}>{children}</code>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
}

const REMARK = [remarkGfm]

export const Markdown = memo(function Markdown({ content, files, streaming }: { content: string; files?: CodeFile[]; streaming?: boolean }) {
  return (
    <FilesContext.Provider value={files}>
      <StreamingContext.Provider value={!!streaming}>
        <div className={`md${streaming ? ' is-streaming' : ''}`}>
          <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS}>
            {content}
          </ReactMarkdown>
        </div>
      </StreamingContext.Provider>
    </FilesContext.Provider>
  )
})
