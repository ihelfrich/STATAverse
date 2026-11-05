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

## Verification and limits

Independent R matrix calculations and native Stata checks must cover conventional/HC1 covariance, valid/weak/irrelevant/invalid instruments, small samples, negative endogeneity, confidence levels and Anderson–Rubin tests/inversion. Invariance checks cover row ordering and transformations of instrument units. Algebraic boundary fixtures exercise all quadratic set shapes. Browser checks cover keyboard use, validation, export, mobile layout, offline operation and the main-site mount. Passing bounded fixtures does not establish full Stata equivalence.

Primary references: [Stata ivregress manual](https://www.stata.com/manuals/rivregress.pdf), covariance definitions and `small`; [ivregress postestimation manual](https://www.stata.com/manuals/rivregresspostestimation.pdf), Anderson–Rubin tests, finite-sample scaling, `estat weakrobust` and confidence sets. Source text was checked through Spider on November 5, 2026.
