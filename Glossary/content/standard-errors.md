## What Does This Mean?

A measure of how much your coefficient would bounce around if you repeated your study with different samples from the same population.

Small standard error: Your estimate is precise. Repeating the study would give you similar results.

Large standard error: Your estimate is noisy. Repeating the study might give you wildly different results.

**Why this matters:** Standard errors determine your p-values, t-statistics, and confidence intervals. Wrong standard errors = wrong inference. You might think a result is significant when it's not, or miss a real effect because your standard errors are inflated.

---

## What Standard Errors Tell You

Your coefficient estimate is ONE number from ONE sample. But if you drew a different sample, you'd get a slightly different coefficient.

Standard errors quantify that uncertainty.

**Example**: You estimate that training increases productivity by 8 points. The standard error is 2.

**Interpretation**: If you repeated this study 100 times with different samples, about 95% of your estimates would fall between 4 and 12 (roughly ±2 standard errors from 8).

**Not interpretation**: "There's a 95% chance the true effect is between 4 and 12." That's wrong. The true effect is fixed. The confidence interval is what bounces around across samples.

---

## Types of Standard Errors

### Classical (Default)

```stata
regress y x1 x2 x3
```

Assumes:
- Errors are homoskedastic (same variance everywhere)
- Errors are independent across observations
- Errors are not serially correlated

**Problem**: These assumptions almost never hold in real data. Classical standard errors are usually wrong.

### Robust (Heteroskedasticity-Consistent)

```stata
regress y x1 x2 x3, robust
```

Allows error variance to differ across observations (heteroskedasticity).

**When to use**: Always. Seriously. Make this your default. There's no cost to using robust standard errors, and huge benefits.

Also called:
- White standard errors
- Huber-White standard errors
- Sandwich estimator
- HC (heteroskedasticity-consistent) standard errors

### Clustered

```stata
regress y x1 x2 x3, vce(cluster firm_id)
```

Allows errors to be correlated within clusters (e.g., within firms, within people over time).

**When to use**:
- Panel data (cluster by unit ID)
- Grouped data (students within schools, employees within firms)
- Time series (observations correlated over time)

**Why it matters**: Regular standard errors assume independence. If observations within clusters are correlated, regular standard errors are too small, and you'll find false significance.

### Two-Way Clustered

```stata
reghdfe y x1 x2, absorb(firm_id year) vce(cluster firm_id year)
```

Allows correlation within firms AND within years.

**When to use**: Panel data where you're worried about both firm-level correlation over time and year-level correlation across firms.

### Bootstrapped

```stata
regress y x1 x2 x3, vce(bootstrap, reps(1000))
```

Resamples your data thousands of times, re-estimates the model each time, and calculates standard errors from the distribution of estimates.

**When to use**:
- Small samples
- Weird distributions
- Complex estimators where formulas are hard

**Downside**: Computationally expensive. Might take minutes instead of seconds.

---

## How to Choose

**Decision tree**:

1. Do you have clustered data (panel, hierarchical)?
   - YES → Use clustered standard errors
   - NO → Continue

2. Do you have heteroskedasticity?
   - Check with `estat hettest` after OLS
   - Probably YES → Use robust standard errors
   - Even if NO → Still use robust (it doesn't hurt)

3. Are you worried about weird distributions or complex models?
   - YES → Consider bootstrap
   - NO → Stick with robust or clustered

**Default recommendation**:
- Cross-sectional data: Use `robust`
- Panel data: Use `vce(cluster unit_id)`
- Always check diagnostics

---

## How Standard Errors Affect Inference

### T-statistic

\[ t = \frac{\hat{\beta}}{SE(\hat{\beta})} \]

Bigger standard error → smaller t-stat → higher p-value → less likely to be significant.

### Confidence Interval

\[ \text{95% CI} = \hat{\beta} \pm 1.96 \times SE(\hat{\beta}) \]

Bigger standard error → wider confidence interval → more uncertainty.

### Practical Example

Coefficient: 5.0

Classical SE: 1.0 → t = 5.0, p < 0.001, CI = [3.0, 7.0]
Robust SE: 2.0 → t = 2.5, p = 0.01, CI = [1.0, 9.0]
Clustered SE: 3.5 → t = 1.4, p = 0.16, CI = [-2.0, 12.0]

Same coefficient. Different conclusions depending on standard errors.

With classical SEs: Highly significant.
With robust SEs: Significant at 1%.
With clustered SEs: Not significant.

**Lesson**: Standard errors matter as much as coefficients.

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the classical formula</summary>
  <div class="math-block">
    OLS variance-covariance matrix (classical):

    \[Var(\hat{\beta}) = \sigma^2 (X'X)^{-1}\]

    where \(\sigma^2\) is the error variance, estimated by:

    \[\hat{\sigma}^2 = \frac{1}{n-k} \sum_{i=1}^n \hat{u}_i^2\]

    Standard errors are the square roots of the diagonal elements of \(Var(\hat{\beta})\).

    **Key assumption**: \(Var(u_i | X) = \sigma^2\) for all i (homoskedasticity).
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the robust formula</summary>
  <div class="math-block">
    Robust variance (White/Huber sandwich estimator):

    \[Var(\hat{\beta}) = (X'X)^{-1} \left( \sum_{i=1}^n \hat{u}_i^2 x_i x_i' \right) (X'X)^{-1}\]

    This doesn't assume constant variance. Each observation gets its own squared residual \(\hat{u}_i^2\).

    For clustered standard errors (cluster by group g):

    \[Var(\hat{\beta}) = (X'X)^{-1} \left( \sum_{g=1}^G X_g' \hat{u}_g \hat{u}_g' X_g \right) (X'X)^{-1}\]

    where \(X_g\) and \(\hat{u}_g\) are the X matrix and residuals for cluster g.

    This allows errors to be correlated within clusters but not across clusters.
  </div>
</details>

---

## Common Mistakes

**"Classical standard errors are fine if I have a big sample."** No. Big samples don't fix heteroskedasticity or clustering. Use robust or clustered SEs regardless of sample size.

**"I'll use clustered SEs just to be safe."** Good instinct, but cluster at the right level. Clustering when you shouldn't slightly inflates SEs (conservative). Not clustering when you should severely underestimates SEs (dangerous).

**"Robust and clustered are the same thing."** No. Robust allows heteroskedasticity but still assumes independence. Clustered allows correlation within clusters.

**"My standard errors got bigger when I clustered, so I'll use regular SEs instead."** That's p-hacking. If clustering is appropriate for your data structure, use it. Bigger SEs mean more honest uncertainty.

**"I'll bootstrap everything to be safe."** Bootstrap doesn't fix model mis-specification, endogeneity, or omitted variables. It only helps with distributional assumptions. Don't use it as a crutch.

---

## Panel Data: Always Cluster

If you have panel data (same units observed multiple times), **always cluster by unit ID**.

```stata
xtset firm_id year
regress y x1 x2, vce(cluster firm_id)
```

**Why**: Observations from the same firm are almost certainly correlated. Wages in 2020 are correlated with wages in 2021 for the same firm. Not accounting for this gives you standard errors that are way too small.

**How much does it matter?**

Example: Estimating effect of training on wages, 1000 firms over 5 years.

Classical SEs: SE = 0.50, t = 6.0, p < 0.001
Clustered SEs: SE = 1.20, t = 2.5, p = 0.01

The t-statistic drops by 60%. That's huge.

---

## How Many Clusters?

**Rule of thumb**: You need at least 30-50 clusters for clustered standard errors to be reliable.

**Fewer than 30 clusters**: Clustered SEs can be too small (ironic, but true). Consider:
- Wild bootstrap
- Cluster-robust-Jackknife
- Block bootstrap

**Unbalanced clusters** (some firms have 2 years, others have 20): Usually fine. Clustered SEs handle this.

**One big cluster, many small clusters**: The big cluster dominates the calculation. Your SEs might be too small. Consider dropping it or using two-way clustering.

---

## How to Report Standard Errors

### In Tables

Most common format: Coefficient in first row, standard error in parentheses below.

```
Training    5.23***
           (1.45)
```

Alternative: t-statistics or p-values in parentheses. Just be clear in the table notes.

### In Text

> "We report heteroskedasticity-robust standard errors throughout. Training increases productivity by 5.2 points (SE = 1.4, p < 0.001)."

Always specify which type of standard errors you're using (robust, clustered, bootstrap).

### In Methods Section

> "All models use heteroskedasticity-robust standard errors (White 1980). For panel specifications, we cluster standard errors at the firm level to account for serial correlation within firms over time. We verify robustness using wild bootstrap standard errors with 1000 replications."

---

## Real Example: Difference by SE Type

**Model**: Effect of CEO tenure on ROA, 500 firms, 10 years each.

```stata
* Classical
regress roa ceo_tenure controls
* Coefficient: 0.015, SE: 0.005, t = 3.0, p = 0.003

* Robust
regress roa ceo_tenure controls, robust
* Coefficient: 0.015, SE: 0.007, t = 2.1, p = 0.03

* Clustered by firm
regress roa ceo_tenure controls, vce(cluster firm_id)
* Coefficient: 0.015, SE: 0.012, t = 1.25, p = 0.21
```

Same coefficient (0.015). But:
- Classical: Highly significant (p = 0.003)
- Robust: Significant (p = 0.03)
- Clustered: Not significant (p = 0.21)

**Correct inference**: Use clustered (panel data → cluster by firm). The effect is not statistically significant.

Using classical SEs would have led to a Type I error (false positive).

---

## Related Concepts

- [Heteroskedasticity](./heteroskedasticity.html) - why you need robust SEs
- [Clustering](./clustered-standard-errors.html) - when observations are grouped
- [P-values](./p-value.html) - what SEs help calculate
- [Confidence Intervals](./confidence-intervals.html) - another use of SEs
- [T-statistic](./t-statistic.html) - coefficient divided by SE

---

## Read More

**Start here:**
- Cameron, A. C., & Miller, D. L. (2015). "A practitioner's guide to cluster-robust inference." *Journal of Human Resources*, 50(2), 317-372.
- Petersen, M. A. (2009). "Estimating standard errors in finance panel data sets." *Review of Financial Studies*, 22(1), 435-480.

**Then dive deeper:**
- White, H. (1980). "A heteroskedasticity-consistent covariance matrix estimator." *Econometrica*, 48(4), 817-838.
- MacKinnon, J. G., & White, H. (1985). "Some heteroskedasticity-consistent covariance matrix estimators." *Journal of Econometrics*, 29(3), 305-325.

**Try it yourself:**
- [Assumption Checker](../CodeLibrary/scripts/04_assumption_checker.do) - test for heteroskedasticity
- [Panel Data Toolkit](../CodeLibrary/scripts/06_panel_data_toolkit.do) - clustered SEs in practice

---

## Practice

[TRY]
- [ ] Run a regression with classical SEs
- [ ] Re-run with robust SEs: `regress y x, robust`
- [ ] If you have panel/grouped data, re-run with clustered SEs

[PREDICT]
- [ ] Before running: Will robust SEs be bigger or smaller than classical?
- [ ] If clustered, how much bigger will they be?

[CHECK]
- [ ] Compare t-statistics across all three
- [ ] Do any significance calls flip?

[REFLECT]
Write a paragraph explaining which standard errors are appropriate for your data and why. What assumptions are you making? What would happen if you used the wrong type?
