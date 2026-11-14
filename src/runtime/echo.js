// How Stata echoes a block it runs from a do-file: a loop is echoed once, its
// first line after the prompt and the lines of its body numbered, before
// what the loop printed. These are the lines of that echo, built from the
// do-file's own text so that comments and continuation lines appear as typed.

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
export function echoOf(lines, start, end) {
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
