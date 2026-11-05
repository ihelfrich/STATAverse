# Website integration and browser performance

Dr. Helfrich added full integration into `ihelfrich.github.io` and efficient browser execution to the continuing five-million-token overhaul on 5 November 2026 UTC. The canonical destination is `/learn/stata/`. The canonical integration was first published on 5 November 2026 UTC. `docs/verification/public-site.json` records the tested public origin, pinned source and student-flow checks; the full overhaul remains active.

## Source and release ownership

STATAverse remains the source of its practice engine, curriculum, labs and reference material. `npm run package:site` builds a selected static package under `dist/`. The package includes student-facing HTML, scripts, styles, data and vendor notices. It excludes source maps, tests, native execution logs, review screenshots and dependency trees. Its manifest records every file's size and SHA-256 hash, the source commit, and whether the source was dirty.

The main website integration lives in the existing Astro repository. This task's isolated worktree is `/Users/ian/Developer/agent-playground/stataverse-site-integration`, branch `codex/stataverse-site-integration`. `config/stataverse.json` pins a STATAverse commit and the mount path. The website build verifies the package before generating `public/learn/stata/`; this generated directory is ignored by git. There is one edited implementation, rather than an independently maintained copy in each repository.

The build adds canonical URLs and a compact site menu from the website's shared navigation registry. It uses the main site's local typography and color tokens. Teaching, Lab, the project record, the teaching catalogue, the command index, Pagefind, the sitemap and the student map route link to STATAverse. Existing relative lesson URLs remain valid beneath the mount.

## Browser execution and saved work

Practice parsing, statistical calculations, imports, exports and task checks run locally in the browser. Repeated-sampling simulation runs in a cancellable worker. No account, remote execution service, model API or licensed Stata server is required for these browser features. Native Stata is still required for the full-language reference workflows.

The practice and investigation storage keys remain unchanged. Legacy reading pages normalize the new mount to their original `/STATAverse/` storage keys; they do not silently create a second set of notes. This preserves work on the same website origin. Work on a different origin, including localhost, still requires an exported backup.

The service worker is scoped to `/learn/stata/`. Its cache name includes that scope and the integrated release identity. It caches the website navigation stylesheet with the core app and never intercepts the site's other routes. Local site fonts outside the app scope can fall back to system fonts offline. Other applications' caches are not searched or deleted.

## Measured payloads and limits

The landing page's three fixed worked examples are calculated during the build using the same practice engine. A numerical test compares the generated values with fresh engine results. The landing script is 4,184 bytes, approximately 2,060 bytes with gzip, down from 166,025 bytes and 51,676 bytes with gzip. Students load the full command editor and engine when they enter Practice. These are asset sizes, not a claim about transfer speed on every network.

Progress-only pages use a compact investigation catalogue instead of loading the task explanations and answer definitions. The practice bundle is approximately 695 KB raw / 223 KB gzip; the Saved work bundle is approximately 157 KB / 51 KB gzip. The IV lab adds 92,208 bytes raw / 34,800 bytes gzip and bounds its rendered scatterplot at 300 points while computing on every observation. The full static package also contains optional reference datasets, a legacy portrait and fonts; those are not all downloaded on each page visit. The current worker pre-caches twenty-four core assets, totaling approximately 1.53 MB raw / 481 KB gzip; that total excludes optional reference data and the main site’s fonts. Further work should measure and refine that policy, legacy image size, stylesheet loading and slower-device responsiveness.

## Verification and remaining publication work

`tools/verify-site-integration.mjs` exercises the assembled website: actual command execution, checked investigations, Saved work, old reading keys, worker scope, offline execution, Teaching navigation, Pagefind results, mobile width, keyboard navigation, targeted accessibility and site links with JavaScript disabled. It records asset sizes in `docs/verification/site-integration.json`. The main site's navigation, discovery, token, copy and rendered-style checks also apply.

The full overhaul remains active. Publication proceeds in two stages. First push the pinned source branch, build and deploy the main website, and verify `/learn/stata/`. Then merge the source release into the project Pages main branch. Its small location bridge forwards all 36 HTML routes to their corresponding canonical paths with the original query and fragment. The replacement worker retires only legacy STATAverse caches and redirects future document navigation; it leaves saved work and other applications’ caches intact. An already open page remains usable until the student navigates or reloads. No DNS or custom-domain change is needed.

`npm run test:legacy` reproduces the transition from the actual v7 worker at commit `c569c03`, checks fresh and returning deep links, preserves a saved note and unrelated caches, and runs canonical practice offline. Its local receipt is `docs/verification/legacy-transition.json`. These checks passed before publication; public release verification is a separate step.

## Verified public release

The canonical site and legacy route were verified on 5 November 2026 UTC. Main-site PRs 22 and 23 deployed source `e67990125dac095fda1f7e764a5a6a0f5ec4cbe8`; source PR 1 activated the legacy bridge at `32adb0b9244b60bf464ba72dbce9f3b8546d5dc7`. The successful GitHub Pages runs and public checks are recorded in `docs/verification/public-release.json` and `docs/verification/public-site.json`. The old homepage reaches the canonical homepage, and deep-link checks preserve encoded query strings and fragments.

The public browser pass executes and checks the first exercise, restores investigation and reading work, uses IV exercises and repeated-sampling simulations offline, and checks shared navigation, search, mobile width and targeted accessibility. Measured public response bodies total 1,528,982 bytes for the 24 core offline assets, or 481,148 bytes when gzipped locally. These are payload sizes rather than observed transfer times. Additional saved IV investigations remain under development and are outside this release.

## Browser programming candidate

The browser-only programming increment adds local macros, foreach, integer forvalues and nested if/else blocks, with a six-step lesson and explicit compatibility limits. Saved work now imports a generated lesson ID/step-count catalogue instead of the full curriculum. Its measured source bundle is about 25.5 KB raw / 9.4 KB gzip; Practice is about 712 KB raw / 230 KB gzip. The source worker advances to v28; the integrated cache also includes the pinned release identity. Public measurements and behavior remain governed by the separate deployment receipt.
