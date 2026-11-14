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
  let session, interactive;
  // Files the student added stay available when the session is cleared.
  const added = new Map();
  // A text file is kept as text; a .dta file as the dataset read from it.
  const put = (name, file) => {
    if (typeof file === "string") addTextFile(session, name, file);
    else (session.files ??= new Map()).set(name, file);
  };
  const memory = () => ({
    observations: session.data.n,
    sortedBy: [...session.data.sortedBy],
    files: [...(session.files ?? new Map()).keys()].sort(),
    variables: session.data.variables.map(({ name, type, format, label }) => ({
      name,
      type,
      format,
      label,
    })),
  });
  const reset = (dataset = "") => {
    session = new Session();
    interactive = session.frame();
    session.library = library;
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
      added.set(name, text);
      addTextFile(session, name, text);
      return { memory: memory() };
    },
    /** A .dta file: read once, then there for use, merge and append. */
    addData(name, bytes) {
      const data = readDta(bytes);
      added.set(name, data);
      put(name, data);
      return {
        memory: memory(),
        rows: data.n,
        variables: data.variables.length,
      };
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
    /**
     * Runs commands as Stata's Command window does: locals set by one are
     * there for the next. A do-file ({ doFile: true }) has locals of its own,
     * as it has in Stata.
     */
    run(source, { doFile = false } = {}) {
      const { output, rc } = session.run(
        source,
        doFile ? undefined : interactive,
      );
      // A byte that is not UTF-8 (text from an old file, or cut out of a
      // character) is shown as U+FFFD, where Stata prints the raw byte.
      for (const block of output)
        block.lines = block.lines.map((line) =>
          line.replace(/(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/g, "\uFFFD"),
        );
      return { output, rc, memory: memory() };
    },
  };
}
