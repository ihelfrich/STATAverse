// The Console page: a do-file editor on the new runtime. The session runs in
// a worker so that a long do-file can be stopped; if a worker cannot start
// it runs in the page. Only the do-file text is kept between visits, under a
// key no other page reads.
import { COMMANDS } from "./runtime/commands.js";
import { LIBRARY } from "./console-datasets.js";
import { createConsoleSession } from "./console-session.js";
import { EXAMPLES } from "./console-examples.js";
import { highlight } from "./console-highlight.js";
import { lineAt, offsetOf, pieces, shift } from "./console-links.js";
import { mountMap } from "./console-map.js";
import { createFox } from "./console-fox.js";
import { SNIPPETS } from "./console-snippets.js";
import { projectZip } from "./console-project.js";
import { doName } from "./console-map-model.js";

const KEY = "stataverse:console:v1",
  SCHEME_KEY = "stataverse:console:scheme",
  PROJECT_KEY = "stataverse:console:project:v1",
  MODE_KEY = "stataverse:console:mode",
  FOX_KEY = "stataverse:console:fox",
  MAX_OUTPUT = 400000;
const EXAMPLE = EXAMPLES[0].text;
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
let worker = null,
  local = null,
  pending = null,
  sequence = 0;
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
        const lost = pending;
        pending = null;
        candidate.terminate();
        if (worker === candidate) worker = null;
        if (lost)
          lost.reject(
            Object.assign(new Error("the interpreter stopped unexpectedly"), {
              lost: true,
            }),
          );
        else
          restart(
            "The interpreter stopped unexpectedly. The session was cleared; the do-file text is unchanged.",
          );
      };
      candidate.onmessage = ({ data: reply }) => {
        if (!pending || reply.id !== pending.id) return;
        const { resolve: done, reject } = pending;
        pending = null;
        if (reply.ok) done(reply);
        else reject(new Error(reply.message));
      };
      worker = candidate;
      resolve(true);
    };
  });
}
function ask(message) {
  if (!worker) {
    local ??= createConsoleSession();
    try {
      return Promise.resolve(
        message.kind === "run"
          ? local.run(message.source)
          : message.kind === "file"
            ? local.addFile(message.name, message.text)
            : message.kind === "data"
              ? local.addData(message.name, message.bytes)
              : message.kind === "remove"
                ? local.removeFile(message.name)
                : message.kind === "export"
                  ? local.exportData()
                  : local.reset(message.dataset),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise((resolve, reject) => {
    pending = { id: ++sequence, resolve, reject };
    worker.postMessage({ ...message, id: pending.id });
  });
}

// ----- the project: one or more do-files, kept between visits -----
function loadProject() {
  try {
    const kept = JSON.parse(localStorage.getItem(PROJECT_KEY));
    if (
      kept &&
      Array.isArray(kept.files) &&
      kept.files.length &&
      kept.files.length <= 30 &&
      kept.files.every(
        (file) =>
          file &&
          typeof file.name === "string" &&
          /^[A-Za-z0-9_-]{1,60}\.do$/.test(file.name) &&
          typeof file.text === "string" &&
          file.text.length < 200000,
      )
    )
      return {
        files: kept.files.map(({ name, text }) => ({ name, text })),
        active: Math.min(kept.files.length - 1, Math.max(0, kept.active | 0)),
      };
  } catch {
    // Fall through to the single do-file of earlier visits.
  }
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
function save() {
  project.files[project.active].text = source.value;
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
  } catch {
    // Storage can be full or unavailable; the page still works without it.
  }
}
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
/** Adds do-files to the project, replacing any of the same name. */
function addDoFiles(files, open = true) {
  save();
  let first = -1;
  for (const file of files) {
    const name = doName(file.name);
    let at = project.files.findIndex((each) => each.name === name);
    if (at < 0) at = project.files.push({ name, text: "" }) - 1;
    project.files[at].text = file.text;
    if (first < 0) first = at;
  }
  if (open && first >= 0) {
    project.active = first;
    source.value = project.files[first].text;
  }
  save();
  showTabs();
  paint();
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
  opened = false;
function showVariables(memory) {
  const table = $("console-variable-table"),
    body = table.querySelector("tbody"),
    before = known;
  known = new Set(memory.variables.map((v) => v.name));
  body.textContent = "";
  for (const variable of memory.variables) {
    const row = document.createElement("tr"),
      name = document.createElement("td"),
      insert = document.createElement("button");
    insert.type = "button";
    insert.className = "console-name";
    insert.textContent = variable.name;
    insert.title = `Put ${variable.name} in the do-file`;
    insert.addEventListener("click", () => {
      // In the map a name goes to the field last used there.
      if (mapping) {
        if (!map.insert(variable.name))
          status.textContent =
            "Select a field in a step first; the name goes there.";
      } else typeInto(variable.name, false);
    });
    name.append(insert);
    row.append(name);
    // A variable this run created is marked for a moment.
    if (before && !before.has(variable.name)) row.className = "is-new";
    for (const text of [variable.type, variable.format, variable.label]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    body.append(row);
  }
  table.hidden = !memory.variables.length;
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
  $("console-files").textContent = memory.files.length
    ? memory.files.join(", ")
    : "none";
  $("console-memory").textContent = memory.variables.length
    ? `${memory.observations.toLocaleString("en-US")} observations, ${memory.variables.length} variables${memory.sortedBy.length ? `, sorted by ${memory.sortedBy.join(" ")}` : ""}.`
    : "No data in memory.";
}

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
  figure.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  return figure;
}
/** One command and what it printed, as it appears in the Results window. */
function recordNode(record) {
  const block = document.createElement("span"),
    command = document.createElement("span");
  block.className = "console-record";
  command.className = "console-command";
  command.textContent = `. ${record.command}`;
  block.append(command, "\n");
  if (record.lines.length) {
    const lines = linesOf(record.lines.join("\n") + "\n", !!record.rc);
    lines.classList.add("console-lines");
    if (record.rc) lines.classList.add("console-error");
    lines.style.setProperty("--rows", Math.min(record.lines.length, 14));
    block.append(lines);
  }
  if (record.graph) block.append(graphOf(record.graph), "\n");
  block.append("\n");
  return block;
}
/**
 * Adds records to the Results window. `origin` says where they came from:
 * lines of a do-file ({ file, from, to }) or a step of the map ({ step }).
 */
function show(records, origin) {
  const set = origin?.file ? marksOf(origin.file) : null;
  if (set)
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
  commandLine.disabled = running;
  map.setBusy(running);
  $("console-download").disabled = running;
  $("console-download-data").disabled = running;
  for (const button of document.querySelectorAll("#console-datasets button"))
    button.disabled = running;
  offerSelection();
  stop.hidden = !running || !worker;
  status.dataset.state = running ? "running" : "idle";
}

/** Runs text in the session and shows what it printed; null after a fault. */
async function perform(text, origin) {
  let result;
  try {
    result = await ask({ kind: "run", source: text });
  } catch (error) {
    if (error.stopped) return null;
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
  show(result.output, origin);
  showVariables(result.memory);
  return result;
}
function finish(rc, commands, started) {
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  status.textContent = rc
    ? `Stopped at an error, return code ${rc}. Commands before it took effect.`
    : `Ran ${commands} command${commands === 1 ? "" : "s"} in ${seconds} seconds.`;
  busy(false);
  status.dataset.state = rc ? "error" : "done";
  if (rc) fox.failed(rc);
  else fox.done();
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
  if (result) finish(result.rc, result.output.length, started);
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
    commands += result.output.length;
    mark(entry.id, result.rc ? "error" : "done", result);
    if (result.rc) return finish(result.rc, commands, started);
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

/** A new worker with the student's files, and a new session in it. */
async function restart(message) {
  await startWorker();
  for (const [name, data] of uploads) await sendUpload(name, data);
  await newSession(message);
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
    uploads: () => [...uploads.keys()],
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
  addDoFiles(files);
  status.textContent =
    files.length > 1
      ? `The map was written to ${files.length} do-files. Run main.do to run them all.`
      : "The map was written to main.do.";
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
$("console-tab-delete").addEventListener("click", () => {
  if (project.files.length < 2) return;
  const [gone] = project.files.splice(project.active, 1);
  project.active = Math.max(0, project.active - 1);
  source.value = project.files[project.active].text;
  save();
  showTabs();
  paint();
  status.textContent = `${gone.name} was deleted.`;
});

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
  // The pattern goes on a line of its own, at the cursor.
  const { selectionStart: at, value } = source,
    before = at > 0 && value[at - 1] !== "\n" ? "\n" : "";
  source.setSelectionRange(at, at);
  typeInto(`${before}${item[1]}\n`, false);
  status.textContent = `Inserted "${item[0]}". Change the names to your own.`;
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
$("console-download").addEventListener("click", () => {
  save();
  const files = mapping ? map.files() : project.files,
    added = [...uploads].map(([name, data]) => ({ name, data })),
    bytes = projectZip(files, added);
  document.body.dataset.downloaded = String(bytes.length);
  hand(bytes, "stata-project.zip", "application/zip");
  status.textContent = `Downloaded stata-project.zip: ${files.map((file) => file.name).join(", ")}, the data they use, and a note on running it in Stata.`;
});

// ----- what runs here, with a filter -----
const names = [...new Set(COMMANDS.map((command) => command.name))].sort(),
  list = $("console-commands"),
  items = names.map((name) => {
    const item = document.createElement("li"),
      code = document.createElement("code");
    code.textContent = name;
    item.append(code);
    list.append(item);
    return item;
  });
$("console-filter").addEventListener("input", (event) => {
  const wanted = event.target.value.trim().toLowerCase();
  let shown = 0;
  items.forEach((item, k) => {
    item.hidden = !!wanted && !names[k].includes(wanted);
    if (!item.hidden) shown++;
  });
  $("console-found").textContent = !wanted
    ? ""
    : shown
      ? `${shown} of ${names.length} commands match.`
      : `No command here is called ${wanted}. It may be written differently, or not be available yet.`;
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
stop.addEventListener("click", async () => {
  // Ending the worker is the only way to interrupt it; the session goes too.
  const interrupted = pending;
  pending = null;
  worker?.terminate();
  worker = null;
  interrupted?.reject(Object.assign(new Error("stopped"), { stopped: true }));
  append("\n--Break--\n", "console-error");
  fox.idle();
  status.textContent = "Stopped. Starting a new session…";
  await restart(
    "Stopped. The session was cleared; the do-file text is unchanged.",
  );
  busy(false);
});
reset.addEventListener("click", async () => {
  output.textContent = "";
  for (const file of project.files) {
    marksOf(file).forEach(forget);
    marks.delete(file);
  }
  linked = [];
  paintMarks();
  place();
  fox.idle();
  fox.say("");
  await newSession("The session was cleared. The do-file text is unchanged.");
});
examples.addEventListener("change", () => {
  const example = EXAMPLES.find((e) => e.id === examples.value);
  examples.value = "";
  if (!example) return;
  typeInto(example.text, true);
  source.setSelectionRange(0, 0);
  source.scrollTop = 0;
  follow();
  status.textContent = `Loaded "${example.title}". Undo in the do-file brings your own text back.`;
});
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
  const line = lineOf(block),
    k = project.files.indexOf(block.file);
  if (!line || k < 0) return;
  if (k !== project.active) openFile(k);
  goTo(line);
});

// ----- the command line under the results -----
const history = [];
let recalled = 0;
$("console-prompt").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = commandLine.value.trim();
  if (!text || commandLine.disabled) return;
  if (history.at(-1) !== text) history.push(text);
  recalled = history.length;
  commandLine.value = "";
  execute(text, "command").then(() => commandLine.focus());
});
commandLine.addEventListener("keydown", (event) => {
  // Up and Down walk through the commands typed here, as in Stata.
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (!history.length) return;
  event.preventDefault();
  recalled = Math.max(
    0,
    Math.min(history.length, recalled + (event.key === "ArrowUp" ? -1 : 1)),
  );
  commandLine.value = history[recalled] ?? "";
});
// ----- the student's own files -----
// Kept on the page as well as in the session, so that they can go into a
// downloaded project and be given to a new session after Stop.
const uploads = new Map();
function showUploads() {
  const list = $("console-own");
  list.textContent = "";
  for (const name of uploads.keys()) {
    const item = document.createElement("li"),
      title = document.createElement("code"),
      dta = /\.dta$/i.test(name),
      command = dta
        ? `use "${name}", clear`
        : `import delimited using "${name}", clear`,
      load = document.createElement("button"),
      build = document.createElement("button"),
      remove = document.createElement("button");
    title.textContent = name;
    load.type = build.type = remove.type = "button";
    load.className = build.className = remove.className = "quiet-button";
    load.textContent = `Load ${name}`;
    load.addEventListener("click", () =>
      execute(`${command}\ndescribe`, "command"),
    );
    build.textContent = "Start a map from it";
    build.addEventListener("click", () => {
      setMode(true);
      map.startFrom(name);
      $("main").scrollIntoView({ block: "start" });
    });
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.addEventListener("click", async () => {
      uploads.delete(name);
      const result = await ask({ kind: "remove", name });
      showVariables(result.memory);
      showUploads();
      status.textContent = `${name} was removed.`;
    });
    item.append(title, load, build, remove);
    list.append(item);
  }
  if (mapping) map.draw();
}
async function sendUpload(name, data) {
  return typeof data === "string"
    ? ask({ kind: "file", name, text: data })
    : ask({ kind: "data", name, bytes: data });
}
/** Takes files from the picker or a drop. Returns what to tell the student. */
async function takeFiles(list) {
  const notes = [],
    scripts = [];
  let loaded = "";
  for (const file of list) {
    // The name is kept as it is, apart from anything like a folder.
    const name = file.name.replace(/[\\/]+/g, "_");
    if (file.size > 5_000_000) {
      notes.push(
        `${file.name} is larger than 5 MB, more than this page reads.`,
      );
      continue;
    }
    if (/\.(xlsx?|sav|rds|rdata|sas7bdat|parquet|zip)$/i.test(name)) {
      notes.push(
        `${file.name} cannot be read here. Save it as CSV or as a Stata .dta file and add that.`,
      );
      continue;
    }
    try {
      if (/\.dta$/i.test(name)) {
        const bytes = new Uint8Array(await file.arrayBuffer()),
          result = await sendUpload(name, bytes);
        uploads.set(name, bytes);
        showVariables(result.memory);
        notes.push(
          `Added ${name}: ${result.rows.toLocaleString("en-US")} rows, ${result.variables} variables.`,
        );
        loaded = `use "${name}", clear`;
        continue;
      }
      const text = await file.text();
      if (text.includes("\0")) {
        notes.push(`${file.name} is not a text file, so it was not added.`);
        continue;
      }
      if (/\.do$/i.test(name)) {
        scripts.push({ name, text });
        continue;
      }
      const result = await sendUpload(name, text);
      uploads.set(name, text);
      showVariables(result.memory);
      notes.push(`Added ${name}.`);
      loaded = `import delimited using "${name}", clear`;
    } catch (error) {
      notes.push(`${file.name}: ${error.message}.`);
    }
  }
  if (scripts.length) {
    addDoFiles(scripts);
    notes.push(
      `Opened ${scripts.map((file) => doName(file.name)).join(", ")} in the do-file editor.`,
    );
  }
  showUploads();
  // One data file is loaded straight away, so there is something to see.
  if (loaded && !run.disabled) {
    await execute(`${loaded}\ndescribe`, "command");
    notes.push(
      "It is in memory now; the command that loaded it is in Results.",
    );
  }
  if (notes.length) status.textContent = notes.join(" ");
}
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
try {
  if (localStorage.getItem(MODE_KEY) === "map") setMode(true);
} catch {
  // The page then opens on the do-file.
}
document.body.dataset.consoleRunner = worker ? "worker" : "page";
busy(false);
