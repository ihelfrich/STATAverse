// The Console's hints, checked again against the runtime's own messages:
// a refusal gets its own honest hint, never the typo hint; each hint fits
// the message and the command it is under; and every fix a hint offers
// runs. The messages and the fixes were checked against Stata 19 (cases
// recheck-hints-fixes and recheck-hints-messages in tools/output-cases.txt).
import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/runtime/commands.js";
import { LANGUAGE } from "../src/console-help.js";
import { adviseRecord } from "../src/console-hints.js";
import { createConsoleSession } from "../src/console-session.js";

const KNOWN = [...COMMANDS, ...LANGUAGE];
const GENERIC = /could not read that line|misspelt option/;

// What the Console's hintNode passes: the names, value labels, files and
// the count of observations in memory after the run.
const contextOf = (ran) => ({
  commands: KNOWN,
  variables: ran.memory.variables,
  labels: ran.memory.labels,
  files: ran.memory.files,
  observations: ran.memory.observations,
});

/** A session, with a function that runs a line and returns its hint. */
function console_(setup = "") {
  const session = createConsoleSession();
  if (setup) {
    const ran = session.run(setup, { doFile: true });
    assert.equal(ran.rc, 0, `setup: ${JSON.stringify(ran.output.at(-1))}`);
  }
  const hint = (line, options) => {
    const ran = session.run(line, options),
      record = ran.output.findLast((each) => each.rc) ?? ran.output.at(-1);
    return {
      record,
      rc: ran.rc,
      ...(adviseRecord(record, contextOf(ran)) ?? { text: "" }),
    };
  };
  // The fix a hint offers must run.
  const runs = (fix) => {
    assert.ok(fix, "a fix is offered");
    const ran = session.run(fix);
    assert.equal(ran.rc, 0, `${fix}: ${ran.output.at(-1)?.lines.join(" | ")}`);
  };
  return { session, hint, runs };
}

/** A record as the session makes it, from a message the runtime prints. */
const record = (command, message, rc = 198, extra = {}) => ({
  command,
  lines: [...message.split("\n"), `r(${rc});`],
  rc,
  ...extra,
});
const advise = (rec, variables = []) =>
  adviseRecord(rec, { commands: KNOWN, variables });

const DATA = [
  "clear",
  "input id t x1 x2 x3 str1 g w y female income",
  '1 1 1 2 3 "a" 1 5 0 50',
  '1 2 2 3 4 "b" 1 8 1 .',
  '2 1 3 4 5 "a" 3 6 1 70',
  '2 2 4 5 6 "b" 4 9 0 .',
  "end",
  'label define fem 0 "Male" 1 "Female"',
  "label values female fem",
  'generate str6 city = cond(id == 1, "Boston", "Austin")',
].join("\n");

// F19, F34, F44, F71, F80, F106, F130, F136: the runtime's refusals, as
// it words them in src/runtime.
test("a refusal gets an honest hint, never the generic r(198) one", () => {
  const cases = [
    [
      "merge 1:1 id using x, sorted",
      "option sorted is not available in the browser yet",
      /Leave out sorted\b/,
    ],
    [
      "merge 1:1 id using x, nonotes",
      "option notes is not available in the browser yet",
      /Leave out nonotes\b/,
    ],
    ["egen m = mode(x)", "egen mode() is not available yet", /another way/],
    [
      "tabulate region, plot",
      "option plot is not available in the browser yet",
      /Leave out plot\b/,
    ],
    [
      "estat hettest, rhs",
      "option rhs is not available in the browser yet",
      /Leave out rhs\b/,
    ],
    [
      "margins, predict(xb)",
      "option predict is not available in the browser yet",
      /Leave out predict\(xb\)/,
    ],
    [
      "table a b, statistic(mean x) statistic(sd x)",
      "a two-way table of more than one statistic is not available in the browser yet",
      /another way/,
    ],
    [
      "local n : colnames e(b)",
      'extended macro function "colnames" is not supported',
      /another way/,
    ],
    [
      "matrix eigenvalues a b = c",
      "matrix eigenvalues is not available yet",
      /another way/,
    ],
    [
      "mat list b, noheader",
      "matrix list option noheader is not available yet; format() is",
      /rest of the message says what runs here/,
    ],
    [
      "xtreg y x, fe vce(cluster region)",
      "vce(cluster region) is not available yet; xtreg clusters on the panel variable here: vce(cluster state)",
      /Leave out vce\(cluster region\), or do as the rest of the message says/,
    ],
    [
      "xtreg y x, fe vce(bootstrap, reps(5))",
      "vce(bootstrap, reps(5)) is not available yet",
      /Leave out vce\(bootstrap, reps\(5\)\)/,
    ],
    [
      "streg x, dist(lognormal)",
      "streg, distribution(lognormal) is not available in the browser yet",
      /another way/,
    ],
    [
      "svy: tobit y x",
      "svy: tobit is not available here; svy runs mean, proportion, ratio, total, regress, logit, logistic, probit, poisson, ologit and tabulate",
      /rest of the message/,
    ],
    [
      "set varabbrev off",
      "set varabbrev off is not available in the browser yet",
      /another way/,
    ],
  ];
  for (const [command, message, expected] of cases) {
    const advice = advise(record(command, message));
    assert.match(
      advice.text,
      /^Stata runs this, but this browser version does not yet\./,
      command,
    );
    assert.match(advice.text, expected, command);
    assert.doesNotMatch(advice.text, GENERIC, command);
    assert.equal(advice.fix, undefined, command);
  }
  // merge m:m says why, and what to use.
  const mm = advise(
    record(
      "merge m:m id using x",
      "merge m:m is not available; it rarely does what is wanted",
    ),
  );
  assert.match(mm.text, /joinby/);
  assert.match(mm.text, /1:m or m:1/);
});

test("the runtime's own hint reaches the record and the Console", () => {
  const { hint } = console_();
  // commands.js refuses set dp comma with a hint of its own.
  const dp = hint("set dp comma");
  assert.equal(dp.rc, 198);
  assert.match(dp.record.hint, /decimal point/);
  assert.match(
    dp.text,
    /^Stata runs this, but this browser version does not yet\. The browser shows numbers with a decimal point/,
  );
  // A loop is recorded whole: the hint of the error that stopped it is
  // kept with the loop's record.
  const loop = hint("forvalues i = 1/1 {\n  set dp comma\n}", { doFile: true });
  assert.equal(loop.rc, 198);
  assert.match(loop.text, /decimal point/);
  // A hint for a real Stata command the browser lacks is kept too.
  assert.match(
    advise(
      record(
        "xttab x",
        "xttab is a Stata command that the browser does not run yet",
        199,
        { hint: "Use tabulate." },
      ),
    ).text,
    /^xttab is part of Stata.*Use tabulate\.$/,
  );
});

// F18, F133, F158: a file not added, or named with a folder.
test("r(601) says whether the file is among the student's, never sysuse dir", () => {
  const { session, hint, runs } = console_(
    "clear\nset obs 2\ngenerate id = _n\nsave people, replace",
  );
  for (const path of [
    'use "C:\\Users\\me\\Desktop\\people.dta", clear',
    "use data/people.dta, clear",
  ]) {
    const advice = hint(path);
    assert.equal(advice.rc, 601, path);
    assert.match(
      advice.text,
      /people\.dta is among your files, but files here are not in folders/,
      path,
    );
    assert.doesNotMatch(advice.text, /sysuse/, path);
    runs(advice.fix);
  }
  const notAdded = hint("import delimited using grades.csv, clear");
  assert.match(
    notAdded.text,
    /^grades\.csv is not among your files\. Open Data and add it/,
  );
  assert.doesNotMatch(notAdded.text, /sysuse/);
  const doFile = hint("do nosuch.do");
  assert.match(
    doFile.text,
    /nosuch\.do is not among your files\. Open Data and add the do-file/,
  );
  assert.doesNotMatch(doFile.text, /sysuse/);
  // A dataset named without .dta may be one of the site's.
  assert.match(hint("use nosuch, clear").text, /sysuse opens it/);
  assert.match(hint("sysuse auto").text, /StataCorp/);
  session.reset();
});

// F20: a merge key in memory but not in the using file.
test("a merge key missing from the using file is said to be missing there", () => {
  const { hint } = console_(
    'clear\ninput str3 id y\n"1" 5\nend\nsave hintsusing, replace\nclear\ninput id k\n1 2\nend',
  );
  const advice = hint("merge 1:1 k using hintsusing");
  assert.deepEqual(advice.record.lines, ["variable k not found", "r(111);"]);
  assert.match(
    advice.text,
    /^k is in the data in memory, so it is the using file, hintsusing, that lacks it/,
  );
  assert.doesNotMatch(advice.text, /Variables list/);
});

// F35, F143: reshape's r(9) for a variable that is not constant.
test("reshape's not-constant r(9) adds the variables to the stubs", () => {
  const { hint, runs } = console_(`${DATA}\ndrop g city`);
  const advice = hint("reshape wide y x1 x2, i(id) j(t)");
  assert.equal(advice.rc, 9);
  assert.match(advice.text, /^x3, w, female and income change within id/);
  assert.doesNotMatch(advice.text, /different value in each observation/);
  assert.equal(
    advice.fix,
    "reshape wide y x1 x2 x3 w female income, i(id) j(t)",
  );
  runs(advice.fix);
});

// F36, F137: r(110) by what took the name.
test("r(110) is advised on by the command that met the name", () => {
  const { hint, runs } = console_(
    `${DATA}\nlabel define yn 0 "No"\nsave hintsfile, replace`,
  );
  const label = hint('label define yn 0 "No" 1 "Yes"');
  assert.deepEqual(label.record.lines, ["label yn already defined", "r(110);"]);
  assert.match(label.text, /value label called yn exists already/);
  assert.doesNotMatch(label.text, /replace to change a variable/);
  runs(label.fix);
  const rename = hint("rename x1 x2");
  assert.match(rename.text, /^x2 is the name of a variable already/);
  assert.doesNotMatch(rename.text, /replace x2 =/);
  hint("merge 1:1 id t using hintsfile");
  const merge = hint("merge 1:1 id t using hintsfile");
  assert.deepEqual(merge.record.lines, [
    "variable _merge already defined",
    "r(110);",
  ]);
  assert.match(merge.text, /drop _merge/);
  assert.doesNotMatch(merge.text, /replace _merge =/);
  const generate = hint("generate x1 = 1");
  assert.match(generate.text, /replace x1 = /);
});

test("r(110) after reshape says the data are reshaped already", () => {
  const { hint } = console_(
    "clear\nset obs 2\ngenerate id = _n\ngenerate inc1 = 1\ngenerate inc2 = 2\nreshape long inc, i(id) j(year)",
  );
  const again = hint("reshape long inc, i(id) j(year)");
  assert.equal(again.rc, 110);
  assert.match(again.text, /already long/);
});

// F37, F107: the hints do not say Stata lacks what it has.
test("hints after a refusal-like error do not claim Stata lacks the feature", () => {
  const { hint } = console_(DATA);
  const option = hint("order x1, frobnicate");
  assert.match(option.text, /here takes no option frobnicate/);
  assert.match(
    option.text,
    /if Stata's help for order lists it, this browser version does not have it yet/,
  );
  const fn = advise(
    record(
      'generate u = usubinstrr(g, "a", "b", .)',
      "unknown function usubinstrr()",
      133,
    ),
  );
  assert.match(fn.text, /^No function called usubinstrr\(\) runs here/);
  assert.match(fn.text, /this browser version does not have it yet/);
  assert.doesNotMatch(fn.text, /does not exist/);
  const lag = advise(
    record(
      "regress y L.c.x",
      "factor-variable and time-series operators not allowed",
      101,
    ),
  );
  assert.match(lag.text, /L\.x is the same as L\.c\.x/);
  const weights = advise(
    record("xtile q = x [aw=w], nq(2)", "weights not allowed", 101),
  );
  assert.match(weights.text, /^xtile here does not take weights/);
  const estat = hint("regress y x1\nestat concordance", { doFile: true });
  assert.match(
    estat.text,
    /^estat concordance does not run after the last model \(regress\) here/,
  );
  assert.doesNotMatch(estat.text, /needs a model first/);
});

// F43: a value label typed as a bare word.
test("a value label typed as a word is compared by its number, never with itself", () => {
  const { hint, runs } = console_(DATA);
  const female = hint("summarize y if female==Female");
  assert.deepEqual(female.record.lines, ["Female not found", "r(111);"]);
  assert.match(female.text, /Female is the label of its value 1/);
  assert.doesNotMatch(female.text, /case-sensitive/);
  assert.equal(female.fix, "summarize y if female==1");
  runs(female.fix);
  const other = hint("summarize y if female == Other");
  assert.match(other.text, /label list fem/);
  assert.equal(other.fix ?? "", "");
  // A numeric variable without labels is never offered itself.
  const plain = hint("summarize y if x1 == X1");
  assert.notEqual(plain.fix, "summarize y if x1 == x1");
});

// F45: an immediate command is not offered as its variable form.
test("an immediate command is not swapped for the command it is a form of", () => {
  const advice = advise(
    record("sdtesti 30 5 2.5 40 6 3.1", "command sdtesti is unrecognized", 199),
  );
  assert.match(advice.text, /immediate form of sdtest/);
  assert.equal(advice.fix, undefined);
  // A typo is still corrected.
  assert.equal(
    advise(record("summarise x", "command summarise is unrecognized", 199)).fix,
    "summarize x",
  );
});

// F50: a single = before a word compared with a string variable.
test("the single-= fix quotes the word a string variable is compared with", () => {
  const { hint, runs } = console_(DATA);
  const advice = hint("tabulate t if city=Boston");
  assert.equal(advice.rc, 109);
  assert.equal(advice.fix, 'tabulate t if city == "Boston"');
  runs(advice.fix);
  // A string compared with a number cannot be mended by ==.
  assert.equal(hint("tabulate t if city=x1").fix ?? "", "");
  assert.equal(hint("count if x1 = 2").fix, "count if x1 == 2");
});

// F72, F138: test and lincom read the model, not the data.
test("test and lincom are advised on by the last model's coefficients", () => {
  const { hint, runs } = console_(`${DATA}\nquietly regress y x1 female`);
  const inData = hint("test x2");
  assert.deepEqual(inData.record.lines, ["x2 not found", "r(111);"]);
  assert.match(
    inData.text,
    /^x2 is in the data but not in the last model \(regress\)/,
  );
  assert.equal(inData.fix ?? "", "");
  assert.deepEqual(inData.suggest, []);
  // The dependent variable is never offered: it is not a coefficient.
  const lincom = hint("lincom income");
  assert.doesNotMatch(lincom.text, /Did you mean/);
  assert.doesNotMatch(lincom.fix ?? "", /\by\b/);
  const typo = hint("test femlae");
  assert.equal(typo.fix, "test female");
  runs(typo.fix);
  const testparm = hint("testparm w");
  assert.match(
    testparm.text,
    /None of those variables is in the last model \(regress\)/,
  );
});

// F131: names that are not variables.
test("r(111) for programs, matrices, _b and text names what is missing", () => {
  const { hint } = console_(DATA);
  assert.match(
    hint("program drop nosuchprog").text,
    /^No program called nosuchprog/,
  );
  assert.match(
    hint("matrix list nosuchmat").text,
    /^No matrix called nosuchmat/,
  );
  assert.match(hint("display _b[x1]").text, /fit a model first/);
  hint("local s abc");
  const shown = hint("display `s'");
  assert.deepEqual(shown.record.lines, ["abc not found", "r(111);"]);
  assert.match(shown.text, /display "`s'"/);
  hint("local c Boston");
  const compared = hint("count if city == `c'");
  assert.match(compared.text, /city holds text/);
  assert.match(compared.text, /"`c'"/);
  // The line had a macro: a fix would lose it.
  assert.equal(compared.fix, undefined);
  hint("quietly regress y x1");
  assert.match(hint("display _b[x2]").text, /no coefficient called x2/);
});

// F132: a program never ended.
test("a program with no end is told to end", () => {
  const { hint } = console_();
  const advice = hint('program define myp\n    display "hi"\n\nmyp', {
    doFile: true,
  });
  assert.equal(advice.rc, 612);
  assert.match(advice.text, /put end on a line of its own/);
  assert.doesNotMatch(advice.text, /\}/);
});

// F139, F160: a string variable used where a number is needed.
test("the string-variable hint fits how the string was used", () => {
  const { hint, runs } = console_(DATA);
  const compared = hint("count if g == 1");
  assert.match(compared.text, /Compare it with text in quotes/);
  const ttest = hint("ttest x1 == g");
  assert.doesNotMatch(ttest.text, /Compare it with text in quotes/);
  const arithmetic = hint("generate z = g + 1");
  assert.doesNotMatch(arithmetic.text, /Compare it with text in quotes/);
  assert.match(arithmetic.text, /encode g, generate\(g_code\)/);
  const dot = hint("count if g == .");
  assert.match(dot.text, /missing text value is empty/);
  assert.equal(dot.fix, "count if missing(g)");
  runs(dot.fix);
  const or = hint('count if g == "a" | "b"');
  assert.match(or.text, /Each side of \| is a condition of its own/);
  assert.equal(or.fix, 'count if g == "a" | g == "b"');
  runs(or.fix);
  const assign = hint("replace g = 5 in 1");
  assert.match(assign.text, /goes in quotes: "5"/);
  assert.doesNotMatch(assign.text, /Compare/);
  assert.equal(assign.fix, 'replace g = "5" in 1');
  runs(assign.fix);
});

// F140: egen's functions in generate.
test("an egen function in generate points to egen", () => {
  const { hint, runs } = console_(DATA);
  const advice = hint("generate m = mean(x1)");
  assert.deepEqual(advice.record.lines, ["unknown function mean()", "r(133);"]);
  assert.match(advice.text, /function of egen/);
  assert.equal(advice.fix, "egen m = mean(x1)");
  runs(advice.fix);
});

// F141, F142.
test("estat with a wrong subcommand and an extra bracket get their own hints", () => {
  const { hint } = console_(`${DATA}\nquietly regress y x1`);
  const estat = hint("estat bogus");
  assert.match(
    estat.text,
    /^estat bogus does not run after the last model \(regress\)/,
  );
  assert.doesNotMatch(estat.text, /needs a model first/);
  const many = hint("generate z = log(x1))");
  assert.deepEqual(many.record.lines, ["too many ')' or ']'", "r(132);"]);
  assert.match(many.text, /nothing open to close/);
  const few = hint("generate z = log((x1)");
  assert.match(few.text, /never closed/);
});

// F144: past the last numbered variable.
test("a range past the last numbered variable ends at the last one", () => {
  const { hint, runs } = console_(DATA);
  const advice = hint("summarize x1-x5");
  assert.match(
    advice.text,
    /^There is no x5: the variables x1, x2, … here stop at x3/,
  );
  assert.equal(advice.fix, "summarize x1-x3");
  runs(advice.fix);
  const loop = hint("forvalues i = 1/7 {\n  summarize x`i'\n}", {
    doFile: true,
  });
  assert.match(loop.text, /^There is no x4/);
  assert.ok(!loop.fix);
});

// F145: particular r(198) messages.
test("clear r(198) messages get hints of their own", () => {
  const { hint, runs } = console_(DATA);
  const range = hint("list x1 in 1/10");
  assert.match(range.text, /there are 4 observations/);
  assert.doesNotMatch(range.text, GENERIC);
  const vce = hint("regress y x1, vce(robsut)");
  assert.equal(vce.fix, "regress y x1, vce(robust)");
  runs(vce.fix);
  const and = hint("count if x1 > 1 and x2 < 5");
  assert.equal(and.fix, "count if x1 > 1 & x2 < 5");
  runs(and.fix);
  assert.match(hint("generate 1x = 1").text, /cannot be a variable name/);
  assert.match(hint("generate _n = 1").text, /cannot be a variable name/);
  const force = hint("duplicates drop x1");
  assert.match(force.text, /force/);
  assert.equal(force.fix ?? "", "");
  // A message that is neither a refusal nor a line Stata could not read
  // gets no hint rather than the wrong one.
  assert.equal(
    advise(
      record(
        "summarize x, meanonly detail",
        "only one of meanonly or detail may be specified",
      ),
    ),
    null,
  );
  assert.match(advise(record("regress y x,", "invalid syntax")).text, GENERIC);
});

// F151: return codes students meet often.
test("r(452), r(451), r(602), r(459), r(106) and r(107) get hints", () => {
  const { hint, runs } = console_(
    `${DATA}\nreplace w = -1 in 1\ngenerate one = 1\nsave hintsfile, replace`,
  );
  assert.match(hint("regress y i.w").text, /w has negative values/);
  assert.match(hint("xtset id one").text, /duplicates report id one/);
  const save = hint("save hintsfile");
  assert.equal(save.rc, 602);
  assert.equal(save.fix, "save hintsfile, replace");
  runs(save.fix);
  assert.match(hint("isid id").text, /duplicates report id/);
  const merge = hint("merge 1:1 id using hintsfile");
  assert.match(
    merge.text,
    /^id repeats in the data in memory \(the master\), so a 1:1 match/,
  );
  assert.match(merge.text, /m:1/);
  assert.match(hint("xtreg y x1").text, /xtset/);
  assert.match(hint("encode x1, generate(e1)").text, /numeric already/);
  for (const message of [
    "key variable id is float in master but str3 in using data",
    "variable id is float in master but str3 in using data",
    "key variable id is str in one dataset and numeric in the other",
  ])
    assert.match(
      advise(record("merge 1:1 id using u", message, 106)).text,
      /destring id, replace/,
      message,
    );
});

// F152: notes under commands that ran.
test("a note follows missing values generated and a > that counts missing", () => {
  const { hint } = console_(DATA);
  const division = hint("generate z = income/2");
  assert.equal(division.rc, 0);
  assert.match(division.text, /count if missing\(z\)/);
  assert.equal(hint("generate q = .").text, "");
  assert.equal(hint("generate q2 = 1 if x1 > 2").text, "");
  const over = hint("count if income > 60");
  assert.deepEqual(over.record.lines, ["  3"]);
  assert.match(over.text, /^income has 2 missing values/);
  assert.match(over.text, /& !missing\(income\)/);
  assert.equal(hint("count if income > 60 & !missing(income)").text, "");
  assert.equal(hint("quietly count if income > 60").text, "");
  assert.equal(hint("count if x1 > 2").text, "");
  // keep counts them too, and drop removes them.
  assert.match(hint("drop if income > 60").text, /income has 2 missing values/);
});

// F159: a command continued with /// is advised on as read.
test("a continued command is advised on whole", () => {
  const { hint } = console_(DATA);
  const advice = hint("regress y x1 ///\n   x3 ///\n   incme", {
    doFile: true,
  });
  assert.deepEqual(advice.record.echo, [">    x3 ///", ">    incme"]);
  assert.match(advice.text, /Did you mean income\?/);
  assert.equal(advice.fix, undefined);
});
