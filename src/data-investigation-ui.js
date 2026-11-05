import {
  DATA_INVESTIGATIONS,
  assessInvestigation,
} from "./labs/data-investigations.js";
import {
  LAB_PROGRESS_KEY,
  emptyLabProgress,
  parseLabProgress,
  completeLabStep,
  withLabProgressLock,
} from "./lab-progress.js";
import { escapeHTML as h } from "./render.js";

export function initializeInvestigations({ applySettings, snapshot }) {
  const $ = (selector) => document.querySelector(selector);
  let progress = emptyLabProgress(),
    savedRaw = null,
    canSave = true,
    guide = null,
    index = 0,
    passed = false,
    generation = 0,
    pendingCheck = null;
  const warn = (message) => {
    canSave = false;
    $("#investigation-storage").hidden = false;
    $("#investigation-storage").textContent = message;
    progressLabel();
  };
  try {
    savedRaw = localStorage.getItem(LAB_PROGRESS_KEY);
    if (savedRaw !== null) progress = parseLabProgress(savedRaw);
  } catch {
    warn(
      "Lab progress could not be read or saved. Any stored copy has been left in place. You can work through the investigation and export its record with a valid Stata project.",
    );
  }
  $("#investigation-select").innerHTML =
    '<option value="">Open exploration</option>' +
    DATA_INVESTIGATIONS.map(
      (g) =>
        `<option value="${g.id}">${h(g.title)} · ${g.steps.length} tasks</option>`,
    ).join("");
  function progressLabel() {
    if (!guide) return;
    const n = (progress.completed[guide.id] || []).length;
    $("#investigation-progress").textContent =
      `${n} of ${guide.steps.length} tasks checked${canSave ? " · saved here" : " · this session"}`;
    $("#investigation-steps").innerHTML = guide.steps
      .map(
        (step, i) =>
          `<option value="${i}">${i + 1}. ${h(step.title)}${progress.completed[guide.id]?.includes(step.id) ? " · checked" : ""}</option>`,
      )
      .join("");
    $("#investigation-steps").value = String(index);
  }
  function leave(updateURL = false) {
    guide = null;
    generation++;
    passed = false;
    $("#investigation-select").value = "";
    for (const id of [
      "investigation-task",
      "investigation-answer",
      "investigation-jump",
    ])
      $("#" + id).hidden = true;
    $("#investigation-summary").textContent =
      "Explore freely, or choose a guided investigation with checked tasks. Progress is stored in this browser and included in Saved work backups.";
    if (updateURL)
      history.replaceState(null, "", `#${snapshot().settings.mode}`);
  }
  function showStep(next, updateURL = true) {
    index = next;
    generation++;
    passed = false;
    pendingCheck = null;
    const step = guide.steps[index];
    $("#investigation-title").textContent = step.title;
    $("#investigation-instruction").textContent = step.instruction;
    $("#investigation-hint").textContent = step.hint;
    $("#investigation-help").open = false;
    $("#investigation-question").textContent = step.question.prompt;
    $("#investigation-inputs").innerHTML =
      step.question.type === "number"
        ? '<label class="sr-only" for="investigation-number">Your numerical answer</label><input id="investigation-number" type="text" inputmode="decimal" maxlength="32" autocomplete="off" placeholder="Enter a number" aria-describedby="investigation-question">'
        : step.question.options
            .map(
              (option, i) =>
                `<label><input type="radio" name="investigation-response" value="${i}"> <span>${h(option)}</span></label>`,
            )
            .join("");
    $("#investigation-feedback").textContent = "";
    $("#investigation-feedback").classList.remove("answer-passed");
    $("#investigation-next").disabled = true;
    $("#investigation-next").textContent =
      index === guide.steps.length - 1 ? "Finish investigation" : "Next task →";
    $("#investigation-previous").disabled = index === 0;
    $("#investigation-finished").hidden = true;
    $("#investigation-check").disabled = false;
    progressLabel();
    applySettings(structuredClone(step.setup));
    if (updateURL)
      history.replaceState(
        null,
        "",
        `#investigation=${guide.id}&step=${step.id}`,
      );
  }
  function open(id, stepId, updateURL = true) {
    guide = DATA_INVESTIGATIONS.find((g) => g.id === id);
    if (!guide) {
      leave();
      return;
    }
    $("#investigation-select").value = id;
    $("#investigation-summary").textContent =
      `${guide.level} · about ${guide.minutes} minutes. ${guide.summary}`;
    for (const id of [
      "investigation-task",
      "investigation-answer",
      "investigation-jump",
    ])
      $("#" + id).hidden = false;
    let next = guide.steps.findIndex((s) => s.id === stepId);
    if (next < 0)
      next = guide.steps.findIndex(
        (s) => !progress.completed[guide.id]?.includes(s.id),
      );
    showStep(next < 0 ? 0 : next, updateURL);
  }
  function fromURL() {
    const params = new URLSearchParams(location.hash.slice(1)),
      id = params.get("investigation");
    if (id) open(id, params.get("step"), false);
    else if (["", "#merge", "#reshape"].includes(location.hash)) leave();
  }
  function changed() {
    if (!guide) return;
    generation++;
    passed = false;
    $("#investigation-next").disabled = true;
    $("#investigation-finished").hidden = true;
    $("#investigation-feedback").textContent = "";
    $("#investigation-feedback").classList.remove("answer-passed");
  }
  $("#investigation-select").addEventListener("change", (event) => {
    if (event.target.value) open(event.target.value);
    else leave(true);
  });
  $("#investigation-steps").addEventListener("change", (event) =>
    showStep(Number(event.target.value)),
  );
  $("#investigation-reset").addEventListener("click", () => showStep(index));
  $("#investigation-previous").addEventListener("click", () => {
    if (index > 0) showStep(index - 1);
  });
  $("#investigation-inputs").addEventListener("input", changed);
  $("#investigation-inputs").addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      event.target.id === "investigation-number" &&
      !$("#investigation-check").disabled
    ) {
      event.preventDefault();
      $("#investigation-check").click();
    }
  });
  $("#investigation-check").addEventListener("click", async () => {
    if (!guide) return;
    const currentGuide = guide,
      step = guide.steps[index],
      current = generation;
    const token = {};
    pendingCheck = token;
    const answer =
      step.question.type === "number"
        ? $("#investigation-number").value
        : $("#investigation-inputs input:checked")?.value;
    const assessment = assessInvestigation(step, snapshot(), answer);
    $("#investigation-feedback").textContent = assessment.message;
    $("#investigation-feedback").classList.toggle(
      "answer-passed",
      assessment.passed,
    );
    if (!assessment.passed) return;
    progress = completeLabStep(progress, currentGuide.id, step.id);
    $("#investigation-check").disabled = true;
    if (canSave) {
      try {
        await withLabProgressLock(() => {
          if (!canSave || localStorage.getItem(LAB_PROGRESS_KEY) !== savedRaw)
            throw new Error("changed");
          const text = JSON.stringify(progress);
          localStorage.setItem(LAB_PROGRESS_KEY, text);
          savedRaw = text;
        });
      } catch (error) {
        warn(
          error.message === "changed"
            ? "Lab progress changed in another tab. Reload before saving further progress so that imported or cleared work is not overwritten. This session can continue and its investigation record can be exported."
            : "This browser could not save lab progress. This session can continue; export the investigation record with a valid Stata project before leaving.",
        );
      }
    }
    if (pendingCheck === token) {
      pendingCheck = null;
      $("#investigation-check").disabled = false;
    }
    if (current !== generation || currentGuide !== guide) return;
    passed = true;
    progressLabel();
    $("#investigation-check").disabled = false;
    $("#investigation-next").disabled = false;
  });
  $("#investigation-next").addEventListener("click", () => {
    if (!passed || !guide) return;
    if (index < guide.steps.length - 1) {
      showStep(index + 1);
      $("#investigation-task").focus({ preventScroll: true });
      $("#investigation-task").scrollIntoView({ block: "start" });
    } else {
      const n = (progress.completed[guide.id] || []).length;
      $("#investigation-finished").hidden = false;
      $("#investigation-finished").textContent =
        n === guide.steps.length
          ? `All ${n} tasks in ${guide.title} are checked. You can revisit any task or choose another investigation. These supported checks are learning records, not a test of unaided mastery.`
          : `This is the last task. ${n} of ${guide.steps.length} tasks are checked; use the task selector to return to any unchecked tasks.`;
      $("#investigation-next").disabled = true;
    }
  });
  window.addEventListener("hashchange", fromURL);
  window.addEventListener("storage", (event) => {
    if (event.key === LAB_PROGRESS_KEY || event.key === null)
      warn(
        "Lab progress changed in another tab. Reload before saving further progress so that imported or cleared work is not overwritten. Your current tables remain available.",
      );
  });
  fromURL();
  return {
    changed,
    record: () =>
      guide
        ? {
            version: 1,
            guide: guide.id,
            step: guide.steps[index].id,
            completed: structuredClone(progress.completed),
            checkedCurrentState: passed,
            question: guide.steps[index].question.prompt,
            response:
              guide.steps[index].question.type === "number"
                ? $("#investigation-number").value
                : guide.steps[index].question.options[
                    Number($("#investigation-inputs input:checked")?.value)
                  ] || null,
            description:
              "Supported investigation checks; not a secure assessment of unaided mastery",
          }
        : null,
  };
}
