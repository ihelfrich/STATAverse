import test from "node:test";
import assert from "node:assert/strict";
import { createConsoleSession } from "../src/console-session.js";
import { LIBRARY } from "../src/console-datasets.js";
import {
  KINDS,
  STARTERS,
  addStep,
  build,
  complete,
  linesOf,
  pathTo,
  removeStep,
  restore,
  rootOf,
  script,
  sequence,
} from "../src/console-map-model.js";

// The page runs a map one step at a time, so that is how each is run here.
for (const starter of STARTERS)
  test(`the starting map "${starter.title}" runs without an error`, () => {
    const map = build(starter.tree),
      session = createConsoleSession();
    for (const entry of sequence(map)) {
      assert.ok(!entry.skipped, "every step of a starting map is filled in");
      const result = session.run(entry.lines.join("\n"));
      assert.equal(
        result.rc,
        0,
        `${entry.lines.join(" / ")}: ${result.output.at(-1)?.lines.join(" ")}`,
      );
    }
    assert.equal(createConsoleSession().run(script(map)).rc, 0);
  });

test("a branch that changes the data is undone before the next branch", () => {
  const map = build([
    "data",
    { dataset: "health" },
    ["keep", { condition: "smoker == 1" }, ["look", { how: "summarize" }]],
    ["look", { how: "describe" }],
  ]);
  assert.equal(
    script(map),
    "sysuse health, clear\npreserve\nkeep if smoker == 1\nsummarize\nrestore\ndescribe\n",
  );
  const session = createConsoleSession();
  let last;
  for (const entry of sequence(map)) last = session.run(entry.lines.join("\n"));
  assert.equal(last.memory.observations, 360);
});

test("a branch that only reads the data needs no preserve", () => {
  const map = build([
    "data",
    { dataset: "study" },
    ["look", { how: "summarize" }],
    ["graph", { how: "histogram", y: "score" }],
  ]);
  assert.equal(
    script(map),
    "sysuse study, clear\nsummarize\nhistogram score\n",
  );
});

test("each kind of step writes the Stata it shows", () => {
  const lines = (kind, fields) => linesOf({ kind, fields });
  assert.deepEqual(lines("data", { dataset: "" }), ["clear"]);
  assert.deepEqual(lines("generate", { name: "lw", expression: "ln(wage)" }), [
    "generate lw = ln(wage)",
  ]);
  assert.deepEqual(
    lines("look", { how: "list (first 10 rows)", variables: "" }),
    ["list in 1/10"],
  );
  assert.deepEqual(
    lines("model", {
      command: "xtreg, fe",
      outcome: "y",
      predictors: "x i.year",
      extra: "firm year",
      options: "vce(cluster firm)",
    }),
    ["xtset firm year", "xtreg y x i.year, fe vce(cluster firm)"],
  );
  assert.deepEqual(
    lines("model", {
      command: "areg",
      outcome: "y",
      predictors: "x",
      extra: "school",
      options: "",
    }),
    ["areg y x, absorb(school)"],
  );
  assert.deepEqual(
    lines("model", {
      command: "ivregress 2sls",
      outcome: "y",
      predictors: "",
      extra: "x = z",
      options: ", vce(robust)",
    }),
    ["ivregress 2sls y (x = z), vce(robust)"],
  );
  assert.deepEqual(lines("after", { what: "margins", detail: "group" }), [
    "margins group",
  ]);
  assert.deepEqual(lines("after", { what: "margins", detail: "at(x=(1 2))" }), [
    "margins, at(x=(1 2))",
  ]);
  assert.deepEqual(
    lines("after", { what: "margins, dydx(*)", detail: "at(x=(1 2))" }),
    ["margins, dydx(*) at(x=(1 2))"],
  );
  assert.deepEqual(lines("after", { what: "marginsplot", detail: "left" }), [
    "marginsplot",
  ]);
  assert.deepEqual(lines("command", { text: "count\n\n  list in 1  \n" }), [
    "count",
    "  list in 1",
  ]);
  // A field's line break cannot start a second command.
  assert.deepEqual(lines("keep", { condition: "x > 1\ndrop _all" }), [
    "keep if x > 1 drop _all",
  ]);
});

test("a step that is not filled in writes nothing and is named in the do-file", () => {
  const map = build(["data", { dataset: "study" }, ["generate", {}]]);
  assert.equal(complete(map.steps[1]), false);
  assert.deepEqual(linesOf(map.steps[1]), []);
  assert.match(script(map), /the step "New variable" is not filled in/);
  assert.equal(createConsoleSession().run(script(map)).rc, 0);
});

test("run to here takes only the steps that lead to a step", () => {
  const map = build(STARTERS[1].tree),
    store = map.steps.find((s) => s.fields.what === "estat firststage"),
    path = pathTo(map, store.id).flatMap((entry) => entry.lines);
  assert.deepEqual(path, [
    "sysuse labor, clear",
    "generate lwage = ln(wage)",
    "ivregress 2sls lwage experience female (education = near_college), vce(robust)",
    "estat firststage",
  ]);
});

test("removing a step removes what follows it, and the first step stays", () => {
  const map = build(STARTERS[0].tree),
    before = map.steps.length,
    model = map.steps.find((s) => s.kind === "model");
  removeStep(map, model.id);
  assert.equal(map.steps.length, before - 2);
  removeStep(map, rootOf(map).id);
  assert.ok(rootOf(map));
  const added = addStep(map, rootOf(map).id, "note", { text: "hello" });
  assert.ok(map.steps.every((s) => s.id !== added.id || s.parent === 1));
});

test("a saved map is checked before it is used", () => {
  const map = build(STARTERS[2].tree),
    copy = restore(JSON.parse(JSON.stringify(map)));
  assert.equal(script(copy), script(map));
  assert.equal(restore(null), null);
  assert.equal(restore({ steps: [] }), null);
  assert.equal(
    restore({ steps: [{ id: 1, kind: "nothing", parent: null, fields: {} }] }),
    null,
  );
  // A step cannot follow itself or a later step.
  assert.equal(
    restore({
      steps: [
        { id: 1, kind: "data", parent: null, fields: {} },
        { id: 2, kind: "note", parent: 2, fields: {} },
      ],
    }),
    null,
  );
  // A choice that is no longer offered falls back to the first one.
  const odd = restore({
    steps: [
      { id: 1, kind: "data", parent: null, fields: { dataset: "study" } },
      { id: 2, kind: "look", parent: 1, fields: { how: "explode" } },
    ],
  });
  assert.equal(odd.steps[1].fields.how, KINDS.look.fields[0].options[0]);
});

test("every dataset loads with sysuse and is the same on each visit", () => {
  const sizes = {};
  for (const [id, entry] of Object.entries(LIBRARY)) {
    const result = createConsoleSession().run(`sysuse ${id}, clear\ndescribe`);
    assert.equal(result.rc, 0, id);
    sizes[id] = [result.memory.observations, result.memory.variables.length];
    assert.ok(entry.description.length > 40, id);
    assert.ok(
      result.memory.variables.every((v) => v.label),
      `${id}: every variable has a label`,
    );
  }
  assert.deepEqual(sizes, {
    study: [24, 5],
    wages: [30, 5],
    clinic: [12, 4],
    schools: [480, 9],
    firms: [600, 9],
    trade: [240, 9],
    labor: [600, 11],
    macro: [120, 7],
    health: [360, 10],
  });
  // The simulated data come from a fixed seed: these values do not move.
  const firms = LIBRARY.firms.data.rows;
  assert.equal(
    createConsoleSession().run(
      "sysuse labor, clear\nquietly summarize wage\nassert r(N) == 586\nsysuse health, clear\nquietly count if missing(bp_after)\nassert r(N) == 18",
    ).rc,
    0,
  );
  assert.equal(firms.length, 600);
});

test("the simulated datasets carry the answers their descriptions state", () => {
  const session = createConsoleSession(),
    check = (source) => {
      const result = session.run(source);
      assert.equal(result.rc, 0, result.output.at(-1)?.lines.join(" "));
    };
  check(
    "sysuse schools, clear\nquietly regress posttest treated pretest ses, vce(cluster school)\nassert abs(_b[treated] - 4) < 2 * _se[treated]",
  );
  check(
    "sysuse firms, clear\ngenerate lsales = ln(sales)\nxtset firm year\nquietly xtreg lsales policy i.year, fe\nassert abs(_b[policy] - 0.09) < 2 * _se[policy]",
  );
  check(
    "sysuse trade, clear\ngenerate ldist = ln(distance)\ngenerate lo = ln(gdp_o)\ngenerate ld = ln(gdp_d)\nquietly poisson trade lo ld ldist contig comlang fta, vce(robust)\nassert abs(_b[ldist] + 1) < 2 * _se[ldist]",
  );
  check(
    "sysuse labor, clear\ngenerate lwage = ln(wage)\nquietly regress lwage education experience female\nassert _b[education] > 0.09\nquietly ivregress 2sls lwage experience female (education = near_college)\nassert abs(_b[education] - 0.075) < 2 * _se[education]",
  );
  check(
    "sysuse health, clear\nquietly regress bp_after treated bp_before\nassert abs(_b[treated] + 8) < 2 * _se[treated]",
  );
});
