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
function sameResults(actual, expected) {
  assert.deepEqual(
    Object.keys(actual)
      .filter((k) => !k.startsWith("matrix:"))
      .sort(),
    Object.keys(expected).sort(),
  );
  for (const [key, value] of Object.entries(expected))
    close(actual[key], value);
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
