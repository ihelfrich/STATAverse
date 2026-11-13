// prtest, prtesti and bitesti results the output fixture cannot compare:
// stored r() values, their order, and return codes. Every expected value was
// recorded from Stata 19 MP (version 17, set processors 1) on the same
// do-file lines.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

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
function matches(r, expected, tolerance = 1e-12) {
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
