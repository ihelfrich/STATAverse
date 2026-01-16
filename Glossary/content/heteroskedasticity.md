## What Does This Mean?

The spread of your errors changes across your data. Sometimes the errors are tiny. Sometimes they're huge. That pattern breaks one of OLS's key assumptions.

Here's a concrete example: You're studying how income affects spending. For people making $30k, their spending varies by maybe $2k-3k. For people making $300k, spending might vary by $50k. The variance keeps changing as income goes up.

**Why this wrecks your analysis:** Your standard errors are wrong. Your p-values are wrong. You might think a coefficient is significant when it's not, or vice versa. Every inference you make is unreliable.

---

## What It Looks Like

Plot your residuals against your fitted values. If you see a cone shape (errors spreading out) or a funnel (errors tightening up), you've got heteroskedasticity.

Perfect world: Random scatter. No pattern. Same vertical spread everywhere.

Real world with heteroskedasticity: Errors fan out like a megaphone. Or they squeeze together. Any systematic pattern in the spread is a problem.

---

## Why It Happens

### Bigger Units Have Bigger Variance

Large firms have more volatile profits than small firms. High earners have more volatile spending than low earners. The outcome variable's scale changes.

### You're Missing a Transformation

Maybe you should be using log(Y) instead of Y. The relationship might be multiplicative, not additive.

### Your Model Is Wrong

You left out important variables. You're using a linear model when the relationship is nonlinear. The heteroskedasticity is telling you something is off.

---

## How to Detect It

### Visual Check (Always Start Here)

```stata
regress spending income age education
predict resid, residuals
predict fitted, xb
scatter resid fitted
```

Look for patterns. Cone shapes. Funnels. Anything that's not random noise.

### Breusch-Pagan Test

```stata
regress spending income age education
estat hettest
```

Tests whether error variance depends on your X variables. If p < 0.05, you have heteroskedasticity.

### White Test

```stata
estat imtest, white
```

More general. Tests for heteroskedasticity of any form. If p < 0.05, there's a problem.

---

## How to Fix It

### Option 1: Use Robust Standard Errors (Easiest)

Don't fix the heteroskedasticity. Just fix your standard errors so they're correct despite it.

```stata
regress spending income age education, robust
```

The coefficients stay the same. The standard errors get adjusted. Now your p-values are trustworthy.

**This works for any sample size.** Use it by default.

### Option 2: Use a Better Model

Transform your variables. Add interactions. Include squared terms. Maybe you need a different functional form.

```stata
* Try logging the outcome
gen log_spending = log(spending)
regress log_spending income age education

* Or add nonlinear terms
gen income_sq = income^2
regress spending income income_sq age education
```

If you fix the model specification, heteroskedasticity often disappears.

### Option 3: Weighted Least Squares (Advanced)

If you know the form of the heteroskedasticity, you can weight observations inversely to their variance.

```stata
* If variance proportional to income
regress spending income age education [aweight=1/income]
```

**Only do this if you're confident about the variance structure.** Getting it wrong makes things worse.

---

## What Happens If You Ignore It

Your **coefficients are still unbiased**. OLS gives you the right answer on average.

But:
- Standard errors are wrong (usually too small)
- t-statistics are wrong
- p-values are wrong
- Confidence intervals are wrong
- You'll find "significance" that isn't really there

You can't trust any hypothesis test. That's a disaster for research.

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the algebra</summary>
  <div class="math-block">
    OLS assumes homoskedasticity:

    \[Var(u_i | X) = \sigma^2 \text{ for all } i\]

    Heteroskedasticity means this variance changes:

    \[Var(u_i | X) = \sigma_i^2\]

    The OLS coefficient estimator is still unbiased:

    \[E[\hat{\beta}] = \beta\]

    But the standard formula for variance is wrong:

    \[\text{Incorrect: } Var(\hat{\beta}) = \sigma^2(X'X)^{-1}\]

    The correct formula (White's heteroskedasticity-robust) is:

    \[Var(\hat{\beta}) = (X'X)^{-1} X' \Omega X (X'X)^{-1}\]

    where \(\Omega\) is a diagonal matrix of \(\sigma_i^2\).
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the matrix form</summary>
  <div class="math-block">
    With homoskedasticity:

    \[Var(u) = \sigma^2 I\]

    With heteroskedasticity:

    \[Var(u) = \Omega = \begin{pmatrix} \sigma_1^2 & 0 & \cdots & 0 \\ 0 & \sigma_2^2 & \cdots & 0 \\ \vdots & \vdots & \ddots & \vdots \\ 0 & 0 & \cdots & \sigma_n^2 \end{pmatrix}\]

    The robust variance estimator:

    \[\widehat{Var}(\hat{\beta}) = (X'X)^{-1} \left(\sum_{i=1}^n \hat{u}_i^2 x_i x_i' \right) (X'X)^{-1}\]

    This is the sandwich estimator. It's consistent even when \(\Omega\) is unknown.
  </div>
</details>

---

## How to Write About It

Here's what a good methods section does:

> "Visual inspection of residuals suggested heteroskedasticity, with variance increasing in firm size. The Breusch-Pagan test confirmed this pattern (χ² = 18.3, p < 0.001). We report heteroskedasticity-robust standard errors throughout (White 1980). Results are substantively identical using weighted least squares with inverse-size weights."

You need:
- Evidence that you checked for it
- The diagnostic test result
- What you did to fix it
- Confirmation that results are robust

**Don't say:** "We used robust standard errors."
**Do say:** "We detected heteroskedasticity and adjusted standard errors accordingly."

---

## What People Get Wrong

**"Heteroskedasticity biases my coefficients."** No. Your coefficients are fine. It's the standard errors that are wrong.

**"I'll just use robust standard errors for everything."** Yes! Do this! There's almost no cost and huge benefits. Make it your default.

**"I need to fix the heteroskedasticity before I can proceed."** Not necessarily. Robust standard errors solve the inference problem. Only fix the underlying issue if you think it reveals model misspecification.

**"My residual plot looks messy."** Messy is fine. Random is fine. You're looking for **patterns**. Cones, funnels, curves. If it's just noise, you're good.

---

## Related Concepts

- [Homoskedasticity](./homoskedasticity.html) - the assumption this violates
- [Robust Standard Errors](./robust-standard-errors.html) - the fix you'll use most
- [OLS Assumptions](./ols-assumptions.html) - where this fits in the big picture
- [Residual Diagnostics](./residual-diagnostics.html) - how to check for problems
- [Weighted Least Squares](./weighted-least-squares.html) - alternative solution

---

## Read More

**Start here:**
- White, H. (1980). "A heteroskedasticity-consistent covariance matrix estimator." *Econometrica*, 48(4), 817-838.

**Then dive deeper:**
- Wooldridge, J. M. (2020). *Introductory Econometrics: A Modern Approach*. Chapter 8.
- Long, J. S., & Ervin, L. H. (2000). "Using heteroscedasticity consistent standard errors in the linear regression model." *The American Statistician*, 54(3), 217-224.

**Try it yourself:**
- [Assumption Checker](../CodeLibrary/scripts/04_assumption_checker.do) - automated diagnostic suite
- [Heteroskedasticity Simulator](../CodeLibrary/scripts/heteroskedasticity_demo.do) - see how it affects inference

---

## Practice

[TRY]
- [ ] Download the assumption checker
- [ ] Run a basic OLS regression on your data
- [ ] Create a residual vs. fitted plot
- [ ] Run the Breusch-Pagan test

[PREDICT]
- [ ] Before looking at results: Do you expect heteroskedasticity? Why or why not?
- [ ] If present, which variables do you think are driving it?

[CHECK]
- [ ] Compare standard OLS standard errors to robust standard errors
- [ ] How much do they differ?

[REFLECT]
Write a paragraph explaining what heteroskedasticity means for your specific research question. If you found it, would it change your substantive conclusions or just your inference?
