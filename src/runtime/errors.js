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
