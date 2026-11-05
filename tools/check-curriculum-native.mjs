import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LESSONS } from "../src/lessons.js";
import { PracticeSession } from "../src/engine.js";
import { createDataset } from "../src/datasets.js";

const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-curriculum-native-"),
);
const stata = "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp";
const quote = (value) =>
  typeof value === "string"
    ? `"${value}"`
    : value === null
      ? "."
      : String(value);
function inputFor(id) {
  const d = createDataset(id);
  return [
    "clear",
    `input ${d.columns.map((c) => `${c.type === "string" ? "str20" : "double"} ${c.name}`).join(" ")}`,
    ...d.rows.map((row) => d.columns.map((c) => quote(row[c.name])).join(" ")),
    "end",
  ].join("\n");
}
const results = [];
for (const lesson of LESSONS) {
  const destination = path.join(folder, lesson.id);
  await fs.mkdir(destination);
  const session = new PracticeSession(lesson.dataset);
  const lines = [inputFor(lesson.dataset)];
  let numericChecks = 0;
  for (const [index, step] of lesson.steps.entries()) {
    const result = session.run(step.command).at(-1);
    let command = step.command.replace(
      /import delimited using "(study|wages|clinic)\.csv", clear/g,
      (_, id) => inputFor(id),
    );
    lines.push(`* Step ${index + 1}: ${step.title}`);
    if (result.kind === "error") {
      lines.push(`capture noisily ${command}`, `assert _rc == ${result.code}`);
    } else lines.push(command);
    if (step.response) {
      const p = step.response.resultPath;
      let expression;
      if (p[0] === "n") expression = "r(N)";
      else if (p[0] === "stats")
        expression = `r(${p.at(-1) === "n" ? "N" : p.at(-1)})`;
      else if (p[0] === "model")
        expression =
          p[1] === "n" ? "e(N)" : `_b[${result.model.coefficients[p[2]].name}]`;
      else if (p[0] === "value")
        expression = step.command.replace(/^display\s+/, "");
      else if (p[0] === "rows")
        expression = `${result.names[p[3]]}[${p[1] + 1}]`;
      else throw new Error(`Unverified response path in ${lesson.id}`);
      lines.push(
        `assert abs((${expression}) - (${step.response.expected})) < 1e-9`,
      );
      numericChecks++;
    }
  }
  lines.push(`assert _N == ${session.data.rows.length}`);
  for (const [i, row] of session.data.rows.entries()) {
    for (const column of session.data.columns) {
      const value = row[column.name];
      lines.push(
        value === null || typeof value === "string"
          ? `assert ${column.name} == ${quote(value)} in ${i + 1}`
          : `assert abs(${column.name} - (${value})) < 1e-8 in ${i + 1}`,
      );
    }
  }
  await fs.writeFile(
    path.join(destination, "candidate.do"),
    lines.join("\n") + "\n",
  );
  await fs.writeFile(
    path.join(destination, "audit.do"),
    [
      "set processors 1",
      'capture noisily do "candidate.do"',
      "local result = _rc",
      'file open receipt using "receipt.txt", write text replace',
      'file write receipt "`result\'" _n',
      "file close receipt",
      "exit, clear",
      "",
    ].join("\n"),
  );
  let code;
  try {
    await promisify(execFile)(stata, ["-b", "do", "audit.do"], {
      cwd: destination,
      timeout: 30000,
    });
    code = (
      await fs.readFile(path.join(destination, "receipt.txt"), "utf8")
    ).trim();
  } catch (error) {
    code = error.killed ? "timeout" : "execution or receipt failure";
  }
  results.push({
    lesson: lesson.id,
    steps: lesson.steps.length,
    numericChecks,
    finalRows: session.data.rows.length,
    returnCode: code,
  });
  console.log(JSON.stringify(results.at(-1)));
}
await fs.writeFile(
  "docs/verification/curriculum-native.json",
  JSON.stringify(
    {
      method:
        "Native Stata execution of all canonical lesson commands, numeric answers and final data checks",
      limits: [
        "Native input substitutes Java-backed CSV import on this machine.",
        "Does not validate every alternative student command, accessibility or mastery.",
        "Preserve is explicitly restored within one enclosing native do-file; browser Run actions use a persistent interactive scope.",
      ],
      results,
    },
    null,
    2,
  ) + "\n",
);
if (results.some((result) => result.returnCode !== "0")) {
  console.log(
    `Inspect only failing command regions in ${folder}; startup logs contain private license metadata.`,
  );
  process.exitCode = 1;
}
