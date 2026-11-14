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

// ----- Second round: what a tester found with the weights above -----
// Recorded from Stata 19 MP (version 17, set processors 1). The printed
// tables are compared in tests/runtime-output.test.mjs (cases
// weighted-population-frequency-weights,
// weighted-models-levels-strings-and-variance,
// weighted-wide-statistics-and-few-clusters, estat-gof-hosmer-lemeshow and
// resampling-exponentiated-coefficients).

const POPULATION = [
  "clear",
  "input str12 state y x pop",
  '"A" 1 0.5 39500000',
  '"A" 0 0.5 29100000',
  '"B" 1 1.5 21500000',
  '"B" 0 1.5 19300000',
  '"C" 1 2.5 13000000',
  '"C" 0 2.5 12800000',
  '"D" 1 3.0 11700000',
  '"D" 0 3.0 10700000',
  "end",
].join("\n");

const fitted = (s, command) => {
  const result = s.run(command);
  assert.equal(result.rc, 0, result.output.at(-1)?.lines.join("\n"));
  const model = s.estimates,
    at = (name) => model.names.indexOf(name);
  return {
    b: (name) => model.b[at(name)],
    se: (name) => Math.sqrt(model.V[at(name)][at(name)]),
    e: s.results.e,
  };
};

test("frequency weights of population size multiply, not repeat, observations", () => {
  // A plain RangeError (Invalid array length) used to escape here: the
  // 157,600,000 frequencies were laid out as arrays.
  const s = new Session();
  s.run(POPULATION);
  const logit = fitted(s, "logit y x [fw=pop]");
  close(logit.b("x"), -0.110246127363336, "_b[x]");
  close(logit.se("x"), 0.0001672182583678562, "_se[x]");
  close(logit.b("_cons"), 0.334956848082459957, "_b[_cons]");
  close(logit.se("_cons"), 0.0002904928033877531, "_se[_cons]");
  assert.equal(logit.e.N, 157600000);
  close(logit.e.ll, -108417477.8695460409, "e(ll)");
  close(logit.e.ll_0, -108635033.3738761991, "e(ll_0)");
  close(logit.e.chi2, 435111.0086603164673, "e(chi2)");
  const poisson = fitted(s, "poisson y x [fw=pop]");
  close(poisson.b("x"), -0.0508637953247630809, "poisson _b[x]");
  close(poisson.se("x"), 0.0001141684444254112, "poisson _se[x]");
  close(poisson.e.ll, -137809057.6296392977, "poisson e(ll)");
  // Each frequency stands for an observation of its own under robust, and
  // the observations of a cluster add their weighted scores.
  const robust = fitted(s, "logit y x [fw=pop], vce(robust)");
  close(robust.se("x"), 0.0001671080114441066, "robust _se[x]");
  close(robust.se("_cons"), 0.0002901201010054984, "robust _se[_cons]");
  close(robust.e.chi2, 435243.34895946295, "robust e(chi2)");
  const clustered = fitted(s, "logit y x [fw=pop], vce(cluster state)");
  close(clustered.se("x"), 0.0289328299472425207, "cluster _se[x]");
  close(clustered.se("_cons"), 0.0419820974279162609, "cluster _se[_cons]");
  assert.equal(clustered.e.N_clust, 4);
  close(clustered.e.chi2, 14.51927251817801157, "cluster e(chi2)");
});

test("frequency weights reach the importance-weight estimates to full precision", () => {
  // Stata 19 gives the same digits for [fw=pop] and [iw=pop]; repeating
  // the observations lost them in the sixth digit.
  const s = new Session();
  s.run(
    [
      "clear",
      "set seed 5",
      "set obs 40",
      "generate x = runiform()*3",
      "generate g = 1 + floor(runiform()*3)",
      "generate y = runiform() < invlogit(-1 + x)",
      "generate c = floor(-ln(runiform())*exp(.5*x))",
      "generate pop = 1000 + floor(runiform()*500000)",
    ].join("\n"),
  );
  for (const w of ["fw", "iw"]) {
    const fit = fitted(s, `logit y x [${w}=pop]`);
    close(fit.b("x"), 1.88862170914424, `[${w}] _b[x]`);
    close(fit.b("_cons"), -1.97368219212841, `[${w}] _b[_cons]`);
    close(fit.e.ll, -4635357.56974777, `[${w}] e(ll)`);
  }
});

test("a string weight is a type mismatch, and sampling weights keep their variance", () => {
  const s = new Session();
  s.run(SETUP);
  s.run('generate str3 sw = "1"\ngenerate str5 s = "a"');
  const code = (command) =>
    Number(
      s
        .run(`capture ${command}\ndisplay _rc`)
        .output.at(-1)
        .lines.join("")
        .trim(),
    );
  // Stata 19: type mismatch r(109) for every weight type.
  for (const command of [
    "probit d x1 [iw=sw]",
    "poisson n x1 [fw=sw]",
    "logit d x1 [pw=sw]",
    "logit d x1 [pw=s]",
  ])
    assert.equal(code(command), 109, command);
  // Stata 19: "pweights not allowed with option vce(oim)" r(198) after
  // logit and probit; poisson fits with the conventional variance.
  assert.equal(code("logit d x1 [pw=pw], vce(oim)"), 198);
  assert.equal(code("probit d x1 [pw=pw], vce(opg)"), 198);
  const t = new Session();
  t.run(
    [
      "clear",
      "set seed 12",
      "set obs 40",
      "generate x = invnormal(runiform())",
      "generate z = invnormal(runiform())",
      "generate w = invnormal(runiform())",
      "generate y = runiform() < invlogit(.5 + x)",
      "generate cl = 1 + floor(runiform()*3)",
      "generate c = floor(-ln(runiform())*exp(.4*x))",
      "generate pw = .5 + runiform()",
    ].join("\n"),
  );
  const oim = fitted(t, "poisson c x [pw=pw], vce(oim)");
  close(oim.b("x"), 0.3754209644686795633, "_b[x]");
  close(oim.se("x"), 0.1999002658171235292, "_se[x]");
  close(oim.se("_cons"), 0.1922398033445286147, "_se[_cons]");
  close(oim.e.ll, -54.0581206726262522, "e(ll)");
  close(oim.e.chi2, 3.527039300812918388, "e(chi2)");
  assert.equal(oim.e.vce, "oim");
  assert.equal(oim.e.chi2type, "Wald");
  // Three clusters leave a variance of rank two: e(rank) 2, the model
  // test missing, its degrees of freedom one less for the constant.
  const few = fitted(t, "logit y x z w, vce(cluster cl)");
  assert.equal(few.e.rank, 2);
  assert.equal(few.e.df_m, 1);
  assert.ok(isMissing(few.e.chi2) && isMissing(few.e.p));
  close(few.se("x"), 0.4194745208639207301, "_se[x]");
  const nocons = fitted(t, "poisson c x z w, vce(cluster cl) nocons");
  assert.equal(nocons.e.rank, 2);
  assert.equal(nocons.e.df_m, 2);
  assert.ok(isMissing(nocons.e.chi2));
});

test("a factor level that only zero weights have is not in the model", () => {
  // Stata 19: the base is the lowest level left (2.g), with no note and no
  // row for level 1.
  const s = new Session();
  s.run(
    [
      "clear",
      "set seed 66",
      "set obs 300",
      "generate x = invnormal(runiform())",
      "generate g = 1 + floor(runiform()*4)",
      "generate y = runiform() < invlogit(.2 + .8*x - .2*g)",
      "generate pw = .3 + runiform()*2",
      "generate pw1 = cond(g == 1, 0, pw)",
    ].join("\n"),
  );
  const fit = fitted(s, "logit y x i.g [pw=pw1]");
  assert.deepEqual(s.estimates.names, ["x", "2b.g", "3.g", "4.g", "_cons"]);
  close(fit.b("x"), 0.5511955811596915833, "_b[x]");
  close(fit.se("x"), 0.1745701309012188951, "_se[x]");
  close(fit.b("3.g"), 0.0328007109241936976, "_b[3.g]");
  close(fit.se("3.g"), 0.3577505007457875141, "_se[3.g]");
  close(fit.b("4.g"), -0.1247958347915335137, "_b[4.g]");
  close(fit.b("_cons"), -0.5738960824968442065, "_b[_cons]");
  assert.equal(fit.e.N, 235);
  assert.equal(fit.e.rank, 4);
});

test("estat gof, group() is the Hosmer-Lemeshow test, ties and weights included", () => {
  const s = new Session();
  s.run(
    [
      "clear",
      "set seed 1234",
      "set obs 157",
      "generate x = round(runiform()*3, .5)",
      "generate z = floor(runiform()*5)",
      "generate y = runiform() < invlogit(-1 + x - .3*z)",
      "generate fw = 1 + floor(runiform()*6)",
      "generate iw = .1 + runiform()*2",
    ].join("\n"),
  );
  // [model, groups asked, r(m), r(chi2), r(df), r(N)] from Stata 19.
  const expected = [
    ["logit y x z", 2, 2, 0.081735, 0, 157],
    ["logit y x z [fw=fw]", 2, 2, 1.052066, 0, 580],
    ["logit y x z [iw=iw]", 2, 2, 0.507294, 0, 157],
    ["probit y x [fw=fw]", 2, 2, 0.100464, 0, 580],
    ["logit y x z", 7, 7, 3.941526, 5, 157],
    ["logit y x z [fw=fw]", 7, 7, 4.835415, 5, 580],
    ["logit y x z [iw=iw]", 7, 7, 9.487007, 5, 157],
    ["probit y x [fw=fw]", 7, 6, 11.032632, 4, 580],
    ["logit y x z", 12, 12, 4.324044, 10, 157],
    ["logit y x z [fw=fw]", 12, 12, 15.308795, 10, 580],
    ["logit y x z [iw=iw]", 12, 12, 8.638184, 10, 157],
    ["probit y x [fw=fw]", 12, 6, 11.032632, 4, 580],
    ["logit y x z", 40, 29, 12.851493, 27, 157],
    ["logit y x z [fw=fw]", 40, 28, 77.205242, 26, 580],
    ["logit y x z [iw=iw]", 40, 24, 17.169917, 22, 157],
    ["probit y x [fw=fw]", 40, 7, 15.959597, 5, 580],
  ];
  for (const [model, group, m, chi2, df, N] of expected) {
    const what = `${model}, group(${group})`,
      result = s.run(`quietly ${model}\nquietly estat gof, group(${group})`);
    assert.equal(result.rc, 0, what);
    const r = s.results.r;
    assert.equal(r.m, m, `${what}: r(m)`);
    assert.equal(r.df, df, `${what}: r(df)`);
    assert.equal(r.N, N, `${what}: r(N)`);
    assert.ok(Math.abs(r.chi2 - chi2) < 5e-6, `${what}: r(chi2) ${r.chi2}`);
  }
  // The listing and the other samples are refused, not ignored.
  for (const options of ["group(10) table", "all", "table"]) {
    const result = s.run(`estat gof, ${options}`);
    assert.equal(result.rc, 198, options);
    assert.match(result.output.at(-1).lines.join("\n"), /not available yet/);
  }
  assert.equal(s.run("estat classification, cutoff(.3)").rc, 198);
});
