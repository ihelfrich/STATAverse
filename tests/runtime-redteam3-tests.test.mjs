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
