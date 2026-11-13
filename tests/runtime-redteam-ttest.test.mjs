// ttest and ttesti after the red-team review of 13 November 2026: groups and
// samples of one observation, string variables, the r() results Stata
// stores, and p-values far in the tail. Every expected value below was
// recorded from Stata 19 MP (version 17, set processors 1) running the same
// commands; the printed tables are compared in tests/runtime-output.test.mjs
// (case ttest-missing-statistics).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const MISSING = 2 ** 1023,
  _ = MISSING;

function run(source) {
  const session = new Session(),
    result = session.run(source);
  return { session, result };
}

// Stata's r() in the order its return list shows them. Values agree to
// 1 part in 10^12 unless a looser tolerance is named for one result.
function same(actual, expected, label, loose = {}) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), label);
  for (const [name, value] of Object.entries(expected)) {
    const tolerance = loose[name] ?? 1e-12,
      got = actual[name];
    assert.ok(
      got === value ||
        Math.abs(got - value) <= tolerance * Math.max(1e-300, Math.abs(value)),
      `${label} r(${name}): ${got} vs ${value}`,
    );
  }
}

const GROUPS = `clear
input y g
1 0
2 1
3 1
5 1
end
`;

test("ttest by() with a group of one observation reports missing statistics", () => {
  const equal = {
    ub_diff: _,
    lb_diff: _,
    mu_diff: -2.333333333333333,
    ub_combined: _,
    lb_combined: _,
    se_combined: _,
    mu_combined: 2.75,
    N_combined: 4,
    ub_2: 7.127916366930091,
    lb_2: -0.4612497002634242,
    se_2: 0.8819171036881971,
    ub_1: _,
    lb_1: _,
    se_1: _,
    level: 95,
    sd: _,
    sd_2: 1.527525231651947,
    sd_1: _,
    se: _,
    p_u: _,
    p_l: _,
    p: _,
    t: _,
    df_t: 2,
    mu_2: 3.333333333333333,
    N_2: 3,
    mu_1: 1,
    N_1: 1,
  };
  let { session, result } = run(GROUPS + "ttest y, by(g)");
  assert.equal(result.rc, 0);
  same(session.results.r, equal, "equal");
  ({ session, result } = run(GROUPS + "ttest y, by(g) unequal"));
  assert.equal(result.rc, 0);
  same(session.results.r, { ...equal, df_t: _ }, "unequal");
  ({ session, result } = run(GROUPS + "ttest y, by(g) welch"));
  assert.equal(result.rc, 0);
  assert.equal(session.results.r.df_t, MISSING);
});

test("paired and one-sample ttest on one observation, as Stata", () => {
  const { session, result } = run("clear\ninput a b\n1 2\nend\nttest a == b");
  assert.equal(result.rc, 0);
  same(session.results.r, {
    ub_diff: _,
    lb_diff: _,
    sd_diff: _,
    mu_diff: -1,
    ub_2: _,
    lb_2: _,
    se_2: _,
    ub_1: _,
    lb_1: _,
    se_1: _,
    level: 95,
    sd_2: _,
    sd_1: _,
    se: _,
    p_u: _,
    p_l: _,
    p: _,
    t: _,
    df_t: 0,
    mu_2: 2,
    N_2: 1,
    mu_1: 1,
    N_1: 1,
  });
  const one = run("clear\ninput a b\n1 2\nend\nttest a == 1");
  assert.equal(one.result.rc, 0);
  same(one.session.results.r, {
    ub_1: _,
    lb_1: _,
    level: 95,
    sd_1: _,
    se: _,
    p_u: _,
    p_l: _,
    p: _,
    t: _,
    df_t: 0,
    mu_1: 1,
    N_1: 1,
  });
});

test("ttesti with n = 1 has missing sd, se, interval and p-values", () => {
  const { session, result } = run("ttesti 1 5 0 3");
  assert.equal(result.rc, 0);
  same(session.results.r, {
    ub_1: _,
    lb_1: _,
    level: 95,
    sd_1: _,
    se: _,
    p_u: _,
    p_l: _,
    p: _,
    t: _,
    df_t: 0,
    mu_1: 5,
    N_1: 1,
  });
  const two = run("ttesti 1 5 0 3 4 2").session.results.r;
  same(two, {
    ub_diff: _,
    lb_diff: _,
    mu_diff: 1,
    ub_combined: _,
    lb_combined: _,
    se_combined: _,
    mu_combined: 4.25,
    N_combined: 4,
    ub_2: 8.968275423500657,
    lb_2: -0.968275423500657,
    se_2: 1.154700538379252,
    ub_1: _,
    lb_1: _,
    se_1: _,
    level: 95,
    sd: _,
    sd_2: 2,
    sd_1: _,
    se: _,
    p_u: _,
    p_l: _,
    p: _,
    t: _,
    df_t: 2,
    mu_2: 4,
    N_2: 3,
    mu_1: 5,
    N_1: 1,
  });
});

test("ttest refuses what Stata refuses, with Stata's return codes", () => {
  const numbers =
    'clear\nset obs 10\ngenerate x = _n\ngenerate g = _n > 5\ngenerate str3 s = "a"\ngenerate str3 s2 = "b"';
  for (const [line, code, message] of [
    ["ttest x == 1 if 0", 2000, "no observations"],
    ["ttest x == x if 0", 2000, "no observations"],
    ["ttest x if 0, by(g)", 2000, "no observations"],
    ["ttest s == 0", 2000, "no observations"],
    ["ttest s, by(g)", 2000, "no observations"],
    ["ttest x == s", 109, "type mismatch"],
    ["ttest s == x", 109, "type mismatch"],
    ["ttest s == s2", 109, "type mismatch"],
  ]) {
    const session = new Session();
    session.run(numbers);
    const result = session.run(line);
    assert.equal(result.rc, code, line);
    assert.match(JSON.stringify(result), new RegExp(message), line);
  }
});

test("r() of ttest and ttesti holds every result Stata stores", () => {
  const data = `clear
set obs 53
set seed 202
gen x = runiform()*10
gen g = runiform() < .3
`;
  let { session } = run(data + "ttest x == 4");
  same(session.results.r, {
    ub_1: 6.38349231075656,
    lb_1: 4.880011171000407,
    level: 95,
    sd_1: 2.727313019480035,
    se: 0.3746252544203795,
    p_u: 0.0000312812353998,
    p_l: 0.9999687187646003,
    p: 0.0000625624707996,
    t: 4.355690711249916,
    df_t: 52,
    mu_1: 5.631751740878483,
    N_1: 53,
  });
  ({ session } = run(data + "ttest x, by(g) welch level(90)"));
  same(session.results.r, {
    ub_diff: 0.6376506218789439,
    lb_diff: -1.8832189484203,
    mu_diff: -0.6227841632706781,
    ub_combined: 6.259132591168146,
    lb_combined: 5.004370890588821,
    se_combined: 0.3746252544203795,
    mu_combined: 5.631751740878483,
    N_combined: 53,
    ub_2: 7.033277246693889,
    lb_2: 5.052771356363972,
    se_2: 0.5692395472620315,
    ub_1: 6.244875547363334,
    lb_1: 4.595604729153171,
    se_1: 0.4876832339328856,
    level: 90,
    sd: 2.727313019480035,
    sd_2: 2.415078863931256,
    sd_1: 2.885172920826985,
    se: 0.749578947694184,
    p_u: 0.7946467013768449,
    p_l: 0.2053532986231551,
    p: 0.4107065972463102,
    t: -0.8308453234798743,
    df_t: 42.48016178966158,
    mu_2: 6.043024301528931,
    N_2: 18,
    mu_1: 5.420240138258253,
    N_1: 35,
  });
  ({ session } = run("ttesti 30 20 5 40 22 6, unequal"));
  same(session.results.r, {
    ub_diff: 0.6277304555533116,
    lb_diff: -4.627730455553312,
    mu_diff: -2,
    ub_combined: 22.48849733963701,
    lb_combined: 19.79721694607727,
    se_combined: 0.6745248198720964,
    mu_combined: 21.14285714285714,
    N_combined: 70,
    ub_2: 23.9188930929573,
    lb_2: 20.0811069070427,
    se_2: 0.9486832980505138,
    ub_1: 21.8670306837905,
    lb_1: 18.1329693162095,
    se_1: 0.9128709291752769,
    level: 95,
    sd: 5.643479536920808,
    sd_2: 6,
    sd_1: 5,
    se: 1.316561177208767,
    p_u: 0.9332865622211712,
    p_l: 0.0667134377788288,
    p: 0.1334268755576575,
    t: -1.5191090506255,
    df_t: 67.19008700237279,
    mu_2: 22,
    N_2: 40,
    mu_1: 20,
    N_1: 30,
  });
});

test("paired ttest stores the per-variable and difference results", () => {
  const { session } = run(`clear
set obs 1000
set seed 36
gen y = (1+(1)*invnormal(runiform()))
gen g = _n > 500
replace y = y + 3 if g
gen y2 = y + 1
ttest y == y2`);
  same(
    session.results.r,
    {
      ub_diff: -0.9999999917147642,
      lb_diff: -1.000000001710797,
      sd_diff: 8.05421259163e-8,
      mu_diff: -0.9999999967127811,
      ub_2: 3.551649345795595,
      lb_2: 3.335117172558821,
      se_2: 0.0551718896852193,
      ub_1: 2.551649349116875,
      lb_1: 2.335117175811979,
      se_1: 0.0551718897025769,
      level: 95,
      sd_2: 1.744688342208431,
      sd_1: 1.744688342757327,
      se: 2.54696565488e-9,
      p_u: 1,
      p_l: 0,
      p: 0,
      t: -392624060.2414122,
      df_t: 999,
      mu_2: 3.443383259177208,
      N_2: 1000,
      mu_1: 2.443383262464427,
      N_1: 1000,
    },
    "paired",
    // return list shows only 12 digits of these three.
    { sd_diff: 1e-11, se: 1e-11, t: 1e-11 },
  );
});

test("tiny ttest p-values keep their digits instead of becoming 0", () => {
  const data = `clear
set obs 1000
set seed 36
gen y = (1+(1)*invnormal(runiform()))
gen g = _n > 500
replace y = y + 3 if g
`;
  let { session } = run(data + "ttest y == 0");
  // Stata: r(p_u) = 3.4659373444e-238, r(p) = 6.9318746888e-238.
  assert.ok(Math.abs(session.results.r.p_u / 3.4659373444e-238 - 1) < 1e-10);
  assert.ok(Math.abs(session.results.r.p / 6.9318746888e-238 - 1) < 1e-10);
  assert.equal(session.results.r.p_l, 1);
  ({ session } = run(data + "ttest y, by(g) welch"));
  // Stata prints r(p_l) = 1.4420672295e-251; the value to 40 digits
  // (mpmath) is 1.44206722943086e-251, so Stata itself is 5e-11 out here.
  assert.ok(Math.abs(session.results.r.p_l / 1.4420672295e-251 - 1) < 1e-10);
  assert.equal(session.results.r.p_u, 1);
  ({ session } = run(data + "ttest y, by(g)"));
  assert.ok(Math.abs(session.results.r.p_l / 2.2868022347e-251 - 1) < 1e-10);
});

test("ttesti with a million observations keeps Stata's digits", () => {
  let { session } = run("ttesti 1000000 0.0001 0.5 0");
  same(session.results.r, {
    ub_1: 0.0010799831784082,
    lb_1: -0.0008799831784082,
    level: 95,
    sd_1: 0.5,
    se: 0.0005,
    p_u: 0.4207403108951348,
    p_l: 0.5792596891048651,
    p: 0.8414806217902696,
    t: 0.2,
    df_t: 999999,
    mu_1: 0.0001,
    N_1: 1000000,
  });
  ({ session } = run("ttesti 1000000 0.0001 0.5 1000000 0 .5, unequal"));
  const r = session.results.r;
  for (const [name, value] of Object.entries({
    p_u: 0.4437685491127058,
    p_l: 0.5562314508872942,
    p: 0.8875370982254116,
    ub_diff: 0.0014859046630755,
    lb_diff: -0.0012859046630755,
    ub_combined: 0.0007429521617641,
    sd: 0.4999998774999238,
  }))
    assert.ok(
      Math.abs(r[name] - value) <= 1e-12 * Math.abs(value),
      `${name}: ${r[name]} vs ${value}`,
    );
});
