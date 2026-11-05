library(jsonlite)
library(sandwich)
folder <- 'tests/fixtures/inference-lab'
cases <- fromJSON(file.path(folder,'cases.json'), simplifyVector=FALSE)
output <- list()
for (entry in cases) {
  data <- read.csv(file.path(folder,paste0(entry$id,'.csv')))
  fit <- lm(y ~ x, data=data)
  p <- entry$options
  covariances <- list(conventional=vcov(fit), hc1=vcovHC(fit,type='HC1'),
    cluster=vcovCL(fit,cluster=data$cluster,type='HC1',cadjust=TRUE))
  methods <- list()
  b <- unname(coef(fit)['x'])
  for (method in names(covariances)) {
    se <- sqrt(covariances[[method]]['x','x'])
    df <- if(method=='cluster') length(unique(data$cluster))-1 else df.residual(fit)
    critical <- qt((1+p$confidence)/2,df)
    lo <- b-critical*se; hi <- b+critical*se
    methods[[method]] <- list(se=se,df=df,critical=critical,lo=lo,hi=hi,
      p=2*pt(-abs((b-p$nullValue)/se),df),covers=lo<=p$beta && p$beta<=hi,
      rejects=p$nullValue<lo || p$nullValue>hi)
  }
  output[[entry$id]] <- list(n=nrow(data),groups=length(unique(data$cluster)),b=b,
    intercept=unname(coef(fit)[1]),residuals=unname(residuals(fit)),methods=methods)
}
write_json(list(source='R lm, sandwich vcovHC HC1, vcovCL HC1 with cadjust; Student t with N-2 or G-1 df',
  R=as.character(getRversion()),models=output),file.path(folder,'reference.json'),pretty=TRUE,auto_unbox=TRUE,digits=16)
cat('Wrote',length(output),'independent inference references.\n')
