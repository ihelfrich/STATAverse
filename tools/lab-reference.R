# Independent lm, sandwich covariance and built-in influence diagnostics.
library(jsonlite)
library(sandwich)
cases <- fromJSON('tests/fixtures/regression-lab/cases.json', simplifyVector=FALSE)
output <- list()
extract <- function(fit, robust) {
  cov <- if (robust) vcovHC(fit, type='HC1') else vcov(fit)
  b <- coef(fit); se <- sqrt(diag(cov)); critical <- qt(.975, df.residual(fit))
  list(n=nobs(fit), df=df.residual(fit), coefficients=lapply(seq_along(b),function(i)list(
    name=if(names(b)[i]=='(Intercept)')'_cons' else names(b)[i], b=unname(b[i]), se=unname(se[i]),
    lo=unname(b[i]-critical*se[i]), hi=unname(b[i]+critical*se[i]))))
}
for (entry in cases) {
  data <- read.csv(paste0('tests/fixtures/regression-lab/',entry$id,'.csv'))
  full <- lm(y ~ x + z, data=data)
  simple <- lm(y ~ x, data=data)
  rx <- residuals(lm(x ~ z,data=data)); ry <- residuals(lm(y ~ z,data=data))
  selected <- entry$selected
  deleted <- lm(y ~ x + z, data=data[data$id != selected,])
  output[[entry$id]] <- list(
    simple=extract(simple, entry$options$robust), full=extract(full,entry$options$robust),
    partialSlope=unname(coef(lm(ry ~ 0 + rx))[1]),
    partialR2=1-sum(residuals(full)^2)/sum(ry^2),
    remainingXVariation=sum(rx^2)/sum((data$x-mean(data$x))^2),
    leverage=unname(hatvalues(full)), cook=unname(cooks.distance(full)), standardized=unname(rstandard(full)),
    deleted=extract(deleted,entry$options$robust)
  )
}
write_json(list(source='R lm, sandwich HC1, hatvalues, cooks.distance, rstandard; all exported synthetic rows',R=as.character(getRversion()),models=output),
  'tests/fixtures/regression-lab/reference.json',pretty=TRUE,auto_unbox=TRUE,digits=16)
cat('Wrote',length(output),'independent regression-lab references.\n')
