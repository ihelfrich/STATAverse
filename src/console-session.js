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
  // A text file is kept as text, or as its bytes with the text decoded from
  // them; a .dta file as the dataset read from it.
  const put = (name, file) => {
    if (typeof file === "string" || file instanceof Uint8Array)
      addTextFile(session, name, file);
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
    /**
     * A text file, as text or as the bytes the picker read. Bytes are
     * decoded as import delimited's scan decodes them (UTF-8, UTF-16 with
     * or without a byte-order mark, or Latin-1 and Windows-1252 when they
     * are not UTF-8) and kept, so that encoding() can read them again.
     */
    addFile(name, content) {
      const file =
        content instanceof ArrayBuffer ? new Uint8Array(content) : content;
      const before = session.files?.get(name),
        stored = addTextFile(session, name, file);
      if (file instanceof Uint8Array && stored.text.includes("\0")) {
        if (before) session.files.set(name, before);
        else session.files.delete(name);
        throw new Error(`${name} is not a text file`);
      }
      added.set(name, file);
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
    run(source) {
      const { output, rc } = session.run(source);
      return { output, rc, memory: memory() };
    },
  };
}
