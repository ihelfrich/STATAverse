// Runs every do-file in the repository through the new runtime and records
// how far each gets: whether it finishes, and if not, the first command it
// stops at. This is a stronger measure than command names, though a
// do-file that finishes has not thereby been checked against Stata.
import fs from "node:fs/promises";
import path from "node:path";
import { Session } from "../src/runtime/session.js";
import { addTextFile } from "../src/runtime/delimited.js";
import { DATASETS, createDataset, toCSV } from "../src/datasets.js";

const ROOTS = [
  "ScriptLibrary/scripts",
  "CodeLibrary/scripts",
  "ZeroToHero/projects",
  "RealData",
];
async function doFiles(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await doFiles(full)));
    else if (entry.name.endsWith(".do")) found.push(full);
  }
  return found.sort();
}

export async function runCorpus(root = ".") {
  const files = [];
  for (const directory of ROOTS)
    for (const file of await doFiles(path.join(root, directory))) {
      const session = new Session();
      session.library = Object.fromEntries(
        Object.keys(DATASETS).map((id) => [id, createDataset(id)]),
      );
      for (const [id, data] of Object.entries(DATASETS))
        addTextFile(
          session,
          data.file ?? `${id}.csv`,
          toCSV(createDataset(id)),
        );
      // Text files beside or below the do-file are available by their
      // path relative to it, as they would be after cd to its folder.
      const here = path.dirname(file),
        walk = async (directory) => {
          for (const entry of await fs.readdir(directory, {
            withFileTypes: true,
          })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (/\.(csv|txt|tsv)$/.test(entry.name))
              addTextFile(
                session,
                path.relative(here, full),
                await fs.readFile(full, "utf8"),
              );
          }
        };
      await walk(here);
      // The projects read from a data folder two levels up.
      const shared = path.join(here, "..", "..", "data");
      try {
        for (const entry of await fs.readdir(shared))
          if (/\.(csv|txt|tsv)$/.test(entry))
            addTextFile(
              session,
              `data/${entry}`,
              await fs.readFile(path.join(shared, entry), "utf8"),
            );
      } catch {
        // No shared data folder for this do-file.
      }
      let result,
        fault = null;
      try {
        result = session.run(await fs.readFile(file, "utf8"));
      } catch (error) {
        fault = String(error?.stack ?? error)
          .split("\n")
          .slice(0, 2)
          .join(" ");
        result = { rc: -1, output: [] };
      }
      const last = result.output.at(-1);
      files.push({
        file: path.relative(root, file),
        commands: result.output.length,
        rc: result.rc,
        ...(result.rc
          ? {
              stoppedAt: fault ? "(interpreter fault)" : last?.command,
              message:
                fault ??
                last?.lines.filter((l) => !/^r\(\d+\);$/.test(l)).at(-1),
            }
          : {}),
      });
    }
  return {
    basis:
      "Each do-file run from the start in a fresh session of the new runtime, with the site's datasets available. Finishing is not agreement with Stata; it means no command was refused.",
    files: files.length,
    finished: files.filter((f) => f.rc === 0).length,
    results: files,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = await runCorpus(".");
  if (process.argv.includes("--write"))
    await fs.writeFile(
      "docs/verification/corpus-run.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  console.log(`${report.finished} of ${report.files} do-files finish.`);
  for (const f of report.results)
    if (f.rc)
      console.log(
        `${f.file} [${f.commands}] rc=${f.rc}: ${String(f.stoppedAt).slice(0, 90)} — ${String(f.message).slice(0, 110)}`,
      );
}
