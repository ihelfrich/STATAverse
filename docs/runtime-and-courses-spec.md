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

| Contract        | Current value                                                                                                                               | Rule                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Public routes   | 36 HTML routes under `/learn/stata/`, plus the legacy `/STATAverse/` bridge                                                                 | No route is removed or renamed. New pages are added.                         |
| Lesson identity | Lesson IDs and step positions in `src/lessons.js` and its imports                                                                           | Existing IDs and positions never change. New lessons get new IDs.            |
| Storage keys    | `stataverse:practice:v2` (internal schema 3), `stataverse:labs:v1`, `stataverse:do-builder:v1`, `stataverse:progress:*`, `stataverse:user*` | Keys keep their meaning. New state gets new keys.                            |
| Backups         | Workspace backup versions 2 to 4                                                                                                            | All remain importable.                                                       |
| Worker protocol | `PRACTICE_PROTOCOL = 2`                                                                                                                     | Unchanged for the existing Practice page until stage 5.                      |
| Offline core    | 600,000 bytes gzip (553,339 at the last release)                                                                                            | The limit stays. New families load on demand and are cached after first use. |
| Service worker  | Scoped to `/learn/stata/`                                                                                                                   | Scope unchanged. Cache names keep carrying the release identity.             |
| Release path    | Main site builds from the commit pinned in `config/stataverse.json`                                                                         | Unchanged. Rolling back is reverting the pin.                                |

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
- **Coverage of the corpus by command name** is 96.9 percent with `display` set aside. Running the 38 do-files from the start is the stricter test; `docs/verification/corpus-run.json` lists where each stops. Most that stop are templates that need the reader's own data, eight finish, and the rest stop at something not built (`ivregress, first`, `xtgee`, `nbreg`, `sysuse auto`) or at a deliberate `exit`.

Every command in the 19 lessons now runs the same in the frozen interpreter and the new runtime, apart from the intended effect of `float` storage. What stage 1 still lacks before the Console should be linked: the frozen-engine interface, and a second model's review of the new code. The Console already runs in a worker that can be stopped, and reads a CSV file the student chooses. The estimation commands were written as separate fitters that leave one shared result object. Stage 3's shared model frame (interactions, weights, a common covariance module) has not been built, and `regress`, the likelihood fitter and `xtreg` each carry their own copy of the sandwich calculation until it is.

A first set of graphs (`scatter`, `line`, `histogram` and `twoway` overlays with `lfit`) is drawn as SVG and shown in the Console. `margins`, `marginsplot` and `import delimited` followed the same day. What follows, in order: `matrix` and the commands that read `r()` and `e()` matrices, the remaining graph types and options, `estat` after instrumental variables and logit, then `.dta` files.

### What the randomized comparison changed about the method

The verification section above asks for constructed cases per command. Those were written, and they were not enough. Three generators now produce cases nobody chose: arithmetic and string expressions, short sequences of data commands, nests of loops and conditions, and reports on random data. Each batch is run in installed Stata and recorded like any other fixture, so the tests still run without Stata. Between them they found about a dozen differences that roughly 900 hand-written cases had passed over, among them operator precedence, an inner `if` deciding an outer `else`, and what `by` does when no observations are left.

Two consequences for the stages that follow. A new command family should get a generator as well as written cases before it is called checked. And the frozen interpreter deserves the same treatment once: the comparison precedence error recorded in [the review](red-team-review.md) was found only because the same expressions were run through it.

## Progress note, 10 November 2026: release and the breadth of the Console

Stage 1 was merged (pull request 13) and published with the correction to the live interpreter's comparison precedence. The Console is at `/learn/stata/Console/`, unlinked, marked `noindex`, and left out of the website's sitemap and search index; the website's sitemap now skips any packaged page that declares `noindex`.

Dr. Helfrich's direction for the Console is that it should work for just about anything a student could try before students are sent to it. `tools/student-probe.mjs` is the measure: 228 commands, 59 running at release and 125 after three further batches (tabulation and summary statistics, regression diagnostics, weights, model comparison, instrumental-variable diagnostics, classical tests, data utilities). Every addition was compared with installed Stata before it was kept.

What the probe still refuses, in the order proposed for building: graphs (`graph bar`, `graph box`, `kdensity`, `twoway` with `qfit`, `lfitci`, `bar`, `area` and `lowess`, `rvfplot`, `avplot`, `histogram, normal`); further estimators (`tobit`, `ologit`, `oprobit`, `mlogit`, `nbreg`, `glm`, `qreg`, `newey`, `xtreg, be`, `xtlogit`, `ivregress liml` and `gmm`, `hausman`, `nlcom`, `testnl`); the simulation prefixes (`bootstrap`, `simulate`, `permute`, `jackknife`); remaining data commands (`table`, `egen` functions `concat`, `anycount` and `cut, group()`, `stack`, `cross`, `joinby`, `collapse` with weights, `do` and `run` on a file in the session, `import excel`); time series (`arima`, `dfuller`, `corrgram`, `tssmooth`); and survey and survival commands. Community-contributed commands (`esttab`, `outreg2`, `reghdfe`, `ivreg2`) are not Stata's and are a separate decision. `sysuse auto` remains unavailable because the dataset is StataCorp's.

Later the same day the graph batch was added: the `twoway` types `qfit`, `lfitci`, `qfitci`, `lowess`, `bar`, `area`, `connected`, `histogram` and `kdensity`; `graph bar`, `hbar` and `box`; `kdensity` and `lowess` as commands; `rvfplot`, `avplot`, `lvr2plot`, `qnorm`, `pnorm` and `tsline`. The probe stands at 145 of 228. Graphs are no longer first in the remaining order; further estimators are.

The estimator batch followed: `tobit`, `ologit`, `oprobit`, `mlogit`, `nbreg`, `qreg`, `newey`, `xtreg, be`, `nlcom`, `testnl` and `hausman`. The probe stands at 154 of 228. Next in order: the simulation prefixes (`bootstrap`, `simulate`, `permute`, `jackknife`), the remaining data commands (`table`, `egen` `concat`, `anycount` and `cut, group()`, `stack`, `cross`, `joinby`, `collapse` with weights, `do` and `run`), `glm` and `cloglog`, `ivregress liml` and `gmm`, `xtlogit`, time series, then survey and survival commands.

The resampling batch followed: `sample`, `bsample`, `bootstrap`, `jackknife`, `simulate`, `vce(bootstrap)` and `vce(jackknife)` on `regress`, with `do`, `run`, `include`, `cross`, `joinby`, `stack` and three more `egen` functions. The probe stands at 166 of 228. What it still refuses falls into five groups: commands needing more work here (`table`, `proportion`, `anova`, `contrast`, `pwcompare`, `glm`, `cloglog`, `xtlogit`, `ivregress liml` and `gmm`, `collapse` with weights, `permute`, `margins` after the newer estimators); time series (`arima`, `dfuller`, `corrgram`, `ac`, `pac`, `tssmooth`, `prais`); survey and survival analysis (`svy`, `stset`, `sts`); files the browser cannot read or write as Stata does (`import excel`, `export excel`, `putexcel`, `infile`, `outsheet`); and things that are not Stata's own commands or not expressible here (`esttab`, `outreg2`, `eststo`, `reghdfe`, `ivreg2`, `mata`).

Then `table`, `proportion`, `anova`, `glm`, `cloglog`, `corrgram`, `ac`, `pac`, `tssmooth` and weighted `collapse`. The probe stands at 177 of 228. Of the 51 still refused, about a dozen are refused for a reason the probe itself supplies (a file that does not exist, a test that needs a different model first). What is left to build: `dfuller` and `arima`, `prais`, `rreg`, `xtlogit`, `ivregress liml` and `gmm`, `contrast` and `pwcompare`, `margins` after the newer estimators, `permute`, `xtdescribe` and `xttab`, `inspect`, `notes`, `numlabel`, `drawnorm`, `outsheet` and `infile`, and `graph pie`. Survey and survival commands, Excel files, `mata` and community-contributed commands remain outside what has been attempted.

Then `ivregress liml` and `gmm`, `prais`, `dfuller`, `notes` and `numlabel`. The probe stands at 185 of 228. Left to build: `arima`, `rreg`, `xtlogit`, `contrast` and `pwcompare`, `margins` after the newer estimators, `permute`, `xtdescribe` and `xttab`, `inspect`, `drawnorm`, `outsheet` and `infile`, and `graph pie`.

Then `margins` after `tobit`, `nbreg`, `glm`, `cloglog`, `qreg`, `areg`, `newey`, `prais`, `ologit`, `oprobit` and `mlogit`. The probe is unchanged at 185 of 228, because its one `margins` line already ran; this batch widens what follows a model, which the probe does not sample. Left to build: `arima`, `rreg`, `xtlogit`, `contrast` and `pwcompare`, `permute`, `xtdescribe` and `xttab`, `inspect`, `drawnorm`, `outsheet` and `infile`, `graph pie`, and predicted probabilities from `predict` after the ordered and multinomial models.

A second probe, `tools/postestimation-probe.mjs`, now samples what follows a model: 23 estimators by 39 follow-up commands, each pair run in installed Stata and here. 824 of 897 pairs agree on whether the command runs. The 63 that Stata runs and the Console refuses set the next order of work: `margins` after `ivregress` and `xtreg`; coefficients of `mlogit` addressed without an equation (`test x1`, `lincom`, `_b[x1]`); `predict` probabilities after `ologit`, `oprobit` and `mlogit`; `margins, at()` after the same three; the `estat` tests after `ivregress gmm`; `estat ic` after `areg` and `xtreg`; `predict, residuals` after `logit` and `predict, pr` after `cloglog`. The 10 pairs the Console runs and Stata refuses should be made to refuse.

All 73 disagreements were then closed, and comparing what `predict` stores after every estimator corrected four wrong defaults the return codes had not shown (see the numerical contract). The post-estimation probe reads 897 of 897 and runs as a test.

The Console page was rebuilt in the same change. It now has a command line under the results that runs one command at a time against the session, with Up and Down recalling earlier commands; a menu of six example do-files, each run by a test; an editor with line numbers and colour for commands, comments, strings, macros and numbers; a button and shortcut that run only the selected lines; variable names that can be put into the do-file with a click, with new variables marked after a run; a searchable list of the commands that run; and a choice of Stata's classic Results colours, kept between visits. A short run is typed and printed in turn and the marks of a graph are drawn in; both are skipped when the reader's system asks for reduced motion, and a run of more than 60 commands arrives at once. Writing the examples found two interpreter faults, since fixed: `simulate name = r(x)` failed when spaces surrounded the equals sign, and `drop _all` was an error with nothing in memory. The page is still unlinked and marked noindex.

## Console round of 11 November 2026: datasets, the map, examples

**Datasets.** `src/console-datasets.js` adds six simulated datasets to the three lesson datasets, for the Console only (the lesson pages still read `src/datasets.js`). Each is generated from a fixed seed, so every visitor gets the same numbers, and each description states the answer built into it: `schools` (tutoring assigned by school, effect 4 points), `firms` (staggered policy in a panel, about 9 percent), `trade` (gravity with zeros, distance elasticity -1), `labor` (return to schooling 0.075 with an instrument), `macro` (quarterly series) and `health` (trial, -8 mmHg, overdispersed visits). A test checks that the stated answers lie within two standard errors of the estimates.

**The map.** `src/console-map-model.js` holds the kinds of step, the Stata each writes and the do-file a map stands for; `src/console-map.js` draws it. Steps are form controls in the order they run, joined by lines; two steps after the same step are branches, and a branch that changes the data is wrapped in `preserve` and `restore` unless it is the last. The page runs a map one step at a time so that each card shows whether it ran; a model that ran is asked for `_b[]` of its plain variables, which the card shows beside its path diagram. The map is kept in `localStorage` under `stataverse:console:map:v1` and checked before use.

**Examples.** Nineteen do-files in four groups. The thirteen new ones were run in installed Stata on CSV copies of the datasets and compared line by line with the Console.

**What that comparison found and fixed.** A factor with one level to show (any 0/1 variable written `i.x`) was printed with blank rows around it; Stata prints it as a plain row, in estimation tables and in `margins, dydx()`. `margins factor, dydx(x)` ignored the factor, and `margins, dydx(factor) at(...)` printed only the first setting; both now give Stata's table. `xtsum` printed `T-bar` for a balanced panel. `collapse` put the `by()` variables in the order typed, not the order they have in the data. `tabstat, by()` and `xtsum` did not shorten names longer than eight characters.

**Known differences that remain.** `reshape` prints no summary table. `list` does not shorten long names in its header. `tabulate` wraps a long variable label differently from Stata, and does not widen the first column for a value-labelled variable such as `_merge`. `marginsplot` does not print the line naming the variables that identify the margins. `nbreg, irr` does not wrap its note at 80 columns. An interaction header longer than twelve characters is broken after `#`, which is what Stata does at 80 columns; at a wider line size Stata widens the column instead. `hausman` stops where Stata reports a negative chi-squared with a warning. Time-series operators are accepted by `generate` but not inside an estimation command's variable list. Random draws do not follow Stata's stream, so a simulation gives a different sample from the same seed.

**Stata on this machine.** Stata 19 MP (18 processors) returned wrong coefficients for `regress lsales policy` on the 600-row `firms` data; `set processors 1` gave the right ones, which agree with the group means. The recorders already run with `set processors 1`. Any comparison against this installation should do the same until the cause is known.

## Console round of 11 November 2026 (second): own data, projects, download

**Why the map could look dead.** The page's script and stylesheet had fixed addresses, so a browser could pair the new page with a script it had kept from before; the Map button then did nothing. `tools/build.mjs` now stamps both addresses in `Console/index.html` with a hash of their contents, and the script passes the stamp to its worker. Separately, the Run button and the results sat below the map. The map now has its own Run button and status above the canvas, each card keeps what it printed behind a Result button and shows an error on the card, and the do-files the map writes are shown beside the results with the lines of the card in hand lit.

**Own data.** CSV, tab-separated and text files as before, now several at once, by the picker or by dropping them on the page; a data file is loaded as soon as it is added. Stata `.dta` files are read by `src/console-dta.js` (formats 105 to 115 but for 112, Stata 5 to 12, and 117, 118 and 119, with strL, notes and characteristics), tested against files written by installed Stata, and stored in the session where `use`, `merge` and `append` find them. A do-file that is added opens in the editor. Added files appear under Datasets with Load, Start a map from it and Remove, and are offered in the map's Load data step. They live in the page for the visit only.

**Projects.** The editor holds several do-files as tabs, kept in `localStorage` under `stataverse:console:project:v1` (the single do-file of earlier visits becomes `main.do`). Before any run every do-file is given to the session, so `do "clean.do"` works. In the map, a "Start a do-file" step sends the steps after it to a file of their own, run from its parent with `do`.

**Download.** `src/console-project.js` packs the do-files, the datasets they use and a README into `stata-project.zip` (`src/console-zip.js`, stored entries). So that the folder runs in Stata on the student's computer, each `sysuse` of a site dataset is rewritten as `use "data/name.dta"` and the dataset is written as a format-118 `.dta` file with its types and labels. A three-file project made from a map was unzipped and run in installed Stata with no errors and the same coefficients as the Console.

**Menus.** An Insert menu of command patterns in six groups; the map's add-a-step menu grouped with a line on what each step does; variable names above the map to put in the field last used.

## Console round of 11 November 2026 (third): less on the first screen

A first-time walk through the live page at 1280 by 800 found the Run button below the fold, 973 words and 30 controls shown in the do-file view, the first card of the map out of view, and a garbled line in the empty Results window. The page was rebuilt on one rule: the first screen is the editor, Run and Results, and everything else is one deliberate step away.

- **One bar.** Write or Map, Run, Examples, More. Run is the same button in both views. Run selection appears only while lines are selected. The status line sits under the bar.
- **More.** Insert a command, new, rename and delete do-file (or, in the map, open as do-files and tidy), download the project, download the data in memory as `.dta`, clear the session, classic colours and the fox. It closes after a choice, on Escape and on a click away.
- **Drawers under the work.** Variables (opens by itself the first time there is data), Data (teaching datasets as a name and a Load button, the description on request; own files), Commands, About. The "start from a dataset" picker is gone: the Data drawer does that.
- **Tabs** appear with the second do-file.
- **Map.** The tree is laid out from the top left, so the first step is in view. A card shows its title and its command; selecting the title opens its fields, Run to here, add a step and Remove. A card that has run shows Result.
- **Words.** 41 shown in the do-file view and 74 in the map, from 973 and 1,104. A browser test holds the do-file view under 45 and checks that Run is in view on a laptop and on a phone.

## Console round of 11 November 2026 (fourth): a command and its output are one thing

The page was tidy but nothing tied its parts together. This round adds one idea and keeps the rest quiet: every line that ran knows what it printed, and the reverse.

- **Source lines.** Each output record now carries the line of the do-file its command started on (`record.line`). A command inside a loop names its own line; what a program or a do-file run with `do` prints belongs to the line that called it. The splitter's start line was wrong for indented commands and is fixed.
- **Gutter.** A line that ran has a tick on the gutter's edge; the line that stopped a run is red and has a band behind it until it is edited or run again. The ticks arrive with the results.
- **Both directions.** The caret on a line lights its block in Results and brings it into view (moving the caret does; typing does not). Pointing at a block shows its line; selecting its command puts the caret there, opening the right do-file first.
- **Editing.** Marks stay on their lines as text is added or removed around them, and a mark is dropped when its own line changes (`shift` in `src/console-links.js`).
- **Map.** A card lights its blocks in Results; selecting a command in Results finds its card. Joins have an end on each card and a finished join is drawn along its length.
- **Results.** Table rules are drawn as a hairline over the dashes, which are still the text that is selected and copied; the classic colours keep the dashes. A run that stops is scrolled to its error.
- **Motion.** Three durations and two curves as custom properties; drawers, the menu and a card's fields open from where they are attached. All of it is off under reduced motion.

Not done: a self-hosted typeface (needs font files added to the repository), and the fox looking at the failed line. Motion was judged from stills, and Safari is still untested here. Selecting a command in Results is a pointer action; from the keyboard the link runs from the do-file to Results only.

**Typeface (later on 11 November).** The Console's code and Results are set in Geist Mono, served from `assets/fonts/` (the same file, license and provenance the hub site already serves; no remote font request). Ligatures are off for the whole page, because the font would otherwise join runs of dashes and break table columns; a browser test checks that every character has the same width and that the font comes from the site's own origin. The page chrome keeps the site's text face, which the lesson pages share.
