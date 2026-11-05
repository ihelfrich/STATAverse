import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const sourcePath = "CodeLibrary/scripts/06_panel_data_toolkit.do";
const source = await fs.readFile(sourcePath);
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-panel-native-"),
);
const commands = [
  `do "${path.resolve(sourcePath)}"`,
  "assert _N == 2000",
  "isid firm_id year",
  "assert inrange(year,2010,2019)",
  "bysort firm_id: assert firm_quality == firm_quality[1]",
  "foreach v in experience competition innovation {",
  "    bysort firm_id: egen double check_`v' = mean(`v'_within)",
  "    assert abs(check_`v') < 1e-12",
  "}",
  "estimates restore fe",
  "matrix fe_b = e(b)",
  "scalar fe_exp = _b[experience]",
  "scalar fe_comp = _b[competition]",
  "scalar fe_innov = _b[innovation]",
  "quietly regress performance experience competition innovation i.firm_id i.year, vce(cluster firm_id)",
  "assert abs(_b[experience]-fe_exp) < 1e-9",
  "assert abs(_b[competition]-fe_comp) < 1e-9",
  "assert abs(_b[innovation]-fe_innov) < 1e-9",
  "estimates restore hybrid",
  "assert abs(_b[experience_within]-fe_exp) < 1e-9",
  "assert abs(_b[competition_within]-fe_comp) < 1e-9",
  "assert abs(_b[innovation_within]-fe_innov) < 1e-9",
  "foreach v in experience competition innovation {",
  "    assert _se[`v'_mean] > 0 & _se[`v'_mean] < .",
  "}",
  "test (experience_mean=experience_within) (competition_mean=competition_within) (innovation_mean=innovation_within)",
  "assert r(df) == 3",
  "assert inrange(r(p),0,1)",
  "estimates restore dynamic_ab",
  "assert e(N_g) == 250",
  "assert e(N) > 0 & e(N) < .",
  "assert _se[L.y] > 0 & _se[L.y] < .",
  "estat abond",
  'file open coefficients using "coefficients.csv", write text replace',
  'file write coefficients "model,term,b,se" _n',
];
for (const model of ["pooled", "fe", "re", "hybrid", "dynamic_ab"]) {
  commands.push(`estimates restore ${model}`);
  const terms =
    model === "hybrid"
      ? [
          "experience_within",
          "competition_within",
          "innovation_within",
          "experience_mean",
          "competition_mean",
          "innovation_mean",
        ]
      : model === "dynamic_ab"
        ? ["L.y", "x"]
        : ["experience", "competition", "innovation"];
  for (const term of terms)
    commands.push(
      `file write coefficients "${model},${term}," %24.16e (_b[${term}]) "," %24.16e (_se[${term}]) _n`,
    );
}
commands.push(
  "file close coefficients",
  "estimates restore fe",
  "assert _N == 2000",
  "",
);
await fs.writeFile(path.join(folder, "candidate.do"), commands.join("\n"));
await fs.writeFile(
  path.join(folder, "audit.do"),
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
await promisify(execFile)(
  "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
  ["-b", "do", "audit.do"],
  { cwd: folder, timeout: 90000 },
);
const returnCode = (
  await fs.readFile(path.join(folder, "receipt.txt"), "utf8")
).trim();
const report = {
  checkedAt: new Date().toISOString(),
  source: sourcePath,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  returnCode,
  checks: [
    "full script executes without user-written packages",
    "static panel restored after separate dynamic example",
    "within deviations have zero firm means",
    "FE slopes match explicit unit/year indicators",
    "within-between within slopes match FE",
    "between coefficients have positive finite standard errors",
    "clustered joint restrictions execute with three degrees of freedom",
    "native dynamic-panel estimation and serial-correlation checks execute",
  ],
  limits: [
    "One deterministic constructed static panel and a separate dynamic panel; not a Monte Carlo study or evidence for empirical identification.",
    "Algebraic coefficient comparisons do not imply equal finite-sample covariance corrections.",
    "Raw license-bearing logs remain outside the repository.",
  ],
};
await fs.writeFile(
  "docs/verification/panel-native.json",
  JSON.stringify(report, null, 2) + "\n",
);
if (returnCode !== "0") {
  console.error(JSON.stringify({ returnCode, privateLogs: folder }));
  process.exitCode = 1;
} else {
  const rows = (
    await fs.readFile(path.join(folder, "coefficients.csv"), "utf8")
  )
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [model, term, b, se] = line.split(",");
      return { model, term, b: Number(b), se: Number(se) };
    });
  if (
    rows.length !== 17 ||
    rows.some(
      (r) => !Number.isFinite(r.b) || !Number.isFinite(r.se) || r.se <= 0,
    )
  )
    throw new Error("Invalid native reference values");
  await fs.writeFile(
    "assets/data/panel-output.json",
    JSON.stringify(
      {
        sourceSha256: report.sourceSha256,
        origin:
          "Native Stata output for the bundled do-file and its fixed seeds",
        staticSample: { firms: 200, periods: 10, observations: 2000 },
        dynamicSample: { firms: 250, retainedPeriods: 10 },
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      returnCode,
      checks: report.checks,
      outputRows: rows.length,
    }),
  );
}
