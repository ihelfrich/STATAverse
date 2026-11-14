// Sixth red-team round, summaries group: what the recorded output cases in
// tools/output-cases.txt cannot compare, namely return codes and the r()
// results of correlate, pwcorr and ci means with weights. The values were
// recorded from Stata 19 MP (version 17, set processors 1).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const DATA = `clear
set seed 99
set obs 40
generate id = _n
generate y = 100*runiform()
generate x = y + 50*runiform()
generate z = runiform()
generate w = 1 + floor(4*runiform())
generate str5 name = "n" + string(_n)
replace y = . in 4
replace x = . in 9`;

const run = (source) => {
  const session = new Session(),
    result = session.run(source);
  return { session, result, r: session.results.r };
};
const rc = (command, data = DATA) =>
  Number(
    run(`${data}\ncapture ${command}\ndisplay _rc`).result.output.at(-1)
      .lines[0],
  );
const close = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} vs ${expected}`,
  );

test("return codes Stata 19 gives for weights, refusals and empty data", () => {
  // summarize refuses importance weights with detail as Stata does.
  assert.equal(rc("summarize y [iw=w], detail"), 101);
  assert.equal(rc("correlate y x [iw=w]"), 101);
  assert.equal(rc("correlate y x in 1/1"), 2001);
  assert.equal(rc("pwcorr y"), 102);
  assert.equal(rc("pwcorr name y"), 102);
  assert.equal(rc("pwcorr y x z, sidak bonferroni"), 198);
  assert.equal(rc("pwcorr y x z, star(100)"), 198);
  assert.equal(rc("pwcorr y x if id > 100"), 2000);
  assert.equal(rc("pwcorr y x z if id > 100"), 0);
  assert.equal(rc("pwcorr"), 0);
  assert.equal(rc("correlate name y x"), 0);
  // One-way tables refuse the two-way options; the abbreviations work.
  assert.equal(rc("tabulate id, row"), 198);
  assert.equal(rc("tabulate id, chi2"), 198);
  assert.equal(rc("tabulate w id, ch"), 0);
  assert.equal(rc("tabulate w id, r co ce nof"), 0);
  assert.equal(rc("tabulate w, su(y) nost noo nofr"), 0);
  assert.equal(rc("tabulate w, su(y) nom"), 198);
  assert.equal(rc("list y in 1/2, cl"), 198);
  assert.equal(rc("list y in 1/2, c"), 0);
  assert.equal(rc("codebook y if id > 100"), 2000);
  assert.equal(rc("codebook", `${DATA}\ndrop if _n > 0`), 2000);
  assert.equal(rc("codebook y", `${DATA}\ndrop if _n > 0`), 2000);
});

test("corr is correlate, not corrgram", () => {
  const { result } = run(`${DATA}\ncorr y x`);
  assert.equal(result.rc ?? 0, 0);
  assert.equal(result.output.at(-1).lines[0], "(obs=38)");
});

test("summarize with no variables in memory prints nothing", () => {
  const { result } = run("clear\nsummarize\nsummarize, detail");
  for (const entry of result.output.slice(1))
    assert.deepEqual(
      entry.lines.filter((line) => line.trim()),
      [],
      entry.command,
    );
});

test("correlate and pwcorr with frequency and analytic weights", () => {
  let { r } = run(`${DATA}\ncorrelate y x [fw=w]`);
  assert.equal(r.N, 96);
  close(r.rho, 0.8469815979381559723, "fw rho");
  ({ r } = run(`${DATA}\ncorrelate y x [aw=w], covariance`));
  assert.equal(r.N, 38);
  close(r.Var_1, 585.6181778071121471, "aw Var_1");
  close(r.cov_12, 643.2099024765600461, "aw cov_12");
  close(r.Var_2, 984.7884482306850487, "aw Var_2");
  ({ r } = run(`${DATA}\npwcorr y x z [fw=w], sig`));
  assert.equal(r.N, 96);
  close(r.rho, 0.8469815979381559723, "pwcorr rho");
  close(r["matrix:sig"].values[2][0], 0.9293826382952965481, "sig[3,1]");
  close(r["matrix:sig"].values[1][0], 1.55337114531e-27, "sig[2,1]");
  assert.equal(r["matrix:Nobs"].values[2][2], 103);
  assert.equal(r["matrix:Nobs"].values[1][0], 96);
});

test("ci means with analytic and frequency weights", () => {
  let { r } = run(`${DATA}\nci means y [aw=w], level(90)`);
  assert.equal(r.N, 39);
  close(r.mean, 46.33383445858955696, "aw mean");
  close(r.se, 3.878480770552222623, "aw se");
  close(r.lb, 39.79489250480611418, "aw lb");
  close(r.ub, 52.87277641237299974, "aw ub");
  ({ r } = run(`${DATA}\nci means y [fw=w]`));
  assert.equal(r.N, 100);
  close(r.mean, 46.33383445858955696, "fw mean");
  close(r.se, 2.402900808653733122, "fw se");
});

test("two observations correlate as Stata computes them", () => {
  // Stata 19: r(rho) is 1 - 2^-52 for 3, 7 against 5, 9, so pwcorr's
  // significance level is min(2 ttail(0, .), 1) = 1, not 0.
  const data = `clear
set obs 3
generate a = cond(_n == 1, 3, cond(_n == 2, 7, 2))
generate b = cond(_n == 1, 5, cond(_n == 2, 9, 1))`;
  let { r } = run(`${data}\ncorrelate a b in 1/2`);
  assert.equal(r.rho, 1 - 2 ** -52);
  ({ r } = run(`${data}\npwcorr a b in 1/2, sig`));
  assert.equal(r["matrix:sig"].values[1][0], 1);
});

test("correlate splits a wide matrix at the default linesize of 79", () => {
  // Stata 19 fits seven columns in 79; the eighth starts a second panel.
  const { result } = run(
    `${DATA}\ngenerate a1 = z\ngenerate a2 = z\ngenerate a3 = z\ncorrelate id y x z w a1 a2 a3`,
  );
  const lines = result.output.at(-1).lines,
    headers = lines.filter((line) => /^ {13}\|/.test(line));
  assert.deepEqual(headers, [
    "             |       id        y        x        z        w       a1       a2",
    "             |       a3",
  ]);
  assert.ok(lines.every((line) => line.length <= 79));
});

test("pwcorr and correlate abbreviate names as abbrev() does", () => {
  // Stata 19 keeps a name's trailing digits: mea~2019, measure~2019.
  const data = `clear
set seed 2
set obs 10
generate measurement_2019 = runiform()
generate x_variable_123456 = runiform()
generate v12345678901 = runiform()`;
  for (const command of ["pwcorr", "correlate"]) {
    const { result } = run(
      `${data}\n${command} measurement_2019 x_variable_123456 v12345678901`,
    );
    const lines = result.output.at(-1).lines.map((line) => line.trimEnd());
    for (const expected of [
      "             | mea~2019 x~123456 v12345~1",
      "measure~2019 |   1.0000",
      "x_var~123456 |   0.2410   1.0000",
      "v12345678901 |  -0.3070  -0.3297   1.0000",
    ])
      assert.ok(lines.includes(expected), `${command}: ${expected}`);
  }
});
