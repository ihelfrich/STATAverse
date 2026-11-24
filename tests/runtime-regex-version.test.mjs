// regexm(), regexr() and regexs() read a pattern as the session's version
// says: Stata 18 and later (the default, as in Stata 19 with no version
// set) use a Perl-style library, version 17 and before Spencer's. The
// printed results are recorded from installed Stata in the
// expr-regex-modern-* cases of tools/output-cases.txt; these tests hold the
// pieces that the record does not show.
import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";

const shown = (session, source) =>
  session.run(source, { doFile: true }).output.at(-1).lines.join("\n").trim();

test("the vice-chair screen a student might write reads as Stata 19 reads it", () => {
  const session = createConsoleSession();
  session.run(
    `clear
set obs 5
gen title = ""
replace title = "vice chairman & ceo" in 1
replace title = "vice-chairman, president & ceo" in 2
replace title = "chairman & ceo" in 3
replace title = "vice  -  chair" in 4
replace title = "president" in 5`,
    { doFile: true },
  );
  for (const pattern of [
    "vice\\s*-?\\s*chair",
    "vice[\\s-]*chair",
    "vice\\W*chair",
    "\\bvice\\b",
  ])
    assert.equal(
      shown(session, `count if regexm(title, "${pattern}")`),
      "3",
      pattern,
    );
  assert.equal(shown(session, 'count if regexm(title, "(?i)VICE")'), "3");
  assert.equal(shown(session, 'count if regexm(title, "\\bchair")'), "4");
  // Under version 17 the same patterns are Spencer's: \s is s, \b is b.
  session.run("version 17");
  assert.equal(
    shown(session, 'count if regexm(title, "vice\\s*-?\\s*chair")'),
    "1",
  );
});

test("a version statement in a do-file ends with it; a version prefix with its command", () => {
  const session = createConsoleSession();
  session.addFile("old.do", 'version 17\ndisplay regexm("a1", "\\d")\n');
  const out = session.run('do old.do\ndisplay regexm("a1", "\\d")', {
    doFile: true,
  });
  const lines = out.output.flatMap((o) => o.lines).map((l) => l.trim());
  assert.ok(lines.includes("0"), lines.join("|"));
  assert.equal(lines.at(-1), "1");
  assert.equal(shown(session, 'version 17: display regexm("a1", "\\d")'), "0");
  assert.equal(shown(session, 'display regexm("a1", "\\d")'), "1");
  assert.equal(shown(session, "display c(version)"), "17");
});

test("a pattern Stata cannot read matches nothing, silently, in every row", () => {
  const session = createConsoleSession();
  const out = session.run(
    'clear\nset obs 3\ngen s = "a"\ncount if regexm(s, "a(")',
    { doFile: true },
  );
  assert.equal(out.rc, 0);
  assert.deepEqual(
    out.output.at(-1).lines.map((l) => l.trim()),
    ["0"],
  );
});

test("what the browser cannot read as Stata does is refused, not answered", () => {
  const session = createConsoleSession();
  for (const pattern of ["a++", "(?>a)b", "\\p{L}", "a(?i)b", "\\h"]) {
    const out = session.run(`display regexm("aab", "${pattern}")`);
    assert.equal(out.rc, 198, pattern);
    assert.match(
      out.output.at(-1).lines.join(" "),
      /cannot read as Stata does/,
    );
  }
});

test("bytes, not letters: . is one byte of a UTF-8 letter", () => {
  const session = createConsoleSession();
  assert.equal(
    shown(
      session,
      'display regexm("é", "^.$") regexm("é", "^..$") regexr("ééa", "(é+)a", "x")',
    ),
    "01éx",
  );
});
