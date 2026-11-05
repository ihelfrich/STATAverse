## Overview
When the outcome is not continuous, OLS can mislead. This module teaches you how to select and
interpret models for binary and count outcomes using the Fulfillment Delays dataset.

## Learning goals
- Choose between linear, logit/probit, and count models.
- Interpret coefficients using marginal effects.
- Diagnose overdispersion in count data.
- Connect model choice to the data generating process.

## Model selection at a glance
<div class="model-selector" data-model-selector>
  <div class="model-selector-controls">
    <button class="model-tab" data-model-tab="continuous">Continuous</button>
    <button class="model-tab" data-model-tab="binary">Binary</button>
    <button class="model-tab" data-model-tab="count">Count</button>
  </div>
  <div class="model-selector-panels">
    <div class="model-panel" data-model-panel="continuous">
      <h3>Continuous outcome</h3>
      <p>Start with OLS. Check linearity, heteroskedasticity, and outliers.</p>
      <p><strong>Typical models:</strong> OLS, robust OLS, quantile regression.</p>
    </div>
    <div class="model-panel" data-model-panel="binary">
      <h3>Binary outcome</h3>
      <p>Model probabilities with logit or probit. Report marginal effects.</p>
      <p><strong>Typical models:</strong> logit, probit, LPM (with caution).</p>
    </div>
    <div class="model-panel" data-model-panel="count">
      <h3>Count outcome</h3>
      <p>Specify the conditional mean and investigate dispersion. Robust Poisson inference can remain useful without Poisson equidispersion; negative binomial adds a different variance model.</p>
      <p><strong>Typical models:</strong> Poisson, negative binomial, zero-inflated.</p>
    </div>
  </div>
</div>

## Step 1: Identify the outcome type
[TRY]
- [ ] Open the dataset description and list the outcomes you could model.

[PREDICT]
- [ ] Which is binary? Which is a count?

[CHECK]
- Expected: `delay` is binary; `delay_days` is a count.

[REFLECT]
- Why would OLS be risky for these outcomes?

## Step 2: Binary outcomes with logit
We model the probability of delay as a function of operations variables.

\[P(delay = 1 | X) = \frac{1}{1 + e^{-(\beta_0 + \beta_1 x_1 + \cdots)}}\]

<details class="math-toggle algebra">
  <summary>Show algebra details</summary>
  <div class="math-block">
    The logit model maps predictors to log-odds:

    \[\log\left(\frac{p}{1-p}\right) = \beta_0 + \beta_1 x_1 + \cdots\]

    A one-unit change in \(x\) changes the log-odds by \(\beta\).
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show linear algebra form</summary>
  <div class="math-block">
    In vector form the linear predictor is:

    \[\eta = \mathbf{X}\beta\]

    and the probability uses the logistic link:

    \[p = \frac{1}{1 + e^{-\eta}}\]
  </div>
</details>

[TRY]
- [ ] Run:
```stata
import delimited using "data/fulfillment_delays.csv", clear
* The supplied supplier tiers are strings; factor variables need numeric codes.
encode supplier_tier, generate(supplier_id)
logit delay i.expedited distance_km backlog_index weather_disruption i.supplier_id
margins, dydx(expedited)
```

[PREDICT]
- [ ] Should expedited shipping reduce delay probability?

[CHECK]
- Inspect the estimated discrete change from expedited = 0 to expedited = 1. Its sign is an empirical result of these data and this model, not a conclusion implied by the variable name. Because expedited is entered with i., margins reports a discrete change, averaged over the estimation sample.

[REFLECT]
- Interpret the `margins` output in plain language.

## Step 3: Count outcomes with Poisson and NB
The Poisson distribution equates the conditional mean and variance. Poisson quasi-maximum likelihood with a correctly specified conditional mean and suitable robust inference does not require the full Poisson variance restriction. Negative binomial adds a variance specification; a larger unconditional sample variance does not by itself select the correct model.

<details class="math-toggle algebra">
  <summary>Show Poisson form</summary>
  <div class="math-block">
    The Poisson mean is:

    \[E(y|X) = \exp(\mathbf{X}\beta)\]

    Dispersion is assessed conditional on the modeled covariates. An unconditional mean–variance comparison is not the same restriction.
  </div>
</details>

<details class="math-toggle linalg">
  <summary>Show log-likelihood structure</summary>
  <div class="math-block">
    The Poisson log-likelihood sums over observations:

    \[\ell(\beta) = \sum_i (y_i \log \mu_i - \mu_i - \log(y_i!))\]

    where \(\mu_i = \exp(\mathbf{X}_i\beta)\).
  </div>
</details>

[TRY]
- [ ] Run:
```stata
poisson delay_days i.expedited distance_km backlog_index weather_disruption i.supplier_id
estat gof
nbreg delay_days i.expedited distance_km backlog_index weather_disruption i.supplier_id
```

[PREDICT]
- [ ] Does an unconditional variance above the mean establish that NB is preferable?

[CHECK]
- A negative-binomial specification can accommodate a particular form of conditional overdispersion. Compare the mean specification, diagnostics and predictive performance; a larger unconditional variance alone does not establish that it is preferable.

[REFLECT]
- When would you choose Poisson anyway?

## Step 4: Visual intuition
A quick visual: backlog index vs delay outcome.

<div class="data-visual">
  <canvas
    class="data-chart"
    data-chart
    data-chart-type="scatter"
    data-csv="../data/fulfillment_delays.csv"
    data-x="backlog_index"
    data-y="delay"
    aria-label="Scatterplot of backlog index vs delay"
    role="img"
  ></canvas>
</div>

[TRY]
- [ ] Describe the pattern: does higher backlog appear to increase delays?

[PREDICT]
- [ ] Should backlog have a positive effect on delay probability?

[CHECK]
- Compare the plotted pattern with the estimated conditional association. A plausible operational hypothesis does not determine the sign in these data or establish a causal effect.

[REFLECT]
- How would you explain this to an operations manager?

## Step 5: Communicate the model choice
<button class="glossary-term" data-definition="A model mis-specification where the functional form or distribution does not match the outcome.">Misspecification</button>
and
<button class="glossary-term" data-definition="Conditional variance exceeds the conditional mean. This challenges the Poisson distributional restriction, but not necessarily a Poisson conditional-mean model with robust inference.">overdispersion</button>
are common issues in limited outcome models.

[TRY]
- [ ] Write two sentences explaining why you chose logit for delay and NB for delay_days.

[PREDICT]
- [ ] What would go wrong with OLS here?

[CHECK]
- Expected: OLS can predict probabilities outside 0-1 and mis-handle variance for counts.

[REFLECT]
- Explain why interpretation changes when outcomes are non-linear.

## Self-test
1) What is the key difference between logit and LPM?
2) What does overdispersion tell you?
3) Why do we report marginal effects for logit?

Answer key (short)
- Q1: Logit constrains predictions to 0-1; LPM does not.
- Q2: Conditional overdispersion challenges Poisson equidispersion. It does not alone disqualify Poisson quasi-maximum likelihood or select NB.
- Q3: Coefficients are in log-odds, so marginal effects are more interpretable.
