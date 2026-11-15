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
