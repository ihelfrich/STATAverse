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

function run(source) {
  const s = new Session();
  const r = s.run(source);
  assert.equal(r.rc, 0, r.output?.map((o) => o.lines.join("\n")).join("\n"));
  return s;
}

const scalars = (e) =>
  Object.keys(e).filter((key) => typeof e[key] === "number");
const macros = (e) =>
  Object.keys(e).filter(
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
