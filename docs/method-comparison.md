# Method comparison

`MethodLab/` is a reference tool, separate from the Practice interpreter and numerical analysis labs. Students specify an outcome, observation structure, proposed research design and dependence assumption. The tool returns candidate specifications with their targets, conditions, syntax, checks and limitations. It does not inspect a dataset or infer identification from a concern about endogeneity.

## Content and generation

`assets/data/method-lab.json` owns the model descriptions and reference claims. `src/method-comparison.js` combines those claims with the selected setup. `src/method-lab.js` renders them, retains selections in the address and exports a complete text comparison. No new browser-storage record is introduced.

`tools/build-method-guides.mjs` generates the two legacy-named method-reference do-files during `npm run build`. These files print guidance and command templates. They do not clear data or run placeholder models. An optional topic argument selects one section, for example:

```stata
do "02_method_decision_tree_v2.do" lpm
do "02_method_decision_tree_v2.do" panel
```

Omitting the argument prints all sections. Unknown topics return Stata error 198. The compact reference omits command templates and extended checks. Do not edit generated guides directly.

## Statistical boundaries

A binary outcome permits both a linear probability specification and a nonlinear probability model. The comparison distinguishes probability-point slopes from log-odds coefficients and marginal effects. Linear fitted values can lie outside the outcome range.

Repeated observations do not establish a causal design. Linear unit effects remove additive, time-invariant heterogeneity under the stated static specification; time-varying confounding and feedback remain possible. Pooled nonlinear models with clustered covariance are explicitly distinguished from unit-effects models.

An IV or DID template appears only when the student explicitly selects that proposed design. It remains conditional on its identifying assumptions. IV templates are linear 2SLS, and DID templates describe a two-group, two-period mean comparison. Neither is presented as an instrumented nonlinear outcome model or a general staggered-adoption solution. Survival outcomes require a separate event-time estimand; the comparison does not append a linear IV or DID command to them.

Unknown dependence and complex-survey choices leave every model command commented out. Independent-observation covariance is not automatically supplied for pooled repeated-record specifications. For linear FE and conditional FE Poisson, the panel-level behavior of `vce(robust)` is stated. An explicitly selected higher-level cluster uses a Poisson fit with unit indicators because `xtpoisson, fe` does not support arbitrary `vce(cluster ...)` syntax.

The relevant official references inspected during this revision were the [xtreg manual](https://www.stata.com/manuals/xtxtreg.pdf), [xtpoisson manual](https://www.stata.com/manuals/xtxtpoisson.pdf) and [logit manual](https://www.stata.com/manuals/rlogit.pdf). Native execution independently checked the generated syntax on the installed Stata version. Those sources and checks do not certify a user's empirical design.

## Verification

The unit suite enumerates all 200 selection combinations, checking that unresolved or randomized designs do not silently generate IV/DID, blocked commands remain comments, survival templates use risk intervals, and exports retain every condition and limitation. Links are checked against local resources, including the lesson hash used for within-group transformations.

The native runner deduplicates outcome/structure/code combinations. It executes those actual templates against deterministic synthetic data, checks nonempty samples and finite estimated covariance, and runs every reference topic, the no-argument default and unknown-topic handling. Data signatures, observation order and variable labels are checked around every reference invocation. The receipt is `docs/verification/method-native.json`; license-bearing logs remain in a private temporary directory outside the repository. These 78 cases establish bounded execution checks, not statistical equivalence or estimator suitability.

Browser cases cover exports, denied and delayed clipboard operations, invalid query values, reset, navigation history, expanded syntax, keyboard access, desktop/mobile accessibility and offline reopening of a new query address. The service worker reuses only the MethodLab static shell for its client-side query choices; no global query-ignoring rule was added. No-JavaScript users retain the reference download and reading links.

The bounded Scholon lookup for advanced teaching/navigation reuse timed out during this increment. Its coverage is unknown. This work extends the existing STATAverse source and reference files; no replacement project or independent teaching-content store was created.
