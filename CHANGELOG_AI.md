# AI Change Log

Purpose
- Track changes made by Codex and other AI assistants.
- Record scope, files touched, and notes for auditing.

Entry: 2025-01-15
Author: Codex (GPT-5)
Scope: Build Zero-to-Hero section, datasets, interactivity, and site wiring.
Summary
- Added a new Zero-to-Hero section with landing, modules, datasets, and projects.
- Implemented interactive behaviors: markdown rendering, callouts, math toggles (KaTeX),
  glossary popovers, CSV previews, and Chart.js scatterplots.
- Created two sample datasets and a starter project with a Stata do-file.
- Wired Zero-to-Hero navigation into STATAverse and added GitHub Pages support.

Files created
- `ZeroToHero/index.html`
- `ZeroToHero/modules/00-econometric-mindset.html`
- `ZeroToHero/modules/01-stata-foundations.html`
- `ZeroToHero/modules/02-ols-intuition.html`
- `ZeroToHero/content/00-econometric-mindset.md`
- `ZeroToHero/content/01-stata-foundations.md`
- `ZeroToHero/content/02-ols-intuition.md`
- `ZeroToHero/content/coffee-chain.md`
- `ZeroToHero/content/warehouse-picking.md`
- `ZeroToHero/content/project-01.md`
- `ZeroToHero/datasets/index.html`
- `ZeroToHero/datasets/coffee-chain.html`
- `ZeroToHero/datasets/warehouse-picking.html`
- `ZeroToHero/projects/index.html`
- `ZeroToHero/projects/project-01.html`
- `ZeroToHero/projects/project-01/analysis.do`
- `ZeroToHero/data/coffee_chain_weekly.csv`
- `ZeroToHero/data/warehouse_picking.csv`
- `.nojekyll`
- `README.md`
- `.gitignore`

Files modified
- `index.html`
- `STATAForBusiness/index.html`
- `STATAForBusiness/modules/00-foundations.html`
- `STATAForBusiness/modules/01-linear-regression.html`
- `assets/css/site.css`
- `assets/js/site.js`

Other AI contributions
- None recorded in this log entry.

Notes
- Added ASCII-only content to comply with repository guidelines.
- Did not remove `.DS_Store`; pending user instruction.
- Added `.gitignore` entries to exclude `.DS_Store` and `EconometricsBooks/` from commits until needed.
- Committed and pushed changes to `origin/main`.
