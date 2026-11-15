// mixed: linear multilevel models with random intercepts and slopes. The
// printed tables are compared line by line in tests/runtime-output.test.mjs
// (the mixed-* cases); this file checks what text cannot: e() and r()
// results at full precision, the predictions, the refusals and the time a
// large fit takes. Every expected value was recorded from Stata 19 MP
// (version 17, set processors 1) on the same generated data.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { StataError } from "../src/runtime/errors.js";
import { missingValue } from "../src/runtime/values.js";

const DATA = `clear
set seed 4202
set obs 600
generate school = ceil(_n/20)
generate class = ceil(_n/5)
generate x = runiform()*4
generate double e0 = invnormal(runiform())
generate double e1 = invnormal(runiform())
generate double e2 = invnormal(runiform())
generate double e3 = invnormal(runiform())
bysort school: generate double s = 1.2*e0[1]
bysort school: generate double sx = 0.5*e3[1]
bysort class: generate double c = 0.8*e1[1]
generate double y = 1 + 0.6*x + s + sx*x + c + e2`;

function session() {
  const s = new Session();
  assert.equal(s.run(DATA).rc, 0);
  return s;
}
const run = (s, command) => {
  const result = s.run(`quietly ${command}`);
  assert.equal(result.rc, 0, command);
  return s.results;
};
// Stata stops its Newton steps at a tolerance, so the variance parameters
// agree to about six digits; the fixed effects follow them.
const close = (ours, theirs, what, tolerance = 1e-5) =>
  assert.ok(
    Math.abs(ours - theirs) <= tolerance * Math.max(1, Math.abs(theirs)),
    `${what}: ${ours} vs Stata ${theirs}`,
  );
const matrix = (s, text) => {
  const result = s.run(`matrix M = ${text}`);
  assert.equal(result.rc, 0, text);
  return s.matrices.get("M");
};

test("mixed with an unstructured slope and a nested level: e() as Stata leaves it", () => {
  const s = session(),
    { e } = run(s, "mixed y x || school: x, cov(un) || class:");
  for (const [name, value] of Object.entries({
    N: 600,
    k: 7,
    k_f: 2,
    k_r: 5,
    k_rs: 4,
    k_rc: 1,
    rank: 7,
    df_c: 4,
    df_m: 1,
    converged: 1,
  }))
    assert.equal(e[name], value, name);
  close(e.ll, -974.575160585033, "e(ll)", 1e-9);
  close(e.ll_c, -1283.05074055465, "e(ll_c)", 1e-9);
  close(e.chi2_c, 616.951159939239, "e(chi2_c)", 1e-8);
  close(e.chi2, 10.6793243153227, "e(chi2)");
  close(e.p, 0.00108339626627624, "e(p)", 1e-4);
  for (const [name, value] of Object.entries({
    cmd: "mixed",
    depvar: "y",
    method: "ML",
    ivars: "school class",
    redim: "2 1",
    vartypes: "Unstructured Identity",
    revars: "x _cons _cons",
    title: "Mixed-effects ML regression",
    chi2type: "Wald",
    predict: "mixed_p",
  }))
    assert.equal(e[name], value, name);
  assert.deepEqual(e["matrix:N_g"].values, [[30, 120]]);
  assert.deepEqual(e["matrix:g_min"].values, [[20, 5]]);
  assert.deepEqual(e["matrix:N_g"].colNames, ["c1", "c2"]);
  const b = matrix(s, "e(b)");
  assert.deepEqual(b.colNames, [
    "y:x",
    "y:_cons",
    "lns1_1_1:_cons",
    "lns1_1_2:_cons",
    "atr1_1_1_2:_cons",
    "lns2_1_1:_cons",
    "lnsig_e:_cons",
  ]);
  [
    0.315098551421282, 1.67415813881745, -0.722995873632, -0.00966258803886273,
    0.191695236822454, -0.256397875977726, -0.0329142163875392,
  ].forEach((value, k) => close(b.values[0][k], value, b.colNames[k]));
  // The two blocks of e(V) are independent, as in Stata.
  const V = matrix(s, "e(V)");
  assert.equal(V.values[0][2], 0);
  assert.equal(V.values[6][1], 0);
});

test("estat icc, estat recovariance and the predicted effects after a nested model", () => {
  const s = session();
  run(s, "mixed y x || school: x, cov(un) || class:");
  const { r } = run(s, "estat icc");
  close(r.icc3, 0.389853612967101, "r(icc3)");
  close(r.se3, 0.0878504427107089, "r(se3)", 1e-4);
  close(r.icc2, 0.627860769198265, "r(icc2)");
  close(r.se2, 0.0557907002388399, "r(se2)", 1e-4);
  assert.equal(r.level, 95);
  assert.equal(r.label3, "school");
  assert.equal(r.label2, "class|school");
  assert.deepEqual(r["matrix:ci3"].rowNames, ["icc"]);
  assert.deepEqual(r["matrix:ci3"].colNames, ["ll", "ul"]);
  close(r["matrix:ci3"].values[0][0], 0.236531461296369, "ci3 ll", 1e-4);
  close(r["matrix:ci3"].values[0][1], 0.568549479605874, "ci3 ul", 1e-4);
  const cov = run(s, "estat recovariance").r;
  assert.equal(cov.relevels, 3);
  assert.equal(cov["matrix:Cov2"].values.length, 2);
  assert.equal(cov["matrix:Cov3"].values.length, 1);
  assert.equal(
    s.run("predict double u1 u0 v0, reffects reses(t1 t0 w0)").rc,
    0,
  );
  const at = (name, i) => s.data.get(name).data[i];
  for (const [name, first, last] of [
    ["u1", -0.592070431715292, -0.145445426424882],
    ["u0", 1.20076131820679, -1.53916668891907],
    ["v0", 1.63199126720428, 0.617264211177826],
    ["t1", 0.177107305006253, 0.184422562285033],
    ["t0", 0.464082062244415, 0.520676255226135],
    ["w0", 0.492139965295792, 0.486957281827927],
  ]) {
    close(at(name, 0), first, `${name}[1]`);
    close(at(name, 599), last, `${name}[600]`);
  }
  assert.equal(s.data.get("t1").type, "double");
  assert.equal(
    s.data.get("w0").label,
    "BLUP r.e. std. errors for class: _cons",
  );
});

test("mixed, reml: the restricted likelihood, its LR test and r(table)", () => {
  const s = session(),
    { e, r } = run(s, "mixed y x || school:, reml");
  close(e.ll, -1074.5921154192, "e(ll)", 1e-9);
  close(e.ll_c, -1286.29711415975, "e(ll_c)", 1e-9);
  close(e.chi2_c, 423.409997481098, "e(chi2_c)", 1e-8);
  close(e.p_c, 2.20900677284513e-94, "e(p_c)", 1e-6);
  assert.equal(e.df_c, 1);
  assert.equal(e.method, "REML");
  const table = r["matrix:table"];
  assert.deepEqual(table.colNames, [
    "y:x",
    "y:_cons",
    "school:var(_cons)",
    "Residual:var(e)",
  ]);
  [0.3237844, 1.6789616, 2.5389924, 1.7679424].forEach((v, k) =>
    close(table.values[0][k], v, `b ${k}`),
  );
  [0.048521, 0.31033602, 0.69000626, 0.10481565].forEach((v, k) =>
    close(table.values[1][k], v, `se ${k}`, 1e-4),
  );
  // The variance parameters carry no test.
  assert.equal(table.values[2][2], missingValue("b"));
  assert.equal(table.values[3][3], missingValue("b"));
});

test("test and lincom reach the fixed effects of mixed", () => {
  const s = session();
  run(s, "mixed y x || school:");
  const { r } = run(s, "test x");
  assert.equal(r.df, 1);
  assert.ok(r.chi2 > 0);
  assert.equal(s.run("quietly lincom x + _cons").rc, 0);
});

test("what mixed refuses, with r(198) and what is available instead", () => {
  const s = session();
  for (const command of [
    "mixed y x || school:, vce(robust)",
    "mixed y x [pw=x] || school:",
    "mixed y x || _all: R.class",
    "mixed y x || school: i.class",
    "mixed y x || school: x, cov(pattern(P))",
    "mixed y x || school: x || school:",
    "mixed y x || school:, dfmethod(kroger)",
    "mixed y x || school:, residuals(ar 1, t(class))",
    "mixed y x || school:, emonly",
    "melogit y x || school:",
    "mepoisson y x || school:",
  ]) {
    const result = s.run(command);
    assert.equal(result.rc, 198, command);
  }
  run(s, "mixed y x || school:");
  assert.equal(s.run("estat wcorrelation").rc, 198);
  // Time-series operators in the fixed part are not yet here: refused with
  // r(198), not with Stata's r(101) for a genuine prohibition.
  assert.equal(s.run("mixed y L.x || school:").rc, 198);
});

test("Stata's own errors after mixed", () => {
  const s = session();
  assert.equal(s.run("mixed").rc, 301);
  for (const [command, rc] of [
    ["mixed y x || school", 198],
    ["mixed y x || school:, cov(foo)", 198],
    ["mixed y x || school:, mle reml", 198],
    ["mixed y x || nosuch:", 111],
  ])
    assert.equal(s.run(command).rc, rc, command);
  run(s, "mixed y x || school: || class:");
  assert.equal(s.run("predict pa, reffects").rc, 102);
  assert.equal(s.run("predict pa pb pc, reffects").rc, 103);
  assert.equal(s.run("predict pa, fitted relevel(x)").rc, 198);
  assert.equal(s.run("predict pa, xb relevel(school)").rc, 198);
  // Typed alone, mixed shows the last fit again.
  assert.equal(s.run("mixed, stddev").rc, 0);
  // After any other model, predict and estat are that model's.
  run(s, "regress y x");
  assert.equal(s.run("predict r, residuals").rc, 0);
});

test("mixed stops with a Stata error, never a crash, on awkward input", () => {
  const s = session();
  for (const command of [
    "mixed y x if x > 100 || school:",
    "mixed y x || school: x, noconstant cov(un)",
    "mixed y || school: || class:, reml",
    "mixed y x x || school:",
    "mixed y x || school:, noconstant",
    "mixed y x in 1/3 || school:",
  ])
    try {
      s.run(command);
    } catch (error) {
      assert.ok(error instanceof StataError, `${command}: ${error}`);
    }
});

test("a two-level fit of 10,000 observations stays quick", () => {
  const s = new Session();
  s.run(`clear
set seed 4303
set obs 10000
generate id = ceil(_n/20)
generate sub = ceil(_n/4)
generate x = runiform()*3
generate z = runiform()
generate double y = 100 + 3*x - 2*z + 2*invnormal(runiform())`);
  const started = Date.now();
  assert.equal(s.run("quietly mixed y x z || id: x, cov(un) || sub:").rc, 0);
  const took = Date.now() - started;
  assert.ok(took < 2000, `took ${took} ms`);
});

test("lrtest between mixed models carries Stata's notes and refusals", () => {
  const s = new Session();
  assert.equal(
    s.run(`clear
set seed 4101
set obs 600
generate id = ceil(_n/10)
generate x = runiform()*5
generate w = runiform() > .5
generate double e0 = invnormal(runiform())
generate double e1 = invnormal(runiform())
generate double e2 = invnormal(runiform())
bysort id: generate double u0 = 1.5*e0[1]
bysort id: generate double u1 = 0.4*e1[1]
generate double y = 2 + 0.7*x - 0.5*w + u0 + u1*x + e2
drop in 37/39
quietly mixed y x w || id:, reml
estimates store a
quietly mixed y x || id:, reml
estimates store b
quietly mixed y x || id: x, reml
estimates store c
quietly regress y x
estimates store d`).rc,
    0,
  );
  // lrtest.ado makes its mixed checks, and gives its notes, only when the
  // current estimates are mixed's.
  assert.equal(s.run("lrtest a b").rc, 0);
  assert.equal(s.run("estimates restore c").rc, 0);
  const failed = s.run("lrtest a b");
  assert.equal(failed.rc, 498);
  assert.match(
    failed.output.at(-1).lines.join("\n"),
    /REML criterion is not comparable under different fixed-effects specifications/,
  );
  assert.equal(s.run("lrtest b d").rc, 498);
  const result = s.run("lrtest b c");
  assert.equal(result.rc, 0);
  // As Stata 19 printed it.
  assert.deepEqual(
    result.output
      .at(-1)
      .lines.flatMap((line) => line.split("\n"))
      .filter(Boolean),
    [
      "Likelihood-ratio test",
      "Assumption: b nested within c",
      " LR chi2(1) =  65.60",
      "Prob > chi2 = 0.0000",
      "Note: The reported degrees of freedom assumes the null hypothesis is not on",
      "      the boundary of the parameter space. If this is not true, then the",
      "      reported test is conservative.",
      "Note: LR tests based on REML are valid only when the fixed-effects",
      "      specification is identical for both models.",
    ],
  );
});

// The seventh red-team round. Every expected value below was recorded
// from Stata 19 MP (version 17, set processors 1) on the same generated
// data; where the likelihood is flat (a covariance matrix nearly
// singular, a variance near zero) Stata stops its Newton steps short of
// the maximum, and the tolerances say how far.
const fit = (source, command) => {
  const s = new Session();
  assert.equal(s.run(source).rc, 0);
  const result = s.run(command);
  assert.equal(result.rc, 0, command);
  return {
    s,
    result,
    lines: result.output.at(-1).lines.flatMap((l) => l.split("\n")),
  };
};
const UNSTRUCTURED = `clear
set seed 202
set obs 300
generate id = ceil(_n/15)
generate x = runiform()*2
generate z = runiform()
generate double e0 = invnormal(runiform())
by id, sort: generate double u0 = e0[1]
generate double y = 1 + x - z + u0 + invnormal(runiform())`;

test("three random effects, unstructured: Newton reaches Stata's maximum", () => {
  const { s, lines } = fit(UNSTRUCTURED, "mixed y x z || id: x z, cov(un)");
  const e = s.results.e;
  assert.equal(e.converged, 1);
  close(e.ll, -457.095167286793, "e(ll)", 2e-8);
  assert.ok(!lines.some((l) => /Convergence not achieved/.test(l)));
  const b = matrix(s, "e(b)");
  [1.03899796577796, -0.983493753699582, 0.637058261886115].forEach(
    (value, k) => close(b.values[0][k], value, b.colNames[k], 5e-5),
  );
  // G is nearly singular: as in Stata, the variance parameters' block of
  // e(V) is zero and their standard errors are not shown.
  const V = matrix(s, "e(V)");
  for (let i = 3; i < 10; i++)
    for (let j = 3; j < 10; j++) assert.equal(V.values[i][j], 0);
  assert.ok(
    lines.some((l) => /^ +var\(_cons\) \| +1\.45\d+ +\. +\. +\.$/.test(l)),
  );
});

test("four unstructured effects at 10,000 observations converge quickly", () => {
  const s = new Session();
  s.run(`clear
set seed 601
set obs 10000
generate id = ceil(_n/5)
generate x = runiform()
generate z = runiform()
generate w = runiform()
generate double e0 = invnormal(runiform())
generate double e1 = invnormal(runiform())
by id, sort: generate double u0 = e0[1]
by id: generate double u1 = e1[1]
generate double y = 1 + x + z + w + u0 + .5*u1*x + invnormal(runiform())`);
  const started = Date.now(),
    result = s.run("mixed y x z w || id: x z w, cov(un)"),
    took = Date.now() - started;
  assert.equal(result.rc, 0);
  // About 0.9 s alone (Stata 19 MP takes 6.7 s); the bound leaves room
  // for the other test files the suite runs beside it.
  assert.ok(took < 4000, `took ${took} ms`);
  const e = s.results.e;
  assert.equal(e.converged, 1);
  close(e.ll, -15989.8928362535, "e(ll)", 1e-9);
  const b = matrix(s, "e(b)");
  close(b.values[0][0], 0.982186526248622, "x", 1e-6);
  close(b.values[0][14], -0.02358116505826, "lnsig_e", 1e-5);
  // Stata's first iteration starts where its EM steps leave it.
  assert.match(
    result.output.at(-1).lines.join("\n"),
    /Iteration 0: +Log likelihood = -16031\.405/,
  );
});

test("REML with four groups and correlations at one: the standard errors fail as in Stata", () => {
  const { s, lines } = fit(
    `clear
set seed 603
set obs 10000
generate id = ceil(_n/2500)
generate x = runiform()
generate z = runiform()
generate double e0 = invnormal(runiform())
by id, sort: generate double u0 = e0[1]
generate double y = 1 + x + z + u0 + invnormal(runiform())`,
    "mixed y x z || id: x z, cov(un) reml",
  );
  assert.equal(s.results.e.converged, 1);
  assert.equal(s.results.e.ic, 3);
  close(s.results.e.ll, -14287.1320171136, "e(ll)", 1e-10);
  assert.ok(lines.includes("standard-error calculation has failed"));
  assert.equal(
    lines.filter(Boolean).at(-1),
    "Warning: Standard-error calculation failed.",
  );
  const V = matrix(s, "e(V)");
  assert.equal(V.values[3][3], 0);
  assert.equal(V.values[9][9], 0);
});

test("a variance at zero leaves the other standard errors, as in Stata", () => {
  const { s } = fit(
    `clear
set seed 901
set obs 300
generate id = ceil(_n/15)
generate x = runiform()*2
generate z = runiform()
generate double e0 = invnormal(runiform())
by id, sort: generate double u0 = e0[1]
generate double y = 1 + x + u0 + invnormal(runiform())`,
    "mixed y x || id: x",
  );
  const table = matrix(s, "r(table)"),
    column = (name) =>
      table.values.map((row) => row[table.colNames.indexOf(name)]);
  // Stata: var(x) 1.48e-12, interval 0 to .; var(_cons) .9080329
  // (.307828); var(Residual) .9732881 (.0822604).
  const vx = column("id:var(x)");
  assert.ok(vx[0] < 1e-10);
  assert.equal(vx[4], 0);
  assert.ok(vx[5] > 8e307, "upper limit missing");
  close(column("id:var(_cons)")[1], 0.307828, "se var(_cons)", 2e-4);
  close(column("Residual:var(e)")[1], 0.0822604, "se var(e)", 2e-4);
  const V = matrix(s, "e(V)");
  assert.ok(V.values[2][2] > 0 && Number.isFinite(V.values[2][2]));
  close(V.values[4][4], 0.00178582496943, "V lnsig_e", 1e-4);
});

test("the LR test against the linear model: p = 1 at zero, %8.2e when small", () => {
  const a = fit(
    `clear
set seed 102
set obs 200
generate id = ceil(_n/10)
generate x = runiform()
generate double y = 2 + x + invnormal(runiform())`,
    "mixed y x || id:",
  );
  assert.equal(a.s.results.e.chi2_c, 0);
  assert.equal(a.s.results.e.p_c, 1);
  assert.ok(
    a.lines.includes(
      "LR test vs. linear model: chibar2(01) = 0.00          Prob >= chibar2 = 1.0000",
    ),
  );
  const b = fit(
    `clear
set seed 703
set obs 120
generate id = ceil(_n/12)
generate x = runiform()
generate double y = x + invnormal(runiform())`,
    "mixed y x || id:, reml",
  );
  // Stata: e(chi2_c) .000240898851984639 and the line below.
  close(b.s.results.e.chi2_c, 0.000240898851984639, "e(chi2_c)", 1e-5);
  assert.ok(
    b.lines.includes(
      "LR test vs. linear model: chibar2(01) = 2.4e-04       Prob >= chibar2 = 0.4938",
    ),
  );
});

test("e() after mixed: Stata's order, e(ic), and no LR test under vce()", () => {
  const s = new Session();
  s.run(`clear
set seed 203
set obs 300
generate id = ceil(_n/15)
generate x = runiform()*2
generate double e0 = invnormal(runiform())
by id, sort: generate double u0 = e0[1]
generate double y = 1 + x + u0 + invnormal(runiform())`);
  run(s, "mixed y x || id:");
  // Stata: e(ic) = 1, its EM steps leaving one Newton step to go.
  assert.equal(s.results.e.ic, 1);
  close(s.results.e.ll, -450.7527744742451, "e(ll)", 1e-12);
  assert.deepEqual(Object.keys(s.results.e).slice(0, 4), [
    "rank",
    "k_f",
    "k_r",
    "k",
  ]);
  run(s, "mixed y x || id:, vce(oim) reml");
  const keys = Object.keys(s.results.e),
    at = keys.indexOf("nrgroups");
  assert.equal(s.results.e.chi2_c, undefined);
  assert.deepEqual(keys.slice(at + 1, at + 6), [
    "rc",
    "df_m",
    "chi2",
    "p",
    "small",
  ]);
});

test("xtmixed, by:, and estat sd's results", () => {
  const s = new Session();
  s.run(`clear
set seed 4202
set obs 600
generate school = ceil(_n/20)
generate g = ceil(_n/300)
generate x = runiform()*4
generate double e0 = invnormal(runiform())
generate double e2 = invnormal(runiform())
generate double e3 = invnormal(runiform())
bysort school: generate double s = 1.2*e0[1]
bysort school: generate double sx = 0.5*e3[1]
generate double y = 1 + 0.6*x + s + sx*x + e2`);
  run(s, "xtmixed y x || school:");
  assert.equal(s.results.e.cmd, "xtmixed");
  const by = s.run("by g, sort: mixed y x || school:, nolog");
  assert.equal(by.rc, 0);
  assert.equal(
    by.output.at(-1).lines.filter((l) => /^-> g = /.test(l)).length,
    2,
  );
  run(s, "mixed y x || school: x, cov(un)");
  const { r } = run(s, "estat sd");
  // Stata 19: r(b) sd(x) .41390236, sd(_cons) .89423743, corr .45626382,
  // sd(e) 1.0289209; the correlation tested, z 2.1274562.
  assert.deepEqual(r["matrix:b"].colNames, [
    "y:x",
    "y:_cons",
    "school:sd(x)",
    "school:sd(_cons)",
    "school:corr(x,_cons)",
    "Residual:sd(e)",
  ]);
  [0.41390236, 0.89423743, 0.45626382, 1.0289209].forEach((v, k) =>
    close(r["matrix:b"].values[0][k + 2], v, `r(b) ${k}`, 2e-6),
  );
  close(r["matrix:table"].values[2][4], 2.1274562, "z corr", 2e-6);
  assert.equal(r["matrix:table"].values[2][2], missingValue("b"));
  // r(V) by the delta method: its diagonal gives the standard errors shown.
  r["matrix:V"].values.forEach((row, i) =>
    close(Math.sqrt(row[i]), r["matrix:table"].values[1][i], `se ${i}`, 1e-9),
  );
});
