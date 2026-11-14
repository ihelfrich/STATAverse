// margins over a factor with several at() settings, on the labor data.
// Expected values were recorded from Stata 19 MP (version 17, set
// processors 1) run on the same data, exported from the runtime with
// exportData(). The printed tables are compared line by line in
// tests/runtime-output.test.mjs (case margins-factor-at-list); this file
// checks what text cannot: r(b), r(V) and the marginsplot graph.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

function session() {
  const s = createConsoleSession();
  s.reset("labor");
  return s;
}
const text = (result) =>
  result.output
    .flatMap((o) => o.lines ?? [])
    .join("\n")
    .trim();
// The column names matrix list prints, and one element at full precision.
// As Stata does, it heads each name through its last # on one line and
// the rest on the next.
const names = (s, matrix) => {
  const listed = text(s.run(`matrix list ${matrix}`)).split("\n");
  return listed.flatMap((line, at) => {
    if (!line.includes("._at#")) return [];
    const [first, second] = [line, listed[at + 1]].map((one) =>
      one.trim().split(/\s+/),
    );
    return first.map((part, k) => `${part}${second[k]}`);
  });
};
const element = (s, expression) =>
  Number(text(s.run(`display %21.0g ${expression}`)));
const close = (ours, theirs, what) =>
  assert.ok(
    Math.abs(ours - theirs) <= 1e-12 * Math.abs(theirs),
    `${what}: ${ours} vs Stata ${theirs}`,
  );

test("margins of a factor at each at() setting keeps every setting in r(b) and r(V)", () => {
  const s = session();
  assert.equal(s.run("quietly regress wage i.female education").rc, 0);
  assert.equal(s.run("quietly margins female, at(education=(12 16))").rc, 0);
  s.run("matrix b = r(b)\nmatrix V = r(V)");
  // Stata's matrix list shows these names (its colnames add bn to the
  // base levels: 1bn._at#0bn.female).
  assert.deepEqual(names(s, "b"), [
    "1._at#0.female",
    "1._at#1.female",
    "2._at#0.female",
    "2._at#1.female",
  ]);
  const stata = [
    [17.97309755692850786, 0.4278021709970126762],
    [15.51538023054137128, 0.4546252986915889083],
    [25.66802374351755844, 0.5824722645080809835],
    [23.21030641713042186, 0.5623172435550687354],
  ];
  stata.forEach(([value, se], j) => {
    close(element(s, `b[1,${j + 1}]`), value, `b[${j + 1}]`);
    close(element(s, `sqrt(V[${j + 1},${j + 1}])`), se, `se[${j + 1}]`);
  });
});

test("margins of two factors at each at() setting lists _at#female then _at#union", () => {
  const s = session();
  s.run("quietly regress wage i.female i.union education");
  assert.equal(
    s.run("quietly margins female union, at(education=(12 16))").rc,
    0,
  );
  s.run("matrix b = r(b)");
  assert.deepEqual(names(s, "b"), [
    "1._at#0.female",
    "1._at#1.female",
    "2._at#0.female",
    "2._at#1.female",
    "1._at#0.union",
    "1._at#1.union",
    "2._at#0.union",
    "2._at#1.union",
  ]);
  [
    17.83404523674933273, 15.35680235670109184, 26.05562750118861004,
    23.57838462114036915, 15.23597526403528946, 19.13565157868637812,
    23.45755752847456677, 27.35723384312565543,
  ].forEach((value, j) =>
    close(element(s, `b[1,${j + 1}]`), value, `b[${j + 1}]`),
  );
});

test("marginsplot after margins of a factor at several settings draws a line per level", () => {
  const s = session();
  s.run("quietly regress wage i.female education");
  s.run("quietly margins female, at(education=(12 16))");
  const result = s.run("marginsplot");
  assert.equal(result.rc, 0);
  const svg = result.output.at(-1).graph.svg,
    count = (tag) => (svg.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length;
  // Stata 19's graph export of the same marginsplot: the x title is the
  // variable label, the legend reads female=0 and female=1, and the title
  // names the factor.
  assert.match(svg, />Adjusted predictions of female with 95% CIs</);
  assert.match(svg, />Years of schooling</);
  assert.match(svg, />female=0</);
  assert.match(svg, />female=1</);
  assert.equal(count("polyline"), 2);
  assert.equal(count("circle"), 4);
});

// Second round. The at() settings are numbered with the variables in the
// model's order, whatever order at() names them in; Stata 19 gives these
// r(b) and standard errors on the labor data.
test("margins numbers the at() settings in the model's order of the variables", () => {
  const s = session();
  s.run("quietly regress wage i.female i.union education experience");
  assert.equal(
    s.run("quietly margins female, at(experience=(5 20) education=(12 16))").rc,
    0,
  );
  s.run("matrix b = r(b)\nmatrix V = r(V)");
  [
    [15.46574782648492175, 0.522260968876446241],
    [13.37482069532024909, 0.5088356853394125912],
    [18.27681928035361025, 0.4026089881092026479],
    [16.18589214918893759, 0.4389253304433676228],
    [23.69078144542033826, 0.6401891253596069253],
    [21.59985431425566205, 0.596107441062710075],
    [26.50185289928902321, 0.5473356395011523823],
    [24.410925768124347, 0.5380357615114512715],
  ].forEach(([value, se], j) => {
    close(element(s, `b[1,${j + 1}]`), value, `b[${j + 1}]`);
    close(element(s, `sqrt(V[${j + 1},${j + 1}])`), se, `se[${j + 1}]`);
  });
  s.run("quietly regress wage i.female i.union education");
  s.run("quietly margins female, at(education=(12 16) union=(0 1))");
  s.run("matrix b = r(b)");
  [
    16.43655031170371927, 13.95930743165547838, 24.65813257614299658,
    22.18088969609475569, 20.33622662635480793, 17.85898374630656704,
    28.55780889079408524, 26.0805660107458479,
  ].forEach((value, j) =>
    close(element(s, `b[1,${j + 1}]`), value, `b[${j + 1}]`),
  );
  s.run("quietly margins, at(education=(12 16) union=(0 1))");
  s.run("matrix b = r(b)");
  [
    15.23597526403528946, 23.45755752847456677, 19.13565157868637812,
    27.35723384312565543,
  ].forEach((value, j) =>
    close(element(s, `b[1,${j + 1}]`), value, `b[${j + 1}]`),
  );
});

test("margins holds at() values and means in float precision, as Stata does", () => {
  const s = session();
  s.run("generate double ed2 = education + 1/3");
  s.run("quietly regress wage i.female ed2 experience");
  s.run("quietly margins, at(ed2=12.3 experience=5.1 female=1)");
  s.run("matrix b = r(b)");
  close(element(s, "b[1,1]"), 13.18696976181063363, "at() values");
  s.run("quietly logit union i.female ed2 experience");
  s.run("quietly margins, atmeans");
  s.run("matrix b = r(b)");
  close(element(s, "b[1,1]"), 0.3487509894572800584, "atmeans");
});

// Legend texts and the number of lines as in Stata 19's graph export of
// the same marginsplot.
const legend = (svg) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)];
test("marginsplot names each line by the value label and the other at() values", () => {
  const s = session(),
    plot = (setup) => {
      setup.forEach((command) => assert.equal(s.run(command).rc, 0));
      const result = s.run("marginsplot");
      assert.equal(result.rc, 0);
      const svg = result.output.at(-1).graph.svg;
      return {
        svg,
        texts: legend(svg).map((m) => m[1]),
        lines: (svg.match(/<polyline\b/g) ?? []).length,
      };
    };
  let p = plot([
    "quietly regress wage i.female education",
    'label define fl 0 "male" 1 "female"',
    "label values female fl",
    "quietly margins female, at(education=(12 16))",
  ]);
  assert.ok(p.texts.includes("male") && p.texts.includes("female"));
  assert.ok(!p.texts.includes("female=0"));
  assert.equal(p.lines, 2);
  p = plot([
    "quietly regress wage i.female education experience",
    "quietly margins female, at(education=(12 16) experience=(5 20))",
  ]);
  assert.deepEqual(p.texts.slice(-4), [
    "experience=5, male",
    "experience=5, female",
    "experience=20, male",
    "experience=20, female",
  ]);
  assert.ok(p.texts.includes("Years of schooling"));
  assert.equal(p.lines, 4);
  p = plot(["quietly margins female, at(experience=(5 20) education=(10 12))"]);
  assert.deepEqual(p.texts.slice(-4), [
    "education=10, male",
    "education=10, female",
    "education=12, male",
    "education=12, female",
  ]);
  assert.ok(p.texts.includes("Years of work experience"));
  p = plot([
    "encode region, gen(reg)",
    "quietly regress wage i.reg education",
    "quietly margins reg, at(education=(10(2)18))",
  ]);
  assert.deepEqual(p.texts.slice(-4), ["East", "North", "South", "West"]);
  assert.equal(p.lines, 4);
  p = plot([
    "quietly regress wage i.female education experience",
    "quietly margins, at(education=(12 16) experience=(5 20))",
  ]);
  assert.deepEqual(p.texts.slice(-2), ["experience=5", "experience=20"]);
  assert.ok(p.texts.includes("Predictive margins with 95% CIs"));
  assert.equal(p.lines, 2);
});
