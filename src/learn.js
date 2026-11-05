import { PracticeSession } from "./engine.js";
import { DATASETS, createDataset, toCSV } from "./datasets.js";
import { LESSONS, TRACKS, assessStep } from "./lessons.js";
import { assessAnswer } from "./lesson-schema.js";
import { REFERENCE } from "./reference.js";
import {
  escapeHTML as h,
  fmt,
  resultHTML,
  explainCoefficient,
} from "./render.js";
import { renderGraph } from "./graph.js";
import { zipSync, strToU8 } from "fflate";
import { registerOffline } from "./offline.js";
import {
  PRACTICE_KEY,
  MAX_STORE_BYTES,
  emptyStore,
  parseStore,
} from "./persistence.js";
import {
  importCatalog,
  validateImportLibrary,
  nativeImportCommand,
} from "./import-library.js";
import { setupImportDialog } from "./import-ui.js";
import { createCommandEditor } from "./editor.js";
import { changeSummary } from "./data-changes.js";
import { historyReceipt, retainResults } from "./output-history.js";
const $ = (selector) => document.querySelector(selector);
const STORAGE = PRACTICE_KEY;
let saved = emptyStore(),
  storageOK = true;
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE || event.key === null)
    storageWarning(
      "Saved practice changed in another tab. Automatic saving in this tab has stopped to protect both copies. Export this work before reloading to use the other saved copy.",
    );
});
try {
  const raw = localStorage.getItem(STORAGE);
  if (raw) saved = parseStore(raw);
} catch {
  storageWarning(
    "Browser storage is unavailable or saved practice data could not be read. Any saved copy has been left in place. You can still practice; export work you want to keep.",
  );
}
let customDatasets = importCatalog(saved.imports);
const catalog = () => ({ ...DATASETS, ...customDatasets });
const originalData = (id) =>
  Object.hasOwn(DATASETS, id)
    ? createDataset(id)
    : structuredClone(customDatasets[id].data);
let mode = LESSONS.some((l) => l.id === location.hash.slice(1))
    ? "guided"
    : saved.mode,
  lesson =
    LESSONS.find((l) => l.id === location.hash.slice(1)) ||
    LESSONS.find((l) => l.id === saved.current) ||
    LESSONS[0];
let stepIndex = 0,
  session,
  results = [],
  timeline = [],
  commandPassed = false,
  answerPassed = false,
  activeTab = "data",
  selectedAnswer = null,
  initialDataset = mode === "guided" ? lesson.dataset : saved.activeDataset,
  dataPage = 0;
let selectedTrack = lesson.track,
  hintCount = 0,
  lessonFinished = false;
function storageWarning(message) {
  storageOK = false;
  $("#storage-warning").hidden = false;
  $("#storage-warning").textContent = message;
  $("#save-status").textContent = "Export to keep your work";
}
function announce(message) {
  $("#announcer").textContent = message;
}
function entry() {
  return mode === "guided"
    ? saved.lessons[lesson.id]
    : saved.free?.[initialDataset];
}
function persist() {
  const previous = entry() || {};
  const data = {
    ...previous,
    step: stepIndex,
    history: session.history.slice(),
    code: editor.getValue(),
    note: $("#student-notes").value,
    completed: Array.isArray(previous.completed) ? previous.completed : [],
  };
  if (mode === "guided") {
    saved.lessons[lesson.id] = data;
    saved.current = lesson.id;
  } else {
    saved.free ??= {};
    saved.free[initialDataset] = data;
  }
  saved.mode = mode;
  if (mode === "free") saved.activeDataset = initialDataset;
  if (!storageOK) return;
  try {
    const text = JSON.stringify(saved);
    if (new TextEncoder().encode(text).length > MAX_STORE_BYTES)
      throw new Error("Storage size limit");
    localStorage.setItem(STORAGE, text);
    $("#save-status").textContent = "Progress saved on this device";
  } catch {
    storageWarning(
      "This browser could not save your work. Keep practicing, then use Export work to keep a copy.",
    );
  }
}
function loadSession() {
  const record = entry();
  session = new PracticeSession(initialDataset, customDatasets);
  dataPage = 0;
  results = [];
  timeline = [];
  stepIndex =
    mode === "guided"
      ? Math.min(
          lesson.steps.length - 1,
          Math.max(0, Number.isInteger(record?.step) ? record.step : 0),
        )
      : 0;
  if (
    Array.isArray(record?.history) &&
    record.history.length <= 500 &&
    record.history.every((c) => typeof c === "string" && c.length <= 50000)
  ) {
    for (const command of record.history) {
      const output = session.run(command);
      results = retainResults([...results, ...output]);
      timeline.push(...output.map(historyReceipt));
      if (output.some((r) => r.kind === "error")) {
        storageWarning(
          "Some saved commands could not be replayed. Practice stopped at the first error; inspect Results before continuing.",
        );
        break;
      }
    }
  }
  commandPassed = false;
  answerPassed = false;
  selectedAnswer = null;
  hintCount = 0;
  lessonFinished = false;
  editor.setValue(
    typeof record?.code === "string"
      ? record.code.slice(0, 50000)
      : mode === "guided" && stepIndex === 0 && lesson.id === "first-commands"
        ? "describe"
        : mode === "guided"
          ? lesson.steps[stepIndex].starter || ""
          : "",
  );
  $("#student-notes").value =
    typeof record?.note === "string" ? record.note.slice(0, 50000) : "";
  renderAll();
  setTab("data");
}
function renderSidebar() {
  const completedCount = LESSONS.filter(
    (l) => saved.lessons[l.id]?.completed?.length === l.steps.length,
  ).length;
  $("#path-count").textContent = `${completedCount}/${LESSONS.length}`;
  $("#track-select").innerHTML = [
    ...TRACKS,
    { id: "all", title: "All lessons" },
  ]
    .map(
      (track) =>
        `<option value="${track.id}" ${selectedTrack === track.id ? "selected" : ""}>${h(track.title)}</option>`,
    )
    .join("");
  $("#track-description").textContent =
    TRACKS.find((t) => t.id === selectedTrack)?.description ||
    "Every lesson is available. Choose a topic or follow the beginner path.";
  const visibleLessons = LESSONS.filter(
    (l) => selectedTrack === "all" || l.track === selectedTrack,
  );
  $("#lesson-list").innerHTML = visibleLessons
    .map((l) => {
      const i = LESSONS.indexOf(l);
      const done = saved.lessons[l.id]?.completed?.length === l.steps.length;
      return `<button type="button" class="lesson-link" data-lesson="${l.id}" ${mode === "guided" && l.id === lesson.id ? 'aria-current="step"' : ""}><span class="lesson-number">${done ? "✓" : String(i + 1).padStart(2, "0")}</span><strong>${h(l.title)}</strong><small>${h(l.level)} · ${l.minutes} min${done ? " · complete" : ""}</small></button>`;
    })
    .join("");
  $("#lesson-switch").innerHTML =
    `${visibleLessons.some((l) => l.id === lesson.id) ? "" : '<option value="" selected disabled>Choose a lesson in this track</option>'}${visibleLessons.map((l) => `<option value="${l.id}" ${l.id === lesson.id ? "selected" : ""}>${LESSONS.indexOf(l) + 1}. ${h(l.title)}</option>`).join("")}`;
  $("#free-mode").setAttribute("aria-pressed", String(mode === "free"));
}
function renderLesson() {
  const free = mode === "free";
  $("#insert-example").hidden = free;
  $("#next-step").hidden = free;
  $("#restart").textContent = free
    ? "Reset this practice dataset"
    : "Restart this lesson";
  $("#interpretation").hidden = free;
  $('[data-workspace-jump="check"]').hidden = free;
  $("#exercise-check").hidden = free;
  if (free) {
    $("#lesson-content").innerHTML =
      `<div class="lesson-topline"><span>Open practice</span><span>At your own pace</span></div><h2 id="lesson-title">Work through your own questions.</h2><p class="lesson-explanation">Choose a dataset, write commands and inspect the results. Your data stay in this browser. Command help lists the syntax supported here.</p><label for="dataset-select" class="eyebrow">Practice dataset</label><select id="dataset-select" class="dataset-select">${Object.values(
        catalog(),
      )
        .map(
          (d) =>
            `<option value="${d.id}" ${d.id === initialDataset ? "selected" : ""}>${h(d.title)}</option>`,
        )
        .join(
          "",
        )}</select>${customDatasets[initialDataset] ? '<button type="button" id="remove-import" class="text-button remove-import">Remove this imported dataset</button>' : ""}<div class="task-card"><strong>A place to begin</strong><p>Inspect the data with <code>describe</code>, then choose a summary, graph or model. Use Undo to inspect the effect of a change.</p></div>`;
    $("#dataset-select").addEventListener("change", (e) => {
      persist();
      initialDataset = e.target.value;
      loadSession();
      persist();
    });
    $("#remove-import")?.addEventListener("click", removeImport);
    return;
  }
  const step = lesson.steps[stepIndex],
    completed = entry()?.completed || [];
  $("#lesson-content").innerHTML =
    `<div class="lesson-topline"><span>${h(lesson.level)}</span><span>Step ${stepIndex + 1} of ${lesson.steps.length}</span></div><div class="step-progress" role="img" aria-label="Step ${stepIndex + 1} of ${lesson.steps.length}">${lesson.steps.map((_, i) => `<span class="${i === stepIndex ? "active" : completed.includes(i) ? "done" : ""}"></span>`).join("")}</div><h2 id="lesson-title">${h(step.title)}</h2><p class="lesson-explanation">${h(step.explanation)}</p><div class="task-card"><strong>${step.starter ? "Repair the draft" : "Your task"}</strong><p>${h(step.task)}</p></div><div class="lesson-help"><button type="button" id="show-hint" class="text-button" aria-controls="task-hints" aria-expanded="false">Show a hint</button><ol id="task-hints" class="task-hints" aria-live="polite"></ol></div>`;
  renderHints();
  $("#show-hint").addEventListener("click", () => {
    hintCount++;
    renderHints();
  });
  const numeric = step.response?.kind === "number";
  const responseMarkup = numeric
    ? `<label for="numeric-answer" class="numeric-label">${step.response.decimals ? `Enter at least ${step.response.decimals} decimal places` : "Enter a whole number"} · ${h(step.response.unit || "value")}</label><input id="numeric-answer" type="text" inputmode="decimal" autocomplete="off" maxlength="50" aria-describedby="answer-feedback" class="numeric-answer" placeholder="Your result">`
    : `<fieldset class="answer-choices"><legend class="sr-only">${h(step.question)}</legend>${step.answers.map((a, i) => `<label class="answer-option"><input type="radio" name="interpretation" value="${i}"><span>${h(a)}</span></label>`).join("")}</fieldset>`;
  $("#interpretation").innerHTML =
    `<h3>${h(step.question)}</h3>${responseMarkup}<button type="button" id="check-answer" class="quiet-button">Check understanding</button><p id="answer-feedback" class="answer-feedback" role="status"></p>`;
  $("#interpretation")
    .querySelectorAll("input")
    .forEach((input) =>
      input.addEventListener(numeric ? "input" : "change", () => {
        selectedAnswer = numeric ? input.value : Number(input.value);
        answerPassed = false;
        $(".answer-feedback").textContent = "";
        updateNext();
      }),
    );
  $("#check-answer").addEventListener("click", () => {
    const assessment = assessAnswer(step, selectedAnswer);
    answerPassed = assessment.passed;
    $(".answer-feedback").classList.toggle("incorrect", !answerPassed);
    $(".answer-feedback").textContent = assessment.message;
    updateNext();
  });
  $("#next-step").innerHTML =
    stepIndex === lesson.steps.length - 1
      ? 'Finish lesson <span aria-hidden="true">✓</span>'
      : 'Next step <span aria-hidden="true">→</span>';
  updateCheck();
}
function renderHints() {
  const hints = lesson.steps[stepIndex].hints || [];
  $("#task-hints").innerHTML = hints
    .slice(0, hintCount)
    .map((hint) => `<li>${h(hint)}</li>`)
    .join("");
  const button = $("#show-hint");
  button.textContent =
    hintCount === 0
      ? "Show a hint"
      : hintCount >= hints.length
        ? "All hints shown · worked command below"
        : "Show the syntax hint";
  button.disabled = hintCount >= hints.length;
  button.setAttribute("aria-expanded", String(hintCount > 0));
}
function updateCheck(message = "") {
  const box = $("#exercise-check");
  box.className =
    "exercise-check" + (commandPassed ? " success" : message ? " error" : "");
  box.textContent = commandPassed
    ? "✓ Your command produced the expected result. Check your interpretation to continue."
    : message ||
      "Run a command that completes the task. A hint or worked command is available if you need help.";
  updateNext();
}
function updateNext() {
  $("#next-step").disabled = lessonFinished || !(commandPassed && answerPassed);
}
function renderData() {
  $("#preserve-status").hidden = !session.preservedData;
  $("#preserve-status").textContent = session.preservedData
    ? `Preserved copy: ${session.preservedData.rows.length} observations`
    : "";
  const data = session.data,
    changedCells = new Map(
      (results.at(-1)?.effect?.cells || []).map((c) => [
        `${c.observation}:${c.name}`,
        c,
      ]),
    ),
    metadata = catalog()[data.id],
    selected = new Set(
      results.at(-1)?.kind === "count" ? results.at(-1).selected : [],
    ),
    newColumn = ["generate", "predict"].includes(results.at(-1)?.kind)
      ? results.at(-1).name
      : null;
  $("#dataset-title").textContent = metadata.title;
  $("#dataset-count").textContent =
    `${data.rows.length} observations · ${data.columns.length} variables`;
  $("#dataset-unit").textContent = metadata.unit;
  $("#dataset-origin").textContent =
    metadata.synthetic === false ? "Imported locally" : "Synthetic data";
  $("#download-source").hidden = !customDatasets[initialDataset];
  $("#import-export-note").hidden = !usedImports().length;
  $("#data-description").textContent = metadata.description;
  const pages = Math.max(1, Math.ceil(data.rows.length / 50));
  dataPage = Math.min(dataPage, pages - 1);
  $("#data-pagination").hidden = data.rows.length <= 50;
  $("#data-pagination").innerHTML =
    `<button type="button" id="data-prev" class="quiet-button" ${dataPage === 0 ? "disabled" : ""}>Previous rows</button><label>Page <input id="data-page" type="number" min="1" max="${pages}" value="${dataPage + 1}" aria-label="Data page"></label><span>of ${pages} · rows ${dataPage * 50 + 1}–${Math.min((dataPage + 1) * 50, data.rows.length)} of ${data.rows.length}</span><button type="button" id="data-next" class="quiet-button" ${dataPage === pages - 1 ? "disabled" : ""}>Next rows</button>`;
  $("#data-prev").addEventListener("click", () => {
    dataPage--;
    renderData();
  });
  $("#data-next").addEventListener("click", () => {
    dataPage++;
    renderData();
  });
  $("#data-page").addEventListener("change", (event) => {
    const page = Number(event.target.value);
    if (Number.isInteger(page) && page >= 1 && page <= pages)
      dataPage = page - 1;
    renderData();
  });
  $("#data-table").innerHTML = data.columns.length
    ? `<table class="data-table"><caption class="sr-only">${h(metadata.title)}. A dot indicates a numeric missing value.</caption><thead><tr><th scope="col">Obs.</th>${data.columns.map((c) => `<th scope="col" class="${c.name === newColumn ? "new-column" : ""}"><button type="button" data-variable="${h(c.name)}" aria-label="Inspect variable ${h(c.name)}">${h(c.name)}</button></th>`).join("")}</tr></thead><tbody>${data.rows
        .map((r, i) => ({ r, i }))
        .slice(dataPage * 50, (dataPage + 1) * 50)
        .map(
          ({ r, i }) =>
            `<tr class="${selected.has(i) ? "highlighted" : ""}"><td>${i + 1}</td>${data.columns.map((c) => `<td class="${changedCells.has(`${i + 1}:${c.name}`) ? "changed-cell " : ""}${r[c.name] === null || r[c.name] === "" ? "missing" : c.name === newColumn ? "new-column" : ""}">${r[c.name] === null ? '<span aria-label="missing">.</span>' : typeof r[c.name] === "number" ? fmt(r[c.name]) : h(r[c.name])}</td>`).join("")}</tr>`,
        )
        .join("")}</tbody></table>`
    : '<div class="empty-state">No data in memory. Import a practice dataset or use Undo.</div>';
  $("#data-table")
    .querySelectorAll("[data-variable]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const c = data.columns.find((c) => c.name === button.dataset.variable),
          count = data.rows.filter(
            (r) => r[c.name] === null || r[c.name] === "",
          ).length;
        $("#variable-detail").innerHTML =
          `<strong>${h(c.name)}</strong> · ${h(c.type)} · ${count} missing of ${data.rows.length}<br>${h(c.label || "No variable label set.")}<br>${c.type === "numeric" ? "A dot (.) represents numeric missing. It is not zero." : "Text values need double quotes in expressions."}`;
      }),
    );
}
function renderResults() {
  $("#result-count").textContent = results.length || "";
  $("#results").innerHTML = results.length
    ? results
        .map((r, i) => resultHTML(r, i))
        .reverse()
        .join("")
    : '<div class="empty-state"><h3>Your results will appear here.</h3><p>Run a command in the editor. Each result stays paired with the command that produced it.</p></div>';
  $("#results")
    .querySelectorAll("[data-coefficient]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const i = Number(button.dataset.result);
        $(`[data-annotation="${i}"]`).textContent = explainCoefficient(
          results[i].model,
          button.dataset.coefficient,
        );
      }),
    );
}
function renderHistory() {
  $("#history-count").textContent = timeline.length || "";
  $("#command-history").innerHTML = timeline.length
    ? timeline
        .map((result, i) => {
          const effect = result.effect;
          const cellValue = (value) =>
            value === null ? ". (missing)" : h(value);
          const cells = effect?.cells || [];
          return `<article class="history-entry ${result.kind === "error" ? "failed" : ""}">
      <div class="history-marker" aria-hidden="true">${String(i + 1).padStart(2, "0")}</div>
      <div class="history-body"><code>${h(result.command)}</code>
      <p>${result.kind === "error" ? `Stopped with r(${result.code}): ${h(result.message)}` : h(changeSummary(effect))}</p>
      ${effect && result.kind !== "error" ? `<span class="history-dimensions">${effect.beforeRows} → ${effect.afterRows} observations · ${effect.beforeColumns} → ${effect.afterColumns} variables</span>` : ""}
      ${cells.length ? `<details class="change-details"><summary>Inspect ${effect.changedCells} changed value${effect.changedCells === 1 ? "" : "s"}</summary><div class="result-table-wrap" tabindex="0" role="region" aria-label="Changed values"><table class="result-table"><thead><tr><th scope="col">Obs.</th><th scope="col">Variable</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${cells.map((c) => `<tr><td>${c.observation}</td><td>${h(c.name)}</td><td>${cellValue(c.before)}</td><td>${cellValue(c.after)}</td></tr>`).join("")}</tbody></table></div>${effect.changedCells > cells.length ? `<p>Showing the first ${cells.length} changes.</p>` : ""}</details>` : ""}
      <button type="button" class="text-button" data-reuse-command="${i}">Load in editor</button>
      </div></article>`;
        })
        .reverse()
        .join("")
    : '<div class="empty-state"><h3>No commands yet.</h3><p>Each run will appear here with its effect on the data. Errors leave the data unchanged.</p></div>';
  $("#command-history")
    .querySelectorAll("[data-reuse-command]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        editor.setValue(timeline[Number(button.dataset.reuseCommand)].command);
        editor.focus();
        persist();
        announce("Command loaded into the editor. It has not run.");
      }),
    );
}
function renderAll() {
  renderSidebar();
  renderLesson();
  renderData();
  renderResults();
  renderHistory();
  renderGraph($("#graph"), session.graph);
  $("#undo").disabled = !session.undoStack.length;
}
function setTab(name, focus = false) {
  activeTab = name;
  for (const tab of ["data", "results", "graph", "history"]) {
    const button = $(`#tab-${tab}`);
    button.setAttribute("aria-selected", String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
    $(`#panel-${tab}`).hidden = name !== tab;
  }
  if (focus) $(`#tab-${name}`).focus();
}
function run(scope = "all") {
  let output, range;
  const fullSource = editor.getValue();
  try {
    range =
      scope === "current"
        ? editor.range()
        : { from: 0, to: fullSource.length, line: 1, text: fullSource };
    if (!range) {
      announce("There is no command at or after the cursor.");
      return;
    }
    output = session.run(range.text);
    for (const result of output)
      if (result.source)
        result.source = {
          ...result.source,
          from: result.source.from + range.from,
          to: result.source.to + range.from,
          line: result.source.line + range.line - 1,
          endLine: result.source.endLine + range.line - 1,
        };
  } catch (e) {
    output = [
      {
        kind: "error",
        command: range?.text ?? fullSource,
        source: e.source
          ? {
              ...e.source,
              from: e.source.from + (range?.from || 0),
              to: e.source.to + (range?.from || 0),
              line: e.source.line + (range?.line || 1) - 1,
            }
          : undefined,
        message: e.message,
        code: e.code || 198,
        hint: e.hint || "Correct the do-file syntax and run again.",
      },
    ];
  }
  if (!output.length) {
    announce("Enter a command before running.");
    updateCheck("The editor is empty. Type a command or load the example.");
    return;
  }
  results = retainResults([...results, ...output]);
  timeline.push(...output.map(historyReceipt));
  if (timeline.length > 500) timeline = timeline.slice(-500);
  const last = output.at(-1);
  if (last.kind === "count" && last.selected.length)
    dataPage = Math.floor(last.selected[0] / 50);
  else if (last.effect?.cells.length)
    dataPage = Math.floor((last.effect.cells[0].observation - 1) / 50);
  else if (last.changed) dataPage = 0;
  if (last.source)
    editor.mark(last.source.from, last.source.to, last.kind === "error");
  if (scope === "current" && !range?.selection && last.kind !== "error")
    editor.advance(range.to);
  if (mode === "guided") {
    const assessment = assessStep(lesson, stepIndex, session, last);
    commandPassed = assessment.passed;
    updateCheck(assessment.message);
  }
  renderData();
  renderResults();
  renderHistory();
  renderGraph($("#graph"), session.graph);
  $("#undo").disabled = !session.undoStack.length;
  const view = ["scatter", "histogram"].includes(last.kind)
    ? "graph"
    : [
          "generate",
          "replace",
          "predict",
          "rename",
          "drop",
          "keep",
          "sort",
          "restore",
        ].includes(last.kind)
      ? "data"
      : "results";
  setTab(view);
  $("#activity-note").textContent =
    last.kind === "error"
      ? `Stopped: ${last.message}`
      : last.changed
        ? last.message ||
          "The data changed. Inspect the updated columns and values."
        : `Completed: ${last.command}. ${session.data.rows.length} observations remain in memory.`;
  announce(
    last.kind === "error"
      ? `Command stopped: ${last.message}`
      : `Command completed. ${view === "data" ? "Data browser updated." : view === "graph" ? "Graph updated." : "Results updated."}`,
  );
  $("#mobile-output-state").textContent =
    last.kind === "error" ? "· error" : "· updated";
  persist();
}
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}
const editor = createCommandEditor($("#code-editor"), {
  onChange: scheduleSave,
  onRun: run,
  variables: () => session?.data.columns || [],
  announce,
});
$("#run").addEventListener("click", () => run("all"));
$("#run-line").addEventListener("click", () => run("current"));
$("#student-notes").addEventListener("input", scheduleSave);
window.addEventListener("pagehide", persist);
$("#insert-example").addEventListener("click", () => {
  const step = lesson.steps[stepIndex];
  const repair = step.repairWhen;
  const isRepair = repair?.variables.every((name) =>
    session.data.columns.some((c) => c.name === name),
  );
  editor.setValue(isRepair ? repair.command : step.command);
  editor.focus();
  persist();
  announce(
    `${isRepair ? "Repair" : "Worked command"} loaded into the editor. It has not run.`,
  );
});
$("#undo").addEventListener("click", () => {
  if (session.undo()) {
    commandPassed = false;
    answerPassed = false;
    selectedAnswer = null;
    const undone = results.findLastIndex((result) => result.kind !== "error");
    if (undone >= 0) results = results.slice(0, undone);
    const event = timeline.findLastIndex((result) => result.kind !== "error");
    if (event >= 0) timeline = timeline.slice(0, event);
    renderAll();
    setTab("data");
    persist();
    announce(
      "Undid the previous successful command. Data and fitted model were restored.",
    );
  }
});
function openLesson(id) {
  const selected = LESSONS.find((l) => l.id === id);
  if (!selected) return;
  persist();
  mode = "guided";
  lesson = selected;
  selectedTrack = selected.track;
  initialDataset = lesson.dataset;
  history.replaceState(null, "", "#" + lesson.id);
  loadSession();
  persist();
  announce(`Opened ${lesson.title}.`);
}
$("#lesson-list").addEventListener("click", (e) => {
  const button = e.target.closest("[data-lesson]");
  if (button) openLesson(button.dataset.lesson);
});
$("#lesson-switch").addEventListener("change", (event) =>
  openLesson(event.target.value),
);
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (
    LESSONS.some((candidate) => candidate.id === id) &&
    (mode !== "guided" || lesson.id !== id)
  )
    openLesson(id);
});
$("#track-select").addEventListener("change", (event) => {
  selectedTrack = event.target.value;
  renderSidebar();
  announce(
    `Showing ${selectedTrack === "all" ? "all lessons" : TRACKS.find((t) => t.id === selectedTrack).title}. Your current work is still open.`,
  );
});
document.querySelectorAll("[data-workspace-jump]").forEach((button) =>
  button.addEventListener("click", () => {
    const target = button.dataset.workspaceJump;
    const element =
      target === "task"
        ? $("#lesson-content")
        : target === "editor"
          ? $(".editor-section")
          : target === "check"
            ? $("#interpretation")
            : $(".observation-pane");
    element.scrollIntoView({ block: "start" });
    if (target === "editor") editor.focus();
    else {
      element.tabIndex = -1;
      element.focus({ preventScroll: true });
    }
  }),
);
$("#free-mode").addEventListener("click", () => {
  persist();
  mode = "free";
  initialDataset = saved.activeDataset;
  history.replaceState(null, "", "#practice");
  loadSession();
  persist();
  announce("Open practice. Choose a dataset and write your own commands.");
});
$("#restart").addEventListener("click", () => {
  if (
    !confirm(
      mode === "guided"
        ? "Restart this lesson? Its practice commands and progress will be cleared. Your notes will be kept."
        : "Reset this practice dataset? Its commands will be cleared. Your notes will be kept.",
    )
  )
    return;
  const note = $("#student-notes").value;
  if (mode === "guided") saved.lessons[lesson.id] = { note, completed: [] };
  else saved.free[initialDataset] = { note };
  loadSession();
  persist();
  announce("Practice restarted with the original data.");
});
$("#next-step").addEventListener("click", () => {
  if (lessonFinished || !(commandPassed && answerPassed)) return;
  persist();
  const record = entry();
  record.completed = [...new Set([...record.completed, stepIndex])];
  if (stepIndex === lesson.steps.length - 1) {
    lessonFinished = true;
    persist();
    renderSidebar();
    $("#lesson-content").insertAdjacentHTML(
      "beforeend",
      `<div class="completed-panel" role="status"><h3>Lesson complete.</h3><p>You have checked each command and its interpretation. Export your work, continue to the next lesson, or use open practice to explore.</p></div>`,
    );
    $("#next-step").disabled = true;
    const next = LESSONS[LESSONS.indexOf(lesson) + 1];
    if (next) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "quiet-button";
      b.style.marginTop = "12px";
      b.textContent = "Continue: " + next.title;
      b.addEventListener("click", () => {
        persist();
        lesson = next;
        selectedTrack = next.track;
        initialDataset = lesson.dataset;
        history.replaceState(null, "", "#" + lesson.id);
        loadSession();
        persist();
      });
      $(".completed-panel").append(b);
    }
    announce("Lesson complete.");
    return;
  }
  stepIndex++;
  commandPassed = false;
  answerPassed = false;
  selectedAnswer = null;
  hintCount = 0;
  editor.setValue(lesson.steps[stepIndex].starter || "");
  renderLesson();
  persist();
  announce(`Step ${stepIndex + 1}: ${lesson.steps[stepIndex].title}`);
  $("#lesson-title").tabIndex = -1;
  $("#lesson-title").focus();
});
$("#clear-results").addEventListener("click", () => {
  results = [];
  renderResults();
  announce("Results display cleared. Data and command history are unchanged.");
});
for (const name of ["data", "results", "graph", "history"]) {
  $(`#tab-${name}`).addEventListener("click", () => setTab(name));
  $(`#tab-${name}`).addEventListener("keydown", (e) => {
    const tabs = ["data", "results", "graph", "history"],
      i = tabs.indexOf(name);
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      setTab(
        e.key === "Home"
          ? "data"
          : e.key === "End"
            ? "history"
            : tabs[
                (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) %
                  tabs.length
              ],
        true,
      );
    }
  });
}
for (const name of ["help", "limits", "export", "import"])
  $(`#${name}-open`).addEventListener("click", () =>
    $(`#${name}-dialog`).showModal(),
  );
function usedImports() {
  const used = new Set(customDatasets[initialDataset] ? [initialDataset] : []);
  for (const command of session.history) {
    const file = command.match(/^import\s+delimited\s+using\s+"([^"]+)"/)?.[1];
    const entry = Object.values(customDatasets).find(
      (dataset) => dataset.file === file,
    );
    if (entry) used.add(entry.id);
  }
  return [...used].map((id) => customDatasets[id]);
}
function removeImport() {
  const id = initialDataset,
    dataset = customDatasets[id];
  if (!dataset) return;
  const references = [
    ...Object.entries(saved.lessons),
    ...Object.entries(saved.free).filter(([key]) => key !== id),
  ].filter(([, record]) =>
    record.history?.some((command) => command.includes(`"${dataset.file}"`)),
  );
  if (references.length) {
    announce(
      "This source is used in other saved sessions. Export and reset those sessions before removing their input file.",
    );
    $("#remove-import").textContent =
      "Used by other sessions — export and reset them first";
    return;
  }
  if (
    !confirm(
      `Remove ${dataset.title} and its saved open-practice commands and notes from this browser? Export its complete Stata project first if you want to keep a copy.`,
    )
  )
    return;
  persist();
  delete saved.imports[id];
  delete saved.free[id];
  customDatasets = importCatalog(saved.imports);
  initialDataset = "study";
  saved.activeDataset = "study";
  loadSession();
  persist();
  announce(
    "Imported dataset removed from this browser. Other work remains available.",
  );
}
setupImportDialog($("#import-dialog"), (record) => {
  persist();
  let id;
  do {
    id = "local_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  } while (Object.hasOwn(saved.imports, id));
  const imports = validateImportLibrary({ ...saved.imports, [id]: record });
  if (
    new TextEncoder().encode(JSON.stringify({ ...saved, imports })).length >
    MAX_STORE_BYTES
  )
    throw new Error(
      "This import would exceed the 4 MB saved-work limit. Export and remove older imported work first.",
    );
  saved.imports = imports;
  customDatasets = importCatalog(imports);
  mode = "free";
  initialDataset = id;
  history.replaceState(null, "", "#practice");
  loadSession();
  editor.setValue("describe");
  persist();
  announce(`Imported ${record.filename}. Review the data, then run a command.`);
});
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
$("#command-reference").innerHTML = REFERENCE.map(
  ([title, commands]) =>
    `<section class="reference-group"><h3>${h(title)}</h3>${commands.map(([syntax, explanation]) => `<div class="reference-command"><code>${h(syntax)}</code><p>${h(explanation)}</p></div>`).join("")}</section>`,
).join("");
function download(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#export-status").textContent =
    `Prepared ${filename}. Check your browser downloads.`;
}
function doFile() {
  const dataset = catalog()[initialDataset];
  const history = session.history.map((command) => {
    const file = command.match(/^import\s+delimited\s+using\s+"([^"]+)"/)?.[1];
    const entry = Object.values(catalog()).find((d) => d.file === file);
    return entry
      ? nativeImportCommand(entry.file, originalData(entry.id))
      : command;
  });
  return [
    "* STATAverse browser practice",
    "* study.csv, wages.csv and clinic.csv are synthetic teaching data.",
    "* Any local_*.csv files contain your supplied data with reviewed import decisions.",
    "* Put this do-file beside the downloaded original CSV files.",
    "* In Stata, cd to that folder before running this file.",
    "* Browser practice is a subset; output formatting may differ.",
    "clear all",
    "set more off",
    nativeImportCommand(dataset.file, originalData(initialDataset)),
    "",
    ...history,
    ...(session.preservedData
      ? [
          "",
          "* Keep the current working data at do-file completion, matching the browser.",
          "* The earlier preserved copy is temporary and is not part of this final dataset.",
          "restore, not",
        ]
      : []),
    "",
  ].join("\n");
}
function notesText() {
  return [
    "STATAverse practice",
    mode === "guided" ? lesson.title : "Open practice",
    `Dataset: ${catalog()[initialDataset].title}`,
    "",
    "Notes",
    $("#student-notes").value,
    "",
    "Results (including errors)",
    ...results.map((r) =>
      resultHTML(r, 0, { complete: true })
        .replace(/<[^>]+>/g, " ")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    ),
  ].join("\n\n");
}
$("#download-original").addEventListener("click", () =>
  download(
    catalog()[initialDataset].file,
    toCSV(originalData(initialDataset)),
    "text/csv;charset=utf-8",
  ),
);
$("#download-source").addEventListener("click", () => {
  const dataset = customDatasets[initialDataset];
  if (dataset)
    download(
      `${dataset.id}-source.txt`,
      dataset.record.source,
      "text/plain;charset=utf-8",
    );
});
$("#download-current").addEventListener("click", () =>
  download("current-data.csv", toCSV(session.data), "text/csv;charset=utf-8"),
);
$("#download-do").addEventListener("click", () =>
  download("stataverse-analysis.do", doFile()),
);
$("#download-notes").addEventListener("click", () =>
  download("stataverse-notes.txt", notesText()),
);
const zipButton = document.createElement("button");
zipButton.type = "button";
zipButton.className = "primary-button";
zipButton.textContent = "Download complete Stata project (.zip)";
zipButton.style.gridColumn = "1 / -1";
$(".export-grid").prepend(zipButton);
zipButton.addEventListener("click", () => {
  const files = {
    "analysis.do": strToU8(doFile()),
    "notes.txt": strToU8(notesText()),
    "current-data.csv": strToU8(toCSV(session.data)),
    "editor-draft.do": strToU8(editor.getValue()),
    "README.txt": strToU8(
      "STATAverse practice project\n\nExtract this ZIP. In Stata, change the working directory to this folder and run analysis.do.\nThe study.csv, wages.csv and clinic.csv files are synthetic teaching datasets. Any local_*.csv files are your supplied data after the recorded import decisions; they have not been independently verified. current-data.csv contains the final working data.\nFor each imported source used by this session, a -source.txt file retains its untouched UTF-8 text and a -import.json file records the original filename, delimiter, headings, missing-value markers, variable names and types. The normalized starting CSV is used by analysis.do. Other imported datasets in your library are excluded.\nThe do-file repeats successful commands, with explicit numeric/string import columns. Failed commands are recorded in notes.txt. editor-draft.do preserves the current editor text, including comments and commands that may not have run. If a preserved copy is active, the do-file discards that temporary copy at completion to retain the working data.\nStata CSV import depends on its installed runtime; browser preview does not establish native import success on every installation. Original header labels are recorded in the import metadata and source, rather than injected as executable Stata code.\n",
    ),
  };
  for (const dataset of Object.values(DATASETS))
    files[dataset.file] = strToU8(toCSV(createDataset(dataset.id)));
  for (const dataset of usedImports()) {
    files[dataset.file] = strToU8(toCSV(dataset.data));
    files[`${dataset.id}-source.txt`] = strToU8(dataset.record.source);
    const { source, ...metadata } = dataset.record;
    files[`${dataset.id}-import.json`] = strToU8(
      JSON.stringify(metadata, null, 2) + "\n",
    );
  }
  download(
    "stataverse-project.zip",
    zipSync(files, { level: 6 }),
    "application/zip",
  );
});
loadSession();
registerOffline();
