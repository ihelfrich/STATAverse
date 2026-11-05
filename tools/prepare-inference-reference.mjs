import fs from "node:fs/promises";
import { inferenceSample, inferenceCSV } from "../src/labs/inference-model.js";
const folder = "tests/fixtures/inference-lab";
await fs.mkdir(folder, { recursive: true });
const cases = [
  { id: "independent", options: {}, replication: 0 },
  {
    id: "heteroskedastic",
    options: { heterogeneity: 1.5, beta: -1, nullValue: -0.5, confidence: 0.9 },
    replication: 12,
  },
  {
    id: "clustered",
    options: {
      groups: 50,
      perGroup: 12,
      errorICC: 0.8,
      xICC: 0.9,
      confidence: 0.99,
    },
    replication: 7,
  },
  {
    id: "few-clusters",
    options: {
      groups: 5,
      perGroup: 25,
      errorICC: 0.7,
      xICC: 0.8,
      heterogeneity: 0.5,
      beta: 0,
    },
    replication: 2,
  },
  {
    id: "many-groups",
    options: { groups: 100, perGroup: 2, errorICC: 0.9, xICC: 0.95 },
    replication: 4,
  },
];
for (const entry of cases) {
  const sample = inferenceSample(entry.options, entry.replication);
  entry.options = sample.parameters;
  await fs.writeFile(`${folder}/${entry.id}.csv`, inferenceCSV(sample));
}
await fs.writeFile(
  `${folder}/cases.json`,
  JSON.stringify(cases, null, 2) + "\n",
);
console.log(`Prepared ${cases.length} synthetic inference cases.`);
