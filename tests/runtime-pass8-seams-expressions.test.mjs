// Pass 8 seams, expressions: factor variables in varlists and expressions,
// relational operators typed with a blank, the one-line if command, a lone
// =, operator typos, coefficient shorthand, old function names, c() values
// and the random-number functions. Every expected value was recorded from
// Stata 19 (StataMP, run in batch under version 17 with set processors 1)
// on simulated data; runiform() is drawn as Stata draws it. The Results
// text itself is checked in tools/output-cases.txt (seams-expressions-).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

/** Runs each line on its own: { rc, text } of the last one. */
function run(s, ...lines) {
  let last;
  for (const line of lines) {
    const ran = s.run(line);
    last = {
      rc: ran.rc,
      lines: ran.output.flatMap((record) => record.lines ?? []),
    };
  }
  while (last.lines[0] === "") last.lines.shift();
  last.text = last.lines.filter((l) => !/^r\(\d+\);$/.test(l)).join("\n");
  return last;
}
const fresh = (...setup) => {
  const s = new Session();
  for (const line of setup) s.run(line);
  return s;
};
const shown = (s, expression) => run(s, `display ${expression}`).text;

test("factor variables in summarize, mean, list and correlate", () => {
  const s = fresh("clear", "set obs 6", "gen g = mod(_n,3)", "gen x = _n^2");
  assert.deepEqual(run(s, "summarize i.g").lines.slice(2, 6), [
    "           g |",
    "          0  |          6    .3333333    .5163978          0          1",
    "          1  |          6    .3333333    .5163978          0          1",
    "          2  |          6    .3333333    .5163978          0          1",
  ]);
  assert.equal(
    run(s, "summarize c.x#c.x").lines[2],
    "     c.x#c.x |          6    379.1667    505.9626          1       1296",
  );
  assert.equal(
    run(s, "summarize 1.g").lines[2],
    "         1.g |          6    .3333333    .5163978          0          1",
  );
  assert.equal(
    run(s, "summarize c.x").lines[2],
    "           x |          6    15.16667    13.37784          1         36",
  );
  assert.deepEqual(run(s, "summarize i.g#c.x").lines.slice(2, 6), [
    "       g#c.x |",
    "          0  |          6         7.5    14.41874          0         36",
    "          1  |          6    2.833333    6.462714          0         16",
    "          2  |          6    4.833333    10.00833          0         25",
  ]);
  // Two levels side by side are grouped; ib1. leaves level 1 out.
  assert.deepEqual(
    run(s, "summarize 1.g 2.g")
      .lines.slice(2, 5)
      .map((l) => l.slice(0, 14)),
    ["           g |", "          1  |", "          2  |"],
  );
  assert.deepEqual(
    run(s, "summarize ib1.g")
      .lines.slice(3, 5)
      .map((l) => l.slice(0, 14)),
    ["          0  |", "          2  |"],
  );
  const mean = run(s, "mean i.g").lines;
  assert.deepEqual(mean.slice(5, 9), [
    "           g |",
    "          0  |   .3333333   .2108185     -.2085929    .8752596",
    "          1  |   .3333333   .2108185     -.2085929    .8752596",
    "          2  |   .3333333   .2108185     -.2085929    .8752596",
  ]);
  assert.deepEqual(run(s, "list 1.g in 1/2").lines.slice(0, 6), [
    "     +----+",
    "     |  1.|",
    "     |  g |",
    "     |----|",
    "  1. |  1 |",
    "  2. |  0 |",
  ]);
  const correlate = run(s, "correlate x i.g");
  assert.equal(correlate.rc, 101);
  assert.equal(correlate.text, "factor-variable operators not allowed");
  const level = run(s, "correlate x 1.g");
  assert.equal(level.rc, 198);
  assert.equal(level.text, "1:  operator invalid");
});

test("factor-variable terms in expressions and if", () => {
  const s = fresh(
    "clear",
    "set obs 6",
    "gen g = mod(_n,3)",
    "gen x = _n",
    "replace g = . in 6",
  );
  // A missing g makes 1.g missing, which counts as true.
  assert.equal(run(s, "count if 1.g").text.trim(), "3");
  assert.equal(run(s, "count if !1.g").text.trim(), "3");
  assert.equal(run(s, "gen z = 2.g").text, "(1 missing value generated)");
  assert.deepEqual(
    Array.from(s.data.get("z").data.slice(0, 5)),
    [0, 1, 0, 0, 1],
  );
  assert.equal(run(s, "gen w = c.x#g").text, "(1 missing value generated)");
  assert.deepEqual(
    Array.from(s.data.get("w").data.slice(0, 5)),
    [1, 4, 0, 4, 10],
  );
  // A base or omitted level alone is 0.
  run(s, "gen b = 1b.g", "gen o = o.g");
  assert.deepEqual(
    Array.from(s.data.get("b").data.slice(0, 5)),
    [0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    Array.from(s.data.get("o").data.slice(0, 5)),
    [0, 0, 0, 0, 0],
  );
  for (const [line, rc, message] of [
    ["gen q = 1.5.g", 198, "multiple conflicting factor levels specified"],
    ["gen q = 1.nosuch", 111, "variable nosuch not found"],
    ["gen q = 1.g[2]", 198, "1.g invalid name"],
    ["gen q = c.x[2]", 198, "c.x invalid name"],
    ["gen q = 1n.g", 198, "1n:  operator invalid"],
    ["gen q = i.g", 198, "i:  operator invalid"],
    ["gen q = 1.(g)", 133, "unknown function 1.()"],
    [
      "gen q = 1.g#1.g",
      198,
      "interaction with duplicate factor variables not allowed",
    ],
    ["display 1.2.3", 198, "multiple conflicting factor levels specified"],
  ]) {
    const ran = run(s, line);
    assert.equal(ran.rc, rc, line);
    assert.equal(ran.text, message, line);
  }
  const t = fresh("clear", "set obs 6", "gen g = mod(_n,3)", "gen x = _n");
  const sum = run(t, "summarize x if 2.g").lines[2];
  assert.match(sum, /\|\s+2\s+3\.5\s/);
  // _b[0.g] is the base level's 0 after regress y i.g.
  run(t, "gen y = x + g", "quietly regress y i.g");
  assert.equal(shown(t, "_b[0.g]"), "0");
  assert.equal(shown(t, "_b[0b.g]"), "0");
  assert.equal(run(t, "display _b[i.g]").text, "i:  operator invalid");
});

test("relational operators typed with a blank", () => {
  const s = fresh("clear", "set obs 4", "gen x = _n");
  assert.equal(run(s, "count if x > = 2").text.trim(), "3");
  assert.equal(run(s, "count if x ~ = 1").text.trim(), "3");
  assert.equal(run(s, "count if x <  = 2").text.trim(), "2");
  assert.equal(shown(s, "3 > = 2"), "1");
  assert.equal(run(s, "gen b = (x > = 2)").rc, 0);
  assert.equal(run(s, "assert x > = 1").rc, 0);
  assert.equal(run(s, 'if x > = 1 display "yes"').text, "yes");
  assert.equal(run(s, "keep if x < = 3").text, "(1 observation deleted)");
  const looped = fresh();
  const ran = looped.run(
    'local n = 0\nwhile 1 < = 0 {\n  local ++n\n}\nif 1 > = 1 {\n  display "in"\n}',
  );
  assert.equal(ran.rc, 0);
  assert.deepEqual(ran.output.flatMap((r) => r.lines ?? []).filter(Boolean), [
    "in",
  ]);
});

test("the one-line if command reports its expression's own error", () => {
  const s = fresh("clear", "set obs 2", "gen x = _n", 'gen s = "a"');
  for (const [line, rc, message] of [
    ['if s == 1 display "yes"', 109, "type mismatch"],
    ['if nosuch == 1 display "yes"', 111, "nosuch not found"],
    ['if _b[x] display "yes"', 111, "_b not allowed when e(b) is not present"],
    ['if L.x display "yes"', 111, "time variable not set"],
    ['if 1 = 1 display "yes"', 101, "=exp not allowed"],
    ['if "a" = "a" display "yes"', 109, "type mismatch"],
    ['if 1 = "a" display "yes"', 101, "=exp not allowed"],
    ['if display "yes"', 111, "display not found"],
    ["if 1", 100, "{ required"],
  ]) {
    const ran = run(s, line);
    assert.equal(ran.rc, rc, line);
    assert.equal(ran.text, message, line);
  }
  assert.equal(run(s, 'if 1.x display "yes"').text, "yes");
});

test("a lone = is judged by where it stands", () => {
  const s = fresh(
    "clear",
    "set obs 4",
    "gen x = _n",
    'gen s = "a" + string(_n)',
  );
  for (const [line, rc, message] of [
    ['gen z = s = "a1"', 198, "invalid syntax"],
    ['scalar k = s = "a1"', 198, "invalid syntax"],
    ['replace x = s = "a1"', 198, "invalid syntax"],
    ['local m = "a" = "a"', 198, "invalid syntax"],
    ['assert s = "a1"', 109, "type mismatch"],
    ["assert 1 = s", 198, "invalid syntax"],
    ['count if nosuch = "a"', 111, "nosuch not found"],
    ['summarize x if nosuch = "a"', 111, "nosuch not found"],
    ['egen w2 = total(s = "a1")', 198, 's="a1" invalid name'],
    ["egen w3 = total(x = 1)", 198, "x=1 invalid name"],
    ["gen z = = x", 198, "=x invalid name"],
  ]) {
    const ran = run(s, line);
    assert.equal(ran.rc, rc, line);
    assert.equal(ran.text, message, line);
  }
  const block = fresh("clear", "set obs 1", "gen x = 1").run(
    'if x = 1 {\n  display "in"\n}',
  );
  assert.equal(block.rc, 101);
  // display shows each side of a lone = as an item of its own.
  assert.equal(shown(s, "3 = 3"), "33");
  assert.equal(shown(s, "1 + 2 = 4"), "34");
  assert.equal(shown(s, "x = 1"), "11");
  assert.equal(shown(s, 's = "a1"'), "a1a1");
  const open = run(s, 'display "abc" + "d');
  assert.equal(open.rc, 132);
  assert.match(open.text, /^abc[\s\S]*too few quotes$/);
});

test("operator typos get Stata's messages", () => {
  const s = fresh("clear", "set obs 3", "gen x = _n");
  for (const [expression, rc, message] of [
    ["x ** 2", 198, "x* invalid name"],
    ["x && 3", 198, "x& invalid name"],
    ["x || 3", 198, "x| invalid name"],
    ["x <> 3", 198, ">3 invalid name"],
    ["x ++ 2", 198, "x+ invalid name"],
    ["x + + 2", 198, "x+ invalid name"],
    ["x + * 2", 198, "*2 invalid name"],
    ["x ^ * 3", 198, "x^ invalid name"],
    ["1 + x ** 2", 198, "x* invalid name"],
    ["(x) ** 2", 133, "unknown function ()"],
    ["+x", 198, "+x invalid name"],
    ["*x", 198, "*x invalid name"],
    ["()", 198, "invalid syntax"],
    ["-*x", 198, "invalid syntax"],
    ["x[", 132, "too few ')' or ']'"],
    ["1e", 198, "1e invalid name"],
    ["2x", 198, "2x invalid name"],
    ["x @ 2", 198, "invalid '@' "],
    ["x # 2", 198, "x#2 invalid name"],
    ["x : 3", 198, "x:3 invalid name"],
    ["abs(1,2)", 198, "1,2 invalid name"],
    ["abs(1 + 2, 3)", 198, "2,3 invalid name"],
    ["mod(1,)", 198, "invalid syntax"],
    ["max(1+,2)", 198, "1+ invalid name"],
    ["2 * (3 *)", 198, "3* invalid name"],
  ]) {
    const ran = run(s, `gen z = ${expression}`);
    assert.equal(ran.rc, rc, expression);
    assert.equal(ran.text, message, expression);
  }
  assert.equal(run(s, "gen z = x * + 2").rc, 0);
});

test("coefficients named by equation", () => {
  const s = fresh(
    "clear",
    "set obs 20",
    "set seed 12345",
    "gen x = runiform()",
    "gen d = x + rnormal() > 1",
    "quietly mlogit d x",
  );
  // mlogit's base outcome is equation #1, its coefficients 0.
  assert.equal(shown(s, "[#1]x"), "0");
  assert.equal(shown(s, "[#1]_cons"), "0");
  assert.equal(shown(s, "[#2]x"), "3.3421997");
  assert.equal(shown(s, "_b[#2:x]"), "3.3421997");
  assert.equal(shown(s, "[0]x"), "0");
  assert.equal(shown(s, "e(k_eq)"), "2");
  const r = fresh(
    "clear",
    "set obs 20",
    "set seed 12345",
    "gen x = runiform()",
    "gen w = runiform()",
    "gen y = 1 + 2*x + rnormal()",
    "quietly regress y x w",
  );
  for (const [expression, rc, message] of [
    ["[y]_b[x]", 303, "equation [y] not found"],
    ["[y]_se[x]", 303, "equation [y] not found"],
    ["_b[#1:x]", 111, "[#1:x] not found"],
    ["[/var(e.y)]", 133, "unknown function /var()"],
    ["2[y]x", 198, "2 invalid name"],
    ["e(b)", 109, "type mismatch"],
  ]) {
    const ran = run(r, `display ${expression}`);
    assert.equal(ran.rc, rc, expression);
    assert.equal(ran.text, message, expression);
  }
  assert.equal(shown(r, "[#1]_b[x]"), shown(r, "_b[x]"));
  const none = fresh();
  for (const [expression, rc, message] of [
    ["_b[x]", 111, "_b not allowed when e(b) is not present"],
    ["_se[x]", 111, "_se not allowed when e(V) is not present"],
    ["[y]x", 303, "equation [y] not found"],
  ]) {
    const ran = run(none, `display ${expression}`);
    assert.equal(ran.rc, rc, expression);
    assert.equal(ran.text, message, expression);
  }
});

test("old function names Stata 19 still reads", () => {
  const s = fresh("set seed 1");
  assert.equal(shown(s, "%21x uniform()"), "+1.122deafddb434X-003");
  s.run("set seed 1");
  assert.equal(shown(s, "%21x invnormal(uniform())"), "-1.1bb65bf526e53X+000");
  for (const [expression, value] of [
    ["invnorm(0.975)", "1.959964"],
    ["normprob(1)", ".84134475"],
    ['index("abc","b")', "2"],
    ["chiprob(2,3)", ".22313016"],
    ["tprob(10,2)", ".07338803"],
    ["fprob(2,10,3)", ".09536743"],
    ["binorm(0,0,0.5)", ".33333333"],
  ])
    assert.equal(shown(s, expression), value, expression);
});

test("functions' arguments as Stata takes them", () => {
  const s = fresh();
  assert.equal(shown(s, 'inrange("b","a","c")'), "1");
  assert.equal(shown(s, "missing()"), "0");
  assert.equal(run(s, "display runiform(1)").text, "invalid syntax");
  const regex = fresh(
    "clear",
    "set obs 2",
    'gen s = "ab"',
    'gen k = regexm(s, "(a)(b)")',
  );
  assert.equal(
    run(regex, "display regexs(3)").lines[0],
    "invalid number, outside of allowed range",
  );
  assert.equal(
    run(regex, "gen t = regexs(3)").lines.filter((l) =>
      /outside of allowed range/.test(l),
    ).length,
    2,
  );
});

test("c() has Stata's limits and calls a name it lacks undefined", () => {
  const s = fresh();
  for (const [name, value] of [
    ["%21x c(maxdouble)", "+1.fffffffffffffX+3fe"],
    ["%21x c(mindouble)", "-1.fffffffffffffX+3fe"],
    ["%21x c(smallestdouble)", "+1.0000000000000X-3fe"],
    ["%21x c(epsdouble)", "+1.0000000000000X-034"],
    ["%21x c(maxfloat)", "+1.fffffe0000000X+07e"],
    ["%21x c(epsfloat)", "+1.0000000000000X-017"],
    ["c(maxlong)", "2.147e+09"],
    ["c(maxint)", "32740"],
    ["c(minint)", "-32767"],
    ["c(maxbyte)", "100"],
    ["c(minbyte)", "-127"],
    ["c(maxstrvarlen)", "2045"],
    ["c(matsize)", "400"],
    ["c(stata_version)", "19"],
  ])
    assert.equal(shown(s, name), value, name);
  assert.equal(s.scope().system("maxlong"), 2147483620);
  const unknown = run(s, "display c(nosuch)");
  assert.equal(unknown.rc, 133);
  assert.equal(unknown.text, "c(nosuch) undefined");
});

test("powers, runiform(a,b) and runiformint() to the bit", () => {
  const s = fresh();
  for (const [expression, value] of [
    ["2^-50", "+1.0000000000000X-032"],
    ["10^-2", "+1.47ae147ae147cX-007"],
    ["3^-2", "+1.c71c71c71c71cX-004"],
    ["1.1^7", "+1.f2df1fb5a7ed8X+000"],
    ["1.7^13", "+1.ef3a994c588caX+009"],
    ["9^-21", "+1.5944bd61f8a08X-043"],
    ["2^0.5", "+1.6a09e667f3bccX+000"],
  ])
    assert.equal(shown(s, `%21x ${expression}`), value, expression);
  s.run("set seed 99");
  const draws = [1, 2, 3, 4].map(() => shown(s, "%21x runiform(10,20)"));
  assert.deepEqual(draws, [
    "+1.cb0de2f9b0e3aX+003",
    "+1.3cfabc70c9f2fX+004",
    "+1.0b37374f0d18eX+004",
    "+1.6c90849cfb8e1X+003",
  ]);
  assert.equal(shown(s, "%21x runiform(0, 2^-50)"), "+1.494c0072796d1X-033");
  s.run("set seed 99");
  assert.equal(shown(s, "%21x runiform(-3.7,20.1)"), "+1.a91923ec35830X+002");
  // A bound beyond 2^53 gives missing and uses up no draw.
  s.run("set seed 5");
  assert.equal(shown(s, "runiformint(0, 2^54)"), ".");
  assert.equal(shown(s, "%21x runiform()"), "+1.589bf68d490b3X-001");
});

test("rbinomial() and rpoisson() draw as Stata does where it can be matched", () => {
  const s = fresh("set seed 1");
  assert.equal(shown(s, "rbinomial(10,0.3)"), "1");
  // One uniform used up, as in Stata.
  assert.equal(shown(s, "%21x runiform()"), "+1.175c928118c7cX-003");
  s.run("set seed 1");
  assert.equal(shown(s, "rpoisson(3)"), "3");
  const g = fresh("clear", "set obs 12", "set seed 1");
  g.run("gen b = rbinomial(20,0.5)");
  assert.deepEqual(
    [...g.data.get("b").data],
    [8, 8, 10, 6, 9, 13, 10, 7, 10, 11, 7, 10],
  );
  g.run("set seed 1");
  g.run("gen p = rpoisson(15)");
  assert.deepEqual(
    [...g.data.get("p").data],
    [16, 16, 13, 15, 17, 22, 13, 15, 12, 19, 15, 12],
  );
  g.run("set seed 1");
  g.run("gen q = rpoisson(3)");
  assert.deepEqual(
    [...g.data.get("q").data],
    [3, 3, 2, 3, 4, 6, 2, 3, 2, 5, 3, 2],
  );
});
