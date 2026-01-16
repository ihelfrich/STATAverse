## What Does This Mean?

The change in your outcome when you increase X by one unit, holding everything else constant.

In linear regression, the marginal effect IS the coefficient. Easy.

In nonlinear models (logit, probit, interactions), the marginal effect is NOT the coefficient. The coefficient tells you about log-odds or latent variables. The marginal effect tells you about the actual outcome you care about.

**Why this matters:** If you interpret logit coefficients as marginal effects, you're wrong. If you interpret interaction coefficients directly, you're wrong. You have to calculate marginal effects explicitly.

---

## Linear vs. Nonlinear Models

### Linear Regression: Easy

```stata
regress wage education experience
```

Coefficient on education: 2.5
Marginal effect of education: 2.5

One more year of education → $2,500 higher wage. The coefficient IS the marginal effect.

### Logit/Probit: Not the Coefficient

```stata
logit hired education experience
```

Coefficient on education: 0.35
Marginal effect of education: ???

That 0.35 is the change in log-odds. What you want is: "One more year of education increases the probability of getting hired by X percentage points."

You have to calculate it:

```stata
margins, dydx(education)
```

This gives you the average marginal effect (AME). Maybe it's 0.08, meaning one more year of education raises hiring probability by 8 percentage points.

### Interactions: Also Not the Coefficient

```stata
regress performance training##female
```

The coefficient on `training#female` tells you how the slope of training differs for women vs. men. But it doesn't tell you the marginal effect of training for women. You have to calculate it:

```stata
margins, dydx(training) at(female=(0 1))
```

Now you get: "Training increases performance by 5 points for men and 9 points for women."

---

## Average Marginal Effects (AME) vs. Marginal Effects at the Mean (MEM)

Two ways to summarize marginal effects for nonlinear models:

### AME: Calculate for Each Person, Then Average

```stata
margins, dydx(education)
```

1. Calculate marginal effect for person 1 given their values of other variables
2. Calculate marginal effect for person 2 given their values
3. ...
4. Average across all people

**Interpretation**: "On average across the sample, one more year of education increases hiring probability by 8 percentage points."

### MEM: Calculate at the Sample Mean

```stata
margins, dydx(education) atmeans
```

Set all variables to their sample means, then calculate the marginal effect at that point.

**Interpretation**: "For someone with average characteristics, one more year of education increases hiring probability by 7 percentage points."

**Which to use?** AME is almost always better. It uses your actual data. MEM evaluates at a point that might not even exist in your sample (the "average person" might be a fiction).

---

## How to Calculate Marginal Effects

### After Logit or Probit

```stata
logit y x1 x2 x3
margins, dydx(*)
```

This gives you average marginal effects for all variables. Interpretation: percentage point change in probability.

### At Specific Values

```stata
margins, dydx(x1) at(x2=(1 2 3))
```

Marginal effect of x1 when x2 equals 1, 2, and 3.

### For Interactions

```stata
regress y c.x1##c.x2 controls
margins, dydx(x1) at(x2=(10 20 30))
marginsplot
```

Shows how the effect of x1 changes across values of x2. The graph makes it obvious.

### For Factor Variables

```stata
logit y i.education i.experience
margins education
```

Gives you predicted probabilities for each education level (not marginal effects). To get marginal effects:

```stata
margins, dydx(education)
```

Tells you how probability changes when education increases by one level.

---

## Visualizing Marginal Effects

Always plot them. Numbers are hard to interpret. Pictures are easy.

```stata
* After running a model with interactions
margins, dydx(x1) at(x2=(10(10)100))
marginsplot, yline(0)
```

This plots the marginal effect of x1 across the range of x2. If the confidence interval crosses zero, the effect becomes insignificant at those values.

**What to look for:**
- Is the effect always positive/negative, or does it change sign?
- Where is the effect strongest?
- Where does it become insignificant?

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the formula</summary>
  <div class="math-block">
    For a linear model:

    \[Y = \beta_0 + \beta_1 X_1 + \beta_2 X_2 + u\]

    Marginal effect of \(X_1\):

    \[\frac{\partial Y}{\partial X_1} = \beta_1\]

    Constant across all observations.

    For a nonlinear model (e.g., logit):

    \[P(Y=1) = \Lambda(\beta_0 + \beta_1 X_1 + \beta_2 X_2)\]

    where \(\Lambda(z) = \frac{e^z}{1 + e^z}\).

    Marginal effect of \(X_1\):

    \[\frac{\partial P}{\partial X_1} = \beta_1 \cdot \Lambda(z) \cdot (1 - \Lambda(z))\]

    This depends on the values of ALL the X variables (through \(z\)). It's different for each observation.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the interaction case</summary>
  <div class="math-block">
    Model with interaction:

    \[Y = \beta_0 + \beta_1 X_1 + \beta_2 X_2 + \beta_3 X_1 X_2 + u\]

    Marginal effect of \(X_1\):

    \[\frac{\partial Y}{\partial X_1} = \beta_1 + \beta_3 X_2\]

    The effect of \(X_1\) depends on the value of \(X_2\).

    At \(X_2 = 0\): Effect is \(\beta_1\)
    At \(X_2 = 10\): Effect is \(\beta_1 + 10\beta_3\)

    The coefficient \(\beta_3\) alone doesn't tell you the effect. You need to evaluate at specific values of \(X_2\).
  </div>
</details>

---

## Common Mistakes

**"My logit coefficient is 0.35, so one more unit of X increases the outcome by 0.35."** No. That's the log-odds change. Calculate the marginal effect.

**"The interaction term is positive and significant, so the effect is positive."** No. The interaction coefficient tells you about slope differences. You have to calculate marginal effects at different levels of the moderator.

**"I'll just exponentiate the logit coefficient to get the effect."** No. Exponentiating gives you odds ratios, not marginal effects. They're different quantities.

**"Marginal effects are only for logit/probit."** No. You need them for any nonlinear model or model with interactions. Even in linear models with interactions, you should report marginal effects at different moderator values.

**"I can interpret the interaction coefficient directly."** Almost never. Plot marginal effects instead.

---

## When You Must Use Marginal Effects

1. **Logit and probit models** - coefficients are in log-odds/latent space
2. **Models with interactions** - effect of X depends on Z
3. **Nonlinear transformations** - log(Y), Y², etc.
4. **Multinomial and ordered logit** - multiple outcome levels
5. **Count models** (Poisson, negative binomial) - coefficients are in log-count space

If you're reporting coefficients from these models without calculating marginal effects, you're doing it wrong.

---

## How to Report Marginal Effects

Here's what a good results section does:

> "We estimate a logit model predicting hiring decisions. Table 2 reports coefficients; we interpret average marginal effects for substantive significance. One additional year of education increases hiring probability by 7.2 percentage points (p < 0.01, 95% CI: [4.1, 10.3]). Prior experience has a marginal effect of 3.5 percentage points per year (p < 0.05). These effects are economically meaningful: moving from the 25th to 75th percentile of education increases hiring probability by 22 percentage points."

You need:
- Coefficients in a table (for the technical audience)
- Marginal effects in the text (for substantive interpretation)
- Percentage point changes (not odds ratios)
- Confidence intervals or standard errors
- Practical significance (what does this mean in the real world?)

---

## Interactions: Full Example

```stata
* Model: Does training affect performance differently for experienced vs. new employees?
regress performance c.training##c.experience age education

* Calculate marginal effect of training at different experience levels
margins, dydx(training) at(experience=(0 5 10 15 20))

* Visualize it
marginsplot, yline(0) ///
  title("Marginal Effect of Training by Experience Level") ///
  ytitle("Effect on Performance") ///
  xtitle("Years of Experience")
```

**Interpretation from the plot**:
- For new employees (0 years): Training increases performance by 12 points (highly significant)
- For mid-career (10 years): Training increases performance by 6 points (significant)
- For veterans (20 years): Training increases performance by 1 point (not significant)

The interaction coefficient alone doesn't tell you this. You need marginal effects.

---

## Related Concepts

- [Interaction Effects](./interaction-effects.html) - when marginal effects vary
- [Logit and Probit](./logit-probit.html) - nonlinear models requiring marginal effects
- [Coefficient](./coefficient.html) - what you estimate
- [Odds Ratios](./odds-ratios.html) - a different transformation (not marginal effects)
- [Average Treatment Effects](./average-treatment-effect.html) - related concept in causal inference

---

## Read More

**Start here:**
- Busenbark, J. R., et al. (2022). "Marginal effects and the misuse of regression coefficients in interaction models." *Organizational Research Methods*, 25(3), 484-515.
- Hoetker, G. (2007). "The use of logit and probit models in strategic management research." *Strategic Management Journal*, 28(4), 331-343.

**Then dive deeper:**
- Wooldridge, J. M. (2010). *Econometric Analysis of Cross Section and Panel Data*. Chapter 15.
- Long, J. S., & Freese, J. (2014). *Regression Models for Categorical Dependent Variables Using Stata* (3rd ed.).

**Try it yourself:**
- [Moderation Mastery](../CodeLibrary/scripts/05_moderation_mastery.do) - complete workflow
- [Limited Outcomes Module](../ZeroToHero/modules/03-limited-outcomes.html) - logit/probit guide

---

## Practice

[TRY]
- [ ] Run a logit model on your data
- [ ] Calculate marginal effects for all variables: `margins, dydx(*)`
- [ ] Compare the coefficients to the marginal effects

[PREDICT]
- [ ] Before calculating: Which variable will have the biggest marginal effect?
- [ ] How different will marginal effects be from coefficients?

[CHECK]
- [ ] Were you right about which variable matters most?
- [ ] Are any coefficients significant but marginal effects tiny?

[REFLECT]
Write a paragraph explaining one of your marginal effects in plain language. Imagine you're talking to someone who doesn't know statistics. What does this number actually mean for real decisions?
