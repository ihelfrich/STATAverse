// The eighth pass's time-series repairs: dfuller over gaps, missing values,
// if and in, and on operated series; varstable, varwle, varnorm and
// varlmar after var; time-series operators typed in lower case, chained
// with periods, and in summarize, list and correlate; arima and stcox under
// by. Their printed text is compared line by line in
// tests/runtime-output.test.mjs (the pass8-ts-* cases); this file checks
// the stored results at full precision and the refusals. Every expected
// value was recorded from Stata 19 MP (version 17, set processors 1) on
// the same generated data, which runiform() reproduces draw for draw.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { missingValue } from "../src/runtime/values.js";

const AR = `clear
set seed 7
set obs 200
generate t = _n
tsset t
generate double e = invnormal(runiform())
generate double y = e in 1
replace y = .4*y[_n-1] + e in 2/l
generate double x = sum(invnormal(runiform()))
replace y = . in 77
`;
const VAR = `clear
set seed 7
set obs 200
generate t = _n
tsset t
generate double e1 = invnormal(runiform())
generate double e2 = invnormal(runiform())
generate double y = e1
generate double w = e2
replace y = .5*y[_n-1] + .1*w[_n-1] + e1 in 2/l
replace w = .2*y[_n-1] + .3*w[_n-1] + e2 in 2/l
generate double x = runiform()
`;

function run(source) {
  const session = new Session(),
    result = session.run(source),
    failed = result.output.find((o) => o.rc);
  assert.equal(failed?.lines.join("\n"), undefined, failed?.command);
  return session;
}
/** The error a do-file stops at: its message, without r(#), and code. */
function failure(source) {
  const result = new Session().run(source),
    failed = result.output.find((o) => o.rc);
  assert.ok(failed, "the command should fail");
  return [
    failed.lines.filter((line) => !/^r\(\d+\);$/.test(line)).join("\n"),
    failed.rc,
  ];
}
/** Agreement to the number of significant digits asked for. */
function close(actual, expected, digits = 10, what = "") {
  const scale = Math.max(Math.abs(expected), 1e-300),
    error = Math.abs(actual - expected) / scale;
  assert.ok(
    error < 0.5 * 10 ** -digits,
    `${what} ${actual} differs from Stata's ${expected}`,
  );
}
const matrix = (session, name) => session.results.r[`matrix:${name}`];

test("dfuller drops only the observations a missing value or gap touches", () => {
  let r = run(`${AR}dfuller y\n`).results.r;
  assert.equal(r.N, 197);
  close(r.Zt, -8.733671523171628, 12, "Zt");
  close(r.p, 3.14203661102e-14, 9, "p");
  close(r.cv_1, -3.477666666666666, 12, "cv_1");
  close(r.cv_5, -2.883533333333333, 12, "cv_5");
  close(r.cv_10, -2.573533333333333, 12, "cv_10");
  r = run(`${AR}dfuller y in 100/200, lags(2) trend\n`).results.r;
  assert.equal(r.N, 101);
  close(r.Zt, -5.206807927220687, 12, "Zt");
  close(r.p, 0.000085027373439, 9, "p");
  close(r.cv_1, -4.039666666666666, 12, "cv_1");
  r = run(`${AR}drop in 50\ndfuller y\n`).results.r;
  assert.equal(r.N, 195);
  close(r.Zt, -8.614750692117223, 12, "Zt");
  close(r.p, 6.33472292406e-14, 9, "p");
});

test("dfuller takes time-series operators, as pperron does", () => {
  let r = run(`${AR}dfuller D.x, drift regress lags(1)\n`).results.r;
  assert.equal(r.N, 197);
  close(r.Zt, -9.75308256515801, 12, "Zt");
  assert.equal(r.p, 0);
  close(r.cv_1, -2.345722805784541, 12, "cv_1");
  const table = r["matrix:table"].values;
  close(table[0][0], -1.018042445939132, 12, "b[LD.x]");
  close(table[1][0], 0.1043816084953484, 12, "se[LD.x]");
  close(table[0][2], 0.0615613861321488, 12, "b[_cons]");
  r = run(`${AR}dfuller l.y, noconstant\n`).results.r;
  assert.equal(r.N, 196);
  close(r.Zt, -8.623203626401683, 12, "Zt");
  close(r.cv_5, -1.95, 12, "cv_5");
  assert.equal(r.p, undefined);
});

test("dfuller refuses what Stata refuses, with its messages", () => {
  assert.deepEqual(failure(`${AR}dfuller y, trend noconstant\n`), [
    "cannot choose trend if constant is excluded",
    198,
  ]);
  assert.deepEqual(failure(`${AR}dfuller y, lags(101)\n`), [
    "DL(1/101)\nnumlist in operator invalid",
    198,
  ]);
  assert.deepEqual(failure(`${AR}dfuller y, lags(99)\n`), [
    "too many time-series operators",
    1000,
  ]);
  assert.deepEqual(failure(`${AR}xtset, clear\ndfuller y\n`), [
    "time variable not set, use tsset varname ...",
    111,
  ]);
  // On panel data the sample must come from one panel.
  assert.deepEqual(
    failure(`${AR}generate id = 1 + (t > 100)\nxtset id t\ndfuller x\n`),
    ["sample may not include multiple panels", 459],
  );
  run(`${AR}generate id = 1 + (t > 100)\nxtset id t\ndfuller x if id == 2\n`);
});

test("varstable, varwle, varnorm and varlmar give Stata's results after var", () => {
  const session = run(`${VAR}quietly var y w, lags(1/2)\nvarstable, amat(A)\n`);
  const re = matrix(session, "Re"),
    im = matrix(session, "Im"),
    modulus = matrix(session, "Modulus");
  assert.deepEqual(re.rowNames, ["real"]);
  assert.deepEqual(im.rowNames, ["complex"]);
  assert.deepEqual(modulus.rowNames, ["r1"]);
  [
    0.4372190795170161, 0.4372190795170161, -0.1741648476389416,
    0.08944063873915198,
  ].forEach((v, j) => close(re.values[0][j], v, 11, `Re[${j}]`));
  [0.03496099387134289, -0.03496099387134289, 0, 0].forEach((v, j) =>
    v
      ? close(im.values[0][j], v, 11, `Im[${j}]`)
      : assert.equal(im.values[0][j], 0),
  );
  close(modulus.values[0][0], 0.4386146310671578, 11, "Modulus[0]");
  assert.deepEqual(session.matrices.get("A").values.slice(2), [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ]);
  run(`${VAR}quietly var y w, lags(1/2)\nvarwle\n`);
  const after = (command) =>
    run(`${VAR}quietly var y w, lags(1/2)\n${command}\n`);
  let s = after("varwle");
  [
    [64.79648001317376, 27.59801766375322, 90.58241040970768],
    [1.516509471159926, 0.2562620977987337, 1.783522401751712],
  ].forEach((row, i) =>
    row.forEach((v, j) =>
      close(matrix(s, "chi2").values[i][j], v, 11, `chi2[${i},${j}]`),
    ),
  );
  close(matrix(s, "p").values[1][2], 0.7754956129869415, 11, "p[2,3]");
  s = after("varnorm");
  const jb = matrix(s, "jb").values,
    skew = matrix(s, "skewness").values,
    kurt = matrix(s, "kurtosis").values;
  close(jb[0][0], 0.482144037557645, 11, "jb y");
  close(jb[2][0], 0.7249191827522161, 11, "jb all");
  assert.equal(jb[2][1], 4);
  close(jb[2][2], 0.9482206961585484, 11, "jb p");
  close(skew[0][0], 0.07559183057503122, 11, "skewness y");
  assert.equal(skew[2][0], missingValue("b"));
  close(kurt[1][0], 3.11817970968843, 11, "kurtosis w");
  close(kurt[2][1], 0.4088010787199076, 11, "kurtosis chi2");
  s = after("varlmar, mlag(3)");
  [
    [1, 2.971412008641587, 4, 0.5626208751933879],
    [2, 6.363259717969764, 4, 0.1736126223466099],
    [3, 5.613174938292119, 4, 0.2299589742591404],
  ].forEach((row, i) =>
    row.forEach((v, j) =>
      close(matrix(s, "lm").values[i][j], v, 10, `lm[${i},${j}]`),
    ),
  );
  s = run(`${VAR}quietly var y w, lags(1/2) small dfk exog(x)\nvarwle\n`);
  close(matrix(s, "F").values[0][0], 31.40069800385023, 11, "F[1,1]");
  close(matrix(s, "F").values[1][2], 0.3913609940119239, 11, "F[2,3]");
  s = run(`${VAR}quietly var y w, lags(1/2) small dfk exog(x)\nvarnorm\n`);
  close(matrix(s, "jb").values[0][0], 1.219166255203208, 10, "jb y");
});

test("var postestimation reads estimates() and refuses as Stata does", () => {
  const stored = `${VAR}quietly var y w, lags(1/2)\nestimates store v1\nquietly regress y w\nestimates store r1\n`;
  // estimates() restores the named fit for the command alone.
  const s = run(`${stored}varstable, estimates(v1)\n`);
  assert.equal(s.estimates.command, "regress");
  close(matrix(s, "Modulus").values[0][0], 0.4386146310671578, 11, "Modulus");
  assert.deepEqual(failure(`${stored}varstable, estimates(foo)\n`), [
    "could not restore estimates(foo)",
    111,
  ]);
  assert.deepEqual(failure(`${stored}varwle, estimates(r1)\n`), [
    "varwle only works after var, svar, ivsvar, and xtvar",
    198,
  ]);
  assert.deepEqual(failure(`${VAR}varstable\n`), [
    "could not restore estimates(.)",
    301,
  ]);
  assert.deepEqual(failure(`${VAR}varlmar\n`), [
    "cannot restore current estimates",
    498,
  ]);
  assert.deepEqual(failure(`${VAR}varnorm\n`), [
    "cannot restore estimates(.)",
    198,
  ]);
  const fitted = `${VAR}quietly var y w\n`;
  assert.deepEqual(failure(`${fitted}varlmar, mlag(0)\n`), [
    "mlag() invalid -- invalid number, outside of allowed range",
    125,
  ]);
  assert.deepEqual(failure(`${fitted}varlmar, mlag(1.5)\n`), [
    "mlag() invalid -- invalid number, noninteger value",
    126,
  ]);
  assert.deepEqual(failure(`${fitted}varlmar, mlag(1 2)\n`), [
    "mlag() invalid -- single number required",
    123,
  ]);
  assert.deepEqual(failure(`${fitted}varnorm, cholesky\n`), [
    "cholesky cannot be specified after var or ivsvar",
    198,
  ]);
  assert.deepEqual(failure(`${fitted}varstable, modlabel\n`), [
    "modlabel cannot be specified without graph",
    198,
  ]);
  // The graph is not drawn here; the refusal says so rather than ignoring it.
  assert.deepEqual(failure(`${fitted}varstable, graph\n`), [
    "option graph is not available in the browser yet",
    198,
  ]);
});

test("lower-case and chained operators work in expressions, if and varlists", () => {
  const s = run(
    `${VAR}generate double ly = l.y\ngenerate double s2 = s2.y\ngenerate double ldf = l.d.f.y\nsummarize ly s2 ldf\n`,
  );
  close(s.results.r.mean, -0.01178340437645441, 12, "mean of L.D.F.y");
  const t = run(`${VAR}summarize l2.y d.w\n`).results.r;
  close(t.mean, -0.0004694035765890424, 11, "mean of D.w");
  close(t.sd, 1.237605083909982, 12, "sd of D.w");
  const c = run(`${VAR}correlate y l.y d.w\n`).results.r;
  close(c.rho, 0.5476627835497042, 12, "rho");
  assert.deepEqual(c["matrix:C"].rowNames, ["y", "L.y", "D.w"]);
  close(c["matrix:C"].values[2][0], -0.00565784748380975, 11, "C[3,1]");
  // A stray missing value code is named as typed, as Stata names it.
  assert.deepEqual(failure(`${VAR}generate z = 1 .b\n`), [
    "invalid '.b' ",
    198,
  ]);
  assert.deepEqual(failure(`${VAR}generate z = q.y\n`), [
    "q:  operator invalid",
    198,
  ]);
  assert.deepEqual(failure(`${VAR}summarize L(1/101).y\n`), [
    "L(1/101)\nnumlist in operator invalid",
    198,
  ]);
  assert.deepEqual(failure(`${VAR}summarize D(-1).y\n`), [
    "D-1:  operator invalid",
    198,
  ]);
});

test("summarize, list and correlate leave no temporary variable behind", () => {
  const s = run(
    `${VAR}summarize L.y D.w\nlist L.y in 1/2\ncorrelate y L.y\ncapture noisily summarize L.y nosuch\n`,
  );
  assert.deepEqual(
    s.data.variables.map((v) => v.name),
    ["t", "e1", "e2", "y", "w", "x"],
  );
});

test("stcox and arima run under by, one model for each group", () => {
  const source = `clear
set seed 99
set obs 400
generate g = 1 + (_n > 200)
bysort g: generate t = _n
generate double x = invnormal(runiform())
generate double tm = -ln(runiform())/exp(.5*x)
generate dead = runiform() < .8
stset tm, failure(dead)
by g: stcox x, nolog
`;
  const s = run(source);
  // The last group's fit is the one left, as by leaves it.
  close(s.results.e.ll, -651.03405, 7, "e(ll)");
});

// ----- The second round of the eighth pass's time-series repairs -----

const PANELS = `clear
set seed 21
set obs 160
generate id = ceil(_n/40)
bysort id: generate t = _n
generate double y = invnormal(runiform())
by id: replace y = .6*y[_n-1] + y if _n > 1
generate double w = invnormal(runiform())
xtset id t
`;

test("arima, var and varsoc count panels after missing values; dfuller before", () => {
  const source = `${PANELS}replace y = . if id != 3\n`;
  let s = run(`${source}var y w\n`);
  assert.equal(s.results.e.N, 38);
  close(s.results.e.ll, -103.7057604886317, 12, "e(ll)");
  close(s.estimates.b[0], 0.779734532775022, 12, "L.y");
  s = run(`${source}varsoc y w, maxlag(2)\n`);
  close(matrix(s, "stats").values[2][6], 5.984513709927984, 12, "AIC");
  s = run(`${source}arima y, ar(1) nolog\n`);
  assert.equal(s.results.e.N, 40);
  assert.deepEqual(failure(`${source}dfuller y\n`), [
    "sample may not include multiple panels",
    459,
  ]);
  assert.equal(run(`${source}dfuller y if id == 3\n`).results.r.N, 39);
});

test("newey takes panel data, its lags within each panel", () => {
  let model = run(`${PANELS}newey y w, lag(2) force\n`).estimates;
  assert.equal(model.N, 160);
  close(model.b[0], 0.0464059397151583286, 12, "_b[w]");
  close(Math.sqrt(model.V[0][0]), 0.0810633088137731606, 12, "_se[w]");
  close(Math.sqrt(model.V[1][1]), 0.1449464584951923041, 12, "_se[_cons]");
  close(model.F, 0.3277166371597651229, 12, "F");
  model = run(
    `${PANELS}newey y w if id < 3 & t != 5, lag(1) force\n`,
  ).estimates;
  assert.equal(model.N, 78);
  close(Math.sqrt(model.V[0][0]), 0.1131208737592100805, 12, "_se[w]");
  // Several panels are not regularly spaced in time without force.
  assert.deepEqual(failure(`${PANELS}newey y w, lag(1)\n`), [
    "t is not regularly spaced",
    198,
  ]);
});

test("operators are refused where Stata refuses them", () => {
  const source = `clear
set obs 40
generate t = _n
tsset t
generate double x = mod(_n, 7)
generate double y = x + mod(_n, 3)
`;
  for (const [command, message] of [
    ["regress y D(-1).x", "D-1:  operator invalid"],
    ["regress y S(-1).x", "S-1:  operator invalid"],
    ["newey y D(-1).x, lag(1)", "D-1:  operator invalid"],
    ["regress y L(1/2)D(0/1).x", "L1D(0/1):  operator invalid"],
    ["summarize L(0/1)F(1/2).x", "L0F(1/2):  operator invalid"],
    ["summarize D(-1)L(1/2).x", "D-1L(1/2):  operator invalid"],
  ])
    assert.deepEqual(failure(`${source}${command}\n`), [message, 198], command);
  // A step in the numlist, and a list of variables in parentheses.
  assert.equal(run(`${source}regress y L(1(1)3).x\n`).results.e.N, 37);
  assert.deepEqual(run(`${source}regress y L(1/2).(x y)\n`).estimates.names, [
    "L.x",
    "L2.x",
    "L.y",
    "L2.y",
    "_cons",
  ]);
});

test("operators need data sorted by time, and stay within by's groups", () => {
  const source = `clear
set obs 12
generate t = _n
generate g = ceil(t/4)
generate double x = mod(_n * 7, 11)
tsset t
`;
  for (const command of [
    "sort x\nsummarize L.x",
    "sort x\ngenerate z = L.x",
    "sort x\nregress x L.x",
    "bysort g: summarize L.x",
    "bysort g (t): generate z = L.x",
  ]) {
    // Under by, Stata stops after the first group's heading.
    const [message, code] = failure(`${source}${command}\n`);
    assert.equal(message.split("\n").at(-1), "not sorted", command);
    assert.equal(code, 5, command);
  }
  const s = run(`${source}by t: generate z = L.x\nsort x\ntsset\n`);
  assert.ok(s.data.get("z").data.every((v) => v === missingValue()));
  assert.deepEqual(s.data.sortedBy, ["t"]);
});

test("arima, dfuller, pperron, corrgram and ac leave the data sorted by time", () => {
  for (const command of [
    "dfuller y",
    "pperron y",
    "corrgram y, lags(2)",
    "ac y, lags(2) nodraw",
    "arima y, ar(1) nolog",
    "bysort g: arima y, ar(1) nolog",
  ]) {
    const s = run(`${VAR}generate g = mod(_n, 2)\nsort y\n${command}\n`);
    assert.deepEqual(s.data.sortedBy, ["t"], command);
    assert.deepEqual(
      Array.from(s.data.get("t").data.slice(0, 3)),
      [1, 2, 3],
      command,
    );
  }
  // var and varsoc leave the order alone.
  let s = run(`${VAR}sort x\nvar y w\nvarsoc y w\n`);
  assert.deepEqual(s.data.sortedBy, ["x"]);
  // _ts sorts before it refuses several panels, so by id: works after.
  for (const command of [
    "capture dfuller y",
    "capture bysort g: arima y, ar(1)",
  ]) {
    s = new Session();
    s.run(`${PANELS}generate g = ceil(id/2)\nsort w\n${command}\n`);
    assert.deepEqual(s.data.sortedBy, ["id", "t"], command);
  }
});

test("test, lincom and testparm read operators as Stata names them", () => {
  const source = `clear
set seed 77
set obs 120
generate t = _n
generate double x = invnormal(runiform())
generate double y = invnormal(runiform())
tsset t
`;
  let s = run(
    `${PANELS}replace y = . if id != 3\nregress y L(1/2).w\ntestparm L(1/2).w\n`,
  );
  close(s.results.r.F, 0.3211310050357656931, 12, "F");
  close(s.results.r.p, 0.7274426392647808104, 11, "p");
  s = run(
    `${PANELS}replace y = . if id != 3\nregress y L(1/2).w\nlincom l.w + l2.w\n`,
  );
  close(s.results.r.estimate, -0.1739667923749537992, 12, "estimate");
  close(s.results.r.se, 0.2638261197398391045, 12, "se");
  s = run(`${source}regress y L(1/3).x\ntest l2.x = l3.x\n`);
  assert.equal(s.results.r.df, 1);
  assert.deepEqual(failure(`${source}regress y L.x\nlincom l2.x\n`), [
    "regressor L2.x not found",
    111,
  ]);
});

test("dfuller and pperron on two or three observations leave Z(t) missing", () => {
  const source = `clear
set seed 11
set obs 150
generate t = _n
generate double y = sum(invnormal(runiform()))
tsset t
`;
  let r = run(`${source}dfuller y in 1/3\n`).results.r;
  assert.equal(r.N, 2);
  assert.equal(r.Zt, missingValue());
  assert.equal(r.p, 1);
  r = run(`${source}pperron y in 1/4, trend\n`).results.r;
  assert.equal(r.N, 3);
  assert.equal(r.Zt, missingValue());
  assert.equal(r.pval, 1);
  r = run(`${source}dfuller y in 1/3, noconstant\n`).results.r;
  close(r.Zt, -1.411368973923135, 12, "Zt");
  assert.deepEqual(failure(`${source}dfuller y in 1/2\n`), [
    "insufficient observations",
    2001,
  ]);
  // The shortest abbreviations of noconstant: nocon and noc.
  run(`${source}dfuller y, nocon\npperron y, noc\n`);
});

test("an operator on a string variable in an expression is missing", () => {
  const s = run(`clear
set obs 8
generate t = _n
generate x = _n*10
generate str3 sv = "ab"
tsset t
generate z1 = L.sv
generate z2 = l..x
rename t time
summarize L.x
`);
  assert.ok(s.data.get("z1").data.every((v) => v === missingValue()));
  assert.deepEqual(Array.from(s.data.get("z2").data.slice(1, 3)), [10, 20]);
  assert.equal(s.panel.time, "time");
});
