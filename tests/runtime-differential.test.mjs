import test from "node:test";
import assert from "node:assert/strict";
import { compareAll } from "../tools/differential.mjs";

// Commands the lessons use that the new runtime does not have yet.
const NOT_YET = /^(codebook|clear\nimport)\b/;

test("lessons run the same in the frozen interpreter and the new runtime", () => {
  const report = compareAll(),
    steps = report.lessons.flatMap((l) =>
      l.steps.map((s) => ({ ...s, lesson: l.lesson })),
    ),
    unexpected = steps.filter(
      (s) =>
        s.status === "different" ||
        s.status === "legacy refuses" ||
        (s.status === "runtime refuses" && !NOT_YET.test(s.command)),
    );
  assert.deepEqual(
    unexpected.map(
      (s) => `${s.lesson}: ${s.status}: ${s.command} ${s.detail ?? ""}`,
    ),
    [],
  );
  assert.ok(report.same + report.sameToSinglePrecision >= 70);
});
