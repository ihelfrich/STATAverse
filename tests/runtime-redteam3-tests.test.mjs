// bitest, bitesti, signtest and robvar results the output fixture cannot
// compare: stored r() values and their order, under the by prefix too, and
// return codes. Every expected value was recorded from Stata 19 MP
// (version 17, set processors 1) on the same do-file lines.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { isMissing } from "../src/runtime/values.js";

function run(source) {
  const session = new Session(),
    out = session.run(source);
  return { rc: out.rc, r: session.results.r };
}
/**
 * r() in return list's order, each value within tolerance (relative above
 * 1, absolute below); null stands for a missing value. Tail probabilities
 * agree with Stata's to about 1e-15; a density, the difference of two
 * tails, and robvar's F probabilities to a few units more.
 */
function matches(r, expected, tolerance = 1e-14) {
  assert.deepEqual(Object.keys(r), Object.keys(expected));
  for (const [key, value] of Object.entries(expected)) {
    if (value === null) {
      assert.ok(isMissing(r[key]), `r(${key}) should be missing`);
      continue;
    }
    assert.ok(
      Math.abs(r[key] - value) <= tolerance * Math.max(1, Math.abs(value)),
      `r(${key}): ${r[key]} vs Stata ${value}`,
    );
  }
}
const BY_DATA = [
  "clear",
  "set obs 20",
  "set seed 61",
  "generate g = _n > 9",
  "generate y = invnormal(runiform())",
  "generate h = runiform() < .5",
  "generate k = 1 + (_n > 5) + (_n > 12)",
].join("\n");

test("signtest under by leaves the last group's results", () => {
  const { rc, r } = run(`${BY_DATA}\nby g, sort: signtest y = 0`);
  assert.equal(rc, 0);
  matches(r, {
    N: 11,
    N_pos: 5,
    N_neg: 6,
    N_tie: 0,
    p: 1,
    p_l: 0.5000000000000001,
    p_u: 0.7255859374999999,
  });
});

test("robvar under bysort runs per group, in return list's order", () => {
  const { rc, r } = run(`${BY_DATA}\nbysort g: robvar y, by(k)`);
  assert.equal(rc, 0);
  matches(r, {
    N: 11,
    w10: 1.510955511681869,
    p_w10: 0.2501606478735242,
    w50: 1.426332315353484,
    p_w50: 0.26288937784684,
    w0: 1.510955511681869,
    p_w0: 0.2501606478735242,
    df_1: 1,
    df_2: 9,
  });
});

test("by with in, and by on bitesti and prtesti, are refused as in Stata", () => {
  assert.equal(run(`${BY_DATA}\nbysort g: bitest h == .5 in 1/5`).rc, 190);
  assert.equal(run(`${BY_DATA}\nbysort g: bitesti 10 3 .5`).rc, 190);
  assert.equal(run(`${BY_DATA}\nbysort g: prtesti 10 .3 .5`).rc, 190);
});

test("bitest, detail adds the densities of the observed and opposite k", () => {
  const { rc, r } = run(
    [
      "clear",
      "set obs 40",
      "set seed 41",
      "generate y = runiform() < .4",
      "bitest y == .5, detail",
    ].join("\n"),
  );
  assert.equal(rc, 0);
  matches(
    r,
    {
      P_oppk: 0.1194006548757896,
      P_noppk: 0.1253706876195796,
      k_nopp: 20,
      P_k: 0.1194006548757896,
      k_opp: 19,
      p: 0.8746293123804204,
      k: 21,
      P_p: 0.5,
      N: 40,
      p_l: 0.6820859986855794,
      p_u: 0.4373146561902102,
    },
    1e-13,
  );
});

test("bitesti, detail on both sides and with an empty opposite tail", () => {
  matches(
    run("bitesti 10 0 .3, detail").r,
    {
      P_oppk: 0.009001692,
      P_noppk: 0.036756909,
      k_nopp: 6,
      P_k: 0.0282475249,
      k_opp: 7,
      p: 0.0388396033,
      k: 0,
      P_p: 0.3,
      N: 10,
      p_l: 0.0282475249,
      p_u: 1,
    },
    1e-13,
  );
  matches(
    run("bitesti 50 1 .01, detail").r,
    {
      P_noppk: 0.6050060671375364,
      k_nopp: 0,
      P_k: 0.3055586197664331,
      p: 0.3949939328624636,
      k_opp: null,
      k: 1,
      P_p: 0.01,
      N: 50,
      p_l: 0.9105646869039693,
      p_u: 0.3949939328624636,
    },
    1e-13,
  );
  matches(
    run("bitesti 10 9 .95, detail").r,
    {
      P_noppk: 0.5987369392383785,
      k_nopp: 10,
      P_k: 0.315124704862305,
      p: 0.4012630607616215,
      k_opp: null,
      k: 9,
      P_p: 0.95,
      N: 10,
      p_l: 0.4012630607616215,
      p_u: 0.9138616441006835,
    },
    1e-13,
  );
  // The k next to the opposite one is the observed k: no k_nopp.
  matches(
    run("bitesti 10 5 .5, detail").r,
    {
      P_oppk: 0.2460937499999998,
      P_k: 0.2460937499999998,
      k_opp: 5,
      p: 1,
      k: 5,
      P_p: 0.5,
      N: 10,
      p_l: 0.6230468749999999,
      p_u: 0.6230468749999999,
    },
    1e-13,
  );
});

test("robvar results are listed in Stata's order", () => {
  const { rc, r } = run(
    [
      "clear",
      "set obs 41",
      "set seed 1818",
      'generate str5 site = cond(_n<10,"north",cond(_n<30,"south","east"))',
      "generate y = invchi2(3,runiform())",
      "replace y = . in 2",
      "robvar y, by(site)",
    ].join("\n"),
  );
  assert.equal(rc, 0);
  matches(r, {
    N: 40,
    w10: 0.0302799556203311,
    p_w10: 0.9701979053102421,
    w50: 0.0010428691394851,
    p_w50: 0.998957703821758,
    w0: 0.153376464170361,
    p_w0: 0.8583492907365841,
    df_1: 2,
    df_2: 37,
  });
});

test("robvar with one group or no observations succeeds with missing W", () => {
  const one = run(
    "clear\nset obs 10\ngenerate y = _n\ngenerate g = 1\nrobvar y, by(g)",
  );
  assert.equal(one.rc, 0);
  matches(one.r, {
    N: 10,
    w10: null,
    p_w10: null,
    w50: null,
    p_w50: null,
    w0: null,
    p_w0: null,
    df_1: 0,
    df_2: 9,
  });
  const none = run(
    "clear\nset obs 10\ngenerate x = _n\ngenerate g = _n > 5\nrobvar x if 0, by(g)",
  );
  assert.equal(none.rc, 0);
  matches(none.r, {
    N: 0,
    w10: null,
    p_w10: null,
    w50: null,
    p_w50: null,
    w0: null,
    p_w0: null,
    df_1: -1,
    df_2: 0,
  });
});

test("invalid arguments and variables give Stata's return codes", () => {
  const data = [
    "clear",
    "set obs 20",
    "generate h = mod(_n, 2)",
    "generate x = _n",
    'generate str3 s = cond(_n < 3, "a", "b")',
  ].join("\n");
  for (const [command, code] of [
    ["bitesti 20 21 .5", 450],
    ["bitesti 20 -1 .5", 450],
    ["bitesti 0 0 .5", 2001],
    ["bitesti -3 0 .5", 198],
    ["bitesti 2.5 1 .5", 7],
    ["bitesti 20 1.5 .5", 450],
    ["bitesti 20 3 1.5", 450],
    ["bitesti 20 3", 198],
    ["bitesti 20 3 .5 4", 101],
    ["bitesti a 3 .5", 111],
    ["bitesti 20 3 .5, level(90)", 198],
    ["bitesti", 198],
    ["bitest h == .5, by(h)", 198],
    ["bitest s == .5", 2000],
    ["bitest x == .5 if 0", 2000],
    ["bitest x == .5", 450],
    ["bitest h == 1.5", 450],
    ["signtest s = 0", 109],
    ["signtest x = s", 109],
    ["robvar s, by(h)", 109],
  ])
    assert.equal(run(`${data}\n${command}`).rc, code, command);
});

// Round 3 of the red team. Recorded from Stata 19 MP (version 17, set
// processors 1) on the same do-file lines.
const EMPTY_DATA = [
  "clear",
  "set obs 20",
  "set seed 66",
  "generate g = _n > 10",
  "generate h = runiform() < .5",
].join("\n");

test("by goes on past a bitest by-group with no observations", () => {
  let { rc, r } = run(`${EMPTY_DATA}\nby g, sort: bitest h == .5 if g == 1`);
  assert.equal(rc, 0);
  matches(r, {
    k_opp: 6,
    p: 0.7539062500000002,
    k: 4,
    P_p: 0.5,
    N: 10,
    p_l: 0.3769531250000001,
    p_u: 0.828125,
  });
  // The last group empty: Stata's return list then shows nothing.
  ({ rc, r } = run(`${EMPTY_DATA}\nby g, sort: bitest h == .5 if g == 0`));
  assert.equal(rc, 0);
  assert.deepEqual(r, {});
  const groups = [
    EMPTY_DATA,
    'generate str3 s = cond(_n<8,"aa",cond(_n<17,"bb","cc"))',
    'replace h = . if s == "bb"',
    "generate y = _n",
  ].join("\n");
  for (const detail of ["", ", detail"]) {
    ({ rc, r } = run(
      `${groups}\ncapture noisily bysort s: bitest h == .5${detail}\nassert _rc == 0`,
    ));
    assert.equal(rc, 0);
    assert.equal(r.N, 4);
    assert.equal(r.k, 2);
  }
  ({ rc, r } = run(
    `${groups}\nsummarize y\ncapture noisily bysort s: bitest h == .5 if y > 100\nassert _rc == 0`,
  ));
  assert.equal(rc, 0);
  assert.deepEqual(r, {});
});

test("robvar keeps Stata's ~1e-31 W for groups of equal spread", () => {
  // Relative agreement, since these statistics are tiny.
  const near = (actual, expected) =>
    assert.ok(
      Math.abs(actual / expected - 1) < 1e-9,
      `${actual} vs Stata ${expected}`,
    );
  const shifted = [
    "clear",
    "input y g",
    "1 1",
    "3 1",
    "5 1",
    "2 2",
    "4 2",
    "6 2",
    "7 3",
    "9 3",
    "11 3",
    "end",
  ].join("\n");
  for (const [source, w, p] of [
    [
      "clear\nset obs 30\ngenerate g = 1 + (_n > 15)\ngenerate y = mod(_n, 15) + 10*g\nrobvar y, by(g)",
      1.1677217347e-30,
      0.9999999999999991,
    ],
    [
      `${shifted}\nrobvar y if g < 3, by(g)`,
      2.218671295935e-31,
      0.9999999999999997,
    ],
    [`${shifted}\nrobvar y, by(g)`, 1.66400347195e-31, 1],
  ]) {
    const { rc, r } = run(source);
    assert.equal(rc, 0);
    for (const name of ["w0", "w50", "w10"]) {
      near(r[name], w);
      assert.ok(Math.abs(r[`p_${name}`] - p) < 1e-14);
    }
  }
  // Shifted copies Stata's arithmetic leaves at exactly 0.
  const { r } = run(
    "clear\ninput y g\n1 1\n2 1\n3 1\n11 2\n12 2\n13 2\nend\nrobvar y, by(g)",
  );
  assert.equal(r.w0, 0);
  assert.equal(r.w50, 0);
  assert.equal(r.w10, 0);
});

test("bitest and bitesti syntax errors return Stata's codes", () => {
  const data = [
    "clear",
    "set obs 30",
    "set seed 77",
    "generate y = runiform() < .4",
    'generate str3 s = cond(_n < 10, "a", "b")',
    "generate z = 2",
  ].join("\n");
  for (const [command, code] of [
    ["bitest y", 100],
    ["bitest y, detail", 100],
    ["bitest y if y == 1", 100],
    ["bitest y in 1/5", 100],
    ["bitest y s", 100],
    ["bitest y == s", 109],
    ['bitest y == "a"', 109],
    ["bitest z == s", 109],
    ["bitest y == s if _n > 40", 109],
    ["bitest y ==", 198],
    ["bitest y .5", 198],
    ["bitest y z == .5", 198],
    ["bitest y zz", 111],
    ["bitest y s = .5", 103],
    ["bitest y == z", 450],
    ["bitest y = .5", 0],
    ['bitest y==1/3 if s == "b"', 0],
    ["bitesti 10 3 .5 if 1", 101],
    ["bitesti 10 3 .5 in 1/5", 101],
    ["bitesti 10 3 .5 [fw=2]", 101],
    ["bitesti 10 3 .5 using x", 101],
    ["bitesti 10 3 .5 =", 101],
    ["bitesti 10 3 .5 1", 101],
  ])
    assert.equal(run(`${data}\n${command}`).rc, code, command);
});
