import { toast } from 'sonner'
import { sceneRef } from '../canvas/CanvasView'
import { useStore } from '../store/useStore'
import { parseProject, saveToStorage, serializeProject } from '../store/project'
import { resetSim, useSim } from '../sim/runtime'
import { BLANK } from '../presets/index'
import type { Architecture } from '../store/types'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design'

function download(href: string, filename: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Make `arch` the current design: one undo step, fresh simulation, camera framed on it. */
export function openDesign(arch: Architecture, message?: string) {
  const st = useStore.getState()
  st.loadArchitecture(arch)
  useSim.getState().stopScenario() // a scenario belongs to the design it was started on
  resetSim()
  requestAnimationFrame(() => sceneRef.current?.fit(false))
  toast(message ?? `Opened ${arch.name}`, { action: { label: 'Undo', onClick: () => { useStore.getState().undo(); requestAnimationFrame(() => sceneRef.current?.fit(false)) } } })
}

export const newBlank = () => openDesign({ ...BLANK, components: [], connections: [] }, 'Started a blank design')

export function exportJson() {
  const arch = useStore.getState().architecture
  const url = URL.createObjectURL(new Blob([serializeProject(arch)], { type: 'application/json' }))
  download(url, `${slug(arch.name)}.cloudsim.json`)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast('Exported project file', { description: `${slug(arch.name)}.cloudsim.json` })
}

export async function exportImage() {
  const scene = sceneRef.current
  if (!scene?.ready) return
  try {
    const url = await scene.exportPng()
    download(url, `${slug(useStore.getState().architecture.name)}.png`)
    toast('Exported image', { description: 'The canvas as it looks right now, at 2× resolution.' })
  } catch {
    toast("Couldn't export the image")
  }
}

export async function importFile(file: File) {
  if (file.size > 1_000_000) { toast("That file is too large to be a project"); return }
  const r = parseProject(await file.text())
  if (!r.ok) { toast("Couldn't open that file", { description: r.error }); return }
  openDesign(r.arch, `Opened ${r.arch.name}`)
  if (r.warnings.length) toast('Some parts were skipped', { description: r.warnings.slice(0, 3).join(' ') })
}

/** Autosave to browser storage (debounced), and once more when the tab is hidden. Returns a stop function. */
export function startAutosave() {
  let timer = 0
  const save = () => {
    const arch = useStore.getState().architecture
    if (saveToStorage(arch)) useStore.getState().setSavedAt(Date.now())
  }
  const unsub = useStore.subscribe((s, p) => {
    if (s.architecture === p.architecture) return
    window.clearTimeout(timer)
    timer = window.setTimeout(save, 400)
  })
  const flush = () => { window.clearTimeout(timer); save() }
  window.addEventListener('pagehide', flush)
  return () => { unsub(); window.clearTimeout(timer); window.removeEventListener('pagehide', flush) }
}
