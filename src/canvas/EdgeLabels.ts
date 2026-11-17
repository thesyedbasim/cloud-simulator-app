import { Container, Text } from 'pixi.js'
import type { Theme } from '../lib/theme'
import type { Architecture } from '../store/types'
import type { StepResult } from '../sim/engine'
import type { Path } from './Particles'

const TAGS: Record<string, string> = { unhealthy: 'REMOVED', draining: 'DRAINING', drained: 'DRAINED', standby: 'STANDBY', warming: 'WARMING' }

/** Small chips on the connections that leave a load balancer: each target's share of traffic, or why it is not getting any. */
export class EdgeLabels extends Container {
  private texts = new Map<string, Text>()
  private theme: Theme

  constructor(theme: Theme) { super(); this.theme = theme }

  update(arch: Architecture, paths: Map<string, Path>, res: StepResult | null) {
    const seen = new Set<string>()
    const kinds = new Map(arch.components.map((c) => [c.id, c.kind]))
    const fanOut = new Map<string, number>()
    for (const e of arch.connections) fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1)
    for (const e of arch.connections) {
      const r = res?.edges[e.id]?.lb
      const path = paths.get(e.id)
      if (!r || !path || kinds.get(e.from) !== 'loadBalancer') continue
      const tag = TAGS[r.status]
      if ((fanOut.get(e.from) ?? 0) < 2 && !tag) continue
      let t = this.texts.get(e.id)
      if (!t) {
        t = new Text({ text: '', style: { fontFamily: 'IBM Plex Mono', fontSize: 9, fill: this.theme.text, fontWeight: '500', stroke: { color: this.theme.bg, width: 3 } } })
        t.anchor.set(0.5, 1)
        this.texts.set(e.id, t)
        this.addChild(t)
      }
      const label = `${Math.round(r.share * 100)}%${tag ? ` · ${tag}` : ''}`
      if (t.text !== label) t.text = label
      t.style.fill = r.status === 'unhealthy' ? this.theme.failed : r.status === 'active' ? this.theme.text : this.theme.dim
      // sit on the last leg, a little way before the arrowhead
      const a = path.pts[path.pts.length - 2], b = path.pts[path.pts.length - 1]
      const k = a.x === b.x && a.y === b.y ? 0 : 0.55
      t.position.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k - 6)
      seen.add(e.id)
    }
    for (const [id, t] of this.texts) if (!seen.has(id)) { this.removeChild(t); t.destroy(); this.texts.delete(id) }
  }
}
