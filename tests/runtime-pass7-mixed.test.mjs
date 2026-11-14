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
  for (const command of ["estat vce", "estat wcorrelation"])
    assert.equal(s.run(command).rc, 198, command);
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
