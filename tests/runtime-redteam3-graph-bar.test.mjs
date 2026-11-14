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

// The cases below follow a second review of the fixes above. Their expected
// values were also recorded from Stata 19 MP (version 17, set processors 1)
// with graph export ... .svg, on the labor data with w3 and rk as above.

test("sort(varname) with no yvars is the error collapse gives", () => {
  const run = session();
  // Stata passes the sort as (mean) _sort=varname after the lone (count)
  // or (percent), and collapse reads that statistic as a variable name.
  for (const [command, name] of [
    ["graph bar (count), over(region, sort(wage)) blabel(bar)", "mean"],
    ["graph bar (percent), over(region, sort(rk)) blabel(bar)", "mean"],
    ["graph bar (count), over(region, sort((count) wage))", "count"],
    ["graph bar (percent), over(region, sort((sum) hours))", "sum"],
    ["graph bar, over(region, sort(hours)) blabel(bar)", "mean"],
    ["graph bar (count), over(union, sort(union))", "mean"],
    ["graph bar (count), over(region, sort((mean) wage))", "mean"],
    ["graph bar (count), over(region, sort((median) wage))", "median"],
    ["graph bar (count), over(region, sort((foo) wage))", "foo"],
    ["graph bar (count), over(region, sort((mean) hours rk))", "mean"],
  ])
    refused(run(command), `variable ${name} not found`, 111);
  // A string or unknown sort variable, sort(0) and sort(#) still draw:
  // 145 | 150 | 176 | 129, and by count West | East | North | South.
  for (const command of [
    "graph bar (count), over(region, sort(region)) blabel(bar)",
    "graph bar (count), over(region, sort(nosuch)) blabel(bar)",
    "graph bar (count), over(region, sort(0)) blabel(bar)",
  ]) {
    const r = run(command);
    assert.equal(r.result.rc, 0, command);
    assert.deepEqual(barLabels(r.graph.svg), ["145", "150", "176", "129"]);
    assert.deepEqual(among(r.graph.svg, REGIONS), REGIONS, command);
  }
  const counted = run("graph bar (count), over(region, sort(1)) blabel(bar)");
  assert.deepEqual(barLabels(counted.graph.svg), ["129", "145", "150", "176"]);
  assert.deepEqual(among(counted.graph.svg, REGIONS), [
    ...["West", "East", "North", "South"],
  ]);
});

test("sort() on the over() variable, or on a yvar, fails as in Stata", () => {
  const run = session();
  for (const command of [
    "graph bar (mean) wage, over(union, sort(union)) blabel(bar)",
    "graph bar (mean) wage, over(union, sort((max) union)) blabel(bar)",
    "graph bar (mean) wage, over(union, sort(union) descending)",
    "graph bar (mean) wage, over(union, sort((sd) union))",
    "graph bar (mean) wage, over(female, sort(female) descending) blabel(bar)",
    "graph bar (mean) wage, over(union, sort((mean) union hours))",
  ])
    refused(run(command), "failed to setup collapse problem");
  refused(
    run("graph bar (mean) wage, over(union, sort((mean) hours union))"),
    "union may not be both target and by()",
  );
  refused(
    run("graph bar (mean) union, over(union) blabel(bar)"),
    "union may not be both target and by()",
  );
  // A yvar named again in sort((stat) varlist) with another statistic.
  for (const command of [
    "graph bar (mean) wage, over(region, sort((max) hours wage)) blabel(bar)",
    "graph bar (mean) wage hours, over(region, sort((max) hours wage))",
    "graph bar (sum) wage, over(region, sort((max) hours wage)) blabel(bar)",
  ])
    refused(run(command), "serset variable 4 not found", 111);
  // With the same statistic Stata leaves that yvar out: only mean of wage,
  // North | West | East | South, as sort(rk).
  const left = run(
    "graph bar (mean) wage hours, over(region, sort((mean) rk hours)) blabel(bar)",
  );
  assert.equal(left.result.rc, 0);
  assert.deepEqual(barLabels(left.graph.svg), [
    ...["20.742", "19.0166", "18.7356", "17.5365"],
  ]);
  assert.ok(!texts(left.graph.svg).includes("mean of hours"));
  // Stata then draws an empty graph when no yvar is left; it is refused.
  const empty = run(
    "graph bar (mean) wage, over(region, sort((mean) hours wage))",
  );
  assert.equal(empty.result.rc, 198);
});

test("sort((stat) v1 v2 ...) sorts on the statistic of v1", () => {
  const run = session();
  for (const [command, order, bars] of [
    [
      "graph bar (mean) wage, over(region, sort((mean) hours rk)) blabel(bar)",
      ["East", "South", "West", "North"],
      ["18.7356", "17.5365", "19.0166", "20.742"],
    ],
    [
      "graph bar (mean) wage, over(region, sort((mean) rk hours)) blabel(bar)",
      ["North", "West", "East", "South"],
      ["20.742", "19.0166", "18.7356", "17.5365"],
    ],
    [
      "graph bar (mean) wage, over(region, sort((median) w3 hours)) blabel(bar)",
      ["South", "East", "North", "West"],
      ["17.5365", "18.7356", "20.742", "19.0166"],
    ],
    [
      "graph bar (mean) hours, over(region, sort((sd) wage rk)) blabel(bar)",
      ["South", "West", "East", "North"],
      ["37.9602", "38.0698", "37.8276", "38.3867"],
    ],
    [
      "graph bar (mean) wage, over(region, sort((median) wage hours)) blabel(bar)",
      ["South", "West", "East", "North"],
      ["17.5365", "19.0166", "18.7356", "20.742"],
    ],
    [
      "graph bar (mean) wage, over(region, sort(wage hours)) blabel(bar)",
      ["South", "East", "West", "North"],
      ["17.5365", "18.7356", "19.0166", "20.742"],
    ],
    // A string or unknown name in the list leaves the order as it is.
    [
      "graph bar (mean) wage, over(region, sort((mean) hours region)) blabel(bar)",
      REGIONS,
      ["18.7356", "20.742", "17.5365", "19.0166"],
    ],
    [
      "graph bar (mean) wage, over(region, sort((mean) hours nosuch)) blabel(bar)",
      REGIONS,
      ["18.7356", "20.742", "17.5365", "19.0166"],
    ],
  ]) {
    const r = run(command);
    assert.equal(r.result.rc, 0, command);
    assert.deepEqual(among(r.graph.svg, REGIONS), order, command);
    assert.deepEqual(barLabels(r.graph.svg), bars, command);
  }
});

test("percentiles keep their digits, and a statistic is drawn once", () => {
  const run = session();
  for (const [command, title] of [
    ["graph bar (p05) wage, over(union) blabel(bar)", "p 05 of wage"],
    ["graph bar (p005) wage, over(union) blabel(bar)", "p 005 of wage"],
    ["graph bar ( p05 ) wage, over(union) blabel(bar)", "p 05 of wage"],
  ]) {
    const r = run(command);
    assert.deepEqual(barLabels(r.graph.svg), ["8.05", "9.43"], command);
    assert.ok(texts(r.graph.svg).includes(title), command);
    assert.ok(!texts(r.graph.svg).includes("p 5 of wage"), command);
  }
  const titles = (svg) => texts(svg).filter((t) => / of /.test(t));
  for (const [command, bars, names] of [
    // (p05) and (p5) are two series in Stata.
    [
      "graph bar (p05) wage (p5) wage, over(union) blabel(bar)",
      ["8.05", "9.43", "8.05", "9.43"],
      ["p 05 of wage", "p 5 of wage"],
    ],
    [
      "graph bar (p50) wage (median) wage, over(union) blabel(bar)",
      ["16.68", "18.87"],
      ["p 50 of wage"],
    ],
    [
      "graph bar (median) wage (p50) wage hours, over(union) blabel(bar)",
      ["16.68", "18.87", "38", "39"],
      ["p 50 of wage", "p 50 of hours"],
    ],
    [
      "graph bar (mean) wage wage, over(union) blabel(bar)",
      ["18.0297", "20.6031"],
      ["mean of wage"],
    ],
    [
      "graph bar (mean) wage hours wage, over(union) blabel(bar)",
      ["18.0297", "20.6031", "37.7778", "38.5681"],
      ["mean of wage", "mean of hours"],
    ],
    [
      "graph bar (count) wage (count) wage, over(union) blabel(bar)",
      ["376", "210"],
      ["count of wage"],
    ],
    [
      "graph bar (percent) wage (percent) wage, over(union) blabel(bar)",
      ["64.1638", "35.8362"],
      ["percent of wage"],
    ],
  ]) {
    const r = run(command);
    assert.equal(r.result.rc, 0, command);
    assert.deepEqual(barLabels(r.graph.svg), bars, command);
    assert.deepEqual(titles(r.graph.svg), names, command);
  }
  // sort(#) counts each series once: by the mean of hours, East | South |
  // West | North.
  const sorted = run(
    "graph bar (mean) wage (mean) wage hours, over(region, sort(2)) blabel(bar)",
  );
  assert.deepEqual(among(sorted.graph.svg, REGIONS), [
    ...["East", "South", "West", "North"],
  ]);
  assert.deepEqual(barLabels(sorted.graph.svg).slice(4), [
    ...["37.8276", "37.9602", "38.0698", "38.3867"],
  ]);
});

test("statistics without variables and malformed arguments give Stata's errors", () => {
  const run = session();
  for (const [command, message, rc] of [
    ["graph bar (mean) wage (p50), over(union)", "varlist required", 100],
    ["graph bar (mean) wage (sum), over(union)", "varlist required", 100],
    [
      "graph bar (count) (sum) wage, over(union)",
      "variable sum not found",
      111,
    ],
    ["graph bar (count) (percent)", "variable percent not found", 111],
    ["graph bar (mean) (sum) wage, over(union)", "variable sum not found", 111],
    [
      "graph bar (mean) wage (count) (sum) hours, over(union)",
      "variable sum not found",
      111,
    ],
    [
      "graph bar (mean) wage (count) (foo) hours, over(union)",
      "variable foo not found",
      111,
    ],
    ["graph bar (mean) wage (foo)", "(foo) invalid statistic", 198],
    ["graph bar (p 50) wage, over(union)", "(p 50) invalid statistic", 198],
    ["graph bar (p 05) wage, over(union)", "(p 05) invalid statistic", 198],
    ["graph bar ( foo ) wage, over(union)", "(foo) invalid statistic", 198],
    ["graph bar (p50.5) wage", "(50.5) invalid statistic", 198],
    ["graph bar (p-1) wage", "(-1) invalid statistic", 198],
    ["graph bar (p5.0) wage", "(5.0) invalid statistic", 198],
    ["graph bar (p1e1) wage, over(union)", "(1e1) invalid statistic", 198],
    [
      "graph bar (mean) wage, over(region, sort(1e1))",
      "sort() invalid, category 1e1 not found",
      198,
    ],
    [
      "graph bar (mean) wage, over(region, sort(2.0))",
      "sort() invalid, category 2.0 not found",
      198,
    ],
    [
      "graph bar (mean) wage, over(region, DESCENDING)",
      "option DESCENDING not allowed",
      198,
    ],
    [
      "graph bar (mean) wage, over(region, Desc)",
      "option Desc not allowed",
      198,
    ],
    [
      "graph bar (mean) wage, over(region, SORT(1))",
      "option SORT() not allowed",
      198,
    ],
    [
      "graph bar (mean) wage, over(region, Sort(1))",
      "option Sort() not allowed",
      198,
    ],
  ])
    refused(run(command), message, rc);
  // sort(#) may be written as numlist allows: South | East | West | North.
  for (const command of [
    "graph bar (mean) wage, over(region, sort(1e0))",
    "graph bar (mean) wage, over(region, sort(+1))",
    "graph bar (mean) wage, over(region, sort(01))",
  ]) {
    const r = run(command);
    assert.equal(r.result.rc, 0, command);
    assert.deepEqual(among(r.graph.svg, REGIONS), [
      ...["South", "East", "West", "North"],
    ]);
  }
  // sort(1.5) names no statistic and no variable, so there is no sort.
  assert.deepEqual(
    among(
      run("graph bar (mean) wage, over(region, sort(1.5))").graph.svg,
      REGIONS,
    ),
    REGIONS,
  );
  // Stata accepts these but they are not drawn here, so they are refused
  // by name: (sem) is collapse's semean, and Stata draws (p+5) as zeros.
  for (const command of [
    "graph bar (sem) wage, over(union)",
    "graph bar (p+5) wage, over(union)",
  ]) {
    const r = run(command);
    assert.equal(r.result.rc, 198, command);
    assert.match(r.result.output.at(-1).lines[0], /not drawn on this page/);
  }
});
