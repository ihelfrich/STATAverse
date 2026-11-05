## The omitted term and the included predictor

Suppose the population relationship is

\[y=\beta_0+\beta_1 x+\gamma z+u,\]

with the required orthogonality conditions for that structural equation. If a regression includes x but omits z, its population slope is

\[\beta_{short}=\beta_1+\gamma\frac{\operatorname{Cov}(x,z)}{\operatorname{Var}(x)}.\]

The formula requires nonzero variance in x. It describes a simple linear setting; in multiple regression the relevant associations are conditional on the other included regressors.

Two ingredients produce the discrepancy: z contributes to the outcome relationship, and z is associated with x. The sign depends on their product. A missing predictor does not necessarily bias every included slope. Omitting a variable uncorrelated with x in this setting can increase residual variation without shifting the population x slope.

## A study-time example

If stronger prior preparation raises scores and is associated with more study hours, omitting preparation can make the study-hours slope larger than its structural value. If preparation is associated with fewer study hours instead, the direction reverses. Substantive information about these relationships matters; there is no general rule that adding controls shrinks a coefficient.

In [the controls lesson](../Learn/#inference), attendance changes the fitted study-hours relationship. It also removes a row with missing attendance from the model sample. Estimating both specifications on the same sample separates this mechanical sample change from the specification change. It still does not prove that the added control delivers a causal estimate.

## Choosing controls

A control should be justified by the study design and the target relationship. A variable measured after treatment may mediate part of the effect of interest. Conditioning on a collider can create an association that was absent before conditioning. A proxy for an unobserved confounder may leave residual confounding, and poorly measured controls can introduce further problems.

More controls do not guarantee less bias. A principled adjustment set depends on the causal structure, timing and measurement process, not on selecting whichever covariates make a coefficient stable or significant.

## What a coefficient change can show

Nested-model comparisons can describe how estimates change with the conditioning set. They can also expose a coding error or an unexpected sample difference. Without additional assumptions, they do not measure the amount of remaining bias, identify the correct specification or establish the validity of a causal claim.

A residual plot cannot reveal every omitted confounder. Because sample OLS residuals are orthogonal to included regressors, regressing those residuals on the same included x is not a general endogeneity diagnostic.

See [bias](concept.html?id=bias), [endogeneity](concept.html?id=endogeneity) and [coefficients](concept.html?id=coefficient).
