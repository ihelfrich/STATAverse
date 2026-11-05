import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  METHOD_CATALOG,
  METHOD_GROUPS,
  compareMethods,
} from "../src/method-comparison.js";

// Execute the actual templates against deterministic synthetic data. This checks
// accepted syntax, populated estimates and supported covariance options, not
// identification, finite-sample performance or empirical model suitability.
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-method-native-"),
);
const root = process.cwd(),
  cases = [],
  seen = new Set();
const allChoices = METHOD_GROUPS.reduce(
  (rows, group) =>
    rows.flatMap((row) =>
      group.options.map((o) => ({ ...row, [group.id]: o.id })),
    ),
  [{}],
);
for (const choice of allChoices)
  for (const method of compareMethods(choice).methods) {
    if (method.blocked) continue;
    const key = [choice.outcome, choice.structure, method.code].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const panel = choice.structure === "panel";
    const y = {
      continuous: "1 + 1.2*x1 + .5*x2 + u",
      binary: "runiform() < invlogit(.2 + .3*x1 + .2*x2)",
      count: "rpoisson(exp(.5 + .2*x1 + .1*x2))",
      fraction:
        "((runiform() < invlogit(x1/3)) + (runiform() < invlogit(x1/3)) + (runiform() < invlogit(x1/3)))/3",
      duration: "1",
    }[choice.outcome];
    cases.push({
      name: [
        choice.outcome,
        choice.structure,
        method.id,
        choice.dependence,
      ].join("-"),
      checks: [
        "actual generated template executes",
        "nonempty estimation sample",
        "finite coefficient covariance",
      ],
      commands: [
        "clear",
        "set seed 18709",
        "set obs 600",
        `generate id = ${panel ? "ceil(_n/6)" : "_n"}`,
        "generate time = mod(_n-1,6)+1",
        "generate cluster_id = ceil(id/4)",
        "generate double x2 = rnormal()",
        "generate double z1 = rnormal()",
        "generate double u = rnormal()",
        "generate double x1 = .7*z1 + .3*x2 + .4*u + rnormal()",
        `generate double y = ${y}`,
        "generate treated = mod(id,2)",
        "generate post = time > 3",
        "generate start = time-1",
        "generate stop = time",
        "generate double duration = -ln(runiform())/exp(.3*x1+.2*x2)",
        `generate event = ${panel ? "time == 6 & " : ""}runiform() > .3`,
        ...(method.id === "did" ? ["keep if inlist(time,1,6)"] : []),
        method.code,
        "assert e(N) > 0",
        "assert e(N) < .",
        "matrix variance = e(V)",
        "assert trace(variance) > 0",
        "assert trace(variance) < .",
      ].join("\n"),
    });
  }
for (const suffix of ["", "_v2"]) {
  const source = path.join(
    root,
    `CodeLibrary/scripts/02_method_decision_tree${suffix}.do`,
  );
  for (const topic of [
    "",
    ...Object.keys(METHOD_CATALOG.methods),
    "unknown-topic",
  ]) {
    cases.push({
      name: `reference${suffix}:${topic || "default"}`,
      checks: [
        "topic return code",
        "existing data, sort order and labels preserved",
      ],
      commands: [
        "clear",
        "set obs 3",
        "generate sentinel = 4-_n",
        'label variable sentinel "Preserve this label"',
        "datasignature set",
        `capture noisily do "${source}" ${topic}`,
        `assert _rc == ${topic === "unknown-topic" ? 198 : 0}`,
        "datasignature confirm",
        "assert _N == 3",
        "assert sentinel == 4-_n",
        "local label : variable label sentinel",
        'assert "`label\'" == "Preserve this label"',
      ].join("\n"),
    });
  }
}
const wrapper = [
  "set processors 1",
  "set more off",
  'file open checks using "receipts.txt", write text replace',
];
for (let i = 0; i < cases.length; i++) {
  await fs.writeFile(
    path.join(folder, `case-${i}.do`),
    cases[i].commands + "\n",
  );
  wrapper.push(
    `capture noisily do "case-${i}.do"`,
    "local result = _rc",
    `file write checks "${i}:\`result'" _n`,
  );
}
wrapper.push("file close checks", "exit, clear", "");
await fs.writeFile(path.join(folder, "audit.do"), wrapper.join("\n"));
try {
  await promisify(execFile)(
    "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
    ["-b", "do", "audit.do"],
    { cwd: folder, timeout: 180000 },
  );
} catch {
  console.error(
    `Native execution did not finish normally. Private logs: ${folder}`,
  );
  process.exitCode = 1;
}
const receipts = new Map(
  (await fs.readFile(path.join(folder, "receipts.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split(":")),
);
const results = cases.map((c, i) => ({
  case: c.name,
  returnCode: receipts.get(String(i)) || "missing receipt",
  checks: c.checks,
}));
const report = {
  checkedAt: new Date().toISOString(),
  method:
    "Native Stata generated method templates and printable reference topics",
  limits: [
    "Deterministic synthetic data; execution is not evidence of identification or empirical suitability.",
    "Outcome/structure/code combinations deduplicated; all native reference topics and unknown-topic handling exercised.",
    "Blocked survey and unresolved-inference commands are deliberately not executed.",
    "Raw license-bearing logs stay outside the repository.",
  ],
  cases: results,
};
await fs.writeFile(
  "docs/verification/method-native.json",
  JSON.stringify(report, null, 2) + "\n",
);
const failures = results.filter((r) => r.returnCode !== "0");
console.log(JSON.stringify({ checked: results.length, failures }, null, 2));
if (failures.length) {
  console.log(`Private failure logs: ${folder}`);
  process.exitCode = 1;
}
