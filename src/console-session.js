// The Console's session and the plain-data summary the page displays. The
// same code runs in the worker and, when a worker cannot start, in the page.
import { Session } from "./runtime/session.js";
import { Dataset } from "./runtime/store.js";
import { addTextFile } from "./runtime/delimited.js";
import { toCSV } from "./datasets.js";
import { LIBRARY } from "./console-datasets.js";

const library = Object.fromEntries(
  Object.entries(LIBRARY).map(([id, entry]) => [id, entry.data]),
);

export function createConsoleSession() {
  let session;
  // Files the student added stay available when the session is cleared.
  const added = new Map();
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
    for (const [name, text] of added) addTextFile(session, name, text);
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
    run(source) {
      const { output, rc } = session.run(source);
      return { output, rc, memory: memory() };
    },
  };
}
