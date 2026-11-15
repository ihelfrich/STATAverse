// The programming seams of the recheck: references that fail inside a
// macro expansion, prefixed if blocks, run with an error, tabs in a
// do-file, two commands on a line under #delimit ;, levelsof's long line,
// matrix list's options and the names syntax checks. The cases whose
// output the recorder can read are in tools/output-cases.txt; these are
// the rest. Every expected value was copied from Stata 19 MP's batch log
// (version 17, set processors 1, linesize 79).
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";
import { commandLines } from "../src/runtime/echo.js";

/** A run's records as Stata's log shows them, blank lines left out. */
function shown(output) {
  return output
    .flatMap((record) => [
      ...commandLines(record, record.width),
      ...record.lines,
    ])
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim());
}
/** The same without the end of do-file and return code that close a run. */
function closed(lines) {
  const out = [...lines];
  while (out.length && /^(\.|end of do-file|r\(\d+\);)$/.test(out.at(-1)))
    out.pop();
  return out;
}
function runFile(source, files = {}) {
  const session = createConsoleSession();
  for (const [name, text] of Object.entries(files)) session.addFile(name, text);
  const result = session.run(source, { doFile: true });
  return { session, result, lines: closed(shown(result.output)) };
}

const SUB =
  'di "in sub"\nnoisily di "loud"\ngen y = 1\ngen y = 2\ndi "not reached"\n';

const TRANSCRIPTS = [
  {
    what: "a failing `=exp' or `:fcn' prints its message and expands to nothing, under any prefix",
    source: [
      "clear",
      "set obs 1",
      "gen x = 2",
      'quietly di "q`=1+\'q"',
      'capture di "c`=1+\'c"',
      "di _rc",
      'capture noisily di "n`=1+\'n"',
      'noisily di "o`=nosuch\'o"',
      "di _rc",
      "forvalues i = 1/2 {",
      "  di \"loop `i' `=1+'\"",
      "}",
      "program pp",
      '  di "in pp `=nosuch\'"',
      '  di "still"',
      "end",
      "pp",
      "if `=1+' 1 {",
      '  di "if ran"',
      "}",
      "local k : word count `=1+'",
      'di "k=`k\'"',
      'di "`:label nosuchlab 1\'"',
      'di "after"',
      "",
    ].join("\n"),
    stata: [
      ". clear",
      ". set obs 1",
      "Number of observations (_N) was 0, now 1.",
      ". gen x = 2",
      '. quietly di "q`=1+\'q"',
      "invalid syntax",
      '. capture di "c`=1+\'c"',
      "invalid syntax",
      ". di _rc",
      "0",
      '. capture noisily di "n`=1+\'n"',
      "invalid syntax",
      "nn",
      '. noisily di "o`=nosuch\'o"',
      "nosuch not found",
      "oo",
      ". di _rc",
      "0",
      ". forvalues i = 1/2 {",
      "  2.   di \"loop `i' `=1+'\"",
      "  3. }",
      "invalid syntax",
      "loop 1",
      "invalid syntax",
      "loop 2",
      ". program pp",
      '  1.   di "in pp `=nosuch\'"',
      '  2.   di "still"',
      "  3. end",
      ". pp",
      "nosuch not found",
      "in pp",
      "still",
      ". if `=1+' 1 {",
      "invalid syntax",
      '.   di "if ran"',
      "if ran",
      ". }",
      ". local k : word count `=1+'",
      "invalid syntax",
      '. di "k=`k\'"',
      "k=0",
      '. di "`:label nosuchlab 1\'"',
      "1",
      '. di "after"',
      "after",
    ],
  },
  {
    what: "quietly, capture and noisily before if exp { make a prefixed block",
    source: [
      "clear",
      "set obs 2",
      "gen x = _n",
      "quietly if 1 {",
      '    noisily di "q if"',
      '    di "hidden"',
      "}",
      'di "after1"',
      "capture noisily if 1 {",
      '    di "cn if"',
      "    gen x = 1",
      '    di "not here"',
      "}",
      'di "rc=" _rc',
      "capture if 1 {",
      '    di "c if"',
      "    nosuchcmd",
      "}",
      'di "rc=" _rc',
      "noisily if 0 {",
      '    di "never"',
      "}",
      "else {",
      '    di "else ran"',
      "}",
      "quietly if x[1] == 1 {",
      '    noisily di "first"',
      "}",
      "else {",
      '    noisily di "second"',
      "}",
      "qui if 0 {",
      '    di "no"',
      "}",
      'else di "inline else"',
      "capture noisily {",
      '  di "plain"',
      "}",
      "quietly if 1 {",
      '    noisily di "q2"',
      "    gen y = 1",
      "    gen y = 2",
      "}",
      'di "end"',
      "",
    ].join("\n"),
    stata: [
      ". clear",
      ". set obs 2",
      "Number of observations (_N) was 0, now 2.",
      ". gen x = _n",
      ". quietly if 1 {",
      "q if",
      '. di "after1"',
      "after1",
      ". capture noisily if 1 {",
      '.     di "cn if"',
      "cn if",
      ".     gen x = 1",
      "variable x already defined",
      "r(110);",
      '.     di "not here"',
      ". }",
      '. di "rc=" _rc',
      "rc=110",
      ". capture if 1 {",
      '. di "rc=" _rc',
      "rc=199",
      ". noisily if 0 {",
      '.     di "never"',
      ". }",
      ". else {",
      '.     di "else ran"',
      "else ran",
      ". }",
      ". quietly if x[1] == 1 {",
      "first",
      ". else {",
      '.     noisily di "second"',
      ". }",
      ". qui if 0 {",
      '. else di "inline else"',
      "inline else",
      ". capture noisily {",
      '.   di "plain"',
      "plain",
      ". }",
      ". quietly if 1 {",
      "q2",
      "variable y already defined",
    ],
  },
  {
    what: "run shows an error once, without end of do-file; capture run still shows its message",
    files: { "sub.do": SUB, "ex.do": "exit 7\n" },
    source: [
      "clear",
      "set obs 1",
      "cap noi run sub.do",
      "di _rc",
      "drop y",
      "capture run sub.do",
      "di _rc",
      "drop y",
      "cap noi run ex.do",
      "di _rc",
      "forvalues i = 1/1 {",
      "  cap noi run sub.do",
      "  drop y",
      "}",
      "quietly run sub.do",
      "",
    ].join("\n"),
    stata: [
      ". clear",
      ". set obs 1",
      "Number of observations (_N) was 0, now 1.",
      ". cap noi run sub.do",
      "loud",
      "variable y already defined",
      ". di _rc",
      "110",
      ". drop y",
      ". capture run sub.do",
      "variable y already defined",
      ". di _rc",
      "110",
      ". drop y",
      ". cap noi run ex.do",
      ". di _rc",
      "7",
      ". forvalues i = 1/1 {",
      "  2.   cap noi run sub.do",
      "  3.   drop y",
      "  4. }",
      "loud",
      "variable y already defined",
      ". quietly run sub.do",
      "variable y already defined",
    ],
  },
  {
    what: "a tab in a do-file line is blanks to the next stop of eight columns",
    source:
      'local t "a\tb"\nlocal n : length local t\ndi "`n\'"\ndi "[`t\']"\ndi "x\ty"\n',
    stata: [
      '. local t "a      b"',
      ". local n : length local t",
      '. di "`n\'"',
      "8",
      '. di "[`t\']"',
      "[a      b]",
      '. di "x   y"',
      "x   y",
    ],
  },
  {
    what: "under #delimit ;, what follows a command's ; on its line is echoed with the next command",
    source: [
      "#delimit ;",
      'di "a" ; // c',
      "#delimit cr",
      'di "b"',
      "#delimit ;",
      'di "c" ; /* x */',
      "",
      'di "d" ;',
      'di "e" ; di "f" ; // end',
      "",
    ].join("\n"),
    stata: [
      ". #delimit ;",
      "delimiter now ;",
      '. di "a" ;',
      "a",
      ".  // c",
      "> #delimit cr",
      "delimiter now cr",
      '. di "b"',
      "b",
      ". #delimit ;",
      "delimiter now ;",
      '. di "c" ;',
      "c",
      ".  /* x */",
      ">",
      '> di "d" ;',
      "d",
      '. di "e" ;',
      "e",
      '.  di "f" ;',
      "f",
      ".  // end",
    ],
  },
  {
    what: "levelsof goes on after > when its line is longer than the linesize",
    source: "clear\nset obs 8\ngen double d = _n / 7\nlevelsof d\n",
    stata: [
      ". clear",
      ". set obs 8",
      "Number of observations (_N) was 0, now 8.",
      ". gen double d = _n / 7",
      ". levelsof d",
      ".1428571428571428 .2857142857142857 .4285714285714285 .5714285714285714 .714285",
      "> 7142857143 .8571428571428571 1 1.142857142857143",
    ],
  },
];

for (const c of TRANSCRIPTS)
  test(`Stata 19's log: ${c.what}`, () => {
    const { lines } = runFile(c.source, c.files);
    assert.deepEqual(lines, c.stata);
  });

test("run sub.do reports an error in the file once, then its r()", () => {
  const { result } = runFile("clear\nset obs 1\nrun sub.do\n", {
    "sub.do": SUB,
  });
  assert.equal(result.rc, 110);
  assert.deepEqual(result.output.at(-1).lines, [
    "loud",
    "variable y already defined",
    "r(110);",
  ]);
});

test("matrix list takes noblank, noheader, nonames, nohalf and title()", () => {
  const session = createConsoleSession();
  session.run("matrix A = (1, 2.5 \\ 3, 4)");
  session.run("matrix S = (1, 2 \\ 2, 5)");
  const lines = (command) => session.run(command).output[0].lines;
  assert.deepEqual(lines('matrix list A, title("Summary")'), [
    "",
    "A[2,2]:  Summary",
    "     c1   c2",
    "r1    1  2.5",
    "r2    3    4",
  ]);
  assert.deepEqual(lines("matrix list A, noblank"), [
    "A[2,2]",
    "     c1   c2",
    "r1    1  2.5",
    "r2    3    4",
  ]);
  assert.deepEqual(lines("matrix list A, noheader"), [
    "",
    "     c1   c2",
    "r1    1  2.5",
    "r2    3    4",
  ]);
  assert.deepEqual(lines("matrix list A, nonames"), [
    "",
    "A[2,2]",
    "    1  2.5",
    "    3    4",
  ]);
  assert.deepEqual(lines("matrix list S, nohalf noheader"), [
    "",
    "    c1  c2",
    "r1   1   2",
    "r2   2   5",
  ]);
  assert.deepEqual(lines("mat l A, f(%5.1f) nohe"), [
    "",
    "     c1   c2",
    "r1  1.0  2.5",
    "r2  3.0  4.0",
  ]);
  const refused = session.run("matrix list A, bogus").output[0];
  assert.equal(refused.rc, 198);
  assert.deepEqual(refused.lines, ["option bogus not allowed", "r(198);"]);
});

test("foreach's lists, varlist ranges and local names are checked as Stata checks them", () => {
  const rc = (source) => runFile(source).result.rc;
  // foreach of an empty varlist, newlist or numlist
  assert.equal(rc("local e\nforeach v of varlist `e' {\n  di 1\n}\n"), 100);
  assert.equal(rc("local e\nforeach v of numlist `e' {\n  di 1\n}\n"), 122);
  // a name already a variable, or twice in the newlist
  assert.equal(
    rc("clear\nset obs 1\ngen z1 = 1\nforeach v of newlist z1 {\n  di 1\n}\n"),
    110,
  );
  assert.equal(rc("foreach v of newlist z2 z2 {\n  di 1\n}\n"), 110);
  assert.equal(rc("foreach v of newlist 1bad {\n  di 1\n}\n"), 198);
  const { result } = runFile(
    "clear\nset obs 1\ngen a = 1\ngen c = 1\nsum c-a\n",
  );
  assert.equal(result.rc, 111);
  assert.equal(result.output.at(-1).lines[0], "variables out of order");
  // a local may start with a digit; one too long is named with its _
  assert.deepEqual(
    runFile('local 1bad x\ndi "`1bad\'"\n').result.output.at(-1).lines,
    ["x"],
  );
  assert.equal(
    runFile("local abcdefghijabcdefghijabcdefghij12 bad\n").result.output.at(-1)
      .lines[0],
    "_abcdefghijabcdefghijabcdefghij12 invalid name",
  );
});
