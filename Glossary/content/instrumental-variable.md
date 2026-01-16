## What Does This Mean?

A variable that affects your outcome ONLY through its effect on the problematic explanatory variable. It's a tool to fix endogeneity and get a causal estimate when OLS is biased.

Think of an instrument as a nudge that changes X but doesn't directly touch Y. By looking at how Y responds to that nudge, you can isolate the causal effect of X on Y.

**Why this matters:** When you have endogeneity (omitted variables, reverse causality, simultaneity), OLS gives you the wrong answer. A good instrument lets you recover the true causal effect. It's one of the most powerful tools in econometrics.

---

## The Classic Example: Education and Wages

**Question**: Does education increase wages, or do high-earners just happen to get more education?

**Problem**: Smart, motivated people get more education AND earn more. OLS picks up both education's effect and ability's effect. Biased.

**Instrument**: Distance to nearest college

**Why it works**:
1. Distance affects education (people closer to college are more likely to attend)
2. Distance only affects wages through education (living 10 miles from a college doesn't directly change your wages)
3. Distance isn't correlated with ability (colleges aren't located based on where smart people live)

**The IV logic**: Compare people who live near colleges (high education) to people who live far away (low education). The wage difference between these groups comes from education, not ability, because distance is unrelated to ability.

---

## The Three Requirements for a Valid Instrument

Your instrument Z must satisfy THREE conditions:

### 1. Relevance: Z strongly predicts X

The instrument must actually move your endogenous variable.

**Test**: Run the first stage regression:
```stata
regress endogenous_x instrument controls
```

Check the F-statistic on the instrument. Should be > 10, ideally > 20.

```stata
ivregress 2sls y controls (endogenous_x = instrument), first
estat firststage
```

If F < 10: **Weak instrument**. Don't use it. Weak instruments give worse estimates than OLS.

### 2. Exclusion: Z affects Y ONLY through X

The instrument cannot have a direct effect on Y. It only affects Y indirectly by changing X.

**This is untestable** if you have one instrument. You have to argue it theoretically.

**Example**: Distance to college affects wages ONLY through education, not through other channels like:
- Urban vs. rural differences
- Labor market characteristics
- Cultural differences

If any of these matter, the exclusion restriction is violated.

### 3. Independence: Z is uncorrelated with the error term

The instrument must be "as good as random" with respect to all omitted factors.

**Also untestable** with a single instrument.

**Example**: Distance to college is unrelated to ability, motivation, family background (after controlling for observables).

If colleges are located in richer areas, distance might be correlated with family wealth → violates independence.

---

## How Instrumental Variables Work (2SLS)

### Two-Stage Least Squares (2SLS)

**Stage 1**: Predict the endogenous variable using the instrument.

\[ \hat{X} = \gamma_0 + \gamma_1 Z + \gamma_2 \text{Controls} \]

This gives you the "clean" part of X—the variation driven by the instrument.

**Stage 2**: Regress Y on the predicted values.

\[ Y = \beta_0 + \beta_1 \hat{X} + \beta_2 \text{Controls} + u \]

The coefficient \(\beta_1\) is the IV estimate. It uses only the variation in X that comes from Z.

### In Stata

```stata
ivregress 2sls wage controls (education = distance_college), robust first
```

Breakdown:
- `wage` = outcome
- `education` = endogenous variable (in parentheses)
- `distance_college` = instrument
- `controls` = exogenous variables
- `first` = show first-stage results
- `robust` = heteroskedasticity-robust standard errors

---

## Diagnostics: Is Your Instrument Valid?

### Test 1: First-Stage F-Statistic (Relevance)

```stata
estat firststage
```

Check the F-statistic.
- **F > 20**: Strong instrument, safe to use
- **10 < F < 20**: Moderate strength, be cautious
- **F < 10**: Weak instrument, DO NOT USE

**Why it matters**: Weak instruments create bias toward OLS and inflate standard errors. Your estimates will be garbage.

### Test 2: Endogeneity Test (Do You Even Need IV?)

```stata
estat endogenous
```

Null hypothesis: X is exogenous (you don't need IV).
- **p < 0.05**: X is endogenous, use IV
- **p > 0.05**: X is not endogenous, just use OLS

This is the Durbin-Wu-Hausman test. It compares OLS and IV estimates. If they're similar, OLS is fine (and more efficient).

### Test 3: Overidentification Test (Multiple Instruments)

If you have MORE instruments than endogenous variables:

```stata
ivregress 2sls y controls (x = z1 z2 z3), robust
estat overid
```

Null hypothesis: All instruments are valid (exclusion restriction holds).
- **p > 0.05**: Can't reject validity (good)
- **p < 0.05**: At least one instrument is invalid (problem)

**Important**: This only tests whether instruments are consistent with each other. It doesn't test if ALL of them are invalid.

---

## What Makes a Good Instrument?

### Strong First Stage

The instrument must actually predict the endogenous variable. Check:
- F-statistic > 20
- Large, significant coefficient on instrument in first stage
- High R² in first stage

### Credible Exclusion

You need a convincing story for why the instrument affects Y ONLY through X.

**Good arguments**:
- Policy changes that affect some people but not others (natural experiments)
- Geographic variation unrelated to outcomes (distance, borders, weather)
- Timing variation (when you were born, when a policy started)

**Weak arguments**:
- "I think it's exogenous"
- "I can't think of how else it would matter"
- "It passes the overid test" (not enough)

### Monotonicity (If Using LATE)

The instrument should move X in the same direction for everyone. No one should do the opposite.

**Example**: Distance to college → less education. Shouldn't make anyone MORE likely to attend just because they're far away.

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the 2SLS formula</summary>
  <div class="math-block">
    True model:

    \[Y = \beta_0 + \beta_1 X + u\]

    Problem: \(Cov(X, u) \neq 0\) (endogeneity).

    Instrument Z satisfies:
    1. \(Cov(Z, X) \neq 0\) (relevance)
    2. \(Cov(Z, u) = 0\) (exogeneity)

    **First stage**:

    \[X = \gamma_0 + \gamma_1 Z + v\]

    Predict: \(\hat{X} = \hat{\gamma}_0 + \hat{\gamma}_1 Z\)

    **Second stage**:

    \[Y = \beta_0 + \beta_1 \hat{X} + error\]

    The 2SLS estimator:

    \[\hat{\beta}_{IV} = \frac{Cov(Z, Y)}{Cov(Z, X)}\]

    This is the "reduced form" (effect of Z on Y) divided by the first stage (effect of Z on X).
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the matrix version</summary>
  <div class="math-block">
    Model:

    \[y = X\beta + u\]

    where X is endogenous.

    Instruments: Z

    **First stage**:

    \[\hat{X} = Z(Z'Z)^{-1}Z'X = P_Z X\]

    where \(P_Z\) is the projection matrix onto the space of Z.

    **Second stage**:

    \[\hat{\beta}_{IV} = (\hat{X}'\hat{X})^{-1}\hat{X}'y\]

    Substituting \(\hat{X} = P_Z X\):

    \[\hat{\beta}_{IV} = (X'P_Z X)^{-1} X'P_Z y\]

    Equivalently:

    \[\hat{\beta}_{IV} = (Z'X)^{-1}Z'y\]

    This uses only the variation in X that's explained by Z.
  </div>
</details>

---

## Common Instruments and Their Problems

### Distance to College (Card 1995)

**Endogenous variable**: Education
**Instrument**: Distance to nearest college
**Exclusion violation**: Distance might correlate with urban/rural, labor markets, culture

### Draft Lottery (Angrist 1990)

**Endogenous variable**: Military service
**Instrument**: Randomly assigned draft number
**Why it works**: True randomization → perfect independence
**Limitation**: Only applies to men eligible for the draft (external validity)

### Judge Assignment (Kling 2006)

**Endogenous variable**: Incarceration
**Instrument**: Which judge you get (some are harsher)
**Exclusion assumption**: Judges only affect outcomes through sentencing, not through other channels
**Problem**: Maybe harsh judges also lecture defendants, affecting behavior directly

### Rainfall (Duflo & Pande 2007)

**Endogenous variable**: Dam construction
**Instrument**: Rainfall shocks
**Why it works**: Weather is random, affects dam building decisions
**Problem**: Rainfall might affect outcomes directly (agriculture, employment)

---

## IV vs. OLS: What's the Difference?

**OLS**: Uses all variation in X (between-unit and within-unit, good and bad)

**IV**: Uses only the variation in X driven by Z (hopefully the "good" variation)

**Example**: Education and wages

OLS uses variation from:
- People who chose to go to college (confounded by ability)
- People who couldn't afford college (confounded by wealth)
- People who got scholarships (confounded by merit)

IV (using distance) uses only variation from:
- People who went to college BECAUSE they lived nearby
- People who didn't go BECAUSE they lived far away

This variation is "as good as random" (if the exclusion restriction holds).

---

## When IV Estimates Differ from OLS

**IV larger than OLS**: Usually means negative omitted variable bias in OLS.

**Example**: Returns to education. OLS = 0.08, IV = 0.12.
**Interpretation**: OLS is biased down because people with low ability get more education (to compensate). IV removes that bias.

**IV smaller than OLS**: Usually means positive omitted variable bias in OLS.

**Example**: Police and crime. OLS = +0.3 (more police → more crime?!), IV = -0.2.
**Interpretation**: OLS is biased upward because high-crime areas hire more police. IV removes that bias and reveals the true negative effect.

---

## Local Average Treatment Effect (LATE)

IV doesn't estimate the average treatment effect for everyone. It estimates the effect for **compliers**—people whose X changes because of the instrument.

**Compliers**: Would attend college if close, wouldn't attend if far.
**Always-takers**: Attend college no matter what (distance doesn't matter).
**Never-takers**: Never attend college no matter what.

IV estimates the effect for compliers only.

**Why it matters**: The effect for people induced by the instrument might differ from the effect for the full population.

**Example**: Effect of education for people who go BECAUSE of distance might be different from the effect for people who go regardless. Maybe marginal students benefit more (or less).

---

## Common Mistakes

**"My instrument is correlated with X, so it's valid."** That's only the first requirement (relevance). You also need exclusion and independence.

**"The overid test passed, so my instruments are valid."** The overid test can only reject. Passing doesn't prove validity.

**"My F-stat is 8, that's almost 10."** No. Weak instruments create serious problems. F > 10 is a minimum, not a target.

**"IV and OLS are similar, so I'll report IV because it's more credible."** If they're similar AND X is exogenous (endogeneity test says so), use OLS. It's more efficient (smaller standard errors).

**"I'll use lagged X as an instrument for current X."** Only works if the lag is uncorrelated with current errors. Usually it's not. This is often invalid.

---

## How to Write About IV

Here's what a good paper does:

> "We instrument CEO tenure using an indicator for unexpected deaths of board members who recruited the CEO. This instrument strongly predicts tenure (F = 23.4, first-stage coefficient = 4.3 years, p < 0.001) but plausibly satisfies the exclusion restriction: board member deaths affect firm performance only through their impact on CEO retention, not through other channels such as board quality or strategic direction (we control for board size and independence). The Durbin-Wu-Hausman test confirms endogeneity of tenure (χ² = 8.7, p = 0.003). The IV estimate (β = 0.18, SE = 0.07, p = 0.01) is smaller than the naive OLS estimate (β = 0.34), suggesting that unobserved firm quality positively biases OLS."

You need:
- Clear statement of the instrument
- First-stage strength (F-stat, coefficient, significance)
- Defense of exclusion restriction (theoretical argument)
- Controls that strengthen exclusion
- Endogeneity test result
- Comparison of IV to OLS
- Interpretation of the difference

---

## Related Concepts

- [Endogeneity](./endogeneity.html) - the problem IV solves
- [Two-Stage Least Squares](./two-stage-least-squares.html) - the method
- [Weak Instruments](./weak-instruments.html) - what to avoid
- [LATE](./local-average-treatment-effect.html) - what IV estimates
- [Reduced Form](./reduced-form.html) - effect of instrument on outcome

---

## Read More

**Start here:**
- Angrist, J. D., & Pischke, J. S. (2009). *Mostly Harmless Econometrics*. Chapter 4.
- Semadeni, M., et al. (2014). "The perils of endogeneity and instrumental variables in strategy research." *Strategic Management Journal*, 35(7), 1070-1079.

**Then dive deeper:**
- Angrist, J. D., & Krueger, A. B. (2001). "Instrumental variables and the search for identification." *Journal of Economic Perspectives*, 15(4), 69-85.
- Stock, J. H., & Yogo, M. (2005). "Testing for weak instruments in linear IV regression." In *Identification and Inference for Econometric Models* (pp. 80-108).

**Classic applications**:
- Card, D. (1995). "Using geographic variation in college proximity to estimate the return to schooling." *NBER Working Paper 4483*.
- Angrist, J. D. (1990). "Lifetime earnings and the Vietnam era draft lottery." *American Economic Review*, 80(3), 313-336.

**Try it yourself:**
- [Endogeneity Simulator](../CodeLibrary/scripts/01_endogeneity_simulator.do) - see IV in action
- [Method Decision Tree](../CodeLibrary/scripts/02_method_decision_tree_v2.do) - when to use IV

---

## Practice

[TRY]
- [ ] Think about your research: What variable might be endogenous?
- [ ] Brainstorm 3 possible instruments
- [ ] For each instrument, ask: Does it satisfy relevance? Exclusion? Independence?

[PREDICT]
- [ ] If you used IV, would the estimate be bigger or smaller than OLS?
- [ ] Why?

[CHECK]
- [ ] If you have data, run both OLS and IV
- [ ] Check the first-stage F-stat
- [ ] Run the endogeneity test

[REFLECT]
Write a paragraph defending your instrument. Why does it satisfy the exclusion restriction? What threats to validity remain? How confident are you in the IV estimate compared to OLS?
