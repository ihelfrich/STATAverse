import jstat from "jstat";
import { seededRandom } from "./regression-model.js";
import { toCSV } from "../datasets.js";

const { jStat } = jstat;
export const INFERENCE_DEFAULTS = Object.freeze({
  groups: 30,
  perGroup: 10,
  seed: 2026,
  beta: 1,
  sigma: 1,
  errorICC: 0,
  xICC: 0,
  heterogeneity: 0,
  confidence: 0.95,
  nullValue: 0,
  repetitions: 500,
});
export const INFERENCE_METHODS = Object.freeze([
  { id: "conventional", title: "Conventional", command: "regress y x" },
  { id: "hc1", title: "Robust · HC1", command: "regress y x, vce(robust)" },
  {
    id: "cluster",
    title: "Clustered · CR1",
    command: "regress y x, vce(cluster cluster)",
  },
]);
export const INFERENCE_PRESETS = Object.freeze([
  {
    id: "independent",
    title: "Independent, constant variance",
    description:
      "Independent normal errors satisfy the conventional model's assumptions.",
    values: {
      groups: 30,
      perGroup: 10,
      errorICC: 0,
      xICC: 0,
      heterogeneity: 0,
    },
  },
  {
    id: "heteroskedastic",
    title: "Variance grows with x",
    description:
      "Errors remain independent, but observations at larger x have more variable outcomes.",
    values: {
      groups: 30,
      perGroup: 10,
      errorICC: 0,
      xICC: 0,
      heterogeneity: 1,
    },
  },
  {
    id: "clustered",
    title: "Shared group shocks",
    description:
      "Both x and the errors move together within groups. Groups are independent of one another.",
    values: {
      groups: 30,
      perGroup: 10,
      errorICC: 0.6,
      xICC: 0.7,
      heterogeneity: 0,
    },
  },
  {
    id: "few",
    title: "Only six independent groups",
    description:
      "Many observations can still contain few independent groups. The usual cluster correction is not an exact small-sample solution.",
    values: {
      groups: 6,
      perGroup: 30,
      errorICC: 0.6,
      xICC: 0.7,
      heterogeneity: 0,
    },
  },
]);

export function inferenceParameters(options = {}) {
  const p = { ...INFERENCE_DEFAULTS, ...options };
  for (const [key, low, high] of [
    ["groups", 5, 100],
    ["perGroup", 2, 50],
    ["seed", 1, 4294967295],
    ["beta", -5, 5],
    ["sigma", 0.1, 5],
    ["errorICC", 0, 0.95],
    ["xICC", 0, 0.95],
    ["heterogeneity", 0, 1.5],
    ["nullValue", -5, 5],
    ["repetitions", 50, 2000],
  ])
    if (!Number.isFinite(p[key]) || p[key] < low || p[key] > high)
      throw new Error(`${key} must lie between ${low} and ${high}.`);
  for (const key of ["groups", "perGroup", "seed", "repetitions"])
    if (!Number.isInteger(p[key]))
      throw new Error(`${key} must be an integer.`);
  if (![0.9, 0.95, 0.99].includes(p.confidence))
    throw new Error("Choose a 90%, 95% or 99% confidence level.");
  return p;
}

/** Equal-sized, independent clusters; normal latent draws are mutually independent. */
export function inferenceData(options = {}, replication = 0) {
  const p = inferenceParameters(options);
  if (!Number.isInteger(replication) || replication < 0 || replication >= 2000)
    throw new Error("The sample number must be between 1 and 2,000.");
  const random = seededRandom(
    (p.seed + Math.imul(replication, 0x9e3779b9)) >>> 0,
  );
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const rows = [];
  for (let g = 1; g <= p.groups; g++) {
    const groupX = normal(),
      groupError = normal();
    for (let i = 0; i < p.perGroup; i++) {
      const x = Math.sqrt(p.xICC) * groupX + Math.sqrt(1 - p.xICC) * normal();
      const scale = Math.exp(
        (p.heterogeneity * x) / 2 - p.heterogeneity ** 2 / 4,
      );
      const error =
        p.sigma *
        scale *
        (Math.sqrt(p.errorICC) * groupError +
          Math.sqrt(1 - p.errorICC) * normal());
      rows.push({
        id: rows.length + 1,
        cluster: g,
        x,
        y: 2 + p.beta * x + error,
        error,
        error_sd: p.sigma * scale,
      });
    }
  }
  return rows;
}

/** Centered simple-OLS formulas; all three methods share the same coefficients. */
export function inferenceFit(rows, options = {}) {
  const p = inferenceParameters(options),
    n = rows.length,
    df = n - 2;
  if (
    df <= 0 ||
    n > 5000 ||
    rows.some((r) => ![r.x, r.y, r.cluster].every(Number.isFinite))
  )
    throw new Error(
      "Inference needs 3–5,000 complete finite observations with a group identifier.",
    );
  const groups = new Map();
  const mx = rows.reduce((s, r) => s + r.x, 0) / n;
  const my = rows.reduce((s, r) => s + r.y, 0) / n;
  const sxx = rows.reduce((s, r) => s + (r.x - mx) ** 2, 0);
  if (!(sxx > 0)) throw new Error("x must vary to estimate a slope.");
  const b = rows.reduce((s, r) => s + (r.x - mx) * (r.y - my), 0) / sxx;
  const intercept = my - b * mx;
  let sse = 0,
    meat = 0;
  const residuals = rows.map((r) => {
    const e = r.y - my - b * (r.x - mx),
      score = (r.x - mx) * e;
    sse += e * e;
    meat += score * score;
    groups.set(r.cluster, (groups.get(r.cluster) || 0) + score);
    return e;
  });
  const G = groups.size;
  if (G < 2)
    throw new Error("Clustered inference needs at least two observed groups.");
  const variances = {
    conventional: sse / df / sxx,
    hc1: ((n / df) * meat) / sxx ** 2,
    cluster:
      ((G / (G - 1)) *
        ((n - 1) / df) *
        [...groups.values()].reduce((s, score) => s + score ** 2, 0)) /
      sxx ** 2,
  };
  if (![b, intercept, ...Object.values(variances)].every(Number.isFinite))
    throw new Error("This sample exceeds the supported numerical range.");
  const methods = Object.fromEntries(
    INFERENCE_METHODS.map(({ id }) => {
      const degrees = id === "cluster" ? G - 1 : df;
      const se = Math.sqrt(variances[id]);
      const critical = jStat.studentt.inv((1 + p.confidence) / 2, degrees);
      const lo = b - critical * se,
        hi = b + critical * se;
      const statistic = se > 0 ? (b - p.nullValue) / se : null;
      const probability =
        statistic === null
          ? null
          : Math.max(
              0,
              Math.min(
                1,
                2 * jStat.studentt.cdf(-Math.abs(statistic), degrees),
              ),
            );
      return [
        id,
        {
          se,
          df: degrees,
          critical,
          lo,
          hi,
          p: probability,
          covers: lo <= p.beta && p.beta <= hi,
          rejects: p.nullValue < lo || p.nullValue > hi,
        },
      ];
    }),
  );
  return { n, groups: G, b, intercept, sxx, sse, residuals, methods };
}

export function inferenceSample(options = {}, replication = 0) {
  const parameters = inferenceParameters(options);
  const rows = inferenceData(parameters, replication);
  return { parameters, replication, rows, ...inferenceFit(rows, parameters) };
}

/** Wilson uncertainty for a simulation rate, not a parameter confidence interval. */
export function simulationRate(successes, total) {
  if (
    !Number.isInteger(total) ||
    total < 1 ||
    !Number.isInteger(successes) ||
    successes < 0 ||
    successes > total
  )
    throw new Error("A simulation rate needs valid integer counts.");
  const rate = successes / total,
    z = 1.959963984540054,
    divisor = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / divisor;
  const half =
    (z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total ** 2))) /
    divisor;
  return {
    count: successes,
    total,
    rate,
    se: Math.sqrt((rate * (1 - rate)) / total),
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
  };
}

export function summarizeSimulation(records, options = {}) {
  const p = inferenceParameters(options),
    R = records.length;
  if (!R) throw new Error("Run at least one sample before summarizing.");
  const average = (values) => values.reduce((sum, x) => sum + x, 0) / R;
  const meanB = average(records.map((r) => r.b));
  const sd =
    R > 1
      ? Math.sqrt(records.reduce((s, r) => s + (r.b - meanB) ** 2, 0) / (R - 1))
      : null;
  const methods = Object.fromEntries(
    INFERENCE_METHODS.map(({ id }) => [
      id,
      {
        coverage: simulationRate(
          records.filter((r) => r.methods[id].covers).length,
          R,
        ),
        rejection: simulationRate(
          records.filter((r) => r.methods[id].rejects).length,
          R,
        ),
        meanSE: average(records.map((r) => r.methods[id].se)),
        meanWidth: average(
          records.map((r) => r.methods[id].hi - r.methods[id].lo),
        ),
      },
    ]),
  );
  return {
    repetitions: R,
    meanB,
    bias: meanB - p.beta,
    empiricalSD: sd,
    meanMCSE: sd === null ? null : sd / Math.sqrt(R),
    methods,
  };
}

export function compactSample(sample) {
  return {
    replication: sample.replication,
    b: sample.b,
    methods: sample.methods,
  };
}

export function inferenceCSV(sample) {
  return toCSV({
    columns: ["id", "cluster", "x", "y", "error", "error_sd"].map((name) => ({
      name,
      type: "numeric",
    })),
    rows: sample.rows,
  });
}

export function inferenceDoFile(sample) {
  const p = sample.parameters;
  return [
    "* STATAverse inference lab — exact exported synthetic observations",
    `* Browser seed ${p.seed}, sample ${sample.replication + 1}; this is not a Stata RNG seed.`,
    `* Generator: groups=${p.groups}, observations/group=${p.perGroup}, beta=${p.beta}, sigma=${p.sigma}`,
    `* Error ICC=${p.errorICC}; x ICC=${p.xICC}; heterogeneity=${p.heterogeneity}`,
    "clear all",
    "set more off",
    'import delimited using "inference-sample.csv", clear asdouble',
    "isid id",
    `assert _N == ${sample.n}`,
    "",
    ...INFERENCE_METHODS.flatMap(({ title, command }) => [
      `* ${title}; same coefficients, different uncertainty calculation`,
      `${command}${command.includes(",") ? "" : ","} level(${p.confidence * 100})`,
      `lincom x - (${p.nullValue}), level(${p.confidence * 100})`,
      "",
    ]),
    "* Robust/clustered inference does not repair omitted-variable bias.",
    "* Few independent clusters can make CR1 inference unreliable.",
    "",
  ].join("\n");
}

export function inferenceSimulationDoFile(options = {}) {
  const p = inferenceParameters(options);
  const seed = 1 + ((p.seed - 1) % 2147483646);
  const names = [
    "b",
    ...INFERENCE_METHODS.flatMap(({ id }) =>
      ["se", "lo", "hi", "cover", "reject"].map((key) => `${key}_${id}`),
    ),
  ];
  return [
    "* STATAverse — native repeated-sampling experiment",
    "* Same population design as the browser; independent native random draws.",
    `* Browser seed ${p.seed} maps to Stata seed ${seed}; the streams do not match.`,
    "* Run in a project folder; generated output files are replaced on rerun.",
    "clear all",
    "set more off",
    "version 16.0",
    "set rng mt64",
    "",
    "capture program drop stataverse_inference_draw",
    "program define stataverse_inference_draw, rclass",
    "    quietly {",
    "        clear",
    `        set obs ${p.groups * p.perGroup}`,
    "        generate long id = _n",
    `        generate int cluster = ceil(_n / ${p.perGroup})`,
    "        bysort cluster: generate double group_x = rnormal() if _n == 1",
    "        by cluster: replace group_x = group_x[1]",
    "        by cluster: generate double group_error = rnormal() if _n == 1",
    "        by cluster: replace group_error = group_error[1]",
    `        generate double x = sqrt(${p.xICC})*group_x + sqrt(1-${p.xICC})*rnormal()`,
    `        generate double error_sd = ${p.sigma}*exp(${p.heterogeneity}*x/2 - (${p.heterogeneity})^2/4)`,
    `        generate double error = error_sd*(sqrt(${p.errorICC})*group_error + sqrt(1-${p.errorICC})*rnormal())`,
    `        generate double y = 2 + (${p.beta})*x + error`,
    "",
    ...INFERENCE_METHODS.flatMap(({ id, title, command }) => [
      `        * ${title}`,
      `        ${command}`,
      "        local b = _b[x]",
      `        local se_${id} = _se[x]`,
      `        local critical = invttail(e(df_r), ${(1 - p.confidence) / 2})`,
      `        local lo_${id} = _b[x] - \`critical'*_se[x]`,
      `        local hi_${id} = _b[x] + \`critical'*_se[x]`,
      `        local cover_${id} = (\`lo_${id}' <= (${p.beta}) & (${p.beta}) <= \`hi_${id}')`,
      `        local reject_${id} = ((${p.nullValue}) < \`lo_${id}' | (${p.nullValue}) > \`hi_${id}')`,
      "",
    ]),
    "    }",
    ...names.map((name) => `    return scalar ${name} = \`${name}'`),
    "end",
    "",
    "* Each repetition returns all three methods on identical observations.",
    `simulate ${names.map((name) => `${name}=r(${name})`).join(" ")} , reps(${p.repetitions}) seed(${seed}) saving("native-repetitions.dta", double replace) nodots: stataverse_inference_draw`,
    `assert _N == ${p.repetitions}`,
    ...names.map((name) => `assert !missing(${name})`),
    "generate long sample = _n",
    "order sample b",
    'export delimited using "native-repetitions.csv", replace',
    "summarize b",
    "",
    "* Mean coverage/rejection and estimated Monte Carlo standard errors.",
    "* These simulation rates concern this generator, not empirical identification.",
    ...INFERENCE_METHODS.flatMap(({ id, title }) => [
      `display "${title}"`,
      `summarize se_${id} cover_${id} reject_${id}`,
      `quietly summarize cover_${id}`,
      'display "Coverage MC standard error: " sqrt(r(mean)*(1-r(mean))/r(N))',
      `quietly summarize reject_${id}`,
      'display "Rejection MC standard error: " sqrt(r(mean)*(1-r(mean))/r(N))',
      "",
    ]),
    "* At a simulated rate of 0 or 1, this plug-in MC SE is zero; that does",
    "* not establish certainty. The browser additionally reports Wilson intervals.",
    "* CR1 with few groups is an approximation; covariance changes do not repair bias.",
    "",
  ].join("\n");
}
