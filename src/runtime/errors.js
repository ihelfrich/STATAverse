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
