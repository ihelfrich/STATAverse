import {
  IV_INVESTIGATIONS,
  assessIVInvestigation,
} from "./labs/iv-investigations.js";
import { completeLabStep, saveLabDraft } from "./lab-progress.js";
import { LabProgressSession } from "./lab-progress-session.js";
import { escapeHTML as h } from "./render.js";

export function initializeIVInvestigations({ snapshot, apply }) {
  const $ = (selector) => document.querySelector(selector);
  let session = null,
    guide = null,
    index = 0,
    loading = false,
    passed = false,
    generation = 0,
    lastSnapshot = "",
    lastNote = "",
    draftIssue = "",
    pendingCheck = null;
  const response = () =>
    guide?.steps[index].question.type === "number"
      ? $("#iv-guide-number").value
      : $("#iv-guide-inputs input:checked")?.value || "";
  function status() {
    if (!session) return;
    const warning = $("#iv-guide-storage");
    warning.hidden = session.canSave;
    warning.textContent = session.message;
    if (!guide) return;
    const completed = session.value.completed[guide.id] || [];
    $("#iv-guide-progress").textContent =
      `${completed.length} of ${guide.steps.length} tasks checked`;
    $("#iv-guide-save").textContent =
      draftIssue ||
      (!session.canSave
        ? "This session only · export before leaving"
        : session.writing
          ? "Saving this task…"
          : "Task, responses and settings saved on this device");
    for (const option of $("#iv-guide-steps").options) {
      const step = guide.steps[Number(option.value)];
      option.textContent = `${Number(option.value) + 1}. ${step.title}${completed.includes(step.id) ? " · checked" : ""}`;
    }
  }
  session = new LabProgressSession({ onStatus: status });
  status();
  $("#iv-guide-select").innerHTML =
    '<option value="">Open exploration</option>' +
    IV_INVESTIGATIONS.map(
      (g) => `<option value="${g.id}">${h(g.title)}</option>`,
    ).join("");
  function draft() {
    const state = snapshot();
    return {
      step: guide.steps[index].id,
      parameters: state.parameters,
      view: state.view,
      plot: state.plot,
      selected: state.selected,
      candidate: state.candidate,
      window: state.window,
      answer: response(),
      note: $("#iv-guide-note").value,
      updatedAt: Date.now(),
    };
  }
  function clearCheck() {
    generation++;
    passed = false;
    $("#iv-guide-next").disabled = true;
    $("#iv-guide-feedback").textContent = "";
    $("#iv-guide-feedback").classList.remove("answer-passed");
    $("#iv-guide-finished").hidden = true;
  }
  function persist() {
    if (!guide || loading) return Promise.resolve(false);
    if (!snapshot().valid) {
      draftIssue =
        "Fix the experiment inputs to save these changes. The last valid draft is retained.";
      status();
      return Promise.resolve(false);
    }
    try {
      const current = draft();
      draftIssue = "";
      return session.update((value) => saveLabDraft(value, guide.id, current));
    } catch (error) {
      draftIssue = `This draft could not be saved: ${error.message}`;
      status();
      return Promise.resolve(false);
    }
  }
  function changed() {
    if (!guide || loading) return;
    const current = JSON.stringify({
      ...snapshot(),
      sample: undefined,
      answer: response(),
    });
    const note = $("#iv-guide-note").value;
    if (current === lastSnapshot && note === lastNote) return;
    if (current !== lastSnapshot) clearCheck();
    lastSnapshot = current;
    lastNote = note;
    persist();
  }
  function showStep(next, { updateURL = true, fresh = false } = {}) {
    loading = true;
    index = next;
    clearCheck();
    pendingCheck = null;
    draftIssue = "";
    const step = guide.steps[index],
      saved = session.value.drafts?.[guide.id],
      restore =
        !fresh && saved?.states[step.id]
          ? { ...saved.states[step.id], note: saved.note }
          : null,
      note = restore?.note ?? $("#iv-guide-note").value;
    $("#iv-guide-title").textContent = step.title;
    $("#iv-guide-instruction").textContent = step.instruction;
    $("#iv-guide-hint").textContent = step.hint;
    $("#iv-guide-help").open = false;
    $("#iv-guide-question").textContent = step.question.prompt;
    $("#iv-guide-inputs").innerHTML =
      step.question.type === "number"
        ? '<label class="sr-only" for="iv-guide-number">Your numerical answer</label><input id="iv-guide-number" type="text" inputmode="decimal" maxlength="128" autocomplete="off" placeholder="Enter a number" aria-describedby="iv-guide-question">'
        : step.question.options
            .map(
              (option, i) =>
                `<label><input type="radio" name="iv-guide-response" value="${i}"> <span>${h(option)}</span></label>`,
            )
            .join("");
    if (restore) {
      if (step.question.type === "number")
        $("#iv-guide-number").value = restore.answer;
      else {
        const input = $(
          `#iv-guide-inputs input[value="${Number(restore.answer)}"]`,
        );
        if (restore.answer !== "" && input) input.checked = true;
      }
    }
    $("#iv-guide-note").value = note;
    $("#iv-guide-previous").disabled = index === 0;
    $("#iv-guide-check").disabled = false;
    $("#iv-guide-next").textContent =
      index === guide.steps.length - 1 ? "Finish investigation" : "Next task →";
    $("#iv-guide-steps").innerHTML = guide.steps
      .map((s, i) => `<option value="${i}">${h(s.title)}</option>`)
      .join("");
    $("#iv-guide-steps").value = String(index);
    apply(restore || structuredClone(step.setup));
    if (updateURL)
      history.replaceState(
        null,
        "",
        `#investigation=${guide.id}&step=${step.id}`,
      );
    loading = false;
    lastSnapshot = "";
    changed();
    if (restore && session.value.completed[guide.id]?.includes(step.id)) {
      const assessment = assessIVInvestigation(step, snapshot(), response());
      if (assessment.passed) {
        passed = true;
        $("#iv-guide-next").disabled = false;
        $("#iv-guide-feedback").textContent =
          `Previously checked. ${assessment.message}`;
        $("#iv-guide-feedback").classList.add("answer-passed");
      }
    }
    status();
  }
  function open(id, stepId, updateURL = true) {
    const next = IV_INVESTIGATIONS.find((g) => g.id === id);
    if (!next) {
      leave(updateURL);
      return;
    }
    guide = next;
    $("#iv-guide-select").value = id;
    $("#iv-guide-summary").textContent =
      `${guide.level} · about ${guide.minutes} minutes · ${guide.steps.length} tasks. ${guide.summary}`;
    for (const selector of [
      "#iv-guide-task",
      "#iv-guide-answer",
      "#iv-guide-jumps",
    ])
      $(selector).hidden = false;
    const saved = session.value.drafts?.[id];
    let nextIndex = guide.steps.findIndex(
      (s) => s.id === (stepId || saved?.step),
    );
    if (nextIndex < 0)
      nextIndex = guide.steps.findIndex(
        (s) => !session.value.completed[id]?.includes(s.id),
      );
    if (nextIndex < 0) nextIndex = 0;
    $("#iv-guide-note").value = saved?.note || "";
    showStep(nextIndex, {
      updateURL,
    });
  }
  function leave(updateURL = true) {
    guide = null;
    generation++;
    passed = false;
    $("#iv-guide-select").value = "";
    for (const selector of [
      "#iv-guide-task",
      "#iv-guide-answer",
      "#iv-guide-jumps",
    ])
      $(selector).hidden = true;
    $("#iv-guide-summary").textContent =
      "Choose a guided investigation, or explore the population freely. Guided tasks, settings, responses and notes resume from Saved work and travel with its backups.";
    if (updateURL)
      history.replaceState(null, "", location.pathname + location.search);
  }
  function fromURL() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("investigation"))
      open(params.get("investigation"), params.get("step"), false);
    else leave(false);
  }
  $("#iv-guide-select").addEventListener("change", (event) =>
    open(event.target.value),
  );
  $("#iv-guide-steps").addEventListener("change", (event) =>
    showStep(Number(event.target.value)),
  );
  $("#iv-guide-reset").addEventListener("click", () =>
    showStep(index, { fresh: true }),
  );
  $("#iv-guide-previous").addEventListener("click", () => {
    if (index > 0) {
      showStep(index - 1);
      jump("iv-guide-task");
    }
  });
  $("#iv-guide-inputs").addEventListener("input", changed);
  $("#iv-guide-note").addEventListener("input", changed);
  $("#iv-guide-inputs").addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      event.target.id === "iv-guide-number" &&
      !$("#iv-guide-check").disabled
    ) {
      event.preventDefault();
      $("#iv-guide-check").click();
    }
  });
  $("#iv-guide-check").addEventListener("click", async () => {
    if (!guide) return;
    const currentGuide = guide,
      step = guide.steps[index],
      current = generation,
      token = {};
    pendingCheck = token;
    const result = assessIVInvestigation(step, snapshot(), response());
    $("#iv-guide-feedback").textContent = result.message;
    $("#iv-guide-feedback").classList.toggle("answer-passed", result.passed);
    if (!result.passed) return;
    $("#iv-guide-check").disabled = true;
    const currentDraft = draft();
    await session.update((value) =>
      completeLabStep(
        saveLabDraft(value, currentGuide.id, currentDraft),
        currentGuide.id,
        step.id,
      ),
    );
    if (pendingCheck === token) {
      pendingCheck = null;
      $("#iv-guide-check").disabled = false;
    }
    if (current !== generation || currentGuide !== guide) return;
    passed = true;
    $("#iv-guide-next").disabled = false;
    status();
  });
  $("#iv-guide-next").addEventListener("click", () => {
    if (!passed || !guide) return;
    if (index < guide.steps.length - 1) {
      showStep(index + 1);
      jump("iv-guide-task");
    } else {
      $("#iv-guide-finished").hidden = false;
      const n = (session.value.completed[guide.id] || []).length;
      $("#iv-guide-finished").textContent =
        n === guide.steps.length
          ? `All ${n} tasks in ${guide.title} are checked. Use Saved work to return to your notes, or choose another investigation. These supported checks record practice; they do not certify unaided mastery.`
          : `${n} of ${guide.steps.length} tasks are checked. Use the task selector to return to an unchecked task.`;
      $("#iv-guide-next").disabled = true;
    }
  });
  function jump(id) {
    const element = $("#" + id);
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "start" });
  }
  document
    .querySelectorAll("[data-iv-jump]")
    .forEach((button) =>
      button.addEventListener("click", () => jump(button.dataset.ivJump)),
    );
  window.addEventListener("hashchange", fromURL);
  window.addEventListener("beforeunload", (event) => {
    if (
      draftIssue ||
      (session.canSave && session.savedRevision < session.revision)
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  fromURL();
  return {
    changed,
    record: () =>
      guide
        ? {
            version: 2,
            guide: guide.id,
            draft: draft(),
            taskStates: structuredClone(
              session.value.drafts?.[guide.id]?.states || {},
            ),
            completed: structuredClone(session.value.completed),
            checkedCurrentState: passed,
            savedOnDevice:
              !draftIssue &&
              session.canSave &&
              session.savedRevision === session.revision,
            description:
              "Supported investigation checks and current draft; use Saved work backups for browser-to-browser restoration.",
          }
        : null,
  };
}
