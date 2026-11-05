import { INVESTIGATION_CATALOG } from "./labs/investigation-catalog.js";
import { validateIVDraft } from "./labs/iv-draft.js";
export const LAB_PROGRESS_KEY = "stataverse:labs:v1";
export const LAB_PROGRESS_LOCK = "stataverse:lab-progress";
export const emptyLabProgress = () => ({ version: 1, completed: {} });
export function validateLabProgress(value) {
  if (
    !value ||
    ![1, 2].includes(value.version) ||
    !value.completed ||
    typeof value.completed !== "object" ||
    Array.isArray(value.completed)
  )
    throw new Error("Lab progress has an unsupported format.");
  if (value.version === 1 && value.drafts !== undefined)
    throw new Error("Saved drafts require the current lab format.");
  const result =
    value.version === 2
      ? { version: 2, completed: {}, drafts: {} }
      : emptyLabProgress();
  if (value.generation !== undefined) {
    if (
      typeof value.generation !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(value.generation)
    )
      throw new Error("The saved lab change identifier is invalid.");
    result.generation = value.generation;
  }
  for (const [id, steps] of Object.entries(value.completed)) {
    const guide = INVESTIGATION_CATALOG.find((g) => g.id === id);
    if (
      !guide ||
      !Array.isArray(steps) ||
      steps.length > guide.steps.length ||
      steps.some((step) => !guide.steps.some((s) => s.id === step))
    )
      throw new Error(
        "Lab progress contains an unknown investigation or step.",
      );
    result.completed[id] = guide.steps
      .map((s) => s.id)
      .filter((step) => steps.includes(step));
  }
  if (value.version === 2) {
    if (
      !value.drafts ||
      typeof value.drafts !== "object" ||
      Array.isArray(value.drafts)
    )
      throw new Error("Saved lab drafts have an unsupported format.");
    for (const [id, draft] of Object.entries(value.drafts)) {
      const guide = INVESTIGATION_CATALOG.find((g) => g.id === id);
      if (guide?.lab !== "iv")
        throw new Error("A saved draft names an unsupported investigation.");
      result.drafts[id] = validateIVDraft(draft, guide);
    }
  }
  return result;
}
export function parseLabProgress(raw) {
  if (typeof raw !== "string" || raw.length > 50000)
    throw new Error("Lab progress exceeds the supported size.");
  return validateLabProgress(JSON.parse(raw));
}
export function completeLabStep(value, id, step) {
  const result = validateLabProgress(value),
    guide = INVESTIGATION_CATALOG.find((g) => g.id === id);
  if (!guide?.steps.some((s) => s.id === step))
    throw new Error("Unknown investigation step.");
  result.completed[id] = [...new Set([...(result.completed[id] || []), step])];
  return validateLabProgress(result);
}
export function saveLabDraft(value, id, draft) {
  const result = validateLabProgress(value);
  const guide = INVESTIGATION_CATALOG.find((g) => g.id === id);
  if (guide?.lab !== "iv") throw new Error("Unknown IV investigation.");
  const saved = validateIVDraft(draft, guide);
  return validateLabProgress({
    version: 2,
    completed: result.completed,
    ...(result.generation ? { generation: result.generation } : {}),
    drafts: {
      ...result.drafts,
      [id]: {
        ...saved,
        states: { ...result.drafts?.[id]?.states, ...saved.states },
      },
    },
  });
}
// An empty record must still change after an explicit clear. Otherwise a
// waiting writer that read null cannot distinguish a clear from no change.
export function renewLabProgress(value = emptyLabProgress()) {
  const generation =
    globalThis.crypto?.randomUUID?.() ||
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  return { ...validateLabProgress(value), generation };
}
export const withLabProgressLock = (callback) =>
  globalThis.navigator?.locks
    ? navigator.locks.request(LAB_PROGRESS_LOCK, callback)
    : Promise.resolve().then(callback);
