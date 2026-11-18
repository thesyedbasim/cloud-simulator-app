---
name: cloud-simulator-workflow
description: How to make, document, ship and release changes to the CloudSim (Cloud Architecture Simulator) app in this repo, and where to look up what the app can do. Use this whenever the user asks for a new feature, fix, tweak or removal in CloudSim, asks to commit, push, open a PR, merge, release or ship, asks what version or release type a change is, or asks "what features does the app have", "does it support X" or "how does Y work". Use it even when they only say "do this" or "add that" about the simulator, because every change here must also update the feature docs and end in a labelled PR and release.
---

# CloudSim workflow

Every change to this app follows one loop: **change it, check it, document it, then ship it as a labelled PR that the release workflow turns into a GitHub release.** The repo is `app/` (remote `thesyedbasim/cloud-simulator-app`). The outer `cloud-simulator/` folder is not a git repository.

## Two living docs (read these instead of the code)

These are part of this skill (see `references/`) and are the answer to "what does the app do?":

- `references/FEATURES.md` (really `docs/FEATURES.md`): everything the app can do today, by area. **Start here** to answer a feature question.
- `references/MODEL.md` (really `docs/MODEL.md`): how each feature is modelled, with the formulas and assumptions. Read it before changing simulation behaviour.

`docs/PRODUCT_SPEC.md` is the product's goals and roadmap, and `docs/TECHNICAL_GUIDE.md` is the original design and build plan. They are background, not a feature list.

Answer feature questions from these files. Only open the code when they do not cover it, and then fix the doc.

## 1. Make the change

- Work on a new branch from an up-to-date `main` (`git fetch`, then `git switch -c <type>/<short-name> origin/main`). Types: `feature/`, `fix/`, `docs/`, `chore/`.
- Keep the change scoped to what was asked. Prefer fixing the cause over adding a setting.
- Run the checks before committing, from `app/`: `pnpm exec tsc -b`, `pnpm test`, and `pnpm build`. `pnpm lint` should report no errors (warnings exist already). Fix failures before going on.
- A visible change should be looked at in the app (start the dev server from `.claude/launch.json` in the outer folder) rather than assumed.

## 2. Update the docs in the same change

A change that is not in the docs will be rediscovered from the code next time, which is what these files exist to prevent. Before committing:

- **`docs/FEATURES.md`**: add, edit or delete the line for anything a user can see or set (a component, a setting, a menu, a scenario, a removed feature). Keep wording plain and current-tense. Remove what no longer exists rather than leaving it.
- **`docs/MODEL.md`**: when simulation behaviour, a formula or an assumption changes, update or add a section. Say what is **not** modelled when that matters.
- **`README.md`**: only when setup, scripts, the folder layout or this process changes.
- **This skill**: when the workflow, the release rules or the doc locations change.

If a change touches none of these, say so in the PR description.

## 3. Commit

The first line of every commit becomes one line of the release notes, so write it as a short statement of what changed for a reader of the changelog: "Add per-IP rate limits to the gateway", not "update engine.ts". Split a large change into several commits where the pieces are independently meaningful (a feature, a fix, a removal, a docs update), and put detail in the commit body. End each message with the attribution line from the session instructions.

## 4. Decide the release type

Choose it from the size and nature of the change, and tell the user which you chose and why in one line. Do not ask unless it is genuinely close.

| Label | Use when |
| --- | --- |
| `release: patch` | Bug fixes, layout or wording tweaks, performance work, small corrections that add no new capability. |
| `release: minor` | A new thing a user can do or see: a component, setting, scenario, menu, mode, or a meaningful change in simulation behaviour. Removing a feature while on `0.x` also counts as minor (state it as a breaking change in the PR). |
| `release: major` | Breaking changes once the app is on `1.x` or later. While on `0.x`, do **not** choose major on your own: moving to `1.0.0` is the user's decision, so ask. |
| *(no label)* | Docs-only, CI-only or internal changes with no effect on the app. No release is published. |

When a PR mixes kinds, use the highest that applies. Exactly one label per PR; the workflow fails on two.

## 5. Ship it

Only ship when the user has asked to commit, push, release or "ship" the work. Opening a PR and merging are outward-facing, so if the request is unclear, confirm once.

1. Commit (step 3), then push the branch: `git push -u origin <branch>`. If the push is rejected because the change touches `.github/workflows/` (the stored token lacks the `workflow` scope), push once over SSH instead: `git push git@github.com:thesyedbasim/cloud-simulator-app.git <branch>:<branch>`. Do not change the remote.
2. Open the PR into `main`: `gh pr create --base main --head <branch> --label "release: <type>" --title ... --body-file ...`. Title: what the release delivers. Body: grouped plain-language bullets of every change (this is the full account of the work, since release notes only list commit subjects), a "Checks" line, and the PR attribution line from the session instructions at the end.
3. Merge with a **normal merge commit**, never squash or rebase, so each commit stays in the history and in the changelog: `gh pr merge <n> --merge`. Do not merge locally with `git merge`.
4. The **Release** workflow (`.github/workflows/release.yml`) runs on the push to `main`. Check it: `gh run list --workflow Release --limit 1`, then `gh release view <tag>`. It reads the PR label, bumps the latest `vX.Y.Z` tag, and publishes a release whose notes list the PR's commits. If it fails or publishes nothing unexpectedly, report it rather than creating a release by hand.
5. Sync: `git switch main && git pull --ff-only`.

Release notes are generated from commit subjects, so there is nothing to write by hand. Version numbers come from the tags; never edit `package.json`'s version for releases.

## Quick reference

- Repo: `thesyedbasim/cloud-simulator-app`, default branch `main`, labels `release: major|minor|patch`.
- Source layout: `src/sim/` (engine, pure TypeScript), `src/canvas/` (PixiJS scene), `src/panels/` (React UI), `src/store/` (state, types, project file), `src/presets/`.
- Tests: Vitest, `src/**/*.test.ts`. Add a test for any new simulation rule.
