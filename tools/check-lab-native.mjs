import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  analyzeRegression,
  regressionDoFile,
} from "../src/labs/regression-model.js";

const root = process.cwd();
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-lab-native-"),
);
const cases = JSON.parse(
  await fs.readFile("tests/fixtures/regression-lab/cases.json", "utf8"),
);
const results = [];
for (const entry of cases) {
  const destination = path.join(folder, entry.id);
  await fs.mkdir(destination);
  const analysis = analyzeRegression(entry.options, entry.perturbation);
  const input = [
    "input double(id x z y ref_h ref_c ref_s)",
    ...analysis.rows.map((row, i) => {
      const reference = analysis.influence[i];
      return [
        row.id,
        row.x,
        row.z,
        row.y,
        reference.leverage,
        reference.cook,
        reference.standardized,
      ].join(" ");
    }),
    "end",
  ].join("\n");
  const candidate =
    regressionDoFile(analysis).replace(
      'import delimited using "regression-lab.csv", clear',
      input,
    ) +
    [
      `assert abs(_b[x] - (${analysis.b.b})) < 1e-9`,
      `assert abs(_se[x] - (${analysis.b.se})) < 1e-9`,
      "assert abs(leverage - ref_h) < 1e-9",
      "assert abs(cook - ref_c) < 1e-9",
      "assert abs(rstandard - ref_s) < 1e-9",
      "",
    ].join("\n");
  await fs.writeFile(path.join(destination, "candidate.do"), candidate);
  await fs.writeFile(
    path.join(destination, "audit.do"),
    [
      "set processors 1",
      'capture noisily do "candidate.do"',
      "local result = _rc",
      'file open receipt using "receipt.txt", write text replace',
      'file write receipt "`result\'" _n',
      "file close receipt",
      "exit, clear",
      "",
    ].join("\n"),
  );
  let code;
  try {
    await promisify(execFile)(
      "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
      ["-b", "do", "audit.do"],
      { cwd: destination, timeout: 45000 },
    );
    code = (
      await fs.readFile(path.join(destination, "receipt.txt"), "utf8")
    ).trim();
  } catch (error) {
    code = error.killed ? "timeout" : "execution or receipt failure";
  }
  const result = {
    case: entry.id,
    returnCode: code,
    assertions: [
      "adjusted x coefficient",
      "requested x standard error",
      "all leverages",
      "all Cook distances",
      "all standardized residuals",
    ],
    temporarySubstitution:
      "Native double-precision input replaces Java-dependent CSV import; all other exported commands are executed.",
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await fs.writeFile(
  path.join(root, "docs/verification/regression-lab-native.json"),
  JSON.stringify(
    {
      method:
        "Installed native Stata; exported do-file with explicit input substitution",
      limits: [
        "Does not verify Java-backed CSV import or PNG export on this machine.",
        "Checks these four synthetic cases, not all parameter combinations.",
      ],
      results,
    },
    null,
    2,
  ) + "\n",
);
if (results.some((result) => result.returnCode !== "0")) process.exitCode = 1;
