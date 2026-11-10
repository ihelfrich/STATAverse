# Browser runtime expansion and three new courses

Requested by Dr. Helfrich on 9 November 2026. Written by Claude Code on branch `claude/runtime-and-courses-spec`. This is a design for review. It changes no engine, curriculum or site-integration code, and nothing in it is built yet.

It continues [the student learning overhaul](overhaul-plan.md) and [browser runtime development](browser-runtime-plan.md). The licence and feasibility conclusions in the second document stand and are not reopened here: no StataCorp binary, recovered code or licensed resource is published, and all execution stays in the student's browser.

## Intent

A student should be able to open `/learn/stata/`, type or paste the kind of do-file an econometrics course actually assigns, and watch it run with numbers that agree with installed Stata. Today that works for a narrow path: about 45 commands, roughly nine expression functions, OLS with conventional and HC1 covariance, two graph types. A student who types `bysort id: gen t = _n`, `merge 1:1 id using wages`, `logit`, `xtreg, fe` or `twoway (scatter y x) (lfit y x)` is told to go and buy Stata. The teaching material around the interpreter is already more ambitious than the interpreter. The 38 do-files in this repository, the method templates and the do-file builder's output all need installed Stata to run.

The work has two parts that depend on each other. The first widens the runtime until the site's own library runs in the browser. The second adds three courses that use what the wider runtime makes possible. Courses are released as the runtime stages they need are verified, so neither part waits for the whole of the other.

## Goals

1. The repository's own do-files become the acceptance corpus. Coverage is the share of their command lines that run in the browser with results matching native Stata. Stage 0 measures the baseline. The provisional target is 90 percent of corpus command lines by the end of stage 4; that number is my proposal, to be reset once the baseline exists.
2. Every released command has declared syntax, native fixtures, source-located errors and resource limits, as the existing families do.
3. Existing students lose nothing: routes, saved work, lesson progress, backups and offline use keep working through every release.
4. Three new courses, each of twelve lessons with a capstone, built on the existing step format and checked in native Stata.

## Non-goals

- Mata, plugins, shell commands, Python and Java integration.
- Installing arbitrary user-written packages. `ssc install` and `net install` stop with an explanation. A small number of widely used community commands may be reimplemented natively under their familiar names (see stage 3).
- `sem`, `gsem`, `mixed`, `bayes`, `svy`, multiple imputation and dialog boxes.
- Reproducing SMCL markup or the exact pixel layout of Stata graphs.
- Accounts, a server, telemetry or any remote execution.

## Anti-goals

These would make the result a failure even if the features exist.

- Output for an option the runtime does not implement. An unrecognised or unimplemented option stops the command with return code 198 and a hint. It is never ignored.
- A number that differs from Stata's beyond the stated tolerance without the result saying so.
- Saved work that fails to load, or replays to different data, after an update.
- A public claim of Stata compatibility stated as anything other than the measured corpus coverage and the list of supported commands.

## Constraints that are fixed

| Contract | Current value | Rule |
| --- | --- | --- |
| Public routes | 36 HTML routes under `/learn/stata/`, plus the legacy `/STATAverse/` bridge | No route is removed or renamed. New pages are added. |
| Lesson identity | Lesson IDs and step positions in `src/lessons.js` and its imports | Existing IDs and positions never change. New lessons get new IDs. |
| Storage keys | `stataverse:practice:v2` (internal schema 3), `stataverse:labs:v1`, `stataverse:do-builder:v1`, `stataverse:progress:*`, `stataverse:user*` | Keys keep their meaning. New state gets new keys. |
| Backups | Workspace backup versions 2 to 4 | All remain importable. |
| Worker protocol | `PRACTICE_PROTOCOL = 2` | Unchanged for the existing Practice page until stage 5. |
| Offline core | 600,000 bytes gzip (553,339 at the last release) | The limit stays. New families load on demand and are cached after first use. |
| Service worker | Scoped to `/learn/stata/` | Scope unchanged. Cache names keep carrying the release identity. |
| Release path | Main site builds from the commit pinned in `config/stataverse.json` | Unchanged. Rolling back is reverting the pin. |

Two properties of the current code shape the migration and are easy to miss.

`validateStore` in `src/persistence.js` copies only the lessons named in the running release's `LESSON_CATALOG`. A browser that briefly runs an older cached release against a store written by a newer one will rewrite the store without the newer lessons' progress. Adding courses to the existing store would therefore make a rollback destructive. New course progress goes in a new key (`stataverse:courses:v1`) that older releases never touch.

Saved sessions are restored by replaying their command history through the interpreter. Any change to the meaning of an existing command changes what an old session replays to. Stata's default `float` storage is the clearest case: adopting it is necessary for fidelity (`generate x = 0.1` followed by `count if x == 0.1` returns zero in Stata, and students need to meet that), but it would alter replayed values in sessions saved under the present double-only arithmetic.

## The decision: one independent runtime, with the old engine frozen for replay

The current `src/engine.js` is frozen as the legacy engine. It keeps serving every session saved before the new runtime and keeps its tests and fixtures. A new runtime is written beside it under `src/runtime/`. Each saved session records which runtime created it and is always replayed by that one. New sessions use the new runtime once it reaches parity on the legacy fixtures, with intended differences listed explicitly (float storage is one). This is my call, made to keep the "nothing breaks" promise checkable instead of aspirational.

Alternatives I rejected:

- **Keep adding cases to `engine.js`.** It is a single 1,162-line dispatcher with command parsing, data and output in one place. Weights, `by`, storage types and stored results each cut across every command, so they cannot be added one command at a time.
- **R or Python compiled to WebAssembly as the numerical kernel.** It would bring many estimators at once. It would also bring a download measured in tens of megabytes against a 600 KB offline budget, slow starts on phones, and finite-sample conventions that differ from Stata's in exactly the places students compare output (cluster corrections, random-effects variance components, iteration paths). Every estimator would still need native fixtures, so the kernel saves less than it appears to.
- **Porting the Stata executable.** Settled in the existing runtime document.

## Runtime architecture

What follows is the shape; names inside `src/runtime/` are the builder's to settle.

**Command grammar.** One parser turns a line into prefixes, command, varlist or other leading argument, `=exp`, `if`, `in`, weights, `using` and options, with Stata's minimum abbreviations for commands, options and variable names. Each command declares its own syntax, and the parser rejects anything outside it before the command runs.

**Macros and programs.** Extends `src/stata-program.js`: globals, compound double quotes, `=exp` evaluation, the commonly used extended macro functions (`word count`, `word # of`, `variable label`, `type`, `list` operations, `display` formats), `while`, `continue`, `program define` with `args` and a documented subset of `syntax`, `tempvar`, `tempname`, `tempfile`, scalars, and `return`, `ereturn` and `sreturn` with `r()`, `e()` and `s()` readable in expressions. Local scope follows Stata's rules per program and per do-file run.

**Data store.** Columnar typed storage with Stata's storage types (`byte`, `int`, `long`, `float`, `double`, `str#`, `strL`), display formats, variable and value labels, notes, the 27 missing values with their ordering, the recorded sort order, and multiple frames. `float` variables are held at single precision so comparisons behave as they do in Stata.

**Expressions.** The existing compiler grows from nine functions to the set students meet: `cond`, `max`, `min`, `int`, `floor`, `ceil`, `mod`, `sum`, `runiform`, `rnormal` and the other common generators, string functions including `substr`, `strpos`, `subinstr`, `strtrim`, `upper`, `lower`, `length`, `real`, `string`, `regexm` and `regexs`, date functions including `date`, `mdy`, `year`, `month`, `day`, `dow`, `ym`, `yq` and the `td()` family, plus subscripts (`x[_n-1]`) and time-series operators once `tsset` or `xtset` is declared. Random draws use a documented generator and seed. Matching Stata's `mt64` stream is a goal to investigate, not a commitment; until it is verified, results that depend on draws are labelled as reproducible within the site only.

**Files.** A virtual folder in IndexedDB, visible to the student, backs `cd`, `pwd`, `dir`, `use`, `save`, `import delimited`, `export delimited`, `import excel`, `log using` and `tempfile`. `.dta` reading and writing are implemented from the published format description. Session data moves out of the 4 MB localStorage store for new-runtime sessions; the old store is left as it is.

**Results.** Every command returns a structured result that renders two ways: the existing rich view, and plain text laid out like Stata's Results window so that a saved log reads like a Stata log.

**Estimation.** A shared layer builds the model frame (factor variables, operators, `if`/`in`, weights, casewise deletion), fits by least squares or by Newton–Raphson with a visible iteration log, and produces a common `e()` object. Covariance is a separate module: conventional, `robust`, `vce(cluster)` with Stata's finite-sample factors, `bootstrap` and `jackknife`. Post-estimation commands read only the common object, so `predict`, `test`, `lincom`, `nlcom`, `margins`, `estimates store` and table commands work for every estimator without per-model code.

**Graphics.** A `twoway` specification (plot types, `||` and parenthesised overlays, `by()`, axis and title options, a small set of schemes) rendered to SVG with PNG and SVG export. The two existing chart types keep their current rendering on the existing pages.

**Execution.** The cancellable worker and its on-page fallback are kept. Each estimator family and the graphics grammar are separate chunks fetched the first time a command needs them and cached for offline use from then on. A command that needs an uncached chunk while offline says so.

## Stages

Each stage ends in a public release through the pinned commit, with its own verification receipt. A stage is done when its commands pass native fixtures, the legacy suite still passes untouched, the offline budget holds and the corpus coverage number is recorded.

**Stage 0. Baseline and safety net.**
- A corpus tool that classifies every command line in the repository's do-files as verified, running but unverified, or unsupported, and reports coverage by command.
- A differential harness that runs every existing fixture and a set of recorded saved sessions through both engines and reports any difference.
- The legacy engine moved behind a stable interface without behavioural change.
- The intermittent public navigation and search failures recorded on 7 November reproduced and either fixed or documented with a cause. Nothing larger should be released on top of an unexplained fault.

**Stage 1. Language and data core.** Grammar, macros, programs, store, expression library, `by` and `bysort`, and the existing commands reimplemented on the new core. Released on a new page, `Console/`, a full-height do-file editor with Results, Variables, Data and Files panes. The existing Practice page is untouched.

**Stage 2. Data commands and files.** `merge`, `append`, `reshape`, `joinby`, `expand`, `fillin`, `contract`, `statsby`, `recode`, `encode`, `decode`, `destring`, `tostring`, `split`, `xtile`, `egen`'s common functions, `order`, `format`, `notes`, `compress`, `frames`, `use`, `save`, the import and export commands, `log`. The merge and reshape logic comes from `src/labs/data-model.js`, which already has 32 native cases. Also `tabstat`, `table` in its basic forms, two-way `tabulate` with `chi2`, `ttest`, `prtest`, `pwcorr`, `ci`. Course 1 is released with this stage.

**Stage 3. Estimation contract, tables and graphics.** The estimation layer with `regress` moved onto it, weights, clustered covariance, the post-estimation commands, `estimates store` and `estimates table`, an `esttab`-compatible table command (reimplemented, since the original depends on Mata), `margins` and `marginsplot` for linear and index models, and the `twoway` grammar with `graph bar`, `graph box`, `kdensity` and `lowess`.

**Stage 4. Estimator families.** In this order, each as its own chunk and its own release:
1. `logit`, `probit`, `poisson`, `nbreg`, `ologit`, `oprobit`, `mlogit`, `tobit`.
2. `xtset`, `tsset`, `xtsum`, `xtreg` (`fe`, `re`, `be`), `areg`, a `reghdfe`-compatible absorbing estimator for multiple fixed effects, `hausman`, `newey`.
3. `ivregress` (`2sls`, `liml`, `gmm`) with `estat firststage`, `estat overid` and `estat endogenous`, built from `src/labs/iv-model.js`.
4. `bootstrap`, `simulate`, `permute`, `didregress` and `xtdidregress` in their two-way fixed-effects forms.
5. If demand justifies it: `teffects ra`, `ipw` and `nnmatch`; `stset`, `sts` and `stcox`; `qreg`; `arima`.

Course 2 is released after families 1 and 2. Course 3 is released after families 3 and 4.

**Stage 5. Practice moves to the new runtime.** New Practice sessions use it; legacy sessions keep replaying on the frozen engine. The legacy engine stays in the package as an on-demand chunk until a later, separate decision to retire it.

## Verification

The existing method is kept and extended, because it is what has made the current subset trustworthy.

- Each command gets a fixture file of constructed cases run in installed Stata (the existing fixtures declare `version 17`), comparing values, missingness, stored results and return codes at the tolerances in [the numerical contract](numerical-contract.md). Estimators also get an independent R reference where one exists.
- Fixtures cover combinations, since that is where an interpreter goes wrong: each command with `if`, `in`, `by`, weights, missing values, string and numeric keys, empty samples and abbreviations.
- The numerical contract gains a section per stage. The capability record in `docs/verification/browser-capabilities.json` is replaced by the corpus coverage report.
- Browser checks cover the Console on desktop and phone widths, keyboard use, offline first use of a cached and an uncached chunk, cancellation inside a long estimation, and storage failure.
- Each release repeats the public checks against the deployed pin. A local pass is not treated as publication.
- The native `import delimited` limitation on this machine (Java) remains; those fixtures continue to substitute explicit data setup and say so.

## Courses

All three use the existing `step()` format: a prediction or question, a command to run, a check on the actual result, two-stage help, and at least one deliberately flawed draft per lesson. Every canonical lesson sequence is checked by `tools/check-curriculum-native.mjs`. Data are synthetic, generated from a documented process shipped with the course, so a student can set an estimate beside the value that produced the data. Each lesson is 15 to 25 minutes. Each capstone exports a complete Stata project.

New lessons take ID prefixes `dw-`, `rb-` and `ci-`. They appear as three additional tracks beside the four existing ones and are stored under `stataverse:courses:v1`.

### Course 1. Data work and reproducible workflow

For the student who can run a regression on a clean file and has never been handed a dirty one. Beginner to intermediate. Requires stage 2.

1. A project that runs from one do-file: folders, relative paths, `log`, `version`.
2. Reading raw files: delimiters, header rows, identifiers with leading zeros, `import excel`.
3. Storage types and precision: why `x == 0.1` fails, `compress`, when to use `double`.
4. Strings: trimming, case, `substr`, `split`, `destring` and what it refuses to convert.
5. Dates: string to daily date, formats, monthly and quarterly dates, durations.
6. Missing values: extended codes, missing in comparisons, sentinel values such as -99.
7. Labels and categories: `encode`, `decode`, `recode`, value labels that survive a merge.
8. Working within groups: `bysort`, `_n` and `_N`, first and last records, running totals.
9. Combining files I: `merge 1:1` and `m:1`, reading `_merge`, duplicate keys.
10. Combining files II: `append`, `reshape` in both directions, choosing the unit of observation.
11. Automating: loops over variables and files, a small program with `syntax`, `tempfile`.
12. Checking and reporting: `assert`, `isid`, `codebook`, summary tables written to a file.

Capstone: three raw files from a fictional clinic network (visits, patients, sites) with realistic defects become one documented analysis file. The check compares the student's final data with the reference on keys, counts and a set of totals.

### Course 2. Regression beyond OLS

For the student in a second econometrics course, which is where most tutoring requests arrive. Intermediate. Requires stage 4, families 1 and 2.

1. From coefficients to predictions: `margins` and `marginsplot` after OLS with interactions.
2. The linear probability model: what it estimates, fitted values outside the unit interval, robust errors.
3. Logit and probit: the index, likelihood iterations, why the two sets of coefficients differ by a scale.
4. Marginal effects: at the means, averaged over the sample, for interactions.
5. Counts: Poisson, exposure, overdispersion, negative binomial.
6. Ordered and multinomial outcomes: cut points, base categories, predicted probabilities.
7. Censoring and corner solutions: `tobit` and what its coefficients describe.
8. Panel structure: `xtset`, within and between variation, `xtsum`.
9. Fixed effects: the within transformation by hand, `xtreg, fe`, `areg`, what is absorbed.
10. Random effects and the Hausman comparison, with its conditions.
11. Clustering: the level of dependence, few clusters, a comparison with the existing inference lab.
12. Time: lags, differences, serial correlation, `newey`, a first forecast.

Capstone: a firm-by-year panel in which the student chooses and defends a specification for a binary investment decision, reports average marginal effects and shows how the conclusion moves with the treatment of unit effects.

### Course 3. Causal inference and program evaluation

For the student writing an empirical paper or preparing for policy work. Advanced. Requires stage 4, families 3 and 4.

1. Potential outcomes and the experimental benchmark: difference in means, randomization inference with `permute`.
2. Regression adjustment in experiments: precision, balance tables, stratified assignment.
3. Selection on observables: what conditioning assumes, overlap, an omitted confounder made visible.
4. Bad controls: mediators and colliders, shown by simulation with known truth.
5. Weighting and matching: propensity scores, weight diagnostics, comparison with regression adjustment.
6. Instrumental variables: compliers, the Wald ratio, the first stage. Uses the existing IV lab.
7. Weak instruments: Anderson–Rubin sets, what the first-stage F does and does not show.
8. Difference in differences: the two-by-two case, parallel trends, pre-period checks.
9. Staggered adoption: why two-way fixed effects can mislead when effects vary, group-time effects.
10. Event studies: leads and lags, the reference period, reading the pre-trend coefficients.
11. Regression discontinuity: local linear fits, bandwidth, the density of the running variable.
12. Inference and credibility: clustering by assignment, few treated groups, a specification curve.

Capstone: a replication exercise on a synthetic policy rollout with staggered timing, where the naive estimate has the wrong sign and the student has to find out why.

Lessons 9 and 11 rest on estimators that are community packages in Stata (`csdid`, `did_imputation`, `rdrobust`). The browser will not pretend to run those. Each of the two lessons gets a visual lab in the manner of the existing IV lab, computing the group-time effects and the local linear fit directly, checked against the native packages, and exporting a do-file that calls them in installed Stata. Two new labs are therefore part of this course.

## Rollout and rollback

Stages 1 to 4 add pages, chunks and keys; they do not alter what existing pages load. Reverting the pin restores the previous release, and because new state lives under new keys, an older release ignores it without damaging it. Stage 5 is the only step that changes an existing page's behaviour, and it leaves the legacy engine in place for old sessions. The service worker's cache name changes with each release as it does now.

## Left to the builder

Module boundaries inside `src/runtime/`; the linear-algebra routines (keep `ml-matrix` or replace it); the SVG renderer's internals; chunk sizes within the offline budget; the layout of the Console; fixture organisation; the wording of error hints; the data-generating processes for course data, subject to the rule that they are synthetic and documented.

## Decisions that are Dr. Helfrich's

1. **Who builds it, and on what budget.** The Codex thread that ran the overhaul holds the open Agent Log entry and knows this code. The work is at least as large as that overhaul.
2. **`sysuse`.** Students will type `sysuse auto`. The dataset belongs to StataCorp and I do not propose shipping it. The default in this spec is that `sysuse` lists the site's own datasets and explains the difference. The alternative is a synthetic stand-in under the same name, which would run familiar tutorials and give different numbers from every textbook.
3. **Course order.** The spec releases data work first because it depends on the earliest stage and serves the widest audience. If the causal course matters more for the job-market season, the IV and difference-in-differences families can move ahead of the nonlinear ones at some cost to Course 2's date.
4. **The coverage target.** Ninety percent of corpus lines is a placeholder until stage 0 reports the baseline.

## Progress, 9 November 2026

Stage 0 has its coverage tool and baseline: `tools/corpus-coverage.mjs` and `docs/verification/corpus-coverage.json`. The differential harness, the frozen-engine interface and the investigation of the intermittent navigation failures are not done.

Before the new runtime exists, four sets of commands were added to the current interpreter because they are purely additive: no existing command changed its results, so saved sessions replay as before and the freeze rule above is not broken. They are expression functions and subscripts; `by` and `bysort` for `generate`, `replace`, `egen`, `summarize` and `count`; `tabstat` and `version`; and `test` and `lincom` after `regress`. Each was compared with installed Stata (129 cases in `tests/fixtures/stata-functions.json`) and is described in [the numerical contract](numerical-contract.md). Name-level corpus coverage, setting `display` aside, moved from 68.3 to 72.3 percent.

One change does touch existing behavior in a way that cannot alter results: `generate` and `replace` now evaluate one observation at a time. Without subscripts, which did not exist before, the order of evaluation is unobservable.

These additions raise the cost of the later migration, since the new runtime must reproduce them too. That is the reason to stop adding to the old interpreter once the grammar and data store of stage 1 begin. The core offline package is at 561,451 gzip bytes of its 600,000 limit, so further families need the on-demand loading described above before they ship.

What the corpus still asks for, by number of command lines: `estat` 16, `estimates` 13, `graph` 13, `margins` 12, `ivregress` 11, `save` 10, `use` 9, `xtreg` 9, `log` 8, `xtset` 8, `mkdir` 7, `marginsplot` 6, `logit` 5, `encode` 4, `expand` 4, `format` 4. Those sixteen account for 139 of the 188 lines whose command is not implemented. The list orders the stage 3 and stage 4 work by what the site's own teaching code uses: stored estimates and `estat`, `margins` and `marginsplot`, the graph grammar, `ivregress`, the panel commands, and `use`, `save` and `log` from stage 2.

## Progress, 10 November 2026

Dr. Helfrich approved starting stage 1 in the Claude session. The first part is in `src/runtime/`: the command grammar (`syntax.js`, with `varlist.js` and `numlist.js`), values and storage types (`values.js`) and the typed dataset (`store.js`). They are described, with their evidence and its limits, in [the numerical contract](numerical-contract.md#new-runtime-command-grammar-and-storage-types). Nothing the site serves imports them, so the release is unchanged and the offline package is the same size.

The grammar reimplements Stata's `syntax` command instead of inventing a declaration format. That choice serves two parts of this spec at once: built-in commands declare their syntax in notation that installed Stata can check line for line, and `program define` gets `syntax` from the same code.

Stage 1 still needs, in the order I would build them: the expression compiler on the new values (extended missing values, storage-aware results, the functions already in the old interpreter); display formats and the plain-text results layout; macros and programs on `src/stata-program.js`; the existing commands declared and reimplemented on the store; and the `Console/` page. The stage 0 items that remain (the differential harness and the frozen-engine interface) are needed before the first command is reimplemented, since that is when there are two engines to compare.

### Later on 10 November 2026

A second session built most of the rest of stage 1 and reached into stages 2 to 4. The numerical contract lists what exists and how each part was checked; the short version follows.

- **Built and checked against installed Stata:** the expression compiler and about 130 functions; display formats; do-file control flow, macros and programs; 60 commands for data work; `save`, `use`, `append`, `merge` and `reshape` on a folder held in the session; the reporting commands with their printed layout; `regress`, `logit`, `probit`, `poisson`, `ivregress 2sls` and `xtreg` with `predict`, `test`, `lincom`, `estat` and `estimates`.
- **The differential harness of stage 0** exists as `tools/differential.mjs` with a standing test.
- **The Console page** exists at `Console/` and is packaged with the site, but nothing links to it. Linking it is the release decision for stage 1 and is left to Dr. Helfrich.
- **Coverage of the corpus by command name** is 90.0 percent with `display` set aside. What remains, by lines: `graph` 13, `margins` 12, `import` 10, `marginsplot` 6, `twoway` 4, then single lines.

What stage 1 still lacks before the Console should be linked: `codebook`; the frozen-engine interface; and a second model's review of the new code. The Console already runs in a worker that can be stopped. The estimation commands were written as separate fitters that leave one shared result object. Stage 3's shared model frame (interactions, weights, a common covariance module) has not been built, and `regress`, the likelihood fitter and `xtreg` each carry their own copy of the sandwich calculation until it is.

A first set of graphs (`scatter`, `line`, `histogram` and `twoway` overlays with `lfit`) is drawn as SVG and shown in the Console. What follows, in order: `margins`, the remaining graph types and options, then files a student brings (`import delimited`, `.dta`).

