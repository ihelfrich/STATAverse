## What Does This Mean?

Your estimator gives you the wrong answer on average. Even if you had infinite data and repeated your study a million times, the average estimate would not equal the true value.

Think of it like a miscalibrated scale. It doesn't matter how many times you weigh yourself—if the scale always adds 5 pounds, the average of all those measurements will still be 5 pounds too high.

**Why this matters:** Biased estimates lead to wrong conclusions. You might think tutoring improves test scores by 15 points when it really only helps by 3. Or you might think a drug works when it doesn't. Everything downstream from that estimate is wrong.

---

## The Difference Between Bias and Noise

**Bias**: Systematic error. Always pulls your estimate in the same direction. More data doesn't fix it.

**Variance** (noise): Random error. Bounces around. More data makes it smaller.

Imagine shooting arrows at a target:
- **Unbiased, low variance**: Arrows cluster tightly around the bullseye
- **Unbiased, high variance**: Arrows scattered everywhere, but centered on bullseye
- **Biased, low variance**: Arrows tightly clustered, but all hitting the same wrong spot
- **Biased, high variance**: Arrows scattered AND off-target

You want low bias first. Then worry about variance.

---

## How Bias Happens

### You Left Something Out (Omitted Variable Bias)

The most common source. You forgot to include a variable that affects both X and Y.

**Example**: Studying whether exercise (X) improves health (Y). But people who exercise also tend to have better diets. If you don't control for diet, your exercise coefficient picks up some of the diet effect too. Biased upward.

### The Relationship Goes Both Ways (Reverse Causality)

Y causes X, but you're treating X as the cause.

**Example**: Do police reduce crime, or does crime increase police? If high-crime cities hire more police, a naive regression gives you a positive coefficient (more police = more crime). That's backward and biased.

### You're Using Bad Data (Measurement Error)

If X is measured with noise, your coefficient gets pulled toward zero (attenuation bias).

**Example**: Self-reported income is wrong for most people. When you regress spending on self-reported income, the coefficient is smaller than the true effect because the measurement error weakens the relationship.

### Your Sample Is Wrong (Selection Bias)

You only observe certain types of observations, and that creates bias.

**Example**: Studying salary returns to MBA programs by surveying MBA grads. But you don't see the people who didn't get jobs. Your estimate is biased upward because you're missing all the failures.

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the definition</summary>
  <div class="math-block">
    An estimator \(\hat{\beta}\) is **unbiased** if:

    \[E[\hat{\beta}] = \beta\]

    where \(\beta\) is the true parameter value.

    The **bias** is:

    \[Bias(\hat{\beta}) = E[\hat{\beta}] - \beta\]

    If this equals zero, the estimator is unbiased.

    **Important**: Unbiasedness is about the expected value over repeated samples, not about any single estimate.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the OLS case</summary>
  <div class="math-block">
    OLS estimator:

    \[\hat{\beta} = (X'X)^{-1}X'y\]

    Substituting the true model \(y = X\beta + u\):

    \[\hat{\beta} = (X'X)^{-1}X'(X\beta + u) = \beta + (X'X)^{-1}X'u\]

    Taking expectations:

    \[E[\hat{\beta}] = \beta + E[(X'X)^{-1}X'u]\]

    OLS is unbiased **if and only if** \(E[X'u] = 0\).

    When X and u are correlated (endogeneity), that expectation is not zero, and you get bias:

    \[E[\hat{\beta}] = \beta + (X'X)^{-1}E[X'u] \neq \beta\]
  </div>
</details>

---

## How to Detect It

Here's the problem: **You usually can't directly test for bias** because you don't know the true value. If you knew the truth, you wouldn't need to estimate it.

But you can look for red flags:

### Check for Endogeneity

```stata
* Hausman test (panel data)
xtreg y x1 x2, fe
estimates store fixed
xtreg y x1 x2, re
estimates store random
hausman fixed random
```

If p < 0.05, you have endogeneity, which means bias.

### Test Your Instrument

```stata
ivregress 2sls y x1 x2 (endogenous_x = instrument)
estat endogenous
```

If your X is endogenous, OLS is biased.

### Compare Methods

Run OLS, then run fixed effects or IV. If the coefficients are wildly different, OLS is probably biased.

```stata
regress y x1 x2
estimates store ols

xtreg y x1 x2, fe
estimates store fe

estimates table ols fe, star stats(N r2)
```

Big differences suggest bias in the simpler model.

### Use Theory

Think carefully. Is there an omitted variable? Could Y cause X instead of X causing Y? Is there selection? Theory often tells you where bias is likely to hide.

---

## How to Fix It

### Find the Missing Variable

If you can measure the omitted variable, include it.

```stata
* Before: Biased
regress health exercise

* After: Less biased
regress health exercise diet sleep stress
```

But you can't include everything. Some variables are unobservable.

### Use Instrumental Variables

Find a variable Z that affects X but doesn't directly affect Y. Use it to isolate the exogenous part of X.

```stata
ivregress 2sls y controls (endogenous_x = instrument), robust
```

Only works if you have a valid instrument (hard to find).

### Use Fixed Effects

Control for all time-invariant unobservables by focusing on within-unit changes.

```stata
xtset firm_id year
xtreg y x1 x2, fe vce(cluster firm_id)
```

Removes bias from anything that doesn't change over time.

### Use a Natural Experiment

Find a setting where X changes for reasons unrelated to Y. Difference-in-differences, regression discontinuity, etc.

```stata
regress y treat##post controls, robust
```

The treatment/control comparison removes selection bias.

---

## What People Get Wrong

**"My R² is high, so there's no bias."** R² tells you nothing about bias. You can have perfect fit and massive bias.

**"I'll add more controls to fix it."** Only helps if you're adding the RIGHT controls. Adding irrelevant variables does nothing. Adding mediators makes it worse.

**"Bias goes away with a bigger sample."** No. Bias is about the expected value, not the variance. More data makes you more precisely wrong.

**"My estimate is significant, so it must be right."** Significance just means the estimate is different from zero. It says nothing about bias. You can have a highly significant, completely biased estimate.

---

## Bias vs. Consistency

**Bias** is about finite samples. Does your estimator give the right answer on average?

**Consistency** is about asymptotics. Does your estimator converge to the truth as n → ∞?

Some estimators are biased in small samples but consistent (they fix themselves with more data). That's often acceptable.

Some estimators are biased AND inconsistent. Those are disasters.

OLS with endogeneity: Biased AND inconsistent. More data doesn't help.

Maximum likelihood estimates: Sometimes biased in small samples, but consistent. They improve with more data.

---

## How to Write About It

Here's what a good paper does:

> "CEO tenure may be endogenous because high-performing firms retain CEOs longer, creating bias in OLS estimates. We address this using an instrumental variables approach (distance to CEO's hometown) and fixed effects specifications. The OLS estimate (β = 0.42, p < 0.01) is substantially larger than the IV estimate (β = 0.18, p = 0.03), suggesting upward bias in the naive specification. We interpret the IV estimate as the causal effect."

You need:
- Acknowledgment of potential bias
- The source of bias (omitted variables, selection, etc.)
- Your solution
- Comparison showing the bias was real

---

## Related Concepts

- [Endogeneity](./endogeneity.html) - the main cause of bias in regression
- [Omitted Variable Bias](./omitted-variable-bias.html) - the most common type
- [Consistency](./consistency.html) - the asymptotic version
- [Selection Bias](./selection-bias.html) - bias from non-random samples
- [Instrumental Variables](./instrumental-variable.html) - one solution

---

## Read More

**Start here:**
- Kennedy, P. (2008). *A Guide to Econometrics* (6th ed.). Chapter 2.
- Wooldridge, J. M. (2010). *Econometric Analysis of Cross Section and Panel Data*. Chapter 4.

**Then dive deeper:**
- Angrist, J. D., & Pischke, J. S. (2009). *Mostly Harmless Econometrics*. Chapters 3-4.
- Imbens, G. W., & Rubin, D. B. (2015). *Causal Inference*. Chapter 6.

**Try it yourself:**
- [Endogeneity Simulator](../CodeLibrary/scripts/01_endogeneity_simulator.do) - see bias in action
- [Anti-Patterns Guide](../CodeLibrary/scripts/03_anti_patterns.do) - common mistakes that cause bias

---

## Practice

[TRY]
- [ ] Download the endogeneity simulator
- [ ] Generate data where the true effect is 0.5
- [ ] Create moderate omitted variable bias (correlation = 0.4)
- [ ] Run OLS and IV on the same data

[PREDICT]
- [ ] Before running: Will OLS be biased upward or downward?
- [ ] How big do you expect the bias to be?

[CHECK]
- [ ] What's the OLS estimate? What's the IV estimate?
- [ ] Calculate: Bias = OLS estimate - True value (0.5)

[REFLECT]
Write a paragraph explaining why bias matters more than variance for causal inference. When would you accept a biased estimator? When is bias unacceptable?
