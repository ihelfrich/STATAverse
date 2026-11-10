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

test("the quantile solver finds the minimum an exhaustive search finds", async () => {
  const { quantileFit } = await import("../src/runtime/quantile.js");
  // A fixed-seed generator; small integers so that ties are common.
  let state = 20261110;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const solve2 = ([a, b], [u, v]) => {
    const det = a[0] * b[1] - a[1] * b[0];
    return Math.abs(det) < 1e-12
      ? null
      : [(u * b[1] - a[1] * v) / det, (a[0] * v - u * b[0]) / det];
  };
  for (let trial = 0; trial < 60; trial++) {
    const n = 6 + Math.floor(next() * 10),
      x = Array.from({ length: n }, () => [Math.floor(next() * 8), 1]),
      y = x.map(() => Math.floor(next() * 12)),
      q = [0.1, 0.25, 0.5, 0.75, 0.9, 0.97][trial % 6],
      loss = (b) =>
        x.reduce((t, row, i) => {
          const e = y[i] - row[0] * b[0] - b[1];
          return t + (e >= 0 ? q * e : (q - 1) * e);
        }, 0);
    if (new Set(x.map((row) => row[0])).size < 2) continue;
    let best = Infinity;
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++) {
        const found = solve2([x[a], x[b]], [y[a], y[b]]);
        if (found) best = Math.min(best, loss(found));
      }
    assert.ok(
      Math.abs(quantileFit(x, y, q).value - best) <= 1e-9 * (1 + best),
      `trial ${trial}: ${quantileFit(x, y, q).value} vs ${best}`,
    );
  }
});

test("do, run and include execute do-files held in the session", async () => {
  const { createConsoleSession } = await import("../src/console-session.js");
  const session = createConsoleSession();
  session.addFile(
    "setup.do",
    "sysuse wages, clear\nlocal who `1'\ndisplay \"hello `who'\"\ngenerate lw = ln(wage)\n",
  );
  session.addFile("shared.do", "local shared 7\n");
  const result = session.run(
    "do setup world\ncount\nrun setup again\ninclude shared.do\ndisplay `shared'\ncapture do missing\ndisplay _rc",
  );
  assert.equal(result.rc, 0);
  const lines = result.output.flatMap((o) => o.lines);
  // do shows what the file printed; run does not.
  assert.equal(lines.filter((line) => line === "hello world").length, 1);
  assert.equal(lines.filter((line) => line === "hello again").length, 0);
  // include keeps the file's local macros; a missing file is r(601).
  assert.ok(lines.includes("7"));
  assert.ok(lines.includes("601"));
  assert.ok(result.memory.variables.some((v) => v.name === "lw"));
});
