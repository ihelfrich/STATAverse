// vce(robust), vce(cluster) and sampling weights after tobit, ologit,
// oprobit and nbreg: the sandwich variance from each model's scores. The
// expected values were recorded from Stata 19 MP (version 17, set
// processors 1) on the same data, which runiform() reproduces draw for
// draw. The printed tables are compared line by line in
// tests/runtime-output.test.mjs (cases robust-likelihood-models,
// base-levels-in-tables, error-message-codes and tobit-stata-steps); this
// file checks what text cannot: every estimate and standard error at full
// precision, e() and return codes.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const SETUP = [
  "clear",
  "set seed 5301",
  "set obs 500",
  "generate byte a = runiform() > .5",
  "generate byte g = 1 + floor(runiform() * 4)",
  "generate double x = 8 + floor(runiform() * 12)",
  "generate int cl = 1 + floor(runiform() * 30)",
  "generate double w = 1 + floor(runiform() * 4)",
  "generate double u = runiform()",
  "generate double latent = .4 * a + .1 * x + ln(u / (1 - u))",
  "generate byte r = 1 + (latent > 0) + (latent > 1) + (latent > 2)",
  "generate double y = 5 + 2 * x - .05 * x^2 + 3 * a + runiform() * 8",
  "generate int c = floor(runiform()^2 * (10 + x)) + floor(4 * runiform() * a)",
  "replace cl = . in 1/3",
  "replace w = 0 in 4",
].join("\n");

const CASES = [
  {
    command: "tobit y x i.a, ll(21) vce(robust)",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.6833657697454274, 0.032304955440282002],
      ["1.a", 3.0858385392884755, 0.21001387582478251],
      ["_cons", 17.024212600888838, 0.46573560574552142],
      ["/var(e.y)", 5.4430399367605471, 0.25840826029362279],
    ],
    e: {
      N: 500,
      ll: -1102.5224064398969,
      ll_0: -1330.2098860727051,
      F: 325.02105149235297,
      p: 4.7930314062554502e-91,
      df_r: 498,
      df_m: 2,
    },
    macros: { vce: "robust", vcetype: "Robust" },
  },
  {
    command: "tobit y x i.g, ll(21) ul(34) vce(cluster cl)",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.70415696631291114, 0.03976225093604642],
      ["2.g", 0.53376247856815118, 0.35898708043609084],
      ["3.g", 0.24786726271607806, 0.26842483104866866],
      ["4.g", 0.029382387398385446, 0.23701866490786991],
      ["_cons", 18.077591745316663, 0.46456563135200502],
      ["/var(e.y)", 8.1531571314176006, 0.47370402670093287],
    ],
    e: {
      N: 497,
      N_clust: 30,
      ll: -1166.4167762770971,
      ll_0: -1310.0168240118189,
      F: 93.427548349445246,
      p: 4.2795008587156998e-59,
      df_r: 493,
      df_m: 4,
    },
    macros: { vce: "cluster", vcetype: "Robust", clustvar: "cl" },
  },
  {
    command: "tobit y x [pw=w], ll(21)",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.68042611939290476, 0.043312992484524034],
      ["_cons", 18.573614022824966, 0.5907291775784298],
      ["/var(e.y)", 7.9529790309471711, 0.4833702093685604],
    ],
    e: {
      N: 499,
      ll: -2996.018539716662,
      ll_0: -3318.879999571283,
      F: 246.78887188109005,
      p: 1.8410706154691401e-45,
      df_r: 498,
      df_m: 1,
    },
    macros: { vce: "robust", vcetype: "Robust" },
  },
  {
    command: "ologit r x i.a, vce(robust)",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.10668711021918754, 0.024652896212086873],
      ["1.a", 0.38620110037095617, 0.16367854378797003],
      ["/cut1", 0.089570275214141667, 0.35538384829757386],
      ["/cut2", 1.2271324661173475, 0.3529557114171854],
      ["/cut3", 2.1204004284373679, 0.36210674095198403],
    ],
    e: {
      N: 500,
      ll: -657.66138501487046,
      ll_0: -670.48300448020518,
      chi2: 23.856956560445362,
      p: 0.0000065997533540895804,
      df_m: 2,
    },
    macros: { vce: "robust", vcetype: "Robust" },
  },
  {
    command: "ologit r x i.g, vce(cluster cl)",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.1109837207355653, 0.02729118668214308],
      ["2.g", -0.07871899236588642, 0.17349046102574364],
      ["3.g", 0.17745271893552192, 0.24637768530911971],
      ["4.g", -0.17216969462368426, 0.19135249166684529],
      ["/cut1", -0.076516190980349785, 0.39075861420078645],
      ["/cut2", 1.0665643990876819, 0.37825637588872324],
      ["/cut3", 1.9535739018701421, 0.40439733562848429],
    ],
    e: {
      N: 497,
      N_clust: 30,
      ll: -655.21669910681271,
      ll_0: -666.2781261163791,
      chi2: 26.169054994291017,
      p: 0.000029255275460984101,
      df_m: 4,
    },
    macros: { vce: "cluster", vcetype: "Robust", clustvar: "cl" },
  },
  {
    command: "oprobit r x i.a [pw=w]",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.071002597617469396, 0.016257648274473121],
      ["1.a", 0.24693885875939459, 0.10742715377937601],
      ["/cut1", 0.16483362880321842, 0.23048694958547508],
      ["/cut2", 0.83465072817943087, 0.23222026660824824],
      ["/cut3", 1.4043961337718618, 0.23641649613597554],
    ],
    e: {
      N: 499,
      ll: -1648.0830987418012,
      ll_0: -1684.852985083535,
      chi2: 24.741436726492523,
      p: 0.0000042409707551214303,
      df_m: 2,
    },
    macros: { vce: "robust", vcetype: "Robust" },
  },
  {
    command: "oprobit r x i.a, vce(cluster cl)",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.064927695369229932, 0.01645110988684156],
      ["1.a", 0.24644504755805072, 0.10472710303624339],
      ["/cut1", 0.06182330645663358, 0.23787293209315086],
      ["/cut2", 0.7450680925005766, 0.23477963818841627],
      ["/cut3", 1.2966879127847053, 0.24483222450983957],
    ],
    e: {
      N: 497,
      N_clust: 30,
      ll: -653.01794825017384,
      ll_0: -666.2781261163791,
      chi2: 21.382885794875534,
      p: 0.000022738685033942801,
      df_m: 2,
    },
    macros: { vce: "cluster", vcetype: "Robust", clustvar: "cl" },
  },
  {
    command: "nbreg c x i.a, vce(robust)",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.019307543275111062, 0.011851511295407166],
      ["1.a", 0.34979110145251707, 0.07909552258011486],
      ["_cons", 1.6368475033731209, 0.16416998716151462],
      ["/lnalpha", -0.12723356915583706, 0.075909224185096366],
    ],
    e: {
      N: 500,
      ll: -1563.941179449916,
      ll_0: -1572.673834078447,
      chi2: 23.55487343028592,
      p: 0.0000076758101340001203,
      df_m: 2,
    },
    macros: { vce: "robust", vcetype: "Robust" },
  },
  {
    command: "nbreg c x i.g, vce(cluster cl)",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.019234638005533402, 0.013328751404735937],
      ["2.g", -0.053762092468743757, 0.13999892521720858],
      ["3.g", -0.15658886687564405, 0.13358066413767306],
      ["4.g", 0.043303505431419163, 0.11043554287847361],
      ["_cons", 1.8528674212005214, 0.17255027269122275],
      ["/lnalpha", -0.090017329406573421, 0.074920880253025068],
    ],
    e: {
      N: 497,
      N_clust: 30,
      ll: -1558.5050277589444,
      ll_0: -1560.85856009965,
      chi2: 4.495826285777337,
      p: 0.34304266127055622,
      df_m: 4,
    },
    macros: { vce: "cluster", vcetype: "Robust", clustvar: "cl" },
  },
  {
    command: "nbreg c x [pw=w]",
    // [name, coefficient, standard error]; a name starting with / is an
    // ancillary parameter.
    coefficients: [
      ["x", 0.027775414588296722, 0.01246745502507807],
      ["_cons", 1.7032914402477404, 0.16920649720112102],
      ["/lnalpha", -0.16307519956653263, 0.084645940313313517],
    ],
    e: {
      N: 499,
      ll: -3912.8729019912639,
      ll_0: -3918.5468830726581,
      chi2: 4.963242326617002,
      p: 0.025891616686261311,
      df_m: 1,
    },
    macros: { vce: "robust", vcetype: "Robust" },
  },
];

const close = (ours, theirs, what) =>
  assert.ok(
    Math.abs(ours - theirs) <= 1e-9 * Math.max(1, Math.abs(theirs)),
    `${what}: ${ours} vs Stata ${theirs}`,
  );

for (const c of CASES)
  test(`${c.command} matches Stata's estimates, standard errors and e()`, () => {
    const session = new Session();
    assert.equal(session.run(SETUP).rc, 0);
    assert.equal(session.run(c.command).rc, 0);
    const model = session.estimates,
      e = session.results.e;
    for (const [name, b, se] of c.coefficients) {
      let value, variance;
      if (name.startsWith("/")) {
        const j = model.auxiliary.names.indexOf(name.slice(1));
        assert.ok(j >= 0, `${name} is reported`);
        value = model.auxiliary.b[j];
        variance = model.auxiliary.V[j][j];
      } else {
        const j = model.names.indexOf(name);
        assert.ok(j >= 0, `${name} is reported`);
        value = model.b[j];
        variance = model.V[j][j];
      }
      close(value, b, `${name} coefficient`);
      close(Math.sqrt(variance), se, `${name} standard error`);
    }
    for (const [key, value] of Object.entries(c.e))
      close(e[key], value, `e(${key})`);
    for (const [key, value] of Object.entries(c.macros))
      assert.equal(e[key], value, `e(${key})`);
    if (!c.macros.clustvar) assert.equal(e.N_clust, undefined);
  });

test("tobit refuses robust, as Stata does, and options it lacks are refused with a hint", () => {
  const session = new Session();
  session.run(SETUP);
  // Recorded from Stata 19: option robust not allowed, r(198).
  const robust = session.run("tobit y x, ll(21) robust");
  assert.equal(robust.rc, 198);
  // Frequency weights are not implemented: refused, not ignored.
  const weighted = session.run("ologit r x [fw=w]");
  assert.equal(weighted.rc, 198);
  assert.match(
    weighted.output.flatMap((o) => o.lines ?? []).join("\n"),
    /not available in the browser yet/,
  );
});

test("error with a negative, missing or too large code stops with 100000 and no message", () => {
  // Recorded from Stata 19: error -1, error . and error 100001 all leave
  // _rc 100000 and print nothing but the return code.
  for (const code of ["-1", ".", "100001", "-32767"]) {
    const session = new Session(),
      result = session.run(`error ${code}`);
    assert.equal(result.rc, 100000, `error ${code}`);
    const lines = result.output
      .flatMap((o) => o.lines ?? [])
      .filter((line) => line.trim() && !/^r\(/.test(line));
    assert.deepEqual(lines, [], `error ${code} prints no message`);
  }
  const session = new Session();
  assert.equal(session.run("error 1.5").rc, 2);
  assert.equal(session.run("error 0.4").rc, 0);
});
