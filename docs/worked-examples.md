# Worked Stata examples

`CodeLibrary/` reads the seven existing do-files in the browser. Each file has a section outline, literal source search, line bookmarks, a relevant practice prerequisite and a browser-lab companion. The source remains a complete native Stata program: the reader does not execute panel estimators, macros or loops. Copy and download retain the complete verified file because later sections can depend on earlier data and local macros.

## Source ownership and version checks

The do-files in `CodeLibrary/scripts/` are canonical. `assets/data/worked-examples.json` supplies student titles, section explanations, prerequisites and interpretation questions. `src/worked-examples.js` divides the actual source at its headings. The build rejects a changed section count and generates `src/worked-example-hashes.js` from the source bytes. The generated catalog preserves useful downloads without JavaScript.

`src/worked-reader.js` fetches only catalogued files, bounds each response at 200,000 bytes and verifies its SHA-256 before enabling the source, copy or download controls. An outdated cached file produces a recoverable error instead of a plausible but mismatched example. Reference estimates must have the same source hash. A failed estimate fetch leaves the verified source usable. Navigation cancels prior requests, and late responses cannot replace a newly selected example or restore an old clipboard fallback.

The service worker caches the reader shell and caches individual files when visited. An unopened file is unavailable offline. A newly selected section URL can reopen the cached shell without having requested that exact query before. Search results expose both complete examples and specific guided panel sections. The reader adds no persistent progress record: its eight panel checks retain choices during the current page session and explicitly reset on reload.

## Panel example correction

The previous within-between section used unrestricted firm fixed effects while including firm-mean regressors. Native Stata omitted the means, giving zero coefficients and standard errors, although the accompanying text described estimated between effects. `docs/verification/panel-original-findings.json` records the reproduced omission against the original source hash.

The revised static example constructs 200 independent firms observed for ten years, a time-invariant firm component correlated with experience, and serially correlated errors independent of the full regressor histories. It compares pooled, FE and RE fits with common year effects. The within-between model decomposes every time-varying regressor and uses RE so that firm means remain estimable. Its within slopes agree with FE in this balanced linear specification; its between slopes can retain confounding. The agreement is an algebraic comparison, not evidence for exogeneity.

The clustering explanation now follows the simulated dependence structure. GEE retains its conditional-mean requirement, and the mixed-model ICC is described as a working variance decomposition. A separate dynamic sample illustrates built-in `xtabond`, bounded lag instruments and residual autocorrelation checks. It preserves and restores the static data. The reporting section prints actual fitted comparisons and a computed interval instead of placeholder significance claims.

The relevant primary references are Stata's [xtreg manual](https://www.stata.com/manuals/xtxtreg.pdf), [xtgee manual](https://www.stata.com/manuals/xtxtgee.pdf) and [xtabond manual](https://www.stata.com/manuals/xtxtabond.pdf). In particular, the within transformation removes time-invariant regressors, and a dynamic-panel residual test cannot certify instrument validity.

## Verification and maintenance

Run `node tools/check-panel-native.mjs` after changing the panel program. The runner executes the complete file in native Stata, checks restored data and identifiers, verifies centered within deviations, compares FE slopes against explicit firm/year indicators, checks the within-between equality and estimable between coefficients, and exercises the joint restriction and dynamic fit. It writes the public receipt `docs/verification/panel-native.json` and the 17 coefficient/standard-error records in `assets/data/panel-output.json`; private raw logs remain outside the repository. The build refuses panel reference results whose source hash no longer matches.

Five unit tests cover source partitioning, hashes, literal search, addresses, native reference consistency and question/catalog structure. Twenty desktop/mobile browser cases cover every example, all eight interpretation checks, keyboard focus, history, exports, failed clipboard access, offline recovery, mismatched source/results, delayed responses and no-script access. Integrated-site checks separately cover the deployed subdirectory, app and main-site search, offline reading and exact downloads.

These checks establish the stated constructed examples and observed interface behavior. They do not establish Monte Carlo properties, a valid empirical research design, full Stata execution in the browser or classroom effectiveness. The other six older do-files remain available, but their full prose and substantive claims have not yet received the same detailed review as the revised panel file.
