import { LESSON_CATALOG } from "./lesson-catalog.js";
import { DATASETS } from "./datasets.js";
import { validateImportLibrary } from "./import-library.js";
import { validateLabProgress } from "./lab-progress.js";
import { validateBuilder } from "./do-builder-model.js";
export const PRACTICE_KEY = "stataverse:practice:v2";
export const MAX_STORE_BYTES = 4000000;
export const emptyStore = () => ({
  version: 3,
  lessons: {},
  free: {},
  imports: {},
  mode: "guided",
  activeDataset: "study",
  current: LESSON_CATALOG[0].id,
});
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function record(value, stepCount) {
  if (!object(value)) throw new Error("A saved lesson has an invalid format.");
  const history = value.history ?? [],
    completed = value.completed ?? [],
    step = value.step ?? 0,
    code = value.code ?? "",
    note = value.note ?? "";
  if (
    !Array.isArray(history) ||
    history.length > 500 ||
    history.some((c) => typeof c !== "string" || c.length > 50000) ||
    history.reduce((n, c) => n + c.length, 0) > 1000000
  )
    throw new Error("The saved command history is invalid or too large.");
  if (!Number.isInteger(step) || step < 0 || step >= stepCount)
    throw new Error("A saved lesson step is invalid.");
  if (
    !Array.isArray(completed) ||
    completed.some((i) => !Number.isInteger(i) || i < 0 || i >= stepCount)
  )
    throw new Error("The saved completion state is invalid.");
  if (
    typeof code !== "string" ||
    typeof note !== "string" ||
    code.length > 50000 ||
    note.length > 50000
  )
    throw new Error("Saved text is invalid or too large.");
  return {
    step,
    history: [...history],
    completed: [...new Set(completed)],
    code,
    note,
  };
}
export function validateStore(value) {
  if (
    !object(value) ||
    ![2, 3].includes(value.version) ||
    !object(value.lessons) ||
    !object(value.free ?? {})
  )
    throw new Error("The practice backup has an unsupported format.");
  const result = emptyStore();
  result.imports = validateImportLibrary(value.imports ?? {});
  for (const lesson of LESSON_CATALOG)
    if (Object.hasOwn(value.lessons, lesson.id))
      result.lessons[lesson.id] = record(
        value.lessons[lesson.id],
        lesson.stepCount,
      );
  for (const id of [...Object.keys(DATASETS), ...Object.keys(result.imports)])
    if (Object.hasOwn(value.free ?? {}, id))
      result.free[id] = record(value.free[id], 1);
  if (LESSON_CATALOG.some((l) => l.id === value.current))
    result.current = value.current;
  if (value.mode === "free") result.mode = "free";
  if (
    Object.hasOwn(DATASETS, value.activeDataset) ||
    Object.hasOwn(result.imports, value.activeDataset)
  )
    result.activeDataset = value.activeDataset;
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_STORE_BYTES)
    throw new Error(
      "The saved practice data exceed the 4 MB limit. Export individual projects before removing older work.",
    );
  return result;
}
export function parseStore(text) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > MAX_STORE_BYTES
  )
    throw new Error("The saved practice data exceed the supported size.");
  return validateStore(JSON.parse(text));
}
export function validateBackup(value) {
  if (
    !object(value) ||
    ![undefined, 1, 2, 3, 4].includes(value.version) ||
    !object(value.progress ?? {}) ||
    !object(value.profile ?? {})
  )
    throw new Error("The workspace backup has an invalid format.");
  if (Object.keys(value.progress ?? {}).length > 300)
    throw new Error("The backup contains too many reading modules.");
  const profile = {};
  for (const field of ["name", "role", "focus"]) {
    const text = value.profile?.[field] ?? "";
    if (typeof text !== "string" || text.length > 500)
      throw new Error("The profile has invalid text.");
    profile[field] = text;
  }
  const progress = {};
  for (const [key, text] of Object.entries(value.progress ?? {})) {
    if (!key.startsWith("stataverse:progress:"))
      throw new Error(
        "This file contains a storage key outside the STATAverse lesson namespace.",
      );
    if (typeof text !== "string" || text.length > 200000)
      throw new Error("A lesson entry is invalid or too large.");
    const entry = JSON.parse(text);
    if (
      !object(entry) ||
      !Array.isArray(entry.checks) ||
      entry.checks.some((v) => typeof v !== "boolean") ||
      !object(entry.notes ?? {})
    )
      throw new Error("A lesson entry has an invalid format.");
    if (
      Object.values(entry.notes ?? {}).some(
        (v) => typeof v !== "string" || v.length > 50000,
      )
    )
      throw new Error("A saved note has an invalid format.");
    progress[key] = JSON.stringify({
      checks: entry.checks,
      notes: entry.notes ?? {},
    });
  }
  const practice =
    value.practice === undefined ? undefined : validateStore(value.practice);
  const labs =
    value.labs === undefined ? undefined : validateLabProgress(value.labs);
  const builder =
    value.builder === undefined ? undefined : validateBuilder(value.builder);
  return {
    version: builder ? 4 : labs ? 3 : 2,
    profile,
    progress,
    ...(practice ? { practice } : {}),
    ...(labs ? { labs } : {}),
    ...(builder ? { builder } : {}),
  };
}
