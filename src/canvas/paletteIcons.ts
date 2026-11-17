import { autoDetectRenderer, type Renderer } from 'pixi.js'
import { ComponentView } from './ComponentView'
import { theme } from '../lib/theme'
import { DEFAULT_CONFIG, type ComponentKind } from '../store/types'

let renderer: Promise<Renderer> | null = null

/** Draws each component with the same code the canvas uses and returns picture URLs for the palette. */
export async function renderPaletteIcons(kinds: ComponentKind[]): Promise<Partial<Record<ComponentKind, string>>> {
  renderer ??= autoDetectRenderer({ width: 8, height: 8, antialias: true, backgroundAlpha: 0, resolution: 2 })
  const r = await renderer
  const t = theme()
  const out: Partial<Record<ComponentKind, string>> = {}
  for (const kind of kinds) {
    const v = new ComponentView({ id: 'icon', kind, name: '', position: { col: 0, row: 0 }, config: { ...DEFAULT_CONFIG[kind] } }, t)
    v.iconOnly()
    out[kind] = await r.extract.base64({ target: v, resolution: 2, antialias: true })
    v.destroy({ children: true })
  }
  return out
}
