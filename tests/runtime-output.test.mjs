import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "../src/runtime/session.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/stata-runtime-output.json", import.meta.url),
    "utf8",
  ),
);
const trimmed = (lines) => {
  const out = lines
    .flatMap((line) => line.split("\n"))
    .map((line) => line.replace(/\s+$/, ""));
  while (out.length && !out[0]) out.shift();
  while (out.length && !out.at(-1)) out.pop();
  return out;
};
// Commands whose printed text is not compared, with the reason.
const SKIP = [
  // Data entry echoes the typed rows with line numbers in Stata's log.
  /^input\b/,
];

for (const c of fixture.cases)
  test(`Results text matches native Stata: ${c.id}`, () => {
    const session = new Session();
    // The record was made with set linesize 200.
    session.settings.linesize = 200;
    const ours = session.run(c.source).output.filter((o) => o.command.trim()),
      failures = [];
    // Stata's log shows the rows of an input block as output of input.
    const theirs = c.commands;
    let k = 0;
    for (const expected of theirs) {
      if (SKIP.some((pattern) => pattern.test(expected.command))) {
        k++;
        continue;
      }
      const actual = ours[k++];
      if (!actual) {
        failures.push(`${expected.command}: not run`);
        break;
      }
      if (
        actual.command.replace(/\s+/g, " ").trim() !==
        expected.command.replace(/\s+/g, " ").trim()
      ) {
        failures.push(`out of step: ${actual.command} vs ${expected.command}`);
        break;
      }
      const a = trimmed(actual.lines).filter(
          (line) => !/^r\(\d+\);$/.test(line),
        ),
        b = expected.lines.filter((line) => !/^r\(\d+\);$/.test(line));
      if (a.join("\n") !== b.join("\n"))
        failures.push(
          `${expected.command}\n--- runtime\n${a.join("\n")}\n--- Stata\n${b.join("\n")}`,
        );
    }
    assert.equal(failures.join("\n\n"), "");
  });
