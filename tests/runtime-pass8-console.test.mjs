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
  for (const command of ["arima y, ar(1)", "dfuller y", "regress y L.y"]) {
    const { record, text, help } = hinted(s, command);
    // Stata 19: time variable not set, use tsset varname ...  r(111)
    assert.deepEqual(record.lines, [
      "time variable not set, use tsset varname ...",
      "r(111);",
    ]);
    assert.match(text, /tsset/);
    assert.doesNotMatch(text, /spelling|No variable has that name/);
    assert.equal(help, "tsset");
  }
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

test("G39: a run sends what it printed before each command, and can be put back up to one", () => {
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
  assert.equal(heard[4].records.length, 1);
  assert.deepEqual(heard[4].records[0].lines, ["x"]);
  // The same run, put back after a Stop at its fifth command, leaves the
  // data as they were before that command.
  const t = session();
  t.run('clear\nset obs 5\ngenerate k = 1\ndisplay "x"\nreplace k = 2', {
    doFile: true,
    stopAt: 4,
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
