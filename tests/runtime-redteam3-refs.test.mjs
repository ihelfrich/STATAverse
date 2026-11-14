// Coefficient references in test, testparm and lincom: interactions of three
// terms written in any order, names abbreviated against the variables of
// the model rather than of the data, numeric scalars, and the return codes
// of the references Stata cannot find or refuses. The stored results and
// the return codes, which the output fixture cannot compare. Every expected
// value was recorded from Stata 19 MP (version 17, set processors 1) on the
// data the do-file lines in DATA make.
import assert from "node:assert/strict";
import test from "node:test";
import { Session } from "../src/runtime/session.js";
import { MISSING } from "../src/runtime/values.js";

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
generate byte sat3 = cond(satisfaction<=2,1,cond(satisfaction==3,2,3))
generate double experience = floor(runiform()*30)
replace wage = wage + .1*experience*female
generate exper = experience`;

function fitted(model) {
  const session = new Session(),
    out = session.run(`${DATA}\nquietly ${model}`);
  assert.equal(out.rc, 0);
  return session;
}
const close = (actual, expected, digits = 1e-7) =>
  assert.ok(
    Math.abs(actual - expected) <= digits * Math.max(1, Math.abs(expected)),
    `${actual} is not ${expected}`,
  );
/** The scalars of r() against Stata's, in any order. */
function sameResults(actual, expected, digits = 1e-7) {
  assert.deepEqual(
    Object.keys(actual)
      .filter((k) => !k.startsWith("matrix:"))
      .sort(),
    Object.keys(expected).sort(),
  );
  for (const [key, value] of Object.entries(expected))
    close(actual[key], value, digits);
}
/** The message and return code of a command Stata refuses. */
function refused(session, command, message, code) {
  const out = session.run(command);
  assert.equal(out.rc, code, command);
  assert.equal(out.output.at(-1).lines[0], message, command);
}

test("a three-way interaction is found whatever the order of its terms", () => {
  const s = fitted("regress wage i.reg##i.female##c.education");
  for (const order of [
    "c.education#1.female#2.reg",
    "1.female#c.education#2.reg",
    "2.reg#c.education#1.female",
    "1.female#2.reg#c.education",
  ]) {
    const out = s.run(`test ${order}`);
    assert.equal(out.rc, 0, order);
    assert.equal(
      out.output[0].lines.find((line) => line.trim()),
      " ( 1)  2.reg#1.female#c.education = 0",
    );
    sameResults(s.results.r, {
      drop: 0,
      df_r: 584,
      F: 0.2991782401516159,
      df: 1,
      p: 0.5846069862750399,
    });
  }
  assert.equal(s.run("testparm c.education#i.female#i.reg").rc, 0);
  sameResults(s.results.r, {
    drop: 0,
    df_r: 584,
    F: 0.6473275886916338,
    df: 3,
    p: 0.5848645181677694,
  });
  assert.equal(
    s.run("lincom c.education#1.female#2.reg - 1.female#3.reg#c.education").rc,
    0,
  );
  sameResults(s.results.r, {
    df: 584,
    ub: 0.3631439016509261,
    lb: -0.63006345684871,
    p: 0.5978216287331322,
    t: -0.5278245061269632,
    level: 95,
    se: 0.252848770850343,
    estimate: -0.133459777598892,
  });
});

test("names are abbreviated against the model's variables, and scalars scale", () => {
  const s = fitted("regress wage education i.reg i.female#c.experience");
  // exper is a variable of the data, but the model has only experience.
  assert.equal(s.run("lincom c.exper#1.fem").rc, 0);
  sameResults(s.results.r, {
    df: 593,
    ub: 0.1783616193433165,
    lb: 0.1144061281758744,
    p: 3.28439006924e-18,
    t: 8.990436768715853,
    level: 95,
    se: 0.0162821759971628,
    estimate: 0.1463838737595954,
  });
  assert.equal(s.run("scalar s = 2").rc, 0);
  assert.equal(s.run("lincom s*education").rc, 0);
  sameResults(s.results.r, {
    df: 593,
    ub: 1.133517921174015,
    lb: 0.7883686779248493,
    p: 1.74626729129e-25,
    t: 10.93594282881894,
    level: 95,
    se: 0.0878701831740659,
    estimate: 0.9609432995494323,
  });
});

test("what a linear expression cannot find is named as Stata names it", () => {
  const s = fitted("regress wage education i.reg i.female#c.experience");
  for (const [command, message, code] of [
    ["lincom 5.reg", "regressor I5.reg not found", 111],
    ["lincom 2b.reg", "regressor I2B.reg not found", 111],
    ["test 5.reg = 0", "regressor I5.reg not found", 111],
    ["lincom 5bn.reg", "regressor I5.reg not found", 111],
    ["lincom 5o.reg", "regressor I5O.reg not found", 111],
    ["lincom exper", "regressor experience not found", 111],
    ["test exper = 0", "regressor experience not found", 111],
    ["lincom c.experience", "regressor experience not found", 111],
    ["lincom reg", "regressor reg not found", 111],
    [
      "lincom c.education#1.female",
      "regressor I1.female#C.education not found",
      111,
    ],
    [
      "lincom 1.female#c.experience#2.reg",
      "regressor I1.female#I2.reg#C.experience not found",
      111,
    ],
    [
      "lincom co.education#1.female",
      "regressor I1.female#CO.education not found",
      111,
    ],
    ["lincom foo", "foo not found", 111],
    ["lincom uni", "uni not found", 111],
    ["lincom e", "e ambiguous abbreviation", 111],
    ["lincom 2.reg#1.union", "variable union not found", 111],
    ["lincom c.foo", "variable foo not found", 111],
    ["lincom 2n.reg", "2n:  operator invalid", 198],
    ["lincom ib2.reg", "ib2:  operator invalid", 198],
    ["lincom i.reg", "i:  operator invalid", 198],
    ["lincom ln(2)*education", "not possible with test", 131],
  ])
    refused(s, command, message, code);
  const m = fitted("mlogit sat3 education i.reg");
  refused(m, "lincom [2]5.reg", "[5.reg] not found", 111);
  refused(m, "lincom [2]exper", "[exper] not found", 111);
  refused(m, "lincom 5.reg", "regressor I5.reg not found", 111);
  refused(m, "lincom exper", "exper not found", 111);
  const n = fitted("nbreg hours education i.reg");
  refused(n, "lincom 1.female", "variable female not found", 111);
  const r = fitted("regress wage i.reg##i.female##c.education");
  refused(
    r,
    "test c.education#1.female#5.reg",
    "c.education#1.female#5.reg not found",
    111,
  );
});

// The third round: what a tester found in the fixes above. Recorded from
// Stata 19 MP in the same way.
const dot = MISSING;
/** The constraint line a command prints first. */
const constraintOf = (out) =>
  out.output
    .flatMap((o) => o.lines ?? [])
    .find((line) => line.startsWith(" ( 1)"));

test("a factor level alone written with o must be the base or omitted", () => {
  const s = fitted("regress wage education i.reg i.female#c.experience");
  refused(s, "lincom 2o.reg", "regressor I2O.reg not found", 111);
  refused(s, "lincom 2o.reg - 3.reg", "regressor I2O.reg not found", 111);
  refused(s, "test 2o.reg = 0", "regressor I2O.reg not found", 111);
  refused(s, "test 2o.reg", "2o.reg not found", 111);
  const base = s.run("lincom 1o.reg");
  assert.equal(base.rc, 0);
  assert.equal(constraintOf(base), " ( 1)  1b.reg = 0");
  sameResults(s.results.r, {
    df: 593,
    ub: dot,
    lb: dot,
    p: dot,
    t: dot,
    level: 95,
    se: 0,
    estimate: 0,
  });
  assert.equal(s.run("test 1o.reg").rc, 0);
  sameResults(s.results.r, {
    dropped_1: 1,
    drop: 1,
    df_r: 593,
    F: dot,
    df: 0,
    p: dot,
  });
  const m = fitted("mlogit sat3 i.reg i.female#c.education");
  refused(m, "lincom [2]2o.reg", "[2o.reg] not found", 111);
  // The list of test finds 2o.reg because equation 3 has it so.
  assert.equal(m.run("test [2]2o.reg").rc, 0);
  sameResults(
    m.results.r,
    {
      drop: 0,
      chi2: 1.372132865082522,
      df: 1,
      p: 0.2414457657800891,
    },
    1e-6,
  );
});

test("an unknown function is r(133), a known one not possible with test", () => {
  const s = fitted("regress wage education i.reg i.female#c.experience");
  refused(s, "lincom education(2)", "unknown function education()", 133);
  refused(s, "test foo(1)*education = 0", "unknown function foo()", 133);
  refused(s, "lincom abs(education)", "not possible with test", 131);
  const t = fitted("tobit wage education, ll(5)");
  refused(t, "lincom var(e.wage)", "unknown function var()", 133);
});

test("scalar(), e(), c(), r() and _se[] are constants", () => {
  const s = fitted("regress wage education i.reg i.female#c.experience");
  s.run("scalar s = 3");
  assert.equal(s.run("lincom scalar(s)*education").rc, 0);
  sameResults(s.results.r, {
    df: 593,
    ub: 1.700276881761023,
    lb: 1.182553016887274,
    p: 1.74626729129e-25,
    t: 10.93594282881894,
    level: 95,
    se: 0.1318052747610988,
    estimate: 1.441414949324148,
  });
  assert.equal(s.run("test scalar(s)*education = 1").rc, 0);
  sameResults(s.results.r, {
    drop: 0,
    df_r: 593,
    F: 11.2157544589028,
    df: 1,
    p: 0.0008625056554742,
  });
  assert.equal(s.run("lincom c(pi)*education").rc, 0);
  close(s.results.r.estimate, 1.509446205190416);
  close(s.results.r.se, 0.1380261609646174);
  assert.equal(s.run("test education = e(N)").rc, 0);
  close(s.results.r.F, 186201680.4114223);
  s.run('scalar str = "abc"');
  refused(s, "lincom str*education", "type mismatch", 109);
  refused(s, "lincom c(foo)*education", "c(foo) undefined", 133);
  refused(s, "lincom scalar(nosuch)*education", "nosuch not found", 111);
  // lincom and test clear r() before they read it, so r(mean) is missing.
  s.run("summarize education");
  const posted = s.run("lincom r(mean)*education");
  assert.equal(posted.rc, 504);
  assert.equal(constraintOf(posted), " ( 1)  .*education = 0");
  assert.ok(
    posted.output
      .at(-1)
      .lines.includes("estimates post: matrix has missing values"),
  );
  s.run("summarize education");
  assert.equal(s.run("test r(mean)*education = 0").rc, 0);
  sameResults(s.results.r, {
    dropped_1: 1,
    drop: 1,
    df_r: 593,
    F: dot,
    df: 0,
    p: dot,
  });
  s.run("summarize education");
  const level = s.run("test 2.reg + 3.reg = r(mean)");
  assert.equal(constraintOf(level), " ( 1)  2.reg + 3.reg = .");
  sameResults(s.results.r, { drop: 0, df_r: 593, F: dot, df: 1, p: dot });
  const se = s.run("lincom _se[education]");
  assert.equal(constraintOf(se), " ( 1) = -.0439351");
  sameResults(s.results.r, {
    df: 593,
    ub: dot,
    lb: dot,
    p: dot,
    t: dot,
    level: 95,
    se: 0,
    estimate: 0.0439350915870329,
  });
  assert.equal(s.run("lincom _b[education]/_se[education]").rc, 0);
  sameResults(s.results.r, {
    df: 593,
    ub: 12.89991530948081,
    lb: 8.971970348157072,
    p: 1.74626729129e-25,
    t: 10.93594282881894,
    level: 95,
    se: 1,
    estimate: 10.93594282881894,
  });
  assert.equal(s.run("test education = _se[education]").rc, 0);
  close(s.results.r.F, 98.72295989755851);
  refused(s, "test _se[education]", "_se not found", 111);
});

test("test's list and [eq] references unabbreviate against the model", () => {
  const s = fitted(
    "regress wage education experience i.reg i.female#c.experience",
  );
  assert.equal(s.run("test exper").rc, 0);
  sameResults(s.results.r, {
    drop: 0,
    df_r: 593,
    F: 2.320022567818329,
    df: 1,
    p: 0.1282512496910781,
  });
  assert.equal(s.run("test 2.re").rc, 0);
  close(s.results.r.F, 11.34524685638359);
  const r = fitted("regress wage i.reg##i.female##c.education");
  assert.equal(r.run("test 1.fem#2.reg").rc, 0);
  sameResults(r.results.r, {
    drop: 0,
    df_r: 584,
    F: 0.049636519901521,
    df: 1,
    p: 0.8237748662757053,
  });
  const m = fitted("mlogit sat3 i.reg i.female#c.education");
  for (const reference of ["[2]educ#1.female", "[2]1.fem#c.education"]) {
    assert.equal(m.run(`lincom ${reference}`).rc, 0, reference);
    sameResults(m.results.r, {
      ub: 0.0107661965874803,
      lb: -0.1430620684736407,
      p: 0.0918700869365298,
      z: -1.685614435664167,
      level: 95,
      se: 0.0392426254447783,
      estimate: -0.0661479359430802,
    });
  }
  assert.equal(m.run("lincom _b[2:2.re]").rc, 0);
  close(m.results.r.estimate, 0.3857275548931146);
  close(m.results.r.se, 0.3292930623842214);
  // 2.re fits 2.reg in each equation.
  refused(m, "test [2]2.re", "2.re ambiguous abbreviation", 111);
  refused(m, "lincom _b[9:2.reg]", "equation 9 not found", 111);
  const t = fitted("tobit wage education, ll(5)");
  assert.equal(t.run("lincom [/]var(e.wag)").rc, 0);
  close(t.results.r.estimate, 12.43095040747969, 1e-6);
  close(t.results.r.se, 0.7730568288275009, 1e-6);
  const n = fitted("nbreg hours education");
  refused(n, "lincom _b[lnalpha:_cons]", "equation lnalpha not found", 111);
});

test("[eq]: names the equation of the first coefficient only", () => {
  const m = fitted("mlogit sat3 i.reg i.female#c.education"),
    out = m.run("test [3]: 2.reg = 3.reg");
  assert.equal(constraintOf(out), " ( 1)  - [1]3.reg + [3]2o.reg = 0");
  sameResults(m.results.r, {
    drop: 0,
    chi2: 0.0216522042403596,
    df: 1,
    p: 0.8830160878302957,
  });
  const n = fitted("mlogit sat3 i.reg education");
  assert.equal(n.run("test [2]: education = 2.reg").rc, 0);
  sameResults(n.results.r, {
    drop: 0,
    chi2: 0.120267336789935,
    df: 1,
    p: 0.7287447219522605,
  });
  refused(n, "test [2]: 2o.reg = 0", "[:2o.reg] not found", 111);
});

test("duplicate factors, i2.reg, ## and spaces in a reference", () => {
  const s = fitted("regress wage education i.reg i.female#c.experience");
  refused(
    s,
    "lincom 2.reg#2.reg",
    "interaction with duplicate factor variables not allowed",
    198,
  );
  const crossed = s.run("lincom 2.reg##1.female");
  assert.equal(crossed.rc, 198);
  assert.match(
    crossed.output.at(-1).lines.join("\n"),
    /^invalid matrix stripe;\n2\.reg##1\.female/,
  );
  assert.equal(s.run("lincom i2.reg").rc, 0);
  sameResults(s.results.r, {
    df: 593,
    ub: 1.916392964632322,
    lb: 0.5047007422493291,
    p: 0.0008054523025817,
    t: 3.368270603200341,
    level: 95,
    se: 0.3593971494720858,
    estimate: 1.210546853440826,
  });
  assert.equal(s.run("lincom 1.female # c.experience").rc, 0);
  close(s.results.r.estimate, 0.1463838737595954);
});
