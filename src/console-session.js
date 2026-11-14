// The Console's session and the plain-data summary the page displays. The
// same code runs in the worker and, when a worker cannot start, in the page.
import { Session } from "./runtime/session.js";
import { Dataset } from "./runtime/store.js";
import { addTextFile } from "./runtime/delimited.js";
import { StataError } from "./runtime/errors.js";
import { toCSV } from "./datasets.js";
import { LIBRARY } from "./console-datasets.js";
import { readDta, writeDta } from "./console-dta.js";
import { binaryKind, checkForeign } from "./runtime/foreign.js";
import { applyFormat } from "./runtime/format.js";
import { isMissing } from "./runtime/values.js";

const library = Object.fromEntries(
  Object.entries(LIBRARY).map(([id, entry]) => [id, entry.data]),
);

/**
 * Whether added bytes are text: no NUL in the text they decode to, and no
 * zero byte at all unless the scan chose UTF-16 or UTF-32, whose files are
 * whole numbers of their code units. A .dta, .xlsx or .zip file fails.
 */
function looksLikeText(bytes, stored) {
  const unit = /^UTF-32/.test(stored.encoding)
    ? 4
    : /^UTF-16/.test(stored.encoding)
      ? 2
      : 1;
  return (
    !stored.text.includes("\0") &&
    bytes.length % unit === 0 &&
    (unit > 1 || !bytes.includes(0))
  );
}

export function createConsoleSession() {
  let session,
    interactive,
    // Each run and reset changes the stamp, so a browser view made before
    // it is made again.
    stamp = 0,
    view = null;
  // Files the student added stay available when the session is cleared.
  const added = new Map();
  // A text file is kept as text, or as its bytes with the text decoded from
  // them; a .dta file as the dataset read from it.
  const put = (name, file) => {
    if (typeof file === "string" || file instanceof Uint8Array)
      addTextFile(session, name, file);
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
    // The first values of each value label, for the Variables list.
    labels: Object.fromEntries(
      [...session.data.valueLabels].map(([name, map]) => [
        name,
        { count: map.size, values: [...map].slice(0, 12) },
      ]),
    ),
  });
  const reset = (dataset = "") => {
    session = new Session();
    stamp++;
    interactive = session.frame();
    session.library = library;
    // Results as Stata's log shows them: a loop echoed once with its lines
    // numbered, do-files run by do shown with their commands.
    session.foldLoops = true;
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
    /**
     * A text file, as text or as the bytes the picker read. Bytes are
     * decoded as import delimited's scan decodes them (UTF-8, UTF-16 with
     * or without a byte-order mark, or Latin-1 and Windows-1252 when they
     * are not UTF-8) and kept, so that encoding() can read them again.
     */
    addFile(name, content) {
      const file =
        content instanceof ArrayBuffer ? new Uint8Array(content) : content;
      const before = session.files?.get(name),
        stored = addTextFile(session, name, file);
      if (file instanceof Uint8Array && !looksLikeText(file, stored)) {
        if (before) session.files.set(name, before);
        else session.files.delete(name);
        throw new StataError(
          `${name} is not a text file; open a Stata dataset with use, and save a spreadsheet as .csv before adding it`,
          610,
        );
      }
      added.set(name, file);
      return { memory: memory() };
    },
    /**
     * A .dta file: read once, then there for use, merge and append. A
     * workbook, SPSS or SAS file is kept as its bytes for import excel,
     * import spss and import sasxport5/8, and checked as it is added.
     */
    addData(name, bytes) {
      const kind = binaryKind(name);
      if (kind) {
        const file = { bytes: new Uint8Array(bytes) },
          check = checkForeign(kind, name, file);
        added.set(name, file);
        put(name, file);
        return { memory: memory(), kind, ...check };
      }
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
      // Kept as its bytes, as Stata keeps any file in its folder; the command
      // that reads it (import excel, import spss, ...) checks it.
      const file = { bytes: new Uint8Array(bytes) };
      added.set(name, file);
      put(name, file);
      return { memory: memory() };
    },
    removeFile(name) {
      added.delete(name);
      session.files?.delete(name);
      return { memory: memory() };
    },
    /**
     * A file in the session's folder, such as a workbook written by export
     * excel or putexcel, for the page to offer as a download: { bytes } or
     * { text }, or null when there is no such file.
     */
    readFile(name) {
      const file = session.files?.get(name);
      if (!file) return null;
      if (file.bytes instanceof Uint8Array) return { name, bytes: file.bytes };
      if (typeof file.text === "string") return { name, text: file.text };
      return { name, bytes: writeDta(file) };
    },
    /** The data in memory as the bytes of a .dta file. */
    exportData() {
      const data = session.data;
      return {
        // The file keeps the dataset's notes and characteristics.
        bytes: writeDta({
          ...data.snapshot(),
          notes: data.notes,
          chars: data.chars,
        }),
        memory: memory(),
      };
    },
    /**
     * A page of the data in memory for the data browser. `where` is what
     * followed browse or edit: a varlist, if and in. The rows can be put in
     * the order of one column (the data stay as they are) and limited to
     * those where a shown value contains `find`. Values are shown under
     * their display format, or as their value label when `labels` is on.
     */
    peek({
      where = "",
      from = 0,
      count = 100,
      order = null,
      find = "",
      labels = true,
    } = {}) {
      const data = session.data,
        parsed = session.parse("[varlist] [if] [in]", where),
        names = parsed.varlist.length ? parsed.varlist : data.names,
        columns = names.map((name) => data.get(name)),
        key = JSON.stringify([stamp, where, order, find, labels]);
      const text = (variable, i) => {
        const value = variable.data[i];
        if (typeof value === "string") return value;
        const named =
          labels && variable.valueLabel
            ? data.valueLabels.get(variable.valueLabel)?.get(value)
            : undefined;
        if (named !== undefined) return named;
        try {
          return applyFormat(value, variable.format).trim();
        } catch {
          return String(value);
        }
      };
      if (view?.key !== key) {
        let rows = session.rows(parsed, null);
        const wanted = find.trim().toLowerCase();
        if (wanted)
          rows = rows.filter((i) =>
            columns.some((column) =>
              text(column, i).toLowerCase().includes(wanted),
            ),
          );
        const by = order && data.has(order.name) && data.get(order.name).data;
        if (by) {
          const sign = order.descending ? -1 : 1;
          rows.sort((a, b) => {
            const x = by[a],
              y = by[b];
            return (x < y ? -sign : x > y ? sign : 0) || a - b;
          });
        }
        view = { key, rows };
      }
      const rows = view.rows,
        start = Math.max(0, Math.min(from, Math.max(0, rows.length - 1)));
      return {
        observations: data.n,
        shown: rows.length,
        from: start,
        columns: columns.map(({ name, type, format, label, valueLabel }) => ({
          name,
          type,
          format,
          label,
          valueLabel: valueLabel ?? "",
        })),
        rows: rows.slice(start, start + count).map((i) => ({
          obs: i + 1,
          cells: columns.map((column) => text(column, i)),
          raw: columns.map((column) => {
            const value = column.data[i];
            return typeof value === "string" || !isMissing(value)
              ? value
              : null;
          }),
        })),
      };
    },
    /**
     * Runs commands as Stata's Command window does: locals set by one are
     * there for the next. A do-file ({ doFile: true }) has locals of its own,
     * as it has in Stata. `progress`, when given, hears now and then which
     * line has run and how many commands, so that a long run shows where
     * it is.
     */
    run(source, { doFile = false, progress = null } = {}) {
      stamp++;
      if (progress) {
        let commands = 0,
          last = 0;
        session.record = function (...args) {
          Session.prototype.record.apply(this, args);
          commands++;
          const now = Date.now();
          if (now - last < 120) return;
          last = now;
          progress({ line: args[5] ?? this.line ?? 0, commands });
        };
      }
      let ran;
      try {
        ran = session.run(source, doFile ? undefined : interactive);
      } finally {
        delete session.record;
        stamp++;
      }
      const { output, rc } = ran;
      // A byte that is not UTF-8 (text from an old file, or cut out of a
      // character) is shown as U+FFFD, where Stata prints the raw byte.
      for (const block of output)
        block.lines = block.lines.map((line) =>
          line.replace(/(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/g, "\uFFFD"),
        );
      // Graphs written by graph export, for the page to turn into files.
      const made = session.exported ?? [];
      session.exported = [];
      return { output, rc, made, memory: memory() };
    },
  };
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
