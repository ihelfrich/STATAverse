// arima, pperron, var, varsoc and vargranger, added in the seventh pass.
// Their printed tables are compared line by line in
// tests/runtime-output.test.mjs (the pass7-ts-* cases); this file checks
// what text cannot: the stored results at full precision, the refusals,
// and the time a fit takes on 10,000 observations. Every expected value
// was recorded from Stata 19 MP (version 17, set processors 1) on the same
// generated data, which runiform() reproduces draw for draw.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { missingValue } from "../src/runtime/values.js";

const ARMA = `clear
set seed 12345
set obs 200
generate t = _n
tsset t
generate double e = invnormal(runiform())
generate double y = 0
replace y = 1 + .6*(y[_n-1]-1) + e + .3*e[_n-1] in 2/l
generate double x = runiform()
replace y = y + 2*x
`;
const QUARTERS = `clear
set seed 12345
set obs 120
generate t = tq(1990q1) + _n - 1
format t %tq
tsset t
generate double e1 = invnormal(runiform())
generate double e2 = invnormal(runiform())
generate double y = 0
generate double x = 0
replace y = .5*y[_n-1] + .2*x[_n-1] + e1 in 2/l
replace x = .3*y[_n-1] + .4*x[_n-1] + e2 in 2/l
generate double w = runiform()
generate double z = sum(e1)
`;

function run(source) {
  const session = new Session(),
    result = session.run(source),
    failed = result.output.find((o) => o.error);
  assert.equal(failed?.error?.message, undefined, failed?.command);
  return session;
}
/** Agreement to the number of significant digits asked for. */
function close(actual, expected, digits = 6, what = "") {
  const scale = Math.max(Math.abs(expected), 1e-300),
    error = Math.abs(actual - expected) / scale;
  assert.ok(
    error < 0.5 * 10 ** -digits,
    `${what} ${actual} differs from Stata's ${expected}`,
  );
}

test("arima(1,0,1) reaches Stata's estimates, OPG variance and log likelihood", () => {
  const session = run(`${ARMA}arima y, arima(1,0,1)\n`),
    model = session.estimates,
    e = session.results.e;
  // e(b) and e(V) as matrix list prints them with format(%20.15g).
  const b = [
      2.02669008505453, 0.662004258385789, 0.0493587578765669, 1.30380655511595,
    ],
    V = [
      [0.0814540050931435],
      [0.00134778105137018, 0.00786036416591431],
      [0.00106066623977072, -0.00794972205281135, 0.0132809344253565],
      [
        -0.000447324929172646, -0.000421127349227228, -0.00106055296762467,
        0.00494635589963121,
      ],
    ];
  b.forEach((v, j) => close(model.b[j], v, 6, `b[${j}]`));
  V.forEach((row, i) =>
    row.forEach((v, j) => close(model.V[i][j], v, 5, `V[${i},${j}]`)),
  );
  close(e.ll, -337.1706228573099, 10, "e(ll)");
  close(e.sigma, 1.303806555115946, 6, "e(sigma)");
  close(e.chi2, 154.3647478004884, 5, "e(chi2)");
  assert.equal(e.N, 200);
  assert.equal(e.k, 4);
  assert.equal(e.df_m, 2);
  assert.equal(e.k_eq, 3);
  assert.equal(e.cmd, "arima");
  assert.equal(e.vce, "opg");
  // The iterations Stata takes: BHHH for five, then BFGS until it stops.
  assert.equal(e.ic, 7);
  assert.deepEqual(
    model.stripe.map((s) => `${s.equation}:${s.name}`),
    ["y:_cons", "ARMA:L.ar", "ARMA:L.ma", "sigma:_cons"],
  );
});

test("arima stops where Stata stops when the gradient tolerance holds it back", () => {
  // At the fourth iteration the change in the log likelihood and the
  // scaled gradient are small enough, but gradient x coefficient is not
  // (arima's gtolerance(.05)); Stata goes on to a fifth, under BFGS.
  const session = run(`clear
set seed 2024
set obs 150
generate t = tm(2000m1) + _n - 1
format t %tm
tsset t
generate double e = invnormal(runiform())
generate double y = 0
replace y = .7*y[_n-1] + e - .4*e[_n-1] in 2/l
generate double x = runiform()
replace y = y + x + 5
replace y = . in 50
arima y, ar(1)
`);
  [5.54289460856698, 0.434271821945015, 1.07743533631894].forEach((v, j) =>
    close(session.estimates.b[j], v, 6, `b[${j}]`),
  );
  assert.equal(session.results.e.ic, 5);
  assert.equal(session.results.e.N_gaps, 1);
  assert.equal(session.results.e.N, 149);
});

test("pperron's statistics and returned results", () => {
  const session = run(`${QUARTERS}pperron z\n`),
    r = session.results.r;
  assert.equal(r.N, 119);
  assert.equal(r.lags, 4);
  close(r.Zrho, -10.14070788512818, 10, "r(Zrho)");
  close(r.Zt, -2.213869942477729, 10, "r(Zt)");
  close(r.pval, 0.2012500353162922, 10, "r(pval)");
  assert.deepEqual(r["matrix:cvalues"].rowNames, ["Z(rho)", "Z(t)"]);
  const trend = run(`${QUARTERS}pperron z, trend regress\n`).results.r;
  close(trend.Zrho, -12.10582043557034, 10, "r(Zrho)");
  close(trend.Zt, -2.695988975194651, 10, "r(Zt)");
  close(trend.pval, 0.2377517475631858, 10, "r(pval)");
  assert.deepEqual(trend["matrix:table"].colNames, ["L.z", "_trend", "_cons"]);
});

test("var's estimates, residual covariance and fit statistics", () => {
  const session = run(`${QUARTERS}var y x\n`),
    e = session.results.e,
    model = session.estimates;
  close(e.ll, -338.9672080672855, 10, "e(ll)");
  close(e.aic, 5.914698441818398, 10, "e(aic)");
  close(e.hqic, 6.010035699740917, 10, "e(hqic)");
  close(e.sbic, 6.149502223552776, 10, "e(sbic)");
  close(e.fpe, 1.27003677519299, 10, "e(fpe)");
  close(e.detsig_ml, 1.071921447712293, 10, "e(detsig_ml)");
  close(e.rmse_1, 1.182129155725081, 10, "e(rmse_1)");
  close(e.r2_2, 0.4214593925890729, 10, "e(r2_2)");
  close(e.ll_1, -184.6236628331644, 10, "e(ll_1)");
  close(e.chi2_1, 44.13818789483325, 10, "e(chi2_1)");
  close(e.chi2_2, 85.96148254496984, 10, "e(chi2_2)");
  close(e.p_1, 6.00543977037e-9, 6, "e(p_1)");
  assert.equal(e.N, 118);
  assert.equal(e.df_eq, 5);
  assert.equal(e.mlag, 2);
  assert.equal(e.tmin, 122);
  assert.equal(e.tmax, 239);
  [
    0.530148540317003, -0.065284751559026, 0.0581025097569127,
    0.0842519507885161, 0.0182680401351304, 0.283389279005252,
    -0.0564294820108391, 0.496685035208741, 0.0751628362292683,
    -0.0185765389624942,
  ].forEach((v, j) => close(model.b[j], v, 10, `b[${j}]`));
  assert.deepEqual(model.names.slice(0, 5), [
    "y:L.y",
    "y:L2.y",
    "y:L.x",
    "y:L2.x",
    "y:_cons",
  ]);
});

test("varsoc's table of statistics", () => {
  const r = run(`${QUARTERS}varsoc y x\n`).results.r,
    stats = r["matrix:stats"];
  assert.equal(r.N, 116);
  assert.equal(r.mlag, 4);
  // r1 to r4, then the longest lag's row, which varsoc.ado names r1 again.
  assert.deepEqual(stats.rowNames, ["r1", "r2", "r3", "r4", "r1"]);
  const expected = [
    [
      0,
      -383.306198223735,
      missingValue("b"),
      missingValue("b"),
      missingValue("b"),
      2.63124478271899,
      6.64321031420232,
      6.66248273359052,
      6.69068600715243,
    ],
    [
      1, -336.384654513746, 93.8430874199769, 4, 2.0079980375274e-19,
      1.25539798097845, 5.90318369851287, 5.96100095667746, 6.04561077736319,
    ],
    [
      2, -335.076369144224, 2.61657073904439, 4, 0.623890513664057,
      1.31514290680144, 5.94959257145214, 6.04595466839313, 6.18697103620269,
    ],
    [
      3, -332.59445921983, 4.96381984878735, 4, 0.291029991860132,
      1.35027198347107, 5.97576653827294, 6.11067347399032, 6.3080963889237,
    ],
    [
      4, -330.953660679735, 3.28159708019007, 4, 0.511853313856222,
      1.40679387926691, 6.01644242551268, 6.18989420000645, 6.44372366206366,
    ],
  ];
  expected.forEach((row, i) =>
    row.forEach((v, j) => {
      if (v >= missingValue("")) assert.equal(stats.values[i][j], v);
      else close(stats.values[i][j], v, 9, `stats[${i},${j}]`);
    }),
  );
});

test("vargranger's small-sample F tests", () => {
  const session = run(`clear
set seed 77
set obs 120
generate t = tq(1990q1) + _n - 1
format t %tq
tsset t
generate double e1 = invnormal(runiform())
generate double e2 = invnormal(runiform())
generate double y = 0
generate double x = 0
replace y = .5*y[_n-1] + .2*x[_n-1] + e1 in 2/l
replace x = .3*y[_n-1] + .4*x[_n-1] + e2 in 2/l
quietly var y x, small
vargranger
`),
    gstats = session.results.r["matrix:gstats"];
  assert.deepEqual(gstats.rowNames, ["y:x", "y:ALL", "x:y", "x:ALL"]);
  assert.deepEqual(gstats.colNames, ["F", "df", "df_r", "p"]);
  close(gstats.values[0][0], 1.22476084039521, 10, "F");
  close(gstats.values[0][3], 0.297698237707322, 10, "p");
  close(gstats.values[2][0], 1.59603997396318, 10, "F");
  close(gstats.values[2][3], 0.207232723492986, 10, "p");
  assert.equal(gstats.values[1][2], 113);
});

test("options arima and var do not have are refused with r(198)", () => {
  for (const [command, pattern] of [
    ["arima y, sarima(1,0,0,12)", /sarima is not available/],
    ["arima y, ar(1) condition", /condition is not available/],
    ["arima y, ar(1) diffuse", /diffuse is not available/],
    ["arima y x, ar(1) vce(cluster t)", /not allowed/],
    ["var y x, lutstats", /lutstats is not available/],
    ["var y x, constraints(1)", /constraints is not available/],
  ]) {
    const result = run(ARMA).run(command),
      last = result.output.at(-1);
    assert.equal(result.rc, 198, command);
    assert.match(last.lines.join("\n"), pattern, command);
  }
});

test("predict after other models is untouched by arima's and var's", () => {
  const session = run(`${ARMA}regress y x\npredict fit\n`);
  assert.equal(session.data.get("fit").label, "Fitted values");
  session.run("arima y x, ar(1) nolog\npredict a\nregress y x\npredict b, xb");
  assert.equal(session.data.get("a").label, "xb prediction, one-step");
  assert.equal(session.data.get("b").label, "Linear prediction");
});

test("arima and var on 10,000 observations stay quick enough for a worker", () => {
  const session = run(`clear
set seed 1
set obs 10000
generate t = _n
tsset t
generate double e = invnormal(runiform())
generate double x = runiform()
generate double w = runiform()
generate double y = 0
replace y = .5*y[_n-1] + .2*y[_n-2] + e + .3*e[_n-1] - .2*e[_n-2] in 3/l
replace y = y + x
`);
  for (const command of [
    "arima y x, arima(2,0,2) nolog",
    "arima y, ar(1/12) nolog",
    "var y x w, lags(1/4)",
    "varsoc y x w, maxlag(8)",
  ]) {
    const start = performance.now();
    session.run(command);
    const elapsed = performance.now() - start;
    // Under 2 seconds in a browser worker; the bound here leaves room for
    // a slow test machine.
    assert.ok(elapsed < 4000, `${command} took ${elapsed.toFixed(0)} ms`);
  }
});
