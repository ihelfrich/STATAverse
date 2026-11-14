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
    ["mcolor(red%33.3)", "#ff0000", 0.33],
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

// ----- The tester's review of these graphs (13 November 2026) -----
// Recorded from Stata 19 MP as above, by graph export … .svg; the printed
// notes and errors are in tools/output-cases.txt (case
// graph-negative-nofill-weights-colours).

/** Every bar drawn, as [x, y, width, height]. */
const rects = (svg) =>
  [
    ...svg.matchAll(
      /<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="(-?[\d.]+)" height="(-?[\d.]+)" fill="(#[0-9a-f]+)" fill-opacity="0\.75"/g,
    ),
  ].map((m) => m.slice(1, 5).map(Number));

test("bars below zero hang down from the zero line, as Stata draws them", () => {
  const run = session(`clear
input g h double y
1 1 -2
1 2 3
2 1 -4
2 2 5
end`);
  // Stata: heights 483.13 and 966.09 hanging from y = 1675.86, and 724.44
  // and 1207.58 rising to it: 2, 4, 3 and 5 on one scale.
  for (const command of [
    "graph bar y, over(g) over(h)",
    "graph bar y, over(h) over(g)",
  ]) {
    const drawn = rects(run(command).svg);
    assert.equal(drawn.length, 4, command);
    assert.ok(
      drawn.every(([, , , height]) => height > 0),
      command,
    );
    // The bars below zero start where the others end.
    const tops = drawn.map(([, y]) => y),
      zero = Math.max(...tops);
    assert.equal(
      drawn.filter(([, y, , height]) => Math.abs(y - zero) < 0.01).length,
      2,
      command,
    );
    assert.equal(
      drawn.filter(([, y, , height]) => Math.abs(y + height - zero) < 0.01)
        .length,
      2,
      command,
    );
  }
  const heights = rects(run("graph bar y, over(g) over(h)").svg).map(
    (r) => r[3],
  );
  assert.deepEqual(
    heights.map((h) => Number(((2 * h) / heights[0]).toFixed(3))),
    [2, 4, 3, 5],
  );
  // blabel(bar) puts the label of a bar below zero under its end.
  const r = run("graph bar y if h == 1, over(g) blabel(bar)"),
    label = /<text x="[\d.]+" y="([\d.]+)"[^>]*>-2<\/text>/.exec(r.svg),
    bar = rects(r.svg)[0];
  assert.equal(rects(r.svg).length, 2);
  assert.ok(Number(label[1]) > bar[1] + bar[3]);
});

test("nofill drops a pair of groups whose y is missing in every observation", () => {
  const run = session(`clear
input byte g byte h double y double z
1 1 5 1
2 1 6 2
3 1 7 3
1 2 8 4
2 2 1 5
3 2 . 6
end
label define gl 1 "One" 2 "Two" 3 "Three"
label values g gl`);
  const words = (svg) => texts(svg).filter((t) => /^[A-Z]/.test(t));
  // Stata: One Two Three | One Two, as for a pair with no observations.
  let r = run("graph bar y, over(g) over(h) nofill");
  assert.deepEqual(words(r.svg), ["One", "Two", "Three", "One", "Two"]);
  sameBars(bars(r.svg), [0, 1.67, 3.34, 6.34, 8.01], [5, 6, 7, 8, 1]);
  // With sort(1), Two (1) and One (8) at 6.34 and 8.01.
  r = run("graph bar y, over(g, sort(1)) over(h) nofill");
  assert.deepEqual(words(r.svg), ["One", "Two", "Three", "Two", "One"]);
  sameBars(bars(r.svg), [0, 1.67, 3.34, 6.34, 8.01], [5, 6, 7, 1, 8]);
  // hbar draws five bars and box five boxes, each with five labels.
  assert.equal(
    words(run("graph hbar y, over(g) over(h) nofill").svg).length,
    5,
  );
  r = run("graph box y, over(g) over(h) nofill");
  assert.equal(words(r.svg).length, 5);
  assert.equal((r.svg.match(/stroke-width="2"/g) ?? []).length, 5);
  // A pair kept by another statistic, or by a count or sum of 0, keeps its
  // place: six labels each.
  for (const command of [
    "graph bar y z, over(g) over(h) nofill",
    "graph bar (count) y, over(g) over(h) nofill",
    "graph bar (sum) y, over(g) over(h) nofill",
    "graph box y z, over(g) over(h) nofill",
  ])
    assert.equal(words(run(command).svg).length, 6, command);
});

test("graph matrix breaks its diagonal labels as Stata does, and draws with no observations", () => {
  const run = session(`clear
set seed 5
set obs 20
generate a = runiform()
generate b = runiform()
generate c = runiform()
generate d = runiform()
generate e = runiform()
generate f = runiform()`);
  const diagonal = (svg) =>
    [...svg.matchAll(/<text [^>]*font-size="12">([^<]*)<\/text>/g)].map(
      (m) => m[1],
    );
  run('label variable a "Annual household income"');
  run('label variable b "Age in years"');
  run('label variable c "Hours worked per week last year"');
  run('label variable d "Highest grade of school completed"');
  assert.deepEqual(diagonal(run("graph matrix a b c d").svg), [
    ...["Annual", "household", "income", "Age in", "years"],
    ...["Hours", "worked per", "week last", "year"],
    ...["Highest", "grade of", "school", "completed"],
  ]);
  run('label variable a "Log of real hourly wage in 2010 dollars"');
  run('label variable b "Gross domestic product per capita in dollars"');
  run('label variable c "WWW MMM WWW iii lll iii"');
  run(
    `label variable d "Respondent's self-reported overall health status (1-5)"`,
  );
  run('label variable e "x y"');
  run('label variable f "Supercalifragilistic expialidocious"');
  assert.deepEqual(diagonal(run("graph matrix a b c d e f").svg), [
    ...["Log of real", "hourly wage", "in 2010", "dollars"],
    ...["Gross", "domestic", "product per", "capita in", "dollars"],
    ...["WWW MMM", "WWW iii", "lll iii"],
    ...["Respondent's", "self-reported", "overall health", "status (1-5)"],
    ...["x y", "Supercalifragilistic", "expialidocious"],
  ]);
  run('label variable a "A"');
  run('label variable b "First var"');
  run('label variable c "%_(){}[] ~^ ok"');
  run('label variable d "Number of children ever born to the woman"');
  run('label variable e "GDP"');
  run('label variable f "Mean years of schooling, adults 25+"');
  assert.deepEqual(diagonal(run("graph matrix a b c d e f").svg), [
    ...["A", "First", "var", "%_(){}[]", "~^ ok"],
    ...["Number of", "children", "ever born to", "the woman", "GDP"],
    ...["Mean years", "of", "schooling,", "adults 25+"],
  ]);
  // With no observations Stata draws the matrix, its labels only; a
  // variable missing everywhere has no axis labels.
  const empty = session(`clear
set seed 8
set obs 200
generate double y = runiform()*10
generate double m = .
generate double frac = 1 + floor(3*runiform()) + 0.5`);
  const r = empty("graph matrix y frac if y > 100");
  assert.equal(r.rc, 0);
  assert.deepEqual(texts(r.svg), ["y", "frac"]);
  assert.deepEqual(texts(empty("graph matrix y m").svg), [
    ...["y", "m", "0", "5", "10", "0", "5", "10"],
  ]);
  assert.deepEqual(texts(empty("graph matrix y m, half").svg), [
    ...["y", "m", "0", "5", "10"],
  ]);
});

/** A pie's wedges as drawn: where each starts and its sweep, in degrees. */
function wedges(svg) {
  const angle = (cx, cy, x, y) =>
    ((Math.atan2(cy - y, x - cx) * 180) / Math.PI + 360) % 360;
  return [
    ...svg.matchAll(
      /<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) A[\d. ]+ ([01]) ([01]) ([\d.]+) ([\d.]+) Z"/g,
    ),
  ].map((m) => {
    const [cx, cy, x0, y0, , clockwise, x1, y1] = m.slice(1, 9).map(Number),
      from = angle(cx, cy, x0, y0),
      to = angle(cx, cy, x1, y1),
      sweep = ((clockwise ? from - to : to - from) + 360) % 360;
    return [Number(from.toFixed(1)), Number(sweep.toFixed(1))];
  });
}

test("graph pie draws each wedge between whole degrees, as Stata does", () => {
  const run = session(`clear
input byte g double y double v double w double u double e
1 1 3 1 7 1
2 2 5 719 713 1
3 4 2 0 0 1
4 0 1 0 0 0
5 0 4 0 0 0
6 0 7 0 0 0
7 0 1 0 0 0
end`);
  const sweeps = (command) => wedges(run(command).svg).map((w) => w[1]);
  // Stata: 51, 103 and 206 degrees for 1, 2 and 4.
  assert.deepEqual(sweeps("graph pie y if g <= 3, over(g)"), [51, 103, 206]);
  // 3, 5, 2, 1, 4, 7 and 1: Stata ends each wedge at the running sum,
  // rounded: 47, 78, 32, 15, 63, 109 and 16.
  assert.deepEqual(
    sweeps("graph pie v, over(g)"),
    [47, 78, 32, 15, 63, 109, 16],
  );
  // Seven equal wedges are 51 and 52 degrees in turn.
  run("replace e = 1");
  assert.deepEqual(
    sweeps("graph pie e, over(g)"),
    [51, 52, 51, 52, 51, 52, 51],
  );
  // A wedge of half a degree vanishes when the angle it ends at, 89.5
  // from 90 clockwise, rounds back to 90: Stata draws one full circle.
  let r = run("graph pie w, over(g)");
  assert.deepEqual(wedges(r.svg), []);
  assert.equal((r.svg.match(/<circle /g) ?? []).length, 1);
  // Counterclockwise it ends at 90.5, which rounds to 91.
  assert.deepEqual(sweeps("graph pie w, over(g) noclockwise"), [1, 359]);
  // From 0 clockwise, -3.5 rounds up to -3: 3 and 357.
  assert.deepEqual(sweeps("graph pie u, over(g) angle0(0)"), [3, 357]);
  // angle0(10.4) starts the wedges at 10 degrees, angle0(10.6) at 11.
  run("replace e = cond(g <= 3, 1, 0)");
  assert.equal(wedges(run("graph pie e, over(g) angle0(10.4)").svg)[0][0], 10);
  assert.equal(wedges(run("graph pie e, over(g) angle0(10.6)").svg)[0][0], 11);
  // The label of the vanished wedge is still drawn, as Stata draws it.
  r = run("graph pie w, over(g) plabel(_all sum)");
  assert.deepEqual(texts(r.svg).slice(0, 2), ["1", "719"]);
});

test("graph pie takes weights and several over() variables as Stata does", () => {
  const run = session(`clear
input byte g double y byte w double v byte h str2 s
1 1 2 1.5 1 "a"
2 2 1 2.5 2 "b"
3 4 3 0.5 1 "c"
1 3 1 1 2 "a"
2 . 2 4 . ""
. 5 1 2 1 "a"
3 2 0 3 2 ""
end
label define gl 1 "Lo" 2 "Mid" 3 "Hi"
label values g gl`);
  const sums = (command) => texts(run(command).svg).slice(0, 3);
  // Stata: fweights and pweights sum y times the weight, 5, 2 and 12;
  // aweights are scaled to sum to the 4 observations, 2.857, 1.143 and
  // 6.857; with no variable, aweights count 1.667 in each group.
  assert.deepEqual(sums("graph pie y [fw=w], over(g) plabel(_all sum)"), [
    ...["5", "2", "12"],
  ]);
  assert.deepEqual(sums("graph pie y [pw=w], over(g) plabel(_all sum)"), [
    ...["5", "2", "12"],
  ]);
  assert.deepEqual(sums("graph pie y [aw=w], over(g) plabel(_all sum)"), [
    ...["2.857", "1.143", "6.857"],
  ]);
  assert.deepEqual(sums("graph pie [aw=w], over(g) plabel(_all sum)"), [
    ...["1.667", "1.667", "1.667"],
  ]);
  assert.deepEqual(sums("graph pie y v [fw=w], plabel(_all sum)"), [
    ...["24", "18", "y"],
  ]);
  assert.deepEqual(
    wedges(run("graph pie y [fw=w], over(g)").svg).map((w) => w[1]),
    [95, 38, 227],
  );
  assert.equal(run("graph pie y [iw=w], over(g)").rc, 101);
  // over(g s) makes a wedge of each pair present, named by both values.
  assert.deepEqual(texts(run("graph pie y, over(g s)").svg), [
    ...["Lo a", "Mid b", "Hi c"],
  ]);
  // A pie of one wedge has no legend: graph pie y, the same with an empty
  // over(), which is as none, and a pie of one group.
  for (const command of [
    "graph pie y",
    "graph pie y, over()",
    "graph pie y if g == 1, over(g)",
  ]) {
    const r = run(command);
    assert.equal(r.rc, 0, command);
    assert.deepEqual(texts(r.svg), [], command);
  }
  // over() with a comma is not a varlist to graph pie.
  for (const command of [
    "graph pie y, over(g, sort(1))",
    "graph pie y, over(g,)",
  ]) {
    const r = run(command);
    assert.equal(r.rc, 198, command);
    assert.deepEqual(r.lines, [
      "over() does not contain a valid varlist",
      "r(198);",
    ]);
  }
});

test("graph bar and box take fweights and missing, and check over() as Stata does", () => {
  const run = session(`clear
input byte g double y byte w byte h str2 s
1 1 2 1 "a"
2 2 1 2 "b"
3 4 3 1 "c"
1 3 1 2 "a"
2 . 2 . ""
. 5 1 1 "a"
3 2 0 2 ""
end
label define gl 1 "Lo" 2 "Mid" 3 "Hi"
label values g gl`);
  // Stata, with [fw=w]: means 1.667, 2 and 4; sums 5, 2 and 12; counts
  // 3, 1 and 3; medians 1, 2 and 4; with no variable, 3 in each group.
  for (const [statistic, heights] of [
    ["(mean) y", [5 / 3, 2, 4]],
    ["(sum) y", [5, 2, 12]],
    ["(count) y", [3, 1, 3]],
    ["(percent) y", [3, 1, 3]],
    ["(median) y", [1, 2, 4]],
    ["(count)", [3, 3, 3]],
  ])
    sameBars(
      bars(run(`graph bar ${statistic} [fw=w], over(g)`).svg),
      [0, 1.67, 3.34],
      heights,
    );
  // Stata draws aweights and pweights, and graph matrix sizes its markers
  // by the weight; this page refuses them with the hint. Stata refuses
  // iweights.
  for (const command of [
    "graph bar y [aw=w], over(g)",
    "graph bar y [pw=w], over(g)",
    "graph box y [aw=w], over(g)",
    "graph matrix y w [aw=w]",
    "graph matrix y w [fw=w]",
  ])
    assert.equal(run(command).rc, 198, command);
  assert.equal(run("graph bar y [iw=w], over(g)").rc, 101);
  // missing draws a "." group last: means 2, 2, 3 and 5.
  const groups = (svg) =>
    texts(svg).filter((t) => /^(Lo|Mid|Hi|a|b|c|\.)$/.test(t));
  let r = run("graph bar y, over(g) missing");
  sameBars(bars(r.svg), [0, 1.67, 3.34, 5.01], [2, 2, 3, 5]);
  assert.deepEqual(groups(r.svg), ["Lo", "Mid", "Hi", "."]);
  r = run("graph bar y, over(g) over(h) missing");
  sameBars(bars(r.svg), [0, 3.34, 5.01, 8.01, 9.68, 11.35], [1, 4, 5, 3, 2, 2]);
  // nofill then leaves out the outer group "." whose one pair has no y:
  // Stata's outer labels are 1 and 2.
  r = run("graph bar y, over(g) over(h) missing nofill");
  assert.deepEqual(
    [...r.svg.matchAll(/font-size="13">([^<]*)</g)].map((m) => m[1]),
    ["1", "2"],
  );
  // A string over() names its empty value ".".
  r = run("graph bar y, over(s) missing");
  sameBars(bars(r.svg), [0, 1.67, 3.34, 5.01], [3, 2, 4, 2]);
  assert.deepEqual(groups(r.svg), ["a", "b", "c", "."]);
  assert.equal(run("graph box y, over(g) missing").rc, 0);
  // Stata: over(g h) is too many variables, r(103); the same variable in
  // two over() fails Stata's merge of the groups, r(5).
  assert.equal(run("graph bar y, over(g h) over(h)").rc, 103);
  assert.equal(run("graph box y, over(g h)").rc, 103);
  assert.equal(run("graph bar y, over(s) over(s)").rc, 5);
  assert.equal(run("graph bar y, over(g) over(h) over(g)").rc, 5);
  assert.equal(run("graph hbar y, over(g) over(g)").rc, 5);
});

test("colour names are Stata's, in lower case, and opacities whole percentages", () => {
  const run = session();
  const note = (name) =>
    `(note:  named style ${name} not found in class color, default attributes used)`;
  // Stata: Red, gs20 and "1 2" are not colours: the note twice, and the
  // markers drawn black.
  for (const [option, name] of [
    ["mcolor(Red)", "Red"],
    ["mcolor(gs20)", "gs20"],
    ['mcolor("1 2")', "1 2"],
  ]) {
    const r = run(`scatter y z, ${option}`);
    assert.deepEqual(r.lines, [note(name), note(name)], option);
    assert.match(r.svg, /<circle [^>]*fill="#000000"/, option);
  }
  // graph matrix prints it four times.
  assert.deepEqual(run('graph matrix y z, mcolor("1 2")').lines, [
    ...[note("1 2"), note("1 2"), note("1 2"), note("1 2")],
  ]);
  // RED%50 is black at 0.50; red% is opaque red; red%50.9 and red%50.5
  // are 0.50; red*0.9 is #FF1919; red%30%40 and red*0.5*0.5 are the
  // default colour.
  assert.deepEqual(marker(run, "mcolor(RED%50)"), ["#000000", 0.5]);
  assert.deepEqual(marker(run, "mcolor(red%)"), ["#ff0000", 0.85]);
  assert.deepEqual(marker(run, "mcolor(red%50.9)"), ["#ff0000", 0.5]);
  assert.deepEqual(marker(run, "mcolor(red%50.5)"), ["#ff0000", 0.5]);
  assert.deepEqual(marker(run, "mcolor(red*0.9)"), ["#ff1919", 0.85]);
  assert.deepEqual(marker(run, "mcolor(red%30%40)"), ["#1a476f", 0.85]);
  assert.deepEqual(marker(run, "mcolor(red*0.5*0.5)"), ["#1a476f", 0.85]);
});

test("color(), mfcolor() and lcolor() colour histograms, fits, densities and markers as Stata does", () => {
  const run = session();
  // Stata: histogram color(red%40) fills #FF1919 at 0.40, outlined #FF0000
  // at 0.40.
  let svg = run("histogram y, color(red%40)").svg;
  assert.match(
    svg,
    /<rect [^>]*fill="#ff1919" fill-opacity="0\.4" stroke="#ff0000" stroke-opacity="0\.4"\/>/,
  );
  // twoway bar color(red) lcolor(blue): #FF3333 outlined in blue.
  svg = run("twoway bar y z, color(red) lcolor(blue)").svg;
  assert.match(
    svg,
    /<rect [^>]*fill="#ff3333" fill-opacity="1" stroke="#0000ff"/,
  );
  // lfitci color(red%20): the band and the line red at 0.20; lcolor()
  // alone colours the line only.
  svg = run("twoway lfitci y z, color(red%20)").svg;
  assert.match(
    svg,
    /<polygon fill="#ff0000" fill-opacity="0\.2" stroke="none"/,
  );
  assert.match(
    svg,
    /<polyline fill="none" stroke="#ff0000" stroke-opacity="0\.2"/,
  );
  assert.doesNotMatch(
    run("twoway lfitci y z, lcolor(red)").svg,
    /<polygon fill="#ff0000"/,
  );
  // kdensity lcolor(red%50) and twoway kdensity color(red): the line.
  assert.match(
    run("kdensity y, lcolor(red%50)").svg,
    /<polyline fill="none" stroke="#ff0000" stroke-opacity="0\.5"/,
  );
  assert.match(
    run("twoway kdensity y, color(red)").svg,
    /<polyline fill="none" stroke="#ff0000"/,
  );
  // mfcolor(red%30): the fill red at 0.30, the outline the marker's own.
  assert.match(
    run("scatter y z, mfcolor(red%30)").svg,
    /<circle [^>]*fill="#ff0000" fill-opacity="0\.3" stroke="#1a476f"/,
  );
  // scatter color(red%40): the markers.
  assert.deepEqual(marker(run, "color(red%40)"), ["#ff0000", 0.4]);
});

test("nofill packs the bars of a category whose colours are missing, as Stata does", () => {
  const run = session(`clear
input byte k byte g byte h double y
1 1 1 2
2 1 1 3
1 2 1 4
1 3 1 5
2 3 1 6
1 1 2 7
2 1 2 8
2 2 2 9
1 3 2 .
2 3 2 3
end`);
  // Stata: under nofill a colour with no bar takes no room, so the single
  // bars of 2 under 1, and of 2 and 3 under 2, stand alone: 0, 1, 2.67,
  // 4.34, 5.34, 8.34, 9.34, 11.01 and 12.68 bar widths.
  sameBars(
    bars(run("graph bar y, over(k) over(g) over(h) nofill").svg),
    [0, 1, 2.67, 4.34, 5.34, 8.34, 9.34, 11.01, 12.68],
    [2, 3, 4, 5, 6, 7, 8, 9, 3],
    [0, 1, 0, 0, 1, 0, 1, 1, 1],
  );
  // Without nofill each keeps its slot.
  sameBars(
    bars(run("graph bar y, over(k) over(g) over(h)").svg),
    [0, 1, 2.67, 5.34, 6.34, 9.34, 10.34, 13.01, 15.68],
    [2, 3, 4, 5, 6, 7, 8, 9, 3],
  );
  // A count of 0 keeps its slot: the last bar is at 13.68.
  const counted = bars(
    run("graph bar (count) y, over(k) over(g) over(h) nofill").svg,
  );
  assert.equal(counted.at(-1).at, 13.68);
});
