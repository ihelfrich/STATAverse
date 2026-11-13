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
