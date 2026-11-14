// Sixth red-team round, files group: what the recorded output cases cannot
// compare. The text files are written here as the testers wrote them with
// printf (empty lines, quoted fields over two lines, quotes in free-format
// data), which export delimited cannot make. Every expected value was
// recorded from Stata 19 MP (version 17, set processors 1).
//
// sasformats8.xpt was written by Stata 19's export sasxport8 from 48
// simulated doubles; its format names, widths and decimals were then set
// byte by byte to the SAS formats listed in FORMATS8 below.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ACCEPT,
  fileKind,
  giveFile,
  loadCommand,
} from "../src/console-files.js";
import { createConsoleSession } from "../src/console-session.js";
import { applyFormat } from "../src/runtime/format.js";
import { Session } from "../src/runtime/session.js";

const fixture = (name) =>
  new Uint8Array(
    fs.readFileSync(new URL(`./fixtures/userdata/${name}`, import.meta.url)),
  );

function withFiles(files) {
  const session = new Session();
  session.files = new Map(
    Object.entries(files).map(([name, content]) => [
      name,
      typeof content === "string" ? { text: content } : { bytes: content },
    ]),
  );
  return session;
}
const lines = (result) =>
  result.output
    .flatMap((entry) => entry.lines)
    .flatMap((line) => line.split("\n"))
    .map((line) => line.replace(/\s+$/, ""))
    .filter(Boolean);
// The observations as text, each value in its display format, each row's
// values joined by |.
const rows = (session) =>
  Array.from({ length: session.data.n }, (_, i) =>
    session.data.variables
      .map((v) =>
        typeof v.data[i] === "string"
          ? v.data[i]
          : applyFormat(v.data[i], v.format).trim(),
      )
      .join("|"),
  );
const names = (session) => session.data.variables.map((v) => v.name);
const types = (session) =>
  session.data.variables.map((v) => `${v.name} ${v.type} ${v.format}`);

// ----- F3: rows are lines of the file, empty lines included -----
const BLANK =
  "Report generated 2024\n\nregion,sales,units\nEast,1200.50,10\nWest,980,\n\nNorth,NA,7\n";

test("F3: varnames() and rowrange() count empty lines as rows", () => {
  const s = withFiles({
    "blank.csv": BLANK,
    "pipe.txt": BLANK.replace(/,/g, "|"),
    "lead.csv": "\na,b\n1,2\n3,4\n",
    "two.csv": "a,b\n\n\n1,2\n",
    "ws.csv": "a,b\n1,2\n   \n3,4\n\n5,6\n",
  });
  const read = (command) => {
    const result = s.run(command);
    assert.equal(result.rc, 0, command);
    return [names(s).join(" "), ...rows(s)];
  };
  assert.deepEqual(
    read("import delimited using blank.csv, clear varnames(3)"),
    ["region sales units", "East|1200.50|10", "West|980|.", "North|NA|7"],
  );
  assert.deepEqual(
    read('import delimited using pipe.txt, clear delimiters("|") varnames(3)'),
    ["region sales units", "East|1200.50|10", "West|980|.", "North|NA|7"],
  );
  assert.deepEqual(
    read("import delimited using blank.csv, clear rowrange(3:5)"),
    ["v1 v2 v3", "region|sales|units", "East|1200.50|10", "West|980|"],
  );
  assert.deepEqual(
    read("import delimited using blank.csv, clear varnames(3) rowrange(5)"),
    ["region sales units", "West|980|.", "North|NA|7"],
  );
  // An empty names row is passed over, unless emptylines(include) keeps it.
  assert.deepEqual(
    read("import delimited using blank.csv, clear varnames(2)")[0],
    "region sales units",
  );
  assert.deepEqual(
    read(
      "import delimited using blank.csv, clear varnames(2) emptylines(include)",
    ),
    [
      "v1 v2 v3",
      "region|sales|units",
      "East|1200.50|10",
      "West|980|",
      "||",
      "North|NA|7",
      "||",
    ],
  );
  assert.deepEqual(
    read(
      "import delimited using blank.csv, clear rowrange(2:4) emptylines(include)",
    ),
    ["v1 v2 v3", "||", "region|sales|units", "East|1200.50|10"],
  );
  // The end row is reached only by a row that is kept: rowrange(6:6) on an
  // empty sixth line reads the seventh.
  assert.deepEqual(
    read("import delimited using blank.csv, clear rowrange(6:6)"),
    ["v1 v2 v3", "North|NA|7"],
  );
  assert.deepEqual(
    read("import delimited using two.csv, clear rowrange(2:3)"),
    ["a b", "1|2"],
  );
  assert.deepEqual(read("import delimited using two.csv, clear varnames(2)"), [
    "v1 v2",
  ]);
  assert.deepEqual(read("import delimited using lead.csv, clear varnames(1)"), [
    "a b",
    "1|2",
    "3|4",
  ]);
  assert.deepEqual(
    read("import delimited using lead.csv, clear rowrange(1:2)"),
    ["a b"],
  );
  assert.deepEqual(
    read(
      "import delimited using lead.csv, clear varnames(nonames) rowrange(1:2)",
    ),
    ["v1 v2", "a|b"],
  );
  assert.deepEqual(read("import delimited using ws.csv, clear rowrange(:4)"), [
    "a b",
    "1|2",
    "   |.",
    "3|4",
  ]);
  assert.deepEqual(
    read(
      "import delimited using ws.csv, clear rowrange(4:6) emptylines(include)",
    ),
    ["a b", "3|4", ".|.", "5|6"],
  );
});

test("F3: a record over several lines is in rowrange() when any of its lines is", () => {
  const s = withFiles({ "ml3.csv": 'a,b\n"x\ny\nq",2\nz,3\nw,4\n' });
  const count = (range) => {
    s.run(
      `import delimited using ml3.csv, clear bindquotes(strict) rowrange(${range})`,
    );
    return s.data.n;
  };
  assert.deepEqual(
    ["2:2", "3:3", "4:4", "5:5", "2:4", "3:5", "4:6"].map(count),
    [1, 1, 1, 1, 1, 2, 3],
  );
});

test("F3: with varnames(), the rows to the end of rowrange() set the types", () => {
  const s = withFiles({
    "t1.csv": "h1,h2\n1,x\n2,3\n4,5\n6,7\n",
    "t2.csv": "h1,h2\n1,2\n2,3\n4,5\n6,y\n",
    "blank.csv": BLANK,
  });
  s.run("import delimited using t1.csv, clear varnames(1) rowrange(3:4)");
  assert.equal(s.data.get("h2").type, "str1");
  s.run("import delimited using t2.csv, clear varnames(1) rowrange(3:4)");
  assert.equal(s.data.get("h2").type, "byte");
  s.run("import delimited using t1.csv, clear rowrange(3:4)");
  assert.equal(s.data.get("h2").type, "byte");
  s.run("import delimited using blank.csv, clear varnames(3) rowrange(3:5)");
  assert.deepEqual(types(s), [
    "region str4 %9s",
    "sales float %9.0g",
    "units byte %8.0g",
  ]);
});

test("F3: a quote left open is reported on the rows read", () => {
  const s = withFiles({ "ml.csv": 'a,b\n"x\ny",2\nz,3\nw,4\nv,5\n' });
  const notes = (command) =>
    lines(s.run(command))
      .filter((line) => line.startsWith("Note: Unmatched"))
      .map((line) => /row (\d+)/.exec(line)[1]);
  assert.deepEqual(notes("import delimited using ml.csv, clear"), ["2", "3"]);
  assert.deepEqual(notes("import delimited using ml.csv, clear rowrange(3)"), [
    "3",
  ]);
  assert.deepEqual(notes("import delimited using ml.csv, clear rowrange(4)"), [
    "4",
  ]);
  assert.deepEqual(
    notes("import delimited using ml.csv, clear rowrange(1:2)"),
    ["2"],
  );
});

// ----- F10: a space is no separator -----
test("F10: groupseparator() and decimalseparator() drop spaces around the character", () => {
  const s = withFiles({
    "espace.csv":
      "ville;revenu\nParis;35 123,50\nLyon;29 800,25\nNice;980,00\n",
    "pt.csv": "v;w\nP;35.123,50\nQ;12,5\n",
    "nnb.csv": "v;w\nP;35 123,50\nQ;12,5\n",
  });
  const read = (command) => {
    const result = s.run(command);
    return [result.rc, names(s).join(" "), ...rows(s)];
  };
  assert.deepEqual(
    read(
      'import delimited using espace.csv, clear delimiters(";") decimalseparator(,) groupseparator(" ")',
    ),
    [
      0,
      "v1 v2",
      "ville|revenu",
      "Paris|35 123,50",
      "Lyon|29 800,25",
      "Nice|980,00",
    ],
  );
  assert.deepEqual(
    read(
      'import delimited using pt.csv, clear delimiters(";") decimalseparator(", ") groupseparator(" .")',
    ),
    [0, "v w", "P|35123.5", "Q|12.5"],
  );
  assert.deepEqual(
    read(
      'import delimited using nnb.csv, clear delimiters(";") parselocale(fr_FR)',
    ),
    [0, "v w", "P|35123.5", "Q|12.5"],
  );
  // groupseparator() is checked first.
  for (const [options, message] of [
    ["decimalseparator(,) groupseparator(..)", "groupseparator"],
    ["decimalseparator(,,) groupseparator(..)", "groupseparator"],
    ["decimalseparator(,,) groupseparator(.)", "decimalseparator"],
    ['decimalseparator(,) groupseparator(". .")', "groupseparator"],
  ]) {
    const result = s.run(
      `import delimited using pt.csv, clear delimiters(";") ${options}`,
    );
    assert.equal(result.rc, 198);
    assert.deepEqual(lines(result), [
      `option ${message}() may contain only one character.`,
      "r(198);",
    ]);
  }
});

// ----- F4: import sasxport8 formats -----
const FORMATS8 = [
  ["COMMA", "%20.0gc"],
  ["COMMAX", "%20.0gc"],
  ["DOLLAR", "%10.2gc"],
  ["DOLLARX", "%15.0gc"],
  ["NEGPAREN", "%10.0gc"],
  ["OCTAL", "%10.0gc"],
  ["E", "%15.4e"],
  ["D", "%15.4g"],
  ["PERCENT", "%10.2g"],
  ["Z", "%010.2g"],
  ["JULIAN", "%8.0f"],
  ["SSN", "%9.0f"],
  ["HEX", "%21x"],
  ["WORDF", "%8.0g"],
  ["WORDS", "%8.0g"],
  ["ROMAN", "%8.0g"],
  ["DATE", "%td"],
  ["WORDDATE", "%td_Month_DD,_CCYY"],
  ["WEEKDATE", "%td_DAYNAME,_Month_DD,_CCYY"],
  ["WORDDATX", "%td_DAYNAME,_DD_Month_CCYY"],
  ["DDMMYY", "%tdDD/NN/YY"],
  ["MMDDYY", "%tdNN/DD/YY"],
  ["YYMMDD", "%tdYYNNDD"],
  ["MONYY", "%tdMonthCCYY"],
  ["MMYY", "%tdNN!MCCYY"],
  ["YYMM", "%tdCCYY!MNN"],
  ["YYMON", "%tdCCYYMonth"],
  ["YYQ", "%tdCCYY!Qq"],
  ["YEAR", "%tdCCYY"],
  ["MONNAME", "%tdMonth"],
  ["MONTH", "%tdnn"],
  ["QTR", "%tdq"],
  ["DAY", "%tdDD"],
  ["WEEKDAY", "%tdda"],
  ["DOWNAME", "%tdDAYNAME"],
  ["DATETIME", "%tc"],
  ["TIME", "%tcHH:MM:SS"],
  ["TOD", "%tcHH:MM:SS"],
  ["HHMM", "%tcHH:MM"],
  ["MMSS", "%tcMM:SS"],
  ["HOUR", "%tcHH"],
  // A width or decimals, BEST and any other name: %10.0g.
  ["BEST", "%10.0g"],
  ["COMMA12.2", "%10.0g"],
  ["DATE9.", "%10.0g"],
  ["COMMA0.2", "%10.0g"],
  ["F8.2", "%10.0g"],
  ["MYFMT", "%10.0g"],
  ["BEST12.", "%10.0g"],
];

test("F4: import sasxport8 gives SAS formats Stata's display formats", () => {
  const s = withFiles({ "sasformats8.xpt": fixture("sasformats8.xpt") });
  assert.equal(s.run("import sasxport8 sasformats8.xpt, clear").rc, 0);
  assert.deepEqual(
    s.data.variables.map((v) => v.format),
    FORMATS8.map(([, format]) => format),
  );
  // As Stata 19 lists them.
  const listed = (name) =>
    lines(s.run(`list ${name}, noobs`))
      .slice(3, 6)
      .map((line) => line.trim());
  assert.deepEqual(listed("x1"), [
    "|   22,000.25 |",
    "| 1,234,567.5 |",
    "|       -.125 |",
  ]);
  assert.deepEqual(listed("x7"), [
    "|  2.2000e+04 |",
    "|  1.2346e+06 |",
    "| -1.2500e-01 |",
  ]);
  assert.deepEqual(listed("x19"), [
    "|    Thursday , March 26, 2020 |",
    "| Wednesday, February 17, 5340 |",
    "| Thursday , December 31, 1959 |",
  ]);
  assert.deepEqual(listed("x28"), ["| 2020Q1 |", "| 5340Q1 |", "| 1959Q4 |"]);
});

// ----- F5: the page takes .zsav and formats.xpf -----
test("F5: the Console takes .zsav and formats.xpf files as bytes", async () => {
  assert.equal(fileKind("trial.zsav"), "binary");
  assert.equal(fileKind("formats.xpf"), "binary");
  assert.equal(fileKind("FORMATS.XPF"), "binary");
  assert.equal(
    loadCommand("trial.zsav"),
    'import spss using "trial.zsav", clear',
  );
  // formats.xpf holds value labels for import sasxport5; it is not loaded.
  assert.equal(loadCommand("formats.xpf"), "");
  for (const kind of [".zsav", ".xpf", ".sav", ".xpt", ".v8xpt"])
    assert.ok(ACCEPT.split(",").includes(kind), kind);
  const s = createConsoleSession();
  await giveFile(
    s,
    "survey.zsav",
    fileKind("survey.zsav"),
    fixture("survey.zsav"),
  );
  const result = await s.run('import spss using "survey.zsav", clear');
  assert.equal(result.rc, 0);
  // As Stata 19 reads the file R haven wrote (stata-imports.json).
  assert.equal(result.output[0].lines.at(-1), "(11 vars, 4 obs)");
  await giveFile(
    s,
    "formats.xpf",
    fileKind("formats.xpf"),
    fixture("formats.xpf"),
  );
  await giveFile(
    s,
    "sim5-stata.xpt",
    fileKind("sim5-stata.xpt"),
    fixture("sim5-stata.xpt"),
  );
  const labelled = await s.run('import sasxport5 "sim5-stata.xpt", clear');
  assert.equal(labelled.rc, 0);
});

// ----- F12: extended missing values in formats.xpf -----
test("F12: export sasxport5 writes .a to .z as Stata does, in value order", () => {
  const s = new Session();
  s.run(`set obs 3
generate byte q = _n
replace q = .b in 3
label define bl 1 "one" .b "bee" .z "zed" .a "ay"
label values q bl
export sasxport5 m.xpt, replace
import sasxport5 formats.xpf, clear`);
  // Stata 19 writes BL 1 one, BL 2147483622 ay, BL 2147483623 bee and
  // BL 2147483647 zed.
  assert.deepEqual(rows(s), [
    "BL|1|one",
    "BL|2147483622|ay",
    "BL|2147483623|bee",
    "BL|2147483647|zed",
  ]);
});

// ----- F11: infix and infile -----
test("F11: infile reads quoted values, commas and empty lines in free format", () => {
  const s = withFiles({
    "q.raw": '1 "Ed Lee" 2\n2 \'Al B\' 3\n3 "x,y"z 4\n',
    "sep.raw": "1,,2\n3, 4\n5 ,6\n\n\n7\n  \n8\t9\n,10\n11,\n",
    "num.raw": "+5 5. -.5 1d3 1e400 0x10 nan . .z .A 1e-3 1,2\n",
  });
  let result = s.run("infile id str10 name gpa using q.raw, clear");
  assert.deepEqual(lines(result), [
    "'z' cannot be read as a number for gpa[3]",
    "(eof not at end of obs)",
    "(4 observations read)",
  ]);
  assert.deepEqual(rows(s), ["1|Ed Lee|2", "2|Al B|3", "3|x,y|.", "4||."]);
  result = s.run("infile str3 a b using q.raw, clear");
  assert.deepEqual(rows(s), ["1|.", "2|2", "Al |3", "3|.", "z|4"]);
  s.run("infile x using sep.raw, clear");
  assert.deepEqual(rows(s), [
    "1",
    ".",
    "2",
    "3",
    "4",
    "5",
    "6",
    ".",
    ".",
    "7",
    ".",
    "8",
    "9",
    ".",
    "10",
    "11",
    ".",
  ]);
  s.run("infile x y using sep.raw, clear byvariable(3)");
  assert.deepEqual(rows(s), ["1|3", ".|4", "2|5"]);
  result = s.run("infile x using num.raw, clear");
  assert.deepEqual(lines(result), [
    "'0x10' cannot be read as a number for x[6]",
    "'nan' cannot be read as a number for x[7]",
    "'.A' cannot be read as a number for x[10]",
    "(13 observations read)",
  ]);
  assert.deepEqual(rows(s), [
    "5",
    "5",
    "-.5",
    "1000",
    ".",
    ".",
    ".",
    ".",
    ".z",
    ".",
    ".001",
    "1",
    "2",
  ]);
});

test("F11: infile dictionaries with _first, _lines, _line, labels and using()", () => {
  const s = withFiles({
    "two.raw":
      'header line\nskip me\n1 Ann\n  20 3.5\n2 "Bo B"\n  21 3.9\n3 Cal\n',
    "d1.dct":
      'infile dictionary using two.raw {\n_first(3)\n_lines(2)\n  id\n  str8 name\n  _line(2)\n  age %4f\n  _column(6) gpa %3f "Grade"\n}\n',
    "d2.dct":
      "dictionary\n{\n  id %1f\n  _skip(1)\n  str3 nm %3s\n  _newline\n  x %4f\n}\n1 Ann\n  20\n2 Bob\n 3.5\n",
    "inl.dct":
      'infile dictionary {\n* a comment\n  _column(2) str5 name %5s "Student name"\n  _skip(1) gpa %4f\n  int yr %2f "Year"\n}\n Ann   3.5 12\n Bob   3.9 13x\n  Cal 2.75 14\n',
    "d3.dct": "dictionary {\n  id\n  str5 name\n}\n",
    "nd.dct": "just data\n1 2\n",
  });
  let result = s.run("infile using d1.dct, clear");
  assert.deepEqual(lines(result), [
    "infile dictionary using two.raw {",
    "_first(3)",
    "_lines(2)",
    "  id",
    "  str8 name",
    "  _line(2)",
    "  age %4f",
    '  _column(6) gpa %3f "Grade"',
    "}",
    "unexpected end of file",
    "(3 observations read)",
  ]);
  assert.deepEqual(rows(s), ["1|Ann|20|3.5", "2|Bo B|21|3.9", "3|Cal|.|."]);
  assert.equal(s.data.get("gpa").label, "Grade");
  s.run("infile using d2.dct, clear");
  assert.deepEqual(rows(s), ["1|Ann|20", "2|Bob|3.5"]);
  s.run("infile using inl.dct, clear");
  assert.deepEqual(types(s), [
    "name str5 %9s",
    "gpa float %9.0g",
    "yr int %8.0g",
  ]);
  assert.deepEqual(rows(s), ["Ann|3.5|12", "Bob|3.9|13", "Cal|.75|14"]);
  assert.equal(s.data.get("name").label, "Student name");
  result = s.run("infile using d3, clear using(two)");
  assert.deepEqual(lines(result).slice(-3), [
    "'header' cannot be read as a number for id[1]",
    "'skip' cannot be read as a number for id[2]",
    "(7 observations read)",
  ]);
  assert.deepEqual(rows(s).slice(0, 4), [".|line", ".|me", "1|Ann", "20|3.5"]);
  result = s.run("infile using d1.dct in 2, clear");
  assert.deepEqual(rows(s), ["2|Bo B|21|3.9"]);
  result = s.run("infile using nd.dct, clear");
  assert.equal(result.rc, 613);
  assert.deepEqual(lines(result), [
    "just data",
    "file does not contain dictionary",
    "r(613);",
  ]);
  result = s.run("infix using nd.dct, clear");
  assert.equal(result.rc, 613);
});

test("F11: infix with lines, and what is refused", () => {
  const s = withFiles({
    "two.raw":
      "header line\nskip me\n1 Ann\n  20 3.5\n2 Bob\n  21 3.9\n3 Cal\n",
    "d4.dct":
      "infix dictionary using two.raw {\n2 lines\n1: id 1\n2: age 3-4\n}\n",
  });
  const result = s.run("infix using d4.dct, clear");
  assert.deepEqual(lines(result).slice(-4), [
    "'h' cannot be read as a number for id[1]",
    "'ip' cannot be read as a number for age[1]",
    "unexpected end of file",
    "(4 observations read)",
  ]);
  assert.deepEqual(rows(s), [".|.", "1|20", "2|21", "3|."]);
  // Value labels in infile's variable list are refused with a way round.
  const refused = s.run("infile x y:lab using two.raw, clear");
  assert.equal(refused.rc, 198);
});
