// margins over a factor with several at() settings, on the labor data.
// Expected values were recorded from Stata 19 MP (version 17, set
// processors 1) run on the same data, exported from the runtime with
// exportData(). The printed tables are compared line by line in
// tests/runtime-output.test.mjs (case margins-factor-at-list); this file
// checks what text cannot: r(b), r(V) and the marginsplot graph.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

function session() {
  const s = createConsoleSession();
  s.reset("labor");
  return s;
}
const text = (result) =>
  result.output
    .flatMap((o) => o.lines ?? [])
    .join("\n")
    .trim();
// The column names matrix list prints, and one element at full precision.
const names = (s, matrix) =>
  text(s.run(`matrix list ${matrix}`))
    .split("\n")
    .find((line) => line.includes("._at#"))
    .trim()
    .split(/\s+/);
const element = (s, expression) =>
  Number(text(s.run(`display %21.0g ${expression}`)));
const close = (ours, theirs, what) =>
  assert.ok(
    Math.abs(ours - theirs) <= 1e-12 * Math.abs(theirs),
    `${what}: ${ours} vs Stata ${theirs}`,
  );

test("margins of a factor at each at() setting keeps every setting in r(b) and r(V)", () => {
  const s = session();
  assert.equal(s.run("quietly regress wage i.female education").rc, 0);
  assert.equal(s.run("quietly margins female, at(education=(12 16))").rc, 0);
  s.run("matrix b = r(b)\nmatrix V = r(V)");
  // Stata's matrix list shows these names (its colnames add bn to the
  // base levels: 1bn._at#0bn.female).
  assert.deepEqual(names(s, "b"), [
    "1._at#0.female",
    "1._at#1.female",
    "2._at#0.female",
    "2._at#1.female",
  ]);
  const stata = [
    [17.97309755692850786, 0.4278021709970126762],
    [15.51538023054137128, 0.4546252986915889083],
    [25.66802374351755844, 0.5824722645080809835],
    [23.21030641713042186, 0.5623172435550687354],
  ];
  stata.forEach(([value, se], j) => {
    close(element(s, `b[1,${j + 1}]`), value, `b[${j + 1}]`);
    close(element(s, `sqrt(V[${j + 1},${j + 1}])`), se, `se[${j + 1}]`);
  });
});

test("margins of two factors at each at() setting lists _at#female then _at#union", () => {
  const s = session();
  s.run("quietly regress wage i.female i.union education");
  assert.equal(
    s.run("quietly margins female union, at(education=(12 16))").rc,
    0,
  );
  s.run("matrix b = r(b)");
  assert.deepEqual(names(s, "b"), [
    "1._at#0.female",
    "1._at#1.female",
    "2._at#0.female",
    "2._at#1.female",
    "1._at#0.union",
    "1._at#1.union",
    "2._at#0.union",
    "2._at#1.union",
  ]);
  [
    17.83404523674933273, 15.35680235670109184, 26.05562750118861004,
    23.57838462114036915, 15.23597526403528946, 19.13565157868637812,
    23.45755752847456677, 27.35723384312565543,
  ].forEach((value, j) =>
    close(element(s, `b[1,${j + 1}]`), value, `b[${j + 1}]`),
  );
});

test("marginsplot after margins of a factor at several settings draws a line per level", () => {
  const s = session();
  s.run("quietly regress wage i.female education");
  s.run("quietly margins female, at(education=(12 16))");
  const result = s.run("marginsplot");
  assert.equal(result.rc, 0);
  const svg = result.output.at(-1).graph.svg,
    count = (tag) => (svg.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
  // Stata 19's graph export of the same marginsplot: the x title is the
  // variable label, the legend reads female=0 and female=1, and the title
  // names the factor.
  assert.match(svg, />Adjusted predictions of female with 95% CIs</);
  assert.match(svg, />Years of schooling</);
  assert.match(svg, />female=0</);
  assert.match(svg, />female=1</);
  assert.equal(count("polyline"), 2);
  assert.equal(count("circle"), 4);
});
