// Records the text installed Stata prints for each command in the cases of
// tools/output-cases.txt, read from a text log. tests/runtime-output.test.mjs
// compares the new runtime's Results text with it line by line.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { format } from "prettier";
import { readCases } from "./check-session-native.mjs";

/**
 * Machine-written reporting do-files. The data come from runiform(), which
 * the runtime reproduces draw for draw, at magnitudes from thousandths to
 * millions, so the tables meet numbers of every width.
 */
export function randomReports(count) {
  const cases = [];
  for (let k = 1; k <= count; k++) {
    const n = 5 + ((k * 7) % 11),
      power = (k % 11) - 3;
    cases.push({
      id: `random-report-${k}`,
      source: [
        "clear",
        `set seed ${1000 + k}`,
        `set obs ${n}`,
        `generate double a = (runiform() - .5) * 10^${power}`,
        "generate float b = runiform() * 1000",
        "generate int c = floor(runiform() * 4)",
        "generate long d = floor(runiform() * 1e6)",
        "replace a = . in 2",
        "summarize",
        "summarize a d, detail",
        "tabulate c",
        "tabulate c if b > 300",
        "list a b c d in 1/5",
        "tabstat a b d, statistics(mean sd min max n)",
        "correlate a b d",
        "regress a b d",
        "codebook c d",
        "bysort c: summarize b",
        "",
      ].join("\n"),
    });
  }
  return cases;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = [
      ...(await readCases("tools/output-cases.txt")),
      ...randomReports(40),
    ],
    folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "stataverse-output-native-"),
    );
  const audit = [
    "version 17",
    "set processors 1",
    "set more off",
    "set linesize 200",
  ];
  for (const [k, c] of cases.entries()) {
    await fs.writeFile(path.join(folder, `case-${k}.do`), c.source);
    audit.push(
      "clear",
      "capture label drop _all",
      "scalar drop _all",
      "capture estimates clear",
      "macro drop _all",
      "set type float",
      `log using "case-${k}.log", text replace nomsg`,
      `capture noisily do "case-${k}.do"`,
      "log close",
    );
  }
  audit.push("exit, clear", "");
  await fs.writeFile(path.join(folder, "audit.do"), audit.join("\n"));
  await promisify(execFile)(
    "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
    ["-b", "do", "audit.do"],
    { cwd: folder, timeout: 180000 },
  );
  const results = [];
  for (const [k, c] of cases.entries()) {
    const lines = (
        await fs.readFile(path.join(folder, `case-${k}.log`), "utf8")
      ).split("\n"),
      commands = [];
    let current = null,
      started = false;
    for (const line of lines) {
      if (/^\. capture noisily do "case-/.test(line)) {
        started = true;
        continue;
      }
      if (!started) continue;
      if (/^end of do-file$/.test(line)) break;
      if (/^\. /.test(line) || line === ".") {
        current = { command: line.slice(2).trim(), lines: [] };
        if (current.command) commands.push(current);
      } else if (/^> /.test(line) && current && !current.lines.length)
        current.command += line.slice(2);
      else if (current) current.lines.push(line.replace(/\s+$/, ""));
    }
    for (const command of commands) {
      while (command.lines.length && !command.lines[0]) command.lines.shift();
      while (command.lines.length && !command.lines.at(-1)) command.lines.pop();
    }
    results.push({ id: c.id, source: c.source, commands });
  }
  await fs.writeFile(
    "tests/fixtures/stata-runtime-output.json",
    await format(
      JSON.stringify({
        source:
          "Recorded from installed Stata's text log by tools/check-output-native.mjs under version 17, with linesize 200. Leading and trailing blank lines of each command's output are removed.",
        cases: results,
      }),
      { parser: "json" },
    ),
  );
  console.log(
    `Recorded ${results.reduce((n, c) => n + c.commands.length, 0)} commands in ${results.length} cases from installed Stata.`,
  );
  await fs.rm(folder, { recursive: true, force: true });
}
