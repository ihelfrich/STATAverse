// prtest, prtesti and bitesti results the output fixture cannot compare:
// stored r() values, their order, and return codes. Every expected value was
// recorded from Stata 19 MP (version 17, set processors 1) on the same
// do-file lines.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { isMissing } from "../src/runtime/values.js";

function run(source) {
  const session = new Session(),
    out = session.run(source);
  return { rc: out.rc, r: session.results.r };
}
function close(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} vs Stata ${expected}`,
  );
}
// return list shows 16 digits, so a value within 2e-16 (below 1, absolute;
// above, relative) is Stata's double to the last bit or the next one. The
// earlier 1e-12 hid limits that were off in their last three digits.
function matches(r, expected, tolerance = 2e-16) {
  for (const [key, value] of Object.entries(expected))
    close(r[key], value, tolerance, `r(${key})`);
}

const TWO_VARIABLES = [
  "clear",
  "set obs 70",
  "set seed 1414",
  "generate a = runiform() < .3",
  "generate b = runiform() < .5",
  "replace b = . in 1/10",
].join("\n");

test("prtest var1 == var2 is the two-sample test of the two variables", () => {
  const { rc, r } = run(`${TWO_VARIABLES}\nprtest a == b`);
  assert.equal(rc, 0);
  // return list, in the order Stata prints it.
  assert.deepEqual(Object.keys(r), [
    "N1",
    "N2",
    "P1",
    "P2",
    "P_diff",
    "se1",
    "se2",
    "se_diff0",
    "se_diff",
    "lb1",
    "ub1",
    "lb2",
    "ub2",
    "lb_diff",
    "ub_diff",
    "z",
    "p_l",
    "p",
    "p_u",
    "level",
  ]);
  matches(r, {
    N1: 70,
    N2: 60,
    P1: 0.3571428571428572,
    P2: 0.4333333333333333,
    P_diff: -0.0761904761904761,
    se1: 0.0572702661240909,
    se2: 0.0639733740910435,
    se_diff0: 0.0859018095218074,
    se_diff: 0.0858631234845134,
    lb1: 0.2448951981546147,
    ub1: 0.4693905161310997,
    lb2: 0.3079478241453803,
    ub2: 0.5587188425212863,
    lb_diff: -0.2444791058202375,
    ub_diff: 0.0920981534392854,
    z: -0.8869484428163769,
    p_l: 0.1875533294425576,
    p: 0.3751066588851153,
    p_u: 0.8124466705574424,
    level: 95,
  });
});

test("prtest var == expression refuses as Stata does", () => {
  for (const [line, code] of [
    ["prtest a == b, by(a)", 198],
    ["prtest a", 100],
    ["prtest a == 1/2", 450],
    ["prtest a == zz", 111],
    // Stata: "== invalid name", from the unab that wants a variable.
    ["prtest a == (b==1)", 198],
    ["prtest a == 0", 450],
  ])
    assert.equal(run(`${TWO_VARIABLES}\n${line}`).rc, code, line);
});

test("prtest by() on a string compares the first value, even an empty one, with the next", () => {
  const { rc, r } = run(
    [
      "clear",
      "set obs 30",
      "set seed 35",
      "generate y = runiform() < .5",
      'generate str3 s = cond(_n <= 10, "", cond(_n <= 21, "lo", "hi"))',
      "prtest y, by(s)",
    ].join("\n"),
  );
  assert.equal(rc, 0);
  matches(r, {
    N1: 10,
    N2: 11,
    P1: 0.4,
    P2: 0.5454545454545454,
    P_diff: -0.1454545454545454,
    se1: 0.1549193338482967,
    se2: 0.150131422517231,
    se_diff0: 0.2182178902359924,
    se_diff: 0.2157300257892891,
    lb1: 0.0963636851484017,
    ub1: 0.7036363148515984,
    lb2: 0.251202364373007,
    ub2: 0.8397067265360838,
    lb_diff: -0.568277626385449,
    ub_diff: 0.2773685354763582,
    z: -0.6665564647208492,
    p_l: 0.2525277426318549,
    p: 0.5050554852637098,
    p_u: 0.7474722573681452,
    level: 95,
  });
});

test("prtesti two-sample stores the confidence limits", () => {
  const { rc, r } = run("prtesti 100 40 120 60, count");
  assert.equal(rc, 0);
  matches(r, {
    N1: 100,
    N2: 120,
    P1: 0.4,
    P2: 0.5,
    P_diff: -0.1,
    se1: 0.0489897948556636,
    se2: 0.0456435464587638,
    se_diff0: 0.0674199862463242,
    se_diff: 0.0669576980886689,
    lb1: 0.3039817664728939,
    ub1: 0.4960182335271062,
    lb2: 0.4105402928141422,
    ub2: 0.5894597071858578,
    lb_diff: -0.2312346767414974,
    ub_diff: 0.0312346767414974,
    z: -1.483239697419132,
    p_l: 0.0690053687843298,
    p: 0.1380107375686597,
    p_u: 0.9309946312156702,
    level: 95,
  });
});

test("prtesti return codes follow prtesti.ado's checks", () => {
  for (const [line, code] of [
    ["prtesti 50 30.5 .5, count", 7],
    ["prtesti 50.5 30 .5, count", 7],
    ["prtesti 50 30 60 20.5, count", 7],
    ["prtesti 50 abc .5", 7],
    ["prtesti 50 .3", 198],
    ["prtesti 50 .3 60 .4 70", 198],
    ["prtesti 50 60 .5, count", 198],
    ["prtesti 50 -3 .5, count", 198],
    ["prtesti 50 1.2 .5", 198],
    ["prtesti 1 .5 .5", 2001],
    ["prtesti 1 .5 10 .5", 2001],
  ])
    assert.equal(run(line).rc, code, line);
});

test("bitesti tails are accurate for millions of trials", () => {
  // Stata's own Binomial() is within 3e-12 of the exact tails (checked at
  // 45 digits); the runtime was 2.7e-7 off at n = 1e6 before.
  for (const [line, expected] of [
    [
      "bitesti 1000000 500500 .5",
      {
        p_l: 0.8415865958480423,
        p_u: 0.1588973456816529,
        p: 0.3177946913633057,
        k_opp: 499500,
      },
    ],
    [
      "bitesti 100000 50300 .5",
      {
        p_l: 0.9713183964058874,
        p_u: 0.0290986765550969,
        p: 0.0581973531101938,
        k_opp: 49700,
      },
    ],
    [
      "bitesti 1000000 300500 .3",
      {
        p_l: 0.8626169720306095,
        p_u: 0.1378629461339582,
        p: 0.275233644424189,
        k_opp: 299499,
      },
    ],
    [
      "bitesti 2000000 1000 .0005",
      {
        p_l: 0.508409367432832,
        p_u: 0.5042083987529665,
        p: 1,
        k_opp: 1001,
      },
    ],
  ]) {
    const { rc, r } = run(line);
    assert.equal(rc, 0, line);
    matches(r, expected, 1e-11);
  }
});

test("bitesti stores its results in Stata's return list order", () => {
  assert.deepEqual(Object.keys(run("bitesti 1000000 500500 .5").r), [
    "k_opp",
    "p",
    "k",
    "P_p",
    "N",
    "p_l",
    "p_u",
  ]);
});

// The values below were recorded from Stata 19 MP (version 17, set
// processors 1) with display %21.0g, to every digit Stata shows.
const missing = (r, keys) =>
  keys.forEach((key) => assert.ok(isMissing(r[key]), `r(${key}) = ${r[key]}`));
/** The return code and message of a do-file's last command. */
function messages(source) {
  const block = new Session().run(source).output.at(-1);
  return {
    rc: block.rc,
    lines: block.lines.filter((line) => line && !/^r\(\d+\);$/.test(line)),
  };
}

test("prtesti with an empty second sample stores missing results and return list runs", () => {
  const { rc, r } = run("prtesti 10 .5 0 .3\nreturn list");
  assert.equal(rc, 0);
  assert.equal(r.N2, 0);
  assert.equal(r.P2, 0.3);
  close(r.se1, 0.1581138830084189706, 2e-16, "r(se1)");
  missing(r, [
    "se2",
    "se_diff0",
    "se_diff",
    "lb2",
    "ub2",
    "lb_diff",
    "ub_diff",
    "z",
    "p_l",
    "p",
    "p_u",
  ]);
  // 0 successes in 0 trials is 0/0, missing. The output fixture cannot hold
  // a message that starts with a period, so these are checked here.
  for (const line of ["prtesti 10 5 0 0, count", "prtesti 0 0 10 3, count"])
    assert.deepEqual(messages(line), {
      rc: 198,
      lines: [". not less than 0"],
    });
  assert.deepEqual(
    messages("clear\nset obs 5\ngen sh = _n > 2\nprtest sh == ."),
    { rc: 198, lines: [". invalid name"] },
  );
  assert.deepEqual(
    messages("clear\nset obs 5\ngen sh = _n > 2\nprtest sh == (.)"),
    { rc: 198, lines: [". invalid name"] },
  );
});

test("prtest on an empty sample leaves z and its tails missing", () => {
  const { rc, r } = run(
    [
      "clear",
      "set obs 30",
      "set seed 77",
      "gen a = runiform() < .4",
      "prtest a == .5 if 0",
    ].join("\n"),
  );
  assert.equal(rc, 0);
  assert.equal(r.N, 0);
  missing(r, ["P", "se", "lb", "ub", "z", "p_l", "p", "p_u"]);
});

test("prtesti's confirm integer number takes only digits", () => {
  for (const line of [
    "prtesti 50.0 .3 .5",
    "prtesti 1e3 .3 .5",
    "prtesti 5e1 .3 .5",
    "prtesti 50 .3 6E1 .45",
    "prtesti 50 1.5e1 .5, count",
    "prtesti 50 15 .5e1 .5, count",
  ])
    assert.equal(run(line).rc, 7, line);
  assert.equal(run("prtesti +50 15 060 30, count").rc, 0);
});

test("prtest var == exp and string variables give Stata's return codes", () => {
  const data = [
    "clear",
    "set obs 30",
    "set seed 9",
    "gen sh = runiform() < .5",
    "gen second_long_variable = runiform() < .6",
  ].join("\n");
  for (const [line, code] of [
    ["prtest sh == (sh)", 0],
    ["prtest sh == second", 0],
    ["prtest sh == sh + 0", 198],
    ['prtest sh == "a"', 109],
    ["prtest sh == second*", 198],
    ["prtest sh == .", 198],
    ["prtest sh == ((sh))", 101],
    ["prtest sh == (sh", 132],
    ["prtest sh == _n>1", 111],
    ["prtest sh, by(nosuch)", 111],
    ["prtest sh, by(sh second)", 103],
  ])
    assert.equal(run(`${data}\n${line}`).rc, code, line);
  const strings = [
    "clear",
    "set obs 10",
    "gen a = _n > 5",
    'gen str5 s = "x"',
    'replace s = "y" in 1/3',
    "gen g = _n > 4",
  ].join("\n");
  for (const [line, code] of [
    ["prtest a == s", 109],
    ["prtest s == a", 450],
    ["prtest s == .5", 450],
    ["prtest s, by(g)", 7],
  ])
    assert.equal(run(`${strings}\n${line}`).rc, code, line);
});

test("prtest passes an empty sample's mean to prtesti as '.'", () => {
  const data = [
    "clear",
    "set obs 20",
    "set seed 3",
    "gen a = runiform() < .3",
    "gen b = runiform() < .5",
    "replace b = . in 11/20",
  ].join("\n");
  // Stata: "varlist not allowed" and "'.' found where number expected".
  assert.equal(run(`${data}\nprtest a == b if _n > 10`).rc, 101);
  assert.equal(run(`${data}\nprtest b == a if _n > 10`).rc, 7);
});

test("prtesti limits and p-values agree with Stata to the last digit", () => {
  matches(run("prtesti 100 40 120 60, count").r, {
    lb1: 0.3039817664728938773,
    ub1: 0.4960182335271061671,
    lb2: 0.4105402928141421715,
    ub2: 0.5894597071858578285,
    lb_diff: -0.2312346767414973914,
    ub_diff: 0.0312346767414974358,
    p: 0.1380107375686596971,
    p_l: 0.0690053687843298486,
    p_u: 0.9309946312156701653,
  });
  matches(run("prtesti 100 40 120 60, count level(99)").r, {
    lb1: 0.2738106508359327007,
    ub1: 0.5261893491640673437,
    lb_diff: -0.2724716008349734597,
    ub_diff: 0.0724716008349735041,
  });
});

test("normal() and invnormal() return Stata's doubles", () => {
  for (const [expression, expected] of [
    ["invnormal(.995)", 2.57582930354889994],
    ["normal(-1.483239697419132)", 0.0690053687843298624],
    ["invnormal(.975)", 1.959963984540053605],
    ["normal(1.2)", 0.8849303297782917799],
  ]) {
    const session = new Session();
    session.run(`scalar v = ${expression}`);
    assert.equal(session.scalar("v"), expected, expression);
  }
});

test("bitesti with p near 1 keeps the upper tail exact and finds Stata's opposite k", () => {
  for (const [line, expected] of [
    [
      "bitesti 1000000000 999999990 .99999999",
      {
        k_opp: 999999992,
        p: 0.8748899644070754489,
        p_u: 0.5830397439065069243,
        p_l: 0.5420702924401774592,
      },
    ],
    [
      "bitesti 5000000 4999990 .999998",
      {
        k_opp: 4999991,
        p: 1,
        p_u: 0.5830397502265005638,
        p_l: 0.5420704106048505055,
      },
    ],
    // Pr(k <= 0) is Binomial(n, n, 1 - p), and Stata rounds 1 - p first.
    [
      "bitesti 19652879 0 1.0713339e-8",
      { p: 1, p_u: 1, p_l: 0.8101402030917204122 },
    ],
  ]) {
    const { rc, r } = run(line);
    assert.equal(rc, 0, line);
    matches(r, expected, 1e-14);
  }
});
