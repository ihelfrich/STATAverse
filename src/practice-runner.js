import {
  PRACTICE_PROTOCOL,
  executePracticeRequestAsync,
} from "./practice-execution.js";

export class PracticeRunCanceled extends Error {
  constructor() {
    super("The pending run was stopped. No changes from it were applied.");
    this.name = "AbortError";
  }
}

/** Each job has its own worker and identity; stopped/late jobs cannot commit. */
export function createPracticeRunner({
  createWorker = () =>
    new Worker(new URL("./practice-worker.js", import.meta.url), {
      type: "module",
    }),
  timeoutMs = 120000,
} = {}) {
  let active = null,
    sequence = 0,
    workerUnavailable = false;
  const timeoutError = () =>
    new Error(
      "This run exceeded two minutes and was stopped. Its pending changes were discarded. Try a smaller section.",
    );
  const finish = (job, error, value) => {
    if (active !== job) return;
    if (!error && performance.now() >= job.deadline) error = timeoutError();
    active = null;
    clearTimeout(job.timer);
    job.worker?.terminate();
    job.controller.abort();
    if (error) job.reject(error);
    else job.resolve(value);
  };
  return {
    get busy() {
      return active !== null;
    },
    cancel() {
      if (active) finish(active, new PracticeRunCanceled());
    },
    run(request, onProgress = () => {}) {
      if (active)
        return Promise.reject(new Error("A practice run is already active."));
      return new Promise((resolve, reject) => {
        const job = {
          id: ++sequence,
          resolve,
          reject,
          mode: "worker",
          controller: new AbortController(),
          deadline: performance.now() + timeoutMs,
        };
        active = job;
        job.timer = setTimeout(() => finish(job, timeoutError()), timeoutMs);
        const fallback = () => {
          if (active !== job || job.mode !== "worker") return;
          job.mode = "cooperative";
          workerUnavailable = true;
          job.worker?.terminate();
          try {
            // Worker postMessage normally isolates state. Preserve that boundary here.
            const copy = structuredClone(request);
            onProgress({ commands: 0, mode: "cooperative" });
            executePracticeRequestAsync(
              copy,
              (data) => {
                if (active === job)
                  onProgress({ ...data, mode: "cooperative" });
              },
              job.controller.signal,
            ).then(
              (value) => finish(job, null, value),
              (error) => finish(job, error),
            );
          } catch (error) {
            finish(job, error);
          }
        };
        if (workerUnavailable) return fallback();
        try {
          job.worker = createWorker();
          job.worker.onmessage = ({ data }) => {
            if (active !== job || job.mode !== "worker" || data?.id !== job.id)
              return;
            if (data.version !== PRACTICE_PROTOCOL) {
              finish(
                job,
                new Error(
                  "Practice assets are from different versions. Reload the page and retry.",
                ),
              );
            } else if (data.kind === "progress") {
              onProgress(data);
            } else if (data.kind === "complete") {
              if (
                !data.state?.data ||
                !Array.isArray(data.state.history) ||
                !Array.isArray(data.undo) ||
                !Array.isArray(data.results) ||
                !Array.isArray(data.receipts)
              ) {
                finish(
                  job,
                  new Error(
                    "The background run returned an incomplete result. Your previous data remain unchanged.",
                  ),
                );
              } else finish(job, null, data);
            } else if (data.kind === "failure") {
              finish(
                job,
                Object.assign(
                  new Error(
                    data.error?.message || "The background run failed.",
                  ),
                  data.error,
                ),
              );
            } else
              finish(
                job,
                new Error("The background run returned an unknown response."),
              );
          };
          job.worker.onerror = (event) => {
            event.preventDefault?.();
            fallback();
          };
          job.worker.onmessageerror = () => fallback();
          job.worker.postMessage({
            id: job.id,
            version: PRACTICE_PROTOCOL,
            request,
          });
        } catch {
          fallback();
        }
      });
    },
  };
}
