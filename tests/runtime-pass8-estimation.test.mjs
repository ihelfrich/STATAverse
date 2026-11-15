// Pass 8, estimation group: e(sample), result matrices in expressions and
// putexcel, too few observations, by with in, predict stub*, estimates
// table's b, collinearity with factor variables, weight notes and the
// logit iteration log. Every expected value was recorded from Stata 19
// (StataMP, run in batch under version 17 with set processors 1); the data
// come from runiform(), which the runtime draws as Stata does. The printed
// output of the same fixes is compared in tools/output-cases.txt
// (pass8-estimation-* cases).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const close = (actual, expected, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );
function run(source) {
  const s = new Session(),
    result = s.run(source);
  assert.equal(result.rc, 0, JSON.stringify(result.output.at(-1)));
  return s;
}
/** count if e(sample), as r(N). */
function inSample(s) {
  assert.equal(s.run("count if e(sample)").rc, 0);
  return s.results.r.N;
}
/** What a command printed, and its return code. */
function printed(s, command) {
  const result = s.run(command);
  return {
    rc: result.rc,
    text: result.output
      .flatMap((o) => o.lines)
      .flatMap((line) => line.split("\n"))
      .join("\n"),
  };
}

const PANEL = `clear
set seed 4711
set obs 400
generate id = ceil(_n/8)
generate t = mod(_n, 8) + 1
generate x = runiform()
generate z = runiform()
replace x = . if runiform() < .08
replace z = . if runiform() < .12
generate u = runiform()
generate y = 1 + 2*x - z + u
generate yb = y > 1.6
generate yc = floor(3*u + x)`;

test("e(sample) marks each model's estimation sample in expressions, if and in", () => {
  const s = run(PANEL);
  // With no estimates e(sample) is 0, never missing.
  assert.equal(inSample(s), 0);
  const fits = [
    ["regress y x z", 322],
    ["logit yb x z", 322],
    ["probit yb x", 367],
    ["poisson yc x z", 322],
    ["ologit yc x z", 322],
    ["mlogit yc x", 367],
    ["tobit y x z, ll(1.5)", 322],
    ["glm yb x z, family(binomial)", 322],
    ["nbreg yc x", 367],
    ["qreg y x z", 322],
    ["ivregress 2sls y (x = u) z", 322],
    ["areg y z, absorb(id)", 322],
    ["clogit yb x z, group(id)", 293],
    ["mean y z", 322],
    ["proportion yc", 367],
  ];
  for (const [command, expected] of fits) {
    assert.equal(s.run(`quietly ${command}`).rc, 0, command);
    assert.equal(inSample(s), expected, command);
  }
  s.run("quietly regress y x z");
  s.run("generate s1 = e(sample)");
  assert.deepEqual(
    [...new Set(s.data.get("s1").data)].sort(),
    [0, 1],
    "gen s1 = e(sample) is 0 or 1, never missing",
  );
  // Refitting on the same sample keeps it.
  s.run("quietly regress y x if e(sample)");
  assert.equal(s.results.e.N, 322);
  s.run("count if e(sample) in 1/100");
  assert.equal(s.results.r.N, 78);
});

test("e(sample) follows the data through sorts, stores and restores", () => {
  const s = run(`${PANEL}
quietly regress y x z
estimates store A
quietly regress y x`);
  s.run("sort u");
  s.run("estimates restore A");
  assert.equal(inSample(s), 322);
  // The marker moved with the observations it marks.
  s.run("generate double check = e(sample) * (y < .)");
  assert.equal(
    s.data.get("check").data.reduce((t, v) => t + v, 0),
    322,
  );
  s.run("ereturn clear");
  assert.equal(inSample(s), 0);
});

test("expand, merge and reshape keep e(sample) where Stata keeps it", () => {
  const s = run(`clear
set seed 7
set obs 40
generate id = _n
generate g = ceil(_n/10)
generate x = runiform()
generate z = runiform()
replace x = . if runiform() < .25
generate y = x + z + runiform()
tempfile base other
save \`base'
clear
set obs 80
generate id = ceil(_n/2) + 5
generate w = _n
save \`other'
use \`base', clear
quietly regress y x z`);
  assert.equal(inSample(s), 27);
  // A master observation keeps its mark; one repeated for another match,
  // and a using observation, are outside the sample.
  s.run("merge 1:m id using `other', nogenerate");
  assert.equal(inSample(s), 27);
  s.run(`use \`base', clear
quietly regress y x
keep id g x z y
rename (x z) (v1 v2)
reshape long v, i(id) j(k)`);
  assert.equal(inSample(s), 27);
  s.run("count if e(sample) & k == 2");
  assert.equal(s.results.r.N, 27);
  // A copy made by expand is outside the sample.
  s.run(`use \`base', clear
quietly regress y x
expand 2`);
  assert.equal(inSample(s), 27);
});

test("a failed fit leaves e() and e(sample) as Stata leaves them", () => {
  const s = run(`clear
set seed 7
set obs 30
generate id = ceil(_n/10)
generate age = 20 + floor(40*runiform())
generate wage = 10 + .5*age + 3*runiform()
generate yb = runiform() < .5
replace yb = 1 if id == 3`);
  s.run("quietly regress wage age");
  // One observation: regress has marked it, and keeps the estimates.
  assert.equal(s.run("capture regress wage age in 1").rc, 0);
  assert.equal(s.results.e.N, 30);
  assert.equal(inSample(s), 1);
  // No observations, or an outcome that does not vary, clear e().
  s.run("quietly regress wage age");
  s.run("capture regress wage age if id > 5");
  assert.equal(s.results.e.N, undefined);
  assert.equal(inSample(s), 0);
  s.run("quietly regress wage age");
  s.run("capture logit yb age if id == 3");
  assert.equal(s.results.e.cmd, undefined);
  // A syntax error leaves them alone.
  s.run("quietly regress wage age");
  s.run("capture regress wage nosuch");
  assert.equal(inSample(s), 30);
});

test("result matrices are subscripted, named and written as Stata's", () => {
  const s = run(`clear
set seed 31
set obs 300
generate school = ceil(_n/5)
generate x = runiform()
generate age = 20 + 40*runiform()
generate female = runiform() < .5
generate score = 50 + 10*runiform() + 2*x + 3*mod(school, 7)
generate wage = 5 + .3*age - 2*female + 10*runiform()
quietly mixed score x || school:`);
  assert.equal(s.scalar("e(N_g)[1,1]"), 60);
  assert.equal(s.scalar("el(e(N_g),1,1)"), 60);
  s.run("quietly regress wage age female");
  close(s.scalar("e(b)[1,1]"), 0.31238076);
  close(s.scalar("el(e(b),1,1)"), 0.31238076);
  close(s.scalar("el(r(table),1,2)"), -2.0461306);
  close(s.scalar("r(table)[1,1]*2"), 0.62476152);
  close(s.scalar("trace(e(V))"), 0.50778608);
  close(s.scalar('e(b)["y1","age"]'), 0.31238076);
  assert.equal(s.scalar("rowsof(e(V))"), 3);
  assert.equal(s.scalar("colsof(e(b))"), 3);
  for (const [expression, code] of [
    ['e(b)[1,"nosuch"]', 111],
    ["e(N)[1,1]", 198],
    ["e(cmd)[1,1]", 198],
    ["rowsof(nosuch)", 111],
    ["colsof(e(N))", 109],
    ["el(e(N),1,1)", 109],
    ['el(e(V),"age","female")', 109],
  ])
    assert.equal(s.run(`display ${expression}`).rc, code, expression);
  assert.equal(
    printed(s, 'display e(b)[1,"nosuch"]').text.split("\n")[0],
    '"nosuch" not found',
  );
  // In a matrix expression a scalar result is 1 x 1, and one that does
  // not exist is missing.
  s.run("matrix A = e(N)");
  assert.deepEqual(s.matrices.get("A").values, [[300]]);
  s.run("matrix C = r(nosuch)");
  assert.equal(s.matrices.get("C").values.length, 1);
  assert.equal(s.run("matrix C = e(cmd)").rc, 109);
  // putexcel takes the result matrices and matrix expressions.
  for (const command of [
    "putexcel set pass8.xlsx, replace",
    "putexcel B1 = matrix(e(b))",
    "putexcel B3 = matrix(r(table)), names",
    "putexcel B20 = matrix(e(N))",
    "putexcel B24 = matrix(e(nosuch))",
    "putexcel A40 = matrix(e(b)*2)",
  ])
    assert.equal(s.run(command).rc, 0, command);
  assert.equal(s.run("putexcel B26 = matrix(nosuch)").rc, 111);
  assert.equal(s.run("putexcel A1 = matrix(e(cmd))").rc, 109);
  s.run("ereturn clear");
  assert.equal(s.run("matrix C = e(b)").rc, 301);
});

test("one observation is too few, as Stata says before anything else", () => {
  const s = run(`clear
set seed 7
set obs 30
generate id = ceil(_n/10)
generate age = 20 + floor(40*runiform())
generate x1 = runiform()
generate x2 = runiform()
generate wage = 10 + .5*age + 3*runiform()
generate yb = runiform() < .5
generate yc = floor(3*runiform())
generate w = 3`);
  for (const command of [
    "regress wage age in 1",
    "regress wage in 1",
    "regress wage age in 1 [fweight=w]",
    "logit yb age in 1",
    "probit yb age in 1",
    "tobit wage age in 1, ll(20)",
    "mlogit yc age in 1",
    "ologit yc age in 1",
    "oprobit yc age in 1",
    "cloglog yb age in 1",
    "ivregress gmm wage (age = yb) in 1",
    "ivregress liml wage (age = yb) in 1",
  ]) {
    const { rc, text } = printed(s, command);
    assert.equal(rc, 2001, command);
    assert.match(text, /^insufficient observations/, command);
  }
  // 2SLS omits the regressors first, then finds the outcome fit exactly.
  const two = printed(s, "ivregress 2sls wage x1 (age = yb) x2 in 1");
  assert.equal(two.rc, 459);
  assert.equal(
    two.text,
    [
      "note: age omitted because of collinearity.",
      "note: x1 omitted because of collinearity.",
      "note: x2 omitted because of collinearity.",
      "wage collinear with _cons",
      "r(459);",
    ].join("\n"),
  );
  assert.equal(
    printed(s, "ivregress 2sls wage (age = yb) in 1/2").text.split("\n")[0],
    "wage collinear with age _cons",
  );
  // By group, each group with one observation says so and the next runs.
  s.run("generate one = _n\nsort one");
  const by = printed(s, "by one: regress wage age if one < 4");
  assert.equal(by.rc, 0);
  assert.equal(by.text.match(/insufficient observations/g).length, 3);
  assert.equal(by.text.match(/no observations/g).length, 27);
});

test("by refuses in with an estimation command, as Stata does", () => {
  const s = run(`clear
set seed 11
set obs 200
generate female = runiform() < .5
generate age = 20 + 40*runiform()
generate wage = 5 + .3*age + 10*runiform()
sort female`);
  for (const command of [
    "by female: regress wage age in 1/100",
    "bysort female: regress wage age in 1/100",
    "by female: logit female age in 1/100",
    "by female: regress wage age if age > 30 in 1/150, robust",
  ]) {
    const { rc, text } = printed(s, command);
    assert.equal(rc, 190, command);
    assert.equal(text.split("\n")[0], "'in' may not be combined with 'by'");
  }
});

test("predict stub* after mlogit, ologit and oprobit names a variable per outcome", () => {
  const s = run(`clear
set seed 4242
set obs 500
generate x1 = runiform()
generate female = runiform() < .5
generate u = runiform() + .4*x1 + .2*female
generate educ = 1 + (u > .45) + (u > .7) + (u > .95)
quietly mlogit educ x1 female, baseoutcome(1)
predict q*, pr`);
  const mean = (name) =>
    s.data.get(name).data.reduce((t, v) => t + v, 0) / s.data.n;
  close(mean("q1"), 0.174);
  close(mean("q2"), 0.264);
  close(mean("q3"), 0.224);
  assert.equal(s.run("predict t*, xb").rc, 103);
  const few = printed(s, "predict a b, pr");
  assert.equal(few.rc, 102);
  assert.equal(
    few.text,
    [
      "too few variables specified",
      "educ has 4 outcomes and so you must specify 4 new variables, or you can use the",
      "outcome() option and specify variables one at a time",
      "r(102);",
    ].join("\n"),
  );
  assert.equal(s.run("predict a b c d e, pr").rc, 103);
  assert.equal(s.run("predict c1 c2 c3 c4, outcome(2)").rc, 103);
  s.run("quietly ologit educ x1 female\npredict o*");
  assert.ok(s.data.has("o4"));
  s.run("quietly oprobit educ x1 female\npredict h*, pr");
  assert.ok(s.data.has("h4"));
});

test("estimates table takes b, se and star without a format", () => {
  const s = run(`clear
set seed 4242
set obs 300
generate x1 = runiform()
generate x2 = runiform()
generate y = 1 + 1.4*x1 - .6*x2 + runiform()
quietly regress y x1
estimates store a
quietly regress y x1 x2`);
  for (const options of ["b se", "b star", "b", "b(%9.3f) se", "se"])
    assert.equal(s.run(`estimates table a ., ${options}`).rc, 0, options);
});

test("regress with a factor variable omits the later of two collinear variables", () => {
  const s = run(`clear
set seed 4711
set obs 500
generate x1 = runiform()
generate x2 = runiform()
generate t = 1 + floor(4*runiform())
generate y = 1 + .7*x1 - .3*x2 + .5*t + runiform()
generate x3 = 2*x1`);
  for (const [command, omitted] of [
    ["regress y x1 x3 i.t", "x3"],
    ["regress y i.t x1 x3", "x3"],
    ["regress y x3 x1 i.t", "x1"],
    // Without factor variables the one with less variation left goes.
    ["regress y x1 x3 x2", "x1"],
  ])
    assert.match(
      printed(s, command).text,
      new RegExp(`^note: ${omitted} omitted because of collinearity\\.`),
      command,
    );
});

test("an untyped weight is named as Stata names it", () => {
  const s = run(`clear
set seed 7
set obs 50
generate double x = invnormal(runiform())
generate double y = 1 + 2*x + invnormal(runiform())
generate xx = 1 + mod(_n, 7)
generate yb = y > 1`);
  assert.deepEqual(
    printed(s, "regress y x [weight=xx]").text.split("\n").slice(0, 2),
    ["(analytic weights assumed)", "(sum of wgt is 198)"],
  );
  assert.equal(
    printed(s, "areg y x [w=xx], absorb(yb)").text.split("\n")[0],
    "(analytic weights assumed)",
  );
  assert.equal(
    printed(s, "mean y [w=xx]").text.split("\n")[0],
    "(frequency weights assumed)",
  );
  // A weight Stata takes but the browser does not yet is refused as such.
  const qreg = printed(s, "qreg y x [w=xx]");
  assert.equal(qreg.rc, 198);
  assert.match(qreg.text, /^fweights are not available with qreg/);
});

test("logit and probit step as Stata does, so the iteration log matches", () => {
  const s = run(`clear
set seed 777
set obs 10000
generate double x = invnormal(runiform())
generate double z = invnormal(runiform())
generate double y = 5 + 2*x + 2*invnormal(runiform())
generate y01 = y > 5`);
  const log = (command) =>
    printed(s, command)
      .text.split("\n")
      .filter((line) => line.startsWith("Iteration"));
  assert.deepEqual(log("logit y01 x"), [
    "Iteration 0:  Log likelihood = -6930.9718",
    "Iteration 1:  Log likelihood = -4971.1802",
    "Iteration 2:  Log likelihood = -4960.0933",
    "Iteration 3:  Log likelihood = -4960.0695",
    "Iteration 4:  Log likelihood = -4960.0695",
  ]);
  assert.deepEqual(log("probit y01 x"), [
    "Iteration 0:  Log likelihood = -6930.9718",
    "Iteration 1:  Log likelihood = -4961.4236",
    "Iteration 2:  Log likelihood = -4959.7917",
    "Iteration 3:  Log likelihood = -4959.7912",
  ]);
});

test("poisson's exposure() and offset() are refused as not yet here", () => {
  const s = run(`clear
set seed 4
set obs 50
generate x1 = runiform()
generate expo = 1 + 4*runiform()
generate yc = floor(expo*runiform()*2)`);
  for (const command of [
    "poisson yc x1, exposure(expo)",
    "poisson yc x1, offset(expo)",
    "logit yc x1, offset(expo)",
  ]) {
    const { rc, text } = printed(s, command);
    assert.equal(rc, 198, command);
    assert.match(text, /is not available in the browser yet/, command);
  }
});

test("poisson and nbreg refuse an outcome that is zero everywhere first", () => {
  const s = run(`clear
set seed 7
set obs 30
generate age = 20 + floor(40*runiform())
generate yc = floor(3*runiform())
generate w = 3`);
  for (const [command, code] of [
    ["poisson yc age if yc == 0", 498],
    ["poisson yc if yc == 0", 498],
    ["poisson yc age if yc == 0 [pweight=w]", 498],
    ["nbreg yc age if yc == 0", 498],
    // Observation 1 is 1: one observation is too few.
    ["poisson yc age in 1", 2001],
    ["nbreg yc age in 1", 2001],
  ]) {
    const { rc, text } = printed(s, command);
    assert.equal(rc, code, command);
    if (code === 498) assert.match(text, /^yc is zero for all observations/);
  }
});

// ----- Second round: what a tester found in the fixes above -----

const LAYOUT = `clear
set seed 909
set obs 200
generate x = runiform()
generate z = runiform()
replace x = . if runiform() < .15
generate g = 1 + floor(3*runiform())
generate y = 1 + 2*x - z + .3*g + runiform()
generate yb = (y + runiform()) > 2.2 if !missing(y)
generate u = runiform()`;

test("postestimation after sort reads each observation where the fit found it", () => {
  const s = run(`${LAYOUT}
quietly regress y x z i.g
sort u`);
  assert.match(
    printed(s, "margins g").text,
    /1 {2}\| {3}2\.285396 {3}\.0373933/,
  );
  assert.match(printed(s, "estat hettest").text, /Prob > chi2 = 0\.9488/);
  assert.match(printed(s, "estat ovtest").text, /F\(3, 170\) = {3}1\.26/);
  s.run("quietly logit yb x z");
  s.run("sort g");
  assert.match(
    printed(s, "margins, dydx(x)").text,
    /x \| {3}\.5150035 {3}\.0828165/,
  );
  assert.match(
    printed(s, "estat classification").text,
    /Correctly classified {24}91\.01%/,
  );
  // The sort the user made stays.
  assert.deepEqual(s.data.sortedBy, ["g"]);
  // An observation dropped since the fit leaves the sample, as e(sample)
  // leaves it in Stata.
  const t = run(`clear
set seed 919
set obs 200
generate id = 1 + floor(40*runiform())
generate t = _n
generate x = runiform()
generate z = runiform()
replace x = . if runiform() < .15
generate g = 1 + floor(3*runiform())
generate y = 1 + 2*x - z + .3*g + runiform()
quietly regress y x z i.g
drop if g == 3 & x > .8`);
  const margins = printed(t, "margins g").text;
  assert.match(margins, /Number of obs = 156/);
  assert.match(margins, /1 {2}\| {4}2\.24052 {3}\.0377616/);
});

test("panel and influence statistics after gsort match the fit's sample", () => {
  const s = run(`clear
set seed 909
set obs 200
generate id = ceil(_n/5)
generate t = mod(_n-1,5)+1
generate x = runiform()
generate z = runiform()
replace x = . if runiform() < .15
generate g = 1 + floor(3*runiform())
generate y = 1 + 2*x - z + .3*g + runiform()
generate u = runiform()
xtset id t
quietly xtreg y x z, fe
gsort -u
predict u1, u
quietly areg y x z, absorb(g)
sort u
predict ar1, residuals
quietly regress y x z
gsort -u
predict df1, dfits
predict cv1, covratio`);
  for (const [name, n, mean, sd] of [
    ["u1", 178, 0, 0.1751727],
    ["ar1", 178, 0, 0.290468],
    ["df1", 178, -0.0003502, 0.1348943],
    ["cv1", 178, 1.017304, 0.020605],
  ]) {
    assert.equal(s.run(`quietly summarize ${name}`).rc, 0);
    assert.equal(s.results.r.N, n, name);
    close(s.results.r.mean, mean, 1e-6);
    close(s.results.r.sd, sd, 1e-6);
  }
  assert.match(printed(s, "estat vif").text, /x \| {6}1\.00 {4}0\.999976/);
});

test("logit's Pearson residuals follow the observations once they are sorted or dropped", () => {
  const s = run(`clear
set seed 808
set obs 90
generate x = runiform()
generate z = runiform()
replace x = . if runiform() < .2
generate y = 1 + 2*x - z + runiform()
generate yb = y > 1.7 if !missing(y)
generate u = runiform()
quietly logit yb x z
gsort -u
predict r2, residuals
summarize r2`);
  assert.equal(s.results.r.N, 69);
  close(s.results.r.mean, 0.0789968, 1e-6);
  close(s.results.r.sd, 0.9119284, 1e-6);
  s.run("drop in 1/5");
  s.run("predict r3, residuals");
  s.run("summarize r3");
  assert.equal(s.results.r.N, 64);
  close(s.results.r.mean, 0.0728884, 1e-6);
});

test("poisson on one observation is too few, even when its outcome is zero", () => {
  const s = run(`clear
set seed 7
set obs 30
generate x = runiform()
generate yc = floor(3*runiform())
generate w = 3
generate g = ceil(_n/10)
replace yc = 0 in 1
replace yc = 0 in 30
replace g = 4 in 30`);
  for (const [command, code] of [
    ["poisson yc x in 1", 2001],
    ["poisson yc in 1", 2001],
    ["poisson yc x if yc == 0 & g == 4", 2001],
    // Three by frequency weight are enough to see the zeros.
    ["poisson yc x in 1 [fw=w]", 498],
  ])
    assert.equal(s.run(command).rc, code, command);
  s.run("sort g");
  const r = s.run("capture noisily by g: poisson yc x, nolog");
  assert.equal(r.rc, 0);
  assert.equal(s.rc, 0);
  assert.match(
    r.output.flatMap((o) => o.lines).join("\n"),
    /-> g = 4\n+insufficient observations/,
  );
});

test("a storage type before stub* or a range types every variable predict makes", () => {
  const s = run(`clear
set seed 4242
set obs 500
generate x1 = invnormal(runiform())
generate female = runiform() < .5
generate u = runiform() + .15*x1 + .1*female
generate educ = 1 + (u > .3) + (u > .6) + (u > .85)
quietly mlogit educ x1 female, baseoutcome(1)
predict byte j1-j4
predict double q*
predict double r1 r2 r3 r4
quietly ologit educ x1 female
predict int k*`);
  for (const name of ["j1", "j2", "j4"])
    assert.equal(s.data.get(name).type, "byte", name);
  assert.deepEqual([...new Set(s.data.get("j2").data)], [0]);
  assert.equal(s.data.get("q3").type, "double");
  // A list types only its first variable, as in Stata.
  assert.equal(s.data.get("r1").type, "double");
  assert.equal(s.data.get("r2").type, "float");
  assert.equal(s.data.get("k2").type, "int");
  assert.equal(s.run("predict str5 sp*").rc, 109);
});

test("regress with importance weights counts their sum, as Stata's regress does", () => {
  const s = run(`clear
set seed 3
set obs 120
generate x = runiform()
generate z = runiform()
generate w = 1 + floor(3*runiform())
generate y = 1 + x + runiform()`);
  const text = printed(s, "regress y x [iw=w]").text;
  assert.doesNotMatch(text, /sum of wgt/);
  assert.equal(s.results.e.N, 238);
  assert.equal(s.results.e.df_r, 236);
  close(s.results.e.F, 406.65, 1e-5);
  close(s.results.e.rmse, 0.27008, 1e-4);
  assert.match(text, /x \| {3}1\.242665 {3}\.0616234 {4}20\.17/);
  // A robust variance takes them as the observations' weights.
  assert.match(
    printed(s, "regress y x [iw=w], vce(robust)").text,
    /\(sum of wgt is 238\)/,
  );
  assert.equal(s.results.e.N, 120);
});

test("result matrices take subscripts in matrix expressions and putexcel", () => {
  const s = run(`clear
set seed 31
set obs 150
generate x = runiform()
generate z = runiform()
generate y = 1 + 2*x - z + runiform()
generate g = 1 + floor(3*runiform())
quietly regress y x z
matrix A = e(b)[1,1..2]
matrix B = e(V)[1..2,"x"]
matrix C = e(V)["x".."z","x".."z"]`);
  const A = s.matrices.get("A");
  assert.deepEqual(A.colNames, ["x", "z"]);
  close(A.values[0][0], 1.9507061, 1e-7);
  close(A.values[0][1], -1.1370648, 1e-7);
  close(s.matrices.get("B").values[1][0], 0.00056765, 1e-5);
  assert.deepEqual(s.matrices.get("C").rowNames, ["x", "z"]);
  for (const [expression, value] of [
    ['colnumb(e(b),"z")', "2"],
    ['rownumb(e(V),"_cons")', "3"],
    ['el(e(b),1,colnumb(e(b),"z"))', "-1.1370648"],
    ["issymmetric(e(V))", "1"],
    ["matmissing(e(b))", "0"],
    ['colnumb(e(b),"nosuch")', "."],
  ])
    assert.equal(printed(s, `display ${expression}`).text, value, expression);
  assert.equal(s.run("display colnumb(e(b),1)").rc, 109);
  assert.equal(
    printed(s, "display (e(b))[1,1]").text.split("\n")[0],
    "unknown function ()",
  );
  s.run("matrix bb = e(b)");
  assert.equal(
    printed(s, 'display colnumb(bb,"z") " " matmissing(bb) " " issymmetric(bb)')
      .text,
    "2 0 0",
  );
  // A factor's base level is found without its marker.
  s.run("quietly regress y x i.g");
  assert.equal(printed(s, 'display e(b)[1,"1.g"]').text, "0");
  s.run("quietly regress y x z");
  for (const command of [
    "putexcel set pass8b.xlsx, replace",
    "putexcel A1 = matrix(e(b)[1,1..2])",
    "putexcel close",
    "import excel using pass8b.xlsx, clear",
  ])
    assert.equal(s.run(command).rc, 0, command);
  close(s.data.get("A").data[0], 1.9507061, 1e-7);
  close(s.data.get("B").data[0], -1.1370648, 1e-7);
});

test("putexcel names a multi-equation matrix in an equation row and a name row", () => {
  const s = run(`clear
set seed 12345
set obs 200
generate age = 20 + floor(40*runiform())
generate female = runiform() < .5
generate educ = 1 + floor(3*runiform())
quietly mlogit educ age female, baseoutcome(1)
putexcel set pass8c.xlsx, replace
putexcel A1 = matrix(e(b)), names
putexcel A20 = matrix(e(V)), rownames
import excel using pass8c.xlsx, clear`);
  const cell = (column, row) => s.data.get(column).data[row - 1];
  assert.equal(cell("B", 1), "1");
  assert.equal(cell("B", 2), "o.age");
  assert.equal(cell("E", 1), "2");
  assert.equal(cell("E", 2), "age");
  assert.equal(cell("A", 3), "y1");
  assert.equal(cell("A", 20), "1");
  assert.equal(cell("B", 20), "o.age");
  assert.equal(cell("B", 23), "age");
});

test("estimates store takes title(); restore keeps or clears the sample as Stata does", () => {
  const s = run(`clear
set seed 5
set obs 80
generate x = runiform()
generate z = runiform()
replace x = . if runiform() < .2
replace z = . if runiform() < .3
generate y = 1 + 2*x + runiform()
quietly regress y x
estimates store m1, title(My first model)`);
  const dir = printed(s, "estimates dir").text.split("\n");
  assert.equal(dir[1], "-".repeat(61));
  assert.match(dir[5], /m1 \| regress {11}y {10}2 {2}My first model$/);
  assert.equal(s.run("estimates store m2, nosuch").rc, 198);
  // The active fit keeps its sample when its marker variable is dropped.
  s.run("drop _est_m1");
  s.run("estimates restore m1");
  assert.equal(inSample(s), 65);
  // A dataset read in afresh carries no store's sample.
  const t = run(`clear
set seed 5
set obs 20
generate x = runiform()
generate y = 1 + 2*x + runiform()
replace x = . in 3
quietly regress y x
estimates store m3
save pass8b-est, replace
use pass8b-est, clear
estimates restore m3`);
  assert.equal(inSample(t), 0);
  // Storing again with no sample in the data drops the marker, and the
  // data still count as unchanged.
  t.run("estimates store m3, title(again)");
  assert.equal(t.data.has("_est_m3"), false);
  assert.doesNotMatch(printed(t, "describe, short").text, /has changed/);
});

test("logit and probit take iterate(), the tolerances, difficult and nocoef", () => {
  const s = run(`clear
set seed 777
set obs 3000
generate x = invnormal(runiform())
generate z = invnormal(runiform())
generate g = 1 + floor(4*runiform())
generate y = 5 + 2*x - z + .5*g + 2*invnormal(runiform())
generate y01 = y > 6`);
  const one = printed(s, "probit y01 x z, iterate(1)");
  assert.equal(one.rc, 0);
  assert.match(
    one.text,
    /Iteration 1: {2}Log likelihood = -1436\.1889\nconvergence not achieved/,
  );
  assert.match(one.text, /x \| {4}\.876703 {3}\.0339223/);
  assert.match(one.text, /Warning: Convergence not achieved\./);
  assert.equal(s.results.e.converged, 0);
  assert.equal(s.results.e.ic, 1);
  s.run("logit y01 x z, ltolerance(1e-3)");
  assert.equal(s.results.e.ic, 3);
  s.run("logit y01 x z, nrtolerance(1e-2)");
  assert.equal(s.results.e.ic, 4);
  const quiet = printed(s, "logit y01 x z, nocoef nolog");
  assert.equal(quiet.rc, 0);
  assert.doesNotMatch(quiet.text, /Logistic regression/);
  assert.equal(s.results.e.N, 3000);
  assert.equal(s.run("probit y01 x z, difficult nolog").rc, 0);
  // Observations past what the link tells from certainty are noted.
  const t = run(`clear
set seed 777
set obs 3000
generate x = invnormal(runiform())
generate z = invnormal(runiform())
generate g = 1 + floor(4*runiform())
generate w = 1 + floor(3*runiform())
generate y = 5 + 2*x - z + .5*g + 2*invnormal(runiform())
generate y01 = y > 6
generate rare = y > 11
generate d = x > 1.5
replace y01 = 1 if d`);
  assert.match(
    printed(t, "probit y01 x z in 1/40").text,
    /Note: 2 failures and 0 successes completely determined\./,
  );
  assert.match(
    printed(t, "probit y01 x in 1/25").text,
    /Note: 1 failure and 0 successes completely determined\./,
  );
  assert.doesNotMatch(
    printed(t, "logit y01 x z in 1/40").text,
    /completely determined/,
  );
});

test("logit's covariate-pattern statistics are Stata's", () => {
  const s = run(`clear
set seed 808
set obs 90
generate x = runiform()
generate z = runiform()
generate g = 1 + floor(3*runiform())
replace x = . if runiform() < .2
generate y = 1 + 2*x - z + runiform()
generate yb = y > 1.7 if !missing(y)
generate xr = round(x, .25)
quietly logit yb xr i.g`);
  for (const [statistic, mean, sd] of [
    ["residuals", 0.005599, 0.3336415],
    ["deviance", 0.0068151, 0.3780297],
    ["hat", 0.3194358, 0.2430463],
    ["rstandard", -0.0023231, 0.470805],
    ["dx2", 0.2186264, 0.2245457],
    ["ddeviance", 0.2489485, 0.2012398],
    ["dbeta", 0.2707984, 0.4079784],
    ["number", 7.616438, 4.101592],
  ]) {
    assert.equal(s.run(`predict double v_${statistic}, ${statistic}`).rc, 0);
    s.run(`summarize v_${statistic}`);
    assert.equal(s.results.r.N, 73, statistic);
    close(s.results.r.mean, mean, 2e-5);
    close(s.results.r.sd, sd, 2e-5);
  }
  s.run("quietly probit yb xr i.g");
  s.run("predict double d1, deviance");
  s.run("summarize d1");
  close(s.results.r.mean, -0.005902, 2e-5);
  // probit has no Pearson residual, as in Stata.
  assert.equal(s.run("predict double d2, residuals").rc, 198);
});

test("xtreg and heckman report too few observations as Stata does", () => {
  const s = run(`clear
set seed 7
set obs 12
generate x = runiform()
generate z = runiform()
generate y = 1 + x + runiform()
generate yb = runiform() < .5
generate g = ceil(_n/4)
replace g = 4 in 12
xtset g`);
  for (const [command, code] of [
    ["xtreg y x in 1, fe", 2001],
    ["xtreg y x in 1, re", 2001],
    ["xtreg y x in 1, be", 2001],
    ["xtreg y x if x > 5, fe", 2001],
    ["xtreg y x if x > 5, re", 2000],
    ["xtreg y x in 1/2, re", 2001],
    ["xtreg y x in 1/2, fe", 0],
    ["heckman y x in 1, select(yb = z)", 2001],
    ["heckman y x in 1/2, select(yb = z)", 2001],
    ["heckman y x in 1, select(z)", 2001],
    ["heckman y x if x > 5, select(yb = z)", 2000],
  ])
    assert.equal(s.run(command).rc, code, command);
});

test("weights: ologit and oprobit take aweights; notes of assumed weights", () => {
  const s = run(`clear
set seed 3
set obs 120
generate x = runiform()
generate z = runiform()
generate w = 1 + floor(3*runiform())
generate y = 1 + x + runiform()
generate yb = runiform() < .4 + .3*x
generate yc = floor(3*runiform()+x)
generate g = 1 + floor(3*runiform())
generate id = ceil(_n/6)
generate t = mod(_n-1,6)+1
xtset id t`);
  const o = printed(s, "oprobit yc x [aw=w]");
  assert.equal(o.rc, 0);
  // The sum of the weights, then the log at once.
  assert.match(o.text, /^\n\(sum of wgt is 238\)\nIteration 0:/);
  assert.match(o.text, /\/cut1 \| {3}-\.285712 {3}\.2061896/);
  assert.equal(s.results.e.N, 120);
  assert.equal(s.run("ologit yc x [aw=w]").rc, 0);
  assert.match(
    printed(s, "correlate y x [w=w]").text,
    /^\(analytic weights assumed\)\n\(sum of wgt is 238\)/,
  );
  assert.match(
    printed(s, "capture noisily xtreg y x [w=w], fe").text,
    /^\(analytic weights assumed\)\nweight must be constant within id/,
  );
  // quietly keeps the note to itself; the error still shows.
  assert.equal(
    printed(s, "capture noisily quietly xtreg y x [w=w], fe").text,
    "weight must be constant within id",
  );
  // poisson's e() is exposure(), which is not here yet; a variable that
  // does not exist is reported first.
  assert.match(
    printed(s, "poisson yc x, e(w)").text,
    /^option exposure is not available in the browser yet/,
  );
  assert.equal(
    printed(s, "poisson yc x, exposure(nosuch)")
      .text.split("\n")
      .slice(0, 2)
      .join("\n"),
    "variable nosuch not found\n(error in option exposure())",
  );
});

test("estimates table: column widths, stfmt(), nobase and bad formats", () => {
  const s = run(`clear
set seed 4242
set obs 300
generate x1 = runiform()
generate x2 = runiform()
generate y = 1 + 1.4*x1 - .6*x2 + runiform()
quietly regress y x1
estimates store a
quietly regress y x1 x2
estimates store b`);
  const lines = printed(s, "estimates table a b, b(%5.2f)").text.split("\n");
  assert.equal(lines[1], "-".repeat(34));
  assert.equal(lines[4].trimEnd(), "          x1 |    1.51      1.44");
  const bad = printed(s, "estimates table a, b(%5.2)");
  assert.equal(bad.rc, 120);
  assert.equal(bad.text.split("\n")[0], "invalid display format %5.2");
  assert.equal(s.run("estimates table a b, b se stfmt(%9.2f)").rc, 0);
  assert.equal(s.run("estimates table a b, b se nobase").rc, 0);
});

test("an estimator typed alone shows its fit without the display options it was shown with", () => {
  const s = run(`clear
set seed 4711
set obs 300
generate x1 = runiform()
generate x2 = runiform()
generate y = 2 + .7*x1 - .2*x2 + runiform()
quietly regress y x1 x2, beta`);
  const replay = printed(s, "regress").text;
  assert.match(replay, /\[95% conf\. interval\]/);
  assert.doesNotMatch(replay, /Beta/);
  assert.match(
    printed(s, "regress, level(90)").text,
    /\[90% conf\. interval\]/,
  );
});
