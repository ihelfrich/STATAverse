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
  const back = readDta(s.exportData().bytes);
  assert.deepEqual(
    [...back.notes],
    [
      ["_dta", ["Simulated for testing", "Second dataset note"]],
      ["income", ["Top-coded at 1,000,000"]],
      ["wage", ["Measured hourly"]],
    ],
  );
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
  assert.deepEqual([...after.notes.keys()], ["_dta", "earnings"]);
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
