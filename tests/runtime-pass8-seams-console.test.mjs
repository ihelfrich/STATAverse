// Where the eighth pass's groups met in the Console: how a do-file is echoed
// (comments, blank lines, /// and #delimit, as Stata's log keeps them),
// capture exit, lines in the error style, files the session writes, the
// changed-data flag the page asks with, hints that look at the command, and
// regress with many regressors. Results are Stata 19's, from batch runs with
// version 17 and set processors 1 on simulated data.
import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/runtime/commands.js";
import { splitCommands } from "../src/runtime/dofile.js";
import { adviseRecord } from "../src/console-hints.js";
import { createConsoleSession } from "../src/console-session.js";

/** A run laid out as Stata's log lays it out. */
function transcript(source) {
  const s = createConsoleSession(),
    ran = s.run(source, { doFile: true }),
    text = [];
  let tight = true;
  for (const record of ran.output) {
    if (!tight && text.at(-1) !== "") text.push("");
    text.push(`. ${record.command}`, ...(record.echo ?? []), ...record.lines);
    tight = !!record.comment;
  }
  return { rc: ran.rc, text, output: ran.output, session: s };
}

test("a do-file is echoed line by line as Stata 19 echoes it", () => {
  const { rc, text } = transcript(
    "display 1\n\n    display 2\n* one\n// two\ndisplay 3 // trailing\ndisplay 4 ///\n\t+ 1\n#delimit ;\ndisplay 5\n  + 1 ;\n#delimit cr\n* last\n",
  );
  assert.equal(rc, 0);
  // Stata 19's log, without its closing prompt and "end of do-file".
  assert.deepEqual(text, [
    ". display 1",
    "1",
    "",
    ". ",
    ".     display 2",
    "2",
    "",
    ". * one",
    ". // two",
    ". display 3 // trailing",
    "3",
    "",
    ". display 4 ///",
    ">         + 1",
    "5",
    "",
    ". #delimit ;",
    "delimiter now ;",
    ". display 5",
    ">   + 1 ;",
    "6",
    "",
    ". #delimit cr",
    "delimiter now cr",
    ". * last",
  ]);
});

test("block comments and * comments ending in /// echo and run as in Stata 19", () => {
  const { text } = transcript(
    "/* a /* b */ c */ display 5\n  * indented comment\n\tdisplay 6\n* star ///\n// not a continuation? ///\ndisplay 7\n/*\nmulti\n*/\ndisplay 8\n* a ///\n* b ///\ndisplay 9\ndisplay 10 /* open\n  still */ + 1\n",
  );
  assert.deepEqual(text, [
    ". /* a /* b */ c */ display 5",
    "5",
    "",
    ".   * indented comment",
    ".         display 6",
    "6",
    "",
    ". * star ///",
    "> // not a continuation? ///",
    ". display 7",
    "7",
    "",
    ". /*",
    "> multi",
    "> */",
    ". display 8",
    "8",
    "",
    // display 9 is part of the comment: Stata 19 does not run it.
    ". * a ///",
    "> * b ///",
    "> display 9",
    ". display 10 /* open",
    ">   still */ + 1",
    "11",
  ]);
  assert.deepEqual(
    splitCommands("* a ///\n* b ///\ndisplay 9\n*x///\ndisplay 1\n").map(
      (command) => command.text,
    ),
    ["display 1"],
  );
});

test("a log keeps the comments and continued lines, as Stata 19's does", () => {
  const { session } = transcript(
    "clear\nset obs 3\ngenerate x = _n\nlog using e2log, replace text nomsg\n* Question 1\nsummarize x // note\ndisplay x[1] ///\n    + 1\nlog close\n",
  );
  // Stata 19's e2log.log, byte for byte.
  assert.equal(
    session.readFile("e2log.log").text,
    "\n. * Question 1\n. summarize x // note\n\n    Variable |        Obs        Mean    Std. dev.       Min        Max\n-------------+---------------------------------------------------------\n           x |          3           2           1          1          3\n\n. display x[1] ///\n>     + 1\n2\n\n. log close\n",
  );
});

test("a command echoed as typed is advised on as it was read", () => {
  const { output } = transcript(
    "clear\nset obs 2\nsummarize nosuch ///\n  , detail\n",
  );
  const record = output.at(-1);
  assert.equal(record.command, "summarize nosuch ///");
  assert.deepEqual(record.echo, [">   , detail"]);
  assert.equal(record.text, "summarize nosuch    , detail");
  const advice = adviseRecord(record, { commands: COMMANDS, variables: [] });
  assert.ok(advice?.text);
  // A record of more than one line offers no one-line fix.
  assert.equal(advice.fix, undefined);
});

test("capture exit sets _rc and goes on, in a do-file, a loop and a program", () => {
  const { rc, text } = transcript(
    'capture exit 198\ndisplay "a " _rc\nprogram p1\n  capture exit 459\n  display "in p1 " _rc\nend\np1\ndisplay "b " _rc\nforvalues i=1/2 {\n  capture exit 7\n  display "loop " _rc\n}\ncapture noisily exit 2000\ndisplay "c " _rc\ncapture quietly exit 3\ndisplay "d " _rc\ncapture exit\ndisplay "never"\n',
  );
  assert.equal(rc, 0);
  // Stata 19: capture exit with no code still ends the do-file.
  const printed = text.filter(
    (line) => line && !line.startsWith(".") && !/^\s*\d+\. /.test(line),
  );
  assert.deepEqual(printed, [
    "a 198",
    "in p1 459",
    "b 459",
    "loop 7",
    "loop 7",
    "c 2000",
    "d 3",
  ]);
});

test("noisily capture prints nothing; capture noisily prints the error", () => {
  const { text } = transcript(
    'clear\nset obs 2\ngenerate educ = _n\nnoisily capture regress nosuch educ\ndisplay _rc\nnoisily capture noisily regress nosuch educ\nnoisily capture display "shown"\n',
  );
  // Stata 19.
  assert.deepEqual(text.slice(-9), [
    ". noisily capture regress nosuch educ",
    "",
    ". display _rc",
    "111",
    "",
    ". noisily capture noisily regress nosuch educ",
    "variable nosuch not found",
    "",
    '. noisily capture display "shown"',
  ]);
});

test("lines in Stata's error style are marked for the Console to show in red", () => {
  const { output } = transcript(
    'display as error "custom problem"\nclear\ncapture noisily regress nosuch\ndisplay "plain" _n as error "bad" _n as text "fine"\ndisplay as text "a" as error " b"\ndisplay in red "old red"\n',
  );
  const byCommand = (start) =>
    output.find((record) => record.command.startsWith(start));
  assert.deepEqual(byCommand("display as error").lines, ["custom problem"]);
  assert.deepEqual(byCommand("display as error").errorLines, [0]);
  assert.deepEqual(byCommand("capture noisily").lines, [
    "no variables defined",
  ]);
  assert.deepEqual(byCommand("capture noisily").errorLines, [0]);
  // Only the line printed as error is red.
  assert.deepEqual(byCommand('display "plain"').lines, [
    "plain",
    "bad",
    "fine",
  ]);
  assert.deepEqual(byCommand('display "plain"').errorLines, [1]);
  // A line of two styles is shown as ordinary output.
  assert.equal(byCommand('display as text "a"').errorLines, undefined);
  assert.deepEqual(byCommand("display in red").errorLines, [0]);
});

test("files the session writes are kept when the session is cleared", () => {
  const s = createConsoleSession(),
    ran = s.run(
      "clear\nset obs 3\ngenerate x = _n\nsave women, replace\nexport delimited using clean.csv, replace\nlog using mylog, replace\ndisplay 1\nlog close\n",
      { doFile: true },
    );
  assert.equal(ran.rc, 0);
  assert.deepEqual([...ran.written].sort(), [
    "clean.csv",
    "mylog.smcl",
    "women.dta",
  ]);
  // Saved: the data are unchanged since, as c(changed) says.
  assert.equal(ran.memory.changed, false);
  assert.equal(s.run("generate y = 1").memory.changed, true);
  s.reset();
  const used = s.run("use women, clear\ncount", { doFile: true });
  assert.equal(used.rc, 0);
  assert.deepEqual(used.output.at(-1).lines, ["  3"]);
  assert.equal(s.run("import delimited clean.csv, clear").rc, 0);
  assert.ok(s.readFile("mylog.smcl").text.includes("{com}. display 1"));
  // A file read but not written is not reported.
  assert.deepEqual(s.run("use women, clear").written, []);
});

test("hints for r(601) and r(9) look at the command", () => {
  const s = createConsoleSession(),
    advice = (command) => {
      const ran = s.run(command);
      return adviseRecord(ran.output.at(-1), {
        commands: COMMANDS,
        variables: ran.memory.variables,
      });
    };
  // Stata 19: no Graph window open, r(601); nothing is missing on disk.
  const graph = advice("graph export g.png");
  assert.match(graph.text, /draw/i);
  assert.doesNotMatch(graph.text, /file or dataset/);
  assert.match(advice("use nosuchfile, clear").text, /No file or dataset/);
  s.run(
    "clear\nset obs 4\ngenerate region = mod(_n, 2)\ngenerate y2018 = _n\ngenerate y2019 = _n",
  );
  // Stata 19: variable id does not uniquely identify the observations, r(9).
  const reshape = advice("reshape long y, i(region) j(year)");
  assert.match(reshape.text, /i\(\)/);
  assert.doesNotMatch(reshape.text, /assert/);
  assert.match(advice("assert region > 5").text, /assert was false/);
});

test("regress with a factor of many levels gives Stata 19's estimates", () => {
  const s = createConsoleSession(),
    ran = s.run(
      'clear\nset obs 3000\nset seed 12345\ngenerate g = mod(_n, 40)\ngenerate x = runiform()\ngenerate w = 1 + runiform()\ngenerate y = 2 + 3*x + g/10 + rnormal()\nquietly regress y x i.g\ndisplay _b[x] " " _se[x] " " _b[39.g] " " e(rmse)\nquietly regress y x i.g [aw=w], vce(robust)\ndisplay _b[x] " " _se[x] " " _b[39.g]\n',
      { doFile: true },
    ),
    shown = ran.output
      .filter((record) => record.command.startsWith("display"))
      .map((record) => record.lines[0]);
  // Stata 19.
  assert.deepEqual(shown, [
    "2.9806307 .06268634 3.7891706 .97688738",
    "2.9567021 .06401296 3.8176174",
  ]);
});
