// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Cpu, Download, Play, RefreshCw, TriangleExclamationPoint } from 'lucide-react'
import { useStore } from '../store'
import {
  CATEGORY_HINT, CATEGORY_LABEL, describeMachine, FIT_INFO, fitHint, fluidLimit, recommend, useHardware, VARIANT_LABEL, variantOf, type Variant,
} from '../lib/hardware'
import { startPull } from '../lib/pull'
import { fr } from '../lib/format'
import { Button, LetterTile, Logo, Meter, Tag, useCopy } from './ui'
import { installOllama, ollamaStatus, startOllama, type OllamaStatus } from '../lib/setup'

/**
 * Ollama absent ou arrêté : Lumen l'installe (téléchargement officiel, adapté au système) ou le démarre lui-même.
 * Sous Linux sans « zstd », il donne la commande officielle à coller dans un terminal.
 */
function OllamaSetup({ onReady }: { onReady: () => void }) {
  const [st, setSt] = useState<OllamaStatus | null>(null)
  const [busy, setBusy] = useState<{ label: string; pct: number | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [command, setCommand] = useState<string | null>(null)
  const [copied, copy] = useCopy()
  useEffect(() => {
    ollamaStatus().then(setSt, () => setSt(null))
  }, [])

  const install = async () => {
    setError(null)
    setBusy({ label: 'Téléchargement d’Ollama', pct: 0 })
    try {
      const last = await installOllama((e) => {
        if (e.status === 'download') setBusy({ label: 'Téléchargement d’Ollama', pct: e.total ? e.loaded! / e.total : null })
        else if (e.status === 'install') setBusy({ label: 'Installation…', pct: null })
        else if (e.status === 'start') setBusy({ label: 'Démarrage…', pct: null })
      })
      if (last.error) {
        setError(last.error)
        if (last.command) setCommand(last.command)
      } else onReady()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      ollamaStatus().then(setSt, () => {})
    }
  }

  const start = async () => {
    setError(null)
    setBusy({ label: 'Démarrage d’Ollama…', pct: null })
    const ok = await startOllama().catch(() => false)
    setBusy(null)
    if (ok) onReady()
    else setError('Ollama ne démarre pas : ouvrez-le depuis vos applications.')
  }

  const installed = st?.installed
  const manual = command ?? (st && !st.installed && !st.canInstall ? st.command : null)
  return (
    <div className="ob-warn">
      <TriangleExclamationPoint size={16} />
      <div className="tcell-name">
        <span className="label">{installed ? 'Ollama est installé mais arrêté' : 'Ollama n’est pas encore installé'}</span>
        <span className="caption">
          {installed
            ? 'Lumen a besoin d’Ollama pour faire tourner les modèles d’IA.'
            : 'Lumen utilise Ollama (gratuit, officiel) pour faire tourner les modèles d’IA. Il peut l’installer pour vous, selon votre système.'}
        </span>
        {busy && (
          <span className="ob-progress">
            <Meter value={busy.pct ?? 0} />
            <span className="mono-sm muted">{busy.pct != null ? `${busy.label} · ${Math.floor(busy.pct * 100)} %` : busy.label}</span>
          </span>
        )}
        {error && <span className="caption danger">{error}</span>}
        {manual && (
          <span className="ob-cmd">
            <code className="inline-code">{manual}</code>
            <Button small variant="ghost" icon={copied ? Check : Copy} onClick={() => void copy(manual)}>
              {copied ? 'Copié' : 'Copier'}
            </Button>
          </span>
        )}
      </div>
      <span className="spacer" />
      {!busy &&
        (installed ? (
          <Button small variant="primary" icon={Play} onClick={() => void start()}>
            Démarrer Ollama
          </Button>
        ) : st?.canInstall !== false ? (
          <Button small variant="primary" icon={Download} onClick={() => void install()}>
            Installer Ollama
          </Button>
        ) : null)}
      {!busy && (
        <Button small icon={RefreshCw} onClick={onReady}>
          Réessayer
        </Button>
      )}
    </div>
  )
}

/** Accueil du premier lancement : détecte la machine et propose un pack de modèles qui y tournent bien. */
export function Onboarding() {
  const runtime = useStore((s) => s.runtime)
  const pulls = useStore((s) => s.pulls)
  const variant = useStore((s) => s.modelVariant)
  const { setOnboarding, setModel, refreshRuntime, setModelVariant } = useStore.getState()
  const hw = useHardware()
  const recos = useMemo(() => (hw ? recommend(hw, variant) : []), [hw, variant])
  const installed = new Set(runtime.models.map((m) => m.name))

  // Par défaut : 3 modèles différents qui tournent (généraliste, bureautique, code — sinon les suivants).
  // Recalculé quand on passe de Standard à Non censuré.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const initialized = useRef<Variant | null>(null)
  useEffect(() => {
    if (initialized.current === variant || !recos.length) return
    initialized.current = variant
    const order = ['general', 'office', 'code', 'reasoning', 'vision', 'image']
    const pick = [...recos]
      .filter((r) => r.fit !== 'lourd')
      .sort((a, b) => Number(b.fit === 'fluide') - Number(a.fit === 'fluide') || order.indexOf(a.category) - order.indexOf(b.category))
      .slice(0, 3)
    setSelected(new Set(pick.map((r) => r.model.name)))
  }, [recos])

  const [installing, setInstalling] = useState(false)
  const picked = recos.filter((r) => selected.has(r.model.name))
  const toDownload = picked.filter((r) => !installed.has(r.model.name))
  const totalGB = toDownload.reduce((n, r) => n + r.model.sizeGB, 0)
  const diskOk = hw?.diskFreeGB == null || totalGB <= hw.diskFreeGB - 5
  const done = picked.length > 0 && toDownload.length === 0

  const toggle = (name: string) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const install = async () => {
    setInstalling(true)
    for (const r of toDownload) await startPull(r.model.name)
    setInstalling(false)
  }

  const finish = () => {
    const ready = (name: string) => useStore.getState().runtime.models.some((m) => m.name === name)
    const main = picked.find((r) => r.category === 'general' && ready(r.model.name)) ?? picked.find((r) => ready(r.model.name))
    if (main) setModel(main.model.name)
    setOnboarding(false)
  }

  const limit = hw ? fluidLimit(hw) : null

  return (
    <div className="overlay">
      <div className="dialog onboarding" role="dialog" aria-label="Bienvenue dans Lumen">
        <div className="ob-hero">
          <Logo size={44} glow />
          <h1 className="display ob-title">
            Bienvenue dans <em>Lumen</em>
          </h1>
          <p className="lead ob-lead">Je regarde votre machine pour vous proposer des modèles qui y tournent bien.</p>
        </div>

        {runtime.connected === false && <OllamaSetup onReady={() => void refreshRuntime(true)} />}

        <div className="machine">
          <span className="machine-icon">
            <Cpu size={18} strokeWidth={1.6} />
          </span>
          <div className="tcell-name">
            <span className="label">{hw ? describeMachine(hw) : 'Analyse de la machine…'}</span>
            {hw && limit && (
              <span className="caption muted">
                Modèles fluides jusqu'à ≈ {fr(limit.sizeGB, 0)} Go (environ {Math.round(limit.paramsB)} milliards de paramètres)
                {hw.diskFreeGB != null ? ` · ${fr(hw.diskFreeGB, 0)} Go libres` : ''}
              </span>
            )}
          </div>
        </div>

        {hw && (
          <section className="ob-pack">
            <div className="row ob-pack-head">
              <span className="overline">Pack conseillé pour votre PC</span>
              <span className="spacer" />
              <div className="segmented seg-text" role="radiogroup" aria-label="Version des modèles">
                {(['standard', 'uncensored'] as Variant[]).map((v) => (
                  <button
                    type="button"
                    key={v}
                    role="radio"
                    aria-checked={variant === v}
                    className={variant === v ? 'is-on' : ''}
                    disabled={installing}
                    onClick={() => setModelVariant(v)}
                  >
                    {VARIANT_LABEL[v]}
                  </button>
                ))}
              </div>
            </div>
            {variant === 'uncensored' && (
              <span className="caption muted">
                Versions modifiées (« abliterated », Dolphin) qui refusent beaucoup moins de demandes. Vous restez responsable de leur usage.
                Quand aucune ne tient sur votre PC, la version standard est proposée.
              </span>
            )}
            {recos.map(({ category, model, fit, primary }) => {
              const isIn = installed.has(model.name)
              const pull = pulls[model.name]
              const on = selected.has(model.name)
              const pct = pull?.total ? (pull.completed ?? 0) / pull.total : 0
              return (
                <button
                  type="button"
                  key={category}
                  className={`ob-row${on ? ' is-on' : ''}`}
                  onClick={() => !installing && !isIn && toggle(model.name)}
                  aria-pressed={on}
                  disabled={isIn}
                >
                  <span className={`ob-check${on || isIn ? ' is-on' : ''}`}>{(on || isIn) && <Check size={12} strokeWidth={2.4} />}</span>
                  <LetterTile name={model.name} size={32} />
                  <span className="tcell-name">
                    <span className="label">
                      {CATEGORY_LABEL[category]} · {model.name}
                      {variant === 'uncensored' && variantOf(model) === 'standard' && <span className="muted"> (standard)</span>}
                    </span>
                    {pull ? (
                      <span className="ob-progress">
                        <Meter value={pct} />
                        <span className="mono-sm muted">{pull.error ? pull.error : pull.total ? `${Math.floor(pct * 100)} %` : pull.status}</span>
                      </span>
                    ) : (
                      <span className="caption muted">{primary ? model.desc : `${CATEGORY_HINT[category]} — ${model.desc.toLowerCase()}`}</span>
                    )}
                  </span>
                  <span className="mono-sm secondary">≈ {fr(model.sizeGB, 1)} Go</span>
                  {isIn ? (
                    <Tag tone="success">Installé</Tag>
                  ) : (
                    <span title={fitHint(fit, hw)}>
                      <Tag tone={FIT_INFO[fit].tone}>{FIT_INFO[fit].label}</Tag>
                    </span>
                  )}
                </button>
              )
            })}
          </section>
        )}

        <div className="ob-foot">
          <span className={`caption ${diskOk ? 'muted' : 'danger'}`}>
            {toDownload.length
              ? `À télécharger : ≈ ${fr(totalGB, 1)} Go${diskOk ? '' : ' — pas assez d’espace disque'}. Vous pourrez utiliser Lumen pendant le téléchargement.`
              : done
                ? 'Tout est prêt.'
                : 'Choisissez au moins un modèle, ou continuez avec ceux déjà installés.'}
          </span>
          <span className="spacer" />
          <Button variant="ghost" onClick={() => setOnboarding(false)}>
            {installing ? 'Continuer en arrière-plan' : 'Plus tard'}
          </Button>
          {done || (!toDownload.length && runtime.models.length) ? (
            <Button variant="primary" icon={Check} onClick={finish}>
              Commencer
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={Download}
              disabled={installing || !toDownload.length || !diskOk || runtime.connected === false}
              onClick={() => void install()}
            >
              {installing ? 'Installation…' : `Installer la sélection (${toDownload.length})`}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
