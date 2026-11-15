// The files group of the recheck: what save, use, append, merge, cd and
// import delimited do with the session's folder, where the text cannot be
// recorded by tools/check-output-native.mjs (a tempfile's name and the
// working folder are Stata's own paths there) or where a runtime hint goes
// with Stata's message. Expected text was recorded from Stata 19 MP
// (version 17, set processors 1, linesize 79) on the same commands, with
// simulated data.
import test from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/runtime/session.js";
import { StataError } from "../src/runtime/errors.js";
import { createConsoleSession } from "../src/console-session.js";
import { detectCharset } from "../src/runtime/charset.js";

const run = (source) => {
  const session = new Session();
  session.run("set linesize 79");
  const result = session.run(source);
  return { session, result };
};
const printed = (result, command) =>
  result.output
    .find((o) => o.command === command)
    ?.lines.flatMap((line) => String(line).split("\n"));
/** The StataError one command throws, run on its own. */
const thrown = (session, text) => {
  try {
    session.dispatch(text, session.frame(), {}, [], []);
  } catch (error) {
    if (error instanceof StataError) return error;
    throw error;
  }
  assert.fail(`${text} did not stop`);
};

test("tempfile names a file with an extension of its own, counted apart from tempvar", () => {
  // Stata 19: tempvar a / tempfile f g / tempname n gives __000000 and
  // __000001 for a and n, and .../St<pid>.000001 and .000002 for f and g;
  // save `f' says "file .../St<pid>.000001 saved as .dta format".
  const { session, result } = run(`clear
set obs 2
generate x = _n
tempvar a
tempfile f g
tempname n
display "\`a' \`n'"
display "\`f'"
display "\`g'"
save \`f'
save \`f', replace
use \`f', clear
capture noisily save \`f'`);
  assert.equal(result.rc, 0);
  assert.deepEqual(printed(result, "display \"`a' `n'\""), [
    "__000000 __000001",
  ]);
  const [f] = printed(result, 'display "`f\'"'),
    [g] = printed(result, 'display "`g\'"');
  assert.match(f, /\/St\d+\.000001$/);
  assert.match(g, /\/St\d+\.000002$/);
  assert.deepEqual(printed(result, "save `f'"), [
    `file ${f} saved as .dta format`,
  ]);
  assert.deepEqual(printed(result, "save `f', replace"), [
    `file ${f} saved as .dta format`,
  ]);
  assert.deepEqual(printed(result, "capture noisily save `f'"), [
    `file ${f} already exists`,
  ]);
  assert.equal(session.data.n, 2);
});

test("use of a file that is not a dataset gives Stata's message and leaves no data", () => {
  // Stata 19: use extra.csv, clear -> "file extra.csv not Stata format"
  // r(610), and _N is 0 afterwards; use nosuch, clear keeps the data.
  const { session, result } = run(`clear
set obs 2
generate id = _n
export delimited using rf.csv, replace
capture noisily use nosuch, clear
display _rc " " _N
capture noisily use rf.csv, clear
display _rc " " _N`);
  assert.equal(result.rc, 0);
  assert.deepEqual(printed(result, "capture noisily use rf.csv, clear"), [
    "file rf.csv not Stata format",
  ]);
  const shown = result.output
    .filter((o) => o.command.startsWith("display"))
    .map((o) => o.lines.join());
  assert.deepEqual(shown, ["601 2", "610 0"]);
  // The advice is the Console's hint, beside Stata's message.
  session.run("set obs 2\ngenerate id = _n");
  const error = thrown(session, "merge 1:1 id using rf.csv");
  assert.equal(error.message, "file rf.csv not Stata format");
  assert.equal(error.code, 610);
  assert.match(error.hint, /import delimited using rf\.csv/);
  // append.ado reports any file it cannot describe as not found.
  const appended = thrown(session, "append using rf.csv");
  assert.equal(appended.message, "file rf.csv not found");
  assert.equal(appended.code, 601);
  assert.match(appended.hint, /import delimited/);
});

test("cd changes only to the session's folder", () => {
  // Stata 19: cd "/Users/student/Dropbox/ECON400" -> "unable to change to
  // /Users/student/Dropbox/ECON400" r(170); cd . shows the folder.
  const { session, result } = run(`cd .
cd ./
capture noisily cd "/Users/student/Dropbox/ECON400"
display _rc
capture noisily cd a b
display _rc`);
  assert.deepEqual(printed(result, "cd ."), ["/stataverse"]);
  assert.deepEqual(printed(result, "cd ./"), ["/stataverse"]);
  assert.deepEqual(
    printed(result, 'capture noisily cd "/Users/student/Dropbox/ECON400"'),
    ["unable to change to /Users/student/Dropbox/ECON400"],
  );
  assert.deepEqual(
    result.output
      .filter((o) => o.command === "display _rc")
      .map((o) => o.lines.join()),
    ["170", "198"],
  );
  assert.match(thrown(session, 'cd "C:\\data"').hint, /one folder/);
});

test("import delimited reads a Stata dataset as the bytes of its file", () => {
  // Stata 19 reads people.dta as text: "Note:  1,670 binary zeros were
  // ignored in the source file. ..." and no error. The counts depend on the
  // bytes of the file, which here are those the browser writes.
  const { result } = run(`clear
set obs 3
generate id = _n
save rfdta, replace
import delimited using rfdta.dta, clear`);
  assert.equal(result.rc, 0);
  const lines = printed(result, "import delimited using rfdta.dta, clear");
  assert.match(lines.join(" "), /binary zeros were ignored in the source file/);
});

test("a 29-byte text file is named UTF-16LE, as Stata's scan names it, and can be added", () => {
  // Stata 19 on Alpha;Beta;Gamma / 1;2;x / 3;4;y (29 bytes): "(encoding
  // automatically selected: UTF-16LE)" and (1 var, 0 obs); 27, 28 and 31
  // bytes of the same text are not UTF-16LE.
  const text = "Alpha;Beta;Gamma\n1;2;x\n3;4;y\n",
    bytes = new TextEncoder().encode(text);
  assert.equal(bytes.length, 29);
  assert.equal(detectCharset(bytes), "UTF-16LE");
  for (const n of [27, 28])
    assert.notEqual(
      detectCharset(new TextEncoder().encode(text.slice(0, n - 1) + "\n")),
      "UTF-16LE",
    );
  assert.notEqual(
    detectCharset(new TextEncoder().encode(text + "5\n")),
    "UTF-16LE",
  );
  // UTF-16LE without a byte-order mark: 12 bytes are not named UTF-16LE
  // by Stata, 20 bytes are.
  const utf16 = (s) => {
    const out = new Uint8Array(s.length * 2);
    [...s].forEach((c, k) => (out[2 * k] = c.charCodeAt(0)));
    return out;
  };
  assert.notEqual(detectCharset(utf16("a;b\n1;2")), "UTF-16LE");
  assert.equal(detectCharset(utf16("ab;cd\n1;2\n")), "UTF-16LE");
  const console = createConsoleSession();
  console.addFile("semi.csv", bytes);
  const result = console.run("import delimited using semi.csv, clear");
  assert.equal(result.rc, 0);
  assert.deepEqual(result.output.at(-1).lines, [
    "(encoding automatically selected: UTF-16LE)",
    "(1 var, 0 obs)",
  ]);
});
