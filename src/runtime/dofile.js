// Turns do-file text into commands and blocks.
//
// splitCommands removes comments, joins continued lines and honours
// #delimit. parseBlocks then groups braces and program ... end into a tree
// the session walks.

/** Logical commands with the line each one started on. */
export function splitCommands(source) {
  const text = source.replace(/\r\n?/g, "\n"),
    out = [];
  let delimiter = "\n",
    current = "",
    startLine = 1,
    line = 1,
    quote = false,
    compound = 0,
    comment = 0;
  const flush = () => {
    // Runs of blanks are kept as typed: a string literal such as "  a" keeps
    // its blanks, and commands that echo what was typed, such as tab1's
    // heading, need them. Tabs and the line breaks of a continued command
    // become single blanks.
    const command = current.replace(/\s/g, " ").trim();
    if (command && !/^\*/.test(command))
      out.push({ text: command, line: startLine });
    current = "";
  };
  const atCommandStart = () => current.trim() === "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    if (c === "\n") line++;
    if (comment) {
      if (c === "/" && next === "*") (comment++, i++);
      else if (c === "*" && next === "/") (comment--, i++);
      continue;
    }
    if (atCommandStart() && !/\s/.test(c)) startLine = line;
    // A compound string left open ends with its line, as in Stata, unless
    // #delimit ; joins the lines.
    if (compound && c === "\n" && delimiter === "\n") compound = 0;
    if (compound) {
      if (c === "`" && next === '"') compound++;
      else if (c === '"' && next === "'") compound--;
      current += c;
      continue;
    }
    if (quote) {
      if (c === '"' || c === "\n") quote = false;
      if (c !== "\n") {
        current += c;
        continue;
      }
    }
    if (c === "`" && next === '"') {
      compound = 1;
      current += c;
    } else if (c === '"') {
      quote = true;
      current += c;
    } else if (c === "/" && next === "*") {
      comment = 1;
      i++;
    } else if (
      c === "/" &&
      next === "/" &&
      (i === 0 || /\s/.test(text[i - 1]))
    ) {
      const continued = text[i + 2] === "/";
      while (i < text.length && text[i] !== "\n") i++;
      line++;
      if (continued) current += " ";
      else if (delimiter === "\n") flush();
      else current += " ";
    } else if (c === "*" && atCommandStart() && delimiter === "\n") {
      // A line that begins with * is a comment.
      while (i < text.length && text[i] !== "\n") i++;
      line++;
      current = "";
    } else if (c === "\n") {
      if (delimiter === "\n") flush();
      else current += " ";
    } else if (c === ";" && delimiter === ";") flush();
    else {
      current += c;
      if (/^\s*#d(e(l(i(m(it?)?)?)?)?)?\s+(;|cr)\s*$/i.test(current)) {
        delimiter = /;\s*$/.test(current) ? ";" : "\n";
        current = "";
      }
    }
  }
  // A /* comment left open comments out the rest of the file, the command
  // it began in with it; Stata ends the file there without an error.
  if (comment) return out;
  flush();
  return out;
}

const OPENS = /\{\s*$/;
/**
 * Groups commands into a tree. Nodes are { kind: "command", text, line },
 * { kind: "block", header, body, line } for a command ending in {, and
 * { kind: "program", name, options, body, line }.
 */
export function parseBlocks(commands) {
  let at = 0,
    // The line of the } that closed the block read last, -1 when the file
    // ended first.
    closed = 0;
  const lastLine = commands.at(-1)?.line ?? 0;
  const block = (closing) => {
    const nodes = [];
    while (at < commands.length) {
      const { text, line } = commands[at];
      // A } that closes nothing is a command of its own, as Stata reads it,
      // and fails when it is reached; so does an end outside a program.
      if (text === "}" && closing === "}") {
        closed = line;
        at++;
        return nodes;
      }
      at++;
      const program =
        /^pr(?:o(?:g(?:r(?:am?)?)?)?)?\s+(?:de(?:f(?:i(?:ne?)?)?)?\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*(?:,\s*(.*))?$/.exec(
          text,
        );
      if (program && !["drop", "dir", "list", "define"].includes(program[1])) {
        const body = [];
        // A program body is kept as text; macros in it expand when it runs.
        while (at < commands.length && commands[at].text !== "end")
          body.push(commands[at++]);
        // A program the file never ends is not defined: Stata reaches the
        // end of the file reading it.
        const unclosed = at >= commands.length;
        at++;
        nodes.push({
          kind: "program",
          name: program[1],
          options: program[2] ?? "",
          body,
          line,
          text,
          ...(unclosed ? { unclosed } : {}),
        });
      } else if (/^inp(?:ut?)?(\s|$)/.test(text)) {
        // The rows, and the line each starts on, so that input can echo
        // them as they were typed.
        const rows = [],
          rowLines = [];
        while (at < commands.length && commands[at].text !== "end") {
          rowLines.push(commands[at].line);
          rows.push(commands[at++].text);
        }
        const unclosed = at >= commands.length;
        at++;
        nodes.push({
          kind: "input",
          text,
          rows,
          rowLines,
          line,
          ...(unclosed ? { unclosed } : {}),
        });
      } else if (OPENS.test(text)) {
        const body = block("}"),
          unclosed = closed === -1;
        nodes.push({
          kind: "block",
          header: text.replace(OPENS, "").trim(),
          body,
          line,
          end: unclosed ? lastLine : closed,
          ...(unclosed ? { unclosed } : {}),
        });
      } else nodes.push({ kind: "command", text, line });
    }
    // A block the file never closes: Stata reads to the end of the file
    // and stops there with r(612), having run none of it.
    if (closing === "}") closed = -1;
    return nodes;
  };
  return block(null);
}
