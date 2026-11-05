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
- STATAverse is part of `https://ihelfrich.github.io/learn/stata/`, connected to the main site's Teaching page, navigation index, public catalogue, search and site map. Its pages provide a clear route back to the main site. Existing `/STATAverse/` links require compatibility handling at publication.
- Student calculations, practice, imports and exports run directly in the browser. No account, server execution or paid service is required. Measure page payloads, avoid unnecessary downloads, keep long simulations cancellable in a worker, and verify performance at the actual nested deployment path.
- The final review attacks statistical claims, false exercise completion, parser edge cases, destructive operations, inaccessible controls and broken links. Findings are reproduced before correction.

## Execution state

The canonical app is live at `https://ihelfrich.github.io/learn/stata/`, with site-wide navigation, Teaching links, search and sitemap integration. The old `/STATAverse/` address forwards to it while retaining paths, queries, fragments and browser notes. The current command path has eighteen lessons and eighty steps, supplemented by four visual analysis labs and guided data investigations. Release-specific publication evidence belongs in `docs/verification/public-release.json`; local checks and public checks are separate receipts.

The migration archive remains preserved. The initial bounded prior-work lookup timed out; it established no conclusion about catalog coverage. Later selected procedures and verification outputs are registered through the project's existing Scholon manifest. The same Agent Log claim owns the continuing work.

The first increment is committed as `c7450d5`. Its verification and registration receipts are recorded under `docs/verification/` and `docs/red-team-review.md`. Dr. Helfrich explicitly rejected stopping at that increment. On 5 November he reduced the work budget from 5,000,000 to **2,500,000 tokens total**. The goal API still reports the older configured limit and exposes no budget-edit operation; the later user limit governs the remaining work. At the correction, 2,004,510 tokens had been recorded. Priorities within the remainder are verified public releases, student usability, statistical correctness and integration at `ihelfrich.github.io/learn/stata/`.

## Continuing implementation

The current work targets mixed levels, with a clear beginner path and substantial advanced work. The stages below are implementation commitments to investigate and verify, not claims that features already exist.

1. **Command execution and feedback.** Add a capable, accessible do-file editor, single-command execution, source locations, command history and visible changes to data. Replace whole-dataset exercise equality with checks of the actual task. Preserve saved work.
2. **Data preparation and reproducibility.** Extend local data handling, inspectable transformations, grouping, joins and reshaping where the browser implementation can be verified. Retain original inputs and export reproducible Stata projects. Unsupported syntax must remain explicit.
3. **Beginner and intermediate curriculum.** Develop task sequences that require prediction, execution, diagnosis and interpretation. Add progressively revealing help, meaningful feedback for common mistakes and independent practice. Avoid making example copying the only practical path.
4. **Advanced visual analysis.** Build substantive interactive work around partial regression, specification, heteroskedasticity, panel models, nonlinear response, instrumental variables and difference-in-differences. Each implemented method needs stated assumptions and independent numerical checks.
5. **Coherent design.** Integrate practice, analysis labs, projects and reference. Reduce mobile scrolling between an action and its result, keep the next task visible, and make dense numerical work readable. Test actual tasks, keyboard use, narrow layouts and zoom, in addition to automated accessibility checks.
6. **Repeated adversarial review.** Reproduce statistical, parser, persistence, export and usability failures. Review student-facing wording and design on real screens after each substantial stage. Record limits and unresolved defects rather than treating a passing suite as complete assurance.

The existing native Stata archive, legacy routes and browser progress remain migration constraints. Public increments are released through pinned source commits and verified at their destination. No paid external model generation is needed.

## Main-site integration and efficiency

The 5 November UTC scope addition makes website integration and browser efficiency explicit acceptance criteria for the continuing goal. The main Astro site is `/Users/ian/Developer/ihelfrich.github.io`; integration work is isolated in `/Users/ian/Developer/agent-playground/stataverse-site-integration` on `codex/stataverse-site-integration`. Its shared navigation registry remains authoritative. The intended mount is `/learn/stata/`, with versioned source selection and a static student-facing package rather than a second independently edited implementation.

The bounded reuse lookup returned advisory website design reviews, not an implemented integration. The project recall matches were unrelated. The existing website, navigation registry and STATAverse build are the reused capabilities. Integration checks must cover nested URLs, return links, search discovery, service-worker scope, saved-work preservation, offline behavior and asset sizes. Further advanced methods and design/voice review remain part of the original objective.

## First-increment verification

27 engine/persistence tests and 36 desktop/mobile browser cases passed. All 558 checked local links resolve. Project-path, cache isolation and offline checks passed. Nine native teaching scripts, two applied projects and sixteen template cases completed their numerical checks; Java-dependent import/PNG export limitations are recorded separately. Seven selected reusable assets were registered in Scholon. Changes remain local on the review branch.

## Curriculum increment

The practice path now has 16 lessons and 68 steps organized into four selectable tracks. The original lesson IDs and step positions remain stable. New work covers observation order, do-files, temporary samples, group comparisons, estimation/prediction sample accounting, log and quadratic specifications, interaction terms and diagnosis of deliberately flawed drafts. Each step has two stages of help; 15 steps require a numerical result rather than selecting a displayed answer. Worked repairs adapt when the flawed draft has already created its variables.

Native verification covers every canonical lesson sequence and a separate preserve/restore behavior sequence. The next major implementation work remains richer local data handling and additional advanced interactive methods. This increment does not complete the active goal.

## Local import increment

Local CSV/TSV and semicolon-delimited data now enter through an explicit preview with type, name and missing-value decisions. Sources are retained, saved-work schema v3 migrates older work, and project exports include only the imported sources used by the current session. Larger data use a paged browser and bounded output/undo retention. Verification includes independent CSV fixtures and real browser import, recovery, export, removal and keyboard paths.

The next advanced increment develops repeated-sampling inference under independent, heteroskedastic and clustered errors. The design must distinguish one realized interval from its repeated-sample coverage, show Monte Carlo uncertainty, preserve seeded reproducibility and cancellation, and compare calculations with independent R/native Stata references. The bounded prior-work lookup for this capability timed out; that is incomplete catalog coverage, not evidence of absence.

## Inference increment

The repeated-sampling lab now implements those comparisons, including a common interval scale, selected-repetition inspection, conditional dependence controls, Monte Carlo uncertainty, worker cancellation, offline execution and exports. Five R/native sample cases cover all covariance choices. Three native simulation programs execute directly with double-precision returned results and an explicit RNG. The homepage's path ranges now reflect all sixteen lessons.

Further work remains on inspectable data preparation, additional advanced methods, discoverability across the older reference sections and continued design/voice review. The active goal remains open; this second lab is another implementation increment, not a completion claim.

## Grouped preparation increment

`egen` and `collapse` now expose group samples, source-row inspection, missingness decisions and the resulting observational unit. The next curriculum pass will connect attached means, individual values, available-case/common-case summaries and recovery of source data, followed by further relational preparation. Existing lesson IDs and progress remain unchanged in this command-level increment.

The bounded Scholon lookup for grouped teaching procedures timed out after twenty seconds. Project recall returned unrelated job-application, compatibility-database and assessment descriptions; none was a reusable Stata grouping capability. Development extends this repository. These limited searches do not establish absence elsewhere.


## Relational preparation increment

`Labs/Data/` now provides visual merge and reshape operations with source-row/cell traces, explicit key requirements, conflicting-value rules, invalid-state recovery and reproducible project exports. The guided command path remains 18 lessons and 80 steps; these visual labs supplement it. Further work should connect the lab to structured investigations and continue advanced methods and navigation improvements.

The bounded Scholon lookup for relational preparation timed out after twenty seconds. The project-recall matches (highball, laborscope and learnscope) did not supply a Stata relational-data capability. The existing STATAverse implementation and native Stata manuals were used. These limited searches do not establish absence elsewhere.


## Guided relational investigations

Three investigations and seventeen tasks now provide a checked path through the visual data lab. They reuse the existing native fixtures and connect to the homepage, search and Saved work. Stable IDs, explicit trace requirements, targeted feedback, resume links and guarded progress writes support continued work. The command curriculum remains eighteen lessons/eighty steps; investigation tasks are counted separately. Next work should deepen advanced statistical methods and improve navigation across the older materials rather than merely multiply near-identical exercises.

## Instrumental variables

The fourth analysis lab links first stages, reduced forms and structural fits on one synthetic sample. Students can vary relevance, endogeneity and exclusion, compare OLS and correctly calculated 2SLS, inspect the incorrect manual second-stage standard error, and invert Anderson–Rubin tests without forcing an unbounded set into a finite interval. Three investigations now provide sixteen tasks, replacing the four transient comparisons. Each visited task retains its experiment and response, with shared notes, task-level restoration, Workspace backups and honest storage-failure behavior. Exact sample exports and native Stata do-files support work beyond the browser.

The implementation uses independent R and native Stata reference checks, a bounded 2,000-row population and at most 300 rendered observations. It joins the existing `/learn/stata/` integration, navigation, search and offline package. The IV-specific Scholon lookup timed out; project recall returned no selected-description matches. Existing code and official Stata documentation supplied the reusable foundations. This is a bounded addition to the continuing goal, not completion of the overhaul.

The saved-investigation release passed 108 unit tests, 158 desktop/mobile browser cases, 660 link checks and eleven independent R/native IV cases. Public checks verified the exact source pin, an offline IV task and its response/settings/note after reload, beginner practice, navigation, search, sitemap, old URLs and saved-work compatibility. Its core offline package measures 496,750 bytes gzip from public response bodies. The remaining work within the revised budget should prioritize the student journey across advanced materials, voice/design consistency and meaningful adversarial cases over adding repetitive exercise counts.

## Method comparison release

The method page now separates outcome models, proposed research designs and covariance assumptions. Its 200 setups retain conditions and limitations in the browser and text exports. The printable Stata references share the same claims and preserve existing data. This increment passed 116 unit tests, 172 desktop/mobile browser cases, 665 link checks and 78 native template/reference cases. The public release pins source `5eb3a81f1e4a128d9fc32e3fdd73bfcfa09b18c6`; nine public check groups cover offline comparisons, exports, discovery and existing saved work. The method module measures 8,457 bytes gzip and the core offline package 507,608 bytes gzip. The goal remains active under the user's 2.5-million-token total cap.

The next bounded objective is to make advanced worked scripts readable and useful before download, while reviewing their substantive claims. The panel toolkit is an identified priority: it still contains unconditional advice to cluster at the panel-unit level, categorical FE/RE recommendations, and a reporting template with placeholder significance claims. Its construction and maintained assumptions must be examined before rewriting the surrounding interpretation. The new method page's qualifications do not establish that every linked older script has received the same review. Further work should retain the original downloadable filenames, reuse the existing content, connect students to relevant browser investigations and continue design/voice review.
