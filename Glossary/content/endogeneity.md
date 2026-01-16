## What Does This Mean?

Your X variable is mixed up with things you haven't measured. That means your regression coefficient is giving you the wrong answer.

Think of it like this: You're trying to figure out if tutoring helps students pass exams. But the students who get tutoring are also the ones whose parents check homework every night. Your regression can't tell those two things apart. The coefficient you get includes both the tutoring effect AND the parental involvement effect. That's endogeneity.

**Why this wrecks your research:** You might think tutoring doubles pass rates, when really it only helps by 20%. Everything you conclude will be wrong.

---

## Three Ways This Happens

### You Left Something Out (Omitted Variable Bias)

There's a variable Z that affects both X and Y, but you didn't include it in your model.

**Example you'll recognize:** Studying whether CEO pay (X) drives firm performance (Y). Bigger companies pay CEOs more AND perform better. If you forget to control for size, you'll think CEO pay matters way more than it actually does.

The missing variable sneaks into your error term, and your coefficient picks up its effect too.

### The Arrow Points Backward (Reverse Causality)

Y is causing X, not the other way around.

**Example:** Stock prices (Y) and analyst ratings (X). You think ratings drive prices. But analysts give good ratings BECAUSE prices are already rising. You've got the causation backward.

OLS can't tell which direction the arrow goes. It just sees correlation.

### They Cause Each Other (Simultaneity)

X and Y determine each other at the same time, creating a feedback loop.

**Classic case:** Supply and demand. Higher demand raises prices. Higher prices lower demand. They're tangled together. A regression will give you some blend of both effects, which isn't what you want.

---

## See the Bias for Yourself

Imagine we know the true effect is 0.5. Here's what OLS gives you as endogeneity gets worse:

- No endogeneity: OLS = 0.51 (basically right)
- Moderate endogeneity: OLS = 0.87 (way too high)
- Severe endogeneity: OLS = 1.43 (almost triple!)

Even a small amount of endogeneity can double your estimate. That's terrifying if you're making decisions based on these numbers.

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the algebra</summary>
  <div class="math-block">
    OLS works when the error term is independent of X:

    \[E[u|X] = 0\]

    Endogeneity breaks this. When \(Cov(X, u) \neq 0\), you get:

    \[\hat{\beta}_{OLS} = \beta_{true} + \frac{Cov(X, u)}{Var(X)}\]

    That second part is the bias. It won't average out, even with infinite data.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the matrix form</summary>
  <div class="math-block">
    In matrices:

    \[\hat{\beta} = (X'X)^{-1}X'y\]

    Substitute \(y = X\beta + u\):

    \[\hat{\beta} = \beta + (X'X)^{-1}X'u\]

    Taking expectations:

    \[E[\hat{\beta}] = \beta + (X'X)^{-1}E[X'u]\]

    If X and u are correlated, that last term isn't zero. Your estimate is biased.
  </div>
</details>

---

## How to Spot It

### Run a Hausman Test (panel data)

```stata
xtreg y x1 x2, fe
estimates store fixed

xtreg y x1 x2, re
estimates store random

hausman fixed random
```

If p < 0.05, you've got endogeneity. Use fixed effects, not random effects.

### Test Your Instrument (IV models)

```stata
ivregress 2sls y x1 x2 (endogenous_x = instrument)
estat endogenous
```

If p < 0.05, X is endogenous. You need instrumental variables, not OLS.

### Look at Your Residuals

```stata
regress y x1 x2
predict resid, residuals
scatter resid x1
```

Patterns mean trouble. Residuals should look like random noise.

---

## How to Fix It

### Option 1: Find an Instrument

You need a variable Z that:
- Strongly predicts X (check this with an F-test)
- Only affects Y through X (you have to argue this theoretically)
- Isn't correlated with your errors

```stata
ivregress 2sls y controls (endogenous_x = instrument), first robust

* Check if your instrument is strong
estat firststage
* F-stat should be over 10, ideally over 20
```

**Real example:** Studying education's effect on wages? Use distance to nearest college as an instrument. It affects whether people get educated, but doesn't directly change their wages.

### Option 2: Use Fixed Effects

This works when your endogeneity comes from time-invariant characteristics (firm culture, individual ability, etc.).

```stata
xtset firm_id year
xtreg y x1 x2, fe vce(cluster firm_id)
```

Fixed effects sweep out anything that doesn't change over time.

### Option 3: Difference-in-Differences

If you have a policy change or natural experiment, you can compare changes across groups.

```stata
regress y treat##post controls, robust
```

The interaction coefficient gives you the causal effect.

### Option 4: Control Function

Model the endogeneity explicitly and include the residuals as a control.

```stata
* Step 1: Predict the endogenous part
regress endogenous_x instrument controls
predict resid_x, residuals

* Step 2: Include those residuals
regress y endogenous_x resid_x controls, robust
```

---

## What People Get Wrong

**"I'll just add more controls."** Doesn't work. If the confounding variable is unobserved, adding other stuff won't help. You need a different strategy.

**"My instrument has an F-stat of 3."** That's a weak instrument. It will give you WORSE estimates than OLS. Don't use it.

**"I'll ignore this and hope reviewers don't notice."** They will notice. Every serious journal expects you to address endogeneity. Have a plan.

---

## How to Write About It

Here's what a good paper does:

> "CEO tenure is potentially endogenous because longer-tenured CEOs may have survived precisely because their firms performed well. We address this using an instrumental variables approach. Our instrument—the unexpected death of a board member who recruited the CEO—strongly predicts CEO tenure (F = 23.4, p < 0.001) but does not directly affect firm performance. The Durbin-Wu-Hausman test confirms endogeneity (χ² = 8.7, p < 0.01). Using 2SLS, we find tenure increases performance by β = 0.18 (SE = 0.07, p = 0.01), compared to the naive OLS estimate of β = 0.34."

You need:
- Clear statement of why X might be endogenous
- Your solution (IV, FE, DiD, etc.)
- Diagnostics showing it works
- Comparison to naive OLS

---

## Related Concepts

- [Omitted Variable Bias](./omitted-variable-bias.html) - the most common type
- [Instrumental Variables](./instrumental-variable.html) - the main solution
- [Confounding](./confounding.html) - another way to think about it
- [Bias](./bias.html) - what endogeneity creates
- [Selection Bias](./selection-bias.html) - endogeneity from non-random samples

---

## Read More

**Start here:**
- Hill et al. (2021). "Endogeneity: A review and agenda." *Journal of Management*, 47(1), 105-143.

**Then dive deeper:**
- Semadeni et al. (2014). "The perils of endogeneity and instrumental variables." *SMJ*, 35(7), 1070-1079.
- Hamilton & Nickerson (2003). "Correcting for endogeneity in strategic management research." *Strategic Organization*, 1(1), 51-78.

**Textbooks:**
- Wooldridge (2010). *Econometric Analysis of Cross Section and Panel Data*. Chapters 5-6.
- Angrist & Pischke (2009). *Mostly Harmless Econometrics*. Chapter 4.

**Try it yourself:**
- [Endogeneity Simulator](../CodeLibrary/scripts/01_endogeneity_simulator.do) - generate data with known bias, see how OLS fails
- [Method Decision Tree](../CodeLibrary/scripts/02_method_decision_tree_v2.do) - figure out which fix to use

---

## Practice

[TRY]
- [ ] Download the endogeneity simulator
- [ ] Generate data where the true effect is 0.5
- [ ] Add moderate endogeneity (correlation = 0.4)
- [ ] Compare OLS vs. IV estimates

[PREDICT]
- [ ] Before running it: Will OLS be too high or too low?
- [ ] How far off will it be?

[CHECK]
- [ ] Run the code. Were you right?

[REFLECT]
Write a paragraph explaining why even correlation = 0.3 between X and the error term causes serious problems. What does this mean for your own research?
