import { PracticeSession } from "./engine.js";
import { historyReceipt, retainResults } from "./output-history.js";
import { RESOURCE_LIMITS } from "./resource-limits.js";

export const PRACTICE_PROTOCOL = 1;

/** The transport supplies a cloned request; commit only the completed result. */
function* executionSteps(request, run, progress) {
  const {
    task,
    dataset,
    customDatasets = {},
    state,
    source,
    commands,
  } = request;
  if (!["run", "replay"].includes(task))
    throw new Error("Unknown practice execution task.");
  const session = new PracticeSession(dataset, customDatasets);
  if (task === "run") session.acceptExecution(state);
  let results = [],
    receipts = [],
    replayFailed = false;
  if (task === "run") {
    const output = yield run(session, source, { onProgress: progress });
    results = [...output];
    receipts = output.receipts || output.map(historyReceipt);
  } else {
    if (!Array.isArray(commands) || commands.length > 500)
      throw new Error("Invalid saved command history.");
    for (const [index, command] of commands.entries()) {
      const output = yield run(session, command);
      results = retainResults([...results, ...output]);
      receipts = retainResults(
        [...receipts, ...(output.receipts || output.map(historyReceipt))],
        {
          entries: 500,
          cells: Infinity,
          bytes: RESOURCE_LIMITS.timelineBytes,
        },
      );
      progress({ commands: index + 1, total: commands.length });
      if (output.some((result) => result.kind === "error")) {
        replayFailed = true;
        break;
      }
    }
  }
  return {
    state: session.executionState(),
    undo: session.undoStack,
    results,
    receipts,
    replayFailed,
  };
}

export function executePracticeRequest(request, progress = () => {}) {
  const steps = executionSteps(
    request,
    (session, source, options) => session.run(source, options),
    progress,
  );
  let next = steps.next();
  while (!next.done) next = steps.next(next.value);
  return next.value;
}

export async function executePracticeRequestAsync(
  request,
  progress = () => {},
  signal,
) {
  const steps = executionSteps(
    request,
    (session, source, options) =>
      session.runAsync(source, { ...options, signal }),
    progress,
  );
  try {
    signal?.throwIfAborted();
    let next = steps.next();
    while (!next.done) {
      const value = await next.value;
      signal?.throwIfAborted();
      next = steps.next(value);
    }
    return next.value;
  } finally {
    steps.return();
  }
}

/** Only analysis inputs cross into the worker, not original import source records. */
export function executionInputs(session, dataset) {
  return {
    dataset,
    state: session.executionState(),
    customDatasets: Object.fromEntries(
      Object.entries(session.customDatasets).map(([key, value]) => [
        key,
        { id: value.id, file: value.file, data: value.data },
      ]),
    ),
  };
}

/** Result and receipt can share a source object; offset each location once. */
export function offsetExecutionSources(results, receipts, range) {
  for (const source of new Set(
    [...results, ...receipts].map((result) => result.source).filter(Boolean),
  )) {
    source.from += range.from;
    source.to += range.from;
    source.line += range.line - 1;
    source.endLine += range.line - 1;
  }
}
