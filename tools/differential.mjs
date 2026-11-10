// Runs every lesson's commands through the frozen interpreter (src/engine.js)
// and the new runtime (src/runtime/session.js) and reports where they part.
// This is the differential harness of docs/runtime-and-courses-spec.md: new
// sessions move to the new runtime only when the differences listed here are
// the intended ones.
import fs from "node:fs/promises";
import { PracticeSession } from "../src/engine.js";
import { LESSONS } from "../src/lessons.js";
import { DATASETS, createDataset, toCSV } from "../src/datasets.js";
import { addTextFile } from "../src/runtime/delimited.js";
import { Session } from "../src/runtime/session.js";
import { Dataset } from "../src/runtime/store.js";
import { isMissing } from "../src/runtime/values.js";

const same = (a, b) => a === b || (a === null && b === null);
// The new runtime stores generate's results as float, as Stata does; the
// old interpreter kept doubles. Values that agree to single precision are
// counted separately from values that are identical.
const single = (a, b) =>
  typeof a === "number" &&
  typeof b === "number" &&
  Math.abs(a - b) <= 6e-8 * Math.max(Math.abs(a), Math.abs(b), 1e-30);

function compareData(legacy, runtime) {
  const names = legacy.columns.map((c) => c.name);
  if (names.join(" ") !== runtime.names.join(" "))
    return {
      status: "different",
      detail: `variables [${names}] vs [${runtime.names}]`,
    };
  if (legacy.rows.length !== runtime.n)
    return {
      status: "different",
      detail: `observations ${legacy.rows.length} vs ${runtime.n}`,
    };
  let rounded = false;
  for (const name of names) {
    const column = runtime.get(name).data;
    for (let i = 0; i < runtime.n; i++) {
      const a = legacy.rows[i][name] ?? null,
        raw = column[i],
        b =
          typeof raw === "number"
            ? isMissing(raw)
              ? null
              : raw
            : raw === ""
              ? null
              : raw,
        left = a === "" ? null : a;
      if (same(left, b)) continue;
      if (single(left, b)) rounded = true;
      else
        return {
          status: "different",
          detail: `${name}[${i + 1}]: ${left} vs ${b}`,
        };
    }
  }
  return { status: rounded ? "float" : "same" };
}

export function compareLesson(lesson) {
  const legacy = new PracticeSession(lesson.dataset),
    runtime = new Session();
  runtime.data = Dataset.fromRows(createDataset(lesson.dataset));
  for (const [id, data] of Object.entries(DATASETS))
    addTextFile(runtime, data.file ?? `${id}.csv`, toCSV(createDataset(id)));
  const steps = [];
  for (const step of lesson.steps) {
    if (!step.command) continue;
    const before = legacy.run(step.command),
      error = before.find((r) => r.kind === "error"),
      after = runtime.run(step.command),
      entry = {
        command: step.command,
        legacy: error ? (error.code ?? 198) : 0,
        runtime: after.rc,
      };
    if (!entry.legacy && !entry.runtime)
      Object.assign(entry, compareData(legacy.data, runtime.data));
    else if (entry.legacy && entry.runtime) entry.status = "both refuse";
    else entry.status = entry.runtime ? "runtime refuses" : "legacy refuses";
    if (entry.status === "runtime refuses")
      entry.detail = after.output.at(-1)?.lines.at(-2) ?? "";
    steps.push(entry);
    // Once the engines disagree about whether a command ran, later steps of
    // the lesson no longer start from the same data.
    if (
      ["runtime refuses", "legacy refuses", "different"].includes(entry.status)
    )
      break;
  }
  return { lesson: lesson.id, dataset: lesson.dataset, steps };
}

export function compareAll() {
  const lessons = LESSONS.map(compareLesson),
    steps = lessons.flatMap((l) => l.steps),
    tally = (status) => steps.filter((s) => s.status === status).length;
  return {
    basis:
      "Every command of every lesson, run in order through the frozen interpreter and the new runtime from the same starting data. A lesson stops at the first command only one of them runs.",
    commands: steps.length,
    same: tally("same"),
    sameToSinglePrecision: tally("float"),
    bothRefuse: tally("both refuse"),
    runtimeRefuses: tally("runtime refuses"),
    legacyRefuses: tally("legacy refuses"),
    different: tally("different"),
    lessons,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = compareAll();
  if (process.argv.includes("--write"))
    await fs.writeFile(
      "docs/verification/runtime-differential.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  const { lessons, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  for (const l of lessons)
    for (const s of l.steps)
      if (!["same", "float", "both refuse"].includes(s.status))
        console.log(
          `${l.lesson}: ${s.status}: ${s.command}${s.detail ? " — " + s.detail : ""}`,
        );
}
