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

test("order, sequential keeps a number past a long's range as a double", () => {
  // Stata 19: order *, sequential; ds. aorder.ado's replace promotes its
  // long to a double, so v3000000000 sorts after v2147483647.
  const names = [
    "v10",
    "v3000000000",
    "v2",
    "v2147483647",
    "v1",
    "v99999999999999999999",
    "v9999999999999999999a",
    "v20240115",
  ];
  const { session } = run(
    `clear\nset obs 1\n${names.map((name) => `generate ${name} = 1`).join("\n")}\norder *, sequential`,
  );
  assert.deepEqual(session.data.names, [
    "v1",
    "v2",
    "v10",
    "v20240115",
    "v2147483647",
    "v3000000000",
    "v9999999999999999999a",
    "v99999999999999999999",
  ]);
});

test("an empty varname option is not given, and too many is named first", () => {
  // Stata 19: capture noisily, then display _rc.
  const setup =
    "clear\nset obs 5\ngenerate x = _n\ngenerate v1 = 1\ngenerate v2 = 2\n";
  let { session, output } = run(
    `${setup}capture noisily order x, after(v*)\ndisplay _rc`,
  );
  assert.deepEqual(output.at(-2).lines, [
    "after():  too many variables specified",
  ]);
  assert.equal(output.at(-1).lines.join("").trim(), "103");
  ({ output } = run(`${setup}capture noisily order x, before()\ndisplay _rc`));
  assert.deepEqual(output.at(-2).lines, ["options not allowed"]);
  assert.equal(output.at(-1).lines.join("").trim(), "101");
  // xtile q = x, cutpoints() is xtile q = x, with nq(2); so is nq().
  ({ session } = run(`${setup}xtile q = x, cutpoints()\nxtile r = x, nq()`));
  assert.equal(session.data.get("q").label, "2 quantiles of x");
  assert.equal(session.data.get("r").label, "2 quantiles of x");
  assert.deepEqual(Array.from(session.data.get("q").data), [1, 1, 1, 2, 2]);
});

test("xtile and pctile labels keep the blanks syntax leaves in =exp", () => {
  // Stata 19: display "[`:variable label q']".
  const { session } = run(
    [
      "clear",
      "set obs 20",
      "generate x = mod(_n*7, 11)",
      "generate w = 1 + mod(_n, 3)",
      "generate g = mod(_n, 2)",
      "generate c = _n*2 in 1/3",
      "xtile a1 = x [aw=w]",
      "xtile a2 = x+( 1 ) [aw=w], nq(3)",
      "xtile a3 = x + ( 1 )  [aw=w] , nq(3)",
      "xtile a4 = x[aw=w], nq(3)",
      "xtile a5 =   x  if g",
      "xtile a6 = (x) *2 [fw=w] if g , nq(3)",
      "xtile a7 = x, nq(4.0)",
      "xtile a8 = x if g, cutpoints(c)",
      "pctile p1 = x [aw=w]",
      "pctile p2 = x   in 1/10",
    ].join("\n"),
  );
  const labels = Object.fromEntries(
    session.data.variables.map((v) => [v.name, v.label]),
  );
  assert.equal(labels.a1, "2 quantiles of x ");
  assert.equal(labels.a2, "3 quantiles of x+(1  )");
  assert.equal(labels.a3, "3 quantiles of x + (1  ) ");
  assert.equal(labels.a4, "3 quantiles of x");
  assert.equal(labels.a5, "2 quantiles of x  ");
  assert.equal(labels.a6, "3 quantiles of (x ) *2  ");
  assert.equal(labels.a7, "4.0 quantiles of x");
  assert.equal(labels.a8, "x  categorized by c");
  assert.equal(labels.p1, "percentiles of x ");
  assert.equal(labels.p2, "percentiles of x   ");
});

test("xtile reads nquantiles() as an expression and pctile n() as an integer", () => {
  // Stata 19: capture noisily xtile z = x, nq(...); display _rc.
  const setup =
    "clear\nset obs 20\ngenerate x = mod(_n*7, 11)\nscalar s4 = 4\n";
  const said = (option) => {
    const { output } = run(
      `${setup}capture noisily xtile z = x, nq(${option})\ndisplay _rc`,
    );
    return [
      output.at(-2).lines.join("\n"),
      output.at(-1).lines.join("").trim(),
    ];
  };
  assert.deepEqual(said("1+3"), ["option n() incorrectly specified", "198"]);
  assert.deepEqual(said("x"), ["option n() incorrectly specified", "198"]);
  assert.deepEqual(said("s4"), ["option n() incorrectly specified", "198"]);
  assert.deepEqual(said("nosuch"), ["nosuch not found", "111"]);
  assert.deepEqual(said("0+1"), [
    "nquantiles() must be greater than or equal to 2",
    "198",
  ]);
  const { output } = run(
    `${setup}capture noisily _pctile x, p()\ncapture noisily pctile p = x, nq(1+3)`,
  );
  assert.deepEqual(output.at(-2).lines, ["option p() incorrectly specified"]);
  assert.deepEqual(output.at(-1).lines, ["option nq() incorrectly specified"]);
});

test("_pctile takes negative importance weights", () => {
  // Stata 19: return list after _pctile x [iw=iw], p(25 50 75).
  const { session } = run(
    "clear\ninput x iw\n1 -1\n2 2\n3 1\n4 0.5\n5 2\n6 1\nend\n_pctile x [iw=iw], p(25 50 75)",
  );
  assert.deepEqual(session.results.r, { r1: 3, r2: 5, r3: 5 });
});

test("gsort refuses what gsort.ado's confirm, type and rename refuse", () => {
  // Stata 19: capture noisily gsort ...; display _rc; return list.
  const codes = {
    "gsort -v*": 111,
    "gsort -s v*, gen(z)": 111,
    "gsort -id w*": 101,
    "gsort -(v1)": 198,
    "gsort id(v1)": 101,
    "gsort w, gen(a b)": 101,
    "gsort w, gen(byte g)": 101,
    "gsort w, gen(X1 id)": 110,
    "gsort w, gen(a-b)": 198,
    "gsort w, gen(_b)": 198,
    "gsort w, gen(_skip)": 0,
  };
  const setup =
    'clear\ninput id v1 v2 str2 s w\n1 1 2 "a" 3\n2 1 . "b" 1\n3 2 1 "c" 2\n4 . 3 "d" 3\n5 2 .a "e" 1\n6 .b 1 "f" 2\nend\n';
  for (const [command, rc] of Object.entries(codes)) {
    const { output } = run(`${setup}capture ${command}\ndisplay _rc`);
    assert.equal(Number(output.at(-1).lines.join("").trim()), rc, command);
  }
  // Stopped at v*, the data are sorted on it, r() is empty and z is not
  // made.
  let { session } = run(`${setup}summarize id\ncapture gsort -s v*, gen(z)`);
  assert.deepEqual(session.data.sortedBy, ["v1", "v2"]);
  assert.deepEqual(Array.from(session.data.get("id").data), [1, 2, 3, 5, 4, 6]);
  assert.deepEqual(session.results.r, {});
  assert.equal(session.data.has("z"), false);
  // Stopped at the rename, the data are sorted and r() is what gsort.ado's
  // summarize left.
  ({ session } = run(`${setup}summarize id\ncapture gsort -id, gen(_b)`));
  assert.deepEqual(session.data.sortedBy, []);
  assert.deepEqual(Array.from(session.data.get("id").data), [6, 5, 4, 3, 2, 1]);
  assert.deepEqual(session.results.r, { N: 0, sum_w: 0, sum: 0 });
  // Finished, r() is put back in reverse order.
  ({ session } = run(`${setup}summarize w\ngsort -id, gen(gg)`));
  assert.deepEqual(Object.keys(session.results.r), [
    "sum",
    "max",
    "min",
    "sd",
    "Var",
    "mean",
    "sum_w",
    "N",
  ]);
});

test("collapse takes (p050) and counts observations before name conflicts", () => {
  // Stata 19: describe and list after collapse (p050) a=y, by(g); and
  // capture noisily of an empty if with a name conflict.
  const setup = "clear\ninput g y\n1 2\n1 4\n1 .\n2 6\n2 9\n2 10\nend\n";
  const { session } = run(`${setup}collapse (p050) a=y, by(g)`);
  assert.equal(session.data.get("a").label, "(p 050) y");
  assert.deepEqual(Array.from(session.data.get("a").data), [3, 9]);
  const { output } = run(
    `${setup}capture noisily collapse (mean) y (sd) y if g > 5, by(g)\ndisplay _rc`,
  );
  assert.deepEqual(output.at(-2).lines, ["no observations"]);
  assert.equal(output.at(-1).lines.join("").trim(), "2000");
});

test("a reserved word as a new variable's name is an invalid varname", () => {
  // Stata 19: capture noisily of each.
  const said = {
    "rename x _b": "_b invalid varname",
    "rename x str5": "str5 invalid variable name",
    "egen _N = mean(x)": "_N invalid varname",
    "xtile _n = x": "_n invalid varname",
    "xtile in = x": "varlist required",
    "xtile _skip = x": "_skip not allowed",
    "pctile _n = x": "_n invalid varname",
    "clonevar _cons = x": "_cons invalid varname",
  };
  for (const [command, message] of Object.entries(said)) {
    const { output } = run(
      `clear\nset obs 3\ngenerate x = _n\ncapture noisily ${command}`,
    );
    assert.deepEqual(output.at(-1).lines, [message], command);
  }
  // egen and rename take _skip.
  const { session } = run(
    "clear\nset obs 3\ngenerate x = _n\negen _skip = mean(x)\nrename _skip k\nrename x _skip",
  );
  assert.deepEqual(session.data.names, ["_skip", "k"]);
});
