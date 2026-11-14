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
