// The Console's session and the plain-data summary the page displays. The
// same code runs in the worker and, when a worker cannot start, in the page.
import { Session } from "./runtime/session.js";
import { Dataset } from "./runtime/store.js";
import { addTextFile } from "./runtime/delimited.js";
import { splitCommands } from "./runtime/dofile.js";
import { toCSV } from "./datasets.js";
import { LIBRARY } from "./console-datasets.js";
import { readDta, writeDta } from "./console-dta.js";

const library = Object.fromEntries(
  Object.entries(LIBRARY).map(([id, entry]) => [id, entry.data]),
);

export function createConsoleSession() {
  let session;
  // Files the student added stay available when the session is cleared.
  const added = new Map();
  // A text file is kept as text, a .dta file as the dataset read from it,
  // and a workbook or an SPSS or SAS file as its bytes, for the import
  // command that reads it.
  const put = (name, file) => {
    if (typeof file === "string") addTextFile(session, name, file);
    else if (file instanceof Uint8Array)
      (session.files ??= new Map()).set(name, { bytes: file });
    else (session.files ??= new Map()).set(name, file);
  };
  const memory = () => ({
    observations: session.data.n,
    sortedBy: [...session.data.sortedBy],
    files: [...(session.files ?? new Map()).keys()].sort(),
    variables: session.data.variables.map(
      ({ name, type, format, label, valueLabel }) => ({
        name,
        type,
        format,
        label,
        valueLabel: valueLabel ?? "",
      }),
    ),
  });
  const reset = (dataset = "") => {
    session = new Session();
    session.library = library;
    // Each site dataset is also there as a CSV file, as lessons expect.
    for (const [id, data] of Object.entries(library))
      addTextFile(session, LIBRARY[id].file, toCSV(data));
    for (const [name, file] of added) put(name, file);
    if (dataset && library[dataset])
      session.data = Dataset.fromRows(library[dataset]);
    return { memory: memory() };
  };
  reset();
  return {
    reset,
    addFile(name, text) {
      addTextFile(session, name, text);
      added.set(name, text);
      return { memory: memory() };
    },
    /** A .dta file: read once, then there for use, merge and append. */
    addData(name, bytes) {
      let data;
      try {
        data = readDta(bytes);
      } catch (error) {
        // An array too large to make: the dataset does not fit in memory.
        if (error instanceof RangeError)
          throw new Error(
            "this dataset needs more memory than this browser tab has. In Stata, keep the variables and observations you need, save, and add that file",
          );
        throw error;
      }
      added.set(name, data);
      put(name, data);
      return {
        memory: memory(),
        rows: data.n,
        variables: data.variables.length,
      };
    },
    /** A file kept as its bytes: an Excel workbook, an SPSS or SAS file. */
    addBinary(name, bytes) {
      added.set(name, bytes);
      put(name, bytes);
      return { memory: memory() };
    },
    removeFile(name) {
      added.delete(name);
      session.files?.delete(name);
      return { memory: memory() };
    },
    /** The data in memory as the bytes of a .dta file. */
    exportData() {
      return { bytes: writeDta(session.data.snapshot()), memory: memory() };
    },
    run(source) {
      const { output, rc } = session.run(source),
        // Graphs written by graph export, for the page to turn into files.
        made = session.exported ?? [];
      session.exported = [];
      return {
        output: foldLoops(source, output, rc),
        rc,
        made,
        memory: memory(),
      };
    },
  };
}

// ----- loops in the Results window, as Stata shows them -----
// Stata echoes a loop once, with the lines of its body numbered, and then
// prints what the loop printed. The runtime records each command of each
// pass; here the records of a loop written in the do-file become one.
const PREFIX =
    "(?:(?:cap(?:t(?:u(?:re?)?)?)?|qui(?:e(?:t(?:ly?)?)?)?|n(?:o(?:i(?:s(?:i(?:ly?)?)?)?)?)?)\\s+)*",
  LOOP = new RegExp(
    `^${PREFIX}(?:foreach|forv(?:a(?:l(?:u(?:es?)?)?)?)?|while)\\s[\\s\\S]*\\{$`,
  ),
  QUIET = /^(?:(?:cap\w*|qui\w*)\s+)+(?!n)/,
  PROGRAM =
    /^pr(?:o(?:g(?:r(?:am?)?)?)?)?\s+(?:de(?:f(?:i(?:ne?)?)?)?\s+)?([A-Za-z_]\w*)/,
  INPUT = /^inp(?:ut?)?(\s|$)/;

/** The loops at the top level of a do-file: { start, end, text }. */
function loopsOf(source) {
  let commands;
  try {
    commands = splitCommands(source);
  } catch {
    return [];
  }
  const spans = [];
  let depth = 0,
    open = null,
    skipping = false;
  for (const { text, line } of commands) {
    // A program's body and input's rows are not run where they are written.
    if (skipping) {
      if (text === "end") skipping = false;
      continue;
    }
    if (!depth) {
      const program = PROGRAM.exec(text);
      if (
        (program && !["drop", "dir", "list", "define"].includes(program[1])) ||
        INPUT.test(text)
      ) {
        skipping = true;
        continue;
      }
    }
    if (text === "}") {
      if (depth) depth--;
      if (!depth && open) {
        open.end = line;
        spans.push(open);
        open = null;
      }
    } else if (/\{\s*$/.test(text)) {
      if (!depth && LOOP.test(text)) open = { start: line, text };
      depth++;
    }
  }
  return spans;
}

const expandTabs = (line) =>
  line.replace(/[^\t]*\t/g, (piece) => {
    const before = piece.length - 1;
    return piece.slice(0, -1) + " ".repeat(8 - (before % 8));
  });

/**
 * What one physical line holds once comments are taken out, and whether the
 * command goes on to the next line (/// or an open block comment).
 */
function scan(line, state) {
  let code = "",
    quote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i],
      next = line[i + 1];
    if (state.comment) {
      if (c === "/" && next === "*") (state.comment++, i++);
      else if (c === "*" && next === "/") (state.comment--, i++);
      continue;
    }
    if (quote) {
      if (c === '"') quote = false;
      code += c;
      continue;
    }
    if (c === '"') {
      quote = true;
      code += c;
    } else if (c === "/" && next === "*") {
      state.comment = 1;
      i++;
    } else if (c === "/" && next === "/" && (i === 0 || /\s/.test(line[i - 1])))
      return { code, continues: line[i + 2] === "/" };
    else if (c === "*" && !state.started && !code.trim()) return { code: "" };
    else code += c;
  }
  return { code, continues: state.comment > 0 };
}

/** The lines Stata echoes for a loop, from its source lines. */
function echoOf(lines, start, end) {
  const state = { comment: 0, started: false },
    echo = [];
  let command = "",
    number = 2,
    logical = "",
    afterEmpty = false,
    continued = false;
  for (let at = start; at <= end; at++) {
    const raw = lines[at - 1] ?? "",
      text = expandTabs(raw).replace(/\s+$/, "");
    state.started = continued;
    if (at === start) command = text.trimStart();
    else if (continued) echo.push(`> ${text}`);
    else if (afterEmpty) echo.push(`. ${text}`);
    else echo.push(`${String(number++).padStart(3)}. ${text}`);
    const { code, continues } = scan(raw, state);
    logical += code;
    continued = continues;
    if (!continued) {
      // A line that held no command makes the next line echo as a plain
      // prompt, without a number, as Stata's log shows.
      afterEmpty = !logical.trim();
      logical = "";
    }
  }
  return { command, echo };
}

/**
 * The records of a run with each top-level loop of `source` folded into one
 * record: the loop's text as Stata echoes it, then all that it printed.
 */
export function foldLoops(source, output, rc = 0) {
  const spans = loopsOf(source);
  if (!spans.length) return output;
  const lines = source.replace(/\r\n?/g, "\n").split("\n"),
    out = [];
  let s = 0,
    k = 0,
    stopped = false;
  const fold = (span, inner) => {
    const { command, echo } = echoOf(lines, span.start, span.end),
      // A quiet loop shows only its first line.
      quiet = QUIET.test(span.text),
      record = {
        command,
        echo: quiet ? [] : echo,
        lines: inner.flatMap((record) => record.lines),
        rc: inner.at(-1)?.rc ?? 0,
        line: span.start,
      },
      graphs = inner.map((record) => record.graph).filter(Boolean);
    if (graphs.length) {
      record.graph = graphs.at(-1);
      if (graphs.length > 1) record.graphs = graphs;
    }
    out.push(record);
    if (record.rc) stopped = true;
  };
  while (k < output.length) {
    const record = output[k];
    // A loop with no passes printed nothing, but it is still echoed.
    while (s < spans.length && record.line && spans[s].end < record.line) {
      if (!stopped) fold(spans[s], []);
      s++;
    }
    const span = spans[s];
    if (span && record.line >= span.start && record.line <= span.end) {
      const inner = [];
      while (
        k < output.length &&
        output[k].line >= span.start &&
        output[k].line <= span.end
      )
        inner.push(output[k++]);
      fold(span, inner);
      s++;
      continue;
    }
    out.push(record);
    if (record.rc) stopped = true;
    k++;
  }
  // A run that ended without an error went through every loop after the
  // last record; one that stopped before printing anything did not.
  for (; s < spans.length && !stopped && !rc; s++) fold(spans[s], []);
  return out;
}

/**
 * The name of an added file a run looked for and did not find, from the
 * error that stopped it; "" when the run did not stop on a missing file.
 */
export function missingFile(output) {
  const last = output.at(-1);
  if (!last || last.rc !== 601 || /^\s*(sysuse|webuse)\b/.test(last.command))
    return "";
  for (const line of last.lines) {
    const m = /^file (.+?) not found\b/.exec(line);
    if (m) return m[1].replace(/^"(.*)"$/, "$1");
  }
  return "";
}
