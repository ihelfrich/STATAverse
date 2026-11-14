// Turns the do-files of a Console project into a folder that runs in Stata
// on the student's own computer: the do-files, the data they use, and a
// note on how to run them.
import { Dataset } from "./runtime/store.js";
import { LIBRARY } from "./console-datasets.js";
import { writeDta } from "./console-dta.js";
import { zip } from "./console-zip.js";

const SYSUSE = /^(\s*)sysuse\s+("?)([A-Za-z_]\w*)(?:\.dta)?\2\s*(,.*)?$/;

/**
 * A do-file as it should read on the student's computer: sysuse of one of
 * this site's datasets becomes use of the copy in the data folder. The names
 * of the datasets used are added to `used`.
 */
export function localise(text, used = new Set()) {
  return text
    .split("\n")
    .map((line) => {
      const m = SYSUSE.exec(line);
      if (!m || !LIBRARY[m[3]]) return line;
      used.add(m[3]);
      return `${m[1]}use "data/${m[3]}.dta"${m[4] ?? ""}`;
    })
    .join("\n");
}
/** One of the site's datasets as a .dta file, with its labels and types. */
export function datasetFile(id, now) {
  const data = Dataset.fromRows(LIBRARY[id].data).snapshot();
  data.label = LIBRARY[id].title.slice(0, 80);
  return writeDta(data, now);
}
function readme(files, used, added) {
  const main = files.some((file) => file.name === "main.do")
    ? "main.do"
    : files[0].name;
  return [
    "A Stata project from the STATAverse Console",
    "===========================================",
    "",
    "To run it in Stata on your own computer:",
    "",
    "  1. Unzip this folder.",
    "  2. In Stata, change to the folder. For example:",
    '       cd "C:/Users/you/Downloads/stata-project"',
    `  3. Type:  do ${main}`,
    "",
    "What is here",
    "------------",
    ...files.map((file) => `  ${file.name}`),
    ...[...used].map(
      (id) =>
        `  data/${id}.dta    ${LIBRARY[id].title} (invented for teaching)`,
    ),
    ...added.map(
      (file) =>
        `  ${file.name}    ${file.made ? "a graph the do-file exported" : "a file you added"}`,
    ),
    "",
    used.size
      ? 'In the Console these datasets are loaded with sysuse. Stata on your\ncomputer does not have them, so each sysuse line was rewritten as\nuse "data/name.dta" and the datasets are in the data folder.'
      : "",
    "",
    "The Console reproduces Stata's results command by command, but it is not",
    "Stata. If a number here differs from what you saw in the browser, Stata is",
    "the authority. Commands that draw random numbers give different draws.",
    "",
  ]
    .filter((line, k, all) => line !== "" || all[k - 1] !== "")
    .join("\r\n");
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whether commands name a file: by its whole name, or without its suffix,
 * as `use left` names left.dta and `import delimited using sales` names
 * sales.csv. Names are matched without regard to case, as on Windows and
 * macOS.
 */
export function mentions(text, name) {
  const stem = name.replace(/\.[^.]+$/, ""),
    edge = "(^|[^\\w.])",
    whole = new RegExp(`${edge}${escape(name)}(?![\\w])`, "i"),
    bare = new RegExp(`${edge}${escape(stem)}(?![\\w.])`, "i");
  return (
    whole.test(text) ||
    (!!stem && bare.test(text)) ||
    patterns(text).some(
      ({ pattern, suffix }) =>
        pattern.test(name) || (!suffix && pattern.test(stem)),
    )
  );
}
// A macro in a name: `y', `"..."', $name or ${name}.
const MACRO = /`[^`']*'|\$\{\w+\}|\$\w+/g;
/**
 * Names built from macros, as `use wave`w'` or `import delimited using
 * sales`y'.csv` in a loop, as patterns in which each macro stands for any
 * text. A name must keep some letters or digits of its own, so that a
 * display of `v' alone does not match every file.
 */
function patterns(text) {
  const found = [];
  for (const raw of text.match(/[^\s,"]*(?:`[^`'\s]*'|\$\{?\w+\}?)[^\s,"]*/g) ??
    []) {
    // The file's own name, after any folder.
    const token = raw.replace(/^.*[\\/]/, "");
    if (!/[A-Za-z0-9]/.test(token.replace(MACRO, ""))) continue;
    const source = token.split(MACRO).map(escape).join(".*");
    found.push({
      pattern: new RegExp(`^${source}$`, "i"),
      suffix: /\.[A-Za-z0-9]+$/.test(token),
    });
  }
  return found;
}
/**
 * The project as the bytes of a .zip file. files: [{ name, text }]; added:
 * the student's own files as [{ name, data, made }] with text or bytes;
 * typed: the commands run from the command line, which may use files too.
 * Graphs the do-files exported (made) are always carried.
 */
export function projectZip(files, added = [], now = new Date(), typed = "") {
  const used = new Set(),
    entries = files.map((file) => ({
      name: file.name,
      data: localise(file.text, used).replace(/\r?\n/g, "\r\n"),
    })),
    // Only the added files the commands mention are worth carrying.
    mentioned = added.filter(
      (file) =>
        file.made ||
        [typed, ...files.map((each) => each.text)].some((text) =>
          mentions(text, file.name),
        ),
    );
  for (const id of used)
    entries.push({ name: `data/${id}.dta`, data: datasetFile(id, now) });
  for (const file of mentioned)
    entries.push({ name: file.name, data: file.data });
  entries.push({ name: "README.txt", data: readme(files, used, mentioned) });
  return zip(
    entries.map((entry) => ({ ...entry, name: `stata-project/${entry.name}` })),
    now,
  );
}
