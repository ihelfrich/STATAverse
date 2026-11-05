export const IV_DEFAULTS = Object.freeze({
  n: 300,
  seed: 2026,
  beta: 1,
  pi: 1,
  rho: 0.7,
  delta: 0,
  sigma: 1,
  confidence: 0.95,
  robust: false,
});
export const IV_PRESETS = /* @__PURE__ */ Object.freeze([
  {
    id: "valid",
    title: "Strong, valid instrument",
    description:
      "z predicts x and has no direct effect on y. Endogeneity biases the population OLS slope.",
    values: { pi: 1, rho: 0.7, delta: 0 },
  },
  {
    id: "weak",
    title: "Weak, valid instrument",
    description:
      "z moves x only slightly. The IV ratio and its conventional interval can become unstable.",
    values: { pi: 0.06, rho: 0.7, delta: 0 },
  },
  {
    id: "irrelevant",
    title: "No population first stage",
    description:
      "π is zero. Any first-stage association in this sample is sampling variation.",
    values: { pi: 0, rho: 0.7, delta: 0 },
  },
  {
    id: "invalid",
    title: "Strong, invalid instrument",
    description:
      "z predicts x strongly but also affects y directly. A strong first stage cannot detect this exclusion failure.",
    values: { pi: 1, rho: 0.7, delta: 0.8 },
  },
]);

export function ivParameters(options = {}) {
  const p = { ...IV_DEFAULTS, ...options };
  for (const [key, low, high] of [
    ["n", 30, 2000],
    ["seed", 1, 4294967295],
    ["beta", -5, 5],
    ["pi", 0, 2],
    ["rho", -0.95, 0.95],
    ["delta", -2, 2],
    ["sigma", 0.1, 5],
  ]) {
    if (
      typeof p[key] !== "number" ||
      !Number.isFinite(p[key]) ||
      p[key] < low ||
      p[key] > high ||
      (["n", "seed"].includes(key) && !Number.isInteger(p[key]))
    )
      throw new Error(
        `${key} must be ${["n", "seed"].includes(key) ? "an integer " : ""}between ${low} and ${high}.`,
      );
  }
  if (![0.9, 0.95, 0.99].includes(p.confidence))
    throw new Error("Choose a 90%, 95% or 99% confidence level.");
  if (typeof p.robust !== "boolean")
    throw new Error("The covariance choice must be conventional or HC1.");
  return p;
}
