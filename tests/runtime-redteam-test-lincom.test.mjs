// test and lincom: the stored results, the return codes of the refusals and
// r(mtest), which the output fixture cannot compare. Every expected value
// was recorded from Stata 19 MP (version 17, set processors 1) on the same
// data, made by the do-file lines in DATA.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";

const DATA = `clear
set seed 4242
set obs 600
generate byte reg = 1 + floor(runiform()*4)
generate double education = 8 + floor(runiform()*10)
generate byte female = runiform() < .5
generate double wage = 2 + .5*education + .8*(reg==2) - .3*(reg==3) + 1.5*female + 6*(runiform()+runiform()+runiform()-1.5)
generate byte union = runiform() < invlogit(-1 + .1*education - .3*(reg==2))
generate int hours = floor(runiform()*2*(20 + education + 3*(reg==3)))
generate byte satisfaction = 1 + floor(5*runiform()*(.6 + .04*education))
replace satisfaction = 5 if satisfaction > 5
generate byte sat3 = cond(satisfaction<=2,1,cond(satisfaction==3,2,3))`;

function fitted(model) {
  const session = new Session(),
    out = session.run(`${DATA}\nquietly ${model}`);
  assert.equal(out.rc, 0);
  return session;
}
/** Runs one command and returns its return code. */
const rc = (session, command) => session.run(command).rc;
const close = (actual, expected, digits = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= digits * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );
function sameResults(actual, expected, digits) {
  assert.deepEqual(
    Object.keys(actual).filter((k) => !k.startsWith("matrix:")),
    Object.keys(expected),
  );
  for (const [key, value] of Object.entries(expected))
    if (typeof value === "string") assert.equal(actual[key], value);
    else close(actual[key], value, digits);
}
function sameMatrix(matrix, colNames, values) {
  assert.deepEqual(matrix.colNames, colNames);
  assert.equal(matrix.values.length, values.length);
  matrix.values.forEach((row, i) =>
    row.forEach((v, j) =>
      values[i][j] === null
        ? assert.ok(v > 8.98e307, `row ${i + 1} column ${j + 1} is missing`)
        : close(v, values[i][j], 1e-6),
    ),
  );
}

test("test, notest leaves no results and accum tests the constraints together", () => {
  const s = fitted("regress wage education i.reg");
  assert.equal(rc(s, "test 2.reg, notest"), 0);
  assert.deepEqual(s.results.r, {});
  assert.equal(rc(s, "test 3.reg, accum"), 0);
  sameResults(s.results.r, {
    drop: 0,
    df_r: 595,
    F: 7.674179908795385,
    df: 2,
    p: 0.0005121618294418,
  });
  // A new model starts again.
  s.run("quietly regress wage education i.reg");
  s.run("test education, accum");
  assert.equal(s.results.r.df, 1);
});

test("test drops a constraint that the others imply, as Stata numbers it", () => {
  const s = fitted("regress wage education i.reg");
  s.run("test (2.reg=0) (2.reg=1)");
  sameResults(s.results.r, {
    dropped_1: 2,
    drop: 1,
    df_r: 595,
    F: 11.95534184835303,
    df: 1,
    p: 0.0005838138510217,
  });
  s.run(
    "test (.01*2.reg=0) (3.reg=0) (4.reg=0) (10*2.reg+10*3.reg+10*4.reg=0)",
  );
  assert.equal(s.results.r.dropped_1, 1);
  s.run(
    "test (3.reg=0) (.01*2.reg=0) (4.reg=0) (10*2.reg+10*3.reg+10*4.reg=0)",
  );
  assert.equal(s.results.r.dropped_1, 2);
});

test("test, mtest stores r(mtest) and r(mtmethod)", () => {
  const s = fitted("regress wage education i.reg");
  assert.equal(
    rc(s, "test (2.reg=3.reg) (3.reg=4.reg) (2.reg=4.reg), mtest"),
    0,
  );
  sameResults(s.results.r, {
    dropped_1: 2,
    drop: 1,
    df_r: 595,
    F: 5.643517252874989,
    df: 2,
    p: 0.0037325766283364,
    mtmethod: "noadjust",
  });
  sameMatrix(
    s.results.r["matrix:mtest"],
    ["F", "df", "p"],
    [
      [11.142009, 1, 0.00089663],
      [1.7092576, 1, 0.19158669],
      [4.0361926, 1, 0.04498538],
    ],
  );
  s.run("test 2.reg 3.reg 4.reg, mtest(holm)");
  assert.equal(s.results.r.mtmethod, "holm");
  sameMatrix(
    s.results.r["matrix:mtest"],
    ["F", "df", "p", "adjustp"],
    [
      [11.955342, 1, 0.00058381, 0.00175144],
      [0.01636518, 1, 0.8982504, 0.8982504],
      [2.0468623, 1, 0.1530452, 0.3060904],
    ],
  );
  // The matrix can be listed, as in Stata.
  const listed = s.run("matrix list r(mtest)");
  assert.equal(listed.rc, 0);
});

test("test after logit reports chi2, and an F test with df()", () => {
  const s = fitted("logit union education i.reg");
  s.run("test 2.reg 3.reg, mtest(s)");
  sameResults(
    s.results.r,
    {
      drop: 0,
      chi2: 6.9856204907868,
      df: 2,
      p: 0.0304152775629622,
      mtmethod: "sidak",
    },
    1e-6,
  );
  sameMatrix(
    s.results.r["matrix:mtest"],
    ["chi2", "df", "p", "adjustp"],
    [
      [6.0997586, 1, 0.01352004, 0.02685728],
      [0.19086263, 1, 0.66219962, 0.8858909],
    ],
  );
  s.run("test 2.reg, df(100)");
  sameResults(
    s.results.r,
    {
      drop: 0,
      df_r: 100,
      F: 6.099758551449458,
      df: 1,
      p: 0.0152134962225237,
    },
    1e-6,
  );
});

test("test after mlogit counts only the constraints it could test", () => {
  const s = fitted("mlogit sat3 education wage");
  s.run("test education wage, mtest(sidak)");
  sameResults(
    s.results.r,
    {
      dropped_2: 6,
      dropped_1: 3,
      drop: 1,
      chi2: 3.473124192261246,
      df: 4,
      p: 0.4819766196882124,
      mtmethod: "sidak",
    },
    1e-6,
  );
  sameMatrix(
    s.results.r["matrix:mtest"],
    ["chi2", "df", "p", "c1"],
    [
      [0.94349074, 1, 0.33138173, 0.80014594],
      [2.4186484, 1, 0.11989834, 0.40002747],
      [null, 1, null, null],
      [0.199172, 1, 0.65539002, 0.985897],
      [0.01755877, 1, 0.89458131, 0.9998765],
      [null, 1, null, null],
    ],
  );
});

test("test refuses what Stata refuses, with its return codes, and clears r()", () => {
  const s = fitted("regress wage education i.reg");
  s.run("test 2.reg, mtest(sidak)");
  assert.equal(rc(s, "test 2.reg, accum mtest"), 198);
  assert.equal(rc(s, "test 2.reg, mtest notest"), 198);
  assert.equal(rc(s, "test 2.reg, mtest(foo)"), 198);
  // noadjust may be shortened to noadj and no further.
  assert.equal(rc(s, "test 2.reg, mtest(noad)"), 198);
  assert.deepEqual(s.results.r, {});
  assert.equal(rc(s, "test 2.reg, mtest(noadj)"), 0);
  assert.equal(rc(s, "test 2.reg, df(0)"), 125);
  // coef is an option of Stata's this runtime does not have.
  assert.equal(rc(s, "test 2.reg, coef"), 198);
});

test("lincom with eform reports exp(b) in r()", () => {
  const s = fitted("regress wage education i.reg");
  assert.equal(rc(s, "lincom education, eform"), 0);
  sameResults(s.results.r, {
    df: 595,
    ub: 1.778952646169592,
    lb: 1.493261860514594,
    p: 1.37144336989e-25,
    t: 10.96048766466958,
    level: 95,
    se: 0.0726405956433545,
    estimate: 1.629859545539605,
  });
  s.run("lincom education, df(9) eform");
  sameResults(s.results.r, {
    df: 9,
    ub: 1.802753237178163,
    lb: 1.473547285009831,
    p: 1.65952510056e-6,
    t: 10.96048766466958,
    level: 95,
    se: 0.0726405956433545,
    estimate: 1.629859545539605,
  });
});

test("lincom allows a constant term", () => {
  const s = fitted("regress wage education i.reg");
  assert.equal(rc(s, "lincom 2.reg + 1"), 0);
  sameResults(s.results.r, {
    df: 595,
    ub: 2.978606305694273,
    lb: 1.545119748660655,
    p: 1.0704260382e-9,
    t: 6.197764717642881,
    level: 95,
    se: 0.3649481918438637,
    estimate: 2.261863027177464,
  });
});

test("lincom after logit: or, and t with df()", () => {
  const s = fitted("logit union education i.reg");
  s.run("lincom education, or");
  sameResults(
    s.results.r,
    {
      ub: 1.179283105082303,
      lb: 1.051874981392052,
      p: 0.0002208228931595,
      z: 3.6939204687236,
      level: 95,
      se: 0.0324849733644603,
      estimate: 1.113758678625854,
    },
    1e-6,
  );
  s.run("lincom education, df(100)");
  sameResults(
    s.results.r,
    {
      df: 100,
      ub: 0.1656069429686279,
      lb: 0.0498740410897355,
      p: 0.0003602472151176,
      t: 3.6939204687236,
      level: 95,
      se: 0.0291669766421393,
      estimate: 0.1077404920291817,
    },
    1e-6,
  );
});

test("lincom refuses what Stata refuses, with its return codes, and clears r()", () => {
  const s = fitted("regress wage education i.reg");
  s.run("lincom education");
  assert.equal(rc(s, "lincom education, or irr"), 198);
  assert.deepEqual(s.results.r, {});
  assert.equal(rc(s, "lincom education, eform(foo)"), 198);
  assert.equal(rc(s, "lincom education + 1, or"), 198);
  assert.equal(rc(s, "lincom education, cformat(abc)"), 7);
  assert.equal(rc(s, "lincom education, cformat(%9s)"), 7);
  assert.equal(rc(s, "lincom education, df(0)"), 125);
  assert.equal(rc(s, "lincom education, df(-2)"), 125);
  // Abbreviations Stata does not take.
  assert.equal(rc(s, "lincom education, o"), 198);
  assert.equal(rc(s, "lincom education, cf(%9.3f)"), 198);
  assert.equal(rc(s, "lincom education, d(9)"), 198);
});
