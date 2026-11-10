// The Console page: a do-file editor on the new runtime. The session lives
// in this page; only the do-file text is kept between visits, under a key no
// other page reads.
import { Session } from "./runtime/session.js";
import { COMMANDS } from "./runtime/commands.js";
import { Dataset } from "./runtime/store.js";
import { DATASETS, createDataset } from "./datasets.js";

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
  reset = $("console-reset"),
  picker = $("console-dataset");

const library = Object.fromEntries(
  Object.keys(DATASETS).map((id) => [id, createDataset(id)]),
);
let session;
function newSession() {
  session = new Session();
  session.library = library;
  if (picker.value) session.data = Dataset.fromRows(library[picker.value]);
}

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

function showVariables() {
  const table = $("console-variable-table"),
    body = table.querySelector("tbody"),
    data = session.data;
  body.textContent = "";
  for (const variable of data.variables) {
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
  table.hidden = !data.variables.length;
  $("console-memory").textContent = data.variables.length
    ? `${data.n.toLocaleString("en-US")} observations, ${data.variables.length} variables${data.sortedBy.length ? `, sorted by ${data.sortedBy.join(" ")}` : ""}.`
    : "No data in memory.";
}

function append(text, className) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  output.append(span);
}

function execute() {
  const text = source.value;
  if (!text.trim()) {
    status.textContent = "The do-file is empty.";
    return;
  }
  save();
  run.disabled = true;
  let result;
  const started = performance.now();
  try {
    result = session.run(text);
  } catch (error) {
    // Anything that is not a Stata error is a fault in the interpreter.
    append(
      `\nThe interpreter stopped unexpectedly: ${error.message}\n`,
      "console-error",
    );
    status.textContent =
      "The interpreter stopped unexpectedly. The session was kept; please report the do-file that caused this.";
    run.disabled = false;
    return;
  }
  for (const record of result.output) {
    append(`. ${record.command}\n`, "console-command");
    if (record.lines.length)
      append(record.lines.join("\n") + "\n", record.rc ? "console-error" : "");
    if (record.graph) {
      // The SVG is produced by this site's own code from numbers and
      // escaped text, so it is parsed as an image, not as markup to trust.
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
  showVariables();
  const seconds = ((performance.now() - started) / 1000).toFixed(2);
  status.textContent = result.rc
    ? `Stopped at an error, return code ${result.rc}. Commands before it took effect.`
    : `Ran ${result.output.length} command${result.output.length === 1 ? "" : "s"} in ${seconds} seconds.`;
  run.disabled = false;
}

for (const [id, data] of Object.entries(DATASETS)) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = `${id}: ${data.title}`;
  picker.append(option);
}
source.value = saved() ?? EXAMPLE;
newSession();
showVariables();
$("console-commands").textContent =
  COMMANDS.map((command) => command.name)
    .sort()
    .join(", ") + ".";

run.addEventListener("click", execute);
reset.addEventListener("click", () => {
  newSession();
  output.textContent = "";
  showVariables();
  status.textContent =
    "The session was cleared. The do-file text is unchanged.";
});
picker.addEventListener("change", () => {
  newSession();
  showVariables();
  status.textContent = picker.value
    ? `Started a new session with the ${picker.value} data in memory.`
    : "Started a new session with no data in memory.";
});
source.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    execute();
  }
});
source.addEventListener("input", save);
run.disabled = false;
reset.disabled = false;
status.textContent = "Ready.";
