// The project lab's page: twelve guided steps on one Stata session. The
// session runs in a worker (project-lab-worker.js); this file keeps what the
// student has typed and run, asks the worker to run and to check, and shows
// what comes back. Nothing of a file the student opens is written to
// storage; progress on the bundled panel is.
import { initLabChrome } from "./labs/chrome.js";
import {
  EXPECTED_COLUMNS,
  LAB_STEPS,
  PANEL_LOAD,
  blankLines,
  changesSession,
  DATE_COLUMNS,
  forData,
  stepFor,
} from "./panel-project/lab-steps.js";
import { assess, preflight, prepareLines } from "./panel-project/lab-checks.js";
import { PANEL_CSV, doFileOf } from "./panel-project/lab-export.js";
import { fileKind, megabytes, refusal } from "./console-files.js";
import { escapeHTML } from "./render.js";
import { registerOffline } from "./offline.js";

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "stataverse:project-lab:v1";
const PAGE_ROWS = 50;
const MAX_RECORDS = 500;
const indexOf = (id) => LAB_STEPS.findIndex((step) => step.id === id);
/**
 * Whether the data in use hold the two dates the robustness step's date
 * screen reads. The bundled panel does; a student's file may not.
 */
const dated = () =>
  !state.source.own ||
  preflight(state.source.columns ?? state.memory?.variables ?? []).every(
    (row) => !DATE_COLUMNS.includes(row.name) || row.state === "ok",
  );
/** A step as the data in use allow. */
const view = (step) => stepFor(step, { dated: dated() });
const thousands = (n) => Number(n).toLocaleString("en-US");

const BUILT_IN = { own: false, name: "panel.dta", load: PANEL_LOAD };

const state = {
  source: BUILT_IN,
  step: 0,
  /** What the student has typed for each step. */
  editors: {},
  /** How many hints each step has shown. */
  hints: {},
  worked: {},
  /** "checked" when a step's checks passed, "worked" when it was replayed. */
  passed: {},
  /** The last result of each step's Run, for this visit only. */
  results: {},
  /** The runs the session holds, in order. */
  timeline: [],
  /** The step the worker's saved copy of the data precedes. */
  markStep: null,
  markLength: 0,
  touched: false,
  memory: null,
  busy: "",
  running: false,
  ready: false,
  history: [],
  historyAt: 0,
  browse: { where: "", from: 0 },
  tab: "results",
};

// ----- the worker -----

let worker = null,
  sequence = 0;
const waiting = new Map();

function startWorker() {
  return new Promise((resolve, reject) => {
    let candidate;
    try {
      candidate = new Worker(
        new URL("./project-lab-worker.js", import.meta.url),
        { type: "module" },
      );
    } catch (error) {
      return reject(error);
    }
    const timer = setTimeout(() => {
      candidate.terminate();
      reject(new Error("the interpreter did not start"));
    }, 30000);
    candidate.onerror = () => {
      clearTimeout(timer);
      candidate.terminate();
      reject(new Error("the interpreter did not start"));
    };
    candidate.onmessage = ({ data }) => {
      if (!data.ready) return;
      clearTimeout(timer);
      candidate.onerror = () => {
        // The worker itself has died, and the session with it.
        if (worker === candidate) worker = null;
        candidate.terminate();
        abandon(new Error("the interpreter stopped unexpectedly"));
      };
      candidate.onmessage = ({ data: reply }) => {
        const asked = waiting.get(reply.id);
        if (!asked) return;
        if (reply.progress) return asked.progress?.(reply.progress);
        waiting.delete(reply.id);
        if (reply.ok) asked.resolve(reply);
        else asked.reject(new Error(reply.message));
      };
      worker = candidate;
      resolve();
    };
  });
}

function abandon(error) {
  const lost = [...waiting.values()];
  waiting.clear();
  for (const each of lost) each.reject(error);
}

function ask(message, progress) {
  if (!worker)
    return Promise.reject(new Error("the interpreter is not running"));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject, progress });
    worker.postMessage({ ...message, id });
  });
}

// ----- the session -----

/** A fresh session holding the data in use, loaded and ready for step 1. */
async function loadSource() {
  await ask({ kind: "reset" });
  if (state.source.own)
    await ask({
      kind: "take",
      file: state.source.file,
      name: state.source.name,
      as: state.source.kind,
    });
  else await ask({ kind: "panel" });
  const loaded = await ask({
    kind: "run",
    source: state.source.load,
    doFile: true,
    quiet: true,
  });
  state.memory = loaded.memory;
  state.markStep = null;
  state.touched = false;
  return loaded;
}

/**
 * Runs the timeline again on a fresh session. A run that no longer goes
 * through ends the timeline there; what stopped it is returned.
 */
async function rebuild() {
  await loadSource();
  for (let k = 0; k < state.timeline.length; k++) {
    const entry = state.timeline[k],
      ran = await ask({
        kind: "run",
        source: entry.text,
        doFile: entry.kind === "step",
        quiet: true,
      });
    state.memory = ran.memory;
    if (ran.rc) {
      const dropped = state.timeline.splice(k);
      forget(dropped);
      return { entry, record: ran.output.findLast((record) => record.rc) };
    }
  }
  return null;
}

/** Steps whose runs have left the timeline are no longer done. */
function forget(entries) {
  for (const entry of entries)
    if (entry.kind === "step") {
      delete state.passed[entry.step];
      delete state.results[entry.step];
    }
}

const inTimeline = (id) =>
  state.timeline.some((entry) => entry.kind === "step" && entry.step === id);

function setBusy(text, running = false) {
  state.busy = text;
  state.running = running;
  renderBusy();
}

function renderBusy() {
  const busy = !!state.busy || !state.ready;
  $("project-status").textContent = state.busy;
  $("project-status").classList.toggle("is-busy", !!state.busy);
  $("step-run").disabled = busy;
  $("step-stop").hidden = !state.running;
  $("project-restart").disabled = busy;
  $("project-open").disabled = busy;
  $("project-builtin").disabled = busy;
  $("project-csv").disabled = busy;
  $("project-command").disabled = busy;
  for (const button of document.querySelectorAll(
    "#project-command-form button, #browse-form button, #browse-previous, #browse-next",
  ))
    button.disabled = busy;
  document.body.classList.toggle("project-busy", !!state.busy);
}

/** Ends a run that is under way, and brings the session back without it. */
async function stop() {
  if (!state.running || !worker) return;
  const stopped = Object.assign(new Error("stopped"), { stopped: true });
  worker.terminate();
  worker = null;
  abandon(stopped);
}

async function recover(note) {
  setBusy("Bringing the session back to where it was before that run");
  try {
    worker?.terminate();
    worker = null;
    abandon(new Error("the session was started again"));
    await startWorker();
    await rebuild();
    addNote(note);
  } catch (error) {
    addNote(
      `The session could not be started again (${error.message}). Reload the page.`,
      true,
    );
  }
}

async function runStep() {
  if (state.busy || !state.ready) return;
  const step = LAB_STEPS[state.step],
    text = $("step-editor").value;
  state.editors[step.id] = text;
  const blanks = blankLines(text);
  if (blanks.length) {
    state.results[step.id] = { blanks };
    renderFeedback();
    $("step-feedback").scrollIntoView({ block: "nearest" });
    return;
  }
  setBusy(`Running step ${step.number}`, true);
  let stopped = false;
  try {
    const at = state.timeline.findIndex(
        (entry) => entry.kind === "step" && indexOf(entry.step) >= step.index,
      ),
      // The worker holds the data as they stood when this step began, and
      // nothing before that point has changed since.
      marked =
        step.index > 0 &&
        state.markStep === step.index &&
        (at < 0 || at >= state.markLength);
    if (marked) {
      // An earlier run of this step, whole or stopped partway, is undone:
      // the data go back to the step's start, and what was typed between
      // then and that run is typed again.
      if (at >= 0) forget(state.timeline.splice(at));
      if (state.touched) {
        await ask({ kind: "rewind" });
        for (const entry of state.timeline.slice(state.markLength))
          await ask({ kind: "run", source: entry.text, quiet: true });
      }
    } else {
      if (at >= 0) {
        // A later step has been run since: the session goes back to where
        // this step began, by running again what came before it.
        const again = state.timeline.splice(at);
        forget(again);
        setBusy(
          `Putting the session back to the start of step ${step.number}`,
          true,
        );
        await rebuild();
        if (again.some((entry) => entry.step !== step.id))
          addNote(
            `The session was put back to the start of step ${step.number}. What was run after that point will need to be run again.`,
          );
      }
      if (step.index > 0) {
        await ask({ kind: "mark", step: step.id });
        state.markLength = state.timeline.length;
      }
    }
    state.markStep = step.index;
    state.touched = true;
    setBusy(`Running step ${step.number}`, true);
    const ran = await ask(
      { kind: "run", source: text, doFile: true },
      ({ command }) =>
        command &&
        setBusy(`Running step ${step.number}: ${command.slice(0, 60)}`, true),
    );
    state.memory = ran.memory;
    addHeading(`Step ${step.number}. ${step.title}`);
    addRecords(ran.output);
    if (ran.rc) {
      const record = ran.output.findLast((each) => each.rc);
      state.results[step.id] = {
        stopped: {
          line: record?.line ?? 0,
          message: record ? errorText(record) : `r(${ran.rc})`,
          rc: ran.rc,
        },
      };
      delete state.passed[step.id];
    } else {
      state.timeline.push({ kind: "step", step: step.id, text });
      setBusy(`Checking step ${step.number}`, true);
      const { facts } = await ask({
        kind: "facts",
        step: step.id,
        ran: ran.output
          .filter((record) => !record.comment)
          .map(({ command, rc }) => ({ command, rc })),
      });
      const result = assess(step.id, facts);
      state.results[step.id] = result;
      if (result.passed) state.passed[step.id] = "checked";
      else delete state.passed[step.id];
    }
  } catch (error) {
    stopped = true;
    delete state.results[step.id];
    await recover(
      error.stopped
        ? `Stopped. The session is as it was before step ${step.number} was run.`
        : `The interpreter stopped (${error.message}). The session is as it was before step ${step.number} was run.`,
    );
  }
  setBusy("");
  save();
  render();
  const result = state.results[step.id];
  announce(
    stopped
      ? "Stopped."
      : result?.stopped
        ? `Stata stopped with an error: ${result.stopped.message}`
        : result?.passed
          ? `Step ${step.number} is complete.`
          : "The step ran. Some checks are not met yet.",
  );
  if (!stopped) $("step-feedback").scrollIntoView({ block: "nearest" });
}

async function runTyped(text) {
  const command = text.trim();
  if (!command || state.busy || !state.ready) return;
  if (state.history.at(-1) !== command) state.history.push(command);
  state.historyAt = state.history.length;
  setBusy(`Running ${command.slice(0, 60)}`, true);
  try {
    const ran = await ask({ kind: "run", source: command });
    state.memory = ran.memory;
    addRecords(ran.output);
    if (!ran.rc && changesSession(command)) {
      state.timeline.push({ kind: "typed", text: command });
      state.touched = true;
      save();
    }
    announce(ran.rc ? `Error: ${errorText(ran.output.at(-1))}` : "Done.");
  } catch (error) {
    await recover(
      error.stopped
        ? "Stopped. The session is as it was before that command."
        : `The interpreter stopped (${error.message}). The session is as it was before that command.`,
    );
  }
  setBusy("");
  render();
}

/** A fresh session with the worked lines of every step before one. */
async function restartFrom(index) {
  if (state.busy || !state.ready) return;
  state.timeline = LAB_STEPS.slice(0, index).map((step) => ({
    kind: "step",
    step: step.id,
    text: forData(view(step).worked, state.source.load),
    worked: true,
  }));
  state.passed = Object.fromEntries(
    LAB_STEPS.slice(0, index).map((step) => [step.id, "worked"]),
  );
  state.results = {};
  setBusy(
    index
      ? `Starting a new session and running the worked lines for ${throughStep(index)}`
      : "Starting a new session",
  );
  $("project-output").replaceChildren();
  try {
    const failed = await rebuild();
    if (failed) {
      const step = LAB_STEPS[indexOf(failed.entry.step)];
      addNote(
        `The worked lines stopped at step ${step.number} (${step.title}): ${errorText(failed.record)}. The session holds the steps before it.`,
        true,
      );
    } else
      addNote(
        index
          ? `A new session, with the worked lines for ${throughStep(index)} already run. Step ${index + 1} starts from here.`
          : "A new session. Nothing has been run.",
      );
  } catch (error) {
    await recover(`The session was started again (${error.message}).`);
  }
  setBusy("");
  save();
  render();
  announce("The session was restarted.");
}

// ----- a student's own file -----

async function openFile(file) {
  if (state.busy || !state.ready) return;
  const message = $("project-file-message"),
    kind = fileKind(file.name),
    isCsv = /\.csv$/i.test(file.name),
    refused =
      refusal(file.name, file.size) ||
      (kind !== "dta" && !isCsv
        ? `${file.name} is not a .dta or .csv file. In Stata, save the data with save or export delimited and open that file here.`
        : /["`$]/.test(file.name)
          ? "Rename the file without quotation marks or dollar signs, and open it again."
          : "");
  message.classList.toggle("is-error", !!refused);
  if (refused) {
    message.textContent = refused;
    return;
  }
  const before = state.source,
    load =
      kind === "dta"
        ? `use "${file.name}", clear`
        : `import delimited using "${file.name}", clear case(preserve) asdouble`;
  setBusy(`Reading ${file.name} on this computer`);
  message.textContent = "";
  try {
    state.source = { own: true, name: file.name, file, kind, load };
    const loaded = await loadSource();
    if (loaded.rc)
      throw new Error(errorText(loaded.output.findLast((each) => each.rc)));
    const { facts } = await ask({ kind: "fileFacts" }),
      prepared = prepareLines(facts);
    if (prepared.length) {
      state.source.load = [load, ...prepared].join("\n");
      const again = await loadSource();
      if (again.rc) {
        // The lines that tidy the file did not all run: leave it as it came.
        state.source.load = load;
        state.source.failed = prepared;
        await loadSource();
      }
    }
    state.source.prepared = prepared;
    state.source.columns = state.memory.variables;
    state.step = 0;
    state.editors = {};
    state.hints = {};
    state.worked = {};
    state.passed = {};
    state.results = {};
    state.timeline = [];
    $("project-output").replaceChildren();
    addNote(
      `${file.name} is in memory: ${thousands(state.memory.observations)} observations, ${state.memory.variables.length} variables. It was read on this computer and has not been sent anywhere.`,
    );
    message.textContent = `${file.name} (${megabytes(file.size)}) is open. The steps now run on it.`;
    announce(`${file.name} is open.`);
  } catch (error) {
    state.source = before;
    message.classList.add("is-error");
    message.textContent = `${file.name} could not be opened: ${error.message}`;
    try {
      if (!worker) await startWorker();
      await rebuild();
    } catch {
      addNote("The session could not be started again. Reload the page.", true);
    }
  }
  setBusy("");
  render();
}

async function useBuiltIn() {
  if (state.busy || !state.ready) return;
  state.source = BUILT_IN;
  $("project-file-message").textContent = "";
  $("project-output").replaceChildren();
  restore();
  setBusy("Bringing back the simulated panel");
  try {
    await rebuild();
    addNote(
      "The simulated panel is in memory again, with your earlier work on it.",
    );
  } catch (error) {
    await recover(`The session was started again (${error.message}).`);
  }
  setBusy("");
  render();
}

// ----- storage: progress on the bundled panel only -----

function save() {
  if (state.source.own) return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        step: state.step,
        editors: state.editors,
        hints: state.hints,
        worked: state.worked,
        passed: state.passed,
        timeline: state.timeline,
      }),
    );
  } catch {
    // Storage that is full or switched off: the visit goes on without it.
  }
}

/** Reads saved progress, keeping only what has the expected shape. */
function restore() {
  state.step = 0;
  state.editors = {};
  state.hints = {};
  state.worked = {};
  state.passed = {};
  state.results = {};
  state.timeline = [];
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return;
  }
  if (!saved || saved.version !== 1) return;
  const known = (id) => indexOf(id) >= 0,
    text = (value) => typeof value === "string" && value.length <= 20000;
  if (
    Number.isInteger(saved.step) &&
    saved.step >= 0 &&
    saved.step < LAB_STEPS.length
  )
    state.step = saved.step;
  for (const [id, value] of Object.entries(saved.editors ?? {}))
    if (known(id) && text(value)) state.editors[id] = value;
  for (const [id, value] of Object.entries(saved.hints ?? {}))
    if (known(id) && [1, 2, 3].includes(value)) state.hints[id] = value;
  for (const [id, value] of Object.entries(saved.worked ?? {}))
    if (known(id) && value === true) state.worked[id] = true;
  for (const [id, value] of Object.entries(saved.passed ?? {}))
    if (known(id) && ["checked", "worked"].includes(value))
      state.passed[id] = value;
  if (Array.isArray(saved.timeline) && saved.timeline.length <= 200)
    for (const entry of saved.timeline) {
      if (!entry || !text(entry.text)) return (state.timeline = []);
      if (entry.kind === "step" && known(entry.step))
        state.timeline.push({
          kind: "step",
          step: entry.step,
          text: entry.text,
          ...(entry.worked ? { worked: true } : {}),
        });
      else if (entry.kind === "typed")
        state.timeline.push({ kind: "typed", text: entry.text });
      else return (state.timeline = []);
    }
  for (const id of Object.keys(state.passed))
    if (!inTimeline(id)) delete state.passed[id];
}

// ----- the output -----

function errorText(record) {
  if (!record) return "";
  const lines = record.lines.slice(-(record.fault || 2));
  return lines
    .filter((line) => !/^r\(\d+\);$/.test(line.trim()))
    .join(" ")
    .trim();
}

/** The steps 1 to n, said as a person would say them. */
const throughStep = (n) => (n === 1 ? "step 1" : `steps 1 to ${n}`);

const ERROR_HELP = {
  110: "The variable already exists. Give the new one another name, or drop the old one first.",
  111: "Stata found no variable (or stored result) with that name. Check the spelling against the Variables tab; names are case-sensitive.",
  198: "Stata could not use the line as written. Read the message above it: it names what was wrong. When it is a syntax error, look for a missing comma before the options, an unclosed bracket or quotation mark, or one = where == was meant.",
  199: "That is not a command Stata knows, or not one this page runs.",
  109: "A text variable was used where a number is needed, or the reverse.",
  2000: "No rows were left for the command: every row has a missing value somewhere, or the if condition is true of none.",
  451: "The panel variable and the time variable do not pick out one row each: some unit has two rows for the same year. For a firm-year panel, the unit is the firm.",
};

function trimOutput() {
  const output = $("project-output");
  while (output.childElementCount > MAX_RECORDS)
    output.firstElementChild.remove();
}

function reveal(node) {
  $("project-output").scrollTop = Math.max(0, node.offsetTop - 6);
}

function addHeading(text) {
  const heading = document.createElement("p");
  heading.className = "project-run-heading";
  heading.textContent = text;
  $("project-output").append(heading);
  reveal(heading);
}

function addNote(text, problem = false) {
  const note = document.createElement("p");
  note.className = `project-note${problem ? " is-error" : ""}`;
  note.textContent = text;
  $("project-output").append(note);
  trimOutput();
  $("project-output").scrollTop = $("project-output").scrollHeight;
}

function addRecords(records) {
  const output = $("project-output");
  let first = null;
  for (const record of records) {
    if (record.comment && !record.command.trim()) continue;
    const block = document.createElement("div");
    block.className = `project-record${record.rc ? " is-error" : ""}${record.comment ? " is-comment" : ""}`;
    const command = document.createElement("pre");
    command.className = "project-typed";
    command.textContent = [
      `. ${record.command}`,
      ...(record.echo ?? []).map((line) =>
        /^\s*\d+\.\s|^>/.test(line) ? line : `> ${line}`,
      ),
    ].join("\n");
    block.append(command);
    if (record.lines.length) {
      const fault = record.rc ? record.fault || 0 : 0,
        marked = new Set(record.errorLines ?? []),
        body = document.createElement("pre");
      body.className = "project-printed";
      record.lines.forEach((line, k) => {
        const row = document.createElement("span");
        if (k >= record.lines.length - fault || marked.has(k))
          row.className = "project-error-line";
        row.textContent = `${line}\n`;
        body.append(row);
      });
      block.append(body);
    }
    if (record.rc) {
      const help = record.hint || ERROR_HELP[record.rc];
      if (help) {
        const hint = document.createElement("p");
        hint.className = "project-error-help";
        hint.textContent = help;
        block.append(hint);
      }
    }
    output.append(block);
    first ??= block;
  }
  trimOutput();
  if (first?.isConnected) {
    const heading = first.previousElementSibling;
    reveal(
      heading?.classList.contains("project-run-heading") ? heading : first,
    );
  }
}

function announce(text) {
  $("project-announcement").textContent = text;
}

// ----- what the page shows -----

function renderExpected() {
  $("project-expected").tBodies[0].innerHTML = EXPECTED_COLUMNS.map(
    (column) =>
      `<tr><th scope="row"><code>${column.name}</code></th><td>${escapeHTML(column.what)}${column.optional ? " <em>(optional)</em>" : ""}</td><td>${{ numeric: "number", string: "text", date: "Stata date", any: "number or text" }[column.kind]}</td></tr>`,
  ).join("");
}

function renderSource() {
  const own = state.source.own;
  $("project-builtin").hidden = !own;
  $("project-source").textContent = own
    ? `Your file ${state.source.name}: ${thousands(state.memory?.observations ?? 0)} observations. Read on this computer; not uploaded, not kept after this tab closes.`
    : "Simulated firm-year panel: invented firms, fiscal years 2004 to 2023.";
  const panel = $("project-preflight");
  panel.hidden = !own;
  if (!own || !state.memory) return;
  // The file as it was loaded and prepared, whatever the steps have added.
  const table = preflight(state.source.columns ?? state.memory.variables),
    missing = table.filter((row) => row.state === "missing"),
    required = missing.filter((row) => !row.optional),
    wrong = table.filter((row) => row.state === "type" || row.state === "case"),
    found = table.length - missing.length,
    names = (rows) => rows.map((row) => row.name).join(", ");
  $("project-preflight-summary").textContent = [
    `${found} of the ${table.length} expected columns are in your file.`,
    required.length
      ? `Missing and needed: ${names(required)}. The steps that read ${required.length > 1 ? "them" : "it"} will stop with a not found error until the file has ${required.length > 1 ? "them" : "it"}.`
      : "Every column the main analysis needs is there.",
    missing.length > required.length
      ? `Missing and optional: ${names(missing.filter((row) => row.optional))}.`
      : "",
    wrong.length
      ? `Not of the expected kind: ${names(wrong)}. See the Status column.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const stepName = (id) => {
    const step = LAB_STEPS[indexOf(id)];
    return step ? `step ${step.number}` : "";
  };
  $("project-preflight-rows").innerHTML = table
    .map((row) => {
      const kind = {
          numeric: "a number",
          string: "text",
          date: "a Stata date",
          any: "",
        }[row.kind],
        status =
          row.state === "ok"
            ? "Found"
            : row.state === "missing"
              ? row.optional
                ? `Not found (optional${row.needed ? `; ${stepName(row.needed)} reads it` : ""})`
                : `Not found; ${stepName(row.needed)} needs it`
              : row.state === "case"
                ? `Found as ${row.found}`
                : `Found, but ${isText(row.type) ? "it is text" : "it is a number"} and the steps expect ${kind}`;
      return `<tr class="is-${row.state}${row.optional ? " is-optional" : ""}"><th scope="row"><code>${row.name}</code></th><td>${row.found ? `<code>${escapeHTML(row.found)}</code>` : "—"}</td><td>${escapeHTML(row.type) || "—"}</td><td>${escapeHTML(status)}</td></tr>`;
    })
    .join("");
  const prepared = state.source.prepared ?? [],
    failed = state.source.failed;
  $("project-preflight-prep").innerHTML = failed
    ? `<p>The lab tried these lines to bring the columns to the expected names and types, and one of them stopped with an error, so the file is in memory as it came:</p><pre tabindex="0">${escapeHTML(failed.join("\n"))}</pre>`
    : prepared.length
      ? `<p>The lab ran these lines after loading the file, to bring its columns to the names and types the steps read. They are part of step 1 and of the do-file you download, because Stata needs them too:</p><pre tabindex="0">${escapeHTML(prepared.join("\n"))}</pre>`
      : "<p>The file needed no changes to its column names or types.</p>";
}
const isText = (type) => /^str/.test(type ?? "");

function renderStepper() {
  $("project-steps").innerHTML = LAB_STEPS.map((step) => {
    const done = state.passed[step.id] && inTimeline(step.id),
      status = done
        ? state.passed[step.id] === "worked"
          ? "run with the worked lines"
          : "complete"
        : inTimeline(step.id)
          ? "run, checks not all met"
          : "not run";
    return `<li><button type="button" data-step="${step.index}" data-state="${done ? state.passed[step.id] : inTimeline(step.id) ? "open" : "todo"}"${step.index === state.step ? ' aria-current="step"' : ""} aria-label="Step ${step.number}: ${escapeHTML(step.title)} (${status})" title="${escapeHTML(step.title)}"><span>${step.number}</span></button></li>`;
  }).join("");
  const done = LAB_STEPS.filter(
    (step) => state.passed[step.id] && inTimeline(step.id),
  ).length;
  $("project-step-count").textContent =
    `${done} of ${LAB_STEPS.length} steps done`;
}

function scaffoldOf(step) {
  return forData(step.scaffold, state.source.load);
}

/** The editor is as tall as its lines, wrapped ones included, within limits. */
function fitEditor() {
  const editor = $("step-editor");
  editor.style.height = "auto";
  editor.style.height = `${Math.min(640, Math.max(130, editor.scrollHeight + 4))}px`;
}

function renderStep() {
  const step = view(LAB_STEPS[state.step]);
  $("step-kicker").textContent =
    `Step ${step.number} of ${LAB_STEPS.length}${step.optional ? " · optional" : ""}`;
  $("step-title").textContent = step.title;
  $("step-idea").innerHTML = step.idea.map((p) => `<p>${p}</p>`).join("");
  $("step-decision").innerHTML =
    `<strong>The decision.</strong> ${step.decision}`;
  const editor = $("step-editor"),
    text = state.editors[step.id] ?? scaffoldOf(step);
  if (editor.value !== text) editor.value = text;
  fitEditor();

  // What stands between this step and a clean run.
  const skipped = LAB_STEPS.slice(0, step.index).filter(
      (each) => !inTimeline(each.id),
    ),
    later = state.timeline.filter(
      (entry) => entry.kind === "step" && indexOf(entry.step) > step.index,
    ),
    notice = $("step-notice"),
    numbers = (steps) =>
      steps.length === 1
        ? `Step ${steps[0].number} has`
        : `Steps ${steps.map((each) => each.number).join(", ")} have`;
  notice.hidden = !skipped.length && !later.length;
  notice.innerHTML = skipped.length
    ? `<p>${numbers(skipped)} not been run in this session, and this step builds on ${skipped.length === 1 ? "it" : "them"}. Go back and do ${skipped.length === 1 ? "it" : "them"}, or use <strong>Restart from this step</strong> below to have the worked lines run for you.</p>`
    : later.length
      ? `<p>You have already gone past this step. Running it again puts the session back to where this step began, and ${later.length === 1 ? `step ${indexOf(later[0].step) + 1}` : `steps ${later.map((entry) => indexOf(entry.step) + 1).join(", ")}`} will need to be run again.</p>`
      : "";

  const shown = state.hints[step.id] ?? 0;
  $("step-hints").innerHTML = step.hints
    .slice(0, shown)
    .map(
      (hint, k) =>
        `<li><strong>${["A nudge", "The form", "The line"][k]}.</strong> ${hint}</li>`,
    )
    .join("");
  $("step-hints").hidden = !shown;
  const hint = $("step-hint");
  hint.disabled = shown >= step.hints.length;
  hint.textContent =
    shown >= step.hints.length
      ? "All three hints shown"
      : `Show hint ${shown + 1} of ${step.hints.length}`;
  const worked = $("step-worked-button");
  worked.disabled = shown < step.hints.length;
  worked.title =
    shown < step.hints.length ? "Available after the three hints" : "";
  worked.textContent = state.worked[step.id]
    ? "Hide the worked version"
    : "Show a worked version";
  $("step-worked").hidden = !state.worked[step.id];
  $("step-worked-lines").textContent = forData(step.worked, state.source.load);

  $("project-restart").textContent = step.index
    ? `Restart from step ${step.number}`
    : "Start over";
  $("project-restart-help").textContent = step.index
    ? `Starts a new session and runs the worked lines for ${throughStep(step.index)}, so that you can begin here. Your own lines for this step stay in the editor.`
    : "Starts a new session with nothing run. Your lines stay in the editors.";
  renderFeedback();
}

function renderFeedback() {
  const step = LAB_STEPS[state.step],
    result = state.results[step.id],
    box = $("step-feedback"),
    verdict = $("step-verdict"),
    checks = $("step-checks"),
    report = $("step-report"),
    next = $("step-next"),
    last = state.step === LAB_STEPS.length - 1;
  next.hidden = true;
  checks.innerHTML = "";
  report.innerHTML = "";
  verdict.className = "";
  if (!result) {
    const earlier = state.passed[step.id] && inTimeline(step.id);
    box.hidden = !earlier;
    if (earlier) {
      verdict.className = "is-done";
      verdict.textContent =
        state.passed[step.id] === "worked"
          ? "This step is in the session through its worked lines."
          : "This step is complete in this session.";
      next.hidden = last;
    }
    return;
  }
  box.hidden = false;
  if (result.blanks) {
    verdict.className = "is-waiting";
    verdict.textContent = `Nothing was run. ${result.blanks.length === 1 ? `Line ${result.blanks[0]} still has` : `Lines ${result.blanks.join(", ")} still have`} a blank (____) to fill in. The hints say what belongs there.`;
    return;
  }
  if (result.stopped) {
    verdict.className = "is-error";
    verdict.textContent = `Stata stopped${result.stopped.line ? ` at line ${result.stopped.line}` : ""}: ${result.stopped.message} (r(${result.stopped.rc})). Nothing after that line ran. Correct it and run again; the step starts afresh each time.`;
    return;
  }
  const open = result.checks.filter((check) => !check.ok && !check.advisory);
  verdict.className = result.passed ? "is-done" : "is-waiting";
  verdict.textContent = result.passed
    ? last
      ? "Every check is met. That is the whole analysis; the do-file is below."
      : `Every check is met. Step ${step.number} is complete.`
    : `The lines ran. ${open.length === 1 ? "One check is" : `${open.length} checks are`} not met yet; each says what it found in your data.`;
  checks.innerHTML = result.checks
    .map(
      (check) =>
        `<li class="${check.ok ? "is-met" : check.advisory ? "is-advice" : "is-open"}"><span class="project-check-mark" aria-hidden="true"></span><div><span class="sr-only">${check.ok ? "Met: " : check.advisory ? "Worth a look: " : "Not met: "}</span><span class="project-check-label">${check.label}</span>${check.why ? `<p>${check.why}</p>` : ""}</div></li>`,
    )
    .join("");
  if (result.report) {
    const r = result.report;
    report.innerHTML = `<h4>${escapeHTML(r.title)}</h4><div class="project-table-wrap" tabindex="0"><table><thead><tr>${r.head.map((h) => `<th scope="col">${escapeHTML(h)}</th>`).join("")}</tr></thead><tbody>${r.rows.map((row) => `<tr>${row.map((cell, k) => (k ? `<td>${escapeHTML(cell)}</td>` : `<th scope="row">${escapeHTML(cell)}</th>`)).join("")}</tr>`).join("")}</tbody></table></div>${r.note ? `<p>${escapeHTML(r.note)}</p>` : ""}`;
  }
  next.hidden = !result.passed || last;
}

function renderVariables() {
  const memory = state.memory;
  $("project-memory").textContent = memory?.variables.length
    ? `${thousands(memory.observations)} observations, ${memory.variables.length} variables${memory.sortedBy.length ? `, sorted by ${memory.sortedBy.join(" ")}` : ""}.`
    : "No data in memory.";
  $("project-variables").innerHTML = (memory?.variables ?? [])
    .map(
      (v) =>
        `<tr><th scope="row"><code>${escapeHTML(v.name)}</code></th><td>${escapeHTML(v.type)}</td><td>${escapeHTML(v.format)}</td><td>${escapeHTML(v.label)}</td></tr>`,
    )
    .join("");
}

async function renderBrowse() {
  if (state.tab !== "browse" || !worker || state.busy) return;
  const status = $("browse-status"),
    grid = $("browse-grid");
  try {
    const page = await ask({
      kind: "peek",
      request: {
        where: state.browse.where,
        from: state.browse.from,
        count: PAGE_ROWS,
      },
    });
    state.browse.from = page.from;
    grid.tHead.innerHTML = `<tr><th scope="col">Obs.</th>${page.columns.map((c) => `<th scope="col" title="${escapeHTML(c.label)}">${escapeHTML(c.name)}</th>`).join("")}</tr>`;
    grid.tBodies[0].innerHTML = page.rows
      .map(
        (row) =>
          `<tr><th scope="row">${row.obs}</th>${row.cells.map((cell, k) => `<td${typeof row.raw[k] === "string" ? ' class="is-text"' : ""}>${escapeHTML(cell)}</td>`).join("")}</tr>`,
      )
      .join("");
    status.classList.remove("is-error");
    status.textContent = page.shown
      ? `Rows ${thousands(page.from + 1)} to ${thousands(page.from + page.rows.length)} of ${thousands(page.shown)}${page.shown < page.observations ? ` that meet the condition (${thousands(page.observations)} in memory)` : ""}.`
      : page.observations
        ? "No observation meets that condition."
        : "No data in memory.";
    $("browse-previous").disabled = page.from <= 0;
    $("browse-next").disabled = page.from + page.rows.length >= page.shown;
  } catch (error) {
    status.classList.add("is-error");
    status.textContent = `${error.message}. Type variable names, then if and a condition, as after browse.`;
  }
}

function renderExport() {
  const has = state.timeline.length > 0;
  $("project-dofile").textContent = has
    ? exportText()
    : "Nothing has run without error yet. Run a step and its lines appear here.";
}

function exportText() {
  return doFileOf({
    timeline: state.timeline,
    load: state.source.own ? state.source.load : "",
    fileName: state.source.name,
    date: new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
  });
}

function render() {
  renderBusy();
  renderSource();
  renderStepper();
  renderStep();
  renderVariables();
  renderExport();
  renderBrowse();
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function goTo(index, focus = true) {
  const step = LAB_STEPS[state.step];
  state.editors[step.id] = $("step-editor").value;
  state.step = Math.min(LAB_STEPS.length - 1, Math.max(0, index));
  save();
  renderStepper();
  renderStep();
  if (focus) {
    $("project-step").focus({ preventScroll: true });
    $("project-step").scrollIntoView({ block: "start" });
  }
  announce(`Step ${state.step + 1}: ${LAB_STEPS[state.step].title}`);
}

function selectTab(name, focus = false) {
  state.tab = name;
  for (const tab of document.querySelectorAll(".project-results [role=tab]")) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  if (name === "browse") renderBrowse();
}

// ----- wiring -----

function wire() {
  $("project-steps").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-step]");
    if (button) goTo(Number(button.dataset.step));
  });
  $("step-editor").addEventListener("input", () => {
    state.editors[LAB_STEPS[state.step].id] = $("step-editor").value;
    fitEditor();
    save();
  });
  window.addEventListener("resize", fitEditor);
  $("step-editor").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      runStep();
    }
  });
  $("step-run").addEventListener("click", runStep);
  $("step-stop").addEventListener("click", stop);
  $("step-hint").addEventListener("click", () => {
    const step = view(LAB_STEPS[state.step]);
    state.hints[step.id] = Math.min(
      step.hints.length,
      (state.hints[step.id] ?? 0) + 1,
    );
    save();
    renderStep();
    $("step-hints").lastElementChild?.scrollIntoView({ block: "nearest" });
    announce(
      `Hint ${state.hints[step.id]}: ${$("step-hints").lastElementChild?.textContent ?? ""}`,
    );
  });
  $("step-worked-button").addEventListener("click", () => {
    const step = view(LAB_STEPS[state.step]);
    state.worked[step.id] = !state.worked[step.id];
    save();
    renderStep();
    if (state.worked[step.id])
      $("step-worked").scrollIntoView({ block: "nearest" });
  });
  $("step-worked-use").addEventListener("click", () => {
    const step = view(LAB_STEPS[state.step]);
    state.editors[step.id] = forData(step.worked, state.source.load);
    save();
    renderStep();
    $("step-editor").focus();
  });
  $("step-reset").addEventListener("click", () => {
    const step = view(LAB_STEPS[state.step]);
    delete state.editors[step.id];
    save();
    renderStep();
    $("step-editor").focus();
  });
  $("step-next").addEventListener("click", () => goTo(state.step + 1));
  $("project-restart").addEventListener("click", () => restartFrom(state.step));

  $("project-command-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("project-command"),
      text = input.value;
    input.value = "";
    runTyped(text).then(() => input.focus());
  });
  $("project-command").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!state.history.length) return;
    event.preventDefault();
    state.historyAt = Math.min(
      state.history.length,
      Math.max(0, state.historyAt + (event.key === "ArrowUp" ? -1 : 1)),
    );
    event.target.value = state.history[state.historyAt] ?? "";
  });
  document
    .querySelector(".project-quick")
    .addEventListener("click", (event) => {
      const button = event.target.closest("button[data-command]");
      if (button) runTyped(button.dataset.command);
    });
  $("project-clear").addEventListener("click", () =>
    $("project-output").replaceChildren(),
  );

  const tabs = [...document.querySelectorAll(".project-results [role=tab]")];
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab.id.slice(4)));
    tab.addEventListener("keydown", (event) => {
      const move =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!move) return;
      event.preventDefault();
      const to = tabs[(tabs.indexOf(tab) + move + tabs.length) % tabs.length];
      selectTab(to.id.slice(4), true);
    });
  }
  $("browse-form").addEventListener("submit", (event) => {
    event.preventDefault();
    state.browse = { where: $("browse-where").value.trim(), from: 0 };
    renderBrowse();
  });
  $("browse-previous").addEventListener("click", () => {
    state.browse.from = Math.max(0, state.browse.from - PAGE_ROWS);
    renderBrowse();
  });
  $("browse-next").addEventListener("click", () => {
    state.browse.from += PAGE_ROWS;
    renderBrowse();
  });

  $("project-open").addEventListener("click", () => $("project-file").click());
  $("project-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) openFile(file);
  });
  $("project-builtin").addEventListener("click", useBuiltIn);
  $("project-csv").addEventListener("click", async () => {
    if (state.busy || !state.ready) return;
    setBusy("Writing the simulated panel as a CSV file");
    try {
      const { text } = await ask({ kind: "csv" });
      download(PANEL_CSV, text, "text/csv");
    } catch (error) {
      addNote(`The CSV file could not be written (${error.message}).`, true);
    }
    setBusy("");
    render();
  });

  const takeDoFile = () => {
    if (!state.timeline.length) {
      $("project-copy-status").textContent =
        "Nothing has run without error yet.";
      return;
    }
    download("panel-project.do", exportText(), "text/plain");
    $("project-copy-status").textContent = "Downloaded panel-project.do.";
    announce("Downloaded panel-project.do.");
  };
  $("project-download").addEventListener("click", takeDoFile);
  $("export-project").addEventListener("click", takeDoFile);
  $("project-copy").addEventListener("click", async () => {
    const status = $("project-copy-status");
    if (!state.timeline.length) {
      status.textContent = "Nothing has run without error yet.";
      return;
    }
    try {
      await navigator.clipboard.writeText(exportText());
      status.textContent = "Copied.";
    } catch {
      status.textContent =
        "This browser did not allow the copy. Open the do-file below and copy it from there.";
    }
  });

  for (const button of document.querySelectorAll("[data-jump]"))
    button.addEventListener("click", () => {
      const target = $(button.dataset.jump);
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    });
  document
    .querySelector(".project-see-output")
    .addEventListener("click", (event) => {
      event.preventDefault();
      selectTab("results");
      $("project-results").scrollIntoView({ block: "start" });
      $("project-output").focus({ preventScroll: true });
    });
}

async function boot() {
  // The page's own notice for a script that never arrived goes, and the
  // controls the markup leaves disabled until then are the script's now.
  $("project-loading")?.remove();
  $("step-reset").disabled = false;
  restore();
  renderExpected();
  wire();
  render();
  setBusy(
    state.timeline.length
      ? "Starting Stata and bringing your session back"
      : "Starting Stata and building the simulated panel",
  );
  try {
    await startWorker();
    const failed = await rebuild();
    state.ready = true;
    if (failed)
      addNote(
        "Part of your saved session no longer runs, so the session holds the steps before it.",
        true,
      );
    else if (state.timeline.length)
      addNote(
        `Your session is back: ${thousands(state.memory.observations)} observations in memory, with ${state.timeline.filter((entry) => entry.kind === "step").length} of your steps run again.`,
      );
    else
      addNote(
        `The simulated panel is in memory: ${thousands(state.memory.observations)} firm-years, ${state.memory.variables.length} variables. Step 1 loads it again with use, as a do-file would.`,
      );
  } catch (error) {
    addNote(
      navigator.onLine === false
        ? "The lab's interpreter could not be fetched: this browser is offline, and the lab has not been opened online here before. Connect to the network and reload the page."
        : `This browser could not start the lab's interpreter (${error.message}). The lab needs a current browser with web workers; the worked do-file is in the Console and the script library.`,
      true,
    );
  }
  setBusy("");
  save();
  render();
  document.body.dataset.projectReady = String(state.ready);
}

boot();
registerOffline();
initLabChrome();
