// The Console with a student's own files: large files, the files kept by
// the page, the project zip, graph export and how loops are echoed. The
// expected text was recorded from Stata 19 MP (version 17, set processors
// 1) on the same commands; every file here is built in code from simulated
// data.
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession, missingFile } from "../src/console-session.js";
import {
  fileKind,
  giveFile,
  loadCommand,
  readBlob,
  refusal,
} from "../src/console-files.js";
import { mentions, projectZip } from "../src/console-project.js";
import { deflate, pdfOf } from "../src/console-picture.js";
import { writeDta } from "../src/console-dta.js";

/** Records as Stata's log shows them. */
const transcript = (output) =>
  output
    .flatMap((record) => [
      `. ${record.command}`,
      ...(record.echo ?? []),
      ...record.lines,
      "",
    ])
    .join("\n")
    .trimEnd();

test("a loop is echoed once, its lines numbered, as Stata 19 shows it", () => {
  const source = [
    "clear",
    "set obs 5",
    "generate income = _n * 1000",
    "generate age = 20 + _n",
    "local vars income age",
    "foreach v of local vars {",
    "    quietly summarize `v'",
    '    display "`v\': mean = " %9.2f r(mean)',
    "}",
    "forvalues i = 1/2 {",
    "",
    '    display "i=`i\'"',
    "    foreach w in a b {",
    '        display "`w\'" ///',
    '            "!"',
    "    }",
    "}",
    "forvalues i = 5/1 {",
    '    display "never"',
    "}",
    'display "after"',
    "forvalues i = 1/3 {",
    "    display `i'",
    "    generate age = `i'",
    "}",
    'display "not reached"',
  ].join("\n");
  const session = createConsoleSession(),
    result = session.run(source);
  assert.equal(result.rc, 110);
  assert.equal(
    transcript(result.output),
    `. clear

. set obs 5
Number of observations (_N) was 0, now 5.

. generate income = _n * 1000

. generate age = 20 + _n

. local vars income age

. foreach v of local vars {
  2.     quietly summarize \`v'
  3.     display "\`v': mean = " %9.2f r(mean)
  4. }
income: mean =   3000.00
age: mean =     23.00

. forvalues i = 1/2 {
  2.${" "}
.     display "i=\`i'"
  3.     foreach w in a b {
  4.         display "\`w'" ///
>             "!"
  5.     }
  6. }
i=1
a!
b!
i=2
a!
b!

. forvalues i = 5/1 {
  2.     display "never"
  3. }

. display "after"
after

. forvalues i = 1/3 {
  2.     display \`i'
  3.     generate age = \`i'
  4. }
1
variable age already defined
r(110);`,
  );
  // The folded record keeps the line the loop starts on, for the gutter.
  assert.equal(result.output.find((r) => /^foreach/.test(r.command)).line, 6);
});

test("comment lines in a loop echo as Stata 19 echoes them", () => {
  const source =
      'foreach v in a /// comment\n   b {\n    display "`v\'"\n    // note\n    * star\n}',
    output = createConsoleSession().run(source).output;
  assert.equal(
    transcript(output),
    [
      ". foreach v in a /// comment",
      ">    b {",
      '  2.     display "`v\'"',
      "  3.     // note",
      ".     * star",
      ". }",
      "a",
      "b",
    ].join("\n"),
  );
  // A quiet loop shows only its first line, as in Stata.
  assert.deepEqual(
    createConsoleSession().run('quietly foreach v in a {\ndisplay "x"\n}')
      .output[0],
    {
      command: "quietly foreach v in a {",
      echo: [],
      lines: [],
      rc: 0,
      line: 1,
    },
  );
  // A program's body is not run where it is written; its loop is not echoed.
  const program = createConsoleSession().run(
    "program define twice\n  forvalues i = 1/2 {\n    display `i'\n  }\nend\ntwice",
  ).output;
  assert.deepEqual(
    program.map((r) => r.command),
    ["twice"],
  );
});

test("graph export writes .svg, .png and .pdf with Stata 19's messages", () => {
  const session = createConsoleSession(),
    result = session.run(
      [
        "clear",
        "set obs 5",
        "generate x = _n",
        "generate y = x^2",
        "capture noisily graph export early.svg",
        "scatter y x",
        "graph export fig1.svg, replace",
        "graph export fig1.png",
        "capture noisily graph export fig1.png",
        "graph export fig1.pdf, replace width(4)",
        "graph export fig2, as(png)",
        "capture noisily graph export fig3.bmp",
        "capture noisily graph export fig4.jpg",
        "capture noisily graph export fig4.png, width(5)",
        "capture noisily graph export fig5.pdf, height(30)",
        "capture noisily graph export fig6.svg, name(nosuch)",
        "capture noisily graph export fig7.png, foo",
        "capture noisily graph export fig8.png, as(PNG)",
        "capture noisily graph export",
        "quietly graph export fig9.svg, height(400)",
        "capture noisily use fig1.png, clear",
      ].join("\n"),
    ),
    printed = Object.fromEntries(
      result.output.map((record) => [record.command, record.lines]),
    );
  assert.equal(result.rc, 0);
  assert.deepEqual(printed["capture noisily graph export early.svg"], [
    "no Graph window open",
  ]);
  assert.deepEqual(printed["graph export fig1.svg, replace"], [
    "(file fig1.svg not found)",
    "file fig1.svg saved as SVG format",
  ]);
  assert.deepEqual(printed["graph export fig1.png"], [
    "file fig1.png written in PNG format",
  ]);
  assert.deepEqual(printed["capture noisily graph export fig1.png"], [
    "file fig1.png already exists",
  ]);
  assert.deepEqual(printed["graph export fig1.pdf, replace width(4)"], [
    "file fig1.pdf saved as PDF format",
  ]);
  assert.deepEqual(printed["graph export fig2, as(png)"], [
    "file fig2 written in PNG format",
  ]);
  assert.deepEqual(printed["capture noisily graph export fig3.bmp"], [
    "output file suffix bmp not recognized\n    Specify correct suffix or specify as() option.",
  ]);
  assert.deepEqual(printed["capture noisily graph export fig4.png, width(5)"], [
    "width() must be an integer between 8 and 16,000",
  ]);
  assert.deepEqual(
    printed["capture noisily graph export fig5.pdf, height(30)"],
    ["height() must be a number between 0.5 and 20"],
  );
  assert.deepEqual(
    printed["capture noisily graph export fig6.svg, name(nosuch)"],
    ["could not find Graph window"],
  );
  assert.deepEqual(printed["capture noisily graph export fig7.png, foo"], [
    "option foo not allowed",
  ]);
  assert.deepEqual(printed["capture noisily graph export fig8.png, as(PNG)"], [
    "option as(PNG) invalid",
  ]);
  assert.deepEqual(printed["capture noisily graph export"], [
    "invalid file specification",
  ]);
  assert.deepEqual(printed["quietly graph export fig9.svg, height(400)"], []);
  assert.deepEqual(printed["capture noisily use fig1.png, clear"], [
    "file fig1.png not Stata format",
  ]);
  // A format Stata writes and the Console does not is refused, not ignored.
  assert.match(
    printed["capture noisily graph export fig4.jpg"][0],
    /writes \.svg, \.png and \.pdf files here/,
  );
  // The files are in the session's folder, and the page is told of each.
  const files = result.memory.files;
  for (const name of ["fig1.svg", "fig1.png", "fig1.pdf", "fig2", "fig9.svg"])
    assert.ok(files.includes(name), name);
  assert.deepEqual(
    result.made.map((file) => [file.name, file.format]),
    [
      ["fig1.svg", "svg"],
      ["fig1.png", "png"],
      ["fig1.pdf", "pdf"],
      ["fig2", "png"],
      ["fig9.svg", "svg"],
    ],
  );
  const svg = result.made[0].svg;
  assert.match(svg, /^<\?xml version="1.0"/);
  // Stata 19 draws a graph 7.5 by 4.5 inches.
  assert.match(svg, /<svg width="7\.500in" height="4\.500in" /);
  // height() alone keeps the graph's shape, as Stata 19 does.
  assert.match(result.made[4].svg, /<svg width="667px" height="400px" /);
  // width(4) of a PDF is in inches.
  assert.equal(result.made[2].width, 4 * 96);
  // The next run starts with none to tell.
  assert.deepEqual(session.run("display 1").made, []);
});

test("a PDF of the graph is well formed", async () => {
  const pixels = new Uint8Array(2 * 2 * 3).fill(255),
    packed = await deflate(pixels),
    bytes = pdfOf({
      width: 480,
      height: 345,
      columns: 2,
      rows: 2,
      pixels: packed,
      packed: true,
    }),
    text = Buffer.from(bytes).toString("latin1");
  assert.match(text, /^%PDF-1\.4\n/);
  assert.match(text, /\/MediaBox \[0 0 480 345\]/);
  assert.match(text, /\/Filter \/FlateDecode/);
  // Each entry of the cross-reference table points at its object.
  const start = Number(/startxref\n(\d+)/.exec(text)[1]),
    offsets = text
      .slice(start)
      .split("\n")
      .slice(3, 8)
      .map((line) => Number(line.slice(0, 10)));
  offsets.forEach((at, k) =>
    assert.equal(text.slice(at, at + 8), `${k + 1} 0 obj\n`),
  );
  assert.match(text, /%%EOF\n$/);
});

test("a dataset of 500,000 observations and 12 variables is read", () => {
  const session = createConsoleSession();
  const made = session.run(
    [
      "clear",
      "set obs 500000",
      "generate long id = _n",
      "generate byte g = mod(_n, 7)",
      "generate int year = 2000 + mod(_n, 20)",
      ...Array.from(
        { length: 9 },
        (_, k) => `generate float x${k + 1} = mod(_n * ${k + 3}, 101) / 7`,
      ),
    ].join("\n"),
  );
  assert.equal(made.rc, 0);
  const bytes = session.exportData().bytes,
    added = session.addData("big500k12.dta", bytes);
  assert.equal(added.rows, 500000);
  assert.equal(added.variables, 12);
  const used = session.run('use "big500k12.dta", clear\nsummarize x9');
  assert.equal(used.rc, 0);
  assert.equal(used.memory.observations, 500000);
});

test("a dataset of 3,000 observations and 2,000 variables is read", () => {
  const session = createConsoleSession();
  assert.equal(
    session.run(
      "clear\nset obs 3000\nforvalues j = 1/2000 {\n  quietly generate byte v`j' = mod(_n, 5)\n}",
    ).rc,
    0,
  );
  const added = session.addData("wide.dta", session.exportData().bytes);
  assert.equal(added.rows, 3000);
  assert.equal(added.variables, 2000);
});

test("a CSV file of 300,000 rows (8.9 MB) is imported", () => {
  const rows = ["id,x,g,s"];
  for (let i = 1; i <= 300000; i++)
    rows.push(`${i},${((i * 7919) % 100000) / 1000},${i % 9},s${i % 13}`);
  const session = createConsoleSession();
  session.addFile("tall.csv", rows.join("\n") + "\n");
  const result = session.run("import delimited using tall.csv, clear");
  assert.equal(result.rc, 0);
  // Stata 19 names the encoding its scan chose, UTF-8 for this file.
  assert.deepEqual(result.output[0].lines, [
    "(encoding automatically selected: UTF-8)",
    "(4 vars, 300,000 obs)",
  ]);
});

test("the Variables pane is told each variable's value label", () => {
  const session = createConsoleSession(),
    result = session.run(
      'clear\nset obs 2\ngenerate female = _n - 1\nlabel define sexlbl 0 "male" 1 "female"\nlabel values female sexlbl\ngenerate x = 1',
    );
  assert.deepEqual(
    result.memory.variables.map((v) => [v.name, v.valueLabel]),
    [
      ["female", "sexlbl"],
      ["x", ""],
    ],
  );
});

test("each kind of file is loaded by the command Stata uses for it", () => {
  assert.equal(loadCommand("a b.dta"), 'use "a b.dta", clear');
  assert.equal(
    loadCommand("course.xlsx"),
    'import excel using "course.xlsx", firstrow clear',
  );
  assert.equal(
    loadCommand("course.XLSM"),
    'import excel using "course.XLSM", firstrow clear',
  );
  assert.equal(
    loadCommand("old.xls"),
    'import excel using "old.xls", firstrow clear',
  );
  assert.equal(loadCommand("s.sav"), 'import spss using "s.sav", clear');
  assert.equal(
    loadCommand("DEMO_J.XPT"),
    'import sasxport5 "DEMO_J.XPT", clear',
  );
  assert.equal(
    loadCommand("c.sas7bdat"),
    'import sas using "c.sas7bdat", clear',
  );
  assert.equal(
    loadCommand("my data.csv"),
    'import delimited using "my data.csv", clear',
  );
  assert.deepEqual(
    [
      "x.dta",
      "x.do",
      "x.xlsx",
      "x.xls",
      "x.sav",
      "x.xpt",
      "x.sas7bdat",
      "x.csv",
      "x.txt",
    ].map(fileKind),
    [
      "dta",
      "do",
      "binary",
      "binary",
      "binary",
      "binary",
      "binary",
      "text",
      "text",
    ],
  );
  // Files nothing here or in Stata reads are refused with what to do.
  assert.match(refusal("model.rds", 10), /haven::write_dta/);
  assert.match(refusal("data.parquet", 10), /to_stata/);
  assert.match(refusal("bundle.zip", 10), /Unpack it/);
  assert.equal(refusal("course.xlsx", 10), "");
  assert.equal(refusal("big.csv", 300_000_000), "");
  assert.match(refusal("huge.csv", 600_000_000), /more than a browser tab/);
});

test("a workbook, SPSS or SAS file is given to the session as its bytes", async () => {
  // A stub session shows where each kind of file goes; the import commands
  // that read the bytes are another part of the runtime.
  const calls = [],
    stub = {
      addData: (name) => calls.push(["data", name]),
      addBinary: (name, bytes) => calls.push(["binary", name, bytes.length]),
      // Text arrives as its bytes, decoded in the session as Stata decodes it.
      addFile: (name, file) =>
        calls.push(["text", name, new TextDecoder().decode(file)]),
    },
    bytes = new Uint8Array([80, 75, 3, 4, 0, 0]);
  for (const name of ["course.xlsx", "s.sav", "DEMO_J.xpt", "c.sas7bdat"])
    giveFile(stub, name, fileKind(name), bytes);
  giveFile(stub, "a.csv", "text", new TextEncoder().encode("﻿x,y\n1,2\n"));
  assert.deepEqual(calls, [
    ["binary", "course.xlsx", 6],
    ["binary", "s.sav", 6],
    ["binary", "DEMO_J.xpt", 6],
    ["binary", "c.sas7bdat", 6],
    ["text", "a.csv", "x,y\n1,2\n"],
  ]);
  assert.throws(
    () => createConsoleSession().addFile("odd.txt", bytes),
    /odd\.txt is not a text file/,
  );
  // In the real session the bytes are kept under the file's name.
  const session = createConsoleSession(),
    result = session.addBinary("course.xlsx", bytes);
  assert.ok(result.memory.files.includes("course.xlsx"));
  session.reset();
  assert.ok(session.run("display 1").memory.files.includes("course.xlsx"));
  // A file read in pieces arrives whole, with its progress told.
  const told = [],
    blob = new Blob([new Uint8Array(300000).fill(7)]),
    read = await readBlob(blob, (loaded, total) => told.push([loaded, total]));
  assert.equal(read.length, 300000);
  assert.ok(read.every((byte) => byte === 7));
  assert.deepEqual(told.at(-1), [300000, 300000]);
});

test("a run that needs a file that is not there names it", () => {
  const session = createConsoleSession(),
    result = session.run('use "labels.dta", clear');
  assert.equal(result.rc, 601);
  assert.equal(missingFile(result.output), "labels.dta");
  assert.equal(
    missingFile(session.run("import delimited using gone.csv, clear").output),
    "gone.csv",
  );
  assert.equal(missingFile(session.run("display 1").output), "");
});

test("the project zip carries data named without its extension", () => {
  assert.ok(mentions("use left, clear", "left.dta"));
  assert.ok(mentions("merge 1:1 id using right", "right.dta"));
  assert.ok(
    mentions('import delimited using "my data é.csv"', "my data é.csv"),
  );
  assert.ok(!mentions("use leftover, clear", "left.dta"));
  const bytes = projectZip(
      [
        {
          name: "main.do",
          text: "use left, clear\nmerge 1:1 id using right\ntab _merge",
        },
      ],
      [
        { name: "left.dta", data: new Uint8Array([1]) },
        { name: "right.dta", data: new Uint8Array([2]) },
        { name: "typed.csv", data: "a\n1\n" },
        { name: "unused.csv", data: "a\n1\n" },
        { name: "fig1.png", data: new Uint8Array([3]), made: true },
      ],
      new Date(2026, 10, 13),
      'import delimited using "typed.csv", clear',
    ),
    text = Buffer.from(bytes).toString("latin1");
  for (const name of ["left.dta", "right.dta", "typed.csv", "fig1.png"])
    assert.ok(text.includes(`stata-project/${name}`), name);
  assert.ok(!text.includes("stata-project/unused.csv"));
  assert.ok(text.includes("fig1.png    a graph the do-file exported"));
});

test("a dataset of 30 million cells is used, saved and checked for changes", () => {
  // 3,000,000 observations of 10 floats, the size Stata 19 loaded at once
  // for the tester; a text fingerprint of the cells broke past 28 million.
  const n = 3_000_000,
    column = new Float64Array(n);
  for (let i = 0; i < n; i++)
    column[i] = Math.fround(((i * 7919) % 10007) / 10007);
  const variables = Array.from({ length: 10 }, (_, k) => ({
      name: `x${k + 1}`,
      type: "float",
      format: "%9.0g",
      label: "",
      valueLabel: "",
      data: column,
    })),
    bytes = writeDta({
      n,
      label: "",
      variables,
      valueLabels: new Map(),
      sortedBy: [],
    }),
    session = createConsoleSession();
  assert.equal(session.addData("big3m.dta", bytes).rows, n);
  const result = session.run(
    "use big3m.dta, clear\ncount\nreplace x1 = 2 in 1\ncapture noisily use big3m.dta\nsave b2, replace\nuse big3m.dta",
  );
  assert.equal(result.rc, 0);
  assert.deepEqual(
    result.output.map((record) => [record.command, record.lines]),
    [
      ["use big3m.dta, clear", []],
      ["count", ["  3,000,000"]],
      ["replace x1 = 2 in 1", ["(1 real change made)"]],
      [
        "capture noisily use big3m.dta",
        ["no; dataset in memory has changed since last saved"],
      ],
      ["save b2, replace", ["(file b2.dta not found)", "file b2.dta saved"]],
      ["use big3m.dta", []],
    ],
  );
});

/** Records as Stata's log shows them, without blanks at the ends of lines. */
const log = (output) =>
  transcript(output)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

test("exit leaves a loop run from the do-file, and ends the do-file elsewhere", () => {
  const session = createConsoleSession();
  let result = session.run(
    'clear\nset obs 2\ngenerate x = _n\ndisplay "before exit"\nexit\ndisplay "not run"\nforvalues i = 1/2 {\n    display "loop `i\'"\n}\nforeach v of varlist nosuch {\n    display "`v\'"\n}',
  );
  // Nothing after exit is run or echoed.
  assert.equal(result.rc, 0);
  assert.deepEqual(
    result.output.map((record) => record.command),
    ["clear", "set obs 2", "generate x = _n", 'display "before exit"', "exit"],
  );
  result = session.run(
    [
      "clear",
      "set obs 2",
      "generate x = _n",
      "foreach v in a b {",
      '    display "in `v\'"',
      "    exit",
      "}",
      'display "after exit"',
      "forvalues i = 1/2 {",
      "    if `i' == 1 {",
      '        display "one"',
      "    }",
      "    else {",
      '        display "other"',
      "    }",
      "}",
      "foreach v of varlist nosuch {",
      '    display "`v\'"',
      "}",
      'display "not run"',
    ].join("\n"),
  );
  assert.equal(result.rc, 111);
  assert.equal(
    log(result.output),
    `. clear

. set obs 2
Number of observations (_N) was 0, now 2.

. generate x = _n

. foreach v in a b {
  2.     display "in \`v'"
  3.     exit
  4. }
in a

. display "after exit"
after exit

. forvalues i = 1/2 {
  2.     if \`i' == 1 {
  3.         display "one"
  4.     }
  5.     else {
  6.         display "other"
  7.     }
  8. }
one
other

. foreach v of varlist nosuch {
  2.     display "\`v'"
  3. }
variable nosuch not found
r(111);`,
  );
  // exit with a code stops the do-file; in a program, exit leaves the
  // program even from inside a loop.
  result = session.run(
    'program define p1\n    foreach v in a b {\n        display "p1 `v\'"\n        exit\n    }\n    display "p1 after loop"\nend\np1\nforeach v in a {\n    exit 198\n}\ndisplay "not reached"',
  );
  assert.equal(result.rc, 198);
  assert.equal(
    log(result.output.slice(-2)),
    `. p1
p1 a

. foreach v in a {
  2.     exit 198
  3. }
r(198);`,
  );
});

test("loops with quietly, capture and noisily show what Stata 19 shows", () => {
  const result = createConsoleSession().run(
    [
      "clear",
      "set obs 3",
      "generate x = _n",
      "quietly foreach v in c d {",
      '    display "`v\'"',
      '    noisily display "n`v\'"',
      "}",
      "capture foreach v in c d {",
      '    display "`v\'"',
      "}",
      "capture noisily forvalues i = 1/2 {",
      '    display "cn`i\'"',
      "}",
      "qui forvalues i = 1/2 {",
      '    display "q`i\'"',
      "}",
      "noisily foreach v in g {",
      '    display "`v\'"',
      "}",
      "quietly {",
      '    display "inside quiet"',
      '    noisily display "noisy inside"',
      "    forvalues i = 1/2 {",
      '        noisily display "qn`i\'"',
      "    }",
      "}",
      "capture noisily foreach v in c d {",
      '    display "`v\'"',
      "    confirm variable nosuch",
      "}",
      "display _rc",
      "capture foreach v in c d {",
      '    display "`v\'"',
      "    exit 111",
      "}",
      "display _rc",
      "capture {",
      '    display "in capture block"',
      '    noisily display "noisy in capture"',
      "}",
    ].join("\n"),
  );
  assert.equal(result.rc, 0);
  assert.equal(
    log(result.output.slice(3)),
    `. quietly foreach v in c d {
nc
nd

. capture foreach v in c d {

. capture noisily forvalues i = 1/2 {
  2.     display "cn\`i'"
  3. }
cn1
cn2

. qui forvalues i = 1/2 {

. noisily foreach v in g {
  2.     display "\`v'"
  3. }
g

. quietly {
noisy inside
qn1
qn2

. capture noisily foreach v in c d {
  2.     display "\`v'"
  3.     confirm variable nosuch
  4. }
c
variable nosuch not found

. display _rc
0

. capture foreach v in c d {

. display _rc
0

. capture {
noisy in capture`,
  );
});

test("do and include show the file's commands and fold its loops, as Stata 19 does", () => {
  const session = createConsoleSession();
  session.addFile(
    "sub.do",
    'display "sub line 1"\ndisplay "sub line 2"\nforvalues k = 1/2 {\n    display "subloop `k\'"\n}\n',
  );
  session.addFile(
    "sub2.do",
    'display "sub2 one"\nexit\ndisplay "sub2 not run"\n',
  );
  session.addFile(
    "sub3.do",
    'display "sub3 one"\nnosuchcommand\ndisplay "sub3 not run"\n',
  );
  let result = session.run(
    'clear\nforvalues i=1/2 {\n    display "main `i\'"\n}\ndo sub.do\nforvalues i = 1/2 {\n    run sub.do\n}\ninclude sub.do\ndisplay "end"',
  );
  assert.equal(result.rc, 0);
  assert.equal(
    log(result.output),
    `. clear

. forvalues i=1/2 {
  2.     display "main \`i'"
  3. }
main 1
main 2

. do sub.do

. display "sub line 1"
sub line 1

. display "sub line 2"
sub line 2

. forvalues k = 1/2 {
  2.     display "subloop \`k'"
  3. }
subloop 1
subloop 2

.
end of do-file

. forvalues i = 1/2 {
  2.     run sub.do
  3. }

. include sub.do

. display "sub line 1"
sub line 1

. display "sub line 2"
sub line 2

. forvalues k = 1/2 {
  2.     display "subloop \`k'"
  3. }
subloop 1
subloop 2

. display "end"
end`,
  );
  // The records of a file carry the line of the do command, for the gutter.
  assert.ok(result.output.slice(2, 7).every((record) => record.line === 5));
  result = session.run(
    'do sub2.do\ndisplay "after sub2"\ndo sub3.do\ndisplay "not reached"',
  );
  assert.equal(result.rc, 199);
  assert.equal(
    log(result.output),
    `. do sub2.do

. display "sub2 one"
sub2 one

. exit

end of do-file

. display "after sub2"
after sub2

. do sub3.do

. display "sub3 one"
sub3 one

. nosuchcommand
command nosuchcommand is unrecognized
r(199);

end of do-file
r(199);`,
  );
});

test("the project zip carries data a loop names through a macro", () => {
  assert.ok(
    mentions("import delimited using sales`y'.csv, clear", "sales2018.csv"),
  );
  assert.ok(mentions("    append using wave`w'", "wave2.dta"));
  assert.ok(mentions('use "data/wave`w\'.dta", clear', "wave2.dta"));
  assert.ok(mentions("use ${stem}_clean", "panel_clean.dta"));
  assert.ok(!mentions("import delimited using sales`y'.csv", "sales2018.dta"));
  // A macro alone, as in display "`v'", names no file.
  assert.ok(!mentions('display "`v\': mean"', "left.dta"));
  const zipped = (text, names) =>
    Buffer.from(
      projectZip(
        [{ name: "main.do", text }],
        names.map((name) => ({ name, data: "a\n1\n" })),
        new Date(2026, 10, 13),
      ),
    ).toString("latin1");
  let text = zipped(
    "forvalues y = 2018/2019 {\n    import delimited using sales`y'.csv, clear\n    save s`y', replace\n}\n",
    ["sales2018.csv", "sales2019.csv", "other.csv"],
  );
  assert.ok(text.includes("stata-project/sales2018.csv"));
  assert.ok(text.includes("stata-project/sales2019.csv"));
  assert.ok(!text.includes("stata-project/other.csv"));
  text = zipped(
    "use wave1, clear\nforvalues w = 2/2 {\n    append using wave`w'\n}",
    ["wave1.dta", "wave2.dta"],
  );
  assert.ok(text.includes("stata-project/wave2.dta"));
});

test("files are found whatever the case of their names, as Stata 19 finds them on macOS", () => {
  const session = createConsoleSession();
  session.addFile("Sales.CSV", "id,amount\n1,10\n2,20\n3,30\n");
  session.addFile("Sub.do", 'display "in sub"\n');
  const result = session.run(
    [
      "clear",
      "set obs 3",
      "generate id = _n",
      "generate v = id * 2",
      "save Left, replace",
      "use left.dta, clear",
      "use left, clear",
      "merge 1:1 id using LEFT",
      "import delimited using sales.csv, clear",
      "run sub",
    ].join("\n"),
  );
  assert.equal(result.rc, 0);
  const printed = Object.fromEntries(
    result.output.map((record) => [record.command, record.lines]),
  );
  assert.equal(
    printed["import delimited using sales.csv, clear"].at(-1),
    "(2 vars, 3 obs)",
  );
  assert.match(printed["merge 1:1 id using LEFT"].join("\n"), /Matched\s+3/);
  // A path into a folder is not found: the Console's files have no folders.
  assert.equal(
    missingFile(session.run('use "data/left.dta", clear').output),
    "data/left.dta",
  );
});

test("graph export refuses where Stata 19 refuses and sizes files as Stata does", () => {
  const session = createConsoleSession(),
    result = session.run(
      [
        "clear",
        "set obs 5",
        "generate x = _n",
        "generate y = x^2",
        "scatter y x",
        "graph export d1.png",
        "graph export d2.png, width(1000)",
        "graph export d3.png, height(300)",
        "graph export d4.svg",
        "graph export d5.svg, width(1000)",
        "graph export d6.pdf",
        "graph export d7.pdf, width(4)",
        "graph export d8.png, width(1000) height(300)",
        "graph export e1.svg, height(400)",
        "graph export e2.svg, width(2.5)",
        "graph export e4.png, height(400)",
        "capture noisily graph export figT.svg, height(abc)",
        "capture noisily graph export figT.svg, width(0)",
        "capture noisily graph export figU.png, width(abc)",
        "capture noisily graph export figU.pdf, width(0)",
        "capture noisily graph export sub/figH.png",
        'capture noisily graph export "nosuchdir/figH.svg"',
        "scatter x y, nodraw name(nd)",
        "capture noisily graph export figL.svg, name(nd)",
        "graph export figL2.svg",
        "clear all",
        "capture noisily graph export figP.png",
        "display _rc",
        "capture noisily graph export figP.png, name(Graph)",
        "display _rc",
      ].join("\n"),
    ),
    printed = Object.fromEntries(
      result.output.map((record) => [record.command, record.lines]),
    ),
    made = Object.fromEntries(result.made.map((file) => [file.name, file]));
  assert.equal(result.rc, 0);
  // Stata 19's sizes: PNG pixels, the SVG's width and height, the PDF page
  // (the page draws a PDF at 3/4 point to the pixel).
  const size = (name) => [made[name].width, made[name].height];
  assert.deepEqual(size("d1.png"), [720, 432]);
  assert.deepEqual(size("d2.png"), [1000, 600]);
  assert.deepEqual(size("d3.png"), [500, 300]);
  assert.deepEqual(size("d8.png"), [1000, 300]);
  assert.deepEqual(size("e4.png"), [666, 400]);
  assert.match(made["d4.svg"].svg, /<svg width="7\.500in" height="4\.500in" /);
  assert.match(made["d5.svg"].svg, /<svg width="1000px" height="600px" /);
  assert.match(made["e1.svg"].svg, /<svg width="667px" height="400px" /);
  assert.match(made["e2.svg"].svg, /<svg width="3px" height="2px" /);
  assert.match(made["figT.svg"].svg, /<svg width="0px" height="0px" /);
  assert.deepEqual(
    size("d6.pdf").map((n) => n * 0.75),
    [540, 324],
  );
  assert.deepEqual(
    size("d7.pdf").map((n) => +(n * 0.75).toFixed(2)),
    [288, 172.8],
  );
  assert.deepEqual(
    printed["capture noisily graph export figT.svg, height(abc)"],
    ["'abc' is an invalid height"],
  );
  assert.deepEqual(printed["capture noisily graph export figT.svg, width(0)"], [
    "file figT.svg saved as SVG format",
  ]);
  assert.deepEqual(
    printed["capture noisily graph export figU.png, width(abc)"],
    ["width() must be an integer between 8 and 16,000"],
  );
  assert.deepEqual(printed["capture noisily graph export figU.pdf, width(0)"], [
    "width() must be a number between 0.5 and 20",
  ]);
  assert.deepEqual(printed["capture noisily graph export sub/figH.png"], [
    "file sub/figH.png could not be opened",
  ]);
  assert.deepEqual(
    printed['capture noisily graph export "nosuchdir/figH.svg"'],
    ["file nosuchdir/figH.svg could not be opened"],
  );
  assert.deepEqual(printed["capture noisily graph export figL.svg, name(nd)"], [
    "could not find Graph window",
  ]);
  assert.deepEqual(printed["graph export figL2.svg"], [
    "file figL2.svg saved as SVG format",
  ]);
  assert.deepEqual(printed["capture noisily graph export figP.png"], [
    "could not read from Graph window",
  ]);
  assert.deepEqual(
    printed["capture noisily graph export figP.png, name(Graph)"],
    ["could not read from Graph window"],
  );
  assert.deepEqual(
    result.output
      .filter((r) => r.command === "display _rc")
      .map((r) => r.lines),
    [["692"], ["692"]],
  );
  // Nothing is written where Stata writes nothing.
  for (const name of [
    "sub/figH.png",
    "nosuchdir/figH.svg",
    "figL.svg",
    "figP.png",
  ])
    assert.ok(!result.memory.files.includes(name), name);
});

test("import delimited reads a file kept as bytes as text, as Stata 19 does", () => {
  // Small files built here: text with binary zeros, and a byte only
  // windows-1252 and ISO-8859-1 print.
  const bytesOf = (...parts) =>
      Uint8Array.from(
        parts.flatMap((part) =>
          typeof part === "string"
            ? [...part].map((c) => c.charCodeAt(0))
            : Array.isArray(part)
              ? part
              : [part],
        ),
      ),
    session = createConsoleSession();
  session.addBinary(
    "z1.xlsx",
    bytesOf("id,name,score\n", 0, 0, "1,Ana,3\n2,Bo", 0, "b,4\n3,Cy,5\n"),
  );
  session.addBinary(
    "z2.xlsx",
    bytesOf(
      "id,city\n1,M",
      0xfc,
      "nchen\n2,Paris\n",
      new Array(1200).fill(0),
      "3,Rome\n",
    ),
  );
  session.addBinary("z3.png", bytesOf("x;y\n", 0, "1;2\n3;4\n"));
  const result = session.run(
      [
        "capture noisily import delimited using z1.xlsx, clear",
        "list",
        "capture noisily import delimited using z2.xlsx, clear",
        "list",
        "capture noisily import delimited using z3.png, clear",
        "capture noisily use z1.xlsx, clear",
      ].join("\n"),
    ),
    lines = result.output.map((record) => record.lines);
  assert.equal(result.rc, 0);
  assert.deepEqual(lines[0], [
    "(encoding automatically selected: ISO-8859-1)",
    "Note:  3 binary zeros were ignored in the source file.  The first instance",
    "       occurred on line 1.  Binary zeros are not valid in text data.  Inspect",
    "       your data carefully.",
    "(3 vars, 3 obs)",
  ]);
  assert.ok(lines[1].some((line) => /\|\s+2\s+Bob\s+4 \|/.test(line)));
  assert.deepEqual(lines[2], [
    "(encoding automatically selected: ISO-8859-1)",
    "Note:  1,200 binary zeros were ignored in the source file.  The first",
    "       instance occurred on line 3.  Binary zeros are not valid in text data.",
    "       Inspect your data carefully.",
    "(2 vars, 3 obs)",
  ]);
  assert.ok(lines[3].some((line) => /\|\s+1\s+München \|/.test(line)));
  assert.deepEqual(lines[4], [
    "(encoding automatically selected: ISO-8859-1)",
    "Note:  1 binary zero was ignored in the source file.  The first instance",
    "       occurred on line 1.  Binary zeros are not valid in text data.  Inspect",
    "       your data carefully.",
    "(2 vars, 2 obs)",
  ]);
  assert.deepEqual(lines[5], ["file z1.xlsx not Stata format"]);
});
