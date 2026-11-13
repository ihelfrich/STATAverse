import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inflateRawSync } from "node:zlib";
import { createConsoleSession } from "../src/console-session.js";
import { Dataset } from "../src/runtime/store.js";
import { MISSING } from "../src/runtime/values.js";
import { readDta, writeDta } from "../src/console-dta.js";
import { crc32, zip } from "../src/console-zip.js";
import { localise, projectZip } from "../src/console-project.js";
import { build, doName, files } from "../src/console-map-model.js";

const fixture = (name) =>
  new Uint8Array(
    fs.readFileSync(new URL(`./fixtures/dta/${name}`, import.meta.url)),
  );
/** The entries of a stored zip: name -> bytes. */
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out = new Map();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true),
      crc = view.getUint32(at + 14, true),
      size = view.getUint32(at + 18, true),
      nameLength = view.getUint16(at + 26, true),
      name = new TextDecoder().decode(
        bytes.subarray(at + 30, at + 30 + nameLength),
      ),
      start = at + 30 + nameLength + view.getUint16(at + 28, true),
      raw = bytes.subarray(start, start + size),
      data = method ? new Uint8Array(inflateRawSync(raw)) : raw;
    assert.equal(crc32(data), crc, `${name}: checksum`);
    out.set(name, data);
    at = start + size;
  }
  assert.equal(view.getUint32(at, true), 0x02014b50, "central directory");
  return out;
}

// These two files were written by installed Stata: the same three rows as
// format 118 (save) and format 117 (saveold, version(13)).
for (const name of ["fromstata118.dta", "fromstata117.dta"])
  test(`a .dta file written by Stata is read as Stata describes it: ${name}`, () => {
    const data = readDta(fixture(name)),
      by = Object.fromEntries(data.variables.map((v) => [v.name, v]));
    assert.equal(data.n, 3);
    assert.equal(data.label, "From Stata");
    assert.deepEqual(data.sortedBy, ["i"]);
    assert.deepEqual(
      data.variables.map((v) => [v.name, v.type, v.format]),
      [
        ["b", "byte", "%8.0g"],
        ["i", "int", "%8.0g"],
        ["l", "long", "%12.0g"],
        ["f", "float", "%9.0g"],
        ["d", "double", "%12.3f"],
        ["s", "str6", "%9s"],
        ["g", "byte", "%10.0g"],
      ],
    );
    assert.equal(by.d.label, "A double, with a long label");
    assert.equal(by.g.valueLabel, "g");
    assert.deepEqual(
      [...data.valueLabels.get("g")],
      [
        [-5, "minus five"],
        [1, "one"],
      ],
    );
    // Sorted by i: the row of -300, the row of 100, then the missing row.
    assert.deepEqual([...by.i.data.slice(0, 2)], [-300, 100]);
    assert.deepEqual(by.s.data, ["é ü", "apple", ""]);
    assert.deepEqual([...by.d.data.slice(0, 2)], [1e300, 3.25]);
    assert.deepEqual([...by.f.data.slice(0, 2)], [-2.5, 1.5]);
    // Each kind of missing value keeps its letter: .a . .b .c .z
    const step = 2 ** 1011;
    assert.equal(by.b.data[2], MISSING + step);
    assert.equal(by.i.data[2], MISSING);
    assert.equal(by.l.data[2], MISSING + 2 * step);
    assert.equal(by.f.data[2], MISSING + 3 * step);
    assert.equal(by.d.data[2], MISSING + 26 * step);
  });

test("a dataset written as .dta reads back the same", () => {
  const session = createConsoleSession();
  session.run(
    'sysuse labor, clear\ngenerate float half = wage / 3\ngenerate long big = id * 100000\nreplace half = .c in 3\nreplace education = .a in 4\nlabel define yn 0 "No" 1 "Yes, a member"\nlabel values union yn\nsort region id',
  );
  const { bytes } = session.exportData(),
    back = readDta(bytes),
    again = readDta(writeDta(back));
  assert.equal(back.n, 600);
  assert.deepEqual(back.sortedBy, ["region", "id"]);
  assert.deepEqual(
    [...back.valueLabels.get("yn")],
    [
      [0, "No"],
      [1, "Yes, a member"],
    ],
  );
  for (const [k, v] of back.variables.entries()) {
    assert.deepEqual(
      [v.name, v.type, v.format, v.label, v.valueLabel],
      ["name", "type", "format", "label", "valueLabel"].map(
        (key) => again.variables[k][key],
      ),
    );
    assert.deepEqual(v.data, again.variables[k].data, v.name);
  }
  // Added to a session, it is there for use.
  const other = createConsoleSession();
  assert.deepEqual(
    { rows: 600, variables: 13 },
    (({ rows, variables }) => ({ rows, variables }))(
      other.addData("workers.dta", bytes),
    ),
  );
  const result = other.run(
    'use "workers.dta", clear\nquietly count if half == .c\nassert r(N) == 1\nquietly count if education == .a\nassert r(N) == 1\nquietly summarize wage\nassert r(N) == 586\ndescribe union',
  );
  assert.equal(result.rc, 0, result.output.at(-1).lines.join(" "));
  assert.match(result.output.at(-1).lines.join("\n"), /yn\s+In a union/);
});

test("files that are not a readable .dta are refused with a reason", () => {
  const bytes = (text) => new TextEncoder().encode(text);
  assert.throws(
    () => readDta(bytes("not a dataset")),
    /not a Stata \.dta file/,
  );
  // Formats 105 to 115 are read; a header cut short is damaged, and the
  // formats of Stata 4 and earlier are refused.
  assert.throws(
    () => readDta(new Uint8Array([114, 2, 1, 0, 9, 0, 0, 0])),
    /damaged or cut short/,
  );
  assert.throws(
    () => readDta(new Uint8Array([104, 2, 1, 0, 9, 0, 0, 0])),
    /Stata 4 or earlier/,
  );
  assert.throws(
    () => readDta(bytes("<stata_dta><header><release>121</release>")),
    /format 121 is not read here/,
  );
  // A file cut short is damaged, not a crash.
  assert.throws(() => readDta(fixture("fromstata118.dta").slice(0, 400)));
});

test("a zip written here is one any unzip program reads", () => {
  const made = zip(
      [
        { name: "a.do", data: "display 1\n" },
        { name: "data/é.bin", data: new Uint8Array([0, 255, 7]) },
        { name: "empty.txt", data: "" },
      ],
      new Date(2026, 10, 11, 9, 30, 0),
    ),
    back = unzip(made);
  assert.deepEqual([...back.keys()], ["a.do", "data/é.bin", "empty.txt"]);
  assert.equal(new TextDecoder().decode(back.get("a.do")), "display 1\n");
  assert.deepEqual([...back.get("data/é.bin")], [0, 255, 7]);
  // The end record counts the entries and points at the directory.
  const end = new DataView(made.buffer, made.length - 22);
  assert.equal(end.getUint32(0, true), 0x06054b50);
  assert.equal(end.getUint16(10, true), 3);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("a downloaded project uses the data folder in place of sysuse", () => {
  const used = new Set();
  assert.equal(
    localise(
      '  sysuse labor, clear\nsysuse "study.dta"\nsysuse auto, clear\n* sysuse labor\ndisplay "sysuse labor"',
      used,
    ),
    '  use "data/labor.dta", clear\nuse "data/study.dta"\nsysuse auto, clear\n* sysuse labor\ndisplay "sysuse labor"',
  );
  assert.deepEqual([...used], ["labor", "study"]);

  const back = unzip(
      projectZip(
        [
          { name: "main.do", text: 'sysuse trade, clear\ndo "more.do"\n' },
          {
            name: "more.do",
            text: 'import delimited using "mine.csv", clear\n',
          },
        ],
        [
          { name: "mine.csv", data: "a,b\n1,2\n" },
          { name: "unused.csv", data: "x\n1\n" },
        ],
      ),
    ),
    text = (name) => new TextDecoder().decode(back.get(name));
  assert.deepEqual(
    [...back.keys()],
    [
      "stata-project/main.do",
      "stata-project/more.do",
      "stata-project/data/trade.dta",
      "stata-project/mine.csv",
      "stata-project/README.txt",
    ],
  );
  assert.equal(
    text("stata-project/main.do"),
    'use "data/trade.dta", clear\r\ndo "more.do"\r\n',
  );
  assert.match(text("stata-project/README.txt"), /do main\.do/);
  // The dataset in the folder is the one sysuse loads here.
  const trade = readDta(back.get("stata-project/data/trade.dta")),
    data = new Dataset();
  data.restore({ defaultType: "float", ...trade });
  assert.equal(data.n, 240);
  assert.equal(trade.variables[2].label, "Exports (millions)");
});

test("a map with Start a do-file steps writes several files that run together", () => {
  const map = build([
      "data",
      { dataset: "labor" },
      [
        "generate",
        { name: "lwage", expression: "ln(wage)" },
        [
          "file",
          { name: "describe it" },
          ["look", { how: "summarize", variables: "lwage" }],
        ],
        [
          "file",
          { name: "models" },
          [
            "keep",
            { condition: "female == 1" },
            [
              "model",
              { command: "regress", outcome: "lwage", predictors: "education" },
            ],
          ],
          [
            "model",
            { command: "regress", outcome: "lwage", predictors: "education" },
          ],
        ],
        ["file", { name: "models" }],
        ["file", {}],
      ],
    ]),
    written = files(map),
    text = (file) => file.lines.map((line) => line.text).join("\n");
  assert.deepEqual(
    written.map((file) => file.name),
    ["main.do", "describe_it.do", "models.do", "models_2.do"],
  );
  assert.equal(
    text(written[0]),
    'sysuse labor, clear\ngenerate lwage = ln(wage)\ndo "describe_it.do"\npreserve\ndo "models.do"\nrestore\ndo "models_2.do"\n* (the step "Start a do-file" is not filled in)',
  );
  assert.equal(
    text(written[2]),
    // Inside the preserved branch a second copy is kept in a file, because
    // Stata holds one preserved copy at a time.
    'save "_branch_6", replace\nkeep if female == 1\nregress lwage education\nuse "_branch_6", clear\nregress lwage education',
  );
  // Every line knows the step that wrote it.
  assert.ok(written.every((file) => file.lines.every((line) => line.step > 0)));
  const session = createConsoleSession();
  for (const file of written) session.addFile(file.name, text(file) + "\n");
  const result = session.run("do main.do");
  assert.equal(result.rc, 0, result.output.at(-1).lines.join(" "));
  assert.equal(result.memory.observations, 600);
  assert.equal(doName("My File!.do"), "My_File.do");
  assert.equal(doName("  "), "part.do");
});

test("a dataset choice that is one of the student's files loads it by its kind", () => {
  const line = (dataset) =>
    files(build(["data", { dataset }]))[0].lines[0].text;
  assert.equal(
    line("file:my wages.csv"),
    'import delimited using "my wages.csv", clear',
  );
  assert.equal(line("file:Panel.DTA"), 'use "Panel.DTA", clear');
  assert.equal(line("labor"), "sysuse labor, clear");
  assert.equal(line(""), "clear");
});
