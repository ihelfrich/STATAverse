import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const fixture = JSON.parse(
  await fs.readFile("tests/fixtures/grouped-data/cases.json", "utf8"),
);
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-grouped-native-"),
);
const input = [
  "clear",
  "input double(id g x y) str1 s",
  ...fixture.rows.map((r) =>
    [r.id, r.g ?? ".", r.x ?? ".", r.y ?? ".", JSON.stringify(r.s)].join(" "),
  ),
  "end",
];
const lines = ["set processors 1"];
for (const entry of fixture.cases) {
  lines.push(
    ...input,
    ...entry.commands.map((c) => `capture noisily ${c}`),
    "local rc = _rc",
    `file open out using "${entry.id}.txt", write text replace`,
    'file write out "`rc\'" _n',
    "if `rc' == 0 & _N > 0 {",
    "forvalues row = 1/`=_N' {",
    "file write out " +
      entry.columns
        .map((name) =>
          name === "s"
            ? "(s[`row']) _tab"
            : "%24.17g (" + name + "[`row']) _tab",
        )
        .join(" ") +
      " _n",
    "}",
    "}",
    "file close out",
  );
}
lines.push("exit, clear");
await fs.writeFile(path.join(folder, "audit.do"), lines.join("\n") + "\n");
await promisify(execFile)(
  "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
  ["-b", "do", "audit.do"],
  { cwd: folder, timeout: 30000 },
);
const cases = [];
for (const entry of fixture.cases) {
  const text = await fs.readFile(path.join(folder, `${entry.id}.txt`), "utf8"),
    records = text.trimEnd().split(/\r?\n/);
  const code = Number(records.shift());
  if (code !== (entry.code || 0))
    throw new Error(
      `Native case ${entry.id} returned ${code}; expected ${entry.code || 0}. Logs remain private in ${folder}.`,
    );
  const rows = code
    ? []
    : records.map((line) =>
        line
          .split("\t")
          .slice(0, entry.columns.length)
          .map((cell, i) =>
            entry.columns[i] === "s"
              ? cell
              : cell.trim() === "."
                ? null
                : Number(cell),
          ),
      );
  cases.push({ id: entry.id, code, rows });
}
const reference = {
  method:
    "Native Stata commands on explicit double-precision input; no CSV substitution or external packages",
  cases,
};
await fs.writeFile(
  "tests/fixtures/grouped-data/native.json",
  JSON.stringify(reference, null, 2) + "\n",
);
await fs.writeFile(
  "docs/verification/grouped-native.json",
  JSON.stringify(
    {
      method: reference.method,
      cases: cases.length,
      allExpectedReturnCodes: true,
      coverage: [
        "All implemented group and row functions",
        "Missing keys, all-missing groups, singleton SD and empty selections",
        "Variablewise versus casewise deletion",
        "Multiple grouping keys and numeric/string counts",
      ],
      limits: [
        "Finite synthetic fixtures, not complete Stata parity",
        "Browser egen accepts source variables rather than general expressions",
        "Weights, by prefixes, extended missing values and additional functions remain unsupported",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({ cases: cases.length, allExpectedReturnCodes: true }),
);
