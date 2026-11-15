// Recheck, manage group: gsort's mfirst and generate(), xtile's weights,
// cutpoints() and altdef, pctile and _pctile with weights and altdef,
// order, sequential, collapse's se* abbreviations and name conflicts,
// destring, generate() keeping the label, contract, zero and split on a
// number. tools/output-cases.txt compares their printed text with Stata's
// (the recheck-manage-* cases); this file checks what text cannot: the
// doubles found, the return codes, the sort order recorded and r() left
// behind. Values were recorded from Stata 19 MP (version 17, set
// processors 1) in batch mode.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";

const run = (source) => {
  const session = new Session(),
    result = session.run(source);
  return { session, output: result.output };
};
const DATA = [
  "clear",
  "input id x y str2 s",
  '1 3 2 "b"',
  '2 . 1 "a"',
  '3 5 2 ""',
  '4 .a 1 "c"',
  '5 1 2 "a"',
  '6 4 . "b"',
  '7 .b 1 "a"',
  "end",
].join("\n");
/** The return code of a command run on DATA, as capture leaves it. */
const rcOf = (command) => {
  const { output } = run(`${DATA}\ncapture ${command}\ndisplay _rc`);
  return Number(output.at(-1).lines.join("").trim());
};

test("the return codes of manage commands' refusals match Stata's", () => {
  // Stata 19: capture <command>, then display _rc, on DATA.
  const expected = {
    "gsort x, gen(id)": 110,
    "gsort x, gen(1a)": 198,
    "gsort x, bogus": 198,
    "gsort , mfirst": 100,
    "gsort -": 198,
    "gsort x -": 198,
    "gsort zz": 111,
    "xtile q = x, nq(1)": 198,
    "xtile q = x [iw=y], nq(2)": 101,
    "xtile q = x, cutpoints(zz)": 111,
    "xtile q = x, cutpoints(s)": 109,
    "xtile q = s": 109,
    "xtile q = x, nq(3) altdef cut(y)": 198,
    "xtile q = x [fw=y], altdef": 198,
    "xtile q = x if x > 100": 2000,
    "xtile q = x, nq(2.5)": 198,
    "xtile q = x, nq(abc)": 111,
    "pctile p = x, nq(9)": 198,
    "pctile p = x, genp(a b)": 198,
    "pctile p = x [fw=-y]": 402,
    "pctile p = x if x>100": 2000,
    "_pctile x, nq(3) p(50)": 198,
    "_pctile x, p(0)": 198,
    "_pctile x, p(50 20)": 198,
    "_pctile x, nq(1)": 198,
    "_pctile x [fw=y], altdef": 198,
    // "no observations", said but not an error.
    "_pctile s": 0,
    "_pctile x if x > 100": 0,
    "order id, before(x) after(y)": 198,
    "order id, first last": 198,
    "order id, before(id)": 198,
    "order id, sequential alphabetic": 198,
    "order id, before(zz)": 111,
    "split x": 109,
    "contract id, zero": 102,
    "collapse (mean) x (sd) x": 198,
    "collapse (sem2) x": 198,
    "collapse (count) id, by(id)": 198,
  };
  for (const [command, rc] of Object.entries(expected))
    assert.equal(rcOf(command), rc, command);
});

test("_pctile, altdef interpolates as Stata does to the last digit", () => {
  // Stata 19: display %21.0g r(r2) and r(r3) after _pctile x, nq(7)
  // altdef; and r(r1), r(r4), r(r6) after _pctile x [aw=w], nq(7).
  const setup =
    "clear\nset seed 12345\nset obs 37\ngenerate x = round(runiform()*100, .01)\ngenerate w = runiform()*3\n";
  let { session } = run(`${setup}_pctile x, nq(7) altdef`);
  assert.equal(session.results.r.r2, 25.3214285714285765);
  assert.equal(session.results.r.r3, 41.9900011335100487);
  ({ session } = run(`${setup}_pctile x [aw=w], nq(7)`));
  assert.equal(session.results.r.r1, 2.670000076293945312);
  assert.equal(session.results.r.r4, 61.61999893188476562);
  assert.equal(session.results.r.r6, 88.220001220703125);
});

test("gsort leaves the data sorted by its leading ascending names, or by generate()", () => {
  // Stata 19: describe, short says "Sorted by: g" after gsort y -x,
  // gen(g), and nothing after gsort -x.
  let { session } = run(`${DATA}\ngsort y -x, gen(g)`);
  assert.deepEqual(session.data.sortedBy, ["g"]);
  assert.equal(session.data.get("g").type, "byte");
  ({ session } = run(`${DATA}\ngsort id -x, mfirst`));
  assert.deepEqual(session.data.sortedBy, ["id"]);
  ({ session } = run(`${DATA}\ngsort -x, mfirst`));
  assert.deepEqual(session.data.sortedBy, []);
  assert.deepEqual(
    Array.from(session.data.get("id").data),
    [7, 4, 2, 3, 6, 1, 5],
  );
  // More than 100 groups need an int.
  ({ session } = run("clear\nset obs 250\ngenerate k = _n\ngsort -k, gen(g)"));
  assert.equal(session.data.get("g").type, "int");
});

test("xtile leaves r(N), the number of distinct quantiles or cutpoints it used", () => {
  // Stata 19: return list after each xtile.
  const setup =
    "clear\nset obs 10\ngenerate x = _n\nreplace x = 3 in 1/5\ngenerate c = 3 in 1\nreplace c = 3 in 2\nreplace c = 8 in 3\nreplace c = 1 in 4\n";
  let { session } = run(`${setup}xtile q1 = x, nq(4)`);
  assert.deepEqual(session.results.r, { N: 3 });
  assert.deepEqual(
    Array.from(session.data.get("q1").data),
    [1, 1, 1, 1, 1, 3, 3, 3, 4, 4],
  );
  ({ session } = run(`${setup}xtile q2 = x, cut(c)`));
  assert.deepEqual(session.results.r, { N: 2 });
  ({ session } = run(`${setup}capture xtile q3 = x in 1/2, nq(5)`));
  assert.deepEqual(session.results.r, { N: 2 });
});

test("order, sequential puts numbered names in aorder's order", () => {
  // Stata 19: order _all, sequential; describe, simple.
  const names = [
    "v01",
    "v1",
    "v1a",
    "v1b",
    "x10",
    "x9",
    "xa",
    "x",
    "x_2",
    "x2_",
    "b2c10",
    "b2c9",
    "b10c1",
    "v001",
    "a1E5",
    "a1E3",
  ];
  const { session } = run(
    `clear\nset obs 1\n${names.map((name) => `generate ${name} = 1`).join("\n")}\norder _all, sequential`,
  );
  assert.deepEqual(session.data.names, [
    "a1E3",
    "a1E5",
    "b2c9",
    "b2c10",
    "b10c1",
    "v1",
    "v01",
    "v001",
    "v1a",
    "v1b",
    "x",
    "x2_",
    "x9",
    "x10",
    "x_2",
    "xa",
  ]);
});
