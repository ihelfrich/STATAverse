// Recheck, describe group, second pass: regress's older syntax for two-stage
// least squares, parentheses in a varlist, level() and the names of mean,
// total and proportion under bootstrap and jackknife, estat sd and e(V_srs)
// after svy: mean, over() of factor values, sdtest's and sdtesti's checks,
// proportion over(), ereturn display and the base of ib2.g. The expected
// values were recorded from Stata 19 (version 17, set processors 1) in batch
// mode.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const run = (source) => {
  const session = new Session(),
    output = session.run(source).output;
  return { session, output };
};
const near = (actual, expected, tolerance = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} is not ${expected}`,
  );
const IV = [
  "clear",
  "set obs 40",
  "set seed 31",
  "generate y = runiform()",
  "generate x = runiform()",
  "generate z = runiform()",
  "generate g = 1 + floor(3*runiform())",
  "generate t = _n",
].join("\n");
const MEANS = [
  "clear",
  "set obs 60",
  "set seed 12345",
  "generate y = round(50 + 10*runiform(), 0.01)",
  "generate x = round(20 + 5*runiform(), 0.01)",
  "generate g = 1 + floor(3*runiform())",
  "generate h = runiform() > .5",
  "generate w = 1 + floor(4*runiform())",
  "generate pw = 0.5 + runiform()",
  'label define gl 1 "North" 2 "South" 3 "West"',
  "label values g gl",
  "replace y = . in 5",
].join("\n");
// The code each command stopped with, or 0.
const codes = (setup, commands) => {
  const { session } = run(setup);
  return commands.map((command) => {
    session.run(`capture ${command}`);
    return session.run("display _rc").output.at(-1).lines.join("").trim();
  });
};

test("regress y x (z) fits two-stage least squares as Stata's regress does", () => {
  const { session } = run(`${IV}\nregress y x (z)`);
  const e = session.results.e,
    model = session.estimates;
  // Stata 19: x .3056317 (.4967674), _cons .3608031 (.2292253), F(1, 38)
  // = .3785214738461642, R-squared missing, model sum of squares
  // -.161149938431886.
  near(model.b[0], 0.3056317);
  near(Math.sqrt(model.V[0][0]), 0.4967674);
  near(model.b[1], 0.3608031);
  near(e.F, 0.3785214738461642, 1e-12);
  near(e.mss, -0.161149938431886, 1e-12);
  assert.equal(e.model, "iv");
  assert.equal(e.cmd, "regress");
  assert.equal(e.predict, "regriv_p");
  assert.ok(e.r2 >= 8.98e307, "e(r2) is missing");
  assert.equal(e.rank, 2);
  // With the regressor among the instruments it is least squares.
  const ols = run(`${IV}\nregress y x (z x)`).session.estimates;
  near(ols.b[0], 0.0576592);
  near(Math.sqrt(ols.V[0][0]), 0.1597113);
});

test("regress's group of instruments has Stata's messages", () => {
  assert.deepEqual(
    codes(IV, [
      "regress y (x)",
      "regress y (z) x",
      "regress y x (z) (g)",
      "regress y x t (z)",
      "regress y x (1.g)",
      "regress y x L.y (z)",
      "regress y x (z), hc2",
      "regress y x (z), vce(unadjusted)",
      "regress y x (z), cluster(g) beta",
      "regress y x (z), noconstant",
    ]),
    ["198", "198", "198", "481", "101", "111", "198", "198", "184", "198"],
  );
});

test("a name before parentheses is read as Stata reads it", () => {
  const setup = `${IV}\ngenerate b = y > .5\nxtset g`;
  assert.deepEqual(
    codes(setup, [
      "summarize y detail(1)",
      "xtreg y x fe(1)",
      "correlate y x cov(1)",
      "summarize y ar(1)",
      "summarize y x sep(2)",
      "summarize y x foo(2)",
      "summarize y (x",
      "correlate y by(x)",
      "correlate y cov(x)",
      "correlate (y x)",
      "tabulate (g)",
      "tabulate g b(1)",
    ]),
    [
      "111",
      "111",
      "198",
      "198",
      "198",
      "198",
      "132",
      "101",
      "198",
      "0",
      "0",
      "101",
    ],
  );
});

test("mean, total and proportion take their own level() under vce(bootstrap) and vce(jackknife)", () => {
  const { output } = run(
    `${MEANS}\nmean y, vce(jackknife, nodots) level(90)\ntotal y, vce(bootstrap, reps(5) seed(1) nodots) level(90)`,
  );
  // Stata 19: [90% conf. interval] 54.00136 55.3183 and 3198.681 3251.179.
  assert.ok(
    output
      .at(-2)
      .lines.includes(
        "           y |   54.65983   .3939246      54.00136     55.3183",
      ),
  );
  assert.ok(
    output
      .at(-1)
      .lines.includes(
        "           y |    3224.93   15.95806      3198.681    3251.179",
      ),
  );
  assert.deepEqual(
    codes(MEANS, [
      "bootstrap, reps(5) seed(1) nodots level(80): mean y, level(90)",
    ]),
    ["198"],
  );
});

test("after bootstrap, mean's e(b) names its estimates alone", () => {
  const { session } = run(
    `${MEANS}\nmean y x, vce(bootstrap, reps(5) seed(1) nodots)\nlincom y - x`,
  );
  const shown = session.run("matrix list e(b)").output.at(-1).lines;
  assert.ok(!shown.some((line) => /Mean:/.test(line)));
});

test("estat sd after svy: mean, over() and e(V_srs), as Stata 19 computes them", () => {
  const { session, output } = run(
    `${MEANS}\nsvyset [pw=pw], strata(h)\nsvy: mean y x, over(g)\nestat sd`,
  );
  const e = session.results.e;
  // Stata 19: e(_N) = 15 23 21 15 23 21; e(V_srs)[1,1] .74314318,
  // [4,1] -.07994049, [6,6] .10105963.
  assert.deepEqual(e["matrix:_N"].values, [[15, 23, 21, 15, 23, 21]]);
  near(e["matrix:V_srs"].values[0][0], 0.74314318, 1e-8);
  near(e["matrix:V_srs"].values[3][0], -0.07994049, 1e-8);
  near(e["matrix:V_srs"].values[5][5], 0.10105963, 1e-8);
  // North 3.338734, South 2.273238, West 3.429097.
  const sd = session.results.r["matrix:sd"].values[0];
  near(sd[0], 3.338734, 1e-6);
  near(sd[1], 2.273238, 1e-6);
  near(sd[2], 3.429097, 1e-6);
  assert.ok(output.at(-1).lines.some((line) => /Over/.test(line)));
  // A subpopulation: y 3.102836, x 1.763757.
  const sub = run(
    `${MEANS}\nsvyset [pw=pw], strata(h)\nsvy, subpop(h): mean y x\nestat sd`,
  ).session;
  near(sub.results.r["matrix:sd"].values[0][0], 3.102836, 1e-6);
  near(sub.results.r["matrix:sd"].values[0][1], 1.763757, 1e-6);
  near(sub.results.e["matrix:V_srs"].values[0][0], 0.38510361, 1e-8);
});

test("over() of a noninteger or negative variable is r(452)", () => {
  const setup = `${IV}\ngenerate neg = g - 2`;
  assert.deepEqual(
    codes(setup, [
      "mean y, over(g x)",
      "total y, over(x)",
      "mean y, over(neg)",
      "ratio y/x, over(x)",
      "proportion g, over(x)",
    ]),
    ["452", "452", "452", "452", "452"],
  );
});

test("sdtest and sdtesti check as sdtest.ado and _ttest check do", () => {
  const setup = [
    "clear",
    "set obs 50",
    "set seed 4242",
    "generate y = round(55 + 12*runiform(), .1)",
    "generate x = round(50 + 10*runiform(), .1)",
    "generate arm = 1 + (runiform() > .5)",
    'generate str20 site = cond(runiform() > .5, "Downtown Clinic", "Uptown")',
  ].join("\n");
  assert.deepEqual(
    codes(setup, [
      "sdtest y, by(arm site)",
      "sdtest y x",
      "sdtest y == -1",
      "sdtest site == 3",
      "sdtest site == y",
      "sdtest y == site",
      "sdtesti 30 . 5 1 . 6",
      "sdtesti 30 . 5 40 . -6",
      "sdtesti . . 5 4",
      "sdtesti 30 . 5 . . 6",
      "sdtesti 1 . . 3",
      "sdtesti 1 . . 30 . 6",
    ]),
    [
      "103",
      "103",
      "411",
      "2000",
      "2000",
      "109",
      "499",
      "411",
      "416",
      "416",
      "0",
      "0",
    ],
  );
  const { output } = run("sdtesti 30 . 5 .5\nsdtesti 30 . 5 1234567");
  // Stata 19: chi2 in %8.4f, the hypothesis as typed or in %7.0g.
  assert.ok(
    output.at(-2).lines.some((line) => /chi2 = {2}2\.9e\+03$/.test(line)),
  );
  assert.ok(
    output
      .at(-1)
      .lines.some(
        (line) =>
          line ===
          "H0: sd = 1.2e+06                                 Degrees of freedom =       29",
      ),
  );
});

test("proportion over() estimates each level within each group", () => {
  const { session } = run(`${MEANS}\nproportion h, over(g)`);
  const model = session.estimates;
  // Stata 19: .7333333 (.1141798) for 0.h@1.g, e(rank) 3, e(N_over) 3.
  assert.equal(model.names[0], "0.h@1.g");
  near(model.b[0], 0.7333333);
  near(Math.sqrt(model.V[0][0]), 0.1141798);
  near(model.V[3][0], -0.01303704, 1e-8);
  assert.equal(session.results.e.rank, 3);
  assert.equal(session.results.e.N_over, 3);
  assert.equal(session.results.e.over, "g");
});

test("mean ib2.g posts the base in e(b) as 2b.g", () => {
  const { session } = run(`${MEANS}\nmean ib2.g y`);
  const e = session.results.e;
  assert.deepEqual(e["matrix:b"]?.colNames ?? session.estimates.names, [
    "1.g",
    "2b.g",
    "3.g",
    "y",
  ]);
  assert.deepEqual(e["matrix:error"].values, [[0, 5, 0, 0]]);
  assert.equal(e.varlist, "1.g 2b.g 3.g y");
  assert.equal(e.rank, 3);
});
