// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { SettingsDialog } from './components/SettingsDialog'
import { Onboarding } from './components/Onboarding'
import { ChatView } from './views/ChatView'
import { ModelsView } from './views/ModelsView'
import { LibraryView } from './views/LibraryView'
import { VpnView } from './views/VpnView'
import { Logo } from './components/ui'
import { fetchHardware, isLowMemory } from './lib/hardware'

export default function App() {
  const hydrated = useStore((s) => s.hydrated)
  const view = useStore((s) => s.view)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const showOnboarding = useStore((s) => s.onboardingOpen || (!s.onboarded && s.runtime.connected !== null))
  const baseUrl = useStore((s) => s.baseUrl)

  // Petites machines (≤ 6 Go) : contexte par défaut réduit pour que les modèles tiennent en mémoire.
  useEffect(() => {
    fetchHardware().then(
      (hw) => useStore.getState().setLowMemory(isLowMemory(hw)),
      () => {},
    )
  }, [])

  // État du runtime : modèles chargés toutes les 4 s, liste complète toutes les 30 s.
  useEffect(() => {
    if (!hydrated) return
    const { refreshRuntime } = useStore.getState()
    const tick = (full: boolean) => !document.hidden && void refreshRuntime(full)
    const a = setInterval(() => tick(false), 4000)
    const b = setInterval(() => tick(true), 30000)
    const onFocus = () => tick(true)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(a)
      clearInterval(b)
      window.removeEventListener('focus', onFocus)
    }
  }, [hydrated, baseUrl])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const s = useStore.getState()
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        s.focusSearch()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        s.newChat()
      } else if (e.key === 'Escape' && s.panel && !s.settingsOpen && !(e.target as HTMLElement)?.closest('input, textarea, .popover')) {
        s.openPanel(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!hydrated)
    return (
      <div className="boot">
        <Logo size={40} glow />
      </div>
    )

  return (
    <div className="app">
      {sidebarOpen && <Sidebar />}
      <main className="main">{view === 'models' ? <ModelsView /> : view === 'library' ? <LibraryView /> : view === 'vpn' ? <VpnView /> : <ChatView />}</main>
      <Toasts />
      {settingsOpen && <SettingsDialog />}
      {showOnboarding && !settingsOpen && <Onboarding />}
    </div>
  )
}
