import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createConsoleSession } from "../src/console-session.js";
import { ERROR_MARK } from "../src/runtime/errors.js";

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

// Commands whose printed text is not compared, with the reason. (input
// echoes its rows as Stata's log does, and is compared.)
const SKIP = [];

for (const c of fixture.cases)
  test(`Results text matches native Stata: ${c.id}`, () => {
    // Each case is run as the Console runs a do-file, which shows it as
    // Stata's log does: comments and each command as typed, a loop or a
    // program definition once, with its lines echoed and numbered.
    const session = createConsoleSession();
    // The record was made with set linesize 200.
    session.run("set linesize 200");
    // and under version 17, which decides how regexm() reads a pattern.
    session.run("version 17");
    const ours = session
        .run(c.source, { doFile: true })
        .output.filter((o) => o.command.trim())
        .map((o) => {
          // The recorder reads a command's lines after "> " as part of it,
          // and the rest of its echo (a loop's lines) as its output.
          const echo = [...(o.echo ?? [])];
          let command = o.command;
          while (echo[0]?.startsWith("> ")) command += echo.shift().slice(2);
          return {
            command,
            lines: [...echo, ...o.lines].map((line) =>
              line.startsWith(ERROR_MARK)
                ? line.slice(ERROR_MARK.length)
                : line,
            ),
          };
        }),
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
            // svy: logit, probit, poisson and ologit, fitted by ml.
            "svy-likelihood-models",
            "svy-collinear-columns",
            "weighted-binary-count-models",
            "weighted-models-postestimation",
            "weighted-models-samples-and-refusals",
            "weighted-population-frequency-weights",
            "weighted-models-levels-strings-and-variance",
            "weighted-wide-statistics-and-few-clusters",
            "estat-gof-hosmer-lemeshow",
            "resampling-exponentiated-coefficients",
            // A fit that never converges stops where 300 steps leave it,
            // and statistics summed from millions of counts carry the
            // last digits of the estimates: both match Stata to rounding.
            "glm-unconverged-log-link",
            "glm-cloglog-large-statistics",
            "margins-factor-interactions-logit",
            "redteam5-estimates-table-equations",
            "redteam5-estat-vce-equations",
            "redteam5b-estat-vce-interactions-logit",
            "redteam5b-estat-classification-gof",
            // margins after ologit takes its gradients by differencing.
            "models6-ordered-margins-factors",
            // The tests of normality take correlations and moments whose
            // last one or two of 16 digits depend on the order of Stata's
            // sums; and bootstrap and jackknife refit logit by ml.
            "normality-results",
            "resampling-cluster-likelihood",
            // The nonlinear panel models integrate by quadrature or
            // iterate GEE steps; their last digits follow the last step.
            "xt-random-effects-binary",
            "xt-random-effects-strong-panels",
            "xt-random-effects-unbalanced-factors",
            "xt-conditional-logit",
            "xt-poisson-models",
            "xt-population-averaged",
            "xt-robust-variances",
            "xt-replay-and-factor-margins",
            "xt-perfect-prediction-and-noconstant",
            "xt-conditional-logit-separated-start",
            "xt-noninteger-counts",
            "xt-weights-pa-and-conditional",
            "xt-collinear-columns",
            "xt-pa-notes-tests-and-replay",
            "xt-group-counts-and-clusters",
            "xt-exposure-and-diverging-pa",
            // mixed reaches Stata's maximum by its own Newton steps, and
            // both take the Hessian of the variance parameters by
            // differencing; the seventh digit of what follows may differ.
            "mixed-random-intercept",
            "mixed-random-slopes",
            "mixed-two-level",
            "mixed-predict-one-level",
            "mixed-predict-two-level",
            "mixed-large-sample",
            "mixed-special-forms",
            "mixed-postestimation",
            "mixed-pass7-notes-and-tests",
            "mixed-pass7-long-level-names",
            "mixed-pass7-degenerate-models",
            "mixed-pass7-lrtest-notes",
            "mixed-pass7-predict-checks",
            "mixed-pass7-estat-results",
            "mixed-pass7-margins-xtmixed-by",
            "mixed-pass8-if-after-level",
            "mixed-pass8-predict-notes",
            // The panel models of the eighth pass, fitted by ml; margins
            // after the fixed-effects models carries the error of Stata's
            // numerical chain rule.
            "xt-pass8-offset-margins",
            "xt-pass8-lrtest-estimators",
            "xt-pass8-old-panel-option",
            "xt-pass8-eform",
            "xt-pass8-fe-margins-chain",
            // teffects logs gmm's criterion, which is rounding noise near
            // zero; heckman's two-step variance carries the last digits of
            // the first-step probit.
            "causal-teffects-estimators",
            "causal-teffects-options",
            "causal-heckman",
            "causal-heckman-forms",
            "causal7-teffects-samples-and-options",
            "causal7-teffects-overlap-and-identification",
            // heckman's scores and its ML estimates carry the last digits
            // of the optimizer's final step.
            "causal7-heckman-forms-and-predictions",
            // estat ptrends regresses on group trends in the time variable
            // itself (values near 2000), whose F statistic, shown whole by
            // return list, agrees with Stata's to about eight digits.
            "causal-didregress",
            // So does estat granger's, of leads with two clusters.
            "pass8-rcs-didregress-granger-and-collinear-groups",
            // Stata's ml search moves the Gompertz model's starting
            // values when records enter late; the fit ends where Stata's
            // does.
            "survival-streg-factors-and-entry",
            // arima's scores are taken by differencing, as Stata's are, and
            // its estimates are where Stata's optimizer stops.
            "pass7-ts-arima-models",
            "pass7-ts-arima-predict",
            "pass7-ts-arima-names-and-errors",
            "pass7-ts-edge-delta-and-white-noise",
            "pass7-ts-arima-singular-and-small",
            "pass7-ts-arima-collinear",
            "pass7-ts-arima-display-predict",
            "pass8-ts-arima-operator-layout",
            "pass8-ts-by-stcox-arima",
            "pass8-ts-lowercase-operators-in-models",
            "pass8-ts-one-panel-samples",
            "pass8-ts2-one-panel-after-missing",
            "pass8-ts2-sorts-by-time",
            // logit, or and poisson, irr replay the fit by fitting it again.
            "pass7-debug-replay-likelihood",
            // logit and logistic fits shown again, alone and stored.
            "pass7-debug2-replay-logistic",
            "pass7-debug2-estimates-replay",
          ].includes(c.id),
        )
      )
        failures.push(
          `${expected.command}\n--- runtime\n${a.join("\n")}\n--- Stata\n${b.join("\n")}`,
        );
    }
    assert.equal(failures.join("\n\n"), "");
  });
