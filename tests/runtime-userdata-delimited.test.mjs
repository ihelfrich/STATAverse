// import delimited, insheet, export delimited and outsheet on a student's
// own files, through the Console's session. Every expected result below was
// recorded from Stata 19 (MP, batch, version 17) on the same small files,
// which are built here from made-up values. Stata's import delimited is
// native in Stata 19 (it does not need Java).
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";
import { Session } from "../src/runtime/session.js";

const bytes = (...parts) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === "number" ? [part] : [...Buffer.from(part)],
    ),
  );
const utf16 = (text, big = false) => {
  const out = Buffer.from(text, "utf16le");
  if (big)
    for (let i = 0; i < out.length; i += 2)
      [out[i], out[i + 1]] = [out[i + 1], out[i]];
  return new Uint8Array(out);
};

/** Adds the files, runs the do-file text and returns what a test reads. */
function run(files, source) {
  const s = createConsoleSession();
  for (const [name, content] of Object.entries(files)) s.addFile(name, content);
  const result = s.run(source);
  return {
    rc: result.rc,
    session: s,
    // Each command's printed lines, without the command itself.
    out: result.output.map((o) => o.lines.join("\n")),
    vars: result.memory.variables.map(
      (v) => `${v.name} ${v.type} ${v.format}${v.label ? ` [${v.label}]` : ""}`,
    ),
    n: result.memory.observations,
  };
}
const names = (r) => r.vars.map((v) => v.split(" ")[0]);

const BASIC = "id,name,score\n1,smithj,71.5\n2,doe,80\n3,roe,\n";

test("U21: quoted numbers are numbers (import delimited and insheet)", () => {
  const files = { "q.csv": 'id,x\n"1","2.5"\n"2","3"\n' };
  for (const command of [
    "import delimited using q.csv",
    "insheet using q.csv",
  ]) {
    const r = run(files, `${command}, clear`);
    assert.deepEqual(r.vars, ["id byte %8.0g", "x float %9.0g"]);
  }
  // stripquotes(no) keeps the quotes, so every column is text and the first
  // row is data.
  const kept = run(
    files,
    "import delimited using q.csv, clear stripquotes(no)",
  );
  assert.deepEqual(kept.vars, ["v1 str3 %9s", "v2 str5 %9s"]);
  assert.equal(kept.n, 3);
});

test("U22: '.' and .a are missing values in a numeric column", () => {
  const r = run(
    { "dot.csv": "id,x\n1,.\n2,3\n3,.a\n" },
    "import delimited using dot.csv, clear\ncount if !missing(x)\ndisplay x[3]\ninsheet using dot.csv, clear\ndisplay x[3]",
  );
  assert.deepEqual(r.vars, ["id byte %8.0g", "x byte %8.0g"]);
  assert.equal(r.out[1].trim(), "1");
  assert.equal(r.out[2], ".a");
  assert.equal(r.out[4], ".a");
});

test("U23: an empty header cell is named v# and the header row stays names", () => {
  const trail = run(
    { "t.csv": "a,b,\n1,2,\n3,4,\n" },
    "import delimited using t.csv, clear",
  );
  assert.equal(trail.out[0].split("\n").at(-1), "(3 vars, 2 obs)");
  assert.deepEqual(trail.vars, [
    "a byte %8.0g",
    "b byte %8.0g",
    "v3 byte %8.0g",
  ]);
  const pandas = run(
    { "p.csv": ",x,y\n0,1.5,2\n1,3.5,4\n" },
    "import delimited using p.csv, clear",
  );
  assert.deepEqual(pandas.vars, [
    "v1 byte %8.0g",
    "x float %9.0g",
    "y byte %8.0g",
  ]);
  const dup = run(
    { "d.csv": "x,x,X,,y\n1,2,3,4,5\n" },
    "import delimited using d.csv, clear",
  );
  assert.deepEqual(dup.vars, [
    "x byte %8.0g",
    "v2 byte %8.0g [x]",
    "v3 byte %8.0g [X]",
    "v4 byte %8.0g",
    "y byte %8.0g",
  ]);
  assert.equal(dup.n, 1);
  // A header over a column with nothing below it still counts.
  const below = run(
    { "e.csv": "a,b\nx,\ny,\n" },
    "import delimited using e.csv, clear",
  );
  assert.deepEqual(below.vars, ["a str1 %9s", "b byte %8.0g"]);
  const only = run(
    { "h.csv": "a,b,c\n" },
    "import delimited using h.csv, clear",
  );
  assert.match(only.out[0], /\(3 vars, 0 obs\)$/);
});

test("U24, U44, U75, U84: decimal columns are float %9.0g, as Stata stores them", () => {
  const r = run(
    {
      "dec.csv":
        "a,b,c,d,e\n0.1,1.0,2.30,1e-3,123456.789\n0.2,2.0,4.10,2.5e-7,0.000001\n",
      "gpa.csv": "gpa,income\n3.7,52000.5\n2.9,61000.25\n",
    },
    [
      "import delimited using dec.csv, clear",
      "count if a == 0.1",
      "count if c == 2.3",
      "count if e == 123456.789",
      "display %21.0g e[1]",
      "import delimited using gpa.csv, clear",
      "count if gpa == 3.7",
      "count if gpa == float(3.7)",
    ].join("\n"),
  );
  assert.deepEqual(
    r.out.slice(1, 4).map((s) => s.trim()),
    ["0", "0", "0"],
  );
  assert.equal(r.out[4].trim(), "123456.7890625");
  assert.equal(r.out[6].trim(), "0");
  assert.equal(r.out[7].trim(), "1");
  assert.deepEqual(r.vars, ["gpa float %9.0g", "income float %9.0g"]);
  const first = run(
    {
      "dec.csv":
        "a,b,c,d,e\n0.1,1.0,2.30,1e-3,123456.789\n0.2,2.0,4.10,2.5e-7,0.000001\n",
    },
    "import delimited using dec.csv, clear",
  );
  assert.deepEqual(first.vars, [
    "a float %9.0g",
    "b byte %8.0g",
    "c float %9.0g",
    "d float %9.0g",
    "e float %9.0g",
  ]);
  // Whole numbers keep the smallest integer type; beyond long they are
  // double, and so is a decimal column holding such a number or one beyond
  // float's range.
  const ints = run(
    {
      "i.csv":
        "a,b,c,d,e,g,m,h\n100,32740,32741,2147483620,2147483621,16777217,12345678901,1e39\n-127,-32767,-32768,-2147483647,-2147483648,1,0.5,2.5\n",
    },
    "import delimited using i.csv, clear",
  );
  assert.deepEqual(ints.vars, [
    "a byte %8.0g",
    "b int %8.0g",
    "c long %12.0g",
    "d long %12.0g",
    "e double %10.0g",
    "g long %12.0g",
    "m double %10.0g",
    "h double %10.0g",
  ]);
  // set type double makes decimal columns double.
  const typed = run(
    { "g.csv": "x\n2.9\n1\n" },
    "set type double\nimport delimited using g.csv, clear",
  );
  assert.deepEqual(typed.vars, ["x double %10.0g"]);
});

test("U34: asdouble applies only to columns that are not whole numbers", () => {
  const r = run(
    { "b.csv": BASIC },
    "import delimited using b.csv, clear asdouble\ncount if score == 71.5",
  );
  assert.deepEqual(r.vars, [
    "id byte %8.0g",
    "name str6 %9s",
    "score double %10.0g",
  ]);
  assert.equal(r.out[1].trim(), "1");
  assert.equal(
    run(
      { "b.csv": BASIC },
      "import delimited using b.csv, clear asdouble asfloat",
    ).out[0],
    "asfloat() and asdouble() are mutually exclusive options\nr(198);",
  );
});

test("U25: the runtime itself sets no size limit on an added text file", () => {
  const long = "s,n\n" + "a".repeat(21_000_000) + ",1\n",
    r = run({ "big.csv": long }, "import delimited using big.csv, clear");
  assert.equal(r.rc, 0);
  assert.deepEqual(r.vars, ["s strL %9s", "n byte %8.0g"]);
});

test("U26, U47: Latin-1 and Windows-1252 bytes are read, and encoding() is honoured", () => {
  const latin1 = bytes("id,ville\n1,Montr", 0xe9, "al\n2,Qu", 0xe9, "bec\n"),
    cp1252 = bytes(
      "Student ID,Score,Name\r\n101,78.5,Ren",
      0xe9,
      "e\r\n102,66,Bob ",
      0x80,
      " ",
      0x93,
      "q",
      0x94,
      "\r\n",
    ),
    files = { "latin1.csv": latin1, "cp1252.csv": cp1252 },
    show = 'display "[" ville[1] "][" ville[2] "]"';
  let r = run(files, `import delimited using latin1.csv, clear\n${show}`);
  assert.equal(
    r.out[0],
    "(encoding automatically selected: ISO-8859-1)\n(2 vars, 2 obs)",
  );
  assert.equal(r.out[1], "[Montréal][Québec]");
  assert.deepEqual(r.vars, ["id byte %8.0g", "ville str9 %9s"]);
  for (const name of ["latin1", "windows-1252", "ISO-8859-1"]) {
    r = run(
      files,
      `import delimited using latin1.csv, clear encoding("${name}")\n${show}`,
    );
    assert.equal(r.out[0], "(2 vars, 2 obs)");
    assert.equal(r.out[1], "[Montréal][Québec]");
  }
  // UTF-8 named outright drops the bytes that are not UTF-8.
  r = run(
    files,
    `import delimited using latin1.csv, clear encoding(utf-8)\n${show}`,
  );
  assert.equal(r.out[1], "[Montral][Qubec]");
  assert.deepEqual(r.vars, ["id byte %8.0g", "ville str7 %9s"]);
  r = run(
    files,
    'import delimited using cp1252.csv, clear\ndisplay "[" name[1] "][" name[2] "]"',
  );
  assert.equal(
    r.out[0].split("\n")[0],
    "(encoding automatically selected: windows-1252)",
  );
  assert.equal(r.out[1], "[Renée][Bob € “q”]");
  assert.deepEqual(r.vars, [
    "studentid int %8.0g [Student ID]",
    "score float %9.0g [Score]",
    "name str15 %15s [Name]",
  ]);
  // True ISO-8859-1 keeps bytes 0x80-0x9f as control characters.
  r = run(
    files,
    "import delimited using cp1252.csv, clear encoding(ISO-8859-1)",
  );
  assert.deepEqual(r.vars.at(-1), "name str12 %12s [Name]");
  r = run(files, "import delimited using latin1.csv, clear encoding(bogus)");
  assert.equal(r.out[0], "encoding not supported\nr(198);");
});

test("U27: UTF-16 files, with or without a byte-order mark", () => {
  const text = "id\tname\r\n1\tAnn\r\n2\tJosé\r\n",
    cases = [
      ["le.txt", utf16("\ufeff" + text), "UTF-16LE"],
      ["be.txt", utf16("\ufeff" + text, true), "UTF-16BE"],
      ["nobom.txt", utf16(text), "UTF-16LE"],
    ];
  for (const [name, content, encoding] of cases) {
    const r = run(
      { [name]: content },
      `import delimited using ${name}, clear\ndisplay name[2]`,
    );
    assert.equal(
      r.out[0],
      `(encoding automatically selected: ${encoding})\n(2 vars, 2 obs)`,
    );
    assert.deepEqual(r.vars, ["id byte %8.0g", "name str5 %9s"]);
    assert.equal(r.out[1], "José");
  }
  const named = run(
    { "le.txt": cases[0][1] },
    'import delimited using le.txt, clear encoding("utf-16")\ndisplay name[2]',
  );
  assert.equal(named.out[1], "José");
  // A file whose text holds a NUL character is refused as not text.
  const s = createConsoleSession();
  assert.throws(
    () => s.addFile("x.bin", bytes("a", 0, 0, 0, 1, 2, 3)),
    /not a text file/,
  );
});

test("U28, U35: delimiters(), whitespace, collapse, asstring and detection", () => {
  const space = "a  b   c\n1  2   3\n4  5   6\n";
  let r = run(
    { "b.csv": BASIC },
    'import delimited using b.csv, clear delimiters(",")',
  );
  assert.match(r.out[0], /\(3 vars, 3 obs\)$/);
  r = run(
    { "s.txt": space },
    "import delimited using s.txt, clear delimiters(whitespace)",
  );
  assert.deepEqual(names(r), ["a", "v2", "b", "v4", "v5", "c"]);
  assert.equal(r.n, 2);
  r = run(
    { "s.txt": space },
    'import delimited using s.txt, clear delimiters(" ", collapse)',
  );
  assert.deepEqual(names(r), ["a", "b", "c"]);
  r = run({ "s.txt": space }, "import delimited using s.txt, clear");
  assert.deepEqual(r.vars, ["v1 str8 %9s"]);
  r = run(
    { "s.csv": "a;b;c\n1;2;3\n4;5;6\n" },
    'import delimited using s.csv, clear delimiters(",;")',
  );
  assert.deepEqual(names(r), ["a", "b", "c"]);
  r = run(
    { "s.csv": "a;b;c\n1;2;3\n4;5;6\n" },
    'import delimited using s.csv, clear delimiters(";,", asstring)',
  );
  assert.deepEqual(r.vars, ["v1 str5 %9s"]);
  r = run(
    { "t.tsv": "id\tname\n1\tann\n" },
    'import delimited using t.tsv, clear delimiters("\\t")',
  );
  assert.deepEqual(names(r), ["id", "name"]);
  // Detected delimiters: pipe, semicolon over a decimal comma, colon.
  const detected = [
    [
      "id|x|name\n1|2.5|ab\n2|3.5|cd\n",
      ["id byte %8.0g", "x float %9.0g", "name str2 %9s"],
    ],
    ["id;wert\n1;2,5\n2;3,5\n", ["id byte %8.0g", "wert str3 %9s"]],
    ["a:b:c\n1:2:3\n", ["a byte %8.0g", "b byte %8.0g", "c byte %8.0g"]],
    ["a;b,c\n1;2,3\n", ["ab str3 %9s [a;b]", "c byte %8.0g"]],
    ["a;b;c\n1,2\n3,4\n", ["a str3 %9s", "b byte %8.0g", "c byte %8.0g"]],
    ["a,b\n1,2\n3:4:5:6\n", ["a str7 %9s", "b byte %8.0g"]],
    [
      "id,t\n1,2024-03-15 13:45:00\n2,2023-12-01 08:00:00\n",
      ["v1 str15 %15s", "v2 byte %8.0g", "v3 byte %8.0g"],
    ],
  ];
  for (const [text, vars] of detected)
    assert.deepEqual(
      run({ "f.txt": text }, "import delimited using f.txt, clear").vars,
      vars,
      text,
    );
});

test("U29, U45: header text becomes a name as Stata makes it", () => {
  const header =
    "First Name,2nd,_x,var,Income ($),income,long name that is definitely longer than thirty two chars,Age\n1,2,3,4,5,6,7,8\n";
  let r = run(
    { "n.csv": header },
    "import delimited using n.csv, clear\nsummarize firstname income v6",
  );
  assert.deepEqual(r.vars, [
    "firstname byte %8.0g [First Name]",
    "nd byte %8.0g [2nd]",
    "_x byte %8.0g",
    "var byte %8.0g",
    "income byte %8.0g [Income ($)]",
    "v6 byte %8.0g [income]",
    "longnamethatisdefinitelylongerth byte %8.0g [long name that is definitely longer than thirty two chars]",
    "age byte %8.0g [Age]",
  ]);
  assert.equal(r.rc, 0);
  r = run(
    { "n.csv": header },
    "import delimited using n.csv, clear case(preserve)",
  );
  assert.deepEqual(names(r), [
    "FirstName",
    "nd",
    "_x",
    "var",
    "Income",
    "income",
    "longnamethatisdefinitelylongerth",
    "Age",
  ]);
  r = run(
    { "n.csv": header },
    "import delimited using n.csv, clear case(upper)",
  );
  assert.deepEqual(names(r), [
    "FIRSTNAME",
    "ND",
    "_X",
    "VAR",
    "INCOME",
    "V6",
    "LONGNAMETHATISDEFINITELYLONGERTH",
    "AGE",
  ]);
  r = run({ "n.csv": header }, "insheet using n.csv, clear case");
  assert.deepEqual(names(r), [
    "FirstName",
    "nd",
    "_x",
    "var",
    "Income",
    "income",
    "longnamethatisdefinitelylongerth",
    "Age",
  ]);
  r = run(
    {
      "h.csv":
        "Score,2019,x y,Score,Age (years),%change,GDP-per-capita\n1,2,3,4,5,6,7\n",
    },
    "import delimited using h.csv, clear",
  );
  assert.deepEqual(r.vars, [
    "score byte %8.0g [Score]",
    "v2 byte %8.0g [2019]",
    "xy byte %8.0g [x y]",
    "v4 byte %8.0g [Score]",
    "ageyears byte %8.0g [Age (years)]",
    "change byte %8.0g [%change]",
    "gdppercapita byte %8.0g [GDP-per-capita]",
  ]);
  r = run(
    {
      "bom.csv": bytes(
        0xef,
        0xbb,
        0xbf,
        "Student ID,Score,Name\r\n101,78.5,Ren",
        0xc3,
        0xa9,
        "e\r\n102,66,Bob\r\n",
      ),
    },
    "import delimited using bom.csv, clear\nsummarize studentid",
  );
  assert.equal(
    r.out[0],
    "(encoding automatically selected: UTF-8)\n(3 vars, 2 obs)",
  );
  assert.equal(r.vars[0], "studentid int %8.0g [Student ID]");
  assert.equal(r.rc, 0);
  // Reserved words and names already taken become v#; Unicode letters stay.
  r = run(
    {
      "r.csv":
        "if,in,_n,_all,long,byte,str5,using,v1,a,If\n1,2,3,4,5,6,7,8,9,10,11\n",
    },
    "import delimited using r.csv, clear",
  );
  assert.deepEqual(names(r), [
    "v1",
    "v2",
    "v3",
    "_all",
    "v5",
    "v6",
    "v7",
    "v8",
    "v9",
    "a",
    "v11",
  ]);
  r = run(
    { "u.csv": "naïve,größe,Ünïcode Name,日本,1_a,a.b\n1,2,3,4,5,6\n" },
    "import delimited using u.csv, clear",
  );
  assert.deepEqual(names(r), [
    "naïve",
    "größe",
    "ünïcodename",
    "日本",
    "_a",
    "ab",
  ]);
  r = run({ "c.csv": "v2,,x\n1,2,3\n" }, "import delimited using c.csv, clear");
  assert.equal(
    r.out[1] ?? r.out[0].split("\n").slice(1).join("\n"),
    "Error creating variables\nr(198);",
  );
  r = run({ "r.csv": "if,a\n1,2\n" }, "insheet using r.csv, clear");
  assert.equal(
    r.out[0],
    "if invalid varname\nerror in line 1 of file\nr(198);",
  );
});

test("U30: stringcols() takes a numlist; leading zeros survive", () => {
  const zip = { "z.csv": "id,zip,code\n1,02134,007\n2,10001,010\n" };
  for (const list of ["2/3", "2 3"]) {
    const r = run(
      zip,
      `import delimited using z.csv, clear stringcols(${list})\ndisplay zip[1] " " code[1]`,
    );
    assert.deepEqual(r.vars, [
      "id byte %8.0g",
      "zip str5 %9s",
      "code str3 %9s",
    ]);
    assert.equal(r.out[1], "02134 007");
  }
  assert.deepEqual(
    run(zip, "import delimited using z.csv, clear stringcols(_all)").vars,
    ["id str1 %9s", "zip str5 %9s", "code str3 %9s"],
  );
  assert.equal(
    run(zip, "import delimited using z.csv, clear stringcols(0)").out[0],
    "0: invalid numlist in stringcols() option\nr(198);",
  );
});

test("U31: insheet's own options", () => {
  const files = {
    "b.csv": BASIC,
    "n.csv": "1,2,3\n4,5,6\n",
    "t.tsv": "id\tname\tscore\n1\tann\t3.5\n2\tbob\t4\n",
    "s.csv": "a;b;c\n1;2;3\n4;5;6\n",
  };
  let r = run(files, "insheet using b.csv, clear comma names");
  assert.deepEqual(r.vars, [
    "id byte %8.0g",
    "name str6 %9s",
    "score float %9.0g",
  ]);
  r = run(files, "insheet using n.csv, clear nonames");
  assert.deepEqual(names(r), ["v1", "v2", "v3"]);
  r = run(files, "insheet using b.csv, clear nonames");
  assert.deepEqual(r.vars, ["v1 str2 %9s", "v2 str6 %9s", "v3 str5 %9s"]);
  r = run(files, "insheet using t.tsv, clear tab");
  assert.equal(r.n, 2);
  r = run(files, "insheet using b.csv, clear tab");
  assert.deepEqual(r.vars, ["v1 str13 %13s"]);
  r = run(files, "insheet using b.csv, clear double");
  assert.equal(r.vars[2], "score double %10.0g");
  r = run(files, 'insheet using s.csv, clear delimiter(";")');
  assert.deepEqual(names(r), ["a", "b", "c"]);
  // With no delimiter given, insheet looks only for tab or comma.
  r = run(files, "insheet using s.csv, clear");
  assert.deepEqual(r.vars, ["v1 str5 %9s"]);
  // insheet keeps "NaN" as text and binds quoted lines with a space.
  r = run(
    {
      "x.csv": "a,b\nNaN,1\n1,2\n",
      "nl.csv": 'id,comment\n1,"line one\nline two"\n2,plain\n',
    },
    "insheet using x.csv, clear\ninsheet using nl.csv, clear\ndisplay comment[1]",
  );
  assert.deepEqual(r.vars, ["id byte %8.0g", "comment str17 %17s"]);
  assert.equal(r.out[2], "line one line two");
  assert.equal(run(files, "insheet using b.csv").rc, 0);
  assert.equal(
    run(files, "set obs 1\ngenerate x = 1\ninsheet using b.csv").out[2],
    "you must start with an empty dataset\nr(18);",
  );
  assert.equal(
    run(files, "insheet using b").out[0],
    "file b.raw not found\nr(601);",
  );
});

test("U32, U95: rowrange, colrange, varnames(#), separators and the other options", () => {
  const files = {
    "b.csv": BASIC,
    "m.csv": "id,v\n1,10\n2,abc\n3,30\n",
    "k.csv": 'id,amt\n1,"1,234"\n2,"12,345,678"\n',
    "semi.csv": "id;wert\n1;2,5\n2;3,5\n",
    "de.csv": 'id;x\n1;"1.234,5"\n2;7,25\n',
    "blank.csv": "a,b\n1,2\n\n3,4\n\n\n5,6\n",
    "c.csv": 'name,x\n"Smith, J",1\n"Doe, A",2\n',
  };
  const shape = (source) => {
    const r = run(files, source);
    return [r.n, r.vars];
  };
  assert.deepEqual(
    shape("import delimited using b.csv, clear rowrange(2:3)")[0],
    2,
  );
  assert.deepEqual(shape("import delimited using b.csv, clear rowrange(3)"), [
    2,
    ["id byte %8.0g", "name str3 %9s", "score byte %8.0g"],
  ]);
  assert.deepEqual(
    shape("import delimited using b.csv, clear rowrange(:2)")[0],
    1,
  );
  // With varnames(1), rows outside rowrange() still set the types.
  assert.deepEqual(
    shape("import delimited using b.csv, clear varnames(1) rowrange(3:4)"),
    [2, ["id byte %8.0g", "name str6 %9s", "score float %9.0g"]],
  );
  assert.deepEqual(
    shape("import delimited using b.csv, clear colrange(2:3)")[1],
    ["name str6 %9s", "score float %9.0g"],
  );
  assert.deepEqual(
    shape("import delimited using b.csv, clear colrange(:2)")[1],
    ["id byte %8.0g", "name str6 %9s"],
  );
  assert.deepEqual(shape("import delimited using b.csv, clear colrange(4:5)"), [
    0,
    [],
  ]);
  assert.deepEqual(shape("import delimited using b.csv, clear varnames(2)"), [
    2,
    ["v1 byte %8.0g [1]", "smithj str3 %9s", "v3 byte %8.0g [71.5]"],
  ]);
  assert.deepEqual(
    shape("import delimited using b.csv, clear varnames(nonames)")[1],
    ["v1 str2 %9s", "v2 str6 %9s", "v3 str5 %9s"],
  );
  let r = run(
    files,
    "import delimited using m.csv, clear numericcols(2)\ndisplay v[1] v[2] v[3]",
  );
  assert.equal(r.out[1], "10.30");
  r = run(
    files,
    "import delimited using k.csv, clear groupseparator(,)\ndisplay amt[2]",
  );
  assert.deepEqual(r.vars[1], "amt long %12.0g");
  assert.equal(r.out[1], "12345678");
  for (const option of [
    "decimalseparator(,)",
    'delimiters(";") decimalseparator(",")',
    "parselocale(de_DE)",
  ]) {
    r = run(
      files,
      `import delimited using semi.csv, clear ${option}\ndisplay wert[1]`,
    );
    assert.equal(r.vars[1], "wert float %9.0g");
    assert.equal(r.out[1], "2.5");
  }
  r = run(
    files,
    "import delimited using de.csv, clear parselocale(de_DE)\ndisplay x[1]",
  );
  assert.equal(r.out[1], "1234.5");
  assert.equal(
    run(files, "import delimited using b.csv, clear parselocale(xx_YY)").out[0],
    "unsupported locale xx_YY\nr(198);",
  );
  assert.equal(
    shape("import delimited using blank.csv, clear emptylines(include)")[0],
    7,
  );
  assert.equal(shape("import delimited using blank.csv, clear")[0], 3);
  assert.deepEqual(
    shape("import delimited using c.csv, clear bindquotes(nobind)"),
    [3, ["v1 str6 %9s", "v2 str3 %9s", "v3 byte %8.0g"]],
  );
  assert.deepEqual(
    shape("import delimited using c.csv, clear stripquotes(no)")[1],
    ["name str10 %10s", "x byte %8.0g"],
  );
  assert.deepEqual(
    shape("import delimited using c.csv, clear stripquotes(yes)")[1],
    ["name str8 %9s", "x byte %8.0g"],
  );
  for (const option of [
    "favorstrfixed",
    'charset("utf-8")',
    "maxquotedrows(10)",
  ])
    assert.equal(
      run(files, `import delimited using b.csv, clear ${option}`).rc,
      0,
      option,
    );
  assert.equal(
    run(files, "import delimited using b.csv, clear case(foo)").out[0],
    "foo: invalid argument in option case();\n   use upper, lower, or preserve\nr(198);",
  );
  assert.equal(
    run(files, "import delimited using b.csv, clear bindquotes(foo)").out[0],
    "foo is an invalid bindquotes() argument; use loose, strict, or nobind\nr(198);",
  );
});

test("U33: a variable list names the columns", () => {
  let r = run(
    { "b.csv": BASIC },
    "import delimited id nm sc using b.csv, clear",
  );
  assert.deepEqual(names(r), ["id", "nm", "sc"]);
  r = run({ "b.csv": BASIC }, "import delimited a b using b.csv, clear");
  assert.deepEqual(names(r), ["a", "b", "score"]);
  assert.equal(
    run({ "b.csv": BASIC }, "import delimited a b c d using b.csv, clear")
      .out[0].split("\n")
      .slice(-2)
      .join("\n"),
    "too many variables specified\nr(103);",
  );
  r = run({ "b.csv": BASIC }, "insheet id nm sc using b.csv, clear");
  assert.equal(
    r.out[0],
    "(note: variable names in file ignored)\n(3 vars, 3 obs)",
  );
  assert.deepEqual(names(r), ["id", "nm", "sc"]);
  assert.equal(
    run({ "b.csv": BASIC }, "insheet a b using b.csv, clear").rc,
    102,
  );
});

test("U37: a quoted field over two lines, loose by default and strict on request", () => {
  const files = { "nl.csv": 'id,comment\n1,"line one\nline two"\n2,plain\n' };
  let r = run(files, "set linesize 200\nimport delimited using nl.csv, clear");
  r.out.shift();
  const note = (row) =>
    `Note: Unmatched quote while processing row ${row}; this can be due to a formatting problem in the file or because a quoted data element spans multiple lines. You should carefully inspect your data after\n    importing. Consider using option bindquote(strict) if quoted data spans multiple lines or option bindquote(nobind) if quotes are not used for binding data.`;
  assert.equal(
    r.out[0],
    [
      "(encoding automatically selected: ISO-8859-1)",
      note(2),
      note(3),
      "(2 vars, 4 obs)",
    ].join("\n"),
  );
  assert.deepEqual(r.vars, ["v1 str9 %9s", "v2 str8 %9s"]);
  r = run(files, "import delimited using nl.csv, clear bindquotes(strict)");
  assert.equal(
    r.out[0],
    "(encoding automatically selected: ISO-8859-1)\n(2 vars, 2 obs)",
  );
  assert.deepEqual(r.vars, ["id byte %8.0g", "comment str17 %17s"]);
  const span =
    'a,b\n1,"' +
    Array.from({ length: 25 }, (_, k) => `l${k}`).join("\n") +
    '"\n2,x\n';
  r = run(
    { "s.csv": span },
    "import delimited using s.csv, clear bindquotes(strict)",
  );
  assert.equal(r.rc, 5101);
  assert.match(
    r.out[0],
    /Unmatched quote exceeded 20 lines while processing row 22;/,
  );
  r = run(
    { "s.csv": span },
    "import delimited using s.csv, clear bindquotes(strict) maxquotedrows(30)",
  );
  assert.deepEqual(r.vars, ["a byte %8.0g", "b str89 %89s"]);
});

test("U38, U46: which first rows are names", () => {
  const cases = [
    ["name,city\nAnn,Boston\nBob,NYC\n", 3, ["v1 str4 %9s", "v2 str6 %9s"]],
    [
      "country,1990,1991\nUSA,5.1,5.3\nMexico,3.2,3.4\n",
      3,
      ["v1 str7 %9s", "v2 float %9.0g", "v3 float %9.0g"],
    ],
    [
      "id,2019,2020\n1,5,6\n2,7,8\n",
      2,
      ["id byte %8.0g", "v2 byte %8.0g [2019]", "v3 byte %8.0g [2020]"],
    ],
    ["1,2,3\n4,5,6\n", 2, ["v1 byte %8.0g", "v2 byte %8.0g", "v3 byte %8.0g"]],
    ["a\n", 0, ["a byte %8.0g"]],
  ];
  for (const [text, n, vars] of cases) {
    const r = run({ "f.csv": text }, "import delimited using f.csv, clear");
    assert.equal(r.n, n, text);
    assert.deepEqual(r.vars, vars, text);
  }
  assert.deepEqual(
    run(
      { "f.csv": "name,city\nAnn,Boston\n" },
      "import delimited using f.csv, clear varnames(1)",
    ).vars,
    ["name str3 %9s", "city str6 %9s"],
  );
});

test("U39: NaN is missing to import delimited; Inf, NA and #N/A are text", () => {
  const r = run(
    { "s.csv": "a,b,c,d,e,f\nNaN,Inf,#N/A,-,NA,nan\n1,2,3,4,5,6\n" },
    "import delimited using s.csv, clear",
  );
  assert.deepEqual(r.vars, [
    "a byte %8.0g",
    "b str3 %9s",
    "c str4 %9s",
    "d str1 %9s",
    "e str2 %9s",
    "f str3 %9s",
  ]);
  const numbers = run(
    {
      "n.csv":
        "a,b,c,d,e,f,g,h,i,j\n+3, 4 ,.5,5.,1e5,1E+05,-0,0x1F,1d3,-.25\n1,2,3,4,5,6,7,8,9,10\n",
    },
    "import delimited using n.csv, clear",
  );
  assert.deepEqual(
    numbers.vars.map((v) => v.split(" ")[1]),
    [
      "byte",
      "byte",
      "float",
      "byte",
      "long",
      "long",
      "byte",
      "str4",
      "int",
      "float",
    ],
  );
});

test("Stata's r(4) and the extension rules for import delimited", () => {
  assert.equal(
    run({ "b.csv": BASIC }, "set obs 1\nimport delimited using b.csv").out[1],
    "no; data in memory would be lost\nr(4);",
  );
  assert.equal(run({ "b.csv": BASIC }, "import delimited using b, clear").n, 3);
  assert.equal(run({ "b.csv": BASIC }, "import delimited b.csv, clear").n, 3);
  const empty = run({ "e.csv": "" }, "import delimited using e.csv, clear");
  assert.equal(
    empty.out[0],
    "(encoding automatically selected: UTF-8)\n(0 vars, 0 obs)",
  );
  assert.equal(
    run({ "e.csv": "" }, "insheet using e.csv, clear").out[0],
    "unexpected end of file\nr(612);",
  );
});

const EXPORT_SETUP = [
  "clear",
  "set obs 4",
  "gen id = _n",
  "gen double big = 123456789.123456 * _n",
  "gen float f = 63078.11 + _n",
  "gen float g = 0.1 * _n",
  "gen d = mdy(3,12,2020) + _n",
  "format d %td",
  "gen d2 = d",
  "format d2 %tdCCYY-NN-DD",
  'gen str10 s = "a,b" if _n==1',
  `replace s = \`"q"x"' if _n==2`,
  'replace s = "  sp  " if _n==3',
  "gen lab = mod(_n,2)",
  'label define yn 0 "No" 1 "Yes, sure"',
  "label values lab yn",
  "gen m = _n",
  "replace m = . in 2",
  "replace m = .a in 3",
  "gen fmt = 1234.5678 * _n",
  "format fmt %9.2f",
  "gen byte b = _n",
  "format b %03.0f",
  "gen e = 1e-10 * _n",
].join("\n");

// What Stata 19 wrote for EXPORT_SETUP.
const WRITTEN = {
  "u1.csv":
    'id,big,f,g,d,d2,s,lab,m,fmt,b,e\n1,123456789.123456,63079.109,.1,13mar2020,2020-03-13,"a,b","Yes, sure",1,1234.5677,1,1.0000000e-10\n2,246913578.246912,63080.109,.2,14mar2020,2020-03-14,"q""x",No,,2469.1355,2,2.0000000e-10\n3,370370367.370368,63081.109,.30000001,15mar2020,2020-03-15,  sp  ,"Yes, sure",.a,3703.7034,3,3.0000000e-10\n4,493827156.493824,63082.109,.40000001,16mar2020,2020-03-16,,No,4,4938.271,4,4.0000001e-10\n',
  "u2.csv":
    'id,big,f,g,d,d2,s,lab,m,fmt,b,e\n1,123456789.123456,63079.109,.1,13mar2020,2020-03-13,"a,b","Yes, sure",1,1234.5677,1,1.0000000e-10\n2,246913578.246912,63080.109,.2,14mar2020,2020-03-14,"q""x","No",,2469.1355,2,2.0000000e-10\n3,370370367.370368,63081.109,.30000001,15mar2020,2020-03-15,"  sp  ","Yes, sure",.a,3703.7034,3,3.0000000e-10\n4,493827156.493824,63082.109,.40000001,16mar2020,2020-03-16,"","No",4,4938.271,4,4.0000001e-10\n',
  "u3.csv":
    'id,big,f,g,d,d2,s,lab,m,fmt,b,e\n1,123456789.123456,63079.109,.1,13mar2020,2020-03-13,"a,b",1,1,1234.5677,1,1.0000000e-10\n2,246913578.246912,63080.109,.2,14mar2020,2020-03-14,"q""x",0,,2469.1355,2,2.0000000e-10\n3,370370367.370368,63081.109,.30000001,15mar2020,2020-03-15,  sp  ,1,.a,3703.7034,3,3.0000000e-10\n4,493827156.493824,63082.109,.40000001,16mar2020,2020-03-16,,0,4,4938.271,4,4.0000001e-10\n',
  "u4.csv":
    'id,big,f,g,d,d2,s,lab,m,fmt,b,e\n1,1.235e+08,63079.11,.1,13mar2020,2020-03-13,"a,b","Yes, sure",1,1234.57,001,1.00e-10\n2,2.469e+08,63080.11,.2,14mar2020,2020-03-14,"q""x",No,,2469.14,002,2.00e-10\n3,3.704e+08,63081.11,.3,15mar2020,2020-03-15,  sp  ,"Yes, sure",.a,3703.70,003,3.00e-10\n4,4.938e+08,63082.11,.4,16mar2020,2020-03-16,,No,4,4938.27,004,4.00e-10\n',
  "u5.txt": '2\t"q""x"\tNo\n3\t  sp  \tYes, sure\n4\t\tNo\n',
  "u6.out":
    'id\tbig\tf\tg\td\td2\ts\tlab\tm\tfmt\tb\te\n1\t1.235e+08\t63079.11\t.1\t13mar2020\t2020-03-13\t"a,b"\t"Yes, sure"\t1\t1234.57\t001\t1.00e-10\n2\t2.469e+08\t63080.11\t.2\t14mar2020\t2020-03-14\t"q"x"\t"No"\t\t2469.14\t002\t2.00e-10\n3\t3.704e+08\t63081.11\t.3\t15mar2020\t2020-03-15\t"  sp  "\t"Yes, sure"\t.a\t3703.70\t003\t3.00e-10\n4\t4.938e+08\t63082.11\t.4\t16mar2020\t2020-03-16\t""\t"No"\t4\t4938.27\t004\t4.00e-10\n',
  "u7.csv": '1,a,b,1\n2,q"x,0\n3,sp  ,1\n4,,0\n',
  "u8.csv":
    "id,d,f\n1,13mar2020,63079.109\n2,14mar2020,63080.109\n3,15mar2020,63081.109\n4,16mar2020,63082.109\n",
};

test("U58: export delimited writes dates and labels as shown and numbers in full; outsheet", () => {
  const s = new Session(),
    commands = [
      "export delimited using u1.csv, replace",
      "export delimited using u2.csv, quote replace",
      "export delimited using u3.csv, nolabel replace",
      "export delimited using u4.csv, datafmt replace",
      "export delimited id s lab using u5.txt if id > 1, delimiter(tab) novarnames replace",
      "outsheet using u6.out, replace",
      "outsheet id s lab using u7.csv, comma nolabel noquote nonames replace",
      "export delimited id d f using u8, replace",
    ],
    result = s.run([EXPORT_SETUP, ...commands].join("\n"));
  assert.equal(result.rc, 0);
  for (const [name, text] of Object.entries(WRITTEN))
    assert.equal(s.files.get(name).text, text, name);
  const printed = result.output.slice(-commands.length).map((o) => o.lines);
  assert.deepEqual(printed[0], [
    "(file u1.csv not found)",
    "file u1.csv saved",
  ]);
  assert.deepEqual(printed[5], ["(file u6.out not found)"]);
  assert.deepEqual(printed[7], [
    "(file u8.csv not found)",
    "file u8.csv saved",
  ]);
  assert.deepEqual(s.run("export delimited using u1.csv").output[0].lines, [
    "file u1.csv already exists",
    "r(602);",
  ]);
  assert.deepEqual(s.run("outsheet using u6.out").output[0].lines, [
    "file u6.out already exists",
    "r(602);",
  ]);
  assert.equal(
    s.run('export delimited using u9.csv, delimiter(";;")').output[0].lines[0],
    ";; invalid character in delimiter() option",
  );
  // Read back, the dates are the text Stata wrote.
  s.run("import delimited using u8.csv, clear");
  assert.deepEqual(
    s.data.variables.map((v) => [v.name, v.type]),
    [
      ["id", "byte"],
      ["d", "str9"],
      ["f", "float"],
    ],
  );
  assert.equal(s.data.get("d").data[0], "13mar2020");
});

// The second round: what a tester found after the first fixes. Each result
// was again recorded from Stata 19 MP (batch, version 17) on these files.

test("A variable list is checked: invalid names, duplicates, names the header holds", () => {
  const files = {
    "g18.csv": "a,b\n1,2\n",
    "basic.csv": BASIC,
    "messy.csv": "First Name,Income ($),age\nAnn,10,3\n",
  };
  // The error, after the encoding line when the file was read.
  const error = (source) =>
    run(files, source).out[0].replace(/^\(encoding [^\n]*\n/, "");
  assert.equal(
    error("import delimited 1a b using g18.csv, clear"),
    "1a: invalid variable name\nr(198);",
  );
  for (const name of ["a-b", "_cons", "strL", "int", "x".repeat(45)])
    assert.equal(
      error(`import delimited ${name} b using g18.csv, clear`),
      `${name}: invalid variable name\nr(198);`,
    );
  // Each given name renames a variable in turn and cannot take a name that
  // another variable still holds.
  for (const source of [
    "import delimited a a using g18.csv, clear",
    "import delimited b using g18.csv, clear",
    "import delimited score using basic.csv, clear",
    "import delimited name x using basic.csv, clear",
    "import delimited name id using basic.csv, clear",
    "import delimited v2 using basic.csv, clear varnames(nonames)",
  ])
    assert.equal(error(source), "could not name variables specified\nr(198);");
  assert.deepEqual(
    names(run(files, "import delimited x id using basic.csv, clear")),
    ["x", "id", "score"],
  );
  assert.deepEqual(
    names(run(files, "import delimited x y id using basic.csv, clear")),
    ["x", "y", "id"],
  );
  assert.deepEqual(
    names(run(files, "import delimited A a using g18.csv, clear")),
    ["A", "a"],
  );
  // The header text is the label whenever it is not the name it gives.
  assert.deepEqual(
    run(files, "import delimited fn inc using messy.csv, clear").vars,
    [
      "fn str3 %9s [First Name]",
      "inc byte %8.0g [Income ($)]",
      "age byte %8.0g",
    ],
  );
  assert.deepEqual(
    run(files, "import delimited a B using g18.csv, clear case(upper)").vars,
    ["a byte %8.0g [a]", "B byte %8.0g [b]"],
  );
  // insheet has its own messages, and names a variable list as it would
  // header text.
  assert.equal(
    error("insheet 1a b using g18.csv, clear"),
    "1a invalid name\nr(198);",
  );
  assert.equal(
    error("insheet a a using g18.csv, clear"),
    "variable a already defined\nr(110);",
  );
  assert.equal(
    error("insheet _n b using g18.csv, clear"),
    "_n invalid varname\nr(198);",
  );
  assert.equal(
    error("insheet a-b c using g18.csv, clear"),
    "invalid syntax\nr(198);",
  );
  assert.deepEqual(run(files, "insheet A a using g18.csv, clear").vars, [
    "a byte %8.0g [A]",
    "v2 byte %8.0g [a]",
  ]);
});

test("colrange() looks for the names row only in the columns it keeps", () => {
  const files = {
    "c.csv": "id,name,city\n1,Ann,Boston\n2,Bob,NYC\n",
    "g17.csv": "ID,Name\n1,a\n",
  };
  let r = run(files, "import delimited using c.csv, clear colrange(2:3)");
  assert.equal(r.n, 3);
  assert.deepEqual(r.vars, ["v1 str4 %9s", "v2 str6 %9s"]);
  r = run(
    files,
    "import delimited using g17.csv, clear colrange(2) case(upper)",
  );
  assert.deepEqual([r.n, r.vars], [2, ["V1 str4 %9s"]]);
  r = run(
    files,
    "import delimited using g17.csv, clear colrange(2:2) varnames(1)",
  );
  assert.deepEqual([r.n, r.vars], [1, ["name str1 %9s [Name]"]]);
});

test("A number beyond a double's range is a missing value", () => {
  const files = {
    "o.csv": "id,x\n1,1e400\n2,3\n",
    "f08.csv": "x,y\n1D3,1e39\n2.5d-1,1e400\n",
  };
  for (const command of ["import delimited", "insheet"]) {
    const r = run(files, `${command} using o.csv, clear\ndisplay x[1]`);
    assert.deepEqual(r.vars, ["id byte %8.0g", "x byte %8.0g"]);
    assert.equal(r.out[1], ".");
  }
  assert.deepEqual(run(files, "import delimited using f08.csv, clear").vars, [
    "x float %9.0g",
    "y double %10.0g",
  ]);
});

test("Reserved words in a header, tested before and after case()", () => {
  const header = (text, options = "") =>
    run(
      { "r.csv": `${text}\n1,2\n` },
      `import delimited using r.csv, clear${options}`,
    );
  assert.equal(
    header("_cons,zz").out[0].split("\n").at(-2),
    "Error creating variables",
  );
  assert.equal(
    header("_se,zz").out[0].split("\n").at(-2),
    "Error creating variables",
  );
  assert.deepEqual(header("_skip,zz").vars, [
    "_skip byte %8.0g",
    "zz byte %8.0g",
  ]);
  assert.deepEqual(header("_all,zz").vars, [
    "_all byte %8.0g",
    "zz byte %8.0g",
  ]);
  assert.deepEqual(header("strL,zz").vars, [
    "v1 byte %8.0g [strL]",
    "zz byte %8.0g",
  ]);
  assert.deepEqual(header("strL,strl").vars, [
    "v1 byte %8.0g [strL]",
    "strl byte %8.0g",
  ]);
  assert.deepEqual(header("Byte,zz").vars, [
    "v1 byte %8.0g [Byte]",
    "zz byte %8.0g",
  ]);
  assert.deepEqual(header("Byte,zz", " case(preserve)").vars, [
    "Byte byte %8.0g",
    "zz byte %8.0g",
  ]);
  assert.deepEqual(header("_Cons,zz", " case(upper)").vars, [
    "_CONS byte %8.0g [_Cons]",
    "ZZ byte %8.0g [zz]",
  ]);
  const insheet = (text) =>
    run({ "r.csv": `${text}\n1,2\n` }, "insheet using r.csv, clear");
  assert.equal(
    insheet("_cons,zz").out[0],
    "_cons invalid varname\nerror in line 1 of file\nr(198);",
  );
  assert.equal(
    insheet("_se,zz").out[0],
    "_se invalid varname\nerror in line 1 of file\nr(198);",
  );
  assert.deepEqual(insheet("_skip,zz").vars, [
    "_skip byte %8.0g",
    "zz byte %8.0g",
  ]);
  assert.deepEqual(insheet("strL,zz").vars, [
    "strl byte %8.0g [strL]",
    "zz byte %8.0g",
  ]);
});

test("varnames(#) after the first row: a names row of numbers sets types too", () => {
  const typed = (text) =>
    run({ "p.csv": text }, "import delimited using p.csv, clear varnames(2)")
      .vars;
  assert.deepEqual(typed("id,v\n1,2.5\n3,4\n"), [
    "v1 byte %8.0g [1]",
    "v2 float %9.0g [2.5]",
  ]);
  assert.deepEqual(typed("top\n12345\nab\n"), ["v1 str5 %9s [12345]"]);
  // A names row holding text does not.
  assert.deepEqual(typed("top,row\nid,v\n1,abc\n3,4\n"), [
    "id byte %8.0g",
    "v str3 %9s",
  ]);
  assert.deepEqual(typed(BASIC), [
    "v1 byte %8.0g [1]",
    "smithj str3 %9s",
    "v3 byte %8.0g [71.5]",
  ]);
});

test("numericcols() wins over stringcols(); case() and ranges as Stata reads them", () => {
  const files = {
    "m01.csv": "id,zip,amt,name\n1,02134,1.5,ab\n2,10001,2,cd\n",
    "g05.csv": "a,b\n1,2\n3,4\n5,6\n7,8\n",
  };
  let r = run(
    files,
    "import delimited using m01.csv, clear stringcols(2) numericcols(2)\ndisplay zip[1]",
  );
  assert.equal(r.vars[1], "zip int %8.0g");
  assert.equal(r.out[1], "2134");
  for (const arg of ["l", "lowe", "u", "upp", "pre", "pres", "preserve"])
    assert.equal(
      run(files, `import delimited using g05.csv, clear case(${arg})`).rc,
      0,
      arg,
    );
  for (const arg of ["p", "pr", "L", "LOWER", "lowerx"])
    assert.equal(
      run(files, `import delimited using g05.csv, clear case(${arg})`).out[0],
      `${arg}: invalid argument in option case();\n   use upper, lower, or preserve\nr(198);`,
    );
  const message = (option) =>
    run(
      files,
      `import delimited using g05.csv, clear ${option}`,
    ).out[0].replace(/\nr\(198\);$/, "");
  assert.equal(
    message("rowrange(3:2)"),
    "3:2 is an invalid row range in rowrange() option\nstart row is greater than end row",
  );
  assert.equal(
    message("colrange(5:3)"),
    "5:3 is an invalid column range in colrange() option\nstart column is greater than end column",
  );
  assert.equal(
    message("rowrange(abc)"),
    "abc is an invalid start row in rowrange() option",
  );
  assert.equal(
    message("colrange(1.5)"),
    "1.5 is an invalid start column in colrange() option",
  );
  assert.equal(
    message("rowrange(0:2)"),
    "0 is an invalid start row in rowrange() option",
  );
  assert.equal(
    message("rowrange(2:abc)"),
    "abc: invalid end row in rowrange() option",
  );
  assert.equal(
    message("colrange(2:3:4)"),
    "3:4: invalid end col in colrange() option",
  );
  assert.equal(
    message("rowrange(:)"),
    ": invalid end row in rowrange() option",
  );
  assert.equal(
    message("colrange(:)"),
    " is an invalid end column in colrange() option",
  );
  assert.equal(
    message("maxquotedrows(1.5)"),
    "option maxquotedrows() incorrectly specified.",
  );
  assert.equal(
    run(files, "import delimited using g05.csv, clear maxquotedrows(-1)").rc,
    0,
  );
  assert.equal(
    run(files, "import delimited using g05.csv, clear rowrange(10)").n,
    0,
  );
});

test("insheet's blanks, quotes and option checks", () => {
  const sheet = (text, extra = "") => {
    const r = run({ "f.csv": text }, `insheet using f.csv, clear${extra}`);
    const values = r.rc
      ? []
      : r.session
          .run(
            r.vars
              .map((v) => {
                const name = v.split(" ")[0];
                return `display ${v.includes(" str") ? `"[" ${name}[1] "]"` : `${name}[1]`}`;
              })
              .join("\n"),
          )
          .output.map((o) => o.lines.join(""));
    return { ...r, values };
  };
  let r = sheet('id,c\n1, "a,b"\n');
  assert.deepEqual(
    [r.vars, r.values],
    [
      ["id byte %8.0g", "c str3 %9s"],
      ["1", "[a,b]"],
    ],
  );
  r = sheet('id,c\n1,"a ""q"" b"\n2,"x"y\n');
  assert.deepEqual([r.vars[1], r.values[1]], ["c str2 %9s", "[ b]"]);
  assert.equal(r.session.run("display c[2]").output[0].lines[0], "xy");
  r = sheet('id,c\n1,"a\n\nb"\n2,z\n');
  assert.deepEqual([r.vars[1], r.values[1]], ["c str3 %9s", "[a b]"]);
  r = sheet('id,c\n1,"x \n y"\n');
  assert.deepEqual([r.vars[1], r.values[1]], ["c str4 %9s", "[x  y]"]);
  // A space after a closing quote is kept, so "1" followed by a space is text.
  r = sheet('id,x\n"1" ,2\n2,"3" \n');
  assert.deepEqual([r.n, r.vars], [3, ["v1 str2 %9s", "v2 str2 %9s"]]);
  // Unquoted spaces are dropped from the value but counted in the width, and
  // spaces alone are text; a line's leading spaces go first.
  r = sheet("a,b\n1, \n2,3\n");
  assert.deepEqual(
    [r.vars, r.values],
    [
      ["a byte %8.0g", "b str1 %9s"],
      ["1", "[]"],
    ],
  );
  r = sheet("a,b,c\n1,  ,3\n4,5,6\n");
  assert.deepEqual(r.vars, ["a byte %8.0g", "b str2 %9s", "c byte %8.0g"]);
  r = sheet("a,b\n , \n1,2\n");
  assert.deepEqual(r.vars, ["a byte %8.0g", "b str1 %9s"]);
  r = sheet("a,b\n1, 2 \n");
  assert.deepEqual(r.vars, ["a byte %8.0g", "b byte %8.0g"]);
  for (const text of ["\n\n", ",,\n,,\n", "   \n"])
    assert.equal(sheet(text).out[0], "unexpected end of file\nr(612);");
  r = sheet(",,\n,,\n1,2,3\n");
  assert.deepEqual(
    [r.n, r.vars],
    [1, ["v1 byte %8.0g", "v2 byte %8.0g", "v3 byte %8.0g"]],
  );
  r = run(
    { "bom.csv": bytes(0xef, 0xbb, 0xbf) },
    "insheet using bom.csv, clear",
  );
  assert.deepEqual([r.n, r.vars], [0, ["v1 byte %8.0g [﻿]"]]);
  const option = (extra) => sheet("a,b\n1,2\n", extra).out[0];
  assert.equal(
    option(" names comma tab"),
    "both tab and comma not allowed\nr(198);",
  );
  assert.equal(
    option(' delimiter(";") comma'),
    "both comma and delimiter() not allowed\nr(198);",
  );
  assert.equal(
    option(' delimiter(";") tab'),
    "both tab and delimiter() not allowed\nr(198);",
  );
  for (const spec of ['";;"', "tab", '"\\t"'])
    assert.equal(
      option(` delimiter(${spec})`),
      "option delimiter() incorrectly specified\nr(198);",
    );
  assert.equal(sheet("a,b\n1,2\n", ' delimiter("")').rc, 0);
});

test("export delimited needs a variable; syntax and file names as Stata reads them", () => {
  const s = createConsoleSession();
  assert.deepEqual(
    s.run("export delimited using x.csv, replace").output[0].lines,
    ["too few variables specified", "r(102);"],
  );
  s.addFile("noext", "a,b\n1,2\n");
  s.addFile("my data.csv", "a,b\n1,2\n");
  const say = (source) => s.run(source).output[0].lines.join("\n");
  assert.equal(say("import delimited, clear"), "using required\nr(100);");
  assert.equal(
    say("import delimited my data.csv, clear"),
    "using required\nr(100);",
  );
  assert.equal(say("insheet, clear"), "using required\nr(100);");
  assert.equal(
    say("insheet plain.txt, clear"),
    "plain.txt invalid name\nr(198);",
  );
  assert.equal(
    say("import delimited using my data.csv, clear"),
    "invalid 'data.csv' \nr(198);",
  );
  assert.equal(
    say("insheet using my data.csv, clear"),
    "invalid 'data.csv' \nr(198);",
  );
  assert.equal(
    say('import delimited "my data.csv", clear'),
    "(encoding automatically selected: ISO-8859-9)\n(2 vars, 1 obs)",
  );
  // The extension is added to a name without one, even when a file has
  // that name.
  assert.equal(
    say("import delimited using noext, clear"),
    "file noext.csv not found\nr(601);",
  );
  assert.equal(
    say("insheet using noext, clear"),
    "file noext.raw not found\nr(601);",
  );
});

test("encoding() takes Java's names for character sets", () => {
  const files = { "l.csv": bytes("id,name\n1,Jos", 0xe9, "\n") };
  for (const name of [
    "windows-1252",
    "WINDOWS-1252",
    "cp1252",
    "latin1",
    "LATIN1",
    "ISO-8859-15",
    "ISO_8859-1",
    "macroman",
    "MacRoman",
    "utf8",
    "sjis",
    "koi8-r",
    "US-ASCII",
  ])
    assert.equal(
      run(files, `import delimited using l.csv, clear encoding("${name}")`).rc,
      0,
      name,
    );
  for (const name of [
    "windows1252",
    "latin-1",
    "iso885915",
    "x-mac-roman",
    "macintosh",
    "ISO-8859-8-I",
    "x",
  ])
    assert.equal(
      run(files, `import delimited using l.csv, clear encoding("${name}")`)
        .out[0],
      "encoding not supported\nr(198);",
      name,
    );
  // Java names whose decoder the browser lacks are refused with a hint.
  assert.match(
    run(files, "import delimited using l.csv, clear encoding(ibm-1047)").out[0],
    /^encoding ibm-1047 is not available here;[\s\S]*r\(198\);$/,
  );
});

test("The encoding scan is ICU's on the first 8,000 bytes, naming the last of tied leaders", () => {
  const line = (bytesIn, name) =>
    run(
      { [name]: bytesIn },
      `import delimited using ${name}, clear`,
    ).out[0].split("\n")[0];
  // Plain ASCII: the language statistics of ISO-8859-1, -2 and -9 decide,
  // and a tie goes to the later in ICU's order.
  assert.equal(
    line(bytes('id,name\n1,"Smith, J"\n2,"Doe"\n'), "f02.csv"),
    "(encoding automatically selected: ISO-8859-2)",
  );
  assert.equal(
    line(bytes("id,big\n1,2147483621\n2,3\n"), "f06.csv"),
    "(encoding automatically selected: ISO-8859-9)",
  );
  const head = [],
    row = [];
  for (let i = 1; i <= 3000; i++) {
    head.push(`c${i}`);
    row.push(((i * 7919) % 1000) / 10);
  }
  assert.equal(
    line(bytes(`${head.join(",")}\n${row.join(",")}\n`), "wide.csv"),
    "(encoding automatically selected: UTF-8)",
  );
  assert.equal(
    line(bytes("id,price\n1,5 ", 0x80, "\n"), "h03.csv"),
    "(encoding automatically selected: windows-1250)",
  );
  // An invalid byte counts at offset 7,999 but not at 8,000.
  const late = (offset) =>
    bytes("1,2\n".repeat(2001).slice(0, offset - 2), "1,", 0xe9, "\n");
  assert.equal(
    line(late(7999), "l1.csv"),
    "(encoding automatically selected: KOI8-R)",
  );
  assert.equal(
    line(late(8000), "l2.csv"),
    "(encoding automatically selected: UTF-8)",
  );
  // UTF-8 that only turns non-ASCII past the sample is read as ISO-8859-1.
  const rows = ["id,city"];
  for (let i = 1; i <= 6000; i++) rows.push(`${i},Paris`);
  const text = `${rows.join("\n")}\n6001,Montréal\n`;
  for (const content of [new Uint8Array(Buffer.from(text)), text]) {
    const r = run(
      { "h02.csv": content },
      "import delimited using h02.csv, clear\ndisplay city[6001]",
    );
    assert.equal(
      r.out[0].split("\n")[0],
      "(encoding automatically selected: ISO-8859-1)",
    );
    assert.equal(r.vars[1], "city str11 %11s");
    assert.equal(r.out[1], "MontrÃ©al");
  }
  // One invalid byte in UTF-8 text.
  const r = run(
    { "h04.csv": bytes("id,name\n1,Zo", 0xc3, 0xab, "\n2,Jos", 0xe9, "\n") },
    'import delimited using h04.csv, clear\ndisplay name[1] "|" name[2]',
  );
  assert.equal(
    r.out[0].split("\n")[0],
    "(encoding automatically selected: ISO-8859-2)",
  );
  assert.equal(r.out[1], "ZoĂŤ|José");
});

test("Bytes that are not text are refused with a Stata error", async () => {
  const { StataError } = await import("../src/runtime/errors.js");
  const s = createConsoleSession();
  s.run("clear\nset obs 2\ngenerate x = _n");
  const dta = s.exportData().bytes;
  for (const content of [
    bytes("a,b\n1,", 0, "\n"),
    dta,
    bytes("PK", 3, 4, 20, 0, 0, 0, 8, 0),
  ]) {
    assert.throws(
      () => s.addFile("x.csv", content),
      (e) =>
        e instanceof StataError && /x\.csv is not a text file/.test(e.message),
    );
    assert.equal(s.run("import delimited using x.csv, clear").rc, 601);
  }
});
