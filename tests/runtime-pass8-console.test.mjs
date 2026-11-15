// The eighth pass's Console findings that can be checked without a page:
// the hints under common mistakes, help for the loops and prefixes, log
// files, sysuse dir, the data label of a site dataset, the part of a
// failed record shown as its error, and what a run sends as it goes so that
// Stop keeps it. Messages, return codes and log layouts are Stata 19's, from
// batch runs with version 17 and set processors 1 on simulated data.
import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/runtime/commands.js";
import { adviseRecord } from "../src/console-hints.js";
import { HELP, LANGUAGE } from "../src/console-help.js";
import { replaceValue } from "../src/console-browse.js";
import { createConsoleSession } from "../src/console-session.js";

const KNOWN = [...COMMANDS, ...LANGUAGE];
function session(setup = "") {
  const s = createConsoleSession();
  if (setup) s.run(setup, { doFile: true });
  return s;
}
/** The last record of a run and the hint the Console shows under it. */
function hinted(s, command) {
  const ran = s.run(command),
    record = ran.output.at(-1);
  return {
    record,
    ...adviseRecord(record, {
      commands: KNOWN,
      variables: ran.memory.variables,
    }),
  };
}
const SIMULATED = [
  "clear",
  "set obs 40",
  "set seed 3",
  "generate t = _n",
  "generate y = runiform()",
  'generate str5 region = cond(_n < 20, "North", "South")',
  "generate wage = 10 + 5*runiform()",
  "generate age = 20 + _n",
].join("\n");

test("G30: a time-series command before tsset is hinted to tsset, not to a misspelt name", () => {
  const s = session(SIMULATED);
  // Stata 19 (batch a5.do, no tsset): arima and dfuller say "time variable
  // not set, use tsset varname ..."; an operator in a varlist, in regress,
  // summarize, list, correlate or scatter, says "time variable not set";
  // newey sets tsset off with dashes. All are r(111).
  for (const [command, message] of [
    ["arima y, ar(1)", "time variable not set, use tsset varname ..."],
    ["dfuller y", "time variable not set, use tsset varname ..."],
    ["regress y L.y", "time variable not set"],
    ["regress D.y wage", "time variable not set"],
    ["summarize L.y", "time variable not set"],
    ["summarize y D.y", "time variable not set"],
    ["list L.y in 1/2", "time variable not set"],
    ["correlate y L.y", "time variable not set"],
    ["scatter y L.y", "time variable not set"],
    ["newey y wage, lag(1)", "time variable not set, use -tsset varname ...-"],
  ]) {
    const { record, text, help } = hinted(s, command);
    assert.deepEqual(record.lines, [message, "r(111);"], command);
    assert.match(text, /tsset/);
    assert.doesNotMatch(
      text,
      /spelling|No variable has that name|generate first/,
    );
    assert.equal(help, "tsset");
  }
  // mean refuses the operators with its own words; tabulate with the
  // general ones (Stata 19, with or without tsset).
  assert.deepEqual(s.run("mean L.y").output[0].lines, [
    "time-series operators not allowed",
    "r(101);",
  ]);
  assert.deepEqual(s.run("tabulate L.y").output[0].lines, [
    "factor-variable and time-series operators not allowed",
    "r(101);",
  ]);
});

test("G53/G66: hints for logit on a continuous outcome, a lone = and a loop on one line", () => {
  const s = session(SIMULATED);
  // Stata 19: outcome does not vary; remember: ... r(2000)
  const logit = hinted(s, "logit wage age");
  assert.equal(logit.record.rc, 2000);
  assert.match(logit.record.lines.join("\n"), /^outcome does not vary/m);
  assert.match(logit.text, /0 or 1/);
  assert.doesNotMatch(logit.text, /No observations were left/);
  // Stata 19: a string after the lone = is a type mismatch, r(109); a
  // number there is =exp not allowed, r(101).
  const typed = hinted(s, 'list if wage >= 12 & region = "North"');
  assert.deepEqual(typed.record.lines, ["type mismatch", "r(109);"]);
  assert.match(typed.text, /single = assigns/);
  assert.equal(typed.fix, 'list if wage >= 12 & region == "North"');
  for (const [command, rc] of [
    ['list if region = "North"', 109],
    ['list if wage == 2 & region = "North"', 109],
    ["list if region = region", 109],
    ['keep if region = "North"', 109],
    ["list if wage = 12", 101],
    ["list if wage >= 2 & age = 22", 101],
    ['list if wage = 2 & region == "North"', 101],
  ])
    assert.equal(s.run(command).output.at(-1).rc, rc, command);
  // The brace is there: the commands are on its line.
  const loop = hinted(s, 'foreach v in a b {   display "`v\'"   }');
  assert.match(loop.text, /line of its own/);
  assert.doesNotMatch(loop.text, /none was given/);
});

test("G66/G85: an option before its comma, a string value without quotes, a name already in the varlist", () => {
  const s = session(SIMULATED);
  s.run("quietly regress wage age");
  for (const [command, fix] of [
    ["margins dydx(age)", "margins, dydx(age)"],
    ["margins at(age)", "margins, at(age)"],
    ["egen m = mean(wage) by(region)", "egen m = mean(wage), by(region)"],
  ]) {
    const { text, fix: offered } = hinted(s, command);
    assert.match(text, /options come after a comma/, command);
    assert.doesNotMatch(text, /generate first|never closed/, command);
    assert.equal(offered, fix);
  }
  const north = hinted(s, "regress wage age if region == North");
  // Stata 19: North not found  r(111)
  assert.deepEqual(north.record.lines, ["North not found", "r(111);"]);
  assert.match(north.text, /in quotes/);
  assert.equal(north.fix, 'regress wage age if region == "North"');
  const itself = hinted(s, "regress wage wages");
  assert.deepEqual(itself.record.lines, [
    "variable wages not found",
    "r(111);",
  ]);
  assert.ok(!itself.fix, "regress wage wage is not offered");
  // In an expression the name already there may be the right one.
  assert.equal(
    hinted(s, "replace wage = Wage + 1").fix,
    "replace wage = wage + 1",
  );
});

test("G53: help on a short topic does not suggest a command it resembles", () => {
  // The page offers a correction only within a small edit distance; the
  // topics mi and i are not commands that run here.
  assert.equal(
    KNOWN.some((c) => c.name === "mi" || c.name === "i"),
    false,
  );
});

test("G40/G41: the loops, the prefixes and every command have help", () => {
  for (const word of [
    "foreach",
    "forvalues",
    "while",
    "capture",
    "quietly",
    "noisily",
    "by",
    "bysort",
  ]) {
    assert.ok(HELP[word], word);
    assert.ok(
      LANGUAGE.some((entry) => entry.name === word),
      `${word} is known to help`,
    );
  }
  const missing = [...new Set(COMMANDS.map((c) => c.name))].filter(
    (name) => !HELP[name],
  );
  assert.deepEqual(missing, []);
  // A search by what a command does finds survival, multilevel, survey and
  // Excel commands.
  const describe = (word) =>
    Object.entries(HELP)
      .filter(([, [summary]]) => new RegExp(`\\b${word}`, "i").test(summary))
      .map(([name]) => name);
  assert.ok(describe("survival").includes("stcox"));
  assert.ok(describe("survival").includes("stset"));
  assert.ok(describe("multilevel").includes("mixed"));
  assert.ok(describe("survey").includes("svyset"));
  assert.ok(describe("excel").includes("import"));
  assert.ok(describe("graph").includes("twoway"));
  assert.ok(describe("graph").includes("scatter"));
});

test("G46: log using writes a text log laid out as Stata 19 writes it", () => {
  const s = session();
  const ran = s.run(
    [
      "clear",
      "set obs 3",
      "gen x = _n",
      "log using mylog.log, replace text",
      "summarize x",
      'display "a{b}"',
      "log off",
      'display "hidden"',
      "log on",
      'display "shown"',
      "log query",
      "log close",
      "capture log close",
      "log close",
    ].join("\n"),
    { doFile: true },
  );
  // Stata 19: no log file open  r(606), and capture log close is quiet.
  assert.deepEqual(ran.output.at(-1).lines, ["no log file open", "r(606);"]);
  assert.equal(ran.output.at(-2).rc, 0);
  const opened = ran.output.find((r) => r.command.startsWith("log using"));
  assert.equal(opened.lines[0], "(file /stataverse/mylog.log not found)");
  assert.equal(opened.lines[1], "-".repeat(79));
  const text = s.readFile("mylog.log").text.split("\n");
  const when = /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d:\d\d$/;
  const expected = [
    "-".repeat(79),
    "      name:  <unnamed>",
    "       log:  /stataverse/mylog.log",
    "  log type:  text",
    / opened on:  /,
    "",
    ". summarize x",
    "",
    "    Variable |        Obs        Mean    Std. dev.       Min        Max",
    "-------------+---------------------------------------------------------",
    "           x |          3           2           1          1          3",
    "",
    '. display "a{b}"',
    "a{b}",
    "",
    ". log off",
    "      name:  <unnamed>",
    "       log:  /stataverse/mylog.log",
    "  log type:  text",
    / paused on:  /,
    "-".repeat(79),
    "-".repeat(79),
    "      name:  <unnamed>",
    "       log:  /stataverse/mylog.log",
    "  log type:  text",
    /^resumed on:  /,
    "",
    '. display "shown"',
    "shown",
    "",
    ". log query",
    "      name:  <unnamed>",
    "       log:  /stataverse/mylog.log, on",
    "  log type:  text",
    "",
    ". log close",
    "      name:  <unnamed>",
    "       log:  /stataverse/mylog.log",
    "  log type:  text",
    / closed on:  /,
    "-".repeat(79),
    "",
  ];
  assert.equal(text.length, expected.length);
  expected.forEach((line, k) => {
    if (typeof line === "string") assert.equal(text[k], line, `line ${k + 1}`);
    else {
      assert.match(text[k], line, `line ${k + 1}`);
      assert.match(text[k].replace(/^.*:  /, ""), when);
    }
  });
  // The log is a file of the session: dir lists it, and log using refuses
  // to write over it without replace (Stata: file ... already exists, r(602)).
  assert.match(s.run("dir").output[0].lines.join("\n"), /mylog\.log/);
  assert.deepEqual(s.run("log using mylog.log, text").output[0].lines, [
    "file /stataverse/mylog.log already exists",
    "r(602);",
  ]);
});

test("G46: an SMCL log by default, appended to, with the loop as Stata writes it", () => {
  const s = session();
  s.run(
    'log using second, replace\ndisplay 1\nforeach v in a b {\n  display "`v\'"\n}\nlog close\nlog using second, append\ndisplay 2\nlog close',
    { doFile: true },
  );
  const smcl = s.readFile("second.smcl").text;
  assert.match(smcl, /^\{smcl\}\n\{txt\}\{sf\}\{ul off\}\{\.-\}\n/);
  assert.match(smcl, /\{com\}\. foreach v in a b \{c -\(\}\n/);
  assert.match(smcl, /\{txt\}  2\{com\}\.   display "`v'"\n/);
  assert.match(smcl, /\{txt\}  3\{com\}\. \{c \)-\}\n/);
  assert.equal(smcl.match(/opened on:/g).length, 2);
  assert.ok(smcl.endsWith("{smcl}\n{txt}{sf}{ul off}"));
  // Commands typed one at a time are logged as well.
  const t = session();
  for (const command of [
    "set obs 2",
    "gen y = 1",
    "log using one.log, text",
    "list",
    "log close",
  ])
    t.run(command);
  assert.match(t.readFile("one.log").text, /\n\. list\n\n {5}\+---\+\n/);
});

test("G48: sysuse dir lists the datasets as Stata does and does not fail", () => {
  const s = session();
  const ran = s.run("sysuse dir\ndisplay 2+2", { doFile: true });
  assert.equal(ran.rc, 0);
  // Stata lays the names out down four columns of sixteen characters.
  assert.deepEqual(ran.output[0].lines, [
    "  clinic.dta      labor.dta       study.dta",
    "  firms.dta       macro.dta       trade.dta",
    "  health.dta      schools.dta     wages.dta",
  ]);
  assert.deepEqual(ran.output[1].lines, ["4"]);
  // Stata 19: sysuse alone is invalid file specification, r(198).
  assert.deepEqual(s.run("sysuse").output[0].lines, [
    "invalid file specification",
    "r(198);",
  ]);
});

test("G55: a site dataset has its data label, shown when it loads as Stata shows it", () => {
  const s = session();
  const ran = s.run("sysuse study, clear");
  assert.deepEqual(ran.output[0].lines, ["(Study time and exam scores)"]);
  assert.deepEqual(s.run('display "[`: data label\']"').output[0].lines, [
    "[Study time and exam scores]",
  ]);
});

test("G49: only the error of a failed loop is marked as one", () => {
  const s = session("sysuse study, clear");
  const loop = s
    .run(
      "foreach v in hours score {\nsummarize `v'\nregress `v' atendance\n}",
      { doFile: true },
    )
    .output.at(-1);
  assert.equal(loop.rc, 111);
  assert.equal(loop.fault, 2);
  assert.ok(loop.lines.slice(0, -2).some((line) => /5\.391304/.test(line)));
  // A message of several lines is all marked.
  const logit = s.run("logit score hours").output.at(-1);
  assert.equal(logit.fault, 4);
});

test("G44: a block left open or a } with nothing open is a record with its error", () => {
  const s = session();
  for (const text of ["}", "foreach v in a b {", "display 1\n}"]) {
    const ran = s.run(text);
    const last = ran.output.at(-1);
    assert.ok(last?.rc, text);
    assert.match(last.lines.at(-1), /^r\(\d+\);$/, text);
  }
});

test("G39: a run sends what it printed before each command, and can be put back to where Stop found it", () => {
  const s = session();
  const heard = [];
  s.run('clear\nset obs 5\ngenerate k = 1\ndisplay "x"\nreplace k = 2', {
    doFile: true,
    stream: (piece) => piece.records && heard.push(piece),
  });
  assert.deepEqual(
    heard.map((piece) => piece.node),
    [0, 1, 2, 3, 4],
  );
  // Each says how many commands had finished, which is where Stop puts
  // the session back to.
  assert.deepEqual(
    heard.map((piece) => piece.count),
    [0, 1, 2, 3, 4],
  );
  assert.equal(heard[4].records.length, 1);
  assert.deepEqual(heard[4].records[0].lines, ["x"]);
  // The same run, put back after a Stop heard after four commands, leaves
  // the data as they were then, and ends with Stop's record.
  const t = session();
  const back = t.run(
    'clear\nset obs 5\ngenerate k = 1\ndisplay "x"\nreplace k = 2',
    { doFile: true, stopAfter: 4 },
  );
  assert.equal(back.rc, 1);
  assert.deepEqual(back.output.at(-1), {
    command: "replace k = 2",
    echo: [],
    lines: ["--Break--", "r(1);"],
    rc: 1,
    fault: 2,
    line: 5,
  });
  assert.deepEqual(t.run("display k[1]").output[0].lines, ["1"]);
  // In the worker a long loop is not cut short at 200,000 commands.
  const u = session();
  const long = u.run(
    "local j = 0\nforvalues i = 1/250000 {\nlocal j = `i' * 2\n}\ndisplay `j'",
    { doFile: true, endless: true },
  );
  assert.equal(long.rc, 0);
  assert.deepEqual(long.output.at(-1).lines, ["500000"]);
});

test("G54: the page's own cap on a run is explained", () => {
  const s = session();
  const ran = s.run("forvalues i = 1/300000 {\nlocal j = `i'\n}", {
    doFile: true,
  });
  const { text } = adviseRecord(ran.output.at(-1), { commands: KNOWN });
  assert.match(text, /200,000 commands/);
});

test("G69: the data editor takes a value label's text for its number", () => {
  const column = {
    name: "f",
    type: "byte",
    valueLabel: "yn",
    codes: [
      [0, "no"],
      [1, "yes"],
    ],
  };
  assert.equal(replaceValue("yes", column), "1");
  assert.equal(replaceValue("No", column), "0");
  assert.equal(replaceValue("maybe", column), null);
  assert.equal(replaceValue("2", column), "2");
  const s = session(
    "clear\nset obs 4\ngen byte f = mod(_n,2)\nlabel define yn 0 no 1 yes\nlabel values f yn",
  );
  const page = s.peek({ count: 4 });
  assert.deepEqual(page.columns[0].codes, [
    [0, "no"],
    [1, "yes"],
  ]);
});

test("G39: Stop inside a loop or a do-file run by do keeps every command that finished, as Break does", () => {
  // Break leaves the effects of each command that finished: in a loop, the
  // iterations done; in a do-file run by do, its commands before the one
  // stopped. The loop's record shows what it printed, then --Break--.
  const s = session();
  const ran = s.run(
    "clear\nset obs 3\ngenerate k = 0\nforvalues i = 1/100 {\n  replace k = `i'\n}",
    { doFile: true, stopAfter: 3 + 5 },
  );
  assert.deepEqual(s.run("display k[1]").output[0].lines, ["5"]);
  assert.equal(ran.output.at(-1).command, "forvalues i = 1/100 {");
  assert.deepEqual(ran.output.at(-1).lines.slice(-3), [
    "(3 real changes made)",
    "--Break--",
    "r(1);",
  ]);
  const t = session();
  t.addFile(
    "part.do",
    'generate made_in_part = 5\ndisplay "part ran"\nwhile 1 {\n  local j = 1\n}',
  );
  t.run("clear\nset obs 2\ngenerate before_do = 1\ndo part.do", {
    doFile: true,
    stopAfter: 3 + 2 + 7,
  });
  assert.equal(t.run("confirm variable made_in_part").output[0].rc, 0);
  assert.equal(t.run("confirm variable before_do").output[0].rc, 0);
});

test("G39: data preserved in a do-file are put back when it ends, however it ends", () => {
  // Stata 19 (batch d4.do): a do-file run by do that preserves and keeps
  // 10 of 50 observations leaves 50; so does one that stops at an error.
  // A program's preserve is undone when it returns. Commands typed one at
  // a time keep the preserved copy until restore (console-mode Stata).
  const s = session("clear\nset obs 50\ngenerate x = _n");
  s.addFile("sub.do", 'preserve\nkeep in 1/10\ndisplay "sub " _N');
  s.addFile("bad.do", "preserve\nkeep in 1/5\nsummarize nosuch");
  s.run("do sub.do");
  assert.deepEqual(s.run("count").output[0].lines, ["  50"]);
  s.run("capture noisily do bad.do");
  assert.deepEqual(s.run("count").output[0].lines, ["  50"]);
  s.run("program define cut10\npreserve\nkeep in 1/10\nend\ncut10");
  assert.deepEqual(s.run("count").output[0].lines, ["  50"]);
  // The editor's Run is a do-file: its preserve is undone at its end, and
  // at a Stop as well.
  s.run("preserve\nkeep in 1/10", { doFile: true });
  assert.deepEqual(s.run("count").output[0].lines, ["  50"]);
  s.run("preserve\nkeep in 1/10\nwhile 1 {\n  local j = 1\n}", {
    doFile: true,
    stopAfter: 50,
  });
  assert.deepEqual(s.run("count").output[0].lines, ["  50"]);
  // A do-file that preserves inside one that has preserved: each puts back
  // its own (Stata: count 20 after the inner do-file).
  s.run("preserve\nkeep in 1/20\ndo sub.do\ncount", { doFile: true });
  // Typed one at a time, preserved data stay changed until restore.
  s.run("preserve");
  s.run("keep in 1/10");
  assert.deepEqual(s.run("count").output[0].lines, ["  10"]);
  s.run("restore");
  assert.deepEqual(s.run("count").output[0].lines, ["  50"]);
});

test("G39: a run put back after Stop writes --Break-- into the open log", () => {
  const s = session("clear\nset obs 3\ngenerate x = _n");
  s.run("log using broke.log, replace text");
  s.run('display "before"\nwhile 1 {\n  local j = 1\n}', {
    doFile: true,
    stopAfter: 4,
  });
  const text = s.readFile("broke.log").text;
  assert.match(
    text,
    /\n\. display "before"\nbefore\n\n\. while 1 \{\n {2}2\. {3}local j = 1\n {2}3\. \}\n--Break--\nr\(1\);\n$/,
  );
});

test("G46: a log opened and closed in a loop, and one in a do-file run by do, hold what Stata's do", () => {
  // Stata 19 (batch b4.do): the log opened in the loop holds its header,
  // what the loop printed after it, and its closing lines; one opened in a
  // do-file holds the do-file's commands, not its own log using.
  const s = session("clear\nset obs 5\ngenerate x = _n");
  s.addFile(
    "an.do",
    'log using an.log, replace text\nsummarize x\ndisplay "done"\nlog close',
  );
  s.run(
    "forvalues i = 1/2 {\n  log using b4_`i'.log, replace text\n  display \"inside `i'\"\n  summarize x\n  log close\n}\ndo an.do",
    { doFile: true },
  );
  const first = s.readFile("b4_1.log").text.split("\n");
  assert.deepEqual(first.slice(0, 4), [
    "-".repeat(79),
    "      name:  <unnamed>",
    "       log:  /stataverse/b4_1.log",
    "  log type:  text",
  ]);
  assert.match(first[4], /^ opened on:  /);
  assert.deepEqual(first.slice(5, 10), [
    "inside 1",
    "",
    "    Variable |        Obs        Mean    Std. dev.       Min        Max",
    "-------------+---------------------------------------------------------",
    "           x |          5           3    1.581139          1          5",
  ]);
  assert.match(first.at(-3), /^ closed on:  /);
  assert.equal(first.at(-2), "-".repeat(79));
  const an = s.readFile("an.log").text.split("\n");
  assert.equal(an.filter((line) => line === "-".repeat(79)).length, 2);
  assert.ok(!an.some((line) => /log using/.test(line)));
  assert.deepEqual(an.slice(5, 13), [
    "",
    ". summarize x",
    "",
    "    Variable |        Obs        Mean    Std. dev.       Min        Max",
    "-------------+---------------------------------------------------------",
    "           x |          5           3    1.581139          1          5",
    "",
    '. display "done"',
  ]);
  assert.deepEqual(an.slice(14, 17), [
    "",
    ". log close",
    "      name:  <unnamed>",
  ]);
});

test("G46: log options and states as Stata 19 has them", () => {
  // Console-mode Stata 19 (b2.txt).
  const s = session("clear\nset obs 3\ngenerate x = _n");
  const lines = (command) => s.run(command).output.at(-1).lines;
  assert.deepEqual(lines("log query"), ["(closed)"]);
  assert.deepEqual(lines("log"), ["(closed)"]);
  assert.deepEqual(lines("log query _all"), ["(closed)"]);
  s.run("log using b2n.log, name(n1) replace text");
  assert.deepEqual(lines("log query"), ["(closed)"]);
  assert.deepEqual(lines("log query _all"), [
    "(closed)",
    "      name:  n1",
    "       log:  /stataverse/b2n.log, on",
    "  log type:  text",
  ]);
  // log close is about the unnamed log.
  assert.deepEqual(lines("log close"), ["no log file open", "r(606);"]);
  s.run("log using b2u.log, replace text");
  assert.deepEqual(lines("log query _all"), [
    "      name:  <unnamed>",
    "       log:  /stataverse/b2u.log, on",
    "  log type:  text",
    "",
    "      name:  n1",
    "       log:  /stataverse/b2n.log, on",
    "  log type:  text",
  ]);
  assert.equal(lines("log off").at(-1), "-".repeat(79));
  assert.deepEqual(lines("log off"), ["(log already off)"]);
  assert.equal(lines("log on")[0], "-".repeat(79));
  assert.deepEqual(lines("log on"), ["(log already on)"]);
  s.run("log close _all");
  assert.deepEqual(
    lines("log using b2a.log, append text")[0],
    "(file /stataverse/b2a.log not found)",
  );
  s.run("log close");
  // nomsg: no header and no closing lines, in Results or in the file.
  assert.deepEqual(lines("log using b2m.log, replace text nomsg"), [
    "(file /stataverse/b2m.log not found)",
  ]);
  s.run('display "nomsg"');
  assert.deepEqual(lines("log close"), []);
  assert.equal(
    s.readFile("b2m.log").text,
    '\n. display "nomsg"\nnomsg\n\n. log close\n',
  );
  // set logtype text: a log named without an extension is a .log of text.
  s.run("set logtype text");
  s.run("log using b6a, replace");
  s.run("log close");
  assert.match(s.readFile("b6a.log").text, /  log type:  text\n/);
  assert.equal(s.readFile("b6a.smcl"), null);
  s.run("set logtype smcl");
  // The rules are as wide as the linesize.
  s.run("set linesize 60");
  assert.equal(lines("log using b2l.log, replace text")[1], "-".repeat(60));
  assert.equal(lines("log close").at(-1), "-".repeat(60));
});

test("G46: an SMCL log draws tables and errors with Stata's markup", () => {
  // Stata 19 (batch b3.do) writes the bars and rules of a table as {c |},
  // {hline n} and {c +}, numbers after the bar as results, a list's box
  // with its corners, and an error in {err}.
  const s = session('clear\nset obs 3\ngenerate x = _n\ngenerate str3 s = "a"');
  s.run("log using b3s.smcl, replace smcl\nsummarize x\nlist in 1/2", {
    doFile: true,
  });
  s.run("summarize nosuch");
  s.run("log close");
  const smcl = s.readFile("b3s.smcl").text;
  assert.match(smcl, /\{txt\}    Variable \{c \|\}        Obs/);
  assert.match(smcl, /\{txt\}\{hline 13\}\{c \+\}\{hline 57\}\n/);
  assert.match(
    smcl,
    /\{txt\}           x \{c \|\}\{res\}          3           2/,
  );
  assert.match(smcl, /\{txt\}     \{c TLC\}\{hline 7\}\{c TRC\}\n/);
  assert.match(smcl, /\{txt\}  1\. \{c \|\}\{res\} 1   a \{txt\}\{c \|\}\n/);
  assert.match(smcl, /\{txt\}     \{c BLC\}\{hline 7\}\{c BRC\}\n/);
  assert.match(smcl, /\{err\}variable nosuch not found\n/);
});

test("G44: a program defined in the Console is shown as Stata's log shows it", () => {
  // Stata 19 (batch p1.do, and console mode): the definition is echoed
  // with its lines numbered from 1, its end the last of them.
  const s = session();
  const ran = s.run(
    'display 0\nprogram define hi\n\tdisplay "hello"\nend\nhi',
    {
      doFile: true,
    },
  );
  assert.deepEqual(
    ran.output.map((record) => [
      record.command,
      record.echo ?? [],
      record.lines,
    ]),
    [
      ["display 0", [], ["0"]],
      ["program define hi", ['  1.         display "hello"', "  2. end"], []],
      ["hi", [], ["hello"]],
    ],
  );
  // Typed at the command line, the block runs once it is closed.
  const typed = s.run('program define hi2\ndisplay "two"\nend').output;
  assert.deepEqual(typed[0].echo, ['  1. display "two"', "  2. end"]);
});

test("forvalues runs more than 1,000,000 values; only foreach of numlist is limited", () => {
  // Stata 19 (batch d1.do) displays 3000000 and 600000.
  const s = session();
  const ran = s.run(
    "local j = 0\nforvalues i = 1/1200000 {\nlocal j = `i'\n}\ndisplay `j'",
    { doFile: true, endless: true },
  );
  assert.equal(ran.rc, 0);
  assert.deepEqual(ran.output.at(-1).lines, ["1200000"]);
  const half = s.run(
    "forvalues i = 0.5(0.5)600000 {\nlocal j = `i'\n}\ndisplay `j'",
    { doFile: true, endless: true },
  );
  assert.deepEqual(half.output.at(-1).lines, ["600000"]);
  // Stata 19 (batch d3.do): foreach of numlist refuses a long list, r(123).
  // (Its own limit is lower, between 1,600 and 1,700 numbers in d9.do;
  // the runtime refuses more than 1,000,000.)
  const many = s.run("foreach i of numlist 1/1000001 {\ndisplay 1\n}")
    .output[0];
  assert.equal(many.rc, 123);
  assert.deepEqual(many.lines.slice(-2), [
    "invalid numlist has too many elements",
    "r(123);",
  ]);
});

test("G85/G66: an option before the comma, in margins and in egen with a space, is offered with its comma", () => {
  const s = session(SIMULATED);
  s.run("quietly regress wage age");
  // Stata 19 (batch h1.do): variable dydx not found, r(111).
  const margins = hinted(s, "margins age dydx(age)");
  assert.deepEqual(margins.record.lines, [
    "variable dydx not found",
    "r(111);",
  ]);
  assert.equal(margins.fix, "margins age, dydx(age)");
  assert.deepEqual(hinted(s, "margins age atmeans").record.lines, [
    "variable atmeans not found",
    "r(111);",
  ]);
  const egen = hinted(s, "egen m2 = total(wage) by (region)");
  assert.deepEqual(egen.record.lines, ["varlist not allowed", "r(101);"]);
  assert.equal(egen.fix, "egen m2 = total(wage), by(region)");
});
