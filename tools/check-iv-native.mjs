import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ivSample, ivDoFile, arTest } from "../src/labs/iv-model.js";
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-iv-native-"),
);
const cases = JSON.parse(
  await fs.readFile("tests/fixtures/iv-lab/cases.json", "utf8"),
);
const results = [];
const equal = (expression, value, tolerance = 1e-8) =>
  `assert abs((${expression}) - (${value})) < ${tolerance * Math.max(1, Math.abs(value))}`;
for (const entry of cases) {
  const destination = path.join(folder, entry.id);
  await fs.mkdir(destination);
  const s = ivSample(entry.options),
    ar = arTest(s, entry.candidate);
  const keys = ["id", "z", "x", "y", "u", "v", "e"];
  const input = [
    `input double(${keys.join(" ")})`,
    ...s.rows.map((r) => keys.map((k) => r[k]).join(" ")),
    "end",
  ].join("\n");
  const commands = ivDoFile(s, entry.candidate)
    .replace('import delimited using "iv-sample.csv", clear asdouble', input)
    .split("\n")
    .flatMap((line) => {
      let result;
      if (line.startsWith("regress x z")) result = s.first;
      else if (line.startsWith("regress y z")) result = s.reduced;
      else if (line.startsWith("regress y xhat")) result = s.naive;
      else if (line.startsWith("regress y x,")) result = s.ols;
      else if (line.startsWith("ivregress")) result = s.iv;
      if (!result) return [line];
      const name =
        line.startsWith("regress x z") || line.startsWith("regress y z")
          ? "z"
          : line.startsWith("regress y xhat")
            ? "xhat"
            : "x";
      return [
        line,
        equal(`_b[${name}]`, result.b),
        equal(`_se[${name}]`, result.se),
        equal("_b[_cons]", result.intercept),
        `lincom ${name}`,
        equal("r(lb)", result.lo, 1e-6),
        equal("r(ub)", result.hi, 1e-6),
      ];
    });
  commands.push(
    equal("r(F)", ar.f),
    equal("r(p)", ar.p, 1e-7),
    "estimates restore correct_iv",
    equal("el(e(V),1,1)", s.iv.covariance[0][0]),
    equal("el(e(V),1,2)", s.iv.covariance[0][1]),
    equal("el(e(V),2,2)", s.iv.covariance[1][1]),
    // This installed Stata rejects a weakrobust test after a non-95 global
    // set level, even without a level option on that test. The F test itself
    // is level-independent; the confidence-set call below passes its level.
    "set level 95",
    `estat weakrobust, ar betanull(${entry.candidate})`,
    equal("r(arF)", ar.f),
    equal("r(p_arF)", ar.p, 1e-7),
    `estat weakrobust, ar ci level(${s.parameters.confidence * 100})`,
    "matrix ar_bounds = r(ar_ci)",
    `assert rowsof(ar_bounds) == ${s.ar.intervals.length}`,
  );
  s.ar.intervals.forEach((interval, i) =>
    interval.forEach((value, j) =>
      commands.push(
        Number.isFinite(value)
          ? equal(`el(ar_bounds,${i + 1},${j + 1})`, value, 1e-6)
          : `assert el(ar_bounds,${i + 1},${j + 1}) == ${value < 0 ? ".l" : ".u"}`,
      ),
    ),
  );
  await fs.writeFile(
    path.join(destination, "candidate.do"),
    commands.join("\n") + "\n",
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
  const receipt = {
    case: entry.id,
    returnCode: code,
    checks: [
      "first stage",
      "reduced form",
      "OLS",
      "2SLS small-sample covariance",
      "naive second stage",
      "Wald endpoints",
      "transformed-outcome AR test",
      "official estat weakrobust AR test",
      "full 2SLS covariance matrix",
      "official confidence-set topology and finite/infinite endpoints",
    ],
  };
  results.push(receipt);
  console.log(JSON.stringify(receipt));
}
await fs.writeFile(
  "docs/verification/iv-native.json",
  JSON.stringify(
    {
      method:
        "Native Stata exported IV workflows and official weakrobust tests",
      limits: [
        `${cases.length} synthetic cases; not general equivalence`,
        "Native double input replaces Java-dependent CSV import",
        "Installed Stata requires global set level 95 for weakrobust tests; confidence-set level remains explicitly selected",
      ],
      cases: results,
    },
    null,
    2,
  ) + "\n",
);
if (results.some((r) => r.returnCode !== "0")) {
  console.log(`Failure logs retained privately at ${folder}`);
  process.exitCode = 1;
}
