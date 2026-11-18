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

## Documentation

| File | What |
| --- | --- |
| [`docs/FEATURES.md`](docs/FEATURES.md) | Everything the app can do today, by area. Start here for "does it do X?". |
| [`docs/MODEL.md`](docs/MODEL.md) | How each feature is modelled: formulas, assumptions and what is not modelled. |
| [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) | The product's goals, users and roadmap. |
| [`docs/TECHNICAL_GUIDE.md`](docs/TECHNICAL_GUIDE.md) | The original design system, architecture and build plan. |

## Making changes

Every change follows the same loop, written down as a Claude Code skill in [`.claude/skills/cloud-simulator-workflow`](.claude/skills/cloud-simulator-workflow/SKILL.md) so it is applied the same way each time:

1. Branch from an up-to-date `main`.
2. Make the change and run `pnpm exec tsc -b`, `pnpm test` and `pnpm build`.
3. **Update the docs in the same change:** `docs/FEATURES.md` for anything a user can see or set, `docs/MODEL.md` when the simulation changes, and this README when setup or process changes.
4. Commit with messages that read as changelog lines (the first line of each commit appears in the release notes).
5. Push, open a pull request into `main` with a release label, and merge it with a normal merge commit (not squash).
6. The release is published automatically.

## Releases

Releases are published automatically when a pull request is merged into `main`.

1. The pull request carries one label: `release: major`, `release: minor` or `release: patch`. It is chosen by the size of the change:
   - **patch**: fixes, tweaks and small corrections that add no capability.
   - **minor**: something new a user can do or see, or a meaningful change in simulation behaviour.
   - **major**: breaking changes after 1.0 (the move to 1.0.0 is decided by the maintainer).
   - No label for docs-only or internal changes: nothing is released.
2. Merge it with a normal merge commit (not squash), so every commit of the branch stays in the history.
3. The **Release** workflow (`.github/workflows/release.yml`) bumps the version from the latest `vX.Y.Z` tag and creates a GitHub release whose notes list every commit of the pull request.

Versions follow [semantic versioning](https://semver.org).
