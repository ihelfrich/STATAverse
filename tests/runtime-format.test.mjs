import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyFormat, displayValue, stringOf } from "../src/runtime/format.js";
import { evaluateScalar } from "../src/runtime/expression.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/stata-runtime-formats.json", import.meta.url),
    "utf8",
  ),
);
const scope = {
  format(args, { node, numeric, mismatch, invalid }) {
    if (args.length < 1 || args.length > 2) throw invalid();
    const value = numeric(args[0]);
    if (args[1] && args[1].type !== "string") throw mismatch();
    const format = args[1]?.evaluate;
    return node("string", (i, env) =>
      stringOf(value(i, env), format ? format(i, env) : undefined),
    );
  },
};

function actual(c) {
  try {
    if (c.kind === "function") return { text: evaluateScalar(c.value, scope) };
    const value = evaluateScalar(c.value);
    if (c.kind === "display") return { text: displayValue(value) };
    return { text: applyFormat(value, c.format) };
  } catch (error) {
    if (error.name !== "StataError") throw error;
    return { rc: error.code };
  }
}

for (const kind of [
  "number",
  "string",
  "date",
  "binary",
  "function",
  "display",
])
  test(`${kind} formatting matches native Stata`, () => {
    const failures = [];
    let compared = 0;
    for (const c of fixture.cases.filter((c) => c.kind === kind)) {
      const result = actual(c),
        label = `${c.value} ${c.format ?? ""}`;
      if ((result.rc ?? 0) !== (c.rc ?? 0))
        failures.push(
          `${label}: return code ${result.rc ?? 0} vs ${c.rc ?? 0}`,
        );
      else if (!c.rc && result.text !== c.text)
        failures.push(`${label}: [${result.text}] vs [${c.text}]`);
      compared++;
    }
    assert.deepEqual(failures, []);
    assert.ok(compared > 0);
  });
