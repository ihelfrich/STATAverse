// The Console page: a do-file editor on the new runtime. The session runs in
// a worker so that a long do-file can be stopped; if a worker cannot start
// it runs in the page. Only the do-file text is kept between visits, under a
// key no other page reads.
import { COMMANDS } from "./runtime/commands.js";
import { DATASETS } from "./datasets.js";
import { createConsoleSession } from "./console-session.js";
import { EXAMPLES } from "./console-examples.js";
import { highlight } from "./console-highlight.js";

const KEY = "stataverse:console:v1",
  SCHEME_KEY = "stataverse:console:scheme",
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
      candidate = new Worker(new URL("./console-worker.js", import.meta.url), {
        type: "module",
      });
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

// ----- the page -----
function saved() {
  try {
    const text = localStorage.getItem(KEY);
    return typeof text === "string" && text.length < 200000 ? text : null;
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem(KEY, source.value);
  } catch {
    // Storage can be full or unavailable; the page still works without it.
  }
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
    insert.addEventListener("click", () => typeInto(variable.name, false));
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
function show(records) {
  const blocks = [],
    // A long run arrives at once; a short one is typed and printed.
    lively = !still.matches && records.length <= 60;
  records.forEach((record, k) => {
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
  runSelection.disabled = running || !selectedLines().trim();
  stop.hidden = !running || !worker;
  status.dataset.state = running ? "running" : "idle";
}

async function execute(text = source.value, what = "do-file") {
  if (!text.trim()) {
    status.textContent = `The ${what} is empty.`;
    return;
  }
  save();
  busy(true);
  status.textContent = "Running…";
  const started = performance.now();
  let result;
  try {
    result = await ask({ kind: "run", source: text });
  } catch (error) {
    if (error.stopped) return;
    // Anything that is not a Stata error is a fault in the interpreter.
    append(
      `\nThe interpreter stopped unexpectedly: ${error.message}\n`,
      "console-error",
    );
    status.textContent =
      "The interpreter stopped unexpectedly. Please report the do-file that caused this.";
    busy(false);
    return;
  }
  show(result.output);
  showVariables(result.memory);
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  status.textContent = result.rc
    ? `Stopped at an error, return code ${result.rc}. Commands before it took effect.`
    : `Ran ${result.output.length} command${result.output.length === 1 ? "" : "s"} in ${seconds} seconds.`;
  status.dataset.state = result.rc ? "error" : "done";
  busy(false);
  status.dataset.state = result.rc ? "error" : "done";
}

async function newSession(message) {
  const result = await ask({ kind: "reset", dataset: picker.value });
  known = null;
  showVariables(result.memory);
  status.textContent = message;
}

for (const [id, data] of Object.entries(DATASETS)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = `${id}: ${data.title}`;
  picker.append(option);
}
for (const example of EXAMPLES) {
  const option = document.createElement("option");
  option.value = example.id;
  option.textContent = example.title;
  examples.append(option);
}
source.value = saved() ?? EXAMPLE;
paint();

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

run.addEventListener("click", () => execute());
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
  status.textContent = "Stopped. Starting a new session…";
  await startWorker();
  await newSession(
    "Stopped. The session was cleared; the do-file text is unchanged.",
  );
  busy(false);
});
reset.addEventListener("click", async () => {
  output.textContent = "";
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
$("console-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  if (file.size > 5_000_000) {
    status.textContent = `${file.name} is larger than 5 MB, which is more than this page reads.`;
    return;
  }
  const text = await file.text();
  if (text.includes("\0")) {
    status.textContent = `${file.name} is not a text file. Save it as CSV first; .dta and .xlsx files cannot be read here yet.`;
    return;
  }
  const result = await ask({ kind: "file", name: file.name, text });
  showVariables(result.memory);
  status.textContent = `Added ${file.name}. Read it with: import delimited using "${file.name}", clear`;
});

await startWorker();
await newSession("Ready.");
document.body.dataset.consoleRunner = worker ? "worker" : "page";
busy(false);
