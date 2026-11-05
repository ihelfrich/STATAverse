import { INVESTIGATION_CATALOG } from "./labs/investigation-catalog.js";
export const LAB_PROGRESS_KEY = "stataverse:labs:v1";
export const LAB_PROGRESS_LOCK = "stataverse:lab-progress";
export const emptyLabProgress = () => ({ version: 1, completed: {} });
export function validateLabProgress(value) {
  if (
    !value ||
    value.version !== 1 ||
    !value.completed ||
    typeof value.completed !== "object" ||
    Array.isArray(value.completed)
  )
    throw new Error("Lab progress has an unsupported format.");
  const result = emptyLabProgress();
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
export const withLabProgressLock = (callback) =>
  globalThis.navigator?.locks
    ? navigator.locks.request(LAB_PROGRESS_LOCK, callback)
    : Promise.resolve().then(callback);
