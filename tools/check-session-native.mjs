// Runs the do-file cases in tools/session-cases.txt in installed Stata and
// records, for each, the return code, the data left in memory, named local
// and global macros and named r() results. tests/runtime-session.test.mjs
// runs the same text through src/runtime/session.js and compares.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { format } from "prettier";
import { hexToDouble } from "./check-runtime-native.mjs";

export const BASE = `clear
input byte id double x float f byte g str12 s
1 1.5 0.1 1 "apple"
2 -2 0.2 1 "Banana split"
3 . 0.3 2 ""
4 0 1 2 "pad"
5 .a . 3 "x"
6 100 2.5 3 "kiwi"
end`;

export async function readCases(file = "tools/session-cases.txt") {
  const text = await fs.readFile(file, "utf8");
  return text
    .split(/^=== /m)
    .filter((part) => part.trim())
    .map((part) => {
      const [header, ...body] = part.split("\n"),
        [id, ...fields] = header.split("|").map((field) => field.trim()),
        named = (key) =>
          (fields.find((field) => field.startsWith(key + ":")) ?? "")
            .slice(key.length + 1)
            .trim()
            .split(/\s+/)
            .filter(Boolean);
      return {
        id,
        source:
          body
            .join("\n")
            .replace(/^@BASE$/m, BASE)
            .trimEnd() + "\n",
        locals: named("locals"),
        globals: named("globals"),
        r: named("r"),
      };
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = await readCases(),
    folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "stataverse-session-native-"),
    );
  const audit = [
    "version 17",
    "set processors 1",
    "set more off",
    'file open out using "out.tsv", write text replace',
  ];
  for (const [k, c] of cases.entries()) {
    await fs.writeFile(path.join(folder, `case-${k}.do`), c.source);
    await fs.writeFile(
      path.join(folder, `wrap-${k}.do`),
      [
        `capture noisily include "case-${k}.do"`,
        "local __rc = _rc",
        `file write out "${k}" _tab "rc" _tab "\`__rc'" _n`,
        ...c.r.map(
          (name) =>
            `file write out "${k}" _tab "r" _tab "${name}" _tab (string(r(${name}), "%21x")) _n`,
        ),
        ...c.locals.map(
          (name) =>
            `file write out "${k}" _tab "local" _tab "${name}" _tab \`"[\`${name}']"' _n`,
        ),
        ...c.globals.map(
          (name) =>
            `file write out "${k}" _tab "global" _tab "${name}" _tab \`"[$${name}]"' _n`,
        ),
        `file write out "${k}" _tab "n" _tab "\`=_N'" _n`,
        "local __sorted : sortedby",
        `file write out "${k}" _tab "sorted" _tab "\`__sorted'" _n`,
        "capture unab __vars : _all",
        'if _rc local __vars ""',
        "foreach v of local __vars {",
        "local t : type `v'",
        "local f : format `v'",
        "local vl : value label `v'",
        "local l : variable label `v'",
        `file write out "${k}" _tab "var" _tab "\`v'" _tab "\`t'" _tab "\`f'" _tab "[\`vl']" _tab \`"[\`l']"' _n`,
        "forvalues j = 1/`=_N' {",
        'if substr("`t\'", 1, 3) == "str" {',
        `file write out "${k}" _tab "val" _tab "\`v'" _tab "[" (\`v'[\`j']) "]" _n`,
        "}",
        "else {",
        `file write out "${k}" _tab "val" _tab "\`v'" _tab (string(\`v'[\`j'], "%21x")) _n`,
        "}",
        "}",
        "}",
        "",
      ].join("\n"),
    );
    audit.push(
      "clear",
      "capture program drop _all",
      "scalar drop _all",
      "capture label drop _all",
      "macro drop _all",
      "set type float",
      `capture noisily do "wrap-${k}.do"`,
    );
  }
  audit.push("file close out", "exit, clear", "");
  await fs.writeFile(path.join(folder, "audit.do"), audit.join("\n"));
  await promisify(execFile)(
    "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
    ["-b", "do", "audit.do"],
    { cwd: folder, timeout: 180000 },
  );
  const results = cases.map((c) => ({
    ...c,
    rc: null,
    localValues: {},
    globalValues: {},
    rValues: {},
    observations: null,
    sortedBy: [],
    variables: [],
  }));
  for (const line of (await fs.readFile(path.join(folder, "out.tsv"), "utf8"))
    .split("\n")
    .filter(Boolean)) {
    const [k, kind, ...rest] = line.split("\t"),
      c = results[Number(k)];
    if (kind === "rc") c.rc = Number(rest[0]);
    else if (kind === "r") c.rValues[rest[0]] = hexToDouble(rest[1]);
    else if (kind === "local")
      c.localValues[rest[0]] = rest.slice(1).join("\t").slice(1, -1);
    else if (kind === "global")
      c.globalValues[rest[0]] = rest.slice(1).join("\t").slice(1, -1);
    else if (kind === "n") c.observations = Number(rest[0]);
    else if (kind === "sorted")
      c.sortedBy = (rest[0] ?? "").split(" ").filter(Boolean);
    else if (kind === "var")
      c.variables.push({
        name: rest[0],
        type: rest[1],
        format: rest[2],
        valueLabel: rest[3].slice(1, -1),
        label: rest.slice(4).join("\t").slice(1, -1),
        values: [],
      });
    else if (kind === "val") {
      const variable = c.variables.find((v) => v.name === rest[0]),
        text = rest.slice(1).join("\t");
      variable.values.push(
        variable.type.startsWith("str") ? text.slice(1, -1) : hexToDouble(text),
      );
    }
  }
  const unfinished = results.filter(
    (c) => c.rc === null || c.observations === null,
  );
  if (unfinished.length)
    throw new Error(
      `Stata did not finish ${unfinished.length} cases, first: ${unfinished[0].id}. See ${folder}/audit.log`,
    );
  await fs.writeFile(
    "tests/fixtures/stata-runtime-sessions.json",
    await format(
      JSON.stringify({
        source:
          "Recorded from installed Stata by tools/check-session-native.mjs under version 17. Each case is a do-file run with include; numeric values were written with %21x and are exact.",
        cases: results,
      }),
      { parser: "json" },
    ),
  );
  console.log(`Recorded ${results.length} do-file cases from installed Stata.`);
  await fs.rm(folder, { recursive: true, force: true });
}
