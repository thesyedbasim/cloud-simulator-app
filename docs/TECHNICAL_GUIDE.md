# Cloud Architecture Simulator: Technical Guide & Build Plan

Companion to *Cloud Architecture Simulator — Product Specification.md*. This is a discussion draft. Nothing is built yet.

**Scope rules for this build**

- Frontend only. No login, no backend, no database.
- All data lives in memory (plain TypeScript objects in a store). A refresh resets the app to a preset. Saving to `localStorage` is an optional later step.
- Generic components (Load Balancer, App Servers, Database…) rather than AWS/GCP/Azure branded ones. This answers the spec's first open question for now.
- Use well-known libraries for solved problems. Write our own code only for the simulation and the isometric drawing, because those are what make the product different.

---

## 1. Look and feel

### 1.1 The concept

The app is a dark **blueprint workspace**: a deep navy drafting surface with a fine isometric grid, thin cyan linework, and small monospace annotations. The canvas is the hero. Panels around it are quiet, translucent, and get out of the way.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ◇ CloudSim   [Preset: Link Shortener ▾]    ▶ ❚❚  1x ▾   Scenario ▾  │  Top bar
├────────┬───────────────────────────────────────────────────┬─────────┤
│        │                                                   │         │
│ Palette│            Isometric blueprint canvas             │Inspector│
│        │       (components, connections, particles)        │         │
│  LB    │                                                   │ selected│
│  App   │                                                   │ settings│
│  DB    │                                                   │ + live  │
│  Cache │                                                   │ state   │
│  Queue │                                                   │         │
├────────┴───────────────────────────────────────────────────┴─────────┤
│  p50 42ms │ p99 310ms │ err 0.4% │ 1.2k rps │ ~$0.84/hr (est.)        │  Metrics strip
└──────────────────────────────────────────────────────────────────────┘
```

- Panels can be collapsed so the canvas can go full screen (good for demos and recording clips).
- On small screens (under ~900px), the palette and inspector become slide-over sheets. The canvas always stays visible.

### 1.2 Design principles (from the spec, made concrete)

| Principle | What it means in code |
| --- | --- |
| State lives on the object | Every component draws its own state: slots filling up, gauge levels, queue height. Panels repeat the numbers but are never the only place to see them. |
| Color has fixed meaning | Only three status colors exist: healthy, strained, failed. They are never used for decoration. |
| Traffic is visible | Particles flow along connections. Density = throughput, speed = latency, red particles = errors. |
| Impressive on first load | The app opens with a preset already running. No empty canvas. |
| Honest numbers | Cost shows "est.", and every assumed value has a small "assumed" marker. |

---

## 2. Tech stack

### 2.1 Core

| Concern | Choice | Why |
| --- | --- | --- |
| Build tool | **Vite** | Fast dev server, zero config. |
| UI framework | **React + TypeScript** | Standard, huge ecosystem. TypeScript keeps the simulation model honest. |
| Canvas rendering | **PixiJS v8** + **@pixi/react** | WebGL rendering. Can draw thousands of particles at 60fps, which SVG and DOM cannot do. Vector `Graphics` suits the blueprint linework, so no image assets are needed. |
| Pan / zoom / drag on canvas | **pixi-viewport** | Gives pan, pinch, wheel zoom, clamping and deceleration for free. |
| State | **Zustand** (+ `immer` middleware) | Tiny, no boilerplate, and it can be read outside React. The simulation loop and the Pixi renderer need that. |
| Styling | **Tailwind CSS v4** | Design tokens live in CSS variables, so the canvas and the UI share one palette. |
| UI components | **shadcn/ui** (built on Radix primitives) | Accessible popovers, dialogs, sliders, selects, tooltips and sheets. We own the code and can restyle it to the blueprint look. |
| Icons | **lucide-react** | Consistent thin-stroke icons that match the linework style. |
| Fonts | **IBM Plex Sans** + **IBM Plex Mono** via `@fontsource` | Plex has an engineering feel. Mono is used for annotations and numbers. Self-hosted, so no flash of unstyled text. |

### 2.2 Polish and micro-interactions

| Concern | Choice | Use |
| --- | --- | --- |
| UI motion | **Motion** (formerly Framer Motion) | Panel slide-in, list reordering, layout transitions, press feedback. |
| Animated numbers | **@number-flow/react** | Metrics roll smoothly instead of flickering (p99, rps, cost). |
| Toasts | **sonner** | "Node killed", "Scenario started", "Fix applied". |
| Live charts | **Recharts** (small sparklines, animation off) | Latency and error sparklines in the inspector and metrics strip. Can switch to uPlot if performance needs it. |
| Keyboard shortcuts | **react-hotkeys-hook** | Space = play/pause, Del = remove, Esc = deselect, 1–5 = speed. |
| Command palette (later) | **cmdk** | "Add Database", "Run Traffic Spike"… |
| Canvas tweening | **@tweenjs/tween.js** or a small lerp helper | Smooth state changes on canvas objects (gauge levels, glow, crack-in on failure). |

### 2.3 Things we are deliberately *not* using

- **React Flow / xyflow**: great for flat node editors, but the isometric view and particle density fight against it. Pixi gives us full control of the look.
- **Three.js**: real 3D is not needed. Isometric is a 2D projection, and Pixi is lighter.
- **Redux, React Query, routers, backend SDKs**: no server and a single screen, so they add nothing.

### 2.4 Tooling

- ESLint + Prettier, `strict` TypeScript.
- **Vitest** for the simulation engine (pure functions, easy to test). No UI tests at first.
- Package manager: pnpm (npm works too).

---

## 3. Design system

All tokens are CSS custom properties in one file (`src/styles/tokens.css`). Tailwind maps to them, and a small `theme.ts` reads the same values for PixiJS, so both stay consistent.

### 3.1 Color

| Token | Value (draft) | Role |
| --- | --- | --- |
| `--bp-bg` | `#0A1A2F` | Canvas / app background (blueprint navy) |
| `--bp-surface` | `#0F2440` at 80% + backdrop blur | Panels |
| `--bp-grid` | `#3A7BD5` at 12% | Isometric grid lines |
| `--bp-grid-major` | `#3A7BD5` at 22% | Every 5th grid line |
| `--bp-line` | `#BFE0FF` | Component linework, connections |
| `--bp-text` | `#E6F1FF` | Primary text |
| `--bp-text-dim` | `#7FA3C7` | Labels, annotations |
| `--bp-accent` | `#5CC8FF` | Selection, focus ring, primary action |
| `--status-healthy` | `#3DDC97` | Healthy |
| `--status-strained` | `#FFB547` | Strained (load at 70–90%) |
| `--status-failed` | `#FF5D5D` | Failed / errors |
| `--status-ghost` | `--bp-line` at 20% | Autoscaling ghost slots, disabled |

Rules:
- The three status colors are for state only.
- Every status is also shown by shape or motion (a crack, a pulse, desaturation), not color alone, for accessibility.
- One dark theme to start. A light "drafting paper" theme is a possible later addition, which the token setup makes easy.

### 3.2 Typography

| Style | Font | Size / weight | Use |
| --- | --- | --- | --- |
| Display | Plex Sans | 20 / 600 | App title, empty states |
| Heading | Plex Sans | 14 / 600 | Panel titles |
| Body | Plex Sans | 13 / 400 | Most UI text |
| Label | Plex Sans | 11 / 500, uppercase, +0.06em tracking | Section labels |
| Data | Plex Mono | 12–13 / 500, tabular numbers | Metrics, settings values |
| Annotation | Plex Mono | 10 / 400 | On-canvas labels, dimension marks |

### 3.3 Spacing, shape, depth

- **Spacing:** 4px base (4, 8, 12, 16, 24, 32).
- **Radius:** 6px for controls, 10px for panels. Canvas objects have sharp corners (blueprint style).
- **Borders:** 1px `--bp-line` at 15% on panels. No heavy shadows; depth comes from blur and a soft outer glow.
- **Z-layers:** canvas → overlays (tooltips on canvas) → panels → popovers → dialogs → toasts.

### 3.4 Motion

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 120ms | Hover, press |
| `--dur-base` | 200ms | Popovers, toggles |
| `--dur-slow` | 320ms | Panels, sheets |
| `--ease-out` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Default |
| spring | stiffness 400, damping 30 | Dropping a component onto the grid |

Respect `prefers-reduced-motion`: lower particle count, no glows or pulses, instant transitions.

### 3.5 Micro-interaction catalog

A short list to keep polish consistent. Each one is small.

| Moment | Interaction |
| --- | --- |
| Drag from palette | A ghost outline follows the cursor and snaps to grid cells, with a dimension readout |
| Drop on canvas | Small spring "settle" and a faint ring ripple on the grid |
| Hover component | Linework brightens, a tooltip shows name and key metric |
| Select component | Accent outline with corner tick marks (drafting style), inspector slides in |
| Draw connection | Dashed line follows cursor; valid targets glow, invalid ones dim |
| Strained | Slow amber pulse on the object |
| Failed | Desaturate, crack lines draw in, retry particles pile up in front |
| Play / pause | Icon morphs; particles ease to a stop instead of freezing |
| Metric change | Numbers roll (NumberFlow); threshold crossings briefly tint the value |
| Scenario start | Toast + a timeline marker |

---

## 4. Application architecture

### 4.1 The three layers

```
┌───────────────────────┐   ticks 10×/sec   ┌────────────────────────┐
│  Simulation engine    │ ────────────────► │  Store (Zustand)       │
│  pure TypeScript,     │                   │  architecture, sim     │
│  no React, no Pixi    │ ◄──────────────── │  state, UI state       │
└───────────────────────┘   reads graph     └──────────┬─────────────┘
                                                       │
                          ┌────────────────────────────┼──────────────────────┐
                          ▼                                                   ▼
               ┌──────────────────────┐                         ┌──────────────────────────┐
               │  Canvas (PixiJS)     │                         │  Panels (React DOM)      │
               │  60fps, reads store  │                         │  subscribe to a          │
               │  directly each frame │                         │  throttled snapshot (4Hz)│
               └──────────────────────┘                         └──────────────────────────┘
```

Key decisions:

1. **The engine is pure functions**: `step(architecture, simState, dt) → simState`. Easy to unit test, and easy to move into a Web Worker later if needed.
2. **Fixed simulation tick, free render rate.** The sim advances in fixed 100ms steps. Pixi renders at 60fps and interpolates between steps. Speed control (0.5×–4×) changes how many steps run per second.
3. **React does not re-render every frame.** The canvas reads the store directly inside the Pixi ticker. React panels subscribe to a snapshot that updates about 4 times per second. This is the main thing that keeps the app smooth.
4. **Particles are visual only.** 1,000 rps is not 1,000 particles. Particle count is sampled from throughput and capped, so animation never slows the simulation.

### 4.2 Data model (draft)

```ts
type ComponentKind = 'client' | 'loadBalancer' | 'appServers' | 'database' | 'cache' | 'queue';

interface ArchComponent {
  id: string;
  kind: ComponentKind;
  name: string;
  position: { col: number; row: number };   // isometric grid cell
  config: Record<string, number>;           // e.g. { instances: 3, capacityPerInstance: 200 }
  assumed?: string[];                        // config keys that are defaults, shown as "assumed"
}

interface Connection { id: string; from: string; to: string; }

interface Architecture { components: ArchComponent[]; connections: Connection[]; }

type Health = 'healthy' | 'strained' | 'failed';

interface ComponentSimState {
  incomingRps: number;
  utilization: number;       // 0..1+ (above 1 means overloaded)
  queueDepth: number;
  latencyMs: number;
  errorRate: number;
  health: Health;
  injected?: 'killed' | 'slow';
}

interface SimState {
  t: number;                                   // seconds since start
  running: boolean;
  speed: number;
  traffic: { shape: TrafficShape; baseRps: number };
  components: Record<string, ComponentSimState>;
  totals: { p50: number; p99: number; errorRate: number; rps: number; costPerHour: number };
  history: TotalsSample[];                     // rolling window for sparklines
}
```

### 4.3 Simulation model (kept small on purpose)

The spec's biggest risk is "simulation not believed", so the model is small, documented, and shows its assumptions.

- **Traffic in:** `rps(t)` from a traffic shape function (steady, spike, daily curve, flash sale, slow ramp).
- **Flow:** each tick, requests move along the graph. A load balancer splits across healthy targets. A cache sends `hitRate` of reads back and passes misses to the database.
- **Capacity:** each component has `capacity = instances × perInstanceCapacity`. `utilization = incoming / capacity`.
- **Latency:** `base / (1 − utilization)` (a simple queueing curve), capped. Above 100% the queue grows each tick.
- **Errors:** come from a full queue, an exhausted connection pool, timeouts, or a killed component.
- **Retries:** failed requests return as extra load (configurable retry count). This is how retry storms happen on their own.
- **Health:** under 70% load = healthy, 70–90% = strained, over 90% or erroring = failed.
- **Cost:** a static price table per component size × instances, always labeled "est.".
- **Determinism:** a seeded random generator, so the same scenario gives the same result. This matters later for compare mode.

Every formula and default goes into a short `docs/MODEL.md`, so a technical reader can check it (spec success measure: "Credibility").

### 4.4 Isometric rendering

- One small module, `iso.ts`: `gridToScreen(col, row)`, `screenToGrid(x, y)`, and a depth sort (draw back to front).
- Each component kind is a class that draws itself with Pixi `Graphics` (linework) and has an `update(simState)` method that changes its state visuals (slot fill, gauge level, queue height, crack overlay).
- Connections are drawn as isometric paths (right angles along grid axes), and particles move along them with `ParticleContainer`.

### 4.5 Folder structure

```
src/
  app/            App shell, layout, top bar, metrics strip
  canvas/         Pixi stage, viewport, iso math, grid
    components/   One drawing class per component kind
    particles/    Particle system
  panels/         Palette, Inspector, Scenario menu
  sim/            Engine: traffic shapes, step(), scenarios, cost table (no UI imports)
  store/          Zustand store and slices (architecture, sim, ui)
  presets/        Ready-made architectures as plain TS objects
  ui/             shadcn components (restyled)
  styles/         tokens.css, globals
  lib/            Small helpers (ids, seeded random, format)
```

---

## 5. Phased build plan

The spec has four product phases (P1–P4). Spec P1 alone is large, so the build splits it into smaller steps. Each step ends in something you can see and try. **We only plan the current step in detail.** Later steps stay a rough list so they can change based on what we learn.

### Step 1: Foundation & blueprint canvas (detailed)

**Goal:** the app opens to a polished, empty-looking blueprint world that feels good to move around in.

- Scaffold Vite + React + TS + Tailwind + shadcn. Add tokens, fonts and lint setup.
- App shell: top bar, collapsible left/right panels, bottom metrics strip (placeholder values).
- Pixi canvas with pixi-viewport: isometric grid (minor/major lines), pan, zoom, zoom limits.
- `iso.ts` with grid math and a hover cell highlight to prove it works.
- One preset (link shortener) rendered as **static** components: Client → Load Balancer → App Servers → Cache + Database. Basic iso linework for each kind.

**Done when:** it looks like the blueprint concept, panning and zooming is smooth, and the preset is visible on load.

### Step 2: Editing (outline)

- Palette with ~5 components. Drag onto canvas with snapping.
- Select, move, delete, draw and remove connections.
- Inspector with each component's settings (instances, capacity, pool size…).
- Keyboard shortcuts and hover/select micro-interactions.

### Step 3: Simulation comes alive (outline)

- Engine `step()` with traffic shapes, capacity, latency, queues and errors.
- Play / pause / speed controls.
- Particles on connections, health colors and on-object state visuals.
- Live metrics strip and inspector sparklines; cost estimate.

### Step 4: Break it (outline)

- Kill or slow down a component (right-click menu or inspector).
- Scenarios: traffic spike, node failure, slow database.
- Retry storms and pool exhaustion arise from the model.
- Bottleneck highlight with a plain-language "why" card.

At this point spec P1 is complete as a demo.

### Later, to be shaped as we go (no commitment to order)

- More presets (chat app, video streaming, e-commerce)
- Autoscaling with ghost slots
- Timeline scrubber / rewind
- Compare mode (design A vs B)
- Suggested fixes with automatic re-run
- Single-point-of-failure check before running
- Save to `localStorage`, export/import JSON, export PNG
- Light theme
- Command palette
- Request tracing (click a particle, follow its path)
- "Describe it in words" with an LLM

---

## 6. Open questions for discussion

1. **Look:** is the dark navy blueprint right, or would you prefer a light "drafting paper" look as the main theme?
2. **Component set for Steps 1–4:** Client, Load Balancer, App Servers, Database, Cache, Queue. Add or remove any?
3. **Starter preset:** start with the link shortener only, or include a second one early?
4. **Canvas library:** PixiJS (full visual control, editing is custom) vs. React Flow (editing for free, much harder to make isometric). This guide recommends PixiJS.
5. **Persistence:** stay purely in memory, or add `localStorage` autosave early since it is cheap?
6. **Mobile:** view-only on phones, or full editing?
