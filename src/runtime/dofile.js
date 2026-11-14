// Turns do-file text into commands and blocks.
//
// splitCommands removes comments, joins continued lines and honours
// #delimit. parseBlocks then groups braces and program ... end into a tree
// the session walks.
import { StataError } from "./errors.js";

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
  if (comment) throw new StataError("a /* comment is not closed", 198);
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
    // The line of the } that closed the block read last.
    closed = 0;
  const block = (closing) => {
    const nodes = [];
    while (at < commands.length) {
      const { text, line } = commands[at];
      if (text === "}") {
        if (closing !== "}")
          throw new StataError("} without a matching {", 198);
        closed = line;
        at++;
        return nodes;
      }
      if (/^end$/.test(text)) {
        if (closing !== "end") throw new StataError("end without program", 198);
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
        if (at >= commands.length)
          throw new StataError(`program ${program[1]} has no end`, 198);
        at++;
        nodes.push({
          kind: "program",
          name: program[1],
          options: program[2] ?? "",
          body,
          line,
        });
      } else if (/^inp(?:ut?)?(\s|$)/.test(text)) {
        const rows = [];
        while (at < commands.length && commands[at].text !== "end")
          rows.push(commands[at++].text);
        if (at >= commands.length)
          throw new StataError("input has no end", 198);
        at++;
        nodes.push({ kind: "input", text, rows, line });
      } else if (OPENS.test(text)) {
        const body = block("}");
        nodes.push({
          kind: "block",
          header: text.replace(OPENS, "").trim(),
          body,
          line,
          end: closed,
        });
      } else nodes.push({ kind: "command", text, line });
    }
    if (closing === "}") throw new StataError("{ without a matching }", 198);
    return nodes;
  };
  return block(null);
}
