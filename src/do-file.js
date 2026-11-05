import { StataError } from "./expression.js";
import { commandPrefixes } from "./command-prefixes.js";

/** Split executable commands while retaining their original editor locations. */
export function commandBlocks(source) {
  if (typeof source !== "string" || source.length > 50000)
    throw new StataError(
      "This do-file exceeds the 50,000-character practice limit.",
    );
  const blocks = [];
  let command = "",
    from = -1,
    to = 0,
    quote = false,
    block = false;
  let quoteAt = 0,
    blockAt = 0,
    physicalStart = 0;
  const lineAt = (position) => source.slice(0, position).split("\n").length;
  const finish = () => {
    if (command.trim())
      blocks.push({
        command: command.trim(),
        from,
        to,
        line: lineAt(from),
        endLine: lineAt(Math.max(from, to - 1)),
      });
    command = "";
    from = -1;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i],
      next = source[i + 1];
    if (c === "\n") physicalStart = i + 1;
    if (block) {
      if (c === "*" && next === "/") {
        block = false;
        i++;
        command += " ";
      } else if (c === "\n") command += " ";
      continue;
    }
    if (!quote && c === "*" && !source.slice(physicalStart, i).trim()) {
      while (i < source.length && source[i] !== "\n") i++;
      physicalStart = i + 1;
      continue;
    }
    if (!quote && c === "/" && next === "*") {
      block = true;
      blockAt = i;
      i++;
      continue;
    }
    if (!quote && c === "/" && next === "/") {
      const continuation = source[i + 2] === "/";
      while (i < source.length && source[i] !== "\n") i++;
      physicalStart = i + 1;
      if (continuation) command += " ";
      else finish();
      continue;
    }
    if (c === '"') {
      if (!quote) quoteAt = i;
      quote = !quote;
    }
    if (c === "\n" && !quote) finish();
    else {
      command += c;
      if (!/\s/.test(c)) {
        if (from < 0) from = i;
        to = i + 1;
      }
    }
  }
  if (block || quote) {
    const error = new StataError(
      block
        ? "A block comment is not closed. End it with */."
        : "A double quote is not closed.",
    );
    error.source = {
      from: block ? blockAt : quoteAt,
      to: source.length,
      line: lineAt(block ? blockAt : quoteAt),
      endLine: lineAt(source.length),
    };
    throw error;
  }
  finish();
  if (blocks.length > 200)
    throw new StataError(
      "Run at most 200 commands at a time in browser practice.",
    );
  return blocks;
}

/** Parse structural blocks without executing or expanding student text. */
export function parseProgram(source) {
  const lines = commandBlocks(source);
  let index = 0;
  const fail = (message, block) => {
    const error = new StataError(message);
    error.source = block;
    throw error;
  };
  function sequence(depth = 0, opener = null) {
    if (depth > 32) fail("The do-file exceeds 32 nested blocks.", opener);
    const nodes = [];
    while (index < lines.length) {
      const line = lines[index++],
        text = line.command;
      if (text === "}") {
        if (!opener) fail("This closing brace has no opening block.", line);
        return { nodes, close: line };
      }
      if (text.startsWith("}"))
        fail("Put a closing brace on its own line.", line);
      const { command: bodyText, prefixes } = commandPrefixes(text);
      const header = bodyText.match(
        /^(foreach|forvalues|forv|if|else)\b([\s\S]*?)\s*\{$/,
      );
      if (prefixes.length && bodyText === "{") {
        const { nodes: body, close } = sequence(depth + 1, line);
        nodes.push({
          ...line,
          type: "prefix",
          prefixes,
          body,
          to: close.to,
          endLine: close.endLine,
        });
        continue;
      }
      if (!header) {
        if (/^(foreach|forvalues|forv|else)\b/.test(bodyText))
          fail(
            "Put the opening brace at the end of the control statement, and start its commands on the next line.",
            line,
          );
        nodes.push({ ...line, type: "command" });
        continue;
      }
      const kind = header[1] === "forv" ? "forvalues" : header[1];
      const { nodes: body, close } = sequence(depth + 1, line);
      const node = {
        ...line,
        type: kind,
        prefixes,
        header: header[2].trim(),
        body,
        to: close.to,
        endLine: close.endLine,
      };
      if (kind === "else") {
        if (prefixes.length)
          fail("Put the prefix on the if block, not on else.", line);
        const previous = nodes.at(-1);
        if (node.header || previous?.type !== "if" || previous.otherwise)
          fail(
            "This else block must follow one if block and have no condition. Use a nested if for another condition.",
            line,
          );
        previous.otherwise = node.body;
        previous.to = node.to;
        previous.endLine = node.endLine;
      } else nodes.push(node);
    }
    if (opener) fail("This block has no closing brace.", opener);
    return { nodes, close: null };
  }
  return sequence().nodes;
}

/** A selection runs exactly its text; a cursor runs its whole logical command. */
export function executionRange(source, from, to = from) {
  if (from !== to)
    return {
      from,
      to,
      line: source.slice(0, from).split("\n").length,
      text: source.slice(from, to),
      selection: true,
    };
  const blocks = parseProgram(source);
  const block =
    blocks.find((b) => from >= b.from && from <= b.to) ||
    blocks.find((b) => b.from >= from);
  return block
    ? { ...block, text: source.slice(block.from, block.to), selection: false }
    : null;
}
