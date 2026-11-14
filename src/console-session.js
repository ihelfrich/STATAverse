// The Console's session and the plain-data summary the page displays. The
// same code runs in the worker and, when a worker cannot start, in the page.
import { Session } from "./runtime/session.js";
import { Dataset } from "./runtime/store.js";
import { addTextFile } from "./runtime/delimited.js";
import { toCSV } from "./datasets.js";
import { LIBRARY } from "./console-datasets.js";
import { readDta, writeDta } from "./console-dta.js";

const library = Object.fromEntries(
  Object.entries(LIBRARY).map(([id, entry]) => [id, entry.data]),
);

export function createConsoleSession() {
  let session;
  // Files the student added stay available when the session is cleared.
  const added = new Map();
  // A text file is kept as text, a .dta file as the dataset read from it,
  // and a workbook or an SPSS or SAS file as its bytes, for the import
  // command that reads it.
  const put = (name, file) => {
    if (typeof file === "string") addTextFile(session, name, file);
    else if (file instanceof Uint8Array)
      (session.files ??= new Map()).set(name, { bytes: file });
    else (session.files ??= new Map()).set(name, file);
  };
  const memory = () => ({
    observations: session.data.n,
    sortedBy: [...session.data.sortedBy],
    files: [...(session.files ?? new Map()).keys()].sort(),
    variables: session.data.variables.map(
      ({ name, type, format, label, valueLabel }) => ({
        name,
        type,
        format,
        label,
        valueLabel: valueLabel ?? "",
      }),
    ),
  });
  const reset = (dataset = "") => {
    session = new Session();
    session.library = library;
    // Results as Stata's log shows them: a loop echoed once with its lines
    // numbered, do-files run by do shown with their commands.
    session.foldLoops = true;
    // Each site dataset is also there as a CSV file, as lessons expect.
    for (const [id, data] of Object.entries(library))
      addTextFile(session, LIBRARY[id].file, toCSV(data));
    for (const [name, file] of added) put(name, file);
    if (dataset && library[dataset])
      session.data = Dataset.fromRows(library[dataset]);
    return { memory: memory() };
  };
  reset();
  return {
    reset,
    addFile(name, text) {
      addTextFile(session, name, text);
      added.set(name, text);
      return { memory: memory() };
    },
    /** A .dta file: read once, then there for use, merge and append. */
    addData(name, bytes) {
      let data;
      try {
        data = readDta(bytes);
      } catch (error) {
        // An array too large to make: the dataset does not fit in memory.
        if (error instanceof RangeError)
          throw new Error(
            "this dataset needs more memory than this browser tab has. In Stata, keep the variables and observations you need, save, and add that file",
          );
        throw error;
      }
      added.set(name, data);
      put(name, data);
      return {
        memory: memory(),
        rows: data.n,
        variables: data.variables.length,
      };
    },
    /** A file kept as its bytes: an Excel workbook, an SPSS or SAS file. */
    addBinary(name, bytes) {
      added.set(name, bytes);
      put(name, bytes);
      return { memory: memory() };
    },
    removeFile(name) {
      added.delete(name);
      session.files?.delete(name);
      return { memory: memory() };
    },
    /** The data in memory as the bytes of a .dta file. */
    exportData() {
      return { bytes: writeDta(session.data.snapshot()), memory: memory() };
    },
    run(source) {
      const { output, rc } = session.run(source),
        // Graphs written by graph export, for the page to turn into files.
        made = session.exported ?? [];
      session.exported = [];
      return {
        output,
        rc,
        made,
        memory: memory(),
      };
    },
  };
}

/**
 * The name of an added file a run looked for and did not find, from the
 * error that stopped it; "" when the run did not stop on a missing file.
 */
export function missingFile(output) {
  const last = output.at(-1);
  if (!last || last.rc !== 601 || /^\s*(sysuse|webuse)\b/.test(last.command))
    return "";
  for (const line of last.lines) {
    const m = /^file (.+?) not found\b/.exec(line);
    if (m) return m[1].replace(/^"(.*)"$/, "$1");
  }
  return "";
}
