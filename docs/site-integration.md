# Website integration and browser performance

Dr. Helfrich added full integration into `ihelfrich.github.io` and efficient browser execution to the continuing five-million-token overhaul on 5 November 2026 UTC. The canonical destination is `/learn/stata/`. The current integration is a local candidate; it has not been published.

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

Progress-only pages use a compact investigation catalogue instead of loading the task explanations and answer definitions. The practice bundle is approximately 695 KB raw / 223 KB gzip; the Saved work bundle is approximately 157 KB / 51 KB gzip. The IV lab adds 92,208 bytes raw / 34,800 bytes gzip and bounds its rendered scatterplot at 300 points while computing on every observation. The full static package also contains optional reference datasets, a legacy portrait and fonts; those are not all downloaded on each page visit. The current worker pre-caches twenty-three core assets, totaling approximately 1.53 MB raw / 481 KB gzip; that total excludes optional reference data and the main site’s fonts. Further work should measure and refine that policy, legacy image size, stylesheet loading and slower-device responsiveness.

## Verification and remaining publication work

`tools/verify-site-integration.mjs` exercises the assembled website: actual command execution, checked investigations, Saved work, old reading keys, worker scope, offline execution, Teaching navigation, Pagefind results, mobile width, keyboard navigation, targeted accessibility and site links with JavaScript disabled. It records asset sizes in `docs/verification/site-integration.json`. The main site's navigation, discovery, token, copy and rendered-style checks also apply.

The full overhaul remains active. Before publication, the pinned STATAverse commit must exist on GitHub, both reviewed branches must be integrated through the existing release process, and the deployed `/learn/stata/` route must be checked. The former `/STATAverse/` project address requires a verified compatibility deployment or redirect; a root-site file alone must not be assumed to override a separately published GitHub Pages project. Preserve query strings, lesson fragments and local storage when implementing that transition. No DNS or custom-domain change is needed.
