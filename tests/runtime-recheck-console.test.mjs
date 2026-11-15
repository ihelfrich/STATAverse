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

// The second look at the F14 fix: merge's and append's messages, and the
// commands whose "file ... not found" is a paragraph, were run in Stata 19
// at each linesize from 40 to 100; a few of those lines follow.
test("F14: merge's, append's and more file messages break as Stata's do", () => {
  // merge 1:1 and m:1 on keys that are not unique: {p 0 4 2}.
  const unique = (names, side) =>
    `${names.includes(" ") ? "variables" : "variable"} ${names} ${names.includes(" ") ? "do" : "does"} not uniquely identify observations in the ${side} data`;
  assert.deepEqual(
    errorText(
      unique("household_id survey_year", "master"),
      79,
      "capture noisily merge 1:1 household_id survey_year using hh",
    ),
    [
      "variables household_id survey_year do not uniquely identify observations in",
      "    the master data",
    ],
  );
  assert.deepEqual(
    errorText(
      unique("household_id survey_year", "using"),
      40,
      "merge m:1 household_id survey_year using hh",
    ),
    [
      "variables household_id survey_year do",
      "    not uniquely identify observations",
      "    in the using data",
    ],
  );
  assert.deepEqual(
    errorText(unique("id", "master"), 40, "merge 1:1 id using twice"),
    [
      "variable id does not uniquely identify",
      "    observations in the master data",
    ],
  );
  assert.deepEqual(
    errorText(unique("long_identifier_name", "master"), 40, "merge 1:m x"),
    [
      "variable long_identifier_name does not",
      "    uniquely identify observations in",
      "    the master data",
    ],
  );
  // append's string/numeric mismatch, and merge's for a key: {p 0 2 2}.
  assert.deepEqual(
    errorText(
      "variable household_identifier is float in master but str4 in using data",
      40,
      "capture noisily append using strkey",
    ),
    [
      "variable household_identifier is float",
      "  in master but str4 in using data",
    ],
  );
  assert.deepEqual(
    errorText(
      "variable household_identifier is str4 in master but float in using data",
      50,
      "append using numkey",
    ),
    [
      "variable household_identifier is str4 in master",
      "  but float in using data",
    ],
  );
  assert.deepEqual(
    errorText(
      "key variable household_identifier is float in master but str4 in using data",
      40,
      "merge 1:1 household_identifier using strkey",
    ),
    [
      "key variable household_identifier is",
      "  float in master but str4 in using",
      "  data",
    ],
  );
  // joinby, infile, infix, labelbook and import sasxport5 say a file is not
  // found as use does; import sasxport8 as import delimited does; estimates
  // use cuts the line.
  for (const command of [
    "capture noisily joinby id using nosuchfile_long_name_here.dta",
    "infile x using nosuchfile_long_name_here.raw, clear",
    "inf x using nosuchfile_long_name_here.raw, clear",
    "infix x 1-2 using nosuchfile_long_name_here.raw, clear",
    "labelbook using nosuchfile_long_name_here.dta",
    "import sasxport5 nosuchfile_long_name_here.xpt, clear",
    "use id using nosuchfile_long_name_here.dta, clear",
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
      "file nosuchfile_long_name_here.v8xpt not found",
      40,
      "import sasxport8 nosuchfile_long_name_here.v8xpt, clear",
    ),
    ["file nosuchfile_long_name_here.v8xpt not", "found"],
  );
  assert.deepEqual(
    errorText(
      "file nosuchfile_long_name_here.ster not found",
      44,
      "estimates use nosuchfile_long_name_here.ster",
    ),
    ["file nosuchfile_long_name_here.ster not foun", "> d"],
  );
});

test("F14: a merge on keys that are not unique, as Results shows it", () => {
  const s = createConsoleSession();
  s.run(
    [
      "clear",
      "input household_id survey_year income",
      "1 2020 10",
      "1 2020 11",
      "2 2021 12",
      "end",
      "save hh, replace",
    ].join("\n"),
  );
  const shown = (command) => {
    const record = s.run(command).output.at(-1),
      from = record.lines.length - (record.rc ? (record.fault ?? 2) : 0),
      red = new Set(record.errorLines ?? []);
    return record.lines.flatMap((line, k) =>
      k >= from || red.has(k) ? errorText(line, 79, record.command) : [line],
    );
  };
  assert.deepEqual(shown("merge 1:1 household_id survey_year using hh"), [
    "variables household_id survey_year do not uniquely identify observations in",
    "    the master data",
    "r(459);",
  ]);
  assert.deepEqual(
    shown("capture noisily merge m:1 household_id survey_year using hh"),
    [
      "variables household_id survey_year do not uniquely identify observations in",
      "    the using data",
    ],
  );
});

test("F14: the error that stops a do-file run by do is shown as an error", () => {
  const s = createConsoleSession();
  s.addFile(
    "inner.do",
    new TextEncoder().encode(
      "clear\ncapture noisily append using nosuchfile_long_name_here.dta\nuse nosuchfile_long_name_here.dta\n",
    ),
  );
  s.run("set linesize 40");
  // Stata 19: the message (in red) is a paragraph, then r(601);, then
  // "end of do-file" and, unless the do was captured, r(601); again.
  const failed = (command) => {
    const records = s.run(command).output,
      record = records.findLast((each) => /^use /.test(each.command));
    return {
      red: record.errorLines,
      fault: record.rc ? Math.min(record.lines.length, record.fault ?? 2) : 0,
      shown: record.lines.flatMap((line, k) =>
        (record.errorLines ?? []).includes(k)
          ? errorText(line, 40, record.command)
          : [line],
      ),
    };
  };
  assert.deepEqual(failed("do inner.do"), {
    red: [0, 1, 4],
    fault: 0,
    shown: [
      "file nosuchfile_long_name_here.dta not",
      "    found",
      "r(601);",
      "",
      "end of do-file",
      "r(601);",
    ],
  });
  assert.deepEqual(failed("capture noisily do inner.do"), {
    red: [0, 1],
    fault: 0,
    shown: [
      "file nosuchfile_long_name_here.dta not",
      "    found",
      "r(601);",
      "",
      "end of do-file",
    ],
  });
  // A text log holds it as Stata 19's log does.
  s.run(
    [
      "log using nested.log, replace text nomsg",
      "capture noisily do inner.do",
      "log close",
    ].join("\n"),
    { doFile: true },
  );
  assert.equal(
    s.readFile("nested.log").text,
    [
      "",
      ". capture noisily do inner.do",
      "",
      ". clear",
      "",
      ". capture noisily append using nosuchfil",
      "> e_long_name_here.dta",
      "file nosuchfile_long_name_here.dta not f",
      "> ound",
      "",
      ". use nosuchfile_long_name_here.dta",
      "file nosuchfile_long_name_here.dta not",
      "    found",
      "r(601);",
      "",
      "end of do-file",
      "",
      ". log close",
      "",
    ].join("\n"),
  );
});

test("F164: a run that stopped says whether commands before it took effect", () => {
  const s = createConsoleSession();
  s.addFile("first.do", new TextEncoder().encode("summarize nosuch\n"));
  s.run("sysuse study, clear");
  const finished = (text) => s.run(text).finished;
  // A loop whose first pass made v1 before its second failed: in Stata, v1
  // is there after the error.
  assert.equal(
    finished("forvalues i = 1/3 {\ngenerate v`i' = `i'\ngenerate v1 = 0\n}"),
    1,
  );
  assert.equal(s.run("confirm variable v1").rc, 0);
  // Nothing took effect: one failed command, a loop that failed at once,
  // a do-file that failed on its first line, a captured failure.
  assert.equal(finished("summarize wagez"), 0);
  assert.equal(finished("forvalues i = 1/3 {\nsummarize nosuch\n}"), 0);
  assert.equal(finished("do first.do"), 0);
  assert.equal(finished("capture summarize nosuch\nsummarize nosuch"), 0);
  assert.equal(finished("display 1\nsummarize nosuch"), 1);
});

test("A do-file run by run that fails shows its error once", () => {
  const s = createConsoleSession();
  s.addFile(
    "inner.do",
    new TextEncoder().encode("display 1\nuse nosuchfile_long_name_here.dta\n"),
  );
  // Stata 19: run prints nothing of the file but its error, once.
  const record = s.run("run inner.do").output.at(-1);
  assert.equal(record.rc, 601);
  assert.deepEqual(record.lines, [
    "file nosuchfile_long_name_here.dta not found",
    "r(601);",
  ]);
});
