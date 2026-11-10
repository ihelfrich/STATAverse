import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "../src/runtime/session.js";
import { missingName } from "../src/runtime/values.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/stata-runtime-sessions.json", import.meta.url),
    "utf8",
  ),
);
const show = (v) => (typeof v === "number" ? (missingName(v) ?? v) : v);
// Sums and moments are accumulated in a different order from Stata's, so
// statistics are compared to 1 part in 10^13; data values must be identical
// unless the variable came from such a statistic.
const close = (a, b) =>
  a === b ||
  (typeof a === "number" &&
    typeof b === "number" &&
    Math.abs(a - b) <= 1e-13 * Math.max(1, Math.abs(b)));

// Cases that are not compared in full, with the reason.
const KNOWN = new Map([]);
// Stata orders tied observations arbitrarily when it sorts; these cases
// sort on a key with ties, so values are compared as sets per variable.
const TIED = new Set(["by-not-sorted"]);

test("do-files leave the same data, macros and results as native Stata", () => {
  const failures = [];
  for (const c of fixture.cases) {
    if (KNOWN.has(c.id)) continue;
    const session = new Session(),
      fail = (message) => failures.push(`${c.id}: ${message}`);
    let result;
    try {
      result = session.run(c.source);
    } catch (error) {
      fail(`threw ${error.message}`);
      continue;
    }
    if (result.rc !== c.rc) fail(`return code ${result.rc} vs ${c.rc}`);
    for (const [name, value] of Object.entries(c.localValues))
      if ((result.locals.get(name) ?? "") !== value)
        fail(`local ${name}: [${result.locals.get(name) ?? ""}] vs [${value}]`);
    for (const [name, value] of Object.entries(c.globalValues))
      if ((session.globals.get(name) ?? "") !== value)
        fail(
          `global ${name}: [${session.globals.get(name) ?? ""}] vs [${value}]`,
        );
    for (const [name, value] of Object.entries(c.rValues)) {
      const actual = session.results.r[name] ?? 2 ** 1023;
      // Tests on likelihood estimates inherit their looser agreement.
      const loose = /^ml-/.test(c.id) ? 1e-5 : 1e-9;
      if (
        !close(actual, value) &&
        !(Math.abs(actual - value) <= loose * Math.abs(value))
      )
        fail(`r(${name}): ${show(actual)} vs ${show(value)}`);
    }
    // Estimation results are compared to 1 part in 10^9.
    // Likelihood estimates stop at a tolerance, so they agree less tightly.
    const tolerance = /^ml-/.test(c.id) ? 1e-5 : 1e-9,
      near = (x, y, scale = 1) =>
        x === y || Math.abs(x - y) <= tolerance * Math.max(scale, Math.abs(y));
    for (const [name, value] of Object.entries(c.eValues ?? {})) {
      const actual = session.results.e[name] ?? 2 ** 1023;
      if (!near(actual, value))
        fail(`e(${name}): ${show(actual)} vs ${show(value)}`);
    }
    for (const [name, matrix] of Object.entries(c.matrixValues ?? {})) {
      const model = session.estimates,
        values = name === "e(b)" ? model.b : model.V.flat(),
        names = model.names.map((n, k) =>
          model.estimable[k] || /b\./.test(n) ? n : "o." + n,
        ),
        // Stata names a likelihood model's coefficients by equation.
        // and marks base and omitted cells of an interaction inside the name.
        plain = (n) =>
          n
            .replace(/^[^:]+:/, "")
            .replace(/(\d+)[bo]+\./g, "$1.")
            .replace(/\bco\./g, "c.")
            .replace(/^o\./, ""),
        expectedNames = matrix.names.map(plain);
      if (names.map(plain).join(" ") !== expectedNames.join(" "))
        fail(`${name} names [${names}] vs [${matrix.names}]`);
      const scale = Math.max(...matrix.values.map(Math.abs));
      if (
        values.length !== matrix.values.length ||
        values.some(
          (v, k) => Math.abs(v - matrix.values[k]) > tolerance * scale,
        )
      )
        fail(`${name}: ${values} vs ${matrix.values}`);
    }
    if (session.data.n !== c.observations)
      fail(`observations ${session.data.n} vs ${c.observations}`);
    if (session.data.sortedBy.join(" ") !== c.sortedBy.join(" "))
      fail(`sorted by [${session.data.sortedBy}] vs [${c.sortedBy}]`);
    const names = session.data.names.join(" "),
      expected = c.variables.map((v) => v.name).join(" ");
    if (names !== expected) {
      fail(`variables [${names}] vs [${expected}]`);
      continue;
    }
    for (const v of c.variables) {
      const actual = session.data.get(v.name);
      for (const key of ["type", "format", "label", "valueLabel"])
        if (actual[key] !== v[key].trimEnd())
          fail(`${v.name} ${key}: ${actual[key]} vs ${v[key]}`);
      const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        values = TIED.has(c.id)
          ? Array.from(actual.data).sort(order)
          : Array.from(actual.data),
        expected = TIED.has(c.id) ? [...v.values].sort(order) : v.values;
      if (
        values.some(
          (value, i) =>
            !close(value, expected[i]) &&
            !(
              /^ml-/.test(c.id) &&
              Math.abs(value - expected[i]) <=
                1e-5 * Math.max(1, Math.abs(expected[i]))
            ),
        )
      )
        fail(`${v.name}: ${values.map(show)} vs ${v.values.map(show)}`);
    }
  }
  assert.deepEqual(failures, []);
});
