import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  inferenceSample,
  inferenceDoFile,
  inferenceSimulationDoFile,
  INFERENCE_METHODS,
} from "../src/labs/inference-model.js";
const root = process.cwd();
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-inference-native-"),
);
const cases = JSON.parse(
  await fs.readFile("tests/fixtures/inference-lab/cases.json", "utf8"),
);
const results = [];
for (const entry of cases) {
  const destination = path.join(folder, entry.id);
  await fs.mkdir(destination);
  const sample = inferenceSample(entry.options, entry.replication);
  const input = [
    "input double(id cluster x y error error_sd)",
    ...sample.rows.map((row) =>
      [row.id, row.cluster, row.x, row.y, row.error, row.error_sd].join(" "),
    ),
    "end",
  ].join("\n");
  let method = -1;
  const candidate = inferenceDoFile(sample)
    .replace(
      'import delimited using "inference-sample.csv", clear asdouble',
      input,
    )
    .split("\n")
    .flatMap((line) => {
      if (line.startsWith("regress ")) method++;
      if (!line.startsWith("lincom ")) return [line];
      const reference = sample.methods[INFERENCE_METHODS[method].id];
      return [
        line,
        `assert abs(_b[x] - (${sample.b})) < 1e-9`,
        `assert abs(_se[x] - (${reference.se})) < 1e-9`,
        `assert e(df_r) == ${reference.df}`,
        `assert abs(r(lb) - (${reference.lo - sample.parameters.nullValue})) < 1e-6`,
        `assert abs(r(ub) - (${reference.hi - sample.parameters.nullValue})) < 1e-6`,
        `assert abs(r(p) - (${reference.p})) < 1e-7`,
      ];
    })
    .join("\n");
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
    methods: INFERENCE_METHODS.map((m) => m.id),
    assertions: [
      "coefficient",
      "standard error",
      "residual degrees of freedom",
      "confidence endpoints",
      "two-sided null-test p-value",
    ],
    temporarySubstitution:
      "Native double input replaces Java-dependent CSV import; remaining exported commands execute unchanged.",
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
const simulationRuns = [];
for (const entry of cases.slice(0, 3)) {
  const destination = path.join(folder, entry.id + "-simulation");
  await fs.mkdir(destination);
  const parameters = { ...entry.options, repetitions: 50 };
  const assertions = INFERENCE_METHODS.flatMap(({ id }) => [
    `assert se_${id} > 0`,
    `assert abs((lo_${id}+hi_${id})/2-b) < 1e-8`,
    `assert cover_${id} == (lo_${id}<=(${parameters.beta}) & (${parameters.beta})<=hi_${id})`,
    `assert reject_${id} == ((${parameters.nullValue})<lo_${id} | (${parameters.nullValue})>hi_${id})`,
  ]);
  await fs.writeFile(
    path.join(destination, "candidate.do"),
    inferenceSimulationDoFile(parameters) + assertions.join("\n") + "\n",
  );
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
    repetitions: 50,
    returnCode: code,
    substitution: "None; generated simulation.do executed directly",
    checks: [
      "all returned quantities observed",
      "positive standard errors",
      "intervals centered on common coefficient",
      "coverage and rejection decisions agree with intervals",
    ],
  };
  simulationRuns.push(result);
  console.log(JSON.stringify(result));
}
await fs.writeFile(
  path.join(root, "docs/verification/inference-native.json"),
  JSON.stringify(
    {
      method:
        "Native Stata exported inference workflow with explicit input substitution",
      limits: [
        "Five synthetic cases; not general equivalence",
        "Java-backed CSV import remains unverified",
      ],
      results,
      simulationRuns,
    },
    null,
    2,
  ) + "\n",
);
if ([...results, ...simulationRuns].some((r) => r.returnCode !== "0"))
  process.exitCode = 1;
