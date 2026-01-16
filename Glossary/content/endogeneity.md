## What is Endogeneity?

**Plain English:** Your explanatory variable (X) is tangled up with things you didn't measure, making your regression coefficient biased and untrustworthy.

**Why It Matters:** If X is endogenous, your estimate is WRONG. You might think increasing marketing spend boosts sales by 20%, when the true effect is only 5%. You cannot make causal claims from endogenous models.

---

## The Three Types of Endogeneity

### 1. Omitted Variable Bias

**The Problem:** You left out an important variable (Z) that affects both X and Y.

**Example:** You regress firm performance (Y) on CEO pay (X), but omit firm size (Z). Larger firms pay CEOs more AND perform better. Your regression will overestimate the CEO pay effect.

**Intuition:** The missing variable is secretly driving both things you're studying. Your coefficient picks up both the true effect AND the confounding effect.

### 2. Reverse Causality

**The Problem:** Y causes X, not X causes Y (or both cause each other).

**Example:** You regress stock price (Y) on analyst recommendations (X). But analysts recommend stocks BECAUSE prices are rising. The arrow goes backward.

**Intuition:** You think you're studying X → Y, but really it's Y → X. Your regression can't tell the difference.

### 3. Simultaneity

**The Problem:** X and Y determine each other at the same time.

**Example:** Demand and price are simultaneously determined in a market. Higher demand increases price, but higher price decreases demand. You can't untangle cause from effect.

**Intuition:** Mutual causation creates a feedback loop. OLS gives you a blend of both effects, not a clean estimate of either.

---

## Visualizing the Bias

<div class="interactive-placeholder" data-viz="endogeneity-scatter">
**Interactive Simulation** (expand below)

Try adjusting the correlation between X and the error term (ρ):
- ρ = 0: No endogeneity → OLS is unbiased
- ρ = 0.5: Moderate endogeneity → OLS overestimates
- ρ = 0.9: Severe endogeneity → OLS is wildly wrong

Compare: Naive OLS (blue) vs. True effect (green)
</div>

**What you'll see:** As endogeneity increases (ρ → 1), the OLS estimate drifts farther from the truth. Even ρ = 0.3 can double your coefficient!

---

## Mathematical Definition

<details class="math-toggle algebra">
  <summary>Show algebra form</summary>
  <div class="math-block">
    The core requirement for OLS to be unbiased is:

    \[E[u|X] = 0\]

    This says: "The error term u is independent of X."

    **Endogeneity means this fails:** \(E[u|X] \neq 0\)

    When endogeneity is present, the OLS estimator is:

    \[\hat{\beta}_{OLS} = \beta + \frac{Cov(X, u)}{Var(X)}\]

    That second term is the bias. If \(Cov(X, u) \neq 0\), you're not estimating β.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show linear algebra form</summary>
  <div class="math-block">
    In matrix notation, OLS is:

    \[\hat{\beta}_{OLS} = (X'X)^{-1}X'y\]

    Substituting \(y = X\beta + u\):

    \[\hat{\beta}_{OLS} = \beta + (X'X)^{-1}X'u\]

    Taking expectations:

    \[E[\hat{\beta}_{OLS}] = \beta + E[(X'X)^{-1}X'u]\]

    **If endogenous:** \(E[X'u] \neq 0\), so the second term is non-zero → bias.
  </div>
</details>

---

## How to Detect Endogeneity

### Tests in Stata

**1. Hausman Test (for panel data)**
```stata
* Estimate fixed effects and random effects
xtreg y x1 x2, fe
estimates store fe_model

xtreg y x1 x2, re
estimates store re_model

* Test for endogeneity
hausman fe_model re_model
```

**Interpretation:** If p < 0.05, reject random effects (evidence of endogeneity).

**2. Durbin-Wu-Hausman Test (for IV models)**
```stata
* After running 2SLS:
ivregress 2sls y x1 x2 (x_endog = z_instrument)

* Test if endogeneity is present
estat endogenous
```

**Interpretation:** If p < 0.05, X is endogenous. You need IV, not OLS.

**3. Visual Inspection**
```stata
regress y x1 x2
predict resid, residuals

* Plot residuals vs. suspected endogenous variable
scatter resid x1
```

**What to look for:** Systematic patterns suggest endogeneity (e.g., residuals increase with X).

---

## How to Fix Endogeneity

### Solution 1: Find an Instrumental Variable (IV)

**What you need:** A variable Z that:
1. **Relevance:** Z affects X (strong first stage)
2. **Exclusion:** Z affects Y ONLY through X (no direct effect)
3. **Exogeneity:** Z is uncorrelated with the error term

**Stata implementation:**
```stata
* Two-stage least squares (2SLS)
ivregress 2sls y x1 x2 (x_endog = z_instrument), first

* Check instrument strength
estat firststage

* Test overidentification (if multiple instruments)
estat overid
```

**Example:** Studying effect of education on wages. Use distance to college as IV (affects education but not wages directly).

### Solution 2: Fixed Effects (for panel data)

**What it does:** Removes time-invariant confounders by focusing on within-unit changes.

**Stata implementation:**
```stata
xtset firm_id year
xtreg y x1 x2, fe vce(cluster firm_id)
```

**Example:** Firm fixed effects control for unobserved firm culture, industry, etc.

### Solution 3: Difference-in-Differences

**What it does:** Exploits a natural experiment or policy change to identify causal effects.

**Stata implementation:**
```stata
* Basic DiD
regress y treat##post x1 x2, robust

* The interaction coefficient is your causal estimate
```

### Solution 4: Control Function Approach

**What it does:** Explicitly model the endogeneity and include residuals as a control.

**Stata implementation:**
```stata
* Step 1: Regress endogenous variable on instruments
regress x_endog z_instrument x1 x2
predict resid_x, residuals

* Step 2: Include residuals in main regression
regress y x_endog resid_x x1 x2, robust
```

---

## Common Mistakes

### ❌ Mistake 1: Adding More Controls to "Fix" Endogeneity

**Why it fails:** If the confounder is unobserved, adding observed controls doesn't help. You need IV or FE.

**Example:** Controlling for 20 variables won't fix endogeneity if ability (unobserved) drives both education and wages.

### ❌ Mistake 2: Using a Weak Instrument

**Why it fails:** Weak instruments create MORE bias than OLS!

**How to check:**
```stata
estat firststage
* F-statistic should be > 10 (ideally > 20)
```

### ❌ Mistake 3: Ignoring the Problem

**Why it fails:** Reviewers WILL ask about endogeneity. You need a credible strategy.

**Better:** Acknowledge endogeneity, discuss magnitude with sensitivity analysis (e.g., Oster 2019 bounds).

---

## In Published Research

**How to report:**
> "We address potential endogeneity using instrumental variables estimation. Our instrument, Z, is strongly correlated with X (F = 47.2, p < 0.001) and satisfies the exclusion restriction because [theoretical argument]. The Durbin-Wu-Hausman test confirms endogeneity is present (χ² = 12.4, p < 0.01). After controlling for endogeneity, the effect of X on Y is β = 0.34 (SE = 0.12, p < 0.01), compared to the naive OLS estimate of β = 0.58."

**Top journals expect:**
1. Clear statement of endogeneity concern
2. Theoretical argument for IV validity
3. First-stage diagnostics (F-stat, partial R²)
4. Overidentification test (if multiple IVs)
5. Comparison of OLS vs. IV estimates

---

## Related Concepts

- **[Omitted Variable Bias](./omitted-variable-bias.html)** - The most common type of endogeneity
- **[Instrumental Variable](./instrumental-variable.html)** - The primary solution
- **[Bias](./bias.html)** - What endogeneity causes
- **[Confounding](./confounding.html)** - Another way to think about endogeneity
- **[Selection Bias](./selection-bias.html)** - Endogeneity from non-random samples

---

## Further Reading

**Essential Papers:**
- Hill, A. D., et al. (2021). "Endogeneity: A review and agenda." *Journal of Management*, 47(1), 105-143. [Comprehensive review of endogeneity in management research]

- Semadeni, M., et al. (2014). "The perils of endogeneity and instrumental variables in strategy research." *Strategic Management Journal*, 35(7), 1070-1079. [Simulation showing how IV can fail]

- Hamilton, B. H., & Nickerson, J. A. (2003). "Correcting for endogeneity in strategic management research." *Strategic Organization*, 1(1), 51-78. [Practical guide to solutions]

**Textbooks:**
- Wooldridge (2010). *Econometric Analysis of Cross Section and Panel Data*. Chapter 5 (IV methods) and Chapter 6 (Panel data).
- Angrist & Pischke (2009). *Mostly Harmless Econometrics*. Chapter 4 (IV in detail).

**STATAverse Modules:**
- [Endogeneity Simulator](../CodeLibrary/scripts/01_endogeneity_simulator.do) - See bias in action
- [Method Decision Tree](../CodeLibrary/scripts/02_method_decision_tree_v2.do) - Choose the right fix

---

## Interactive Practice

[TRY]
- [ ] Download the endogeneity simulator script
- [ ] Generate data with ρ = 0.5 (moderate endogeneity)
- [ ] Compare OLS vs. IV estimates

[PREDICT]
- [ ] What do you expect: Will OLS overestimate or underestimate?
- [ ] By how much?

[CHECK]
- [ ] Run the simulation. Were you right?

[REFLECT]
- Write one paragraph: Why does even ρ = 0.3 cause serious bias? What does this mean for your own research?
