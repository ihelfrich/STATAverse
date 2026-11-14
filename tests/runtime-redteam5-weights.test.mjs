// Frequency, sampling and importance weights on logit, probit and poisson.
// The expected values were recorded from Stata 19 MP (version 17, set
// processors 1) on the same data, which runiform() reproduces draw for
// draw. The printed tables, the postestimation commands and the refusals
// are compared line by line in tests/runtime-output.test.mjs (cases
// weighted-binary-count-models, weighted-models-postestimation and
// weighted-models-samples-and-refusals); this file checks what text cannot:
// every estimate and standard error at full precision, e() and the
// refusals that differ from Stata on purpose.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { isMissing } from "../src/runtime/values.js";

const SETUP = [
  "clear",
  "set seed 4207",
  "set obs 300",
  "generate x1 = runiform() * 4",
  "generate x2 = invnormal(runiform())",
  "generate g = 1 + floor(runiform() * 4)",
  "generate d = runiform() < invlogit(-1 + .5 * x1 - .4 * x2)",
  "generate n = floor(-ln(runiform()) * exp(.2 + .3 * x1))",
  "generate fw = 1 + floor(runiform() * 3)",
  "generate pw = .5 + runiform() * 2",
  "generate cl = 1 + floor(runiform() * 25)",
].join("\n");

const CASES = [
  {
    command: "logit d x1 x2 [fweight=fw]",
    // [name, coefficient, standard error]
    coefficients: [
      ["x1", 0.47201743760221776, 0.080266007758463501],
      ["x2", -0.63207227512898723, 0.10570880853439098],
      ["_cons", -0.89461694966784433, 0.17690911041117993],
    ],
    e: {
      N: 589,
      ll: -370.28127361435179,
      ll_0: -408.07266700056272,
      chi2: 75.582786772421855,
      r2_p: 0.092609469935801436,
    },
    macros: { wtype: "fweight", wexp: "= fw", vce: "oim", chi2type: "LR" },
  },
  {
    command: "logit d x1 x2 [pweight=pw], vce(cluster cl)",
    coefficients: [
      ["x1", 0.46236853074241097, 0.1421681607312747],
      ["x2", -0.64173034336222634, 0.1768454535779744],
      ["_cons", -0.78646879500681521, 0.28256155718816345],
    ],
    e: {
      N: 300,
      ll: -285.85733384173483,
      ll_0: -313.47403312091723,
      chi2: 29.706990069227267,
      r2_p: 0.088098841885668189,
      N_clust: 25,
    },
    macros: {
      wtype: "pweight",
      wexp: "= pw",
      vce: "cluster",
      vcetype: "Robust",
      chi2type: "Wald",
    },
  },
  {
    command: "probit d x1 x2 [iweight=pw]",
    coefficients: [
      ["x1", 0.28490075049697561, 0.056667607183118598],
      ["x2", -0.39139133305222035, 0.071929733565747139],
      ["_cons", -0.48833296973028439, 0.12172596683484846],
    ],
    e: {
      N: 300,
      ll: -285.84129862075235,
      ll_0: -313.47403312091723,
      chi2: 55.265469000329745,
      r2_p: 0.088149995152887239,
    },
    macros: { wtype: "iweight", wexp: "= pw", vce: "oim", chi2type: "LR" },
  },
  {
    // poisson leaves no constant-only model under sampling weights.
    command: "poisson n x1 x2 [pweight=pw]",
    coefficients: [
      ["x1", 0.39892937098224907, 0.075621096030300011],
      ["x2", 0.05998238577810304, 0.12457590275223888],
      ["_cons", -0.11937705408227017, 0.17703926244637755],
    ],
    e: {
      N: 300,
      ll: -1044.3936904371058,
      ll_0: undefined,
      chi2: 30.198732833206673,
      r2_p: null,
    },
    macros: {
      wtype: "pweight",
      wexp: "= pw",
      vce: "robust",
      vcetype: "Robust",
      chi2type: "Wald",
    },
  },
  {
    command: "poisson n x1 x2 [fweight=fw], vce(cluster cl)",
    coefficients: [
      ["x1", 0.41934707667418081, 0.077094832037947023],
      ["x2", 0.040241183834299851, 0.11855337668860463],
      ["_cons", -0.15524927388161266, 0.18171599996123211],
    ],
    e: {
      N: 589,
      ll: -1417.7088944476343,
      ll_0: -1555.869018018547,
      chi2: 34.541487015149038,
      r2_p: 0.088799328202360139,
      N_clust: 25,
    },
    macros: { wtype: "fweight", wexp: "= fw", vce: "cluster" },
  },
  {
    command: "logit d x1 x2 [pw = 2*pw]",
    coefficients: [
      ["x1", 0.46236853074241097, 0.12384909596256355],
      ["x2", -0.64173034336222634, 0.16365892003899063],
      ["_cons", -0.78646879500681521, 0.25778047686500638],
    ],
    e: {
      N: 300,
      ll: -571.71466768346966,
      ll_0: -626.94806624183445,
      chi2: 27.189410884392711,
    },
    macros: { wtype: "pweight", wexp: "= 2*pw", vce: "robust" },
  },
];

const close = (actual, expected, what) =>
  assert.ok(
    Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
    `${what}: ${actual} vs Stata ${expected}`,
  );

for (const c of CASES)
  test(`weighted fit matches Stata 19: ${c.command}`, () => {
    const s = new Session();
    s.run(SETUP);
    const result = s.run(c.command);
    assert.equal(result.rc, 0, result.output.at(-1)?.lines.join("\n"));
    const model = s.estimates;
    for (const [name, b, se] of c.coefficients) {
      const k = model.names.indexOf(name);
      close(model.b[k], b, `_b[${name}]`);
      close(Math.sqrt(model.V[k][k]), se, `_se[${name}]`);
    }
    const e = s.results.e;
    for (const [key, value] of Object.entries(c.e))
      if (value === undefined) assert.ok(!(key in e), `e(${key}) is not set`);
      else if (value === null) assert.ok(isMissing(e[key]), `e(${key}) = .`);
      else close(e[key], value, `e(${key})`);
    for (const [key, value] of Object.entries(c.macros))
      assert.equal(e[key], value, `e(${key})`);
  });

test("weighted models refuse what Stata refuses, with its codes", () => {
  const s = new Session();
  s.run(SETUP);
  const rc = (command) => s.run(`capture ${command}\ndisplay _rc`);
  const code = (command) =>
    Number(rc(command).output.at(-1).lines.join("").trim());
  // Stata 19: aweights not allowed r(101); noninteger frequency weights
  // r(401); negative sampling weights r(402); weights with bootstrap r(101).
  assert.equal(code("logit d x1 [aweight=pw]"), 101);
  assert.equal(code("probit d x1 [fweight=pw]"), 401);
  assert.equal(code("poisson n x1 [pweight=pw-1]"), 402);
  assert.equal(code("logit d x1 [pw=pw], vce(bootstrap)"), 101);
  assert.equal(code("bootstrap, reps(5): logit d x1 [fw=fw]"), 101);
  assert.equal(code("logit d x1 [iw=-pw]"), 2001);
  // After sampling weights: no Pearson residuals r(135), no classification
  // or goodness-of-fit r(101), no likelihood-ratio test r(498).
  s.run("quietly logit d x1 x2 [pw=pw]\nestimates store full");
  assert.equal(code("predict r, residuals"), 135);
  assert.equal(code("estat classification"), 101);
  assert.equal(code("estat gof"), 101);
  s.run("quietly logit d x1 [pw=pw]");
  assert.equal(code("lrtest full"), 498);
  // After importance weights: no classification r(101), no residuals r(135).
  s.run("quietly logit d x1 x2 [iw=pw]");
  assert.equal(code("estat classification"), 101);
  assert.equal(code("predict r, residuals"), 135);
});

test("jackknife after frequency or importance weights is refused, not approximated", () => {
  // Stata 19 runs both (jackknife: logit d x1 [fw=fw] on 60 observations
  // gives _se[x1] = .1798259 with 114 degrees of freedom), leaving out a
  // frequency-weighted observation one unit at a time; leaving out whole
  // observations, as done here, gave .2887067. Refused until it matches.
  const s = new Session();
  s.run(SETUP);
  for (const w of ["fw=fw", "iw=pw"]) {
    const result = s.run(`jackknife, nodots: logit d x1 [${w}]`);
    assert.equal(result.rc, 198);
    assert.match(result.output.at(-1).lines.join("\n"), /not available yet/);
  }
});
