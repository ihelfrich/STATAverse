// Graphs with by() panels, a trailing if or in, titles and marker labels,
// from the red-team findings of 13 November 2026. Every expected value was
// recorded from Stata 19 MP (version 17, set processors 1) on the labor
// dataset exported from this console, by drawing each graph and reading the
// SVG that graph export wrote: its <circle> marks (Stata draws two per
// marker), its <text> labels and its bar rectangles. The printed notes and
// error messages are compared in tools/output-cases.txt (case graph-panels).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

function labor(setup = "") {
  const s = createConsoleSession();
  s.reset("labor");
  if (setup) assert.equal(s.run(setup).rc, 0);
  return s;
}
function graph(s, command) {
  const out = s.run(command);
  assert.equal(out.rc, 0, command);
  return {
    ...out.output
      .map((o) => o.graph)
      .filter(Boolean)
      .at(-1),
    lines: out.output.flatMap((o) => o.lines ?? []),
  };
}
const circles = (svg) => (svg.match(/<circle\b/g) ?? []).length;
const texts = (svg) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
// The marker labels mlabel() writes, in the order of the markers.
const markerLabels = (svg) =>
  [...svg.matchAll(/font-size="10">([^<]*)</g)].map((m) => m[1]);
// The drawn panels of a by() graph, each its own <svg>.
const panels = (svg) => svg.split(/(?=<svg x=)/).slice(1);
// A panel's y-axis tick labels, its x-axis tick labels and the rest.
const yLabels = (panel) =>
  [...panel.matchAll(/text-anchor="end">([^<]*)</g)].map((m) => m[1]);
const xLabels = (panel) =>
  [...panel.matchAll(/y="[\d.]+" text-anchor="middle">([^<]*)</g)].map(
    (m) => m[1],
  );

test("if and in after plots in parentheses apply to every plot", () => {
  const s = labor();
  // Stata: 606 circles (303 markers, the legend's included), 40 circles
  // with the x axis labelled 10 12 14 16 18, and 2 (the legend's only).
  assert.equal(
    circles(
      graph(s, "twoway (scatter wage educ) (lfit wage educ) if female==0").svg,
    ),
    302,
  );
  const in20 = graph(s, "twoway (scatter wage educ) (lfit wage educ) in 1/20");
  assert.equal(circles(in20.svg), 19);
  assert.deepEqual(xLabels(in20.svg), ["10", "12", "14", "16", "18"]);
  const none = graph(
    s,
    "twoway (scatter wage educ) (lfit wage educ) if wage<0",
  );
  assert.equal(circles(none.svg), 0);
  assert.deepEqual(none.lines, ["(note:  regress could not fit model)"]);
  assert.doesNotMatch(none.svg, /NaN|Infinity/);
  // Each plot's own if and in are kept: Stata draws 40 and 152 circles.
  assert.equal(
    circles(
      graph(s, "twoway (scatter wage educ in 1/50) (lfit wage educ) in 1/20")
        .svg,
    ),
    19,
  );
  assert.equal(
    circles(
      graph(
        s,
        "twoway (scatter wage educ if female==1) (lfit wage educ) if educ>14",
      ).svg,
    ),
    75,
  );
  // Stata: "junk is not a twoway plot type", r(198); an out-of-range in is
  // r(198) "observation numbers out of range".
  const junk = s.run("twoway (scatter wage educ) (lfit wage educ) junk");
  assert.equal(junk.rc, 198);
  assert.match(
    junk.output.at(-1).lines.join("\n"),
    /junk is not a twoway plot type/,
  );
  assert.equal(
    s.run("twoway (scatter wage educ) (lfit wage educ) in 900/1000").rc,
    198,
  );
  // scatter with no observations draws an empty graph and returns 0.
  assert.equal(circles(graph(s, "scatter wage educ if wage<0").svg), 0);
});

test("by(, total): the Total panel leaves out a missing by-variable", () => {
  const s = labor("gen fem2 = female\nreplace fem2 = . in 1/40");
  // Stata: 2188 circles, 1094 markers: 547 in the panels and 547 in Total.
  const scatter = graph(s, "scatter wage educ, by(fem2, total)");
  assert.equal(circles(scatter.svg), 1094);
  assert.equal(circles(panels(scatter.svg)[2]), 547);
  // Stata's bars, read from its SVG: the bins are those of all 586 wages
  // (24 of width 1.915), the panels count their own rows, and Total counts
  // the 547 rows of the two panels.
  const counts = (panel) => {
    const at = new Map(
        [
          ...panel.matchAll(
            /<text x="[\d.]+" y="([\d.]+)" text-anchor="end">([^<]*)<\/text>/g,
          ),
        ].map((m) => [m[2], Number(m[1])]),
      ),
      unit = (at.get("0") - at.get("20")) / 20;
    return [
      ...panel.matchAll(
        /height="([\d.]+)" fill="#[0-9a-f]+" fill-opacity="0.75"/g,
      ),
    ].map((m) => Math.round(Number(m[1]) / unit));
  };
  const bars = panels(
    graph(s, "histogram wage, by(fem2, total) frequency").svg,
  ).map(counts);
  assert.deepEqual(bars, [
    [
      2, 8, 25, 16, 30, 29, 33, 26, 18, 21, 13, 14, 13, 14, 7, 4, 3, 1, 2, 3, 2,
      1, 0, 1,
    ],
    [
      5, 15, 19, 31, 30, 32, 23, 22, 18, 11, 14, 9, 9, 7, 7, 3, 3, 0, 0, 0, 0,
      3, 0, 0,
    ],
    [
      7, 23, 44, 47, 60, 61, 56, 48, 36, 32, 27, 23, 22, 21, 14, 7, 6, 1, 2, 3,
      2, 4, 0, 1,
    ],
  ]);
});

test("a by-group with nothing to draw still gets its panel", () => {
  const s = labor(
    'label define fl 0 "Male" 1 "Female"\nlabel values female fl\ngen y2 = wage if female==0',
  );
  // Stata: two panels, titled Male and Female, the second empty.
  const scatter = graph(s, "scatter y2 educ, by(female)");
  assert.equal(panels(scatter.svg).length, 2);
  assert.ok(texts(panels(scatter.svg)[1]).includes("Female"));
  assert.equal(circles(panels(scatter.svg)[1]), 0);
  assert.equal(panels(graph(s, "histogram y2, by(female)").svg).length, 2);
  // An empty panel draws the common axes; Stata labels both panels' y axes
  // 0 20 40 60 and x axes 5 10 15 20. A plot's own if leaves the panels as
  // they are: Stata draws both panels here.
  assert.equal(
    panels(
      graph(
        s,
        "twoway (scatter wage educ if female==0) (scatter hours educ if female==0), by(female)",
      ).svg,
    ).length,
    2,
  );
  // With one plot its if is the graph's: Stata draws only the panel 0, and
  // an if that keeps rows whose y is missing draws that panel empty.
  assert.equal(
    panels(graph(s, "scatter wage educ if female==0, by(female)").svg).length,
    1,
  );
  assert.equal(
    panels(graph(s, "scatter y2 educ if female==1, by(female)").svg).length,
    1,
  );
  // Nothing in the sample at all: Stata stops with "nothing to graph".
  const nothing = s.run("scatter wage educ if wage<0, by(female)");
  assert.equal(nothing.rc, 198);
  assert.match(nothing.output.at(-1).lines.join("\n"), /nothing to graph/);
});

test("an empty by-panel with lfit leaves the other panels drawn", () => {
  const s = labor("gen y2 = wage if female==0");
  const g = graph(s, "twoway (scatter y2 educ) (lfit y2 educ), by(female)");
  // Stata notes once, for the empty panel, and draws both panels with
  // labelled axes; the 302 markers are all in panel 0.
  assert.deepEqual(g.lines, ["(note:  regress could not fit model)"]);
  assert.doesNotMatch(g.svg, /NaN|Infinity/);
  const [male, female] = panels(g.svg);
  assert.equal(circles(male), 302);
  assert.equal(circles(female), 0);
  for (const panel of [male, female]) {
    assert.ok(yLabels(panel).length > 0);
    assert.ok(xLabels(panel).includes("10"));
  }
  // Three empty panels, three notes, as in Stata.
  const regions = graph(
    labor('gen y3 = wage if region=="East"'),
    "twoway (scatter y3 educ) (lfit y3 educ), by(region)",
  );
  assert.equal(regions.lines.length, 3);
});

test("twoway by() sorts on the by-variable before in and _n", () => {
  const s = labor();
  // Stata: one panel, 0, with 49 markers (98 circles), for both; 21 for
  // 300/320.
  for (const command of [
    "scatter wage educ in 1/50, by(union)",
    "scatter wage educ if inrange(_n,1,50), by(union)",
  ]) {
    const g = graph(s, command);
    assert.equal(panels(g.svg).length, 1, command);
    assert.equal(circles(g.svg), 49, command);
  }
  assert.equal(
    circles(graph(s, "scatter wage educ in 300/320, by(union)").svg),
    21,
  );
  // The sort is stable: Stata labels these markers with these ids.
  const ids = (command) =>
    markerLabels(graph(s, command).svg).sort((a, b) => a - b);
  assert.deepEqual(ids("scatter wage educ in 1/10, by(union) mlabel(id)"), [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "8",
    "10",
    "14",
  ]);
  assert.deepEqual(ids("scatter wage educ in 1/10, by(region) mlabel(id)"), [
    "5",
    "14",
    "19",
    "23",
    "38",
    "51",
    "52",
    "58",
    "59",
  ]);
  // The data are left in their order.
  assert.deepEqual(
    labor()
      .run("list id in 1/3")
      .output.flatMap((o) => o.lines),
    s.run("list id in 1/3").output.flatMap((o) => o.lines),
  );
  // histogram, by() does not sort: Stata draws panels 0 and 1.
  assert.equal(
    panels(graph(s, "histogram wage in 300/320, by(union)").svg).length,
    2,
  );
});

test("title(), subtitle(), note() and caption() go in every panel", () => {
  const s = labor();
  const count = (svg, text) => texts(svg).filter((t) => t === text).length;
  // Stata's SVG text: T | T with the panel names kept.
  let svg = graph(s, "scatter wage educ, by(female) title(T)").svg;
  assert.equal(count(svg, "T"), 2);
  assert.equal(count(svg, "0") >= 1 && count(svg, "1") >= 1, true);
  // S | S | T | T, with S in place of the panel names.
  svg = graph(s, "scatter wage educ, by(female) title(T) subtitle(S)").svg;
  assert.equal(count(svg, "S"), 2);
  assert.equal(count(svg, "T"), 2);
  for (const panel of panels(svg)) assert.ok(!texts(panel).includes("1"));
  // N | N and C | C, with Graphs by Female kept.
  svg = graph(s, "scatter wage educ, by(female) note(N) caption(C)").svg;
  assert.equal(count(svg, "N"), 2);
  assert.equal(count(svg, "C"), 2);
  assert.equal(count(svg, "Graphs by Female"), 1);
  // by()'s own: one Overall, and note() replaces Graphs by.
  svg = graph(s, "scatter wage educ, by(female, title(Overall))").svg;
  assert.equal(count(svg, "Overall"), 1);
  assert.equal(count(svg, "Graphs by Female"), 1);
  svg = graph(s, "scatter wage educ, by(female, note(N))").svg;
  assert.equal(count(svg, "N"), 1);
  assert.equal(count(svg, "Graphs by Female"), 0);
  svg = graph(
    s,
    "scatter wage educ, by(female, title(Overall) subtitle(Sub) caption(Cap))",
  ).svg;
  for (const text of ["Overall", "Sub", "Cap", "Graphs by Female"])
    assert.equal(count(svg, text), 1, text);
  // histogram: Wages | Wages.
  svg = graph(s, "histogram wage, by(female) title(Wages)").svg;
  assert.equal(count(svg, "Wages"), 2);
});

test("a title's suboptions are not printed as its text", () => {
  const s = labor();
  // Stata draws Main, and "Wages, 1990" whole.
  let svg = graph(s, "scatter wage educ, title(Main, size(large))").svg;
  assert.ok(texts(svg).includes("Main"));
  assert.ok(!texts(svg).some((t) => /size/.test(t)));
  assert.match(svg, /font-size="16">Main</);
  svg = graph(s, "scatter wage educ, title(Main, size(vlarge) color(red))").svg;
  assert.match(svg, /font-size="19" fill="#ff0000">Main</);
  svg = graph(s, 'scatter wage educ, title("Wages, 1990")').svg;
  assert.ok(texts(svg).includes("Wages, 1990"));
  // Stata accepts box and size(5); this page does not draw them and says so.
  assert.equal(s.run("scatter wage educ, title(Main, box)").rc, 198);
  assert.equal(s.run("scatter wage educ, title(Main, size(5))").rc, 198);
  // Stata draws "a" "b" as two lines, which this page does not.
  assert.equal(s.run('scatter wage educ, title("a" "b")').rc, 198);
  // Every graph draws them: Stata draws kdensity's K too (rc 0).
  svg = graph(s, "kdensity wage, title(K, size(large))").svg;
  assert.match(svg, /font-size="16">K</);
});

test('xtitle("") and ytitle("") remove the axis titles', () => {
  const s = labor();
  // Stata's SVG text is only the tick labels.
  for (const command of [
    'scatter wage educ, xtitle("") ytitle("")',
    'histogram wage, xtitle("") ytitle("")',
  ]) {
    const all = texts(graph(s, command).svg);
    assert.ok(
      all.every((t) => /^[\d.]+$/.test(t)),
      command,
    );
  }
  // With by(), only Graphs by Female is left beside the panels.
  const svg = graph(
    s,
    'scatter wage educ, by(female) xtitle("") ytitle("")',
  ).svg;
  const outside = svg.replace(/<svg x=[\s\S]*?<\/svg>/g, "");
  assert.deepEqual(texts(outside), ["Graphs by Female"]);
});

test("the description counts the points the by() panels draw", () => {
  const s = labor(
    'gen str5 reg2 = region\nreplace reg2 = "" in 1/50\ngen fem2 = female\nreplace fem2 = . in 1/40',
  );
  // Stata draws 537 and 547 markers (1074 and 1094 circles).
  let g = graph(s, "scatter wage educ, by(reg2)");
  assert.equal(circles(g.svg), 537);
  assert.match(g.description, /, 537 points, in 4 panels by reg2\./);
  g = graph(s, "scatter wage educ, by(fem2)");
  assert.equal(circles(g.svg), 547);
  assert.match(g.description, /, 547 points, in 2 panels by fem2\./);
});

test("mlabel() writes the value in the variable's display format", () => {
  const s = labor("gen double w2 = wage/3\ngen w4 = wage if _n!=2");
  const labels = (command) => markerLabels(graph(s, command).svg);
  // Stata, under %10.0g and then %6.2f.
  let all = labels("scatter w2 educ in 1/5, mlabel(w2)");
  assert.deepEqual(all, ["2.7433333", "5.57", "14.34", "5.8133333", "3.98"]);
  assert.equal(s.run("format w2 %6.2f").rc, 0);
  all = labels("scatter w2 educ in 1/5, mlabel(w2)");
  assert.deepEqual(all, ["2.74", "5.57", "14.34", "5.81", "3.98"]);
  // A double in %10.0g, a string, and a missing value (Stata: 8.23 . 43.02).
  all = labels("scatter wage educ in 1/5, mlabel(wage)");
  assert.deepEqual(all, ["8.23", "16.71", "43.02", "17.44", "11.94"]);
  assert.deepEqual(labels("scatter wage educ in 1/3, mlabel(region)"), [
    "West",
    "West",
    "North",
  ]);
  assert.deepEqual(labels("scatter educ hours in 1/3, mlabel(w4)"), [
    "8.23",
    ".",
    "43.02",
  ]);
});

// The second round of findings, 13 November 2026. Expected values recorded
// from Stata 19 MP (version 17, set processors 1) on the same labor data,
// read from the SVG of graph export; the printed notes are also compared in
// tools/output-cases.txt (case graph-panels-fits).
// A panel's name, its subtitle: the text centred at the top of the panel.
const panelNames = (svg) =>
  panels(svg).map(
    (panel) =>
      /<text x="320" y="24" text-anchor="middle"[^>]*>([^<]*)</.exec(
        panel,
      )?.[1] ?? null,
  );
const printed = (out) => out.output.flatMap((o) => o.lines ?? []);

test("a by() panel whose fit cannot be made is left out", () => {
  const s = labor("gen g = (id==5)");
  // Stata draws only panel 0, with axes, and prints nothing for kdensity.
  let g = graph(s, "twoway kdensity wage, by(g)");
  assert.deepEqual(panelNames(g.svg), ["0"]);
  assert.deepEqual(g.lines, []);
  assert.doesNotMatch(g.svg, /NaN|Infinity/);
  assert.ok(yLabels(g.svg).length > 0);
  // 585 markers: the g==1 point is left out with its panel.
  g = graph(s, "twoway (kdensity wage) (scatter wage educ), by(g)");
  assert.equal(circles(g.svg), 585);
  assert.deepEqual(panelNames(g.svg), ["0"]);
  assert.doesNotMatch(g.svg, /NaN|Infinity/);
  // East has one wage among id<=8: Stata draws North and West.
  g = graph(s, "twoway kdensity wage if id<=8, by(region)");
  assert.deepEqual(panelNames(g.svg), ["North", "West"]);
  // lfit and lfitci say why, and draw panel 0 alone.
  const why = [
    "(note:  regress could not fit model)",
    "insufficient observations",
  ];
  for (const fit of ["lfit", "lfitci"]) {
    g = graph(s, `twoway (scatter wage educ) (${fit} wage educ), by(g)`);
    assert.deepEqual(g.lines, why, fit);
    assert.equal(circles(g.svg), 585, fit);
    assert.deepEqual(panelNames(g.svg), ["0"], fit);
  }
  g = graph(
    s,
    "twoway (scatter wage educ) (lfitci wage educ) if id<=8, by(region)",
  );
  assert.deepEqual(g.lines, why);
  assert.deepEqual(panelNames(g.svg), ["North", "West"]);
  // qfit of one observation is drawn empty: all three panels, one note.
  g = graph(
    s,
    "twoway (scatter wage educ) (qfit wage educ) if id<=8, by(region)",
  );
  assert.deepEqual(g.lines, why.slice(0, 1));
  assert.deepEqual(panelNames(g.svg), ["East", "North", "West"]);
  // Stata's East panel reaches x = 10, the schooling of id 7, whose wage
  // is missing: the axes span each variable over the plot's rows.
  assert.ok(xLabels(panels(g.svg)[0]).includes("10"));
  // No panel left: nothing to graph, r(198); without by(), r(2001).
  let out = s.run(
    "twoway (scatter wage educ) (lfit wage educ) if id==1, by(region)",
  );
  assert.equal(out.rc, 198);
  assert.deepEqual(printed(out).slice(0, 3), [...why, "nothing to graph"]);
  out = s.run("twoway (scatter wage educ) (lfit wage educ) if id==1");
  assert.equal(out.rc, 2001);
  assert.deepEqual(printed(out).slice(0, 2), why);
});

test("a fit of x with too few values is made at a lower degree", () => {
  const s = labor("gen x2 = cond(educ<14, 12, 16)");
  // Stata draws these without a note: qfit of two x values is a line.
  for (const command of [
    "twoway (scatter wage x2) (qfit wage x2)",
    "twoway (scatter wage x2) (qfitci wage x2)",
    "twoway (scatter wage educ) (lfitci wage educ) if educ==12",
  ]) {
    const g = graph(s, command);
    assert.deepEqual(g.lines, [], command);
    assert.doesNotMatch(g.svg, /NaN|Infinity/, command);
  }
});

test("a plot after the plots in parentheses needs none of its own", () => {
  const s = labor();
  // Stata: both plots, 586 markers, legend Hourly wage | Fitted values.
  const g = graph(s, "twoway (scatter wage educ) lfit wage educ");
  assert.equal(circles(g.svg), 586);
  assert.equal((g.svg.match(/<polyline/g) ?? []).length, 1);
  assert.deepEqual(texts(g.svg).slice(-2), ["Hourly wage", "Fitted values"]);
  // Its if is its own: every marker is drawn.
  assert.equal(
    circles(
      graph(s, "twoway (scatter wage educ) lfit wage educ if female==0").svg,
    ),
    586,
  );
  // Stata's messages, r(198).
  for (const [command, message] of [
    [
      "twoway (scatter wage educ (lfit wage educ)",
      "parentheses do not balance",
    ],
    [
      "twoway (scatter wage educ) (lfit wage educ) [aw=hours]",
      "[ is not a twoway plot type",
    ],
    [
      "twoway (scatter wage educ) (lfit wage educ))",
      ") is not a twoway plot type",
    ],
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, 198, command);
    assert.equal(printed(out)[0], message, command);
  }
});

test("text options: suboptions without text, empty text, quotes, case", () => {
  const s = labor();
  // xtitle(, …) and ytitle(, …) restyle the titles Stata draws anyway, and
  // ytitle() changes nothing.
  for (const command of [
    "scatter wage educ, ytitle(, size(small))",
    "scatter wage educ, xtitle(, color(red))",
    "scatter wage educ, ytitle() xtitle()",
  ]) {
    const all = texts(graph(s, command).svg);
    assert.ok(all.includes("Hourly wage"), command);
    assert.ok(all.includes("Years of schooling"), command);
  }
  assert.match(
    graph(s, "scatter wage educ, ytitle(, size(small))").svg,
    /font-size="10">Hourly wage</,
  );
  const both = texts(
    graph(
      s,
      'scatter wage educ, xtitle("Schooling", size(small)) ytitle(, size(small))',
    ).svg,
  );
  assert.ok(both.includes("Schooling") && both.includes("Hourly wage"));
  // subtitle("") beside by() removes the panel names; subtitle(, …) and
  // by(, subtitle("")) keep them.
  assert.deepEqual(
    panelNames(graph(s, 'scatter wage educ, by(female) subtitle("")').svg),
    [null, null],
  );
  assert.deepEqual(
    panelNames(
      graph(s, "scatter wage educ, by(female) subtitle(, size(small))").svg,
    ),
    ["0", "1"],
  );
  assert.deepEqual(
    panelNames(graph(s, 'scatter wage educ, by(female, subtitle(""))').svg),
    ["0", "1"],
  );
  // A compound-quoted title keeps its inner quotes: "Hi" there "you".
  assert.ok(
    texts(
      graph(s, 'scatter wage educ, title(`""Hi" there "you""\')').svg,
    ).includes("&quot;Hi&quot; there &quot;you&quot;"),
  );
  // Suboption names are lower case, size() to s() and color() to c().
  const out = s.run('scatter wage educ, title("Main", SIZE(large))');
  assert.equal(out.rc, 198);
  assert.equal(printed(out)[0], "option SIZE() not allowed");
  assert.equal(s.run("scatter wage educ, title(Main, colour(red))").rc, 198);
  assert.match(
    graph(s, "scatter wage educ, title(Main, s(large) c(red))").svg,
    /font-size="16" fill="#ff0000">Main</,
  );
  // graph combine reads its title so: Stata draws Main.
  assert.equal(s.run("scatter wage educ, name(a)").rc, 0);
  assert.equal(s.run("scatter wage hours, name(b)").rc, 0);
  const combined = texts(
    graph(s, "graph combine a b, title(Main, size(large))").svg,
  );
  assert.ok(combined.includes("Main"));
  assert.ok(!combined.some((t) => /size/.test(t)));
});

test('xtitle("") and ytitle("") in kdensity, lowess, graph box and graph bar', () => {
  const s = labor();
  const yTitled = (svg) => /rotate\(-90\)/.test(svg);
  // Stata draws no axis titles in any of these.
  let svg = graph(s, 'kdensity wage, xtitle("") ytitle("")').svg;
  assert.ok(!texts(svg).includes("Hourly wage"));
  assert.ok(!texts(svg).includes("Density"));
  assert.ok(texts(svg).includes("Kernel density estimate"));
  svg = graph(s, 'lowess wage educ, xtitle("") ytitle("")').svg;
  assert.ok(!texts(svg).includes("Years of schooling"));
  assert.ok(!yTitled(svg));
  assert.ok(!yTitled(graph(s, 'graph box wage, ytitle("")').svg));
  assert.ok(
    !yTitled(graph(s, 'graph bar (mean) wage, over(female) ytitle("")').svg),
  );
});

test("an empty twoway graph: its legend and its x axis", () => {
  const s = labor(
    "gen y2 = wage if female==0\ngen e2 = cond(female==1, 40, educ)",
  );
  // Stata: Years of schooling | Hourly wage | wage, the fit not made named
  // by its variable.
  const g = graph(s, "twoway (scatter wage educ) (lfit wage educ) if wage<0");
  assert.deepEqual(texts(g.svg), ["Years of schooling", "Hourly wage", "wage"]);
  // Stata labels the x axis 5 10 15 20 from educ, and the y axis not at all.
  for (const command of [
    "scatter y2 educ if female==1",
    "scatter y2 educ if female==1, by(female)",
  ]) {
    const svg = graph(s, command).svg;
    assert.deepEqual(xLabels(svg), ["5", "10", "15", "20"], command);
    assert.deepEqual(yLabels(svg), [], command);
  }
  // A row whose y is missing still reaches along x: Stata's axis runs to 40.
  assert.equal(xLabels(graph(s, "scatter y2 e2").svg).at(-1), "40");
});
