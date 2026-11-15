// The console group's findings from the re-check after release 492e426.
// Every expected line was copied from Stata 19 MP (version 17, set
// processors 1) run in batch on the same commands.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleSession } from "../src/console-session.js";
import { errorText } from "../src/console-wrap.js";

test("F14: error messages wider than the linesize break as Stata's do", () => {
  // import excel's firstrow refusal is a paragraph that uses the whole
  // linesize; at 79 only "the first row" goes on.
  const firstrow =
    "option firstrow not allowed with extvarlist; specify option cellrange() to skip the first row";
  assert.deepEqual(
    errorText(
      firstrow,
      79,
      'import excel id gdp using book.xlsx, sheet("y2020") firstrow clear',
    ),
    [
      "option firstrow not allowed with extvarlist; specify option cellrange() to skip",
      "the first row",
    ],
  );
  assert.deepEqual(
    errorText(firstrow, 40, "capture noisily import excel id gdp using b"),
    [
      "option firstrow not allowed with",
      "extvarlist; specify option cellrange()",
      "to skip the first row",
    ],
  );
  // use, merge, do, run, include, insheet, describe using and cross say a
  // file is not found in a paragraph indented by four, two columns short
  // of the linesize; a name too long for a line is cut after "> ".
  assert.deepEqual(
    errorText(
      "file nosuchfile_with_a_rather_long_name_for_testing_wrapping_of_errors_too.dta not found",
      79,
      "capture noisily use nosuchfile_with_a_rather_long_name_for_testing_wrapping_of_errors_too.dta, clear",
    ),
    [
      "file",
      "    nosuchfile_with_a_rather_long_name_for_testing_wrapping_of_errors_too.dta",
      "    not found",
    ],
  );
  assert.deepEqual(
    errorText(
      "file nosuchfile_with_a_rather_long_name_for_testing_wrapping_of_errors.dta not found",
      79,
      "capture noisily merge 1:1 _n using nosuchfile_with_a_rather_long_name_for_testing_wrapping_of_errors.dta",
    ),
    [
      "file nosuchfile_with_a_rather_long_name_for_testing_wrapping_of_errors.dta",
      "    not found",
    ],
  );
  for (const command of [
    "use nosuchfile_long_name_here.dta, clear",
    "capture noisily do nosuchfile_long_name_here.do",
    "capture noisily run nosuchfile_long_name_here.do",
    "capture noisily include nosuchfile_long_name_here.do",
    "capture noisily insheet using nosuchfile_long_name_here.csv, clear",
    "capture noisily describe using nosuchfile_long_name_here.dta",
    "capture noisily cross using nosuchfile_long_name_here.dta",
  ]) {
    const name = command.match(/nosuchfile_long_name_here\.\w+/)[0];
    assert.deepEqual(
      errorText(`file ${name} not found`, 40, command),
      [`file ${name} not`, "    found"],
      command,
    );
  }
  assert.deepEqual(
    errorText(
      "file nosuchfile_long_name_here_and_longer_still.dta not found",
      40,
      "capture noisily use nosuchfile_long_name_here_and_longer_still.dta, clear",
    ),
    [
      "file",
      "    nosuchfile_long_name_here_and_long",
      "    > er_still.dta not found",
    ],
  );
  // import delimited, import excel and import spss use the whole width
  // and do not indent.
  for (const [command, name] of [
    ["capture noisily import delimited using x, clear", "x.csv"],
    ["capture noisily import excel using x, clear", "x.xlsx"],
    ["capture noisily import spss using x, clear", "x.sav"],
  ]) {
    const file = `nosuchfile_long_name_here.${name.split(".")[1]}`;
    assert.deepEqual(
      errorText(`file ${file} not found`, 40, command),
      [`file ${file} not`, "found"],
      command,
    );
  }
  // Every other message is cut as display cuts a line: where the next
  // character would pass the linesize, the rest after "> ".
  assert.deepEqual(
    errorText(
      "file nosuchfile_long_name_here.dta not found",
      40,
      "capture noisily append using nosuchfile_long_name_here.dta",
    ),
    ["file nosuchfile_long_name_here.dta not f", "> ound"],
  );
  assert.deepEqual(
    errorText(
      "variable nosuchvariablename_abcdefgh not found",
      40,
      "summarize nosuchvariablename_abcdefgh",
    ),
    ["variable nosuchvariablename_abcdefgh not", ">  found"],
  );
  assert.deepEqual(
    errorText(
      "option nosuchoptionnamehereforthis not allowed",
      40,
      "summarize x, nosuchoptionnamehereforthis",
    ),
    ["option nosuchoptionnamehereforthis not a", "> llowed"],
  );
  assert.deepEqual(
    errorText(
      "string variable s not allowed with statistic mean",
      40,
      "collapse (mean) s, by(x)",
    ),
    ["string variable s not allowed with stati", "> stic mean"],
  );
  // A message that fits is left alone, and so is each line of one that
  // already has several.
  assert.deepEqual(errorText("type mismatch", 40, "replace s = 5"), [
    "type mismatch",
  ]);
});

test("F14: a text log holds long error messages as Stata's log does", () => {
  const s = createConsoleSession();
  s.run(
    [
      "clear",
      "set obs 3",
      "generate x = _n",
      "set linesize 40",
      "log using wrapped.log, replace text nomsg",
      "capture noisily use nosuchfile_long_name_here.dta, clear",
      "capture noisily append using nosuchfile_long_name_here.dta",
      "capture noisily import delimited using nosuchfile_long_name_here.csv, clear",
      "capture noisily summarize nosuchvariablename_abcdefgh",
      'display as error "alpha beta gamma delta epsilon zeta eta theta"',
      "log close",
    ].join("\n"),
    { doFile: true },
  );
  // Stata 19's wrapped.log, line for line.
  assert.equal(
    s.readFile("wrapped.log").text,
    [
      "",
      ". capture noisily use nosuchfile_long_na",
      "> me_here.dta, clear",
      "file nosuchfile_long_name_here.dta not",
      "    found",
      "",
      ". capture noisily append using nosuchfil",
      "> e_long_name_here.dta",
      "file nosuchfile_long_name_here.dta not f",
      "> ound",
      "",
      ". capture noisily import delimited using",
      ">  nosuchfile_long_name_here.csv, clear",
      "file nosuchfile_long_name_here.csv not",
      "found",
      "",
      ". capture noisily summarize nosuchvariab",
      "> lename_abcdefgh",
      "variable nosuchvariablename_abcdefgh not",
      ">  found",
      "",
      '. display as error "alpha beta gamma del',
      '> ta epsilon zeta eta theta"',
      "alpha beta gamma delta epsilon zeta eta ",
      "> theta",
      "",
      ". log close",
      "",
    ].join("\n"),
  );
});

test("F165: each by() panel is drawn on a canvas of its own place", () => {
  const s = createConsoleSession();
  s.run("sysuse study, clear");
  const graph = s
    .run("scatter score hours, by(group)")
    .output.map((record) => record.graph)
    .find(Boolean);
  const panels = [
    ...graph.svg.matchAll(
      /<svg x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)" xmlns="[^"]+" viewBox="0 0 ([\d.]+) ([\d.]+)"/g,
    ),
  ].map((m) => m.slice(1).map(Number));
  assert.ok(panels.length > 1);
  for (const [width, height, w, h] of panels) {
    // The panel fills its place: its canvas has the place's proportions.
    assert.ok(Math.abs(width / height - w / h) < 0.01);
    // Its text keeps at least 0.7 of its size.
    assert.ok(width / w >= 0.7);
  }
  // The panels' names are on shaded strips, as in Stata's by() graphs.
  assert.match(graph.svg, /fill="#d9e6eb"/);
  assert.doesNotMatch(graph.svg, /NaN|Infinity/);
});
