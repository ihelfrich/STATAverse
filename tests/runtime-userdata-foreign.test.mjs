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
import { strToU8, zipSync } from "fflate";
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
