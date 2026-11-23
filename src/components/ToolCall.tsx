// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useState } from 'react'
import {
  AppWindow, Camera, Check, ChevronDown, CloudSun, Code, Cpu, Download, Eye, FilePen, FileText, FolderInput, FolderOpen, Globe, LoaderCircle, Search, ShieldCheck, Terminal, X,
  type LucideIcon,
} from 'lucide-react'
import { useStore, type ToolCall } from '../store'
import { decideTool } from '../chat'
import { Button } from './ui'

const META: Record<string, { label: string; icon: LucideIcon; detail: (a: Record<string, unknown>) => string }> = {
  set_working_dir: { label: 'Changer de dossier', icon: FolderInput, detail: (a) => String(a.path ?? '') },
  system_info: { label: 'Analyser la machine', icon: Cpu, detail: () => 'RAM, GPU, modèles adaptés' },
  install_model: { label: 'Installer un modèle', icon: Download, detail: (a) => String(a.name ?? '') },
  web_search: { label: 'Recherche web', icon: Search, detail: (a) => String(a.query ?? '') },
  web_fetch: { label: 'Lire une page', icon: Globe, detail: (a) => String(a.url ?? '') },
  weather: { label: 'Météo', icon: CloudSun, detail: (a) => String(a.location ?? '') || useStore.getState().userCity || 'votre ville' },
  run_command: { label: 'Commande', icon: Terminal, detail: (a) => String(a.command ?? '') },
  list_dir: { label: 'Lister un dossier', icon: FolderOpen, detail: (a) => String(a.path ?? '.') },
  read_file: { label: 'Lire un fichier', icon: FileText, detail: (a) => String(a.path ?? '') },
  write_file: { label: 'Écrire un fichier', icon: FilePen, detail: (a) => String(a.path ?? '') },
  open: { label: 'Ouvrir', icon: AppWindow, detail: (a) => String(a.target ?? '') },
  screenshot: { label: "Capture d'écran", icon: Camera, detail: () => 'écran principal' },
  applescript: { label: 'AppleScript', icon: Code, detail: (a) => String(a.script ?? '').split('\n')[0] },
}

const STATUS: Record<ToolCall['status'], string> = {
  pending: 'À valider',
  running: 'En cours',
  done: 'Terminé',
  error: 'Erreur',
  denied: 'Refusé',
}

export function ToolCallView({ call, msgId }: { call: ToolCall; msgId: string }) {
  const openPanel = useStore((s) => s.openPanel)
  const meta = META[call.name] ?? { label: call.name, icon: Code, detail: () => '' }
  const path = String(call.args.path ?? '')
  const viewable = call.name === 'write_file' && call.status === 'done'
  const waiting = call.status === 'pending' && call.needsApproval
  const [open, setOpen] = useState(false)
  const preview =
    call.name === 'write_file'
      ? String(call.args.content ?? '')
      : call.name === 'applescript'
        ? String(call.args.script ?? '')
        : call.name === 'run_command'
          ? String(call.args.command ?? '')
          : ''
  const previewLines = preview.split('\n')

  return (
    <div className={`tool is-${call.status}${waiting ? ' is-waiting' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={waiting}>
        <span className="tool-icon">
          <meta.icon size={14} strokeWidth={1.7} />
        </span>
        <span className="tool-label">{meta.label}</span>
        <span className="tool-detail mono-sm ellipsis">{meta.detail(call.args)}</span>
        <span className={`tool-status st-${call.status}`}>
          {call.status === 'running' && <LoaderCircle size={12} />}
          {call.status === 'done' && <Check size={12} strokeWidth={2.2} />}
          {(call.status === 'error' || call.status === 'denied') && <X size={12} strokeWidth={2.2} />}
          {STATUS[call.status]}
        </span>
        {!waiting && call.output && <ChevronDown size={13} className={`chev${open ? ' is-open' : ''}`} />}
      </button>
      {viewable && (
        <div className="tool-links">
          <Button small variant="ghost" icon={/\.(html?|svg)$/i.test(path) ? Eye : FileText} onClick={() => openPanel({ type: 'code', key: `${msgId}:tool:${call.id}` })}>
            {/\.(html?|svg)$/i.test(path) ? 'Aperçu' : 'Voir le fichier'}
          </Button>
        </div>
      )}

      {waiting && (
        <div className="tool-approve">
          {preview && (
            <pre className="tool-preview">
              {previewLines.slice(0, 14).join('\n')}
              {previewLines.length > 14 ? `\n… (${previewLines.length} lignes)` : ''}
            </pre>
          )}
          <div className="tool-actions">
            <ShieldCheck size={14} className="muted" />
            <span className="caption secondary">Le modèle veut effectuer cette action sur votre ordinateur.</span>
            <span className="spacer" />
            <Button small variant="ghost" onClick={() => decideTool(call.id, 'deny')}>
              Refuser
            </Button>
            <Button small variant="secondary" onClick={() => decideTool(call.id, 'always')} title="Ne plus demander pour cet outil dans cette conversation">
              Toujours
            </Button>
            <Button small variant="primary" icon={Check} onClick={() => decideTool(call.id, 'allow')}>
              Autoriser
            </Button>
          </div>
        </div>
      )}

      {call.image && <img className="tool-image" src={call.image} alt="Capture d'écran prise par l'agent" />}
      {open && call.output && <pre className="tool-output">{call.output}</pre>}
    </div>
  )
}
