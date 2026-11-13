// Runs the Console's session off the page's thread, so a long do-file can be
// stopped by ending the worker. Messages are answered in the order they
// came, each with its own id; a file being read reports its progress.
import { createConsoleSession } from "./console-session.js";
import { giveFile, readBlob } from "./console-files.js";

const session = createConsoleSession();
async function answer(data) {
  const { id, kind, source, dataset } = data;
  if (kind === "take") {
    // A file the student added, read here so that the page stays free.
    const bytes = await readBlob(data.file, (loaded, total) =>
      self.postMessage({ id, progress: { loaded, total } }),
    );
    return giveFile(session, data.name, data.as, bytes);
  }
  return kind === "run"
    ? session.run(source)
    : kind === "file"
      ? session.addFile(data.name, data.text)
      : kind === "data"
        ? session.addData(data.name, data.bytes)
        : kind === "binary"
          ? session.addBinary(data.name, data.bytes)
          : kind === "remove"
            ? session.removeFile(data.name)
            : kind === "export"
              ? session.exportData()
              : session.reset(dataset);
}
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      self.postMessage({ id: data.id, ok: true, ...(await answer(data)) });
    } catch (error) {
      // A file that cannot be read, or a fault in the interpreter itself.
      self.postMessage({
        id: data.id,
        ok: false,
        message: String(error?.message ?? error),
      });
    }
  });
};
self.postMessage({ ready: true });
