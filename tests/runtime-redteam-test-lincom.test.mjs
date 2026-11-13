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

// The second round of findings. Expected values recorded from Stata 19 MP
// (version 17, set processors 1) on DATA with age added, as in the output
// cases test-lincom-options and test-lincom-equations, which compare the
// printed text.
const AGE = "generate double age = 20 + floor(runiform()*40)";
function withAge(model) {
  const session = new Session(),
    out = session.run(`${DATA}\n${AGE}\nquietly ${model}`);
  assert.equal(out.rc, 0);
  return session;
}
const missing = (value) => value > 8.98e307;
const linesOf = (session, command) =>
  session.run(command).output.flatMap((o) => o.lines);

test("lincom and test refuse division by zero and nonlinear terms with r(131)", () => {
  const s = withAge("regress wage education female");
  for (const command of [
    "lincom education/0",
    "lincom education*(1/0)",
    "lincom education + 1/0",
    "test education/0 = 1",
    "test education = 1/0",
    "lincom education*female",
    "test education^2 = 0",
  ]) {
    assert.equal(rc(s, command), 131, command);
    assert.deepEqual(s.results.r, {});
  }
  assert.equal(rc(s, "lincom education = 1"), 198);
  s.run("quietly logit union education");
  assert.equal(rc(s, "lincom education/0"), 131);
});

test("a coefficient named twice in a list is tested once", () => {
  const s = withAge("regress wage education female");
  s.run("test education education");
  sameResults(s.results.r, {
    drop: 0,
    df_r: 597,
    F: 116.8385346276878,
    df: 1,
    p: 5.39374250928e-25,
  });
  s.run("quietly regress wage education age i.reg");
  s.run("test education 2.reg 2.reg, mtest");
  sameResults(s.results.r, {
    drop: 0,
    df_r: 594,
    F: 68.00434848789496,
    df: 2,
    p: 2.54769845176e-27,
    mtmethod: "noadjust",
  });
  assert.equal(s.results.r["matrix:mtest"].values.length, 2);
  // In parentheses each is its own constraint, and the repeat is dropped.
  s.run("test (education) (education)");
  assert.equal(s.results.r.dropped_1, 2);
});

test("test takes Stata's abbreviations of accumulate, notest and mtest", () => {
  const s = withAge("regress wage education female");
  assert.equal(rc(s, "test education, a"), 0);
  assert.equal(rc(s, "test education, acc"), 0);
  assert.equal(s.results.r.dropped_1, 2);
  assert.equal(rc(s, "test education, not"), 0);
  assert.deepEqual(s.results.r, {});
  assert.equal(rc(s, "test education, notes"), 0);
  assert.equal(rc(s, "test education, mt"), 0);
  assert.equal(s.results.r.mtmethod, "noadjust");
  assert.equal(rc(s, "test education female, mtes(b)"), 0);
  assert.equal(s.results.r.mtmethod, "bonferroni");
  assert.equal(rc(s, "test education female, mtest (holm)"), 0);
  assert.equal(s.results.r.mtmethod, "holm");
  assert.equal(rc(s, "test education female, mtest,"), 0);
  assert.equal(s.results.r.mtmethod, "noadjust");
  // An empty mtest() is no option at all.
  assert.equal(rc(s, "test education, mtest()"), 0);
  sameResults(s.results.r, {
    drop: 0,
    df_r: 597,
    F: 116.8385346276878,
    df: 1,
    p: 5.39374250928e-25,
  });
  assert.equal(rc(s, "test education, mtest() accum"), 0);
  assert.equal(rc(s, "test education, mtest(b) mtest(h)"), 198);
  assert.equal(rc(s, "test education, nottest"), 198);
});

test("test with no constraints replays the last test, or says there is none", () => {
  const s = withAge("regress wage education age i.reg");
  assert.equal(rc(s, "test"), 302);
  s.run("test education age");
  assert.equal(rc(s, "test"), 0);
  // _test, which replays, stores its results in another order.
  sameResults(s.results.r, {
    p: 1.30789109394e-24,
    df: 2,
    F: 60.41438950100269,
    df_r: 594,
    drop: 0,
  });
  assert.equal(rc(s, "test, notest"), 0);
  assert.deepEqual(s.results.r, {});
  assert.equal(rc(s, "test, accum"), 0);
  assert.equal(s.results.r.df, 2);
  s.run("test 2.reg, accum");
  s.run("test");
  assert.equal(s.results.r.df, 3);
  // Only accumulate and notest go with a replay.
  for (const option of ["mtest", "mtest(b)", "df(5)", "coef"])
    assert.equal(rc(s, `test, ${option}`), 198, option);
  s.run("quietly regress wage education female i.reg");
  s.run("test (education) (education) (female)");
  s.run("test");
  sameResults(s.results.r, {
    p: 1.53868386825e-31,
    df: 2,
    F: 80.14071581934081,
    df_r: 594,
    drop: 1,
    dropped_1: 2,
  });
  s.run("quietly logit union education female");
  s.run("test education");
  s.run("test");
  sameResults(
    s.results.r,
    { p: 0.0002247092580168, df: 1, chi2: 13.61229303306681, drop: 0 },
    1e-6,
  );
});

test("lincom becomes the test that test accumulates to and replays", () => {
  const s = withAge("regress wage education female");
  s.run("test education, notest");
  s.run("lincom education + female");
  assert.ok(
    linesOf(s, "test female, accum").includes(" ( 1)  education + female = 0"),
  );
  assert.equal(s.results.r.df, 2);
  s.run("lincom education");
  s.run("test");
  sameResults(s.results.r, {
    p: 5.39374250928e-25,
    df: 1,
    F: 116.8385346276878,
    df_r: 597,
    drop: 0,
  });
});

test("df() is Stata's numlist: one positive number, with its return codes", () => {
  const s = withAge("regress wage education female");
  s.run("test education, df(2.5)");
  sameResults(s.results.r, {
    drop: 0,
    df_r: 2.5,
    F: 116.8385346276878,
    df: 1,
    p: 0.0036688988982587,
  });
  assert.equal(rc(s, "test education, df(.)"), 127);
  assert.equal(rc(s, "test education, df(abc)"), 121);
  assert.equal(rc(s, "test education, df(1 2)"), 123);
  assert.equal(rc(s, "test education, df(-1)"), 125);
  assert.equal(rc(s, "lincom education, df(.)"), 127);
});

test("an omitted coefficient has no test or interval in lincom", () => {
  const s = withAge("regress wage education female");
  s.run("generate double educ2 = education");
  s.run("quietly regress wage education educ2 female");
  const omitted = (estimate) =>
    assert.deepEqual(
      Object.entries(s.results.r).map(([k, v]) => [k, missing(v) ? "." : v]),
      [
        ["df", 597],
        ["ub", "."],
        ["lb", "."],
        ["p", "."],
        ["t", "."],
        ["level", 95],
        ["se", 0],
        ["estimate", estimate],
      ],
    );
  assert.ok(
    linesOf(s, "lincom educ2").includes("         (1) |          0  (omitted)"),
  );
  omitted(0);
  s.run("lincom educ2, eform");
  omitted(1);
  assert.ok(linesOf(s, "lincom 0*female").includes(" ( 1) = 0"));
  omitted(0);
  s.run("test educ2 = 0");
  assert.equal(s.results.r.dropped_1, 1);
  assert.equal(s.results.r.df, 0);
  assert.ok(missing(s.results.r.F));
});

test("lincom and test name equations by label, outcome value or number after mlogit", () => {
  const s = withAge("regress wage education female");
  s.run('label define sl 1 "low" 2 "mid" 3 "high"');
  s.run("label values sat3 sl");
  s.run("quietly mlogit sat3 education i.female, baseoutcome(1)");
  assert.equal(rc(s, "lincom [3]education, rrr"), 0);
  close(s.results.r.estimate, 1.041081, 1e-6);
  close(s.results.r.se, 0.0329047, 1e-5);
  assert.equal(rc(s, "lincom [high]education"), 0);
  close(s.results.r.estimate, 0.0402596, 1e-5);
  // The base outcome's coefficients are zero, and omitted.
  assert.equal(rc(s, "lincom [1]education"), 0);
  assert.equal(s.results.r.estimate, 0);
  assert.ok(missing(s.results.r.lb));
  assert.equal(rc(s, "lincom [#2]education"), 0);
  assert.equal(rc(s, "lincom [foo]education"), 303);
  assert.equal(rc(s, "lincom [#7]education"), 303);
  assert.equal(rc(s, "lincom [2]foo"), 111);
  s.run("quietly mlogit sat3 education female");
  s.run("test [1]");
  sameResults(
    s.results.r,
    { drop: 0, chi2: 1.640599964918273, df: 2, p: 0.4402995525503245 },
    1e-6,
  );
});

test("test and lincom take abbreviations, a=b=c, [depvar] and cut points", () => {
  const s = withAge("regress wage education female");
  assert.equal(rc(s, "lincom educ"), 0);
  close(s.results.r.estimate, 0.4744254, 1e-6);
  assert.equal(rc(s, "test educ ed"), 0);
  assert.equal(s.results.r.df, 1);
  s.run("generate double educ2 = education");
  s.run("quietly regress wage education educ2 female");
  assert.equal(rc(s, "test educ"), 111);
  s.run("quietly regress wage education age i.reg");
  s.run("test 2.reg=3.reg=4.reg");
  sameResults(s.results.r, {
    drop: 0,
    df_r: 594,
    F: 5.638959754305264,
    df: 2,
    p: 0.0037496376488985,
  });
  s.run("quietly logit union education");
  assert.equal(rc(s, "lincom [union]education, or"), 0);
  close(s.results.r.estimate, 1.110265, 1e-6);
  s.run("quietly ologit sat3 education i.reg");
  assert.equal(rc(s, "lincom /cut1"), 0);
  close(s.results.r.estimate, -0.0836615, 1e-5);
  assert.equal(rc(s, "lincom [/]cut1 - [/]cut2"), 0);
  close(s.results.r.estimate, -0.7939168, 1e-5);
});

test("return list shows the matrices test stores", () => {
  const s = withAge("regress wage education i.reg");
  s.run("test 2.reg 3.reg 4.reg, mtest");
  const lines = linesOf(s, "return list");
  assert.ok(lines.includes("matrices:"));
  assert.ok(lines.includes("              r(mtest) :  3 x 3"));
});
