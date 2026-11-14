// Graphs from the fifth red-team round (students' own data, 13 November
// 2026): graph bar, hbar and box with two or three over() groups, graph
// pie, graph matrix, and colours with an intensity or an opacity. Every
// expected value below was recorded from Stata 19 MP (version 17, set
// processors 1) by exporting the same graphs with graph export … .svg and
// reading the SVG: the bars' places in units of one bar's width and their
// heights, the pie slices' angles and labels, the matrix's labels, and the
// fill and opacity of the markers. Stata's printed messages are compared
// in tools/output-cases.txt (case graph-over-pie-matrix).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

const DATA = `clear
input byte g byte h byte k double y double z
1 1 1 2 5
1 1 2 4 6
1 2 1 6 7
1 2 2 8 1
2 1 1 3 2
2 1 2 5 3
2 2 1 7 4
2 2 2 9 9
3 1 1 1 2
3 1 2 2 3
end
label define gl 1 "One" 2 "Two" 3 "Three"
label values g gl
label define hl 1 "No" 2 "Yes"
label values h hl
label variable z "Zed value"`;

function session(data = DATA) {
  const s = createConsoleSession();
  assert.equal(s.run(data).rc, 0);
  return (command) => {
    const result = s.run(command);
    return {
      rc: result.rc,
      lines: result.output.at(-1).lines,
      svg: result.output.at(-1).graph?.svg,
    };
  };
}
const texts = (svg) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const PALETTE = ["#1a476f", "#90353b", "#55752f", "#e37e00"];
/**
 * The bars of a chart, along the category axis: where each starts, in
 * units of one bar's width from the first, its height against the
 * tallest, and its colour's place in the palette.
 */
function bars(svg, horizontal = false) {
  const list = [
    ...svg.matchAll(
      /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9a-f]+)" fill-opacity="0\.75"/g,
    ),
  ].map((m) => {
    const [x, y, w, h] = m.slice(1, 5).map(Number);
    return horizontal
      ? { at: y, size: h, value: w, colour: PALETTE.indexOf(m[5]) }
      : { at: x, size: w, value: h, colour: PALETTE.indexOf(m[5]) };
  });
  list.sort((a, b) => a.at - b.at);
  const width = list[0].size,
    tallest = Math.max(...list.map((b) => b.value));
  return list.map((b) => ({
    at: Number(((b.at - list[0].at) / width).toFixed(2)),
    height: Number((b.value / tallest).toFixed(3)),
    colour: b.colour,
  }));
}
/** Places within 0.02 bar widths, heights within 0.005 of the tallest. */
function sameBars(actual, places, heights, colours) {
  assert.equal(actual.length, places.length);
  const tallest = Math.max(...heights);
  actual.forEach((bar, k) => {
    assert.ok(
      Math.abs(bar.at - places[k]) < 0.02,
      `bar ${k} at ${bar.at}, Stata ${places[k]}`,
    );
    assert.ok(
      Math.abs(bar.height - heights[k] / tallest) < 0.005,
      `bar ${k} height ${bar.height}, Stata ${heights[k] / tallest}`,
    );
    if (colours) assert.equal(bar.colour, colours[k], `bar ${k} colour`);
  });
}

test("graph bar with two over() lays out groups and labels as Stata does", () => {
  const run = session();
  const r = run("graph bar y, over(g) over(h)");
  assert.equal(r.rc, 0);
  // Stata: bars at 0, 1.67, 3.34, 6.34 and 8.01 bar widths, of 3, 4, 1.5,
  // 7 and 8; the slot of Three under Yes, which has no observations, is
  // left empty but keeps its label.
  sameBars(bars(r.svg), [0, 1.67, 3.34, 6.34, 8.01], [3, 4, 1.5, 7, 8]);
  assert.deepEqual(
    texts(r.svg).filter((t) => /^[A-Z]/.test(t)),
    ["One", "Two", "Three", "One", "Two", "Three", "No", "Yes"],
  );
  assert.ok(texts(r.svg).includes("mean of y"));
  // The outer group's label is a second row, under the middle of its bars.
  const at = (text) =>
    [
      ...r.svg.matchAll(
        new RegExp(
          `<text x="([\\d.]+)" y="([\\d.]+)"[^>]*>${text}</text>`,
          "g",
        ),
      ),
    ].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(at("No")[0][1] > at("One")[0][1]);
  assert.ok(Math.abs(at("No")[0][0] - at("Two")[0][0]) < 0.01);
  // nofill drops the empty pair, and with it the label.
  const nofill = run("graph bar y, over(g) over(h) nofill");
  assert.deepEqual(
    texts(nofill.svg).filter((t) => /^[A-Z]/.test(t)),
    ["One", "Two", "Three", "One", "Two", "No", "Yes"],
  );
});

test("sort() orders the bars within each outer group, and the groups by their sum", () => {
  // Stata: over(g, sort(1) descending) over(h, descending) puts Yes first,
  // with Two (8) and One (7), then No with Two, One and Three.
  sameBars(
    bars(
      session()("graph bar y, over(g, sort(1) descending) over(h, descending)")
        .svg,
    ),
    [0, 1.67, 6.34, 8.01, 9.68],
    [8, 7, 4, 3, 1.5],
  );
  // An empty pair counts as 0 and sorts first: No has 5, 6, 7; Yes has an
  // empty slot, then 1 and 8.
  const fifth = session(`clear
input byte g byte h double y
1 2 8
2 2 1
1 1 5
2 1 6
3 1 7
end`);
  sameBars(
    bars(fifth("graph bar y, over(g, sort(1)) over(h)").svg),
    [0, 1.67, 3.34, 8.01, 9.68],
    [5, 6, 7, 1, 8],
  );
  // The outer groups are ordered by the sum of their bars: 9 + 5 + 1 = 15
  // comes before 1 + 2 + 20 = 23, and 1 + 2 + 10 = 13 before 15.
  const outer = (rows) =>
    session(`clear
input byte g byte h double y
${rows}
end`)("graph bar y, over(g) over(h, sort(1))").svg;
  sameBars(
    bars(outer("1 1 9\n1 1 9\n2 1 5\n3 1 1\n1 2 1\n2 2 2\n3 2 20")),
    [0, 1.67, 3.34, 6.34, 8.01, 9.68],
    [9, 5, 1, 1, 2, 20],
  );
  sameBars(
    bars(
      outer(
        "1 1 9\n1 1 9\n2 1 5\n3 1 1\n1 2 1\n2 2 2\n3 2 10\n3 2 10\n3 2 10\n3 2 10",
      ),
    ),
    [0, 1.67, 3.34, 6.34, 8.01, 9.68],
    [1, 2, 10, 9, 5, 1],
  );
});

test("with three over() the first is drawn as the bars' colours", () => {
  const run = session();
  // Stata: over(h) over(g) over(k) draws No and Yes side by side in each
  // category of g, the categories two thirds of a bar apart and the groups
  // of k two bars apart, with a legend of No and Yes.
  const r = run("graph bar y, over(h) over(g) over(k) blabel(bar)");
  assert.equal(r.rc, 0);
  sameBars(
    bars(r.svg),
    [0, 1, 2.67, 3.67, 5.34, 9.34, 10.34, 12.01, 13.01, 14.68],
    [2, 6, 3, 7, 1, 4, 8, 5, 9, 2],
    [0, 1, 0, 1, 0, 0, 1, 0, 1, 0],
  );
  const words = texts(r.svg);
  assert.deepEqual(words.slice(-2), ["No", "Yes"]);
  assert.ok(words.includes("mean of y"));
  // graph hbar draws them from the top, the colours in order within each
  // category.
  sameBars(
    bars(run("graph hbar y, over(g) over(h) over(k)").svg, true),
    [0, 1, 2, 3.67, 4.67, 8.67, 9.66, 10.66, 12.33, 13.33],
    [2, 3, 1, 6, 7, 4, 5, 2, 8, 9],
    [0, 1, 2, 0, 1, 0, 1, 2, 0, 1],
  );
  // asyvars with one over() draws its groups as colours, side by side.
  sameBars(
    bars(run("graph bar y, over(g) asyvars").svg),
    [0, 1, 2],
    [5, 6, 1.5],
    [0, 1, 2],
  );
  // Two statistics over two groups.
  sameBars(
    bars(run("graph bar (sum) y (mean) z, over(g) over(h)").svg),
    [0, 1, 2.67, 3.67, 5.34, 6.34, 9.35, 10.35, 12.02, 13.02],
    [6, 5.5, 8, 2.5, 3, 2.5, 14, 4, 16, 6.5],
  );
});

test("graph box with two over() draws its boxes where Stata does", () => {
  const svg = session()("graph box y z, over(g) over(h)").svg,
    boxes = [
      ...svg.matchAll(
        /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="#[0-9a-f]+" fill-opacity="0\.6"/g,
      ),
    ].map((m) => [Number(m[1]), Number(m[2])]),
    width = boxes[0][1];
  // Stata: boxes a third of a box apart, categories one box apart, groups
  // two apart; no boxes for Three under Yes.
  const places = boxes
      .map(([x]) => (x - boxes[0][0]) / width)
      .sort((p, q) => p - q),
    stata = [0, 1.33, 3.33, 4.66, 6.66, 8, 11, 12.33, 14.33, 15.66];
  assert.equal(places.length, stata.length);
  places.forEach((at, k) =>
    assert.ok(Math.abs(at - stata[k]) < 0.02, `box ${k} at ${at}`),
  );
  assert.deepEqual(
    texts(svg).filter((t) => /^[A-Z]/.test(t)),
    ["One", "Two", "Three", "One", "Two", "Three", "No", "Yes", "Zed value"],
  );
});

test("too many over() groups are refused with Stata's messages", () => {
  const run = session();
  for (const [command, message] of [
    [
      "graph bar y, over(g) over(h) over(k) over(g)",
      "may not specify more than 3 over() options",
    ],
    [
      "graph bar y z, over(g) over(h) over(k)",
      "may not specify more than two by variables when a varlist is specified",
    ],
    [
      "graph box y z, over(g) over(h) over(k)",
      "may not specify more than two by variables when a varlist is specified",
    ],
  ]) {
    const r = run(command);
    assert.equal(r.rc, 198, command);
    assert.equal(r.lines[0], message, command);
  }
  // Stata sorts the colours within each category when the first of three
  // over() has sort(); that is refused here, not drawn otherwise.
  assert.equal(run("graph bar y, over(g, sort(1)) over(h) over(k)").rc, 198);
});

/** The slices of a pie: their start and end, in degrees, and colours. */
function slices(svg) {
  const angle = (cx, cy, x, y) =>
    Math.round(
      ((((Math.atan2(cy - y, x - cx) * 180) / Math.PI) % 360) + 360) % 360,
    ) % 360;
  return [
    ...svg.matchAll(
      /<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) A[\d. ]+ [01] [01] ([\d.]+) ([\d.]+) Z" fill="(#[0-9a-f]+)"/g,
    ),
  ].map((m) => {
    const [cx, cy, x0, y0, x1, y1] = m.slice(1, 7).map(Number);
    return [angle(cx, cy, x0, y0), angle(cx, cy, x1, y1)];
  });
}
const PIE = `clear
input byte g double y double z str6 s
1 2 1 "b"
1 4 2 "b"
2 5 3 "a"
2 -1 4 "a"
3 1 . "c"
4 0 5 "c"
5 . 6 "d"
. 3 7 "e"
6 0.001 8 "e"
end
label variable z "Zed value"
label define gl 1 "One" 2 "Two" 3 "Three"
label values g gl`;

test("graph pie draws Stata's slices, labels and legend", () => {
  const run = session(PIE);
  // Sums of y by g: 6, 4, 1, 0 and .001; g 5 has no y and is left out,
  // and the slice of 0 is not drawn or labelled but is in the legend.
  let r = run("graph pie y, over(g) plabel(_all percent)");
  assert.equal(r.rc, 0);
  assert.deepEqual(slices(r.svg).slice(0, 3), [
    [90, 254],
    [254, 123],
    [123, 90],
  ]);
  assert.deepEqual(texts(r.svg), [
    ...["54.54%", "36.36%", "9.09%", ".0091%"],
    ...["One", "Two", "Three", "4", "6"],
  ]);
  // Each variable's sum over its own observations, named by its label.
  r = run("graph pie y z");
  assert.deepEqual(slices(r.svg), [
    [90, 349],
    [349, 90],
  ]);
  assert.deepEqual(texts(r.svg), ["y", "Zed value"]);
  r = run("graph pie z, over(s) plabel(_all sum)");
  assert.deepEqual(slices(r.svg), [
    [90, 20],
    [20, 350],
    [350, 300],
    [300, 240],
    [240, 90],
  ]);
  assert.deepEqual(texts(r.svg).slice(0, 5), ["7", "3", "5", "6", "15"]);
  // sort orders the slices by size and recolours them by place; the legend
  // follows.
  r = run("graph pie z, over(s) plabel(_all percent, format(%4.1f)) sort");
  assert.deepEqual(texts(r.svg), [
    ...["8.3%", "13.9%", "16.7%", "19.4%", "41.7%"],
    ...["b", "c", "d", "a", "e"],
  ]);
  r = run("graph pie z, over(s) sort descending");
  assert.deepEqual(texts(r.svg), ["e", "a", "d", "c", "b"]);
  // descending alone changes nothing.
  r = run("graph pie z, over(s) des");
  assert.deepEqual(texts(r.svg), ["a", "b", "c", "d", "e"]);
  // noclockwise angle0(0) runs counterclockwise from three o'clock.
  r = run("graph pie z, over(s) noclockwise angle(0)");
  assert.deepEqual(slices(r.svg)[0], [0, 70]);
  r = run("graph pie z, over(s) angle0(45)");
  assert.deepEqual(slices(r.svg)[0], [45, 335]);
  // missing keeps the observations with no g, labelled ".".
  r = run("graph pie, over(g) missing");
  assert.deepEqual(texts(r.svg), ["One", "Two", "Three", "4", "5", "6", "."]);
  assert.deepEqual(slices(r.svg)[0], [90, 10]);
  // plabel(# ...) labels one slice; a text, colour and size are drawn.
  r = run('graph pie z, over(s) plabel(2 percent) plabel(1 "hello")');
  assert.deepEqual(texts(r.svg).slice(0, 2), ["8.333%", "hello"]);
  r = run(
    "graph pie z, over(s) plabel(_all percent, format(%9.2f) color(red*0.5))",
  );
  assert.match(r.svg, /fill="#ff8080">19\.44%</);
  r = run("graph pie z, over(s) legend(off) title(Pie)");
  assert.deepEqual(texts(r.svg), ["Pie"]);
  // Sums and percentages are labelled in %6.4g: Stata writes the sums
  // 49382.71 and 86419.75 as 4.9e+04 and 8.6e+04, and a sum of .00049 as
  // 4.9e-04. Two plabel() options are both drawn.
  const sums = session(`clear
input double b str3 s
10 "x"
30 "x"
20 "y"
50 "y"
40 "z"
. "z"
end
replace b = b * 1234.5678`);
  r = sums("graph pie b, over(s) plabel(_all sum) plabel(_all percent)");
  assert.deepEqual(texts(r.svg), [
    ...["4.9e+04", "8.6e+04", "4.9e+04", "26.67%", "46.67%", "26.67%"],
    ...["x", "y", "z"],
  ]);
  r = sums("replace b = b / 1e8\ngraph pie b, over(s) plabel(_all sum)");
  assert.deepEqual(texts(r.svg), [
    "4.9e-04",
    "8.6e-04",
    "4.9e-04",
    "x",
    "y",
    "z",
  ]);
});

test("graph pie refuses and reports as Stata does", () => {
  const run = session(PIE);
  for (const [command, rc, message] of [
    [
      "graph pie y z, over(g)",
      198,
      "option over() invalid with more than one variable",
    ],
    ["graph pie y, plabel(_all value)", 198, "not a plabel() type , value"],
    ["graph pie z, over(s) plabel(0 sum)", 198, "invalid syntax"],
    ["graph pie (count) y, over(g)", 111, "variable count not found"],
    ["graph pie", 198, "graph specification required"],
    ["graph pie z, ov(s)", 198, "option ov() not allowed"],
    ["graph pie s", 109, "string variables not allowed in varlist;"],
  ]) {
    const r = run(command);
    assert.equal(r.rc, rc, command);
    assert.equal(r.lines.join("\n").split("\n")[0], message, command);
  }
  // Nothing to draw: Stata says so and returns 0.
  let r = run("graph pie y if y > 100, over(g)");
  assert.equal(r.rc, 0);
  assert.deepEqual(r.lines, ["sum of pie wedges is not positive"]);
  assert.equal(r.svg, undefined);
  r = run("graph pie z, over(s) plabel(9 sum)");
  assert.equal(r.rc, 0);
  assert.ok(r.svg);
  r = run("replace y = -abs(y)\ngraph pie y, over(g)");
  assert.equal(r.rc, 459);
  assert.equal(r.lines[0], "sum for a pie wedge is negative");
  // Looks graph pie does not draw are refused by name.
  assert.equal(run("graph pie z, over(s) pie(1, explode)").rc, 198);
  assert.equal(run("graph pie z, over(s) sort(y)").rc, 198);
});

test("graph matrix draws each pair over its own observations, with Stata's axes", () => {
  const run = session(`clear
input double a double b double c double d
1 10 100 0.5
2 30 . 0.25
3 20 300 .
4 50 250 0.75
5 40 150 1
6 . 200 0.1
end
label variable a "First var"
label variable c "Third"`);
  let r = run("graph matrix a b c d");
  assert.equal(r.rc, 0);
  // The diagonal: each variable's label, a word to a line.
  const words = texts(r.svg),
    labels = words.filter((t) => /^[A-Za-z]/.test(t));
  assert.deepEqual(labels, ["First", "var", "b", "Third", "d"]);
  // Pairs of present values: 5, 5, 5, 4, 4 and 4, each drawn twice.
  assert.equal((r.svg.match(/<circle /g) ?? []).length, 54);
  // Stata labels each variable with about three values: a 0 2 4 6, b 0 50,
  // c 100 200 300, d 0 .5 1, each twice, on alternate sides.
  const numbers = words.filter((t) => !/^[A-Za-z]/.test(t)).sort();
  assert.deepEqual(
    numbers,
    [
      ...["0", "2", "4", "6", "0", "50", "100", "200", "300", "0", ".5", "1"],
      ...["0", "2", "4", "6", "0", "50", "100", "200", "300", "0", ".5", "1"],
    ].sort(),
  );
  // half: the lower triangle, with axes at the left and the bottom only:
  // b, c and d up the left, a, b and c along the bottom.
  r = run("graph matrix a b c d, half ms(Oh) msize(small)");
  assert.equal((r.svg.match(/<circle [^>]*fill="none"/g) ?? []).length, 27);
  assert.deepEqual(
    texts(r.svg)
      .filter((t) => !/^[A-Za-z]/.test(t))
      .sort(),
    [
      ...["0", "50", "100", "200", "300", "0", ".5", "1"],
      ...["0", "2", "4", "6", "0", "50", "100", "200", "300"],
    ].sort(),
  );
  // Symbols, sizes and colours.
  r = run("graph matrix a b, ms(D) mcolor(red%50)");
  assert.match(
    r.svg,
    /<polygon points="[^"]*" fill="#ff0000" fill-opacity="0\.5"\/>/,
  );
  r = run("graph matrix a b, ms(Q)");
  assert.equal(r.rc, 0);
  assert.deepEqual(r.lines, [
    "(note:  named style Q not found in class symbol, default attributes used)",
    "(note:  named style Q not found in class symbol, default attributes used)",
  ]);
  assert.equal(run("graph matrix a").rc, 102);
  assert.equal(run("graph matrix a b, ha").rc, 198);
  assert.equal(run("graph matrix a b, diagonal(x)").rc, 198);
});

/** The fill, and its opacity, of a scatter's first marker. */
function marker(run, options) {
  const m = /<circle [^>]*fill="(#[0-9a-f]+)" fill-opacity="([\d.]+)"/.exec(
    run(`scatter y z, ${options}`).svg,
  );
  return [m[1], Number(m[2])];
}

test("colours take Stata's intensity and opacity", () => {
  const run = session();
  // Stata's fills: red%30 #FF0000 at 0.30; "255 0 0" #FF0000; red*0.5
  // #FF8080; red*1.5 #AA0000; navy*0.3%50 #BAC8D4 at 0.50; navy*2 #0D2438;
  // "255 0 0%50" at 0.50; %30 the first colour at 0.30; red*0.5%30;
  // "255 128 0*0.5" #FFC080; red*300 #010000; gs8*.2 #E6E6E6; red*0
  // #FFFFFF; red%0 at 0; red%33.3 at 0.33. red%130 and red*-1 are Stata's
  // default colour, opaque, without a note.
  const opaque = 0.85; // this page's own marker opacity
  for (const [options, fill, opacity] of [
    ["mcolor(red%30)", "#ff0000", 0.3],
    ['mcolor("255 0 0")', "#ff0000", opaque],
    ["mcolor(red*0.5)", "#ff8080", opaque],
    ["mcolor(red*1.5)", "#aa0000", opaque],
    ["mcolor(navy*0.3%50)", "#bac8d4", 0.5],
    ["mcolor(navy*2)", "#0d2438", opaque],
    ['mcolor("255 0 0%50")', "#ff0000", 0.5],
    ["mcolor(%30)", "#1a476f", 0.3],
    ["mcolor(red*0.5%30)", "#ff8080", 0.3],
    ['mcolor("255 128 0*0.5")', "#ffc080", opaque],
    ["mcolor(red*300)", "#010000", opaque],
    ["mcolor(gs8*.2)", "#e6e6e6", opaque],
    ["mcolor(red*0)", "#ffffff", opaque],
    ["mcolor(red%0)", "#ff0000", 0],
    ["mcolor(red%33.3)", "#ff0000", 0.333],
    ["mcolor(red%100)", "#ff0000", opaque],
    ["mcolor(red%130)", "#1a476f", opaque],
    ["mcolor(red*-1)", "#1a476f", opaque],
  ])
    assert.deepEqual(marker(run, options), [fill, opacity], options);
  // A text's colour: title(T, color(green*0.4)) is #99CC99.
  assert.match(
    run("scatter y z, title(T, color(green*0.4))").svg,
    /fill="#99cc99">T</,
  );
  // A line's opacity: lcolor(blue%40) strokes #0000FF at 0.40.
  assert.match(
    run("line y z, lcolor(blue%40)").svg,
    /<polyline fill="none" stroke="#0000ff" stroke-opacity="0\.4"/,
  );
  // An unknown name with an opacity gets Stata's note, twice.
  assert.deepEqual(run("scatter y z, mcolor(foo%30)").lines, [
    "(note:  named style foo not found in class color, default attributes used)",
    "(note:  named style foo not found in class color, default attributes used)",
  ]);
});
