// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useMemo, useState, type CSSProperties } from 'react'
import {
  Activity, Brain, Check, Cpu, Download, HardDrive, Layers, Lightbulb, LoaderCircle, MessageSquare, PanelLeft, Play, RefreshCw, Scale,
  Search, Sparkles, Square, Target, Trash, X, Zap, type LucideIcon,
} from 'lucide-react'
import { DEFAULT_SETTINGS, thinkModeOf, toast, useStore } from '../store'
import { ollama, type ModelInfo, type RunningModel } from '../lib/ollama'
import { capabilityTags, formatCtx, modelSubtitle, prettyName, supportsThinking } from '../lib/models'
import {
  CATALOG, CATEGORY_HINT, CATEGORY_LABEL, describeMachine, FIT_INFO, fitHint, fitOf, fluidLimit, GiB, recommend, useHardware, useLiveUsage, VARIANT_LABEL, variantOf,
  type CatalogModel, type Category, type Fit, type SystemInfo, type Variant,
} from '../lib/hardware'
import { formatBytes, fr } from '../lib/format'
import { STRENGTHS as STRENGTH_LIST, strengthsOf } from '../lib/strengths'
import { Button, IconButton, LetterTile, Meter, StackMeter, StatusDot, Tag, useArmed } from '../components/ui'
import { cancelPull, startPull } from '../lib/pull'

export function ModelsView() {
  const runtime = useStore((s) => s.runtime)
  const tpsHistory = useStore((s) => s.tpsHistory)
  const selectedModel = useStore((s) => s.selectedModel)
  const pulls = useStore((s) => s.pulls)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const baseUrl = useStore((s) => s.baseUrl)
  const [tab, setTab] = useState<'installed' | 'discover'>('installed')
  const [filter, setFilter] = useState('')
  const [pullName, setPullName] = useState('')
  const [focus, setFocus] = useState('')
  const [cat, setCat] = useState<Category | 'all'>('all')
  const variant = useStore((s) => s.modelVariant)
  const current = focus || selectedModel

  const running = useMemo(() => new Map(runtime.running.map((r) => [r.name, r])), [runtime.running])
  const q = filter.trim().toLowerCase()
  const models = runtime.models.filter((m) => !q || m.name.toLowerCase().includes(q) || prettyName(m.name).toLowerCase().includes(q))
  const disk = runtime.models.reduce((n, m) => n + m.size, 0)
  const vram = runtime.running.reduce((n, r) => n + r.size_vram, 0)
  const loadedSize = runtime.running.reduce((n, r) => n + r.size, 0)
  const recent = tpsHistory.slice(-20)
  const avgTps = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0
  const spark = tpsHistory.slice(-18)
  const maxSpark = Math.max(1, ...spark)
  const installedNames = new Set(runtime.models.map((m) => m.name))
  const hw = useHardware()
  const limit = hw ? fluidLimit(hw) : null
  const heavy = hw ? runtime.models.filter((m) => fitOf(GiB(m.size), hw) === 'lourd').length : 0

  return (
    <div className="page">
      <div className="page-main">
        <div className="page-head">
          {!sidebarOpen && <IconButton icon={PanelLeft} label="Afficher la barre latérale" onClick={() => useStore.getState().toggleSidebar()} />}
          <div className="page-head-text">
            <h1 className="h1">Modèles locaux</h1>
            <span className="secondary">
              {runtime.models.length} modèles · {formatBytes(disk)} sur disque{runtime.version ? ` · Ollama ${runtime.version}` : ''}
            </span>
          </div>
          <form
            className="pull-form"
            onSubmit={(e) => {
              e.preventDefault()
              void startPull(pullName)
              setPullName('')
            }}
          >
            <div className="input-icon">
              <Download size={14} className="muted" />
              <input value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder="qwen2.5-coder:7b, hf.co/…" aria-label="Nom du modèle à télécharger" />
            </div>
            <Button variant="primary" icon={Download} type="submit" disabled={!pullName.trim()}>
              Télécharger
            </Button>
          </form>
        </div>

        {hw && limit && (
          <div className="machine">
            <span className="machine-icon">
              <Cpu size={18} strokeWidth={1.6} />
            </span>
            <div className="tcell-name">
              <span className="label">Votre machine : {describeMachine(hw)}</span>
              <span className="caption muted">
                Modèles fluides jusqu'à ≈ {fr(limit.sizeGB, 0)} Go (environ {Math.round(limit.paramsB)} milliards de paramètres en Q4)
                {hw.diskFreeGB != null ? ` · ${fr(hw.diskFreeGB, 0)} Go libres sur le disque` : ''}
              </span>
            </div>
            <span className="spacer" />
            {heavy > 0 && <Tag tone="danger">{heavy} modèle{heavy > 1 ? 's' : ''} trop lourd{heavy > 1 ? 's' : ''}</Tag>}
            <Button small variant="ghost" icon={Download} onClick={() => useStore.getState().setOnboarding(true)}>
              Assistant
            </Button>
            <Button small variant="secondary" icon={Sparkles} onClick={() => setTab('discover')}>
              Modèles conseillés
            </Button>
          </div>
        )}

        <div className="stats">
          <LiveUsageCard modelsBytes={loadedSize} vramBytes={vram} loadedCount={runtime.running.length} />
          <div className="stat">
            <div className="stat-label"><HardDrive size={14} /><span className="overline">Espace disque</span></div>
            <div className="stat-value"><b>{formatBytes(disk)}</b><span className="caption muted">{runtime.models.length} modèles</span></div>
            <Meter value={runtime.models.length ? 1 : 0} tone="info" />
            <span className="caption muted">Dossier ~/.ollama/models</span>
          </div>
          <div className="stat">
            <div className="stat-label"><Activity size={14} /><span className="overline">Débit moyen</span></div>
            <div className="stat-value"><b>{avgTps ? fr(avgTps, 0) : '—'}</b><span className="caption muted">tok/s</span></div>
            <div className="spark" aria-hidden>
              {spark.length ? spark.map((v, i) => <i key={i} style={{ height: `${Math.max(12, (v / maxSpark) * 100)}%`, opacity: 0.45 + 0.55 * (i / Math.max(1, spark.length - 1)) }} />) : <span className="caption muted">Pas encore de mesures</span>}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label"><StatusDot tone={runtime.connected ? 'success' : 'danger'} /><span className="overline">Runtime</span></div>
            <div className="stat-value"><b>{runtime.connected ? 'En ligne' : 'Hors ligne'}</b><span className="caption muted">{runtime.version ? `v${runtime.version}` : ''}</span></div>
            <span className="caption muted ellipsis">{baseUrl === '/ollama' ? 'Proxy → 127.0.0.1:11434' : baseUrl}</span>
            <Button small variant="ghost" icon={RefreshCw} onClick={() => void useStore.getState().refreshRuntime(true)}>
              Actualiser
            </Button>
          </div>
        </div>

        <div className="tabs">
          <button type="button" className={`tab${tab === 'installed' ? ' is-on' : ''}`} onClick={() => setTab('installed')}>
            Installés <Tag tone={tab === 'installed' ? 'accent' : 'neutral'}>{runtime.models.length}</Tag>
          </button>
          <button type="button" className={`tab${tab === 'discover' ? ' is-on' : ''}`} onClick={() => setTab('discover')}>
            Découvrir
          </button>
          <span className="spacer" />
          {tab === 'discover' && (
            <div className="segmented seg-text" role="radiogroup" aria-label="Version des modèles">
              {(['standard', 'uncensored'] as Variant[]).map((v) => (
                <button type="button" key={v} role="radio" aria-checked={variant === v} className={variant === v ? 'is-on' : ''} onClick={() => useStore.getState().setModelVariant(v)}>
                  {VARIANT_LABEL[v]}
                </button>
              ))}
            </div>
          )}
          {tab === 'installed' && (
            <div className="input-icon tabs-filter">
              <Search size={14} className="muted" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer les modèles…" />
            </div>
          )}
        </div>

        {Object.entries(pulls).length > 0 && (
          <div className="table">
            {Object.entries(pulls).map(([name, p]) => (
              <div key={name} className="trow pull-row">
                <div className="tcell-model">
                  <LetterTile name={name} size={34} />
                  <div className="tcell-name">
                    <span className="label ellipsis">{prettyName(name)}</span>
                    <span className={`caption ${p.error ? 'danger' : 'muted'} ellipsis`}>{p.error ?? p.status}</span>
                  </div>
                </div>
                <div className="progress-cell">
                  <div className="row">
                    <span className="mono-sm secondary">{p.total ? `${formatBytes(p.completed ?? 0)} / ${formatBytes(p.total)}` : '…'}</span>
                    <span className="spacer" />
                    {p.total ? <span className="mono-sm accent">{Math.floor(((p.completed ?? 0) / p.total) * 100)} %</span> : null}
                  </div>
                  <Meter value={p.total ? (p.completed ?? 0) / p.total : 0} />
                </div>
                <IconButton
                  icon={X}
                  label={p.error ? 'Fermer' : 'Annuler le téléchargement'}
                  onClick={() => (p.error ? useStore.getState().setPull(name, null) : cancelPull(name))}
                />
              </div>
            ))}
          </div>
        )}

        {tab === 'installed' ? (
          <div className="table">
            <div className="thead overline">
              <span>Modèle</span>
              <span>Taille</span>
              <span className="col-caps">Capacités</span>
              <span>Statut</span>
            </div>
            {models.map((m) => (
              <ModelRow key={m.name} m={m} run={running.get(m.name)} selected={m.name === current} onSelect={() => setFocus(m.name)} hw={hw} />
            ))}
            {!models.length && (
              <div className="empty">
                {runtime.connected === false ? "Ollama est injoignable — lancez « ollama serve »." : q ? 'Aucun modèle ne correspond.' : 'Aucun modèle installé. Téléchargez-en un depuis « Découvrir ».'}
              </div>
            )}
          </div>
        ) : (
          <>
            {hw && (
              <section className="reco">
                <div className="row">
                  <Sparkles size={15} className="accent" />
                  <span className="label">Conseillés pour votre PC</span>
                  <span className="caption muted">
                    — pour chaque usage, le plus capable qui reste fluide sur cette machine{variant === 'uncensored' ? ' (version non censurée quand elle tient)' : ''}
                  </span>
                </div>
                {variant === 'uncensored' && (
                  <span className="caption muted">
                    Versions modifiées (« abliterated », Dolphin) qui refusent beaucoup moins de demandes. Vous restez responsable de leur usage.
                  </span>
                )}
                <div className="reco-grid">
                  {recommend(hw, variant).map(({ category, model, fit, primary }) => (
                    <CatalogCard
                      key={category}
                      d={model}
                      fit={fit}
                      hw={hw}
                      kicker={CATEGORY_LABEL[category]}
                      note={primary ? undefined : CATEGORY_HINT[category]}
                      installed={installedNames.has(model.name)}
                      pulling={!!pulls[model.name]}
                    />
                  ))}
                </div>
              </section>
            )}
            <div className="row discover-filters">
              <span className="overline">Toute la sélection</span>
              <span className="spacer" />
              {(['all', ...Object.keys(CATEGORY_LABEL)] as (Category | 'all')[]).map((c) => (
                <button type="button" key={c} className={`chip${cat === c ? ' is-on' : ''}`} onClick={() => setCat(c)}>
                  {c === 'all' ? 'Tous les usages' : CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
            {cat !== 'all' && <span className="caption muted">{CATEGORY_HINT[cat]}{cat === 'image' ? '. ' + IMAGE_NOTE : ''}</span>}
            <div className="discover-grid">
              {CATALOG.filter((d) => variantOf(d) === variant && (cat === 'all' || d.category === cat || d.alsoFor?.includes(cat))).map((d) => (
                <CatalogCard
                  key={d.name}
                  d={d}
                  fit={hw ? fitOf(d.sizeGB, hw) : null}
                  hw={hw}
                  kicker={CATEGORY_LABEL[d.category]}
                  installed={installedNames.has(d.name)}
                  pulling={!!pulls[d.name]}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {current && runtime.models.some((m) => m.name === current) && <SettingsPanel name={current} />}
    </div>
  )
}

/** Mémoire, GPU et processeur mesurés en direct (toutes les 2 s) : la part des modèles et celle du reste du système. */
function LiveUsageCard({ modelsBytes, vramBytes, loadedCount }: { modelsBytes: number; vramBytes: number; loadedCount: number }) {
  const u = useLiveUsage(2000)
  const models = GiB(modelsBytes)
  const onGpu = modelsBytes ? vramBytes / modelsBytes : 1
  if (!u)
    return (
      <div className="stat">
        <div className="stat-label"><Layers size={14} /><span className="overline">Mémoire · en direct</span></div>
        <div className="stat-value"><b>{formatBytes(modelsBytes)}</b><span className="caption muted">{loadedCount} modèle{loadedCount > 1 ? 's' : ''} en mémoire</span></div>
        <span className="caption muted">Mesure en direct indisponible (pont local arrêté).</span>
      </div>
    )
  const total = u.ramTotalGB
  const other = Math.max(0, u.ramUsedGB - models)
  const free = Math.max(0, total - u.ramUsedGB)
  return (
    <div className="stat">
      <div className="stat-label">
        <Layers size={14} />
        <span className="overline">Mémoire · en direct</span>
        <span className="spacer" />
        <StatusDot tone="success" pulse />
      </div>
      <div className="stat-value">
        <b>{fr(u.ramUsedGB, 1)} Go</b>
        <span className="caption muted">sur {fr(total, 0)} Go</span>
      </div>
      <StackMeter
        label={`Mémoire : ${fr(models, 1)} Go pour les modèles, ${fr(other, 1)} Go pour le reste, ${fr(free, 1)} Go libres`}
        parts={[
          { value: models / total, className: 'seg-models', title: `Modèles : ${fr(models, 1)} Go` },
          { value: other / total, className: 'seg-other', title: `Système et applications : ${fr(other, 1)} Go` },
        ]}
      />
      <span className="caption muted usage-legend">
        <span><i className="seg-models" />Modèles {fr(models, 1)} Go</span>
        <span><i className="seg-other" />Reste {fr(other, 1)} Go</span>
        <span>Libre {fr(free, 1)} Go</span>
      </span>
      <div className="usage-mini caption">
        {u.gpuPct != null && (
          <>
            <span className="muted">GPU</span>
            <Meter value={u.gpuPct / 100} tone="info" />
            <span className="mono-sm">{u.gpuPct} %</span>
          </>
        )}
        {u.gpuMemTotalGB != null && u.gpuMemUsedGB != null && (
          <>
            <span className="muted">VRAM</span>
            <Meter value={u.gpuMemUsedGB / u.gpuMemTotalGB} tone="violet" />
            <span className="mono-sm">{fr(u.gpuMemUsedGB, 1)}/{fr(u.gpuMemTotalGB, 0)}</span>
          </>
        )}
        <span className="muted">Processeur</span>
        <Meter value={u.cpuPct / 100} tone="success" />
        <span className="mono-sm">{u.cpuPct} %</span>
      </div>
      {modelsBytes > 0 && onGpu < 0.99 && (
        <span className="caption danger">{Math.round(onGpu * 100)} % du modèle sur le GPU : le reste tourne sur le processeur (plus lent).</span>
      )}
    </div>
  )
}

function expiry(r: RunningModel) {
  const ms = new Date(r.expires_at).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms > 365 * 86_400_000) return 'permanent'
  if (ms <= 0) return 'expire'
  return `${Math.max(1, Math.round(ms / 60_000))} min`
}

const IMAGE_NOTE =
  "Ollama ne génère plus d'images de type photo (fonction retirée en juillet 2026) : ces modèles dessinent en vectoriel, et le dessin s'affiche directement dans la conversation (téléchargeable en SVG ou PNG)."

function CatalogCard({ d, fit, hw, kicker, note, installed, pulling }: { d: CatalogModel; fit: Fit | null; hw: SystemInfo | null; kicker: string; note?: string; installed: boolean; pulling: boolean }) {
  return (
    <div className={`discover-card${fit === 'lourd' ? ' is-heavy' : ''}`}>
      <div className="row">
        <LetterTile name={d.name} size={34} />
        <div className="tcell-name">
          <span className="label">{d.name}</span>
          <span className="caption muted">
            {kicker} · ≈ {fr(d.sizeGB, 1)} Go
          </span>
        </div>
        <span className="spacer" />
        {fit && hw && (
          <span title={fitHint(fit, hw)}>
            <Tag tone={FIT_INFO[fit].tone}>{FIT_INFO[fit].label}</Tag>
          </span>
        )}
      </div>
      <span className="secondary">{note ? `${note} — ${d.desc.toLowerCase()}` : d.desc}</span>
      <div className="row tag-row">
        {d.tags.map((t) => (
          <Tag key={t.label} tone={t.tone}>
            {t.label}
          </Tag>
        ))}
        <span className="spacer" />
        {installed ? (
          <Tag tone="success">Installé</Tag>
        ) : (
          <Button small variant={fit === 'lourd' ? 'ghost' : 'secondary'} icon={pulling ? LoaderCircle : Download} disabled={pulling} onClick={() => void startPull(d.name)}>
            {pulling ? 'En cours' : 'Télécharger'}
          </Button>
        )}
      </div>
    </div>
  )
}

function ModelRow({ m, run, selected, onSelect, hw }: { m: ModelInfo; run?: RunningModel; selected: boolean; onSelect: () => void; hw: SystemInfo | null }) {
  const fit = hw ? fitOf(GiB(m.size), hw) : null
  const [busy, setBusy] = useState<'load' | 'unload' | 'delete' | null>(null)
  const [armed, trigger] = useArmed()
  const keepLoaded = useStore((s) => s.modelSettings[m.name]?.keepLoaded ?? false)
  const refresh = () => useStore.getState().refreshRuntime(true)
  const act = async (kind: 'load' | 'unload' | 'delete', fn: () => Promise<unknown>) => {
    setBusy(kind)
    try {
      await fn()
      await refresh()
    } catch (e) {
      toast((e as Error).message, 'danger')
    } finally {
      setBusy(null)
    }
  }
  const embedding = m.capabilities?.length === 1 && m.capabilities[0] === 'embedding'
  const gpu = run && run.size ? Math.round((run.size_vram / run.size) * 100) : 0

  return (
    <div className={`trow${selected ? ' is-selected' : ''}`} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
      <div className="tcell-model">
        <LetterTile name={m.name} size={34} />
        <div className="tcell-name">
          <span className="row">
            <span className="label ellipsis" title={m.name}>{prettyName(m.name)}</span>
            {m.details?.quantization_level && <span className="qbadge">{m.details.quantization_level}</span>}
          </span>
          <span className="caption muted ellipsis">{modelSubtitle(m)}</span>
        </div>
      </div>
      <span className="fit-size" title={fit && hw ? `${FIT_INFO[fit].label} — ${fitHint(fit, hw)}` : undefined}>
        {fit && <i className={`fit-dot tone-${FIT_INFO[fit].tone}`} />}
        <span className="mono-sm secondary">{formatBytes(m.size)}</span>
      </span>
      <div className="tcell-tags col-caps">
        {capabilityTags(m).slice(0, 3).map((t) => <Tag key={t.label} tone={t.tone}>{t.label}</Tag>)}
      </div>
      <div className="tcell-status" onClick={(e) => e.stopPropagation()}>
        {run ? (
          <>
            <StatusDot tone="success" />
            <span className="label-sm success" title={`Expire : ${expiry(run)}`}>Chargé · {gpu} % GPU</span>
            <span className="spacer" />
            <IconButton icon={busy === 'unload' ? LoaderCircle : Square} label="Décharger de la mémoire" disabled={!!busy} onClick={() => void act('unload', () => ollama.unload(m.name))} />
          </>
        ) : (
          <>
            <span className="label-sm muted">{embedding ? 'Embeddings' : 'Inactif'}</span>
            <span className="spacer" />
            {!embedding && (
              <Button small variant="secondary" icon={busy === 'load' ? LoaderCircle : Play} disabled={!!busy} onClick={() => void act('load', () => ollama.load(m.name, keepLoaded ? -1 : '30m'))}>
                {busy === 'load' ? 'Chargement' : 'Charger'}
              </Button>
            )}
          </>
        )}
        <IconButton
          icon={Trash}
          label={armed ? 'Cliquer à nouveau pour supprimer du disque' : 'Supprimer'}
          className={armed ? 'is-danger' : ''}
          disabled={!!busy}
          onClick={() => {
            if (trigger()) void act('delete', () => ollama.remove(m.name)).then(() => toast(`${prettyName(m.name)} supprimé`, 'success'))
          }}
        />
      </div>
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format: (v: number) => string }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <label className="slider-field">
      <span className="row">
        <span className="label-sm secondary">{label}</span>
        <span className="spacer" />
        <span className="mono-sm">{format(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ '--pct': `${pct}%` } as CSSProperties} />
    </label>
  )
}

function Toggle({ label, desc, on, onChange }: { label: string; desc: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="toggle-row" onClick={() => onChange(!on)} aria-pressed={on}>
      <span className="toggle-text">
        <span className="label-sm">{label}</span>
        <span className="caption muted">{desc}</span>
      </span>
      <span className={`switch${on ? ' is-on' : ''}`}>
        <i />
      </span>
    </button>
  )
}

const CTX = [2048, 4096, 8192, 16384, 32768, 65536, 131072]

// ---------- Mode simple : des niveaux plutôt que des curseurs ----------
type Level<T extends string> = { id: T; label: string; hint: string; icon?: LucideIcon; sub?: string }

const STYLES = [
  { id: 'precis', label: 'Précis', icon: Target, hint: 'Réponses factuelles et constantes. Idéal pour le code et les calculs.', v: { temperature: 0.2, top_p: 0.85, repeat_penalty: 1.05 } },
  { id: 'equilibre', label: 'Équilibré', icon: Scale, hint: 'Le bon compromis pour la plupart des conversations.', v: { temperature: 0.7, top_p: 0.9, repeat_penalty: 1.1 } },
  { id: 'creatif', label: 'Créatif', icon: Sparkles, hint: 'Plus de variété et d’idées. Pour écrire, imaginer, reformuler.', v: { temperature: 1.1, top_p: 0.95, repeat_penalty: 1.1 } },
] as const

const MEMORY = [
  { id: 'courte', label: 'Courte', ctx: 4096, hint: '≈ 6 pages de texte. Le plus léger pour la mémoire vidéo.' },
  { id: 'normale', label: 'Normale', ctx: 8192, hint: '≈ 12 pages. Suffisant pour une conversation classique.' },
  { id: 'longue', label: 'Longue', ctx: 32768, hint: '≈ 50 pages. Pour de longs fichiers ou projets. Utilise plus de VRAM.' },
  { id: 'max', label: 'Maximale', ctx: 131072, hint: '≈ 200 pages. Très gourmand en mémoire vidéo.' },
] as const

const THINK_LEVELS: Level<'off' | 'auto' | 'on'>[] = [
  { id: 'off', label: 'Rapide', icon: Zap, hint: 'Répond tout de suite, sans réfléchir avant.' },
  { id: 'auto', label: 'Auto', icon: Lightbulb, hint: 'Réfléchit seulement quand la demande est complexe (code, images, « pourquoi »…).' },
  { id: 'on', label: 'Approfondie', icon: Brain, hint: 'Réfléchit avant chaque réponse. Plus juste, mais plus lent.' },
]

const near = (a: number, b: number) => Math.abs(a - b) < 0.011

function LevelPicker<T extends string>({ levels, value, onChange }: { levels: readonly Level<T>[]; value: T | null; onChange: (id: T) => void }) {
  const current = levels.find((l) => l.id === value)
  return (
    <div className="level-field">
      <div className="levels" style={{ '--n': levels.length } as CSSProperties}>
        {levels.map((l) => (
          <button type="button" key={l.id} className={`level${l.id === value ? ' is-on' : ''}`} onClick={() => onChange(l.id)} aria-pressed={l.id === value}>
            {l.icon && <l.icon size={17} strokeWidth={1.6} />}
            <span>{l.label}</span>
            {l.sub && <small>{l.sub}</small>}
          </button>
        ))}
      </div>
      <span className="caption muted level-hint">{current ? current.hint : 'Personnalisé — réglé dans le mode avancé.'}</span>
    </div>
  )
}

const MODE_KEY = 'lumen.settingsMode'
function readMode(): 'simple' | 'advanced' {
  try {
    return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple'
  } catch {
    return 'simple'
  }
}

function SettingsPanel({ name }: { name: string }) {
  const info = useStore((s) => s.runtime.models.find((m) => m.name === name))
  const custom = useStore((s) => s.modelSettings[name])
  const lowMemory = useStore((s) => s.lowMemory)
  const st = custom ?? (lowMemory ? { ...DEFAULT_SETTINGS, num_ctx: 4096 } : DEFAULT_SETTINGS)
  const { updateSettings, resetSettings, setModel, newChat } = useStore.getState()
  const overrides = useStore((s) => s.modelStrengths)
  const setModelStrengths = useStore((s) => s.setModelStrengths)
  const strengths = info ? strengthsOf(info, overrides) : []
  const [mode, setModeState] = useState<'simple' | 'advanced'>(readMode)
  const setMode = (m: 'simple' | 'advanced') => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* stockage indisponible : le choix vaut pour cette session */
    }
  }
  const set = (p: Partial<typeof st>) => updateSettings(name, p)
  const maxCtx = info?.details?.context_length ?? 131072
  const options = CTX.filter((n) => n <= maxCtx)
  const f2 = (v: number) => fr(v, 2)

  const style = STYLES.find((s) => near(s.v.temperature, st.temperature) && near(s.v.top_p, st.top_p) && near(s.v.repeat_penalty, st.repeat_penalty))
  const memLevels: Level<string>[] = MEMORY.filter((m, i) => m.ctx <= maxCtx || i === 0).map((m) => ({
    id: m.id,
    label: m.label,
    sub: formatCtx(Math.min(m.ctx, maxCtx)),
    hint: m.hint,
  }))
  const memory = MEMORY.find((m) => Math.min(m.ctx, maxCtx) === st.num_ctx)

  return (
    <aside className="panel settings-panel">
      <div className="set-head">
        <div className="tcell-name">
          <span className="overline">Paramètres</span>
          <span className="h2 ellipsis" title={name}>{prettyName(name)}</span>
          <span className="mono-sm muted ellipsis">{name}</span>
        </div>
        <div className="segmented seg-text mode-switch" role="tablist" aria-label="Niveau de détail des réglages">
          <button type="button" className={mode === 'simple' ? 'is-on' : ''} onClick={() => setMode('simple')} aria-selected={mode === 'simple'}>
            Simple
          </button>
          <button type="button" className={mode === 'advanced' ? 'is-on' : ''} onClick={() => setMode('advanced')} aria-selected={mode === 'advanced'}>
            Avancé
          </button>
        </div>
      </div>

      {info && (
        <section className="set-section">
          <span className="row">
            <span className="label">Points forts</span>
            <span className="spacer" />
            {overrides[name] && (
              <button type="button" className="link-btn" onClick={() => setModelStrengths(name, null)} title="Revenir aux points forts détectés automatiquement">
                Auto
              </button>
            )}
          </span>
          <div className="str-chips">
            {STRENGTH_LIST.map((x) => {
              const on = strengths.includes(x.id)
              return (
                <button
                  type="button"
                  key={x.id}
                  className={`str-chip${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => setModelStrengths(name, on ? strengths.filter((y) => y !== x.id) : [...strengths, x.id])}
                >
                  {on && <Check size={12} strokeWidth={2} />}
                  {x.label}
                </button>
              )
            })}
          </div>
          <span className="caption muted">
            {overrides[name] ? 'Personnalisés' : 'Détectés automatiquement'} — servent à vous suggérer le modèle le plus doué.
          </span>
        </section>
      )}

      {mode === 'simple' ? (
        <>
          <section className="set-section">
            <span className="label">Style des réponses</span>
            <LevelPicker levels={STYLES} value={style?.id ?? null} onChange={(id) => set({ ...STYLES.find((s) => s.id === id)!.v })} />
          </section>

          <section className="set-section">
            <span className="label">Mémoire de la conversation</span>
            <LevelPicker
              levels={memLevels}
              value={memory?.id ?? null}
              onChange={(id) => set({ num_ctx: Math.min(MEMORY.find((m) => m.id === id)!.ctx, maxCtx) })}
            />
          </section>

          {supportsThinking(info) && (
            <section className="set-section">
              <span className="label">Réflexion</span>
              <LevelPicker levels={THINK_LEVELS} value={thinkModeOf(st.think)} onChange={(id) => set({ think: id })} />
            </section>
          )}

          <section className="set-section">
            <Toggle label="Toujours prêt" desc="Garde le modèle chargé : réponses immédiates, mais la VRAM reste occupée." on={st.keepLoaded} onChange={(v) => set({ keepLoaded: v })} />
          </section>

          <section className="set-section">
            <span className="label">Consignes</span>
            <textarea
              className="textarea"
              value={st.system}
              placeholder="Ex. : Réponds en français, de façon concise, avec du code commenté."
              onChange={(e) => set({ system: e.target.value })}
            />
          </section>
        </>
      ) : (
        <>
      <section className="set-section">
        <span className="label">Génération</span>
        <Slider label="Température" value={st.temperature} min={0} max={2} step={0.05} onChange={(v) => set({ temperature: v })} format={f2} />
        <Slider label="Top-p" value={st.top_p} min={0} max={1} step={0.01} onChange={(v) => set({ top_p: v })} format={f2} />
        <Slider label="Pénalité de répétition" value={st.repeat_penalty} min={0.8} max={2} step={0.01} onChange={(v) => set({ repeat_penalty: v })} format={f2} />
      </section>

      <section className="set-section">
        <span className="label">Contexte & mémoire</span>
        <div className="slider-field">
          <span className="row">
            <span className="label-sm secondary">Longueur de contexte</span>
            <span className="spacer" />
            <span className="caption muted">max {formatCtx(maxCtx)}</span>
          </span>
          <div className="segmented seg-full">
            {options.map((n) => (
              <button type="button" key={n} className={st.num_ctx === n ? 'is-on' : ''} onClick={() => set({ num_ctx: n })}>
                {formatCtx(n)}
              </button>
            ))}
          </div>
          <span className="caption muted">Plus de contexte = plus de VRAM utilisée.</span>
        </div>
        {supportsThinking(info) && (
          <div className="slider-field">
            <span className="row">
              <span className="label-sm secondary">Réflexion</span>
            </span>
            <div className="segmented seg-full seg-text">
              {(['auto', 'on', 'off'] as const).map((m) => (
                <button type="button" key={m} className={thinkModeOf(st.think) === m ? 'is-on' : ''} onClick={() => set({ think: m })}>
                  {m === 'auto' ? 'Auto' : m === 'on' ? 'Toujours' : 'Jamais'}
                </button>
              ))}
            </div>
            <span className="caption muted">Auto : réfléchit seulement pour les questions complexes, le code et les images.</span>
          </div>
        )}
        <Toggle label="Garder en mémoire" desc="Ne jamais décharger ce modèle de la VRAM" on={st.keepLoaded} onChange={(v) => set({ keepLoaded: v })} />
      </section>

      <section className="set-section">
        <span className="label">Prompt système</span>
        <textarea
          className="textarea"
          value={st.system}
          placeholder="Ex. : Tu es un assistant de code senior. Réponds en français, avec du code typé et testé."
          onChange={(e) => set({ system: e.target.value })}
        />
      </section>
        </>
      )}

      <div className="set-foot">
        <Button variant="ghost" icon={RefreshCw} onClick={() => resetSettings(name)}>
          Réinitialiser
        </Button>
        <span className="spacer" />
        <Button
          variant="primary"
          icon={MessageSquare}
          onClick={() => {
            setModel(name)
            newChat()
          }}
        >
          Discuter
        </Button>
      </div>
    </aside>
  )
}
