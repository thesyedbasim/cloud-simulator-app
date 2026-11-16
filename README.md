# CloudSim

Cloud Architecture Simulator: see an architecture breathe, then break it on purpose.

Build or open a design, push traffic through it, break parts of it, and watch what happens on an isometric blueprint canvas. It explains why something broke, suggests fixes by experiment, and compares designs before and after. Frontend only: no backend, no accounts, designs autosave in the browser and export as JSON.

## Run it

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # unit tests (the simulation, the analysis, the file format)
pnpm build      # type-check and production build
```

## Stack

Vite, React, TypeScript, PixiJS (canvas), Zustand, Tailwind, Radix primitives, Motion, Vitest.

## Where things are

| Path | What |
| --- | --- |
| `src/sim/` | The simulation and everything built on it: engine, scenarios, headless runs, fixes, capacity finder, SLOs, tracing. Pure TypeScript, no UI. |
| `src/canvas/` | The PixiJS scene: components, traffic particles, tiers, trace player. |
| `src/panels/`, `src/app/` | React UI: inspector, dialogs, top bar, dock. |
| `src/store/` | App state, the architecture types, and the project file format. |
| `src/presets/` | The starter designs. |
| `docs/` | `PRODUCT_SPEC.md` (what and why), `TECHNICAL_GUIDE.md` (the original plan), `MODEL.md` (every formula and assumption in the simulation). |

The marketing site lives in a separate repository, `landing/`.
