// Errors raised by the new runtime carry Stata's return code, so capture and
// _rc behave as they do in Stata.
export class StataError extends Error {
  constructor(message, code = 198, hint = "") {
    super(message);
    this.name = "StataError";
    this.code = code;
    this.hint = hint;
  }
}

// Control flow that is not an error: exit, continue and continue, break.
export class Signal extends Error {
  constructor(kind, code = 0) {
    super(kind);
    this.kind = kind;
    this.code = code;
  }
}

// A line Stata prints in its error style (display as error, the message of
// a command run under capture noisily), when the session is asked to say
// so (the Console sets markErrors): the line begins with this mark, which
// the Console takes out and shows the line in red.
export const ERROR_MARK = "\u0000err\u0000";
export const errorLine = (session, line) =>
  session.markErrors ? ERROR_MARK + line : line;

// The end of a line display left open with _continue: the next line a
// loop or a program prints goes on from it. The session joins such lines
// before it returns them, and takes the mark out.
export const CONTINUE_MARK = "\u0000c\u0000";
/**
 * Lines with those display left open joined to the line after them. A
 * line of the Console's own marks (a log's) passes between them, and a
 * line in the error style is not joined.
 */
export function joinContinued(lines) {
  const out = [];
  let open = -1;
  for (const line of lines) {
    if (line.startsWith("\u0000") && !line.startsWith(ERROR_MARK)) {
      out.push(line);
      continue;
    }
    if (open >= 0 && !line.startsWith(ERROR_MARK)) out[open] += line;
    else {
      out.push(line);
      open = out.length - 1;
    }
    if (out[open]?.endsWith(CONTINUE_MARK))
      out[open] = out[open].slice(0, -CONTINUE_MARK.length);
    else open = -1;
  }
  return out;
}
