// The project lab's Stata session, off the page's thread: the same session
// the Console runs, with the bundled panel built here from its seed and the
// lab's checks answered here, beside the data they look at. Messages are
// answered in the order they came, each with its own id.
import { createConsoleSession } from "./console-session.js";
import { giveFile, readBlob } from "./console-files.js";
import { panelCsv } from "./panel-project/panel-data.js";
import { PANEL_FILE, panelDta } from "./panel-project/panel-dta.js";
import {
  gatherBefore,
  gatherFacts,
  gatherFileFacts,
} from "./panel-project/lab-checks.js";
import { SESSION_HEADER } from "./panel-project/lab-steps.js";

/** The data as they stood when the step now being worked on began. */
const MARK = "lab-step-start.dta";

const session = createConsoleSession();
/** What the checks of the step now being worked on found when it began. */
let before = { step: null, facts: null };

async function answer(data) {
  const { id, kind } = data;
  if (kind === "reset") {
    session.removeFile(MARK);
    before = { step: null, facts: null };
    session.reset();
    return session.run(SESSION_HEADER, { doFile: true });
  }
  if (kind === "panel") return session.addData(PANEL_FILE, panelDta());
  if (kind === "csv") return { text: panelCsv() };
  if (kind === "take") {
    // A file the student opened: read here, and given to nothing else.
    const bytes = await readBlob(data.file, (loaded, total) =>
      self.postMessage({ id, progress: { loaded, total } }),
    );
    return giveFile(session, data.name, data.as, bytes);
  }
  if (kind === "run")
    return session.run(data.source, {
      doFile: !!data.doFile,
      endless: true,
      ...(data.quiet
        ? {}
        : {
            stream: (stream) =>
              stream.command !== undefined &&
              self.postMessage({
                id,
                progress: { command: stream.command, count: stream.count },
              }),
          }),
    });
  if (kind === "peek") return session.peek(data.request);
  if (kind === "facts")
    return {
      facts: gatherFacts(
        session,
        data.step,
        data.ran,
        before.step === data.step ? before.facts : null,
      ),
    };
  if (kind === "fileFacts") return { facts: gatherFileFacts(session) };
  if (kind === "mark") {
    session.addData(MARK, session.exportData().bytes);
    before = { step: data.step, facts: gatherBefore(session, data.step) };
    return {};
  }
  if (kind === "rewind") return session.run(`use "${MARK}", clear`);
  throw new Error(`unknown request ${kind}`);
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      self.postMessage({ id: data.id, ok: true, ...(await answer(data)) });
    } catch (error) {
      self.postMessage({
        id: data.id,
        ok: false,
        message: String(error?.message ?? error),
      });
    }
  });
};
self.postMessage({ ready: true });
