// The Console page: a do-file editor on the new runtime. The session runs in
// a worker so that a long do-file can be stopped; if a worker cannot start
// it runs in the page. The do-file text is kept between visits under a key
// no other page reads, and the files the student adds in this browser's
// IndexedDB.
import { COMMANDS } from "./runtime/commands.js";
import { LIBRARY } from "./console-datasets.js";
import { createConsoleSession, missingFile } from "./console-session.js";
import { EXAMPLES } from "./console-examples.js";
import { highlight } from "./console-highlight.js";
import { lineAt, offsetOf, pieces, shift } from "./console-links.js";
import { mountMap } from "./console-map.js";
import { createFox } from "./console-fox.js";
import { SNIPPETS } from "./console-snippets.js";
import { projectZip } from "./console-project.js";
import { doName } from "./console-map-model.js";
import {
  ACCEPT,
  fileKind,
  giveFile,
  loadCommand,
  megabytes,
  openShelf,
  readBlob,
  refusal,
} from "./console-files.js";
import { picture, typeOf } from "./console-picture.js";
import {
  adviseRecord,
  commandParts,
  distance,
  nearest,
  resolveCommand,
} from "./console-hints.js";
import { HELP, LANGUAGE, helpUrl } from "./console-help.js";
import { mountBrowser } from "./console-browse.js";
import { splitCommands } from "./runtime/dofile.js";
import { commandLines } from "./runtime/echo.js";
import { errorText } from "./console-wrap.js";

const KEY = "stataverse:console:v1",
  SCHEME_KEY = "stataverse:console:scheme",
  PROJECT_KEY = "stataverse:console:project:v1",
  MODE_KEY = "stataverse:console:mode",
  FOX_KEY = "stataverse:console:fox",
  MAX_OUTPUT = 400000;
const EXAMPLE = EXAMPLES[0].text;
// The commands, with the loops and prefixes, that help and the Commands
// list know.
const KNOWN = [...COMMANDS, ...LANGUAGE];
const $ = (id) => document.getElementById(id);
const source = $("console-source"),
  output = $("console-output"),
  status = $("console-status"),
  run = $("console-run"),
  runSelection = $("console-run-selection"),
  stop = $("console-stop"),
  reset = $("console-reset"),
  examples = $("console-example"),
  commandLine = $("console-command"),
  still = window.matchMedia("(prefers-reduced-motion: reduce)");

// ----- where the session runs -----
// Every question to the session has its own id and its own answer; the
// worker answers them in the order they were asked, so nothing asked while
// a run is going is lost, and nothing overtakes the run.
let worker = null,
  local = null,
  sequence = 0;
const waiting = new Map();
/** Rejects every question still waiting, as when the worker is ended. */
function abandon(error) {
  const lost = [...waiting.values()];
  waiting.clear();
  for (const each of lost) each.reject(error);
  return lost.length;
}
function startWorker() {
  return new Promise((resolve) => {
    let candidate;
    const fail = () => {
      candidate?.terminate();
      resolve(false);
    };
    try {
      // The worker carries the page's stamp, so the two are always a pair.
      candidate = new Worker(
        new URL(
          `./console-worker.js${new URL(import.meta.url).search}`,
          import.meta.url,
        ),
        { type: "module" },
      );
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(fail, 8000);
    candidate.onerror = () => {
      clearTimeout(timer);
      fail();
    };
    candidate.onmessage = ({ data }) => {
      if (!data.ready) return;
      clearTimeout(timer);
      candidate.onerror = () => {
        // The worker answers every fault in the interpreter with a message,
        // so an error event means the worker itself has died, and with it
        // the session. It cannot be asked anything again: replace it.
        candidate.terminate();
        if (worker === candidate) worker = null;
        const lost = abandon(
          Object.assign(new Error("the interpreter stopped unexpectedly"), {
            lost: true,
          }),
        );
        if (!lost)
          restart(
            "The interpreter stopped unexpectedly. The session was cleared; the do-file text is unchanged.",
          );
      };
      candidate.onmessage = ({ data: reply }) => {
        const asked = waiting.get(reply.id);
        if (!asked) return;
        if (reply.progress) return asked.progress?.(reply.progress);
        if (reply.stream) return asked.stream?.(reply.stream);
        waiting.delete(reply.id);
        if (reply.ok) asked.resolve(reply);
        else asked.reject(new Error(reply.message));
      };
      worker = candidate;
      resolve(true);
    };
  });
}
/** A file read and given to the session in the page, when there is no worker. */
async function takeHere(message, progress) {
  const bytes = await readBlob(message.file, (loaded, total) =>
    progress?.({ loaded, total }),
  );
  return giveFile(local, message.name, message.as, bytes);
}
// What the session has been asked to do since it was last cleared, so that
// after Stop a new session can be brought back to where the old one was:
// the runs, and every file given or taken away, in order, with the files
// the session had when it was cleared. A file added again, or removed,
// after a run that read it is then read as that run read it.
let journal = [],
  journalBase = new Map();
const JOURNALED = new Set(["run", "file", "take", "binary", "remove"]);
function ask(message, progress, stream, { kept = true } = {}) {
  if (kept && message.kind === "reset") {
    journal = [];
    journalBase = new Map(uploads);
  } else if (kept && JOURNALED.has(message.kind)) journal.push(message);
  if (!worker) {
    local ??= createConsoleSession();
    if (message.kind === "take") return takeHere(message, progress);
    try {
      return Promise.resolve(
        message.kind === "run"
          ? local.run(message.source, { doFile: message.doFile })
          : message.kind === "file"
            ? local.addFile(message.name, message.text)
            : message.kind === "binary"
              ? local.addBinary(message.name, message.bytes)
              : message.kind === "remove"
                ? local.removeFile(message.name)
                : message.kind === "peek"
                  ? local.peek(message.request)
                  : message.kind === "export"
                    ? local.exportData()
                    : message.kind === "read"
                      ? { file: local.readFile(message.name) }
                      : local.reset(message.dataset),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject, progress, stream });
    worker.postMessage({ ...message, id });
  });
}

// ----- the project: one or more do-files, kept between visits -----
/** The do-files of a kept project, or null; a file that is not one is left out. */
function readProject(raw) {
  try {
    const kept = JSON.parse(raw);
    if (!kept || !Array.isArray(kept.files)) return null;
    const files = kept.files
      .filter(
        (file) =>
          file &&
          typeof file.name === "string" &&
          /^[A-Za-z0-9_-]{1,60}\.do$/.test(file.name) &&
          typeof file.text === "string",
      )
      .map(({ name, text }) => ({ name, text }));
    if (!files.length) return null;
    return {
      files,
      active: Math.min(files.length - 1, Math.max(0, kept.active | 0)),
    };
  } catch {
    return null;
  }
}
function loadProject() {
  let kept = null;
  try {
    kept = readProject(localStorage.getItem(PROJECT_KEY));
  } catch {
    kept = null;
  }
  if (kept) return kept;
  let text = null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    text = null;
  }
  return {
    files: [
      {
        name: "main.do",
        text: typeof text === "string" && text.length < 200000 ? text : EXAMPLE,
      },
    ],
    active: 0,
  };
}
const project = loadProject();
// A deleted do-file can be brought back: from the status line at once, and
// from More for as long as the page is open.
const deleted = [];
// The do-files as this window last read or wrote them. Another window of
// the Console may change them: what it changed is taken in, what this one
// changed is kept, and a file both changed is kept twice, so that neither
// window's work is lost.
const textsOf = (files) => new Map(files.map(({ name, text }) => [name, text]));
let base = textsOf(project.files),
  written = null;
/**
 * Takes in the do-files another window kept. Returns whether this window's
 * files changed.
 */
function merge(theirs) {
  const before = JSON.stringify(project.files),
    active = project.files[project.active],
    others = textsOf(theirs.files);
  for (const [name, text] of others) {
    const mine = project.files.find((file) => file.name === name),
      was = base.get(name);
    if (!mine) {
      // Added there, or changed there after it was deleted here.
      if (was === undefined || was !== text) project.files.push({ name, text });
    } else if (mine.text === text || text === was) continue;
    else if (mine.text === was) mine.text = text;
    else project.files.push({ name: freeName(name), text });
  }
  // Deleted there, and not changed here since.
  for (const file of [...project.files])
    if (
      !others.has(file.name) &&
      base.get(file.name) === file.text &&
      project.files.length > 1
    )
      project.files.splice(project.files.indexOf(file), 1);
  project.active = Math.max(0, project.files.indexOf(active));
  base = others;
  return JSON.stringify(project.files) !== before;
}
function save() {
  project.files[project.active].text = source.value;
  try {
    const kept = localStorage.getItem(PROJECT_KEY);
    if (kept && kept !== written) {
      const theirs = readProject(kept);
      if (theirs && merge(theirs)) {
        source.value = project.files[project.active].text;
        showTabs();
        paint();
      }
    }
    written = JSON.stringify(project);
    localStorage.setItem(PROJECT_KEY, written);
    base = textsOf(project.files);
  } catch {
    // Storage can be full or unavailable; the page still works without it.
  }
}
window.addEventListener("storage", (event) => {
  if (event.key !== PROJECT_KEY || !event.newValue) return;
  const theirs = readProject(event.newValue);
  if (!theirs) return;
  project.files[project.active].text = source.value;
  const file = current(),
    at = source.selectionStart;
  const changed = merge(theirs);
  written = event.newValue;
  if (!changed) return;
  if (current() !== file || source.value !== file.text) {
    source.value = current().text;
    if (current() === file) source.setSelectionRange(at, at);
  }
  showTabs();
  paint();
  status.textContent =
    "Another window of the Console changed the do-files; its changes are here too.";
  // What only this window had goes back, for the other window to take in.
  if (JSON.stringify(project.files) !== JSON.stringify(theirs.files)) save();
});
/** A name no file in the project has yet, starting from a wanted one. */
function freeName(wanted, except = -1) {
  let name = doName(wanted);
  for (
    let k = 2;
    project.files.some((file, j) => j !== except && file.name === name);
    k++
  )
    name = doName(wanted).replace(/\.do$/, `_${k}.do`);
  return name;
}
function showTabs() {
  const list = $("console-tabs");
  list.textContent = "";
  project.files.forEach((file, k) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "console-tab";
    tab.textContent = file.name;
    tab.setAttribute("aria-pressed", String(k === project.active));
    tab.addEventListener("click", () => openFile(k));
    list.append(tab);
  });
  $("console-tab-name").value = project.files[project.active].name;
  $("console-tab-delete").disabled = project.files.length < 2;
  const restore = $("console-tab-restore");
  restore.hidden = !deleted.length;
  restore.textContent = deleted.length
    ? `Bring back ${deleted.at(-1).name}`
    : "";
  // One file needs no tabs; the bar appears with the second.
  $("console-tabs-bar").hidden = mapping || project.files.length < 2;
  run.textContent = mapping
    ? "Run map"
    : project.files.length > 1
      ? `Run ${project.files[project.active].name}`
      : "Run";
}
function openFile(k) {
  save();
  project.active = k;
  source.value = project.files[k].text;
  source.scrollTop = 0;
  save();
  showTabs();
  paint();
  point(0, false);
}
/**
 * Adds do-files to the project. One with the name of a file already there
 * and other text never replaces it: the added file takes a free name
 * (main_2.do), or, with `renameOld` (the map writing main.do and the files
 * it runs, whose names it uses), the file already there does. Returns the
 * names given and what to tell the student.
 */
function addDoFiles(files, { open = true, renameOld = false } = {}) {
  save();
  let first = -1;
  const names = [],
    notes = [];
  for (const file of files) {
    let name = doName(file.name),
      at = project.files.findIndex((each) => each.name === name);
    // An empty file, or the example do-file as the page first shows it,
    // holds no work of the student's and is simply replaced.
    const spare =
      at >= 0 &&
      (!project.files[at].text.trim() || project.files[at].text === EXAMPLE);
    if (spare) project.files[at].text = file.text;
    else if (at >= 0 && project.files[at].text !== file.text) {
      const free = freeName(name);
      if (renameOld) {
        notes.push(`The ${name} that was there is kept as ${free}.`);
        project.files[at].name = free;
      } else {
        notes.push(
          `${name} was already open with other text, so the added file is ${free}; neither was changed.`,
        );
        name = free;
      }
      at = -1;
    }
    if (at < 0) at = project.files.push({ name, text: file.text }) - 1;
    names.push(name);
    if (first < 0) first = at;
  }
  if (open && first >= 0) {
    project.active = first;
    source.value = project.files[first].text;
  }
  save();
  showTabs();
  paint();
  return { names, notes };
}
/** Gives the session every do-file, so that one can run another with do. */
async function shareFiles() {
  save();
  for (const file of project.files)
    await ask({ kind: "file", name: file.name, text: file.text });
}

// ----- the editor: line numbers and colour behind the text -----
const gutter = $("console-gutter"),
  painted = $("console-highlight"),
  band = $("console-band"),
  ghost = $("console-ghost"),
  fault = $("console-fault");
// Each file's marks: the line a command started on, and what it printed.
const marks = new WeakMap(),
  seen = new WeakMap();
let caret = 0,
  linked = [],
  typed = 0;
const current = () => project.files[project.active];
function marksOf(file = current()) {
  if (!marks.has(file)) marks.set(file, new Map());
  return marks.get(file);
}
function forget(mark) {
  for (const block of mark.blocks) {
    block.classList.remove("has-line", "is-linked");
    block.mark = null;
  }
}
/** Whether a block of the Results window still belongs to a line. */
const lineOf = (block) =>
  block?.mark && marksOf(block.file).get(block.mark.line) === block.mark
    ? block.mark.line
    : 0;
function paint() {
  const text = source.value,
    lines = text.split("\n").length,
    file = current(),
    was = seen.get(file);
  // Marks stay on their lines as the text around them changes.
  if (was !== undefined && was !== text)
    marks.set(file, shift(marksOf(file), was, text, forget));
  seen.set(file, text);
  gutter.textContent = "";
  if (lines > 3000)
    gutter.textContent = Array.from({ length: lines }, (_, k) => k + 1).join(
      "\n",
    );
  else
    for (let k = 1; k <= lines; k++) {
      const number = document.createElement("span");
      number.className = "gutter-line";
      number.textContent = k;
      gutter.append(number);
    }
  paintMarks();
  // Colour is skipped for a very long do-file; the text stays readable.
  const coloured = text.length < 60000;
  source.classList.toggle("is-coloured", coloured);
  painted.textContent = "";
  if (coloured) painted.append(highlight(text, COMMANDS), "\n");
  follow();
}
function follow() {
  gutter.scrollTop = source.scrollTop;
  painted.scrollTop = source.scrollTop;
  painted.scrollLeft = source.scrollLeft;
  place();
}
/** Shows in the gutter which lines have run, and which one stopped. */
function paintMarks() {
  const set = marksOf();
  for (const number of gutter.children) delete number.dataset.state;
  for (const [line, mark] of set) {
    const number = gutter.children[line - 1];
    if (number) number.dataset.state = mark.state;
  }
  gutter.children[caret - 1]?.classList.add("is-active");
}
// The bands behind the text: the line the caret is on, the line pointed at
// from the Results window, and the line that stopped the run.
let metrics = null;
function measure() {
  const style = getComputedStyle(source);
  metrics = {
    line: parseFloat(style.lineHeight) || 21,
    top: parseFloat(style.paddingTop) || 0,
  };
}
window.addEventListener("resize", () => {
  metrics = null;
  place();
});
function place() {
  if (!source.offsetParent) return;
  if (!metrics) measure();
  const put = (node, line) => {
    node.hidden = !line;
    if (!line) return;
    node.style.height = `${metrics.line}px`;
    node.style.transform = `translateY(${metrics.top + (line - 1) * metrics.line - source.scrollTop}px)`;
  };
  let stopped = 0;
  for (const [line, mark] of marksOf())
    if (mark.state === "error") stopped = line;
  put(band, caret);
  put(fault, stopped);
  put(ghost, Number(ghost.dataset.line) || 0);
  band.classList.toggle("has-result", linked.length > 0);
}
/** Brings a block of the Results window into view if it is not already. */
function bring(block) {
  const box = output.getBoundingClientRect(),
    at = block.getBoundingClientRect();
  if (at.top >= box.top && at.bottom <= box.bottom) return;
  output.scrollTo({
    top: output.scrollTop + at.top - box.top - 12,
    behavior: still.matches ? "auto" : "smooth",
  });
}
/** Makes `line` the current line, and lights what it printed. */
function point(line, reveal) {
  gutter.children[caret - 1]?.classList.remove("is-active");
  caret = line;
  for (const block of linked) block.classList.remove("is-linked");
  linked = (marksOf().get(line)?.blocks ?? []).filter(
    (block) => block.isConnected,
  );
  for (const block of linked) block.classList.add("is-linked");
  gutter.children[caret - 1]?.classList.add("is-active");
  place();
  if (reveal && linked.length) bring(linked[0]);
}
/** Puts the caret on a line of the do-file and shows that line. */
function goTo(line) {
  const at = offsetOf(source.value, line);
  source.focus({ preventScroll: true });
  source.setSelectionRange(at, at);
  if (!metrics) measure();
  const top = (line - 1) * metrics.line;
  if (
    top < source.scrollTop ||
    top > source.scrollTop + source.clientHeight - 2 * metrics.line
  )
    source.scrollTop = Math.max(0, top - source.clientHeight / 3);
  source.scrollIntoView({ block: "nearest" });
  point(line, false);
  band.classList.remove("is-flash");
  void band.offsetWidth;
  band.classList.add("is-flash");
}
/** Replaces text in the editor so that the browser's undo can restore it. */
// Where the student last typed: the do-file or the command line.
let typingAt = "source";
/** Puts a name into the command line at its cursor, spaced as a word. */
function typeCommand(text) {
  const { selectionStart: start, selectionEnd: end, value } = commandLine,
    before = value.slice(0, start ?? value.length),
    after = value.slice(end ?? value.length),
    piece = `${before && !/[\s(]$/.test(before) ? " " : ""}${text}${after && !/^\s/.test(after) ? " " : after ? "" : " "}`;
  commandLine.focus();
  commandLine.setRangeText(
    piece,
    start ?? value.length,
    end ?? value.length,
    "end",
  );
}
function typeInto(text, selectAll) {
  source.focus();
  if (selectAll) source.select();
  let typed = false;
  try {
    typed = document.execCommand("insertText", false, text);
  } catch {
    typed = false;
  }
  if (!typed)
    source.setRangeText(
      text,
      source.selectionStart,
      source.selectionEnd,
      "end",
    );
  save();
  paint();
}
/** The whole lines the selection touches, or "" when nothing is selected. */
function selectedLines() {
  const { selectionStart: from, selectionEnd: to, value } = source;
  if (from === to) return "";
  const start = value.lastIndexOf("\n", from - 1) + 1,
    end = value.indexOf("\n", Math.max(from, to - 1));
  return value.slice(start, end < 0 ? value.length : end);
}

// ----- the variables -----
let known = null,
  opened = false,
  // The data in memory as last reported, for the hints under an error.
  memoryNow = { variables: [] },
  // How the Variables list is ordered: by a column, or as in the data.
  variableOrder = null;
function showVariables(memory) {
  memoryNow = memory;
  const table = $("console-variable-table"),
    body = table.querySelector("tbody"),
    before = known;
  known = new Set(memory.variables.map((v) => v.name));
  body.textContent = "";
  const rows = memory.variables.map((variable, k) => ({ ...variable, k }));
  if (variableOrder) {
    const { key, descending } = variableOrder,
      sign = descending ? -1 : 1;
    rows.sort(
      (a, b) =>
        sign *
          String(a[key] ?? "").localeCompare(String(b[key] ?? ""), "en", {
            numeric: true,
          }) || a.k - b.k,
    );
  }
  for (const th of table.querySelectorAll("th[data-key]"))
    th.setAttribute(
      "aria-sort",
      variableOrder?.key === th.dataset.key
        ? variableOrder.descending
          ? "descending"
          : "ascending"
        : "none",
    );
  for (const variable of rows) {
    const row = document.createElement("tr"),
      name = document.createElement("td"),
      insert = document.createElement("button");
    row.dataset.search =
      `${variable.name} ${variable.label} ${variable.valueLabel}`.toLowerCase();
    insert.type = "button";
    insert.className = "console-name";
    insert.textContent = variable.name;
    insert.title = `Put ${variable.name} where you are typing`;
    insert.addEventListener("click", () => {
      // In the map a name goes to the field last used there.
      if (mapping) {
        if (!map.insert(variable.name))
          status.textContent =
            "Select a field in a step first; the name goes there.";
      } else if (typingAt === "command" && !commandLine.disabled)
        // As in Stata, a name clicked while a command is being typed goes
        // into the command.
        typeCommand(variable.name);
      else typeInto(variable.name, false);
    });
    name.append(insert);
    row.append(name);
    // A variable this run created is marked for a moment.
    if (before && !before.has(variable.name)) row.className = "is-new";
    // In the order of Stata's Variables window.
    for (const text of [variable.label, variable.type, variable.format]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    // A value label shows what its numbers stand for, on request, in a
    // row of its own under the variable.
    const labelCell = document.createElement("td"),
      pairs = memory.labels?.[variable.valueLabel];
    row.append(labelCell);
    body.append(row);
    if (variable.valueLabel && pairs?.values.length) {
      const toggle = document.createElement("button"),
        values = document.createElement("tr"),
        cell = document.createElement("td");
      toggle.type = "button";
      toggle.className = "console-label-toggle";
      toggle.textContent = variable.valueLabel;
      toggle.setAttribute("aria-expanded", "false");
      toggle.title = `What the values of ${variable.valueLabel} stand for`;
      values.className = "console-label-row";
      values.hidden = true;
      values.dataset.search = row.dataset.search;
      cell.colSpan = 5;
      cell.textContent =
        `${variable.valueLabel}: ` +
        pairs.values.map(([value, text]) => `${value} = ${text}`).join("; ") +
        (pairs.count > pairs.values.length
          ? `; and ${pairs.count - pairs.values.length} more`
          : "");
      values.append(cell);
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        values.hidden = !open;
      });
      labelCell.append(toggle);
      body.append(values);
    } else labelCell.textContent = variable.valueLabel ?? "";
  }
  // On a phone the rows are laid out as cards (console.css), which takes
  // a table's own roles away in some browsers; they are given explicitly.
  table.setAttribute("role", "table");
  for (const part of table.querySelectorAll("thead, tbody"))
    part.setAttribute("role", "rowgroup");
  for (const row of table.querySelectorAll("tr"))
    row.setAttribute("role", "row");
  for (const cell of table.querySelectorAll("th"))
    cell.setAttribute("role", "columnheader");
  for (const cell of table.querySelectorAll("td"))
    cell.setAttribute("role", "cell");
  table.hidden = !memory.variables.length;
  $("console-variable-tools").hidden = !memory.variables.length;
  filterVariables();
  // The list opens by itself the first time there is something in it.
  if (memory.variables.length && !opened) {
    opened = true;
    $("drawer-variables").open = true;
  }
  map.setNames(
    memory.variables
      .map((variable) => variable.name)
      // estimates store keeps a marker variable that is not the student's.
      .filter((name) => !name.startsWith("_est_")),
  );
  // Each file in the session's folder can be downloaded: a dataset saved
  // with save, a CSV from export delimited, a log, a workbook.
  const folder = $("console-files");
  folder.textContent = memory.files.length ? "" : "none";
  memory.files.forEach((name, k) => {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "console-file-link";
    link.textContent = name;
    // Named as a copy to keep, not as the Download of Your files.
    link.setAttribute("aria-label", `Save a copy of ${name} to this computer`);
    link.title = `Save a copy of ${name} to this computer`;
    link.addEventListener("click", () => downloadFile(name));
    folder.append(...(k ? [", "] : []), link);
  });
  $("browse-summary").textContent = memory.variables.length
    ? `Sort, search and edit the ${memory.observations.toLocaleString("en-US")} observations`
    : "";
  $("console-memory").textContent = memory.variables.length
    ? `${memory.observations.toLocaleString("en-US")} observations, ${memory.variables.length} variable${memory.variables.length === 1 ? "" : "s"}${memory.sortedBy.length ? `, sorted by ${memory.sortedBy.join(" ")}` : ""}.`
    : "No data in memory.";
}

/** Shows the variables whose name or labels hold what is typed. */
function filterVariables() {
  const wanted = $("console-variable-filter").value.trim().toLowerCase(),
    rows = [
      ...document.querySelectorAll(
        "#console-variable-table tbody tr:not(.console-label-row)",
      ),
    ];
  let shown = 0;
  for (const row of rows) {
    row.hidden = !!wanted && !row.dataset.search.includes(wanted);
    // A value label's own row goes with its variable.
    const values = row.nextElementSibling;
    if (values?.classList.contains("console-label-row"))
      values.hidden =
        row.hidden ||
        row
          .querySelector(".console-label-toggle")
          ?.getAttribute("aria-expanded") !== "true";
    if (!row.hidden) shown++;
  }
  $("console-variable-found").textContent = !wanted
    ? ""
    : shown
      ? `${shown} of ${rows.length} variables.`
      : "No variable matches.";
}
$("console-variable-filter").addEventListener("input", filterVariables);
for (const th of document.querySelectorAll(
  "#console-variable-table th[data-key]",
))
  th.querySelector("button").addEventListener("click", () => {
    const key = th.dataset.key;
    variableOrder =
      variableOrder?.key !== key
        ? { key, descending: false }
        : variableOrder.descending
          ? null
          : { key, descending: true };
    showVariables(memoryNow);
  });

// ----- the results -----
function append(text, className) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  output.append(span);
}
// Numbers are marked so that the classic colours can show them as Stata's
// Results window did; the text of the log is unchanged.
// A table rule is marked too, so that it can be drawn as a line.
function linesOf(text, plain) {
  const block = document.createElement("span");
  if (plain || text.length > 20000) {
    block.textContent = text;
    return block;
  }
  for (const piece of pieces(text)) {
    if (piece.kind === "text") {
      block.append(piece.text);
      continue;
    }
    const span = document.createElement("span");
    span.className = `console-${piece.kind}`;
    span.textContent = piece.text;
    block.append(span);
  }
  return block;
}
// Marks in a graph appear in turn: points, then lines, then bars. The rules
// travel inside the image, which is still shown as an image.
const DRAWN = `<style>
@keyframes pop{from{opacity:0;transform:scale(.2)}}
@keyframes draw{from{stroke-dasharray:0 4000}to{stroke-dasharray:4000 0}}
@keyframes show{from{opacity:0}}
circle{transform-box:fill-box;transform-origin:center;animation:pop .45s cubic-bezier(.2,.9,.3,1.4) backwards}
circle:nth-of-type(5n+2){animation-delay:.08s}circle:nth-of-type(5n+3){animation-delay:.16s}
circle:nth-of-type(5n+4){animation-delay:.24s}circle:nth-of-type(5n){animation-delay:.32s}
polyline,path{animation:draw 1.1s .3s ease-out backwards}
rect[fill-opacity]{animation:show .5s ease-out backwards}
rect[fill-opacity]:nth-of-type(4n+3){animation-delay:.1s}rect[fill-opacity]:nth-of-type(4n){animation-delay:.2s}
rect[fill-opacity]:nth-of-type(4n+1){animation-delay:.3s}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>`;
function graphOf(graph) {
  // The SVG is produced by this site's own code from numbers and escaped
  // text, and is shown as an image, not inserted as markup.
  const figure = document.createElement("img"),
    svg = still.matches
      ? graph.svg
      : graph.svg.replace(/(<svg[^>]*>)/, `$1${DRAWN}`);
  figure.className = "console-graph";
  figure.alt = graph.description;
  // The image takes its height before it is decoded, from its proportions,
  // so that Results can scroll a new graph into view as soon as it is
  // added rather than to where an empty image ends.
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(graph.svg);
  if (box) {
    figure.width = Math.round(Number(box[1]));
    figure.height = Math.round(Number(box[2]));
  }
  figure.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  return figure;
}
/**
 * A record as Stata's log has it: the command, then what it printed, and
 * a blank line, which a comment or a blank line of the do-file has not, nor
 * output that ends with one already, as a table does.
 */
const recordText = (record) =>
  [...commandLines(record, record.width), ...shownLines(record)].join("\n") +
  (record.comment || record.lines.at(-1) === "" ? "" : "\n");
/** How many lines at the end of a record are its error. */
const faultOf = (record) =>
  record.rc ? Math.min(record.lines.length, record.fault ?? 2) : 0;
/**
 * A record's lines as Results shows them: an error message wider than the
 * linesize is broken as Stata breaks it (each line stays one entry).
 */
function shownLines(record) {
  const red = new Set(record.errorLines ?? []),
    from = record.lines.length - faultOf(record);
  return record.lines.map((line, k) =>
    k >= from || red.has(k)
      ? errorText(line, record.width ?? 79, record.command).join("\n")
      : line,
  );
}
/** A short name for a command, for the labels of its buttons. */
const brief = (command) =>
  command.length > 40 ? `${command.slice(0, 38)}…` : command;
function toolButton(text, label, act) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "console-tool";
  button.textContent = text;
  // The name a screen reader gives begins with the words on the button.
  if (label) button.setAttribute("aria-label", label);
  button.addEventListener("click", act);
  return button;
}
/** A command's entry in the help: what it does, how to write it, a link. */
function helpCard(name) {
  const card = document.createElement("span"),
    [summary, syntax] = HELP[name] ?? [],
    link = document.createElement("a");
  card.className = "console-help-card";
  if (summary) {
    const what = document.createElement("span"),
      how = document.createElement("code");
    what.className = "console-help-what";
    what.textContent = summary;
    how.textContent = syntax;
    card.append(what, how);
  }
  link.href = helpUrl(name);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `Stata's help for ${name}`;
  card.append(link);
  return card;
}
/** Opens the Commands list on one command's help. */
function showHelp(name) {
  const drawer = $("drawer-commands"),
    filter = $("console-filter");
  drawer.open = true;
  filter.value = name;
  filter.dispatchEvent(new CustomEvent("input", { detail: { only: true } }));
  const item = items[names.indexOf(name)];
  if (!item) return;
  const button = item.querySelector("button");
  if (button.getAttribute("aria-expanded") !== "true") button.click();
  item.scrollIntoView({ block: "center" });
  focusSoon(button);
}
/**
 * Focuses an element in a drawer that is opening: its content can take
 * the focus only once the opening has begun, so this tries for a moment.
 */
function focusSoon(element, tries = 20) {
  element.focus({ preventScroll: true });
  if (document.activeElement !== element && tries > 0)
    setTimeout(() => focusSoon(element, tries - 1), 30);
}
/** The plain hint under a failed command, with its help and a fix. */
function hintNode(record) {
  const advice = adviseRecord(record, {
    commands: KNOWN,
    variables: memoryNow.variables,
  });
  if (!advice) return null;
  const hint = document.createElement("span"),
    label = document.createElement("strong");
  hint.className = "console-hint";
  hint.setAttribute("role", "note");
  label.textContent = "Hint";
  hint.append(label, " ", advice.text);
  if (advice.fix)
    hint.append(
      " ",
      toolButton(
        `Try ${advice.fix}`,
        `Try ${advice.fix} (puts it at the command line)`,
        () => {
          commandLine.value = advice.fix;
          commandLine.focus();
        },
      ),
    );
  if (advice.help && names.includes(advice.help))
    hint.append(
      " ",
      toolButton(`help ${advice.help}`, "", () => showHelp(advice.help)),
    );
  return hint;
}
/**
 * What help was asked about: a command or topic, "" for help alone, or
 * null when the record is not a help command.
 */
function helpAsked(record) {
  const { word, rest } = commandParts(record.command);
  if (record.rc || resolveCommand(word, COMMANDS) !== "help") return null;
  return rest.trim().split(/\s+/)[0] ?? "";
}
/**
 * help on something that is not a command here: Stata's help for that
 * topic, or, for help alone, its contents and the Commands list.
 */
function topicCard(topic) {
  const card = document.createElement("span"),
    what = document.createElement("span"),
    link = document.createElement("a");
  card.className = "console-help-card";
  what.className = "console-help-what";
  what.textContent = topic
    ? `${topic} is not a command that runs here; Stata's help may have a page on it. The Commands list shows what runs here.`
    : "The Commands list shows every command that runs here, each with a line of help. Stata's own help starts at its contents.";
  link.href = topic ? helpUrl(topic) : helpUrl("contents");
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = topic
    ? `Stata's help for ${topic}`
    : "Stata's help contents";
  card.append(
    what,
    toolButton("Open the Commands list", "", () => {
      const drawer = $("drawer-commands"),
        filter = $("console-filter");
      drawer.open = true;
      filter.value = "";
      filter.dispatchEvent(new Event("input"));
      drawer.scrollIntoView({ block: "start" });
      focusSoon(filter);
    }),
    " ",
    link,
  );
  return card;
}
/** One command and what it printed, as it appears in the Results window. */
function recordNode(record) {
  // A comment, a blank line or #delimit in a do-file is echoed as Stata
  // echoes it, with no tools and no blank line after it.
  if (record.comment) {
    const block = document.createElement("span"),
      command = document.createElement("span");
    block.className = "console-record is-comment";
    block.text = recordText(record);
    command.className = "console-command";
    // Cut at the linesize as a command is; a blank line is a prompt alone.
    command.textContent = commandLines(record, record.width).join("\n");
    block.append(command, "\n");
    if (record.lines.length)
      block.append(linesOf(record.lines.join("\n") + "\n"));
    return block;
  }
  const block = document.createElement("span"),
    command = document.createElement("span"),
    tools = document.createElement("span"),
    graphs = record.graphs ?? (record.graph ? [record.graph] : []);
  block.className = "console-record";
  block.text = recordText(record);
  command.className = "console-command";
  // A loop is echoed as Stata echoes it: its lines, numbered, once. A
  // line wider than the linesize goes on after "> ", as in Stata.
  command.textContent = commandLines(record, record.width).join("\n");
  // Copy what one command printed, or save its graph; shown on pointing
  // or focus, and always on a touch screen.
  tools.className = "console-tools";
  tools.append(
    toolButton("Copy", `Copy the results of ${brief(record.command)}`, () =>
      copyText(block.text, "The command and its results were copied."),
    ),
  );
  graphs.forEach((graph, k) =>
    tools.append(
      toolButton(
        graphs.length > 1 ? `Save graph ${k + 1}` : "Save graph",
        `${graphs.length > 1 ? `Save graph ${k + 1}` : "Save graph"} of ${brief(record.command)} as an SVG file`,
        () => {
          hand(
            new TextEncoder().encode(graph.svg),
            `graph${k ? k + 1 : ""}.svg`,
            "image/svg+xml",
          );
          status.textContent = "Saved the graph as an SVG file.";
        },
      ),
    ),
  );
  block.append(command, tools, "\n");
  if (record.lines.length) {
    // Only the error is shown as one: what a loop or a command printed
    // before it failed is ordinary output, as in Stata.
    const fault = faultOf(record),
      shown = shownLines(record),
      printed = shown.slice(0, shown.length - fault),
      wrong = shown.slice(shown.length - fault);
    const lines = document.createElement("span");
    lines.className = "console-lines";
    // Lines the command printed in Stata's error style, as display as
    // error and capture noisily print them, are red too.
    const red = new Set(record.errorLines ?? []);
    for (let k = 0; k < printed.length;) {
      let end = k + 1;
      while (end < printed.length && red.has(end) === red.has(k)) end++;
      const piece = linesOf(
        printed.slice(k, end).join("\n") + "\n",
        red.has(k),
      );
      if (red.has(k)) piece.classList.add("console-error");
      lines.append(piece);
      k = end;
    }
    if (wrong.length) {
      const error = linesOf(wrong.join("\n") + "\n", true);
      error.classList.add("console-error");
      lines.append(error);
    }
    lines.style.setProperty("--rows", Math.min(record.lines.length, 14));
    block.append(lines);
  }
  if (record.rc) {
    const hint = hintNode(record);
    if (hint) block.append(hint);
  }
  // help shows this site's entry for the command, and Stata's own help;
  // a topic that is not a command, such as datetime, links to Stata's
  // help for it, and help alone to its contents.
  const asked = helpAsked(record);
  if (asked !== null) {
    const name = asked && resolveCommand(asked, KNOWN);
    if (name) block.append(helpCard(name), "\n");
    else {
      block.append(topicCard(asked), "\n");
      // A misspelt command is offered its right spelling; a short topic
      // such as mi or i is not taken for a command it happens to resemble.
      const lower = asked.toLowerCase(),
        typo = nearest(asked, names).filter(
          (name) =>
            distance(lower, name.toLowerCase()) <=
            Math.max(1, Math.floor(asked.length / 4)),
        );
      if (asked.length >= 3 && typo.length) {
        const hint = hintNode({
          command: `help ${asked}`,
          lines: [`command ${asked} is unrecognized`],
          rc: 199,
        });
        if (hint) block.append(hint);
      }
    }
  }
  for (const graph of graphs) block.append(graphOf(graph), "\n");
  // A comment or a blank line of the do-file is followed directly by the
  // next line, as in Stata's log; a command by a blank line.
  if (!record.comment) block.append("\n");
  return block;
}
/**
 * Adds records to the Results window. `origin` says where they came from:
 * lines of a do-file ({ file, from, to }) or a step of the map ({ step }).
 */
function show(records, origin, more = false) {
  const set = origin?.file ? marksOf(origin.file) : null;
  // The first part of a run clears the marks of the lines it covers; the
  // parts that follow add to them.
  if (set && !more)
    for (const [line, mark] of [...set])
      if (line > origin.from && line <= origin.to) {
        forget(mark);
        set.delete(line);
      }
  const fresh = new Map(),
    blocks = [],
    // A long run arrives at once; a short one is typed and printed.
    lively = !still.matches && records.length <= 60;
  records.forEach((record, k) => {
    const block = recordNode(record);
    if (lively) {
      block.classList.add("is-arriving");
      block.style.setProperty("--wait", `${Math.min(k * 90, 1400)}ms`);
      block.style.setProperty(
        "--keys",
        Math.min(record.command.length + 2, 40),
      );
    }
    if (origin?.step !== undefined) block.dataset.step = origin.step;
    if (set && record.line) {
      const line = record.line + origin.from;
      let mark = fresh.get(line);
      if (!mark) {
        mark = {
          line,
          state: "done",
          blocks: [],
          wait: Math.min(k * 90, 1400),
        };
        fresh.set(line, mark);
        set.set(line, mark);
      }
      if (record.rc) mark.state = "error";
      mark.blocks.push(block);
      block.mark = mark;
      block.file = origin.file;
      block.classList.add("has-line");
      // The keyboard's way back to the line, as a click on the command is.
      block
        .querySelector(".console-tools")
        ?.append(
          toolButton(
            "Go to line",
            `Go to line of ${brief(record.command)} in the do-file`,
            () => backTo(block),
          ),
        );
    }
    output.append(block);
    blocks.push(block);
  });
  if (set && origin.file === current()) {
    paintMarks();
    // The gutter fills in as the results arrive.
    if (lively)
      for (const [line, mark] of fresh) {
        const number = gutter.children[line - 1];
        if (!number) continue;
        number.classList.add("is-arriving");
        number.style.setProperty("--wait", `${mark.wait}ms`);
      }
    point(caret, false);
  }
  if (output.textContent.length > MAX_OUTPUT) {
    while (output.textContent.length > MAX_OUTPUT / 2 && output.firstChild)
      output.firstChild.remove();
    output.prepend(
      "(earlier results were removed to keep the page responsive)\n\n",
    );
  }
  offerKeeping();
  // New results that fit are shown whole; longer ones start at their top.
  const first = blocks.find((block) => block.isConnected);
  // A run that stopped ends at its error, so that is what is shown.
  if (records.at(-1)?.rc) output.scrollTop = output.scrollHeight;
  else if (first && output.scrollHeight - first.offsetTop > output.clientHeight)
    output.scrollTop = first.offsetTop - output.offsetTop - 8;
  else output.scrollTop = output.scrollHeight;
}
/** Run selection is offered only while lines are selected in the editor. */
function offerSelection() {
  runSelection.hidden = mapping || run.disabled || !selectedLines().trim();
}
function busy(running) {
  run.disabled = running;
  reset.disabled = running;
  examples.disabled = running;
  // The command line stays open during a run: what is typed and entered
  // then waits its turn, as in Stata's Command window, and no keystroke is
  // lost.
  // (It starts closed, until the session is ready.)
  if (!running) commandLine.disabled = false;
  map.setBusy(running);
  $("console-download").disabled = running;
  $("console-download-data").disabled = running;
  for (const button of document.querySelectorAll(
    "#console-datasets button, #console-own button",
  ))
    button.disabled = running;
  browser.setBusy(running);
  offerSelection();
  stop.hidden = !running || !worker;
  status.dataset.state = running ? "running" : "idle";
  isRunning = running;
  showProgress(running);
  if (!running) for (const done of idle.splice(0)) done();
}
// ----- how far a long run has got -----
// A run that lasts more than a moment shows the line it has reached, how
// many commands have run and how long it has taken, with how to stop it.
// The text is not announced as it changes; the status line says Running.
const progress = {
  started: 0,
  line: 0,
  commands: 0,
  lines: 0,
  from: 0,
  timer: null,
};
function showProgress(running) {
  const box = $("console-progress");
  clearInterval(progress.timer);
  if (!running) {
    box.hidden = true;
    return;
  }
  Object.assign(progress, { started: performance.now(), line: 0, commands: 0 });
  progress.timer = setInterval(drawProgress, 250);
}
function drawProgress() {
  const seconds = (performance.now() - progress.started) / 1000;
  if (seconds < 0.6) return;
  const box = $("console-progress"),
    bar = $("console-progress-bar");
  box.hidden = false;
  if (progress.lines > 1 && progress.line) {
    bar.max = progress.lines;
    bar.value = Math.min(progress.line, progress.lines);
  } else bar.removeAttribute("value");
  const at = progress.from + progress.line,
    where =
      progress.line && progress.lines > 1
        ? progress.from
          ? `line ${at} (the selection is lines ${progress.from + 1}–${progress.from + progress.lines}), `
          : `line ${at} of ${progress.lines}, `
        : "";
  $("console-progress-text").textContent =
    `${where ? `At ${where}` : ""}${progress.commands ? `${progress.commands.toLocaleString("en-US")} command${progress.commands === 1 ? "" : "s"} run, ` : ""}${seconds.toFixed(1)} s.${worker ? " Stop, or Ctrl or ⌘ + ., ends the run." : ""}`.replace(
      /^./,
      (c) => c.toUpperCase(),
    );
}

// Whether a run is going, and what waits for it to end.
let isRunning = false;
const idle = [];
const whenIdle = () =>
  isRunning ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve();

/**
 * browse, edit and help print a note where the runtime has no editor or
 * help files; the Console opens its browser or shows its help instead, so
 * the note is left out, and Results show what Stata's do.
 */
const NOTES =
  /^\((browse|edit) opens Stata's Data Editor|^\(Stata's help files are not included/;
function quietNotes(record) {
  if (record.comment) return record;
  const { word, rest } = commandParts(record.command),
    name = resolveCommand(word, COMMANDS);
  if (record.rc || !["browse", "edit", "help"].includes(name)) return record;
  // browse and edit give what they show after macros are expanded; the
  // text typed is the fallback.
  return {
    ...record,
    lines: record.lines.filter((line) => !NOTES.test(line)),
    opens: name,
    where: record.opened?.where ?? rest.trim(),
    labels: record.opened?.labels ?? true,
  };
}
// A byte that is not UTF-8 is shown as U+FFFD, as the session shows it in
// what a run returns at its end.
const readable1 = (line) =>
  line.replace(/(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/g, "\uFFFD");
const readable = (record) => ({
  ...record,
  lines: record.lines.map(readable1),
});
// Where the run that Stop ended was stopped: the do-file line, or 0.
let stopped = null;
/** Runs text in the session and shows what it printed; null after a fault. */
async function perform(text, origin) {
  let result;
  // What the run has printed so far, shown as it comes when a run is long;
  // after Stop, all of it stays, as Stata keeps it.
  const message = { kind: "run", source: text, doFile: origin != null },
    heard = {
      shown: 0,
      waiting: [],
      timer: 0,
      node: 0,
      line: 0,
      command: "",
      echo: [],
      partial: [],
      // How many commands the run had finished when it last said so: Stop
      // puts the session back to that point, which is what Results show.
      count: 0,
    },
    flush = () => {
      clearTimeout(heard.timer);
      heard.timer = 0;
      const batch = heard.waiting.splice(0);
      if (!batch.length) return;
      show(batch.map(quietNotes), origin, heard.shown > 0);
      heard.shown += batch.length;
    };
  try {
    // What the command line runs keeps its locals for the next command;
    // the do-file, a selection of it and the map's steps run as do-files.
    progress.lines = origin?.file ? text.split("\n").length : 0;
    // A selection's lines are counted as the editor's gutter numbers them.
    progress.from = origin?.file ? origin.from : 0;
    result = await ask(
      message,
      ({ line, commands }) => {
        progress.line = line;
        progress.commands = commands;
      },
      (piece) => {
        heard.count = piece.count ?? heard.count;
        if (!piece.records) {
          heard.partial = piece.partial;
          return;
        }
        heard.waiting.push(...piece.records.map(readable));
        Object.assign(heard, {
          node: piece.node,
          line: piece.line,
          command: piece.command,
          echo: piece.echo,
          partial: [],
        });
        heard.timer ||= setTimeout(flush, 300);
      },
    );
    // How the run ended, so that putting it back after a Stop can tell
    // whether it ran the same way again.
    message.rc = result.rc;
    message.records = result.output.length;
  } catch (error) {
    if (error.stopped) {
      // Break: every command that had finished when Stop was pressed (as
      // far as Results show) took effect, inside a loop or a do-file too,
      // and a new session is brought to that point; the one stopped is
      // shown with what it printed, then --Break-- and r(1), as Stata
      // shows it.
      message.stopAfter = heard.count;
      heard.waiting.push({
        command: heard.command || text.trim().split("\n")[0],
        echo: heard.echo,
        lines: [...heard.partial.map(readable1), "--Break--", "r(1);"],
        rc: 1,
        ...(origin?.file && heard.line ? { line: heard.line } : {}),
      });
      flush();
      stopped = {
        line: origin?.file && heard.line ? heard.line + origin.from : 0,
      };
      return null;
    }
    clearTimeout(heard.timer);
    // Put back after a Stop, this run is expected to fail the same way.
    message.faulted = true;
    // Anything that is not a Stata error is a fault in the interpreter.
    append(
      `\nThe interpreter stopped unexpectedly: ${error.message}\n`,
      "console-error",
    );
    fox.idle();
    if (error.lost) {
      status.textContent = "The interpreter stopped. Starting a new session…";
      await restart(
        "The interpreter stopped unexpectedly. The session was cleared; the do-file text is unchanged. Please report the do-file that caused this.",
      );
    } else
      status.textContent =
        "The interpreter stopped unexpectedly. Please report the do-file that caused this.";
    status.dataset.state = "error";
    busy(false);
    return null;
  }
  clearTimeout(heard.timer);
  memoryNow = result.memory;
  const records = result.output.map(quietNotes);
  show(records.slice(heard.shown), origin, heard.shown > 0);
  showVariables(result.memory);
  // browse and edit open the data browser, as they open Stata's editor.
  const opened = records.findLast(
    (record) => !record.rc && /^(browse|edit)$/.test(record.opens ?? ""),
  );
  if (opened)
    browser.open(opened.where, opened.opens === "edit", opened.labels);
  else browser.refresh();
  if (result.made?.length) await keepMade(result.made);
  if (result.written?.length) await keepWritten(result.written);
  return result;
}
/** The commands a run ran: its records, less the comments it echoed. */
const ran = (result) =>
  result.output.filter((record) => !record.comment).length;
/**
 * Whether commands of a run that stopped at an error finished before it:
 * those a loop, a program or a do-file ran count, the one that failed and
 * a captured one do not.
 */
const tookEffect = (result) => (result.finished ?? ran(result) - 1) > 0;
function finish(rc, commands, started, output = [], before = commands > 1) {
  const seconds = ((performance.now() - started) / 1000).toFixed(2),
    missing = rc === 601 ? missingFile(output) : "";
  status.textContent = rc
    ? `Stopped at an error, return code ${rc}.${before ? " Commands before it took effect." : ""}`
    : `Ran ${commands} command${commands === 1 ? "" : "s"} in ${seconds} seconds.`;
  if (missing) {
    // Files are found without regard to case, as Stata finds them on macOS
    // and Windows, but the Console's files are not in folders.
    const base = missing.replace(/^.*[\\/]/, ""),
      have = [...uploads.keys()].find(
        (name) => name.toLowerCase() === base.toLowerCase(),
      );
    if (have && base !== missing)
      status.textContent += ` ${have} is among your files, but files here are not in folders: name it without the folder, as ${have}.`;
    else if (!have)
      status.textContent += ` ${missing} is not among your files: open Data and add it. ${shelf ? "Files you add are kept in this browser until you remove them." : "This browser is not keeping added files, so they are gone after a reload."}`;
  }
  busy(false);
  status.dataset.state = rc ? "error" : "done";
  if (rc) {
    const last = output.findLast((record) => record.rc);
    fox.failed(
      rc,
      last
        ? adviseRecord(last, {
            commands: KNOWN,
            variables: memoryNow.variables,
          })?.text
        : undefined,
    );
  } else fox.done();
  // On a narrow screen the results are below the editor; go to them.
  if (!mapping && window.matchMedia("(max-width: 900px)").matches)
    $("results-title").scrollIntoView({ block: "start" });
}
function begin() {
  save();
  busy(true);
  status.textContent = "Running…";
  fox.running();
  return performance.now();
}

async function execute(text = source.value, what = "do-file") {
  if (isRunning) {
    status.textContent =
      "A run is still going. Wait for it to end, or select Stop.";
    return;
  }
  if (!text.trim()) {
    status.textContent = `The ${what} is empty.`;
    return;
  }
  // What is run from the do-file is tied to the lines it came from.
  const file = current(),
    from =
      what === "selection"
        ? lineAt(
            source.value,
            Math.min(source.selectionStart, source.selectionEnd),
          ) - 1
        : 0,
    origin =
      what === "do-file" && text === source.value
        ? { file, from: 0, to: Infinity }
        : what === "selection"
          ? { file, from, to: from + text.split("\n").length }
          : null;
  const started = begin();
  // Every do-file of the project is there for do, run and include.
  await shareFiles();
  const result = await perform(text, origin);
  if (result)
    finish(result.rc, ran(result), started, result.output, tookEffect(result));
  return result;
}

/**
 * Runs the steps of a map one at a time, so that each card can show whether
 * it ran. A model that ran is then asked for its coefficients, which the
 * card shows beside its variables; that question prints nothing.
 */
async function runSteps(entries, mark) {
  if (!entries.length) {
    status.textContent = "No step in the map is filled in yet.";
    return;
  }
  const started = begin();
  let commands = 0;
  for (const entry of entries) {
    mark(entry.id, "running");
    const result = await perform(entry.lines.join("\n"), { step: entry.id });
    if (!result) return mark(entry.id, "error");
    const earlier = commands > 0;
    commands += ran(result);
    mark(entry.id, result.rc ? "error" : "done", result);
    if (result.rc)
      return finish(
        result.rc,
        commands,
        started,
        result.output,
        earlier || tookEffect(result),
      );
    const terms = entry.guard ? [] : map.termsOf(entry.id);
    if (terms.length) {
      const estimates = {};
      for (const term of terms) {
        try {
          const reply = await ask({
              kind: "run",
              source: `display %9.3g _b[${term}]`,
            }),
            value = reply.output.at(-1)?.lines.join("").trim();
          if (!reply.rc && value) estimates[term] = value;
        } catch {
          break;
        }
      }
      map.setEstimates(entry.id, estimates);
    }
  }
  finish(0, commands, started);
}

/**
 * A new worker with the student's files, and a new session in it. With
 * `replay`, what the old session was asked to do since it was cleared is
 * done again, quietly and in order: the files it had then, each run and
 * each file added or removed since, so that the new one holds the same
 * data, results, macros and logs; the run that was stopped is done up to
 * where Stop found it. Each run is checked to end as it ended before; one
 * that does not is named in the status, for the data may then differ.
 * Returns false when the session could not be put back.
 */
async function restart(message, replay = false) {
  const steps = replay ? journal.slice() : [],
    base = replay ? new Map(journalBase) : new Map();
  await startWorker();
  if (!steps.length) {
    for (const [name, file] of uploads)
      await sendUpload(name, file).catch(() => {});
    await newSession(message);
    return true;
  }
  let memory = null,
    differs = null;
  try {
    // The files the session had when it was last cleared; the journal
    // gives and takes away the rest as they were.
    for (const [name, file] of base)
      await sendUpload(name, file, null, { kept: false }).catch(() => {});
    memory = (
      await ask({ kind: "reset", dataset: "" }, null, null, { kept: false })
    ).memory;
    for (const step of steps) {
      let reply;
      try {
        reply = await ask({ ...step, quiet: true }, null, null, {
          kept: false,
        });
      } catch (error) {
        // Only a worker that has died ends the putting back. A file that
        // cannot be read again (changed on disk since), or a run that
        // fails in the interpreter where it did not before, is named.
        if (error.lost || !worker) throw error;
        if (!step.faulted)
          differs ??=
            step.kind === "run"
              ? `${step.source.trim().split("\n")[0]} stopped in the interpreter this time`
              : `${step.name} could not be read again`;
        continue;
      }
      memory = reply.memory ?? memory;
      if (
        step.kind === "run" &&
        step.stopAfter === undefined &&
        step.rc !== undefined &&
        (reply.rc !== step.rc || reply.output.length !== step.records)
      )
        differs ??= `${step.source.trim().split("\n")[0]} ended differently this time (return code ${reply.rc}, not ${step.rc})`;
    }
  } catch (error) {
    journal = [];
    journalBase = new Map(uploads);
    if (!worker) await startWorker();
    for (const [name, file] of uploads)
      await sendUpload(name, file, null, { kept: false }).catch(() => {});
    await newSession(
      `Stopped. The session could not be put back as it was (${error.message}), so it was cleared: the data in memory are gone; the do-file text and Results are unchanged.`,
    );
    return false;
  }
  journal = steps;
  journalBase = base;
  known = null;
  showVariables(memory);
  status.textContent = differs
    ? `${message} But in putting the session back, ${differs}, so the data may not be as they were: check them before going on.`
    : message;
  return true;
}
async function newSession(message) {
  const result = await ask({ kind: "reset", dataset: "" });
  known = null;
  showVariables(result.memory);
  status.textContent = message;
}

for (const example of EXAMPLES) {
  const option = document.createElement("option");
  let group = [...examples.children].find((g) => g.label === example.group);
  if (!group) {
    group = document.createElement("optgroup");
    group.label = example.group;
    examples.append(group);
  }
  option.value = example.id;
  option.textContent = example.title;
  group.append(option);
}

// ----- the datasets: a name and a Load button, the rest on request -----
for (const entry of Object.values(LIBRARY)) {
  const item = document.createElement("li"),
    more = document.createElement("details"),
    title = document.createElement("summary"),
    name = document.createElement("code"),
    about = document.createElement("p"),
    load = document.createElement("button");
  name.textContent = entry.id;
  title.append(name, entry.title);
  about.textContent = `${entry.data.rows.length.toLocaleString("en-US")} rows, ${entry.data.columns.length} variables. ${entry.description}`;
  more.append(title, about);
  load.type = "button";
  load.className = "quiet-button";
  load.textContent = "Load";
  load.setAttribute("aria-label", `Load ${entry.id}`);
  load.addEventListener("click", async () => {
    if (!mayReplaceData(`Load ${entry.id} in their place`)) return;
    await execute(`sysuse ${entry.id}, clear\ndescribe`, "command");
    $("results-title").scrollIntoView({ block: "start" });
  });
  item.append(more, load);
  $("console-datasets").append(item);
}

// ----- Ols the fox -----
const foxSeat = $("fox-seat"),
  foxSwitch = $("console-fox"),
  fox = createFox({ host: foxSeat, says: $("fox-says"), still });
function setFox(shown) {
  foxSeat.hidden = !shown;
  foxSwitch.setAttribute("aria-pressed", String(shown));
  if (!shown) $("fox-says").textContent = "";
}
try {
  setFox(localStorage.getItem(FOX_KEY) !== "hidden");
} catch {
  setFox(true);
}
foxSwitch.addEventListener("click", () => {
  const shown = foxSeat.hidden;
  setFox(shown);
  try {
    localStorage.setItem(FOX_KEY, shown ? "shown" : "hidden");
  } catch {
    // The choice then lasts for this visit only.
  }
});

// ----- write the do-file, or build it as a map -----
const map = mountMap({
    steps: $("map-steps"),
    links: $("map-links"),
    canvas: $("map-canvas"),
    starter: $("map-starter"),
    code: $("mapcode-view"),
    names: $("map-names"),
    library: LIBRARY,
    uploads: () =>
      [...uploads].filter(([, file]) => !file.made).map(([name]) => name),
    run: runSteps,
    render: recordNode,
    colour: (text) => highlight(text, COMMANDS),
    // A card lights what it printed in the Results window.
    pointed(id, on) {
      for (const block of output.querySelectorAll(".console-record[data-step]"))
        block.classList.toggle(
          "is-linked",
          on && Number(block.dataset.step) === id,
        );
    },
  }),
  layout = document.querySelector(".console-layout");
let mapping = false;
// ----- the data browser: browse and edit -----
const browser = mountBrowser({
  drawer: $("drawer-browse"),
  ask,
  async run(command) {
    ranTyped.push(command);
    await execute(command, "command");
  },
  onOpen() {
    $("drawer-browse").scrollIntoView({ block: "nearest" });
  },
});
$("console-browse").addEventListener("click", () => {
  browser.open("", false);
  $("drawer-browse").scrollIntoView({ block: "start" });
});
function setMode(toMap) {
  mapping = toMap;
  layout.classList.toggle("is-mapping", toMap);
  $("console-map").hidden = !toMap;
  $("console-mapcode").hidden = !toMap;
  document.querySelector(".console-code").hidden = toMap;
  $("console-example-pick").hidden = toMap;
  $("map-starter-pick").hidden = !toMap;
  for (const group of document.querySelectorAll("[data-for]"))
    group.hidden = (group.dataset.for === "map") !== toMap;
  showTabs();
  offerSelection();
  $("editor-title").textContent = toMap ? "Map" : "Do-file";
  $("console-mode-write").setAttribute("aria-pressed", String(!toMap));
  $("console-mode-map").setAttribute("aria-pressed", String(toMap));
  if (toMap) map.draw();
  else paint();
  try {
    localStorage.setItem(MODE_KEY, toMap ? "map" : "write");
  } catch {
    // The choice then lasts for this visit only.
  }
}
$("console-mode-write").addEventListener("click", () => setMode(false));
$("console-mode-map").addEventListener("click", () => setMode(true));
$("map-tidy").addEventListener("click", () => map.tidy());
$("map-export").addEventListener("click", () => {
  const files = map.files();
  setMode(false);
  const { notes } = addDoFiles(files, { renameOld: true });
  status.textContent = [
    files.length > 1
      ? `The map was written to ${files.length} do-files. Run main.do to run them all.`
      : "The map was written to main.do.",
    ...notes,
  ].join(" ");
});
source.value = project.files[project.active].text;
showTabs();
paint();

// ----- the do-files of the project -----
$("console-tab-new").addEventListener("click", () => {
  save();
  project.active = project.files.push({ name: freeName("part"), text: "" }) - 1;
  source.value = "";
  save();
  showTabs();
  paint();
  source.focus();
  status.textContent = `Started ${project.files[project.active].name}. More has Rename.`;
});
$("console-tab-name").addEventListener("change", (event) => {
  const file = project.files[project.active],
    name = freeName(event.target.value, project.active);
  status.textContent = name === file.name ? "" : `${file.name} is now ${name}.`;
  file.name = name;
  save();
  showTabs();
});
function bringBack() {
  const file = deleted.pop();
  if (!file) return;
  save();
  file.name = freeName(file.name);
  project.active = project.files.push(file) - 1;
  source.value = file.text;
  save();
  showTabs();
  paint();
  status.textContent = `${file.name} is back.`;
}
$("console-tab-delete").addEventListener("click", () => {
  if (project.files.length < 2) return;
  save();
  const [gone] = project.files.splice(project.active, 1);
  deleted.push(gone);
  project.active = Math.max(0, project.active - 1);
  source.value = project.files[project.active].text;
  save();
  showTabs();
  paint();
  status.textContent = `${gone.name} was deleted. `;
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "quiet-button";
  undo.textContent = "Undo";
  undo.addEventListener("click", bringBack);
  status.append(undo);
});
$("console-tab-restore").addEventListener("click", bringBack);

// ----- a menu of command patterns -----
const insert = $("console-insert");
for (const group of SNIPPETS) {
  const section = document.createElement("optgroup");
  section.label = group.group;
  group.items.forEach(([label, text], k) => {
    const option = new Option(
      `${label}: ${text.split("\n")[0]}`,
      `${group.group}\n${k}`,
    );
    section.append(option);
  });
  insert.append(section);
}
insert.addEventListener("change", () => {
  const [name, index] = insert.value.split("\n"),
    item = SNIPPETS.find((group) => group.group === name)?.items[index];
  insert.value = "";
  if (!item) return;
  // A pattern that opens a file the student added names the one added
  // last of that kind; with none added, its placeholder is selected, to be
  // typed over.
  const placeholder = /myfile\.(csv|dta)/.exec(item[1]),
    own = placeholder
      ? [...uploads]
          .filter(
            ([name, file]) =>
              !file.made &&
              !name.includes('"') &&
              (placeholder[1] === "dta"
                ? /\.dta$/i.test(name)
                : /\.(csv|tsv|txt)$/i.test(name)),
          )
          .sort((a, b) => !a[1].written - !b[1].written)
          .at(-1)?.[0]
      : undefined,
    text = own ? item[1].replace(placeholder[0], own) : item[1];
  // The pattern goes on a line of its own: at the cursor when it is at the
  // start of a line, otherwise under the line it is in, which is kept
  // whole.
  const { selectionStart: cursor, value } = source,
    end = value.indexOf("\n", cursor),
    at =
      cursor === 0 || value[cursor - 1] === "\n"
        ? cursor
        : end < 0
          ? value.length
          : end + 1,
    before = at > 0 && value[at - 1] !== "\n" ? "\n" : "";
  source.setSelectionRange(at, at);
  typeInto(`${before}${text}\n`, false);
  if (own)
    status.textContent = `Inserted "${item[0]}" for ${own}, the last ${placeholder[1] === "dta" ? ".dta" : "text"} file you added.`;
  else if (placeholder) {
    const from = at + before.length + placeholder.index;
    source.setSelectionRange(from, from + placeholder[0].length);
    status.textContent = `Inserted "${item[0]}". Type the name of your file over ${placeholder[0]}, and add the file in Data.`;
  } else
    status.textContent = `Inserted "${item[0]}". Change the names to your own.`;
});

// ----- copying the results -----
/** Puts text on the clipboard, with a fallback for browsers that refuse. */
async function copyText(text, done) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
  }
  status.textContent = copied
    ? done
    : "This browser did not allow copying. Select the text in Results and copy it.";
}
/** Every record in the Results window, as one log. */
const allResults = () =>
  [...output.querySelectorAll(".console-record")]
    .map((block) => block.text ?? "")
    .join("\n");
function offerKeeping() {
  const any = !!output.querySelector(".console-record");
  $("console-copy-all").hidden = !any;
  $("console-save-log").hidden = !any;
}
$("console-copy-all").addEventListener("click", () =>
  copyText(allResults(), "All the results were copied."),
);
$("console-save-log").addEventListener("click", () => {
  hand(new TextEncoder().encode(allResults()), "results.log", "text/plain");
  status.textContent =
    "Downloaded results.log: every command in Results and what it printed.";
});

// ----- the whole project as a folder to run in Stata -----
function hand(bytes, name, type) {
  const link = document.createElement("a"),
    url = URL.createObjectURL(new Blob([bytes], { type }));
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$("console-download").addEventListener("click", async () => {
  save();
  const files = mapping ? map.files() : project.files,
    added = [];
  for (const [name, file] of uploads)
    added.push({
      name,
      made: file.made,
      written: !!file.written,
      data: new Uint8Array(await file.blob.arrayBuffer()),
    });
  const bytes = projectZip(files, added, new Date(), ranTyped.join("\n"));
  document.body.dataset.downloaded = String(bytes.length);
  hand(bytes, "stata-project.zip", "application/zip");
  status.textContent = `Downloaded stata-project.zip: ${files.map((file) => file.name).join(", ")}, the data they use, and a note on running it in Stata.`;
});

// ----- what runs here, with a filter -----
// Each name opens its entry: what it does, how to write it, Stata's help.
const names = [...new Set(KNOWN.map((command) => command.name))].sort(),
  list = $("console-commands"),
  items = names.map((name) => {
    const item = document.createElement("li"),
      button = document.createElement("button"),
      code = document.createElement("code");
    button.type = "button";
    button.className = "console-help-name";
    button.setAttribute("aria-expanded", "false");
    code.textContent = name;
    button.append(code);
    button.addEventListener("click", () => {
      const open = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(open));
      item.classList.toggle("is-open", open);
      if (open && !item.querySelector(".console-help-card"))
        item.append(helpCard(name));
    });
    item.dataset.search = `${name} ${HELP[name]?.[0] ?? ""}`.toLowerCase();
    item.append(button);
    list.append(item);
    return item;
  });
$("console-filter").addEventListener("input", (event) => {
  const wanted = event.target.value.trim().toLowerCase(),
    // One command's help, opened from a hint, shows that command alone.
    only = !!event.detail?.only;
  // The command of that name first, then those whose names begin with or
  // hold what is typed, then those whose description has a word that
  // begins with it: regress before ivregress, and graph finds twoway.
  const word = new RegExp(
      `\\b${wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
    rank = (name, k) =>
      name === wanted
        ? 0
        : name.startsWith(wanted)
          ? 1
          : name.includes(wanted)
            ? 2
            : !only && word.test(items[k].dataset.search)
              ? 3
              : 4;
  const ranked = names
    .map((name, k) => ({ name, k, rank: wanted ? rank(name, k) : 0 }))
    .filter((each) => each.rank < 4)
    .sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name));
  const byName = ranked.filter((each) => each.rank < 3),
    byUse = ranked.filter((each) => each.rank === 3),
    shown = new Set(ranked.map((each) => each.k));
  items.forEach((item, k) => {
    item.hidden = !!wanted && !shown.has(k);
  });
  // The list is in that order while something is typed, and in the
  // alphabet's order when the filter is empty.
  for (const each of ranked) list.append(items[each.k]);
  const advice =
    wanted && !byName.length
      ? adviseRecord(
          {
            command: wanted,
            lines: [`command ${wanted} is unrecognized`],
            rc: 199,
          },
          { commands: KNOWN },
        )
      : null;
  $("console-found").textContent = !wanted
    ? ""
    : byName.length
      ? `${ranked.length} of ${names.length} commands match${byUse.length ? `: ${byName.length} by name, then ${byUse.length} by what they do` : ""}.`
      : `No command here is called ${wanted}.${
          byUse.length
            ? ` ${byUse.length === 1 ? "This one does" : `These ${byUse.length} do`} what you describe.`
            : advice?.suggest.length
              ? ` ${advice.text.replace(" The Commands list shows what runs here.", "")}`
              : " It may be written differently, or not be available here."
        }`;
});

// ----- the colours of the Results window -----
const scheme = $("console-scheme"),
  frame = $("console-window");
function setScheme(classic) {
  frame.dataset.scheme = classic ? "classic" : "standard";
  scheme.setAttribute("aria-pressed", String(classic));
}
try {
  setScheme(localStorage.getItem(SCHEME_KEY) === "classic");
} catch {
  setScheme(false);
}
scheme.addEventListener("click", () => {
  const classic = frame.dataset.scheme !== "classic";
  setScheme(classic);
  try {
    localStorage.setItem(SCHEME_KEY, classic ? "classic" : "standard");
  } catch {
    // The choice then lasts for this visit only.
  }
});

run.addEventListener("click", () => (mapping ? map.runAll() : execute()));
runSelection.addEventListener("click", () =>
  execute(selectedLines(), "selection"),
);
// Whether a Stop is being dealt with: the run ended and the session being
// put back. Pressing Stop again then changes nothing, as pressing Break
// twice changes nothing in Stata.
let restoring = false;
stop.addEventListener("click", async () => {
  // What was typed to run after this run is dropped with it.
  entered.length = 0;
  if (restoring) {
    status.textContent =
      "Stop was pressed: the session is being put back as it was when the run stopped. This ends by itself.";
    return;
  }
  restoring = true;
  // Ending the worker is the only way to interrupt it. What the run has
  // already said (what it printed, how far it got) is let in first, so
  // that the point it is put back to is the one Results show.
  await new Promise((resolve) => setTimeout(resolve, 60));
  worker?.terminate();
  worker = null;
  stopped = null;
  abandon(Object.assign(new Error("stopped"), { stopped: true }));
  // The run's own ending (what it printed, where it stopped) comes first.
  await new Promise((resolve) => setTimeout(resolve, 0));
  fox.idle();
  const where = stopped?.line ? ` on line ${stopped.line}` : "";
  status.textContent = `Stopped${where}. Putting the session back as it was when the run stopped (the commands run since it was last cleared are run again, which takes about as long as they took)…`;
  await restart(
    `Stopped${where} (--Break--). The commands that had finished when you pressed Stop took effect, as they do after Break in Stata.`,
    true,
  );
  restoring = false;
  busy(false);
});
// Ctrl or ⌘ + . stops a run, as Break does in Stata for Mac.
document.addEventListener("keydown", (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key === "." &&
    isRunning &&
    !stop.hidden
  ) {
    event.preventDefault();
    stop.click();
  }
});
reset.addEventListener("click", async () => {
  if (isRunning || !mayReplaceData("Clear the session")) return;
  output.textContent = "";
  offerKeeping();
  for (const file of project.files) {
    marksOf(file).forEach(forget);
    marks.delete(file);
  }
  linked = [];
  paintMarks();
  place();
  fox.idle();
  fox.say("");
  await newSession(
    `The session was cleared. The do-file text is unchanged${uploads.size ? ", and your files, those the session wrote among them, are still here" : ""}.`,
  );
});
examples.addEventListener("change", () => {
  const example = EXAMPLES.find((e) => e.id === examples.value);
  examples.value = "";
  if (!example) return;
  // The do-file holds the student's work: the example opens beside it.
  const own = source.value.trim();
  if (own && !EXAMPLES.some((each) => each.text.trim() === own)) {
    const { names } = addDoFiles([
      { name: `${example.id}.do`, text: example.text },
    ]);
    source.setSelectionRange(0, 0);
    source.scrollTop = 0;
    follow();
    status.textContent = `Opened "${example.title}" as ${names[0]}, in a tab of its own; your do-file is unchanged.`;
    return;
  }
  typeInto(example.text, true);
  source.setSelectionRange(0, 0);
  source.scrollTop = 0;
  follow();
  status.textContent = `Loaded "${example.title}". Undo in the do-file brings the text before it back.`;
});
// Tab indents, as in Stata's Do-file Editor, and Shift+Tab takes the indent
// away; after Escape, Tab moves on from the editor, so that the keyboard can
// always leave it.
let tabLeaves = false;
source.addEventListener("keydown", (event) => {
  if (event.key === "Escape") tabLeaves = true;
  else if (event.key !== "Tab") tabLeaves = false;
  if (
    event.key !== "Tab" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    tabLeaves
  )
    return;
  event.preventDefault();
  indent(event.shiftKey);
});
source.addEventListener("blur", () => {
  tabLeaves = false;
});
/** Indents the lines of the selection by four spaces, or takes four away. */
function indent(back) {
  const { selectionStart: from, selectionEnd: to, value } = source;
  if (!back && from === to) {
    typeInto("    ", false);
    return;
  }
  const start = value.lastIndexOf("\n", from - 1) + 1,
    end = to > from && value[to - 1] === "\n" ? to - 1 : to,
    lines = value.slice(start, end).split("\n"),
    changed = lines.map((line) =>
      back ? line.replace(/^( {1,4}|\t)/, "") : `    ${line}`,
    ),
    text = changed.join("\n");
  if (text === lines.join("\n")) return;
  source.setSelectionRange(start, end);
  typeInto(text, false);
  // A caret stays where it was in its line; a selection holds the lines.
  if (from === to) {
    const at = Math.max(start, from + changed[0].length - lines[0].length);
    source.setSelectionRange(at, at);
  } else source.setSelectionRange(start, start + text.length);
}
source.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (run.disabled) return;
    if (event.shiftKey && selectedLines().trim())
      execute(selectedLines(), "selection");
    else execute();
  }
});
source.addEventListener("input", () => {
  typed = performance.now();
  save();
  paint();
});
source.addEventListener("scroll", follow);
document.addEventListener("selectionchange", () => {
  if (document.activeElement !== source) return;
  offerSelection();
  const line = lineAt(source.value, source.selectionStart);
  // Moving to a line shows what it printed; typing does not move Results.
  if (line !== caret) point(line, performance.now() - typed > 400);
});
source.addEventListener("focus", () => {
  typingAt = "source";
});
commandLine.addEventListener("focus", () => {
  typingAt = "command";
});
source.addEventListener("focus", () =>
  point(lineAt(source.value, source.selectionStart), false),
);
// From the Results window back to the do-file: pointing at a block shows
// its line, and selecting its command goes there.
function hint(block) {
  const line =
    block && block.file === current() && !mapping ? lineOf(block) : 0;
  if (Number(ghost.dataset.line || 0) === line) return;
  gutter.children[Number(ghost.dataset.line) - 1]?.classList.remove(
    "is-pointed",
  );
  ghost.dataset.line = line || "";
  gutter.children[line - 1]?.classList.add("is-pointed");
  place();
}
output.addEventListener("pointerover", (event) => {
  const block = event.target.closest?.(".console-record");
  hint(block);
  if (mapping && block?.dataset.step && map.hovering())
    map.point(Number(block.dataset.step), true);
});
output.addEventListener("pointerleave", () => hint(null));
output.addEventListener("click", (event) => {
  const block = event.target.closest?.(".console-command")?.parentElement;
  if (!block || !getSelection().isCollapsed) return;
  if (mapping) {
    if (block.dataset.step) map.reveal(Number(block.dataset.step));
    return;
  }
  backTo(block);
});
/** Goes from a block of Results to the line of the do-file it came from. */
function backTo(block) {
  const line = lineOf(block),
    k = project.files.indexOf(block.file);
  if (!line || k < 0 || mapping) return;
  if (k !== project.active) openFile(k);
  goTo(line);
}

// ----- the command line under the results -----
const history = [],
  // Every command run from the command line or a Load button, so that the
  // project zip carries the files they used.
  ranTyped = [];
let recalled = 0,
  // What was being typed when Up first recalled an earlier command.
  draft = "",
  // The lines of a loop, program or other block typed so far: as in
  // Stata's Command window, it runs once it is closed.
  typedBlock = [];
/**
 * What closes the block text leaves open: "}" for a loop or an if, "end"
 * for a program or input, or "" when nothing is left open. A } that closes
 * nothing is left for the run to report.
 */
function leftOpen(text) {
  const open = [];
  for (const { text: line } of splitCommands(text)) {
    if (open.at(-1) === "end") {
      if (line === "end") open.pop();
      continue;
    }
    if (
      /^pr(?:o(?:g(?:r(?:am?)?)?)?)?\s+(?:de(?:f(?:i(?:ne?)?)?)?\s+)?[A-Za-z_]\w*\s*(?:,.*)?$/.test(
        line,
      ) &&
      !/^pr\w*\s+(drop|dir|list)\b/.test(line)
    ) {
      open.push("end");
      continue;
    }
    if (/^inp(?:ut?)?(\s|$)/.test(line)) {
      open.push("end");
      continue;
    }
    if (/^\}/.test(line)) {
      if (open.at(-1) !== "}") return "";
      open.pop();
    }
    if (/\{$/.test(line)) open.push("}");
  }
  return open.at(-1) ?? "";
}
// The lines of the open block, shown at the foot of Results as Stata shows
// them while they are typed.
let pending = null;
function setOpened(lines, closer = "}") {
  typedBlock = lines;
  if (lines.length) {
    if (!pending) {
      pending = document.createElement("span");
      pending.className = "console-pending";
    }
    pending.textContent = `${lines.map((line, k) => (k ? `  ${k + 1}. ${line}` : `. ${line}`)).join("\n")}\n`;
    output.append(pending);
    output.scrollTop = output.scrollHeight;
  } else {
    pending?.remove();
    pending = null;
  }
  document.querySelector(".console-dot").textContent = typedBlock.length
    ? `${typedBlock.length + 1}.`
    : ".";
  commandLine.placeholder = typedBlock.length
    ? `the next line, or ${closer} to finish`
    : "type a command, press Enter";
}
$("console-prompt").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = commandLine.value.trim();
  if (!text && !typedBlock.length) return;
  if (text && history.at(-1) !== text) history.push(text);
  recalled = history.length;
  draft = "";
  commandLine.value = "";
  const lines = [...typedBlock, text],
    closer = leftOpen(lines.join("\n"));
  if (closer) {
    // As in Stata's Command window, the block runs when it is closed;
    // until then Results shows its lines as they are typed.
    setOpened(lines, closer);
    status.textContent = `${typedBlock[0]} is open: type its lines, then ${closer} on a line of its own to run it. Escape drops it.`;
    return;
  }
  setOpened([]);
  runTyped(lines.join("\n"));
});
// Commands entered while a run is going, in the order they were entered.
// Stop drops them.
const entered = [];
function runTyped(whole) {
  if (isRunning) {
    entered.push(whole);
    status.textContent =
      entered.length === 1
        ? "The command you entered runs when this run ends."
        : `The ${entered.length} commands you entered run when this run ends, in order.`;
    idle.push(() => {
      const next = entered.shift();
      if (next !== undefined) runTyped(next);
    });
    return;
  }
  ranTyped.push(whole);
  execute(whole, "command").then(() => commandLine.focus());
}
commandLine.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && typedBlock.length) {
    event.preventDefault();
    status.textContent = `The block ${typedBlock[0]} was dropped; nothing in it ran.`;
    setOpened([]);
    return;
  }
  // Ctrl or ⌘ + Enter runs the do-file from the editor; here, where Enter
  // runs the command, it runs the command too rather than doing nothing.
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("console-prompt").requestSubmit();
    return;
  }
  // Up and Down walk through the commands typed here, as in Stata. What
  // was being typed is kept, and Down past the newest command brings it
  // back, as a shell does.
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (!history.length) return;
  event.preventDefault();
  if (recalled === history.length) draft = commandLine.value;
  recalled = Math.max(
    0,
    Math.min(history.length, recalled + (event.key === "ArrowUp" ? -1 : 1)),
  );
  commandLine.value = history[recalled] ?? draft;
  const end = commandLine.value.length;
  commandLine.setSelectionRange(end, end);
});
// ----- the student's own files -----
// Kept on the page as well as in the session, so that they can go into a
// downloaded project and be given to a new session after Stop; and kept in
// this browser's IndexedDB, so that they are there on the next visit. Each
// is { blob, made }: made is true for a graph that graph export wrote.
const uploads = new Map();
let shelf = null;
async function shelve(name, blob, made = false, written = false) {
  try {
    await shelf?.put(name, blob, made, written);
    return true;
  } catch {
    return false;
  }
}
function showUploads() {
  const list = $("console-own");
  list.textContent = "";
  for (const [name, file] of uploads) {
    const item = document.createElement("li"),
      title = document.createElement("code"),
      size = document.createElement("span"),
      buttons = [];
    title.textContent = name;
    size.className = "console-own-size";
    size.textContent = file.made
      ? `${megabytes(file.blob.size)}, made by graph export`
      : file.written
        ? `${megabytes(file.blob.size)}, written by this session`
        : megabytes(file.blob.size);
    if (file.made) {
      const download = document.createElement("button");
      download.textContent = `Download ${name}`;
      download.addEventListener("click", async () =>
        hand(
          new Uint8Array(await file.blob.arrayBuffer()),
          name,
          file.blob.type,
        ),
      );
      buttons.push(download);
    } else if (loadCommand(name)) {
      // formats.xpf holds value labels for import sasxport5; it is not
      // loaded on its own.
      const load = document.createElement("button"),
        build = document.createElement("button"),
        command = loadCommand(name);
      load.textContent = `Load ${name}`;
      load.addEventListener("click", () => {
        if (!mayReplaceData(`Load ${name} in their place`)) return;
        ranTyped.push(command);
        execute(`${command}\ndescribe`, "command");
      });
      build.textContent = "Start a map from it";
      build.addEventListener("click", () => {
        setMode(true);
        map.startFrom(name);
        $("main").scrollIntoView({ block: "start" });
      });
      buttons.push(load, build);
    }
    if (file.written) {
      const download = document.createElement("button");
      download.textContent = `Download ${name}`;
      download.addEventListener("click", async () =>
        hand(
          new Uint8Array(await file.blob.arrayBuffer()),
          name,
          /\.(log|txt|csv|do|smcl)$/i.test(name)
            ? "text/plain"
            : "application/octet-stream",
        ),
      );
      buttons.push(download);
    }
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.addEventListener("click", async () => {
      if (isRunning) return;
      uploads.delete(name);
      await shelf?.remove(name).catch(() => {});
      const result = await ask({ kind: "remove", name });
      showVariables(result.memory);
      showUploads();
      status.textContent = `${name} was removed from this browser.`;
    });
    buttons.push(remove);
    for (const button of buttons) {
      button.type = "button";
      button.className = "quiet-button";
      button.disabled = isRunning;
    }
    item.append(title, size, ...buttons);
    list.append(item);
  }
  $("console-kept").textContent = !uploads.size
    ? ""
    : shelf
      ? "Your files are kept in this browser's storage for this site, on this device only, until you remove them. They are not uploaded anywhere."
      : "This browser is not keeping added files (its storage is off, as in some private windows), so add them again after a reload.";
  if (mapping) map.draw();
}
/** Gives the session one of the student's files; progress as it is read. */
function sendUpload(name, file, progress, options) {
  if (file.made)
    return file.blob
      .arrayBuffer()
      .then((buffer) =>
        ask(
          { kind: "binary", name, bytes: new Uint8Array(buffer) },
          null,
          null,
          options,
        ),
      );
  return ask(
    { kind: "take", name, file: file.blob, as: fileKind(name) },
    progress,
    null,
    options,
  );
}
/** Graphs written by graph export, made into files and kept. */
async function keepMade(made) {
  const kept = [];
  for (const each of made) {
    try {
      const blob = new Blob([await picture(each)], {
        type: typeOf(each.format),
      });
      uploads.set(each.name, { blob, made: true });
      await shelve(each.name, blob, true);
      // The session gets the file's bytes, so that a later run reads the
      // PNG or PDF as Stata would; an SVG it already has as text.
      if (each.format !== "svg")
        await ask({
          kind: "binary",
          name: each.name,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        }).catch(() => {});
      kept.push(each.name);
    } catch {
      status.textContent = `${each.name} could not be drawn as ${each.format.toUpperCase()} in this browser.`;
    }
  }
  if (kept.length) showUploads();
}
/**
 * Files that save, export, putexcel or log using wrote: kept as the
 * student's own files are, in this browser and in a new session, since in
 * Stata they are on disk and neither clear all nor quitting removes them.
 */
async function keepWritten(names) {
  let lost = "";
  for (const name of names) {
    let file = null;
    try {
      file = (await ask({ kind: "read", name })).file;
    } catch {
      file = null;
    }
    if (!file) continue;
    const blob = new Blob([file.bytes ?? file.text]);
    uploads.set(name, { blob, made: false, written: true });
    if (!(await shelve(name, blob, false, true)) && shelf) lost = name;
  }
  showUploads();
  if (lost)
    status.textContent += ` ${lost} could not be kept in this browser (its storage is full), so it is here for this visit only: save a copy from Data.`;
}
/**
 * Whether the data in memory may be replaced: when they have changed since
 * they were last saved, the student is asked first, as Stata's File > Open
 * asks, and as use without clear refuses with r(4).
 */
function mayReplaceData(what) {
  if (!memoryNow.changed) return true;
  if (
    window.confirm(
      `The data in memory have changed since they were last saved. ${what}, and lose the changes?`,
    )
  )
    return true;
  status.textContent =
    "Nothing was replaced: the data in memory are as they were. Save them with save, or download them from Data, first.";
  return false;
}
// Leaving the page loses the data in memory, as quitting Stata does: the
// browser asks first when they have changed since they were last saved,
// as Stata warns on exit, or while a run is going on.
window.addEventListener("beforeunload", (event) => {
  if (!memoryNow.changed && !isRunning) return;
  event.preventDefault();
  event.returnValue = "";
});
/** Takes files from the picker or a drop. Returns what to tell the student. */
async function takeFiles(list) {
  const notes = [],
    scripts = [];
  let loaded = "",
    loadedName = "";
  // A file added during a run is taken when the run ends.
  if (isRunning) {
    status.textContent = `${list.map((file) => file.name).join(", ")} will be added when the run ends.`;
    await whenIdle();
  }
  for (const file of list) {
    // The name is kept as it is, apart from anything like a folder.
    const name = file.name.replace(/[\\/]+/g, "_"),
      kind = fileKind(name),
      refused = refusal(file.name, file.size);
    if (refused) {
      notes.push(refused);
      continue;
    }
    // A file of the same name is not replaced without asking, as the
    // operating system asks before a file in Stata's folder is overwritten.
    if (kind !== "do" && uploads.has(name)) {
      const was = uploads.get(name);
      if (
        !window.confirm(
          `${name} is already among your files${was.written ? " (the session wrote it)" : was.made ? " (graph export made it)" : ""}. Replace it with the file you chose?`,
        )
      ) {
        notes.push(`${name} was not added: the ${name} already here is kept.`);
        continue;
      }
    }
    if (kind === "do") {
      // The editor keeps do-files of up to 200,000 characters.
      const text = file.size < 1_000_000 ? await file.text() : null;
      if (text === null || text.length >= 200000 || text.includes("\0"))
        notes.push(
          text?.includes("\0")
            ? `${file.name} is not a text file, so it was not added.`
            : `${file.name} is longer than the editor holds (200,000 characters).`,
        );
      else scripts.push({ name, text });
      continue;
    }
    try {
      const big = file.size > 2_000_000,
        result = await sendUpload(
          name,
          { blob: file, made: false },
          big
            ? ({ loaded, total }) => {
                status.textContent = `Reading ${file.name}: ${Math.floor((100 * loaded) / total)}% of ${megabytes(total)}…`;
              }
            : null,
        );
      if (big) status.textContent = `Read ${file.name}.`;
      // A file added again is the last added, as the status says.
      uploads.delete(name);
      uploads.set(name, { blob: file, made: false });
      const kept = await shelve(name, file);
      showVariables(result.memory);
      notes.push(
        kind === "dta"
          ? `Added ${name}: ${result.rows.toLocaleString("en-US")} rows, ${result.variables} variables.`
          : `Added ${name}.`,
      );
      if (shelf && !kept)
        notes.push(
          `${name} could not be kept in this browser (its storage is full), so it is here for this visit only.`,
        );
      // When several are added together, the first that can be loaded is
      // the one loaded, and the note names it.
      if (!loaded && loadCommand(name)) {
        loaded = loadCommand(name);
        loadedName = name;
      }
    } catch (error) {
      notes.push(`${file.name}: ${error.message}.`);
    }
  }
  if (scripts.length) {
    const added = addDoFiles(scripts);
    notes.push(
      `Opened ${added.names.join(", ")} in the do-file editor.`,
      ...added.notes,
    );
  }
  showUploads();
  // One data file is loaded straight away when memory is empty, so there
  // is something to see. Data already in memory are never replaced: adding
  // a file to the folder does not touch memory in Stata, and it may be a
  // file to merge.
  const empty = !memoryNow.variables.length && !(memoryNow.observations > 0);
  if (loaded && !isRunning && !empty)
    notes.push(
      `The data in memory are unchanged; ${loaded} loads it in their place.`,
    );
  else if (loaded && !isRunning) {
    ranTyped.push(loaded);
    const ran = await execute(`${loaded}\ndescribe`, "command");
    notes.push(
      ran && !ran.rc
        ? `${loadedName} is in memory now; the command that loaded it is in Results.`
        : `The command that loads ${loadedName}, ${loaded}, stopped at an error; see Results.`,
    );
  }
  if (notes.length) status.textContent = notes.join(" ");
}
/** The files kept from earlier visits, given to the new session. */
async function restoreFiles() {
  shelf = await openShelf();
  let kept = [];
  try {
    kept = (await shelf?.list()) ?? [];
  } catch {
    kept = [];
  }
  const lost = [];
  for (const file of kept) {
    try {
      const result = await sendUpload(file.name, file, ({ loaded, total }) => {
        status.textContent = `Reading ${file.name} from this browser: ${Math.floor((100 * loaded) / total)}%…`;
      });
      uploads.set(file.name, {
        blob: file.blob,
        made: file.made,
        written: !!file.written,
      });
      showVariables(result.memory);
    } catch {
      // A file that cannot be read back is taken off the shelf, so that it
      // is reported once, not on every visit.
      lost.push(file.name);
      await shelf?.remove(file.name).catch(() => {});
    }
  }
  showUploads();
  return { count: uploads.size, lost };
}
// The picker offers every kind of file the page takes.
$("console-file").accept = ACCEPT;
$("console-file").addEventListener("change", async (event) => {
  const list = [...event.target.files];
  event.target.value = "";
  await takeFiles(list);
});
// Files dropped anywhere on the page are taken the same way.
let dragging = 0;
const carriesFiles = (event) =>
  [...(event.dataTransfer?.types ?? [])].includes("Files");
document.addEventListener("dragenter", (event) => {
  if (!carriesFiles(event)) return;
  dragging++;
  document.body.classList.add("is-dropping");
});
document.addEventListener("dragleave", (event) => {
  if (!carriesFiles(event)) return;
  dragging = Math.max(0, dragging - 1);
  if (!dragging) document.body.classList.remove("is-dropping");
});
document.addEventListener("dragover", (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
document.addEventListener("drop", async (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragging = 0;
  document.body.classList.remove("is-dropping");
  await takeFiles([...event.dataTransfer.files]);
});

$("console-count").textContent = `${names.length} run here`;

// ----- the More menu: closes after a choice, on Escape and on a click away -----
const more = $("console-more");
more.addEventListener("click", (event) => {
  if (event.target.closest("button:not(.console-switch)")) more.open = false;
});
// The menu opens under its button and is moved in from the edge of a narrow
// screen, so that none of it is off the page.
more.addEventListener("toggle", () => {
  const panel = more.querySelector(".console-menu-panel");
  panel.style.translate = "";
  if (!more.open) return;
  const box = panel.getBoundingClientRect(),
    room = document.documentElement.clientWidth;
  const shift =
    box.right > room - 8
      ? Math.max(room - 8 - box.right, 8 - box.left)
      : box.left < 8
        ? 8 - box.left
        : 0;
  if (shift) panel.style.translate = `${Math.round(shift)}px 0`;
});
for (const control of more.querySelectorAll("select, input"))
  control.addEventListener("change", () => {
    more.open = false;
  });
document.addEventListener("click", (event) => {
  if (more.open && !more.contains(event.target)) more.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !more.open) return;
  more.open = false;
  more.querySelector("summary").focus();
});
/** A file of the session's folder, as the browser's download. */
async function downloadFile(name) {
  let file = null;
  try {
    file = (await ask({ kind: "read", name })).file;
  } catch {
    file = null;
  }
  if (!file) {
    status.textContent = `${name} is no longer in this session.`;
    return;
  }
  const bytes = file.bytes ?? new TextEncoder().encode(file.text),
    type = /\.(log|txt|csv|do|smcl)$/i.test(name)
      ? "text/plain"
      : "application/octet-stream";
  hand(bytes, name, type);
  status.textContent = `Downloaded ${name}.`;
}
$("console-download-data").addEventListener("click", async () => {
  const result = await ask({ kind: "export" });
  if (!result.memory.variables.length) {
    status.textContent = "There is no data in memory to download.";
    return;
  }
  hand(result.bytes, "data.dta", "application/octet-stream");
  status.textContent = `Downloaded data.dta: ${result.memory.observations.toLocaleString("en-US")} observations, ${result.memory.variables.length} variables, as a Stata dataset.`;
});

await startWorker();
await newSession("Ready.");
{
  const { count, lost } = await restoreFiles();
  if (count || lost.length)
    status.textContent = [
      "Ready.",
      count
        ? `Your file${count === 1 ? " is" : "s are"} here from this browser: ${[...uploads.keys()].join(", ")}.`
        : "",
      lost.length
        ? `${lost.join(", ")} could not be read back and ${lost.length === 1 ? "was" : "were"} removed from this browser; add ${lost.length === 1 ? "it" : "them"} again.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
}
try {
  if (localStorage.getItem(MODE_KEY) === "map") setMode(true);
} catch {
  // The page then opens on the do-file.
}
document.body.dataset.consoleRunner = worker ? "worker" : "page";
busy(false);
