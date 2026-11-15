// log using, log close, log off, log on and log query in the Console. A log
// is a file in the session's folder, as save writes one, so that dir lists
// it and the page offers it for download; it holds what Stata's log holds:
// a header, each command after it with what it printed, and the closing
// lines. A text log is plain text; an SMCL log carries Stata's markup.
import { StataError } from "./runtime/errors.js";

const RULE = "-".repeat(79),
  MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" "),
  FOLDER = "/stataverse";

/** When, as a log's header writes it: 14 Nov 2026, 18:02:04. */
function stamp(now = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}, ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}

/** Text shown as SMCL shows it: braces written as {c -(} and {c )-}. */
const smclText = (line) =>
  line.replace(/[{}]/g, (c) => (c === "{" ? "{c -(}" : "{c )-}"));

/**
 * The logs of one session. `files` is how to read and write a file in the
 * session's folder: { has(name), text(name), write(name, text) }.
 */
export function createLogs(files) {
  const open = new Map(),
    // The logs being written, as the records of runs are taken in.
    active = new Set();
  // What a run's commands did to the logs, by the record each belongs to.
  let events = [];

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

  /** The log a close, off, on or query is about; null when none is open. */
  function target(word) {
    if (word && word !== "_all") {
      const log = open.get(word);
      if (!log) throw new StataError(`log ${word} not found`, 111);
      return [log];
    }
    if (word === "_all") return [...open.values()];
    if (open.has("<unnamed>")) return [open.get("<unnamed>")];
    return open.size === 1 ? [...open.values()] : [];
  }

  function using(rest, ctx, at) {
    const m =
      /^(?:"([^"]+)"|([^\s,]+))\s*(?:,(.*))?$/.exec(rest.trim()) ?? null;
    if (!m) throw new StataError("invalid file specification", 198);
    let file = (m[1] ?? m[2]).replace(/^.*[\\/]/, "");
    const options = { replace: false, append: false, type: "", name: "" };
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
      else if (word === "nomsg") continue;
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
    if (!/\.[A-Za-z0-9]+$/.test(file))
      file += options.type === "text" ? ".log" : ".smcl";
    const type = options.type || (/\.log$/i.test(file) ? "text" : "smcl"),
      path = `${FOLDER}/${file}`,
      exists = files.has(file);
    if (exists && !options.replace && !options.append)
      throw new StataError(`file ${path} already exists`, 602);
    if (options.replace && !exists) ctx.out(`(file ${path} not found)`);
    const log = { name, file, path, type, on: true, text: "" };
    if (options.append && exists) log.text = files.text(file);
    const when = stamp(),
      header = [RULE, ...fields(log, when, "opened on")];
    for (const line of header) ctx.out(line);
    open.set(name, log);
    // quietly log using writes no header, as Stata's does.
    const quiet = !!ctx.flags?.quiet;
    if (type === "smcl")
      log.text += quiet
        ? "{smcl}\n{txt}{sf}{ul off}"
        : `{smcl}\n${smclHeader(log, "opened on", when)}`;
    else if (!quiet) log.text += `${header.join("\n")}\n`;
    write(log);
    events.push({ at, kind: "open", log });
  }

  /** Runs a log command; `at` is the record it will be shown as. */
  function command(text, ctx, at) {
    const m = /^(\w*)\s*(.*)$/s.exec(text.trim()),
      word = m[1],
      rest = m[2].trim();
    if (!word || "query".startsWith(word)) {
      const logs = target(rest);
      if (!logs.length) return ctx.out("no log file open");
      for (const log of logs) {
        ctx.out(`      name:  ${log.name}`);
        ctx.out(`       log:  ${log.path}, ${log.on ? "on" : "off"}`);
        ctx.out(`  log type:  ${log.type}`);
      }
      return;
    }
    if (word === "using" || word === "u") return using(rest, ctx, at);
    if (word === "close" || word === "c") {
      const logs = target(rest);
      if (!logs.length) {
        if (rest === "_all") return;
        throw new StataError("no log file open", 606);
      }
      for (const log of logs) {
        const lines = [...fields(log, stamp(), "closed on"), RULE];
        for (const line of lines) ctx.out(line);
        open.delete(log.name);
        events.push({ at, kind: "close", log, lines });
      }
      return;
    }
    if (word === "off" || word === "on") {
      const logs = target(rest);
      if (!logs.length) throw new StataError("no log file open", 606);
      for (const log of logs) {
        if (log.on === (word === "on")) continue;
        log.on = word === "on";
        const when = stamp(),
          lines =
            word === "off"
              ? [...fields(log, when, "paused on"), RULE]
              : [RULE, ...fields(log, when, "resumed on")];
        for (const line of lines) ctx.out(line);
        events.push({ at, kind: word, log, lines, when });
      }
      return;
    }
    throw new StataError(`invalid syntax`, 198);
  }

  /** Writes one record of Results into each log that is open and on. */
  function record(record, logs) {
    for (const log of logs) {
      if (log.type === "smcl") {
        // As Stata writes it: a blank line before each command, the lines
        // of a loop numbered in text and their commands as commands.
        const gap = /\{txt\}\n$/.test(log.text) ? "" : "{txt}\n",
          echo = (record.echo ?? []).map((line) => {
            const numbered = /^(\s*\d+)\.(.*)$/.exec(line);
            return numbered
              ? `{txt}${numbered[1]}{com}.${smclText(numbered[2])}\n`
              : `${smclText(line)}\n`;
          }),
          lines = record.lines.map((line) =>
            line === RULE
              ? "{txt}{.-}\n"
              : line === ""
                ? "{txt}\n"
                : `{txt}${smclText(line)}\n`,
          );
        add(
          log,
          `${gap}{com}. ${smclText(record.command)}\n${echo.join("")}${lines.join("")}`,
        );
      } else {
        const gap = log.text && !log.text.endsWith("\n\n") ? "\n" : "";
        add(
          log,
          `${gap}${[`. ${record.command}`, ...(record.echo ?? []), ...record.lines].join("\n")}\n`,
        );
      }
    }
  }

  /**
   * Takes the records of a run from `from` up to `to` into the logs, with
   * what the log commands among them did: a log is written from the
   * command after its log using, and ends with its log close.
   */
  function take(records, from, to) {
    for (let k = from; k < to; k++) {
      record(
        records[k],
        [...active].filter((log) => log.writing),
      );
      for (const event of events.filter((each) => each.at === k)) {
        const log = event.log;
        if (event.kind === "open") {
          active.add(log);
          log.writing = true;
        } else if (event.kind === "close") {
          if (log.type === "smcl") add(log, "{smcl}\n{txt}{sf}{ul off}");
          active.delete(log);
        } else if (event.kind === "off") log.writing = false;
        else {
          log.writing = true;
          add(
            log,
            log.type === "smcl"
              ? smclHeader(log, "resumed on", event.when)
              : `${event.lines.join("\n")}\n`,
          );
        }
      }
    }
    events = events.filter((event) => event.at >= to);
  }

  return {
    command,
    take,
    /** A new run: what earlier runs did is done. */
    start() {
      events = [];
    },
    clear() {
      open.clear();
      active.clear();
      events = [];
    },
  };
}
