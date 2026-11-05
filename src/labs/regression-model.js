import { regress, mean, correlation } from "../statistics.js";
import { toCSV } from "../datasets.js";

export const REGRESSION_DEFAULTS = Object.freeze({
  n: 100,
  seed: 2026,
  beta: 1,
  gamma: 2,
  rho: 0.7,
  sigma: 1.5,
  robust: false,
});
export const REGRESSION_PRESETS = Object.freeze([
  {
    id: "confounding",
    title: "Omitted-variable bias",
    description: "z raises y and is positively related to x.",
    values: { beta: 1, gamma: 2, rho: 0.7, sigma: 1.5 },
  },
  {
    id: "reversal",
    title: "A sign reversal",
    description:
      "A positive structural effect can coexist with a negative unadjusted slope.",
    values: { beta: 1, gamma: -3, rho: 0.8, sigma: 1 },
  },
  {
    id: "unrelated",
    title: "An unrelated control",
    description: "z predicts y but is independent of x in the population.",
    values: { beta: 1, gamma: 2, rho: 0, sigma: 1.5 },
  },
  {
    id: "precision",
    title: "Little independent variation",
    description:
      "x and z almost move together. The adjusted slope has less information.",
    values: { beta: 1, gamma: 2, rho: 0.95, sigma: 1.5 },
  },
]);

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function parameters(options) {
  const p = { ...REGRESSION_DEFAULTS, ...options };
  for (const [name, low, high] of [
    ["n", 20, 1000],
    ["seed", 1, 4294967295],
    ["beta", -5, 5],
    ["gamma", -5, 5],
    ["rho", -0.95, 0.95],
    ["sigma", 0.1, 5],
  ])
    if (!Number.isFinite(p[name]) || p[name] < low || p[name] > high)
      throw new Error(`${name} must lie between ${low} and ${high}.`);
  if (!Number.isInteger(p.n) || !Number.isInteger(p.seed))
    throw new Error("The sample size and seed must be integers.");
  if (typeof p.robust !== "boolean")
    throw new Error("The covariance choice must be true or false.");
  return p;
}
export function regressionData(options = {}, perturbation = null) {
  const p = parameters(options);
  const random = seededRandom(p.seed);
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const rows = Array.from({ length: p.n }, (_, i) => {
    const z = normal(),
      u = normal(),
      error = normal();
    const x = p.rho * z + Math.sqrt(1 - p.rho ** 2) * u;
    const y = 2 + p.beta * x + p.gamma * z + p.sigma * error;
    return { id: i + 1, x, z, y };
  });
  if (perturbation) {
    const { id, dx, dy } = perturbation;
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      id > p.n ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      Math.abs(dx) > 10 ||
      Math.abs(dy) > 20
    )
      throw new Error(
        "The modified observation must exist; x and y adjustments are limited to ±10 and ±20.",
      );
    rows[id - 1].x += dx;
    rows[id - 1].y += dy;
  }
  return rows;
}
const coefficient = (model, name) =>
  model.coefficients.find((c) => c.name === name);

export function analyzeRegression(options = {}, perturbation = null) {
  const p = parameters(options),
    rows = regressionData(p, perturbation);
  const simple = regress(rows, "y", ["x"], p.robust);
  const full = regress(rows, "y", ["x", "z"], p.robust);
  const xOnZ = regress(rows, "x", ["z"]);
  const yOnZ = regress(rows, "y", ["z"]);
  const zOnX = regress(rows, "z", ["x"]);
  const residualized = rows.map((row, i) => ({
    id: row.id,
    x: xOnZ.residuals[i],
    y: yOnZ.residuals[i],
  }));
  const sxx = residualized.reduce((sum, row) => sum + row.x ** 2, 0);
  const partialSlope =
    residualized.reduce((sum, row) => sum + row.x * row.y, 0) / sxx;
  const bx = coefficient(full, "x"),
    bz = coefficient(full, "z");
  const short = coefficient(simple, "x"),
    delta = coefficient(zOnX, "x").b;
  const mx = mean(rows.map((r) => r.x)),
    mz = mean(rows.map((r) => r.z));
  const xx = rows.reduce((s, r) => s + (r.x - mx) ** 2, 0);
  const zz = rows.reduce((s, r) => s + (r.z - mz) ** 2, 0);
  const xz = rows.reduce((s, r) => s + (r.x - mx) * (r.z - mz), 0);
  const determinant = xx * zz - xz ** 2;
  const influence = rows.map((row, i) => {
    const x = row.x - mx,
      z = row.z - mz;
    const leverage =
      1 / rows.length +
      (zz * x ** 2 - 2 * xz * x * z + xx * z ** 2) / determinant;
    const residual = full.residuals[i],
      mse = full.rmse ** 2;
    const standard =
      mse > 0 && leverage < 1
        ? residual / Math.sqrt(mse * (1 - leverage))
        : null;
    const cook =
      standard === null
        ? null
        : (standard ** 2 * leverage) / (full.k * (1 - leverage));
    return { id: row.id, leverage, residual, standardized: standard, cook };
  });
  return {
    parameters: p,
    rows,
    simple,
    full,
    xOnZ,
    yOnZ,
    residualized,
    partialSlope,
    influence,
    b: bx,
    short,
    zCoefficient: bz,
    zOnXSlope: delta,
    decomposition: {
      difference: short.b - bx.b,
      omittedComponent: bz.b * delta,
      discrepancy: short.b - bx.b - bz.b * delta,
    },
    populationShortSlope: p.beta + p.gamma * p.rho,
    sampleCorrelation: correlation(
      rows.map((r) => r.x),
      rows.map((r) => r.z),
    ),
    remainingXVariation: sxx / xx,
    partialR2: 1 - full.sse / yOnZ.sse,
    perturbation: perturbation ? { ...perturbation } : null,
  };
}

export function leaveOneOut(analysis, id) {
  if (!analysis.rows.some((row) => row.id === id))
    throw new Error("Choose an observation in this sample.");
  return regress(
    analysis.rows.filter((row) => row.id !== id),
    "y",
    ["x", "z"],
    analysis.parameters.robust,
  );
}
export function regressionCSV(analysis) {
  return toCSV({
    columns: ["id", "x", "z", "y"].map((name) => ({ name })),
    rows: analysis.rows,
  });
}
export function regressionDoFile(analysis) {
  const p = analysis.parameters;
  return [
    "* STATAverse regression lab: exact exported synthetic observations",
    `* Browser generator seed ${p.seed}; n=${p.n}; beta=${p.beta}; gamma=${p.gamma}; rho=${p.rho}; sigma=${p.sigma}.`,
    "* The browser seed uses its own generator. Stata set seed does not reproduce these draws.",
    "* Import the accompanying CSV to reproduce the displayed estimates.",
    ...(analysis.perturbation
      ? [
          `* Observation ${analysis.perturbation.id} was manually modified: dx=${analysis.perturbation.dx}, dy=${analysis.perturbation.dy}.`,
        ]
      : []),
    "clear all",
    "set more off",
    'import delimited using "regression-lab.csv", clear',
    "",
    "* Unadjusted and adjusted models on the same complete sample",
    `regress y x${p.robust ? ", vce(robust)" : ""}`,
    "estimates store unadjusted",
    `regress y x z${p.robust ? ", vce(robust)" : ""}`,
    "estimates store adjusted",
    "",
    "* Partial regression. The slope agrees; use adjusted for its standard error and residual df.",
    "regress x z",
    "predict double rx, residuals",
    "regress y z",
    "predict double ry, residuals",
    "regress ry rx, noconstant",
    "estimates restore adjusted",
    "avplot x",
    "",
    "* Classical influence diagnostics (calculated from the conventional fit)",
    "regress y x z",
    "predict double leverage, hat",
    "predict double cook, cooksd",
    "predict double rstandard, rstandard",
    "gsort -cook",
    "list id x z y leverage cook rstandard in 1/10",
    "sort id",
    "",
    "* Return to the requested covariance specification",
    "estimates restore adjusted",
    "",
    "* Diagnostics identify observations to investigate; they do not justify automatic deletion.",
    "",
  ].join("\n");
}
