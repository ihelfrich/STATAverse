import { test } from "node:test";
import assert from "node:assert/strict";
import { LESSONS, TRACKS, assessStep } from "../src/lessons.js";
import { assessAnswer } from "../src/lesson-schema.js";
import { PracticeSession } from "../src/engine.js";
import { explainCoefficient, resultHTML } from "../src/render.js";
import { nativeImportCommand } from "../src/import-library.js";

test("curriculum responses agree with computed results and every mistake has useful feedback", () => {
  assert.equal(new Set(LESSONS.map((l) => l.id)).size, LESSONS.length);
  for (const lesson of LESSONS) {
    assert.ok(
      TRACKS.some((t) => t.id === lesson.track),
      lesson.id,
    );
    const s = new PracticeSession(lesson.dataset);
    for (const step of lesson.steps) {
      const result = s.run(step.command).at(-1);
      assert.ok(step.hints.length >= 2, step.title);
      if (step.response?.kind === "number") {
        const actual = step.response.resultPath.reduce(
          (v, key) => v[key],
          result,
        );
        assert.ok(Math.abs(actual - step.response.expected) < 1e-9, step.title);
        assert.equal(
          assessAnswer(step, String(actual)).passed,
          true,
          step.title,
        );
        assert.equal(
          assessAnswer(step, actual.toFixed(step.response.decimals)).passed,
          true,
          step.title,
        );
        assert.equal(
          assessAnswer(step, String(actual + 10)).passed,
          false,
          step.title,
        );
      } else {
        assert.ok(step.answers[step.correct], step.title);
        for (let i = 0; i < step.answers.length; i++) {
          const response = assessAnswer(step, i);
          assert.equal(response.passed, i === step.correct, step.title);
          if (i !== step.correct)
            assert.ok(
              step.answerFeedback[i]?.length > 25,
              step.title + ":" + i,
            );
        }
      }
    }
  }
});

test("numeric answers reject missing, malformed and nonfinite input", () => {
  const step = LESSONS.find((l) => l.id === "group-comparisons").steps[1];
  for (const input of [
    null,
    "",
    " ",
    "66.91 points",
    "66.91x",
    "Infinity",
    "NaN",
    "0x42",
    "66,91",
    "1e999",
    "66+0.91",
  ])
    assert.equal(assessAnswer(step, input).passed, false, String(input));
  for (const input of ["66.91", "+66.909", "6.69091e1"])
    assert.equal(assessAnswer(step, input).passed, true, input);
});

test("repair exercises accept corrections after the flawed draft was executed", () => {
  const lesson = LESSONS.find((l) => l.id === "debugging");
  const s = new PracticeSession(lesson.dataset);
  for (const [i, step] of lesson.steps.entries()) {
    if (step.starter) {
      const incorrect = s.run(step.starter).at(-1);
      assert.equal(
        assessStep(lesson, i, s, incorrect).passed,
        false,
        step.title,
      );
    }
    const repaired = s.run(step.repairWhen?.command || step.command).at(-1);
    assert.equal(assessStep(lesson, i, s, repaired).passed, true, step.title);
  }
});

test("reproducibility and restoration checks reject a matching answer without the required state", () => {
  const doFile = LESSONS.find((l) => l.id === "do-files");
  const s = new PracticeSession();
  let result = s.run("count if !missing(score, hours, attendance)").at(-1);
  assert.equal(assessStep(doFile, 3, s, result).passed, false);
  s.run(nativeImportCommand("study.csv", s.data));
  result = s.run("count if !missing(score, hours, attendance)").at(-1);
  assert.equal(assessStep(doFile, 3, s, result).passed, true);
  const preserved = LESSONS.find((l) => l.id === "temporary-samples");
  s.run(
    'keep if group == "A"\npreserve\nimport delimited using "study.csv", clear',
  );
  result = { kind: "preserve" };
  assert.equal(assessStep(preserved, 0, s, result).passed, false);
});

test("coefficient explanations distinguish model columns from underlying changes", () => {
  const interaction = LESSONS.find((l) => l.id === "interactions");
  const s = new PracticeSession();
  for (const step of interaction.steps.slice(0, 4)) s.run(step.command);
  const explanation = explainCoefficient(s.model, "hours_c");
  assert.match(
    explanation,
    /changing an underlying variable changes more than one column/,
  );
  assert.match(explanation, /hours_c \* group_b/);
  assert.doesNotMatch(explanation, /holding .*hours_b.* fixed/);
  const wages = new PracticeSession("wages");
  wages.run(
    "gen double ln_wage = ln(wage)\nregress ln_wage education experience",
  );
  assert.match(explainCoefficient(wages.model, "education"), /outcome scale/);
  const error = s.run('count if group = "A"')[0];
  assert.match(error.hint, /compare values with ==/);
  assert.equal(resultHTML(error, 0).split(error.message).length - 1, 1);
});
