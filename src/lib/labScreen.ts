// Lumen — © 2026 Nixovel. Tous droits réservés. Licence : voir LICENSE (https://github.com/Nixovel/Ia-local)
// Panneau « Écran du labo » (à côté du chat) : ouvert ou non, labo affiché. Gardé à part du store principal.
import { create } from 'zustand'
import { useStore } from '../store'
import type { LabId } from './lab'

type LabScreenState = {
  open: boolean
  lab: LabId
  /** L'utilisateur a fermé le panneau : on ne le rouvre plus tout seul. */
  dismissed: boolean
  show: (lab?: LabId) => void
  close: () => void
  setLab: (lab: LabId) => void
  /** Le modèle travaille dans un labo à écran : on montre cet écran, sauf si l'utilisateur a fermé le panneau. */
  auto: (lab: LabId) => void
}

export const useLabScreen = create<LabScreenState>((set, get) => ({
  open: false,
  lab: 'windows-vm',
  dismissed: false,
  show: (lab) => {
    useStore.getState().openPanel(null)
    set({ open: true, lab: lab ?? get().lab, dismissed: false })
  },
  close: () => set({ open: false, dismissed: true }),
  setLab: (lab) => set({ lab }),
  auto: (lab) => {
    const s = get()
    if (s.dismissed || (s.open && s.lab === lab)) return
    if (!s.open) useStore.getState().openPanel(null)
    set({ open: true, lab })
  },
}))
