// The do-file seams found after pass 8: continue outside a loop, preamble
// lines that stopped a do-file, the commands a program needs (ereturn post
// and display, return matrix, mark, markout, marksample), restore in a
// program that never preserved, by with a program that is not byable,
// gettoken and tokenize with parse(), capture program define, settings that
// were silently accepted, a * comment ending in ///, the echo of a do-file
// line by line, long lines, macro list, } else {, do inside programs and
// loops, do's options, program dir and list, and cmdlog. Every expected
// value was recorded from Stata 19 MP (version 17, set processors 1).
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";
import { Session } from "../src/runtime/session.js";
import { commandLines } from "../src/runtime/echo.js";

// Do-files as Stata 19 runs them: each case is a do-file run in the Console
// and the lines of Stata 19 MP's batch log of the same do-file (version 17,
// set processors 1, linesize 79), blank lines left out, as is the prompt
// and end of do-file that close it.
const TRANSCRIPTS = [
  {
    what: "comments, blank lines and comments after a command are echoed as typed",
    source:
      '* star comment\n\n// slash comment\ndisplay "a" // trailing\n/* block\n   comment */\ndisplay "b" /* inline */\n\n\ndisplay "c"\n',
    stata: [
      ". * star comment",
      ".",
      ". // slash comment",
      '. display "a" // trailing',
      "a",
      ". /* block",
      ">    comment */",
      '. display "b" /* inline */',
      "b",
      ".",
      ".",
      '. display "c"',
      "c",
    ],
  },
  {
    what: "a * comment ending in /// swallows the next line; // and a /// in a // comment do not",
    source:
      '* star comment ///\ndisplay "after star continuation"\ndisplay "two"\n// slash comment ///\ndisplay "after slash continuation"\n*star no space///\ndisplay "after nospace"\ndisplay 1 // trailing ///\ndisplay "after trailing"\n* first ///\n  second ///\ndisplay "third"\n\t* tab star\ndisplay "end"\n  // indented slash\n    /* indented block */ display "after block"\ndisplay "x" /* open\n  still */ "y"\n',
    stata: [
      ". * star comment ///",
      '> display "after star continuation"',
      '. display "two"',
      "two",
      ". // slash comment ///",
      '. display "after slash continuation"',
      "after slash continuation",
      ". *star no space///",
      '. display "after nospace"',
      "after nospace",
      ". display 1 // trailing ///",
      "1",
      '. display "after trailing"',
      "after trailing",
      ". * first ///",
      ">   second ///",
      '> display "third"',
      ".         * tab star",
      '. display "end"',
      "end",
      ".   // indented slash",
      '.     /* indented block */ display "after block"',
      "after block",
      '. display "x" /* open',
      '>   still */ "y"',
      "xy",
    ],
  },
  {
    what: "comments, blank lines and continued lines inside a block are echoed as read",
    source:
      'if 1 {\n    * a comment in a block\n    display "one"\n\n    // another\n    display "two" ///\n        "three"\n}\nif 0 {\n    * skipped comment\n    display "no"\n}\ncapture noisily {\n    * in capture\n    display "cap"\n}\ndisplay "end"\n',
    stata: [
      ". if 1 {",
      ".     * a comment in a block",
      '.     display "one"',
      "one",
      ".",
      ".     // another",
      '.     display "two" ///',
      '>         "three"',
      "twothree",
      ". }",
      ". if 0 {",
      ".     * skipped comment",
      '.     display "no"',
      ". }",
      ". capture noisily {",
      ".     * in capture",
      '.     display "cap"',
      "cap",
      ". }",
      '. display "end"',
      "end",
    ],
  },
  {
    what: "continue outside a loop is statement out of context, r(119)",
    source: 'display "before"\ncontinue\ndisplay "after"\n',
    stata: [
      '. display "before"',
      "before",
      ". continue",
      "statement out of context",
    ],
  },
  {
    what: "continue in a program never reaches the caller's loop",
    source:
      'program define pc\n    display "in pc"\n    continue, break\n    display "pc after"\nend\nforvalues i = 1/2 {\n    pc\n    display "loop `i\'"\n}\ndisplay "after"\n',
    stata: [
      ". program define pc",
      '  1.     display "in pc"',
      "  2.     continue, break",
      '  3.     display "pc after"',
      "  4. end",
      ". forvalues i = 1/2 {",
      "  2.     pc",
      '  3.     display "loop `i\'"',
      "  4. }",
      "in pc",
      "statement out of context",
    ],
  },
  {
    what: "continue in a do-file run by do never reaches the caller's loop",
    source:
      'forvalues i = 1/2 {\n    display "outer `i\'"\n    do t19c_c.do\n}\ndisplay "after"\n',
    files: {
      "t19c_c.do": 'display "child"\ncontinue\ndisplay "child after"\n',
    },
    stata: [
      ". forvalues i = 1/2 {",
      '  2.     display "outer `i\'"',
      "  3.     do t19c_c.do",
      "  4. }",
      "outer 1",
      '. display "child"',
      "child",
      ". continue",
      "statement out of context",
    ],
  },
  {
    what: "do inside a program shows the file's commands; run shows only noisily output",
    source:
      'clear\nset obs 3\ngenerate x = _n\ndo t9_c.do alpha "beta gamma"\nrun t9_c.do one\nquietly do t9_c.do q\ncapture do t9_c.do cap\ncapture noisily do t9_c.do capn\nprogram define callit\n    display "callit"\n    do t9_c.do fromprog\n    forvalues k = 1/2 {\n        display "k=`k\'"\n    }\nend\ncallit\ndo t9_err.do\ndisplay "after err"\n',
    files: {
      "t9_c.do":
        'display `"args: `0\' | `1\' | `2\'"\'\nforvalues j = 1/2 {\n    display "j`j\'"\n}\nnoisily display "noisy"\n',
      "t9_err.do":
        'display "in err"\nforeach v in a b {\n    display "`v\'"\n    confirm variable `v\'\n}\n',
    },
    stata: [
      ". clear",
      ". set obs 3",
      "Number of observations (_N) was 0, now 3.",
      ". generate x = _n",
      '. do t9_c.do alpha "beta gamma"',
      ". display `\"args: `0' | `1' | `2'\"'",
      'args: alpha "beta gamma" | alpha | beta gamma',
      ". forvalues j = 1/2 {",
      '  2.     display "j`j\'"',
      "  3. }",
      "j1",
      "j2",
      '. noisily display "noisy"',
      "noisy",
      ".",
      "end of do-file",
      ". run t9_c.do one",
      "noisy",
      ". quietly do t9_c.do q",
      ". capture do t9_c.do cap",
      ". capture noisily do t9_c.do capn",
      ". display `\"args: `0' | `1' | `2'\"'",
      "args: capn | capn |",
      ". forvalues j = 1/2 {",
      '  2.     display "j`j\'"',
      "  3. }",
      "j1",
      "j2",
      '. noisily display "noisy"',
      "noisy",
      ".",
      "end of do-file",
      ". program define callit",
      '  1.     display "callit"',
      "  2.     do t9_c.do fromprog",
      "  3.     forvalues k = 1/2 {",
      '  4.         display "k=`k\'"',
      "  5.     }",
      "  6. end",
      ". callit",
      "callit",
      ". display `\"args: `0' | `1' | `2'\"'",
      "args: fromprog | fromprog |",
      ". forvalues j = 1/2 {",
      '  2.     display "j`j\'"',
      "  3. }",
      "j1",
      "j2",
      '. noisily display "noisy"',
      "noisy",
      ".",
      "end of do-file",
      "k=1",
      "k=2",
      ". do t9_err.do",
      '. display "in err"',
      "in err",
      ". foreach v in a b {",
      '  2.     display "`v\'"',
      "  3.     confirm variable `v'",
      "  4. }",
      "a",
      "variable a not found",
    ],
  },
  {
    what: "do and include echo the file line by line; include ends with its prompt",
    source:
      '* main line 3\n* main line 4\n* main line 5\ndisplay "main"\ndo t14_c.do\ninclude t14_i.do\ndisplay "end main"\ndisplay "padding a"\ndisplay "padding b"\ndisplay "padding c"\n',
    files: {
      "t14_c.do":
        'display "child line1"\ndisplay "child line2"\nprogram define kid\n    display "kid runs"\nend\nkid\nforvalues i = 1/2 {\n    display "c`i\'"\n}\n',
      "t14_i.do":
        'display "inc1"\nprogram define incp\n    display "incp runs"\nend\nincp\nforeach z in u v {\n    display "`z\'"\n}\n',
    },
    stata: [
      ". * main line 3",
      ". * main line 4",
      ". * main line 5",
      '. display "main"',
      "main",
      ". do t14_c.do",
      '. display "child line1"',
      "child line1",
      '. display "child line2"',
      "child line2",
      ". program define kid",
      '  1.     display "kid runs"',
      "  2. end",
      ". kid",
      "kid runs",
      ". forvalues i = 1/2 {",
      '  2.     display "c`i\'"',
      "  3. }",
      "c1",
      "c2",
      ".",
      "end of do-file",
      ". include t14_i.do",
      '. display "inc1"',
      "inc1",
      ". program define incp",
      '  1.     display "incp runs"',
      "  2. end",
      ". incp",
      "incp runs",
      ". foreach z in u v {",
      '  2.     display "`z\'"',
      "  3. }",
      "u",
      "v",
      ".",
      '. display "end main"',
      "end main",
      '. display "padding a"',
      "padding a",
      '. display "padding b"',
      "padding b",
      '. display "padding c"',
      "padding c",
    ],
  },
  {
    what: "do, nostop reports each error and goes on",
    source: 'do t35_c.do, nostop\ndisplay "after"\n',
    files: { "t35_c.do": 'display "one"\nsummarize nosuch\ndisplay "two"\n' },
    stata: [
      ". do t35_c.do, nostop",
      '. display "one"',
      "one",
      ". summarize nosuch",
      "no variables defined",
      "r(111);",
      '. display "two"',
      "two",
      ".",
      "end of do-file",
      '. display "after"',
      "after",
    ],
  },
  {
    what: "do with an option other than nostop is refused before the file runs",
    source:
      'do t34_c.do a b, opt\ndisplay "[`fromchild\']"\nlocal fromchild 0\nrun t34_c.do x\ndisplay "[`fromchild\']"\n',
    files: {
      "t34_c.do":
        "args first second\ndisplay \"first=`first' second=`second'\"\nsyntax [anything] [, opt]\ndisplay \"anything=`anything' opt=`opt'\"\nlocal fromchild 1\n",
    },
    stata: [". do t34_c.do a b, opt", "option opt not allowed"],
  },
  {
    what: "} else { on one line: the if block is echoed, then that line stops the file",
    source:
      'local a 1\nif `a\' == 2 {\n    display "two"\n} else {\n    display "not two"\n}\ndisplay "after"\n',
    stata: [
      ". local a 1",
      ". if `a' == 2 {",
      '.     display "two"',
      ". } else {",
      "program error:  code follows on the same line as close brace",
    ],
  },
  {
    what: "} else { after a block that ran",
    source:
      'local a 2\nif `a\' == 2 {\n    display "two"\n} else {\n    display "not two"\n}\ndisplay "after"\n',
    stata: [
      ". local a 2",
      ". if `a' == 2 {",
      '.     display "two"',
      "two",
      ". } else {",
      "program error:  code follows on the same line as close brace",
    ],
  },
  {
    what: "capture program define defines the program, and fails with 110 when it exists",
    source:
      'capture program define newp\n    display "body of newp"\nend\ndisplay _rc\nnewp\ncapture program define newp\ndisplay _rc\ncapture noisily program define newp\ndisplay _rc\nquietly program define qp\n    display "qp body"\nend\nqp\nnoisily program define np, rclass\n    display "np body"\nend\nnp\ncap prog drop np\ncap pr def np\n    display "np again"\nend\nnp\ncapture program drop zz\ncapture program zz\n    display "zz"\nend\nzz\n',
    stata: [
      ". capture program define newp",
      ". display _rc",
      "0",
      ". newp",
      "body of newp",
      ". capture program define newp",
      ". display _rc",
      "110",
      ". capture noisily program define newp",
      "program newp already defined",
      ". display _rc",
      "110",
      ". quietly program define qp",
      ". qp",
      "qp body",
      ". noisily program define np, rclass",
      '  1.     display "np body"',
      "  2. end",
      ". np",
      "np body",
      ". cap prog drop np",
      ". cap pr def np",
      ". np",
      "np again",
      ". capture program drop zz",
      ". capture program zz",
      ". zz",
      "zz",
    ],
  },
  {
    what: "indented and tab-indented lines are echoed with their indentation",
    source:
      '* star comment ///\ndisplay "after star continuation"\n// slash comment ///\ndisplay "after slash continuation"\ndisplay "one" /* mid\n  comment */ "two"\ndisplay "x" //   trailing ///\ndisplay "y"\nlocal url http://example.com/a\ndisplay "`url\'"\ndisplay "tab"\t// tab before comment\ndisplay 6*7 // product\ndisplay "q" /*nested /* inner */ still */ "r"\n\tdisplay "leading tab"\n',
    stata: [
      ". * star comment ///",
      '> display "after star continuation"',
      ". // slash comment ///",
      '. display "after slash continuation"',
      "after slash continuation",
      '. display "one" /* mid',
      '>   comment */ "two"',
      "onetwo",
      '. display "x" //   trailing ///',
      "x",
      '. display "y"',
      "y",
      ". local url http://example.com/a",
      '. display "`url\'"',
      "http://example.com/a",
      '. display "tab"   // tab before comment',
      "tab",
      ". display 6*7 // product",
      "42",
      '. display "q" /*nested /* inner */ still */ "r"',
      "qr",
      '.         display "leading tab"',
      "leading tab",
    ],
  },
  {
    what: "nested if blocks are echoed with their indentation",
    source:
      'clear\nset obs 2\ngenerate x = _n\nnoisily {\n    display "in noisily block"\n    summarize x\n}\n{\n    display "bare block"\n}\nif 1 {\n    display "if one"\n    if 0 {\n        display "inner no"\n    }\n    else {\n        display "inner else"\n    }\n}\ncapture noisily {\n    display "before"\n    if 1 {\n        summarize nosuch\n        display "skipped"\n    }\n    display "skipped too"\n}\ndisplay _rc\nif 1 {\n    display "will fail"\n    summarize nosuch\n    display "not run"\n}\ndisplay "never"\n',
    stata: [
      ". clear",
      ". set obs 2",
      "Number of observations (_N) was 0, now 2.",
      ". generate x = _n",
      ". noisily {",
      '.     display "in noisily block"',
      "in noisily block",
      ".     summarize x",
      "    Variable |        Obs        Mean    Std. dev.       Min        Max",
      "-------------+---------------------------------------------------------",
      "           x |          2         1.5    .7071068          1          2",
      ". }",
      ". {",
      '.     display "bare block"',
      "bare block",
      ". }",
      ". if 1 {",
      '.     display "if one"',
      "if one",
      ".     if 0 {",
      '.         display "inner no"',
      ".     }",
      ".     else {",
      '.         display "inner else"',
      "inner else",
      ".     }",
      ". }",
      ". capture noisily {",
      '.     display "before"',
      "before",
      ".     if 1 {",
      ".         summarize nosuch",
      "variable nosuch not found",
      "r(111);",
      '.         display "skipped"',
      ".     }",
      "r(111);",
      '.     display "skipped too"',
      ". }",
      ". display _rc",
      "111",
      ". if 1 {",
      '.     display "will fail"',
      "will fail",
      ".     summarize nosuch",
      "variable nosuch not found",
      "r(111);",
      '.     display "not run"',
      ". }",
    ],
  },
  {
    what: "a captured loop whose own line fails leaves _rc 199 from its }",
    source:
      'clear\nset obs 2\ngenerate a = 1\ngenerate b = 2\nforeach v of local nothing {\n    display "never"\n}\nforeach v in {\n    display "never2"\n}\ncapture noisily foreach v of varlist zz* {\n    display "`v\'"\n}\ndisplay _rc\ncapture noisily foreach v of numlist 1/a {\n    display "`v\'"\n}\ndisplay _rc\ncapture noisily foreach v of something x y {\n    display "`v\'"\n}\ndisplay _rc\ncapture noisily foreach v x y {\n    display "`v\'"\n}\ndisplay _rc\ncapture noisily foreach 1bad in x {\n    display "x"\n}\ndisplay _rc\ncapture noisily forvalues i = a/3 {\n    display "`i\'"\n}\ndisplay _rc\ncapture noisily forvalues i 1/3 {\n    display "`i\'"\n}\ndisplay _rc\nforeach v of varlist a b {\n    drop `v\'\n}\ndescribe\n',
    stata: [
      ". clear",
      ". set obs 2",
      "Number of observations (_N) was 0, now 2.",
      ". generate a = 1",
      ". generate b = 2",
      ". foreach v of local nothing {",
      '  2.     display "never"',
      "  3. }",
      ". foreach v in {",
      '  2.     display "never2"',
      "  3. }",
      ". capture noisily foreach v of varlist zz* {",
      '  2.     display "`v\'"',
      "  3. }",
      "variable zz* not found",
      "} is not a valid command name",
      ". display _rc",
      "199",
      ". capture noisily foreach v of numlist 1/a {",
      '  2.     display "`v\'"',
      "  3. }",
      "invalid numlist",
      "} is not a valid command name",
      ". display _rc",
      "199",
      ". capture noisily foreach v of something x y {",
      '  2.     display "`v\'"',
      "  3. }",
      "invalid syntax",
      "} is not a valid command name",
      ". display _rc",
      "199",
      ". capture noisily foreach v x y {",
      '  2.     display "`v\'"',
      "  3. }",
      "invalid syntax",
      "} is not a valid command name",
      ". display _rc",
      "199",
      ". capture noisily foreach 1bad in x {",
      '  2.     display "x"',
      "  3. }",
      "x",
      ". display _rc",
      "0",
      ". capture noisily forvalues i = a/3 {",
      '  2.     display "`i\'"',
      "  3. }",
      "invalid syntax",
      "} is not a valid command name",
      ". display _rc",
      "199",
      ". capture noisily forvalues i 1/3 {",
      '  2.     display "`i\'"',
      "  3. }",
      "invalid syntax",
      "} is not a valid command name",
      ". display _rc",
      "199",
      ". foreach v of varlist a b {",
      "  2.     drop `v'",
      "  3. }",
      ". describe",
      "Contains data",
      " Observations:             0",
      "    Variables:             0",
      "Sorted by:",
    ],
  },
  {
    what: "capture of blocks and loops leaves Stata's _rc",
    source:
      'capture {\n    summarize nosuch\n}\ndisplay _rc\ncapture forvalues i = 1/2 {\n    summarize nosuch\n}\ndisplay _rc\ncapture foreach v of varlist zz* {\n    display "x"\n}\ndisplay _rc\n',
    stata: [
      ". capture {",
      ". display _rc",
      "111",
      ". capture forvalues i = 1/2 {",
      ". display _rc",
      "0",
      ". capture foreach v of varlist zz* {",
      ". display _rc",
      "199",
    ],
  },
  {
    what: "noisily capture keeps the error quiet; capture noisily shows it",
    source:
      'clear\nset obs 3\ngenerate x = _n\nprogram define pn\n    display "pn quiet part"\n    noisily display "pn noisy part"\n    summarize x\nend\nquietly pn\ncapture pn\ndisplay _rc\ncapture noisily pn\nquietly {\n    pn\n    forvalues i = 1/2 {\n        noisily display "q loop `i\'"\n        display "hidden `i\'"\n    }\n}\nquietly forvalues i = 1/2 {\n    display "hidden2"\n    noisily display "shown2 `i\'"\n}\ncapture quietly {\n    noisily display "cq"\n}\ncapture noisily quietly summarize nosuch\ndisplay _rc\nquietly capture noisily summarize nosuch\ndisplay _rc\nnoisily capture summarize nosuch\ndisplay _rc\ncapture {\n    summarize x\n    noisily display "noisily inside capture"\n}\ncapture: display "colon form"\nquietly: display "q colon"\nnoisily: display "n colon"\nqui display "abbrev"\ncap noi display "abbrev2"\nn display "n abbrev"\nquietly summarize nosuch\n',
    stata: [
      ". clear",
      ". set obs 3",
      "Number of observations (_N) was 0, now 3.",
      ". generate x = _n",
      ". program define pn",
      '  1.     display "pn quiet part"',
      '  2.     noisily display "pn noisy part"',
      "  3.     summarize x",
      "  4. end",
      ". quietly pn",
      ". capture pn",
      ". display _rc",
      "0",
      ". capture noisily pn",
      "pn quiet part",
      "pn noisy part",
      "    Variable |        Obs        Mean    Std. dev.       Min        Max",
      "-------------+---------------------------------------------------------",
      "           x |          3           2           1          1          3",
      ". quietly {",
      "q loop 1",
      "q loop 2",
      ". quietly forvalues i = 1/2 {",
      "shown2 1",
      "shown2 2",
      ". capture quietly {",
      "cq",
      ". capture noisily quietly summarize nosuch",
      "variable nosuch not found",
      ". display _rc",
      "111",
      ". quietly capture noisily summarize nosuch",
      "variable nosuch not found",
      ". display _rc",
      "111",
      ". noisily capture summarize nosuch",
      ". display _rc",
      "111",
      ". capture {",
      "noisily inside capture",
      '. capture: display "colon form"',
      '. quietly: display "q colon"',
      '. noisily: display "n colon"',
      "n colon",
      '. qui display "abbrev"',
      '. cap noi display "abbrev2"',
      "abbrev2",
      '. n display "n abbrev"',
      "n abbrev",
      ". quietly summarize nosuch",
      "variable nosuch not found",
    ],
  },
];

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
const last = (result) => result.output.at(-1);

for (const c of TRANSCRIPTS)
  test(`Stata 19's log: ${c.what}`, () => {
    const { lines } = runFile(c.source, c.files);
    assert.deepEqual(lines, c.stata);
  });

test("continue outside a loop stops with r(119), and capture keeps 119", () => {
  let { result } = runFile('display "before"\ncontinue\ndisplay "after"\n');
  assert.equal(result.rc, 119);
  assert.deepEqual(last(result).lines, ["statement out of context", "r(119);"]);
  ({ result } = runFile("capture noisily continue\ndisplay _rc\n"));
  assert.equal(result.rc, 0);
  assert.deepEqual(last(result).lines, ["119"]);
  ({ result } = runFile("capture continue, break\ndisplay _rc\n"));
  assert.deepEqual(last(result).lines, ["119"]);
});

test("preamble lines of a do-file run as Stata 19 runs them", () => {
  const { result, lines } = runFile(
    [
      "clear all",
      "clear matrix",
      "clear mata",
      "clear programs",
      "clear results",
      "clear frames",
      "set mem 500m",
      "set matsize 800",
      "set emptycells drop",
      "set sortseed 1",
      "discard",
      "set more off, perm",
      "set maxvar 5000",
      "set niceness 5",
      "set autotabgraphs on",
      'display "reached"',
      "",
    ].join("\n"),
  );
  assert.equal(result.rc, 0);
  for (const expected of [
    "set memory ignored.",
    "    Memory no longer needs to be set in modern Statas; memory adjustments are",
    "    performed on the fly automatically.",
    "set matsize ignored.",
    "    Matrix sizes are no longer limited by c(matsize) in modern Statas.",
    "    Matrix sizes are now limited by edition of Stata.  See limits for more",
    "    details.",
    "(set more preference recorded)",
    "(-set autotabgraphs- irrelevant in this version of Stata)",
    "reached",
  ])
    assert.ok(lines.includes(expected), expected);
});

test("set takes only the values Stata takes, with its messages", () => {
  const s = new Session();
  const rc = (command) => {
    const r = s.run(`capture noisily ${command}\ndisplay _rc`);
    return [r.output[0].lines.join("\n"), Number(r.output[1].lines[0])];
  };
  assert.deepEqual(rc("set more maybe"), ["on or off required", 100]);
  assert.deepEqual(rc("set more"), ["on or off required", 100]);
  assert.deepEqual(rc("set varabbrev maybe"), [
    "'maybe' found where on or off expected",
    198,
  ]);
  assert.deepEqual(rc("set trace maybe"), [
    "'maybe' found where on or off expected",
    198,
  ]);
  assert.deepEqual(rc("set rmsg maybe"), [
    "'maybe' found where on or off expected",
    198,
  ]);
  assert.deepEqual(rc("set trace"), ["on or off required", 100]);
  assert.deepEqual(rc("set emptycells maybe"), ["keep or drop required", 100]);
  assert.deepEqual(rc("set emptycells"), ["keep or drop required", 100]);
  assert.deepEqual(rc("set sortseed abc"), ["invalid sortseed", 198]);
  assert.deepEqual(rc("set sortseed"), ["invalid syntax", 198]);
  assert.deepEqual(rc("set sortseed 1.5"), ["", 0]);
  assert.deepEqual(rc("set dp maybe"), ["invalid syntax", 198]);
  assert.deepEqual(rc("set dp period"), ["", 0]);
  assert.deepEqual(rc("set cformat bogus"), ["invalid numeric format", 7]);
  assert.deepEqual(rc("set cformat"), ["", 0]);
  assert.deepEqual(rc("set matsize abc"), [
    "abc found where number expected",
    198,
  ]);
  assert.deepEqual(rc("set mem abc"), [
    "'abc' found where integer expected",
    198,
  ]);
  assert.deepEqual(rc("set mem"), ["invalid syntax", 198]);
  assert.deepEqual(rc("set type maybe"), [
    "'maybe' found where 'float' or 'double' expected",
    198,
  ]);
  assert.deepEqual(rc("set varabbrev on, permanently"), [
    "(set varabbrev preference recorded)",
    0,
  ]);
  assert.deepEqual(rc("set linesize 80, perm"), ["options not allowed", 101]);
  assert.deepEqual(rc("set processors 1, perm"), ["options not allowed", 101]);
  assert.deepEqual(rc("set seed 1, perm"), [
    "',' found where nothing expected",
    198,
  ]);
  assert.deepEqual(rc("set trace off"), ["", 0]);
  assert.deepEqual(rc("set rmsg off"), ["", 0]);
});

test("settings that would change output the browser does not follow are refused with r(198)", () => {
  // Stata takes these; the browser cannot yet print what they ask for, so
  // it refuses them with a hint rather than ignore them.
  for (const command of [
    "set trace on",
    "set rmsg on",
    "set varabbrev off",
    "set dp comma",
    "set cformat %9.2f",
    "set pformat %5.3f",
    "set sformat %8.2f",
  ]) {
    const result = new Session().run(command);
    assert.equal(result.rc, 198, command);
    assert.match(
      result.output[0].lines[0],
      /is not available in the browser yet$/,
      command,
    );
  }
});

test("clear's parts clear what Stata's do, and discard clears the estimates", () => {
  const s = new Session();
  const said = (command) => s.run(command).output.at(-1).lines;
  s.run(
    'clear\nset obs 10\ngenerate price = _n^2\ngenerate mpg = 10 - _n + mod(_n, 3)\nquietly regress price mpg\nmatrix A = (1,2)\nscalar sc = 3\nprogram define pp\ndisplay "pp"\nend\ndiscard',
  );
  assert.deepEqual(
    said('display "after discard e(N)=" e(N) " A=" A[1,1] " sc=" sc'),
    ["after discard e(N)=. A=1 sc=3"],
  );
  assert.deepEqual(said("pp"), ["pp"]);
  s.run("quietly summarize price\nclear results");
  assert.deepEqual(said('display "[" e(N) "][" r(N) "]"'), ["[.][.]"]);
  s.run("quietly regress price mpg\nclear matrix");
  assert.deepEqual(said("capture noisily matrix list A"), [
    "matrix A not found",
  ]);
  assert.deepEqual(said("display e(N)"), ["."]);
  s.run("clear programs");
  assert.deepEqual(said("capture noisily pp"), ["command pp is unrecognized"]);
  assert.deepEqual(said("display _N"), ["10"]);
  s.run("clear mata\nclear ado\nclear rngstream\nclear results");
  assert.deepEqual(said("display _N"), ["10"]);
  s.run("clear frames");
  assert.deepEqual(said("display _N"), ["0"]);
  assert.deepEqual(said("capture noisily clear bogus"), ["bogus not allowed"]);
  assert.deepEqual(said("capture noisily clear all bogus"), [
    "bogus not allowed",
  ]);
  assert.deepEqual(said("display _rc"), ["198"]);
});

test("ereturn post, ereturn display and ereturn list as Stata 19 shows them", () => {
  const s = createConsoleSession();
  s.run(
    "clear\nset obs 20\nset seed 1\ngenerate x = runiform()\ngenerate y = 1 + 2*x + rnormal()\ngenerate g = _n > 10",
  );
  const run = (text) => s.run(text, { doFile: true });
  let result = run(
    [
      "program define myols, eclass",
      "    tempname b V",
      "    quietly regress y x",
      "    matrix `b' = e(b)",
      "    matrix `V' = e(V)",
      "    local N = e(N)",
      "    ereturn post `b' `V', depname(y) obs(`N') esample(g)",
      '    ereturn local cmd "myols"',
      "    ereturn scalar ll = -3.5",
      "    ereturn display",
      "end",
      "myols",
    ].join("\n"),
  );
  assert.equal(result.rc, 0);
  assert.deepEqual(last(result).lines, [
    "------------------------------------------------------------------------------",
    "           y | Coefficient  Std. err.      z    P>|z|     [95% conf. interval]",
    "-------------+----------------------------------------------------------------",
    "           x |   1.091174   .8711474     1.25   0.210    -.6162434    2.798592",
    "       _cons |   1.434582   .4088746     3.51   0.000     .6332025    2.235961",
    "------------------------------------------------------------------------------",
  ]);
  result = s.run("ereturn list");
  assert.deepEqual(
    result.output[0].lines.map((line) => line.trimEnd()).filter(Boolean),
    [
      "scalars:",
      "                  e(N) =  20",
      "                 e(ll) =  -3.5",
      "macros:",
      '                e(cmd) : "myols"',
      '         e(properties) : "b V"',
      '             e(depvar) : "y"',
      "matrices:",
      "                  e(b) :  1 x 2",
      "                  e(V) :  2 x 2",
      "functions:",
      "             e(sample)",
    ],
  );
  assert.deepEqual(s.run('display _b[x] " " _se[x]').output[0].lines, [
    "1.0911741 .8711474",
  ]);
  assert.deepEqual(s.run("count if e(sample)").output[0].lines, ["  10"]);
  // esample() moves the variable into e(sample).
  assert.equal(s.run("confirm variable g").rc, 111);
  // With dof(), t statistics.
  result = run(
    "program define myols2, eclass\n    tempname b V\n    quietly regress y x\n    matrix `b' = e(b)\n    matrix `V' = e(V)\n    ereturn post `b' `V', dof(18)\n    ereturn display\nend\nmyols2",
  );
  assert.deepEqual(last(result).lines.slice(1, 5), [
    "             | Coefficient  Std. err.      t    P>|t|     [95% conf. interval]",
    "-------------+----------------------------------------------------------------",
    "           x |   1.091174   .8711474     1.25   0.226    -.7390387    2.921387",
    "       _cons |   1.434582   .4088746     3.51   0.003     .5755683    2.293596",
  ]);
  // After regress, ereturn display shows its table without the header.
  result = s.run("quietly regress y x\nereturn display");
  assert.deepEqual(result.output[1].lines.slice(1, 5), [
    "           y | Coefficient  Std. err.      t    P>|t|     [95% conf. interval]",
    "-------------+----------------------------------------------------------------",
    "           x |   1.091174   .8711474     1.25   0.226    -.7390387    2.921387",
    "       _cons |   1.434582   .4088746     3.51   0.003     .5755683    2.293596",
  ]);
  // b is moved; a V named otherwise than b is a name conflict, one of
  // another size a conformability error.
  result = run(
    "program define ec1, eclass\n    matrix b = (1, 2)\n    ereturn post b\nend\nec1\ncapture noisily matrix list b\ndisplay _rc",
  );
  assert.deepEqual(last(result).lines, ["111"]);
  result = run(
    "program define ec4, eclass\n    matrix b = (1, 2)\n    matrix V = (1, 0 \\ 0, 1)\n    ereturn post b V\nend\ncapture noisily ec4\ndisplay _rc",
  );
  assert.deepEqual(last(result).lines, ["507"]);
  result = run(
    "program define ec5, eclass\n    matrix b = (1, 2)\n    matrix colnames b = a b\n    matrix V = (1)\n    ereturn post b V\nend\ncapture noisily ec5\ndisplay _rc",
  );
  assert.deepEqual(last(result).lines, ["503"]);
});

test("return matrix moves a matrix into r(), as return list shows", () => {
  const s = createConsoleSession();
  const result = s.run(
    [
      "program define rmat, rclass",
      "    tempname m",
      "    matrix `m' = (1,2\\3,4)",
      "    return matrix mm = `m'",
      "    return scalar s = 1",
      "end",
      "rmat",
      "return list",
      "matrix list r(mm)",
      "program define rm2, rclass",
      "    matrix m = (1,2\\3,4)",
      "    return matrix mm = m, copy",
      "    return matrix m2 = m",
      "    capture noisily matrix list m",
      "end",
      "rm2",
      "return list",
    ].join("\n"),
    { doFile: true },
  );
  assert.equal(result.rc, 0);
  const list = (k) => result.output[k].lines.filter(Boolean);
  assert.deepEqual(list(2), [
    "scalars:",
    "                  r(s) =  1",
    "matrices:",
    "                 r(mm) :  2 x 2",
  ]);
  assert.deepEqual(list(3), [
    "r(mm)[2,2]",
    "    c1  c2",
    "r1   1   2",
    "r2   3   4",
  ]);
  assert.deepEqual(list(5), ["matrix m not found"]);
  assert.deepEqual(list(6), [
    "matrices:",
    "                 r(m2) :  2 x 2",
    "                 r(mm) :  2 x 2",
  ]);
});

test("mark, markout and marksample mark the observations Stata marks", () => {
  const s = new Session();
  s.run(
    'clear\ninput x y w str3 s g\n1 2 1 "a" 1\n. 3 1 "b" 1\n3 . 0 "" 2\n4 5 2 "d" 2\n5 .a . "e" 2\nend',
  );
  s.run(
    "mark m1\nmark m2 if x > 2\nmark m3 in 2/4\nmark m4 [fweight=w]\nmark m5 [fweight=w], zeroweight\nmarkout m1 x y\ngenerate byte m6 = 1\nmarkout m6 s\ngenerate byte m7 = 1\nmarkout m7 s, strok\ngenerate byte m8 = 2\nmarkout m8 x\ngenerate byte m9 = 1\nmarkout m9 y, sysmissok",
  );
  const column = (name) => Array.from(s.data.get(name).data);
  assert.deepEqual(column("m1"), [1, 0, 0, 1, 0]);
  assert.deepEqual(column("m2"), [0, 1, 1, 1, 1]);
  assert.deepEqual(column("m3"), [0, 1, 1, 1, 0]);
  assert.deepEqual(column("m4"), [1, 1, 0, 1, 0]);
  assert.deepEqual(column("m5"), [1, 1, 1, 1, 0]);
  assert.deepEqual(column("m6"), [0, 0, 0, 0, 0]);
  assert.deepEqual(column("m7"), [1, 1, 0, 1, 1]);
  assert.deepEqual(column("m8"), [2, 0, 2, 2, 2]);
  assert.deepEqual(column("m9"), [1, 1, 1, 1, 0]);
  assert.equal(s.data.get("m1").type, "byte");
  let r = s.run("capture noisily mark m1\ndisplay _rc");
  assert.deepEqual(r.output[0].lines, ["variable m1 already defined"]);
  assert.deepEqual(r.output[1].lines, ["110"]);
  r = s.run("generate m10 = 1\ncapture noisily markout m10 x\ndisplay _rc");
  assert.deepEqual(r.output[1].lines, ["m10 not byte"]);
  assert.deepEqual(r.output[2].lines, ["198"]);
  r = s.run(
    [
      "program define ms",
      "    syntax [varlist] [if] [in] [fweight]",
      "    marksample touse",
      '    display "touse=`touse\'"',
      "    quietly count if `touse'",
      '    display "n=" r(N)',
      "end",
      "ms x y",
      "ms x y if g == 2",
      "ms x y in 1/3",
      "ms x [fweight=w]",
      "ms s",
      "describe, short",
    ].join("\n"),
  );
  assert.deepEqual(
    r.output.filter((o) => o.command.startsWith("ms ")).map((o) => o.lines),
    [
      ["touse=__000000", "n=2"],
      ["touse=__000000", "n=1"],
      ["touse=__000000", "n=1"],
      ["touse=__000000", "n=2"],
      ["touse=__000000", "n=0"],
    ],
  );
  // The temporary variable is dropped when the program ends.
  assert.ok(
    r.output.at(-1).lines.some((line) => /Variables:\s+15$/.test(line)),
  );
  r = s.run(
    'program define ms2\n    syntax [varlist] [if]\n    marksample touse, strok\n    quietly count if `touse\'\n    display "n2=" r(N)\n    marksample t2, novarlist\n    quietly count if `t2\'\n    display "n3=" r(N)\nend\nms2 s\nms2 x y',
  );
  assert.deepEqual(r.output[0].lines, ["n2=4", "n3=5"]);
  assert.deepEqual(r.output[1].lines, ["n2=2", "n3=5"]);
});

test("by runs a byable(recall) program by group and refuses any other, r(190)", () => {
  const s = new Session();
  s.run(
    'clear\ninput x g\n1 1\n. 1\n3 2\n4 2\n5 2\nend\nsort g\nprogram define ms3, byable(recall)\n    syntax [varlist] [if]\n    marksample touse\n    quietly count if `touse\'\n    display "by n=" r(N) " _N=" _N\nend\nprogram define myp\n    display "myp N=" _N\nend',
  );
  let r = s.run("by g: ms3 x");
  assert.deepEqual(
    r.output[0].lines.filter((line) => !/^-+$/.test(line) && line),
    ["-> g = 1", "by n=1 _N=5", "-> g = 2", "by n=3 _N=5"],
  );
  r = s.run("capture noisily by g: myp\ndisplay _rc");
  assert.deepEqual(r.output[0].lines, ["myp may not be combined with by"]);
  assert.deepEqual(r.output[1].lines, ["190"]);
  r = s.run("capture noisily by g: by g: summarize x\ndisplay _rc");
  assert.deepEqual(r.output[0].lines, ["by may not be combined with by"]);
  assert.deepEqual(r.output[1].lines, ["190"]);
});

test("restore restores only what the do-file or program preserved", () => {
  // Stata 19: nothing to restore inside p1; the caller's copy stays and
  // restores N=5; restore, bogus is refused and leaves N=4.
  const { result } = runFile(
    [
      "clear",
      "set obs 5",
      "generate x = _n",
      "preserve",
      "program define p1",
      "    capture noisily restore",
      '    display "inside rc=" _rc',
      "end",
      "p1",
      "drop in 1",
      "capture noisily restore, bogus",
      'display _rc " N=" _N',
      "restore, preserve",
      "display _N",
      "",
    ].join("\n"),
  );
  assert.equal(result.rc, 0);
  const lines = result.output.flatMap((record) => record.lines);
  assert.ok(lines.includes("nothing to restore"));
  assert.ok(lines.includes("inside rc=622"));
  assert.ok(lines.includes("option bogus not allowed"));
  assert.ok(lines.includes("198 N=4"));
  assert.equal(lines.at(-1), "5");
});

test("tokenize and gettoken with parse() split only at its characters", () => {
  // Each pair runs as one do-file, whose locals are its own.
  const said = (text) => new Session().run(text).output.at(-1).lines[0];
  const tokens = "\ndisplay `\"[`1'][`2'][`3'][`4']\"'",
    halves = "\ndisplay `\"[`lhs'][`rhs']\"'";
  assert.equal(said(`tokenize "a b,c", parse(",")${tokens}`), "[a b][,][c][]");
  assert.equal(
    said(`tokenize "  a b , c  ", parse(",")${tokens}`),
    "[a b ][,][c  ][]",
  );
  assert.equal(said(`tokenize "a b,c", parse(", ")${tokens}`), "[a][b][,][c]");
  assert.equal(
    said(`local s "x y = z"\ngettoken lhs rhs : s, parse("=")${halves}`),
    "[x y ][= z]",
  );
  assert.equal(
    said(`local s "  = z"\ngettoken lhs rhs : s, parse("=")${halves}`),
    "[=][ z]",
  );
  assert.equal(
    said(`local s "a b, opt(1)"\ngettoken lhs rhs : s, parse(",")${halves}`),
    "[a b][, opt(1)]",
  );
  assert.equal(
    said(`local s "a b, opt(1)"\ngettoken lhs rhs : s, parse(", ")${halves}`),
    "[a][ b, opt(1)]",
  );
  assert.equal(
    said(`local s \`""a b" c, d"'\ngettoken lhs rhs : s, parse(",")${halves}`),
    "[a b][ c, d]",
  );
  assert.equal(
    said(`local s "a b c"\ngettoken lhs rhs : s, parse("")${halves}`),
    "[a][ b c]",
  );
});

test("a #delimit section is echoed as Stata 19's log echoes it", () => {
  const { lines } = runFile(
    [
      "#delimit ;",
      'display "semi"',
      '  "colon";',
      "forvalues i = 1/2 {;",
      "  display `i';",
      "};",
      "#delimit cr",
      'display "back"',
      "",
    ].join("\n"),
  );
  assert.deepEqual(lines, [
    ". #delimit ;",
    "delimiter now ;",
    '. display "semi"',
    '>   "colon";',
    "semicolon",
    ". forvalues i = 1/2 {;",
    "  2.   display `i';",
    "  3. };",
    "1",
    "2",
    ". #delimit cr",
    "delimiter now cr",
    '. display "back"',
    "back",
  ]);
});

test("a command wider than the linesize is cut where Stata cuts it, and a text log cuts its output", () => {
  const long =
    'display "this is a quite long string that goes past the seventy-nine character line limit of the log"';
  assert.deepEqual(commandLines({ command: long.slice(0) }), [
    '. display "this is a quite long string that goes past the seventy-nine characte',
    '> r line limit of the log"',
  ]);
  assert.deepEqual(
    commandLines({
      command:
        'local long "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff gggggggggg hhhhhhhhhh"',
    }),
    [
      '. local long "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffffffff',
      '>  gggggggggg hhhhhhhhhh"',
    ],
  );
  // Stata 19's text log of log using lg17, text replace nomsg / display /
  // log close.
  const session = createConsoleSession();
  session.run(`log using lg17, text replace nomsg\n${long}\nlog close\n`, {
    doFile: true,
  });
  assert.equal(
    session.readFile("lg17.log").text,
    [
      "",
      '. display "this is a quite long string that goes past the seventy-nine characte',
      '> r line limit of the log"',
      "this is a quite long string that goes past the seventy-nine character line limi",
      "> t of the log",
      "",
      ". log close",
      "",
    ].join("\n"),
  );
});

test("macro list, macro drop _all and the system globals", () => {
  const s = createConsoleSession();
  const result = s.run(
    [
      'global sdf_second "this is a long value that goes on and on and on and on and on and on and on past the line"',
      'global a_rather_long_global_name "value"',
      'local loc1 "L"',
      'local verylonglocalname "x"',
      "macro list sdf_second a_rather_long_global_name _verylonglocalname _loc1",
      "capture noisily macro list nosuch",
      "capture noisily macro list _nosuch",
      "capture noisily macro bogus",
      "global g1 a",
      "global g2 b",
      "macro drop g*",
      'display "[$g1][$g2]"',
      "macro drop _all",
      'display "[`loc1\'][$a_rather_long_global_name][$S_level]"',
      'display ("$S_DATE" == c(current_date))',
      "",
    ].join("\n"),
    { doFile: true },
  );
  assert.equal(result.rc, 0);
  const said = (k) => result.output[k].lines;
  assert.deepEqual(said(4), [
    "sdf_second:     this is a long value that goes on and on and on and on and on",
    "                and on and on past the line",
    "a_rather_long_global_name:",
    "                value",
    "_verylonglocalname:",
    "                x",
    "_loc1:          L",
  ]);
  assert.deepEqual(said(5), ["global macro $nosuch not found"]);
  assert.deepEqual(said(6), ["local macro `nosuch' not found"]);
  assert.deepEqual(said(7), ["invalid syntax"]);
  assert.deepEqual(said(11), ["[][]"]);
  assert.deepEqual(said(13), ["[][][95]"]);
  assert.deepEqual(said(14), ["1"]);
});

test("program dir and program list show what Stata 19 shows", () => {
  const { result } = runFile(
    [
      "program zeta",
      '    display "z"   // trailing',
      '\tdisplay "tabbed"',
      "    local a = 1 /* inline */ + 2",
      '    display "a" ///',
      '        "b"',
      "end",
      "program alpha",
      'display "a"',
      "end",
      "program mid, rclass",
      'display "m"',
      "end",
      "program dir",
      "program list",
      "capture noisily program list nosuch",
      "capture noisily program drop nosuch",
      "capture noisily program dir nosuch",
      "display _rc",
      "",
    ].join("\n"),
  );
  assert.equal(result.rc, 0);
  const said = (command) =>
    result.output.find((record) => record.command === command).lines;
  assert.deepEqual(said("program dir"), [
    "           249  mid",
    "           249  alpha",
    "           313  zeta",
    "      --------",
    "           811",
    "",
  ]);
  assert.deepEqual(said("program list").filter(Boolean), [
    "mid, rclass:",
    '  1. display "m"',
    "alpha:",
    '  1. display "a"',
    "zeta:",
    '  1.     display "z"',
    '  2.         display "tabbed"',
    "  3.     local a = 1 + 2",
    '  4.     display "a" "b"',
  ]);
  assert.deepEqual(said("capture noisily program list nosuch"), [
    "program nosuch not found",
  ]);
  assert.deepEqual(said("capture noisily program drop nosuch"), [
    "program nosuch not found",
  ]);
  assert.deepEqual(said("capture noisily program dir nosuch"), [
    "nosuch not allowed",
  ]);
  assert.deepEqual(said("display _rc"), ["101"]);
  const named = new Session().run("capture noisily program define 1abc");
  assert.deepEqual(named.output[0].lines, ["1abc invalid name"]);
});

test("cmdlog opens, pauses and closes as Stata's does, and keeps typed commands", () => {
  // Stata 19's messages and return codes; its paths are the session's
  // folder here.
  const s = createConsoleSession();
  const said = (command) => {
    const result = s.run(`capture noisily ${command}\ndisplay _rc`);
    return [result.output[0].lines, Number(result.output[1].lines[0])];
  };
  assert.deepEqual(said("cmdlog close"), [["no cmdlog file open"], 607]);
  assert.deepEqual(said("cmdlog"), [["(closed)"], 0]);
  assert.deepEqual(said("cmdlog using cl1"), [
    ["(cmdlog /stataverse/cl1.txt opened)"],
    0,
  ]);
  assert.deepEqual(said("cmdlog off"), [
    ["(cmdlog /stataverse/cl1.txt paused)"],
    0,
  ]);
  assert.deepEqual(said("cmdlog on"), [
    ["(cmdlog /stataverse/cl1.txt resumed)"],
    0,
  ]);
  assert.deepEqual(said("cmdlog using cl2.log"), [
    ["log file already open"],
    604,
  ]);
  assert.deepEqual(said("cmdlog query"), [
    ["    cmdlog:  /stataverse/cl1.txt, on"],
    0,
  ]);
  s.run('display "typed"');
  // A do-file's commands are not written to it, as in Stata.
  s.run('display "from a do-file"', { doFile: true });
  assert.deepEqual(said("cmdlog close"), [
    ["(cmdlog /stataverse/cl1.txt closed)"],
    0,
  ]);
  assert.match(s.readFile("cl1.txt").text, /display "typed"/);
  assert.doesNotMatch(s.readFile("cl1.txt").text, /from a do-file/);
  assert.deepEqual(said("cmdlog using cl1"), [
    ["file /stataverse/cl1.txt already exists"],
    602,
  ]);
  assert.deepEqual(said("cmdlog using cl1, bogus"), [
    ["option bogus not allowed"],
    198,
  ]);
  assert.deepEqual(said("cmdlog using cl3, replace"), [
    [
      "(file /stataverse/cl3.txt not found)",
      "(cmdlog /stataverse/cl3.txt opened)",
    ],
    0,
  ]);
});

test("do takes nostop and no other option, and needs a file", () => {
  const session = createConsoleSession();
  session.addFile(
    "child.do",
    "args first second\ndisplay \"[`first'][`second']\"\n",
  );
  let result = session.run(
    "capture noisily do child.do a b, opt\ndisplay _rc",
    {
      doFile: true,
    },
  );
  assert.deepEqual(result.output[0].lines, ["option opt not allowed"]);
  assert.deepEqual(result.output.at(-1).lines, ["198"]);
  result = session.run("capture noisily do\ndisplay _rc", { doFile: true });
  assert.deepEqual(result.output[0].lines, ["invalid file specification"]);
  assert.deepEqual(result.output.at(-1).lines, ["198"]);
  result = session.run("do child.do a b", { doFile: true });
  assert.ok(result.output.some((record) => record.lines.includes("[a][b]")));
});
