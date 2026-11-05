import fs from "node:fs/promises";
import {
  analyzeRegression,
  regressionCSV,
} from "../src/labs/regression-model.js";
const cases = [
  { id: "confounding", options: { seed: 2026, n: 100 }, selected: 37 },
  {
    id: "reversal",
    options: { seed: 2026, n: 80, gamma: -3, rho: 0.8, sigma: 1, robust: true },
    selected: 22,
  },
  {
    id: "collinear",
    options: {
      seed: 830,
      n: 50,
      rho: 0.95,
      beta: -0.5,
      gamma: 1,
      robust: true,
    },
    selected: 10,
  },
  {
    id: "modified",
    options: { seed: 2026, n: 100 },
    perturbation: { id: 37, dx: 6, dy: -12 },
    selected: 37,
  },
];
await fs.mkdir("tests/fixtures/regression-lab", { recursive: true });
for (const entry of cases) {
  const analysis = analyzeRegression(entry.options, entry.perturbation);
  entry.options = analysis.parameters;
  await fs.writeFile(
    `tests/fixtures/regression-lab/${entry.id}.csv`,
    regressionCSV(analysis),
  );
}
await fs.writeFile(
  "tests/fixtures/regression-lab/cases.json",
  JSON.stringify(cases, null, 2) + "\n",
);
console.log(
  `Prepared ${cases.length} synthetic datasets for independent R checks.`,
);
