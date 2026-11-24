// The project lab's worked analysis in the Console runtime against the record
// of installed Stata (tools/check-project-native.mjs), on the simulated panel.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createConsoleSession } from "../src/console-session.js";
import { ERROR_MARK } from "../src/runtime/errors.js";
import {
  PANEL_SEED,
  buildPanel,
  panelCsv,
  panelFingerprint,
} from "../src/panel-project/panel-data.js";
import { PANEL_FILE, panelDta } from "../src/panel-project/panel-dta.js";
import {
  ANALYSIS_STEPS,
  canonicalDoFile,
  linesBefore,
} from "../src/panel-project/analysis.js";
import { hexToDouble } from "../tools/check-runtime-native.mjs";
import { valueLines } from "../tools/check-project-native.mjs";

const fixture = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/panel-project/native.json", import.meta.url),
      "utf8",
    ),
  ),
  panel = buildPanel();

// One session runs the analysis and then the do-file that prints every
// reported number; the tests below read what it printed.
const session = createConsoleSession();
session.addData(PANEL_FILE, panelDta(panel));
// The record was made with set linesize 200.
session.run("set linesize 200");
const ran = session.run(canonicalDoFile(), { doFile: true }),
  printed = session.run(fixture.valuesSource, { doFile: true });

test("the fixture was recorded from this panel and this analysis", () => {
  assert.equal(fixture.seed, PANEL_SEED);
  assert.equal(fixture.observations, panel.observations);
  assert.equal(fixture.fingerprint, panelFingerprint(panel));
  assert.equal(
    fixture.csvSha256,
    createHash("sha256").update(panelCsv(panel)).digest("hex"),
  );
  assert.equal(
    fixture.analysisSource,
    canonicalDoFile(),
    "the analysis changed: record again with node tools/check-project-native.mjs",
  );
});

const trimmed = (lines) => {
  const out = lines
    .flatMap((line) => line.split("\n"))
    .map((line) =>
      (line.startsWith(ERROR_MARK)
        ? line.slice(ERROR_MARK.length)
        : line
      ).replace(/\s+$/, ""),
    );
  while (out.length && !out[0]) out.shift();
  while (out.length && !out.at(-1)) out.pop();
  return out;
};
// poisson and logit take Stata's own steps, so their iteration logs are
// compared line by line with everything else. A number they print is
// allowed a difference in its seventh digit (the rule of
// tests/runtime-output.test.mjs); on this panel none differs.
const likelihood = (command) =>
  /^(poisson|logit|margins|est(imates)? table)\b/.test(command);
function sameLine(a, b) {
  if (a === b) return true;
  const x = a.split(/\s+/),
    y = b.split(/\s+/);
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

test("the analysis prints what Stata prints, command by command", () => {
  assert.equal(ran.rc, 0);
  const ours = ran.output
      .filter((o) => o.command.trim())
      .map((o) => {
        // Stata's log shows a command's continuation lines after "> " and
        // the lines of a loop as its output.
        const echo = [...(o.echo ?? [])];
        let command = o.command;
        while (echo[0]?.startsWith("> ")) command += echo.shift().slice(2);
        return { command, lines: trimmed([...echo, ...o.lines]) };
      }),
    failures = [];
  assert.equal(ours.length, fixture.commands.length);
  for (const [k, expected] of fixture.commands.entries()) {
    const actual = ours[k];
    assert.equal(
      actual.command.replace(/\s+/g, " ").trim(),
      expected.command.replace(/\s+/g, " ").trim(),
    );
    const a = actual.lines,
      b = expected.lines;
    let same;
    if (likelihood(expected.command)) {
      same =
        a.length === b.length && a.every((line, j) => sameLine(line, b[j]));
    } else same = a.join("\n") === b.join("\n");
    if (!same) {
      const j = a.findIndex((line, i) =>
        likelihood(expected.command)
          ? !sameLine(line, b[i] ?? "")
          : line !== b[i],
      );
      failures.push(
        `${expected.command}\n  ours:  ${a[j] ?? "(no line)"}\n  Stata: ${b[j] ?? "(no line)"}`,
      );
    }
  }
  assert.deepEqual(failures, []);
});

// Tolerances of docs/numerical-contract.md: 1e-10 relative, with unit
// absolute scale near zero, for what least squares computes in closed form,
// and 1e-6 for the coefficients, standard errors and marginal effects of the
// fits that iterate. Counts and degrees of freedom are equal.
const close = (a, b, tolerance) =>
  Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));
const ITERATED = /^(all_fees|buys|amount|margins) /;

test("every reported number agrees with Stata within the numerical contract", () => {
  assert.equal(printed.rc, 0);
  const ours = valueLines(printed.output.flatMap((o) => o.lines)),
    theirs = fixture.values,
    failures = [];
  assert.deepEqual(Object.keys(ours), Object.keys(theirs));
  assert.ok(Object.keys(theirs).length > 400);
  for (const [name, expected] of Object.entries(theirs)) {
    assert.equal(ours[name].length, expected.length, name);
    for (const [k, hex] of expected.entries()) {
      const a = hexToDouble(ours[name][k]),
        b = hexToDouble(hex),
        integer = / (N|N_clust|df|df_r)$|^count /.test(name),
        tolerance = integer ? 0 : ITERATED.test(name) ? 1e-6 : 1e-10;
      if (typeof b === "string" ? a !== b : !close(a, b, tolerance))
        failures.push(`${name}[${k}]: ${a} against Stata's ${b}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the steps are the do-file, and a session can be replayed to any step", () => {
  const ids = ANALYSIS_STEPS.map((step) => step.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const step of ANALYSIS_STEPS)
    assert.ok(canonicalDoFile().includes(step.lines), step.id);
  // Replaying the lines before the regression step leaves what it needs.
  const again = createConsoleSession();
  again.addData(PANEL_FILE, panelDta(panel));
  const before = again.run(linesBefore("baseline"), { doFile: true });
  assert.equal(before.rc, 0);
  const names = before.memory.variables.map((v) => v.name);
  for (const name of ["lnnas", "dual_proxy", "turnover_raw", "nas_m"])
    assert.ok(names.includes(name), name);
  assert.throws(() => linesBefore("nowhere"));
});

// What the panel is built to show, read from Stata's own numbers, so that a
// change to the generator that loses the lesson fails here and not in the
// lab.
test("the recorded results carry the lesson the lab teaches", () => {
  const value = (name, k = 0) => hexToDouble(fixture.values[name][k]),
    t = (name) => Math.abs(value(name) / value(name, 1));
  // Pooled least squares: a positive, significant chair coefficient and
  // turnover coefficient; cash flow near zero.
  assert.ok(value("baseline b dual_proxy") > 0.06);
  assert.ok(value("baseline b dual_proxy") < 0.14);
  assert.ok(t("baseline b dual_proxy") > 1.97);
  assert.ok(value("baseline b turnover") > 0.07);
  assert.ok(value("baseline b turnover") < 0.16);
  assert.ok(t("baseline b turnover") > 1.97);
  assert.ok(t("baseline b positive_cfo") < 1);
  assert.ok(Math.abs(value("baseline b size") - 0.67) < 0.03);
  assert.ok(Math.abs(value("baseline b big4") - 0.36) < 0.1);
  // The joint test rejects at 5 percent, not overwhelmingly.
  assert.ok(value("test p") < 0.05 && value("test p") > 0.001);
  // Firm fixed effects take the chair coefficient away and leave turnover.
  assert.ok(Math.abs(value("firm_fe b dual_proxy")) < 0.04);
  assert.ok(t("firm_fe b dual_proxy") < 1);
  assert.ok(value("firm_fe b turnover") > 0);
  // Poisson with the zero-fee firm-years: the signs of least squares.
  assert.ok(value("all_fees b dual_proxy") > 0.08);
  assert.ok(value("all_fees b dual_proxy") < 0.18);
  for (const term of ["turnover", "positive_cfo", "size", "big4"])
    assert.equal(
      Math.sign(value(`all_fees b ${term}`)),
      Math.sign(value(`baseline b ${term}`)),
      term,
    );
  // Uncapped ratios lose most of the turnover coefficient.
  assert.ok(
    value("uncapped b turnover_raw") < value("baseline b turnover") / 2,
  );
  // The sample flow.
  const count = (name) => value(`count ${name}`);
  assert.ok(count("window") > count("matched"));
  assert.ok(count("matched") > count("nonfinancial"));
  assert.ok(count("nonfinancial") > count("eligible"));
  assert.equal(count("eligible"), count("zero") + count("baseline"));
  assert.ok(count("baseline") >= 5000 && count("baseline") <= 6500);
  assert.ok(value("baseline N_clust") >= 600);
});
