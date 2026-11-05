# STATAverse

An interactive Stata learning site for mixed levels, with a clear beginner path. Students run commands, inspect data and output, change a fitted line, check interpretations and export their work to Stata.

## Learning paths

- **Practice (`Learn/`)**: 19 lessons and 86 checked exercises across a beginner path, data/do-files, model specification and independent practice. Two-stage hints, numerical responses, specific feedback and deliberately flawed drafts support work beyond copying an example. Group preparation connects attached means, contributing observations, common samples and changes in observational unit. Open practice includes three synthetic datasets and local CSV/TSV imports with a typed preview, editable names, explicit missing-value decisions and retained original source.
- **Do-file builder (`ScriptLibrary/builder.html`)**: five stages connect project paths, data import, ordered preparation, analysis and output. Beginner, intermediate and advanced views expose eight analysis families and nine preparation operations. Generated code remains visible and editable; Mac/Windows path guidance, do-file downloads and workspace backups are included. Complete exports target installed Stata, including commands beyond the browser interpreter.
- **Analysis labs (`Labs/`)**: regression and adjustment connects a seeded population to raw/partial-regression plots, an exact omitted-variable decomposition, influence diagnostics and one-observation sensitivity. The inference lab (`Labs/Inference/`) compares conventional, HC1 and one-way clustered intervals, runs up to 2,000 repeated samples in a cancelable background worker, reports Monte Carlo uncertainty, and links individual intervals to their underlying samples. Export exact observations, completed repetition results and native Stata analysis/simulation do-files. The data lab (`Labs/Data/`) traces rows and cells through merges and reshapes, with key audits, sample-retention rules, conflicting-value decisions, source tracing and exact project exports. Three guided investigations add 17 tasks with configuration, source-inspection and interpretation checks.
- **Instrumental variables (`Labs/IV/`)**: linked first-stage, reduced-form and structural plots; conventional/HC1 2SLS covariance; weak and invalid instruments; analytic Anderson–Rubin confidence sets, including disconnected and unbounded sets; three saved investigations with 16 tasks and exact-data Stata exports. The lab runs locally and supports offline use after the app is cached. It does not add `ivregress` to the Practice interpreter.
- **Applied lessons (`ZeroToHero/`)**: longer worked examples, constructed business datasets and two downloadable Stata projects.
- **Method comparison (`MethodLab/`)**: compare outcome models, proposed research designs and inference assumptions across 200 setups. Linear probability, logit, count, fraction, survival, panel, IV and simple DID specifications retain their conditions and limits. Choices travel in the page address; text exports preserve qualifications. Printable Stata references share the same source. Templates require full Stata and do not fit a model in the browser.
- **Worked examples (`CodeLibrary/`)**: read seven native Stata do-files by section, find commands and bookmark source lines before downloading. The panel sequence adds eight interpretation checks and matching native reference estimates, with explicit within/between, covariance and dynamic-panel conditions. Previously opened files remain readable offline. Native Stata is required to execute the complete programs.
- **Reference**: concepts, short command templates and native Stata simulations. Advanced materials remain accessible.
- **Saved work (`Workspace/`)**: local progress, notes, do-file plans and command-history backups. No account or server is required. Backups move work between browsers, including lab investigation completion; no automatic synchronization occurs.

The browser workspace implements a documented **subset**, not Stata itself. It supports data inspection, transformations, missing-value conditions, temporary samples with preserve/restore, frequency tables, graphs, OLS and HC1 robust inference. Regression accepts `i.` and `c.`, `#` and `##`, reference categories and grouped terms; interactions and polynomial terms can also use explicitly generated columns. Unsupported commands stop with an explanation. Local macros, foreach lists, integer forvalues ranges and nested if/else blocks run in the browser. Full Stata is needed for global macros, user-defined programs, arbitrary files, time-series operators, panel estimators and other advanced analysis. Merge and reshape run in the separate synthetic-data lab; they are not commands in the practice interpreter. See [the numerical contract](docs/numerical-contract.md).

Imports stay in the browser. UTF-8 CSV, TSV and semicolon-delimited files are bounded at 1 MB, 5,000 observations, 50 columns and 100,000 cells; the library retains up to three sources totaling 1.5 MB. Leading-zero identifiers remain text by default. Invalid numeric conversions block import. Project exports include the used original sources, decisions, normalized starting CSVs, commands and current data; unrelated imported sources are excluded. Workspace backups include the entire local library. Internal storage schema v3 migrates existing v2 work under the same storage key.

Transformations enforce text-growth limits as well as row and column limits. Oversized values fail without changing the data. Undo and displayed results use bounded retention; long changed-value previews are identified as shortened. Older saved work that cannot replay under the current bounds remains preserved for backup. The [numerical contract](docs/numerical-contract.md) specifies these limits.

Open practice supports group and row statistics with `egen`, and changes in observational unit with `collapse`. Results show each statistic's nonmissing sample and let students inspect source observations recorded when the command ran. `preserve`, `restore` and Undo recover individual-level data; grouping, casewise deletion and missing-total decisions are explicit. Command help lists the supported grammar. Twenty-five native cases in `tools/check-grouped-native.mjs` check values and missingness; browser cases cover inspection, snapshots, reload, restore, keyboard access and exports.

The programming lesson teaches six connected tasks with actual substitutions visible in Results. Local scopes last for one Run action; run definitions and uses together. Cursor execution selects an entire enclosing block. Errors retain source positions and prior successful changes. Project ZIPs preserve the original editor program as `editor-draft.do`, while `analysis.do` contains expanded successful commands for reproducible replay. Fourteen constructed cases agree with the installed native executable; one empty-sample behavior is retained as an explicit boundary, not adopted as a specification. See [browser runtime development](docs/browser-runtime-plan.md).

## Local development

Use a current Node installation; this candidate was checked with Node 24.20.0.

```sh
npm ci
npm run build
npm run dev
```

Open `http://127.0.0.1:4173/`. Use an HTTP server: opening HTML through `file://` does not support fetched lessons or offline registration.

Author JavaScript in `src/`; `npm run build` creates the checked-in bundles, generates the method-reference do-files and copies local vendor assets. Teaching content remains in the section `content/` directories. After changing titles or lesson metadata, refresh the search index with `uv run --no-project python tools/build_site_index.py` (standard library only).

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

`tools/inference-reference.R` independently checks five inference samples using R `lm` and `sandwich`, including few groups and nondefault confidence levels. `tools/check-inference-native.mjs` checks all three covariance methods in native Stata and runs three native simulation workflows directly. Sample-import checks substitute native input; the self-generating simulation do-files need no such substitution. Simulations retain double-precision output and specify Stata's `mt64` generator; their draws differ from the browser stream.

`tools/check-data-native.mjs` executes 32 merge/reshape cases against native Stata, comparing rows, missingness and failure codes. Only CSV import is substituted with explicit data setup. The cases include missing/composite/string keys, empty retained samples, overlap rules and both reshape directions. Browser checks cover source tracing, keyboard navigation, invalid-to-valid recovery, exports, hidden controls, contrast and mobile overflow. Investigation targets reuse these native fixtures; numeric answers are checked against the verified source or result tables. Progress uses stable task IDs in `stataverse:labs:v1`. Workspace backups containing lab progress use version 3; backups without it retain version 2. Earlier practice storage remains unchanged.

[The red-team report](docs/red-team-review.md) records reproduced defects, corrections and limits. [Verification receipts](docs/verification/) include native execution, dependency audit, deployment checks and screenshots. Passing these checks does not establish full Stata equivalence or replace classroom testing.

`tools/check-method-native.mjs` executes generated method templates and every printable reference topic in native Stata. Its 78 cases check supported syntax, populated estimates, finite covariance and preservation of existing data by the reference guides. They do not validate identifying assumptions or empirical suitability. [Method comparison maintenance](docs/method-comparison.md) describes the canonical source and the separation between model, design and inference.

## Static hosting

The integrated destination is `https://ihelfrich.github.io/learn/stata/`. `npm run package:site` produces the static student-facing package that the main website builds from a pinned commit. Local development supports the repository root. Former `/STATAverse/` URLs forward to their corresponding canonical routes while retaining queries, fragments and browser storage. See [website integration](docs/site-integration.md) for navigation, storage compatibility, performance measurements and the remaining publication checks. The canonical website route was published on 5 November 2026 UTC. Public browser checks are recorded in `docs/verification/public-site.json`; the broader overhaul continues.

Vendor notices are retained under `assets/vendor/`. The application contains no telemetry or remote execution service. New practice data are explicitly synthetic; the older business datasets are constructed teaching examples, not verified business records.

Practice runs and saved-history restoration use a cancelable browser worker. If a worker cannot start or load, the same interpreter runs on the page and yields between commands. Stop discards the pending run; an individual command cannot be interrupted midway in the fallback. Both modes retain the existing data until a completed run is accepted.
