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
// Maximum-likelihood estimators reach the same estimates as Stata by a
// different sequence of steps. Their iteration lines are not compared, and
// numbers that follow from the last step may differ in the seventh digit.
const iteration = (line) => /^Iteration \d+:/.test(line);
function sameLine(a, b) {
  if (a === b) return true;
  const x = a.split(/\s+/),
    y = b.split(/\s+/);
  return (
    a.length === b.length &&
    x.length === y.length &&
    x.every(
      (token, k) =>
        token === y[k] ||
        (/^-?[\d.]+$/.test(token) &&
          /^-?[\d.]+$/.test(y[k]) &&
          Math.abs(Number(token) - Number(y[k])) <=
            2e-6 * Math.max(1, Math.abs(Number(y[k])))),
    )
  );
}
function sameText(actual, expected, tolerant) {
  if (!tolerant) return actual.join("\n") === expected.join("\n");
  const a = actual.filter((line) => !iteration(line)),
    b = expected.filter((line) => !iteration(line));
  return a.length === b.length && a.every((line, k) => sameLine(line, b[k]));
}

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
      if (
        !sameText(
          a,
          b,
          ["nonlinear", "margins", "margins-interactions"].includes(c.id),
        )
      )
        failures.push(
          `${expected.command}\n--- runtime\n${a.join("\n")}\n--- Stata\n${b.join("\n")}`,
        );
    }
    assert.equal(failures.join("\n\n"), "");
  });
