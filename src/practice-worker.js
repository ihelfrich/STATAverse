import {
  executePracticeRequest,
  PRACTICE_PROTOCOL,
} from "./practice-execution.js";

self.onmessage = ({ data }) => {
  const { id, version, request } = data;
  if (version !== PRACTICE_PROTOCOL) {
    self.postMessage({
      id,
      version: PRACTICE_PROTOCOL,
      kind: "failure",
      error: {
        message:
          "Practice assets are from different versions. Reload the page and retry.",
      },
    });
    return;
  }
  let lastProgress = performance.now();
  try {
    const result = executePracticeRequest(request, (progress) => {
      if (performance.now() - lastProgress < 80) return;
      self.postMessage({ id, version, kind: "progress", ...progress });
      lastProgress = performance.now();
    });
    self.postMessage({ id, version, kind: "complete", ...result });
  } catch (error) {
    self.postMessage({
      id,
      version,
      kind: "failure",
      error: {
        message: error.message,
        code: error.code,
        source: error.source,
        hint: error.hint,
      },
    });
  }
};
