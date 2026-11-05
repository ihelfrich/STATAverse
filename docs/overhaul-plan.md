# Student learning overhaul

Owner: Codex chat 01a1a93e-afc3-7e12-88fb-5884548e56a1. Working branch: codex/student-workbench-overhaul. Requested 4 November 2026.

The existing site contains useful lessons and scripts, but browser exercises mainly expose static text, checkboxes and copy buttons. The primary objective is an end-to-end student path connecting commands to data changes, numerical results, graphs and interpretation, with portable work that runs in Stata.

## Acceptance criteria

- A first-time student can inspect data, run a command, see its result and complete a checked exercise without installing anything.
- The browser practice environment accurately identifies its supported Stata subset. Unsupported syntax must stop with an actionable explanation rather than fabricate results.
- Every numerical teaching claim is tied to the supplied data or qualified as conditional. Regression calculations receive independent reference checks, including covariance and missing-data behavior.
- Lessons include data inspection, missing values, transformations, grouped summaries, visualization, regression, inference and reproducible do-files. Existing advanced material remains accessible.
- Students can undo destructive practice commands, reset, save progress and export data and do-files. Failure to save must be visible. Exported code uses Stata syntax.
- Keyboard, mobile, no-storage and failed-network paths receive browser checks. No client information enters examples or fixtures.
- The final review attacks statistical claims, false exercise completion, parser edge cases, destructive operations, inaccessible controls and broken links. Findings are reproduced before correction.

## Execution state

Repository cloned from ihelfrich/STATAverse; migration archive identified and preserved. Agent Log claimed. Bounded prior-work lookup timed out; no conclusion about catalog coverage. No production publication is authorized by this local overhaul request.

The first increment is committed as `c7450d5`. Its verification and registration receipts are recorded under `docs/verification/` and `docs/red-team-review.md`. Dr. Helfrich explicitly rejected stopping at that increment. A new active goal now has a configured 5,000,000-token budget. That is a work budget, not a claim about tokens already consumed.

## Continuing implementation

The current work targets mixed levels, with a clear beginner path and substantial advanced work. The stages below are implementation commitments to investigate and verify, not claims that features already exist.

1. **Command execution and feedback.** Add a capable, accessible do-file editor, single-command execution, source locations, command history and visible changes to data. Replace whole-dataset exercise equality with checks of the actual task. Preserve saved work.
2. **Data preparation and reproducibility.** Extend local data handling, inspectable transformations, grouping, joins and reshaping where the browser implementation can be verified. Retain original inputs and export reproducible Stata projects. Unsupported syntax must remain explicit.
3. **Beginner and intermediate curriculum.** Develop task sequences that require prediction, execution, diagnosis and interpretation. Add progressively revealing help, meaningful feedback for common mistakes and independent practice. Avoid making example copying the only practical path.
4. **Advanced visual analysis.** Build substantive interactive work around partial regression, specification, heteroskedasticity, panel models, nonlinear response, instrumental variables and difference-in-differences. Each implemented method needs stated assumptions and independent numerical checks.
5. **Coherent design.** Integrate practice, analysis labs, projects and reference. Reduce mobile scrolling between an action and its result, keep the next task visible, and make dense numerical work readable. Test actual tasks, keyboard use, narrow layouts and zoom, in addition to automated accessibility checks.
6. **Repeated adversarial review.** Reproduce statistical, parser, persistence, export and usability failures. Review student-facing wording and design on real screens after each substantial stage. Record limits and unresolved defects rather than treating a passing suite as complete assurance.

The existing native Stata archive, legacy routes and browser progress remain migration constraints. No public deployment or paid external model generation is included in the current execution.

## First-increment verification

27 engine/persistence tests and 36 desktop/mobile browser cases passed. All 558 checked local links resolve. Project-path, cache isolation and offline checks passed. Nine native teaching scripts, two applied projects and sixteen template cases completed their numerical checks; Java-dependent import/PNG export limitations are recorded separately. Seven selected reusable assets were registered in Scholon. Changes remain local on the review branch.

## Curriculum increment

The practice path now has 16 lessons and 68 steps organized into four selectable tracks. The original lesson IDs and step positions remain stable. New work covers observation order, do-files, temporary samples, group comparisons, estimation/prediction sample accounting, log and quadratic specifications, interaction terms and diagnosis of deliberately flawed drafts. Each step has two stages of help; 15 steps require a numerical result rather than selecting a displayed answer. Worked repairs adapt when the flawed draft has already created its variables.

Native verification covers every canonical lesson sequence and a separate preserve/restore behavior sequence. The next major implementation work remains richer local data handling and additional advanced interactive methods. This increment does not complete the active five-million-token goal.

## Local import increment

Local CSV/TSV and semicolon-delimited data now enter through an explicit preview with type, name and missing-value decisions. Sources are retained, saved-work schema v3 migrates older work, and project exports include only the imported sources used by the current session. Larger data use a paged browser and bounded output/undo retention. Verification includes independent CSV fixtures and real browser import, recovery, export, removal and keyboard paths.

The next advanced increment develops repeated-sampling inference under independent, heteroskedastic and clustered errors. The design must distinguish one realized interval from its repeated-sample coverage, show Monte Carlo uncertainty, preserve seeded reproducibility and cancellation, and compare calculations with independent R/native Stata references. The bounded prior-work lookup for this capability timed out; that is incomplete catalog coverage, not evidence of absence.
