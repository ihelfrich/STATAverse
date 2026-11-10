// Runs the Console's session off the page's thread, so a long do-file can be
// stopped by ending the worker.
import { createConsoleSession } from "./console-session.js";

const session = createConsoleSession();
self.onmessage = ({ data }) => {
  const { id, kind, source, dataset } = data;
  try {
    const result =
      kind === "run" ? session.run(source) : session.reset(dataset);
    self.postMessage({ id, ok: true, ...result });
  } catch (error) {
    // Anything that reaches here is a fault in the interpreter itself.
    self.postMessage({
      id,
      ok: false,
      message: String(error?.message ?? error),
    });
  }
};
self.postMessage({ ready: true });
