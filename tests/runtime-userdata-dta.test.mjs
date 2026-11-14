// A student's own .dta files: every format Stata has written since Stata 5
// that is still met, long strings (strL), notes and characteristics,
// labels of .a to .z, the sort order, large datasets and Unicode names.
// The expected text was recorded from Stata 19 reading the same files.
// The files in tests/fixtures/userdata hold simulated data: course1xx.dta
// were saved by Stata 19 (118; 117 by saveold, version(13); 115 by saveold,
// version(12)) and by R's haven (114 with version = 10, 113 with
// version = 8); strl11x.dta by Stata 19; old1xx.dta were built from the
// documented layout and read back by Stata 19 as shown below.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createConsoleSession } from "../src/console-session.js";
import { readDta, writeDta } from "../src/console-dta.js";
import { MISSING } from "../src/runtime/values.js";

const STEP = 2 ** 1011;
const fixture = (name) =>
  new Uint8Array(
    fs.readFileSync(new URL(`./fixtures/userdata/${name}`, import.meta.url)),
  );
/** A Console session with the file added as x.dta and in use. */
function using(bytes) {
  const s = createConsoleSession();
  s.addData("x.dta", bytes);
  const r = s.run("use x.dta, clear");
  assert.equal(r.rc, 0, r.output.at(-1)?.lines.join("\n"));
  return s;
}
/** What one command prints, without the blank lines around it. */
function shown(s, command) {
  const r = s.run(command);
  assert.equal(r.rc, 0, `${command}: ${r.output.at(-1)?.lines.join("\n")}`);
  const lines = r.output
    .flatMap((block) => block.lines)
    .flatMap((line) => line.split("\n"))
    .map((line) => line.replace(/\s+$/, ""));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.join("\n");
}
const block = (text) => text.replace(/^\n/, "").replace(/\n$/, "");

const COURSE = {
  list: block(`
     +-------------------------+
     | id   female      region |
     |-------------------------|
  1. |  7     Male   Northeast |
  2. | 13   Female   Northeast |
  3. | 15     Male   Northeast |
  4. | 16   Female   Northeast |
  5. | 18   Female   Northeast |
     |-------------------------|
  6. | 20   Female     Midwest |
  7. | 22   Female     Midwest |
  8. | 24   Female     Midwest |
  9. |  1   Female       South |
 10. |  6   Female       South |
     |-------------------------|
 11. |  8   Female       South |
 12. |  9     Male       South |
     +-------------------------+
`),
  tabulate: block(`
     Census |
     region |      Freq.     Percent        Cum.
------------+-----------------------------------
  Northeast |          5       20.83       20.83
    Midwest |          3       12.50       33.33
      South |          5       20.83       54.17
       West |          9       37.50       91.67
    Refused |          1        4.17       95.83
  Not asked |          1        4.17      100.00
------------+-----------------------------------
      Total |         24      100.00
`),
  summarize: block(`
    Variable |        Obs        Mean    Std. dev.       Min        Max
-------------+---------------------------------------------------------
          id |         24        12.5    7.071068          1         24
      female |         24        .625    .4945354          0          1
      region |         22    2.818182    1.220319          1          4
      income |         23    30644.09    22529.96       3149      97480
        wage |         23     14.5713    6.030763       4.35      31.48
-------------+---------------------------------------------------------
         gpa |         23    1.748565    1.353673       .012      3.904
        bday |         24    12882.54    1178.852      10979      14527
        name |          0
       grade |          0
`),
  notes: block(`
_dta:
  1.  Simulated for testing
  2.  Second dataset note

income:
  1.  Top-coded at 1,000,000
`),
  chars: block(`
  _dta[note1]:                Simulated for testing
  _dta[note0]:                2
  _dta[note2]:                Second dataset note
  _dta[author]:               Test builder
  income[note0]:              1
  income[note1]:              Top-coded at 1,000,000
  income[source]:             Simulated tax records
`),
};

for (const release of [118, 117, 115, 114, 113])
  test(`format ${release} is read as Stata 19 reads it`, () => {
    const s = using(fixture(`course${release}.dta`));
    assert.equal(shown(s, "list id female region in 1/12"), COURSE.list);
    // .a and .b carry their value labels (Refused, Not asked).
    assert.equal(shown(s, "tabulate region, missing"), COURSE.tabulate);
    assert.equal(shown(s, "summarize"), COURSE.summarize);
    const data = readDta(fixture(`course${release}.dta`)),
      by = Object.fromEntries(data.variables.map((v) => [v.name, v]));
    assert.equal(data.label, "Simulated course survey");
    // haven stores every number as a double and each string at the width
    // of its longest value, keeping the formats.
    const haven = release <= 114;
    assert.deepEqual(
      data.variables.map((v) => [v.name, v.type, v.format]),
      [
        ["id", "int", "%8.0g"],
        ["female", "byte", "%8.0g"],
        ["region", "byte", "%9.0g"],
        ["income", "long", "%12.0fc"],
        ["wage", "float", "%9.0g"],
        ["gpa", "double", "%10.0g"],
        ["bday", "int", "%td"],
        ["name", haven ? "str9" : "str12", "%12s"],
        ["grade", haven ? "str1" : "str3", "%9s"],
      ].map(([name, type, format]) => [
        name,
        haven && !type.startsWith("str") ? "double" : type,
        format,
      ]),
    );
    assert.equal(by.income.label, "Household income (USD)");
    assert.equal(by.wage.data[0], MISSING + 26 * STEP);
    assert.equal(by.gpa.data.filter((x) => x === MISSING + 2 * STEP).length, 1);
    assert.equal(
      by.income.data.filter((x) => x === MISSING + 3 * STEP).length,
      1,
    );
    // haven names each label after its variable, keeps no notes and no
    // sort order; Stata's own files keep all three.
    const old = haven;
    assert.equal(by.region.valueLabel, old ? "region" : "reglbl");
    assert.equal(
      data.valueLabels.get(by.region.valueLabel).get(MISSING + STEP),
      "Refused",
    );
    assert.deepEqual(data.sortedBy, old ? [] : ["region", "id"]);
    if (old) assert.equal(shown(s, "notes"), "");
    else {
      assert.equal(shown(s, "notes"), COURSE.notes);
      assert.equal(shown(s, "char list"), COURSE.chars);
    }
  });

test("the formats of Stata 6, 7 and 7 SE are read; Stata 5's value labels are passed over", () => {
  const list = block(`
     +-----------------------------------------------+
     |   b      i       l      f           d       s |
     |-----------------------------------------------|
  1. | Yes   -300   70000    1.5        3.25   apple |
  2. |  No    100      -5   -2.5   1.00e+100    pear |
  3. |   .      .       .      .           .         |
     +-----------------------------------------------+
`);
  for (const release of [108, 110, 111]) {
    const s = using(fixture(`old${release}.dta`));
    assert.equal(shown(s, "list"), list, `format ${release}`);
    assert.equal(shown(s, "notes"), "_dta:\n  1.  An old note");
    const data = readDta(fixture(`old${release}.dta`));
    assert.deepEqual(data.sortedBy, ["i"]);
    assert.equal(data.label, `Old ${release}`);
    assert.deepEqual(
      data.variables.map((v) => [v.name, v.type, v.label]),
      [
        ["b", "byte", "A byte"],
        ["i", "int", "An int"],
        ["l", "long", "A long"],
        ["f", "float", "A float"],
        ["d", "double", "A double"],
        ["s", "str5", "A string"],
      ],
    );
  }
  const s = using(fixture("old105.dta"));
  assert.match(shown(s, "list b i s"), /\| 1   -300   apple \|/);
  // Formats from before Stata 5 and Stata 8's test release are refused.
  for (const release of [104, 112])
    assert.throws(
      () => readDta(new Uint8Array([release, 2, 1, 0, 0, 0, 0, 0, 0, 0])),
      { code: 610, message: new RegExp(`format ${release}`) },
    );
});

for (const release of [118, 117])
  test(`strL variables are read: format ${release}`, () => {
    const s = using(fixture(`strl${release}.dta`));
    shown(s, "generate n = strlen(essay)");
    assert.equal(
      shown(s, "list id n tag"),
      block(`
     +-----------------+
     | id      n   tag |
     |-----------------|
  1. |  1   3000    t1 |
  2. |  2     14    t2 |
  3. |  3      0    t3 |
  4. |  4     15    t4 |
  5. |  5      5    t5 |
     |-----------------|
  6. |  6     14    t6 |
     +-----------------+
`),
    );
    assert.equal(
      shown(s, "list id essay in 2/4"),
      block(`
     +---------------------+
     | id            essay |
     |---------------------|
  2. |  2   Short answer 2 |
  3. |  3                  |
  4. |  4   Zoë wrote this |
     +---------------------+
`),
    );
    const essay = readDta(fixture(`strl${release}.dta`)).variables[1];
    assert.equal(essay.type, "strL");
    // Row 6 shares row 2's stored text; row 5 is binary: \0 \1 a b c.
    assert.equal(essay.data[5], "Short answer 2");
    assert.equal(essay.data[4], "\0\u0001abc");
    assert.equal(essay.data[0], "x".repeat(3000));
  });

test("strL text and binary written here read back, in this page and in Stata", () => {
  const s = using(fixture("strl118.dta"));
  shown(s, 'generate strL more = essay + "!"');
  const back = readDta(s.exportData().bytes),
    more = back.variables.find((v) => v.name === "more");
  assert.equal(more.type, "strL");
  // Stata 19 listed the exported file's row 5 as \0abc! and row 3 as !.
  assert.deepEqual(
    [...more.data],
    [
      "x".repeat(3000) + "!",
      "Short answer 2!",
      "!",
      "Zoë wrote this!",
      "\0\u0001abc!",
      "Short answer 2!",
    ],
  );
});

test("labels of .a to .z are read, and written as Stata codes them", () => {
  const s = using(fixture("course118.dta"));
  shown(
    s,
    `label define yn 0 "No" 1 "Yes" .a "Don't know" .b "Refused"\ngenerate byte ans = mod(_n, 2)\nreplace ans = .a in 1\nreplace ans = .b in 2\nlabel values ans yn`,
  );
  const bytes = s.exportData().bytes,
    labels = readDta(bytes).valueLabels.get("yn");
  assert.deepEqual(
    [...labels],
    [
      [0, "No"],
      [1, "Yes"],
      [MISSING + STEP, "Don't know"],
      [MISSING + 2 * STEP, "Refused"],
    ],
  );
  // In the file .a and .b are the long codes 2147483622 and 2147483623;
  // Stata 19 then lists 0 No, 1 Yes, .a Don't know, .b Refused.
  const raw = new DataView(bytes.buffer),
    text = new TextDecoder("latin1").decode(bytes),
    at = text.indexOf("<lbl>", text.indexOf("yn\0") - 20);
  const table = text.indexOf("yn\0", at) + 129 + 3,
    count = raw.getUint32(table, true);
  assert.equal(count, 4);
  assert.deepEqual(
    [0, 1, 2, 3].map((k) => raw.getInt32(table + 8 + 4 * count + 4 * k, true)),
    [0, 1, 2147483622, 2147483623],
  );
  const again = using(bytes);
  assert.equal(
    shown(again, "tabulate ans, missing"),
    block(`
        ans |      Freq.     Percent        Cum.
------------+-----------------------------------
         No |         11       45.83       45.83
        Yes |         11       45.83       91.67
 Don't know |          1        4.17       95.83
    Refused |          1        4.17      100.00
------------+-----------------------------------
      Total |         24      100.00
`),
  );
});

test("the sort order ends at the first zero in the sortlist", () => {
  // Stata may leave other numbers after the zero that ends the list.
  const s = createConsoleSession();
  s.run("set obs 5\ngenerate a = 6 - _n\ngenerate b = _n");
  const bytes = s.exportData().bytes,
    text = new TextDecoder("latin1").decode(bytes),
    at = text.indexOf("<sortlist>") + 10;
  bytes.set([0, 0, 2, 0, 1, 0], at);
  assert.deepEqual(readDta(bytes).sortedBy, []);
  const t = using(bytes);
  const r = t.run("by b: generate n = _n");
  assert.equal(r.rc, 5);
  assert.deepEqual(readDta(t.exportData().bytes).sortedBy, []);
  // A sort written here reads back.
  t.run("sort b a");
  assert.deepEqual(readDta(t.exportData().bytes).sortedBy, ["b", "a"]);
});

test("notes and characteristics are written back with the data", () => {
  const s = using(fixture("course118.dta"));
  shown(s, 'notes wage: Measured hourly\nchar wage[unit] "dollars"');
  const back = readDta(s.exportData().bytes),
    notes = (data, owner) =>
      [...(data.chars.get(owner) ?? [])]
        .filter(([name]) => /^note\d+$/.test(name))
        .sort(),
    note = (k, text) => [`note${k}`, text];
  assert.deepEqual(notes(back, "_dta"), [
    note(0, "2"),
    note(1, "Simulated for testing"),
    note(2, "Second dataset note"),
  ]);
  assert.deepEqual(notes(back, "income"), [
    note(0, "1"),
    note(1, "Top-coded at 1,000,000"),
  ]);
  assert.deepEqual(notes(back, "wage"), [
    note(0, "1"),
    note(1, "Measured hourly"),
  ]);
  assert.equal(back.chars.get("wage").get("unit"), "dollars");
  assert.equal(back.chars.get("_dta").get("author"), "Test builder");
  // Stata 19 read the exported file and listed its characteristics so,
  // the reverse of the order they had here, as it does with its own files.
  assert.equal(
    shown(using(s.exportData().bytes), "char list"),
    block(`
  _dta[author]:               Test builder
  _dta[note2]:                Second dataset note
  _dta[note0]:                2
  _dta[note1]:                Simulated for testing
  income[source]:             Simulated tax records
  income[note1]:              Top-coded at 1,000,000
  income[note0]:              1
  wage[note0]:                1
  wage[note1]:                Measured hourly
  wage[unit]:                 dollars
`),
  );
  // They follow a variable that is renamed and leave with one dropped.
  shown(s, "rename income earnings\ndrop wage");
  const after = readDta(s.exportData().bytes);
  assert.deepEqual([...after.chars.keys()], ["_dta", "earnings"]);
  assert.equal(
    after.chars.get("earnings").get("note1"),
    "Top-coded at 1,000,000",
  );
  assert.equal(
    after.chars.get("earnings").get("source"),
    "Simulated tax records",
  );
  assert.equal(after.chars.has("wage"), false);
});

test("large datasets load: 500,000 x 12 and 3,000 x 2,000", () => {
  const wide = (n, k, type, value) => ({
    n,
    label: "",
    sortedBy: [],
    valueLabels: new Map(),
    variables: Array.from({ length: k }, (_, j) => ({
      name: `v${j + 1}`,
      type,
      format: "%9.0g",
      label: "",
      valueLabel: "",
      data: Float64Array.from({ length: n }, (_, i) => value(i, j)),
    })),
  });
  for (const [n, k, type] of [
    [500_000, 12, "float"],
    [3_000, 2_000, "byte"],
  ]) {
    const bytes = writeDta(wide(n, k, type, (i, j) => (i + j) % 7)),
      s = createConsoleSession(),
      added = s.addData("big.dta", bytes);
    assert.deepEqual([added.rows, added.variables], [n, k]);
    const r = s.run(
      `use big.dta, clear\nquietly summarize v${k}\nassert r(N) == ${n}`,
    );
    assert.equal(r.rc, 0, r.output.at(-1)?.lines.join("\n"));
  }
  // A file larger than the browser can hold is refused before it is read,
  // with what it would need.
  const header = writeDta(wide(1, 12, "double", () => 1));
  new DataView(header.buffer).setBigUint64(
    new TextDecoder("latin1").decode(header).indexOf("<N>") + 3,
    20_000_000_000n,
    true,
  );
  assert.throws(() => readDta(header), {
    code: 610,
    message:
      /20,000,000,000 observations of 12 variables\) needs about 1,920,000 MB/,
  });
});

test("Unicode variable names can be used in commands", () => {
  const s = using(fixture("uni.dta"));
  assert.equal(
    shown(s, "summarize größe"),
    block(`
    Variable |        Obs        Mean    Std. dev.       Min        Max
-------------+---------------------------------------------------------
       größe |          3           3         1.5        1.5        4.5
`),
  );
  shown(s, "generate y = größe*2");
  assert.equal(
    shown(s, "list"),
    block(`
     +---------------------+
     | größe   ñ_count   y |
     |---------------------|
  1. |   1.5         1   3 |
  2. |     3         2   6 |
  3. |   4.5         3   9 |
     +---------------------+
`),
  );
});

// The tests below use files saved by Stata 19 from simulated data:
// notes118.dta (and notes115.dta, by saveold, version(12)) hold notes 1 and
// 3 of _dta, note 2 having been dropped, two notes on income and
// characteristics; latin115.dta and latin117.dta (saveold, version(12) and
// version(13)) hold country names in Latin-1, as a file from Stata 13 or
// earlier on Windows does; binary118.dta holds a strL of the bytes 00 FF 7A
// in observation 6; havenstrl119.dta was written by R's haven
// (write_dta(..., version = 15)), which gives a format-119 file 118-style
// strL references. The expected text is what Stata 19 printed for the same
// commands.

// Text here keeps each byte that is not UTF-8 as a code unit U+DC80 to
// U+DCFF, and shows it as U+FFFD, where Stata's log has the raw byte.
const raw = (b) => String.fromCharCode(0xdc00 + b),
  REPLACEMENT = String.fromCharCode(0xfffd);

test("notes keep their numbers: a gap left by notes drop stays a gap", () => {
  for (const name of ["notes118.dta", "notes115.dta"]) {
    const s = using(fixture(name));
    assert.equal(
      shown(s, "notes"),
      block(`
_dta:
  1.  First note
  3.  Third note

income:
  1.  inc A
  2.  inc B
`),
    );
    assert.equal(
      shown(s, "char list"),
      block(`
  _dta[note1]:                First note
  _dta[note0]:                3
  _dta[note3]:                Third note
  _dta[author]:               Instructor
  income[note1]:              inc A
  income[note0]:              2
  income[note2]:              inc B
  income[source]:             IRS
  income[unit]:               USD
`),
    );
    assert.equal(shown(s, `display "[\`: char _dta[note0]']"`), "[3]");
    assert.equal(
      shown(s, `display "[\`: char _dta[]']"`),
      "[note1 note0 note3 author]",
    );
  }
  // note0 says how far the notes go: note5 is past it; with note1 deleted
  // only note 3 is left.
  const s = using(fixture("notes118.dta"));
  shown(s, 'char _dta[note5] "manual five"');
  assert.equal(
    shown(s, "notes _dta"),
    "_dta:\n  1.  First note\n  3.  Third note",
  );
  shown(s, "char _dta[note1]");
  assert.equal(shown(s, "notes _dta"), "_dta:\n  3.  Third note");
  // Written back, the notes keep their numbers: Stata 19 read the export
  // and listed notes 1 and 3, with note0 3.
  const back = readDta(using(fixture("notes118.dta")).exportData().bytes);
  assert.deepEqual(
    ["note0", "note1", "note2", "note3"].map((k) =>
      back.chars.get("_dta").get(k),
    ),
    ["3", "First note", undefined, "Third note"],
  );
});

test("notes subcommands work on a file's notes", () => {
  const s = using(fixture("notes118.dta"));
  assert.equal(shown(s, "notes drop income in 1"), "  (1 note dropped)");
  assert.equal(shown(s, "notes _dta: Added later"), "");
  assert.equal(
    shown(s, "notes list _dta in 2/4"),
    "_dta:\n  3.  Third note\n  4.  Added later",
  );
  assert.equal(
    shown(s, "notes replace _dta in 1 : Replaced first"),
    "  (note 1 for _dta replaced)",
  );
  assert.equal(shown(s, "notes search Third"), "_dta:\n  3.  Third note");
  assert.equal(shown(s, "notes renumber _dta"), "");
  assert.equal(
    shown(s, "notes"),
    block(`
_dta:
  1.  Replaced first
  2.  Third note
  3.  Added later

income:
  2.  inc B
`),
  );
  assert.equal(
    shown(s, "char list _dta[]"),
    block(`
  _dta[note3]:                Added later
  _dta[note2]:                Third note
  _dta[note1]:                Replaced first
  _dta[note0]:                3
  _dta[author]:               Instructor
`),
  );
});

test("collapse keeps the dataset's notes; drop _all clears them", () => {
  let s = using(fixture("notes118.dta"));
  shown(s, "collapse (mean) income, by(id)");
  assert.equal(shown(s, "notes"), "_dta:\n  1.  First note\n  3.  Third note");
  assert.equal(
    shown(s, "char list"),
    block(`
  _dta[note1]:                First note
  _dta[note0]:                3
  _dta[note3]:                Third note
  _dta[author]:               Instructor
`),
  );
  s = using(fixture("notes118.dta"));
  shown(s, "drop _all");
  assert.equal(shown(s, "notes"), "");
  assert.equal(shown(s, "char list"), "");
});

test("locals typed one command at a time are kept, as in Stata's Command window", () => {
  const s = using(fixture("notes118.dta"));
  shown(s, "local u : char income[unit]");
  shown(s, "local v : char _dta[author]");
  shown(s, "local z : char income[]");
  assert.equal(shown(s, `display "[\`u'] [\`v']"`), "[USD] [Instructor]");
  assert.equal(shown(s, `display "[\`z']"`), "[note1 note0 note2 source unit]");
  // A do-file has locals of its own.
  assert.equal(
    s.run(`display "[\`u']"`, { doFile: true }).output[0].lines.join(),
    "[]",
  );
});

test("text from Stata 13 and earlier keeps its bytes (Latin-1, say)", () => {
  for (const name of ["latin115.dta", "latin117.dta"]) {
    const s = using(fixture(name));
    shown(
      s,
      "gen n = strlen(country)\ngen c3 = substr(country, 1, 3)\ngen n3 = strlen(c3)\ngen u = ustrlen(country)",
    );
    assert.equal(
      shown(s, "list n c3 n3 u"),
      block(`
     +--------------------+
     |  n    c3   n3    u |
     |--------------------|
  1. | 13   C${REPLACEMENT}t    3   13 |
  2. |  6   Esp    3    6 |
  3. |  4   Cha    3    4 |
     +--------------------+
`),
    );
    assert.equal(shown(s, 'count if country == "Chad"'), "  1");
    // Written back, the byte F4 (ô in Latin-1) is still F4: Stata 19 read
    // the export and gave tobytes(country[1]) = \d067\d244\d116...
    const back = readDta(s.exportData().bytes),
      country = back.variables.find((v) => v.name === "country");
    assert.equal(country.data[0], `C${raw(0xf4)}te d'Ivoire`);
    assert.equal(
      back.variables.find((v) => v.name === "c3").data[0],
      `C${raw(0xf4)}t`,
    );
    const bytes = s.exportData().bytes;
    assert.ok(
      Buffer.from(bytes).includes(Buffer.from([0x43, 0xf4, 0x74, 0x65])),
    );
  }
});

test("a binary strL keeps its bytes and shows a null byte as \\0", () => {
  const s = using(fixture("binary118.dta"));
  shown(s, "gen la = strlen(a)");
  assert.equal(
    shown(s, "list id la if id >= 5"),
    block(`
     +---------+
     | id   la |
     |---------|
  5. |  5   20 |
  6. |  6    3 |
  7. |  7    0 |
  8. |  8    0 |
     +---------+
`),
  );
  assert.equal(
    shown(s, "list id a if id == 6"),
    block(`
     +-----------+
     | id      a |
     |-----------|
  6. |  6   \\0${REPLACEMENT}z |
     +-----------+
`),
  );
  // The fixture strl118.dta holds \0, \1 and abc in observation 5.
  assert.equal(
    shown(using(fixture("strl118.dta")), "tabulate essay in 5/6"),
    block(`
         essay |      Freq.     Percent        Cum.
---------------+-----------------------------------
        \\0\u0001abc |          1       50.00       50.00
Short answer 2 |          1       50.00      100.00
---------------+-----------------------------------
         Total |          2      100.00
`),
  );
  const bytes = Buffer.from(s.exportData().bytes),
    at = bytes.indexOf(Buffer.from([0, 0xff, 0x7a]));
  assert.ok(at > bytes.indexOf("<strls>"));
});

test("a strL reference with no text, or a strL with an invalid header, is refused", () => {
  // Stata 19: ".dta file corrupt ... attempt to crosslink a strl to
  // observation or variable 0", r(688).
  assert.throws(() => readDta(fixture("havenstrl119.dta")), {
    code: 688,
    message: /strL.*observation or variable 0/,
  });
  // The first text said to belong to observation 1,001 of 8: Stata 19
  // gives ".dta file corrupt / GSO header invalid.", r(612).
  const broken = fixture("binary118.dta"),
    at = Buffer.from(broken).indexOf("<strls>GSO") + 7,
    view = new DataView(broken.buffer, broken.byteOffset);
  view.setBigUint64(at + 7, view.getBigUint64(at + 7, true) + 1000n, true);
  assert.throws(() => readDta(broken), { code: 612 });
});

test("bytes after the value labels of a format 113 to 115 file are passed over", () => {
  const original = fixture("latin115.dta"),
    labels = (bytes) => shown(using(bytes), "label list");
  // Stata 19 loads the file with 16 zero bytes or a newline appended as it
  // loads the file itself.
  for (const extra of [new Uint8Array(16), Uint8Array.of(10)]) {
    const padded = new Uint8Array(original.length + extra.length);
    padded.set(original);
    padded.set(extra, original.length);
    assert.equal(labels(padded), labels(original));
  }
  // Cut 3 bytes short, the last label keeps what is left, as in Stata 19.
  assert.equal(
    labels(original.subarray(0, original.length - 3)),
    `yl:\n           1 ${REPLACEMENT}le`,
  );
});

test("more than 32,767 variables are written as format 119", () => {
  // Stata 19 read such an export of a 33,001-variable file and listed it
  // as it listed the file itself.
  const k = 33001,
    variables = Array.from({ length: k }, (_, j) => ({
      name: `v${j + 1}`,
      type: j === k - 1 ? "strL" : "byte",
      format: j === k - 1 ? "%9s" : "%8.0g",
      label: "",
      valueLabel: "",
      data: j === k - 1 ? ["row 1", "q".repeat(2500)] : [j % 100, 1],
    })),
    bytes = writeDta({
      n: 2,
      variables,
      sortedBy: ["v3", "v2"],
      label: "",
      valueLabels: new Map(),
      chars: new Map(),
    });
  assert.match(
    new TextDecoder().decode(bytes.subarray(0, 60)),
    /<release>119</,
  );
  const back = readDta(bytes);
  assert.equal(back.variables.length, k);
  assert.deepEqual(back.sortedBy, ["v3", "v2"]);
  assert.deepEqual([...back.variables[32999].data], [99, 1]);
  assert.deepEqual(back.variables[k - 1].data, ["row 1", "q".repeat(2500)]);
});

test("names may hold any character outside ASCII after the first", () => {
  const s = createConsoleSession();
  shown(
    s,
    "set obs 4\ngen co₂ = _n*400 + mod(_n,2)\ngen temp°c = 20+_n\ngen r² = _n/10\ngen a·b = 1\ngen a😀 = 1",
  );
  assert.equal(
    shown(s, "summarize co₂ temp°c r²"),
    block(`
    Variable |        Obs        Mean    Std. dev.       Min        Max
-------------+---------------------------------------------------------
         co₂ |          4      1000.5    516.1398        401       1600
      temp°c |          4        22.5    1.290994         21         24
          r² |          4         .25    .1290994         .1         .4
`),
  );
  assert.equal(s.run("gen ½a = 1").output[0].lines[0], "½a invalid name");
  assert.equal(shown(s, "notes co₂: ppm\nnotes co₂"), "co₂:\n  1.  ppm");
});
