import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { ticks } from "../src/runtime/graphics.js";

const DATA = `clear
input double y double x byte g str2 s
1 1 1 "a"
3 2 1 "b"
2 3 2 "c"
5 4 2 "d"
. 5 2 "e"
8 6 3 "f"
end
label variable y "Outcome <y> & more"
`;
const run = (source) => {
  const session = new Session(),
    result = session.run(DATA + source);
  return { session, result, last: result.output.at(-1) };
};
const marks = (svg, tag) =>
  (svg.match(new RegExp("<" + tag + "\\b", "g")) ?? []).length;

test("scatter draws one marker per complete observation and labels its axes", () => {
  const { last, result } = run("scatter y x");
  assert.equal(result.rc, 0);
  assert.equal(marks(last.graph.svg, "circle"), 5);
  assert.match(last.graph.svg, /Outcome &lt;y&gt; &amp; more/);
  assert.match(last.graph.description, /5 points/);
  assert.deepEqual(last.lines, []);
});

test("twoway overlays plots written with parentheses or with ||", () => {
  for (const source of [
    'twoway (scatter y x) (lfit y x), title("Fit")',
    'twoway scatter y x || lfit y x, title("Fit")',
    "graph twoway (scatter y x if g > 1) (line y x)",
  ]) {
    const { last, result } = run(source);
    assert.equal(result.rc, 0, source);
    assert.equal(marks(last.graph.svg, "polyline"), 1, source);
    assert.ok(marks(last.graph.svg, "circle") >= 2, source);
  }
  assert.match(
    run('twoway (scatter y x) (lfit y x), title("Fit")').last.graph.svg,
    />Fit</,
  );
});

test("histogram chooses bins as Stata does and still draws under quietly", () => {
  const { last, session } = run("quietly histogram x, bin(3) frequency");
  assert.equal(marks(last.graph.svg, "rect"), 1 + 3);
  assert.deepEqual(last.lines, []);
  assert.deepEqual(session.results.r, { N: 6, bin: 3, width: 5 / 3, start: 1 });
});

test("graph commands refuse what they cannot draw", () => {
  assert.equal(run("scatter y s").result.rc, 109);
  assert.equal(run("scatter y").result.rc, 102);
  assert.equal(run("scatter y x if x > 99").result.rc, 2000);
  assert.equal(run("graph bar y").result.rc, 198);
  assert.equal(run("twoway (area y x)").result.rc, 198);
  assert.equal(run("graph export out.png").result.rc, 0);
});

test("ticks are round and cover the data", () => {
  assert.deepEqual(ticks(0, 10), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(ticks(3.1, 25.1), [0, 5, 10, 15, 20, 25, 30]);
  assert.deepEqual(ticks(5, 5), [4, 4.5, 5, 5.5, 6]);
  assert.deepEqual(ticks(-0.3, 0.42), [-0.4, -0.2, 0, 0.2, 0.4, 0.6]);
});
