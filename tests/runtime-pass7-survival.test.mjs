// Survival analysis: stset, stdescribe, stsum, sts list, sts graph, sts
// test, stcox, streg and estat phtest. Their printed output is compared
// line by line with installed Stata in tests/runtime-output.test.mjs (the
// survival-* cases of tools/output-cases.txt); this file checks what text
// cannot: results at full precision, the drawn survivor curves, the
// options refused rather than ignored, and speed on a student-sized
// dataset. The expected values were recorded from Stata 19 MP (version
// 17, set processors 1) on the same generated data.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const DATA = `clear
set seed 2041
set obs 40
generate id = _n
generate grp = runiform() < .5
generate x = round(invnormal(runiform()),.01)
generate t = ceil(-ln(runiform())*10*exp(-.5*x - .4*grp))
generate d = runiform() < .75
quietly stset t, failure(d)`;

function session(extra = "") {
  const s = new Session();
  assert.equal(s.run(`${DATA}\n${extra}`).rc, 0);
  return s;
}
const run = (s, command) => {
  const result = s.run(`quietly ${command}`);
  assert.equal(result.rc, 0, command);
  return s.results;
};
const close = (ours, theirs, what, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(ours - theirs) <= tolerance * Math.max(1, Math.abs(theirs)),
    `${what}: ${ours} vs Stata ${theirs}`,
  );
/** The error a command stops with: its return code and message. */
function stops(s, command) {
  const result = s.run(command);
  return { rc: result.rc, text: result.output.at(-1).lines.join("\n") };
}

test("stset leaves summarize's r() of _t, as Stata's stset does", () => {
  const s = session();
  const { r } = run(s, "stset t, failure(d)");
  assert.deepEqual(
    [r.N, r.sum_w, r.sum, r.mean, r.min, r.max],
    [40, 40, 581, 14.525, 1, 86],
  );
  // The settings are characteristics, as Stata keeps them.
  const chars = s.data.chars.get("_dta");
  assert.equal(chars.get("_dta"), "st");
  assert.equal(chars.get("st_bt"), "t");
  assert.equal(chars.get("st_bd"), "d");
  assert.deepEqual(
    ["_st", "_d", "_t", "_t0"].map((name) => s.data.get(name).type),
    ["byte", "byte", "byte", "byte"],
  );
});

test("stdescribe and stsum post Stata's r()", () => {
  const s = session();
  let { r } = run(s, "stdescribe");
  assert.deepEqual(
    [r.N_sub, r.N_total, r.tr, r.tr_mean, r.tr_med, r.N_fail, r.f_mean],
    [40, 40, 581, 14.525, 6, 29, 0.725],
  );
  assert.equal(r.gap_mean >= 8.98e307, true, "gap_mean is missing");
  ({ r } = run(s, "stsum"));
  assert.deepEqual([r.p25, r.p50, r.p75, r.N_sub, r.risk], [4, 8, 38, 40, 581]);
  close(r.ir, 0.0499139414802065, "ir", 1e-15);
});

test("sts test's statistics match Stata's to rounding", () => {
  const s = session();
  let { r } = run(s, "sts test grp");
  close(r.chi2, 0.9154855515697961, "log-rank chi2", 1e-14);
  assert.equal(r.df, 1);
  ({ r } = run(s, "sts test grp, wilcoxon"));
  close(r.chi2, 3.341735431578972, "Wilcoxon chi2", 1e-14);
  assert.equal(r.by, "grp");
});

test("stcox posts Stata's estimates for each treatment of ties", () => {
  const s = session();
  let { e } = run(s, "stcox x grp");
  close(e.ll, -74.75085750633316, "ll");
  close(e.ll_0, -79.34074265322143, "ll_0");
  close(e.chi2, 9.179770293776528, "chi2", 1e-8);
  close(e.r2_p, 0.0578502922130375, "r2_p", 1e-8);
  assert.deepEqual(
    [e.N, e.N_sub, e.N_fail, e.risk, e.df_m, e.rank, e.converged],
    [40, 40, 29, 581, 2, 2, 1],
  );
  assert.deepEqual([e.cmd, e.cmd2, e.ties], ["cox", "stcox", "breslow"]);
  const model = s.estimates;
  close(model.b[0], 0.65631927, "b[x]", 1e-7);
  close(model.b[1], 0.74910427, "b[grp]", 1e-7);
  close(model.V[0][0], 0.04892153, "V[x,x]", 1e-6);
  close(model.V[1][0], 0.03485425, "V[grp,x]", 1e-6);
  ({ e } = run(s, "stcox x grp, efron"));
  close(e.ll, -73.748915, "Efron ll", 1e-8);
  ({ e } = run(s, "stcox x grp, exactm"));
  close(e.ll, -63.790045, "exact marginal ll", 1e-8);
  assert.equal(e.ties, "marginal");
});

test("estat phtest gives Stata's global test", () => {
  const s = session();
  run(s, "stcox x grp");
  let { r } = run(s, "estat phtest");
  close(r.chi2, 1.637403034056615, "chi2", 1e-7);
  close(r.p, 0.4410039189669926, "p", 1e-7);
  assert.equal(r.df, 2);
  ({ r } = run(s, "estat phtest, detail"));
  const phtest = r["matrix:phtest"];
  assert.deepEqual(phtest.rowNames, ["x", "grp"]);
  assert.deepEqual(phtest.colNames, ["rho", "chi2", "df", "p"]);
  close(phtest.values[0][0], -0.10305, "rho of x", 1e-4);
  close(phtest.values[1][0], -0.23083, "rho of grp", 1e-4);
  // After the exact marginal likelihood there are no Schoenfeld residuals.
  run(s, "stcox x grp, exactm");
  assert.equal(stops(s, "estat phtest").rc, 322);
});

test("streg posts Stata's estimates for each distribution", () => {
  const s = session();
  let { e } = run(s, "streg x grp, dist(exponential)");
  close(e.ll, -52.51566317465694, "exponential ll");
  close(e.ll_0, -59.01549816729114, "exponential ll_0");
  close(e.p, 0.001503687291987, "exponential p", 1e-8);
  ({ e } = run(s, "streg x grp, dist(weibull)"));
  close(e.ll, -52.49112521655697, "Weibull ll");
  close(e.ll_0, -58.20039217205577, "Weibull ll_0");
  close(e.aux_p, 1.030888229115691, "Weibull p", 1e-8);
  const model = s.estimates;
  close(model.b[0], 0.67869447, "b[x]", 1e-7);
  close(model.b[2], -3.0200259, "b[_cons]", 1e-7);
  close(model.auxiliary.b[0], 0.03042079, "ln_p", 1e-6);
  ({ e } = run(s, "streg x grp, dist(weibull) time"));
  assert.equal(e.frm2, "time");
  close(s.estimates.b[2], 2.929538, "AFT _cons", 1e-6);
  ({ e } = run(s, "streg x grp, dist(gompertz)"));
  close(e.ll, -52.51190486050508, "Gompertz ll");
  close(e.gamma, 0.0010048676817935, "gamma", 1e-7);
  // Without distribution(), streg fits the last distribution again.
  ({ e } = run(s, "streg x"));
  assert.equal(e.cmd, "gompertz");
});

test("predict after stcox gives the hazard ratio Stata gives", () => {
  const s = session();
  run(s, "stcox x grp");
  const result = s.run("predict h");
  assert.equal(result.rc, 0);
  assert.deepEqual(result.output.at(-1).lines, [
    "(option hr assumed; predicted hazard ratio)",
  ]);
  run(s, "summarize h");
  close(s.results.r.mean, 1.472885, "mean hazard ratio", 1e-6);
  close(s.results.r.min, 0.3341875, "smallest", 1e-6);
});

test("sts graph draws the Kaplan–Meier steps that sts list shows", () => {
  const s = session();
  const result = s.run("sts graph, by(grp)");
  assert.equal(result.rc, 0);
  const { svg, description } = result.output.at(-1).graph;
  // Two step functions, one per group, from (0, 1).
  const lines = [...svg.matchAll(/<polyline[^>]*points="([^"]+)"/g)];
  assert.equal(lines.length, 2);
  const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(
    (m) => m[1],
  );
  for (const label of ["0.00", "0.25", "0.50", "0.75", "1.00"])
    assert.ok(texts.includes(label), label);
  for (const label of [
    "Kaplan–Meier survival estimates",
    "Analysis time",
    "grp = 0",
    "grp = 1",
  ])
    assert.ok(texts.includes(label), label);
  assert.match(description, /grp = 0 falls to 0\.0000 by time 61/);
  // The curve of grp = 1 steps to .8421 at time 1, as sts list shows.
  const s1 = s.run("sts graph if grp == 1");
  assert.match(
    s1.output.at(-1).graph.description,
    /falls to 0\.0000 by time 86/,
  );
  const failure = s.run("sts graph, failure");
  assert.match(
    failure.output.at(-1).graph.description,
    /Kaplan–Meier failure estimate: rises to 1\.0000 by time 86/,
  );
});

test("options not computed here are refused, never ignored", () => {
  const s = session();
  run(s, "stcox x grp");
  for (const command of [
    "stset t [fweight=id]",
    "stset t, failure(d) id(id) exit(d==1)",
    "stset t, failure(d) time0(x)",
    "sts list, at(1 5 10)",
    "sts list, cumhaz",
    "sts test grp, cox",
    "sts test grp, strata(id)",
    "sts graph, ci",
    "sts graph, scheme(s1mono)",
    "sts generate s = s",
    "stcox x grp, exactp",
    "stcox x grp, vce(robust)",
    "stcox x grp, strata(id)",
    "streg x grp, dist(lognormal)",
    "streg x grp, dist(weibull) frailty(gamma)",
    "streg x grp, dist(weibull) vce(robust)",
    "predict s0, basesurv",
    "estat phtest, plot(x)",
  ]) {
    const { rc, text } = stops(s, `capture noisily ${command}`);
    assert.equal(rc, 0, command);
    const plain = stops(s, command);
    assert.equal(plain.rc, 198, `${command}: ${plain.text}`);
    assert.match(
      plain.text,
      /not available in the browser yet|is not drawn on this page/,
      command,
    );
    void text;
  }
  run(s, "streg x grp, dist(weibull)");
  assert.equal(stops(s, "predict m").rc, 198);
});

test("mistakes stop with Stata's return codes, not a crash", () => {
  const plain = new Session();
  plain.run("clear\nset obs 5\ngenerate t = _n");
  for (const command of [
    "stsum",
    "stdescribe",
    "sts list",
    "stcox t",
    "streg t, dist(weibull)",
  ])
    assert.equal(stops(plain, command).rc, 119, command);
  const s = session();
  for (const [command, rc] of [
    ["stset t, id(id)", 198],
    ["stset t, failure(d) origin(5)", 198],
    ["stset t d, failure(d)", 198],
    ["sts foo", 198],
    ["sts test", 100],
    ["sts test grp if d == 0", 2000],
    ["streg x grp", 198],
    ["streg x grp, dist(normal)", 198],
    ["streg x grp, dist(gompertz) time", 198],
    ["stcox x grp, efron exactm", 198],
    ["stsum, by(nosuchvar)", 111],
    ["estat phtest", 301],
  ])
    assert.equal(stops(s, command).rc, rc, command);
});

test("survival commands stay quick on 10,000 records", () => {
  const s = new Session();
  s.run(`clear
set seed 5
set obs 10000
generate grp = floor(runiform()*4)
generate x = invnormal(runiform())
generate z = runiform()
generate t = ceil(-ln(runiform())*50*exp(-.5*x - .2*grp))
generate d = runiform() < .7
quietly stset t, failure(d)`);
  for (const command of [
    "stsum, by(grp)",
    "sts test grp",
    "sts list, by(grp)",
    "stcox x z i.grp",
    "estat phtest, detail",
    "stcox x z i.grp, efron",
    "streg x z i.grp, dist(weibull)",
    "streg x z i.grp, dist(gompertz)",
  ]) {
    const started = Date.now();
    run(s, command);
    assert.ok(Date.now() - started < 2000, `${command} took too long`);
  }
  // The exact marginal likelihood integrates every tied group, of which
  // these data have hundreds with up to a thousand failures each, by
  // Stata's fifteen-point rule.
  const started = Date.now();
  run(s, "stcox x z i.grp, exactm");
  assert.ok(Date.now() - started < 2000, "exactm took too long");
});

// ----- The red-team round on survival (pass 7). Values recorded from
// Stata 19 MP (version 17, set processors 1) on the same generated data.

/** A session holding the data of a do-file's first lines. */
function data(source) {
  const s = new Session();
  assert.equal(s.run(source).rc, 0);
  return s;
}
/** The lines of a command's printed output. */
const printed = (s, command) =>
  s
    .run(command)
    .output.flatMap((block) => block.lines)
    .flatMap((line) => line.split("\n"));

const TIES = `clear
set seed 909
set obs 1000
generate x = invnormal(runiform())
generate z = runiform() < .5
generate t = ceil(runiform()*3)
generate d = runiform() < .7
quietly stset t, failure(d)`;

test("stcox, exactm integrates as Stata does, by 15-point Gauss-Laguerre", () => {
  // Tied groups of 207, 235 and 236 failures among 1,000, 678 and 326 at
  // risk: the integral itself gives -1129.6494 at beta = 0, Stata's
  // quadrature -1466.5746.
  const s = data(TIES),
    { e } = run(s, "stcox x z, exactm");
  close(e.ll, -1466.24443544355836, "ll", 1e-13);
  close(e.ll_0, -1466.57460538933606, "ll_0", 1e-13);
  const V = s.estimates.V;
  close(V[0][0], 0.00146234691236009, "V[x,x]", 1e-11);
  close(V[1][0], 0.000074705547202661, "V[z,x]", 1e-9);
  close(V[1][1], 0.005957858537967421, "V[z,z]", 1e-11);
});

test("stcox says no ties when no two failures share a time", () => {
  const s = data(`clear
set seed 505
set obs 50
generate x = invnormal(runiform())
generate t = -ln(runiform())*exp(-.4*x)
generate d = runiform() < .8
quietly stset t, failure(d)`);
  for (const [method, word] of [
    ["", "breslow"],
    ["efron", "efron"],
    ["exactm", "marginal"],
  ]) {
    const { e } = run(s, `stcox x, ${method}`);
    assert.deepEqual([e.ties, e.method], ["none", word], method);
    // e(ties) is stored before e(method) when there are no ties.
    const keys = Object.keys(e);
    assert.ok(keys.indexOf("ties") < keys.indexOf("method"), method);
    close(e.ll, -100.0360163465004, `${method} ll`, 1e-12);
  }
  // Schoenfeld residuals exist after exactm without ties.
  const { r } = run(s, "estat phtest");
  close(r.chi2, 0.0142, "phtest chi2", 0.05);
  // ereturn list cuts a macro too long for the line, as Stata does.
  s.run("set linesize 79");
  assert.ok(
    printed(s, "ereturn list").includes(
      '       e(marginsnotok) : "CSNell DEViance DFBeta ESR LDisplace LMax MGale S.."',
    ),
  );
  s.run("set linesize 120");
  assert.ok(
    printed(s, "ereturn list").includes(
      '       e(marginsnotok) : "CSNell DEViance DFBeta ESR LDisplace LMax MGale SCAledsch SCHoenfeld SCores"',
    ),
  );
});

test("stcox stops when an estimate settles to 1e-4 of itself, as Stata does", () => {
  // Stata's cox ignores tolerance() and ltolerance(): on these data it
  // logs two iterations for Breslow's ties and three for Efron's.
  const s = data(`clear
set seed 70
set obs 200
generate x = invnormal(runiform())
generate g = runiform() < .4
generate w = runiform()*3
generate t = ceil(-ln(runiform())*2*exp(-.3*x+.2*g))
generate d = runiform() < .75
quietly stset t, failure(d)`),
    log = (command) =>
      printed(s, command).filter((line) => /^Iteration|^Refining/.test(line));
  assert.deepEqual(log("stcox x g w"), [
    "Iteration 0:  Log likelihood = -696.27556",
    "Iteration 1:  Log likelihood = -689.61611",
    "Iteration 2:  Log likelihood = -689.61202",
    "Refining estimates:",
    "Iteration 0:  Log likelihood = -689.61202",
  ]);
  assert.equal(log("stcox x g w, efron").length, 6);
});

test("a covariate that separates the failures adds no degree of freedom", () => {
  // stcox: Stata stops with z's coefficient at 3.24e+17 where its rounding
  // makes the information vanish, and the runtime where its own does; the
  // rank, test and p-value agree.
  const s = data(`clear
set seed 404
set obs 30
generate z = _n > 15
generate t = cond(z, ceil(runiform()*5), 5 + ceil(runiform()*5))
generate d = 1
quietly stset t, failure(d)`);
  let { e } = run(s, "stcox z");
  assert.deepEqual([e.rank, e.df_m], [0, 0]);
  close(e.chi2, 32.6925882292297, "chi2", 1e-9);
  close(e.ll, -63.13850501501527, "ll", 1e-12);
  assert.equal(s.estimates.V[0][0], 0);
  assert.ok(
    printed(s, "stcox").includes(
      "Log likelihood = -63.138505                             Prob > chi2   =      .",
    ),
  );
  // streg: 300 Newton steps that are not concave, then r(430).
  const t = data(`clear
set seed 1111
set obs 70
generate x = invnormal(runiform())
generate x2 = -x
generate g = floor(runiform()*3)
generate t = -ln(runiform())*10*exp(-.3*x)
generate d = runiform() < .8
replace x = . in 3
generate z = x > 0 if x < .
replace d = 1 if z == 1
replace d = 0 if z == 0
quietly stset t, failure(d)`);
  const result = t.run("streg z, dist(exponential) nolog");
  assert.equal(result.rc, 430);
  e = t.results.e;
  assert.deepEqual(
    [e.converged, e.rc, e.ic, e.rank, e.df_m, e.k],
    [0, 430, 300, 1, 0, 2],
  );
  assert.ok(e.p >= 8.98e307, "p is missing");
  close(e.ll, -32.96964470507715, "ll", 1e-12);
  close(e.ll_0, -59.37995779204731, "ll_0", 1e-12);
  assert.deepEqual(t.estimates.V[0], [0, 0]);
  close(t.estimates.V[1][1], 0.03703704, "V[_cons]", 1e-6);
  // Its replay stops the same way.
  assert.equal(t.run("streg").rc, 430);
});

test("ereturn list after streg holds e() as Stata stores it", () => {
  const s = data(`clear
set seed 1717
set obs 60
generate x = invnormal(runiform())
generate g = floor(runiform()*3)
generate t = ceil(-ln(runiform())*10)
generate d = runiform() < .7
replace x = . in 2
quietly stset t if g < 2, failure(d)
quietly streg x i.g, dist(weibull)`);
  const lines = printed(s, "ereturn list"),
    scalars = lines
      .filter((line) => / = /.test(line))
      .map((line) => line.trim().split(" ")[0]);
  assert.deepEqual(scalars, [
    "e(rank)",
    "e(N)",
    "e(ic)",
    "e(k)",
    "e(k_eq)",
    "e(k_dv)",
    "e(converged)",
    "e(rc)",
    "e(ll)",
    "e(k_eq_model)",
    "e(ll_0)",
    "e(df_m)",
    "e(chi2)",
    "e(p)",
    "e(aux_p)",
    "e(k_aux)",
    "e(risk)",
    "e(N_fail)",
    "e(N_sub)",
  ]);
  const from = lines.indexOf("macros:");
  assert.deepEqual(lines.slice(from + 1, from + 22), [
    '            e(cmdline) : "streg x i.g, dist(weibull)"',
    '            e(predict) : "streg_p"',
    '        e(predict_sub) : "weibul_p"',
    '          e(estat_cmd) : "streg_estat"',
    '               e(cmd2) : "streg"',
    '              e(title) : "Weibull PH regression"',
    '                e(cmd) : "weibull"',
    '               e(dead) : "_d"',
    '               e(frm2) : "hazard"',
    '            e(stcurve) : "stcurve"',
    '                 e(t0) : "_t0"',
    '           e(chi2type) : "LR"',
    '  e(deriv_useminbound) : "off"',
    '                e(opt) : "moptimize"',
    '                e(vce) : "oim"',
    '               e(user) : "weib_lf0"',
    '          e(ml_method) : "e2"',
    '          e(technique) : "nr"',
    '              e(which) : "max"',
    '             e(depvar) : "_t"',
    '         e(properties) : "b V"',
  ]);
  const matrices = lines.indexOf("matrices:");
  assert.deepEqual(lines.slice(matrices + 1, matrices + 6), [
    "                  e(b) :  1 x 5",
    "                  e(V) :  5 x 5",
    "                e(Cns) :  1 x 6",
    "               e(ilog) :  1 x 20",
    "           e(gradient) :  1 x 5",
  ]);
  const { e } = s.results;
  assert.deepEqual([e.k, e.rank, e.df_m], [5, 4, 2]);
  // Stata's gradient at its estimates is below 1e-7 in every element.
  assert.ok(
    e["matrix:gradient"].values[0].every((v) => Math.abs(v) < 1e-6),
    "gradient",
  );
  // stcox stores what cox does, but e(datasignature), whose checksum
  // is Stata's own (docs/numerical-contract.md).
  const { e: cox } = run(s, "stcox x i.g");
  assert.equal(
    cox.marginsnotok,
    "CSNell DEViance DFBeta ESR LDisplace LMax MGale SCAledsch SCHoenfeld SCores",
  );
  assert.equal(cox.rank, 2);
});

test("stcox, estimate fits the model without covariates", () => {
  const s = data(`clear
set seed 1818
set obs 90
generate t = ceil(-ln(runiform())*12)
generate d = runiform() < .7
quietly stset t, failure(d)`);
  const { e } = run(s, "stcox, estimate");
  close(e.ll, -235.322369489237, "ll", 1e-13);
  assert.deepEqual([e.chi2, e.r2_p, e.df_m, e.N_fail], [0, 0, 0, 66]);
  assert.equal("rank" in e, false);
  assert.equal(
    printed(s, "ereturn list").some((line) => /e\(b\)/.test(line)),
    false,
  );
});

test("sts test refuses more groups than it can compare, and is quick below", () => {
  const s = data(`clear
set seed 9
set obs 10000
generate g = floor(runiform()*1000)
generate d = runiform() < .9
generate t = -ln(runiform())*10
quietly stset t, failure(d)`);
  const started = Date.now();
  run(s, "sts test g");
  assert.ok(Date.now() - started < 2500, "sts test took too long");
  s.run("generate x = invnormal(runiform())");
  const refused = stops(s, "sts test x");
  assert.equal(refused.rc, 134);
  assert.match(refused.text, /at most 1,000 groups/);
});

test("a Weibull constant-only model that WeibCons cannot fit is refused", () => {
  // Stata takes 20 Newton steps in ln p, then searches for new starting
  // values by ml, which the runtime does not.
  const s = data(`clear
set seed 1212
set obs 45
generate g = floor(runiform()*3)
generate x = runiform()
generate t = ceil(runiform()*15)
generate d = runiform() < .6
quietly stset t, failure(d)`);
  const lines = printed(s, "capture noisily streg g in 1/2, dist(weibull)");
  assert.equal(s.rc, 430);
  assert.ok(lines.includes("Iteration 20: Log likelihood =  18.306853"));
  assert.equal(
    lines.includes("Iteration 21: Log likelihood =  19.306853"),
    false,
  );
});
