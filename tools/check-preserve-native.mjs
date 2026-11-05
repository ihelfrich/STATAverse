import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PracticeSession } from "../src/engine.js";

const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-preserve-native-"),
);
const commands = [
  "restore",
  "preserve",
  "preserve",
  'keep if group == "A"',
  "restore, preserve",
  'keep if group == "B"',
  "restore, not",
  "restore",
  "preserve",
  "clear",
  "restore",
  "preserve",
  "clear all",
  "restore",
  'label variable hours "Before copy"',
  "preserve",
  'label variable hours "Temporary"',
  "sort score",
  "generate double minutes = hours * 60",
  "restore",
];
const session = new PracticeSession();
const original = session.data;
const lines = [
  "clear all",
  "input double(id hours attendance score) str1 group",
  ...original.rows.map((row) =>
    [
      row.id,
      row.hours ?? ".",
      row.attendance ?? ".",
      row.score ?? ".",
      `"${row.group}"`,
    ].join(" "),
  ),
  "end",
];
const cases = [];
for (const command of commands) {
  const result = session.run(command).at(-1);
  const code = result.kind === "error" ? result.code : 0;
  cases.push({
    command,
    expectedReturnCode: code,
    observations: session.data.rows.length,
    preserved: Boolean(session.preservedData),
  });
  lines.push(
    `capture noisily ${command}`,
    `if _rc != ${code} error 9`,
    `if _N != ${session.data.rows.length} error 9`,
  );
  if (session.data.columns.some((c) => c.name === "id"))
    for (const [i, row] of session.data.rows.entries())
      lines.push(`assert id == ${row.id} in ${i + 1}`);
}
lines.push(
  "local restored_label : variable label hours",
  'assert "`restored_label\'" == "Before copy"',
  "capture confirm variable minutes",
  "assert _rc == 111",
);
await fs.writeFile(path.join(folder, "candidate.do"), lines.join("\n") + "\n");
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
  { cwd: folder, timeout: 30000 },
);
const code = (
  await fs.readFile(path.join(folder, "receipt.txt"), "utf8")
).trim();
await fs.writeFile(
  "docs/verification/preserve-native.json",
  JSON.stringify(
    {
      method:
        "Native Stata checks of return codes, row counts, order, labels and removed temporary columns",
      returnCode: code,
      cases,
      limits: [
        "Checks the stated sequence in one native do-file. Browser Run actions retain an explicit interactive preserve scope.",
        "Preserve options outside the documented browser subset remain unsupported.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    returnCode: code,
    cases: cases.length,
    ...(code !== "0" ? { privateLogFolder: folder } : {}),
  }),
);
if (code !== "0") process.exitCode = 1;
