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

## Releases

Releases are published automatically when a pull request is merged into `main`.

1. Open a pull request into `main` and give it one label: `release: major`, `release: minor` or `release: patch`.
2. Merge it with a normal merge commit (not squash), so every commit of the branch stays in the history.
3. The **Release** workflow (`.github/workflows/release.yml`) bumps the version from the latest `vX.Y.Z` tag and creates a GitHub release whose notes list every commit of the pull request.

A pull request without a release label publishes nothing. Versions follow [semantic versioning](https://semver.org): major for breaking changes, minor for new features, patch for fixes.
