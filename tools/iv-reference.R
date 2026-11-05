library(jsonlite)
args <- commandArgs(trailingOnly=TRUE)
cases <- fromJSON(args[1], simplifyVector=FALSE)
models <- list()
for (entry in cases) {
  d <- read.csv(file.path(args[2], paste0(entry$id,".csv")))
  n <- nrow(d); df <- n-2
  p <- entry$options
  robust <- isTRUE(p$robust)
  confidence <- if(is.null(p$confidence)) .95 else p$confidence
  X <- cbind(d$x,1); Z <- cbind(d$z,1)
  Xhat <- Z %*% solve(crossprod(Z),crossprod(Z,X))
  bread <- solve(crossprod(Xhat))
  b <- bread %*% crossprod(Xhat,d$y)
  u <- drop(d$y-X %*% b)
  V <- if(robust) n/df*bread %*% crossprod(Xhat*u) %*% bread else sum(u^2)/df*bread
  fit <- function(y,x) {
    m <- lm(y~x); Xm <- model.matrix(m); inv <- solve(crossprod(Xm))
    vc <- if(robust) n/df*inv %*% crossprod(Xm*residuals(m)) %*% inv else vcov(m)
    c(b=coef(m)[[2]],se=sqrt(vc[2,2]),intercept=coef(m)[[1]])
  }
  first <- fit(d$x,d$z); reduced <- fit(d$y,d$z); ordinary <- fit(d$y,d$x); naive <- fit(d$y,Xhat[,1]); ar <- fit(d$y-entry$candidate*d$x,d$z)
  critical <- qt((1+confidence)/2,df)
  se <- sqrt(V[1,1]); test <- ar[[1]]/ar[[2]]
  models[[entry$id]] <- list(b=unname(b[1]),intercept=unname(b[2]),se=se,covariance=unname(V),lo=b[1]-critical*se,hi=b[1]+critical*se,
    first=as.list(first),reduced=as.list(reduced),ols=as.list(ordinary),naive=as.list(naive),firstF=(first[[1]]/first[[2]])^2,
    ar=list(f=test^2,p=2*pt(-abs(test),df)))
}
write_json(list(method="Independent R matrix 2SLS and lm transformed-outcome regressions",models=models),args[3],auto_unbox=TRUE,pretty=TRUE,digits=17)
