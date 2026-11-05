# Instrumental-variables lab contract

The lab studies one endogenous regressor, one excluded instrument and an intercept. It is a synthetic, independent-observation experiment; it does not establish the validity of an instrument in an empirical application. Every displayed estimate uses the same complete sample. This is a dedicated browser calculation, not an extension of the Practice command interpreter.

## Population and identification

Draw independent standard-normal z, v and e. Set x = πz + v, u = σ(ρv + √(1−ρ²)e), and y = 2 + βx + δz + u. Thus z is independent of u. Exclusion holds when δ = 0, and relevance holds when π ≠ 0. The structural coefficient is β. For π ≠ 0 the population IV ratio is β + δ/π; the population OLS slope is β + (δπ + σρ)/(π²+1). At π = 0 the population IV ratio is undefined, even if the sample covariance happens to be nonzero.

The generator preserves latent draws when parameters change. Transcendental functions can differ in their final floating-point bits between JavaScript engines; exports retain the exact browser values instead of regenerating them in Stata. Supported inputs are n = 30–2,000, unsigned nonzero 32-bit integer seeds, β ∈ [−5,5], π ∈ [0,2], ρ ∈ [−.95,.95], δ ∈ [−2,2], σ ∈ [.1,5], and confidence levels .90, .95 or .99. These limits are interface/resource limits, not identification assumptions.

## Estimation and covariance

With centered cross-products S, the IV slope is Szy/Szx and the intercept is mean(y) − b mean(x). The first stage is x on z; the reduced form is y on z. The first-stage F statistic has one numerator degree of freedom and is the square of the corresponding slope t statistic. Its covariance specification follows the selected conventional/HC1 method.

The 2SLS covariance uses residuals y − b0 − bx, not residuals from regressing y on fitted x. Write H = Szx²/Szz. Conventional slope variance is [Σû²/(n−2)]/H. HC1 uses influence rows (zc/Szx, 1/n − mean(x)zc/Szx), in slope/intercept order, and multiplier n/(n−2). The displayed Wald interval uses t(n−2), matching `ivregress 2sls y (x = z), small`, with `vce(robust)` when selected. Weak instruments can make this Wald interval unreliable.

Exactly zero sample relevance, or absolute sample correlation at most 10⁻¹², suppresses the numerical IV point estimate and its Wald interval. This is a numerical guard, not a statistical instrument-strength cutoff. Constant x or z and non-finite/oversized data are rejected explicitly. Generated samples have no missing observations.

## Anderson–Rubin inversion

For a candidate b, regress y − bx on z with an intercept and test the z coefficient. The accepted set contains every b for which this F statistic is no larger than t(n−2, 1−α/2)². The conventional test has an exact finite-sample reference under the valid normal, homoskedastic generator. HC1 with this F reference is an approximation. Neither version repairs exclusion failure.

Let γ and π̂ be the reduced-form and first-stage slopes, and ry and rx their residuals. The slope variance of the transformed-outcome regression is vyy − 2b vxy + b² vxx. Conventional v terms divide residual cross-products by (n−2)Szz; HC1 weights them by zc² and multiplies by n/[(n−2)Szz²]. The confidence set solves (π̂²−c vxx)b² + (−2γπ̂+2c vxy)b + γ²−c vyy ≤ 0. Analytic inversion preserves bounded intervals, two unbounded rays, half-lines, the whole line, singletons and the empty set. Plotting bounds do not determine confidence-set endpoints. Numerically degenerate variances are reported as unavailable, without fabricated p-values.

## Guided investigations and saved work

Three investigations provide 16 supported tasks: two-stage estimation (five), weak-instrument confidence sets (six), and exclusion failure (five). Numerical checks use the experiment's exact settings and accept three-decimal rounding. Tasks that require selecting an observation or testing a candidate also check that inspection state. Correct-choice positions vary. These checks provide guided practice, not proof of unaided mastery.

Each investigation saves its current task, a separate experiment and response for every visited task, and a shared note. Returning to a task restores that state; resetting a task preserves the other tasks and the note. Previously checked responses are reassessed before the Next control is enabled. Editing analysis settings or the response requires a fresh check; editing the note does not. Invalid inputs retain the last valid draft and visibly report unsaved changes.

The existing lab-progress key accepts completion-only version 1 and draft-bearing version 2. Workspace backup version 3 includes both Data and IV investigations. A shared Web Lock serializes current lab writes, imports and clears. Unique change identifiers make even repeated clears of an empty workspace distinguishable from its earlier state. A stale lab session becomes read-only, while its in-memory work remains exportable. Corrupt stored data are retained; storage failures never produce a saved-on-device claim. Browsers without Web Locks use an optimistic byte comparison, which does not supply the same cross-tab serialization guarantee. An older public page must reload to adopt these protections.

The investigation UI loads only when a guide is selected. A failed module load exposes a retry without disabling the experiment. Its bundle is included in the scoped offline cache. The static homepage and search index link directly to each guide. The main browser Practice interpreter remains a separately bounded command subset.

## Verification and limits

Independent R matrix calculations and native Stata checks must cover conventional/HC1 covariance, valid/weak/irrelevant/invalid instruments, small samples, negative endogeneity, confidence levels and Anderson–Rubin tests/inversion. Invariance checks cover row ordering and transformations of instrument units. Algebraic boundary fixtures exercise all quadratic set shapes. Browser checks cover keyboard use, validation, export, mobile layout, offline operation and the main-site mount. Passing bounded fixtures does not establish full Stata equivalence.

Primary references: [Stata ivregress manual](https://www.stata.com/manuals/rivregress.pdf), covariance definitions and `small`; [ivregress postestimation manual](https://www.stata.com/manuals/rivregresspostestimation.pdf), Anderson–Rubin tests, finite-sample scaling, `estat weakrobust` and confidence sets. Source text was checked through Spider on November 5, 2026.
