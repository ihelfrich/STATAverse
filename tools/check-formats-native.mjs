// Records how installed Stata displays numbers, strings and dates under
// display formats, and what string() returns, for src/runtime/format.js.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { format } from "prettier";

export const VALUES = [
  "0",
  "1",
  "-1",
  "0.1",
  "float(0.1)",
  "1/3",
  "2/3",
  "-2/3",
  "123456789",
  "1234567.891",
  "1e10",
  "1.5e-5",
  "123.456",
  "1e-10",
  "99999.5",
  "0.000123456",
  "-0.5",
  "1e100",
  "12345678901234567890",
  ".",
  ".a",
  "16777216",
  "3.14159265358979",
  "100",
  "1000000",
  "0.05",
  "1e15",
  "1e16",
  "0.1+0.2",
  "999999999",
  "1234.5",
  "-1234567.891",
  "0.5",
  "2.5",
  "1e-5",
  "123456.7",
  "9.99999",
  "0.999999",
  "12345.678",
  "-0.000001",
  "1e7",
  "1e8",
  "1e9",
  "0.0001",
  "0.00001",
  "1234567890123",
  "42",
  "-42.42",
  "1e300",
  "1e-300",
  "99.995",
  "0.005",
  "1.005",
  "-1e-10",
  "65.25",
  "9999999",
  "99999999",
  "0.12345678901",
  "8.5e-8",
  "5e5",
  "1.23e22",
];
export const FORMATS = [
  "%9.0g",
  "%10.0g",
  "%8.0g",
  "%12.0g",
  "%9.2f",
  "%9.0f",
  "%12.3f",
  "%10.4f",
  "%5.1f",
  "%9.2e",
  "%12.4e",
  "%12.0gc",
  "%12.2fc",
  "%-9.2f",
  "%09.2f",
  "%9.3g",
  "%15.0g",
  "%18.0g",
  "%4.0g",
  "%3.0f",
  "%05.0f",
  "%12.0fc",
  "%6.3g",
  "%9.4g",
  "%10.7g",
  "%-9.0g",
  "%20.10f",
  "%8.2g",
  "%1.0f",
  "%7.0g",
  "%6.0g",
  "%5.0g",
  "%9.1g",
  "%16.0g",
  "%9.0gc",
];
export const STRINGS = [
  ['"abc"', "%9s"],
  ['"abc"', "%-9s"],
  ['"abcdefghijkl"', "%3s"],
  ['"abc"', "%~9s"],
  ['"abcd"', "%~9s"],
  ['""', "%5s"],
  ['"naïve"', "%9s"],
  ['"abc"', "%1s"],
  ['"ab"', "%-5s"],
];
export const DATES = [
  ...["0", "24420", "-1", "21974", ".", "24420.7", "-58438", "2936549"].flatMap(
    (v) =>
      [
        "%td",
        "%tdDD/NN/CCYY",
        "%tdCCYY-NN-DD",
        "%tdMonth_DD,_CCYY",
        "%tdDay",
        "%tdDDmonYY",
        "%tdnn/dd/YY",
        "%tdMon_dd",
        "%tdDayname,_dd_Month_CCYY",
        "%tdDD.NN.CCYY",
        "%tdCCYYNNDD",
        "%tdJJJ",
        "%tdq",
        "%tdww",
        "%-td",
        "%12td",
        "%tdDD!xNN",
        "%d",
        "%tdmon",
        "%tdMON",
        "%tddd_mm_yy",
      ].map((f) => [v, f]),
  ),
  ...["802", "0", "-1", "."].flatMap((v) =>
    ["%tm", "%tmCCYY-NN", "%tmMon_CCYY", "%tmMonth_CCYY", "%tmCCYY!mNN"].map(
      (f) => [v, f],
    ),
  ),
  ...["267", "0", "-1"].flatMap((v) =>
    ["%tq", "%tqCCYY!Qq", "%tqCCYY-q"].map((f) => [v, f]),
  ),
  ["2026", "%ty"],
  ["3476", "%tw"],
  ["133", "%th"],
  ["0", "%tw"],
  ["0", "%th"],
];
export const FUNCTIONS = [
  "string(3.5)",
  "string(1/3)",
  "string(100000000)",
  "string(1e10)",
  "string(.)",
  "string(.a)",
  'string(3,"%5.2f")',
  'string(1234567.891,"%12.2fc")',
  "string(0.1)",
  "string(-0.5)",
  "string(1e-5)",
  "string(123456789012)",
  "strofreal(2)",
  'string(24420,"%td")',
  "string(float(0.1))",
  "string(1234567)",
  "string(0.000012345)",
  'string("a")',
  "string(1234567890)",
  "string(0.5)",
  "string(-1/3)",
  "string(1e15)",
  "string(1e16)",
  "string(2^53)",
  "string(123456.789)",
  'string(5,"%9.0g")',
  'string(5,"%-9.0g")',
  'string(5,"%05.0f")',
  'string(1/3,"%9.3f")',
  'string(3,"bad")',
  'string(3,"%9s")',
  "string(1e-10)",
  "string(12345678)",
  "string(123456789)",
  "string(0.1+0.2)",
  "string(99999999.5)",
  'string(1.5)+"x"',
];
// display EXP with no format.
export const DISPLAY = [
  "1",
  "1/3",
  "0.1",
  "float(0.1)",
  "1e10",
  "123456789",
  "1234567890",
  "12345678901",
  "1e-5",
  ".",
  ".b",
  "-0.5",
  "2/3",
  "100000",
  "1e15",
  "1e16",
  "3.14159265358979",
  "1234.5678",
  "0.000123456789",
  "1e100",
  "-1234567.891",
  "16777217",
  "0.1+0.2",
  "1e7",
  "99999999",
  "999999999.9",
  "1.5e-10",
  "22/7",
  "1e9",
  "5e-324",
  "123456.123456",
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "stataverse-formats-native-"),
  );
  const cases = [
    ...VALUES.flatMap((value) =>
      FORMATS.map((f) => ({ kind: "number", value, format: f })),
    ),
    ...STRINGS.map(([value, f]) => ({ kind: "string", value, format: f })),
    ...DATES.map(([value, f]) => ({ kind: "date", value, format: f })),
    ...FUNCTIONS.map((value) => ({ kind: "function", value })),
    ...DISPLAY.map((value) => ({ kind: "display", value })),
  ];
  const audit = [
    "version 17",
    "set processors 1",
    "set more off",
    "clear",
    'file open out using "out.tsv", write text replace',
  ];
  cases.forEach((c, k) => {
    // A failed file write leaves part of a line behind, so each result is
    // built in a string scalar first.
    const expression =
      c.kind === "function"
        ? c.value
        : c.kind === "display"
          ? null
          : `string(${c.value}, "${c.format}")`;
    if (c.kind === "string")
      audit.push(
        `capture file write out "${k}" _tab "[" ${c.format} (${c.value}) "]" _n`,
        `if _rc file write out _n "${k}" _tab "E\`=_rc'" _n`,
      );
    else if (c.kind === "display")
      audit.push(
        `file write out "${k}" _tab "["`,
        `capture file write out (${c.value})`,
        `file write out "]" _n`,
      );
    else if (c.kind === "function")
      audit.push(
        "capture scalar drop __v",
        `capture scalar __v = ${expression}`,
        "local rc = _rc",
        "if `rc' {",
        `file write out "${k}" _tab "E\`rc'" _n`,
        "}",
        "else {",
        `file write out "${k}" _tab "[" (scalar(__v)) "]" _n`,
        "}",
      );
    else
      audit.push(
        `file write out "${k}" _tab "["`,
        `capture file write out ${c.format} (${c.value})`,
        "local rc = _rc",
        'file write out "]"',
        "if `rc' file write out \"E`rc'\"",
        "file write out _n",
      );
  });
  audit.push("file close out", "exit, clear", "");
  await fs.writeFile(path.join(folder, "audit.do"), audit.join("\n"));
  await promisify(execFile)(
    "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
    ["-b", "do", "audit.do"],
    { cwd: folder, timeout: 180000 },
  );
  const lines = (await fs.readFile(path.join(folder, "out.tsv"), "utf8"))
    .split("\n")
    .filter(Boolean);
  for (const line of lines) {
    const tab = line.indexOf("\t"),
      k = Number(line.slice(0, tab)),
      text = line.slice(tab + 1),
      c = cases[k];
    if (!c) continue;
    const error = /^(?:\[\])?E(\d+)$/.exec(text);
    if (error) c.rc = Number(error[1]);
    else c.text = text.slice(1, -1);
  }
  const unfinished = cases.filter(
    (c) => c.rc === undefined && c.text === undefined,
  );
  if (unfinished.length)
    throw new Error(
      `Stata did not report ${unfinished.length} cases, first: ${JSON.stringify(unfinished[0])}. See ${folder}/audit.log`,
    );
  await fs.writeFile(
    "tests/fixtures/stata-runtime-formats.json",
    await format(
      JSON.stringify({
        source:
          "Recorded from installed Stata by tools/check-formats-native.mjs under version 17.",
        cases,
      }),
      { parser: "json" },
    ),
  );
  console.log(`Recorded ${cases.length} format cases from installed Stata.`);
  await fs.rm(folder, { recursive: true, force: true });
}
