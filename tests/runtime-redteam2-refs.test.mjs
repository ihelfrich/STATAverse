// test and lincom references to equations and ancillary parameters:
// [eq]_b[name], _b[/name], [/]lnalpha, [depvar]name and [/]var(e.depvar)
// after tobit, factor levels after mlogit, test [eq]: varlist and
// test [eq=eq]. The stored results and the return codes of the refusals,
// which the output fixture cannot compare. Every expected value was
// recorded from Stata 19 MP (version 17, set processors 1) on the data the
// do-file lines in DATA make.
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
const close = (actual, expected, digits) =>
  assert.ok(
    Math.abs(actual - expected) <= digits * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );
/** The scalars and macros of r(), in any order, against Stata's. */
function sameResults(actual, expected, digits = 1e-7) {
  assert.deepEqual(
    Object.keys(actual)
      .filter((k) => !k.startsWith("matrix:"))
      .sort(),
    Object.keys(expected).sort(),
  );
  for (const [key, value] of Object.entries(expected))
    if (typeof value === "string") assert.equal(actual[key], value);
    else if (value === null)
      assert.ok(actual[key] > 8.98e307, `r(${key}) is not missing`);
    else close(actual[key], value, digits);
}
/** The message and return code of a command Stata refuses. */
function refused(session, command, message, code) {
  const out = session.run(command);
  assert.equal(out.rc, code, command);
  assert.ok(
    out.output.at(-1).lines.join("\n").includes(message),
    `${command}: ${out.output.at(-1).lines.join(" | ")}`,
  );
}

test("after mlogit an unqualified factor level is tested in every equation", () => {
  const s = fitted("mlogit sat3 education i.female");
  assert.equal(rc(s, "test 1.female"), 0);
  sameResults(s.results.r, {
    dropped_1: 3,
    drop: 1,
    chi2: 0.0644099652302670689,
    df: 2,
    p: 0.9683080754131317969,
  });
});

test("test [eq=eq] and test [eq]: varlist after mlogit", () => {
  const s = fitted("mlogit sat3 education i.female");
  assert.equal(rc(s, "test [2=3]"), 0);
  sameResults(s.results.r, {
    dropped_1: 2,
    drop: 1,
    chi2: 2.744975224880462417,
    df: 2,
    p: 0.2534756255018562054,
  });
  // Both coefficients belong to the base outcome, so nothing is tested.
  assert.equal(rc(s, "test [3]: education 1.female"), 0);
  sameResults(s.results.r, {
    dropped_2: 2,
    dropped_1: 1,
    drop: 1,
    chi2: null,
    df: 0,
    p: null,
  });
  refused(s, "test [2]:", "last test not found", 302);
  refused(s, "test [9]: education", "equation 9 not found", 303);
  refused(s, "test [2=3] [1=2]", ": expected,  found", 198);
});

test("[eq]_b[name] names the coefficient of that equation", () => {
  const s = fitted("mlogit sat3 education i.female");
  assert.equal(rc(s, "lincom [2]_b[education]"), 0);
  sameResults(s.results.r, {
    ub: 0.0118733610304172788,
    lb: -0.1403514825577725778,
    p: 0.0980840078202811494,
    z: -1.654214154925977454,
    level: 95,
    se: 0.0388335818384725473,
    estimate: -0.0642390607636776495,
  });
  const r = fitted("regress wage education");
  refused(
    r,
    "lincom [nosuch]_b[education]",
    "equation [nosuch] not found",
    303,
  );
  refused(r, "lincom _b[/x]", "[/x] not found", 111);
});

test("testparm after mlogit takes equal and df(), and refuses what Stata refuses", () => {
  const s = fitted("mlogit sat3 education i.female i.reg");
  assert.equal(rc(s, "testparm i.reg, equal"), 0);
  sameResults(s.results.r, {
    drop: 0,
    chi2: 0.1399022180184827657,
    df: 2,
    p: 0.9324394066779627677,
  });
  assert.equal(rc(s, "testparm i.reg, df(100)"), 0);
  sameResults(s.results.r, {
    dropped_3: 9,
    dropped_2: 6,
    dropped_1: 3,
    drop: 1,
    df_r: 100,
    F: 0.5761538730996916824,
    df: 6,
    p: 0.7485078646065694841,
  });
  refused(
    s,
    "testparm i.reg, nosvyadjust",
    "option nosvyadjust is allowed only with survey data",
    198,
  );
  refused(s, "testparm i.reg, bogus", "option bogus not allowed", 198);
  refused(s, "test i.reg", "i:  operator invalid", 198);
  refused(s, "test nosuch", "nosuch not found", 111);
});

test("_b[/cut#] after ologit", () => {
  const s = fitted("ologit satisfaction education i.reg");
  assert.equal(rc(s, "lincom _b[/cut2] - _b[/cut1]"), 0);
  sameResults(
    s.results.r,
    {
      ub: 1.140136453020902385,
      lb: 0.8073491187274055569,
      p: 1.87107983196927e-30,
      z: 11.46979222974793977,
      level: 95,
      se: 0.084896288125312705,
      estimate: 0.973742785874153971,
    },
    1e-6,
  );
});

test("[/]lnalpha after nbreg", () => {
  const s = fitted("nbreg hours education i.reg");
  assert.equal(rc(s, "lincom [/]lnalpha"), 0);
  sameResults(
    s.results.r,
    {
      ub: -0.631229741469570782,
      lb: -0.8725870484003283023,
      p: 2.68605917932891e-34,
      z: -12.2118811523581563,
      level: 95,
      se: 0.0615718729615832711,
      estimate: -0.7519083949349495422,
    },
    1e-6,
  );
  assert.equal(rc(s, "test [hours]education [/]lnalpha, mtest(holm)"), 0);
  sameResults(
    s.results.r,
    {
      drop: 0,
      chi2: 167.7746961670681287,
      df: 2,
      p: 3.69987989105266e-37,
      mtmethod: "holm",
    },
    1e-6,
  );
});

test("[/]var(e.depvar) and [depvar]name after tobit", () => {
  const s = fitted("tobit wage education i.female, ll(4)");
  assert.equal(rc(s, "lincom [/]var(e.wage)"), 0);
  // tobit's variance comes from a numerical Hessian, good to about the
  // seventh digit.
  sameResults(
    s.results.r,
    {
      df: 598,
      ub: 11.10387198037994239,
      lb: 8.707741427793173727,
      p: 2.15944733038772e-49,
      t: 16.23817957813054491,
      level: 95,
      se: 0.6100318484855052903,
      estimate: 9.905806704086558057,
    },
    2e-6,
  );
  assert.equal(rc(s, "test _b[/var(e.wage)] = 50"), 0);
  sameResults(
    s.results.r,
    {
      drop: 0,
      df_r: 598,
      F: 4319.743314657305746,
      df: 1,
      p: 8.6521609854689e-276,
    },
    2e-6,
  );
  // sigma is not a parameter of tobit's "/" equation.
  refused(s, "lincom [/]sigma", "[sigma] not found", 111);
});

// The second round, after the fixes above were checked again. Every value
// below was recorded from Stata 19 MP (version 17, set processors 1).
// Maximum-likelihood fits reach Stata's estimates by other steps, so their
// statistics are compared to 1e-6.

test("testparm after mlogit tests interactions and lists in every equation", () => {
  const s = fitted("mlogit sat3 c.education##i.female");
  assert.equal(rc(s, "testparm i.female c.education#i.female"), 0);
  sameResults(
    s.results.r,
    {
      dropped_2: 6,
      dropped_1: 3,
      drop: 1,
      chi2: 1.605299279981514,
      df: 4,
      p: 0.8078393736312565,
    },
    1e-6,
  );
  const m = fitted("mlogit sat3 education i.female i.reg");
  assert.equal(rc(m, "testparm i.(reg female)"), 0);
  sameResults(
    m.results.r,
    {
      dropped_4: 12,
      dropped_3: 9,
      dropped_2: 6,
      dropped_1: 3,
      drop: 1,
      chi2: 3.522124508141468,
      df: 8,
      p: 0.8974658001573222,
    },
    1e-6,
  );
  // equation(3) is the base outcome, whose coefficients are all omitted.
  refused(
    m,
    "testparm i.reg, equation(3)",
    "identify any testable coefficients from\nequation(3)",
    111,
  );
  refused(m, "testparm i.reg, eq(3) equal", "from\nequation(3)", 111);
  refused(m, "testparm _cons", "variable _cons not found", 111);
  refused(m, "testparm i.reg, equation(9)", "equation 9 not found", 303);
});

test("test [eq=eq] keeps repeated constraints and [eq]: takes an expression", () => {
  const s = fitted("mlogit sat3 education i.female i.reg");
  assert.equal(rc(s, "test [2=3=3]"), 0);
  sameResults(
    s.results.r,
    {
      dropped_9: 14,
      dropped_8: 13,
      dropped_7: 12,
      dropped_6: 11,
      dropped_5: 10,
      dropped_4: 9,
      dropped_3: 8,
      dropped_2: 4,
      dropped_1: 2,
      drop: 1,
      chi2: 5.489015254931129,
      df: 5,
      p: 0.3591519016472509,
    },
    1e-6,
  );
  assert.equal(rc(s, "test [2]: education = 0 = 1"), 0);
  sameResults(
    s.results.r,
    {
      dropped_1: 2,
      drop: 1,
      chi2: 3.124563754195991,
      df: 1,
      p: 0.0771205109841262,
    },
    1e-6,
  );
  refused(s, "test [2]: educ", "educ ambiguous abbreviation", 111);
  refused(s, "test educ", "educ ambiguous abbreviation", 111);
  refused(s, "test [2]: education 1.female = 0", "=exp required", 100);
  refused(s, "test [2=3]: education = 0", "equation [2=3] not found", 303);
  refused(s, "test [2=3] education", "invalid syntax", 198);
  refused(s, "test [9]education", "equation 9 not found", 303);
  refused(s, "test [9]education = 0", "equation [9] not found", 303);
  const o = fitted("ologit satisfaction education i.female");
  refused(
    o,
    "test [satisfaction=/]",
    "variables differ between equations",
    111,
  );
  refused(o, "test [satisfaction] [/]", "[satisfaction]cut1 not found", 111);
  const n = fitted("nbreg hours education");
  refused(n, "test [hours] [/]", "[hours]lnalpha not found", 111);
});

test("_b[] is not a name of test's list, and [eq]name() is not found", () => {
  const s = fitted("regress wage education i.female i.reg");
  refused(s, "test _b[education] _b[1.female]", "_b not found", 111);
  refused(s, "test _coef[education]", "_coef not found", 111);
  refused(s, "test 2*education", "2 not found", 111);
  refused(s, "test education+1.female", "+ not found", 111);
  refused(s, "test [#2]", "equation #2 not found", 303);
  refused(s, "test [wage]education", "equation wage not found", 303);
  refused(s, "lincom _b[education](1)", "invalid syntax", 198);
  const o = fitted("ologit satisfaction education i.female");
  refused(o, "test _b[/cut1] _b[/cut2]", "_b not found", 111);
  refused(o, "lincom _b[/education]", "[/education] not found", 111);
  refused(o, "lincom _b[cut1]", "[cut1] not found", 111);
  refused(o, "lincom [/]cut1()", "[cut1()] not found", 111);
  refused(
    o,
    "lincom [satisfaction]education(1)",
    "[education(1)] not found",
    111,
  );
  const n = fitted("nbreg hours education");
  refused(n, "lincom _b[lnalpha]", "[lnalpha] not found", 111);
  refused(n, "lincom [/]lnalpha()", "[lnalpha()] not found", 111);
  const t = fitted("tobit wage education i.female, ll(4)");
  refused(t, "lincom _b[var(e.wage)]", "[var(e.wage)] not found", 111);
  refused(t, "lincom [/]var(e.wage)()", "[var(e.wage)()] not found", 111);
  refused(t, "test [/]: var(e.wage)", "var not found", 111);
  assert.equal(rc(t, "test ([/]var(e.wage) = 50) (education = 0)"), 0);
  sameResults(
    t.results.r,
    {
      drop: 0,
      df_r: 598,
      F: 2241.511407646505,
      df: 2,
      p: 1.4264667402e-278,
    },
    2e-6,
  );
  // [wage] [/] is [wage]_cons, as Stata reads it.
  assert.equal(rc(t, "test [wage] [/]"), 0);
  sameResults(
    t.results.r,
    {
      drop: 0,
      df_r: 598,
      F: 15.967260238927,
      df: 1,
      p: 0.0000724919850987,
    },
    2e-6,
  );
});

test("[#1] names regress's one equation", () => {
  const s = fitted("regress wage education i.female i.reg");
  assert.equal(rc(s, "lincom [#1]_b[education]"), 0);
  sameResults(s.results.r, {
    df: 594,
    ub: 0.5568305890762956,
    lb: 0.3859784962327479,
    p: 4.25616810729e-25,
    t: 10.83770583153106,
    level: 95,
    se: 0.043496709541887,
    estimate: 0.4714045426545217,
  });
  assert.equal(rc(s, "test [#1]: education"), 0);
});

test("testparm after a one-equation model takes equal, df() and interactions", () => {
  const s = fitted("regress wage education i.female i.reg");
  assert.equal(rc(s, "testparm i.reg, equal"), 0);
  sameResults(s.results.r, {
    drop: 0,
    df_r: 594,
    F: 5.920966546973007,
    df: 2,
    p: 0.0028435003370848,
  });
  assert.equal(rc(s, "testparm i.reg, df(100)"), 0);
  sameResults(s.results.r, {
    drop: 0,
    df_r: 100,
    F: 5.668897467812022,
    df: 3,
    p: 0.0012560993064994,
  });
  refused(
    s,
    "testparm i.reg, nosuchoption",
    "option nosuchoption not allowed",
    198,
  );
  refused(
    s,
    "testparm i.reg, df(0)",
    "df() invalid -- invalid number, outside of allowed range",
    125,
  );
  refused(s, "testparm i.reg, equation(wage)", "from\nequation(wage)", 111);
  const l = fitted("logit union c.education##i.female");
  assert.equal(rc(l, "testparm i.female education, eq(#1) equal"), 0);
  sameResults(
    l.results.r,
    {
      drop: 0,
      chi2: 0.3582077898014268,
      df: 1,
      p: 0.5495032717899028,
    },
    1e-6,
  );
  refused(
    l,
    "testparm i.female, equation(nosuch)",
    "equation nosuch not found",
    303,
  );
});

test("interactions are named with their factors first, base levels marked", () => {
  const names = (model) => fitted(model).estimates.names.join(" ");
  assert.equal(
    names("regress wage c.education##i.female"),
    "education 0b.female 1.female 0b.female#co.education 1.female#c.education _cons",
  );
  assert.equal(
    names(
      "regress wage c.education#i.female#i.union c.hours#c.education#i.reg",
    ),
    "0b.female#0b.union#c.education 0b.female#1.union#c.education 1.female#0b.union#c.education 1.female#1.union#c.education 1b.reg#c.hours#c.education 2.reg#c.hours#c.education 3.reg#c.hours#c.education 4.reg#c.hours#c.education _cons",
  );
  assert.equal(
    names("regress wage i.female##i.union"),
    "0b.female 1.female 0b.union 1.union 0b.female#0b.union 0b.female#1o.union 1o.female#0b.union 1.female#1.union _cons",
  );
});
