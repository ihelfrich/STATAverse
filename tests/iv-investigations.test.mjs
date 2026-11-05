import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  IV_INVESTIGATIONS,
  ivInvestigationTarget,
  ivInvestigationMetric,
  assessIVInvestigation,
} from "../src/labs/iv-investigations.js";
import { IV_DEFAULTS, ivSample, arTest } from "../src/labs/iv-model.js";
import { INVESTIGATION_CATALOG } from "../src/labs/investigation-catalog.js";
import {
  emptyLabProgress,
  completeLabStep,
  saveLabDraft,
  validateLabProgress,
  parseLabProgress,
} from "../src/lab-progress.js";
import { validateBackup } from "../src/persistence.js";

const sourceCases = JSON.parse(
  fs.readFileSync(new URL("./fixtures/iv-lab/cases.json", import.meta.url)),
);
const references = JSON.parse(
  fs.readFileSync(new URL("./fixtures/iv-lab/reference.json", import.meta.url)),
).models;
const native = JSON.parse(
  fs.readFileSync(
    new URL("../docs/verification/iv-native.json", import.meta.url),
  ),
).cases;
const stateFor = (step) => {
  const target = ivInvestigationTarget(step);
  return { ...target, sample: ivSample(target.parameters), valid: true };
};
const responseFor = (step, state) =>
  String(
    step.question.type === "number"
      ? ivInvestigationMetric(step, state)
      : step.question.answer,
  );
const draftFor = (step, note = "My explanation") => ({
  ...step.setup,
  step: step.id,
  answer: "",
  note,
  updatedAt: 1,
});
const close = (a, b) =>
  assert.ok(
    Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b)),
    `${a} differs from ${b}`,
  );

test("all IV investigation settings match independently checked samples and numeric questions use their verified quantities", () => {
  assert.equal(
    IV_INVESTIGATIONS.reduce((n, g) => n + g.steps.length, 0),
    16,
  );
  for (const guide of IV_INVESTIGATIONS)
    for (const step of guide.steps) {
      const state = stateFor(step);
      const entry = sourceCases.find((c) =>
        Object.entries(IV_DEFAULTS).every(
          ([k, v]) => (c.options[k] ?? v) === state.parameters[k],
        ),
      );
      assert.ok(entry, `${step.id}: independently checked sample missing`);
      assert.equal(
        native.find((c) => c.case === entry.id)?.returnCode,
        "0",
        step.id,
      );
      const r = references[entry.id];
      if (step.question.type === "number") {
        const expected =
          step.question.metric === "projected42"
            ? r.first.intercept + r.first.b * state.sample.rows[41].z
            : step.question.metric === "ivSlope"
              ? r.b
              : step.question.metric === "firstF"
                ? r.firstF
                : state.parameters.beta +
                  state.parameters.delta / state.parameters.pi;
        close(ivInvestigationMetric(step, state), expected);
        assert.equal(
          assessIVInvestigation(step, state, expected.toFixed(3)).passed,
          true,
          step.id,
        );
      }
      assert.equal(
        assessIVInvestigation(step, state, responseFor(step, state)).passed,
        true,
        step.id,
      );
    }
});

test("the conceptual contrasts shown in the sequence occur in the specified samples", () => {
  const states = Object.fromEntries(
    IV_INVESTIGATIONS.flatMap((g) => g.steps.map((s) => [s.id, stateFor(s)])),
  );
  assert.equal(states["whole-line"].sample.ar.kind, "all");
  assert.equal(states["rejected-middle"].sample.ar.kind, "two-rays");
  assert.equal(arTest(states["rejected-middle"].sample, 2).accepted, false);
  assert.equal(arTest(states["accepted-tail"].sample, 10).accepted, true);
  assert.equal(arTest(states["invalid-coverage"].sample, 1).accepted, false);
  assert.equal(states["zero-relevance"].sample.population.iv, null);
  assert.ok(Number.isFinite(states["zero-relevance"].sample.iv.b));
  close(states["ols-target"].sample.population.ols, 1.35);
  close(states["ols-target"].sample.population.iv, 1);
  assert.notEqual(
    states["structural-residual"].sample.iv.se,
    states["structural-residual"].sample.naive.se,
  );
  assert.deepEqual(
    states["same-first-stage"].sample.first,
    states["strong-first-stage"].sample.first,
  );
  assert.deepEqual(
    states["more-data"].sample.rows.slice(0, 300),
    states["wrong-limit"].sample.rows,
  );
  assert.ok(
    states["more-data"].sample.iv.se < states["wrong-limit"].sample.iv.se,
  );
  const choices = IV_INVESTIGATIONS.flatMap((g) => g.steps).filter(
    (s) => s.question.type === "choice",
  );
  assert.equal(
    new Set(choices.map((s) => s.question.answer)).size,
    3,
    "Correct choices should not all occupy one position",
  );
  for (const step of choices) {
    assert.equal(step.question.feedback[step.question.answer], "");
    for (let i = 0; i < step.question.options.length; i++) {
      const result = assessIVInvestigation(step, states[step.id], String(i));
      assert.equal(
        result.passed,
        i === step.question.answer,
        `${step.id}: ${i}`,
      );
      if (!result.passed)
        assert.ok(
          result.message.length > 35,
          "Wrong choices need explanatory feedback",
        );
    }
  }
});

test("task checks require the experiment, requested inspection and a meaningful answer", () => {
  for (const guide of IV_INVESTIGATIONS)
    for (const step of guide.steps) {
      const state = stateFor(step),
        answer = responseFor(step, state);
      assert.equal(
        assessIVInvestigation(step, { ...state, valid: false }, answer).kind,
        "result",
      );
      const wrong = {
        ...state,
        parameters: { ...state.parameters, seed: state.parameters.seed + 1 },
      };
      assert.equal(assessIVInvestigation(step, wrong, answer).kind, "settings");
      for (const key of Object.keys(step.required || {})) {
        const changed = { ...state, [key]: key === "selected" ? 1 : "wrong" };
        assert.equal(
          assessIVInvestigation(step, changed, answer).kind,
          "inspection",
          `${step.id}: ${key}`,
        );
      }
      for (const value of [
        "",
        "   ",
        "NaN",
        "Infinity",
        "1+1",
        "300 observations",
        undefined,
      ])
        assert.equal(
          assessIVInvestigation(step, state, value).passed,
          false,
          step.id,
        );
    }
});

test("each IV task keeps its response and experiment in the existing lab record and workspace backup", () => {
  const guide = IV_INVESTIGATIONS[0],
    [first, second] = guide.steps;
  const original = completeLabStep(
    emptyLabProgress(),
    "matching-records",
    "unique-side",
  );
  let saved = saveLabDraft(original, guide.id, {
    ...draftFor(first),
    selected: 42,
    answer: "0.810",
  });
  saved = completeLabStep(saved, guide.id, first.id);
  saved = saveLabDraft(saved, guide.id, {
    ...draftFor(second, "Compare both stages."),
    answer: "1.001",
  });
  assert.equal(saved.drafts[guide.id].step, second.id);
  assert.equal(saved.drafts[guide.id].states[first.id].answer, "0.810");
  assert.equal(saved.drafts[guide.id].states[first.id].selected, 42);
  assert.equal(saved.drafts[guide.id].states[second.id].answer, "1.001");
  assert.equal(saved.drafts[guide.id].note, "Compare both stages.");
  assert.deepEqual(original, {
    version: 1,
    completed: { "matching-records": ["unique-side"] },
  });
  assert.deepEqual(parseLabProgress(JSON.stringify(saved)), saved);
  const backup = validateBackup({ labs: saved });
  assert.equal(backup.version, 3);
  assert.deepEqual(backup.labs, saved);
  const legacyDraft = {
    version: 2,
    completed: {},
    drafts: { [guide.id]: draftFor(first) },
  };
  assert.equal(
    validateLabProgress(legacyDraft).drafts[guide.id].states[first.id].answer,
    "",
  );
  assert.deepEqual(
    INVESTIGATION_CATALOG.filter((g) => g.lab === "iv").map((g) => [
      g.id,
      g.steps.map((s) => s.id),
    ]),
    IV_INVESTIGATIONS.map((g) => [g.id, g.steps.map((s) => s.id)]),
  );
});

test("malformed task states, oversized notes and impossible experiments cannot enter a backup", () => {
  const guide = IV_INVESTIGATIONS[0],
    step = guide.steps[0];
  const valid = saveLabDraft(emptyLabProgress(), guide.id, draftFor(step));
  const badState = (changes) => {
    const value = structuredClone(valid);
    Object.assign(value.drafts[guide.id].states[step.id], changes);
    return value;
  };
  const invalid = [
    badState({ candidate: " " }),
    badState({ candidate: "0x10" }),
    badState({ candidate: "1e10" }),
    badState({ parameters: { ...IV_DEFAULTS, n: 2001 } }),
    badState({ selected: 301 }),
    badState({ answer: "x".repeat(129) }),
    badState({ updatedAt: -1 }),
    badState({ plot: "other" }),
  ];
  const wrongStep = structuredClone(valid);
  wrongStep.drafts[guide.id].step = "future-task";
  invalid.push(wrongStep);
  const longNote = structuredClone(valid);
  longNote.drafts[guide.id].note = "x".repeat(4001);
  invalid.push(longNote);
  const unknownState = structuredClone(valid);
  unknownState.drafts[guide.id].states.future =
    unknownState.drafts[guide.id].states[step.id];
  invalid.push(unknownState);
  for (const value of invalid)
    assert.throws(() => validateBackup({ labs: value }));
  let maximum = emptyLabProgress();
  for (const g of IV_INVESTIGATIONS)
    for (const s of g.steps)
      maximum = saveLabDraft(maximum, g.id, {
        ...draftFor(s, "n".repeat(4000)),
        answer: "x".repeat(128),
      });
  assert.ok(JSON.stringify(maximum).length < 50000);
  assert.deepEqual(parseLabProgress(JSON.stringify(maximum)), maximum);
});
