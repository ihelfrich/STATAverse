// The Console's hints after a second check against Stata 19: a typo of one
// of Stata's own subcommands is not called a refusal; a value-labelled or
// abbreviated variable, a factor variable in the last model, a missing-value
// note, egen in an expression, a single =, merge's match, reshape's j(),
// input without end, immediate commands, a missing worksheet, a number given
// to a string variable, display of a misspelt variable, a global macro and
// an option inside a loop each get advice that fits, and every fix offered
// runs. Stata's messages and the fixes are recorded in tools/output-cases.txt
// (case recheck-hints-r2).
import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/runtime/commands.js";
import { LANGUAGE } from "../src/console-help.js";
import { adviseRecord } from "../src/console-hints.js";
import { createConsoleSession } from "../src/console-session.js";

const KNOWN = [...COMMANDS, ...LANGUAGE];

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

/** A record as the session makes it, from a message. */
const record = (command, message, rc = 198) => ({
  command,
  lines: [...message.split("\n"), `r(${rc});`],
  rc,
});
const advise = (rec) => adviseRecord(rec, { commands: KNOWN, variables: [] });

const PEOPLE = [
  "clear",
  "input id grp wage educ exper female str6 city str5 region",
  '1 1 15.3 12 5 0 "Boston" "North"',
  '2 1 . 16 3 1 "Austin" "South"',
  '3 2 21.4 16 9 1 "Boston" "North"',
  '4 2 13.1 10 2 0 "Austin" "South"',
  '5 3 18.2 14 7 1 "Boston" "North"',
  '6 3 . 12 4 0 "Austin" "North"',
  '7 1 16.9 13 6 1 "Boston" "South"',
  '8 2 19.5 15 8 0 "Austin" "North"',
  '9 3 22.1 17 10 1 "Boston" "South"',
  '10 1 14.2 11 3 0 "Austin" "North"',
  "end",
  'label define fem 0 "Male" 1 "Female"',
  "label values female fem",
].join("\n");

const REFUSED = /Stata runs this/;

test("a typo of Stata's own subcommand or kernel is a typo, not a refusal", () => {
  // The runtime's words for them, and Stata's.
  const cases = [
    [
      "import excell using book.xlsx, clear",
      "import excell is not available; import delimited is",
      /^import has no subcommand excell\. Did you mean import excel\?/,
      "import excel using book.xlsx, clear",
    ],
    [
      "import excell using book.xlsx, clear",
      'import: unknown subcommand "excell"',
      /^import has no subcommand excell\. Did you mean import excel\?/,
      "import excel using book.xlsx, clear",
    ],
    [
      "import exel using book.xlsx, clear",
      'import: unknown subcommand "exel"',
      /Did you mean import excel\?/,
      "import excel using book.xlsx, clear",
    ],
    [
      "import delimted using g.csv, clear",
      "import delimted is not available; import delimited is",
      /Did you mean import delimited\?/,
      "import delimited using g.csv, clear",
    ],
    [
      "import csv using g.csv, clear",
      'import: unknown subcommand "csv"',
      /Did you mean import delimited\?/,
      "import delimited using g.csv, clear",
    ],
    [
      "export excell using book.xlsx, replace",
      'export: unknown subcommand "excell"',
      /^export has no subcommand excell\. Did you mean export excel\?/,
      "export excel using book.xlsx, replace",
    ],
    [
      "kdensity wage, kernel(bogus)",
      "kernel(bogus) is not available",
      /^kdensity has no kernel bogus\. kernel\(\) takes epanechnikov/,
      "",
    ],
    [
      "kdensity wage, kernel(bogus)",
      "invalid kernel function",
      /^kdensity has no kernel bogus/,
      "",
    ],
    [
      "graph bogus wage",
      "graph bogus is not available yet",
      /^graph has no subcommand bogus\. The graph subcommands that run here/,
      "",
    ],
    [
      "graph bogus wage",
      "bogusgraph_g.new wage: class member function not found",
      /^graph has no subcommand bogus/,
      "",
      4023,
    ],
    [
      "graph scatter wage educ",
      "scattergraph_g.new wage educ: class member function not found",
      /scatter is a twoway plot type/,
      "scatter wage educ",
      4023,
    ],
  ];
  for (const [command, message, expected, fix, rc] of cases) {
    const advice = advise(record(command, message, rc));
    assert.doesNotMatch(advice.text, REFUSED, command);
    assert.match(advice.text, expected, command);
    assert.equal(advice.fix ?? "", fix, command);
  }
  // Parts of Stata the browser lacks are still refusals: Stata's cosine
  // kernel, import sas, graph describe.
  for (const [command, message] of [
    ["kdensity wage, kernel(cosine)", "kernel(cosine) is not available"],
    [
      "import sas using x.sas7bdat",
      "import sas (.sas7bdat files) is not available in the browser",
    ],
    [
      "graph describe",
      "graph describe is not available here; graphs are drawn on this page and kept by name for graph combine, display, dir, rename and drop",
    ],
  ])
    assert.match(advise(record(command, message)).text, REFUSED, command);
});

test("the fixes for a typo of a subcommand run", () => {
  const { hint, runs } = console_(
    `${PEOPLE}\nexport delimited using g.csv, replace\nexport excel using book.xlsx, sheet("Data") firstrow(variables) replace`,
  );
  for (const [line, fix] of [
    ["graph scatter wage educ", "scatter wage educ"],
    ["graph histogram wage", "histogram wage"],
    ["import excell using book.xlsx, firstrow clear", ""],
    ["import delimted using g.csv, clear", ""],
    ["import csv using g.csv, clear", ""],
  ]) {
    const advice = hint(line);
    assert.equal(advice.rc, 198, line);
    assert.doesNotMatch(advice.text, REFUSED, line);
    if (fix) assert.equal(advice.fix, fix);
    runs(advice.fix);
  }
});

test("a value label's word against an abbreviated variable gives its number (F43)", () => {
  const { hint, runs } = console_(PEOPLE);
  const fem = hint("summarize wage if fem==Female");
  assert.equal(fem.rc, 111);
  assert.match(fem.text, /Female is the label of its value 1/);
  assert.equal(fem.fix, "summarize wage if fem==1");
  runs(fem.fix);
  const male = hint("count if femal == Male");
  assert.equal(male.fix, "count if femal == 0");
  assert.doesNotMatch(male.text, /Did you mean female/);
  runs(male.fix);
  // The text gives the operator typed.
  const not = hint("count if female!=Male");
  assert.match(not.text, /female != 0\./);
  assert.equal(not.fix, "count if female!=0");
  // An abbreviated string variable: the word goes in quotes.
  const regio = hint("count if regio == North");
  assert.equal(regio.fix, 'count if regio == "North"');
  runs(regio.fix);
});

test("a factor variable of the last model is named by its levels (F72, F138)", () => {
  const { hint, runs } = console_(PEOPLE);
  runs("regress wage i.female educ");
  const female = hint("test female");
  assert.equal(female.rc, 111);
  assert.match(female.text, /as a factor variable, i\.female/);
  assert.doesNotMatch(female.text, /not in the last model/);
  assert.equal(female.fix, "test 1.female");
  runs(female.fix);
  const lincom = hint("lincom female");
  assert.match(lincom.text, /1\.female/);
  assert.equal(lincom.fix, "lincom 1.female");
  runs(lincom.fix);
  runs("regress wage i.grp");
  const grp = hint("test grp");
  assert.equal(grp.fix, "test 2.grp 3.grp");
  runs(grp.fix);
  assert.equal(hint("lincom grp").fix, "");
  runs("regress wage c.educ#c.exper");
  const within = hint("test exper");
  assert.match(within.text, /only in c\.educ#c\.exper/);
  assert.equal(within.fix, "test c.educ#c.exper");
  runs(within.fix);
});

test("the missing-value note is given only where the condition counts missing values", () => {
  const { hint } = console_(PEOPLE);
  const NOTE = /wage has 2 missing values/;
  for (const line of [
    "count if wage > 15 & wage < 20",
    "count if wage > 15 & wage <= 20",
    "count if inrange(wage, 15, .) & wage > 15",
    "count if wage > 15 & !missing(wage)",
    "summarize wage if wage > 15",
    "regress wage educ if wage > 15",
    'display "keep if wage > 5"',
    "list id if wage >= 20 & wage <= 21",
  ])
    assert.doesNotMatch(hint(line).text, NOTE, line);
  for (const line of [
    "count if wage > 15",
    "count if educ > 12 & wage > 15",
    "count if 15 < wage",
    "tabulate region if wage > 15",
    "count if wage > 15 | wage < 14",
  ])
    assert.match(hint(line).text, NOTE, line);
  assert.match(hint("count if 15 < wage").text, /so 15 < wage is true/);
});

test("egen in an expression is made first, not swapped for generate (F140)", () => {
  const { hint, runs } = console_(PEOPLE);
  for (const line of [
    "generate dev = wage - mean(wage)",
    "gen z = (wage - mean(wage))/sd(wage)",
  ]) {
    const advice = hint(line);
    assert.equal(advice.rc, 133);
    assert.equal(advice.fix ?? "", "", line);
    assert.match(advice.text, /egen mean_wage = mean\(wage\)/);
  }
  runs("egen mean_wage = mean(wage)");
  runs("generate dev = wage - mean_wage");
  const alone = hint("bysort grp: gen gm = mean(wage)");
  assert.equal(alone.fix, "bysort grp: egen gm = mean(wage)");
  runs(alone.fix);
});

test("a single = against a number or a value label's word (F50)", () => {
  const { hint, runs } = console_(PEOPLE);
  const city = hint("count if city=5");
  assert.equal(city.rc, 109);
  assert.equal(city.fix ?? "", "");
  assert.match(city.text, /city holds text, so it is compared with text/);
  const female = hint("count if female=Female");
  assert.equal(female.rc, 101);
  assert.equal(female.fix, "count if female == 1");
  runs(female.fix);
  const word = hint("count if educ=twelve");
  assert.equal(word.fix ?? "", "");
  assert.match(word.text, /twelve is not a variable/);
  const quoted = hint("count if city=Boston & wage>5");
  assert.equal(quoted.fix, 'count if city == "Boston" & wage>5');
  runs(quoted.fix);
});

test("r(459) from merge fits the match typed", () => {
  const { hint, runs } = console_(`${PEOPLE}\nsave people, replace`);
  const m1 = hint("merge m:1 grp using people");
  assert.equal(m1.rc, 459);
  assert.match(
    m1.text,
    /^m:1 needs one observation for each grp in the using data/,
  );
  assert.match(m1.text, /joinby grp using people forms every pair/);
  assert.doesNotMatch(m1.text, /a 1:1 match/);
  const onem = hint("merge 1:m grp using people");
  assert.match(
    onem.text,
    /^1:m needs one observation for each grp in the data in memory/,
  );
  assert.match(onem.text, /the match is m:1; if grp repeats in both/);
  assert.match(
    hint("merge 1:1 grp using people").text,
    /so a 1:1 match is not possible/,
  );
  runs("preserve");
  runs("joinby grp using people");
  runs("restore");
});

test("reshape: 'already long' with the data still wide, and j() kept apart from i() (F137)", () => {
  const { hint, runs } = console_(
    [
      "clear",
      "input id inc2000 inc2001 year",
      "1 5 6 1",
      "2 7 8 2",
      "end",
    ].join("\n"),
  );
  const named = hint("reshape long inc, i(id) j(year)");
  assert.equal(named.rc, 110);
  assert.match(named.text, /The data are still wide \(inc2000 and inc2001/);
  assert.doesNotMatch(named.text, /reshape has been done/);
  runs("reshape long inc, i(id) j(yr)");
  assert.match(
    hint("reshape long inc, i(id) j(yr)").text,
    /already long: the reshape has been done/,
  );
  const wide = console_(
    [
      "clear",
      "input grp t x w v",
      "1 1 5 1 3",
      "1 2 6 2 3",
      "2 1 7 1 4",
      "2 2 8 1 5",
      "end",
      "reshape wide x w v, i(grp) j(t)",
      "reshape long x, i(grp) j(t)",
    ].join("\n"),
  );
  const typo = wide.hint("reshape wide x, i(t) j(w)");
  assert.equal(typo.rc, 111);
  assert.doesNotMatch(typo.text, /\bt\b,/);
  assert.equal(typo.fix ?? "", "");
});

test("input without end is told about end, not about { and } (F132)", () => {
  const { hint } = console_();
  const file = hint("clear\ninput x y\n1 2\n3 4", { doFile: true });
  assert.equal(file.rc, 612);
  assert.match(
    file.text,
    /^input reads the values .* Put end on a line of its own/,
  );
  const typed = console_().hint("input x");
  assert.equal(typed.rc, 612);
  assert.match(typed.text, /^input reads the values/);
  assert.match(hint("clear\ninp x\n1", { doFile: true }).text, /^input reads/);
});

test("only Stata's immediate commands are called immediate forms (F45)", () => {
  const { hint, runs } = console_(PEOPLE);
  const count = hint("counti if wage > 5");
  assert.equal(count.rc, 199);
  assert.doesNotMatch(count.text, /immediate/);
  assert.equal(count.fix, "count if wage > 5");
  runs(count.fix);
  for (const line of ["testi educ", "listi in 1"])
    assert.doesNotMatch(hint(line).text, /immediate/, line);
  assert.match(
    hint("ztesti 30 5 1 4").text,
    /^ztesti is the immediate form of ztest/,
  );
});

test("a worksheet that is not found is not a missing file", () => {
  const { hint, runs } = console_(
    `${PEOPLE}\nexport excel using book.xlsx, sheet("Data") firstrow(variables) replace`,
  );
  const sheet = hint('import excel using book.xlsx, sheet("data") clear');
  assert.equal(sheet.rc, 601);
  assert.match(sheet.text, /no worksheet called data/);
  assert.match(sheet.text, /import excel using book\.xlsx, describe/);
  assert.doesNotMatch(sheet.text, /No file or dataset/);
  runs("import excel using book.xlsx, describe");
});

test("a number given to a string variable is made text, not encoded (F160)", () => {
  const { hint, runs } = console_(PEOPLE);
  const educ = hint("replace city = educ in 1");
  assert.equal(educ.rc, 109);
  assert.doesNotMatch(educ.text, /encode/);
  assert.equal(educ.fix, "replace city = string(educ) in 1");
  runs(educ.fix);
  const big = hint("replace region = 1e3 in 3");
  assert.equal(big.fix, 'replace region = "1000" in 3');
  runs(big.fix);
});

test("display of a misspelt variable offers the variable (F131)", () => {
  const { hint, runs } = console_(PEOPLE);
  const subscripted = hint("display wge[1]");
  assert.equal(subscripted.rc, 111);
  assert.equal(subscripted.fix, "display wage[1]");
  runs(subscripted.fix);
  assert.equal(hint("display wagee").fix, "display wage");
  // A word near no variable is still told to go in quotes.
  assert.match(hint("display hello").text, /put it in quotes/);
});

test("a global macro is shown as typed in the quoting advice", () => {
  const { hint, runs } = console_(`${PEOPLE}\nglobal g Boston`);
  const advice = hint("count if city == $g");
  assert.equal(advice.rc, 111);
  assert.match(advice.text, /as "\$g"/);
  assert.doesNotMatch(advice.text, /`name'/);
  runs('count if city == "$g"');
  const local = hint("local c Boston\ncount if city == `c'", { doFile: true });
  assert.match(local.text, /as "`c'"/);
});

test("an option inside a loop is advised on by the command that has it", () => {
  const { hint } = console_(PEOPLE);
  const loop = hint(
    [
      "forvalues i = 1/2 {",
      "  capture regress wage educ, bogus",
      "  summarize wage, bogus",
      "}",
    ].join("\n"),
    { doFile: true },
  );
  assert.equal(loop.rc, 198);
  assert.match(loop.text, /^summarize/);
  assert.doesNotMatch(loop.text, /forvalues/);
  assert.equal(loop.fix ?? "", "");
});
