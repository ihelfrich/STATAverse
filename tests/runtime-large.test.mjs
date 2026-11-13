// Faults found by red-teaming the graph work on 12 November: lists spread
// into Math.min, Math.max and push() overflowed the stack once a dataset or a
// number list had a few hundred thousand entries, and by() drew panels for
// groups with nothing in the sample.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";
import { greatest, least } from "../src/runtime/extremes.js";

function session(dataset = "labor") {
  const s = createConsoleSession();
  s.reset(dataset);
  return s;
}
const graphOf = (out) => out.output.find((o) => o.graph)?.graph;

test("least and greatest behave as Math.min and Math.max", () => {
  assert.equal(least([]), Infinity);
  assert.equal(greatest([]), -Infinity);
  assert.equal(least([3, -1, 2]), -1);
  assert.equal(greatest(new Set([3, -1, 2])), 3);
  assert.ok(Number.isNaN(least([1, NaN])));
  const big = Array.from({ length: 500000 }, (_, k) => k);
  assert.equal(least(big), 0);
  assert.equal(greatest(big), 499999);
});

test("graphs of 250,000 observations draw instead of overflowing", () => {
  const s = session("");
  assert.equal(
    s.run(
      "clear\nset obs 250000\ngenerate x = runiform()\ngenerate y = x + runiform()\ngenerate byte g = runiform() > .5",
    ).rc,
    0,
  );
  for (const command of [
    "scatter y x",
    "histogram x",
    "scatter y x, by(g)",
    "graph box x, over(g)",
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, 0, command);
    assert.ok(graphOf(out), command);
  }
});

test("a long number list and a long captured loop do not overflow", () => {
  const s = session();
  const labels = s.run("scatter wage education, xlabel(0(0.0001)20)");
  assert.equal(labels.rc, 198);
  assert.match(labels.output.at(-1).lines.join(" "), /at most 200/);
  // The step limit stops the loop before any overflow, and capture absorbs
  // its r(901): the run ends normally instead of throwing.
  const loop = s.run(
    "capture noisily {\n  forvalues i = 1/200000 {\n    display `i'\n  }\n}",
  );
  assert.equal(loop.rc, 0);
  assert.ok(loop.output.length > 100000);
});

test("by() draws only the groups present in the sample", () => {
  const out = session().run(
    "scatter wage education if female == 1, by(female)",
  );
  assert.equal(out.rc, 0);
  assert.match(graphOf(out).description, /in 1 panel by female/);
});

test("by() needs data, and xlabel(#n) asks for about n ticks", () => {
  const s = session();
  assert.equal(s.run("twoway function y = x^2, range(0 5) by(female)").rc, 198);
  const few = graphOf(s.run("scatter wage education, xlabel(#2)")).svg,
    many = graphOf(s.run("scatter wage education, xlabel(#10)")).svg;
  const ticksOf = (svg) =>
    (svg.match(/text-anchor="middle">[\d.]+</g) ?? []).length;
  assert.ok(ticksOf(many) > ticksOf(few));
});
