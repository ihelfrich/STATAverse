## What Does This Mean?

The number in front of your variable in the regression equation. It tells you how much Y changes when X increases by one unit, holding everything else constant.

In the simplest case: \(Y = 3 + 2X\)

The coefficient on X is 2. Interpretation: "When X goes up by 1, Y goes up by 2."

**Why this matters:** The coefficient is what you're trying to estimate. It's the answer to "What is the relationship between X and Y?" But interpreting it correctly depends on your model, your variables, and your assumptions.

---

## What "Holding Everything Else Constant" Means

When you run:
```stata
regress wage education experience age
```

The coefficient on education is the effect of ONE MORE YEAR of education, assuming experience and age stay the same.

**This is a thought experiment.** You're comparing two people who differ ONLY in education, not in experience or age.

**Example**:
- Person A: Education = 16, Experience = 5, Age = 28
- Person B: Education = 17, Experience = 5, Age = 28

The education coefficient tells you the wage difference between A and B.

**Important**: This is NOT the same as the total effect of education in the real world. Education usually comes with more experience, different jobs, etc. The coefficient isolates the direct effect.

---

## How to Interpret Coefficients in Different Models

### Linear-Linear (Both Variables in Levels)

```stata
regress wage education
```

Coefficient: 2.5

**Interpretation**: "One more year of education is associated with $2,500 higher annual wages."

Units: Y units per X unit.

### Log-Linear (Log Y, Linear X)

```stata
gen log_wage = log(wage)
regress log_wage education
```

Coefficient: 0.08

**Interpretation**: "One more year of education is associated with an 8% increase in wages."

Formula: % change in Y = (coefficient × 100)%

### Linear-Log (Linear Y, Log X)

```stata
gen log_education = log(education)
regress wage log_education
```

Coefficient: 15000

**Interpretation**: "A 1% increase in education is associated with a $150 increase in wages."

Formula: Change in Y = coefficient / 100 (for 1% change in X)

### Log-Log (Both Variables in Logs)

```stata
gen log_wage = log(wage)
gen log_education = log(education)
regress log_wage log_education
```

Coefficient: 1.2

**Interpretation**: "A 1% increase in education is associated with a 1.2% increase in wages."

This is an **elasticity**. Constant percentage relationship.

---

## Standardized Coefficients (Beta Coefficients)

Sometimes you want to compare the importance of different variables that have different units.

**Standardized coefficient**: Effect of a one-standard-deviation change in X on Y, measured in standard deviations of Y.

```stata
regress wage education experience, beta
```

The `beta` option gives you standardized coefficients.

**Interpretation**: "A one-SD increase in education leads to a 0.45-SD increase in wages."

**When to use**:
- Comparing relative importance of predictors
- Variables measured in incomparable units (years of education vs. IQ points)

**When NOT to use**:
- When you care about real-world magnitudes
- For policy or decision-making (need actual units)

---

## Dummy Variables (Binary Predictors)

When X is binary (0 or 1):

```stata
regress wage female
```

Coefficient: -5000

**Interpretation**: "Women earn $5,000 less than men, on average."

The coefficient is the difference in Y between the two groups.

### Multiple Categories (Reference Group)

```stata
regress wage i.education_level
* where education_level = 1 (HS), 2 (Some college), 3 (BA), 4 (Grad)
```

Stata automatically creates dummies and drops one category (reference group).

If HS is the reference:
- Coefficient on "Some college": Difference between some college and HS
- Coefficient on "BA": Difference between BA and HS
- Coefficient on "Grad": Difference between grad degree and HS

**How to change the reference group**:
```stata
regress wage ib3.education_level
```

Now category 3 (BA) is the reference.

---

## Interactions: Coefficient Depends on Another Variable

When you include an interaction:

```stata
regress performance c.training##c.experience
```

You get THREE coefficients:
1. Main effect of training
2. Main effect of experience
3. Interaction term (training × experience)

**Interpretation of the interaction coefficient**:
"The effect of training increases by [interaction coefficient] for each additional year of experience."

**BUT**: You can't interpret the main effects alone. You have to calculate marginal effects at specific values of the moderator.

```stata
margins, dydx(training) at(experience=(0 5 10 15))
```

This gives you the effect of training at different experience levels.

**Never interpret interaction coefficients directly.** Always use marginal effects or marginsplot.

---

## Statistical Significance of Coefficients

A coefficient is **statistically significant** if you can reject the null hypothesis that it equals zero.

Check the p-value or t-statistic:
- |t| > 2 → roughly significant at 5% level
- p < 0.05 → significant

**But**:
- Statistical significance ≠ practical importance
- A tiny coefficient can be significant with a huge sample
- A large coefficient can be insignificant with a small sample

Always report:
1. The coefficient (effect size)
2. The standard error (precision)
3. The p-value or confidence interval (significance)
4. The practical meaning (is this a big deal?)

---

## What Can Go Wrong

### Bias

If you have endogeneity, omitted variables, or measurement error, your coefficient is **biased**—it doesn't equal the true causal effect.

**Example**: Regress health on exercise, omitting diet. The exercise coefficient picks up some of the diet effect. Biased upward.

### Noise

Even if unbiased, your coefficient has **sampling variability**. Different samples give different estimates.

**Example**: True effect = 5. You might get 4.2 in one sample, 5.9 in another. That's noise.

Standard errors quantify this uncertainty.

### Multicollinearity

When your X variables are highly correlated, coefficients become unstable and standard errors blow up.

**Example**: Include both "years of experience" and "age" in the model. They're almost perfectly correlated. The coefficients will be weird, and standard errors will be huge.

**Solution**: Drop one, create a composite index, or use ridge regression.

### Overfitting

Including too many predictors makes coefficients fit your specific sample but fail to generalize.

**Example**: 50 observations, 40 predictors. R² = 0.99. But the model is junk outside your sample.

**Solution**: Keep models simple. Use cross-validation. Penalize complexity (lasso, ridge).

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the OLS formula</summary>
  <div class="math-block">
    Simple regression:

    \[Y = \beta_0 + \beta_1 X + u\]

    OLS chooses \(\beta_0\) and \(\beta_1\) to minimize the sum of squared residuals:

    \[\min_{\beta_0, \beta_1} \sum_{i=1}^n (Y_i - \beta_0 - \beta_1 X_i)^2\]

    Solution:

    \[\hat{\beta}_1 = \frac{Cov(X, Y)}{Var(X)}\]

    \[\hat{\beta}_0 = \bar{Y} - \hat{\beta}_1 \bar{X}\]

    **Interpretation**: \(\beta_1\) is the sample covariance divided by the variance of X.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show the matrix form</summary>
  <div class="math-block">
    Multiple regression:

    \[y = X\beta + u\]

    where:
    - \(y\) is n × 1 (outcome vector)
    - \(X\) is n × k (design matrix)
    - \(\beta\) is k × 1 (coefficient vector)
    - \(u\) is n × 1 (error vector)

    OLS estimator:

    \[\hat{\beta} = (X'X)^{-1}X'y\]

    This projects y onto the column space of X.

    Variance:

    \[Var(\hat{\beta}) = \sigma^2 (X'X)^{-1}\]

    where \(\sigma^2\) is the error variance.
  </div>
</details>

---

## How to Report Coefficients

### In a Table

Standard format:

| Variable    | Model 1 | Model 2 | Model 3 |
|-------------|---------|---------|---------|
| Education   | 2.5***  | 2.3***  | 1.8**   |
|             | (0.4)   | (0.5)   | (0.7)   |
| Experience  |         | 1.2***  | 1.0**   |
|             |         | (0.3)   | (0.4)   |
| Female      |         |         | -5.0**  |
|             |         |         | (2.1)   |
| N           | 1000    | 1000    | 1000    |
| R²          | 0.23    | 0.31    | 0.35    |

Notes: Standard errors in parentheses. *** p<0.01, ** p<0.05, * p<0.10.

### In Text

> "Education significantly predicts wages (β = 2.5, SE = 0.4, p < 0.001). Each additional year of education is associated with $2,500 higher annual wages, holding experience and gender constant. This effect is economically meaningful, representing approximately 6% of average wages in our sample."

Include:
- Coefficient
- Standard error
- P-value or significance level
- Interpretation in original units
- Practical significance

---

## Common Mistakes

**"My coefficient is big, so the effect is important."** Depends on the scale. A coefficient of 1000 sounds big until you realize the outcome ranges from 0 to 1,000,000.

**"Coefficient of 0.5 means X explains 50% of Y."** No. That's not how coefficients work. You're thinking of R².

**"The coefficient is the correlation."** No. Correlation is standardized and symmetric. Coefficients have units and direction.

**"I'll compare coefficients across models to see which variable matters most."** Coefficients have different units. Use standardized coefficients (beta) for that comparison.

**"Significant coefficient = causal effect."** No. Significance just means "probably not zero." Doesn't mean causal. You need exogeneity for that.

---

## Coefficient vs. Other Quantities

**Coefficient vs. Correlation**:
- Correlation: Symmetric, unitless, standardized
- Coefficient: Directional, has units, unstandardized

**Coefficient vs. Marginal Effect**:
- In linear models: Same thing
- In nonlinear models: Marginal effect is the effect on the outcome; coefficient is the effect on log-odds, latent variable, etc.

**Coefficient vs. Elasticity**:
- Coefficient: Change in Y per unit change in X
- Elasticity: % change in Y per % change in X (log-log model)

**Coefficient vs. R²**:
- Coefficient: Effect size
- R²: Proportion of variance explained

---

## Related Concepts

- [Standard Errors](./standard-errors.html) - uncertainty around the coefficient
- [P-value](./p-value.html) - significance of the coefficient
- [Bias](./bias.html) - when the coefficient is wrong
- [Marginal Effects](./marginal-effects.html) - what to report in nonlinear models
- [Interpretation](./regression-interpretation.html) - how to explain coefficients

---

## Read More

**Start here:**
- Wooldridge, J. M. (2020). *Introductory Econometrics: A Modern Approach*. Chapter 2.
- Kennedy, P. (2008). *A Guide to Econometrics* (6th ed.). Chapter 2.

**Then dive deeper:**
- Angrist, J. D., & Pischke, J. S. (2009). *Mostly Harmless Econometrics*. Chapter 3.
- Gelman, A., & Hill, J. (2007). *Data Analysis Using Regression and Multilevel/Hierarchical Models*. Chapters 3-4.

**Try it yourself:**
- [OLS Intuition Module](../ZeroToHero/modules/02-ols-intuition.html) - interactive walkthrough
- [Regression Plain English](../CodeLibrary/scripts/00_regression_plain_english.do) - practice interpreting

---

## Practice

[TRY]
- [ ] Run a simple regression on your data
- [ ] Identify the coefficient on your main predictor
- [ ] Write out the interpretation in a complete sentence

[PREDICT]
- [ ] Before running: Will the coefficient be positive or negative?
- [ ] How big do you expect it to be?

[CHECK]
- [ ] Were you right about the sign?
- [ ] Is the magnitude close to what you expected?
- [ ] Is it statistically significant? Practically meaningful?

[REFLECT]
Explain your coefficient to someone who doesn't know statistics. What does this number mean in the real world? If you could change X by 10 units, what would happen to Y? Is that a big deal or a small deal?
