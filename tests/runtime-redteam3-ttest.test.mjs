// ttest after the third red-team review of 13 November 2026: the by prefix,
// the unpaired and reverse options, the r() they leave and the return codes
// of the errors around them. Every expected value below was recorded from
// Stata 19 MP (version 17, set processors 1) running the same commands; the
// printed tables are compared in tests/runtime-output.test.mjs (cases
// ttest-by-prefix, ttest-unpaired-reverse, ttest-hypothesis-echo,
// ttest-long-names, ttest-large-numbers and ttest-constant-and-level).
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

// Stata's r() in the order its return list shows them, to 1 part in 10^12.
function same(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), label);
  for (const [name, value] of Object.entries(expected)) {
    const got = actual[name];
    assert.ok(
      got === value ||
        Math.abs(got - value) <= 1e-12 * Math.max(1e-300, Math.abs(value)),
      `${label} r(${name}): ${got} vs ${value}`,
    );
  }
}

// The numbers each display line shows, with the rc of the whole run.
function codes(source) {
  const { result } = run(source);
  return {
    rc: result.rc,
    lines: result.output
      .filter((o) => /^display\b/.test(o.command))
      .flatMap((o) => o.lines),
  };
}

const BY = `clear
set obs 20
set seed 61
generate g = _n > 9
generate y = invnormal(runiform())
generate k = mod(_n, 2)
`;

test("by g: ttest runs once per group and leaves the last group's r()", () => {
  const { session, result } = run(BY + "by g, sort: ttest y == 0, level(90)\n");
  assert.equal(result.rc, 0);
  const lines = result.output.at(-1).lines;
  assert.deepEqual(
    lines.filter((line) => line.startsWith("->")),
    ["-> g = 0", "-> g = 1"],
  );
  assert.equal(lines.filter((line) => line === "One-sample t test").length, 2);
  same(
    session.results.r,
    {
      ub_1: 0.5434113585883119,
      lb_1: -0.1367391565376261,
      level: 90,
      sd_1: 0.6223041231748587,
      se: 0.1876317529147379,
      p_u: 0.1519676984037873,
      p_l: 0.8480323015962127,
      p: 0.3039353968075746,
      t: 1.083697710364307,
      df_t: 10,
      mu_1: 0.2033361010253429,
      N_1: 11,
    },
    "by g: ttest y == 0, level(90)",
  );
});

test("by refuses in with ttest, and ttesti with any by, as r(190)", () => {
  const { lines, rc } = codes(
    BY +
      `sort g
capture by g: ttest y in 1/5, by(k)
display _rc
capture by g: ttest y == 0 in 1/5
display _rc
capture by g: ttesti 10 1 1 0
display _rc
`,
  );
  assert.equal(rc, 0);
  assert.deepEqual(lines, ["190", "190", "190"]);
});

const SAMPLES = `clear
set obs 25
set seed 607
generate a = invnormal(runiform())
generate b = (1+(3)*invnormal(runiform()))
`;

test("ttest a == b, unpaired is the two-sample test of two variables", () => {
  const { session, result } = run(SAMPLES + "ttest a == b, unpaired\n");
  assert.equal(result.rc, 0);
  same(
    session.results.r,
    {
      ub_diff: -0.0627274486122624,
      lb_diff: -2.269437168568563,
      mu_diff: -1.166082308590412,
      ub_combined: 1.454311765060654,
      lb_combined: 0.3126656175396534,
      se_combined: 0.2840516061373965,
      mu_combined: 0.8834886913001537,
      N_combined: 50,
      ub_2: 2.552623456585309,
      lb_2: 0.3804362346054113,
      se_2: 0.5262340074180908,
      ub_1: 0.6216124572423961,
      lb_1: -0.0207173832325009,
      se_1: 0.1556108067559824,
      level: 95,
      sd: 2.008548169066834,
      sd_2: 2.631170037090454,
      sd_1: 0.7780540337799122,
      se: 0.5487594680208724,
      p_u: 0.980616680690938,
      p_l: 0.019383319309062,
      p: 0.038766638618124,
      t: -2.124942486725458,
      df_t: 48,
      mu_2: 1.46652984559536,
      N_2: 25,
      mu_1: 0.3004475370049476,
      N_1: 25,
    },
    "ttest a == b, unpaired",
  );
});

test("unpaired samples of one observation each have missing statistics", () => {
  const { session } = run(`clear
input y g
0 0
1 1
2 2
end
ttest y == g if _n == 1, unpaired
`);
  same(
    session.results.r,
    {
      ub_diff: _,
      lb_diff: _,
      mu_diff: 0,
      ub_combined: _,
      lb_combined: _,
      se_combined: _,
      mu_combined: 0,
      N_combined: 2,
      ub_2: _,
      lb_2: _,
      se_2: _,
      ub_1: _,
      lb_1: _,
      se_1: _,
      level: 95,
      sd: _,
      sd_2: _,
      sd_1: _,
      se: _,
      p_u: _,
      p_l: _,
      p: _,
      t: _,
      df_t: 0,
      mu_2: 0,
      N_2: 1,
      mu_1: 0,
      N_1: 1,
    },
    "ttest y == g if _n == 1, unpaired",
  );
});

test("ttest y, by(g) reverse puts the larger group first", () => {
  const { session } = run(`clear
set obs 24
set seed 33
generate y = runiform()
generate g = cond(_n<10, 1.5, 2.25)
ttest y, by(g) reverse
`);
  same(
    session.results.r,
    {
      ub_diff: 0.2091226184746909,
      lb_diff: -0.2352296119975997,
      mu_diff: -0.0130534967614544,
      ub_combined: 0.6157253800753831,
      lb_combined: 0.4057910985450864,
      se_combined: 0.0507416694944917,
      mu_combined: 0.5107582393102348,
      N_combined: 24,
      ub_2: 0.7104580684711552,
      lb_2: 0.3273752811011323,
      se_2: 0.0830620339143724,
      ub_1: 0.6480964774367952,
      lb_1: 0.3636298786125836,
      se_1: 0.0663158253514658,
      level: 95,
      sd: 0.248582397916903,
      sd_2: 0.2491861017431171,
      sd_1: 0.2568400871762267,
      se: 0.1071310094502019,
      // Stata's p-values come from 1 - p/2; the runtime takes each tail
      // directly, which agrees to about 1 part in 10^14 here.
      p_u: 0.547936484769137,
      p_l: 0.4520635152308629,
      p: 0.9041270304617257,
      t: -0.1218461099960241,
      df_t: 22,
      mu_2: 0.5189166747861438,
      N_2: 9,
      mu_1: 0.5058631780246894,
      N_1: 15,
    },
    "ttest y, by(g) reverse",
  );
});

test("ttest option errors return Stata's codes", () => {
  const { lines, rc } = codes(`clear
input y g
0 0
1 1
2 2
end
generate str3 s = "a"
generate m = .
capture ttest y
display _rc
capture ttest y == 0, by(g)
display _rc
capture ttest y == 0, reverse
display _rc
capture ttest y == 0, unpaired
display _rc
capture ttest y == 0, welch
display _rc
capture ttest y == g, unequal
display _rc
capture ttest s == y, unpaired
display _rc
capture ttest y == s, unpaired
display _rc
capture ttest m == y, unpaired
display _rc
capture ttest y == m, unpaired
display _rc
`);
  assert.equal(rc, 0);
  assert.deepEqual(lines, [
    "100",
    "198",
    "198",
    "198",
    "198",
    "198",
    "2000",
    "109",
    "2000",
    "2000",
  ]);
});

test("ttest error messages are not preceded by a blank line", () => {
  const { result } = run(`clear
input y g
0 0
1 1
2 2
end
capture noisily ttest y if g == 0, by(g)
capture noisily ttest y == g if g == 9, unpaired
`);
  const [first, second] = result.output.slice(-2).map((o) => o.lines);
  assert.deepEqual(first, ["1 group found, 2 required"]);
  assert.deepEqual(second, ["first sample has no observations"]);
});
