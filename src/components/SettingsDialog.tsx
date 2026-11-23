// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect, useRef, useState } from 'react'
import { Check, Download, ExternalLink, FolderOpen, Globe, LoaderCircle, MapPin, Play, Plug, RefreshCw, Sparkles, Stethoscope, Trash, X } from 'lucide-react'
import { toast, useStore } from '../store'
import { downloadText } from '../lib/files'
import { agentInfo } from '../lib/agent'
import { ollamaAccount, type OllamaAccount } from '../lib/web'
import { useHardware } from '../lib/hardware'
import { defaultStt, defaultVoice, hasWebGPU, STT, VOICES, voiceInfo, type SttModel } from '../voice/catalog'
import { prepareVoice, previewVoice } from '../voice/conversation'
import { useVoice } from '../voice/state'
import { runDoctor } from '../lib/setup'
import { AUTHOR, COPYRIGHT, REPO_URL } from '../lib/authorship'
import { Button, IconButton, Logo, useArmed, useClickOutside } from './ui'
import { LabSettings } from './LabSettings'

export function SettingsDialog() {
  const baseUrl = useStore((s) => s.baseUrl)
  const count = useStore((s) => s.order.length)
  const runtime = useStore((s) => s.runtime)
  const suggestOn = useStore((s) => s.suggestModels)
  const handoff = useStore((s) => s.handoffMode)
  const { setSettingsOpen, setBaseUrl, clearAll, setAgentCwd, setSuggestModels, setHandoffMode } = useStore.getState()
  const [url, setUrl] = useState(baseUrl)
  const [cwd, setCwd] = useState(useStore.getState().agentCwd)
  const [home, setHome] = useState('')
  useEffect(() => {
    agentInfo().then((i) => setHome(i.home), () => setHome(''))
  }, [])
  const webOn = useStore((s) => s.webSearch)
  const [city, setCity] = useState(useStore.getState().userCity)
  const [account, setAccount] = useState<OllamaAccount | null | undefined>(undefined)
  const checkAccount = () => {
    setAccount(undefined)
    void ollamaAccount().then(setAccount)
  }
  useEffect(() => {
    if (webOn) checkAccount()
  }, [webOn])
  const autoTools = useStore((s) => s.autoTools)
  const vp = useStore((s) => s.voice)
  const hw = useHardware()
  const [gpu, setGpu] = useState(false)
  useEffect(() => {
    void hasWebGPU().then(setGpu)
  }, [])
  const voiceId = voiceInfo(vp.voice ?? defaultVoice(hw)).id
  const sttId = vp.stt === 'turbo' && !gpu ? 'small' : (vp.stt ?? defaultStt(hw, gpu))
  const progress = useVoice((s) => s.progress)
  const [voiceBusy, setVoiceBusy] = useState<'prepare' | 'preview' | null>(null)
  const [voiceReady, setVoiceReady] = useState(false)
  const runVoice = async (kind: 'prepare' | 'preview', fn: () => Promise<void>) => {
    setVoiceBusy(kind)
    try {
      await fn()
      if (kind === 'prepare') setVoiceReady(true)
    } catch (e) {
      toast(`Voix : ${(e as Error).message}`, 'danger')
    } finally {
      setVoiceBusy(null)
    }
  }
  const [doctor, setDoctor] = useState<string | null>(null)
  const check = async () => {
    setDoctor('running')
    try {
      setDoctor((await runDoctor()).output)
    } catch (e) {
      setDoctor(`Diagnostic impossible : ${(e as Error).message}`)
    }
  }
  const [armed, trigger] = useArmed()
  const ref = useRef<HTMLDivElement>(null)
  const close = () => setSettingsOpen(false)
  useClickOutside(ref, close)

  const exportAll = () => {
    const { conversations, order } = useStore.getState()
    const data = order.map((id) => conversations[id]).filter(Boolean)
    downloadText(JSON.stringify(data, null, 2), `lumen-conversations-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')
  }

  return (
    <div className="overlay">
      <div ref={ref} className="dialog" role="dialog" aria-label="Réglages">
        <div className="dialog-head">
          <h2 className="h2">Réglages</h2>
          <span className="spacer" />
          <IconButton icon={X} label="Fermer" onClick={close} />
        </div>

        <section className="dialog-section">
          <label className="label" htmlFor="ollama-url">
            Adresse d'Ollama
          </label>
          <p className="caption muted">
            « /ollama » passe par le proxy du serveur Vite vers 127.0.0.1:11434. Vous pouvez aussi indiquer une adresse directe, par
            exemple http://localhost:11434.
          </p>
          <div className="field-row">
            <input id="ollama-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Button
              variant="primary"
              icon={Plug}
              onClick={() => {
                setBaseUrl(url)
                toast('Adresse enregistrée', 'success')
              }}
            >
              Connecter
            </Button>
          </div>
          <p className={`caption ${runtime.connected ? 'success' : runtime.connected === false ? 'danger' : 'muted'}`}>
            {runtime.connected
              ? `Connecté · Ollama ${runtime.version} · ${runtime.models.length} modèles`
              : runtime.connected === false
                ? runtime.error
                : 'Connexion…'}
          </p>
        </section>

        <section className="dialog-section">
          <label className="label" htmlFor="agent-cwd">
            Dossier de travail de l'agent
          </label>
          <p className="caption muted">
            En mode Agent, les commandes s'exécutent ici. Lire et lister dans ce dossier se fait sans demander ; toute autre action
            (commande, écriture, ouverture d'app, AppleScript, capture d'écran) attend votre accord.
          </p>
          <div className="field-row">
            <input
              id="agent-cwd"
              className="input mono"
              value={cwd}
              placeholder={home || '~'}
              onChange={(e) => setCwd(e.target.value)}
            />
            <Button
              icon={FolderOpen}
              onClick={() => {
                setAgentCwd(cwd)
                toast('Dossier de travail enregistré', 'success')
              }}
            >
              Enregistrer
            </Button>
          </div>
        </section>

        <section className="dialog-section">
          <span className="label">Recherche Internet</span>
          <button type="button" className="toggle-row" onClick={() => useStore.getState().setWebSearch(!webOn)} aria-pressed={webOn}>
            <span className="toggle-text">
              <span className="label-sm">Autoriser les modèles à chercher sur Internet</span>
              <span className="caption muted">
                Météo, actualité, informations récentes : le modèle lance lui-même la recherche et cite ses sources. Les modèles
                restent sur votre machine ; seules les recherches partent sur Internet. Aussi activable avec le bouton « Web ».
              </span>
            </span>
            <span className={`switch${webOn ? ' is-on' : ''}`}>
              <i />
            </span>
          </button>
          {webOn && (
            <>
              <div className="field-row">
                <input
                  className="input"
                  value={city}
                  placeholder="Votre ville, pour la météo (ex. Mulhouse)"
                  aria-label="Votre ville"
                  onChange={(e) => setCity(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (useStore.getState().setUserCity(city), toast('Ville enregistrée', 'success'))}
                />
                <Button
                  icon={MapPin}
                  onClick={() => {
                    useStore.getState().setUserCity(city)
                    toast('Ville enregistrée', 'success')
                  }}
                >
                  Enregistrer
                </Button>
              </div>
              <div className="web-account">
                <Globe size={15} className={account?.signedIn ? 'success' : 'muted'} />
                <span className="toggle-text">
                  {account === undefined ? (
                    <span className="caption muted">Vérification du compte Ollama…</span>
                  ) : account?.signedIn ? (
                    <>
                      <span className="label-sm">Recherche web complète active</span>
                      <span className="caption muted">Ollama est relié au compte {account.name ?? 'ollama.com'} (recherche gratuite d'Ollama).</span>
                    </>
                  ) : account ? (
                    <>
                      <span className="label-sm">Météo prête · recherche limitée à Wikipédia</span>
                      <span className="caption muted">
                        Pour chercher sur tout le web, reliez Ollama à un compte gratuit ollama.com (une seule fois), puis cliquez sur
                        « Vérifier ». Commande équivalente : « ollama signin ».
                      </span>
                    </>
                  ) : (
                    <span className="caption muted">Ollama injoignable ou trop ancien : météo et Wikipédia seulement.</span>
                  )}
                </span>
                {account && !account.signedIn && account.signinUrl && (
                  <Button small variant="primary" icon={ExternalLink} onClick={() => window.open(account.signinUrl, '_blank', 'noopener,noreferrer')}>
                    Relier Ollama
                  </Button>
                )}
                <Button small variant="ghost" icon={RefreshCw} onClick={checkAccount}>
                  Vérifier
                </Button>
              </div>
            </>
          )}
        </section>

        <LabSettings />

        <section className="dialog-section">
          <span className="label">Voix (conversation façon Jarvis)</span>
          <p className="caption muted">
            Bouton <b>onde sonore</b> à côté d'Envoyer : vous parlez, Lumen répond à voix haute, puis réécoute. Tout tourne sur votre
            machine (reconnaissance Whisper, voix naturelles Supertonic ou légères Piper), sans ralentir le modèle. Les voix sont les mêmes
            sur tous les ordinateurs ; les plus légères sont choisies d'office sur les petits PC.
          </p>
          <div className="voice-pick">
            {VOICES.map((v) => (
              <button
                type="button"
                key={v.id}
                className={`voice-opt${voiceId === v.id ? ' is-on' : ''}`}
                onClick={() => useStore.getState().setVoicePrefs({ voice: v.id })}
                aria-pressed={voiceId === v.id}
              >
                <span className="label-sm">{v.label}</span>
                <span className="caption muted">
                  {v.desc} · {v.engine === 'supertonic' ? 'modèle commun ' : ''}
                  {v.sizeMB} Mo
                </span>
              </button>
            ))}
          </div>
          <div className="field-row">
            <span className="label-sm">Débit</span>
            <div className="segmented seg-text">
              {([['Posé', 0.9], ['Normal', 1], ['Rapide', 1.15]] as const).map(([label, rate]) => (
                <button type="button" key={label} className={vp.rate === rate ? 'is-on' : ''} onClick={() => useStore.getState().setVoicePrefs({ rate })}>
                  {label}
                </button>
              ))}
            </div>
            <span className="spacer" />
            <Button
              small
              icon={voiceBusy === 'preview' ? LoaderCircle : Play}
              disabled={!!voiceBusy}
              onClick={() => void runVoice('preview', () => previewVoice(voiceId, vp.rate))}
            >
              Écouter
            </Button>
          </div>
          <div className="field-row">
            <span className="label-sm">Compréhension</span>
            <div className="segmented seg-text">
              {(Object.keys(STT) as SttModel[]).map((k) => (
                <button
                  type="button"
                  key={k}
                  disabled={!!STT[k].gpu && !gpu}
                  title={STT[k].gpu && !gpu ? 'Demande une carte graphique accessible au navigateur (WebGPU)' : `${STT[k].desc} · ${STT[k].sizeMB} Mo`}
                  className={sttId === k ? 'is-on' : ''}
                  onClick={() => useStore.getState().setVoicePrefs({ stt: k })}
                >
                  {STT[k].label}
                </button>
              ))}
            </div>
            <span className="caption muted">{STT[sttId].desc}</span>
          </div>
          <div className="field-row">
            <span className="caption muted">
              {voiceBusy === 'prepare' && progress?.total
                ? `Téléchargement ${progress.what === 'stt' ? 'de la reconnaissance' : 'de la voix'} · ${Math.floor((progress.loaded / progress.total) * 100)} %`
                : voiceReady
                  ? 'Voix prête : elle fonctionne maintenant hors ligne.'
                  : `À télécharger une seule fois : ≈ ${(VOICES.find((v) => v.id === voiceId)?.sizeMB ?? 0) + STT[sttId].sizeMB} Mo (gardés dans le navigateur).`}
            </span>
            <span className="spacer" />
            <Button small icon={voiceBusy === 'prepare' ? LoaderCircle : voiceReady ? Check : Download} disabled={!!voiceBusy} onClick={() => void runVoice('prepare', prepareVoice)}>
              {voiceReady ? 'Prête' : 'Préparer la voix'}
            </Button>
          </div>
        </section>

        <section className="dialog-section">
          <span className="label">Modèles</span>
          <button type="button" className="toggle-row" onClick={() => useStore.getState().setAutoTools(!autoTools)} aria-pressed={autoTools}>
            <span className="toggle-text">
              <span className="label-sm">Activer tout seul Agent et Web selon la demande</span>
              <span className="caption muted">
                « Ouvre Discord » active le mode Agent, « cherche… » ou « quelle météo… » la recherche web (au clavier comme à la voix).
                Les actions sur l'ordinateur demandent toujours votre accord.
              </span>
            </span>
            <span className={`switch${autoTools ? ' is-on' : ''}`}>
              <i />
            </span>
          </button>
          <button type="button" className="toggle-row" onClick={() => setSuggestModels(!suggestOn)} aria-pressed={suggestOn}>
            <span className="toggle-text">
              <span className="label-sm">Suggérer le modèle le plus doué</span>
              <span className="caption muted">Une petite bulle propose un autre modèle quand il est plus fort pour votre demande (frontend, code…).</span>
            </span>
            <span className={`switch${suggestOn ? ' is-on' : ''}`}>
              <i />
            </span>
          </button>
          <span className="label-sm" style={{ marginTop: 6 }}>
            Quand on change de modèle dans une conversation
          </span>
          <div className="segmented seg-full seg-text">
            <button type="button" className={handoff === 'full' ? 'is-on' : ''} onClick={() => setHandoffMode('full')}>
              Relire tout l'historique
            </button>
            <button type="button" className={handoff === 'summary' ? 'is-on' : ''} onClick={() => setHandoffMode('summary')}>
              Lui donner un résumé
            </button>
          </div>
          <p className="caption muted">
            Dans les deux cas, si la conversation dépasse la mémoire du modèle, elle est résumée automatiquement.
          </p>
          <div className="field-row">
            <Button
              icon={Sparkles}
              onClick={() => {
                setSettingsOpen(false)
                useStore.getState().setOnboarding(true)
              }}
            >
              Assistant de configuration
            </Button>
            <span className="caption muted">Analyse la machine et propose les modèles adaptés.</span>
          </div>
        </section>

        <section className="dialog-section">
          <span className="label">Diagnostic</span>
          <div className="field-row">
            <span className="caption muted">
              Vérifie tout : Node.js, dépendances, moteurs vocaux, Ollama, et fait répondre un modèle pour de vrai. (Équivalent dans un
              terminal : « lumen doctor ».)
            </span>
            <span className="spacer" />
            <Button small icon={doctor === 'running' ? LoaderCircle : Stethoscope} disabled={doctor === 'running'} onClick={() => void check()}>
              {doctor === 'running' ? 'Vérification…' : 'Vérifier'}
            </Button>
          </div>
          {doctor && doctor !== 'running' && <pre className="doctor-out">{doctor}</pre>}
        </section>

        <section className="dialog-section about">
          <span className="label">À propos</span>
          <div className="about-row">
            <Logo size={34} />
            <span className="toggle-text">
              <span className="label-sm">Lumen — conçu et développé par {AUTHOR}</span>
              <span className="caption muted">
                {COPYRIGHT} Usage personnel autorisé ; republication, revente ou appropriation interdites sans accord (voir LICENSE).
              </span>
            </span>
            <Button small variant="ghost" icon={ExternalLink} onClick={() => window.open(REPO_URL, '_blank', 'noopener,noreferrer')}>
              Dépôt officiel
            </Button>
          </div>
        </section>

        <section className="dialog-section">
          <span className="label">Données</span>
          <p className="caption muted">
            {count} conversation{count > 1 ? 's' : ''} enregistrée{count > 1 ? 's' : ''} uniquement dans ce navigateur (IndexedDB). Rien n'est envoyé en ligne.
          </p>
          <div className="field-row">
            <Button icon={Download} onClick={exportAll} disabled={!count}>
              Exporter (.json)
            </Button>
            <Button
              variant="danger"
              icon={Trash}
              disabled={!count}
              onClick={() => {
                if (trigger()) {
                  clearAll()
                  toast('Conversations supprimées', 'success')
                }
              }}
            >
              {armed ? 'Confirmer la suppression' : 'Tout effacer'}
            </Button>
          </div>
        </section>
      </div>
    </div>
  )
}
