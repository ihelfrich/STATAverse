import { PracticeSession, splitDoFile } from "./engine.js";
import { DATASETS, createDataset, toCSV } from "./datasets.js";
import { LESSONS, checkStep } from "./lessons.js";
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
import { PRACTICE_KEY, emptyStore, parseStore } from "./persistence.js";
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
let mode = "guided",
  lesson =
    LESSONS.find((l) => l.id === location.hash.slice(1)) ||
    LESSONS.find((l) => l.id === saved.current) ||
    LESSONS[0];
let stepIndex = 0,
  session,
  results = [],
  commandPassed = false,
  answerPassed = false,
  activeTab = "data",
  selectedAnswer = null,
  initialDataset = lesson.dataset;
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
    code: $("#command-editor").value,
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
  if (!storageOK) return;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(saved));
    $("#save-status").textContent = "Progress saved on this device";
  } catch {
    storageWarning(
      "This browser could not save your work. Keep practicing, then use Export work to keep a copy.",
    );
  }
}
function loadSession() {
  const record = entry();
  session = new PracticeSession(initialDataset);
  results = [];
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
      results.push(...output);
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
  $("#command-editor").value =
    typeof record?.code === "string"
      ? record.code.slice(0, 50000)
      : mode === "guided" && stepIndex === 0 && lesson.id === "first-commands"
        ? "describe"
        : "";
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
  $("#lesson-list").innerHTML = LESSONS.map((l, i) => {
    const done = saved.lessons[l.id]?.completed?.length === l.steps.length;
    return `<button type="button" class="lesson-link" data-lesson="${l.id}" ${mode === "guided" && l.id === lesson.id ? 'aria-current="step"' : ""}><span class="lesson-number">${done ? "✓" : String(i + 1).padStart(2, "0")}</span><strong>${h(l.title)}</strong><small>${h(l.level)} · ${l.minutes} min${done ? " · complete" : ""}</small></button>`;
  }).join("");
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
  $("#exercise-check").hidden = free;
  if (free) {
    $("#lesson-content").innerHTML =
      `<div class="lesson-topline"><span>Open practice</span><span>At your own pace</span></div><h2 id="lesson-title">Work through your own questions.</h2><p class="lesson-explanation">Choose a dataset, write commands and inspect the results. Your data stay in this browser. Command help lists the syntax supported here.</p><label for="dataset-select" class="eyebrow">Practice dataset</label><select id="dataset-select" class="dataset-select">${Object.values(
        DATASETS,
      )
        .map(
          (d) =>
            `<option value="${d.id}" ${d.id === initialDataset ? "selected" : ""}>${h(d.title)}</option>`,
        )
        .join(
          "",
        )}</select><div class="task-card"><strong>A place to begin</strong><p>Inspect the data with <code>describe</code>, then choose a summary, graph or model. Use Undo to inspect the effect of a change.</p></div>`;
    $("#dataset-select").addEventListener("change", (e) => {
      persist();
      initialDataset = e.target.value;
      loadSession();
    });
    return;
  }
  const step = lesson.steps[stepIndex],
    completed = entry()?.completed || [];
  $("#lesson-content").innerHTML =
    `<div class="lesson-topline"><span>${h(lesson.level)}</span><span>Step ${stepIndex + 1} of ${lesson.steps.length}</span></div><div class="step-progress" role="img" aria-label="Step ${stepIndex + 1} of ${lesson.steps.length}">${lesson.steps.map((_, i) => `<span class="${i === stepIndex ? "active" : completed.includes(i) ? "done" : ""}"></span>`).join("")}</div><h2 id="lesson-title">${h(step.title)}</h2><p class="lesson-explanation">${h(step.explanation)}</p><div class="task-card"><strong>Your task</strong><p>${h(step.task)}</p></div>`;
  $("#interpretation").innerHTML =
    `<h3>${h(step.question)}</h3><fieldset style="border:0;padding:0;margin:0"><legend class="sr-only">${h(step.question)}</legend>${step.answers.map((a, i) => `<label class="answer-option"><input type="radio" name="interpretation" value="${i}"><span>${h(a)}</span></label>`).join("")}</fieldset><button type="button" id="check-answer" class="quiet-button" style="margin-top:9px">Check understanding</button><p class="answer-feedback" role="status"></p>`;
  $("#interpretation")
    .querySelectorAll("input")
    .forEach((input) =>
      input.addEventListener("change", () => {
        selectedAnswer = Number(input.value);
        answerPassed = false;
        $(".answer-feedback").textContent = "";
        updateNext();
      }),
    );
  $("#check-answer").addEventListener("click", () => {
    if (selectedAnswer === null) {
      $(".answer-feedback").textContent = "Choose an answer first.";
      return;
    }
    answerPassed = selectedAnswer === step.correct;
    $(".answer-feedback").classList.toggle("incorrect", !answerPassed);
    $(".answer-feedback").textContent = answerPassed
      ? step.feedback
      : "That interpretation does not follow from this command. Revisit the explanation and inspect the result, then try again.";
    updateNext();
  });
  $("#next-step").innerHTML =
    stepIndex === lesson.steps.length - 1
      ? 'Finish lesson <span aria-hidden="true">✓</span>'
      : 'Next step <span aria-hidden="true">→</span>';
  updateCheck();
}
function updateCheck(message = "") {
  const box = $("#exercise-check");
  box.className =
    "exercise-check" + (commandPassed ? " success" : message ? " error" : "");
  box.textContent = commandPassed
    ? "✓ Your command produced the expected result. Check your interpretation to continue."
    : message ||
      "Run a command that completes the task. Load the example if you need a starting point.";
  updateNext();
}
function updateNext() {
  $("#next-step").disabled = !(commandPassed && answerPassed);
}
function renderData() {
  const data = session.data,
    metadata = DATASETS[data.id],
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
  $("#data-description").textContent = metadata.description;
  $("#data-table").innerHTML = data.columns.length
    ? `<table class="data-table"><caption class="sr-only">${h(metadata.title)}. A dot indicates a numeric missing value.</caption><thead><tr><th scope="col">Obs.</th>${data.columns.map((c) => `<th scope="col" class="${c.name === newColumn ? "new-column" : ""}"><button type="button" data-variable="${h(c.name)}" aria-label="Inspect variable ${h(c.name)}">${h(c.name)}</button></th>`).join("")}</tr></thead><tbody>${data.rows.map((r, i) => `<tr class="${selected.has(i) ? "highlighted" : ""}"><td>${i + 1}</td>${data.columns.map((c) => `<td class="${r[c.name] === null || r[c.name] === "" ? "missing" : c.name === newColumn ? "new-column" : ""}">${r[c.name] === null ? '<span aria-label="missing">.</span>' : typeof r[c.name] === "number" ? fmt(r[c.name]) : h(r[c.name])}</td>`).join("")}</tr>`).join("")}</tbody></table>`
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
function renderAll() {
  renderSidebar();
  renderLesson();
  renderData();
  renderResults();
  renderGraph($("#graph"), session.graph);
  $("#undo").disabled = !session.undoStack.length;
}
function setTab(name, focus = false) {
  activeTab = name;
  for (const tab of ["data", "results", "graph"]) {
    const button = $(`#tab-${tab}`);
    button.setAttribute("aria-selected", String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
    $(`#panel-${tab}`).hidden = name !== tab;
  }
  if (focus) $(`#tab-${name}`).focus();
}
function run() {
  let output;
  try {
    output = session.run($("#command-editor").value);
  } catch (e) {
    output = [
      {
        kind: "error",
        command: $("#command-editor").value,
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
  results.push(...output);
  if (results.length > 200) results = results.slice(-200);
  const last = output.at(-1);
  if (mode === "guided") {
    commandPassed = checkStep(lesson, stepIndex, session, last);
    updateCheck(
      commandPassed
        ? ""
        : last.kind === "error"
          ? "The command stopped with an error. Read Results for the cause and a next step."
          : "The command ran, but the result does not yet match this task. Check the variable names, sample and dataset state.",
    );
  }
  renderData();
  renderResults();
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
  persist();
}
$("#run").addEventListener("click", run);
$("#command-editor").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    run();
  }
});
let saveTimer;
for (const input of [$("#command-editor"), $("#student-notes")])
  input.addEventListener("input", () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
  });
window.addEventListener("pagehide", persist);
$("#insert-example").addEventListener("click", () => {
  $("#command-editor").value = lesson.steps[stepIndex].command;
  $("#command-editor").focus();
  persist();
  announce("Example loaded into the editor. It has not run.");
});
$("#undo").addEventListener("click", () => {
  if (session.undo()) {
    commandPassed = false;
    answerPassed = false;
    selectedAnswer = null;
    const undone = results.findLastIndex((result) => result.kind !== "error");
    if (undone >= 0) results = results.slice(0, undone);
    renderAll();
    setTab("data");
    persist();
    announce(
      "Undid the previous successful command. Data and fitted model were restored.",
    );
  }
});
$("#lesson-list").addEventListener("click", (e) => {
  const button = e.target.closest("[data-lesson]");
  if (!button) return;
  persist();
  mode = "guided";
  lesson = LESSONS.find((l) => l.id === button.dataset.lesson);
  initialDataset = lesson.dataset;
  history.replaceState(null, "", "#" + lesson.id);
  loadSession();
  persist();
  announce(`Opened ${lesson.title}.`);
});
$("#free-mode").addEventListener("click", () => {
  persist();
  mode = "free";
  initialDataset = "study";
  loadSession();
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
  if (!(commandPassed && answerPassed)) return;
  persist();
  const record = entry();
  record.completed = [...new Set([...record.completed, stepIndex])];
  if (stepIndex === lesson.steps.length - 1) {
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
  $("#command-editor").value = "";
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
for (const name of ["data", "results", "graph"]) {
  $(`#tab-${name}`).addEventListener("click", () => setTab(name));
  $(`#tab-${name}`).addEventListener("keydown", (e) => {
    const tabs = ["data", "results", "graph"],
      i = tabs.indexOf(name);
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      setTab(
        e.key === "Home"
          ? "data"
          : e.key === "End"
            ? "graph"
            : tabs[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3],
        true,
      );
    }
  });
}
for (const name of ["help", "limits", "export"])
  $(`#${name}-open`).addEventListener("click", () =>
    $(`#${name}-dialog`).showModal(),
  );
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
  return [
    "* STATAverse browser practice — synthetic teaching data",
    "* Put this do-file beside the downloaded original CSV files.",
    "* In Stata, cd to that folder before running this file.",
    "* Browser practice is a subset; output formatting may differ.",
    "clear all",
    "set more off",
    `import delimited using "${DATASETS[initialDataset].file}", clear`,
    "",
    ...session.history,
    "",
  ].join("\n");
}
function notesText() {
  return [
    "STATAverse practice",
    mode === "guided" ? lesson.title : "Open practice",
    `Dataset: ${DATASETS[initialDataset].title}`,
    "",
    "Notes",
    $("#student-notes").value,
    "",
    "Results (including errors)",
    ...results.map((r) =>
      resultHTML(r, 0)
        .replace(/<[^>]+>/g, " ")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&"),
    ),
  ].join("\n\n");
}
$("#download-original").addEventListener("click", () =>
  download(
    DATASETS[initialDataset].file,
    toCSV(createDataset(initialDataset)),
    "text/csv;charset=utf-8",
  ),
);
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
    "README.txt": strToU8(
      "STATAverse synthetic practice project\n\nExtract this ZIP. In Stata, change the working directory to this folder and run analysis.do.\nThe three named CSV files are original practice datasets; current-data.csv contains your final browser data.\nThe do-file begins with the original dataset and repeats successful commands. Failed commands are recorded in notes.txt.\nAll data are synthetic. No causal or population claims are implied.\n",
    ),
  };
  for (const dataset of Object.values(DATASETS))
    files[dataset.file] = strToU8(toCSV(createDataset(dataset.id)));
  download(
    "stataverse-project.zip",
    zipSync(files, { level: 6 }),
    "application/zip",
  );
});
loadSession();
registerOffline();
