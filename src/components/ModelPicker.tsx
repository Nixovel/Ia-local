// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useMemo, useRef, useState } from 'react'
import { Box, Check, ChevronRight, Search } from 'lucide-react'
import { useStore } from '../store'
import { capabilityTags, formatCtx, isChatModel, prettyName } from '../lib/models'
import type { ModelInfo } from '../lib/ollama'
import { FIT_INFO, fitHint, fitOf, GiB, useHardware } from '../lib/hardware'
import { LetterTile, Tag, useClickOutside } from './ui'

export function ModelPicker({ placement = 'down', onClose }: { placement?: 'up' | 'down'; onClose: () => void }) {
  const models = useStore((s) => s.runtime.models)
  const running = useStore((s) => s.runtime.running)
  const selected = useStore((s) => s.selectedModel)
  const connected = useStore((s) => s.runtime.connected)
  const { setModel, setView } = useStore.getState()
  const [q, setQ] = useState('')
  const hw = useHardware()
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, onClose)

  const { inMemory, installed } = useMemo(() => {
    const query = q.trim().toLowerCase()
    const list = models
      .filter(isChatModel)
      .filter((m) => !query || m.name.toLowerCase().includes(query) || prettyName(m.name).toLowerCase().includes(query))
    const loaded = new Set(running.map((r) => r.name))
    return { inMemory: list.filter((m) => loaded.has(m.name)), installed: list.filter((m) => !loaded.has(m.name)) }
  }, [models, running, q])

  const pick = (m: ModelInfo) => {
    setModel(m.name)
    onClose()
  }

  const row = (m: ModelInfo) => {
    const tags = capabilityTags(m).filter((t) => t.label === 'Vision' || t.label === 'Réflexion')
    const d = m.details ?? {}
    return (
      <button type="button" key={m.name} className={`mp-row${m.name === selected ? ' is-selected' : ''}`} onClick={() => pick(m)} title={m.name}>
        <LetterTile name={m.name} size={28} />
        <span className="mp-text">
          <span className="label ellipsis">{prettyName(m.name)}</span>
          <span className="caption muted ellipsis">
            {[d.parameter_size, d.quantization_level, d.context_length ? `${formatCtx(d.context_length)} ctx` : null].filter(Boolean).join(' · ')}
          </span>
        </span>
        {tags.map((t) => (
          <Tag key={t.label} tone={t.tone}>
            {t.label}
          </Tag>
        ))}
        {hw && fitOf(GiB(m.size), hw) !== 'fluide' && (
          <span title={fitHint(fitOf(GiB(m.size), hw), hw)}>
            <Tag tone={FIT_INFO[fitOf(GiB(m.size), hw)].tone}>{FIT_INFO[fitOf(GiB(m.size), hw)].label}</Tag>
          </span>
        )}
        {m.name === selected && <Check size={16} className="accent" />}
      </button>
    )
  }

  return (
    <div ref={ref} className={`popover model-picker ${placement}`} role="dialog" aria-label="Choisir un modèle">
      <div className="mp-search">
        <Search size={14} className="muted" />
        <input autoFocus placeholder="Rechercher un modèle local…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="mp-list">
        {!connected && <p className="mp-empty">Ollama est injoignable. Lancez « ollama serve ».</p>}
        {connected && !inMemory.length && !installed.length && <p className="mp-empty">Aucun modèle trouvé.</p>}
        {inMemory.length > 0 && <div className="overline mp-group">En mémoire</div>}
        {inMemory.map(row)}
        {installed.length > 0 && <div className="overline mp-group">Installés</div>}
        {installed.map(row)}
      </div>
      <button
        type="button"
        className="mp-foot"
        onClick={() => {
          setView('models')
          onClose()
        }}
      >
        <Box size={14} />
        <span>Gérer les modèles</span>
        <span className="spacer" />
        <ChevronRight size={14} className="muted" />
      </button>
    </div>
  )
}
