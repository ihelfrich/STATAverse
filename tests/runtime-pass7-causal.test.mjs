// The seventh pass's causal-inference commands: teffects ra, ipw, ipwra and
// aipw; heckman by maximum likelihood and by two steps; didregress and
// xtdidregress with estat ptrends and estat granger. Their printed tables
// are compared line by line in tests/runtime-output.test.mjs (the causal-*
// cases); this file checks at full precision what text cannot: e() and r()
// results, e(b) and e(V), and the predictions after heckman. Every expected
// value was recorded from Stata 19 MP (version 17, set processors 1) on the
// same generated data.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const TEFFECTS = `clear
set seed 4242
set obs 300
generate x1 = invnormal(runiform())
generate x2 = runiform()*4
generate g = floor(runiform()*3)
generate t = runiform() < invlogit(-0.3 + 0.6*x1 - 0.2*x2)
generate y = 1 + 0.5*x1 + 0.3*x2 + 1.2*t + 0.4*t*x1 + invnormal(runiform())`;
const HECKMAN = `clear
set seed 777
set obs 400
generate x1 = invnormal(runiform())
generate x2 = runiform()*3
generate z = invnormal(runiform())
generate u1 = invnormal(runiform())
generate u2 = 0.6*u1 + 0.8*invnormal(runiform())
generate s = (0.3 + 0.8*z + 0.4*x1 + u1) > 0
generate y = 2 + 0.7*x1 - 0.5*x2 + u2 if s`;
const HECKMAN_FORMS = `clear
set seed 2468
set obs 500
generate x1 = invnormal(runiform())
generate x2 = runiform()*3
generate g = 1 + floor(runiform()*3)
generate z = invnormal(runiform())
generate u1 = invnormal(runiform())
generate u2 = -0.4*u1 + 0.9*invnormal(runiform())
generate s = (0.2 + 0.7*z + 0.3*x1 + 0.2*(g==2) + u1) > 0
generate y = 1 + 0.5*x1 + 0.3*(g==3) + u2 if s`;
const DID = `clear
set seed 99
set obs 30
generate id = _n
generate grp = ceil(_n/3)
generate treatedgrp = grp > 6
generate a = invnormal(runiform())
expand 8
bysort id: generate year = 2000 + _n
generate x = invnormal(runiform())
generate d = treatedgrp & year >= 2005
generate y = a + 0.2*year - 400 + 0.5*x + 1.5*d + invnormal(runiform())`;

function session(data) {
  const s = new Session();
  assert.equal(s.run(data).rc, 0);
  return s;
}
function run(s, command) {
  const result = s.run(command);
  assert.equal(
    result.rc,
    0,
    `${command}: ${result.output.at(-1)?.lines.join(" ")}`,
  );
  return result;
}
/** Agreement to the given relative tolerance (absolute near zero). */
function close(actual, expected, what, tolerance = 1e-7) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${what}: ${actual} against Stata's ${expected}`,
  );
}
const coefficients = (s) => s.estimates.b;
const variance = (s, k) => s.estimates.V[k][k];

test("teffects ra: e(b), e(V) and e() as Stata leaves them", () => {
  const s = session(TEFFECTS);
  run(s, "teffects ra (y x1 x2) (t)");
  [
    1.1204008, 1.6248161, 0.5210261, 0.29367648, 1.0328807, 0.87484326,
    0.30395488, 2.1357158,
  ].forEach((v, k) => close(coefficients(s)[k], v, `e(b)[${k + 1}]`, 1e-7));
  [
    0.01660109, 0.00598281, 0.0054531, 0.00450745, 0.02513937, 0.00810577,
    0.00566496, 0.02309135,
  ].forEach((v, k) => close(variance(s, k), v, `e(V)[${k + 1}]`, 1e-6));
  const e = s.results.e;
  assert.deepEqual(
    [e.N, e.n1, e.n0, e.k_eq, e.k_levels, e.treated, e.control],
    [300, 108, 192, 4, 2, 1, 0],
  );
  assert.equal(e.subcmd, "ra");
  assert.equal(e.omodel, "linear");
  assert.equal(e.vcetype, "Robust");
  assert.equal(e.tlevels, "0 1");
});

test("teffects ipw, ipwra and aipw reach Stata's effects and errors", () => {
  const s = session(TEFFECTS),
    cases = [
      ["teffects ipw (y) (t x1 x2)", 1.110365, 0.1391412],
      ["teffects ipw (y) (t x1 x2, probit), atet", 1.272557, 0.1310885],
      ["teffects ipwra (y x1 x2) (t x1 x2)", 1.104261, 0.124795],
      ["teffects ipwra (y x1 x2) (t x1 x2, probit), atet", 1.274247, 0.1271234],
      ["teffects aipw (y x1 x2) (t x1 x2)", 1.102698, 0.125446],
      ["teffects aipw (y x1 x2) (t x1 x2, probit)", 1.099175, 0.1245958],
      ["teffects aipw (y x1 x2) (t x1 x2), atet", 1.274471, 0.1271087],
      ["teffects ra (y x1 x2) (t), vce(cluster g)", 1.120401, 0.0709312],
      ["teffects ra (y x1 x2) (t) [pweight=x2]", 1.083541, 0.1589211],
    ];
  for (const [command, b, se] of cases) {
    run(s, command);
    close(coefficients(s)[0], b, `${command}: b`, 1e-6);
    close(Math.sqrt(variance(s, 0)), se, `${command}: se`, 1e-6);
  }
  run(s, "teffects ra (y x1 x2) (t), vce(cluster g)");
  assert.equal(s.results.e.N_clust, 3);
});

test("teffects refuses what it does not compute", () => {
  const s = session(TEFFECTS);
  for (const command of [
    "teffects ra (y x1 x2, fprobit) (t)",
    "teffects ipw (y) (t x1 x2, hetprobit(x1))",
    "teffects psmatch (y) (t x1 x2)",
    "teffects ra (y x1 x2) (t), vce(bootstrap)",
    "teffects ra (y x1 x2) (t), osample(v)",
  ])
    assert.equal(s.run(command).rc, 198, command);
  run(s, "teffects ra (y x1 x2) (t)");
  assert.equal(s.run("predict p0 p1, ps").rc, 198);
  assert.equal(s.run("predict a b c, cmean").rc, 103);
  assert.equal(s.run("margins").rc, 322);
  // A logit outcome needs an outcome of 0 and 1.
  assert.equal(s.run("teffects ra (y x1 x2, logit) (t)").rc, 459);
});

const BINARY = `clear
set seed 4242
set obs 400
generate x1 = invnormal(runiform())
generate x2 = runiform()*4
generate t = runiform() < invlogit(-0.3 + 0.6*x1 - 0.2*x2)
generate yb = runiform() < invlogit(-0.5 + 0.7*x1 + 0.2*x2 + 0.8*t)
generate yc = floor(-ln(runiform()) * exp(0.2 + 0.3*x1 + 0.4*t))`;

test("teffects with logit, probit and Poisson outcome models", () => {
  const s = session(BINARY),
    cases = [
      ["teffects ra (yb x1 x2, logit) (t)", 0.316493, 0.0478909],
      ["teffects ra (yb x1 x2, probit) (t), atet", 0.3204732, 0.0456689],
      ["teffects ra (yc x1 x2, poisson) (t), pomeans", 1.003162, 0.0966859],
      ["teffects ipwra (yb x1 x2, logit) (t x1 x2)", 0.3176477, 0.0481449],
      [
        "teffects ipwra (yb x1 x2, probit) (t x1 x2, probit), atet",
        0.3214233,
        0.04555,
      ],
      ["teffects ipwra (yc x1 x2, poisson) (t x1 x2)", 0.480922, 0.1767749],
      ["teffects aipw (yb x1 x2, logit) (t x1 x2)", 0.3184739, 0.048667],
      ["teffects aipw (yb x1 x2, probit) (t x1 x2)", 0.3182341, 0.0486],
      [
        "teffects aipw (yc x1 x2, poisson) (t x1 x2), pomeans",
        1.002493,
        0.0971813,
      ],
      ["teffects aipw (yb x1 x2, logit) (t x1 x2), atet", 0.3199429, 0.0459942],
    ];
  for (const [command, b, se] of cases) {
    run(s, command);
    close(coefficients(s)[0], b, `${command}: b`, 2e-6);
    close(Math.sqrt(variance(s, 0)), se, `${command}: se`, 2e-6);
  }
  assert.equal(s.results.e.omodel, "logit");
  // aipw, atet's conditional means average to its potential-outcome means.
  run(s, "predict cm0 cm1, cmean");
  run(s, "summarize cm0");
  close(s.results.r.mean, 0.4617472, "cmean 0", 2e-6);
  run(s, "summarize cm1");
  close(s.results.r.mean, 0.7816902, "cmean 1", 2e-6);
});

test("predict after teffects: statistics, labels and defaults as Stata's", () => {
  const s = session(TEFFECTS);
  run(s, "replace x2 = . in 3");
  run(s, "teffects ra (y x1 x2) (t)");
  const assumed = run(s, "predict te1").output.at(-1).lines.join("\n");
  assert.match(assumed, /\(option te assumed; treatment effect\)/);
  run(s, "predict cm0 cm1, cmean");
  run(s, "predict xb0 xb1, xb");
  run(s, "predict ate*, te");
  const labels = {
    te1: "treatment effect, t: 1 vs 0",
    cm0: "mean prediction, t=0",
    cm1: "mean prediction, t=1",
    xb0: "linear prediction, t=0",
    ate1: "treatment effect, t: 1 vs 0",
  };
  for (const [name, label] of Object.entries(labels))
    assert.equal(s.data.get(name).label, label, name);
  const means = { te1: 1.134414, cm0: 1.624083, cm1: 2.758497 };
  for (const [name, mean] of Object.entries(means)) {
    run(s, `summarize ${name}`);
    close(s.results.r.mean, mean, name, 2e-6);
    assert.equal(s.results.r.N, 299);
  }
  run(s, "teffects ipw (y) (t x1 x2)");
  run(s, "predict p0 p1");
  run(s, "predict pxb, xb");
  assert.equal(s.data.get("p1").label, "propensity score, t=1");
  assert.equal(s.data.get("pxb").label, "Linear prediction, t=1");
  run(s, "summarize p1");
  close(s.results.r.mean, 0.3578595, "ps", 2e-6);
  run(s, "summarize pxb");
  close(s.results.r.mean, -0.676399, "ps index", 2e-6);
  assert.equal(s.run("predict tq, te").rc, 198);
  run(s, "teffects aipw (y x1 x2) (t x1 x2, probit)");
  run(s, "predict ate3");
  run(s, "predict psx, psxb");
  run(s, "summarize ate3");
  close(s.results.r.mean, 1.113777, "aipw te", 2e-6);
  run(s, "summarize psx");
  close(s.results.r.mean, -0.4086296, "aipw psxb", 2e-6);
});

test("heckman with sampling and frequency weights", () => {
  const s = session(
    `${HECKMAN}\ngenerate pw = 0.5 + runiform()*2\ngenerate fw = 1 + floor(runiform()*3)`,
  );
  run(s, "heckman y x1 x2 [fweight=fw], select(x1 z) nolog");
  const e = s.results.e;
  close(e.ll, -1074.380810020854, "e(ll)", 1e-10);
  close(e.chi2, 278.0780903070337, "e(chi2)", 1e-8);
  close(e.rho, 0.6264892115060212, "e(rho)", 1e-8);
  close(e.chi2_c, 28.85038615981443, "e(chi2_c)", 1e-8);
  assert.equal(e.wtype, "fweight");
  run(s, "heckman y x1 x2 [pweight=pw], select(x1 z) nolog");
  assert.equal(s.results.e.vcetype, "Robust");
  assert.equal(s.run("heckman y x1 x2 [aweight=pw], select(x1 z)").rc, 101);
  assert.equal(
    s.run("heckman y x1 x2 [pweight=pw], select(x1 z) twostep").rc,
    198,
  );
});

test("heckman by maximum likelihood: e() as Stata leaves it", () => {
  const s = session(HECKMAN);
  run(s, "heckman y x1 x2, select(x1 z)");
  const e = s.results.e;
  close(e.ll, -518.369219621591, "e(ll)", 1e-10);
  close(e.chi2, 141.0580969673095, "e(chi2)", 1e-8);
  close(e.rho, 0.5789157126790134, "e(rho)", 1e-8);
  close(e.sigma, 0.9911186899355371, "e(sigma)", 1e-8);
  close(e.lambda, 0.5737741827335215, "e(lambda)", 1e-8);
  close(e.selambda, 0.1448962973132917, "e(selambda)", 1e-8);
  close(e.chi2_c, 12.82121403965192, "e(chi2_c)", 1e-8);
  close(e.p_c, 0.0003427112750579, "e(p_c)", 1e-8);
  assert.deepEqual(
    [e.N, e.N_selected, e.N_nonselected, e.rank, e.k, e.df_m],
    [400, 236, 164, 8, 8, 2],
  );
  assert.equal(e.chi2_ct, "LR");
  [
    0.60314644, -0.57298269, 2.1174291, 0.34946943, 0.87900826, 0.31035323,
    0.66083031, -0.00892098,
  ].forEach((v, k) => close(coefficients(s)[k], v, `e(b)[${k + 1}]`, 1e-6));
});

test("heckman, twostep: Heckman's variance as Stata computes it", () => {
  const s = session(HECKMAN);
  run(s, "heckman y x1 x2, select(x1 z) twostep");
  const e = s.results.e;
  close(e.rho, 0.646122494657729, "e(rho)", 1e-8);
  close(e.sigma, 1.006346744289508, "e(sigma)", 1e-8);
  close(e.lambda, 0.6502232689110209, "e(lambda)", 1e-8);
  close(e.selambda, 0.1790940020821092, "e(selambda)", 1e-7);
  close(e.chi2, 140.1330462741835, "e(chi2)", 1e-7);
  assert.equal(e.method, "two-step");
  // The regression's block, lambda's covariances and its own variance.
  const V = s.estimates.V;
  close(V[0][0], 0.00494949, "V[y:x1]", 1e-6);
  close(V[2][1], -0.00670026, "V[y:_cons, y:x2]", 1e-6);
  close(V[6][2], -0.01664336, "V[lambda, y:_cons]", 1e-6);
  close(V[6][6], 0.03207466, "V[lambda]", 1e-6);
  assert.equal(V[3][0], 0);
});

test("heckman, robust and clustered: Wald test of rho", () => {
  const s = session(HECKMAN);
  run(s, "heckman y x1 x2, select(x1 z) vce(robust) nolog");
  close(s.results.e.chi2, 181.94, "e(chi2)", 1e-4);
  close(s.results.e.chi2_c, 15.06, "e(chi2_c)", 1e-3);
  assert.equal(s.results.e.chi2_ct, "Wald");
  close(Math.sqrt(variance(s, 0)), 0.0575308, "se(x1)", 1e-6);
});

test("predict after heckman: each statistic's mean, as Stata's", () => {
  const s = session(HECKMAN_FORMS);
  run(s, "heckman y x1, select(x1 z) twostep rhotrunc");
  const means = {
    ycond: 0.6940387,
    yexpected: 0.5173224,
    psel: 0.5649378,
    mills: 0.7425064,
    xbsel: 0.2105789,
    xb: 1.140819,
    stdp: 0.1332298,
    stdf: 1.01896,
  };
  for (const [statistic, mean] of Object.entries(means)) {
    run(s, `predict p_${statistic}, ${statistic}`);
    run(s, `summarize p_${statistic}`);
    close(s.results.r.mean, mean, statistic, 2e-6);
    assert.equal(s.results.r.N, 500);
  }
  run(s, "heckman y x1, select(x1 z) nolog");
  run(s, "predict c2, ycond");
  run(s, "summarize c2");
  close(s.results.r.mean, 0.6969114, "ycond after ML", 2e-6);
  run(s, "predict q2, stdpsel");
  run(s, "summarize q2");
  close(s.results.r.mean, 0.1084495, "stdpsel after ML", 2e-6);
  assert.equal(s.data.get("q2").label, "S.E. of prediction of select");
});

test("didregress: areg's estimates clustered by group, and e()", () => {
  const s = session(DID);
  run(s, "didregress (y x) (d), group(grp) time(year)");
  [
    1.5392687, 0.42529471, 0, 0.14934864, 0.42372648, 0.35484075, 0.73884283,
    1.0998255, 1.1204801, 1.1693216, 0.45071949,
  ].forEach((v, k) => close(coefficients(s)[k], v, `e(b)[${k + 1}]`, 1e-6));
  close(variance(s, 0), 0.08956475, "V[ATET]", 1e-6);
  close(variance(s, 10), 0.03672402, "V[_cons]", 1e-6);
  const e = s.results.e;
  assert.deepEqual(
    [e.N, e.rank, e.N_clust, e.df_r, e.tmin, e.tmax],
    [240, 9, 10, 9, 2005, 2005],
  );
  assert.equal(e.data_type, "Repeated cross-sectional");
  assert.equal(e.clustvar, "grp");
});

test("estat ptrends and estat granger: r() as Stata leaves it", () => {
  const s = session(DID);
  run(s, "didregress (y) (d), group(grp) time(year)");
  run(s, "estat ptrends");
  close(s.results.r.F, 1.013959604565395, "ptrends F", 1e-7);
  close(s.results.r.p, 0.3402599874172469, "ptrends p", 1e-7);
  assert.deepEqual(
    [s.results.r.df, s.results.r.df_r, s.results.r.N],
    [1, 9, 240],
  );
  run(s, "didregress (y x) (d), group(grp) time(year)");
  run(s, "estat ptrends");
  close(s.results.r.F, 0.486917522341561659, "ptrends F with x", 1e-7);
  run(s, "estat granger");
  close(s.results.r.F, 1.242693600454228, "granger F", 1e-7);
  close(s.results.r.p, 0.3504346530634576, "granger p", 1e-7);
  assert.equal(s.results.r.df, 3);
  run(s, "xtset id year");
  run(s, "xtdidregress (y x) (d), group(id) time(year)");
  run(s, "estat ptrends");
  close(s.results.r.F, 0.480816435836745992, "xt ptrends F", 1e-7);
  assert.equal(s.results.r.df_r, 29);
});

test("didregress refuses what it does not compute", () => {
  const s = session(DID);
  for (const command of [
    "didregress (y x) (d), group(grp) time(year) vce(hc2)",
    "didregress (y x) (d, continuous), group(grp) time(year)",
    "didregress (y x) (d), group(grp id) time(year)",
    "didregress (y x) (d), group(grp) time(year) wildbootstrap(rseed(1))",
  ])
    assert.equal(s.run(command).rc, 198, command);
  run(s, "didregress (y x) (d), group(grp) time(year) vce(robust)");
  assert.equal(s.run("estat ptrends").rc, 198);
  assert.equal(s.run("estat trendplots").rc, 198);
});

// ----- The red team's findings on the seventh pass, fixed -----
// Values recorded from Stata 19 MP (version 17, set processors 1) on the
// same generated data, printed with %21.15g.

const SAMPLES = `clear
set seed 404
set obs 200
generate x1 = invnormal(runiform())
generate x2 = runiform()*3
generate t = runiform() < invlogit(-0.2 + 0.7*x1)
generate yb = runiform() < invlogit(-0.5 + 0.4*x1 + 0.8*t)
generate y = 1 + x1 + 0.4*x2 + t + invnormal(runiform())
replace x2 = . in 7`;

test("aipw, atet with an observation set aside: variance and predictions", () => {
  const s = session(SAMPLES);
  // Stata divides the equations of the means by the share treated in the
  // sample and their derivatives by the share among all the data.
  run(s, "teffects aipw (y x1 x2) (t x1 x2), atet");
  close(coefficients(s)[0], 1.08715461867439, "ATET", 1e-9);
  close(Math.sqrt(variance(s, 0)), 0.155372660158606, "ATET se", 1e-8);
  close(Math.sqrt(variance(s, 1)), 0.146643137298945, "POmean se", 1e-8);
  // predict divides by the share treated among the observations predicted.
  run(s, "predict double a1, te");
  run(s, "predict double a2 a3, cmean");
  const mean = (name) => {
    const v = [...s.data.get(name).data].filter((x) => x < 8.9e307);
    return [v.reduce((t, x) => t + x, 0) / v.length, v.length];
  };
  close(mean("a1")[0], 1.09261770720763, "mean te", 1e-9);
  close(mean("a3")[0], 3.18627091119038, "mean cmean 1", 1e-9);
  assert.equal(mean("a3")[1], 199);
  run(s, "teffects aipw (y x1 x2) (t x1 x2) if x1 > -1, atet");
  close(Math.sqrt(variance(s, 0)), 0.160688418431855, "ATET se, if", 1e-8);
  // ate's cmean needs no propensity score where the level is not observed.
  run(s, "teffects aipw (yb x1, logit) (t x1 x2)");
  run(s, "predict double h2 h3, cmean");
  close(mean("h3")[0], 0.563915443569422, "mean cmean, logit", 1e-9);
  assert.equal(mean("h3")[1], 200);
});

test("aipw's nls and wnls fit the conditional means by least squares", () => {
  const s = session(SAMPLES);
  for (const [command, b, se] of [
    ["teffects aipw (y x1) (t x1), nls", 1.12172173616595, 0.146404201350917],
    ["teffects aipw (y x1) (t x1), wnls", 1.11622310939588, 0.149180769987303],
    [
      "teffects aipw (yb x1, logit) (t x1), nls",
      0.146195084995674,
      0.0757853869688605,
    ],
  ]) {
    run(s, command);
    close(coefficients(s)[0], b, `${command}: b`, 1e-7);
    close(Math.sqrt(variance(s, 0)), se, `${command}: se`, 1e-6);
  }
  assert.equal(s.results.e.cme, "nls");
});

test("heckman's two-step probit variance is version 6's, at its last step's start", () => {
  const s = session(`clear
set seed 4646
set obs 200
generate x1 = invnormal(runiform())
generate z = invnormal(runiform())
generate u1 = invnormal(runiform())
generate s = (0.2 + 0.8*z + 0.3*x1 + u1) > 0
generate y = 2 + 0.6*x1 + u1 if s`);
  run(s, "heckman y x1, select(x1 z) twostep");
  const at = (name) => s.estimates.names.indexOf(name);
  close(Math.sqrt(variance(s, at("select:x1"))), 0.104017555774428, "x1", 1e-7);
  close(Math.sqrt(variance(s, at("select:z"))), 0.139734670075741, "z", 1e-7);
  close(
    Math.sqrt(variance(s, at("/mills:lambda"))),
    0.183009803025062,
    "lambda",
    1e-6,
  );
});

test("heckman's scores and predictions bounded by pr(), e() and ystar()", () => {
  const s = session(`clear
set seed 662
set obs 80
generate x1 = invnormal(runiform())
generate z = invnormal(runiform())
generate u1 = invnormal(runiform())
generate u2 = 0.5*u1 + 0.85*invnormal(runiform())
generate s = (0.2 + 0.8*z + 0.3*x1 + u1) > 0
generate y = 2 + 0.6*x1 + u2 if s`);
  run(s, "heckman y x1, select(x1 z) nolog");
  run(s, "predict double q*, scores");
  const column = (name) => [...s.data.get(name).data];
  [
    42.0745546694657, 32.7799988030817, 16.7554135106979, 76.0246998252921,
  ].forEach((v, k) =>
    close(
      column(`q${k + 1}`).reduce((t, x) => t + x * x, 0),
      v,
      `sum of squared scores ${k + 1}`,
      1e-8,
    ),
  );
  close(column("q1")[0], -0.288128808918988, "q1[1]", 1e-8);
  close(column("q4")[3], -0.866551545852042, "q4[4]", 1e-8);
  run(s, "predict double p1, e(0,3)");
  run(s, "predict double p2, pr(.,2)");
  run(s, "predict double p3, ystar(0,3)");
  const mean = (name) => column(name).reduce((t, x) => t + x, 0) / 80;
  close(mean("p1"), 1.73057404581094, "e(0,3)", 1e-9);
  close(mean("p2"), 0.511179860885585, "pr(.,2)", 1e-9);
  close(mean("p3"), 1.86119427011608, "ystar(0,3)", 1e-9);
  // The two-step fit has no scores; a selection indicator of 0 and 2 is
  // never censored, as Stata reads its sum.
  run(s, "heckman y x1, select(x1 z) twostep");
  assert.equal(s.run("predict w1, scores").rc, 198);
  run(s, "generate s2 = 2*s");
  assert.equal(s.run("heckman y x1, select(s2 = x1 z)").rc, 498);
});

const CELLS = `clear
set seed 808
set obs 20
generate id = _n
generate grp = ceil(_n/2)
generate treatedgrp = grp == 10
generate a = invnormal(runiform())
expand 5
bysort id: generate t = _n
generate x = invnormal(runiform())
generate z = runiform() < 0.5
generate d = treatedgrp & t >= 4
generate y = a + 0.3*t + 0.5*x + 1.2*d + invnormal(runiform())`;

test("didregress: e(rank), residuals, weights and a treatment varying in a cell", () => {
  const s = session(CELLS);
  // e(rank) is the rank of the cluster-robust variance.
  run(s, "didregress (y x) (d), group(grp) time(t)");
  assert.equal(s.results.e.rank, 5);
  run(s, "predict double r1, residuals");
  close(Math.max(...s.data.get("r1").data), 2.85117905918607, "residual", 1e-9);
  run(s, "didregress (y x i.z) (d), group(grp) time(t)");
  assert.equal(s.results.e.rank, 6);
  run(s, "didregress (y x) (d) [fweight=1+z], group(grp) time(t)");
  close(Math.sqrt(variance(s, 0)), 0.203725597636213, "fweight se", 1e-9);
  assert.equal(s.results.e.N, 157);
  run(s, "didregress (y x) (d) [pweight=1+z], group(grp) time(t)");
  close(coefficients(s)[0], 2.84844908546071, "pweight ATET", 1e-9);
  close(Math.sqrt(variance(s, 0)), 0.210266851603635, "pweight se", 1e-9);
  run(s, "xtset id t");
  run(s, "xtdidregress (y x) (d), group(grp) time(t)");
  assert.equal(s.results.e.rank, 5);
  run(s, "xtdidregress (y x) (d), group(id) time(t)");
  assert.equal(s.results.e.rank, 6);
  run(s, "predict double xr, residuals");
  const xr = [...s.data.get("xr").data];
  close(Math.max(...xr), 2.21320770753515, "xt residual max", 1e-9);
  close(Math.min(...xr), -1.97102346407515, "xt residual min", 1e-9);
  // Stata refuses a treatment that varies within a group and period.
  run(s, "generate dv = d");
  run(s, "replace dv = 1 - d if id == 19 & t == 5");
  assert.equal(s.run("didregress (y x) (dv), group(grp) time(t)").rc, 198);
  assert.equal(s.run("xtdidregress (y x) (dv), group(grp) time(t)").rc, 198);
});
