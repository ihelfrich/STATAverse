// How Stata echoes a block it runs from a do-file: a loop is echoed once, its
// first line after the prompt and the lines of its body numbered, before
// what the loop printed. These are the lines of that echo, built from the
// do-file's own text so that comments and continuation lines appear as typed.
import { displayWidth } from "./values.js";

/**
 * A line wider than the linesize as Stata prints it: cut where the next
 * character would pass the linesize, the rest on lines that begin "> ".
 */
export function wrapCharacters(line, linesize) {
  if (displayWidth(line) <= linesize) return [line];
  const lines = [];
  let current = "",
    used = 0;
  for (const character of line) {
    const width = displayWidth(character);
    if (used + width > linesize && used > 2) {
      lines.push(current);
      current = "> ";
      used = 2;
    }
    current += character;
    used += width;
  }
  lines.push(current);
  return lines;
}

/**
 * The lines that show a record's command, as Results and the log show them
 * at a linesize: the command after the prompt, then its echo, each line
 * cut at the linesize.
 */
export function commandLines(record, linesize = 79) {
  const lines = wrapCharacters(`. ${record.command}`.trimEnd(), linesize);
  for (const line of record.echo ?? [])
    lines.push(...wrapCharacters(line, linesize));
  return lines;
}

import { commentGoesOn } from "./dofile.js";

export const expandTabs = (line) =>
  line.replace(/[^\t]*\t/g, (piece) => {
    const before = piece.length - 1;
    return piece.slice(0, -1) + " ".repeat(8 - (before % 8));
  });

/**
 * What one physical line holds once comments are taken out, and whether the
 * command goes on to the next line (/// or an open block comment).
 */
function scan(line, state) {
  // A * comment that ended in /// goes on through this line.
  if (state.star) {
    state.star = commentGoesOn(line, false);
    return { code: "", continues: state.star };
  }
  let code = "",
    quote = false;
  // The line after a * comment that ended in /// is comment as well.
  if (state.star) {
    state.star = /\s\/\/\/\s*$/.test(line);
    return { code: "", continues: state.star };
  }
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
    else if (c === "*" && !state.started && !code.trim()) {
      state.star = commentGoesOn(line);
      return { code: "", continues: state.star };
    } else code += c;
  }
  return { code, continues: state.comment > 0 };
}

/**
 * The lines Stata echoes for a loop, from its source lines; a program's
 * lines are numbered from 1 (`first`), a loop's from 2.
 */
export function echoOf(lines, start, end, first = 2) {
  const state = { comment: 0, started: false },
    echo = [];
  let command = "",
    number = first,
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

const DELIMIT = /^\s*#d(?:e(?:l(?:i(?:m(?:it?)?)?)?)?)?\s+(;|cr)\s*$/i;

/**
 * How Stata's log shows a do-file read line by line: every line is echoed
 * after the prompt as typed (tabs expanded), a comment or a blank line as
 * a line of its own, and the lines a command continues onto (after ///,
 * inside a comment, or before the ; that ends it under #delimit ;) after
 * "> ". `before(line)` gives the records of the lines not yet echoed that
 * come before a command's first line; `command(line)` the echo of the
 * command that starts there; `skip(end)` passes over a block's lines,
 * which the block echoes itself.
 */
export function fileEcho(lines) {
  let cursor = 1,
    // Under #delimit ;, where on the cursor's line the next command starts
    // when one has ended there with more after its ;.
    column = 0,
    delimiter = "\n";
  const shown = (at) => expandTabs(lines[at - 1] ?? "").replace(/\s+$/, "");
  // The line break that ends the file starts no line of its own.
  const last = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  // The ; that ends a command on a line, outside quotes, when more follows
  // it there (another command, or a comment, which Stata echoes with the
  // next command): its column, or -1.
  const endsBefore = (text) => {
    let quote = false;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quote = !quote;
      else if (text[i] === ";" && !quote)
        return text.slice(i + 1).trim() ? i : -1;
    }
    return -1;
  };
  const group = (at, from = 0) => {
    const state = { comment: 0, started: false, star: false },
      echo = [];
    let code = "",
      next = at,
      after = 0;
    const text = (k) => (k === at ? shown(k).slice(from) : shown(k));
    for (; next <= last; next++) {
      const line = text(next),
        stop = delimiter === ";" ? endsBefore(line) : -1;
      if (stop >= 0) {
        // Two commands on one line under #delimit ;: this one ends at its
        // ;, and the next is echoed from there.
        if (next > at) echo.push(`> ${line.slice(0, stop + 1)}`);
        code += line.slice(0, stop + 1);
        after = (next === at ? from : 0) + stop + 1;
        break;
      }
      if (next > at) echo.push(`> ${line}`);
      state.started = next > at;
      const found = scan(
        next === at
          ? expandTabs(lines[next - 1] ?? "").slice(from)
          : lines[next - 1],
        state,
      );
      code += found.code;
      if (next === at && DELIMIT.test(found.code)) {
        next++;
        break;
      }
      if (delimiter === ";") {
        // A blank line before any command is a line of its own, but not
        // the rest of a line after a command's ;.
        if (!code.trim() && !found.continues && !state.comment && !from) {
          next++;
          break;
        }
        if (code.replace(/"[^"]*"/g, "").includes(";")) {
          next++;
          break;
        }
      } else if (!found.continues) {
        next++;
        break;
      }
    }
    const first = text(at);
    return {
      command:
        after && next === at ? first.slice(0, after - from).trimEnd() : first,
      echo,
      next: after ? next : Math.max(next, at + 1),
      after,
      code,
    };
  };
  return {
    before(line) {
      const records = [];
      if (column) {
        // The rest of a line after a command's ;, with no command after
        // it there: Stata echoes it, and the lines up to the next code,
        // under one prompt; a #delimit there ends that echo, and so does
        // the end of the file.
        const state = { comment: 0, started: false, star: false },
          rest = shown(cursor).slice(column),
          code = scan(rest, state).code.trim();
        let found = code ? cursor : cursor + 1;
        for (; found <= last; found++) {
          state.started = true;
          if (scan(lines[found - 1] ?? "", state).code.trim()) break;
        }
        const delimit =
          !code && found <= last && found < line
            ? DELIMIT.exec(lines[found - 1] ?? "")
            : null;
        if (!code && (delimit || found > last)) {
          const record = {
            command: rest.trimEnd(),
            echo: [],
            lines: [],
            rc: 0,
            comment: true,
          };
          if (delimit) {
            for (let k = cursor + 1; k <= found; k++)
              record.echo.push(`> ${shown(k)}`);
            delimiter = delimit[1] === ";" ? ";" : "\n";
            record.lines = [`delimiter now ${delimit[1].toLowerCase()}`];
            cursor = found + 1;
          } else cursor += 1;
          column = 0;
          records.push(record);
        }
      }
      while (cursor < line && cursor <= lines.length && !column) {
        const { command, echo, next, after, code } = group(cursor, column),
          record = { command, echo, lines: [], rc: 0, comment: true },
          delimit = DELIMIT.exec(code);
        if (delimit) {
          delimiter = delimit[1] === ";" ? ";" : "\n";
          record.lines = [`delimiter now ${delimit[1].toLowerCase()}`];
        }
        records.push(record);
        cursor = next;
        column = after;
      }
      return records;
    },
    command(line) {
      if (line < cursor) return null;
      // A command that starts after another's ; is echoed from there.
      const { command, echo, next, after } = column
        ? group(cursor, column)
        : group(line);
      cursor = next;
      column = after;
      return { command, echo };
    },
    skip(end) {
      if (end + 1 > cursor) column = 0;
      cursor = Math.max(cursor, end + 1);
    },
  };
}
