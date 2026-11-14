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
  // Stata 19 leaves r() empty after histogram draws its graph.
  assert.deepEqual(session.results.r, {});
});

test("graph commands refuse what they cannot draw", () => {
  assert.equal(run("scatter y s").result.rc, 109);
  assert.equal(run("scatter y").result.rc, 102);
  // A twoway graph with no observations is drawn empty: Stata 19 returns 0
  // for scatter wage educ if wage < 0 and draws the axes with no markers.
  assert.equal(run("scatter y x if x > 99").result.rc, 0);
  assert.equal(marks(run("scatter y x if x > 99").last.graph.svg, "circle"), 0);
  assert.equal(run("graph pie y").result.rc, 198);
  assert.equal(run("twoway (rcap y x x)").result.rc, 198);
  assert.equal(run("graph export out.png").result.rc, 0);
});

test("ticks are the values Stata's natscale picks", () => {
  // Recorded from Stata 19 (version 17): _natscale 0 10 5 gives 0 to 10 by
  // 2; _natscale 3.1 25.1 5 gives 5 to 25 by 5, labels inside the data;
  // _natscale -.3 .42 5 gives -.4 to .4 by .2. A graph of a constant 5 is
  // labelled 4 and 6.
  assert.deepEqual(ticks(0, 10), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(ticks(3.1, 25.1), [5, 10, 15, 20, 25]);
  assert.deepEqual(ticks(5, 5), [4, 6]);
  assert.deepEqual(ticks(-0.3, 0.42), [-0.4, -0.2, 0, 0.2, 0.4]);
});

test("marginsplot draws the last margins with its intervals", () => {
  const { result } = run(
    'regress y c.x##c.g\nmargins, dydx(x) at(g=(1 2 3))\nmarginsplot, title("Effect")',
  );
  assert.equal(result.rc, 0);
  const graph = result.output.at(-1).graph;
  assert.equal(marks(graph.svg, "circle"), 3);
  assert.equal(marks(graph.svg, "polyline"), 1);
  assert.match(graph.svg, />Effect</);
  assert.match(graph.description, /3 estimates/);
  assert.equal(run("marginsplot").result.rc, 301);
});

test("function plots draw a curve of an expression in x", () => {
  const { last, result } = run(
    "twoway (scatter y x) (function y = x^2 / 4, range(x))",
  );
  assert.equal(result.rc, 0);
  assert.equal(marks(last.graph.svg, "polyline"), 1);
  assert.equal(run("twoway function y = exp(-x), range(5 0)").result.rc, 198);
});

test("margins leaves r(b) and r(V) for matrix commands", () => {
  const { session, result } = run(
    "regress y c.x##c.g\nmargins, dydx(x) at(g=(1 3))\nmatrix b = r(b)\nmatrix V = r(V)\nlocal first = b[1,1]\nlocal se = sqrt(V[2,2])",
  );
  assert.equal(result.rc, 0);
  const { points } = session.margins;
  assert.equal(
    Number(result.locals.get("first")).toFixed(10),
    points[0].value.toFixed(10),
  );
  assert.ok(Number(result.locals.get("se")) > 0);
  assert.equal(session.matrices.get("V").values.length, 2);
});

test("twoway draws fits with bands, bars, areas and smoothers", () => {
  const { result } = run(
    "twoway (lfitci y x) (scatter y x)\ntwoway (qfitci y x) (qfit y x)\ntwoway bar y x\ntwoway area y x\ntwoway connected y x\ntwoway (histogram x) (kdensity x)\ntwoway lowess y x",
  );
  assert.equal(result.rc, 0);
  const graphs = result.output.filter((o) => o.graph).map((o) => o.graph.svg);
  assert.equal(graphs.length, 7);
  // A band is one polygon; the scatter over it has five markers.
  assert.equal(marks(graphs[0], "polygon"), 1);
  assert.equal(marks(graphs[0], "circle"), 5);
  assert.equal(marks(graphs[1], "polyline"), 2);
  // Five bars and the white background.
  assert.equal(marks(graphs[2], "rect"), 6);
  assert.equal(marks(graphs[3], "polygon"), 1);
  assert.equal(marks(graphs[4], "circle"), 5);
});

test("graph bar, hbar and box report the statistics they draw", () => {
  const { result } = run(
    "graph bar y, over(g)\ngraph hbar (mean) y (median) x, over(g)\ngraph box x, over(g)\ngraph bar, over(g)",
  );
  assert.equal(result.rc, 0);
  const graphs = result.output.filter((o) => o.graph).map((o) => o.graph);
  assert.equal(graphs.length, 4);
  // Means of y by g: (1 + 3)/2, 3.5 from the two present values, and 8.
  assert.match(graphs[0].description, /mean of y by g: 1 2, 2 3\.5, 3 8/);
  // Stata titles (median) as p 50.
  assert.match(graphs[1].description, /p 50 of x by g: 1 1\.5, 2 4, 3 6/);
  assert.match(graphs[2].description, /x \(2\): median 4, quartiles 3 and 5/);
  assert.match(graphs[3].description, /percent by g: 1 33\.33333, 2 50/);
  assert.match(graphs[1].svg, />1<\/text>/);
});

test("kdensity, lowess and the plots after regress draw and store what they compute", () => {
  const { result, session } = run(
    "kdensity x, generate(kx kd) n(4)\nlowess y x, generate(ly)\nregress y x\nrvfplot\navplot x\nlvr2plot\nqnorm y\npnorm y\ntsset x\ntsline y\nhistogram x, normal kdensity",
  );
  assert.equal(result.rc, 0);
  assert.equal(result.output.filter((o) => o.graph).length, 9);
  // Stata 19 leaves r() empty once histogram has drawn.
  assert.deepEqual(session.results.r, {});
  assert.equal(session.data.get("kd").type, "double");
  // With one regressor the added-variable slope is the coefficient itself.
  assert.match(
    result.output.find((o) => o.command === "avplot x").graph.description,
    /^Added-variable plot for x: coef = 1\.364865, se = \.2697066, t = 5\.06\.$/,
  );
});

test("graphs that are not available say so", () => {
  for (const command of ["graph pie, over(g)", "twoway rcap y x x", "avplot g"])
    assert.notEqual(run(`regress y x\n${command}`).result.rc, 0, command);
});

test("ac and pac draw the correlations corrgram reports", () => {
  const { result } = run(
    "tsset x\nac x, lags(3)\npac x, lags(3)\ncorrgram x, lags(3)",
  );
  assert.equal(result.rc, 0);
  const graphs = result.output.filter((o) => o.graph).map((o) => o.graph);
  assert.equal(graphs.length, 2);
  // x is 1 to 6: its first autocorrelation is 0.5.
  assert.match(graphs[0].description, /lags 1 to 3: 0\.500,/);
  assert.match(result.output.at(-1).lines.join("\n"), /^1\s+0\.5000\s/m);
});
