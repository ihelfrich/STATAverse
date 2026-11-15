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

test("a 29-byte do-file runs as the text it holds, though the scan names it UTF-16LE", () => {
  // Stata 19 reads a do-file as its bytes; only import delimited scans for
  // an encoding. do short.do and include short.do on these 29 bytes run
  // summarize, tab x and display 2+2, which shows 4.
  const bytes = new TextEncoder().encode("summarize\ntab x\ndisplay 2+2\n\n");
  assert.equal(bytes.length, 29);
  assert.equal(detectCharset(bytes), "UTF-16LE");
  const console = createConsoleSession();
  console.addFile("short.do", bytes);
  for (const command of ["do short.do", "run short.do", "include short.do"]) {
    const result = console.run(
      `clear\nset obs 2\ngenerate x = _n\n${command}`,
      { doFile: true },
    );
    assert.equal(result.rc, 0, command);
    // run shows nothing of what the file does.
    if (command === "run short.do") continue;
    assert.deepEqual(
      result.output.find((o) => o.command === "display 2+2")?.lines,
      ["4"],
    );
    assert.equal(
      result.output
        .find((o) => o.command === "summarize")
        ?.lines.filter(Boolean)
        .at(-1),
      "           x |          2         1.5    .7071068          1          2",
    );
  }
  // import delimited still reads the bytes as the scan names them.
  const imported = console.run("import delimited using short.do, clear");
  assert.equal(
    imported.output.at(-1).lines[0],
    "(encoding automatically selected: UTF-16LE)",
  );
});

test("bindquotes(loose) keeps the quotes of a field that does not start with one, a pair inside a quoted stretch as one", () => {
  // Stata 19, import delimited using q.csv, clear stringcols(_all), on
  // id,s,t rows whose s is as below (unmatched quotes run to the line end).
  const rows = [
      ['a""b', 'a""b'],
      ['a""""b', 'a"""b'],
      ['a"b"c', 'a"b"c'],
      ['a"b""c"d', 'a"b"c"d'],
      ['a"""b"""', 'a""b""'],
      ['ab"""', 'ab"",x'],
      ['a""""""b', 'a""""b'],
      ['a"""b', 'a""b,s'],
      ['ab""', 'ab""'],
      ['a"b,c"d', 'a"b,c"d'],
      ['a""""', 'a"""'],
      ['a" "" "', 'a" " "'],
    ],
    tails = ["x", "x", "x", "x", "x", "x", "x", "s", "w", "e", "x", "x"],
    text =
      "id,s,t\n" +
      rows.map(([raw], k) => `${k + 1},${raw},${tails[k]}\n`).join(""),
    console = createConsoleSession();
  console.addFile("q.csv", new TextEncoder().encode(text));
  const result = console.run(
    "import delimited using q.csv, clear stringcols(_all)",
  );
  assert.equal(result.rc, 0);
  // The values as list shows them, one to a row of its table.
  const values = [],
    listed = console.run("list s, noobs");
  for (const line of listed.output.at(-1).lines)
    if (/^ {2}\| /.test(line) && !/\| +s \|/.test(line))
      values.push(line.slice(4, -2).trim());
  assert.deepEqual(
    values,
    rows.map(([, read]) => read),
  );
});

test("tempfile numbers are used again once a program ends, and preserve uses one up", () => {
  // Stata 19: tempfile a b c gives .000001-.000003; a program's tempfile
  // q is .000004 each time it is called, and its file is erased when it
  // ends; after preserve and restore the next tempfile is one further on.
  const { session, result } = run(`clear
set obs 2
generate x = _n
tempfile a b c
program define r2fpp
tempfile q
display "\`q'"
save \`q'
end
r2fpp
r2fpp
preserve
restore
tempfile d
display "\`d'"`);
  assert.equal(result.rc, 0);
  const shown = result.output
    .filter(
      (o) => o.command.startsWith("r2fpp") || o.command.startsWith("display"),
    )
    .flatMap((o) => o.lines)
    .filter((line) => /St\d+\.\d+$/.test(line))
    .map((line) => line.slice(-6));
  assert.deepEqual(shown, ["000004", "000004", "000005"]);
  assert.ok(
    ![...session.files.keys()].some((name) => name.endsWith(".000004")),
  );
});

test("cd changes to a folder mkdir made and back with .., and pwd and c(pwd) follow", () => {
  // Stata 19 (in folder F): mkdir _s1 / cd _s1/ shows F/_s1, cd ../.. from
  // F/_s1/_in shows F, mkdir _s1 again is "could not create directory _s1"
  // r(693), cd _s1 from inside _s1 is r(170), and cd alone goes home.
  const { result } = run(`mkdir _s1
capture noisily mkdir _s1
display _rc
mkdir _s1/_in
capture noisily mkdir _nope/_in
display _rc
cd _s1/
pwd
cd _in
display c(pwd)
capture noisily cd _s1
display _rc
cd ../..
capture noisily cd ..
display _rc
cd _s1
cd
pwd`);
  assert.equal(result.rc, 0);
  const lines = result.output.flatMap((o) => o.lines);
  assert.deepEqual(lines, [
    "could not create directory _s1",
    "693",
    "could not create directory _nope/_in",
    "693",
    "/stataverse/_s1",
    "/stataverse/_s1",
    "/stataverse/_s1/_in",
    "/stataverse/_s1/_in",
    "unable to change to _s1",
    "170",
    "/stataverse",
    "unable to change to ..",
    "170",
    "/stataverse/_s1",
    "/stataverse",
    "/stataverse",
  ]);
});
