// The Console with a student's own files: large files, the files kept by
// the page, the project zip, graph export and how loops are echoed. The
// expected text was recorded from Stata 19 MP (version 17, set processors
// 1) on the same commands; every file here is built in code from simulated
// data.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createConsoleSession,
  foldLoops,
  missingFile,
} from "../src/console-session.js";
import {
  fileKind,
  giveFile,
  loadCommand,
  readBlob,
  refusal,
} from "../src/console-files.js";
import { mentions, projectZip } from "../src/console-project.js";
import { deflate, pdfOf } from "../src/console-picture.js";

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
  assert.deepEqual(foldLoops("quietly foreach v in a {\nx\n}", [])[0], {
    command: "quietly foreach v in a {",
    echo: [],
    lines: [],
    rc: 0,
    line: 1,
  });
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
  assert.match(svg, /<svg width="640px" height="460px" /);
  // height() alone keeps the graph's shape, as Stata 19 does.
  assert.match(result.made[4].svg, /<svg width="557px" height="400px" /);
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
  assert.deepEqual(result.output[0].lines, ["(4 vars, 300,000 obs)"]);
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
      addFile: (name, text) => calls.push(["text", name, text]),
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
    () => giveFile(stub, "odd.txt", "text", bytes),
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
