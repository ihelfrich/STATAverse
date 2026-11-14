// Files from other programs: import excel (.xlsx, .xlsm and .xls), export
// excel, putexcel, import spss (.sav and .zsav), import sasxport5,
// import sasxport8 and export sasxport5.
//
// Every fixture in tests/fixtures/userdata holds simulated data. The .xlsx
// workbooks were built by hand with fflate: shared and inline strings,
// booleans, errors, formulas with cached values, a merged title, blank rows,
// percent, custom date and date-time formats and the 1904 date system.
// student.xls, d1904.xls and sst.xls were saved from them by LibreOffice
// (sst.xls has enough strings to run into CONTINUE records), and
// course-stata.xls/.xlsx and sim5-stata.xpt with formats.xpf were written by
// Stata 19's export excel and export sasxport5. The .sav, .zsav and the other
// .xpt files were written by R haven. stata-imports.json holds what Stata 19
// MP (version 17, set processors 1) printed and imported for each command;
// the other expected values below were recorded from Stata 19 as well.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createConsoleSession } from "../src/console-session.js";
import { StataError } from "../src/runtime/errors.js";
import { applyFormat } from "../src/runtime/format.js";
import { Session } from "../src/runtime/session.js";

const folder = new URL("./fixtures/userdata/", import.meta.url),
  fixture = (name) => new Uint8Array(fs.readFileSync(new URL(name, folder))),
  recorded = JSON.parse(
    fs.readFileSync(new URL("stata-imports.json", folder), "utf8"),
  );
const FILES = fs.readdirSync(folder).filter((name) => !name.endsWith(".json"));

/** A session whose folder holds every fixture, as the Console keeps them. */
function sessionWithFiles(names = FILES) {
  const session = new Session();
  session.files = new Map(
    names.map((name) => [name, { bytes: fixture(name) }]),
  );
  return session;
}
const printed = (result) =>
  result.output
    .flatMap((entry) => entry.lines)
    .flatMap((line) => line.split("\n"))
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line, k, all) => line || (k > 0 && k < all.length - 1));
const shown = (variable, i) =>
  typeof variable.data[i] === "string"
    ? variable.data[i]
    : applyFormat(variable.data[i], "%21.0g").trim();
// Stata keeps letters outside ASCII in a variable name; this runtime's names
// are ASCII, so such a header names the variable by its column letter.
const RENAMED = { Ünïcode: "M" };

for (const expected of recorded.results)
  test(`imports as Stata 19 does: ${expected.command}`, () => {
    const session = sessionWithFiles(),
      result = session.run(expected.command);
    assert.equal(result.rc, expected.rc);
    assert.deepEqual(printed(result), expected.printed);
    const data = session.data;
    assert.deepEqual(
      data.variables.map((v) => v.name),
      expected.variables.map((v) => RENAMED[v.name] ?? v.name),
    );
    for (const want of expected.variables) {
      const v = data.get(RENAMED[want.name] ?? want.name),
        where = `${expected.command}: ${want.name}`;
      assert.equal(v.type, want.type, where);
      assert.equal(v.format, want.format, where);
      assert.equal(v.label, want.label, where);
      assert.equal(v.valueLabel, want.valueLabel, where);
      assert.equal(data.n, want.n, where);
      assert.deepEqual(
        want.values.map((_, i) => shown(v, i)),
        want.values,
        where,
      );
    }
  });

test("import excel, describe stores the sheets and ranges in r()", () => {
  const session = sessionWithFiles(["student.xlsx", "gaps.xlsx"]);
  session.run("import excel using student.xlsx, describe");
  // Stata 19: r(N_worksheet) = 3, r(worksheet_2) = "Data", r(range_2) = "A1:H8".
  assert.equal(session.results.r.N_worksheet, 3);
  assert.equal(session.results.r.worksheet_2, "Data");
  assert.equal(session.results.r.range_2, "A1:H8");
  // An empty sheet has an empty range; Stata prints "     Empty | ".
  const out = session.run("import excel using gaps.xlsx, describe");
  assert.equal(out.output[0].lines[3], "     Empty | ");
});

test("import excel refuses what Stata refuses, with Stata's codes", () => {
  const rc = (command, data = false) => {
    const session = sessionWithFiles(["student.xlsx"]);
    if (data) session.run("set obs 2\ngenerate x = 1");
    return session.run(command).rc;
  };
  // Recorded from Stata 19.
  assert.equal(rc("import excel using nofile.xlsx, clear"), 601);
  assert.equal(rc('import excel using student.xlsx, sheet("data") clear'), 601);
  assert.equal(
    rc("import excel using student.xlsx, cellrange(Z99) clear"),
    198,
  );
  assert.equal(
    rc(
      'import excel using student.xlsx, sheet("Data") cellrange(A1:H100) clear',
    ),
    198,
  );
  assert.equal(rc("import excel using student.xlsx, case(proper) clear"), 198);
  assert.equal(
    rc('import excel using student.xlsx, allstring("%foo") clear'),
    198,
  );
  assert.equal(rc("import excel using student.xlsx", true), 4);
  assert.equal(rc("import excel using student.xlsx, describe clear"), 198);
  assert.equal(rc("import excel A using student.xlsx, firstrow clear"), 198);
  // locale() is not implemented, so it is refused rather than ignored.
  assert.equal(rc('import excel using student.xlsx, locale("en") clear'), 198);
  // A missing sheet clears the data, as in Stata (N=0 afterwards).
  const session = sessionWithFiles(["student.xlsx"]);
  session.run("set obs 2\ngenerate x = 1");
  session.run('capture import excel using student.xlsx, sheet("Nope") clear');
  assert.equal(session.data.variables.length, 0);
});

test("a damaged workbook, SPSS or SAS file is reported, never a crash", () => {
  const junk = new Uint8Array(3000).map((_, k) => (k * 7919) % 251),
    noWorkbook = zipSync({ "hello.txt": strToU8("hi") });
  const cases = [
    ["junk.xlsx", junk, "import excel using junk.xlsx, clear", 603],
    ["junk.xls", junk, "import excel using junk.xls, clear", 603],
    ["empty.xlsx", noWorkbook, "import excel using empty.xlsx, clear", 603],
    ["junk.sav", junk, "import spss using junk.sav, clear", 692],
    ["junk.xpt", junk, "import sasxport5 junk.xpt, clear", 610],
  ];
  for (const [name, bytes, command, code] of cases) {
    const session = new Session();
    session.files = new Map([[name, { bytes }]]);
    assert.equal(session.run(command).rc, code, command);
    // The Console reads the file as it is added and says why it cannot.
    assert.throws(
      () => createConsoleSession().addData(name, bytes),
      (error) => error instanceof StataError,
    );
  }
  // Cut every fixture short at several places: each failure is a Stata error.
  for (const name of FILES) {
    const whole = fixture(name),
      command = /\.xlsx?$/.test(name)
        ? `import excel using ${name}, clear`
        : /sav$/.test(name)
          ? `import spss using ${name}, clear`
          : /8\.xpt$/.test(name)
            ? `import sasxport8 ${name}, clear`
            : `import sasxport5 ${name}, clear`;
    for (const share of [0.1, 0.35, 0.6, 0.85, 0.97]) {
      const session = new Session();
      session.files = new Map([
        [name, { bytes: whole.slice(0, Math.floor(whole.length * share)) }],
      ]);
      const result = session.run(command);
      assert.ok(result.rc === 0 || result.rc >= 600, `${name} at ${share}`);
    }
  }
});

test("the Console keeps added workbooks and data files as bytes", () => {
  const s = createConsoleSession();
  // Stata 19: student.xlsx has the sheets Notes, Data and Wide.
  assert.deepEqual(s.addData("student.xlsx", fixture("student.xlsx")).sheets, [
    "Notes",
    "Data",
    "Wide",
  ]);
  const sav = s.addData("survey.sav", fixture("survey.sav"));
  assert.equal(sav.rows, 4);
  assert.equal(sav.variables, 11);
  assert.equal(
    s.addData("nhanes-like.xpt", fixture("nhanes-like.xpt")).rows,
    3,
  );
  assert.ok(s.readFile("student.xlsx").bytes instanceof Uint8Array);
  // Stata 19: use on a workbook is "file student.xlsx not Stata format" r(610).
  assert.equal(s.run("use student.xlsx, clear").rc, 610);
  // .sas7bdat files are refused with advice, at once.
  assert.throws(
    () => s.addData("iris.sas7bdat", new Uint8Array(1024)),
    (error) => error instanceof StataError && /SAS/.test(error.hint),
  );
  assert.equal(s.run("import sas using iris.sas7bdat, clear").rc, 198);
});

test("export excel writes what Stata writes and reads back the same", () => {
  const session = new Session();
  session.run(`clear
set obs 3
generate id = _n
generate str6 name = word("Ann Bob Carla", _n)
generate byte female = mod(_n, 2)
label define sexl 0 "male" 1 "female"
label values female sexl
generate double stamp = 1.9e12 + _n * 3600000
replace stamp = . in 2`);
  // %tc is set directly: the display format belongs to another package.
  session.data.get("stamp").format = "%tc";
  const out = session.run("export excel using t.xlsx, firstrow(variables)");
  assert.deepEqual(out.output[0].lines, ["file t.xlsx saved"]);
  // Stata 19: an existing file needs replace (r602), .xls is not written here.
  assert.equal(session.run("export excel using t.xlsx").rc, 602);
  const xls = session.run("export excel using t.xls, replace");
  assert.equal(xls.rc, 198);
  assert.match(xls.output[0].lines[0], /\.xls format is not available/);
  assert.equal(session.run("export excel using t").rc, 198);
  session.run("import excel using t.xlsx, firstrow clear");
  const data = session.data;
  // Stata 19 reads its own export of these as: id byte %10.0g, female str6
  // (labels are written as text), stamp double %tcnn/dd/ccYY_hh:MM.
  assert.equal(data.get("id").type, "byte");
  assert.deepEqual(data.get("female").data, ["female", "male", "female"]);
  assert.equal(data.get("stamp").type, "double");
  assert.equal(data.get("stamp").format, "%tcnn/dd/ccYY_hh:MM");
  assert.equal(data.get("stamp").data[0], 1.9e12 + 3600000);
  assert.ok(data.get("stamp").data[1] > 8e307);
  // A workbook Stata wrote is modified in place by sheet(..., modify).
  const stata = sessionWithFiles(["course-stata.xlsx"]);
  stata.run("clear\nset obs 1\ngenerate z = 42");
  assert.equal(
    stata.run(
      'export excel using course-stata.xlsx, sheet("Sheet1", modify) cell(G2)',
    ).rc,
    0,
  );
  stata.run("import excel using course-stata.xlsx, firstrow clear");
  assert.equal(stata.data.n, 4);
  assert.equal(stata.data.get("G").data[0], 42);
  assert.equal(stata.data.get("name").data[2], "Carla Diaz");
});

test("putexcel writes values, formulas and matrices and refuses formatting", () => {
  const session = new Session();
  session.run(`putexcel set m.xlsx, replace
matrix M = (1, 2 \\ 3, 4)
putexcel A1 = matrix(M)
putexcel A5 = matrix(M), names
putexcel D1 = formula(SUM(A1:B2))`);
  session.run("import excel using m.xlsx, clear allstring");
  // Stata 19 wrote: 1 2 / 3 4 at A1, then c1 c2 over r1 1 2 / r2 3 4 at A5.
  assert.deepEqual(session.data.get("A").data, [
    "1",
    "3",
    "",
    "",
    "",
    "r1",
    "r2",
  ]);
  assert.deepEqual(session.data.get("C").data, [
    "",
    "",
    "",
    "",
    "c2",
    "2",
    "4",
  ]);
  const bold = session.run('putexcel B9 = "x", bold');
  assert.equal(bold.rc, 198);
  assert.match(bold.output[0].lines[0], /option bold is not available/);
  assert.equal(session.run('putexcel A1:B2 = "x"').rc, 198);
  assert.equal(session.run("putexcel A1 = image(x.png)").rc, 198);
  // Stata 19: an unknown result type such as date(...) is "date not found" r(111).
  assert.equal(session.run('putexcel A1 = date("2024-01-15", "YMD")').rc, 111);
});

test("export sasxport5 writes the bytes Stata writes", () => {
  const session = new Session();
  session.run(`clear
input id str12 name double income byte female float bdate
1 "Ann" 52000.5 1 21915
2 "Bob" . 0 22000
3 "Carla Diaz" 61000 1 .
4 "" 47000.25 0 22100
end
format bdate %td
label define sexl 0 "male" 1 "female"
label values female sexl
label var income "Annual income"`);
  const out = session.run("export sasxport5 sim5-stata.xpt, replace");
  assert.deepEqual(out.output[0].lines, [
    "file sim5-stata.xpt saved",
    "file formats.xpf saved",
  ]);
  // Only the creation times in the headers differ from Stata's files.
  const times = [
    [80 + 64, 80 + 80],
    [160, 176],
    [400 + 64, 400 + 80],
    [480, 496],
  ];
  for (const name of ["sim5-stata.xpt", "formats.xpf"]) {
    const ours = session.files.get(name).bytes.slice(),
      theirs = fixture(name);
    for (const [from, to] of times) {
      ours.fill(0, from, to);
      theirs.fill(0, from, to);
    }
    assert.deepEqual(ours, theirs, name);
  }
  // Stata 19: without formats.xpf the import warns and keeps the label name.
  const alone = sessionWithFiles(["sim5-stata.xpt"]);
  const result = alone.run("import sasxport5 sim5-stata.xpt, clear");
  assert.deepEqual(printed(result), [
    "Warning:  file sim5-stata.xpt contains variables with value labels, but value",
    "          label file formats.xpf or FORMATS.xpf could not be opened",
  ]);
  assert.equal(alone.data.get("female").valueLabel, "sexl");
  // Stata 19 refuses a version 5 file in import sasxport8, r(603).
  assert.equal(alone.run("import sasxport8 sim5-stata.xpt, clear").rc, 603);
});

// ----- user-data round 4: what a tester found at the first version -----
// Every expected value below was recorded from Stata 19 MP (version 17, set
// processors 1) on the same files. The small workbooks are built here;
// odd.sav, zero.sav, v8dt.xpt and v5dt.xpt were written by R haven from
// simulated values, and sheets.xls by LibreOffice from a simulated workbook.

/** A minimal .xlsx: sheets of hand-written sheetData, plus extra parts. */
function workbook(sheets, extra = {}) {
  const rels = sheets
      .map(
        (_, k) =>
          `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`,
      )
      .join(""),
    files = {
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}${extra.types ?? ""}</Types>`,
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
      "xl/workbook.xml": strToU8(
        `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map(([name], k) => `<sheet name="${name}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("")}</sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}${extra.rels ?? ""}</Relationships>`,
      ),
    };
  sheets.forEach(([, data, around = ""], k) => {
    files[`xl/worksheets/sheet${k + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData>${around}</worksheet>`,
    );
  });
  for (const [name, text] of Object.entries(extra.parts ?? {}))
    files[name] = strToU8(text);
  return zipSync(files);
}
const inline = (ref, text) =>
  `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
const num = (ref, value) => `<c r="${ref}"><v>${value}</v></c>`;
const OFFSET =
  `<row r="2">${inline("B2", "id")}${inline("C2", "score")}${inline("D2", "name")}</row>` +
  [1, 2, 3]
    .map(
      (i) =>
        `<row r="${i + 2}">${num(`B${i + 2}`, i)}${num(`C${i + 2}`, 69 + i)}${inline(`D${i + 2}`, `s${i - 1}`)}</row>`,
    )
    .join("");
const RAGGED =
  `<row r="5">${inline("C5", "a")}${inline("D5", "b")}</row>` +
  `<row r="6">${num("C6", 1)}${num("D6", 2)}${num("E6", 3)}${inline("F6", "z")}</row>` +
  `<row r="7">${num("C7", 4)}${num("E7", 6)}</row><row r="9">${num("C9", 7)}</row><row r="12"></row>`;

function sessionWith(files) {
  const session = new Session();
  session.files = new Map(
    Object.entries(files).map(([name, bytes]) => [name, { bytes }]),
  );
  return session;
}
// What a command printed, without the r(#) line an error ends with.
const said = (result) =>
  printed(result).filter((line) => !/^r\(\d+\);$/.test(line));
const dims = (session) => [session.data.n, session.data.variables.length];
const shownValue = (value) =>
  typeof value === "string" ? value : applyFormat(value, "%9.0g").trim();

test("import excel finds the data area as Stata does and refuses ranges outside it", () => {
  const session = sessionWith({
    "offset.xlsx": workbook([["Sheet1", OFFSET]]),
    "tallrow.xlsx": workbook([
      ["Sheet1", OFFSET + '<row r="9" spans="2:4" ht="30" customHeight="1"/>'],
    ]),
    "ragged.xlsx": workbook([["Sheet1", RAGGED]]),
    "toprow.xlsx": workbook([
      [
        "Sheet1",
        '<row r="1" ht="30" customHeight="1"/><row r="2"></row>' +
          [3, 4, 5]
            .map(
              (r) =>
                `<row r="${r}">${num(`B${r}`, r)}${num(`C${r}`, 10 * r)}</row>`,
            )
            .join(""),
      ],
      ["Empty", '<row r="4" ht="20" customHeight="1"/><row r="7"/>'],
      ["None", ""],
    ]),
  });
  const left = [
      "invalid column range in option cellrange();",
      "    The upper left column is left of the data area in the worksheet.",
    ],
    before = [
      "invalid row range in option cellrange();",
      "    The upper left row is before the data area in the worksheet.",
    ];
  const check = (command, rc, lines, n, k) => {
    const result = session.run(command);
    assert.equal(result.rc, rc, command);
    if (lines) assert.deepEqual(said(result), lines, command);
    assert.deepEqual(dims(session), [n, k], command);
  };
  check(
    "import excel using offset.xlsx, cellrange(A2) firstrow clear",
    198,
    left,
    0,
    0,
  );
  check(
    "import excel using offset.xlsx, cellrange(B1) firstrow clear",
    198,
    before,
    0,
    0,
  );
  check(
    "import excel using offset.xlsx, cellrange(A1:D5) clear",
    198,
    left,
    0,
    0,
  );
  check(
    "import excel using offset.xlsx, cellrange(B2) firstrow clear",
    0,
    ["(3 vars, 3 obs)"],
    3,
    3,
  );
  // A blank row whose height was changed is part of the data area.
  check(
    "import excel using tallrow.xlsx, describe",
    0,
    ["     Sheet | Range", "  ---------+---------", "    Sheet1 | B2:D9"],
    3,
    3,
  );
  check(
    "import excel using tallrow.xlsx, firstrow clear",
    0,
    ["(3 vars, 7 obs)"],
    7,
    3,
  );
  assert.ok(
    session.data
      .get("score")
      .data.slice(3)
      .every((v) => v > 8e307),
  );
  for (const [range, rc, n, k, lines] of [
    ["A1", 198, 0, 0, left],
    ["A5:D6", 198, 0, 0, left],
    ["C1:D6", 198, 0, 0, before],
    [":D7", 0, 3, 2, ["(2 vars, 3 obs)"]],
    ["C5:F12", 0, 8, 4, ["(4 vars, 8 obs)"]],
    ["C12", 0, 1, 4, ["(4 vars, 1 obs)"]],
    ["C10:D11", 0, 2, 2, ["(2 vars, 2 obs)"]],
    [
      "C13",
      198,
      0,
      0,
      [
        "invalid row range in option cellrange();",
        "    The upper left row is after the data area in the worksheet.",
      ],
    ],
    [
      "G5",
      198,
      0,
      0,
      [
        "invalid column range in option cellrange();",
        "    The upper left column is right of the data area in the worksheet.",
      ],
    ],
  ])
    check(
      `import excel using ragged.xlsx, cellrange(${range}) clear`,
      rc,
      lines,
      n,
      k,
    );
  check(
    "import excel using ragged.xlsx, describe",
    0,
    ["     Sheet | Range", "  ---------+---------", "    Sheet1 | C5:F12"],
    0,
    0,
  );
  check(
    "import excel using toprow.xlsx, describe",
    0,
    [
      "     Sheet | Range",
      "  ---------+---------",
      "    Sheet1 | B1:C5",
      "     Empty | A4:A7",
      "      None |",
    ],
    0,
    0,
  );
  check("import excel using toprow.xlsx, clear", 0, ["(2 vars, 5 obs)"], 5, 2);
  check(
    "import excel using toprow.xlsx, sheet(Empty) clear",
    0,
    ["(0 vars, 0 obs)"],
    0,
    0,
  );
  check(
    "import excel using toprow.xlsx, sheet(None) clear",
    0,
    ["(0 vars, 0 obs)"],
    0,
    0,
  );
  check(
    "import excel using toprow.xlsx, sheet(Empty) cellrange(A4) clear",
    198,
    [
      "invalid column range in option cellrange();",
      "    The upper left column is right of the data area in the worksheet.",
    ],
    0,
    0,
  );
  // A badly written range is refused before memory is cleared.
  session.run("import excel using toprow.xlsx, cellrange(B2:C3) clear");
  for (const [range, message] of [
    ["5", "invalid cell range 5 in option cellrange()"],
    ["A", "invalid cell range A in option cellrange()"],
    ["AAAA1", "column name AAAA out of range in option cellrange()"],
    ["A0", "row number 0 out of range in option cellrange()"],
    ["A1:5", "invalid cell range 5 in option cellrange()"],
    ["1A", "invalid column name 1A in option cellrange()"],
    ["A1:B", "invalid cell range B in option cellrange()"],
    [":", "invalid cell range in option cellrange()"],
    ["$5", "invalid column name $5 in option cellrange()"],
    ["B3:XFE3", "column name XFE out of range in option cellrange()"],
    ["B3:C1048577", "row number 1048577 out of range in option cellrange()"],
  ])
    check(
      `import excel using toprow.xlsx, cellrange(${range}) clear`,
      198,
      [message],
      2,
      2,
    );
});

test("import excel reads formulas that were never calculated as Stata does", () => {
  const header =
    '<row r="1">' +
    [..."abcdefghi"].map((c, k) => inline(`${"ABCDEFGHI"[k]}1`, c)).join("") +
    "</row>";
  const row2 =
    '<row r="2"><c r="A2"><f>1+1</f></c><c r="B2"><f>1+1</f><v/></c>' +
    '<c r="C2" t="str"><f>"s"</f><v/></c><c r="D2" t="str"><f>"s"</f></c>' +
    '<c r="E2" t="b"><f>TRUE()</f></c><c r="F2" t="e"><f>1/0</f></c>' +
    '<c r="G2"><f t="shared" ref="G2:G3" si="0">1+2</f></c><c r="H2"><v/></c><c r="I2" t="s"><f>"x"</f></c></row>';
  const row3 =
    `<row r="3">${num("A3", 5)}${num("B3", 6)}<c r="C3" t="str"><f>"q"</f><v>q</v></c>` +
    `${num("D3", 7)}${num("E3", 8)}${num("F3", 9)}<c r="G3"><f t="shared" si="0"/></c>${num("H3", 3)}${num("I3", 4)}</row>`;
  const session = sessionWith({
    "fcache.xlsx": workbook([["Sheet1", header + row2 + row3]]),
  });
  session.run("import excel using fcache.xlsx, firstrow clear");
  const row = (i) => session.data.variables.map((v) => shownValue(v.data[i]));
  // <v/> after a formula is 0 (openpyxl and pandas write that); no <v> at
  // all is missing, except for a boolean formula, which is false.
  assert.deepEqual(row(0), [".", "0", "", ".", "0", ".", ".", ".", "."]);
  assert.deepEqual(row(1), ["5", "6", "q", "7", "8", "9", ".", "3", "4"]);
  assert.equal(session.data.get("c").type, "str1");
  session.run("import excel using fcache.xlsx, clear");
  assert.deepEqual(
    session.data.variables.map((v) => v.data[1]),
    ["", "0", "", "", "0", "", "", "", ""],
  );
});

test("import excel stops at 5,000 variables with r(900), keeping them", () => {
  const rows = [
    `<row r="1">${inline("A1", "id")}${inline("B1", "score")}${inline("XFD1", "stray")}</row>`,
  ];
  for (let i = 1; i <= 20; i++)
    rows.push(
      `<row r="${i + 1}">${num(`A${i + 1}`, i)}${num(`B${i + 1}`, 49 + i)}</row>`,
    );
  const session = sessionWith({
    "wide.xlsx": workbook([["Sheet1", rows.join("")]]),
  });
  session.run("set linesize 200");
  const result = session.run("import excel using wide.xlsx, firstrow clear"),
    message = [
      "no room to add more variables",
      "    Up to 5,000 variables are currently allowed, although you could reset the maximum using set maxvar; see help memory.",
    ];
  assert.equal(result.rc, 900);
  // Stata prints the message twice, and the variables made so far stay.
  assert.deepEqual(said(result), [...message, ...message]);
  assert.deepEqual(dims(session), [20, 5000]);
});

test("import excel shows an 8-bit .xls sheet name the way Stata 19 does", () => {
  const session = sessionWithFiles(["sheets.xls"]),
    result = session.run("import excel using sheets.xls, describe");
  // Stata reads the name's UTF-8 bytes again as Latin-1 and sizes the
  // table by bytes.
  assert.deepEqual(said(result), [
    "              Sheet | Range",
    "  ------------------+------------------",
    "             grades | A1:O30",
    "                hdr | A1:L4",
    "            onlyhdr | A1:B1",
    "              empty |",
    "  Ã\u0091andÃº sheet | A1:A2",
    "               wide | A1:IV5",
    "               calc | A1:G6",
  ]);
  const missing = session.run(
    'import excel using sheets.xls, sheet("Ñandú sheet") clear',
  );
  assert.equal(missing.rc, 601);
  assert.deepEqual(said(missing), ["worksheet Ñandú sheet not found"]);
});

test("export excel writes the number formats and period dates Stata writes", () => {
  const session = new Session();
  session.run(`clear
set obs 2
generate double v1 = 1234.5678 * _n`);
  const formats = {
    a: "%9.2f",
    b: "%9.1f",
    c: "%12.2fc",
    d: "%9.0fc",
    e: "%8.2e",
    f: "%9.1e",
    g: "%12.0gc",
    h: "%10.0g",
    i: "%tc",
    j: "%tcHH:MM:SS",
    k: "%tcDD-Mon-CCYY",
    l: "%td",
    m: "%tm",
    q: "%tq",
    w: "%tw",
    hh: "%th",
    y: "%ty",
    s: "%tcHH:MM:SS.sss",
  };
  for (const [name, format] of Object.entries(formats)) {
    session.run(`generate double ${name} = 1234.5678 * _n`);
    // Set directly: some of these formats belong to another package.
    session.data.get(name).format = format;
  }
  session.run("drop v1");
  assert.equal(session.run("export excel using f.xlsx, replace").rc, 0);
  const parts = unzipSync(session.files.get("f.xlsx").bytes),
    text = (name) => strFromU8(parts[name]),
    xfs = [
      ...text("xl/styles.xml")
        .match(/<cellXfs[\s\S]*<\/cellXfs>/)[0]
        .matchAll(/numFmtId="(\d+)"/g),
    ].map((m) => Number(m[1])),
    row = /<row r="1">([\s\S]*?)<\/row>/.exec(
      text("xl/worksheets/sheet1.xml"),
    )[1],
    cells = [
      ...row.matchAll(/<c r="([A-Z]+)1"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g),
    ];
  const numFmt = (cell) => xfs[Number(/s="(\d+)"/.exec(cell[2])?.[1] ?? 0)],
    value = (cell) => Number(/<v>([^<]*)<\/v>/.exec(cell[3] ?? "")?.[1]);
  // Stata 19 wrote these number formats and serial numbers.
  assert.deepEqual(
    cells.map((cell) => numFmt(cell)),
    [2, 1, 4, 1, 11, 1, 3, 1, 22, 19, 22, 14, 14, 14, 14, 14, 14, 0],
  );
  assert.deepEqual(
    cells.slice(11, 17).map(value),
    [23150.5678, 59476, 134593, 30583, 247272, -243250],
  );
  // A %tc format with fractions of a second is written as an empty string.
  assert.match(cells.at(-1)[2], /t="s"/);
  // datestring() turns a %tm value's raw number into a date, as Stata does.
  session.run(`clear
set obs 1
generate int mo = ym(2024, 1)`);
  session.data.get("mo").format = "%tm";
  session.run('export excel using d.xlsx, datestring("%tdCCYY-NN-DD") replace');
  session.run("import excel using d.xlsx, clear");
  assert.deepEqual(session.data.get("A").data, ["1962-02-07"]);
});

test("export excel and export sasxport5 refuse what Stata refuses", () => {
  const session = new Session();
  session.run(`clear
set obs 3
generate id = _n
generate str3 s = "ab"`);
  const trace = (first) => [
    first,
    ...(first.includes("_xlbkaddsheet")
      ? []
      : ["    export_excel_write():     -  function returned error"]),
    "export_excel_write_file():     -  function returned error",
    "export_excel_export_file():     -  function returned error",
    "                 <istmt>:     -  function returned error",
  ];
  for (const [command, first] of [
    [
      'export excel id using t.xlsx, sheet("bad/name") replace',
      "         _xlbkaddsheet():  9901  Stata returned error",
    ],
    [
      `export excel id using t.xlsx, sheet("'quoted'") replace`,
      "         _xlbkaddsheet():  9901  Stata returned error",
    ],
    [
      'export excel id using t.xlsx, sheet("abcdefghijklmnopqrstuvwxyz123456") replace',
      "      _xlshwritenumcol():  9901  Stata returned error",
    ],
    [
      'export excel s id using t.xlsx, sheet("abcdefghijklmnopqrstuvwxyz123456") replace',
      "      _xlshwritestrcol():  9901  Stata returned error",
    ],
    [
      'export excel id using t.xlsx, sheet("abcdefghijklmnopqrstuvwxyz123456") firstrow(variables) replace',
      "         _xlshwritestr():  9901  Stata returned error",
    ],
  ]) {
    const result = session.run(command);
    assert.equal(result.rc, 9901, command);
    assert.deepEqual(said(result), trace(first), command);
    assert.equal(session.files?.has("t.xlsx") ?? false, false, command);
  }
  assert.equal(
    session.run(
      'export excel id using t.xlsx, sheet("abcdefghijklmnopqrstuvwxyz12345") replace',
    ).rc,
    0,
  );
  const none = session.run("export excel id using u.xlsx if id > 5, replace");
  assert.equal(none.rc, 198);
  assert.deepEqual(said(none), ["observations must be between 1 and 1048576"]);
  // putexcel's own messages for such names.
  session.run('putexcel set p.xlsx, sheet("x/y") replace');
  const bad = session.run("putexcel A1 = 1");
  assert.equal(bad.rc, 603);
  assert.deepEqual(said(bad), ["file p.xlsx could not be loaded"]);
  session.run('putexcel set t.xlsx, sheet("a:b") modify');
  const add = session.run("putexcel A1 = 1");
  assert.equal(add.rc, 603);
  assert.deepEqual(said(add), ["worksheet a:b could not be created"]);
  // export sasxport5 takes a varlist with using.
  assert.equal(
    session.run('export sasxport5 id using "o1.xpt" in 1/2, replace').rc,
    0,
  );
  session.run("import sasxport5 o1.xpt, clear");
  assert.deepEqual(dims(session), [2, 1]);
  assert.equal(
    session.run("export sasxport5 o2.xpt, vallabfile(xpt) replace").rc,
    198,
  );
  session.run("drop in 1/2");
  for (const command of [
    "export excel id using e0.xlsx, replace",
    "export excel id using e0.xlsx, firstrow(variables) replace",
    "export sasxport5 z0.xpt, replace",
  ]) {
    const result = session.run(command);
    assert.equal(result.rc, 2000, command);
    assert.deepEqual(said(result), ["no observations"], command);
  }
});

test("putexcel and export excel keep what else a student's workbook holds", () => {
  const styles =
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"/><right style="thin"/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>';
  const data =
    `<row r="1">${inline("A1", "Title over three columns")}</row>` +
    `<row r="2">${inline("A2", "x")}${inline("B2", "y")}${inline("C2", "label")}</row>` +
    '<row r="3"><c r="A3" s="1"><v>1</v></c><c r="B3" s="2"><f>A3*2</f><v>2</v></c><c r="C3" t="str"><f>"Car"&amp;"l"</f><v>Carl</v></c></row>' +
    '<row r="4"><c r="A4" s="1"><v>3</v></c><c r="B4" s="2"><f>A4*2</f><v>6</v></c><c r="C4" t="str"><f>IF(A4&gt;2,"hi","lo")</f><v>hi</v></c></row>';
  const book = workbook(
    [
      [
        "Data",
        data,
        '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>',
      ],
    ],
    {
      types:
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
      rels: '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>',
      parts: {
        "xl/styles.xml": styles,
        "xl/calcChain.xml":
          '<?xml version="1.0"?><calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B3" i="1"/><c r="C3"/><c r="B4"/><c r="C4"/></calcChain>',
        "docProps/core.xml":
          '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>sim</dc:creator></cp:coreProperties>',
      },
    },
  );
  const session = sessionWith({ "wb.xlsx": book });
  session.run(`putexcel set wb.xlsx, modify sheet("Data")
putexcel E2 = "note"
putexcel A4 = 5
clear
set obs 2
generate v = _n
export excel using wb.xlsx, sheet("new")`);
  const parts = unzipSync(session.files.get("wb.xlsx").bytes),
    text = (name) => strFromU8(parts[name]),
    sheet = text("xl/worksheets/sheet1.xml");
  // Stata 19 keeps merged cells, fills, borders, string formulas and the
  // document properties; only the cells written change.
  assert.match(sheet, /<mergeCell ref="A1:C1"\/>/);
  assert.equal(sheet.match(/<f>/g).length, 4);
  assert.match(sheet, /<f>"Car"&amp;"l"<\/f><v>Carl<\/v>/);
  // putexcel keeps the yellow, bordered style of the cell it writes.
  assert.match(sheet, /<c r="A4" s="1"><v>5<\/v><\/c>/);
  assert.match(text("xl/styles.xml"), /FFFFFF00[\s\S]*style="thin"/);
  assert.ok(parts["docProps/core.xml"]);
  assert.ok(parts["xl/calcChain.xml"]);
  assert.match(
    text("xl/workbook.xml"),
    /<sheet name="new" sheetId="2" r:id="rId\d+"\/>/,
  );
  assert.match(
    text("[Content_Types].xml"),
    /PartName="\/xl\/worksheets\/sheet2\.xml"/,
  );
  session.run(
    'import excel using wb.xlsx, sheet("Data") cellrange(A2) firstrow clear',
  );
  assert.deepEqual(Array.from(session.data.get("x").data), [1, 5]);
  assert.deepEqual(session.data.get("label").data, ["Carl", "hi"]);
  assert.equal(session.data.get("note").label, "note");
  session.run('import excel using wb.xlsx, sheet("new") clear');
  assert.deepEqual(Array.from(session.data.get("A").data), [1, 2]);
  // A formula overwritten with a value takes Excel's calculation chain with
  // it, which Excel then rebuilds.
  session.run(`putexcel set wb.xlsx, modify sheet("Data")
putexcel B3 = 0`);
  const after = unzipSync(session.files.get("wb.xlsx").bytes);
  assert.equal(after["xl/calcChain.xml"], undefined);
  assert.doesNotMatch(
    strFromU8(after["xl/_rels/workbook.xml.rels"]),
    /calcChain/,
  );
});

test("import spss names and labels odd SPSS variables as Stata 19 does", () => {
  const session = sessionWithFiles(["odd.sav", "zero.sav"]),
    notes = [
      "may not label .5",
      "note: invalid numeric value for value label labels1, skipped",
      "note: no values defined for value label labels1, removed",
      "may not label 1.5",
      "note: invalid numeric value for value label labels1, skipped",
      "note: no values defined for value label labels1, removed",
      "note: invalid string value m for value label labels2, skipped",
      "note: no values defined for value label labels2, removed",
      "note: invalid string value f for value label labels2, skipped",
      "note: may not attach value label to string variable: no label applied",
    ];
  const result = session.run("import spss using odd.sav, clear");
  assert.deepEqual(said(result), [...notes, "(19 vars, 6 obs)"]);
  // The renamed variables are numbered among themselves.
  assert.deepEqual(
    session.data.variables.slice(5, 10).map((v) => v.name),
    ["_v1", "_v2", "_v3", "_v4", "_v5"],
  );
  // A bad value before any good one removes the whole set; frac keeps the
  // name of the label it no longer has, and the string set stays empty.
  assert.equal(session.data.get("frac").valueLabel, "labels1");
  assert.equal(session.data.valueLabels.has("labels1"), false);
  assert.equal(session.data.valueLabels.get("labels2").size, 0);
  assert.equal(session.data.valueLabels.get("labels0").size, 5);
  const upper = session.run("import spss using odd.sav, case(upper) clear");
  assert.deepEqual(said(upper), [...notes, "(19 vars, 6 obs)"]);
  assert.deepEqual(
    session.data.variables.slice(5, 10).map((v) => v.name),
    ["_V1", "_V2", "_V3", "_V4", "_V5"],
  );
  // With no cases nothing is compressed: doubles, and SPSS's 8-byte string.
  const zero = session.run("import spss using zero.sav, clear");
  assert.deepEqual(said(zero), [
    "note: invalid string value m for value label labels1, skipped",
    "note: no values defined for value label labels1, removed",
    "note: invalid string value f for value label labels1, skipped",
    "note: may not attach value label to string variable: no label applied",
    "(3 vars, 0 obs)",
  ]);
  assert.deepEqual(
    session.data.variables.map((v) => [v.name, v.type, v.format]),
    [
      ["id", "double", "%8.0f"],
      ["q1", "double", "%8.2f"],
      ["sex", "str8", "%1s"],
    ],
  );
});

test("SAS transport imports clear memory and read SAS missing values and formats as Stata 19 does", () => {
  const session = sessionWithFiles(["v5dt.xpt", "v8dt.xpt"]);
  session.run("import sasxport5 v5dt.xpt, clear");
  // Without clear: import sasxport5 gives Stata's usual r(4) message.
  const kept = session.run("import sasxport5 v5dt.xpt");
  assert.equal(kept.rc, 4);
  assert.deepEqual(said(kept), [
    "no; dataset in memory has changed since last saved",
  ]);
  assert.deepEqual(said(session.run("import sasxport8 v8dt.xpt")), [
    "no; data in memory would be lost",
  ]);
  // A file refused after clear leaves memory empty.
  assert.equal(session.run("import sasxport5 v8dt.xpt, clear").rc, 610);
  assert.deepEqual(dims(session), [0, 0]);
  session.run("import sasxport5 v5dt.xpt, clear");
  assert.equal(session.run("import sasxport8 v5dt.xpt, clear").rc, 603);
  assert.deepEqual(dims(session), [0, 0]);
  const described = said(session.run("import sasxport5 v5dt.xpt, describe"));
  assert.deepEqual(described.slice(0, 4), [
    "data from v5dt.xpt, member(demo)",
    "  obs:                6             13nov26:18:33:03",
    " vars:                9             (date shown exactly as recorded in file)",
    " size:            1,608",
  ]);
  assert.deepEqual(described.slice(14, 16), [
    "dt          datetime",
    "tm          time",
  ]);
  session.run("import sasxport8 v8dt.xpt, clear");
  const v = (name) => session.data.get(name);
  // SAS's .A to .Z come in as plain missing; DATETIME and TIME get %tc
  // formats over SAS's seconds.
  assert.deepEqual(
    Array.from(v("a_long_variable_name_over_8").data, (x) => shownValue(x)),
    [".", "1.5", ".", "-1.00e-10", "7.24e+75", "."],
  );
  assert.deepEqual(
    ["D", "DT", "TM"].map((name) => [v(name).type, v(name).format]),
    [
      ["long", "%td"],
      ["long", "%tc"],
      ["double", "%tcHH:MM:SS"],
    ],
  );
  assert.equal(v("DT").data[0], 2020896000);
});
