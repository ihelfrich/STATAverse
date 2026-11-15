// The Console's session and the plain-data summary the page displays. The
// same code runs in the worker and, when a worker cannot start, in the page.
import { Session } from "./runtime/session.js";
import { Dataset } from "./runtime/store.js";
import { addTextFile } from "./runtime/delimited.js";
import { ERROR_MARK, StataError } from "./runtime/errors.js";
import { toCSV } from "./datasets.js";
import { LIBRARY } from "./console-datasets.js";
import { readDta, writeDta } from "./console-dta.js";
import { binaryKind, checkForeign } from "./runtime/foreign.js";
import { applyFormat } from "./runtime/format.js";
import { isMissing, parseNumber } from "./runtime/values.js";
import { echoOf, fileEcho } from "./runtime/echo.js";
import { parseBlocks, splitCommands } from "./runtime/dofile.js";
import { createLogs, isLogMark } from "./console-log.js";
import { changed } from "./runtime/data-commands.js";

/**
 * What ends a run that is put back after Stop at the point where Stop
 * found it. It is not a StataError, so capture does not catch it and every
 * do-file and program it passes through ends as Break ends them.
 */
class Break extends Error {}

const library = Object.fromEntries(
    Object.entries(LIBRARY).map(([id, entry]) => [id, entry.data]),
  ),
  // Each dataset's data label: its title, as the .dta in a project zip has
  // it (Stata keeps 80 characters).
  labels = Object.fromEntries(
    Object.entries(LIBRARY).map(([id, entry]) => [
      id,
      (entry.title ?? "").slice(0, 80),
    ]),
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
    // Whether the data differ from what was last saved or loaded, as
    // c(changed) says, so that the page can ask before replacing them.
    changed: changed(session),
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
  // log using writes a file in the session's folder, as save does.
  const logs = createLogs({
    has: (name) => !!session.files?.has(name),
    text: (name) => session.files.get(name)?.text ?? "",
    write: (name, text) => (session.files ??= new Map()).set(name, { text }),
    linesize: () => session.settings.linesize ?? 79,
    logtype: () => session.settings.logtype,
  });
  const reset = (dataset = "") => {
    logs.clear();
    session = new Session();
    stamp++;
    interactive = session.frame();
    session.library = library;
    session.libraryLabels = labels;
    // Results as Stata's log shows them: a loop echoed once with its lines
    // numbered, do-files run by do shown with their commands.
    session.foldLoops = true;
    // Lines in Stata's error style are marked, to be shown in red.
    session.markErrors = true;
    // Each site dataset is also there as a CSV file, as lessons expect.
    for (const [id, data] of Object.entries(library))
      addTextFile(session, LIBRARY[id].file, toCSV(data));
    for (const [name, file] of added) put(name, file);
    if (dataset && library[dataset]) {
      session.data = Dataset.fromRows(library[dataset]);
      session.data.label = labels[dataset];
    }
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
        parsed = session.parse("[varlist] [if] [in] [, NOLabel]", where),
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
      // A start past the end shows the last page, in step with the others.
      const rows = view.rows,
        past = from >= rows.length && rows.length > 0,
        start = past
          ? Math.floor((rows.length - 1) / Math.max(1, count)) *
            Math.max(1, count)
          : Math.max(0, from);
      return {
        observations: data.n,
        shown: rows.length,
        from: start,
        past,
        columns: columns.map(({ name, type, format, label, valueLabel }) => ({
          name,
          type,
          format,
          label,
          valueLabel: valueLabel ?? "",
          // The label's numbers and texts, so that the editor takes a text.
          codes: valueLabel
            ? [...(data.valueLabels.get(valueLabel) ?? [])].slice(0, 2000)
            : [],
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
     * as it has in Stata, and the data it preserves are put back when it
     * ends. `progress`, when given, hears now and then which line has run
     * and how many commands, so that a long run shows where it is.
     *
     * A run given `stopAfter` (a count of commands) is a run put back after
     * Stop: it ends as Break would have ended it once that many commands
     * had finished, which is as far as the page had heard the stopped run
     * go, and ends with the record Stop showed, --Break-- and r(1).
     */
    run(
      source,
      {
        doFile = false,
        progress = null,
        stream = null,
        stopAfter = -1,
        endless = false,
      } = {},
    ) {
      stamp++;
      let commands = 0,
        // Commands, a loop's and a program's own among them, that finished
        // without an error: what took effect before a run stopped.
        finished = 0,
        last = 0;
      session.opened = null;
      // The files in the folder before the run, to tell which it wrote.
      const before = new Map(session.files ?? []);
      // The commands of the run, one at a time. Before each, what the ones
      // before it printed goes to `stream`, so that a run ended by Stop
      // keeps what it printed; and while one runs, what its inner commands
      // have printed so far, with how many commands have finished.
      let top = null,
        sent = 0,
        pending = [],
        told = 0,
        logged = 0,
        stopping = null,
        // The top-level command running now: how it is shown, where its
        // records begin, and all that it has printed (for a run put back).
        current = null;
      const stop = () => {
        if (stopAfter >= 0 && commands >= stopAfter) throw new Break();
      };
      logs.start();
      session.log = (text, ctx) => logs.command(text, ctx);
      const lines = source.replace(/\r\n?/g, "\n").split("\n"),
        // A do-file is echoed line by line, as Stata's log shows it:
        // comments and blank lines too, and each command as typed.
        file = doFile ? fileEcho(lines) : null,
        // Records carry the linesize they were made at, for Results and the
        // log to cut a long command where Stata cuts it.
        sized = (records) => {
          const width = session.settings.linesize ?? 79;
          if (width !== 79)
            for (const record of records) record.width ??= width;
          return records;
        };
      session.runNodes = function (nodes, frame, output) {
        if (top)
          return Session.prototype.runNodes.call(this, nodes, frame, output);
        top = output;
        for (let k = 0; k < nodes.length; k++) {
          const node = nodes[k];
          if (file) top.push(...sized(file.before(node.line)));
          logs.take(top, logged, top.length);
          logs.settle();
          logged = top.length;
          const typed =
              file && node.kind === "command" ? file.command(node.line) : null,
            shown =
              node.kind === "block" || node.kind === "program"
                ? echoOf(
                    lines,
                    node.line,
                    node.end || node.line,
                    node.kind === "program" ? 1 : 2,
                  )
                : (typed ?? { command: node.text ?? "", echo: [] });
          if (file && node.kind !== "command")
            file.skip(node.unclosed ? lines.length : (node.end ?? node.line));
          current = { ...shown, line: node.line, from: top.length, lines: [] };
          if (stream) {
            stream({
              records: top.slice(sent),
              node: k,
              line: node.line,
              command: shown.command,
              echo: shown.echo,
              count: commands,
            });
            sent = top.length;
            pending = [];
          }
          stop();
          try {
            Session.prototype.runNodes.call(this, [node], frame, output);
          } finally {
            // The command's record shows the line as typed.
            const record = typed && top[current.from];
            if (record && record.command === node.text && !record.echo) {
              // What it was read as is kept for the hints.
              if (typed.command !== node.text || typed.echo.length)
                record.text = node.text;
              record.command = typed.command;
              record.echo = typed.echo;
            }
          }
        }
        // Comments and blank lines after the last command; the file's last
        // line break ends it.
        if (file)
          top.push(
            ...sized(
              file.before(
                lines.at(-1) === "" ? lines.length : lines.length + 1,
              ),
            ),
          );
      };
      // The error a command stopped at, for what the Console says of it.
      session.dispatch = function (...args) {
        // A run put back after Stop ends before the first command that had
        // not finished, wherever it stands.
        stop();
        try {
          return Session.prototype.dispatch.apply(this, args);
        } catch (error) {
          this.failure = error;
          stopping = error;
          throw error;
        }
      };
      session.record = function (...args) {
        Session.prototype.record.apply(this, args);
        const entry = args[0].at(-1),
          failure = this.failure;
        this.failure = null;
        sized([entry]);
        // A log command's lines end here, even when capture or quietly kept
        // them out of Results.
        entry.lines.push(...logs.ends());
        // browse and edit say what the data browser is to show.
        if (this.opened) {
          if (!args[3]) entry.opened = this.opened;
          this.opened = null;
        }
        // The options a command takes, when one it lacks was given.
        if (args[3] && failure?.code === args[3] && failure.allowed)
          entry.allowed = failure.allowed;
        commands++;
        // A command captured, or a do-file reporting its error on the
        // line that failed, is recorded with 0 but did not finish.
        if (!args[3] && !failure) finished++;
        // In the worker, where Stop can end any run, a run is not cut short
        // after a fixed number of commands: a long loop runs to its end.
        if (endless) this.steps = 0;
        if (stream) {
          // What the command running now has printed, its last lines.
          pending.push(
            ...entry.lines
              .filter((line) => !isLogMark(line))
              .map((line) =>
                line.startsWith(ERROR_MARK)
                  ? line.slice(ERROR_MARK.length)
                  : line,
              ),
          );
          if (pending.length > 2000) pending = pending.slice(-1000);
        }
        if (stopAfter >= 0 && current) current.lines.push(...entry.lines);
        const now = Date.now();
        if (stream && now - told >= 150) {
          told = now;
          stream({ partial: pending.slice(-1000), count: commands });
        }
        if (progress && now - last >= 120) {
          last = now;
          progress({ line: args[5] ?? this.line ?? 0, commands });
        }
      };
      let ran;
      // A command typed in the Command window goes to the open cmdlog, as
      // in Stata; a do-file's commands do not.
      const typedLog = !doFile && session.cmdlog?.on ? session.cmdlog : null;
      if (typedLog && source.trim()) {
        const file = session.files?.get(typedLog.name);
        if (file && typeof file.text === "string")
          file.text += `${source.replace(/\r\n?/g, "\n").trim()}\n`;
      }
      try {
        ran = session.run(source, doFile ? undefined : interactive, {
          doFile,
        });
      } catch (error) {
        if (!(error instanceof Break)) throw error;
        // Put back to where Stop found it: the command running then is
        // shown with what it had printed, then --Break-- and r(1), as Stop
        // showed it, and as the log keeps it.
        const output = top ?? [];
        output.splice(current?.from ?? output.length);
        output.push({
          command: current?.command ?? "",
          echo: current?.echo ?? [],
          lines: [...(current?.lines ?? []), "--Break--", "r(1);"],
          rc: 1,
          fault: 2,
          ...(doFile && current?.line ? { line: current.line } : {}),
        });
        ran = { output, rc: 1 };
      } finally {
        delete session.runNodes;
        delete session.log;
        delete session.record;
        delete session.dispatch;
        session.failure = null;
        stamp++;
      }
      const { output, rc } = ran;
      // A block left open, or a } with no {, stops the run before any
      // command does: it is reported under the line it is about, as every
      // other error is, not in the status line alone.
      if (rc && !output.some((block) => block.rc)) {
        const commands = splitCommands(source);
        try {
          parseBlocks(commands);
        } catch (error) {
          if (error instanceof StataError) {
            const at = faultOf(commands, error.message);
            output.push({
              command:
                at?.text ?? lines.find((line) => line.trim())?.trim() ?? "",
              lines: [...(error.message ? [error.message] : []), `r(${rc});`],
              rc,
              fault: error.message ? 2 : 1,
              ...(doFile && at ? { line: at.line } : {}),
            });
          }
        }
      }
      // How many of the last lines of the record that stopped the run are
      // its error, so that only they are shown as one; what the command or
      // loop printed before it is shown as ordinary output.
      const stopped = output.findLast((block) => block.rc);
      if (stopped && stopped.fault === undefined) {
        // The message's own lines, as logit's "outcome does not vary;
        // remember:" and the two lines under it, when the record ends so.
        const said =
            stopping instanceof StataError &&
            stopping.code === stopped.rc &&
            stopping.message
              ? stopping.message.split("\n")
              : null,
          before = stopped.lines.slice(0, -1);
        stopped.fault =
          stopped.lines.at(-1) !== `r(${stopped.rc});`
            ? 0
            : said && before.slice(-said.length).join("\n") === said.join("\n")
              ? said.length + 1
              : stopping instanceof StataError && stopping.code === stopped.rc
                ? stopping.message
                  ? 2
                  : 1
                : Math.min(2, stopped.lines.length);
      }
      // A string variable where a number was needed: what its text is, so
      // that the Console's hint offers a command that works on it.
      for (const block of output)
        if (block.rc === 109 || block.rc === 2000)
          block.strings = stringContents(session, block);
      // A byte that is not UTF-8 (text from an old file, or cut out of a
      // character) is shown as U+FFFD, where Stata prints the raw byte.
      for (const block of output)
        block.lines = block.lines.map((line) =>
          line.replace(/(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/g, "\uFFFD"),
        );
      logs.take(output, logged, output.length);
      logs.settle();
      // The lines in the error style: which they are, and their text.
      for (const block of output)
        if (block.lines.some((line) => line.startsWith(ERROR_MARK))) {
          block.errorLines = [];
          block.lines = block.lines.map((line, k) => {
            if (!line.startsWith(ERROR_MARK)) return line;
            block.errorLines.push(k);
            return line.slice(ERROR_MARK.length);
          });
        }
      // Graphs written by graph export, for the page to turn into files.
      const made = session.exported ?? [];
      session.exported = [];
      // Files that save, export, putexcel or a log wrote: on disk in Stata,
      // they stay when the session is cleared, as the student's own do,
      // and the page keeps them as it keeps those.
      const written = [];
      for (const [name, file] of session.files ?? [])
        if (
          before.get(name) !== file &&
          !made.some((graph) => graph.name === name)
        ) {
          written.push(name);
          added.set(name, file);
        }
      return { output, rc, made, written, memory: memory(), finished };
    },
  };
}

// Entries that mean "no value" in files from other programs: destring with
// force makes them missing, which is what they mean.
const NOT_A_VALUE =
  /^(?:n\/?a|n\.a\.?|nan|null|none|missing|-+|\?+|\*+|\.+|#n\/a|not available|unknown|no data)$/i;

/**
 * What the string variables named in a failed record hold, read as destring
 * reads them: { numbers, ignore, missing, words, others }. numbers counts
 * entries that are numbers, perhaps once the characters in ignore (a comma,
 * $, % or a space) are taken out; missing names entries such as NA that
 * mean no value; words names, most common first, the entries that are text
 * (others counts how many different ones there are).
 */
function stringContents(session, block) {
  const names = session.data.names,
    named = new Set(),
    contents = {};
  // Names written whole, or abbreviated to a start only one name has.
  for (const word of `${block.command} ${(block.echo ?? []).join(" ")}`.split(
    /[^A-Za-z0-9_]+/,
  )) {
    if (!word) continue;
    const starting = names.filter((name) => name.startsWith(word));
    if (names.includes(word)) named.add(word);
    else if (starting.length === 1) named.add(starting[0]);
  }
  for (const variable of session.data.variables) {
    if (!/^str/.test(variable.type) || !named.has(variable.name)) continue;
    const kinds = new Map(),
      ignore = new Set(),
      missing = new Map(),
      words = new Map();
    let numbers = 0;
    const kindOf = (raw) => {
      const cell = raw.trim();
      if (cell === "" || cell === "." || /^\.[a-z]$/.test(cell)) return "";
      if (parseNumber(cell.replace(/^0+/, "0")) !== undefined) return "number";
      // Commas count only between thousands: 1,5 may be a decimal comma.
      const bare = raw.replace(/[,$%\s]/g, "").trim(),
        grouped =
          !cell.includes(",") ||
          /^[-+]?\$?\d{1,3}(,\d{3})+(\.\d*)?%?$/.test(cell.replace(/\s/g, ""));
      if (
        bare &&
        grouped &&
        parseNumber(bare.replace(/^0+/, "0")) !== undefined
      )
        return `number${[...new Set(raw.trim().match(/[,$%\s]/g))].join("")}`;
      return NOT_A_VALUE.test(cell) ? "missing" : "word";
    };
    for (const raw of variable.data) {
      let kind = kinds.get(raw);
      if (kind === undefined) {
        kind = kindOf(raw);
        if (kinds.size < 10000) kinds.set(raw, kind);
      }
      if (!kind) continue;
      if (kind.startsWith("number")) {
        numbers++;
        for (const c of kind.slice(6)) ignore.add(c);
      } else {
        const tally = kind === "missing" ? missing : words,
          cell = raw.trim();
        tally.set(cell, (tally.get(cell) ?? 0) + 1);
      }
    }
    const common = (tally) =>
      [...tally]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([text]) => text);
    contents[variable.name] = {
      numbers,
      ignore: [
        ...new Set([...ignore].map((c) => (/\s/.test(c) ? " " : c))),
      ].join(""),
      missing: common(missing),
      words: common(words),
      others: words.size,
    };
  }
  return contents;
}

/**
 * The command a block error is about: the { left open, the } with no {, or
 * the program with no end.
 */
function faultOf(commands, message) {
  const open = [];
  for (const command of commands) {
    if (
      /^pr(o(g(r(am?)?)?)?)?\s+/.test(command.text) &&
      !/^pr\w*\s+(drop|dir|list)\b/.test(command.text)
    )
      open.push(command);
    else if (/\{$/.test(command.text)) open.push(command);
    else if (command.text === "}" || command.text === "end") {
      if (!open.length) return command;
      open.pop();
    }
  }
  if (/^program /.test(message))
    return open.find((command) => /^pr/.test(command.text)) ?? open.at(-1);
  return open.at(-1) ?? commands.at(-1);
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
