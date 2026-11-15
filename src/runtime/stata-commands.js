// Commands of official Stata 19 that the browser does not run. Typing one
// is refused as a real command that is not available here, not as a
// command Stata does not know (r(199) "unrecognized"), which would send a
// student hunting for a typo. The command table is consulted first, so a
// name the runtime comes to implement is simply never reached here.
export const STATA_COMMANDS = new Set(
  `
  sureg reg3 sem gsem rreg cnsreg eivreg frontier nl nlsur gmm mvreg manova
  xtgee xtgls xtpcse xtabond xtdpd xtdpdsys xthtaylor xtfrontier xtcointtest
  xtunitroot xtheckman xtcloglog xtologit xtoprobit xtnbreg xttobit
  xtintreg xtstreg xteregress xtrc xtmlogit
  meglm meprobit mecloglog meologit meoprobit menbreg meintreg metobit
  mestreg meqrlogit meqrpoisson
  heckprobit heckoprobit heckpoisson ivprobit ivtobit ivpoisson ivqregress
  mprobit asclogit asmixlogit asroprobit cmclogit cmmixlogit cmroprobit
  cmrologit nlogit rologit slogit scobit hetprobit hetoprobit hetregress
  biprobit zip zinb zioprobit tnbreg tpoisson gnbreg betareg fracreg binreg
  exlogistic expoisson sqreg bsqreg iqreg lpoly npregress npgraph mfp fp
  stepwise nestreg
  svar vec vecrank varbasic varstable varlmar varnorm varwle veclmar
  vecnorm vecstable irf fcast arch arfima ucm dfactor sspace mswitch
  threshold tsfilter dfgls xcorr cumsp pergram wntestq wntestb
  stcrreg stcurve stpower stsplit stjoin stfill stgen strate stptime stmh
  stmc sttocc snapspan stintreg stteffects stvary ltable
  power sampsi cci csi iri mcc mcci ir cs cc tabodds mhodds symmetry kappa
  kap icc alpha factor pca rotate screeplot loadingplot scoreplot cluster
  clustermat discrim candisc canon mds mdsmat ca camat mca biplot
  procrustes ladder gladder qladder boxcox lnskew0 bcskew0 spikeplot
  dotplot stem lv symplot dstdize istdize
  statsby permute rolling etable collect dtable putdocx putpdf dyndoc
  dyntext markdown mi xpose mkspline tsreport xttab xttrans suest pwmean
  eteffects etregress etpoisson mediate hdidregress lasso elasticnet
  sqrtlasso dsregress dslogit dspoisson poregress pologit popoisson
  xporegress xpologit xpopoisson bayes bayesmh bayesstats bayestest
  bayesgraph churdle mlexp irt cmset cmsummary spregress spivregress
  spxtregress spmatrix spset avplots rvpplot cprplot acprplot tsrline
  xtline
  intreg truncreg xtivreg predictnl linktest ksmirnov pcorr tetrachoric
  median nptrend loneway mvtest hotelling lroc lsens lfit lstat roctab
  roccomp rocreg rocfit rocgold tsfill ipolate tsrevar smooth expandcl
  drawnorm corr2data range splitsample postfile post postclose file frame
  frames frget frlink webuse uselabel move aorder cf compare datasignature
  checksum odbc jdbc saveold outfile tabdisp serrbar qqplot quantile vce
  svmat stci stphplot fvset fvexpand mata python java shell winexec xshell
  erase rm rmdir copy type filefilter unzipfile zipfile translate ml
  marksample tsunab fvunab creturn putmata getmata ado update sysdir
  adopath discard beep
  `
    .split(/\s+/)
    .filter(Boolean),
);
