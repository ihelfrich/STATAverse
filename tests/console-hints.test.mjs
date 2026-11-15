// The Console's hints under a failed command, its help index and the data
// browser's view of the data. The messages hinted at are the runtime's own;
// none of this changes what a command prints.
import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/runtime/commands.js";
import {
  adviseRecord,
  commandParts,
  distance,
  nearest,
  resolveCommand,
  swap,
} from "../src/console-hints.js";
import { HELP, LANGUAGE, helpUrl } from "../src/console-help.js";
import { editText, replaceValue } from "../src/console-browse.js";
import { createConsoleSession } from "../src/console-session.js";

const names = [...new Set(COMMANDS.map((command) => command.name))];
const advise = (command, variables = []) => {
  const session = createConsoleSession();
  const { output } = session.run(command);
  return adviseRecord(output.at(-1), { commands: COMMANDS, variables });
};

test("distance counts an adjacent swap once", () => {
  assert.equal(distance("tabluate", "tabulate"), 1);
  assert.equal(distance("summarise", "summarize"), 1);
  assert.equal(distance("", "abc"), 3);
});

test("nearest puts a name in other capitals first, then close spellings", () => {
  assert.deepEqual(nearest("Score", ["score", "scores", "core"]), [
    "score",
    "core",
    "scores",
  ]);
  assert.deepEqual(nearest("id", ["studentid", "group"]), ["studentid"]);
  assert.deepEqual(nearest("zzzz", names), []);
});

test("an unrecognized command suggests the nearest commands that run here", () => {
  const advice = advise("summarise score");
  assert.match(advice.text, /^Did you mean summarize\b/);
  assert.equal(advice.help, "summarize");
  assert.equal(advice.fix, "summarize score");
  // Every suggestion is a command that runs here.
  for (const typed of ["tabluate", "regresss", "destrng", "xtrge"])
    for (const name of advise(`${typed} x`).suggest)
      assert.ok(names.includes(name), `${typed}: ${name}`);
});

test("a community package names what runs here in its place", () => {
  const advice = advise("esttab m1 m2");
  assert.match(advice.text, /community-contributed package/);
  assert.ok(advice.suggest.length);
  for (const name of advice.suggest) assert.ok(names.includes(name), name);
  assert.match(advise("reghdfe y x, absorb(id)").text, /areg/);
  // xi runs here now, so it is not advised away.
  assert.ok(names.includes("xi"));
});

test("the common mistakes of a first session have particular hints", () => {
  const study = createConsoleSession();
  study.run("sysuse study, clear");
  const variables = study.peek({ count: 0 }).columns;
  const on = (command) =>
    adviseRecord(study.run(command).output.at(-1), {
      commands: COMMANDS,
      variables,
    });
  assert.match(advise("summarize score").text, /no data in memory/);
  assert.equal(on("summarize Score").fix, "summarize score");
  assert.match(on("summarize Score").text, /case-sensitive/);
  assert.equal(on("count if hours = 2").fix, "count if hours == 2");
  assert.equal(
    on("summarize score if hours = 2").fix,
    "summarize score if hours == 2",
  );
  assert.equal(
    on("regress score hours, robsut").fix,
    "regress score hours, robust",
  );
  assert.match(on("generate score = 1").text, /replace score/);
  assert.match(on("sysuse auto").text, /StataCorp/);
});

test("a string variable in a model is named, with destring to fix it", () => {
  const session = createConsoleSession();
  session.addFile(
    "survey.csv",
    new TextEncoder().encode("hours,score\n2,55\n3,NA\n4,61\n"),
  );
  session.run("import delimited survey.csv, clear");
  const variables = session.peek({ count: 0 }).columns,
    { output } = session.run("regress score hours"),
    advice = adviseRecord(output.at(-1), { commands: COMMANDS, variables });
  // Stata 19 counts a string variable as missing in regress: r(2000).
  assert.equal(output.at(-1).rc, 2000);
  assert.match(advice.text, /^score is stored as text/);
  // NA is in score, so destring without force would change nothing.
  assert.equal(advice.fix, "destring score, replace force");
});

// The fix a hint offers is run here and must work. What destring does on
// these columns was recorded from Stata 19 (case pass7-ux-destring-hint):
// without ignore(",") and force it prints "contains nonnumeric characters;
// no replace" for both and changes nothing.
test("the destring a hint offers works on NA and on thousands commas", () => {
  const session = createConsoleSession();
  session.addFile(
    "survey.csv",
    'id,income,score\n1,"1,200",55\n2,"2,500",NA\n3,800,61\n4,"1,050",70\n',
  );
  session.run("import delimited survey.csv, clear");
  const failed = session.run("regress score income"),
    advice = adviseRecord(failed.output.at(-1), {
      commands: COMMANDS,
      variables: failed.memory.variables,
    });
  assert.equal(advice.fix, 'destring score income, replace ignore(",") force');
  assert.match(advice.text, /"NA" for a missing value and commas/);
  // regress finds no observations, r(2000); poisson refuses the string
  // variable in its varlist, r(109), as Stata 19 does (case
  // pass7-ux-strings-in-models). The hint is the same.
  assert.equal(failed.output.at(-1).rc, 2000);
  const poisson = session.run("poisson score income");
  assert.equal(poisson.output.at(-1).rc, 109);
  assert.equal(
    adviseRecord(poisson.output.at(-1), {
      commands: COMMANDS,
      variables: poisson.memory.variables,
    }).fix,
    advice.fix,
  );
  const fixed = session.run(advice.fix);
  assert.equal(fixed.rc, 0);
  assert.deepEqual(fixed.output.at(-1).lines, [
    "score: contains nonnumeric characters not specified in ignore(); replaced as byte",
    "(1 missing value generated)",
    "income: character , removed; replaced as int",
  ]);
  assert.equal(session.run("regress score income").rc, 0);
});

test("a string of words gets == with quotes or encode, never force", () => {
  const session = createConsoleSession();
  session.run(
    'clear\nset obs 4\ngenerate str6 sex = cond(mod(_n,2),"male","female")\ngenerate str6 n = cond(_n == 2, "twenty", string(_n))',
    { doFile: true },
  );
  const advise = (command) => {
    const ran = session.run(command);
    return adviseRecord(ran.output.at(-1), {
      commands: COMMANDS,
      variables: ran.memory.variables,
    });
  };
  const words = advise("generate male = (sex == 1)");
  assert.match(words.text, /sex == "male"/);
  assert.match(words.text, /encode sex/);
  assert.doesNotMatch(words.text, /force/);
  assert.equal(words.fix, "");
  assert.equal(words.help, "encode");
  // Mostly numbers, one word: correct it first; no button wipes it.
  const mixed = advise("summarize n if n > 1");
  assert.match(mixed.text, /such as "twenty"/);
  assert.equal(mixed.fix, "");
  // A decimal comma is not taken for a thousands separator.
  session.run('replace n = "1,5" in 2');
  assert.equal(advise("summarize n if n > 1").fix, "");
});

// Messages recorded from Stata 19 (case pass7-ux-error-messages).
test("each return code's hint fits the message it is under", () => {
  const session = createConsoleSession();
  session.run(
    'clear\nset obs 4\ngenerate id = _n\ngenerate income = 100 * _n\ngenerate str6 sex = cond(mod(_n,2),"male","female")',
    { doFile: true },
  );
  const advise = (command) => {
    const ran = session.run(command),
      record = ran.output.at(-1);
    return {
      record,
      ...adviseRecord(record, {
        commands: COMMANDS,
        variables: ran.memory.variables,
      }),
    };
  };
  const ifNot = advise("describe if income > 1");
  assert.deepEqual(ifNot.record.lines, ["if not allowed", "r(101);"]);
  assert.match(ifNot.text, /^describe does not take an if condition/);
  assert.match(advise("list income [fw=id]").text, /does not take weights/);
  const inNot = advise("describe in 1/2");
  assert.deepEqual(inNot.record.lines, ["in range not allowed", "r(101);"]);
  assert.match(inNot.text, /does not take in/);
  const open = advise("tabstat income, stat(mean) by(sex");
  assert.deepEqual(open.record.lines, [") required", "r(100);"]);
  assert.match(open.text, /not closed/);
  assert.equal(open.fix, "tabstat income, stat(mean) by(sex)");
  assert.equal(session.run(open.fix).rc, 0);
  assert.equal(
    advise("regress income id, cluster(sex").fix,
    "regress income id, cluster(sex)",
  );
  // Two brackets open: where the close goes is not guessed.
  assert.equal(advise("tabstat income, by(sex stat(mean)").fix ?? "", "");
  // Options are suggested from the command's own.
  const detial = advise("tabulate sex, detial");
  assert.equal(detial.fix, "");
  assert.doesNotMatch(detial.text, /detail/);
  assert.doesNotMatch(advise("summarize income, rbust").text, /robust/);
  assert.equal(
    advise("summarize income, detial").fix,
    "summarize income, detail",
  );
  // Names in expressions, which Stata reports without "variable".
  const income = advise("replace income = Income + 1");
  assert.deepEqual(income.record.lines, ["Income not found", "r(111);"]);
  assert.match(income.text, /the variable is called income/);
  assert.equal(income.fix, "replace income = income + 1");
  assert.equal(advise("generate y = incme * 2").fix, "generate y = income * 2");
  assert.match(advise("summarize i").text, /id and income/);
  session.run("clear");
  assert.match(advise("count if x > 1").text, /no data in memory/);
});

test("an error inside a loop offers no fix of the loop's first line", () => {
  const session = createConsoleSession();
  const ran = session.run(
    "clear\nset obs 3\ngenerate income = _n\nforeach v in incme {\n  summarize `v'\n}",
    { doFile: true },
  );
  const advice = adviseRecord(ran.output.at(-1), {
    commands: COMMANDS,
    variables: ran.memory.variables,
  });
  assert.match(advice.text, /Did you mean income\?/);
  assert.equal(advice.fix, undefined);
});

test("browse and edit expand macros and take nolabel, as Stata reads them", () => {
  const session = createConsoleSession();
  session.run(
    'clear\nset obs 3\ngenerate id = _n\ngenerate score = _n * 10\nlabel define yn 1 "yes"\nlabel values id yn',
    { doFile: true },
  );
  session.run("local v id score");
  const opened = session.run("browse `v'").output.at(-1);
  assert.deepEqual(opened.opened, { where: "id score", labels: true });
  assert.equal(session.peek({ where: opened.opened.where }).columns.length, 2);
  assert.deepEqual(session.run("edit id, nolabel").output.at(-1).opened, {
    where: "id",
    labels: false,
  });
  assert.equal(session.peek({ where: "id score, nolabel" }).columns.length, 2);
  const missing = session.run("browse nosuch").output.at(-1);
  assert.equal(missing.rc, 111);
  assert.equal(missing.opened, undefined);
  assert.equal(session.run("browse id, foo").rc, 198);
});

test("Go to row past the end shows the last page, in step with the rest", () => {
  const session = createConsoleSession();
  session.run("clear\nset obs 300", { doFile: true });
  const past = session.peek({ from: 9998, count: 100 });
  assert.equal(past.from, 200);
  assert.equal(past.past, true);
  assert.equal(past.rows.length, 100);
  assert.equal(session.peek({ from: 100, count: 100 }).past, false);
});

test("commandParts and resolveCommand read a line as the session does", () => {
  assert.deepEqual(commandParts("quietly by group: reg y x"), {
    word: "reg",
    rest: " y x",
  });
  assert.equal(resolveCommand("reg", COMMANDS), "regress");
  assert.equal(resolveCommand("su", COMMANDS), "summarize");
  assert.equal(
    swap("merge 1:1 id using id_file", "id", "key"),
    "merge 1:1 key using id_file",
  );
});

test("every help entry is a registered command, with Stata's help linked", () => {
  for (const [name, [summary, syntax]] of Object.entries(HELP)) {
    assert.ok(
      names.includes(name) || LANGUAGE.some((word) => word.name === name),
      `${name} is not registered`,
    );
    assert.ok(summary.endsWith("."), name);
    assert.ok(syntax.length, name);
  }
  assert.equal(helpUrl("regress"), "https://www.stata.com/help.cgi?regress");
  assert.equal(helpUrl("if"), "https://www.stata.com/help.cgi?ifcmd");
});

test("the browser's view sorts, finds and shows value labels", () => {
  const session = createConsoleSession();
  session.run(
    'sysuse study, clear\nlabel define yes 0 "no" 1 "yes"\ngenerate passed = score >= 60 if score < .\nlabel values passed yes',
    { doFile: true },
  );
  const all = session.peek({ count: 3 });
  assert.equal(all.shown, 24);
  assert.deepEqual(
    all.columns.map((c) => c.name),
    ["id", "hours", "attendance", "score", "group", "passed"],
  );
  assert.deepEqual(all.rows[0].cells, ["1", "2", "65", "48", "A", "no"]);
  assert.deepEqual(
    session.peek({ count: 1, labels: false }).rows[0].cells.at(-1),
    "0",
  );
  const top = session.peek({
    where: "id score if score < .",
    order: { name: "score", descending: true },
    count: 2,
  });
  assert.deepEqual(
    top.columns.map((c) => c.name),
    ["id", "score"],
  );
  assert.ok(top.rows[0].raw[1] >= top.rows[1].raw[1]);
  assert.equal(
    session.peek({ find: "yes" }).shown,
    session.peek({ where: "if passed == 1" }).shown,
  );
  // The data in memory keep their order.
  assert.deepEqual(session.peek({ count: 1 }).rows[0].obs, 1);
  // A missing value is shown as Stata shows it, and has no raw value.
  const missing = session.peek({ where: "if score >= .", count: 1 }).rows[0];
  assert.equal(missing.cells[3], ".");
  assert.equal(missing.raw[3], null);
});

test("the browser's view of 100,000 observations is quick", () => {
  const session = createConsoleSession();
  session.run("clear\nset seed 3\nset obs 100000\ngenerate x = runiform()", {
    doFile: true,
  });
  const started = performance.now();
  const view = session.peek({ order: { name: "x" }, find: ".1", count: 100 });
  assert.ok(view.shown > 0);
  assert.ok(performance.now() - started < 2000);
});

test("a long run reports its progress as it goes", () => {
  const session = createConsoleSession(),
    heard = [];
  const started = Date.now();
  session.run(
    "clear\nset obs 20000\nforvalues i = 1/400 {\n  generate double v`i' = sqrt(_n) * `i'\n}",
    { doFile: true, progress: (where) => heard.push(where) },
  );
  if (Date.now() - started > 300) assert.ok(heard.length > 0);
  for (const each of heard) assert.ok(each.commands > 0 && each.line >= 1);
});

test("a value typed in the browser is written as Stata reads it", () => {
  const number = { type: "float" },
    text = { type: "str8" };
  assert.equal(replaceValue("12.5", number), "12.5");
  assert.equal(replaceValue("", number), ".");
  assert.equal(replaceValue(".a", number), ".a");
  assert.equal(replaceValue("lots", number), null);
  assert.equal(replaceValue("New York", text), '"New York"');
});

// Inside quotes Stata expands $name and `name' and reads a backslash
// before them as an escape: Stata 19 stores "US" for replace name =
// "US$abc", and "a\" for "a\\$x". The commands below, recorded from Stata
// 19 in case pass7-ux-edit-strings, store the text exactly.
test("a string typed in the editor is stored exactly as typed", () => {
  const text = { type: "str10" },
    typed = [
      ["US$abc", '"US" + char(36) + "abc"'],
      ["it's `ok'", `"it's " + char(96) + "ok'"`],
      [
        'say "hi" $x \\`y\'',
        '"say " + char(34) + "hi" + char(34) + " " + char(36) + "x \\" + char(96) + "y\'"',
      ],
      ["C:\\$tmp\\", '"C:\\" + char(36) + "tmp\\"'],
      ["", '""'],
      ['$`"', "char(36) + char(96) + char(34)"],
      ["a\\b", '"a\\b"'],
    ];
  const session = createConsoleSession();
  session.run('clear\nset obs 8\ngenerate str10 name = "abc"', {
    doFile: true,
  });
  typed.forEach(([value, expression], k) => {
    assert.equal(replaceValue(value, text), expression);
    assert.equal(session.run(`replace name = ${expression} in ${k + 2}`).rc, 0);
    assert.equal(session.peek({ from: k + 1, count: 1 }).rows[0].raw[0], value);
  });
});

test("a float is offered for change as the decimal it was made from", () => {
  assert.equal(editText(Math.fround(4.1), "float"), "4.1");
  assert.equal(editText(Math.fround(0.1), "float"), "0.1");
  assert.equal(editText(Math.fround(123456.7), "float"), "123456.7");
  assert.equal(editText(Math.fround(16777217), "float"), "16777216");
  assert.equal(editText(4.1, "double"), "4.1");
  assert.equal(editText(null, "float"), ".");
  assert.equal(editText("abc", "str3"), "abc");
});

test("r(119) is advised on by what is out of context", async () => {
  const { createConsoleSession } = await import("../src/console-session.js");
  const { adviseRecord } = await import("../src/console-hints.js");
  const cases = [
    ["continue", /inside a loop/],
    ["sysuse study, clear\nsts list", /stset/],
    ["sysuse study, clear\nsvy: mean score", /svyset/],
  ];
  for (const [source, pattern] of cases) {
    const session = createConsoleSession();
    const { output } = session.run(source);
    const record = output.at(-1);
    assert.equal(record.rc, 119, source);
    const advice = adviseRecord(record, { commands: [], variables: [] });
    assert.match(advice.text, pattern, source);
    assert.doesNotMatch(advice.text, /different kind of model/);
  }
});
