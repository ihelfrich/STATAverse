import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";
import { EXAMPLES } from "../src/console-examples.js";

// The Console offers these do-files to students, so each must run to its
// end in a fresh session.
for (const example of EXAMPLES)
  test(`the Console example "${example.title}" runs without an error`, () => {
    const result = createConsoleSession().run(example.text);
    assert.equal(
      result.rc,
      0,
      result.rc
        ? `${result.output.at(-1).command}: ${result.output.at(-1).lines.join(" ")}`
        : "",
    );
  });

test("simulate reads a named statistic written with spaces", () => {
  const session = createConsoleSession(),
    result = session.run(
      "program define one, rclass\n  drop _all\n  set obs 5\n  generate x = _n\n  summarize x, meanonly\n  return scalar m = r(mean)\nend\nsimulate average = r(m), reps(3): one\nsummarize average",
    );
  assert.equal(result.rc, 0);
  assert.ok(result.memory.variables.some((v) => v.name === "average"));
});
