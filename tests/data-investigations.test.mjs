import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DATA_INVESTIGATIONS,
  investigationTarget,
  assessInvestigation,
} from "../src/labs/data-investigations.js";
import {
  mergeScenario,
  reshapeScenario,
  mergeData,
  reshapeData,
} from "../src/labs/data-model.js";
import { dataReferenceCases } from "../tools/data-reference-cases.mjs";
import {
  emptyLabProgress,
  validateLabProgress,
  parseLabProgress,
  completeLabStep,
} from "../src/lab-progress.js";
import { validateBackup } from "../src/persistence.js";

const native = JSON.parse(
  fs.readFileSync(new URL("./fixtures/data-lab/native.json", import.meta.url)),
);
const sourceCases = dataReferenceCases();
const canonical = (rows) => rows.map((row) => JSON.stringify(row)).sort();
const matches = (row, where) =>
  Object.entries(where).every(([key, value]) => row[key] === value);
function evaluate(settings) {
  const sources =
    settings.mode === "merge"
      ? mergeScenario(settings.example, settings)
      : reshapeScenario(settings);
  const result =
    settings.mode === "merge"
      ? mergeData(sources.master, sources.using, settings)
      : reshapeData(sources, settings);
  return { sources, result };
}
function select(step, result) {
  return {
    row: step.trace
      ? result.data.rows.findIndex((row) => matches(row, step.trace.row))
      : 0,
    column: step.trace?.column
      ? result.data.columns.findIndex((c) => c.name === step.trace.column)
      : 0,
  };
}
test("all seventeen investigation targets agree with existing native fixtures and numeric answers follow the verified tables", () => {
  assert.equal(
    DATA_INVESTIGATIONS.reduce((n, g) => n + g.steps.length, 0),
    17,
  );
  for (const guide of DATA_INVESTIGATIONS)
    for (const step of guide.steps) {
      const settings = investigationTarget(step),
        { sources, result } = evaluate(settings),
        expected = native.cases.find((c) => c.id === step.reference),
        original = sourceCases.find((c) => c.id === step.reference);
      assert.ok(expected?.code === 0, step.id);
      const compareSources = (data) =>
        settings.mode === "merge" ? [data.master, data.using] : [data];
      assert.deepEqual(
        compareSources(sources),
        compareSources(original.sources),
        step.id,
      );
      assert.deepEqual(
        canonical(
          result.data.rows.map((row) =>
            expected.columns.map((c) => row[c.name]),
          ),
        ),
        canonical(expected.rows),
        step.id,
      );
      const rows = expected.rows.map((row) =>
        Object.fromEntries(expected.columns.map((c, i) => [c.name, row[i]])),
      );
      const metric = step.question.metric;
      if (metric) {
        let value;
        if (metric.kind === "distinctSource")
          value = new Set(
            original.sources[metric.side].rows.map((r) => r[metric.column]),
          ).size;
        if (metric.kind === "countSource")
          value = original.sources[metric.side].rows.filter((r) =>
            matches(r, metric.where),
          ).length;
        if (metric.kind === "retainedRows") value = rows.length;
        if (metric.kind === "matchedRows")
          value = rows.filter((r) => r._merge >= 3).length;
        if (metric.kind === "distinctResult")
          value = new Set(rows.map((r) => r[metric.column])).size;
        if (metric.kind === "countResult")
          value = rows.filter((r) => matches(r, metric.where)).length;
        if (metric.kind === "resultValue")
          value = rows.find((r) => matches(r, metric.where))?.[metric.column];
        assert.equal(step.question.answer, value, step.id);
      }
      const selected = select(step, result);
      assert.ok(selected.row >= 0 && selected.column >= 0, step.id);
      assert.equal(
        assessInvestigation(
          step,
          { settings, result, selected, traceTouched: true },
          String(step.question.answer),
        ).passed,
        true,
        step.id,
      );
    }
});
test("checks reject a correct answer without the requested settings, trace, valid operation or response", () => {
  for (const guide of DATA_INVESTIGATIONS)
    for (const step of guide.steps) {
      const settings = investigationTarget(step),
        { result } = evaluate(settings),
        selected = select(step, result),
        snapshot = { settings, result, selected, traceTouched: true };
      assert.equal(
        assessInvestigation(
          step,
          { ...snapshot, result: null },
          String(step.question.answer),
        ).kind,
        "result",
      );
      assert.equal(
        assessInvestigation(
          step,
          { ...snapshot, settings: { ...settings, mode: "wrong" } },
          String(step.question.answer),
        ).kind,
        "settings",
      );
      if (step.trace)
        assert.equal(
          assessInvestigation(
            step,
            { ...snapshot, traceTouched: false },
            String(step.question.answer),
          ).kind,
          "trace",
        );
      for (const answer of ["", "NaN", "1+1", "2 students", undefined, "999"])
        assert.equal(
          assessInvestigation(step, snapshot, answer).passed,
          false,
          `${step.id}: ${answer}`,
        );
    }
});
test("set-equivalent keys and stubs pass while a changed cell selection invalidates the trace", () => {
  const guide = DATA_INVESTIGATIONS[1],
    step = guide.steps.at(-1),
    settings = investigationTarget(step);
  settings.stubs.reverse();
  const { result } = evaluate(settings),
    selected = select(step, result);
  assert.equal(
    assessInvestigation(
      step,
      { settings, result, selected, traceTouched: true },
      "0",
    ).passed,
    true,
  );
  assert.equal(
    assessInvestigation(
      step,
      {
        settings,
        result,
        selected: { row: selected.row, column: 0 },
        traceTouched: true,
      },
      "0",
    ).kind,
    "trace",
  );
});
test("lab progress validates stable step IDs, round-trips through workspace backups and rejects future or corrupt records", () => {
  const original = emptyLabProgress(),
    saved = completeLabStep(original, "matching-records", "unique-side");
  assert.deepEqual(original, emptyLabProgress());
  assert.deepEqual(
    completeLabStep(saved, "matching-records", "unique-side"),
    saved,
  );
  assert.deepEqual(parseLabProgress(JSON.stringify(saved)), saved);
  assert.deepEqual(validateBackup({ labs: saved }).labs, saved);
  assert.equal(validateBackup({ labs: saved }).version, 3);
  assert.equal(validateBackup({ profile: {} }).version, 2);
  for (const invalid of [
    { version: 2, completed: {} },
    { version: 1, completed: [] },
    { version: 1, completed: { unknown: [] } },
    { version: 1, completed: { "matching-records": [0] } },
    { version: 1, completed: { "matching-records": ["future-step"] } },
  ])
    assert.throws(() => validateLabProgress(invalid));
  assert.throws(() => parseLabProgress("x".repeat(50001)));
  assert.throws(() => validateBackup({ version: 99 }));
});
