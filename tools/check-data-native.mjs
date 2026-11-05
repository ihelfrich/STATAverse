import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataReferenceCases } from "./data-reference-cases.mjs";
import {
  mergeData,
  reshapeData,
  dataProject,
  mergeCommand,
  reshapeCommand,
} from "../src/labs/data-model.js";
import { nativeImportCommand } from "../src/import-library.js";
import { isDeepStrictEqual } from "node:util";
const canonical = (rows) => rows.map((row) => JSON.stringify(row)).sort();
const folder = await fs.mkdtemp(
  path.join(os.tmpdir(), "stataverse-data-native-"),
);
const input = (data) =>
  !data.rows.length
    ? [
        "clear",
        "set obs 1",
        ...data.columns.map(
          (c) =>
            `generate ${c.type === "string" ? "str40" : "double"} ${c.name} = ${c.type === "string" ? '""' : "."}`,
        ),
        "drop in 1",
      ].join("\n")
    : [
        "clear",
        "input " +
          data.columns
            .map((c) => `${c.type === "string" ? "str40" : "double"} ${c.name}`)
            .join(" "),
        ...data.rows.map((r) =>
          data.columns
            .map((c) =>
              c.type === "string"
                ? JSON.stringify(r[c.name])
                : r[c.name] === null
                  ? "."
                  : String(r[c.name]),
            )
            .join(" "),
        ),
        "end",
      ].join("\n");
const cases = dataReferenceCases(),
  output = [];
for (const entry of cases) {
  const destination = path.join(folder, entry.id);
  await fs.mkdir(destination);
  let result,
    expectedCode = 0;
  try {
    result =
      entry.mode === "merge"
        ? mergeData(entry.sources.master, entry.sources.using, entry.options)
        : reshapeData(entry.sources, entry.options);
  } catch (error) {
    expectedCode = error.code || 498;
  }
  let candidate;
  if (result) {
    candidate = dataProject(entry.mode, entry.sources, result)["analysis.do"];
    if (entry.mode === "merge")
      candidate = candidate
        .replace(
          nativeImportCommand("using.csv", entry.sources.using),
          input(entry.sources.using),
        )
        .replace(
          nativeImportCommand("master.csv", entry.sources.master),
          input(entry.sources.master),
        );
    else
      candidate = candidate.replace(
        nativeImportCommand("source.csv", entry.sources),
        input(entry.sources),
      );
    const columns = result.data.columns;
    candidate += [
      'file open values using "values.txt", write text replace',
      "if _N > 0 {",
      "forvalues row = 1/`=_N' {",
      "file write values " +
        columns
          .map((c) =>
            c.type === "string"
              ? "(" + c.name + "[`row']) _tab"
              : "%24.17g (" + c.name + "[`row']) _tab",
          )
          .join(" ") +
        " _n",
      "}",
      "}",
      "file close values",
      "",
    ].join("\n");
  } else if (entry.mode === "merge") {
    candidate = [
      input(entry.sources.using),
      'save "using-data.dta", replace',
      input(entry.sources.master),
      mergeCommand(entry.options),
      "",
    ].join("\n");
  } else
    candidate =
      input(entry.sources) + "\n" + reshapeCommand(entry.options) + "\n";
  await fs.writeFile(path.join(destination, "candidate.do"), candidate);
  await fs.writeFile(
    path.join(destination, "audit.do"),
    [
      "set processors 1",
      'capture noisily do "candidate.do"',
      "local rc = _rc",
      'file open receipt using "receipt.txt", write text replace',
      'file write receipt "`rc\'" _n',
      "file close receipt",
      "exit, clear",
      "",
    ].join("\n"),
  );
  await promisify(execFile)(
    "/Applications/Stata/StataMP.app/Contents/MacOS/stata-mp",
    ["-b", "do", "audit.do"],
    { cwd: destination, timeout: 30000 },
  );
  const code = Number(
    (await fs.readFile(path.join(destination, "receipt.txt"), "utf8")).trim(),
  );
  const item = {
    id: entry.id,
    mode: entry.mode,
    code,
    expectedCode,
    columns:
      result?.data.columns.map((c) => ({ name: c.name, type: c.type })) || [],
    rows: [],
  };
  if (code === 0 && result) {
    const raw = await fs.readFile(path.join(destination, "values.txt"), "utf8");
    item.rows = raw.length
      ? raw
          .replace(/\r?\n$/, "")
          .split(/\r?\n/)
          .map((line) =>
            line
              .split("\t")
              .slice(0, item.columns.length)
              .map((v, i) =>
                item.columns[i].type === "string"
                  ? v
                  : v.trim() === "."
                    ? null
                    : Number(v),
              ),
          )
      : [];
  }
  item.valuesMatch =
    code === expectedCode &&
    (code !== 0 ||
      isDeepStrictEqual(
        canonical(item.rows),
        canonical(
          result.data.rows.map((row) => item.columns.map((c) => row[c.name])),
        ),
      ));
  output.push(item);
  console.log(
    JSON.stringify({
      id: entry.id,
      expectedCode,
      code,
      rows: item.rows.length,
    }),
  );
}
await fs.mkdir("tests/fixtures/data-lab", { recursive: true });
await fs.writeFile(
  "tests/fixtures/data-lab/native.json",
  JSON.stringify(
    {
      method:
        "Native Stata execution; explicit input replaces only exported CSV import, with remaining successful export commands unchanged",
      cases: output,
    },
    null,
    2,
  ) + "\n",
);
const failures = output.filter((c) => !c.valuesMatch);
await fs.writeFile(
  "docs/verification/data-native.json",
  JSON.stringify(
    {
      method:
        "Native Stata executes the exported operation with explicit input substituted only for Java-backed CSV import",
      cases: output.length,
      allExpectedReturnCodes: output.every((c) => c.code === c.expectedCode),
      allValuesAndMissingnessMatch: output.every((c) => c.valuesMatch),
      comparison:
        "Exact canonical row values and missingness in these integer/string fixtures; display ordering is ignored",
      coverage: [
        "1:1, m:1 and 1:m; composite, string and missing keys",
        "Unmatched rows, empty retained samples and empty master data",
        "Duplicate-key and type failures",
        "Default overlap, update and update replace with conflict precedence",
        "Long/wide reshape, missing columns/records, varying nonstub attributes and repaired string stubs",
      ],
      limits: [
        "Synthetic finite fixtures, not complete Stata equivalence",
        "Native Java-backed CSV import remains unverified on this machine",
        "Extended missing values, m:m merges, string reshape indexes and additional syntax are unsupported",
      ],
    },
    null,
    2,
  ) + "\n",
);
if (failures.length) {
  console.log(
    JSON.stringify({
      failures: failures.map((c) => c.id),
      privateLogFolder: folder,
    }),
  );
  process.exitCode = 1;
}
