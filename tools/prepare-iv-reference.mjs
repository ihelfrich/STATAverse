import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { format } from "prettier";
import { ivSample, ivCSV } from "../src/labs/iv-model.js";
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-iv-reference-"),
);
const casesPath = path.resolve("tests/fixtures/iv-lab/cases.json");
const cases = JSON.parse(await fs.readFile(casesPath, "utf8"));
for (const entry of cases)
  await fs.writeFile(
    path.join(folder, entry.id + ".csv"),
    ivCSV(ivSample(entry.options)),
  );
execFileSync(
  "Rscript",
  [
    "tools/iv-reference.R",
    casesPath,
    folder,
    "tests/fixtures/iv-lab/reference.json",
  ],
  { timeout: 45000, stdio: "inherit" },
);
const resultPath = "tests/fixtures/iv-lab/reference.json";
await fs.writeFile(
  resultPath,
  await format(await fs.readFile(resultPath, "utf8"), { parser: "json" }),
);
console.log(`Independent R references written for ${cases.length} cases.`);
