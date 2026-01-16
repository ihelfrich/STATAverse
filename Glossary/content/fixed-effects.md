## What Does This Mean?

You control for all the ways your units differ from each other that don't change over time. Instead of trying to measure every difference between firms, people, or countries, you just say "each unit gets its own baseline" and focus only on changes within that unit.

Think of it like tracking your weight loss. You don't compare yourself to your neighbor. You compare yourself TODAY to yourself LAST MONTH. Fixed effects does the same thing for regression—it compares each unit to itself over time.

**Why this is powerful:** It eliminates bias from anything that doesn't change. Firm culture? Gone. Individual ability? Gone. Country geography? Gone. You don't have to measure these things. They just disappear from your model.

---

## What It Actually Does

Regular OLS uses variation both **between** units and **within** units over time.

Fixed effects throws away the between-unit variation and uses only the within-unit variation.

**Example**: Do higher wages increase productivity?

**OLS logic**: Compare high-wage firms to low-wage firms. Maybe high-wage firms are also better managed, have better technology, attract better workers. Your wage coefficient picks up all that other stuff.

**Fixed effects logic**: Compare each firm to ITSELF over time. When this firm raised wages by 10%, did productivity go up? That within-firm change removes firm-level confounders.

---

## When to Use It

Use fixed effects when:

1. **You have panel data** (same units observed multiple times)
2. **You're worried about time-invariant confounders** (things that don't change)
3. **Your treatment varies within units over time**

**Perfect for**:
- Person-level ability (doesn't change)
- Firm-level culture (changes very slowly)
- Country-level institutions (stable over short periods)

**Doesn't help with**:
- Variables that don't change (can't estimate their effects)
- Time-varying confounders (still need to control for these)
- Between-unit comparisons (FE throws that variation away)

---

## Fixed Effects vs. Random Effects

**Fixed effects**: Assumes unit-specific effects are correlated with your X variables. Conservative. Always safe.

**Random effects**: Assumes unit-specific effects are uncorrelated with your X variables. More efficient (smaller standard errors) but requires a strong assumption.

**Which to use?** Run a Hausman test.

```stata
xtreg y x1 x2, fe
estimates store fixed

xtreg y x1 x2, re
estimates store random

hausman fixed random
```

- If p < 0.05: Use fixed effects (RE assumption violated)
- If p > 0.05: Either works, but FE is safer

**Default recommendation**: Use fixed effects. The efficiency gain from RE rarely matters, and the bias from getting it wrong is huge.

---

## How to Do It in Stata

### Basic Fixed Effects

```stata
xtset firm_id year
xtreg productivity wage training, fe vce(cluster firm_id)
```

This includes a dummy for each firm. You don't see the coefficients—they're just controlling for time-invariant firm differences.

### With Time Fixed Effects Too

Control for year-specific shocks that affect all units (recessions, policy changes, tech trends).

```stata
xtreg productivity wage training i.year, fe vce(cluster firm_id)
```

Now you're using only within-firm, within-year variation.

### High-Dimensional Fixed Effects

If you have tons of fixed effects (firm, year, industry, region), use `reghdfe` (much faster).

```stata
ssc install reghdfe
reghdfe productivity wage training, absorb(firm_id year) vce(cluster firm_id)
```

Can handle millions of observations and thousands of fixed effects.

---

## What You Can and Can't Estimate

### CAN estimate:
- Variables that change within units over time
  - Example: Wages, training, R&D spending

### CAN'T estimate:
- Variables that don't change
  - Example: Firm industry (if firms don't switch industries)
  - Example: Person gender (doesn't change in your data)

The fixed effect absorbs these. They're controlled for, but you can't get a coefficient.

### Tricky cases:
- Slowly changing variables (firm size, CEO tenure)
  - Technically you can estimate them, but there's little within-unit variation
  - Coefficients will be imprecise (huge standard errors)

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the within transformation</summary>
  <div class="math-block">
    Model with unit fixed effects:

    \[Y_{it} = \alpha_i + \beta X_{it} + u_{it}\]

    where \(\alpha_i\) is the unit-specific intercept.

    For each unit, calculate the time average:

    \[\bar{Y}_i = \alpha_i + \beta \bar{X}_i + \bar{u}_i\]

    Subtract the unit mean from each observation:

    \[Y_{it} - \bar{Y}_i = \beta(X_{it} - \bar{X}_i) + (u_{it} - \bar{u}_i)\]

    The \(\alpha_i\) term disappears. Now run OLS on the demeaned data. That's fixed effects.

    You're regressing deviations from the unit mean on deviations from the unit mean.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the dummy variable approach</summary>
  <div class="math-block">
    Fixed effects is equivalent to OLS with a dummy for each unit:

    \[Y_{it} = \beta X_{it} + \sum_{i=1}^N \alpha_i D_i + u_{it}\]

    where \(D_i = 1\) if observation is from unit i, 0 otherwise.

    In matrix form:

    \[y = X\beta + D\alpha + u\]

    Estimating this directly (Least Squares Dummy Variable) gives the same \(\hat{\beta}\) as the within transformation, but it's computationally expensive when N is large.

    That's why Stata uses the within transformation instead.
  </div>
</details>

---

## What People Get Wrong

**"Fixed effects controls for everything."** No. Only for time-invariant things. If your confounder changes over time, FE doesn't help.

**"I can't estimate the effect of gender/industry/country."** Correct! If it doesn't vary within units, FE absorbs it. You need between-unit variation, which means you can't use FE for that variable.

**"Fixed effects solves endogeneity."** Only if the endogeneity comes from time-invariant omitted variables. If you have reverse causality or time-varying confounders, you still have a problem.

**"I'll use random effects to get those time-invariant coefficients."** Only if the RE assumption holds (unit effects uncorrelated with X). Almost never true in practice. Hausman test usually rejects RE.

**"More fixed effects = better."** Not always. If you saturate the model (firm × year × industry × region FEs), you might be controlling away your treatment variation. Think carefully about what you're absorbing.

---

## Standard Errors with Fixed Effects

Always cluster your standard errors at the unit level (or higher).

```stata
xtreg y x1 x2, fe vce(cluster firm_id)
```

**Why?** Errors are likely correlated within units over time. Regular standard errors are too small (you'll find false significance).

**Two-way clustering** (firm and year):
```stata
reghdfe y x1 x2, absorb(firm_id year) vce(cluster firm_id year)
```

Use this when you're worried about correlation both within firms over time AND within years across firms.

---

## First-Differencing: The Close Cousin

Instead of comparing to the unit mean, compare each period to the previous period.

```stata
xtset firm_id year
reg D.(y x1 x2), vce(cluster firm_id)
```

`D.` creates first differences: \(Y_{it} - Y_{i,t-1}\).

**When to use first differences instead of FE:**
- You have only 2 time periods (FE and FD are identical)
- Errors are random walks (FD is more efficient)
- You care about short-run changes (FD emphasizes recent changes more)

**When FE is better:**
- You have many time periods
- Errors are serially uncorrelated
- You want to use all available variation

---

## Example: CEO Tenure and Firm Performance

**Question**: Does longer CEO tenure improve performance?

**Problem**: High-quality firms keep their CEOs longer. Naive OLS is biased.

**Solution**: Fixed effects

```stata
xtset firm_id year
xtreg roa ceo_tenure firm_size rd_intensity i.year, fe vce(cluster firm_id)
```

**Interpretation**: Within the same firm, does performance change as the CEO's tenure increases? Removes bias from time-invariant firm quality.

**What's controlled:**
- Industry (if firms don't change industries)
- Firm culture
- Geographic location
- Founding conditions
- Anything else that's stable over your sample period

**What's NOT controlled:**
- Time-varying shocks (controlled by including year FEs)
- Firm size changes (included as control)
- Reverse causality (would need IV for that)

---

## How to Write About It

Here's what a good methods section does:

> "We estimate firm fixed effects models to control for time-invariant heterogeneity across firms. This absorbs all stable differences in firm quality, culture, and capabilities that might be correlated with both CEO tenure and performance. We include year fixed effects to control for macroeconomic shocks and industry trends. Standard errors are clustered at the firm level to account for serial correlation. The Hausman test strongly rejects random effects (χ² = 45.3, p < 0.001), confirming that firm-specific effects are correlated with our predictors."

You need:
- Why you're using FE (what confounders you're worried about)
- What the fixed effects absorb
- Hausman test result (justifies FE over RE)
- Clustering strategy

---

## Related Concepts

- [Panel Data](./panel-data.html) - the type of data you need
- [Random Effects](./random-effects.html) - the alternative
- [Difference-in-Differences](./difference-in-differences.html) - related approach
- [Within-Between Models](./within-between.html) - hybrid approach
- [Hausman Test](./hausman-test.html) - how to choose

---

## Read More

**Start here:**
- Wooldridge, J. M. (2010). *Econometric Analysis of Cross Section and Panel Data*. Chapter 10.
- Certo, S. T., et al. (2017). "Sample selection bias and Heckman models in strategic management research." *Strategic Management Journal*, 38(13), 2639-2657.

**Then dive deeper:**
- Angrist, J. D., & Pischke, J. S. (2009). *Mostly Harmless Econometrics*. Chapter 5.
- Allison, P. D. (2009). *Fixed Effects Regression Models*. SAGE.

**Try it yourself:**
- [Panel Data Toolkit](../CodeLibrary/scripts/06_panel_data_toolkit.do) - full workflow
- [Method Decision Tree](../CodeLibrary/scripts/02_method_decision_tree_v2.do) - when to use FE

---

## Practice

[TRY]
- [ ] Load a panel dataset (same units, multiple time periods)
- [ ] Run OLS: `regress y x1 x2`
- [ ] Run FE: `xtreg y x1 x2, fe`
- [ ] Run Hausman test

[PREDICT]
- [ ] Before running: Which coefficients will change the most? Why?
- [ ] Will FE coefficients be bigger or smaller than OLS?

[CHECK]
- [ ] Compare OLS vs. FE estimates
- [ ] What does the Hausman test say?
- [ ] Do your main conclusions change?

[REFLECT]
Write a paragraph explaining what the differences between OLS and FE tell you about your data. What time-invariant confounders do you think FE is controlling for?
