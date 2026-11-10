// The Console's session and the plain-data summary the page displays. The
// same code runs in the worker and, when a worker cannot start, in the page.
import { Session } from "./runtime/session.js";
import { Dataset } from "./runtime/store.js";
import { DATASETS, createDataset } from "./datasets.js";

const library = Object.fromEntries(
  Object.keys(DATASETS).map((id) => [id, createDataset(id)]),
);

export function createConsoleSession() {
  let session;
  const memory = () => ({
    observations: session.data.n,
    sortedBy: [...session.data.sortedBy],
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
    if (dataset && library[dataset])
      session.data = Dataset.fromRows(library[dataset]);
    return { memory: memory() };
  };
  reset();
  return {
    reset,
    run(source) {
      const { output, rc } = session.run(source);
      return { output, rc, memory: memory() };
    },
  };
}
