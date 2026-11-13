// Title options on every graph command, and the histogram of a variable
// that is missing in every observation, from the second red-team round of
// 13 November 2026. Every expected value was recorded from Stata 19 MP
// (version 17, set processors 1) by drawing the same graphs on the labor
// data, exporting them with graph export ... .svg and reading the SVG's
// <text> elements: their text, their fill, their font size and their
// text-anchor (none for text set against the left edge, "end" for the
// right, "middle" for the centre). The printed messages are compared in
// tools/output-cases.txt (case graph-text-options).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

function labor(setup = []) {
  const s = createConsoleSession();
  s.reset("labor");
  for (const command of setup) assert.equal(s.run(command).rc, 0, command);
  return s;
}
function graph(s, command) {
  const out = s.run(command);
  assert.equal(out.rc, 0, `${command}: ${JSON.stringify(out.output)}`);
  return {
    svg: out.output
      .map((o) => o.graph)
      .filter(Boolean)
      .at(-1).svg,
    lines: out.output.flatMap((o) => o.lines ?? []),
  };
}
function refused(s, command) {
  const out = s.run(command);
  return { rc: out.rc, lines: out.output.flatMap((o) => o.lines ?? []) };
}
const texts = (svg) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
// The attributes of the <text> element that draws exactly this text.
function attributes(svg, text) {
  const found = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].filter(
    (m) => m[2] === text,
  );
  assert.equal(found.length, 1, `one text "${text}" in ${texts(svg)}`);
  const attrs = {};
  for (const a of found[0][1].matchAll(/([\w-]+)="([^"]*)"/g))
    attrs[a[1]] = a[2];
  return attrs;
}
// Where the text is set across the graph: against the left edge, the
// right, or in the middle, as its text-anchor says.
const side = (svg, text) =>
  ({ undefined: "left", end: "right", middle: "middle" })[
    attributes(svg, text)["text-anchor"]
  ];
const DEFAULT_TITLE_SIZE = 16;

test("size() and color() in a title are drawn on graph bar, hbar and box", () => {
  const s = labor();
  // Stata: rc 0 for each; the texts are Union, Mean wage, Wages by region,
  // Wages, Box and Source: CPS, with no suboption printed.
  const union = graph(
    s,
    "graph bar (percent) union, over(region) title(Union, size(medium))",
  ).svg;
  assert.ok(!texts(union).some((t) => /size\(/.test(t)));
  // Stata draws a medium title at 123.69 against a default (large) title's
  // 157.44: smaller than the default.
  assert.ok(
    Number(attributes(union, "Union")["font-size"]) < DEFAULT_TITLE_SIZE,
  );
  const mean = graph(
    s,
    'graph bar (mean) wage, over(region) ytitle("Mean wage", size(small))',
  ).svg;
  assert.equal(attributes(mean, "Mean wage")["font-size"], "10");
  // Stata: fill #0000ff.
  const blue = graph(
    s,
    'graph bar (mean) wage, over(region) title("Wages by region", color(blue))',
  ).svg;
  assert.equal(attributes(blue, "Wages by region").fill, "#0000ff");
  // Stata: the hbar's title at the large size, and its ytitle, along the
  // bottom, in #FF0000.
  const hbar = graph(
    s,
    "graph hbar (mean) wage, over(region) title(Wages, size(large)) ytitle(Wage, color(red) size(small))",
  ).svg;
  assert.equal(attributes(hbar, "Wages")["font-size"], "16");
  assert.equal(attributes(hbar, "Wage").fill, "#ff0000");
  // Stata: Box in #FF0000.
  const box = graph(
    s,
    "graph box wage, over(female) title(Box, size(large) color(red))",
  ).svg;
  assert.equal(attributes(box, "Box").fill, "#ff0000");
  // Stata: the note at 67.50, below the 89.94 of a default note.
  const note = graph(
    s,
    'graph bar (mean) wage, over(region) note("Source: CPS", size(vsmall))',
  ).svg;
  assert.ok(Number(attributes(note, "Source: CPS")["font-size"]) < 11);
});

test("size() and color() in a title are drawn on kdensity, lowess and the diagnostic plots", () => {
  const s = labor();
  // Stata: KD, LW's xtitle E, QN, PN and R in their colours, unprinted.
  assert.equal(
    attributes(
      graph(s, "kdensity wage, title(KD, size(small) color(red))").svg,
      "KD",
    ).fill,
    "#ff0000",
  );
  const lw = graph(
    s,
    "lowess wage educ, title(LW, size(small)) xtitle(E, color(blue))",
  ).svg;
  assert.equal(attributes(lw, "LW")["font-size"], "10");
  assert.equal(attributes(lw, "E").fill, "#0000ff");
  assert.equal(
    attributes(graph(s, "qnorm wage, title(QN, color(red))").svg, "QN").fill,
    "#ff0000",
  );
  assert.equal(
    attributes(graph(s, "pnorm wage, subtitle(PN, color(red))").svg, "PN").fill,
    "#ff0000",
  );
  assert.equal(s.run("regress wage educ").rc, 0);
  // Stata: R in #FF0000 against the right edge (text-anchor end).
  const rvf = graph(s, "rvfplot, title(R, color(red) position(1))").svg;
  assert.equal(attributes(rvf, "R").fill, "#ff0000");
  assert.equal(side(rvf, "R"), "right");
});

test("position() sets a title or note against the left edge, the right or the middle", () => {
  const s = labor();
  // Stata: title(Main, position(11)) is set at the left edge, where the
  // note is, with no text-anchor; both at x 542.19.
  const left = graph(
    s,
    'scatter wage educ, title("Main", position(11)) note(N)',
  ).svg;
  assert.equal(side(left, "Main"), "left");
  assert.equal(attributes(left, "Main").x, attributes(left, "N").x);
  // Stata: pos(1) is text-anchor end; subtitle position(12) middle.
  const right = graph(
    s,
    "scatter wage educ, title(Main, pos(1)) subtitle(Sub, position(12))",
  ).svg;
  assert.equal(side(right, "Main"), "right");
  assert.equal(side(right, "Sub"), "middle");
  // Stata: the note at position(7) on the left, the caption at position(5)
  // on the right, and a caption at position(6) in the middle.
  const below = graph(
    s,
    'scatter wage educ, note("Source: x", size(vsmall) position(7)) caption(Cap, position(5))',
  ).svg;
  assert.equal(side(below, "Source: x"), "left");
  assert.equal(side(below, "Cap"), "right");
  assert.equal(
    side(graph(s, "scatter wage educ, caption(Cap, position(6))").svg, "Cap"),
    "middle",
  );
  // Stata: the same for twoway, graph hbar, and by()'s own title.
  assert.equal(
    side(
      graph(s, 'twoway scatter wage educ, title("Main", position(11))').svg,
      "Main",
    ),
    "left",
  );
  assert.equal(
    side(
      graph(s, "graph hbar (mean) wage, over(region) title(Main, position(11))")
        .svg,
      "Main",
    ),
    "left",
  );
  assert.equal(
    side(
      graph(s, "scatter wage educ, by(female, title(All, position(11)))").svg,
      "All",
    ),
    "left",
  );
  // Stata: position() with nothing in it leaves the title in the middle.
  assert.equal(
    side(graph(s, "scatter wage educ, title(Main, position())").svg, "Main"),
    "middle",
  );
});

test("title suboptions Stata does not allow are refused with its message", () => {
  const s = labor();
  // Stata: each r(198) with these messages.
  for (const [command, message] of [
    ["scatter wage educ, title(Main, po(11))", "option po() not allowed"],
    [
      "scatter wage educ, title(Main, POSition(11))",
      "option POSition() not allowed",
    ],
    [
      "scatter wage educ, xtitle(X, position(11))",
      "option position() not allowed",
    ],
    ["scatter wage educ, ytitle(Y, ring(0))", "option ring() not allowed"],
  ]) {
    const out = refused(s, command);
    assert.equal(out.rc, 198, command);
    assert.equal(out.lines[0], message, command);
  }
});

test("ring(), margin() and positions on another side are refused, not ignored", () => {
  // Stata draws these (rc 0), moving the text inside the plot, shifting the
  // plot or putting the text on another side; this page does not, so it
  // refuses them by name rather than draw the text where Stata would not.
  const s = labor();
  for (const command of [
    'scatter wage educ, title("Main", ring(0))',
    'scatter wage educ, ytitle("Wage ($)", margin(medium))',
    "scatter wage educ, title(Main, position(3))",
    "scatter wage educ, note(N, position(12))",
    "graph bar (mean) wage, over(region) title(Main, ring(0))",
  ]) {
    const out = refused(s, command);
    assert.equal(out.rc, 198, command);
    assert.match(out.lines[0], /is not drawn on this page/, command);
  }
});

test("histogram of a variable missing everywhere draws empty axes", () => {
  const s = labor(["gen w5 = .", "gen w6 = wage if female == 1"]);
  // Stata: rc 0, no bin line, and the SVG's texts -1 | 1 | Density | w5.
  assert.equal(s.run("summarize wage").rc, 0);
  const plain = graph(s, "histogram w5");
  assert.deepEqual(plain.lines, []);
  assert.deepEqual(
    texts(plain.svg).sort(),
    ["-1", "1", "Density", "w5"].sort(),
  );
  assert.equal((plain.svg.match(/fill-opacity="0\.75"/g) ?? []).length, 0);
  // Stata leaves r() empty.
  assert.deepEqual(
    s.run("return list").output.flatMap((o) => o.lines ?? []),
    [],
  );
  // Stata: -1 | 1 | Frequency | w5; -1 | 1 | Density | -1 | 1 | w5 with a
  // normal curve; the xlabel()s and the title with xlabel(0(1)3) title(T).
  assert.deepEqual(
    texts(graph(s, "histogram w5, frequency").svg).sort(),
    ["-1", "1", "Frequency", "w5"].sort(),
  );
  assert.deepEqual(
    texts(graph(s, "histogram w5, start(0) normal").svg).sort(),
    ["-1", "1", "-1", "1", "Density", "w5"].sort(),
  );
  const labelled = graph(s, "histogram w5, xlabel(0(1)3) title(T, color(red))");
  assert.deepEqual(
    texts(labelled.svg).sort(),
    ["-1", "1", "0", "1", "2", "3", "Density", "w5", "T"].sort(),
  );
  assert.equal(attributes(labelled.svg, "T").fill, "#ff0000");
  // Stata: rc 0 for one observation in the sample, and for by() when one
  // group has values.
  graph(s, "histogram w5 in 1/1");
  graph(s, "histogram w6, by(female)");
});

test("histogram of a variable missing everywhere refuses by(), discrete and width()", () => {
  const s = labor(["gen w5 = ."]);
  // Stata: r(125) with this message, and r() left empty.
  for (const command of [
    "histogram w5, by(female)",
    "histogram w5, by(female) frequency",
    "histogram w5, discrete",
    "histogram w5, width(1)",
  ]) {
    assert.equal(s.run("summarize wage").rc, 0);
    const out = refused(s, command);
    assert.equal(out.rc, 125, command);
    assert.equal(
      out.lines[0],
      "width() invalid -- invalid number, outside of allowed range",
    );
    assert.deepEqual(
      s.run("return list").output.flatMap((o) => o.lines ?? []),
      [],
    );
  }
  // Stata: "no observations" r(2000) only when if or in leaves no rows,
  // with r(N) = 0 left behind.
  const none = refused(s, "histogram w5 if female == 7");
  assert.equal(none.rc, 2000);
  assert.equal(none.lines[0], "no observations");
  assert.match(
    s
      .run("return list")
      .output.flatMap((o) => o.lines ?? [])
      .join("\n"),
    /r\(N\) =\s+0\n?$/m,
  );
});
