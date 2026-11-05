import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyBuilder, buildDoFile, METHODS } from "../src/do-builder-model.js";
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-builder-native-"),
);
const project = path.join(folder, "Student's course — data");
await fs.mkdir(project);
const setup = [
  "clear",
  "set seed 42517",
  "set obs 600",
  "generate id=ceil(_n/6)",
  "generate year=2000+mod(_n-1,6)",
  "generate group=mod(id,2)",
  "generate double x1=rnormal()",
  "generate double z=rnormal()",
  "generate double u=rnormal()",
  "generate double x2=.7*z+.3*x1+.4*u+rnormal()",
  "generate double y=2+x1+.8*x2+u",
  "generate byte binary=runiform()<invlogit(.3*x1+.2*x2)",
  "generate count_y=rpoisson(exp(.5+.1*x1))",
  "generate double positive=exp(.2*x1)",
  "generate str8 numeric_text=string(id)",
  'generate str8 category=cond(group==0,"A","B")',
  "generate coded=cond(_n<4,-99,x1)",
  `save "${project}/data.dta", replace`,
];
const cases = [];
for (const { id } of METHODS)
  for (const vce of ["describe", "scatter", "ttest"].includes(id)
    ? ["robust"]
    : ["conventional", "robust", "cluster"]) {
    cases.push({
      id: `${id}-${vce}`,
      plan: {
        method: id,
        vce,
        outcome: id === "logit" ? "binary" : id === "poisson" ? "count_y" : "y",
        predictors:
          id === "scatter" ? "x1" : id === "describe" ? "y x1 x2" : "x1",
        endogenous: "x2",
        instruments: "z",
        panel: "id",
        time: "year",
        cluster: "id",
        group: "group",
      },
    });
  }
for (const step of [
  { type: "rename", variable: "positive", target: "renamed" },
  { type: "log", variable: "positive", target: "logged" },
  { type: "square", variable: "x1", target: "squared" },
  { type: "center", variable: "x1", target: "centered" },
  { type: "encode", variable: "category", target: "encoded" },
  { type: "destring", variable: "numeric_text", target: "converted" },
  { type: "missing", variable: "coded", value: "-99" },
  { type: "filter", variable: "id", operator: "<=", value: "50" },
  { type: "dropmissing", variable: "coded" },
])
  cases.push({
    id: `prepare-${step.type}`,
    plan: { steps: [step], saveData: true },
  });
cases.push({
  id: "factor-interaction",
  plan: {
    method: "ols",
    outcome: "y",
    predictors: "c.x1##i.group",
    vce: "cluster",
    cluster: "id",
  },
});
const wrapper = [
  "set processors 1",
  "set more off",
  ...setup,
  `file open receipts using "${folder}/receipts.txt", write text replace`,
];
for (const [i, c] of cases.entries()) {
  const p = {
    ...emptyBuilder(),
    project,
    file: "data.dta",
    format: "dta",
    stem: `case_${i}`,
    replace: true,
    ...c.plan,
  };
  const result = buildDoFile(p);
  if (result.errors.length)
    throw new Error(JSON.stringify({ case: c.id, errors: result.errors }));
  const checks = [
    "assert _N > 0",
    ...(["ols", "logit", "poisson", "iv", "fe"].includes(p.method)
      ? ["assert e(N) > 0", "matrix V=e(V)", "assert trace(V)>0 & trace(V)<."]
      : []),
  ];
  if (c.id === "prepare-log")
    checks.push("assert abs(logged-ln(positive))<1e-12");
  if (c.id === "prepare-center")
    checks.push("quietly summarize centered", "assert abs(r(mean))<1e-12");
  if (c.id === "prepare-destring") checks.push("assert converted==id");
  if (c.id === "prepare-missing") checks.push("assert missing(coded) in 1/3");
  if (c.id === "prepare-filter") checks.push("assert _N==300");
  await fs.writeFile(
    path.join(folder, `case-${i}.do`),
    result.code + checks.join("\n") + "\n",
  );
  wrapper.push(
    `capture noisily do "${folder}/case-${i}.do"`,
    "local rc=_rc",
    `file write receipts "${i}:\`rc'" _n`,
  );
}
wrapper.push("file close receipts", "exit, clear", "");
await fs.writeFile(path.join(folder, "audit.do"), wrapper.join("\n"));
await promisify(execFile)(
  "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
  ["-b", "do", "audit.do"],
  { cwd: folder, timeout: 180000 },
);
const receipts = new Map(
  (await fs.readFile(path.join(folder, "receipts.txt"), "utf8"))
    .trim()
    .split("\n")
    .map((s) => s.split(":")),
);
const results = cases.map((c, i) => ({
  case: c.id,
  returnCode: receipts.get(String(i)) ?? "missing",
}));
await fs.writeFile(
  "docs/verification/builder-native.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      method:
        "Actual generated do-files run against constructed .dta input; output files, model covariance and selected preparation identities checked.",
      limits: [
        "Execution checks do not establish identification, empirical suitability or full Stata compatibility.",
        "Native test runs on macOS; Windows path normalization is covered by JavaScript and browser tests, not a Windows Stata run.",
        "CSV and Excel import syntax follows official manuals; these native cases use .dta input.",
        "Raw native logs remain outside the repository.",
      ],
      cases: results,
    },
    null,
    2,
  ) + "\n",
);
const failures = results.filter((c) => c.returnCode !== "0");
console.log(
  JSON.stringify(
    {
      cases: results.length,
      failures,
      ...(failures.length ? { privateLogs: folder } : {}),
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
