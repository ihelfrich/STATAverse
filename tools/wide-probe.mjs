// The wide probe: what a student might type, run through the Console's
// runtime, sorted into four outcomes.
//
//   pass     the command finished and every assertion on it held
//   refused  the command stopped with a return code
//   wrong    the command finished but an assertion failed: it printed or drew
//            something other than what Stata would
//   crash    the runtime threw a JavaScript error instead of a StataError
//
// Cases are in tools/wide-probe-cases.txt. A line `@ <expression>` after a
// case is an assertion on it, evaluated with these names in scope:
//
//   rc           the return code of the whole run
//   text         every output line, joined with newlines
//   svg          the SVG of the last graph drawn ("" if none)
//   description  the text description of that graph ("" if none)
//   graphs       how many graphs the run drew
//   run(cmd)     the same names for `cmd` run in a fresh session on the same
//                dataset and setup, for comparing with and without an option
//
// "Ran" is not "agrees with Stata"; the recorded fixtures under tests/ are
// what establish agreement. Assertions exist to catch what a return code
// cannot: an option accepted and ignored, a graph drawn as something else.
//
//   node tools/wide-probe.mjs            counts by outcome and group
//   node tools/wide-probe.mjs --list     also every case not passing
//   node tools/wide-probe.mjs --write    also rewrite the receipt in
//                                        docs/verification/wide-probe.json
//   node tools/wide-probe.mjs --drill labor ["setup;;lines"]
//                                        run each line of standard input
//                                        alone and print what it printed
import fs from "node:fs";
import { createConsoleSession } from "../src/console-session.js";

const casesFile = new URL("./wide-probe-cases.txt", import.meta.url);
const receiptFile = new URL(
  "../docs/verification/wide-probe.json",
  import.meta.url,
);
const lines = (s) => s.split(";;").join("\n");

export function readCases(source = fs.readFileSync(casesFile, "utf8")) {
  const cases = [];
  for (const raw of source.split("\n")) {
    if (!raw.trim() || raw.startsWith("#")) continue;
    if (raw.startsWith("@ ")) {
      const last = cases.at(-1);
      if (!last) throw new Error(`assertion before any case: ${raw}`);
      last.asserts.push(raw.slice(2).trim());
      continue;
    }
    const [group, dataset, setup, ...rest] = raw.split("|");
    cases.push({
      group,
      dataset,
      setup,
      command: rest.join("|"),
      asserts: [],
    });
  }
  return cases;
}

export const caseKey = (c) => `${c.dataset}|${c.setup}|${c.command}`;

function execute(dataset, setup, command) {
  const session = createConsoleSession();
  session.reset(dataset);
  if (setup) {
    const before = session.run(lines(setup));
    if (before.rc) return { setupFailed: true, out: before };
  }
  return { out: session.run(lines(command)) };
}

function view(out) {
  const drawn = out.output.filter((o) => o.graph);
  const graph = drawn.at(-1)?.graph;
  return {
    rc: out.rc,
    text: out.output.flatMap((o) => o.lines ?? []).join("\n"),
    svg: graph?.svg ?? "",
    description: graph?.description ?? "",
    graphs: drawn.length,
  };
}

function judge(c) {
  const result = { group: c.group, key: caseKey(c) };
  let out;
  try {
    const done = execute(c.dataset, c.setup, c.command);
    if (done.setupFailed) {
      const last = done.out.output.at(-1)?.lines ?? [];
      return {
        ...result,
        outcome: "crash",
        detail: `setup failed: ${last.join(" ").slice(0, 160)}`,
      };
    }
    out = done.out;
  } catch (error) {
    return {
      ...result,
      outcome: "crash",
      detail: String(error?.stack ?? error)
        .split("\n")
        .slice(0, 2)
        .join(" | ")
        .slice(0, 240),
    };
  }
  if (out.rc) {
    const bad = out.output.find((o) => o.rc);
    return {
      ...result,
      outcome: "refused",
      rc: out.rc,
      detail: (bad?.lines ?? []).join(" ").slice(0, 160),
    };
  }
  const scope = view(out);
  const run = (command) => view(execute(c.dataset, c.setup, command).out);
  for (const expression of c.asserts) {
    let held;
    try {
      held = Function(
        "rc",
        "text",
        "svg",
        "description",
        "graphs",
        "run",
        `return (${expression});`,
      )(scope.rc, scope.text, scope.svg, scope.description, scope.graphs, run);
    } catch (error) {
      return {
        ...result,
        outcome: "wrong",
        detail: `assertion threw: ${expression} (${error.message})`,
      };
    }
    if (!held)
      return { ...result, outcome: "wrong", detail: `failed: ${expression}` };
  }
  return { ...result, outcome: "pass" };
}

export function runProbe(cases = readCases()) {
  return cases.map(judge);
}

export function summarise(results) {
  const counts = { pass: 0, refused: 0, wrong: 0, crash: 0 };
  const groups = {};
  for (const r of results) {
    counts[r.outcome] += 1;
    groups[r.group] ??= { pass: 0, refused: 0, wrong: 0, crash: 0 };
    groups[r.group][r.outcome] += 1;
  }
  return { cases: results.length, ...counts, groups };
}

function drill(dataset, setup = "") {
  const input = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const command of input) {
    let out;
    try {
      out = execute(dataset, setup, command).out;
    } catch (error) {
      console.log(`${command}\n  JS EXCEPTION ${error.message}`);
      continue;
    }
    const v = view(out);
    console.log(`${command}\n  rc ${v.rc}  graphs ${v.graphs}`);
    for (const line of v.text.split("\n").slice(0, 20))
      console.log(`  ${line}`);
    if (v.description) console.log(`  [graph] ${v.description}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === "--drill") {
    drill(args[1] ?? "labor", args[2] ?? "");
  } else {
    const results = runProbe();
    const summary = summarise(results);
    console.log(
      `${summary.cases} cases: ${summary.pass} pass, ${summary.refused} refused, ${summary.wrong} wrong, ${summary.crash} crash`,
    );
    for (const [group, n] of Object.entries(summary.groups))
      console.log(
        `  ${group.padEnd(6)} ${n.pass} pass, ${n.refused} refused, ${n.wrong} wrong, ${n.crash} crash`,
      );
    if (args.includes("--list"))
      for (const r of results.filter((r) => r.outcome !== "pass"))
        console.log(`[${r.outcome}] ${r.key}\n    ${r.detail}`);
    if (args.includes("--write")) {
      const receipt = {
        basis:
          "Each case in tools/wide-probe-cases.txt run in a fresh Console session. Pass means the command finished and every assertion on it held; it does not mean agreement with Stata, which the recorded fixtures establish. The cases are a judgement about what students type, not a sample of student work.",
        ...summary,
        results: results.map(({ key, group, outcome }) => ({
          group,
          outcome,
          key,
        })),
      };
      fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
    }
  }
}
