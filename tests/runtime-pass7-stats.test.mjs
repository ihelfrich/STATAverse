// Seventh pass, stats group: swilk, sfrancia, sktest, ktau, contract and
// ratio, and the design options of bootstrap, jackknife, simulate and
// bsample. tools/output-cases.txt compares their printed text with Stata's;
// this file checks what text cannot: r() to more digits than return list
// keeps reliably, the files saving() writes, the samples bsample draws and
// the errors. The values were recorded from Stata 19 (version 17, set
// processors 1) in batch mode.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { kendallScore } from "../src/runtime/stats-more.js";

const run = (source) => {
  const session = new Session(),
    output = session.run(source).output;
  return { session, output, last: output.at(-1) };
};
const close = (actual, expected, tolerance = 1e-12) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );
const DATA = `set seed 12345
set obs 200
generate x = invnormal(runiform())
generate y = exp(invnormal(runiform()))
generate g = 1 + floor(runiform()*3)
generate w = 1 + floor(runiform()*4)
generate u = runiform()
replace x = . in 5`;

test("swilk's r() agrees with Stata's to 12 digits", () => {
  const { session } = run(`${DATA}\nswilk x y u`),
    r = session.results.r;
  // Stata 19: return list after swilk x y u.
  assert.equal(r.N, 200);
  close(r.W, 0.9657699204881062);
  close(r.V, 5.106638338520595);
  close(r.z, 3.751633966070957);
  close(r.p, 0.0000878429175544);
});

test("swilk's exact probability for three observations", () => {
  const { session } = run(`${DATA}\nswilk x in 1/3`),
    r = session.results.r;
  // Stata 19: return list after swilk x in 1/3.
  assert.equal(r.N, 3);
  close(r.W, 0.8464158797748276);
  close(r.V, 2.292742640149597);
  close(r.z, 0.7359192186801922);
  close(r.p, 0.2308899302669927);
});

test("sfrancia's r() agrees with Stata's to 12 digits", () => {
  const { session } = run(`${DATA}\nsfrancia x y u`),
    r = session.results.r;
  assert.equal(r.N, 200);
  close(r.W, 0.97050833563976);
  close(r.V, 4.801612540616418);
  close(r.z, 3.24408698594621);
  close(r.p, 0.00058913878571);
});

test("sktest's r() agrees with Stata's, adjusted and not", () => {
  let { session } = run(`${DATA}\nsktest x y u`);
  let r = session.results.r;
  close(r.p_skew, 0.8619938707333263);
  close(r.p_kurt, 1.6907660239e-11, 1e-9);
  close(r.chi2, 34.77608469375834);
  close(r.p_chi2, 2.80846591648e-8, 1e-9);
  ({ session } = run(`${DATA}\nsktest x y, noadjust`));
  r = session.results.r;
  close(r.p_skew, 3.74315942311e-26, 1e-9);
  close(r.p_kurt, 1.72430905831e-14, 1e-9);
  close(r.chi2, 170.7317524938664);
  close(r.p_chi2, 8.43472646449e-38, 1e-9);
});

test("Kendall's score by merge sort is the sum over pairs, ties included", () => {
  let seed = 7;
  const next = () => (seed = (seed * 69069 + 1) % 2 ** 32) / 2 ** 32;
  for (let trial = 0; trial < 50; trial++) {
    const n = 3 + Math.floor(next() * 40),
      xs = Array.from({ length: n }, () => Math.floor(next() * 6)),
      ys = Array.from({ length: n }, () => Math.floor(next() * 5));
    let pairs = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        pairs += Math.sign(xs[i] - xs[j]) * Math.sign(ys[i] - ys[j]);
    assert.equal(kendallScore(xs, ys), pairs);
  }
});

test("the normality notes and ktau's errors are Stata's", () => {
  const { last } = run(`${DATA}\nswilk x in 1/3`);
  // At the default line size of 79 the note wraps as at 200.
  assert.deepEqual(last.lines.slice(-3), [
    "Note: The normal approximation to the sampling distribution of W'",
    "      is valid for 4<=n<=2000.",
    "",
  ]);
  const few = run(`${DATA}\nktau x y in 1/2`).last;
  assert.equal(few.rc, 2001);
  const one = run(`${DATA}\nktau x`).last;
  assert.equal(one.rc, 102);
  const text = run(`${DATA}\ngenerate str1 s = "a"\nsfrancia s`).last;
  assert.equal(text.rc, 109);
});

test("contract's refusals and errors", () => {
  const base = "set obs 4\ngenerate g = mod(_n, 2)\n";
  assert.equal(run(`${base}contract g, float`).last.rc, 198);
  assert.equal(
    run(`${base}generate _freq = 1\ncontract g`).last.lines[0],
    "_freq already defined: use freq() option to specify frequency variable",
  );
  assert.equal(run(`${base}contract g if g > 5`).last.rc, 2000);
  // contract g, zero over two variables fills every combination.
  const { session } = run(
    `${base}generate h = _n\ncontract g h, zero cfreq(c) percent(p)`,
  );
  assert.equal(session.data.n, 8);
  assert.deepEqual(
    Array.from(session.data.get("c").data),
    [0, 1, 1, 2, 3, 3, 4, 4],
  );
});

test("ratio keeps e(b), e(V), e(_N) and refuses what it lacks", () => {
  const { session } = run(`set seed 2468
set obs 60
generate g = 1 + floor(runiform()*3)
generate h = floor(runiform()*2)
generate w = 1 + floor(runiform()*4)
generate y = 10 + 5*runiform()
generate x = 2 + runiform()
generate z = 1 + runiform()
replace x = . in 7
ratio (r1: y/x) (r2: z/x), over(h)`);
  const model = session.estimates;
  assert.deepEqual(model.names, [
    "c.r1@0.h",
    "c.r1@1.h",
    "c.r2@0.h",
    "c.r2@1.h",
  ]);
  // Stata 19: the groups of over() do not covary.
  assert.equal(model.V[0][1], 0);
  assert.equal(model.V[0][3], 0);
  assert.ok(model.V[0][2] !== 0);
  assert.deepEqual(session.results.e["matrix:_N"].values, [[27, 32, 27, 32]]);
  const weighted = run(
    `set obs 3\ngenerate y = _n\ngenerate x = 1\nratio y/x [aw=x]`,
  );
  assert.equal(weighted.last.rc, 101);
  const robust = run(
    `set obs 3\ngenerate y = _n\ngenerate x = 1\nratio y/x, vce(robust)`,
  );
  assert.equal(robust.last.rc, 198);
});

test("bsample keeps strata whole and draws clusters whole", () => {
  const { session } = run(`set obs 30
generate id = ceil(_n/3)
generate s = 1 + (_n > 12)
generate k = _n
set seed 11
bsample, strata(s) cluster(id) idcluster(nid)`);
  const data = session.data,
    s = data.get("s").data,
    id = data.get("id").data,
    nid = data.get("nid").data;
  assert.equal(data.n, 30);
  assert.equal(s.filter((v) => v === 1).length, 12);
  // Each new cluster is one old cluster, all three of its observations.
  const members = new Map();
  nid.forEach((v, i) => {
    if (!members.has(v)) members.set(v, []);
    members.get(v).push(id[i]);
  });
  assert.equal(members.size, 10);
  for (const ids of members.values()) {
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 1);
  }
});

test("the design options' errors are Stata's", () => {
  const base = `set seed 77
set obs 20
generate id = ceil(_n/4)
generate y = runiform()
`;
  const cases = [
    ["bootstrap m=r(mean), reps(5) idcluster(n): summarize y", 198],
    ["bootstrap m=r(mean), reps(5) cluster(id) size(9): summarize y", 498],
    ["bootstrap m=r(mean), reps(5) size(30): summarize y", 498],
    ["bootstrap m=r(mean), reps(5) dots(2) nodots: summarize y", 198],
    ["bootstrap m=r(mean), reps(1): summarize y", 198],
    ["jackknife m=r(mean), idcluster(n): summarize y", 198],
    ["bsample, cluster(id) strata(id)", 460],
    ["bsample 21", 498],
    ["simulate m=r(mean), reps(2) seed(XAA00): summarize y", 198],
  ];
  for (const [command, rc] of cases)
    assert.equal(run(`${base}${command}`).last.rc, rc, command);
  const saved = run(
    `${base}bootstrap m=r(mean), reps(3) saving(f) nodots: summarize y\nbootstrap m=r(mean), reps(3) saving(f) nodots: summarize y`,
  ).last;
  assert.equal(saved.rc, 602);
});

test("saving() writes the replicates as Stata does", () => {
  const { session } = run(`set seed 77
set obs 40
generate y = runiform()
bootstrap m=r(mean), reps(4) nodots saving(bs, double): summarize y
simulate s=r(sd), reps(3) nodots saving(sim, replace): summarize y`);
  const bs = session.files.get("bs.dta");
  assert.equal(bs.label, "bootstrap: summarize");
  assert.equal(bs.n, 4);
  assert.equal(bs.variables[0].type, "double");
  assert.equal(bs.variables[0].label, "r(mean)");
  // simulate leaves the results in memory, as the file it saved.
  assert.equal(session.data.filename, "sim.dta");
  assert.equal(session.data.label, "simulate: summarize");
  assert.equal(session.data.get("s").type, "float");
});

test("a zero total and a constant variable read as in Stata", () => {
  const base = `set seed 4321
set obs 50
generate x = invnormal(runiform())
generate zero = 0
`;
  // Stata 19: ratio's rows, and swilk's error once its coefficients are
  // all missing.
  const over = run(`${base}ratio x/zero`).last.lines;
  assert.ok(
    over.includes(
      "    _ratio_1 |          .  (denominator estimate equals zero)",
    ),
  );
  const none = run(`${base}ratio zero/x`).last.lines;
  assert.ok(none.includes("    _ratio_1 |          0  (omitted)"));
  const constant = run(`${base}swilk zero`).last;
  assert.equal(constant.rc, 2000);
  assert.ok(constant.lines.includes("no observations"));
});

// Second round of the seventh pass. The values were recorded from Stata 19
// (version 17, set processors 1) in batch mode, with matrix list's
// format(%21.17g) and list after format %21.17g.
const FAILED = `set seed 77
set obs 30
generate y = runiform()
generate x = 1 + runiform()
replace y = . in 4
`;

test("bootstrap of statistics keeps e(b), e(V) and bstat's matrices", () => {
  const { session } = run(
      `${FAILED}set seed 5\nbootstrap m=r(mean) s=r(sd), reps(20) nodots: summarize y`,
    ),
    e = session.results.e,
    row = (name) => e[`matrix:${name}`].values[0],
    pair = (name) => e[`matrix:${name}`].values;
  assert.deepEqual(e["matrix:b"].colNames, ["m", "s"]);
  close(row("b")[0], 0.43552713622820788);
  close(row("b")[1], 0.22880125154239689);
  close(e["matrix:V"].values[0][0], 0.0023466659386255943);
  close(e["matrix:V"].values[1][0], -0.000139647992855076);
  close(e["matrix:V"].values[1][1], 0.0005628418854955048);
  close(row("b_bs")[0], 0.44351173937320709);
  close(row("b_bs")[1], 0.22381081879138948);
  close(row("bias")[0], 0.0079846031449992139);
  close(row("bias")[1], -0.004990432751007412);
  close(row("z0")[0], -0.38532046640756762);
  close(row("z0")[1], 0.25334710313579978);
  close(row("se")[0], 0.048442398151057664);
  close(row("se")[1], 0.023724288935508792);
  assert.deepEqual(row("reps"), [20, 20]);
  close(pair("ci_normal")[0][0], 0.34058178052738519);
  close(pair("ci_normal")[1][1], 0.2753000034148162);
  close(pair("ci_percentile")[0][0], 0.33119556307792664);
  close(pair("ci_percentile")[1][0], 0.5173724889755249);
  close(pair("ci_percentile")[0][1], 0.18750299513339996);
  close(pair("ci_bc")[0][1], 0.18954437971115112);
  close(pair("ci_bc")[1][0], 0.49311822652816772);
  close(pair("ci_bc")[1][1], 0.26636317372322083);
  // _b[] and _se[] read them, as matrix list does.
  close(session.scalar("_b[m]"), 0.43552713622820788);
  close(session.scalar("_se[s]"), Math.sqrt(0.0005628418854955048));
});

test("saving(, double) keeps and uses the replicates in double", () => {
  const { session } = run(`set seed 405
set obs 30
generate y = runiform()
set seed 9
bootstrap m=r(mean), reps(12) saving(p7dbl2, replace double) nodots: summarize y
use p7dbl2, clear`);
  const m = session.data.get("m");
  assert.equal(m.type, "double");
  // Stata 19: list in 1/3 with format m %20.0g.
  close(m.data[0], 0.603190764784812927, 1e-15);
  close(m.data[1], 0.493050182610750176, 1e-15);
  close(m.data[2], 0.516860839972893449, 1e-15);
});

test("jackknife keep stores a cluster's pseudovalues in its first row", () => {
  const { session } = run(`${FAILED}generate s = mod(_n, 4)
jackknife m=r(mean) v=r(Var), keep cluster(s) nodots: summarize y if x > 1.2`),
    m = session.data.get("m").data,
    v = session.data.get("v").data;
  close(m[0], 0.42772045731544495, 1e-15);
  close(m[1], 0.43343552947044373, 1e-15);
  close(m[2], 0.39349427819252014, 1e-15);
  close(v[0], 0.044909827411174774, 1e-15);
  close(v[2], 0.05673450231552124, 1e-15);
  // Cluster 0 lost its replicate (r(N) did not fall by its size); the
  // later rows of a cluster are missing.
  for (const i of [3, 4, 5]) assert.ok(m[i] > 1e300);
});

test("ratio's variance and rank as Stata keeps them", () => {
  const { session } = run(
      `${FAILED}generate s = mod(_n, 4)\nratio y/x, over(s)`,
    ),
    V = session.estimates.V;
  close(V[0][0], 0.0023076931816884754);
  close(V[1][1], 0.0036268850970012931);
  close(V[3][3], 0.0054707899167096563);
  assert.equal(V[1][0], 0);
  assert.equal(session.results.e.rank, 4);
  // A group of one observation: zero in e(V), left out of the rank.
  const one = run(`set seed 501
set obs 12
generate g = cond(_n == 1, 1, cond(_n <= 6, 2, 3))
generate y = 2 + runiform()
generate x = 1 + runiform()
ratio y/x, over(g)`).session;
  assert.equal(one.estimates.V[0][0], 0);
  assert.equal(one.results.e.rank, 2);
  assert.deepEqual(one.results.e["matrix:error"].colNames, ["c1", "c2", "c3"]);
});

test("the prefixes refuse what Stata refuses, with its messages", () => {
  const base = `set obs 30\ngenerate y = runiform()\ngenerate w = 1\n`,
    rc = (line) => run(`${base}${line}`).last;
  const seed = rc("bootstrap m=r(mean), reps(5) seed(abc) nodots: summarize y");
  assert.equal(seed.rc, 198);
  assert.ok(seed.lines.includes("'abc' found where integer < 2^31 expected"));
  const group = rc("bootstrap m=r(mean), reps(5) group(w) nodots: summarize y");
  assert.ok(group.lines.includes("option group() requires option idcluster()"));
  const strata = rc("jackknife m=r(mean), strata(w) nodots: summarize y");
  assert.ok(strata.lines.includes("option strata() not allowed"));
  const missing = rc("bootstrap m=r(nosuch), nodots: summarize y");
  assert.equal(missing.rc, 322);
  const combined = rc("jackknife m=r(mean), eclass rclass nodots: summarize y");
  assert.ok(
    combined.lines.includes("options eclass rclass may not be combined"),
  );
  const predicted = run(
    `${base}generate x = 1 + runiform()\nratio y/x\npredict p`,
  ).last;
  assert.equal(predicted.rc, 301);
  assert.ok(predicted.lines.includes("predict is not allowed after ratio"));
});

test("resampling stays quick at 10,000 observations", () => {
  const session = new Session();
  session.run(`set seed 801
set obs 10000
generate s = 1 + mod(_n, 4)
generate id = ceil(_n/10)
generate y = invnormal(runiform())
generate x = runiform()`);
  // A jackknife of 1,000 clusters runs ratio 1,000 times; it is allowed
  // more while other test files share the machine.
  for (const [line, limit] of [
    [
      "bootstrap m=r(mean), reps(30) strata(s) cluster(id) nodots: summarize y",
      2000,
    ],
    ["bootstrap, reps(30) nodots: ratio y/x, over(s)", 2000],
    ["jackknife, cluster(id) nodots: ratio y/x, over(s)", 4000],
  ]) {
    const start = Date.now();
    session.run(line);
    assert.ok(
      Date.now() - start < limit,
      `${line} took ${Date.now() - start} ms`,
    );
  }
});
