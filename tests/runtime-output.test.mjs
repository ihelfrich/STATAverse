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
// tobit's "Grid node" lines, which log its starting values, are of the same
// kind.
const iteration = (line) => /^(Iteration|Grid node) \d+:/.test(line);
function sameLine(a, b) {
  if (a === b) return true;
  const x = a.split(/\s+/),
    y = b.split(/\s+/);
  // A number that differs in its seventh digit may print one character
  // longer or shorter, since trailing zeros are dropped.
  return (
    Math.abs(a.length - b.length) <= 1 &&
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
          [
            "nonlinear",
            "margins",
            "margins-interactions",
            "estat-gof",
            "nonlinear-more",
            "more-postestimation",
            "count-quantile",
            "margins-more",
            "margins-outcomes",
            "predict-defaults",
            "mlogit-coefficients",
            "outcome-predict-margins",
            "likelihood-factor-layout",
            "models-interaction-terms",
            "nbreg-stata-steps",
            "models-repeated-terms",
            "test-accumulate-mlogit",
            "test-lincom-equations",
            "perfect-prediction",
            "binary-noconstant",
            "test-lincom-equation-references",
            "test-references-stata-forms",
            "test-lincom-references-round3",
            "table-width-factor-labels",
            "table-width-likelihood-models",
            "mlogit-factor-layout",
            "test-lincom-tobit-prefix-and-minus",
            "table-width-continuous-pieces",
            "table-level-labels-abbreviated",
            "table-unlabelled-levels-and-one-level-factors",
            "constraint-lines-wrapped",
            "table-width-xtreg-and-resampling",
            // A fit that never converges stops where 300 steps leave it,
            // and statistics summed from millions of counts carry the
            // last digits of the estimates: both match Stata to rounding.
            "glm-unconverged-log-link",
            "glm-cloglog-large-statistics",
          ].includes(c.id),
        )
      )
        failures.push(
          `${expected.command}\n--- runtime\n${a.join("\n")}\n--- Stata\n${b.join("\n")}`,
        );
    }
    assert.equal(failures.join("\n\n"), "");
  });
