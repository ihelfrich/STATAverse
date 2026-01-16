## What Does This Mean?

You left an important variable out of your regression. That missing variable affects both your X and your Y. Now your coefficient for X is wrong because it's picking up some of the effect from the variable you forgot.

Here's the classic example: You're studying whether education (X) increases wages (Y). But you don't control for ability. Smart people get more education AND earn more money. Your education coefficient captures both the education effect and the ability effect. It's too big. That's omitted variable bias.

**Why this wrecks everything:** You think education raises wages by $50k when it really only raises them by $20k. Your policy recommendation is wrong. Your theory test is wrong. Your whole paper is wrong.

---

## The Three Ingredients for Bias

Omitted variable bias happens when ALL THREE of these are true:

1. **The omitted variable (Z) affects Y**
   - Example: Ability affects wages

2. **The omitted variable (Z) is correlated with X**
   - Example: Smarter people get more education

3. **You didn't include Z in your regression**
   - Example: You can't measure ability, so you left it out

If even one of these is false, there's no omitted variable bias from that variable.

---

## The Direction of Bias

Which way does the bias go? Depends on the signs.

**Positive bias** (your coefficient is too big):
- Z is positively related to both X and Y
- OR Z is negatively related to both X and Y

**Negative bias** (your coefficient is too small):
- Z is positively related to X but negatively related to Y
- OR Z is negatively related to X but positively related to Y

**Example 1**: Education and wages, omitting ability
- Ability → Education: Positive (smart people get more education)
- Ability → Wages: Positive (smart people earn more)
- Same signs → Positive bias (education coefficient too high)

**Example 2**: Police and crime, omitting crime severity
- Crime severity → Police: Positive (bad areas get more police)
- Crime severity → Crime: Positive (bad areas have more crime)
- Same signs → Positive bias (police appear to INCREASE crime)

---

## Why Adding Controls Can Make It Worse

You might think: "I'll just add more variables and fix it."

Doesn't work. Here's why:

### The Control Must Be the Actual Confounder

If you add variables that aren't the omitted confounder, you don't reduce bias. You just burn degrees of freedom.

### Bad Controls Make It Worse

If you control for a **mediator** (something on the causal path from X to Y), you block part of the effect you're trying to measure.

**Example**: Studying education → wages. You control for job title. But education affects wages THROUGH job title. You just threw away the main mechanism. Your coefficient is now biased DOWNWARD.

### More Controls ≠ Better

This isn't Pokémon. You don't "catch 'em all." Every control has to be justified by theory. Ask yourself:
- Does this variable affect Y?
- Is it correlated with X?
- Is it a confounder or a mediator?

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the formula</summary>
  <div class="math-block">
    True model:

    \[Y = \beta_0 + \beta_1 X + \beta_2 Z + u\]

    But you run:

    \[Y = \beta_0 + \beta_1 X + error\]

    The omitted variable Z ends up in your error term. That makes X correlated with the error.

    The bias in \(\hat{\beta}_1\) is:

    \[Bias(\hat{\beta}_1) = \beta_2 \cdot \frac{Cov(X, Z)}{Var(X)}\]

    **Interpretation**:
    - \(\beta_2\): Effect of Z on Y
    - \(Cov(X, Z) / Var(X)\): Regression coefficient if you regressed Z on X

    The bias is the effect of Z, times how much Z moves with X.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the matrix version</summary>
  <div class="math-block">
    True model:

    \[y = X_1\beta_1 + X_2\beta_2 + u\]

    where \(X_1\) is included, \(X_2\) is omitted.

    You estimate:

    \[\hat{\beta}_1 = (X_1'X_1)^{-1}X_1'y\]

    Substitute the true model:

    \[\hat{\beta}_1 = \beta_1 + (X_1'X_1)^{-1}X_1'X_2\beta_2 + (X_1'X_1)^{-1}X_1'u\]

    Taking expectations:

    \[E[\hat{\beta}_1] = \beta_1 + (X_1'X_1)^{-1}X_1'X_2\beta_2\]

    The middle term is the bias. It's zero only if:
    - \(\beta_2 = 0\) (Z doesn't affect Y), OR
    - \(X_1'X_2 = 0\) (X and Z are orthogonal)
  </div>
</details>

---

## How to Detect It

You can't directly test for omitted variable bias. If you could measure the omitted variable, you'd just include it.

But you can look for warning signs:

### Check Your Theory

Is there an obvious variable you didn't measure? Something that affects both X and Y?

Make a directed acyclic graph (DAG). Draw arrows from causes to effects. If there's a backdoor path from X to Y through another variable, you have a problem.

### Compare Models

Add controls one at a time. If your main coefficient jumps around a lot, it's probably biased.

```stata
regress y x1
estimates store m1

regress y x1 x2
estimates store m2

regress y x1 x2 x3
estimates store m3

estimates table m1 m2 m3, star stats(N r2)
```

If the x1 coefficient changes drastically, you're picking up confounding.

### Use Sensitivity Analysis

Simulate how strong an omitted confounder would have to be to flip your result.

"If there's an unobserved variable with correlation 0.3 to both X and Y, my result disappears."

That tells you how fragile your finding is.

---

## How to Fix It

### Option 1: Measure and Include It

The clean solution. Find data on the omitted variable and add it.

```stata
* Before: Biased
regress wage education

* After: Less biased
regress wage education ability test_score family_income
```

But you can't measure everything. Ability? Motivation? Luck? Good luck finding those in a dataset.

### Option 2: Use Fixed Effects

If the omitted variable doesn't change over time, fixed effects sweep it out.

```stata
xtset person_id year
xtreg wage education experience, fe vce(cluster person_id)
```

This removes all time-invariant person-level confounders (ability, family background, personality).

### Option 3: Find an Instrument

Use instrumental variables to isolate the exogenous part of X.

```stata
* Instrument: Distance to nearest college
* Affects education, doesn't directly affect wages
ivregress 2sls wage experience (education = distance_college), robust
estat firststage
```

Only works if you have a valid instrument (hard to find, hard to defend).

### Option 4: Use a Natural Experiment

Find a setting where X changes for reasons unrelated to the omitted variable. Policy changes, lotteries, geographic boundaries.

```stata
* Regression discontinuity
rdrobust wage education, c(cutoff)
```

Closest thing to random assignment you'll get with observational data.

---

## What People Get Wrong

**"I have 47 control variables, so there's no omitted variable bias."** Quality over quantity. If you didn't include the actual confounder, those 47 variables do nothing.

**"My R² is 0.95, so I've controlled for everything."** R² measures fit, not causality. You can have perfect fit and massive bias.

**"I'll use stepwise regression to pick controls."** Terrible idea. Stepwise selection picks variables based on correlation, not causality. It will happily include mediators and exclude confounders.

**"Fixed effects solve all my problems."** Only if the confounders are time-invariant. If the omitted variable changes over time, fixed effects don't help.

**"I'll add interactions to be safe."** Interactions are not a substitute for confounders. They model how effects change across groups, not how variables jointly cause Y.

---

## Real-World Example

**Question**: Do firms with female CEOs perform better?

**Naive regression**:
```stata
regress firm_performance female_ceo firm_size industry_dummies
```

**Problem**: Board quality is omitted. Better boards hire better CEOs (including women) AND improve performance. The female_ceo coefficient picks up board quality too.

**Bias direction**: Positive (female_ceo coefficient too high)

**Better approach**:
```stata
* Add board controls
regress firm_performance female_ceo board_independence board_size director_experience firm_size industry_dummies

* Or use fixed effects
xtset firm_id year
xtreg firm_performance female_ceo firm_size, fe vce(cluster firm_id)
```

Fixed effects control for time-invariant firm quality (including persistent board quality).

---

## How to Write About It

Here's what a good paper does:

> "CEO tenure may be confounded by unobserved firm quality. High-quality firms both retain CEOs longer and perform better, biasing naive OLS estimates upward. We address this in three ways. First, we include time-varying controls for board composition, analyst coverage, and industry dynamism. Second, we estimate firm fixed effects models to absorb time-invariant quality differences. Third, we use an IV strategy exploiting variation in state-level governance reforms. Across all specifications, the positive tenure-performance relationship persists, suggesting it is not driven by omitted firm quality."

You need:
- Clear statement of what might be omitted
- Direction of bias
- Multiple strategies to address it
- Robustness check showing results hold

---

## Related Concepts

- [Bias](./bias.html) - the general concept
- [Endogeneity](./endogeneity.html) - omitted variable bias is one type
- [Confounding](./confounding.html) - another way to think about it
- [Instrumental Variables](./instrumental-variable.html) - one solution
- [Fixed Effects](./fixed-effects.html) - another solution

---

## Read More

**Start here:**
- Clarke, K. A. (2005). "The phantom menace: Omitted variable bias in econometric research." *Conflict Management and Peace Science*, 22(4), 341-352.
- Busenbark, J. R., et al. (2022). "Introducing the problem, not the solution: The importance of theoretical variables in causal inference research." *Journal of Management*, 48(4), 934-966.

**Then dive deeper:**
- Wooldridge, J. M. (2010). *Econometric Analysis of Cross Section and Panel Data*. Chapter 5.
- Angrist, J. D., & Pischke, J. S. (2009). *Mostly Harmless Econometrics*. Chapter 3.

**Try it yourself:**
- [Endogeneity Simulator](../CodeLibrary/scripts/01_endogeneity_simulator.do) - create omitted variable bias
- [Anti-Patterns Guide](../CodeLibrary/scripts/03_anti_patterns.do) - see what NOT to do

---

## Practice

[TRY]
- [ ] Think about your own research
- [ ] List 3 variables you DIDN'T include in your model
- [ ] For each: Does it affect Y? Is it correlated with your main X?

[PREDICT]
- [ ] Which omitted variable creates the biggest bias?
- [ ] What's the direction: positive or negative?
- [ ] How would you fix it if you could?

[CHECK]
- [ ] Run your model with and without controls for possible confounders
- [ ] How much does your main coefficient change?

[REFLECT]
Write a paragraph defending your control variable strategy. Why are you confident you haven't missed a major confounder? What would it take to change your conclusion?
