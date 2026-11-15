// log using, log close, log off, log on and log query in the Console. A log
// is a file in the session's folder, as save writes one, so that dir lists
// it and the page offers it for download; it holds what Stata's log holds:
// a header, then all that Results shows after it, and the closing lines. A
// text log is plain text; an SMCL log carries Stata's markup.
//
// Results are made of records, and a record can hold the work of many
// commands (a loop, a do-file run by do), so a log command marks its place
// among the lines: a line that begins with MARK, taken out before anything
// is shown, says where the command's own lines begin and where they end.
// The log is then written line by line in the order Results shows them, and
// each log begins and ends where its command stood, even inside a loop.
import { ERROR_MARK, StataError } from "./runtime/errors.js";

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" "),
  FOLDER = "/stataverse",
  MARK = "\u0000log\u0000";

/** Whether a line of a record is one of the logs' marks. */
export const isLogMark = (line) => line.startsWith(MARK);

/** When, as a log's header writes it: 14 Nov 2026, 18:02:04. */
function stamp(now = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}, ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}

/** Text shown as SMCL shows it: braces written as {c -(} and {c )-}. */
const smclText = (line) =>
  line.replace(/[{}]/g, (c) => (c === "{" ? "{c -(}" : "{c )-}"));

/** A run of rule characters as SMCL draws it: {hline n} and {c +}. */
const ruled = (text) =>
  text.replace(/-+|\+/g, (piece) =>
    piece === "+" ? "{c +}" : `{hline ${piece.length}}`,
  );

/**
 * One line of output in SMCL: rules and the bars of a table as Stata draws
 * them, numbers after a table's bar as results, a list's box with its
 * corners. `box` remembers whether a list's box is open.
 */
function smclLine(line, box) {
  if (line === "") return "{txt}";
  // A table's rule: -------------+----------
  if (/^-+(\+-+)+$/.test(line)) return `{txt}${ruled(line)}`;
  // A list's box: its top, the rule under its header, and its bottom.
  const edge = /^(\s*)\+(-+)\+$/.exec(line);
  if (edge) {
    box.open = !box.open;
    return `{txt}${edge[1]}{c ${box.open ? "TLC" : "BLC"}}{hline ${edge[2].length}}{c ${box.open ? "TRC" : "BRC"}}`;
  }
  const inner = /^(\s*)\|(-+)\|$/.exec(line);
  if (inner && box.open)
    return `{txt}${inner[1]}{c LT}{hline ${inner[2].length}}{c RT}`;
  const text = smclText(line);
  // A row of a list: what is between its bars is a result.
  const row = /^(\s*(?:\d+\.)?\s*)\|(.*)\|$/.exec(text);
  if (row && box.open) return `{txt}${row[1]}{c |}{res}${row[2]}{txt}{c |}`;
  // A row of a table: its label, a bar, then numbers as results.
  const bar = text.lastIndexOf(" |");
  if (bar > 0 && !/[|]/.test(text.slice(0, bar))) {
    const label = text.slice(0, bar + 1),
      values = text.slice(bar + 2);
    return /\d/.test(values) && !/[A-Za-z]{2}/.test(values)
      ? `{txt}${label}{c |}{res}${values}`
      : `{txt}${label}{c |}${values}`;
  }
  return `{txt}${text}`;
}

/**
 * The logs of one session. `files` is how to read and write a file in the
 * session's folder, and what the session's settings are: { has(name),
 * text(name), write(name, text), linesize(), logtype() }.
 */
export function createLogs(files) {
  const open = new Map();
  // What each mark stands for, and the marks of the command running now
  // that close its lines when it is recorded.
  const events = new Map();
  let ending = [],
    next = 0;

  const rule = () => "-".repeat(files.linesize?.() ?? 79);
  const fields = (log, when, word) => [
    `      name:  ${log.name}`,
    `       log:  ${log.path}`,
    `  log type:  ${log.type}`,
    `${word.padStart(10)}:  ${when}`,
  ];
  const write = (log) => files.write(log.file, log.text);
  const add = (log, piece) => {
    log.text += piece;
    write(log);
  };
  const smclHeader = (log, word, when) =>
    `{txt}{sf}{ul off}{.-}\n      name:  {res}${log.name}\n       {txt}log:  {res}${log.path}\n  {txt}log type:  {res}${log.type}\n${" ".repeat(10 - word.length)}{txt}${word}:  {res}${when}\n{txt}\n`;
  const smclFooter = (log, when) =>
    `      {txt}name:  {res}${log.name}\n       {txt}log:  {res}${log.path}\n  {txt}log type:  {res}${log.type}\n {txt}closed on:  {res}${when}\n{txt}{.-}\n{smcl}\n{txt}{sf}{ul off}`;

  /**
   * Marks where a log command's lines begin; `event` is applied where they
   * end, once the command is recorded, so that capture or quietly, which
   * keep its lines out of Results, do not keep the log from changing.
   */
  function mark(ctx, event) {
    const id = String(++next);
    events.set(id, event);
    ctx.out(`${MARK}b${id}`);
    ending.push(`${MARK}e${id}`);
  }

  /** The logs a close, off or on is about: the unnamed log, or those named. */
  function target(word) {
    if (word === "_all") return [...open.values()];
    if (word) {
      const log = open.get(word);
      if (!log) throw new StataError(`log ${word} not found`, 111);
      return [log];
    }
    return open.has("<unnamed>") ? [open.get("<unnamed>")] : [];
  }

  function using(rest, ctx) {
    const m =
      /^(?:"([^"]+)"|([^\s,]+))\s*(?:,(.*))?$/.exec(rest.trim()) ?? null;
    if (!m) throw new StataError("invalid file specification", 198);
    let file = (m[1] ?? m[2]).replace(/^.*[\\/]/, "");
    const options = {
      replace: false,
      append: false,
      type: "",
      name: "",
      nomsg: false,
    };
    for (const raw of (m[3] ?? "").match(/[A-Za-z]+(\([^)]*\))?/g) ?? []) {
      const word = /^[A-Za-z]+/.exec(raw)[0],
        value = /\(([^)]*)\)/.exec(raw)?.[1]?.trim() ?? "";
      if ("replace".startsWith(word) && word.length >= 7)
        options.replace = true;
      else if ("append".startsWith(word) && word.length >= 6)
        options.append = true;
      else if (word === "text" || word === "t") options.type = "text";
      else if (word === "smcl" || word === "s") options.type = "smcl";
      else if (word === "name" && value) options.name = value;
      else if (word === "nomsg") options.nomsg = true;
      else throw new StataError(`option ${word} not allowed`, 198);
    }
    if (options.replace && options.append)
      throw new StataError(
        "options replace and append may not be combined",
        198,
      );
    const name = options.name || "<unnamed>";
    if (open.has(name))
      throw new StataError(
        name === "<unnamed>"
          ? "log file already open"
          : `log file ${name} already open`,
        604,
      );
    // With no type named, set logtype decides, and a .log file is text.
    const chosen = options.type || files.logtype?.() || "smcl";
    if (!/\.[A-Za-z0-9]+$/.test(file))
      file += chosen === "text" ? ".log" : ".smcl";
    const type =
        options.type ||
        (/\.log$/i.test(file)
          ? "text"
          : /\.smcl$/i.test(file)
            ? "smcl"
            : chosen),
      path = `${FOLDER}/${file}`,
      exists = files.has(file);
    if (exists && !options.replace && !options.append)
      throw new StataError(`file ${path} already exists`, 602);
    const log = {
      name,
      file,
      path,
      type,
      on: true,
      writing: false,
      nomsg: options.nomsg,
      text: options.append && exists ? files.text(file) : "",
    };
    // quietly log using and nomsg write no header, as Stata's do.
    const quiet = !!ctx.flags?.quiet || options.nomsg,
      when = stamp();
    mark(ctx, { kind: "open", log, quiet, when });
    if ((options.replace || options.append) && !exists)
      ctx.out(`(file ${path} not found)`);
    if (!options.nomsg)
      for (const line of [rule(), ...fields(log, when, "opened on")])
        ctx.out(line);
    open.set(name, log);
    if (type === "smcl")
      log.text += quiet ? "{smcl}\n{txt}{sf}{ul off}" : "{smcl}\n";
    write(log);
  }

  /** Runs a log command. */
  function command(text, ctx) {
    const m = /^(\w*)\s*(.*)$/s.exec(text.trim()),
      word = m[1],
      rest = m[2].trim();
    if (!word || "query".startsWith(word)) {
      // Stata answers about the unnamed log, "(closed)" when there is none;
      // _all adds the named ones.
      const shown = (log) => {
        ctx.out(`      name:  ${log.name}`);
        ctx.out(`       log:  ${log.path}, ${log.on ? "on" : "off"}`);
        ctx.out(`  log type:  ${log.type}`);
      };
      if (rest && rest !== "_all") return shown(target(rest)[0]);
      const unnamed = open.get("<unnamed>");
      if (unnamed) shown(unnamed);
      else ctx.out("(closed)");
      if (rest === "_all") {
        let after = !!unnamed;
        for (const log of open.values()) {
          if (log === unnamed) continue;
          if (after) ctx.out("");
          shown(log);
          after = true;
        }
      }
      return;
    }
    if (word === "using" || word === "u") return using(rest, ctx);
    if (word === "close" || word === "c") {
      const logs = target(rest);
      if (!logs.length) {
        if (rest === "_all") return;
        throw new StataError("no log file open", 606);
      }
      const when = stamp();
      mark(ctx, { kind: "close", logs, when });
      for (const log of logs) {
        if (!log.nomsg)
          for (const line of [...fields(log, when, "closed on"), rule()])
            ctx.out(line);
        open.delete(log.name);
      }
      return;
    }
    if (word === "off" || word === "on") {
      const logs = target(rest);
      if (!logs.length) throw new StataError("no log file open", 606);
      const on = word === "on",
        changed = logs.filter((log) => log.on !== on);
      if (!changed.length) return ctx.out(`(log already ${word})`);
      const when = stamp();
      mark(ctx, { kind: word, logs: changed, when });
      for (const log of changed) {
        log.on = on;
        const lines = on
          ? [rule(), ...fields(log, when, "resumed on")]
          : [...fields(log, when, "paused on"), rule()];
        for (const line of lines) ctx.out(line);
      }
      return;
    }
    throw new StataError(`invalid syntax`, 198);
  }

  // The logs open where the lines taken so far stand, which may be
  // before the command that closed them has been reached.
  const live = new Set();
  /** Writes one line of Results into each log that is being written. */
  function put(line, skip, render) {
    for (const log of live)
      if (log.writing && !skip?.includes(log))
        add(log, `${log.type === "smcl" ? render(log, line) : line}\n`);
  }

  /** Applies what a log command did, where its lines end. */
  function apply(event) {
    if (event.kind === "open") {
      const log = event.log;
      live.add(log);
      log.writing = true;
      if (!event.quiet) {
        if (log.type === "smcl")
          add(log, smclHeader(log, "opened on", event.when));
        else
          add(
            log,
            `${[rule(), ...fields(log, event.when, "opened on")].join("\n")}\n`,
          );
      }
      return;
    }
    for (const log of event.logs) {
      if (event.kind === "close") {
        if (log.writing && !log.nomsg)
          add(
            log,
            log.type === "smcl"
              ? smclFooter(log, event.when)
              : `${[...fields(log, event.when, "closed on"), rule()].join("\n")}\n`,
          );
        else if (log.type === "smcl") add(log, "{smcl}\n{txt}{sf}{ul off}");
        log.writing = false;
        live.delete(log);
      } else if (event.kind === "off") {
        if (log.type === "smcl")
          add(
            log,
            `      {txt}name:  {res}${log.name}\n       {txt}log:  {res}${log.path}\n  {txt}log type:  {res}${log.type}\n {txt}paused on:  {res}${event.when}\n{txt}{.-}\n`,
          );
        else
          add(
            log,
            `${[...fields(log, event.when, "paused on"), rule()].join("\n")}\n`,
          );
        log.writing = false;
      } else {
        log.writing = true;
        add(
          log,
          log.type === "smcl"
            ? smclHeader(log, "resumed on", event.when)
            : `${[rule(), ...fields(log, event.when, "resumed on")].join("\n")}\n`,
        );
      }
    }
  }

  /**
   * Takes the records of a run from `from` up to `to` into the logs, line
   * by line as Results shows them, and takes the marks out of them.
   */
  function take(records, from, to) {
    for (let k = from; k < to; k++) {
      const record = records[k],
        box = { open: false },
        // The lines of a log command itself go to the other logs only:
        // its own log gets its header or closing lines from the command.
        skip = [];
      const render = (log, line, kind = "out") => {
        if (kind === "command") return `{com}. ${smclText(line)}`;
        if (kind === "echo") {
          const numbered = /^(\s*\d+)\.(.*)$/.exec(line);
          return numbered
            ? `{txt}${numbered[1]}{com}.${smclText(numbered[2])}`
            : `{com}${smclText(line)}`;
        }
        if (kind === "error")
          return /^r\(\d+\);$/.test(line)
            ? `{txt}{search ${line.slice(0, -1)}, local:${line}}`
            : `{err}${smclText(line)}`;
        return smclLine(line, box);
      };
      const lines = record.lines,
        // The lines at the end that are the record's error.
        fault = record.rc ? (record.fault ?? 2) : 0,
        plain = lines.filter((line) => !isLogMark(line)).length;
      // A blank line before each command, as Results shows one: none when
      // what came before already ended with one, as a table does, or was a
      // comment or a blank line of the do-file, which Stata echoes with no
      // blank line after it.
      for (const log of live) {
        if (log.writing && !log.tight && !/(^|\n)(\{txt\})?\n$/.test(log.text))
          add(log, log.type === "smcl" ? "{txt}\n" : "\n");
        log.tight = !!record.comment;
      }
      put(`. ${record.command}`, null, (log, line) =>
        render(log, line.slice(2), "command"),
      );
      for (const line of record.echo ?? [])
        put(line, null, (log, each) => render(log, each, "echo"));
      let shown = 0;
      for (const line of lines) {
        if (isLogMark(line)) {
          const id = line.slice(MARK.length + 1),
            event = events.get(id);
          if (!event) continue;
          if (line[MARK.length] === "b") skip.push(...(event.logs ?? []));
          else {
            events.delete(id);
            for (const log of event.logs ?? [])
              if (skip.includes(log)) skip.splice(skip.indexOf(log), 1);
            apply(event);
          }
          continue;
        }
        // A line in the error style (display as error) is {err} in SMCL.
        const marked = line.startsWith(ERROR_MARK),
          text = marked ? line.slice(ERROR_MARK.length) : line,
          kind = shown++ >= plain - fault || marked ? "error" : "out";
        put(text, skip, (log, each) => render(log, each, kind));
      }
      record.lines = lines.filter((line) => !isLogMark(line));
    }
  }

  return {
    command,
    take,
    /** The marks that end the lines of the log command just recorded. */
    ends() {
      const out = ending;
      ending = [];
      return out;
    },
    /**
     * Applies, in the order they were run, what log commands did whose
     * lines were never shown, as under run or quietly do: called once the
     * records they would have been in are all taken.
     */
    settle() {
      for (const [id, event] of [...events].sort((a, b) => a[0] - b[0])) {
        events.delete(id);
        apply(event);
      }
    },
    /** A new run. */
    start() {
      ending = [];
    },
    clear() {
      open.clear();
      live.clear();
      events.clear();
      ending = [];
    },
  };
}
