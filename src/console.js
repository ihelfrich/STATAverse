// The Console page: a do-file editor on the new runtime. The session runs in
// a worker so that a long do-file can be stopped; if a worker cannot start
// it runs in the page. Only the do-file text is kept between visits, under a
// key no other page reads.
import { COMMANDS } from "./runtime/commands.js";
import { LIBRARY } from "./console-datasets.js";
import { createConsoleSession } from "./console-session.js";
import { EXAMPLES } from "./console-examples.js";
import { highlight } from "./console-highlight.js";
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
  picker = $("console-dataset"),
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
        // A worker that dies mid-run loses the session.
        pending?.reject(new Error("the interpreter stopped unexpectedly"));
        pending = null;
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
  run.textContent = mapping
    ? "Run the map"
    : project.files.length > 1
      ? `Run ${project.files[project.active].name}`
      : "Run do-file";
}
function openFile(k) {
  save();
  project.active = k;
  source.value = project.files[k].text;
  source.scrollTop = 0;
  save();
  showTabs();
  paint();
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
  painted = $("console-highlight");
function paint() {
  const text = source.value,
    lines = text.split("\n").length;
  gutter.textContent = Array.from({ length: lines }, (_, k) => k + 1).join(
    "\n",
  );
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
let known = null;
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
const NUMBER = /(?<![\w.])-?(?:\d[\d,]*\.?\d*|\.\d+)(?:e[+-]?\d+)?(?![\w])/gi;
function linesOf(text, plain) {
  const block = document.createElement("span");
  if (plain || text.length > 20000) {
    block.textContent = text;
    return block;
  }
  let at = 0;
  for (const m of text.matchAll(NUMBER)) {
    if (m.index > at) block.append(text.slice(at, m.index));
    const number = document.createElement("span");
    number.className = "console-number";
    number.textContent = m[0];
    block.append(number);
    at = m.index + m[0].length;
  }
  if (at < text.length) block.append(text.slice(at));
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
function show(records) {
  const blocks = [],
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
    output.append(block);
    blocks.push(block);
  });
  if (output.textContent.length > MAX_OUTPUT) {
    while (output.textContent.length > MAX_OUTPUT / 2 && output.firstChild)
      output.firstChild.remove();
    output.prepend(
      "(earlier results were removed to keep the page responsive)\n\n",
    );
  }
  // New results that fit are shown whole; longer ones start at their top.
  const first = blocks.find((block) => block.isConnected);
  if (first && output.scrollHeight - first.offsetTop > output.clientHeight)
    output.scrollTop = first.offsetTop - output.offsetTop - 8;
  else output.scrollTop = output.scrollHeight;
}
function busy(running) {
  run.disabled = running;
  reset.disabled = running;
  picker.disabled = running;
  examples.disabled = running;
  commandLine.disabled = running;
  map.setBusy(running);
  $("map-run").disabled = running;
  $("console-download").disabled = running;
  for (const button of document.querySelectorAll("#console-datasets button"))
    button.disabled = running;
  runSelection.disabled = running || !selectedLines().trim();
  stop.hidden = !running || !worker;
  status.dataset.state = running ? "running" : "idle";
}

/** Runs text in the session and shows what it printed; null after a fault. */
async function perform(text) {
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
    status.textContent =
      "The interpreter stopped unexpectedly. Please report the do-file that caused this.";
    status.dataset.state = "error";
    fox.idle();
    busy(false);
    return null;
  }
  show(result.output);
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
  $("map-status").textContent = status.textContent;
  if (rc) fox.failed(rc);
  else fox.done();
}
function begin() {
  save();
  busy(true);
  status.textContent = "Running…";
  $("map-status").textContent = "Running…";
  fox.running();
  return performance.now();
}

async function execute(text = source.value, what = "do-file") {
  if (!text.trim()) {
    status.textContent = `The ${what} is empty.`;
    return;
  }
  const started = begin();
  // Every do-file of the project is there for do, run and include.
  await shareFiles();
  const result = await perform(text);
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
    $("map-status").textContent = status.textContent;
    return;
  }
  const started = begin();
  let commands = 0;
  for (const entry of entries) {
    mark(entry.id, "running");
    const result = await perform(entry.lines.join("\n"));
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

async function newSession(message) {
  const result = await ask({ kind: "reset", dataset: picker.value });
  known = null;
  showVariables(result.memory);
  status.textContent = message;
}

for (const [id, data] of Object.entries(LIBRARY)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = `${id}: ${data.title}`;
  picker.append(option);
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

// ----- the datasets, each with what was built into it -----
for (const entry of Object.values(LIBRARY)) {
  const item = document.createElement("li"),
    title = document.createElement("h3"),
    name = document.createElement("code"),
    size = document.createElement("p"),
    about = document.createElement("p"),
    load = document.createElement("button");
  name.textContent = entry.id;
  title.append(name, entry.title);
  size.className = "data-size";
  size.textContent = `${entry.data.rows.length.toLocaleString("en-US")} rows, ${entry.data.columns.length} variables. ${entry.unit}.`;
  about.textContent = entry.description;
  load.type = "button";
  load.className = "quiet-button";
  load.textContent = `Load ${entry.id}`;
  load.addEventListener("click", async () => {
    await execute(`sysuse ${entry.id}, clear\ndescribe`, "command");
    $("results-title").scrollIntoView({ block: "start" });
  });
  item.append(title, size, about, load);
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
  }),
  layout = document.querySelector(".console-layout");
let mapping = false;
function setMode(toMap) {
  mapping = toMap;
  layout.classList.toggle("is-mapping", toMap);
  $("console-map").hidden = !toMap;
  $("console-mapcode").hidden = !toMap;
  $("console-tabs-bar").hidden = toMap;
  run.hidden = toMap;
  document.querySelector(".console-code").hidden = toMap;
  $("console-choices").hidden = toMap;
  $("console-keys").hidden = toMap;
  runSelection.hidden = toMap;
  showTabs();
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
$("map-run").addEventListener("click", () => map.runAll());
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
  $("console-tab-name").select();
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
  $("map-status").textContent = "Downloaded stata-project.zip.";
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
  await startWorker();
  for (const [name, data] of uploads) await sendUpload(name, data);
  await newSession(
    "Stopped. The session was cleared; the do-file text is unchanged.",
  );
  busy(false);
});
reset.addEventListener("click", async () => {
  output.textContent = "";
  fox.idle();
  fox.say("");
  await newSession("The session was cleared. The do-file text is unchanged.");
});
picker.addEventListener("change", () =>
  newSession(
    picker.value
      ? `Started a new session with the ${picker.value} data in memory.`
      : "Started a new session with no data in memory.",
  ),
);
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
  save();
  paint();
});
source.addEventListener("scroll", follow);
document.addEventListener("selectionchange", () => {
  if (document.activeElement === source)
    runSelection.disabled = run.disabled || !selectedLines().trim();
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
      $("editor-title").scrollIntoView({ block: "start" });
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

await startWorker();
await newSession("Ready.");
try {
  if (localStorage.getItem(MODE_KEY) === "map") setMode(true);
} catch {
  // The page then opens on the do-file.
}
document.body.dataset.consoleRunner = worker ? "worker" : "page";
busy(false);
