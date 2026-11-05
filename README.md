# STATAverse

An interactive Stata learning site for mixed levels, with a clear beginner path. Students run commands, inspect data and output, change a fitted line, check interpretations and export their work to Stata.

## Learning paths

- **Practice (`Learn/`)**: 16 lessons and 68 checked exercises across a beginner path, data/do-files, model specification and independent practice. Two-stage hints, numerical responses, specific feedback and deliberately flawed drafts support work beyond copying an example. Open practice includes three synthetic datasets and local CSV/TSV imports with a typed preview, editable names, explicit missing-value decisions and retained original source.
- **Analysis lab (`Labs/`)**: a seeded regression experiment with adjustable structural coefficients, correlation and noise; linked raw/partial-regression plots; an exact omitted-variable decomposition; influence diagnostics and one-observation sensitivity. Export the actual observations and a native Stata do-file.
- **Applied lessons (`ZeroToHero/`)**: longer worked examples, constructed business datasets and two downloadable Stata projects.
- **Reference**: concepts, short command templates, native Stata simulations and a method-comparison guide. Advanced materials remain accessible.
- **Saved work (`Workspace/`)**: local progress, notes and command-history backups. No account or server is required. Backups move work between browsers; no automatic synchronization occurs.

The browser workspace implements a documented **subset**, not Stata itself. It supports data inspection, transformations, missing-value conditions, temporary samples with preserve/restore, frequency tables, graphs, OLS and HC1 robust inference. Interactions and polynomial terms use explicitly generated columns. Unsupported commands stop with an explanation. Full Stata is needed for macros, loops, arbitrary files, factor-variable syntax, merges, panel estimators and other advanced analysis. See [the numerical contract](docs/numerical-contract.md).

Imports stay in the browser. UTF-8 CSV, TSV and semicolon-delimited files are bounded at 1 MB, 5,000 observations, 50 columns and 100,000 cells; the library retains up to three sources totaling 1.5 MB. Leading-zero identifiers remain text by default. Invalid numeric conversions block import. Project exports include the used original sources, decisions, normalized starting CSVs, commands and current data; unrelated imported sources are excluded. Workspace backups include the entire local library. Internal storage schema v3 migrates existing v2 work under the same storage key.

## Local development

Use a current Node installation; this candidate was checked with Node 24.20.0.

```sh
npm ci
npm run build
npm run dev
```

Open `http://127.0.0.1:4173/`. Use an HTTP server: opening HTML through `file://` does not support fetched lessons or offline registration.

Author JavaScript in `src/`; `npm run build` creates the checked-in bundles and copies local vendor assets. Teaching content remains in the section `content/` directories. After changing titles or lesson metadata, refresh the search index with `python3 tools/build_site_index.py` (standard library only).

## Verification

```sh
npm test                 # engine, numerical references and persistence
npm run test:browser     # desktop and mobile workflows
npm run test:deployment  # project paths, cache isolation and screenshots
npm run check:links
npm run format:check
npm audit
```

Browser checks use installed Google Chrome through Playwright. The deployment check accepts `BROWSER_CHANNEL` for a different installed Chromium channel. `npm run check` builds and runs the engine, link, browser and deployment checks.

Independent numerical fixtures come from R `lm`/`sandwich` and native Stata. See `tools/reference.R`, `tools/stata-reference.do` and `tools/stata-expressions.do`. The regression lab adds `tools/prepare-lab-reference.mjs`, `tools/lab-reference.R` and `tools/check-lab-native.mjs`; the native lab check explicitly substitutes double-precision input for Java-dependent CSV import. Native library checks use `tools/audit_stata.py`; scripts run in disposable folders, return codes are recorded, and license-bearing logs stay outside the repository. The runners never install packages or change global Stata configuration.

`tools/check-curriculum-native.mjs` checks every canonical lesson, its numerical answers and final data in native Stata. `tools/check-preserve-native.mjs` checks preservation errors, restoration options and recovery of order/labels. Browser Run actions retain a persistent interactive preservation scope; the native scope distinction and export behavior are documented in the workspace.

`tools/csv-reference.py` creates 30 synthetic delimited-text fixtures using Python's independent standard-library CSV writer and reader. Import checks cover malformed records, quoted newlines, byte-preserving source export, conversion decisions, bounded storage, keyboard controls and browser recovery. Native `import delimited` remains unverified because of the installed Java limitation.

[The red-team report](docs/red-team-review.md) records reproduced defects, corrections and limits. [Verification receipts](docs/verification/) include native execution, dependency audit, deployment checks and screenshots. Passing these checks does not establish full Stata equivalence or replace classroom testing.

## Static hosting

Serve the repository root or a project subpath such as `/STATAverse/`. Built assets are included for the existing GitHub Pages arrangement; `.nojekyll` remains in place. Deployment is a separate action. This local candidate has not been pushed or published.

Vendor notices are retained under `assets/vendor/`. The application contains no telemetry or remote execution service. New practice data are explicitly synthetic; the older business datasets are constructed teaching examples, not verified business records.
