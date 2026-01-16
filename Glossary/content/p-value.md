## What Does This Mean?

The probability of seeing a result this extreme (or more extreme) if the true effect were actually zero.

**NOT**: The probability that your hypothesis is true.
**NOT**: The probability that your result happened by chance.
**NOT**: 1 minus the probability that your finding is real.

P-values tell you about the data, assuming the null hypothesis is true. They don't tell you the probability that your theory is correct.

**Why this matters**: P-values are the most misunderstood statistic in all of science. Misinterpreting them leads to wrong conclusions, overconfidence, and irreproducible research.

---

## What a P-Value Actually Tells You

You run a regression. You get a coefficient of 5.2 with p = 0.03.

**Correct interpretation**: "If the true effect were zero, I'd only see an estimate this large or larger in 3% of samples."

**Wrong interpretation**: "There's a 97% chance my hypothesis is true."

The p-value is computed assuming the null hypothesis (no effect) is true. It's a statement about how surprising your data would be in that world. It's NOT a statement about whether the null is actually true.

---

## The Logic Behind P-Values

1. **Start with the null hypothesis**: The effect is zero (\(\beta = 0\))
2. **Calculate a test statistic**: \(t = \hat{\beta} / SE(\hat{\beta})\)
3. **Ask**: If the null were true, how often would I see a t-statistic this large?
4. **The p-value is that probability**

**Small p-value** (e.g., 0.01): "This result would be really rare if there were no true effect. So either I got really unlucky, or there's actually an effect."

**Large p-value** (e.g., 0.40): "This result is pretty common even if there's no effect. Can't rule out that I'm just seeing noise."

---

## The 0.05 Threshold

**Where it comes from**: Historical convention. R.A. Fisher suggested it in the 1920s as a rough guideline. It's arbitrary.

**What it means**:
- p < 0.05: "Statistically significant" (convention says you can reject the null)
- p ≥ 0.05: "Not significant" (can't reject the null)

**What it does NOT mean**:
- p = 0.049: Real effect
- p = 0.051: No effect

There's nothing magical about 0.05. It's a continuum, not a cliff.

---

## Common Misinterpretations

### Wrong #1: "p = 0.03 means there's a 97% chance my hypothesis is true"

No. The p-value is calculated assuming the null is true. It can't tell you the probability the null is false.

For that, you'd need Bayesian inference and prior probabilities.

### Wrong #2: "p = 0.20 means there's no effect"

No. Failing to reject the null doesn't mean the null is true. Maybe the effect exists but your sample is too small to detect it (low power).

Absence of evidence ≠ evidence of absence.

### Wrong #3: "p < 0.001 is stronger evidence than p = 0.04"

Kind of, but not as much as you'd think. Both are "significant." The p = 0.001 result is more surprising under the null, but that doesn't make it more important, more true, or more reliable.

Small p-values can come from:
- Large effects
- Large samples
- Low variance

A tiny effect in a huge sample can have p < 0.001. That doesn't make it meaningful.

### Wrong #4: "I can't publish this because p = 0.08"

The 0.05 threshold is arbitrary. If your effect is substantively meaningful, report it. Discuss effect size, confidence intervals, and practical significance.

Don't let a mechanical rule override scientific judgment.

---

## What You Should Report Instead

### Effect Size

How big is the effect? Is it large enough to matter in practice?

"Training increases productivity by 8 points (p = 0.02)."

What's the scale of productivity? Is 8 points a lot or a little? Put it in context.

### Confidence Intervals

```stata
regress y x, robust
```

Stata gives you 95% confidence intervals automatically. Report them.

"Training increases productivity by 8 points (95% CI: [2, 14])."

This tells you both significance (interval doesn't include zero) and precision (width of the interval).

### Practical Significance

Statistical significance ≠ practical importance.

"CEO tenure increases ROA by 0.001 percentage points per year (p < 0.001, n = 50,000)."

Highly significant. Completely meaningless.

Always ask: Is this effect large enough to care about?

---

## P-Hacking and Multiple Testing

### P-Hacking

Running many regressions, trying different controls, and only reporting the one with p < 0.05.

**Examples**:
- Add/remove controls until significance appears
- Try different sample restrictions
- Run 20 outcome variables, report the one that's significant

**Why it's bad**: If you run 20 tests, one will probably be "significant" by chance (5% false positive rate). You're finding noise, not signal.

### Multiple Testing Correction

If you're testing multiple hypotheses, adjust your significance threshold.

**Bonferroni correction**: Divide your alpha by the number of tests.

Testing 10 hypotheses? Use α = 0.05/10 = 0.005 instead of 0.05.

```stata
* Testing 3 main effects
regress y x1 x2 x3, robust
test x1 = x2 = x3 = 0
```

The joint test controls the family-wise error rate.

### Pre-Registration

Specify your hypothesis, model, and sample BEFORE you see the data. This stops p-hacking.

Write a pre-analysis plan. Register it. Stick to it.

---

## The Math (If You Want It)

<details class="math-toggle algebra">
  <summary>Show the calculation</summary>
  <div class="math-block">
    Test statistic:

    \[t = \frac{\hat{\beta} - \beta_0}{SE(\hat{\beta})}\]

    Under the null hypothesis (\(\beta_0 = 0\)):

    \[t = \frac{\hat{\beta}}{SE(\hat{\beta})}\]

    If the null is true and assumptions hold, \(t\) follows a t-distribution with \(n-k\) degrees of freedom.

    The p-value is:

    \[p = P(|T| \geq |t| \mid \beta = 0)\]

    where \(T\) is a random variable from the t-distribution.

    **Two-tailed test**: Probability of getting \(t\) this extreme in either direction.
    **One-tailed test**: Probability of getting \(t\) this large in one direction.

    Most regressions use two-tailed tests.
  </div>
</details>

---

## Large Samples Make Everything Significant

With a big enough sample, tiny effects become significant.

**Example**: Effect of education on wages, n = 100,000.

True effect: $100 per year (tiny).
Estimate: $105, SE = $20, t = 5.25, p < 0.001.

Highly significant. But who cares about $100?

**Lesson**: In large samples, focus on effect size, not p-values.

Ask: "Is this large enough to matter?" not "Is this significant?"

---

## Small Samples Make Everything Insignificant

With a small sample, even large effects might not be significant.

**Example**: Effect of training on productivity, n = 20.

True effect: 15 points (huge).
Estimate: 18, SE = 12, t = 1.5, p = 0.15.

Not significant. But the effect might be real—you just don't have enough data.

**Lesson**: Non-significance doesn't mean no effect. Calculate power. Maybe you need more data.

---

## How to Write About P-Values

### Good Practice

> "Training increases productivity by 8 points (SE = 2.1, 95% CI: [3.8, 12.2], p < 0.01). This represents a 15% improvement over baseline, substantively meaningful for operational efficiency."

Reports:
- Effect size (8 points)
- Precision (SE and CI)
- Significance (p < 0.01)
- Practical meaning (15% improvement)

### Bad Practice

> "Training had a significant effect (p = 0.03)."

What's the effect? How big? How precise? This tells you almost nothing.

### When p > 0.05

> "Training's effect on productivity was positive but not statistically significant (β = 3.2, SE = 2.8, p = 0.26). With a larger sample, we could distinguish small effects from zero; our current estimate is too imprecise to draw firm conclusions."

Don't hide null results. Report them honestly and discuss power.

---

## Alternatives to P-Values

### Confidence Intervals

Focus on the range of plausible values, not just significance.

"95% CI: [2, 10]" tells you:
- The effect is probably positive (doesn't include zero)
- It could be as small as 2 or as large as 10
- You can judge practical significance

### Bayesian Inference

Use Bayes factors or posterior probabilities instead of p-values.

These actually give you "probability the hypothesis is true."

Requires prior probabilities (subjective), but more intuitive than p-values.

### Effect Sizes and Power

Report standardized effect sizes (Cohen's d, R²).

Calculate statistical power: "We had 80% power to detect effects of 5 points or larger."

This tells readers what effects you could have missed.

---

## Common Mistakes

**"p = 0.06 is marginally significant."** No. It's not significant. If you want to report it, fine, but don't pretend 0.06 is different from 0.05 in some meaningful way.

**"We found a trend toward significance."** This is just p-hacking language. Either reject the null or don't.

**"p < 0.001 so this is definitely true."** No. P-values tell you about data given the null, not about the probability your theory is true.

**"All my p-values are < 0.05 so my model is correct."** No. Statistical significance doesn't validate your model. You could have endogeneity, omitted variables, measurement error—all while getting p < 0.05.

---

## What the American Statistical Association Says

In 2016, the ASA released a statement on p-values:

1. P-values don't measure the probability that the hypothesis is true
2. Statistical significance ≠ practical importance
3. P-values alone aren't enough for decision-making
4. P-values don't measure effect size
5. P < 0.05 doesn't mean "real"; p > 0.05 doesn't mean "no effect"
6. P-values should be reported with context (effect size, uncertainty, study design)

**Bottom line**: Stop treating p-values as the sole arbiter of truth. They're one piece of evidence among many.

---

## Related Concepts

- [Statistical Significance](./statistical-significance.html) - what p < 0.05 means
- [Confidence Intervals](./confidence-intervals.html) - better than p-values
- [Standard Errors](./standard-errors.html) - what p-values depend on
- [Type I Error](./type-i-error.html) - false positives
- [Type II Error](./type-ii-error.html) - false negatives
- [Power](./statistical-power.html) - probability of detecting real effects

---

## Read More

**Start here:**
- Wasserstein, R. L., & Lazar, N. A. (2016). "The ASA statement on p-values: Context, process, and purpose." *The American Statistician*, 70(2), 129-133.
- Bettis, R. A. (2012). "The search for asterisks: Compromised statistical tests and flawed theories." *Strategic Management Journal*, 33(1), 108-113.

**Then dive deeper:**
- Ziliak, S. T., & McCloskey, D. N. (2008). *The Cult of Statistical Significance*.
- Ioannidis, J. P. (2005). "Why most published research findings are false." *PLOS Medicine*, 2(8), e124.

**Try it yourself:**
- [Statistical Power Calculator](../CodeLibrary/scripts/power_calculator.do)
- [Multiple Testing Simulator](../CodeLibrary/scripts/multiple_testing.do)

---

## Practice

[TRY]
- [ ] Run a regression on your data
- [ ] Identify the p-values for each coefficient
- [ ] Calculate confidence intervals

[PREDICT]
- [ ] Before looking: Which coefficients will be significant?
- [ ] What effect sizes would be practically meaningful?

[CHECK]
- [ ] Were you right about significance?
- [ ] Are any results statistically significant but practically tiny?
- [ ] Are any results large but not significant (power problem)?

[REFLECT]
Write a paragraph explaining one of your results without using the words "significant" or "p-value." Focus on effect size, confidence intervals, and practical meaning. Can you make your finding clear to a non-statistician?
