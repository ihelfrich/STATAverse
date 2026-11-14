// Maximum-likelihood fits on 50,000 observations converge as Stata's do:
// the same iteration log, step for step, the same estimates, and in well
// under a second each. Every expected line below was recorded from Stata 19
// MP (version 17, set processors 1) running the same do-file, whose data
// come from runiform(), which the runtime reproduces draw for draw. The
// text of the 15,000-observation fits in red-team findings U54 and U55 is
// compared with Stata's whole in the convergence-large-samples case of
// tools/output-cases.txt.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const DATA = `clear
set seed 4711
set obs 50000
gen age = 18 + floor(runiform()*60)
gen educ = 1 + floor(runiform()*4)
gen region = 1 + floor(runiform()*5)
gen inc = 20 + 0.6*age + 8*educ + 15*invnormal(runiform())
gen z = invnormal(runiform())
gen satisf = 1 + (z + 0.01*age > -1.2) + (z + 0.1*educ > -0.4) + (z > 0.4) + (z - 0.005*inc > 1.1)
gen hours = max(0, -20 + 0.15*age + 3*educ + 0.2*inc + 18*invnormal(runiform()))
gen employed = runiform() < invlogit(-3 + 0.02*age + 0.4*educ + 0.02*inc)
gen kids = floor(-ln(runiform()) * (0.5 + 0.02*age))
gen share = runiform()^(1 + 0.3*educ)
drop z`;

// The iteration log and the row of age, as Stata 19 printed them.
const STATA = {
  "ologit satisf age i.educ inc i.region": [
    [-69314.787, -69275.137, -69275.132],
    "age |   .0007849   .0005719     1.37   0.170    -.0003361    .0019058",
  ],
  "tobit hours age i.educ inc i.region, ll(0)": [
    [-161448.46, -156872.75, -156489.71, -156486.62, -156486.62],
    "age |   .1498969   .0059965    25.00   0.000     .1381436    .1616502",
  ],
  "tobit hours age i.educ, ll(0) ul(40)": [
    [-155434.86, -149619.51, -149038.11, -149021.64, -149021.62, -149021.62],
    "age |   .2719319   .0050524    53.82   0.000      .262029    .2818347",
  ],
  "glm employed age i.educ inc i.region, family(binomial)": [
    [-30197.78, -30190.55, -30190.549],
    "age |   .0206174   .0006861    30.05   0.000     .0192728    .0219621",
  ],
  "glm employed age i.educ inc, family(binomial) link(probit)": [
    [-30198.859, -30194.337, -30194.337],
    "age |   .0125173   .0004152    30.14   0.000     .0117034    .0133312",
  ],
  "glm employed age i.educ inc, family(binomial) link(cloglog)": [
    [-32149.687, -30247.687, -30239.779, -30239.777],
    "age |   .0131961    .000444    29.72   0.000     .0123258    .0140664",
  ],
  "glm kids age i.educ inc, family(poisson)": [
    [-76605.562, -75247.424, -75247.132, -75247.132],
    "age |    .019833   .0003181    62.34   0.000     .0192095    .0204565",
  ],
  "glm share age i.educ, family(binomial)": [
    [-25838.329, -25837.792, -25837.792],
    "age |  -.0000179   .0005346    -0.03   0.973    -.0010658    .0010299",
  ],
  "cloglog employed age i.educ inc i.region": [
    [-36620.077, -30290.371, -30238.926, -30238.908, -30238.908],
    "age |   .0132001   .0004441    29.73   0.000     .0123298    .0140704",
  ],
};

test("50,000-observation ML fits take Stata's steps to Stata's estimates", () => {
  const session = new Session();
  session.run(DATA);
  for (const [command, [log, age]] of Object.entries(STATA)) {
    const started = performance.now(),
      { output } = session.run(command),
      took = performance.now() - started,
      lines = output.flatMap((o) => o.lines).flatMap((l) => l.split("\n")),
      iterations = lines
        .filter((l) => /^Iteration \d+:/.test(l))
        .map((l) => Number(l.split("=")[1])),
      row = lines.find((l) => /^\s+age \|/.test(l))?.trim();
    assert.ok(
      !lines.some((l) => /convergence not achieved/.test(l)),
      `${command} did not converge`,
    );
    assert.deepEqual(iterations, log, command);
    assert.equal(row, age, command);
    // Generous, so that a slow machine does not fail it: each takes about
    // a tenth of a second.
    assert.ok(took < 5000, `${command} took ${Math.round(took)} ms`);
  }
});
