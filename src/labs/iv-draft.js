import { IV_DEFAULTS, ivParameters } from "./iv-parameters.js";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function validateState(value) {
  if (
    !object(value) ||
    !object(value.parameters) ||
    Object.keys(value.parameters).length !== Object.keys(IV_DEFAULTS).length ||
    Object.keys(IV_DEFAULTS).some((k) => !Object.hasOwn(value.parameters, k))
  )
    throw new Error("The saved IV task or population settings are invalid.");
  const parameters = ivParameters(value.parameters);
  if (
    !["stages", "uncertainty", "method"].includes(value.view) ||
    !["first", "reduced", "structural"].includes(value.plot) ||
    !Number.isInteger(value.selected) ||
    value.selected < 1 ||
    value.selected > parameters.n ||
    ![2, 5, 20, 100].includes(value.window)
  )
    throw new Error("The saved IV view or selected observation is invalid.");
  if (
    typeof value.candidate !== "string" ||
    value.candidate.length > 32 ||
    (value.candidate !== "" &&
      (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.candidate) ||
        !Number.isFinite(Number(value.candidate)) ||
        Math.abs(Number(value.candidate)) > 1000000))
  )
    throw new Error("The saved IV candidate is invalid.");
  if (
    typeof value.answer !== "string" ||
    value.answer.length > 128 ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0
  )
    throw new Error("The saved IV response or note is invalid.");
  return {
    parameters,
    view: value.view,
    plot: value.plot,
    selected: value.selected,
    candidate: value.candidate === "" ? "" : String(Number(value.candidate)),
    window: value.window,
    answer: value.answer,
    updatedAt: value.updatedAt,
  };
}
export function validateIVDraft(value, guide) {
  if (
    !object(value) ||
    !guide?.steps.some((s) => s.id === value.step) ||
    typeof value.note !== "string" ||
    value.note.length > 4000
  )
    throw new Error("The saved IV task or investigation note is invalid.");
  // Accept the earlier local draft shape without discarding a student's work.
  const source =
    value.states === undefined ? { [value.step]: value } : value.states;
  if (!object(source) || !Object.hasOwn(source, value.step))
    throw new Error("The saved IV investigation has no current task state.");
  const states = {};
  for (const [id, state] of Object.entries(source)) {
    if (!guide.steps.some((s) => s.id === id))
      throw new Error("The saved IV investigation contains an unknown task.");
    states[id] = validateState(state);
  }
  return { step: value.step, note: value.note, states };
}
