// The recheck of the linear models: what tests/runtime-output.test.mjs
// cannot compare line by line (the recheck-linear-* cases of
// tools/output-cases.txt carry the printed text). The order ereturn list
// shows e() in once margins or estimates restore have held the estimates,
// the results Stata keeps hidden, and stored results at full precision.
// Every expected value was recorded from Stata 19 MP (version 17, set
// processors 1) on the same generated data, which runiform() and
// rnormal() reproduce draw for draw.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { HIDDEN, HISTORICAL } from "../src/runtime/estimation.js";

function run(source) {
  const s = new Session();
  const r = s.run(source);
  assert.equal(r.rc, 0, r.output?.map((o) => o.lines.join("\n")).join("\n"));
  return s;
}

// What ereturn list shows: the results Stata keeps hidden, or keeps only
// for older versions, are left out.
const listed = (e) =>
  Object.keys(e).filter(
    (key) =>
      !(e[HIDDEN] ?? []).includes(key) && !(e[HISTORICAL] ?? []).includes(key),
  );
const scalars = (e) => listed(e).filter((key) => typeof e[key] === "number");
const macros = (e) =>
  listed(e).filter(
    (key) => typeof e[key] === "string" && e[key] !== "" && !/:/.test(key),
  );

const ORDER = `clear
set obs 120
set seed 5110
generate x = rnormal()
generate f = runiform() < .5
generate y = 1 + x + f + rnormal()
quietly regress y x
`;
const FIT_SCALARS = "N sum_w df_m df_r F r2 rmse mss rss r2_a ll ll_0 rank",
  FIT_MACROS =
    "cmdline title marginsok vce depvar cmd properties predict model estat_cmd",
  reversed = (list) => list.split(" ").reverse().join(" ");

test("margins and estimates restore leave e() in the order Stata lists it", () => {
  const s = run(`${ORDER}quietly margins\n`);
  assert.equal(scalars(s.results.e).join(" "), FIT_SCALARS);
  assert.equal(macros(s.results.e).join(" "), reversed(FIT_MACROS));
  s.run("quietly margins");
  assert.equal(scalars(s.results.e).join(" "), reversed(FIT_SCALARS));
  assert.equal(macros(s.results.e).join(" "), FIT_MACROS);
  s.run("estimates store m1\nestimates restore m1");
  assert.equal(scalars(s.results.e).join(" "), reversed(FIT_SCALARS));
  assert.equal(macros(s.results.e).join(" "), FIT_MACROS);
  // With factor variables in the model, or derivatives asked for, one
  // margins leaves the order restore gives.
  s.run("quietly regress y x i.f\nquietly margins");
  assert.equal(scalars(s.results.e).join(" "), reversed(FIT_SCALARS));
  s.run("quietly regress y x f\nquietly margins, dydx(x)");
  assert.equal(scalars(s.results.e).join(" "), reversed(FIT_SCALARS));
  assert.equal(macros(s.results.e).join(" "), FIT_MACROS);
});

const IV = `clear
set obs 160
set seed 5108
generate z1 = rnormal()
generate z2 = rnormal()
generate x = rnormal()
generate g = 1 + floor(runiform()*5)
generate h = z1 + z2 + rnormal()
generate y = 1 + h + x + rnormal()
`;

test("ivregress and areg post e() in Stata's order, with hidden results", () => {
  const s = run(`${IV}quietly ivregress 2sls y x (h = z1 z2)\n`),
    e = s.results.e;
  assert.equal(
    scalars(e).join(" "),
    "kappa rss N df_m rmse mss r2 r2_a chi2 k_endog iterations rank",
  );
  // ereturn list shows these, and not cmd2, the robust_ macros,
  // marginsprop, insts or instd, which display e() still finds.
  const listed = s.run("ereturn list").output[0].lines.join("\n");
  assert.match(
    listed,
    /e\(cmdline\) : "ivregress 2sls  y x \(h = z1 z2\)"[\s\S]*e\(properties\) : "b V"/,
  );
  assert.doesNotMatch(listed, /instd|insts|cmd2|marginsprop|e\(p\) /);
  assert.equal(e.instd, "h");
  assert.equal(e.insts, "x z1 z2");
  const order = macros(e).filter((key) => listed.includes(`e(${key})`));
  assert.equal(
    order.join(" "),
    "cmdline cmd estat_cmd vce estimator footnote marginsnotok marginsok predict depvar exogr exog endog title properties",
  );
  // estimates store and restore keep them hidden.
  s.run("estimates store iv\nestimates restore iv");
  assert.equal(s.results.e.instd, "h");
  assert.doesNotMatch(
    s.run("ereturn list").output[0].lines.join("\n"),
    /instd/,
  );
  const a = run(`${IV}quietly areg y x, absorb(g)\n`).results.e;
  assert.equal(
    scalars(a).join(" "),
    "F_absorb p_absorb rank p rc k_absorb ll_0 ll tss df_a r2_a rss mss rmse r2 F df_r df_m sum_w N",
  );
  assert.equal(a.title2, "Absorbed variable: g");
});

test("summarize and regress sum as precisely as Stata", () => {
  const s = run(`clear
set obs 199
set seed 5113
generate x = exp(rnormal(2, .6))
quietly summarize x
`);
  // %21.0g of r(Var) in Stata 19: 33.95958442290765333.
  assert.equal(s.results.r.Var, 33.95958442290765333);
  const r = run(`${ORDER}`).results.e;
  // ereturn list after regress y x: e(rss) = 165.470750791382, e(ll) =
  // -189.5507862268232, the last digits Stata's sums give.
  assert.equal(r.rss.toPrecision(16), "165.4707507913820");
  assert.equal(r.ll.toPrecision(16), "-189.5507862268232");
});

test("a regression's cluster variance counts no direction of rounding", () => {
  // Dummies for groups inside clusters, and with them the constant, have
  // scores that sum to zero in every cluster; Stata leaves them out of
  // e(rank) and e(df_m) (0 and 1 here).
  const s = run(`clear
set obs 60
set seed 5112
generate g = ceil(_n/3)
generate c = ceil(g/4)
forvalues k = 1/6 {
generate x\`k' = rnormal()
}
generate y = g/5 + x1 - x2 + rnormal()
quietly regress y x1 i.g, vce(cluster g)
`);
  assert.equal(s.results.e.df_m, 0);
  assert.equal(s.results.e.rank, 1);
  // areg with fewer clusters than coefficients: F missing on the rank of
  // the slopes' variance, as Stata reports F(4, 4) = . and e(rank) 4.
  s.run("quietly areg y x1-x6, absorb(g) vce(cluster c)");
  assert.equal(s.results.e.df_m, 4);
  assert.equal(s.results.e.rank, 4);
});

// The second recheck: e() orders recorded from Stata 19 (version 17, set
// processors 1) on these data, where the values differ from Stata's in the
// last digit or Stata posts a checksum the browser does not compute
// (areg's e(datasignature)), so the text cannot be compared whole.
const RECHECK = `clear
set obs 300
set seed 2026
generate g = 1+floor(runiform()*6)
generate x1 = invnormal(runiform())
generate x2 = x1*.5 + invnormal(runiform())
generate z1 = invnormal(runiform())
generate z2 = invnormal(runiform())
generate en = x1 + z1*.8 + z2*.5 + invnormal(runiform())
generate y = 1 + 2*x1 - x2 + en + invnormal(runiform())*2 + g*.5
`;
const matrices = (e) =>
  Object.keys(e)
    .filter((key) => key.startsWith("matrix:"))
    .map((key) => key.slice(7));
const words = (text) => text.split(" ");

test("margins reverses e(beta) and e(V_modelbased) with the macros", () => {
  const s = run(`${RECHECK}quietly regress y x1 x2, vce(robust)\n`);
  assert.deepEqual(matrices(s.results.e), ["beta", "V_modelbased"]);
  s.run("quietly margins");
  // ereturn list: e(b) e(V) e(V_modelbased) e(beta).
  assert.deepEqual(matrices(s.results.e), ["V_modelbased", "beta"]);
  assert.equal(macros(s.results.e)[0], "vcetype");
});

test("estimates restore steps the order of results restored after another fit", () => {
  const FIT = "N sum_w df_m df_r F r2 rmse mss rss r2_a ll ll_0 rank",
    FIT_M =
      "cmdline title marginsok vce depvar cmd properties predict model estat_cmd vcetype";
  // Stored as fitted, restored after another fit: the macros reversed;
  // restored again after another: the scalars.
  const s = run(`${RECHECK}quietly regress y x1 x2, vce(robust)
estimates store a
quietly regress y x1
estimates restore a
`);
  assert.equal(scalars(s.results.e).join(" "), FIT);
  assert.equal(macros(s.results.e).join(" "), reversed(FIT_M));
  assert.deepEqual(matrices(s.results.e), ["V_modelbased", "beta"]);
  s.run("quietly regress y x1\nestimates restore a");
  assert.equal(scalars(s.results.e).join(" "), reversed(FIT));
  assert.equal(macros(s.results.e).join(" "), FIT_M);
  // Stored after margins of a factor (scalars reversed), restored after
  // another fit: the macros reversed.
  const f = run(`${RECHECK}quietly regress y x1 i.g
quietly margins g
estimates store m1
quietly regress y x1
estimates restore m1
`);
  assert.equal(scalars(f.results.e)[0], "N");
  assert.equal(macros(f.results.e)[0], "estat_cmd");
  // ereturn list, all then shows e(_estimates_name) first among the
  // hidden macros.
  const hidden = f.run("ereturn list, all").output[0].lines.join("\n");
  assert.match(
    hidden,
    /Hidden;[\s\S]*e\(_estimates_name\) : "m1"\n[\s\S]*e\(_r_z__CL\)/,
  );
});

test("ivregress keeps its order through margins and estimates restore", () => {
  const FIT = "kappa rss N df_m rmse mss r2 r2_a chi2 k_endog iterations rank",
    FIT_M =
      "cmdline cmd estat_cmd vce estimator footnote marginsnotok marginsok predict depvar exog endog title properties";
  const s = run(`${RECHECK}quietly ivregress 2sls y (en = z1 z2)
estimates store iv
quietly regress y x1
estimates restore iv
`);
  assert.equal(scalars(s.results.e).join(" "), FIT);
  assert.equal(macros(s.results.e).join(" "), reversed(FIT_M));
  // Restored while active, then margins: the scalars reversed.
  const m = run(`${RECHECK}quietly ivregress 2sls y (en = z1 z2)
estimates store d
estimates restore d
`);
  assert.equal(scalars(m.results.e).join(" "), reversed(FIT));
  m.run("quietly margins");
  assert.equal(scalars(m.results.e).join(" "), reversed(FIT));
  assert.equal(macros(m.results.e).join(" "), FIT_M);
  const fresh = run(`${RECHECK}quietly ivregress 2sls y x1 (en = z1 z2)
quietly margins
`);
  assert.equal(scalars(fresh.results.e)[0], "rank");
  assert.equal(macros(fresh.results.e)[0], "cmdline");
  // e(idtype) is hidden: overidentified here, justidentified with one
  // instrument.
  assert.equal(fresh.results.e.idtype, "overidentified");
  fresh.run("quietly ivregress 2sls y (en = z1)");
  assert.equal(fresh.results.e.idtype, "justidentified");
});

test("areg's own scalars keep a run of their own through margins", () => {
  const s = run(`${RECHECK}quietly areg y x1, absorb(g)
quietly margins
`);
  assert.deepEqual(
    scalars(s.results.e),
    words(
      "N sum_w df_m df_r F r2 rmse mss rss r2_a df_a tss ll ll_0 F_absorb p_absorb rank p rc k_absorb",
    ),
  );
  assert.equal(macros(s.results.e)[0], "absvar");
  s.run("quietly margins");
  assert.deepEqual(
    scalars(s.results.e),
    words(
      "k_absorb rc p rank p_absorb F_absorb ll_0 ll tss df_a r2_a rss mss rmse r2 F df_r df_m sum_w N",
    ),
  );
  assert.equal(macros(s.results.e)[0], "cmdline");
  // Hidden: e(r2_c), the R-squared without the absorbed indicators,
  // which is regress's (.4917071327346695 for both in Stata on the
  // recheck's data), and the historical e(ar2).
  const t = run(`${RECHECK}quietly areg y x1 x2, absorb(g)\n`),
    a = t.results.e;
  t.run("quietly regress y x1 x2");
  assert.equal(a.r2_c, t.results.e.r2);
  assert.equal(a.ar2, a.r2_a);
  assert.equal(a.estmethod, "areg");
  const c = run(`${RECHECK}quietly areg y x1, absorb(g) vce(cluster g)\n`)
    .results.e;
  assert.equal(c.estmethod, "areg_11");
  assert.equal(c.marginsprop, undefined);
});
