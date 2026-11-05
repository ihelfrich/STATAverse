import {
  BUILDER_KEY,
  METHODS,
  PREPARATIONS,
  emptyBuilder,
  validateBuilder,
  buildDoFile,
} from "./do-builder-model.js";
import { escapeHTML as h } from "./render.js";
const $ = (selector) => document.querySelector(selector),
  $$ = (selector) => [...document.querySelectorAll(selector)];
let plan = emptyBuilder(),
  writable = true,
  storedText = null;
const stages = [
  "Project",
  "Data",
  "Preparation",
  "Analysis",
  "Review & export",
];
const fields = Object.keys(plan).filter(
  (k) => !["version", "steps", "edited", "stage"].includes(k),
);
for (const el of $$("input:not([type=checkbox])")) el.maxLength = 2000;
$("#builder-code").maxLength = 50000;
try {
  const raw = localStorage.getItem(BUILDER_KEY);
  storedText = raw;
  if (raw) plan = validateBuilder(JSON.parse(raw));
} catch {
  writable = false;
  $("#builder-storage").textContent =
    "The saved plan could not be read. It has been left unchanged; download any new code before closing this page.";
}
function save() {
  if (!writable) return;
  try {
    if (localStorage.getItem(BUILDER_KEY) !== storedText) {
      writable = false;
      $("#builder-storage").textContent =
        "Another tab changed saved work. Download this do-file before reloading; this tab will not overwrite the saved plan.";
      return;
    }
    storedText = JSON.stringify(plan);
    localStorage.setItem(BUILDER_KEY, storedText);
    $("#builder-storage").textContent = "Plan saved on this device.";
  } catch {
    writable = false;
    $("#builder-storage").textContent =
      "The browser could not save this plan. Download the do-file before closing this page.";
  }
}
function readForm() {
  for (const key of fields) {
    const field = $("#" + key);
    plan[key] = field.type === "checkbox" ? field.checked : field.value;
  }
}
function fillForm() {
  renderMethods();
  for (const key of fields) {
    const field = $("#" + key);
    if (field.type === "checkbox") field.checked = plan[key];
    else field.value = plan[key];
  }
}
function renderMethods() {
  const levels = ["beginner", "intermediate", "advanced"],
    max = levels.indexOf(plan.level);
  $("#method").innerHTML = METHODS.filter(
    (m) => levels.indexOf(m.level) <= max || m.id === plan.method,
  )
    .map(
      (m) =>
        `<option value="${m.id}">${h(m.title)}${levels.indexOf(m.level) > max ? " (selected)" : ""}</option>`,
    )
    .join("");
  $("#method").value = plan.method;
}
function renderSteps() {
  $("#preparation-empty").hidden = plan.steps.length > 0;
  $("#add-operation").disabled = plan.steps.length >= 30;
  $("#preparation-steps").innerHTML = plan.steps
    .map((s, i) => {
      const spec = PREPARATIONS.find((p) => p.id === s.type),
        prefix = `step-${i}`;
      const field = (key, label, placeholder = "") =>
        `<div><label for="${prefix}-${key}">${label}</label><input id="${prefix}-${key}" data-step="${i}" data-field="${key}" value="${h(s[key] || "")}" placeholder="${h(placeholder)}" spellcheck="false" /></div>`;
      return `<article class="preparation-step" id="${prefix}"><header><h3>${i + 1}. ${h(spec.title)}</h3><div class="step-controls"><button type="button" data-move="${i}" data-direction="-1" aria-label="Move step ${i + 1} up" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" data-move="${i}" data-direction="1" aria-label="Move step ${i + 1} down" ${i === plan.steps.length - 1 ? "disabled" : ""}>↓</button><button type="button" data-remove="${i}" aria-label="Remove step ${i + 1}">Remove</button></div></header><div class="step-fields">${field("variable", "Existing variable", "income")}${spec.target ? field("target", "New variable", s.type === "log" ? "ln_income" : "income_new") : ""}${s.type === "filter" ? `<div><label for="${prefix}-operator">Comparison</label><select id="${prefix}-operator" data-step="${i}" data-field="operator">${["==", "!=", ">", ">=", "<", "<="].map((op) => `<option value="${h(op)}" ${op === s.operator ? "selected" : ""}>${h(op)}</option>`).join("")}</select></div>` : ""}${spec.value ? field("value", s.type === "missing" ? "Missing-value code" : "Numeric value", s.type === "missing" ? "-99" : "18") : ""}</div></article>`;
    })
    .join("");
}
function render({ focus = false } = {}) {
  const result = buildDoFile(plan),
    model = ["ols", "logit", "poisson", "iv", "fe"].includes(plan.method);
  for (const b of $$("[data-stage]")) {
    if (Number(b.dataset.stage) === plan.stage)
      b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  }
  for (const panel of $$("[data-panel]"))
    panel.hidden = Number(panel.dataset.panel) !== plan.stage;
  const flow = $(".builder-flow ol"),
    current = $(`[data-stage="${plan.stage}"]`);
  flow.scrollLeft +=
    current.getBoundingClientRect().left -
    flow.getBoundingClientRect().left -
    12;
  for (const panel of $$("[data-formats]"))
    panel.hidden = !panel.dataset.formats.split(" ").includes(plan.format);
  $("#mac-path").hidden = plan.os !== "mac";
  $("#windows-path").hidden = plan.os !== "windows";
  $("#project").placeholder =
    plan.os === "mac"
      ? "/Users/name/Documents/course-project"
      : "C:\\Users\\name\\Documents\\course-project";
  const roles = {
    outcome: plan.method !== "describe",
    predictors: plan.method !== "ttest",
    group: plan.method === "ttest",
    iv: plan.method === "iv",
    panel: plan.method === "fe",
    inference: model,
    cluster: model && plan.vce === "cluster",
  };
  for (const [role, show] of Object.entries(roles))
    $(`[data-role="${role}"]`).hidden = !show;
  $("#predictors-label").textContent =
    {
      describe: "Variables (optional)",
      scatter: "Horizontal-axis variable",
      iv: "Included exogenous controls (optional)",
    }[plan.method] || "Predictor variables";
  $("#predictors-help").textContent =
    plan.method === "describe"
      ? "Leave blank to summarize all numeric variables."
      : plan.method === "scatter"
        ? "Enter one numeric variable."
        : "Separate names with spaces. Use i.group for a numeric categorical predictor, c.age for a continuous predictor, and c.age##i.group for an interaction with both main effects.";
  $("#method-note").textContent = METHODS.find(
    (m) => m.id === plan.method,
  ).note;
  $("#plan-notes").innerHTML = result.notes
    .map((n) => `<p>${h(n)}</p>`)
    .join("");
  const errors =
    plan.stage === 4
      ? result.errors
      : result.errors.filter((e) => e.stage === plan.stage);
  $("#plan-errors").innerHTML = errors.length
    ? `<p><strong>${plan.stage === 4 ? "Fields to complete before export" : "Required fields"}</strong></p><ul>${errors.map((e) => `<li><button type="button" data-error-stage="${e.stage}" data-error-field="${h(e.field)}">${h(e.message)}</button></li>`).join("")}</ul>`
    : "";
  for (const el of $$("[aria-invalid]")) el.removeAttribute("aria-invalid");
  for (const e of result.errors) {
    const el = document.getElementById(e.field);
    if (el?.matches("input,select")) el.setAttribute("aria-invalid", "true");
  }
  $("#stage-position").textContent = `${plan.stage + 1} of 5`;
  $("#previous-stage").disabled = plan.stage === 0;
  $("#next-stage").hidden = plan.stage === 4;
  $("#next-stage").textContent =
    `Next: ${stages[plan.stage + 1] || "Review"} →`;
  $("#code-heading").textContent =
    (/^[A-Za-z0-9_-]+$/.test(plan.stem) ? plan.stem : "analysis") + ".do";
  const edited = plan.edited !== null;
  if (!edited) $("#builder-code").value = result.code;
  $("#builder-code").readOnly = !edited;
  $("#edit-code").hidden = edited;
  $("#regenerate-code").hidden = !edited;
  $("#code-state").textContent = edited
    ? "Manual edits are preserved. Form changes do not update this copy. Review the code before downloading; edits are not syntax-checked."
    : result.errors.length
      ? `${result.errors.length} required field${result.errors.length === 1 ? "" : "s"} remain before export.`
      : "The required fields are complete. Check the specification and paths before running.";
  $("#download-do").disabled = $("#copy-do").disabled = edited
    ? !plan.edited.trim()
    : result.errors.length > 0;
  if (focus) $(`[data-panel="${plan.stage}"] h2`).focus();
}
function changeStage(stage) {
  plan.stage = Math.max(0, Math.min(4, stage));
  render({ focus: true });
  save();
}
$("#operation").innerHTML = PREPARATIONS.map(
  (p) => `<option value="${p.id}">${h(p.title)}</option>`,
).join("");
fillForm();
renderSteps();
if (plan.edited !== null) $("#builder-code").value = plan.edited;
render();
$("#builder-form").addEventListener("submit", (e) => e.preventDefault());
function update(event) {
  if (event.target.dataset.step !== undefined) {
    const i = Number(event.target.dataset.step);
    plan.steps[i][event.target.dataset.field] = event.target.value;
  } else if (fields.includes(event.target.id)) readForm();
  else return;
  if (event.target.id === "level") renderMethods();
  render();
  save();
}
$("#builder-form").addEventListener("input", update);
$("#level").addEventListener("change", update);
for (const b of $$("[data-stage]"))
  b.addEventListener("click", () => changeStage(Number(b.dataset.stage)));
$("#previous-stage").addEventListener("click", () =>
  changeStage(plan.stage - 1),
);
$("#next-stage").addEventListener("click", () => changeStage(plan.stage + 1));
$("#add-operation").addEventListener("click", () => {
  if (plan.steps.length >= 30) return;
  plan.steps.push({
    type: $("#operation").value,
    variable: "",
    target: "",
    value: "",
    operator: "==",
  });
  renderSteps();
  render();
  save();
  document.getElementById(`step-${plan.steps.length - 1}-variable`).focus();
});
$("#preparation-steps").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.remove !== undefined)
    plan.steps.splice(Number(button.dataset.remove), 1);
  else if (button.dataset.move !== undefined) {
    const i = Number(button.dataset.move),
      j = i + Number(button.dataset.direction);
    if (j < 0 || j >= plan.steps.length) return;
    [plan.steps[i], plan.steps[j]] = [plan.steps[j], plan.steps[i]];
  } else return;
  renderSteps();
  render();
  save();
  $("#add-operation").focus();
});
$("#plan-errors").addEventListener("click", (event) => {
  const b = event.target.closest("[data-error-stage]");
  if (!b) return;
  changeStage(Number(b.dataset.errorStage));
  const el = document.getElementById(b.dataset.errorField);
  (el?.matches("input,select") ? el : el?.querySelector("input"))?.focus();
});
$("#edit-code").addEventListener("click", () => {
  plan.edited = $("#builder-code").value;
  render();
  save();
  $("#builder-code").focus();
});
$("#builder-code").addEventListener("input", () => {
  if (plan.edited === null) return;
  plan.edited = $("#builder-code").value;
  if (plan.edited.length > 50000) {
    $("#builder-action").textContent =
      "The code exceeds 50,000 characters. Shorten it before saving or downloading.";
    $("#download-do").disabled = $("#copy-do").disabled = true;
    return;
  }
  render();
  save();
});
$("#regenerate-code").addEventListener("click", () => {
  plan.edited = null;
  render();
  save();
  $("#edit-code").focus();
});
const code = () => plan.edited ?? buildDoFile(plan).code;
$("#copy-do").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(code());
    $("#builder-action").textContent = "Code copied.";
  } catch {
    $("#builder-code").focus();
    $("#builder-code").select();
    $("#builder-action").textContent =
      "Code selected. Use Copy from the browser’s Edit menu.";
  }
});
$("#download-do").addEventListener("click", () => {
  const blob = new Blob([code()], { type: "text/plain;charset=utf-8" }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = $("#code-heading").textContent;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  $("#builder-action").textContent =
    "Do-file downloaded. Open it in Stata’s Do-file Editor.";
});
window.addEventListener("storage", (event) => {
  if (event.key === BUILDER_KEY || event.key === null) {
    writable = false;
    $("#builder-storage").textContent =
      "Another tab changed saved work. This tab’s plan will not overwrite it. Download this do-file, then reload to read the saved plan.";
  }
});
