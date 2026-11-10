// The Console page: a do-file editor on the new runtime. The session runs in
// a worker so that a long do-file can be stopped; if a worker cannot start
// it runs in the page. Only the do-file text is kept between visits, under a
// key no other page reads.
import { COMMANDS } from "./runtime/commands.js";
import { DATASETS } from "./datasets.js";
import { createConsoleSession } from "./console-session.js";

const KEY = "stataverse:console:v1",
  MAX_OUTPUT = 400000;
const EXAMPLE = `* A first do-file. Change anything and run it again.
sysuse study, clear
describe
summarize hours score

* Scores by tutorial group
bysort group: summarize score

* A new variable, then a regression
generate passed = score >= 60 if score < .
tabulate group passed
regress score hours attendance
test hours = attendance

* A picture
twoway (scatter score hours) (lfit score hours)
`;
const $ = (id) => document.getElementById(id);
const source = $("console-source"),
  output = $("console-output"),
  status = $("console-status"),
  run = $("console-run"),
  stop = $("console-stop"),
  reset = $("console-reset"),
  picker = $("console-dataset");

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

function showVariables(memory) {
  const table = $("console-variable-table"),
    body = table.querySelector("tbody");
  body.textContent = "";
  for (const variable of memory.variables) {
    const row = document.createElement("tr");
    for (const text of [
      variable.name,
      variable.type,
      variable.format,
      variable.label,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    body.append(row);
  }
  table.hidden = !memory.variables.length;
  $("console-memory").textContent = memory.variables.length
    ? `${memory.observations.toLocaleString("en-US")} observations, ${memory.variables.length} variables${memory.sortedBy.length ? `, sorted by ${memory.sortedBy.join(" ")}` : ""}.`
    : "No data in memory.";
}

function append(text, className) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  output.append(span);
}
function busy(running) {
  run.disabled = running;
  reset.disabled = running;
  picker.disabled = running;
  stop.hidden = !running || !worker;
}

async function execute() {
  const text = source.value;
  if (!text.trim()) {
    status.textContent = "The do-file is empty.";
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
  for (const record of result.output) {
    append(`. ${record.command}\n`, "console-command");
    if (record.lines.length)
      append(record.lines.join("\n") + "\n", record.rc ? "console-error" : "");
    if (record.graph) {
      // The SVG is produced by this site's own code from numbers and
      // escaped text, and is shown as an image, not inserted as markup.
      const figure = document.createElement("img");
      figure.className = "console-graph";
      figure.alt = record.graph.description;
      figure.src =
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(record.graph.svg);
      output.append(figure, "\n");
    }
    append("\n");
  }
  if (output.textContent.length > MAX_OUTPUT) {
    while (output.textContent.length > MAX_OUTPUT / 2 && output.firstChild)
      output.firstChild.remove();
    output.prepend(
      "(earlier results were removed to keep the page responsive)\n\n",
    );
  }
  output.scrollTop = output.scrollHeight;
  showVariables(result.memory);
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  status.textContent = result.rc
    ? `Stopped at an error, return code ${result.rc}. Commands before it took effect.`
    : `Ran ${result.output.length} command${result.output.length === 1 ? "" : "s"} in ${seconds} seconds.`;
  busy(false);
}

async function newSession(message) {
  const result = await ask({ kind: "reset", dataset: picker.value });
  showVariables(result.memory);
  status.textContent = message;
}

for (const [id, data] of Object.entries(DATASETS)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = `${id}: ${data.title}`;
  picker.append(option);
}
source.value = saved() ?? EXAMPLE;
$("console-commands").textContent =
  COMMANDS.map((command) => command.name)
    .sort()
    .join(", ") + ".";

run.addEventListener("click", execute);
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
source.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (!run.disabled) execute();
  }
});
source.addEventListener("input", save);

await startWorker();
await newSession("Ready.");
document.body.dataset.consoleRunner = worker ? "worker" : "page";
busy(false);
