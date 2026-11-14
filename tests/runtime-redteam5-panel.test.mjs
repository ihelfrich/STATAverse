// areg and xtreg on panel data of the size a student brings. The output
// cases areg-absorbed-within, xtreg-collinear-within and xtsum-formats in
// tools/output-cases.txt compare the printed results with Stata's; these
// tests cover what text cannot: how long areg takes with thousands of
// absorbed categories, and a case whose corr(u_i, Xb) is zero up to
// rounding, so its printed sign is not comparable. Expected values were recorded from Stata 19 MP (version 17,
// set processors 1) on the same generated data.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

function numbers(s, command) {
  const out = s.run(command);
  assert.equal(out.rc, 0, JSON.stringify(out.output.at(-1)));
  return out.output.at(-1).lines.join(" ").trim().split(/\s+/).map(Number);
}
const close = (actual, expected, digits = 8) =>
  assert.ok(
    Math.abs(actual - expected) <=
      10 ** -digits * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );

test("areg absorbs 5,000 categories of 15,000 observations in well under a second", () => {
  const s = createConsoleSession();
  s.reset("");
  s.run(
    [
      "clear",
      "set seed 12345",
      "set obs 15000",
      "generate long id = ceil(_n/3)",
      "generate age = 20 + floor(runiform()*50)",
      "generate educ = 1 + floor(runiform()*4)",
      "generate income = 20000 + 500*age + 3000*invnormal(runiform()) + mod(id,37)*200",
    ].join("\n"),
  );
  const start = performance.now(),
    out = s.run("areg income age i.educ, absorb(id)"),
    elapsed = performance.now() - start;
  assert.equal(out.rc, 0);
  assert.ok(elapsed < 1000, `areg took ${elapsed.toFixed(0)} ms`);
  const lines = out.output[0].lines;
  assert.ok(lines.some((l) => l.includes("No. of categories =     5,000")));
  assert.ok(
    lines.includes(
      "F test of absorbed indicators: F(4999, 9996) = 2.552          Prob > F = 0.000",
    ),
  );
  const [bAge, seAge, bEduc, seEduc, cons, fAbsorb, rmse] = numbers(
    s,
    'display %20.0g _b[age] " " %20.0g _se[age] " " %20.0g _b[4.educ] " " %20.0g _se[4.educ] " " %20.0g _b[_cons] " " %20.0g e(F_absorb) " " %20.0g e(rmse)',
  );
  close(bAge, 501.347385275951126);
  close(seAge, 2.09089842300473805);
  close(bEduc, -49.0262010973426641);
  close(seEduc, 85.6835616979887931);
  close(cons, 23546.6377375762568);
  close(fAbsorb, 2.55210597269771666);
  close(rmse, 3012.35020453994775);
});

test("xtreg, fe omits a regressor made redundant by the indicators before it", () => {
  const s = createConsoleSession();
  s.reset("");
  s.run(
    [
      "clear",
      "set seed 4211",
      "set obs 450",
      "generate id = ceil(_n/3)",
      "bysort id: generate wave = _n",
      "generate age = 20 + floor(runiform()*40)",
      "by id: replace age = age[1] + wave - 1",
      "generate ai = 5000*invnormal(runiform())",
      "by id: replace ai = ai[1]",
      "generate female = mod(id, 2)",
      "generate double income = round(30000 + 200*age + 100*wave + 2000*female + ai + 9000*invnormal(runiform()))",
      "xtset id wave",
    ].join("\n"),
  );
  const out = s.run("xtreg income i.wave age, fe"),
    lines = out.output[0].lines;
  assert.equal(out.rc, 0);
  assert.equal(lines[0], "note: age omitted because of collinearity.");
  // Stata leaves out the between R-squared, which the fitted panel means,
  // all equal, cannot give.
  assert.equal(
    lines[7],
    "                                                              avg =        3.0",
  );
  assert.ok(lines.includes("         age |          0  (omitted)"));
  const [b2, se2, b3, cons, sigmaE, dfR] = numbers(
    s,
    'display %20.0g _b[2.wave] " " %20.0g _se[2.wave] " " %20.0g _b[3.wave] " " %20.0g _b[_cons] " " %20.0g e(sigma_e) " " %20.0g e(df_r)',
  );
  close(b2, 577.439999999998236);
  close(se2, 1049.39598534583365);
  close(b3, 1503.03999999999678);
  close(cons, 38163.4000000000015);
  close(sigmaE, 9088.03581938895331);
  assert.equal(dfR, 298);
});

// Round five, adversarial pass. Values recorded from Stata 19 MP (version 17,
// set processors 1) on the same generated data.
test("xtreg, fe with clustered standard errors is linear in the number of observations", () => {
  const s = createConsoleSession();
  s.reset("");
  s.run(
    [
      "clear",
      "set seed 5150",
      "set obs 40000",
      "generate long id = ceil(_n/4)",
      "bysort id: generate t = _n",
      "generate age = 20 + floor(runiform()*50)",
      "generate educ = 1 + floor(runiform()*4)",
      "generate income = 20000 + 500*age + 3000*invnormal(runiform()) + mod(id,37)*200",
      "xtset id t",
    ].join("\n"),
  );
  for (const command of [
    "xtreg income age i.educ, fe vce(robust)",
    "xtreg income age i.educ, fe vce(cluster id)",
  ]) {
    const start = performance.now(),
      out = s.run(command),
      elapsed = performance.now() - start;
    assert.equal(out.rc, 0);
    // It took 7 to 10 seconds when the grand mean was recomputed for every
    // observation.
    assert.ok(elapsed < 2000, `${command} took ${elapsed.toFixed(0)} ms`);
  }
  const [bAge, seAge, b4, se4, cons, seCons, F] = numbers(
    s,
    'display %20.0g _b[age] " " %20.0g _se[age] " " %20.0g _b[4.educ] " " %20.0g _se[4.educ] " " %20.0g _b[_cons] " " %20.0g _se[_cons] " " %20.0g e(F)',
  );
  close(bAge, 498.263459129388764);
  close(seAge, 1.18391751210930463);
  close(b4, 41.0579327139973032);
  close(se4, 48.5161864348251299);
  close(cons, 23691.0878686687356);
  close(seCons, 60.0092336848156833);
  close(F, 44299.7742561821578);
});
