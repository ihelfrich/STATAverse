// graph bar, hbar and box against Stata 19: one bar with no over(), the
// order of the groups under over(g, sort() descending), the percentile
// statistics and the absence of a title under the groups. Every expected
// value below was recorded from Stata 19 MP (version 17, set processors 1)
// by exporting the same graphs with graph export ... .svg and reading the
// text elements of the SVG, or from the error Stata printed.
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";

const session = (setup) => {
  const s = createConsoleSession();
  if (setup) s.run(setup);
  else {
    s.reset("labor");
    s.run('gen w3 = wage if region!="West"');
    s.run(
      'gen double rk = cond(region=="East",3,cond(region=="North",1,cond(region=="South",4,2)))',
    );
  }
  return (command) => {
    const result = s.run(command);
    return { result, graph: result.output.at(-1).graph };
  };
};
const texts = (svg) =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
// blabel(bar) text is the only text drawn at font-size 10.
const barLabels = (svg) =>
  [...svg.matchAll(/<text[^>]*font-size="10"[^>]*>([^<]*)<\/text>/g)].map(
    (m) => m[1],
  );
const axisNumbers = (svg) =>
  [...svg.matchAll(/<text(?![^>]*font-size="10")[^>]*>([^<]*)<\/text>/g)]
    .map((m) => m[1])
    .filter((t) => /^-?[\d.]+$/.test(t));
const among = (svg, names) => texts(svg).filter((t) => names.includes(t));
const REGIONS = ["East", "North", "South", "West"];
const refused = (r, message, rc = 198) => {
  assert.equal(r.result.rc, rc);
  assert.deepEqual(r.result.output.at(-1).lines, [message, `r(${rc});`]);
};

const SMALL = `clear
input byte g double s str3 t double y
1 40 "b" 1
1 0 "a" 2
1 0 "z" 3
1 0 "b" 4
2 5 "c" 5
2 5 "c" 6
3 1 "y" 7
3 1 "y" 8
3 1 "y" 9
3 1 "y" 10
3 16 "a" 11
end
gen double sm = s if g!=2`;
const SECOND = `clear
input byte g double s double y double y2
1 0 1 -1
1 10 2 -3
2 3 3 .
2 3 4 .
3 9 5 2
3 0 6 4
end`;

test("graph bar (count) and (percent) without over() draw one bar", () => {
  const run = session();
  const count = run("graph bar (count), blabel(bar)");
  assert.equal(count.result.rc, 0);
  // Stata: one bar of 600 titled frequency, y labels 0 200 400 600, and no
  // label under the bar.
  assert.deepEqual(barLabels(count.graph.svg), ["600"]);
  assert.deepEqual(
    texts(count.graph.svg).filter((t) => !/^\d+$/.test(t)),
    ["frequency"],
  );
  assert.deepEqual(axisNumbers(count.graph.svg), ["0", "200", "400", "600"]);
  const percent = run("graph bar (percent), blabel(bar)");
  assert.deepEqual(barLabels(percent.graph.svg), ["100"]);
  assert.ok(texts(percent.graph.svg).includes("percent"));
  for (const command of ["graph bar (count)", "graph hbar (count)"]) {
    const r = run(command);
    assert.equal(r.result.rc, 0, command);
    assert.ok(texts(r.graph.svg).includes("frequency"), command);
  }
  // Stata: 75 observations have wage > 30; graph bar if ... is one bar of
  // 100 percent.
  assert.deepEqual(
    barLabels(run("graph bar (count) if wage > 30, blabel(bar)").graph.svg),
    ["75"],
  );
  const plain = run("graph bar if wage > 30");
  assert.equal(plain.result.rc, 0);
  assert.ok(texts(plain.graph.svg).includes("percent"));
  refused(run("graph bar"), "graph specification required");
  refused(run("graph bar (mean)"), "varlist required", 100);
});

test("over(, descending) reverses the groups, with or without sort()", () => {
  const run = session();
  // Stata orders the bars of each command as written in the comments.
  const cases = [
    // West | South | North | East
    ["graph bar (mean) wage, over(region, descending)", [3, 2, 1, 0]],
    ["graph bar (mean) wage, over(region, des)", [3, 2, 1, 0]],
    // A string sort variable leaves the order as it is.
    ["graph bar (mean) wage, over(region, sort(region))", [0, 1, 2, 3]],
    [
      "graph bar (mean) wage, over(region, sort(region) descending)",
      [3, 2, 1, 0],
    ],
    // sort(rk): North | West | East | South, and the reverse.
    ["graph bar (mean) wage, over(region, sort(rk))", [1, 3, 0, 2]],
    ["graph bar (mean) wage, over(region, sort(rk) descending)", [2, 0, 3, 1]],
    // The mean of wage, and of hours: South | East | West | North and
    // East | South | West | North.
    ["graph bar (mean) wage, over(region, sort(wage))", [2, 0, 3, 1]],
    ["graph bar (mean) wage, over(region, sort(hours))", [0, 2, 3, 1]],
    // No w3 in West: its missing mean sorts last.
    ["graph bar (mean) w3, over(region, sort(w3))", [2, 0, 1, 3]],
    ["graph bar (mean) wage, over(region, sort(nosuch))", [0, 1, 2, 3]],
    ["graph bar (count), over(region, descending)", [3, 2, 1, 0]],
    // Counts 145 150 176 129: South | North | East | West.
    ["graph bar (count), over(region, sort(1) descending)", [2, 1, 0, 3]],
    // Mean hours: East | South | West | North.
    ["graph bar (mean) wage hours, over(region, sort(2))", [0, 2, 3, 1]],
    ["graph box wage, over(region, descending)", [3, 2, 1, 0]],
    // Box plots sort on the median: South | West | East | North.
    ["graph box wage hours, over(region, sort(1))", [2, 3, 0, 1]],
    // Every median of hours is 38, so descending reverses the ties.
    ["graph box wage hours, over(region, sort(2) descending)", [3, 2, 1, 0]],
    ["graph box wage, over(region, sort(1) descending)", [1, 0, 3, 2]],
  ];
  for (const [command, order] of cases) {
    const r = run(command);
    assert.equal(r.result.rc, 0, command);
    assert.deepEqual(
      among(r.graph.svg, REGIONS),
      order.map((k) => REGIONS[k]),
      command,
    );
  }
  // Stata: 129 | 176 | 150 | 145 over West | South | North | East.
  assert.deepEqual(
    barLabels(
      run("graph bar (count), over(region, descending) blabel(bar)").graph.svg,
    ),
    ["129", "176", "150", "145"],
  );
  // graph hbar puts the first group at the top: West, with 19.0166.
  const h = run("graph hbar (mean) wage, over(region, descending) blabel(bar)");
  assert.deepEqual(texts(h.graph.svg).slice(-9, -1), [
    ...["West", "19.0166", "South", "17.5365"],
    ...["North", "20.742", "East", "18.7356"],
  ]);
});

test("sort(varname) uses the mean, or the named statistic, of the variable", () => {
  // The group labels, centred under the bars; the y axis numbers are
  // anchored at their end.
  const order = (run, command) => {
    const r = run(command);
    assert.equal(r.result.rc, 0, command);
    return [
      ...r.graph.svg.matchAll(
        /<text[^>]*text-anchor="middle">([123])<\/text>/g,
      ),
    ].map((m) => m[1]);
  };
  const small = session(SMALL);
  // The means of s are 10, 5 and 4; sm has no value in group 2.
  assert.deepEqual(order(small, "graph bar (mean) y, over(g, sort(s))"), [
    "3",
    "2",
    "1",
  ]);
  assert.deepEqual(
    order(small, "graph bar (mean) y, over(g, sort(s) descending)"),
    ["1", "2", "3"],
  );
  assert.deepEqual(order(small, "graph bar (mean) y, over(g, sort(sm))"), [
    "3",
    "1",
    "2",
  ]);
  // A missing key stays last under descending.
  assert.deepEqual(
    order(small, "graph bar (mean) y, over(g, sort(sm) descending)"),
    ["1", "3", "2"],
  );
  // Of a list Stata reads the first word; sort(0) is no sort.
  assert.deepEqual(order(small, "graph bar (mean) y, over(g, sort(s t))"), [
    "3",
    "2",
    "1",
  ]);
  assert.deepEqual(order(small, "graph bar (mean) y, over(g, sort(0))"), [
    "1",
    "2",
    "3",
  ]);
  const second = session(SECOND);
  // Means of s 5, 3, 4.5 against first values 0, 3, 9: Stata uses the mean.
  assert.deepEqual(order(second, "graph bar (mean) y, over(g, sort(s))"), [
    "2",
    "3",
    "1",
  ]);
  // max of s 10, 3, 9; median 5, 3, 4.5.
  assert.deepEqual(
    order(second, "graph bar (mean) y, over(g, sort((max) s))"),
    ["2", "3", "1"],
  );
  assert.deepEqual(
    order(second, "graph bar (mean) y, over(g, sort((median) s) descending)"),
    ["1", "3", "2"],
  );
  // A group with no bar counts as 0 under sort(#): means -2, none and 3.
  assert.deepEqual(order(second, "graph bar (mean) y2, over(g, sort(1))"), [
    "1",
    "2",
    "3",
  ]);
  assert.deepEqual(
    order(second, "graph bar (mean) y2, over(g, sort(1) descending)"),
    ["3", "2", "1"],
  );
  // Counts 2, 0 and 2.
  assert.deepEqual(order(second, "graph bar (count) y2, over(g, sort(1))"), [
    "2",
    "1",
    "3",
  ]);
  refused(
    second("graph bar (mean) y, over(g, sort((foo) s))"),
    "(foo) invalid statistic",
  );
  refused(second("graph box y, over(g, sort((max) s))"), "invalid syntax");
  refused(
    small("graph bar (mean) y, over(g, sort(2))"),
    "sort() invalid, category 2 not found",
  );
  refused(
    small("graph bar (mean) y, over(g, sort(s) sort(1))"),
    "option sort() not allowed",
  );
  refused(
    small("graph bar (mean) y, over(g, descending descending)"),
    "option descending not allowed",
  );
  refused(
    session()("graph box wage, over(region, sort(3))"),
    "sort() invalid, category 3 not found",
  );
});

test("graph bar draws (median) and (p1) to (p99), titled p #", () => {
  const run = session();
  const two = run(
    "graph bar (median) wage (p75) wage, over(union) blabel(bar)",
  );
  assert.equal(two.result.rc, 0);
  // Stata: 16.68 | 18.87 for p 50 and 22.5 | 26.75 for p 75.
  assert.deepEqual(barLabels(two.graph.svg), [
    "16.68",
    "18.87",
    "22.5",
    "26.75",
  ]);
  assert.ok(texts(two.graph.svg).includes("p 50 of wage"));
  assert.ok(texts(two.graph.svg).includes("p 75 of wage"));
  for (const command of [
    "graph bar (p50) wage, over(union) blabel(bar)",
    "graph bar (median) wage, over(union) blabel(bar)",
  ]) {
    const r = run(command);
    assert.deepEqual(barLabels(r.graph.svg), ["16.68", "18.87"], command);
    assert.ok(texts(r.graph.svg).includes("p 50 of wage"), command);
    assert.ok(!texts(r.graph.svg).includes("median of wage"), command);
  }
  const three = run(
    "graph bar (p1) wage (p99) w3 (p25) hours, over(region) blabel(bar)",
  );
  assert.deepEqual(barLabels(three.graph.svg), [
    ...["5.33", "7.36", "6.82", "7.07"],
    ...["46.03", "44.96", "39.36"],
    ...["33", "34", "33", "33"],
  ]);
  for (const title of ["p 1 of wage", "p 99 of w3", "p 25 of hours"])
    assert.ok(texts(three.graph.svg).includes(title));
  assert.deepEqual(
    barLabels(
      run(
        "graph bar (median) wage (p75) wage (p25) wage, over(region) blabel(bar)",
      ).graph.svg,
    ),
    [
      ...["17.315", "18.88", "16.62", "16.93"],
      ...["22.56", "26.23", "22.34", "25.17"],
      ...["13.02", "14.28", "12.08", "12.36"],
    ],
  );
  assert.deepEqual(
    barLabels(run("graph bar (p7) wage, blabel(bar)").graph.svg),
    ["9.03"],
  );
  assert.deepEqual(
    barLabels(
      run("graph bar (p33) hours (p66) hours, over(female) blabel(bar)").graph
        .svg,
    ),
    ["37", "33", "42", "39"],
  );
  const h = run(
    "graph hbar (median) wage (p90) wage (p10) wage, over(union) blabel(bar)",
  );
  assert.deepEqual(
    barLabels(h.graph.svg).sort(),
    ["16.68", "29.48", "9.37", "18.87", "32.1", "11.13"].sort(),
  );
  assert.ok(texts(h.graph.svg).includes("p 90 of wage"));
  for (const [command, message] of [
    ["graph bar (p0) wage", "(0) invalid statistic"],
    ["graph bar (p100) wage", "(100) invalid statistic"],
    ["graph bar (p) wage", "() invalid statistic"],
    ["graph bar (p5x) wage", "(5x) invalid statistic"],
    ["graph bar (P50) wage", "(P50) invalid statistic"],
    ["graph bar (MEDIAN) wage", "(MEDIAN) invalid statistic"],
    ["graph bar (foo) wage", "(foo) invalid statistic"],
  ])
    refused(run(command), message);
});

test("graph bar, hbar and box draw no title under the groups", () => {
  const run = session();
  // Stata: the SVG text is the axis numbers, the groups and the y title.
  const count = run("graph bar (count), over(region)");
  assert.deepEqual(
    texts(count.graph.svg).filter((t) => !/^\d+$/.test(t)),
    [...REGIONS, "frequency"],
  );
  const two = run("graph bar (mean) wage hours, over(female) blabel(bar)");
  assert.ok(!texts(two.graph.svg).includes("Female"));
  for (const command of [
    "graph hbar (count), over(region)",
    "graph bar (mean) wage, over(union)",
    "graph hbar (mean) wage, over(union)",
    "graph box wage, over(union)",
  ]) {
    const t = texts(run(command).graph.svg);
    for (const title of ["Region", "In a union"])
      assert.ok(!t.includes(title), `${command}: ${title}`);
  }
});
