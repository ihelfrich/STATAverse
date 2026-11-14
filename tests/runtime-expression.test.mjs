import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  compileExpression,
  evaluateAll,
  evaluateScalar,
} from "../src/runtime/expression.js";
import { Dataset } from "../src/runtime/store.js";
import {
  byteLength,
  coerce,
  missingName,
  parseNumber,
} from "../src/runtime/values.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/stata-runtime-expressions.json", import.meta.url),
    "utf8",
  ),
);

// Not compared, with the reason for each.
const SKIPPED = new Map([
  // Stata keeps a literal that lies between two missing-value codes as it
  // was typed; the runtime reads any literal above the largest double as ".".
  ["8.99e307", "literal inside the missing-value range"],
  // Stata evaluates regexs() before the regexm() in the same expression, so
  // these two record the match left by an earlier command.
  [
    'cond(regexm("abc123","([a-z]+)([0-9]+)"), regexs(2), "none")',
    "argument evaluation order",
  ],
  [
    'cond(regexm("abc123","([a-z]+)([0-9]+)"), regexs(0), "none")',
    "argument evaluation order",
  ],
  // generate reads "in 1" as its own qualifier; that is the grammar's job.
  ["id in 1", "qualifier, not expression"],
]);
// Results that pass through exp, ln or a series are compared to 1 part in
// 10^14; everything else must be the identical double.
const APPROXIMATE =
  /normal|lnfactorial|logit|comb\(|\^\(?-?[\d.]*\.\d|\^-|exp\(|log10|ln\(|log\(/;
// Distribution functions are compared to 1 part in 10^11.
const DISTRIBUTION = /^(t|F|chi2|inv|lngamma|ibeta|gammap)/;

const show = (v) => (typeof v === "number" ? (missingName(v) ?? v) : v);
function same(actual, expected, expression) {
  // A byte cut out of a character is kept as it is, as Stata keeps it; the
  // fixture holds it as U+FFFD, as Stata's log read back as UTF-8 gives it.
  if (typeof actual === "string")
    actual = actual.replace(/[\uDC80-\uDCFF]/g, "\uFFFD");
  if (actual === expected) return true;
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  if (DISTRIBUTION.test(expression))
    return Math.abs(actual - expected) <= 1e-11 * Math.abs(expected);
  if (!APPROXIMATE.test(expression)) return false;
  return Math.abs(actual - expected) <= 1e-14 * Math.abs(expected);
}

function run(body) {
  try {
    return { rc: 0, ...body() };
  } catch (error) {
    if (error.name !== "StataError") throw error;
    return { rc: error.code };
  }
}

test("scalar expressions match native Stata", () => {
  let compared = 0;
  const failures = [];
  for (const c of fixture.scalar) {
    if (SKIPPED.has(c.expression)) continue;
    const result = run(() => ({ value: evaluateScalar(c.expression) }));
    if (result.rc !== (c.rc ?? 0)) {
      failures.push(
        `${c.expression}: return code ${result.rc} vs ${c.rc ?? 0}`,
      );
      continue;
    }
    if (c.rc) continue;
    const expected = "string" in c ? c.string : c.number;
    if (!same(result.value, expected, c.expression))
      failures.push(
        `${c.expression}: ${show(result.value)} vs ${show(expected)}`,
      );
    compared++;
  }
  assert.deepEqual(failures, []);
  assert.ok(compared > 350, `${compared} compared`);
});

function dataset() {
  const data = new Dataset();
  data.setObservations(6);
  for (const [name, type, values] of fixture.variables)
    if (type === "str") data.generate(name, values, { string: true });
    else
      data.generate(
        name,
        values.map((v) => coerce("double", parseNumber(String(v)))),
        { type },
      );
  return data;
}

test("expressions over data match native Stata, with and without by", () => {
  const data = dataset(),
    scope = {
      dataset: data,
      scalars: new Map([
        ["k", 3],
        ["ks", "txt"],
      ]),
      results: { r: { N: 6, mean: 35 }, e: {} },
    },
    groups = [0, 2, 4].map((start) => ({ start, count: 2 }));
  let compared = 0;
  const failures = [];
  for (const c of fixture.data) {
    if (SKIPPED.has(c.expression)) continue;
    const label = (c.by ? "by: " : "") + c.expression,
      result = run(() => {
        const compiled = compileExpression(c.expression, scope);
        return {
          type: compiled.type,
          values: evaluateAll(compiled, 6, c.by ? groups : undefined),
        };
      });
    if (result.rc !== c.rc) {
      failures.push(`${label}: return code ${result.rc} vs ${c.rc}`);
      continue;
    }
    if (c.rc) continue;
    // generate stores a numeric result as float and a string result at the
    // width of its longest value.
    const type =
      result.type === "numeric"
        ? "float"
        : "str" +
          Math.max(
            1,
            // A byte cut out of a character counts as one byte.
            ...result.values.map((v) => byteLength(v)),
          );
    if (type !== c.type) failures.push(`${label}: type ${type} vs ${c.type}`);
    result.values.forEach((value, i) => {
      // Machine-written cases pass through ^ and other library functions
      // in unpredictable places, so they are compared to 1 part in 10^12.
      const close =
        c.random &&
        typeof value === "number" &&
        Math.abs(value - c.values[i]) <=
          1e-12 * Math.max(1, Math.abs(c.values[i]));
      if (!close && !same(value, c.values[i], c.expression))
        failures.push(
          `${label} [${i + 1}]: ${show(value)} vs ${show(c.values[i])}`,
        );
    });
    compared++;
  }
  assert.deepEqual(failures, []);
  assert.ok(compared > 85, `${compared} compared`);
});

test("a type mismatch is found before any observation is read", () => {
  const data = dataset();
  let reads = 0;
  const watched = new Proxy(data, {
    get(target, key) {
      if (key === "value") reads++;
      return Reflect.get(target, key);
    },
  });
  assert.throws(() => compileExpression("s + 1", { dataset: watched }), {
    code: 109,
  });
  assert.equal(reads, 0);
  assert.equal(compileExpression("s + s", { dataset: data }).type, "string");
  assert.equal(
    compileExpression("strlen(s)", { dataset: data }).type,
    "numeric",
  );
});
