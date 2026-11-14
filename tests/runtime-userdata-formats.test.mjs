// Display formats, list layout, codebook and summarize on a student's own
// .dta file: datetime (%tc, %tC) and custom date formats, %21x and the
// binary formats, a left-justified %-18s string, CJK and accented text, a
// long strL, and summarize, format. The file holds simulated data written
// by Stata 19, and the expected text was recorded from Stata 19 MP
// (version 17, set processors 1, set linesize 80) on the same file; see
// tests/fixtures/userdata/formats-expected.json. The return codes below were
// recorded from the same Stata; refusals are the browser's own.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";

const fixture = (name) =>
  new URL(`./fixtures/userdata/${name}`, import.meta.url);
const expected = JSON.parse(
  fs.readFileSync(fixture("formats-expected.json"), "utf8"),
);
const lines = (out) => {
  const all = out.output
    .flatMap((o) => o.lines ?? [])
    .flatMap((line) => line.split("\n"))
    .map((line) => line.replace(/\s+$/, ""));
  while (all.length && !all[0]) all.shift();
  while (all.length && !all.at(-1)) all.pop();
  return all;
};
function session() {
  const s = createConsoleSession();
  s.addData(
    "formats.dta",
    new Uint8Array(fs.readFileSync(fixture("formats.dta"))),
  );
  assert.equal(s.run("set linesize 80").rc, 0);
  assert.equal(s.run("use formats.dta, clear").rc, 0);
  return s;
}

test("a .dta file with %tc, %td, %-18s, CJK and strL variables lists, displays and summarizes as in Stata 19", () => {
  const s = session();
  for (const { command, lines: want } of expected.cases) {
    const out = s.run(command);
    assert.equal(out.rc, 0, command);
    assert.deepEqual(lines(out), want, command);
  }
});

test("clock() reads timestamp strings to the millisecond and %tc shows them", () => {
  const s = createConsoleSession();
  s.run(
    'clear\nset obs 2\ngenerate str19 t = "2024-03-15 13:45:00" in 1\nreplace t = "2023-12-01 08:00:00" in 2\ngenerate double tt = clock(t, "YMDhms")\nformat tt %tc\ngenerate d = dofc(tt)\nformat d %td',
  );
  // Stata 19: 2026129500000 and 2017036800000; 15mar2024, 01dec2023.
  assert.deepEqual(lines(s.run("display %15.0f tt[1] _n %15.0f tt[2]")), [
    "  2026129500000",
    "  2017036800000",
  ]);
  assert.deepEqual(lines(s.run("list")), [
    "     +------------------------------------------------------+",
    "     |                   t                   tt           d |",
    "     |------------------------------------------------------|",
    "  1. | 2024-03-15 13:45:00   15mar2024 13:45:00   15mar2024 |",
    "  2. | 2023-12-01 08:00:00   01dec2023 08:00:00   01dec2023 |",
    "     +------------------------------------------------------+",
  ]);
  // Stata 19: Clock() counts the 27 leap seconds since 1972.
  assert.deepEqual(
    lines(
      s.run('display %15.0f Clock("2024-03-15 13:45:00", "YMDhms") - tt[1]'),
    ),
    ["          27000"],
  );
});

test("unavailable list options and business calendars are refused, not ignored", () => {
  const s = session();
  for (const command of [
    "list id, header(2)",
    "list id, fast",
    "list id, nocompress",
    "list id, mean",
    "format bday %tbsimple",
    'display bofd("simple", bday[1])',
  ]) {
    const out = s.run(command);
    assert.equal(out.rc, 198, command);
  }
  // Stata 19: "may not specify both -clean- and -display- options", r(198).
  const both = s.run("list id, clean display");
  assert.equal(both.rc, 198);
  assert.match(lines(both)[0], /may not specify both -clean- and -display-/);
  // Stata 19: an invalid datetime literal is r(198); %20tc is r(120).
  assert.equal(s.run("display tc(01jan2001)").rc, 198);
  assert.equal(s.run("display %20tc 0").rc, 120);
});

// A survey-style file with a value label longer than 100 characters (Stata
// widens the variable's format to %109.0g when it is attached), a %21x
// variable with missing values, and strings with a combining accent,
// halfwidth katakana and a leading U+FEFF. longlabels.dta was written by
// Stata 19 from simulated data; longlabels-expected.json holds what Stata 19
// MP printed for each command (version 17, set processors 1, linesize 80).
test("a .dta file with a 109-character value label, %21x missing values and U+FEFF lists as in Stata 19", () => {
  const recorded = JSON.parse(
      fs.readFileSync(fixture("longlabels-expected.json"), "utf8"),
    ),
    s = createConsoleSession();
  s.addData(
    "longlabels.dta",
    new Uint8Array(fs.readFileSync(fixture("longlabels.dta"))),
  );
  assert.equal(s.run("set linesize 80").rc, 0);
  assert.equal(s.run("use longlabels.dta, clear").rc, 0);
  for (const { command, lines: want } of recorded.cases) {
    const out = s.run(command);
    assert.equal(out.rc, 0, command);
    assert.deepEqual(lines(out), want, command);
  }
});

test("label values widens a numeric format to its longest label, as Stata 19 does", () => {
  const s = createConsoleSession();
  s.run(
    'clear\nset obs 2\ngenerate byte a = 1\ngenerate double c = 1.5\nformat c %-5.2f\ngenerate d = 1\nformat d %td\nlabel define l20 1 "abcdefghijklmnopqrst"\nlabel values a c d l20',
  );
  // Stata 19: %20.0g, %20.2f (the - is dropped) and %td unchanged.
  const formats = () =>
    lines(s.run("describe a c d"))
      .slice(-3)
      .map((line) => line.split(/\s+/)[2]);
  assert.deepEqual(formats(), ["%20.0g", "%20.2f", "%td"]);
  // A longer text added later widens it again; a label in CJK counts bytes.
  s.run('label define l20 2 "日本日本日本日本日本日本", add');
  assert.deepEqual(formats(), ["%36.0g", "%36.2f", "%td"]);
  // A %111.0g format no longer throws a RangeError in list or display.
  s.run("format c %111.0g");
  const out = s.run("list c, nolabel");
  assert.equal(out.rc, 0);
  assert.deepEqual(lines(out), [
    "     +-----+",
    "     |   c |",
    "     |-----|",
    "  1. | 1.5 |",
    "  2. | 1.5 |",
    "     +-----+",
  ]);
  // Stata 19: display %111.0g 1.5 is 1.5 right-aligned in 111 columns.
  assert.deepEqual(lines(s.run("display %111.0g 1.5")), [
    " ".repeat(108) + "1.5",
  ]);
});

test("import delimited text with decomposed accents and halfwidth katakana lists in Stata 19's columns", () => {
  const s = createConsoleSession();
  s.addFile(
    "names.csv",
    `id,name\n1,${"Zoë Nuñez".normalize("NFD")}\n2,ｱｲｳ ｴｵ\n3,Plain name\n4,가x\n5,😀ab\n`,
  );
  assert.equal(s.run("set linesize 80").rc, 0);
  assert.equal(s.run("import delimited using names.csv, clear").rc, 0);
  // Recorded from Stata 19: a combining mark and a Hangul jamo take a
  // column, halfwidth katakana and an emoji two.
  assert.deepEqual(lines(s.run("list")), [
    "     +------------------+",
    "     | id          name |",
    "     |------------------|",
    `  1. |  1   ${"Zoë Nuñez".normalize("NFD")} |`,
    "  2. |  2   ｱｲｳ ｴｵ |",
    "  3. |  3    Plain name |",
    "  4. |  4           가x |",
    "  5. |  5          😀ab |",
    "     +------------------+",
  ]);
  assert.deepEqual(lines(s.run("list name, string(4)")), [
    "     +--------+",
    "     | name   |",
    "     |--------|",
    `  1. | ${"Zoë".normalize("NFD")}.. |`,
    "  2. | ｱｲ.. |",
    "  3. | Plai.. |",
    "  4. | 가x    |",
    "  5. | 😀ab   |",
    "     +--------+",
  ]);
});
