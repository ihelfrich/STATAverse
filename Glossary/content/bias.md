## A property of an estimator

The bias of an estimator for a parameter is its expected value minus that parameter:

\[\operatorname{Bias}(\hat\theta)=E[\hat\theta]-\theta.\]

The expectation is taken over repeated samples under a specified data-generating process. A single estimate's distance from a true value is its estimation error, which combines the estimator's systematic tendency with sample variation. A biased estimator can happen to be close to the parameter in one sample; an unbiased estimator can be far away.

## Bias and precision

Precision concerns the spread of the sampling distribution. Bias concerns its center relative to the parameter. Under the usual squared-error decomposition,

\[E[(\hat\theta-\theta)^2]=\operatorname{Var}(\hat\theta)+\operatorname{Bias}(\hat\theta)^2.\]

Some procedures deliberately trade bias for lower variance. That can improve prediction or a particular loss criterion, but it does not establish that a coefficient estimates a desired causal parameter.

## Bias and consistency

Unbiasedness is a finite-sample expectation property. Consistency means that the estimator converges to the target parameter as the sample grows under stated conditions. An estimator may be biased in finite samples and still consistent. An estimator with persistent identification problems can remain inconsistent even in a very large sample.

Increasing the number of observations can reduce sampling variability without fixing a systematic mismatch between the estimand and the target. Reporting a smaller standard error does not resolve that mismatch.

## Regression example

A regression of exam score on study hours may capture differences in prior preparation as well as the relationship of interest. If a structural interpretation omits preparation, and preparation belongs in the outcome equation and is associated with study hours, the short-regression slope generally differs from the structural hours slope.

The practice data let you compare specifications. They do not supply evidence about the causal effect of study time in real students. A coefficient change after adding attendance is a description of the fitted models; it cannot by itself reveal how much bias was removed.

[Compare models on a common sample](../Learn/#inference). See [omitted-variable bias](concept.html?id=omitted-variable-bias), [endogeneity](concept.html?id=endogeneity) and [standard errors](concept.html?id=standard-errors).
