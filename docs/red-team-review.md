# Student overhaul: adversarial review

Reviewed on 4 November 2026. The implementation agent performed the adversarial review. Independent numerical comparisons used R and native Stata; no separate human or second-agent review is claimed.

## Findings corrected

| Failure | Consequence | Correction and evidence |
| --- | --- | --- |
| Static checkboxes passed as practical learning | Completion without running a command | Eight lessons require an observed command result and an interpretation answer. Unrelated commands cannot pass. All 30 steps run through browser controls. |
| Expression differences from native Stata | Incorrect powers, missing bounds or mixed types | Executed native fixtures; corrected left-associative powers, `inrange()` and type checks, including empty samples. |
| Unsupported options mistaken for supported inference | A request for clustering could yield ordinary inference | Explicit grammar and option validation. Errors stop do-files; atomic rollback preserves the data. |
| Unchecked numerical extremes | Overflow disguised as a missing statistic | Scaled summaries/correlations, explicit regression/graph range limits and numerical failure messages. |
| Backup import accepted arbitrary storage keys | Overwriting another application's settings | Namespaced schema validation before writes, bounded payloads and rollback. Browser tests attack arbitrary keys and partial quota failure. |
| Practice history missing from backups | Loss of analysis between devices | Backups now include reading notes, guided progress and open-practice histories; round-trip tests verify restoration. |
| Two tabs could overwrite saved work | Older tab could erase an imported copy | A storage-change event stops saving in the older tab and explains recovery. Browser test reproduces the conflict. |
| Root assumptions and global cache lookup | Project-path failures or unrelated cached responses | Relative registration, scope-specific caches and isolated lookup; deployment test covers `/STATAverse/`, offline practice and an unrelated cache. |
| Remote rendering assets and consumed TeX delimiters | Missing equations/charts | Pinned local Markdown, KaTeX and Chart.js, plus TeX-aware rendering. Tests block the former CDN. |
| Chart silently truncated to 120 observations | Plot and model used different samples | Plot all nonmissing observations and expose an accessible table; coffee plot verified at 144 observations. |
| Overstated probability and identification claims | P-values, Hausman tests and F thresholds taught as certification | Rewrote all ten glossary entries, revised method guidance and corresponding script claims. |
| IV simulation changed treatment without updating outcome | Advertised structural effect disappeared | Preserve the stated DGP and use `ivregress` for covariance. Native execution completes. |
| Classical Hausman used clustered estimates | Invalid test usage | Separate conventional fits for the classical test; retain clustered reported models and qualify interpretation. |
| Panel simulation used deterministic time and nested years | Misleading variation/decomposition | Add within-firm variation linked to omitted quality; separate fixed year effects from firm random effects. |
| Margins grid used overwritten summary results | Single x value instead of a multi-line plot | Preserve the intended grid and specify plotting dimensions. Native execution completes. |
| String categories in factor-variable notation | Logit/count examples failed | Encode supplied categories; use discrete changes for binary expedited shipping. Native checks complete. |
| `lnalpha=0` described as `alpha=0` | Wrong negative-binomial null | Remove false Wald-test recipe; explain boundary null and covariance limitations. |
| `marginsplot` followed other postestimation commands | Native `r(301)` | Plot immediately after `margins`; native template assertions pass. |
| Invalid missingness/winsorization code | Incorrect counts or replaced missing outcomes | Built-in commands, frozen original-column list and explicit missing guard; native assertions verify results. |
| Merge templates discarded unmatched rows | Silent sample restriction | Preserve unmatched rows and indicators for review; tests retain both unmatched sides. |
| Unlabeled reading checkboxes and weak filter contrast | Accessibility barriers | Accessible names, corrected filter styles and focusable scrollable code, checked on desktop and mobile reference surfaces. |
| Advisories in initially selected dependencies | Avoidable exposure | Updated and pinned affected packages. Recorded npm audit reports zero known advisories, not proof of no vulnerabilities. |

## Verification scope

### Continuing overhaul: editor and execution review

The resumed goal extends the first increment; it is not a completed redesign. The next implementation adds an accessible CodeMirror editor, current-command and selection execution, source-line diagnostics, command history with bounded before/after cell changes, compact mobile navigation and more permissive task checks.

- **Comment parsing:** an unmatched quote inside a full-line `*` comment could incorrectly stop execution. Comments now bypass string parsing. Tests cover comments, continued commands, selected ranges and source locations.
- **False rejection of valid work:** whole-dataset equality rejected an extra helper column, an equivalent generate/replace workflow or a reordered summary. Checks now compare required data and task-relevant outputs. They retain sample-membership checks; two equal counts from different groups do not pass interchangeably.
- **False completion through an unrelated error:** an arbitrary failed assertion could resemble the intended age-check failure. Failed assertions now carry checked and failing observation evidence. The exercise compares that evidence rather than accepting an error code alone.
- **Misleading change displays:** sorting rows must not be described as editing every cell. Change receipts distinguish reordering, row removal, added/removed columns, variable labels and edits to existing values. At most 200 edited cells appear per receipt.
- **Editor suggestions:** suggestions must come from the supported command/function catalogs. A review caught unsupported functions in the initial completion list; they were removed before acceptance.
- **Accessibility:** the populated History view exposed insufficient contrast in its command numbers. The color was darkened and the desktop/mobile check rerun.
- **Completion test timing:** the initial mobile test pressed Enter inside CodeMirror's deliberate 75 ms protection against accidental completion acceptance. The implementation retains that protection; the test selects the visible suggestion through its control.

The unchanged v2 storage format retains existing progress and editor text. The ZIP now also includes `editor-draft.do`, preserving comments and unexecuted text separately from the reproducible successful-command history. Tests cover selection isolation, source locations, current-command advancement, editor exit with Tab, suggestions, draft persistence and history reuse.

Limits at this stage: the required dataset projection still checks the supplied lesson's underlying values; it is not a general symbolic proof of equivalent Stata programs. History receipts are reconstructed for successful saved commands, while current-visit errors remain in the results/notes view. Full transcript persistence and more substantial curriculum changes remain further work.

### Continuing overhaul: regression analysis lab

The first advanced browser lab now connects the known generator, raw/partial-regression plots, the finite-sample omitted-variable identity, collinearity, influence diagnostics and exact Stata exports. It is one substantial lab, not the end of the broader advanced curriculum.

- **Inference after residualization:** a residual-only regression can reproduce the coefficient while using the wrong residual degrees of freedom for its default standard error. The lab explicitly uses full-model inference and explains the distinction beside the equality.
- **Sample versus population bias:** the sample identity uses estimated coefficients and the sample z-on-x slope. The population formula β + γρ is shown separately. Neither is presented as exact recovery of the structural coefficient in each draw.
- **Direct versus total effects:** control labels identify both β and γ as direct effects in the constructed system. γ alone is not the total effect of z when z also changes x.
- **Influence versus deletion:** the interface compares a temporary omission without removing rows. Cook's distance, leverage and standardized residuals are distinct. Classical diagnostics retain conventional residual variance even when the reported model covariance uses HC1.
- **Manual changes and provenance:** changing one point is visibly identified and exported. The seed is a browser-generator seed, not a promise that `set seed` in Stata reproduces it. The native do-file imports the exact exported observations.
- **Plot usability:** a first visual pass found undersized SVG labels after scaling. Labels were enlarged, narrower layouts use one plot per row, and mobile controls jump directly to parameters, plots and estimates. Linked point selection uses one keyboard stop per plot with arrow-key navigation rather than hundreds of Tab stops.
- **Test reliability:** a restore-state browser check originally mixed `innerText` with `textContent` matching, producing a false failure from table whitespace. The test now compares the same representation for both change detection and restoration.

Verification at this increment: 38 unit cases, 50 desktop/mobile browser cases and 567 local links pass. Project-prefix, offline practice, cache isolation and mobile lab navigation checks pass. Four independent R cases and four native Stata exported-workflow cases pass. Native CSV import remains substituted because of the installed Java limitation. Automated accessibility checks cover all four lab views; this does not replace student or manual assistive-technology testing.

Engine tests cover supported syntax, invalid expressions, sample selection, missing values, rollback, undo, collinearity, row-order/unit invariance and independent numerical fixtures. Browser tests cover every lesson, interpretation gating, storage failures, backups, simultaneous tabs, graph controls, exports, keyboard navigation, mobile overflow and automated accessibility checks. Deployment uses a real local server under the GitHub Pages project prefix.

Native receipts cover default settings of nine advanced scripts, both applied projects and sixteen small templates with assertions. Runtime success does not certify every branch, explanatory sentence or suitability for another dataset. Historical design notes are labeled as historical; their earlier validation claims are not evidence for this release.

## Remaining limits

- This is a browser subset, with no licensed Stata backend or arbitrary uploads. Formatting, histogram bins, storage types, collinearity omission and post-mutation estimation-state behavior differ from native Stata.
- Installed Stata lacks Java. Numerical/scalar checks use native `input`; applied-project checks disclose substitution of `insheet` for `import delimited`. Ten PNG exports reported environment failures. Graph construction and numerical execution completed, but an unmodified exported project has not completed an end-to-end Java-backed import/export run here.
- Work is local browser storage. Exported backups provide portable recovery. Clearing storage without a backup removes saved work. Progress is learning assistance, not an authenticated assessment record.
- Numerical fixtures bound observed discrepancies, not global floating-point error. Probability routines are approximate; tolerances are in the numerical contract.
- Automated accessibility checks and visual inspection do not replace testing with students, screen readers and varied assistive technology. No learning-effect claim is made.
- Local changes are reviewable on the working branch. No push, public deployment or live-site verification has occurred.
