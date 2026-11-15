// How Stata echoes a block it runs from a do-file: a loop is echoed once, its
// first line after the prompt and the lines of its body numbered, before
// what the loop printed. These are the lines of that echo, built from the
// do-file's own text so that comments and continuation lines appear as typed.

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
 * What Stata echoes for the lines of a do-file between the commands it
 * runs, from `from` to `to`: each blank line as a bare prompt, each comment
 * as typed (a block comment or a * comment ending in /// with its further
 * lines after >), and #delimit with what it says. Each is { command, echo,
 * lines }, with no blank line after it, as Stata's log has none.
 */
export function gapEchoes(lines, from, to) {
  const state = { comment: 0, started: false },
    units = [];
  let continued = false;
  for (let at = from; at <= to; at++) {
    const raw = lines[at - 1] ?? "",
      text = expandTabs(raw).replace(/\s+$/, "");
    if (continued) units.at(-1).echo.push(`> ${text}`);
    else {
      const delimit = DELIMIT.exec(raw);
      units.push({
        command: text,
        echo: [],
        lines: delimit
          ? [`delimiter now ${delimit[1] === ";" ? ";" : "cr"}`]
          : [],
      });
    }
    state.started = false;
    continued = !!scan(raw, state).continues;
  }
  return units;
}
