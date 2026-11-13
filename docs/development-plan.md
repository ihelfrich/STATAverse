# STATAverse development plan

Written 12 November 2026 as a handoff. It is for a new Claude session (Opus 5.5,
with ultracode on) that takes over the project from the session that built the
Console. It says where the project stands, what must not change, what to build
and in what order, how each piece is checked, and what is Dr. Helfrich's to
decide. Read it once in full, then work from section 6 onward.

The state described here was mapped on 12 November by seven agents reading the
repository and by a probe that ran 488 student-style commands through the
runtime. Three further agents then checked this plan against the code, reran
the defects it names, and corrected it. Their notes, the probe and its results
are kept outside the repository at
`/Users/ian/Developer/agent-playground/stataverse-probe-2026-11-12/`
(`area0.md` tests, `area1.md` written backlog, `area2.md` deploy, `area3.md`
Console, `area4.md` lessons, `area5.md` runtime, `area6.md` probe,
`review.md` the check of this plan; `cases.txt`, `probe.mjs`, `results.json`).
Treat the notes as leads with file references, and confirm a claim in the code
before building on it.

**Refreshed 12 November, after PR 30.** This file is on `main`. Section 2
gives the state at `83c25ec`; section 6a turns section 6 into milestones, says
which packages can run side by side, and lists the decisions due before the
first milestone ends. Section 10 is the starting prompt.

## 1. The goal

Dr. Helfrich's direction, in his words: upgrade STATAVERSE "without breaking
it, including giving students the ability to run almost any stata commands they
want in the browser directly", and later, that the Console should work for
"just about anything a student could try before students are sent to it".

Two things follow. The public site at https://ihelfrich.github.io/learn/stata/
keeps working exactly as it does: every address, every saved session, every
lesson check. And the Console, the page that runs do-files on the new runtime,
is developed until a student's ordinary do-file runs there and prints what
Stata prints, at which point Dr. Helfrich decides whether to link it.

## 2. Where it stands

Two interpreters live in the repository.

- `src/engine.js` is the older one. It serves the 19 guided lessons
  (`Learn/index.html`, `src/learn.js`), the labs and the do-file builder. It is
  frozen: saved Practice sessions are command histories that are re-run through
  it, so changing what a command means changes what a student's saved work
  restores to.
- `src/runtime/` is the new one: 44 files, about 20,700 lines, 190 commands
  registered in the `COMMANDS` array of `src/runtime/commands.js`, 114
  expression functions. Only the Console loads it.

The Console (`Console/index.html`, `src/console*.js`, `assets/css/console.css`)
is published at `/learn/stata/Console/`, with `noindex`, outside site search,
and with no link pointing to it. It has a do-file editor with several files, a
command line, a Results window whose blocks are tied to the lines that made
them, a map view, nine teaching datasets, the student's own CSV and `.dta`
files, `.dta` export, a project zip and SVG graphs. The session runs in a
worker and falls back to the page.

`main` is at `83c25ec` (PR 30, clustered standard errors). The website
repository pins that commit (ihelfrich/ihelfrich.github.io#53) and the live
page serves it; `logit`, `poisson` and `ivregress` under `vce(cluster region)`
and the `vce(bootstrap)` refusal were checked on the live Console, `xtreg, re`
and `probit` only in the unit tests. `npm test` runs 374 unit tests in about
two seconds. The wide probe, rerun at `83c25ec`, runs 361 of 488 cases and
stops 127 (by group, ran/stopped: data management 61/4, description 30/15,
tests 14/13, estimation 41/22, post-estimation 59/22, graphs 36/7,
programming 88/22, dates 18/8, time series 14/14). The
browser suite had 278 passing runs at the last full check (two Playwright
projects, both Chrome). This repository has no CI of its own; the website
repository's deploy workflow builds the pinned commit on GitHub Actions.

Not built: the three courses of `docs/runtime-and-courses-spec.md` (`dw-`,
`rb-`, `ci-`), the `stataverse:courses:v1` store, moving Practice to the new
runtime (stage 5 of the spec), the frozen-engine interface, a second model's
review of the runtime, any way to load part of the runtime on demand, and
linking the Console.

### What the probe found

Of 488 cases a student might type, 360 ran and 128 stopped. About twenty of
the 128 are correct refusals or community packages. The rest cluster, and the
clusters set the order of section 6.

More serious than any refusal: a set of commands return success and show
something wrong. A refusal tells the student to try something else; these do
not. All of the following were reproduced at `0f615aa`; `scalar list`,
`twoway function`, `scatter, by()`, `graph combine`, `xline()` and the
`date(…, "DMY", 2050)` case still behave this way at `83c25ec`.

Standard errors (fixed on 12 November in the pull request that carries this
plan; see `tests/runtime-cluster.test.mjs`): `logit`, `probit`, `poisson` and
`ivregress` printed conventional standard errors under `vce(cluster v)`;
`xtreg, re` printed conventional ones under a Robust heading; `xtreg` ignored
the variable named; `regress` with a string cluster variable reported "no
observations". Clustering now matches Stata where it is computed and is
refused elsewhere. The same pattern, a `vce()` that is read loosely, is the
first thing to look for in any estimator added later.

Graphs:

- `by()` on `scatter` and `histogram` draws one pooled panel.
- `twoway function` draws a flat line at zero for any expression.
- `graph bar (count), over(g)` is labelled and scaled as percent.
- These options are accepted and have no effect: `xline()`, `yline()`,
  `xlabel()`, `ylabel()`, `mcolor()`, `mlabel()`, `legend(order())`,
  `legend(label())`, `xscale(log)`, `yaxis(2)`, `blabel()`, `noutsides`,
  `subtitle()`, `note()`, `caption()`, `over(, sort())`, `asyvars`, `stack`.
- `graph combine` returns success with no graph and no message.

Other:

- `scalar list` and `timer list` print nothing.
- `date("15/3/24", "DMY", 2050)` returns missing.
- `margins, dydx(*) atmeans` after a model with `i.female` prints
  `female = . (mean)`.

These contradict the project's own rule (section 3, item 7) that an option the
runtime does not act on is refused. The existing probe,
`tools/student-probe.mjs`, counts return codes and cannot see any of them. The
list comes from a sample; expect more of the same kind.

## 3. What must not change

These are fixed. A change that touches one needs Dr. Helfrich's explicit word.

1. No route under `/learn/stata/` is removed or renamed, and the legacy
   `/STATAverse/` bridge keeps working. Lesson deep links (`Learn/#<lesson id>`
   and `?course=`) keep working.
2. Lesson IDs and step positions in `src/lessons.js` never change.
3. Storage keys keep their meaning: `stataverse:practice:v2` (schema 3),
   `stataverse:labs:v1`, `stataverse:do-builder:v1`, `stataverse:progress:*`,
   `stataverse:user*`, and the Console's `stataverse:console:*`. New state gets
   a new key. Nothing new goes into `stataverse:practice:v2`: an older cached
   release runs `validateStore` on it and drops what it does not know. Nothing
   but `.do` files goes into `stataverse:console:project:v1`: its loader
   rejects the whole project if one file name does not end in `.do`, and the
   student's tabs are then lost.
4. Workspace backups of every accepted version (unversioned, 1, 2, 3 and 4)
   stay importable. `PRACTICE_PROTOCOL` stays 2 for the existing Practice page.
5. `src/engine.js`, `src/expression.js` and `src/persistence.js` are not edited
   except for a recorded bug fix he has approved.
6. The offline core stays under 600,000 bytes gzip (561,451 at the 9 November
   release). The Console is outside the core and must stay outside it. The
   limit is asserted in one place only, `npm run test:site`
   (`tools/verify-site-integration.mjs`), which needs the website build served
   locally and is not part of `npm run check`.
7. An option or form the runtime does not implement is refused with r(198) and
   a hint, never ignored. In `src/runtime` this is the list after `|` in a
   command's syntax declaration. This holds for options that change only a
   graph's look (`scheme()`, `graphregion()`, `msymbol()` and the like): they
   are refused by name, not accepted with a printed note (Dr. Helfrich, 12
   November 2026). The list is `NOT_DRAWN` in `src/runtime/graph-looks.js`;
   an option is taken off it only by drawing it.
8. A number that differs from Stata beyond the stated tolerance is either
   fixed or written down in `docs/numerical-contract.md`. Compatibility is
   described only as measured coverage plus the list of commands, never as a
   bare percentage.
9. `float` storage in the new runtime differs from the old engine on purpose,
   and several statistics repeat Stata's single-precision intermediate
   arithmetic on purpose. Neither is to be "improved".
10. No Stata log (`*.log`, `*.smcl`), StataCorp dataset or other licensed
    material enters the repository. Logs from native runs stay in a private
    temporary directory. `sysuse auto` stays unavailable unless he decides
    otherwise.

## 4. How to work here

**Before building.** Read the Agent Log (Notion, linked from
`~/.claude/CLAUDE.md`) for this project and add one `IN PROGRESS:` entry. An
older overhaul entry belongs to a Codex thread; check it is not active on the
same work. The previous Claude session's entry is page
`41308471-6405-8111-a2c8-e519a8f8e4c0`.

**Branches and merging.** Work on `claude/<topic>`, one topic per pull request.
Commit subjects are plain imperative sentences ("Console: …" for Console
work); the body is prose. Merging a pull request and deploying each need his
go-ahead, every time. Never push to `main`, never force-push.

**Build and checks.**

```bash
npm test                      # 369 unit tests, about 3 s; leaves the tree clean
npm run format:check          # prettier over an explicit list in package.json
npm run build                 # rewrites tracked bundles and the ?v= stamp
npm run test:browser          # Playwright, Chrome, desktop and phone profile
npm run check                 # build, unit, links, browser, deployment
npm run test:legacy && npm run test:loading
```

`npm run check` does not run prettier and does not check the offline budget.
Run `format:check` yourself on every package.

Things that have cost time before:

- Run prettier before the last `npm run build`, then commit. The build stamps
  `Console/index.html` with a hash of the Console bundle; a build after the
  commit changes the stamp and leaves the tree dirty.
- `npm run package:site` does not fail on a dirty tree. It writes
  `"dirty": true` into `dist/site-package.json`, and the website's
  `prepare-stataverse.mjs` then refuses the package. Untracked files count.
- `npm run check` rewrites `docs/verification/screenshots` and
  `docs/verification/deployment.json`. The probe, corpus and differential
  scripts also write tracked receipts under `docs/verification`
  (`tools/student-probe.mjs` on every run). Check `git status` and restore
  what was not meant to change. Package A0 removes most of this.
- `assets/js/*.js` is build output. Edit `src/`.
- Only one Playwright run on this machine at a time, in any checkout. The
  config reuses whatever is listening on `127.0.0.1:4173`, so a run started in
  a second worktree tests the first one's files. Stop any `npm run dev` first.
  Agents working in worktrees do not run browser tests.
- A new top-level folder or file type must be added to `SITE_ROOTS` or
  `EXTENSIONS` in `tools/package-site.mjs`, or it silently does not ship. New
  HTML, CSS and source files must be added to the `format:check` list.
- `findCommand` takes the first entry of `COMMANDS` whose name starts with the
  typed word and meets its minimum length. Adding a command can change what an
  abbreviation resolves to. Check the neighbours.
- Throw `StataError`, never a plain `Error`: a plain one escapes `Session.run`
  and the student sees a crash.
- `src/console.js` runs on import (top-level `await`) and exports nothing, so
  Console page behaviour is tested only in `tests/browser/console.spec.js`.

**Checking against Stata.** Stata 19 MP is installed; the recorders call it by
its application path. The recorders that belong to the new runtime are:

| Recorder                                  | Cases come from                                                 | Fixture                                         |
| ----------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| `tools/check-expressions-native.mjs`      | arrays in the file and `randomExpressions`                      | `tests/fixtures/stata-runtime-expressions.json` |
| `tools/check-session-native.mjs`          | `tools/session-cases.txt`, `randomDoFiles`, `randomControlFlow` | `stata-runtime-sessions.json`                   |
| `tools/check-output-native.mjs`           | `tools/output-cases.txt`, `randomReports`                       | `stata-runtime-output.json`                     |
| `tools/check-formats-native.mjs`          | generated in the file                                           | `stata-runtime-formats.json`                    |
| `tools/check-runtime-native.mjs`          | in the file                                                     | `stata-runtime.json`                            |
| `tools/postestimation-probe.mjs --record` | estimator and follow-up pairs                                   | `stata-postestimation-rc.json`                  |

These record under `version 17` with `set processors 1`; without the second
line this machine has returned wrong regression coefficients. (The
post-estimation probe lacks that line; add it when B7 touches it.) The other
`check-*-native.mjs` files, including `check-functions-native.mjs`, belong to
the frozen engine. Do not add runtime cases to them.

A recorder takes no arguments, reruns every case in Stata and rewrites its
whole fixture. After running one, read `git diff tests/fixtures`: a change to
an existing case is a finding to explain, not noise to commit. To add cases,
write them into the case file and add a seeded generator function beside the
existing ones. A new command family gets a generator before it is called
checked: the machine-written generators found about a dozen differences that
some 900 hand-written cases had missed. Tolerances are in
`docs/numerical-contract.md`.

Native `import delimited` and graph export do not work here (no Java), so data
enters native runs by `input` or `insheet`, and graphs are compared by the
numbers they are drawn from. Only `runiform()` follows Stata's random stream;
anything using `rnormal()` and the other generators is compared through data
entered by `input`, or distributionally.

**Spending.** His rule is that any Claude use that incurs additional charges or
draws on paid credits needs his prior approval. Mapping and checking this plan
used about 1.5 million subagent tokens. Before the first workflow of a
session, confirm the billing route is his subscription; if it is uncertain,
ask. A second-model review through another provider (R1) is his to approve.

**Other standing rules.** `~/Secure/` is never read. Address him as
Dr. Helfrich and write to him plainly, at his level. Register reusable outputs
in `.scholon-outputs.json` (it lists nothing from `src/runtime` or the Console
yet). Close the session by updating the Agent Log entry.

## 5. How to use workflows on this project

Each work package in section 6 is sized to be one pull request and one or two
workflows. The shape that fits most runtime packages:

1. **Scout** inline: read the dispatch point and the nearest existing command,
   and list the exact forms to add.
2. **Write cases** (one agent): cases in the matching case file and a seeded
   generator in the matching recorder (section 4), covering each new form, its
   options, `if`/`in`, weights, missing values and the error paths.
3. **Record** inline, not in an agent: run the recorder, read the fixture
   diff, keep the logs out of the repository.
4. **Implement** (one agent per independent module; a worktree each only when
   two would edit the same file). The test is the fixture, not the agent's
   reading of the manual.
5. **Verify adversarially** (two or three agents with different briefs): one
   tries inputs outside the fixture and has them recorded; one checks that
   every option not implemented is refused, and that an accepted option
   changes the output; one reruns `npm test` and the probes and reports any
   case that went from pass to fail. The probes rewrite tracked receipts; the
   agent restores them or reports the diff.
6. **Run the checks** inline (`format:check`, `check`), then write the pull
   request.

Verify every claimed defect by running it. Agents do not merge, deploy, push
to `main`, post anywhere, run `npm run build` in a shared checkout, or run
browser tests in a worktree.

## 6. The work, in order

Sizes: S is under a day of one session, M one to two, L more. "Recorded" means
compared with a native Stata fixture as in section 4. Do the phases in order;
within Phase B the order given is by how soon a student meets the gap.

### Phase A. Make wrong answers impossible to miss

**A0. Checks that leave the tree clean (S).** The screenshot and receipt paths
are hard-coded in eight browser specs (`data-lab`, `data-investigations`,
`do-builder`, `iv-investigations`, `grouped-data`, `method-lab`, `iv-lab`,
`programming`; find them with `grep -n "docs/verification" tests/browser`) and
in `tools/verify-deployment.mjs`. Route them through one environment variable
that defaults to an ignored directory, and give `tools/student-probe.mjs` a
`--write` flag like its neighbours. Done: `npm run check` on a clean tree
leaves it clean.

**A1. Adopt the wide probe (S).** Move `cases.txt` and `probe.mjs` from the
probe folder into `tools/`, with a receipt in `docs/verification/`. The probe
imports the repository by absolute path; make it relative. The folder's
`drill.mjs` and `full.mjs` (one case per fresh session, from standard input)
are worth keeping as a `--drill` mode; `g*.mjs` were one-off graph checks and
become asserting cases. Add a
second kind of case that asserts something about the output (a line that must
appear, a count of panels or of SVG marks, a standard error that must differ
from the conventional one), so that an ignored option fails the probe. Also
regenerate `docs/verification/corpus-run.json` with
`node tools/corpus-run.mjs --write`; the committed copy predates `nbreg`.
Done: `npm run probe:wide` prints the pass, refuse and wrong counts, and a
unit test fails when a case moves from pass to fail.

**A2. Silent wrong results (M).** For each item in section 2, either implement
the behaviour or refuse the option, and add an asserting case to A1. Standard
errors are done. Then the graphs, then the rest. Then
sweep every graph command's syntax declaration for options that are accepted
and dropped.

Before turning an ignored option into a refusal, find what uses it. Lessons
run on the frozen engine and are not affected. The Console's own content is:
`src/console-examples.js`, `src/console-snippets.js`,
`src/console-map-model.js` and `src/do-builder-model.js` carry `by()`,
`vce(cluster …)` and `atmeans`. Run `tests/console-examples.test.mjs`,
`tests/console-map.test.mjs` and `tests/runtime-differential.test.mjs`, and
compare `node tools/corpus-run.mjs` before and after. Where shipped content
uses an option, implement it rather than refuse it.

**A3. Crashes and false errors (S).**

- `ivregress …, first` fails above 254 observations: `more-estimators.js`
  builds an `inlist(_n, …)`, which is capped at 255 arguments. Pass the rows
  directly.
- `destring, replace` on a one-variable dataset throws a plain JavaScript
  error (`data-commands.js`).
- Exporting a dataset that holds a `strL` variable throws a `RangeError` in
  the writer of `src/console-dta.js`. Refuse or write it.
- `nbreg` reports r(430) when the data are equi- or underdispersed and alpha
  goes to zero, where Stata converges and prints alpha near 1e-20 with a
  missing standard error. This stops
  `ZeroToHero/projects/project-02/analysis.do`. Record that boundary case.
- In the Console, a worker that dies mid-run appears to leave the next Run
  waiting forever (`src/console.js`: the error handler rejects the pending
  request but keeps the dead worker). This is from reading the code; reproduce
  it in the browser suite first, then recover as Stop does.

**A4. A coverage matrix (S).** A script that lists the registered commands and
the commands that appear in the recorded fixtures and writes the difference to
`docs/verification/`. It becomes the backlog for recording in every later
package.

**A5. CI (M, his decision).** A GitHub Actions workflow on pull requests:
build, `format:check`, unit tests, link check, and a check that the build
leaves the tree clean. The website's deploy workflow already builds the pinned
commit on Actions and rejects a dirty tree, so build parity between this Mac
and Actions is exercised on every deploy; confirm it for the new workflow. Add
a unit test that sums the gzip sizes of the service worker's `CORE_ASSETS`, so
the offline budget is checked without the website build.

**A6. Safari and Firefox (M, his permission).** Playwright has only Chrome
installed. Adding WebKit and Firefox projects means downloading browsers. The
Console relies on module workers, `document.execCommand`, `interpolate-size`,
`::details-content` and `@starting-style`; expect failures and fix the ones
that change behaviour (the worker path decides whether Stop exists at all).
Done: `tests/browser/console.spec.js` passes in all three engines, or each
remaining difference is written down.

**Release guards (S each), before the first release after Phase A.** E2 and
E3 in Phase E are small and protect every later release. Do them here.

### Phase B. The language a student actually types

Every package ends with the wide probe's count moving and no case going from
pass to fail. Each package also states how many gzip bytes it adds to
`console.js` and `console-worker.js` (162 KB and 136 KB today); see B14.

**B1. Coefficient references (M).** The line a student types straight after
`regress y i.female`. The level names (`2.g`, `1b.g`, `2.g#c.x`) already exist
in `e(b)`, and `_b[2.g]` already works in `display`. What fails is the
constraint parser of `test` and `lincom`: `test 1.female`, `test 2.g = 3.g`,
`test 1.female#c.education` and `lincom education + 1.female#c.education` are
read as numbers, and `_b[name]` is not accepted at all (`test _b[education] =
2` fails with r(111)). Numeric literals such as `1.`, `2.5` and `.5` need
regression cases first.

**B2. Operators in varlists (L).** `L.x`, `D.x`, `F.x`, `L(1/4).x`, `L2.x` in
any command's varlist (`regress`, `summarize`, `list`, `correlate`, `xtreg`,
`newey`); lowercase `l.` `d.` `f.` and the seasonal `S.` operator in
expressions; base levels `ib2.x`, `b2.x`, `ib(last).x`, `ibn.x`, `i(2 3).x`,
`1.female`; `fvset base`; the `baselevels` option. Start at
`src/runtime/varlist.js` (the r(101) is thrown near line 32), `estimation.js`
(`component()` accepts only `i.` and `c.`) and `panel.js`
(`timeSeriesOperator`, which today reaches expressions only). The risk is
shared: the design matrix names its columns, and `test`, `lincom`, `margins`,
`predict` and `estimates table` read those names; B1's names must not move.
Sample loss from lags must match Stata's. Recorded, with a generator over
operators crossed with commands.

**B3. One covariance module (L).** The sandwich calculation exists in four
copies: `estimation.js` (`regress`), `models.js` (the likelihood fitter and,
separately, `ivregress`) and `panel.js` (`xtreg`). That is why `tobit`,
`nbreg`, `mlogit`, the ordered models, `areg`, `glm` and LIML offer only
conventional standard errors. `src/runtime/vce.js` (12 November) holds the
reading of `vce()` and the clustered middle of the sandwich, and is the place
to start. Two pull requests: first the refactoring onto
one model frame and one covariance module with every fixture unchanged; then
`vce(robust)` and `vce(cluster v)` on every estimator and pweights on the
likelihood fitters, on `ivregress liml` and `gmm`, and on `xtreg` with a
cluster variable above the panel, replacing the refusals. This is the spec's stage 3 item
and the largest internal change in the plan.

**B4. Estimation conveniences (M).** None of these needs B3:
`exposure()` and
`offset()` on `poisson`; fweights on `logit` and `probit`; `[pweight]` on
`mean`; replay (`regress` alone, `regress, level(90)`, `, coeflegend`, `logit`
alone); `by:` and `bysort:` before estimators, `correlate`, `pwcorr` and
`ttest` (the last group's results stay in `e()`; headers as Stata prints
them); `xi:` as a prefix; `ivreg` pointing to `ivregress`; the `||` separator
after a bare plot command (`scatter y x || lfit y x`).

**B5. Description (M).** `tabulate` with `nofreq`, `expected`, `nokey`,
`matcell()`, `plot`, `exact` beyond 2×2 and aweights; `tabstat` with
`skewness`, `kurtosis`, `q`, `format()` and `save`; `table` with `nformat()`,
several `statistic()` in two-way tables, `nototals` and the old `contents()`;
`inspect`, `misstable summarize` and `patterns`, `contract`, `ci proportions`.
The layout of `tabulate` and `tabstat` is under recorded comparison; existing
column widths must not move.

**B6. Tests (M).** `ttest` with `unequal` and `welch` and with `unpaired`;
`ttesti`, `prtesti`; `robvar`, `signtest`, `swilk`, `sktest`, `bitest`,
`ktau`, `median`, `ksmirnov`; `oneway` with `bonferroni`, `scheffe` and
`sidak`.

**B7. Post-estimation (M).** `margins` with `over()`, `post`, `predict()`,
`pwcompare` and `eyex()`; `predict` with `u`, `e`, `ue` after `xtreg`, with
`ystar()` after `tobit`, and `dfbeta()`; `estat dwatson`, `estat bgodfrey`,
`estat hettest, rhs iid`; `lroc`, `xttest0`; the matrices `r(table)` after
estimation and `r(C)` after `correlate`. Add `set processors 1` to the
post-estimation probe's recording do-file, re-record, and confirm the fixture
does not change apart from new rows.

**B8. Functions (M).** Mathematics (`sin`, `cos`, `tan`, `atan`, `gamma`,
`digamma` and their neighbours); densities and distributions (`binomial`,
`binomialp`, `poisson`, `tden`, `lnnormal`, `betaden`, `binormal`); random
draws (`rt`, `rchi2`, `rgamma`, `rbeta`, `rweibull`, `rlogistic`,
`rnbinomial`) without moving the existing seed stream; date-time (`clock`,
`dofc`, `cofd`, `hh`/`mm`/`ss`, `hms`, `dhms`, `datediff`, `age`, `monthly`,
`quarterly`, `yearly`, `weekly`, the `%tc` format, `d()`); strings
(`ustrregexm`, `ustrregexra`, `ustrtrim`, `strtoname`, `strdup`, `plural`,
`soundex`); recoding (`recode`, `irecode`, `autocode`). `egen`: `mode`, `mad`,
`pc`, `kurt`, `skew`, `fill`, `diff`, `nvals`; `cut` with `group() label` and
`icodes` and with commas in `at()`; `seq` with `from() to()`. New rows go into
`tools/check-expressions-native.mjs`. This package parallelises well: one
agent per family.

**B9. Matrices (M).** Addition, multiplication, scalar multiples, `inv()`,
`invsym()`, `det()`, `trace()`, `diag()`, `vecdiag()`, `cholesky()`, range
subscripts (`A[1,1..2]`) and element assignment (element reads already work),
joins with `,` and `\` of named matrices, `matrix rownames`/`colnames`,
`mkmat`, `svmat`, `matrix accum`, the extended macro functions `colnames` and
`rownames`. `ml-matrix` is already a dependency. Conformability errors use
Stata's code 503. Mata stays out; say so in the refusal.

**B10. Files and data (M).** `use varlist using`, `use … if`, `use … in`;
`describe using`; `creturn list`; `webuse` with the same explanation `sysuse`
gives; the `dir` extended macro function; `expand, generate()`; `sample,
count by()`; `bootstrap, seed()`; `merge m:m`; `import excel` and
`export excel` (weigh the bundle size: `fflate` is present, an xlsx reader is
not); reading `.dta` with strL.

**B11. Writing programs (M).** `tokenize`, `gettoken`, `marksample`, `mark`,
`markout`, `postfile`/`post`/`postclose`, `file open`/`write`/`read`/`close`,
`char`, and `ereturn post b V` (refused today; names on `b` and `V` need B9's
`matrix colnames`).

**B12. Graphs (M).** Whatever A2 refused rather than implemented, plus a
second `over()` in `graph bar`; `graph pie`, `graph dot`, `graph matrix`;
`twoway rcap`, `rarea`, `rspike` and `tsline` as twoway plot types; weights on
`scatter` and `histogram`; `xtline`. Compare the numbers the picture is drawn
from, as the existing tests do, and assert the SVG's structure.

**B13. Result tables (M, his decision).** `esttab`, `eststo`, `estout`,
`outreg2` and `coefplot` are community packages; the spec calls them "a
separate decision". Nearly every applied course asks for one of these tables,
so a student's do-file stops there. The proposal to put to him: implement
`eststo` and an `esttab` that covers `se`, `t`, `p`, `star()`, `r2`, `ar2`,
`b()` and `se()` formats, `mtitles`, `keep()`, `drop()`, `label`, and `using`
with `.txt`, `.csv`, `.rtf` and `.tex`; refuse the rest; have `outreg2`
explain and point to `esttab`. Files written by `using` go to the session's
in-memory folder (where `save` and `use` already look) and into the downloaded
zip, not into `stataverse:console:project:v1` (section 3, item 3).

**B14. Loading the runtime in parts (M).** The spec assumes new command
families load on demand. Nothing does: the Console is two single bundles with
the whole runtime in each, nothing in `src/runtime` uses dynamic import, and
`Session.run` is synchronous, so a command cannot wait for a chunk. Decide how
a command reaches a family that is not loaded (scan the do-file before the
run, or make dispatch asynchronous inside the worker), split the build
(`tools/build.mjs` splits only the Practice bundle today), and cache chunks on
first use. This comes before B15 and before any lesson page loads the runtime
(Phase D), because the offline core has about 38,000 bytes of headroom.

**B15. More estimators (L, order is his).** Each family a chunk with a
recorded fixture: a `reghdfe`-compatible absorbing estimator (also a community
command); `xtlogit`, `xtpoisson`, `xtdescribe`, `xttab`; `arima`, `var`,
`tsfill`, `tsappend`, `pperron`, `xcorr`; `heckman`, `rreg`, `sqreg`,
`sureg`; `didregress`, `xtdidregress`, `permute`, `teffects`; `stset`,
`sts`, `stcox`; `glm` with `family(gamma)`; `xtreg, mle`. Which come first
depends on which course is built first.

### Phase C. The Console as a product

C3 and C4 first: they are small, and they are the faults that lose a
student's work.

**C1. Keyboard route from Results to the do-file (M).** The link from a block
of Results to its line is pointer-only. Give the blocks a keyboard route (a
roving tabindex within the log, or a shortcut that moves between blocks and
Enter to go to the line) without making a screen reader announce every block
twice. The pointer behaviour is pinned by two tests at lines 695 to 800 of
`tests/browser/console.spec.js`.

**C2. Results at size (M).** The log is `aria-live`, so a long run reads all
of it aloud; trimming reads `textContent.length` on each pass; a numeric table
makes thousands of spans. Announce a summary instead, trim by block, and test
near the 400,000-character cap. Trimmed blocks must leave the line marks.

**C3. Saving (S).** Autosave runs synchronously on each keystroke and
serialises the whole project; a quota failure is silent. Debounce it, flush on
`pagehide`, before Run and on tab switch, and tell the student when saving
failed. The flush at `pagehide` must be synchronous, and callers rely on
`save()` copying the editor into the project at once. Two Console tabs share
one project key and overwrite each other without notice; a debounce widens
that window. Read the two 10 November sections of `docs/red-team-review.md` on
the stale read under a lock before designing this, and decide and test what
two tabs do.

**C4. Undo and destructive actions (S).** Deleting a do-file and "Clear
session" act at once and cannot be undone. Add an undo for the deletion and a
confirmation for the clear.

**C5. Graph export (S).** A graph cannot leave the page, and `graph export`
only prints a note. Add save as SVG and PNG from the Results block, and have
`graph export name.svg|png` write to the session's in-memory folder and the
zip (not the stored project; see B13). Export the plain SVG, not the copy with
the drawing animation injected.

**C6. Tabs and messages (S).** The do-file tabs are buttons with
`aria-pressed`; make them a tab list with arrow keys. File errors share the
status line with successes and are overwritten. Test selectors depend on the
current markup.

**C7. Completion and help at the caret (L, his decision).** The editor is a
textarea over a highlight layer. Commands and the variables in memory are
known and are not offered. Two routes: a popup placed from the highlight
layer, keeping the textarea; or CodeMirror 6, already a dependency, which
replaces the textarea, gutter, highlight and band placement and with them the
line linking and every test that targets `#console-source`. Recommendation:
the popup, because the linking is recent and tested. `help <command>` should
show the syntax and options the runtime supports for that command, generated
from the syntax declarations, including what it refuses.

**C8. Narrow screens (M).** One breakpoint at 900 px. Check 900 to 1100 px
and under 400 px, and give the map a touch route.

**C9. Offline (S).** The Console is not in the service worker's cache. Cache
it on first use outside the core list, and say so plainly when it is opened
offline before that.

**C10. Arriving from a lesson (S).** The page reads nothing from its address.
Add a way to open with a dataset and a do-file (a fragment naming a site
dataset and a lesson's commands by id, not arbitrary text in the address).

**Small ones.** The fox does not look at the failed line. Motion was judged
from still images; watch it in a browser.

### Phase R. Before students are sent to it

**R0. The frozen-engine interface (M).** The spec makes this a condition of
linking: `src/engine.js` behind a stable interface with no change in
behaviour. Either build it, or bring him the question of deferring it to D4
and record his answer.

**R1. A second model's review of `src/runtime` (M, his approval).** Also a
condition of linking. Send the focused artifact and concrete questions; run
every claimed bug before accepting it.

**R2. The decision to link (his).** Bring it to him when Phase A, B1 to B7,
C1 to C4, R0 and R1 are done. The evidence: the wide probe's counts, the list
of known differences, the engines tested. If he says yes: remove `noindex` and
`data-pagefind-ignore`, retitle the page, add it to the navigation
(`tools/refresh-navigation.mjs`) and to `tools/check-links.mjs` and
`tools/verify-deployment.mjs`, and check in the website repository that the
sitemap and search pick it up.

### Phase D. Lessons and courses

Do not start here. It is the only phase that can break existing students'
work.

**D1. `stataverse:courses:v1` (M).** Its own store, validator and place in the
Workspace backup (a new backup version; every older one stays importable).

**D2. A typed result channel (M).** Lesson steps are graded on the actual
result. `src/lesson-checks.js` reads the frozen engine's typed result objects;
the new runtime returns lines of text. Give the runtime a typed channel
(stored results and the dataset) that checks can read, and a runtime version
of `tools/check-curriculum-native.mjs`. Courses and stage 5 both need it.

**D3. Course 1, data work (L).** Twelve lessons and a capstone as specified in
`docs/runtime-and-courses-spec.md` lines 134 to 151, with synthetic data whose
generating process is documented, as a new track. Prerequisites: D1, D2, B14
(the lesson page must load the runtime without growing the offline core), and
from B10 and B11 `import excel` (lesson 2), the `dir` macro function (lesson 11) and a way to write a table to a file (lesson 12), or his agreement to
teach those lessons without them. Course order is his decision.

**D4. A regression gate for lessons (M).** Before any existing lesson moves:
saved-store fixtures from the current release replayed through both
interpreters, `assessStep` verdicts compared for correct and for known-wrong
answers on all 86 lesson commands, all routes and deep links, backup import.

**D5. Stage 5 (L, his decision to begin).** A runtime tag for saved sessions
(under a new key, since older releases strip unknown fields), and the Practice
page's Data tab, Undo, preserve and export on the new runtime, with legacy
sessions still replayed by the frozen engine.

**D6. Courses 2 and 3 (L each).** Course 2 needs B2 (operators in models, for
the lesson on lags and serial correlation), B3 (clustering), B4 (exposure) and
B7 (margins forms). Course 3 needs B2 (`ib#.` for event studies), `permute`,
`didregress`/`xtdidregress` and `teffects` from B15, an Anderson–Rubin routine
that no package above lists, and two new labs.

### Phase E. Releasing

**E1. A pin script (S).** A script in the website repository that, given a
commit, clones it fresh, runs `npm run package:site`, asserts
`"dirty": false`, builds the hub against it, runs the hub checks and opens the
pull request. It stops there; merging is his.

**E2. A live check (S).** After a deploy, fetch
`/learn/stata/site-release.json` and the Console's `?v=` stamp and compare
them with the pin, with retries for the CDN.

**E3. Hub assertions (S).** `scripts/prepare-stataverse.mjs` extracts the
hub's three font faces by pattern and does not check it found three; the
Console's typeface depends on one of them. Assert the count, and add a browser
check of which face the Console resolved.

## 6a. Milestones, lanes and the decisions due now

Section 6 is the full backlog. This section is the order in which it is
spent. Each milestone ends with a release (section 7) so that the live Console
never runs far behind `main`, and each one is judged by the wide probe's three
counts (ran, refused, wrong) rather than by packages closed.

**M1. No silent wrong answers.** A0, A1, A3, A2 (in that order: A3 is small
and its crashes would otherwise show up as noise in A2's sweep), A4, then E2
and E3 before the release. A5 joins if he approves it. Done when the wide
probe has an asserting case for every item in section 2, its "wrong" count is
zero, `npm run check` leaves the tree clean, and the release is verified live
by E2's script rather than by hand.

**M2. A student's first week of do-files.** B1, B4, B5, B6, with C3 and C4 in
the Console lane. These are the forms an introductory problem set reaches
first (coefficient references after factor variables, `by:` before
estimators, replay, `tabulate` and `tabstat` options, the common tests), and
C3 and C4 are the two places the Console can lose a student's work. B13 joins
here if he approves it, because nearly every problem set ends in a table.

**M3. An applied course's do-files.** B2, B3 (two pull requests), B7. B2 and
B3 are the two largest internal changes and both touch the names of
design-matrix columns; do them one after the other, never side by side, and
rerun B1's cases after each.

**M4. The linking gate.** C1, C2, A6, R0, R1, then R2 put to him with the
probe's counts. Phases B8 to B15 and D follow, with B14 before any of B15 or
D3.

**Lanes.** Runtime packages edit `src/runtime/` and the recorders; Console
packages (C1 to C10) edit `src/console*.js`, `Console/index.html`,
`assets/css/console.css` and `tests/browser/console.spec.js`; release
packages (E1 to E3) live in the website repository. Packages in different
lanes can run as parallel sessions in separate worktrees. Two runtime
packages run side by side only when neither touches `estimation.js`,
`models.js`, `varlist.js` or the `COMMANDS` array's abbreviation neighbours;
B8 (functions) and B6 (tests) are the safest pair. Browser tests run in one
checkout at a time (section 4), so a parallel session runs unit tests and
leaves the browser suite to whoever merges.

**Decisions due before M1 ends,** each with a recommendation:

1. A5, CI on pull requests. Recommend yes: it costs one workflow file, catches
   a dirty build before the pin does, and lets the offline budget be asserted
   without the website build.
2. A6, downloading WebKit and Firefox for Playwright. Recommend yes before M4:
   the worker path, which decides whether Stop exists, has never run outside
   Chrome.
3. B13, `eststo` and `esttab` under their familiar names. Recommend yes, with
   the scope written in B13, because it is the most common last line of a
   student's do-file that the runtime cannot run.

R1's cost and the order of B15 and the courses can wait until M3.

## 6b. Progress on 12 November (evening)

All of this is in open pull requests; nothing below is merged or deployed.
Each package was checked against Stata 19 with a recorded output case, and
each red-team finding was fixed on the branch it concerned.

| PR          | What                                             | Base |
| ----------- | ------------------------------------------------ | ---- |
| #31         | A0: checks write receipts outside the tree       | main |
| #32         | A1: the wide probe, with output assertions       | main |
| #33         | A3: crashes and false errors; nbreg at alpha = 0 | main |
| #34         | A2: silent wrong results, graph options          | #32  |
| #35         | A4: coverage matrix                              | main |
| #37         | Large datasets in graphs; by() and tick faults   | #34  |
| #38         | error # prints Stata's message                   | main |
| #39         | B1: coefficient references in test and lincom    | main |
| #40         | tobit, ologit, nbreg tables laid out by term     | #33  |
| #41         | Coefficient-table width for regress              | main |
| #42         | The same for logit, probit, poisson              | #41  |
| #43         | ttesti; ttest, unequal and welch                 | main |
| #44         | prtesti                                          | main |
| #45         | robvar                                           | main |
| #46         | bitest, bitesti                                  | main |
| #47         | signtest                                         | #46  |
| #48         | Long continuous-interaction labels               | #42  |
| website #54 | E2 live check, E3 font-face guard                | main |

Merge notes. #33 and #34 both add a line to `Session.select`: keep both
(`parsed.only` and `this.panelRows`). #44 to #47 all add functions and
registry lines to `src/runtime/tests.js`; conflicts are adjacent lines.
Every PR that adds a recorded case appends to `tools/output-cases.txt`, and
the fixture must be re-recorded after merging several of them
(`node tools/check-output-native.mjs`), then `npm test`. After the merges,
rerun `node tools/wide-probe.mjs --write` and
`node tools/coverage-matrix.mjs --write` on `main`.

A trial merge of every branch above into one local branch, made at 19:47,
showed the hazards. The conflicts in `src/runtime/tests.js` nest, and
resolving them by keeping both sides cut the end of `robvar` off from the
`bitest` comment that follows it. Run `node --check src/runtime/tests.js`
after resolving. With that repaired, the bundles rebuilt and the output
fixture re-recorded (118 cases), all 406 unit tests passed. The wide probe
stood at 519 cases: 391 pass, 128 refused, 0 wrong, 0 crash. The coverage
matrix showed 143 of 193 registered commands in a recorded fixture.

Found and not yet fixed, each measured against Stata:

- The coefficient-table width (#41, #42) is not yet used by the likelihood
  family, margins, lincom or the beta table of regress.
- For c.x#i.f Stata orders the factor first and names the coefficient
  1.f#c.x; the runtime keeps the typed order. This renames design-matrix
  columns and belongs with B2.
- tobit's iteration log lacks Stata's "Refining starting values" and "Grid
  node" lines.
- robvar on a by() variable with very many values runs where Stata stops
  with r(134) "too many values".

## 7. Releasing, as it is done today

The only release input is `commit` in `config/stataverse.json` of
`ihelfrich/ihelfrich.github.io`. When a change to that file reaches the
website's `main`, its deploy workflow checks out that STATAverse commit on
GitHub Actions, runs `npm ci && npm run package:site`, refuses a dirty or
mismatched package, builds and publishes. Steps 2 to 4 below are a local
rehearsal of what the workflow will do. Each step that publishes needs his
go-ahead.

1. `gh pr merge <n> --merge` in STATAverse; `git checkout main && git pull`.
2. `npm run package:site`, then check that `dist/site-package.json` says
   `"dirty": false` and that `git status` is empty.
3. In a fresh checkout of the website repository (the one at
   `/Users/ian/Developer/agent-playground/stataverse-pin-a611179` is behind
   `origin/main`; fetch first), branch `claude/stataverse-pin-<sha7>` from
   `origin/main` and set `commit` to the full SHA of STATAverse `main`. The
   commit must exist on the remote.
4. `STATAVERSE_PACKAGE_DIR=/Users/ian/Developer/STATAverse/dist node scripts/prepare-stataverse.mjs`,
   then `npx astro build`, `npm run pagefind`,
   `node scripts/check-public-discovery.mjs`, `npm run check:stataverse`.
   "STATAverse package does not match the pinned release" means the package's
   commit differs from the pin. "The public site requires a clean STATAverse
   source package" means the package was built from a dirty tree.
5. Commit, push, open the pull request, merge it on his word. The "Build and
   deploy hub" workflow publishes. A daily run at 07:30 UTC redeploys whatever
   `main` pins.
6. Verify the live page: the release file, the stamp, and the page in a
   browser.

A push-triggered deploy run can sit queued with no jobs (run 43095736644 did
on 11 November and can be neither cancelled nor deleted). The scheduled run
deploys the same commit.

## 8. What is his to decide

- Whether to add CI to the repository (A5) and to download WebKit and Firefox
  for testing (A6).
- Community commands under their familiar names: `esttab`, `eststo`,
  `outreg2` (B13) and a `reghdfe`-compatible command (B15).
- `sysuse auto` and `webuse`: keep refusing, or ship a synthetic stand-in.
- The order of the estimator families (B15) and of the courses (Phase D), and
  whether Course 1 keeps `import excel`.
- Textarea or CodeMirror for the Console editor (C7).
- Whether the frozen-engine interface is built before linking (R0).
- A second model's review and what it may cost (R1).
- Linking the Console (R2), and beginning stage 5 (D5).
- Every merge and every deploy.

Ask these as they come due, one at a time, with a recommendation. Work that
does not depend on the answer continues meanwhile.

## 9. Known and not yet known

Known differences from Stata that remain are listed in
`docs/numerical-contract.md` under "Limits of that evidence" and in the dated
notes of `docs/runtime-and-courses-spec.md`. Not established anywhere: how the
site behaves in Safari, Firefox, on Windows or with a screen reader; how the
runtime performs on tens of thousands of rows; the cause of the intermittent
public navigation and search failures seen on 7 November and not since;
whether the legacy `/STATAverse/` address is still deployed from this
repository's `main`; how many more accepted-and-ignored options exist beyond
those the probe sampled.

## 10. Starting prompt for the new session

> Read `docs/development-plan.md` in `/Users/ian/Developer/STATAverse` in
> full, then `docs/numerical-contract.md` and the progress notes at the end of
> `docs/runtime-and-courses-spec.md`. Check the Agent Log and claim the work.
> Then begin milestone M1 of section 6a: A0, A1, A3, A2, A4, E2, E3. For each
> package, scout inline, run a workflow shaped as in section 5, verify every claimed
> defect by running it, run `npm run format:check` and `npm run check`, and
> open one pull request. Stop for my go-ahead before merging or deploying, and
> bring me the three decisions in section 6a before M1 ends and the rest of
> section 8 as they come due.
