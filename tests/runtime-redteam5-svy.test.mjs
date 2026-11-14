// svyset, svydescribe and the svy: prefix (linearized variance). The
// printed tables are compared line by line with Stata in
// tests/runtime-output.test.mjs (the svy-* cases of tools/output-cases.txt);
// this file checks what text cannot: return codes, estimates at full
// precision, the design's life with the data, and the refusals of what is
// not implemented. Expected values were recorded from Stata 19 MP (version
// 17, set processors 1) on the same data, which runiform() reproduces draw
// for draw.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const SETUP = [
  "clear",
  "set seed 5",
  "set obs 60",
  "generate strat = 1 + floor((_n-1)/30)",
  "generate psu = 1 + floor((_n-1)/5)",
  "generate w = 1 + runiform()",
  "generate y = runiform()",
  "generate x = runiform()",
  "generate b = runiform() < .5",
  "svyset psu [pw=w], strata(strat)",
].join("\n");

function session(extra = "") {
  const s = new Session();
  const result = s.run(`${SETUP}\n${extra}`);
  assert.equal(result.rc, 0, JSON.stringify(result.output.at(-1)));
  return s;
}
/** The return code and message of a line run after the setup. */
function failure(line, extra = "") {
  const s = session(extra),
    result = s.run(line),
    last = result.output.at(-1);
  return { rc: result.rc, text: last.lines.join("\n") };
}
const close = (actual, expected, digits = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) <= digits * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );

test("svy estimates match Stata at full precision", () => {
  const s = session("svy: mean y x");
  close(s.results.e.N_pop, 88.05029332637787, 1e-12);
  const at = (name) => s.estimates.names.indexOf(name);
  close(Math.sqrt(s.estimates.V[at("y")][at("y")]), 0.0313395647412318, 1e-9);
  close(s.estimates.b[at("x")], 0.4163887050588481, 1e-12);
  s.run("svy: logit b x");
  const x = s.estimates.names.indexOf("x");
  close(s.estimates.b[x], -0.4547068696379836, 1e-6);
  close(Math.sqrt(s.estimates.V[x][x]), 0.8875112654686531, 1e-6);
  close(s.results.e.F, 0.2624915227015268, 1e-6);
  assert.equal(s.results.e.df_r, 10);
  assert.equal(s.results.e.N_strata, 2);
  assert.equal(s.results.e.N_psu, 12);
});

test("errors carry Stata's return codes", () => {
  assert.equal(failure("svy: mean y", "svyset, clear").rc, 119);
  assert.equal(
    failure(
      "svy: mean y",
      "generate fv = 20 + _n\nsvyset psu [pw=w], strata(strat) fpc(fv)",
    ).rc,
    461,
  );
  assert.equal(
    failure(
      "svy: mean y",
      "generate f2 = 3\nsvyset psu [pw=w], strata(strat) fpc(f2)",
    ).rc,
    462,
  );
  assert.equal(failure("svy: mean y", "replace w = -1 in 3").rc, 402);
  assert.equal(failure("svy: summarize y").rc, 322);
  assert.equal(failure("svyset psu [aw=w]").rc, 101);
  assert.equal(failure("svyset psu [pw=w*2]").rc, 111);
  assert.equal(failure("svy: mean y, vce(linearized)").rc, 198);
  const lr = failure("lrtest m1 .", "svy: regress y x\nestimates store m1");
  assert.equal(lr.rc, 322);
  assert.match(lr.text, /lrtest is not appropriate with survey estimation/);
  assert.equal(failure("estat ic", "svy: regress y x").rc, 321);
  assert.equal(failure("predict p", "svy: proportion b").rc, 301);
});

test("what is not implemented is refused with r(198), never ignored", () => {
  for (const [line, extra] of [
    ["svy jackknife: mean y"],
    ["svy bootstrap: mean y"],
    ["svy, vce(brr): mean y"],
    ["svy, vce(sdr): mean y"],
    ["svyset psu [pw=w], vce(jackknife)"],
    ["svyset psu [iw=w]"],
    ["svyset psu, poststrata(strat) postweight(w)"],
    ["svyset psu [pw=w], fpc(w) || _n"],
    ["svy: tobit y x, ll(0)"],
    ["svy: ivregress 2sls y (x = b)"],
    ["svy: tabulate strat b, se"],
    ["svy: tabulate strat b, wald"],
    ["svy: mean y, stdize(strat) stdweight(w)"],
    ["svy: proportion b, over(strat)"],
    ["svy: proportion b, citype(wilson)"],
    ["svy, subpop(b) srssubpop: mean y"],
    ["margins", "svy: regress y x"],
    ["margins, dydx(x)", "svy: logit b x"],
    ["estat gof", "svy: logit b x"],
    ["hausman m1 .", "svy: regress y x\nestimates store m1"],
  ]) {
    const { rc, text } = failure(line, extra);
    assert.equal(rc, 198, `${line}: ${text}`);
    assert.ok(text.length > 10, `${line} has no hint`);
  }
});

test("a perfect predictor is refused rather than fitted to infinity", () => {
  const { rc, text } = failure("svy: logit b d", "generate d = b");
  assert.equal(rc, 198);
  assert.match(text, /predicts .* perfectly/);
});

test("the design stays with the data: save and use, preserve and clear", () => {
  const s = session("save svydata\nclear\nuse svydata");
  assert.equal(s.data.svyset?.psu, "psu");
  assert.equal(s.data.svyset?.strata, "strat");
  s.run("preserve\nsvyset, clear\nrestore");
  assert.equal(s.data.svyset?.weight, "w");
  s.run("clear");
  assert.equal(s.data.svyset, undefined);
  const shown = s.run("svyset").output.at(-1).lines;
  assert.deepEqual(shown, ["no survey characteristics are set"]);
});

test("a dropped design variable is Stata's error, not a crash", () => {
  const { rc, text } = failure("svy: mean y", "drop strat");
  assert.equal(rc, 111);
  assert.match(text, /variable strat not found/);
});

test("test after svy is the adjusted Wald test", () => {
  const s = session("svy: regress y x b"),
    lines = s.run("test x b").output.at(-1).lines;
  assert.equal(lines[1], "Adjusted Wald test");
  assert.equal(s.results.r.df_r, 9);
  assert.equal(s.results.r.df, 2);
});

// ----- the fifth round's survey fixes -----
// The data of the user-data red team: schools sampled within regions, with
// weights, missing incomes and labelled factors. Expected values were
// recorded from Stata 19 MP (version 17, set processors 1) on the same
// data, which runiform() and invnormal(runiform()) reproduce.
const USERDATA = [
  "clear",
  "set seed 2468",
  "set obs 400",
  "generate region = 1 + floor(runiform()*4)",
  'label define reg 1 "North" 2 "South" 3 "East" 4 "West"',
  "label values region reg",
  "generate school = region*100 + 1 + floor(runiform()*6)",
  "generate wt = 0.5 + 3*runiform()",
  "generate age = 18 + floor(runiform()*50)",
  "generate educ = 1 + floor(runiform()*4)",
  'label define ed 1 "Less than HS" 2 "HS" 3 "Some college" 4 "College+"',
  "label values educ ed",
  "generate employed = runiform() < .6",
  'label define yn 0 "No" 1 "Yes"',
  "label values employed yn",
  "generate income = 20000 + 300*age + 2000*educ + 8000*invnormal(runiform())",
  "generate hours = 20 + 20*runiform()",
  "replace income = . if runiform() < .05",
  "replace hours = . if runiform() < .03",
  'generate sex = cond(runiform()<.5, "male", "female")',
  "svyset school [pweight=wt], strata(region)",
].join("\n");
function userdata(extra = "") {
  const s = new Session(),
    result = s.run(`${USERDATA}\n${extra}`);
  assert.equal(result.rc, 0, JSON.stringify(result.output.at(-1)));
  return s;
}
/** The return code and message of a line run on the user data. */
function userFailure(line, extra = "") {
  const s = userdata(extra),
    result = s.run(line),
    last = result.output.at(-1);
  return {
    rc: result.rc,
    text: last.lines.filter((line) => !/^r\(\d+\);$/.test(line)).join("\n"),
  };
}

test("a design whose strata all have one unit runs under every singleunit rule", () => {
  const SINGLE = [
    "clear",
    "set seed 31",
    "set obs 40",
    "generate s = 1 + floor((_n-1)/10)",
    "generate w = 1 + runiform()",
    "generate y = runiform()",
    "generate x = runiform()",
  ].join("\n");
  for (const rule of ["certainty", "scaled", "centered"]) {
    const s = new Session(),
      result = s.run(
        `${SINGLE}\nsvyset s [pw=w], strata(s) singleunit(${rule})\nsvy: regress y x\nsvy: mean y`,
      );
    assert.equal(
      result.rc,
      0,
      `${rule}: ${JSON.stringify(result.output.at(-1))}`,
    );
    assert.equal(s.results.e.df_r, 0);
  }
  // Stata: e(V) is zero, e(rank) 0 and e(df_m) 0 under certainty; under
  // centered the variance is .00042549 and the regression keeps rank 2.
  const s = new Session();
  s.run(
    `${SINGLE}\nsvyset s [pw=w], strata(s) singleunit(certainty)\nsvy: regress y x`,
  );
  assert.equal(s.results.e.rank, 0);
  assert.equal(s.results.e.df_m, 0);
  assert.ok(s.results.e.F >= 8.98e307, "F is missing");
  assert.deepEqual(s.estimates.V, [
    [0, 0],
    [0, 0],
  ]);
  s.run("svyset s [pw=w], strata(s) singleunit(centered)\nsvy: regress y x");
  assert.equal(s.results.e.rank, 2);
  assert.equal(s.results.e.df_m, 1);
  s.run("svy: mean y");
  close(s.estimates.V[0][0], 0.00042549, 1e-4);
});

test("zero weights count in the sample but not in the subpopulation", () => {
  const s = userdata(
    "replace wt = 0 in 1/3\nsvy, subpop(employed): regress income age",
  );
  assert.equal(s.results.e.N, 387);
  assert.equal(s.results.e.N_sub, 225);
  assert.equal(s.results.e.N_subpsu, 24);
  close(s.results.e.N_subpop, 449.18680065870285, 1e-12);
  close(s.estimates.b[0], 262.47703819401505, 1e-10);
  close(Math.sqrt(s.estimates.V[0][0]), 51.419540695302693, 1e-10);
  const zero = userFailure(
    "svy, subpop(if school == 101 & employed == 1): mean age",
    "replace wt = 0 if school == 101 & employed == 1",
  );
  assert.equal(zero.rc, 461);
  assert.equal(
    zero.text.split("\n").at(-1),
    "all observations in subpop() subpopulation have zero weights",
  );
  const none = userFailure("svy, subpop(if age > 200): mean age");
  assert.equal(none.rc, 461);
  assert.match(none.text, /no observations in subpop\(\) subpopulation/);
});

test("a negative weight stops svy even on an observation the command drops", () => {
  const extra = "replace wt = -1 in 10";
  assert.equal(userFailure("svy: mean income", extra).rc, 402);
  assert.equal(userFailure("svy: mean age", extra).rc, 402);
  assert.equal(userFailure("svy: regress income age", extra).rc, 402);
  const s = userdata(extra);
  assert.equal(s.run("svy: mean income if _n != 10").rc, 0);
});

test("lincom and test reach the estimates of mean and total over groups", () => {
  const s = userdata("svy: mean income, over(educ)");
  s.run("lincom c.income@2.educ - c.income@1.educ");
  close(s.results.r.estimate, 3141.9978076419357, 1e-12);
  close(s.results.r.se, 1225.8832582493458, 1e-10);
  close(s.results.r.p, 0.018548609283200301, 1e-9);
  const shown = s
    .run("lincom income@2.educ - income@1.educ")
    .output.at(-1).lines;
  assert.ok(
    shown.some((line) =>
      line.includes("- c.income@1bn.educ + c.income@2.educ = 0"),
    ),
  );
  s.run("test c.income@2.educ = c.income@1.educ");
  close(s.results.r.F, 6.5692157793681254, 1e-10);
  assert.equal(s.results.r.df_r, 20);
  s.run("svy: mean income, over(region employed)");
  assert.equal(s.results.e.N_over, 8);
  assert.equal(
    s.results.e.over_namelist,
    "1bn.region#0bn.employed 1bn.region#1.employed 2.region#0bn.employed 2.region#1.employed 3.region#0bn.employed 3.region#1.employed 4.region#0bn.employed 4.region#1.employed",
  );
  const at = s.estimates.names.indexOf("c.income@4.region#1.employed");
  close(s.estimates.b[at], 37381.944456222787, 1e-12);
  close(Math.sqrt(s.estimates.V[at][at]), 1089.6394146743276, 1e-10);
});

test("svy tabulate stores the null-corrected and likelihood-ratio statistics", () => {
  const s = userdata("svy: tabulate educ employed");
  close(s.results.e.F_Penl, 0.86886613529723256, 1e-10);
  close(s.results.e.df1_Penl, 2.35087582672252, 1e-10);
  close(s.results.e.df2_Penl, 47.017516534450401, 1e-10);
  close(s.results.e.p_Penl, 0.44139955150325605, 1e-10);
  close(s.results.e.cun_LR, 3.2257757153973445, 1e-10);
  close(s.results.e.F_LR, 0.87099835480384535, 1e-10);
  close(s.results.e.F_LRnl, 0.85573743873505026, 1e-10);
  close(s.results.e.p_LRnl, 0.44732400926645233, 1e-10);
});

test("svy, the estimator alone and ereturn display show the estimates again", () => {
  const s = userdata("svy: regress income age"),
    first = s.run("svy").output.at(-1).lines;
  assert.ok(first.some((line) => line.startsWith("Survey: Linear regression")));
  const ninety = s.run("svy, level(90)").output.at(-1).lines.join("\n");
  assert.match(ninety, /\[90% conf\. interval\]/);
  assert.match(ninety, /202\.2002 {4}318\.9024/);
  assert.equal(s.run("regress").rc, 0);
  assert.equal(s.run("ereturn display").rc, 0);
  assert.equal(s.results.e.cmdname, "regress");
  assert.equal(s.run("logit").rc, 301);
  s.run("svy: mean income age");
  assert.equal(s.results.e.N_over, 1);
  assert.equal(new Session().run("svy").rc, 301);
  assert.equal(userdata("regress income age").run("svy").rc, 301);
});

test("svy messages and return codes are Stata's", () => {
  for (const [line, rc, text, extra] of [
    ["svyset nosuch [pw=wt]", 111, "nosuch invalid psu variable name"],
    ["svyset school region", 103, "too many variables specified"],
    [
      "svyset school [pw=wt], strata(nosuch)",
      111,
      "variable nosuch not found\n(error in option strata())",
    ],
    [
      "svyset school [pw=wt], strata(region) fpc(sex)",
      109,
      "string variables not allowed in option fpc();\nsex is a string variable",
    ],
    [
      "svyset school [pw=wt], singleunit(bogus)",
      198,
      "option singleunit() invalid",
    ],
    [
      "svyset school [pw=wt], dof(-2)",
      125,
      "dof() invalid -- invalid number, outside of allowed range",
    ],
    ["svyset school [pw=wt], dof(abc)", 121, "dof() invalid -- invalid number"],
    [
      "svy: regress income age [pw=wt]",
      101,
      "weights not allowed with the svy prefix\n    The svy prefix assumes survey weights were already specified using svyset.",
    ],
    [
      "svy: regress income age, robust",
      198,
      "option robust not allowed with the svy prefix",
    ],
    [
      "svy: regress income age, cluster(school)",
      198,
      "option cluster() not allowed with the svy prefix",
    ],
    [
      "svy: regress income age, noheader",
      198,
      "option noheader not allowed with the svy prefix",
    ],
    ["svy, subpop(sex): mean income", 109, "invalid subpop() option"],
    ["svy, subpop(nosuch): mean income", 111, "invalid subpop() option"],
    [
      "svy, subpop(employed): logit employed age",
      2000,
      "an error occurred when svy executed logit",
    ],
    ["svy mean income", 198, "'' found where ':' expected"],
    [
      "svy: mean income, over(sex)",
      109,
      "string variables not allowed in varlist;\nsex is a string variable\ninvalid over() option",
    ],
    [
      "svy: ratio income/hours age/hours",
      198,
      "invalid ratio specification: too many '/'",
    ],
    ["svyset", 111, "variable wt not found", "rename wt weight"],
    ["regress income ib(#7).educ age", 175, "factor level out of range"],
  ]) {
    const result = userFailure(line, extra);
    assert.equal(result.rc, rc, `${line}: ${result.text}`);
    assert.ok(result.text.endsWith(text), `${line}: ${result.text}`);
  }
});

test("options Stata takes are taken, not refused", () => {
  const s = userdata();
  for (const line of [
    "svy: mean income, noheader",
    "svy: mean income, nolegend",
    "svy: proportion educ, percent",
    "svy: ratio myr: income/hours",
    "svy: ratio income hours",
    "svy: ratio (income/hours) age/hours",
    "svy: logit employed age, noheader",
    "svy: tabulate educ, noheader",
    "svy: regress income ib2.educ age employed",
  ])
    assert.equal(s.run(line).rc, 0, line);
  // percent changes what the table shows, not e(b).
  s.run("svy: proportion educ, percent");
  close(s.estimates.b[0], 0.29601887474658978, 1e-12);
  close(Math.sqrt(s.estimates.V[0][0]), 0.022345129552471692, 1e-10);
  s.run("svy: regress income ib2.educ age employed");
  const at = s.estimates.names.indexOf("1.educ");
  close(s.estimates.b[at], -2889.6303872113344, 1e-10);
  close(Math.sqrt(s.estimates.V[at][at]), 1228.0753432025167, 1e-10);
  close(s.results.e.F, 45.291811126628289, 1e-10);
  const vce = s
    .run("regress income age hours\nestat vce, corr")
    .output.at(-1).lines;
  assert.equal(vce[1], "Correlation matrix of coefficients of regress model");
});
