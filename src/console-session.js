// The Console's session and the plain-data summary the page displays. The
// same code runs in the worker and, when a worker cannot start, in the page.
import { Session } from "./runtime/session.js";
import { Dataset } from "./runtime/store.js";
import { addTextFile } from "./runtime/delimited.js";
import { toCSV } from "./datasets.js";
import { LIBRARY } from "./console-datasets.js";
import { readDta, writeDta } from "./console-dta.js";
import { binaryKind, checkForeign } from "./runtime/foreign.js";

const library = Object.fromEntries(
  Object.entries(LIBRARY).map(([id, entry]) => [id, entry.data]),
);

export function createConsoleSession() {
  let session;
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
    /**
     * A .dta file: read once, then there for use, merge and append. A
     * workbook, SPSS or SAS file is kept as its bytes for import excel,
     * import spss and import sasxport5/8, and checked as it is added.
     */
    addData(name, bytes) {
      const kind = binaryKind(name);
      if (kind) {
        const file = { bytes: new Uint8Array(bytes) },
          check = checkForeign(kind, name, file);
        added.set(name, file);
        put(name, file);
        return { memory: memory(), kind, ...check };
      }
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
    /**
     * A file in the session's folder, such as a workbook written by export
     * excel or putexcel, for the page to offer as a download: { bytes } or
     * { text }, or null when there is no such file.
     */
    readFile(name) {
      const file = session.files?.get(name);
      if (!file) return null;
      if (file.bytes instanceof Uint8Array) return { name, bytes: file.bytes };
      if (typeof file.text === "string") return { name, text: file.text };
      return { name, bytes: writeDta(file) };
    },
    /** The data in memory as the bytes of a .dta file. */
    exportData() {
      return { bytes: writeDta(session.data.snapshot()), memory: memory() };
    },
    run(source) {
      const { output, rc } = session.run(source);
      return { output, rc, memory: memory() };
    },
  };
}
