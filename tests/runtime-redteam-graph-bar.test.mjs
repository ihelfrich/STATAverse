// graph bar and graph hbar against Stata 19: the (percent) statistic, groups
// whose statistic is missing, and the number format of blabel(bar). Every
// expected value below was recorded from Stata 19 MP (version 17, set
// processors 1) by exporting the same graphs with graph export ... .svg and
// reading the bars and text elements of the SVG.
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";
import { Session } from "../src/runtime/session.js";

const labor = (...commands) => {
  const s = createConsoleSession();
  s.reset("labor");
  s.run('gen w3 = wage if region!="West"');
  return commands.map((c) => {
    const result = s.run(c);
    return { result, graph: result.output.at(-1).graph };
  });
};
const texts = (svg) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
// blabel(bar) text is the only text drawn at font-size 10.
const barLabels = (svg) =>
  [...svg.matchAll(/<text[^>]*font-size="10"[^>]*>([^<]*)<\/text>/g)].map(
    (m) => m[1],
  );
// The numbers on the axes: text that is not a bar label.
const axisNumbers = (svg) =>
  [...svg.matchAll(/<text(?![^>]*font-size="10")[^>]*>([^<]*)<\/text>/g)]
    .map((m) => m[1])
    .filter((t) => /^-?[\d.]+$/.test(t));
const bars = (svg) => (svg.match(/fill-opacity="0\.75"/g) ?? []).length;

test("graph bar (percent) is each group's share of the nonmissing values", () => {
  const [one, whole, two, mixed] = labor(
    "graph bar (percent) union, over(region) blabel(bar)",
    "graph bar (percent) wage, blabel(bar)",
    "graph bar (percent) w3 hours, over(region) blabel(bar)",
    "graph bar (percent) union (mean) wage, over(region) blabel(bar)",
  );
  for (const r of [one, whole, two, mixed]) assert.equal(r.result.rc, 0);
  // Stata: 24.1667 | 25 | 29.3333 | 21.5, y axis 0 10 20 30.
  assert.deepEqual(barLabels(one.graph.svg), [
    "24.1667",
    "25",
    "29.3333",
    "21.5",
  ]);
  assert.ok(texts(one.graph.svg).includes("percent of union"));
  assert.deepEqual(axisNumbers(one.graph.svg), ["0", "10", "20", "30"]);
  // Stata: one bar of 100 titled "percent of wage", y axis 0 to 100.
  assert.deepEqual(barLabels(whole.graph.svg), ["100"]);
  assert.ok(texts(whole.graph.svg).includes("percent of wage"));
  // Stata: w3 30.9368 32.0261 37.037 0 (no w3 in West, labelled 0);
  // hours 24.1667 25 29.3333 21.5.
  assert.deepEqual(barLabels(two.graph.svg), [
    ...["30.9368", "32.0261", "37.037", "0"],
    ...["24.1667", "25", "29.3333", "21.5"],
  ]);
  assert.deepEqual(barLabels(mixed.graph.svg), [
    ...["24.1667", "25", "29.3333", "21.5"],
    ...["18.7356", "20.742", "17.5365", "19.0166"],
  ]);
});

test("graph hbar (percent) draws the same shares", () => {
  const [h] = labor("graph hbar (percent) w3 hours, over(region) blabel(bar)");
  assert.equal(h.result.rc, 0);
  assert.deepEqual(
    barLabels(h.graph.svg).sort(),
    [
      "30.9368",
      "32.0261",
      "37.037",
      "0",
      "24.1667",
      "25",
      "29.3333",
      "21.5",
    ].sort(),
  );
});

test("a group whose statistic is missing keeps its slot but gets no bar or label", () => {
  const [mean, two, sd, median, minmax] = labor(
    "graph bar (mean) w3, over(region) blabel(bar)",
    "graph bar (mean) w3 hours, over(region) blabel(bar)",
    "graph bar (sd) w3, over(region) blabel(bar)",
    "graph bar (median) w3, over(region) blabel(bar)",
    "graph bar (min) w3 (max) w3, over(region) blabel(bar)",
  );
  // Stata: 18.7356 | 20.742 | 17.5365, three bars, axis labels East North
  // South West.
  assert.deepEqual(barLabels(mean.graph.svg), ["18.7356", "20.742", "17.5365"]);
  assert.equal(bars(mean.graph.svg), 3);
  for (const region of ["East", "North", "South", "West"])
    assert.ok(texts(mean.graph.svg).includes(region));
  // Stata: West shows only its hours bar, 38.0698.
  assert.deepEqual(barLabels(two.graph.svg), [
    ...["18.7356", "20.742", "17.5365"],
    ...["37.8276", "38.3867", "37.9602", "38.0698"],
  ]);
  assert.equal(bars(two.graph.svg), 7);
  assert.deepEqual(barLabels(sd.graph.svg), ["8.44383", "8.90922", "6.97278"]);
  assert.deepEqual(barLabels(median.graph.svg), ["17.315", "18.88", "16.62"]);
  assert.deepEqual(barLabels(minmax.graph.svg), [
    ...["5.06", "6.63", "6.21"],
    ...["49.12", "45.25", "45.5"],
  ]);
  assert.match(mean.graph.description, /West \(no bar\)/);
});

test("count and sum of no values are 0 bars labelled 0", () => {
  const [count, sum] = labor(
    "graph bar (count) w3, over(region) blabel(bar)",
    "graph bar (sum) w3, over(region) blabel(bar)",
  );
  // Stata: 142 | 147 | 170 | 0 and 2660.45 | 3049.07 | 2981.2 | 0.
  assert.deepEqual(barLabels(count.graph.svg), ["142", "147", "170", "0"]);
  assert.deepEqual(barLabels(sum.graph.svg), [
    "2660.45",
    "3049.07",
    "2981.2",
    "0",
  ]);
});

test("over(, sort(1)) puts a group with no bar first", () => {
  const [up, down, hbar] = labor(
    "graph bar (mean) w3 hours, over(region, sort(1)) blabel(bar)",
    "graph bar (mean) w3 hours, over(region, sort(1) descending) blabel(bar)",
    "graph hbar (mean) w3 hours, over(region) blabel(bar)",
  );
  const order = (svg) =>
    texts(svg).filter((t) => ["East", "North", "South", "West"].includes(t));
  // Stata: West | South | East | North, and North | East | South | West.
  assert.deepEqual(order(up.graph.svg), ["West", "South", "East", "North"]);
  assert.deepEqual(order(down.graph.svg), ["North", "East", "South", "West"]);
  // Stata's hbar: seven labels, West with only its hours bar.
  assert.deepEqual(
    barLabels(hbar.graph.svg).sort(),
    [
      "18.7356",
      "20.742",
      "17.5365",
      "37.8276",
      "38.3867",
      "37.9602",
      "38.0698",
    ].sort(),
  );
});

test("with every statistic missing Stata draws empty axes from -1 to 1", () => {
  const [sd, west, hwest] = labor(
    "graph bar (sd) wage if _n<=1, blabel(bar)",
    'graph bar (mean) w3 if region=="West", over(region) blabel(bar)',
    'graph hbar (mean) w3 if region=="West", over(region) blabel(bar)',
  );
  for (const r of [sd, west, hwest]) {
    assert.equal(r.result.rc, 0);
    assert.equal(bars(r.graph.svg), 0);
    assert.deepEqual(barLabels(r.graph.svg), []);
    // Stata's only axis labels are -1 and 1.
    assert.deepEqual(axisNumbers(r.graph.svg), ["-1", "1"]);
  }
  assert.ok(texts(west.graph.svg).includes("West"));
  assert.ok(texts(hwest.graph.svg).includes("West"));
});

test("an empty sample is r(2000) no observations, as in Stata", () => {
  for (const command of [
    "graph bar (mean) wage if wage<0, over(region)",
    "graph bar (mean) wage if wage<0",
    "graph bar (percent) wage if wage<0",
    "graph hbar (mean) wage if wage<0, over(region)",
    "graph bar if wage<0, over(region)",
  ]) {
    const [r] = labor(command);
    assert.equal(r.result.rc, 2000, command);
    assert.deepEqual(r.result.output.at(-1).lines, [
      "no observations",
      "r(2000);",
    ]);
  }
});

test("graph bar may open with if or in when it has no yvars", () => {
  const [percent, count] = labor(
    "graph bar if wage>20, over(region) blabel(bar)",
    "graph bar (count) in 1/100, over(region) blabel(bar)",
  );
  // Stata: 23.0769 | 29.4872 | 25.641 | 21.7949 and 15 | 31 | 30 | 24.
  assert.deepEqual(barLabels(percent.graph.svg), [
    ...["23.0769", "29.4872", "25.641", "21.7949"],
  ]);
  assert.deepEqual(barLabels(count.graph.svg), ["15", "31", "30", "24"]);
});

const VALUES = `clear
input double y byte g
18.735559 1
1234567.8 2
123456.78 3
0.000123456 4
0.0123456 5
-2.3456789 6
12345678 7
1e15 8
0.5 9
100 10
-0.000123456 11
99999.95 12
-1234567.8 13
-123456.78 14
-99999.95 15
-12.3456 16
-0.5 17
1234.5678 18
0.00001 19
-0.00001 20
123456.5 21
-123456.5 22
.1234567 23
-.1234567 24
end
`;

test("blabel(bar) writes heights in %8.0g whatever the variable's format", () => {
  // Stata 19, blabel(bar) on each value as its own bar (two runs of twelve).
  const stata = [
    ...["18.7356", "1.2e+06", "123457", ".000123", ".012346", "-2.34568"],
    ...["1.2e+07", "1.0e+15", ".5", "100", "-.000123", "99999.9"],
    ...["-1.2e+06", "-123457", "-99999.9", "-12.3456", "-.5", "1234.57"],
    ...[".00001", "-.00001", "123457", "-123457", ".123457", "-.123457"],
  ];
  // Stata 19 after replace y = y/7 (first twelve), with format y %6.2f.
  const seventh = [
    ...["2.67651", "176367", "17636.7", ".000018", ".001764", "-.335097"],
    ...["1.8e+06", "1.4e+14", ".071429", "14.2857", "-.000018", "14285.7"],
  ];
  const session = new Session(),
    result = session.run(
      VALUES +
        "graph bar (mean) y, over(g) blabel(bar)\n" +
        "graph hbar (mean) y, over(g) blabel(bar)\n" +
        "replace y = y/7\nformat y %6.2f\n" +
        "graph bar (mean) y if g <= 12, over(g) blabel(bar)",
    );
  assert.equal(result.rc, 0);
  const graphs = result.output.filter((o) => o.graph).map((o) => o.graph.svg);
  assert.deepEqual(barLabels(graphs[0]), stata);
  assert.deepEqual(barLabels(graphs[1]), stata);
  assert.deepEqual(barLabels(graphs[2]), seventh);
});

test("with every statistic 0 Stata labels the axis only -1 and 1", () => {
  // Recorded from Stata 19 (graph export .svg) on the same commands.
  const s = createConsoleSession();
  s.reset("labor");
  for (const c of [
    "gen allm = .",
    "gen z = 0",
    'gen w3 = wage if region!="West"',
  ])
    s.run(c);
  const run = (c) => {
    const result = s.run(c);
    assert.equal(result.rc, 0, c);
    return result.output.at(-1).graph.svg;
  };
  const stata = [
    // Stata: bar labels 0 | 0 | 0 | 0, axis -1 | 1.
    ["graph bar (count) allm, over(region) blabel(bar)", ["0", "0", "0", "0"]],
    ['graph bar (count) w3 if region=="West", over(region) blabel(bar)', ["0"]],
    [
      "graph bar (mean) allm (count) allm, over(region) blabel(bar)",
      ["0", "0", "0", "0"],
    ],
    ["graph bar (mean) z, over(region) blabel(bar)", ["0", "0", "0", "0"]],
    ["graph bar (sum) z", []],
    ["graph hbar (count) allm, over(region)", []],
    ["graph hbar (sum) allm, over(region) blabel(bar)", ["0", "0", "0", "0"]],
    ["graph hbar (mean) z", []],
  ];
  for (const [command, labels] of stata) {
    const svg = run(command);
    assert.deepEqual(axisNumbers(svg), ["-1", "1"], command);
    assert.deepEqual(barLabels(svg), labels, command);
  }
  // A series of zeros beside a nonzero one keeps an ordinary axis from 0
  // (Stata: 0 5 10 15 20); the runtime's general tick choice is not what
  // this test checks.
  const mixed = axisNumbers(
    run("graph bar (mean) z (mean) wage, over(region)"),
  );
  assert.equal(mixed[0], "0");
  assert.ok(!mixed.includes("-1"));
});

test("an if may run straight into its parenthesis", () => {
  const [percent, mean, over, count, hbar] = labor(
    "graph bar if(wage>20), over(region) blabel(bar)",
    "graph bar (mean) wage if(wage>20)",
    "graph bar (mean) wage if(wage>20), over(region)",
    "graph bar (count) if(wage>20), over(region)",
    "graph hbar (mean) wage if(wage>20), over(region)",
  );
  for (const r of [percent, mean, over, count, hbar])
    assert.equal(r.result.rc, 0);
  // Stata 19: rc 0, axis 0 10 20 30 titled "percent", with the same shares
  // as graph bar if wage>20.
  assert.deepEqual(barLabels(percent.graph.svg), [
    ...["23.0769", "29.4872", "25.641", "21.7949"],
  ]);
  assert.ok(texts(percent.graph.svg).includes("percent"));
  assert.deepEqual(axisNumbers(percent.graph.svg), ["0", "10", "20", "30"]);
  // Stata 19: one bar, axis 0 10 20 30; over(region) four bars, same axis.
  assert.equal(bars(mean.graph.svg), 1);
  assert.deepEqual(axisNumbers(mean.graph.svg), ["0", "10", "20", "30"]);
  assert.equal(bars(over.graph.svg), 4);
  assert.deepEqual(axisNumbers(over.graph.svg), ["0", "10", "20", "30"]);
  // Stata 19: axis 0 20 40 60 80, titled frequency.
  assert.deepEqual(axisNumbers(count.graph.svg), ["0", "20", "40", "60", "80"]);
  assert.ok(texts(count.graph.svg).includes("frequency"));
  assert.ok(texts(hbar.graph.svg).includes("mean of wage"));
});
