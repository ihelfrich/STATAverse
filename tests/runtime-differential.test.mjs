import test from "node:test";
import assert from "node:assert/strict";
import { compareAll } from "../tools/differential.mjs";

test("every lesson command runs the same in the frozen interpreter and the new runtime", () => {
  const report = compareAll(),
    steps = report.lessons.flatMap((l) =>
      l.steps.map((s) => ({ ...s, lesson: l.lesson })),
    ),
    // "same", "float" (equal to single precision, because generate now
    // stores float) and "both refuse" are the only acceptable outcomes.
    unexpected = steps.filter(
      (s) => !["same", "float", "both refuse"].includes(s.status),
    );
  assert.deepEqual(
    unexpected.map(
      (s) => `${s.lesson}: ${s.status}: ${s.command} ${s.detail ?? ""}`,
    ),
    [],
  );
  assert.ok(report.commands >= 86);
});
