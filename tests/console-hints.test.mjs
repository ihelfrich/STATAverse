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
import { HELP, helpUrl } from "../src/console-help.js";
import { replaceValue } from "../src/console-browse.js";
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
  assert.match(advise("xi: regress y i.g").text, /Factor variables/);
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
  assert.equal(output.at(-1).rc, 109);
  assert.match(advice.text, /^score is stored as text/);
  assert.equal(advice.fix, "destring score, replace");
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
    assert.ok(names.includes(name), `${name} is not registered`);
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
  assert.equal(replaceValue('say "hi"', text), '`"say "hi""\'');
});
