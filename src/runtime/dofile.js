// Turns do-file text into commands and blocks.
//
// splitCommands removes comments, joins continued lines and honours
// #delimit. parseBlocks then groups braces and program ... end into a tree
// the session walks.

/**
 * Whether a comment line goes on to the next line, as a * comment does when
 * it ends in /// with a blank before it; a // comment earlier on the line
 * takes the /// with it, as Stata reads it.
 */
export function commentGoesOn(line, first = true) {
  const body = /^(.*?)\s\/\/\/\s*$/.exec(line)?.[1];
  if (body === undefined) return false;
  return !/(^|\s)\/\//.test(first ? body.replace(/^\s*\*/, "") : body);
}

/**
 * Logical commands with the line each one started on and the line it ended
 * on (`end`), so that the Console can echo it as typed.
 */
export function splitCommands(source) {
  // A tab is blanks to the next stop of eight columns of its line, as
  // Stata reads a do-file: in local t "a<tab>b" six blanks follow the a.
  const text = source
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) =>
        line.replace(/[^\t]*\t/g, (piece) => {
          const before = piece.length - 1;
          return piece.slice(0, -1) + " ".repeat(8 - (before % 8));
        }),
      )
      .join("\n"),
    out = [];
  let delimiter = "\n",
    current = "",
    startLine = 1,
    line = 1,
    quote = false,
    compound = 0,
    comment = 0,
    // Where the text after the last /// starts, while a command goes on.
    continuedAt = null;
  const flush = (end = line) => {
    continuedAt = null;
    // Runs of blanks are kept as typed: a string literal such as "  a" keeps
    // its blanks, and commands that echo what was typed, such as tab1's
    // heading, need them. The line breaks of a continued command become
    // single blanks.
    const command = current.replace(/\s/g, " ").trim();
    if (command && !/^\*/.test(command))
      out.push({
        text: command,
        line: startLine,
        end: Math.max(end, startLine),
        // Read under #delimit ;, which a loop's echo needs to know.
        ...(delimiter === ";" ? { semicolon: true } : {}),
      });
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
      if (continued) {
        current += " ";
        continuedAt = current.length;
      } else if (delimiter === "\n") flush(line - 1);
      else current += " ";
    } else if (c === "*" && atCommandStart() && delimiter === "\n") {
      // A line that begins with * is a comment, and one that ends in ///
      // takes the next line with it.
      let from = i,
        first = true;
      for (;;) {
        while (i < text.length && text[i] !== "\n") i++;
        if (i >= text.length || !commentGoesOn(text.slice(from, i), first))
          break;
        line++;
        from = ++i;
        first = false;
      }
      line++;
      current = "";
    } else if (c === "\n") {
      if (delimiter === "\n") flush(line - 1);
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
  // A /// on the last line continues into nothing: Stata runs nothing.
  if (continuedAt !== null && !current.slice(continuedAt).trim()) current = "";
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
    closed = 0,
    trailing = false;
  const lastLine = commands.at(-1)?.line ?? 0;
  const block = (closing) => {
    const nodes = [];
    while (at < commands.length) {
      const { text, line, end: last, semicolon } = commands[at];
      // A } that closes nothing is a command of its own, as Stata reads it,
      // and fails when it is reached; so does an end outside a program.
      if (text.startsWith("}") && closing === "}") {
        closed = line;
        // More on the line after the }: Stata runs the block, then stops.
        trailing = text !== "}";
        at++;
        return nodes;
      }
      at++;
      // capture, quietly and noisily may stand before a definition.
      const prefixed =
          /^((?:(?:cap(?:t(?:u(?:re?)?)?)?|qui(?:e(?:t(?:ly?)?)?)?|n(?:o(?:i(?:s(?:i(?:ly?)?)?)?)?)?)\s+)*)([\s\S]*)$/.exec(
            text,
          ),
        program =
          /^pr(?:o(?:g(?:r(?:am?)?)?)?)?\s+(?:de(?:f(?:i(?:ne?)?)?)?\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*(?:,\s*(.*))?$/.exec(
            prefixed[2],
          );
      if (program && !["drop", "dir", "list", "define"].includes(program[1])) {
        const body = [];
        // A program body is kept as text; macros in it expand when it runs.
        while (at < commands.length && commands[at].text !== "end")
          body.push(commands[at++]);
        // A program the file never ends is not defined: Stata reaches the
        // end of the file reading it.
        const unclosed = at >= commands.length,
          end = commands[at]?.line;
        at++;
        nodes.push({
          kind: "program",
          name: program[1],
          options: program[2] ?? "",
          body,
          line,
          end,
          text,
          ...(prefixed[1] ? { prefixes: prefixed[1].trim() } : {}),
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
        const unclosed = at >= commands.length,
          end = commands[at]?.line;
        at++;
        nodes.push({
          kind: "input",
          text,
          rows,
          rowLines,
          line,
          // The line of its end, which a do-file's echo passes over.
          ...(end ? { end } : {}),
          ...(unclosed ? { unclosed } : {}),
        });
      } else if (OPENS.test(text)) {
        const body = block("}"),
          unclosed = closed === -1,
          more = !unclosed && trailing;
        nodes.push({
          kind: "block",
          header: text.replace(OPENS, "").trim(),
          body,
          line,
          end: unclosed ? lastLine : closed,
          ...(unclosed ? { unclosed } : {}),
          ...(more ? { trailing: true } : {}),
          ...(semicolon ? { semicolon } : {}),
        });
      } else nodes.push({ kind: "command", text, line, end: last ?? line });
    }
    // A block the file never closes: Stata reads to the end of the file
    // and stops there with r(612), having run none of it.
    if (closing === "}") closed = -1;
    return nodes;
  };
  return block(null);
}
