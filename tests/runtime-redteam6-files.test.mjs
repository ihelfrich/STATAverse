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
import { MISSING } from "../src/runtime/values.js";

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

// ----- A later round on the files group's fixes -----
// Every expected value below was recorded from Stata 19 MP (version 17, set
// processors 1) reading the same bytes.

test("infile free format: an empty line is a missing value only after a comma, and a quoted empty value is not a number", () => {
  const s = withFiles({
    "tb.raw": "1 Ann 3.5\n\t\n2 Bob 4\n3 Cal 5\n",
    "crlfblank.raw": "1 Ann 3.5\r\n\r\n2 Bob 4\r\n3 Cal 5\r\n",
    "tabbed.raw": '1\tAnn\t3.5\n2\t"Bo b"\t4\n\t\t\n3\tCal\t5\n',
    "c3.raw": "1 Ann 3.5\n2 Bob 4\n\n3,Cal,5\n",
    "c5.raw": "1 Ann 3.5,\n\n2 Bob 4\n",
    "q.raw": '1 Ann 3.5\n""\n2 Bob 4\n3 Cal 5\n',
    "qe.raw": '1 "" 3\n"" B 4\n\'\' C 5\n',
    "q1.raw": '1 "A,B" 3\n\n2 C 4\n',
  });
  for (const [file, n] of [
    ["tb.raw", 3],
    ["crlfblank.raw", 3],
    ["c3.raw", 3],
    ["q1.raw", 2],
  ]) {
    const result = s.run(`infile id str5 name score using ${file}, clear`);
    assert.deepEqual(lines(result), [`(${n} observations read)`], file);
  }
  assert.deepEqual(rows(s), ["1|A,B|3", "2|C|4"]);
  s.run("infile id str10 name score using tabbed.raw, clear");
  assert.deepEqual(rows(s), ["1|Ann|3.5", "2|Bo b|4", "3|Cal|5"]);
  let result = s.run("infile id str5 name score using c5.raw, clear");
  assert.deepEqual(lines(result), [
    "'Bob' cannot be read as a number for id[3]",
    "(eof not at end of obs)",
    "(3 observations read)",
  ]);
  assert.deepEqual(rows(s), ["1|Ann|3.5", ".||2", ".|4|."]);
  result = s.run("infile id str5 name score using q.raw, clear");
  assert.deepEqual(lines(result), [
    "'' cannot be read as a number for id[2]",
    "'Bob' cannot be read as a number for score[2]",
    "'Cal' cannot be read as a number for score[3]",
    "(eof not at end of obs)",
    "(4 observations read)",
  ]);
  result = s.run("infile id str5 name score using qe.raw, clear");
  assert.deepEqual(lines(result), [
    "'' cannot be read as a number for id[2]",
    "'' cannot be read as a number for id[3]",
    "(3 observations read)",
  ]);
  assert.deepEqual(rows(s), ["1||3", ".|B|4", ".|C|5"]);
  s.run("infile str5 a str5 b str5 c using qe.raw, clear");
  assert.deepEqual(rows(s), ["1||3", "|B|4", "|C|5"]);
});

test("infix and infile read a Latin-1 file's bytes as they are, one column each", async () => {
  const s = createConsoleSession(),
    give = (name, bytes) => giveFile(s, name, fileKind(name), bytes),
    latin1 = (text) => new Uint8Array(Buffer.from(text, "latin1"));
  await give(
    "latfix.dat",
    latin1("M\xfcller  42 3.5\nSm\xeethe  37 2.0\nBrown   29 4.0\n"),
  );
  await give("latin1.dat", latin1("Jos\xe9 12\nAnn  34\n"));
  await give("lat.raw", latin1("1 Jos\xe9 3\n2 Ann 4\n"));
  await give("lat.dat", latin1("M\xfcller 42\nSm\xeeth  37\n"));
  await give(
    "lat.dct",
    latin1(
      "infile dictionary using lat.dat {\n  str6 name %6s\n  age %3f\n}\n",
    ),
  );
  const shown = async (commands) =>
    (await s.run(commands, { doFile: true })).output
      .filter((o) => /^list/.test(o.command ?? ""))
      .flatMap((o) => o.lines)
      .flatMap((line) => line.split("\n"))
      .filter((line) => /^\s+\d+\. \|/.test(line))
      .map((line) => line.replace(/^\s+\d+\. /, "").trim());
  // Stata's log holds the raw byte, shown here as U+FFFD.
  assert.deepEqual(
    await shown(`infix str name 1-7 age 9-10 gpa 12-14 using latfix.dat, clear
list
generate l = strlen(name)
list l`),
    [
      "| M�ller    42   3.5 |",
      "| Sm�the    37     2 |",
      "|  Brown    29     4 |",
      "| 6 |",
      "| 6 |",
      "| 5 |",
    ],
  );
  assert.deepEqual(
    await shown(`infix str name 1-4 age 6-7 using latin1.dat, clear
list`),
    ["| Jos�    12 |", "|  Ann    34 |"],
  );
  assert.deepEqual(
    await shown(`infile id str10 name n using lat.raw, clear
generate l = strlen(name)
list l`),
    ["| 4 |", "| 3 |"],
  );
  assert.deepEqual(
    await shown(`infile using lat.dct, clear
list
generate l = strlen(name)
list l`),
    ["| M�ller    42 |", "|  Sm�th    37 |", "| 6 |", "| 5 |"],
  );
});

// formats.xpf made as the testers made it in Stata: a dataset of FMTNAME,
// START and LABEL written with export sasxport5, then given that name.
function withFormats(make) {
  const s = new Session();
  s.run(`clear
set obs 3
generate byte x = _n
label define mylbl 1 "a" 2 "b" 3 "c"
label values x mylbl
export sasxport5 s.xpt, replace rename
clear
${make}
export sasxport5 v.xpt, replace rename`);
  s.files.set("formats.xpf", s.files.get("v.xpt"));
  s.run("clear");
  return s;
}
const oneRow = (start, label) => `set obs 1
generate str8 FMTNAME = "MYLBL"
generate str16 START = "${start}"
generate str40 LABEL = "${label}"`;

test("import sasxport5 reads formats.xpf as Stata 19 does: . is 2147483621, the first label stays, and bad rows make it invalid", () => {
  let s = withFormats(oneRow("2147483621", "just above"));
  let result = s.run("import sasxport5 s.xpt, clear");
  assert.equal(result.rc, 0);
  assert.deepEqual(
    [...s.data.valueLabels.get("mylbl")],
    [[MISSING, "just above"]],
  );
  assert.deepEqual(lines(s.run("label list")), [
    "mylbl:",
    "           . just above",
  ]);
  assert.deepEqual(rows(s), ["1", "2", "3"]);

  s = withFormats(`set obs 2
generate str8 FMTNAME = "MYLBL"
generate str16 START = "1"
generate str40 LABEL = cond(_n == 1, "first", "second")`);
  assert.equal(s.run("import sasxport5 s.xpt, clear").rc, 0);
  assert.deepEqual([...s.data.valueLabels.get("mylbl")], [[1, "first"]]);

  s = withFormats(oneRow("1.5", "one and a half"));
  result = s.run("import sasxport5 s.xpt, clear");
  assert.equal(result.rc, 610);
  assert.deepEqual(lines(result).slice(0, 2), [
    "may not label 1.5",
    "formats.xpf is not a valid value label file",
  ]);
  assert.equal(s.data.n + s.data.variables.length, 0);

  // A SAS keyword: Stata 19 prints a number made from the field's bytes
  // (3.3957e-314), which is not reproduced; the error and its code are.
  s = withFormats(oneRow("LOW", "low"));
  result = s.run("import sasxport5 s.xpt, clear");
  assert.equal(result.rc, 610);
  assert.equal(lines(result)[1], "formats.xpf is not a valid value label file");
  assert.equal(s.data.n + s.data.variables.length, 0);

  s = withFormats(`set obs 2
generate str8 FMTNAME = cond(_n == 1, "MYLBL", "$MYLBL")
generate str16 START = cond(_n == 1, "1", "M")
generate str16 END = START
generate str1 TYPE = cond(_n == 1, "N", "C")
generate str40 LABEL = cond(_n == 1, "one", "em")`);
  result = s.run("import sasxport5 s.xpt, clear");
  assert.equal(result.rc, 610);
  assert.deepEqual(lines(result).slice(0, 2), [
    '"type" variable not equal to "N" in formats.xpf for format; value labels only',
    "allowed for numeric variables",
  ]);
  assert.equal(s.data.n + s.data.variables.length, 0);
});

test("import delimited reports a quote left open before rowrange() on the first row read", () => {
  const s = withFiles({
    "n1.csv": 'id,name\n1,"Ann\n\n2,Bob\n3,Cal\n',
    "n2.csv": 'id,name\n1,"Ann\n\n\n2,Bob\n3,"Cal\n',
    "multi.csv":
      '\n\n\nid,name,score\n1,"Ann\n\nSmith",3\n2,Bob,4\n\n3,"Cal",5',
  });
  const notes = (command) =>
    lines(s.run(command))
      .filter((line) => line.startsWith("Note: Unmatched"))
      .map((line) => /row (\d+)/.exec(line)[1]);
  assert.deepEqual(
    notes("import delimited using n1.csv, clear rowrange(3:5)"),
    ["4"],
  );
  assert.deepEqual(
    notes("import delimited using n1.csv, clear varnames(1) rowrange(3:5)"),
    ["4"],
  );
  assert.deepEqual(
    notes("import delimited using n2.csv, clear varnames(1) rowrange(3:5)"),
    ["5"],
  );
  assert.deepEqual(
    notes("import delimited using n2.csv, clear varnames(1) rowrange(4:6)"),
    ["5", "6"],
  );
  assert.deepEqual(
    notes(
      "import delimited using n2.csv, clear varnames(1) rowrange(3:5) emptylines(include)",
    ),
    [],
  );
  assert.deepEqual(
    notes("import delimited using multi.csv, clear varnames(4) rowrange(6:8)"),
    ["7"],
  );
});

// strings8.xpt was written by Stata 19's export sasxport8 from eight string
// variables (a str3 holding "abc", str5, str6, a str20 holding "ab", a
// str12 holding eleven characters, str1, str9 and str10). The tests set
// each variable's format name and width byte by byte, as SAS-made files
// carry them.
function patched8(name, edit) {
  const bytes = Buffer.from(fixture(name)),
    start = bytes.indexOf("HEADER RECORD*******NAMSTV8") + 80;
  for (let k = 0; start + 140 * (k + 1) <= bytes.length; k++) {
    const at = start + 140 * k;
    if (!/^[A-Za-z_]/.test(bytes.toString("latin1", at + 8, at + 9))) break;
    const out = edit(k, bytes.toString("latin1", at + 56, at + 64).trim());
    if (!out) continue;
    bytes.write(out.format.padEnd(8, " "), at + 56, "latin1");
    bytes.writeUInt16BE(out.width ?? 0, at + 64);
    bytes.writeUInt16BE(0, at + 66);
  }
  return new Uint8Array(bytes);
}

test("import sasxport8 gives string formats and lower-case format names as Stata 19 does", () => {
  const formats = (format, width) => {
    const s = withFiles({
      "p.xpt": patched8("strings8.xpt", () => ({ format, width })),
    });
    assert.equal(s.run("import sasxport8 p.xpt, clear").rc, 0);
    return s.data.variables.map((v) => `${v.type} ${v.format}`);
  };
  // The format Stata's export writes ($w.), and $ or $CHAR with any width.
  const asWritten = [
    "str3 %3s",
    "str5 %5s",
    "str6 %6s",
    "str2 %9s",
    "str11 %11s",
    "str1 %1s",
    "str9 %9s",
    "str10 %10s",
  ];
  assert.deepEqual(formats("$", 0), asWritten);
  assert.deepEqual(formats("$", 2), asWritten);
  assert.deepEqual(formats("$CHAR", 0), asWritten);
  assert.deepEqual(formats("$CHAR", 30), asWritten);
  assert.deepEqual(formats("", 0), [
    "str3 %7s",
    "str5 %9s",
    "str6 %10s",
    "str2 %9s",
    "str11 %11s",
    "str1 %5s",
    "str9 %13s",
    "str10 %14s",
  ]);
  assert.deepEqual(formats("", 5), [
    "str3 %-10.0g",
    "str5 %-10.0g",
    "str6 %-10.0g",
    "str2 %-9s",
    "str11 %-11s",
    "str1 %-10.0g",
    "str9 %-10.0g",
    "str10 %-10.0g",
  ]);
  // A format name not in capitals is not mapped: Stata 19 gives Comma,
  // Date, percent and dollar %10.0g.
  const s = withFiles({
    "lower.xpt": patched8("sasformats8.xpt", (k, format) =>
      /^[A-Z]+$/.test(format)
        ? {
            format:
              k % 2 || format.length === 1
                ? format.toLowerCase()
                : format[0] + format.slice(1).toLowerCase(),
          }
        : null,
    ),
  });
  assert.equal(s.run("import sasxport8 lower.xpt, clear").rc, 0);
  assert.ok(s.data.variables.length > 20);
  for (const v of s.data.variables) assert.equal(v.format, "%10.0g", v.name);
});

test("import spss looks for name.sav only when no extension is given", () => {
  const s = withFiles({ "survey.zsav": fixture("survey.zsav") });
  const result = s.run('import spss using "survey", clear');
  assert.equal(result.rc, 601);
  assert.equal(lines(result)[0], "file survey.sav not found");
  assert.equal(s.run('import spss using "survey.zsav", clear').rc, 0);
});
