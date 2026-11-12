// Records what installed Stata reports for robust and clustered standard
// errors, so that tests/runtime-cluster.test.mjs can compare src/runtime
// without Stata. Run from the repository root: node tools/check-cluster-native.mjs
// The data are invented here. Stata's log is written to a temporary folder
// and removed; only the numbers reach tests/fixtures.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import prettier from "prettier";

const NAMES = "firm year cl reg cls z x1 x2 yb cnt y".split(" ");

/** 48 rows: 12 firms over 4 years, in 8 clusters and 4 regions. */
export function clusterData() {
  let state = 12345;
  const u = () =>
      (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648,
    round = (v, places) => Math.round(v * 10 ** places) / 10 ** places,
    rows = [];
  for (let i = 0; i < 48; i++) {
    const firm = Math.floor(i / 4) + 1,
      cl = ((firm - 1) % 8) + 1,
      z = round(u() * 10, 1),
      x2 = round(u() * 5, 1),
      x1 = round(0.5 * z + 3 * u() + cl * 0.3, 1),
      e = u() - 0.5 + (cl % 3) * 0.2;
    rows.push({
      firm,
      year: (i % 4) + 1,
      cl,
      reg: ((firm - 1) % 4) + 1,
      cls: "g" + String.fromCharCode(96 + cl),
      z,
      x1,
      x2,
      yb: x1 * 0.4 - x2 * 0.3 + e * 3 > 1.2 ? 1 : 0,
      cnt: Math.max(0, Math.round(1 + 0.3 * x1 + 2 * e + u())),
      y: round(1 + 0.8 * x1 - 0.5 * x2 + 4 * e, 2),
    });
  }
  return {
    columns: NAMES.map((name) => ({
      name,
      type: name === "cls" ? "string" : "number",
    })),
    rows,
  };
}

// Every form the runtime acts on, and the ones it must refuse.
export const COMMANDS = [
  "logit yb x1 x2, vce(cluster cl)",
  "logit yb x1 x2, vce(cluster cls)",
  "logit yb x1 x2, cluster(cl)",
  "logit yb x1 x2, vce(robust)",
  "logit yb x1 x2 if year > 1, vce(cluster cl) or",
  "probit yb x1 x2, vce(cluster cl)",
  "poisson cnt x1 x2, vce(cluster cl)",
  "poisson cnt x1 x2, vce(cl firm) irr",
  "ivregress 2sls y x2 (x1 = z), vce(cluster cl)",
  "ivregress 2sls y x2 (x1 = z), cluster(cls)",
  "ivregress 2sls y x2 (x1 = z), vce(robust)",
  "regress y x1 x2, vce(cluster cl)",
  "regress y x1 x2, vce(cluster cls)",
  "regress y x1 x2, cluster(cl)",
  "xtreg y x1 x2, fe vce(cluster firm)",
  "xtreg y x1 x2, re vce(cluster firm)",
  "xtreg y x1 x2, fe vce(robust)",
];

const KEEP = /adjusted for|^\s+(x1|x2|_cons) \|/;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { rows } = clusterData(),
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "stataverse-cluster-")),
    input = [
      "input double(firm year cl reg) str2 cls double(z x1 x2 yb cnt y)",
      ...rows.map((row) =>
        NAMES.map((n) => (n === "cls" ? `"${row[n]}"` : row[n])).join(" "),
      ),
      "end",
    ],
    body = COMMANDS.flatMap((command, k) => [
      `display "@@ ${k}"`,
      `capture noisily ${command}`,
      'display "@rc " _rc',
      "matrix list e(V), format(%22.15e)",
      'display "@N_clust " e(N_clust) " @vce " e(vce)',
    ]);
  await fs.writeFile(
    path.join(folder, "run.do"),
    [
      "version 17",
      "set processors 1",
      "set more off",
      "set linesize 255",
      "clear",
      ...input,
      "xtset firm year",
      ...body,
      "",
    ].join("\n"),
  );
  try {
    await promisify(execFile)(
      "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
      ["-b", "-q", "do", "run.do"],
      { cwd: folder, timeout: 120000 },
    );
    const log = await fs.readFile(path.join(folder, "run.log"), "utf8"),
      cases = log
        .split(/\n@@ /)
        .slice(1)
        .map((block) => {
          const k = Number(block.split("\n")[0]),
            matrix = /e\(V\)\[\d+,\d+\]\n([\s\S]*?)\n\n/.exec(block),
            tail = /@N_clust (\S+) @vce (\S+)/.exec(block);
          return {
            command: COMMANDS[k],
            rc: Number(/@rc (\d+)/.exec(block)[1]),
            // The lower triangle of e(V), row by row.
            V: matrix[1]
              .split("\n")
              .filter((line) => /e[+-]\d\d/.test(line))
              .map((line) => line.trim().split(/\s+/).slice(1).map(Number)),
            clusters: tail[1] === "." ? null : Number(tail[1]),
            vce: tail[2],
            lines: block.split("\n").filter((line) => KEEP.test(line)),
          };
        });
    if (cases.length !== COMMANDS.length || cases.some((c) => c.rc))
      throw new Error("Stata did not run every command");
    await fs.writeFile(
      "tests/fixtures/stata-runtime-cluster.json",
      await prettier.format(
        JSON.stringify({ stata: "version 17, set processors 1", cases }),
        { parser: "json" },
      ),
    );
    console.log(`${cases.length} commands recorded`);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}
