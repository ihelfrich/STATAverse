# Independent reference calculations: R lm and sandwich::vcovHC.
library(jsonlite)
library(sandwich)
reference <- list()
for (dataset in c('study','wages')) {
  data <- read.csv(paste0('tests/fixtures/', dataset, '.csv'))
  models <- if (dataset == 'study') list(simple = score ~ hours, controls = score ~ hours + attendance) else list(controls = wage ~ education + experience)
  for (name in names(models)) {
    fit <- lm(models[[name]], data = data)
    for (robust in c(FALSE,TRUE)) {
      cov <- if(robust) vcovHC(fit, type='HC1') else vcov(fit)
      b <- coef(fit); se <- sqrt(diag(cov)); df <- df.residual(fit)
      tt <- b/se; p <- 2*pt(-abs(tt),df); critical <- qt(.975,df)
      key <- paste(dataset,name,if(robust)'robust' else 'ols',sep=':')
      reference[[key]] <- list(n=nobs(fit),df=df,r2=summary(fit)$r.squared,rmse=summary(fit)$sigma,coefficients=lapply(seq_along(b),function(i)list(name=if(names(b)[i]=='(Intercept)')'_cons' else names(b)[i],b=unname(b[i]),se=unname(se[i]),t=unname(tt[i]),p=unname(p[i]),lo=unname(b[i]-critical*se[i]),hi=unname(b[i]+critical*se[i]))))
    }
  }
}
write_json(list(source='R lm + sandwich::vcovHC(type=HC1)',R=as.character(getRversion()),sandwich=as.character(packageVersion('sandwich')),models=reference),'tests/fixtures/r-reference.json',pretty=TRUE,auto_unbox=TRUE,digits=16)
cat('Wrote',length(reference),'independent regression references.\n')
