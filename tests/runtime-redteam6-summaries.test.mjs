// Sixth red-team round, summaries group: what the recorded output cases in
// tools/output-cases.txt cannot compare, namely return codes and the r()
// results of correlate, pwcorr and ci means with weights. The values were
// recorded from Stata 19 MP (version 17, set processors 1).
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { abbreviateAmong } from "../src/runtime/format.js";

const DATA = `clear
set seed 99
set obs 40
generate id = _n
generate y = 100*runiform()
generate x = y + 50*runiform()
generate z = runiform()
generate w = 1 + floor(4*runiform())
generate str5 name = "n" + string(_n)
replace y = . in 4
replace x = . in 9`;

const run = (source) => {
  const session = new Session(),
    result = session.run(source);
  return { session, result, r: session.results.r };
};
const rc = (command, data = DATA) =>
  Number(
    run(`${data}\ncapture ${command}\ndisplay _rc`).result.output.at(-1)
      .lines[0],
  );
const close = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} vs ${expected}`,
  );

test("return codes Stata 19 gives for weights, refusals and empty data", () => {
  // summarize refuses importance weights with detail as Stata does.
  assert.equal(rc("summarize y [iw=w], detail"), 101);
  assert.equal(rc("correlate y x [iw=w]"), 101);
  assert.equal(rc("correlate y x in 1/1"), 2001);
  assert.equal(rc("pwcorr y"), 102);
  assert.equal(rc("pwcorr name y"), 102);
  assert.equal(rc("pwcorr y x z, sidak bonferroni"), 198);
  assert.equal(rc("pwcorr y x z, star(100)"), 198);
  assert.equal(rc("pwcorr y x if id > 100"), 2000);
  assert.equal(rc("pwcorr y x z if id > 100"), 0);
  assert.equal(rc("pwcorr"), 0);
  assert.equal(rc("correlate name y x"), 0);
  // One-way tables refuse the two-way options; the abbreviations work.
  assert.equal(rc("tabulate id, row"), 198);
  assert.equal(rc("tabulate id, chi2"), 198);
  assert.equal(rc("tabulate w id, ch"), 0);
  assert.equal(rc("tabulate w id, r co ce nof"), 0);
  assert.equal(rc("tabulate w, su(y) nost noo nofr"), 0);
  assert.equal(rc("tabulate w, su(y) nom"), 198);
  assert.equal(rc("list y in 1/2, cl"), 198);
  assert.equal(rc("list y in 1/2, c"), 0);
  assert.equal(rc("codebook y if id > 100"), 2000);
  assert.equal(rc("codebook", `${DATA}\ndrop if _n > 0`), 2000);
  assert.equal(rc("codebook y", `${DATA}\ndrop if _n > 0`), 2000);
});

test("corr is correlate, not corrgram", () => {
  const { result } = run(`${DATA}\ncorr y x`);
  assert.equal(result.rc ?? 0, 0);
  assert.equal(result.output.at(-1).lines[0], "(obs=38)");
});

test("summarize with no variables in memory prints nothing", () => {
  const { result } = run("clear\nsummarize\nsummarize, detail");
  for (const entry of result.output.slice(1))
    assert.deepEqual(
      entry.lines.filter((line) => line.trim()),
      [],
      entry.command,
    );
});

test("correlate and pwcorr with frequency and analytic weights", () => {
  let { r } = run(`${DATA}\ncorrelate y x [fw=w]`);
  assert.equal(r.N, 96);
  close(r.rho, 0.8469815979381559723, "fw rho");
  ({ r } = run(`${DATA}\ncorrelate y x [aw=w], covariance`));
  assert.equal(r.N, 38);
  close(r.Var_1, 585.6181778071121471, "aw Var_1");
  close(r.cov_12, 643.2099024765600461, "aw cov_12");
  close(r.Var_2, 984.7884482306850487, "aw Var_2");
  ({ r } = run(`${DATA}\npwcorr y x z [fw=w], sig`));
  assert.equal(r.N, 96);
  close(r.rho, 0.8469815979381559723, "pwcorr rho");
  close(r["matrix:sig"].values[2][0], 0.9293826382952965481, "sig[3,1]");
  close(r["matrix:sig"].values[1][0], 1.55337114531e-27, "sig[2,1]");
  assert.equal(r["matrix:Nobs"].values[2][2], 103);
  assert.equal(r["matrix:Nobs"].values[1][0], 96);
});

test("ci means with analytic and frequency weights", () => {
  let { r } = run(`${DATA}\nci means y [aw=w], level(90)`);
  assert.equal(r.N, 39);
  close(r.mean, 46.33383445858955696, "aw mean");
  close(r.se, 3.878480770552222623, "aw se");
  close(r.lb, 39.79489250480611418, "aw lb");
  close(r.ub, 52.87277641237299974, "aw ub");
  ({ r } = run(`${DATA}\nci means y [fw=w]`));
  assert.equal(r.N, 100);
  close(r.mean, 46.33383445858955696, "fw mean");
  close(r.se, 2.402900808653733122, "fw se");
});

test("two observations correlate as Stata computes them", () => {
  // Stata 19: r(rho) is 1 - 2^-52 for 3, 7 against 5, 9, so pwcorr's
  // significance level is min(2 ttail(0, .), 1) = 1, not 0.
  const data = `clear
set obs 3
generate a = cond(_n == 1, 3, cond(_n == 2, 7, 2))
generate b = cond(_n == 1, 5, cond(_n == 2, 9, 1))`;
  let { r } = run(`${data}\ncorrelate a b in 1/2`);
  assert.equal(r.rho, 1 - 2 ** -52);
  ({ r } = run(`${data}\npwcorr a b in 1/2, sig`));
  assert.equal(r["matrix:sig"].values[1][0], 1);
});

test("correlate splits a wide matrix at the default linesize of 79", () => {
  // Stata 19 fits seven columns in 79; the eighth starts a second panel.
  const { result } = run(
    `${DATA}\ngenerate a1 = z\ngenerate a2 = z\ngenerate a3 = z\ncorrelate id y x z w a1 a2 a3`,
  );
  const lines = result.output.at(-1).lines,
    headers = lines.filter((line) => /^ {13}\|/.test(line));
  assert.deepEqual(headers, [
    "             |       id        y        x        z        w       a1       a2",
    "             |       a3",
  ]);
  assert.ok(lines.every((line) => line.length <= 79));
});

test("pwcorr and correlate abbreviate names as abbrev() does", () => {
  // Stata 19 keeps a name's trailing digits: mea~2019, measure~2019.
  const data = `clear
set seed 2
set obs 10
generate measurement_2019 = runiform()
generate x_variable_123456 = runiform()
generate v12345678901 = runiform()`;
  for (const command of ["pwcorr", "correlate"]) {
    const { result } = run(
      `${data}\n${command} measurement_2019 x_variable_123456 v12345678901`,
    );
    const lines = result.output.at(-1).lines.map((line) => line.trimEnd());
    for (const expected of [
      "             | mea~2019 x~123456 v12345~1",
      "measure~2019 |   1.0000",
      "x_var~123456 |   0.2410   1.0000",
      "v12345678901 |  -0.3070  -0.3297   1.0000",
    ])
      assert.ok(lines.includes(expected), `${command}: ${expected}`);
  }
});

// Seventh round, summaries group. The values below were recorded from
// Stata 19 MP (version 17, set processors 1), the exact ones with %21x.
const bits = (x) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16);
};

test("correlate rounds its moments as Stata does near a correlation of -1", () => {
  const line = (n) => `clear
set obs ${n}
generate y = _n
generate yy = -y`;
  // Stata 19: 1, ..., 6 has variance 3.5 - 2^-51 and correlates with its
  // negative at -(1 - 2^-53); 1, ..., 10 has variance one ulp above
  // 82.5/9 and correlates at exactly -1; 1, ..., 8 at -(1 + 2^-52).
  const expected = {
    4: ["3ffaaaaaaaaaaaaa", "bff0000000000000"],
    5: ["4004000000000000", "bfeffffffffffffe"],
    6: ["400bffffffffffff", "bfefffffffffffff"],
    7: ["4012aaaaaaaaaaab", "bfeffffffffffffe"],
    8: ["4018000000000000", "bff0000000000001"],
    10: ["4022555555555556", "bff0000000000000"],
    12: ["4029ffffffffffff", "bff0000000000000"],
    17: ["4039800000000000", "bff0000000000001"],
  };
  for (const [n, [variance, rho]] of Object.entries(expected)) {
    let { r } = run(`${line(n)}\ncorrelate y yy, covariance`);
    assert.equal(bits(r.Var_1), variance, `Var_1 at ${n}`);
    assert.equal(bits(-r.cov_12), variance, `cov_12 at ${n}`);
    ({ r } = run(`${line(n)}\ncorrelate y yy`));
    assert.equal(bits(r.rho), rho, `rho at ${n}`);
  }
  // pwcorr's significance level follows: 0 where 1 - rho^2 > 0, 1 where
  // rho is exactly -1 or beyond it.
  const sig = (n) =>
    run(`${line(n)}\npwcorr y yy, sig`).r["matrix:sig"].values[1][0];
  assert.ok(sig(6) < 1e-15);
  assert.equal(sig(10), 1);
  assert.equal(sig(8), 1);
});

test("correlate's covariances of floats and with frequency weights", () => {
  const data = `clear
set seed 5
set obs 25
generate a = runiform()*10
generate b = 3*a + runiform()
generate w = 1 + floor(4*runiform())`;
  let { r } = run(`${data}\ncorrelate a b, covariance`);
  assert.deepEqual([r.Var_1, r.cov_12, r.Var_2].map(bits), [
    "4021feaa46079c1a",
    "403b27b6a0fa3a52",
    "40548446838d1a79",
  ]);
  ({ r } = run(`${data}\ncorrelate a b`));
  assert.equal(bits(r.rho), "3feffa871794f2a3");
  ({ r } = run(`${data}\ncorrelate a b [fw=w], covariance`));
  assert.deepEqual([r.Var_1, r.cov_12, r.Var_2].map(bits), [
    "4020db7a48f0c762",
    "40393fec3ec6cdfe",
    "4052efb3e83cbf69",
  ]);
});

const SIGNS = `clear
set seed 2468
set obs 40
generate income = 20000 + 60000*runiform()
generate score = 100*runiform()
generate age = 18 + 50*runiform()
generate w = 1 + floor(4*runiform())
generate aw = runiform()*3
replace income = . in 3
replace score = . in 5
generate double wneg = aw - 1
generate wfneg = w - 2`;

test("correlate and pwcorr leave out observations with negative weights", () => {
  let { r } = run(`${SIGNS}\ncorrelate income score [aw=wneg]`);
  assert.equal(r.N, 24);
  close(r.sum_w, 25.08999371528625, "sum_w");
  close(r.rho, -0.3071672454600947, "rho");
  ({ r } = run(`${SIGNS}\npwcorr income score [aw=wneg]`));
  assert.equal(r.N, 24);
  ({ r } = run(`${SIGNS}\ncorrelate income score [fw=wfneg]`));
  assert.equal(r.N, 20);
  assert.equal(r.sum_w, undefined);
  close(r.rho, 0.0902208080334092, "fw rho");
  assert.equal(rc("correlate income score [aw=wneg]", SIGNS), 0);
  assert.equal(rc("pwcorr income score [aw=wneg]", SIGNS), 0);
  assert.equal(
    rc("correlate income score [aw=allneg]", `${SIGNS}\ngenerate allneg = -1`),
    2000,
  );
  assert.equal(
    rc("pwcorr income score [aw=allneg]", `${SIGNS}\ngenerate allneg = -1`),
    0,
  );
});

test("correlate returns the sum of analytic weights", () => {
  let { r } = run(`${SIGNS}\ncorrelate income score age [aw=aw]`);
  close(r.sum_w, 57.77826676145196, "sum_w");
  assert.equal(r.N, 38);
  ({ r } = run(`${SIGNS}\ncorrelate income score [aweight=aw], covariance`));
  close(r.sum_w, 57.77826676145196, "sum_w with covariance");
  close(r.cov_12, -147219.4036612877, "cov_12");
  close(r.Var_2, 1127.726907661468, "Var_2");
  ({ r } = run(`${SIGNS}\ncorrelate income score [fw=w]`));
  assert.equal(r.sum_w, undefined);
  assert.equal(r.N, 87);
});

test("pwcorr with frequency weights that are not whole numbers", () => {
  // Stata 19: each correlate fails under capture, so every cell is
  // missing, no observations are counted and pwcorr succeeds.
  assert.equal(rc("pwcorr income score [fw=aw]", SIGNS), 0);
  const { r } = run(`${SIGNS}\npwcorr income score age [fw=aw], sig obs`);
  assert.equal(r.N, 0);
  assert.ok(r.rho > 8e307);
  assert.ok(r["matrix:C"].values.flat().every((v) => v > 8e307));
  assert.ok(r["matrix:Nobs"].values.flat().every((v) => v === 0));
  assert.equal(rc("correlate income score [fw=aw]", SIGNS), 401);
});

test("by works with correlate and pwcorr", () => {
  const data = `clear
set seed 8
set obs 30
generate g = _n > 15
generate a = runiform()
generate b = a + runiform()
generate aw = runiform()`;
  assert.equal(rc("by g, sort: correlate a b [aw=aw]", data), 0);
  assert.equal(rc("by g, sort: pwcorr a b, sig obs", data), 0);
  const { result } = run(`${data}\nby g, sort: correlate a b [aw=aw]`),
    lines = result.output.at(-1).lines.map((line) => line.trimEnd());
  for (const expected of [
    "-> g = 0",
    "(sum of wgt is 5.995509973261505)",
    "           b |   0.5504   1.0000",
    "-> g = 1",
    "           b |   0.7123   1.0000",
  ])
    assert.ok(lines.includes(expected), expected);
});

test("tabulate, tab2 and summarize options as Stata 19 takes them", () => {
  const data = `clear
set obs 6
generate grp = mod(_n,2)
generate k = _n > 2
generate income = _n
generate score = _n^2
generate inx = 1`;
  assert.equal(rc("tabulate grp k, key", data), 0);
  assert.equal(rc("tabulate grp, key", data), 198);
  assert.equal(rc("tabulate grp k, key nokey", data), 198);
  assert.equal(rc("tabulate grp, summarize(income score)", data), 198);
  assert.equal(rc("tabulate grp, su(inc*)", data), 198);
  assert.equal(rc("tabulate grp, su(income-score)", data), 198);
  assert.equal(rc("tabulate grp, su(in)", data), 111);
  assert.equal(rc("tabulate grp, su(nosuch)", data), 111);
  assert.equal(rc("tabulate grp, su(inco)", data), 0);
  assert.equal(rc("tab2 grp k, firstonly", data), 0);
  assert.equal(rc("tab2 grp k, chi2 first", data), 0);
  // tab2.ado leaves its capture block before it records the failure.
  assert.equal(rc("tab2 grp k income, firs", data), 0);
  assert.equal(rc("summarize income, meanonly detail", data), 198);
  assert.equal(rc("summarize, meanonly detail", "clear"), 198);
});

test("abbrev() makes an abbreviation no other variable would match", () => {
  // display abbrev("name", w) for w = 5, ..., 14 with these variables in
  // memory, recorded from Stata 19.
  const sets = [
    {
      respondent_age_years:
        "res.. r~ag~s r~age~s r~age_~s r~e_years re~e_years res~e_years resp~e_years respo~e_years respondent_a~s",
      respondent_edu_years:
        "res.. r~ed~s r~edu~s r~edu_~s r~u_years re~u_years res~u_years resp~u_years respo~u_years respondent_e~s",
    },
    {
      household_income_2019:
        "hou.. hous.. house.. ~me_2019 h~me_2019 ho~me_2019 hou~me_2019 hous~me_2019 household_i~9 household_in~9",
      household_size_2019:
        "hou.. h~si~9 h~siz~9 h~size~9 h~ze_2019 ho~ze_2019 hou~ze_2019 hous~ze_2019 household_s~9 household_si~9",
      household_income_2020:
        "hou~0 h~2020 ho~2020 hou~2020 hous~2020 house~2020 househ~2020 househo~2020 househol~2020 household~2020",
    },
    {
      aaaa_pppp_zzzz_end:
        "aaa.. aaaa.. aaaa_.. aaaa_p~d aaaa_pp~d aaaa_ppp~d aaaa_pppp~d aaaa_pppp_~d aaaa_pppp_z~d aaaa_pppp_zz~d",
      aaaa_qqqq_zzzz_end:
        "a~q~d a~qq~d a~qqq~d aaaa_q~d aaaa_qq~d aaaa_qqq~d aaaa_qqqq~d aaaa_qqqq_~d aaaa_qqqq_z~d aaaa_qqqq_zz~d",
      aaaa_pppp_zzzz_x:
        "aaa~x aaaa~x aaaa_~x aaaa_p~x aaaa_pp~x aaaa_ppp~x aaaa_pppp~x aaaa_pppp_~x aaaa_pppp_z~x aaaa_pppp_zz~x",
    },
    {
      abcdefghijk1:
        "abc~1 abcd~1 abcde~1 abcdef~1 abcdefg~1 abcdefgh~1 abcdefghi~1 abcdefghijk1 abcdefghijk1 abcdefghijk1",
      abcdefghijk2:
        "ab~k2 abc~k2 abcd~k2 abcde~k2 abcdef~k2 abcdefg~k2 abcdefgh~k2 abcdefghijk2 abcdefghijk2 abcdefghijk2",
      abcdefghijkl12:
        "a~l12 ab~l12 abc~l12 abcd~l12 abcde~l12 abcdef~l12 abcdefg~l12 abcdefgh~l12 abcdefghi~l12 abcdefghijkl12",
      abcdefghijkm12:
        "a~m12 ab~m12 abc~m12 abcd~m12 abcde~m12 abcdef~m12 abcdefg~m12 abcdefgh~m12 abcdefghi~m12 abcdefghijkm12",
    },
    {
      y: "y y y y y y y y y y",
      变量名称很长的名字:
        "变~字 变~字 变量~字 变量~字 变量名~字 变量名~字 变量名称~字 变量名称~字 变量名称很~字 变量名称很~字",
      收入: "收入 收入 收入 收入 收入 收入 收入 收入 收入 收入",
    },
  ];
  for (const set of sets) {
    const names = Object.keys(set);
    for (const [name, shown] of Object.entries(set))
      shown
        .split(" ")
        .forEach((expected, k) =>
          assert.equal(
            abbreviateAmong(name, k + 5, names),
            expected,
            `${name} at ${k + 5}`,
          ),
        );
  }
});
