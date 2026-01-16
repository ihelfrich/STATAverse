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

Entry: 2025-01-15 (cont)
Author: Codex (GPT-5)
Scope: Expanded Zero-to-Hero with limited outcomes module, new dataset, and project 02.
Summary
- Added Module 03 on limited outcomes with model selection widget, logit/Poisson/NB workflows,
  and visual intuition chart.
- Added Fulfillment Delays dataset plus dataset page and documentation.
- Added Project 02 (delay risk + delay days) with do-file.
- Updated navigation and index pages to include new module, dataset, and project.
- Extended JS/CSS with model selector UI and supporting styles.

Files created
- `ZeroToHero/modules/03-limited-outcomes.html`
- `ZeroToHero/content/03-limited-outcomes.md`
- `ZeroToHero/content/fulfillment-delays.md`
- `ZeroToHero/datasets/fulfillment-delays.html`
- `ZeroToHero/data/fulfillment_delays.csv`
- `ZeroToHero/projects/project-02.html`
- `ZeroToHero/content/project-02.md`
- `ZeroToHero/projects/project-02/analysis.do`

Files modified
- `ZeroToHero/index.html`
- `ZeroToHero/datasets/index.html`
- `ZeroToHero/datasets/coffee-chain.html`
- `ZeroToHero/datasets/warehouse-picking.html`
- `ZeroToHero/projects/index.html`
- `ZeroToHero/projects/project-01.html`
- `ZeroToHero/modules/00-econometric-mindset.html`
- `ZeroToHero/modules/01-stata-foundations.html`
- `ZeroToHero/modules/02-ols-intuition.html`
- `assets/css/site.css`
- `assets/js/site.js`

Other AI contributions
- None recorded in this log entry.

Entry: 2025-01-15 (cont)
Author: Codex (GPT-5)
Scope: Added ScriptLibrary section with reusable Stata scripts.
Summary
- Added a ScriptLibrary section with index and per-script pages.
- Created a starter set of 15 single-task Stata scripts with matching documentation.
- Added script search, filter, and metadata loading in the site JS.
- Added styling for script cards, tags, and filters.
- Wired Scripts navigation across site pages and added a root card.

Files created
- `ScriptLibrary/index.html`
- `ScriptLibrary/script.html`
- `ScriptLibrary/scripts.json`
- `ScriptLibrary/content/project-setup-log.md`
- `ScriptLibrary/content/import-csv.md`
- `ScriptLibrary/content/import-excel.md`
- `ScriptLibrary/content/standardize-variable-names.md`
- `ScriptLibrary/content/missingness-report.md`
- `ScriptLibrary/content/encode-categorical.md`
- `ScriptLibrary/content/group-summaries.md`
- `ScriptLibrary/content/merge-1-1.md`
- `ScriptLibrary/content/append-files.md`
- `ScriptLibrary/content/reshape-wide-long.md`
- `ScriptLibrary/content/panel-setup.md`
- `ScriptLibrary/content/ols-robust-diagnostics.md`
- `ScriptLibrary/content/logit-margins.md`
- `ScriptLibrary/content/poisson-nb-overdispersion.md`
- `ScriptLibrary/content/loop-acs-hhi.md`
- `ScriptLibrary/content/export-regression-table.md`
- `ScriptLibrary/scripts/project-setup-log.do`
- `ScriptLibrary/scripts/import-csv.do`
- `ScriptLibrary/scripts/import-excel.do`
- `ScriptLibrary/scripts/standardize-variable-names.do`
- `ScriptLibrary/scripts/missingness-report.do`
- `ScriptLibrary/scripts/encode-categorical.do`
- `ScriptLibrary/scripts/group-summaries.do`
- `ScriptLibrary/scripts/merge-1-1.do`
- `ScriptLibrary/scripts/append-files.do`
- `ScriptLibrary/scripts/reshape-wide-long.do`
- `ScriptLibrary/scripts/panel-setup.do`
- `ScriptLibrary/scripts/ols-robust-diagnostics.do`
- `ScriptLibrary/scripts/logit-margins.do`
- `ScriptLibrary/scripts/poisson-nb-overdispersion.do`
- `ScriptLibrary/scripts/loop-acs-hhi.do`
- `ScriptLibrary/scripts/export-regression-table.do`

Files modified
- `assets/js/site.js`
- `assets/css/site.css`
- `index.html`
- `ZeroToHero/index.html`
- `ZeroToHero/modules/00-econometric-mindset.html`
- `ZeroToHero/modules/01-stata-foundations.html`
- `ZeroToHero/modules/02-ols-intuition.html`
- `ZeroToHero/modules/03-limited-outcomes.html`
- `ZeroToHero/datasets/index.html`
- `ZeroToHero/datasets/coffee-chain.html`
- `ZeroToHero/datasets/warehouse-picking.html`
- `ZeroToHero/datasets/fulfillment-delays.html`
- `ZeroToHero/projects/index.html`
- `ZeroToHero/projects/project-01.html`
- `ZeroToHero/projects/project-02.html`
- `STATAForBusiness/index.html`
- `STATAForBusiness/modules/00-foundations.html`
- `STATAForBusiness/modules/01-linear-regression.html`

Other AI contributions
- None recorded in this log entry.

Entry: 2025-01-15 (cont)
Author: Codex (GPT-5)
Scope: Added author branding and profile section.
Summary
- Added an About section with profile photo, bio, credentials, and focus areas.
- Linked to Fixed Point and ianhelfrich.com.
- Added Scripts and About links to the main navigation and updated the footer.
- Added profile styles.

Files created
- `assets/img/ian-helfrich.png`

Files modified
- `index.html`
- `assets/css/site.css`

Entry: 2025-01-15 (cont)
Author: Codex (GPT-5)
Scope: Branding palette update, search, and workspace tooling.
Summary
- Updated the global color palette to match Fixed Point accents.
- Added a math glyph motif in the homepage hero.
- Built a site-wide search page with a generated search index.
- Added a local-first Workspace page for profiles and note export/import.
- Added a service worker for offline caching.
- Added a build script to regenerate the search index.

Files created
- `Search/index.html`
- `Workspace/index.html`
- `assets/data/site-index.json`
- `service-worker.js`
- `tools/build_site_index.py`

Files modified
- `assets/css/site.css`
- `assets/js/site.js`
- `index.html`
- Various navigation headers across HTML pages

Other AI contributions
- None recorded in this log entry.

Entry: 2025-01-15 (cont)
Author: Codex (GPT-5)
Scope: Remove course references, expand script library depth, add builder.
Summary
- Removed course-number references across the site and search index.
- Expanded ScriptLibrary scripts with deeper code, options, and related concepts.
- Added 10 advanced scripts for cleaning, panel, and causal workflows.
- Added a Script Builder page with drag/drop ordering and combined .do export.
- Updated search index to include Script Builder.

Files created
- `ScriptLibrary/builder.html`
- New scripts under `ScriptLibrary/scripts/` and docs under `ScriptLibrary/content/`

Files modified
- `ScriptLibrary/scripts.json`
- `ScriptLibrary/index.html`
- `ScriptLibrary/script.html`
- `assets/js/site.js`
- `assets/css/site.css`
- `tools/build_site_index.py`
- `assets/data/site-index.json`
- `index.html`
- `STATAForBusiness/index.html`
- `STATAForBusiness/modules/00-foundations.html`
- `STATAForBusiness/modules/01-linear-regression.html`
- `README.md`

Other AI contributions
- None recorded in this log entry.

Entry: 2026-01-15
Author: Codex (GPT-5)
Scope: Add Topics Map and Reading Library; update navigation and search index.
Summary
- Added Topics Map page with a structured econometrics topic catalog and Script Library links.
- Added Reading Library page with book references, a topic-to-reading map, and curated papers.
- Linked Topics/Readings in global navigation and added new cards on the homepage.
- Regenerated the site search index to include the new pages.

Files created
- `Topics/index.html`
- `Topics/content/topics.md`
- `Readings/index.html`
- `Readings/content/reading-list.md`

Files modified
- `index.html`
- `tools/build_site_index.py`
- `assets/data/site-index.json`
- Various navigation headers across HTML pages

Other AI contributions
- None recorded in this log entry.

Entry: 2026-01-15
Author: Codex (GPT-5)
Scope: Remove course references, fix math rendering, surface Code Library in site navigation.
Summary
- Removed course-specific references from CodeLibrary documentation and pages.
- Updated ZeroToHero math delimiters for reliable KaTeX rendering in markdown.
- Added Code Library to global navigation and homepage, plus search index updates.
- Refined Code Library layout to match site styling and curriculum framing.

Files modified
- `CodeLibrary/index.html`
- `CodeLibrary/README.md`
- `CodeLibrary/INNOVATION_SUMMARY.md`
- `CodeLibrary/MASTER_ARCHITECTURE.md`
- `CodeLibrary/TRANSFORMATION_SUMMARY.md`
- `CodeLibrary/scripts/02_method_decision_tree_v2.do`
- `ZeroToHero/content/00-econometric-mindset.md`
- `ZeroToHero/content/02-ols-intuition.md`
- `ZeroToHero/content/03-limited-outcomes.md`
- `tools/build_site_index.py`
- `assets/data/site-index.json`
- `index.html`
- Various navigation headers across HTML pages

Other AI contributions
- None recorded in this log entry.

Entry: 2026-01-15
Author: Codex (GPT-5)
Scope: Add Method Lab interactive decision engine and site wiring.
Summary
- Added Method Lab wizard that recommends methods, Stata snippets, and diagnostics.
- Wired Method Lab into global navigation, homepage paths, and site search index.
- Added Method Lab data catalog and styling support.

Files created
- `MethodLab/index.html`
- `assets/data/method-lab.json`

Files modified
- `assets/js/site.js`
- `assets/css/site.css`
- `index.html`
- `tools/build_site_index.py`
- `assets/data/site-index.json`
- Various navigation headers across HTML pages

Other AI contributions
- None recorded in this log entry.

Entry: 2026-01-15
Author: Codex (GPT-5)
Scope: Normalize navigation and fix Code Library doc links.
Summary
- Standardized global navigation order across all pages.
- Added HTML wrappers for Code Library documentation (architecture, innovation, transformation).
- Updated Code Library index to link to rendered docs instead of raw markdown.
- Extended site search index with new Code Library documentation pages.

Files created
- `CodeLibrary/architecture.html`
- `CodeLibrary/innovation.html`
- `CodeLibrary/transformation.html`

Files modified
- `CodeLibrary/index.html`
- `assets/data/site-index.json`
- `tools/build_site_index.py`
- Various navigation headers across HTML pages

Other AI contributions
- None recorded in this log entry.

Entry: 2026-01-15
Author: Codex (GPT-5)
Scope: Reduce marketing tone and tighten copy voice across core pages.
Summary
- Rewrote homepage, Code Library, and Method Lab copy to be direct and less promotional.
- Removed emoji-heavy headings and hype language from Code Library docs.
- Cleaned Readings intro and README phrasing for a more natural voice.

Files modified
- `index.html`
- `CodeLibrary/index.html`
- `CodeLibrary/README.md`
- `CodeLibrary/INNOVATION_SUMMARY.md`
- `CodeLibrary/MASTER_ARCHITECTURE.md`
- `CodeLibrary/TRANSFORMATION_SUMMARY.md`
- `CodeLibrary/transformation.html`
- `MethodLab/index.html`
- `Readings/content/reading-list.md`
- `README.md`

Other AI contributions
- None recorded in this log entry.
