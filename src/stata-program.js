import { StataError, compileExpression, tokenize } from "./expression.js";
import { parseProgram } from "./do-file.js";
import { historyReceipt, retainResults } from "./output-history.js";
import { RESOURCE_LIMITS } from "./resource-limits.js";

const MAX_OPERATIONS = 1000;
const MAX_TEXT = 50000;
const own = (object, key) => Object.hasOwn(object, key);
const lname = /^[A-Za-z_][A-Za-z_0-9]{0,30}$/;

/** Text substitution, never JavaScript evaluation. Each run owns its locals. */
export function expandLocals(
  source,
  locals,
  depth = 0,
  onUndefined = () => {},
) {
  if (depth > 32)
    throw new StataError(
      "Macro substitution exceeds 32 nested references.",
      901,
    );
  let text = "";
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\" && ["`", "$"].includes(source[i + 1]))
      throw new StataError(
        "Escaped macro substitution is not implemented yet. Use an ordinary local reference.",
        198,
      );
    if (source[i] === "$" && /[A-Za-z_{]/.test(source[i + 1] || ""))
      throw new StataError(
        "Global macro substitution is not implemented yet. Use a local within this do-file.",
        198,
      );
    if (source[i] !== "`" || source[i + 1] === '"') {
      text += source[i];
      continue;
    }
    let end = i + 1,
      nesting = 1;
    for (; end < source.length; end++) {
      if (source[end] === "`") nesting++;
      if (source[end] === "'" && --nesting === 0) break;
    }
    if (nesting)
      throw new StataError(
        "A local macro reference is missing its closing apostrophe.",
      );
    const name = expandLocals(
      source.slice(i + 1, end),
      locals,
      depth + 1,
      onUndefined,
    );
    if (!/^[A-Za-z_0-9]{1,31}$/.test(name))
      throw new StataError("The expanded local macro name is invalid.");
    if (!own(locals, name)) onUndefined(name);
    text += own(locals, name) ? locals[name] : "";
    if (text.length > MAX_TEXT)
      throw new StataError("Macro expansion exceeds 50,000 characters.", 901);
    i = end;
  }
  if (text.length > MAX_TEXT)
    throw new StataError("Macro expansion exceeds 50,000 characters.", 901);
  return text;
}

export function listWords(text) {
  const words = [];
  let i = 0;
  while (i < text.length) {
    while (/\s/.test(text[i] || "") && i < text.length) i++;
    if (i === text.length) break;
    let word = "",
      quote = false;
    while (i < text.length && (quote || !/\s/.test(text[i]))) {
      if (text[i] === '"') quote = !quote;
      else word += text[i];
      i++;
    }
    if (quote) throw new StataError("A quoted list item is not closed.");
    words.push(word);
  }
  return words;
}

export function forvaluesRange(text) {
  const number = "([+-]?\\d+)";
  let match = text.match(
    new RegExp(`^${number}\\s*\\(\\s*${number}\\s*\\)\\s*${number}$`),
  );
  let start, step, end;
  if (match) [, start, step, end] = match;
  else {
    match = text.match(new RegExp(`^${number}\\s*\\/\\s*${number}$`));
    if (match) {
      [, start, end] = match;
      step = 1;
    } else {
      match = text.match(
        new RegExp(`^${number}\\s+${number}\\s*(?:to|:)\\s*${number}$`),
      );
      if (!match)
        throw new StataError(
          "Use an integer range such as 1/5, 5(-1)1 or 2 4 to 10.",
        );
      [, start, step, end] = match;
      step = Number(step) - Number(start);
    }
  }
  [start, step, end] = [start, step, end].map(Number);
  if (![start, step, end].every(Number.isSafeInteger) || step === 0)
    throw new StataError(
      "Loop bounds and a nonzero increment must be safely represented integers.",
    );
  const count = Math.max(0, Math.floor((end - start) / step) + 1);
  if (count > MAX_OPERATIONS)
    throw new StataError(
      "This loop exceeds 1,000 iterations. Reduce its range.",
      901,
    );
  return Array.from({ length: count }, (_, i) => String(start + i * step));
}

function expression(text, session) {
  const fn = compileExpression(text, session.data.columns);
  if (
    !session.data.rows.length &&
    tokenize(text).some(
      (token) =>
        token.type === "name" &&
        session.data.columns.some((column) => column.name === token.value),
    )
  )
    throw new StataError(
      "There are no observations for evaluating a data variable in this control statement. Test _N first or restore the sample.",
      2000,
    );
  const value = fn(session.data.rows[0] || {}, 0, session.data.rows.length);
  return value === undefined ? (fn.valueType === "string" ? "" : null) : value;
}

function literalContents(text) {
  if (text.startsWith('`"') || text.includes("\"'"))
    throw new StataError(
      "Compound macro quotes are not implemented yet. Use ordinary double quotes.",
    );
  if (text.startsWith('"')) {
    if (!text.endsWith('"'))
      throw new StataError("A macro definition's quote is not closed.");
    return text.slice(1, -1);
  }
  return text;
}

/** Interpret control flow around the existing command engine. */
function* programSteps(
  source,
  session,
  resolveVariables,
  { onProgress = () => {} } = {},
) {
  const program = parseProgram(source),
    locals = Object.create(null);
  let results = [],
    receipts = [];
  const startingCommands = session.history.length;
  const append = (result) => {
    results = retainResults([...results, result]);
    receipts = retainResults([...receipts, historyReceipt(result)], {
      entries: 500,
      cells: Infinity,
      bytes: RESOURCE_LIMITS.timelineBytes,
    });
    onProgress({ commands: session.history.length - startingCommands });
  };
  let operations = 0,
    current = null,
    currentCommand = "";
  const undefinedLocals = new Set();
  const expand = (text) =>
    expandLocals(text, locals, 0, (name) => undefinedLocals.add(name));
  const tick = () => {
    if (++operations > MAX_OPERATIONS)
      throw new StataError(
        "This run reached the 1,000-operation limit. Reduce the loop range or run a smaller section.",
        901,
      );
  };
  function* execute(nodes) {
    for (const node of nodes) {
      current = node;
      currentCommand = node.command;
      undefinedLocals.clear();
      tick();
      if (node.type === "command") {
        const command = expand(node.command);
        currentCommand = command;
        const local = command.match(
          /^(?:local|loc)\s+([A-Za-z_][A-Za-z_0-9]{0,30})(?=\s|=|$)([\s\S]*)$/,
        );
        if (local) {
          const name = local[1],
            definition = local[2].trim();
          if (definition.startsWith(":"))
            throw new StataError(
              "Extended macro functions are not implemented yet.",
              133,
            );
          const value = definition.startsWith("=")
            ? expression(definition.slice(1), session)
            : literalContents(definition);
          locals[name] = value === null ? "." : String(value);
          if (
            Object.values(locals).reduce((n, value) => n + value.length, 0) >
            MAX_TEXT
          )
            throw new StataError(
              "Local macro contents exceed 50,000 characters.",
              901,
            );
          append({
            kind: "macro",
            command: node.command,
            message: `Local ${name} defined for this run.`,
            source: {
              from: node.from,
              to: node.to,
              line: node.line,
              endLine: node.endLine,
            },
          });
        } else {
          const result = session.execute(command);
          result.source = {
            from: node.from,
            to: node.to,
            line: node.line,
            endLine: node.endLine,
          };
          if (command !== node.command) result.originalCommand = node.command;
          append(result);
        }
      } else if (node.type === "if") {
        const value = expression(expand(node.header), session);
        if (typeof value === "string")
          throw new StataError(
            "The if command requires a numeric condition.",
            109,
          );
        yield* execute(
          value === null || Boolean(value) ? node.body : node.otherwise || [],
        );
      } else {
        const header = expand(node.header);
        const match =
          node.type === "forvalues"
            ? header.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/)
            : header.match(
                /^([A-Za-z_]\w*)\s+(in|of\s+(?:local|varlist))\s*([\s\S]*)$/,
              );
        if (!match || !lname.test(match[1]))
          throw new StataError(`Invalid ${node.type} header.`);
        const name = match[1];
        let items;
        if (node.type === "forvalues") items = forvaluesRange(match[2]);
        else if (match[2] === "in") items = listWords(match[3]);
        else if (/local$/.test(match[2])) {
          const reference = match[3].trim();
          if (!lname.test(reference))
            throw new StataError(
              "foreach of local requires one local macro name.",
            );
          items = listWords(own(locals, reference) ? locals[reference] : "");
        } else items = resolveVariables(match[3], session.data);
        try {
          for (const item of items) {
            current = node;
            currentCommand = node.command;
            tick();
            locals[name] = item;
            yield* execute(node.body);
            yield;
          }
        } finally {
          // Stata removes the loop macro, including a pre-existing value.
          delete locals[name];
        }
      }
      yield;
    }
  }
  try {
    yield* execute(program);
  } catch (error) {
    append({
      kind: "error",
      command: currentCommand,
      ...(current && current.command !== currentCommand
        ? { originalCommand: current.command }
        : {}),
      source: current
        ? {
            from: current.from,
            to: current.to,
            line: current.line,
            endLine: current.endLine,
          }
        : undefined,
      message: error.message,
      code: error.code || 498,
      hint: undefinedLocals.size
        ? `Undefined local${undefinedLocals.size > 1 ? "s" : ""}: ${[...undefinedLocals].join(", ")}. Undefined locals substitute empty text. Run each definition together with its uses; locals expire after each Run action.`
        : error.hint || "Check the command and data, then try again.",
      ...(error.evidence ? { evidence: error.evidence } : {}),
    });
  }
  if (!results.length && program.length) {
    const first = program[0];
    append({
      kind: "control",
      command: first.command,
      message:
        "No data commands ran. The selected conditions or loop ranges produced no iterations.",
      source: {
        from: first.from,
        to: first.to,
        line: first.line,
        endLine: first.endLine,
      },
    });
  }
  // Keep lightweight command history even when earlier full output is released.
  Object.defineProperty(results, "receipts", { value: receipts });
  return results;
}

export function runProgram(...args) {
  const steps = programSteps(...args);
  let next;
  do next = steps.next();
  while (!next.done);
  return next.value;
}

/** Same interpreter, yielding between operations when a Worker is unavailable. */
export async function runProgramAsync(
  source,
  session,
  resolveVariables,
  { signal, ...options } = {},
) {
  const steps = programSteps(source, session, resolveVariables, options);
  let checkpoint = performance.now();
  try {
    // Give the page a chance to paint and receive Stop before any command runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (;;) {
      signal?.throwIfAborted();
      const next = steps.next();
      if (next.done) return next.value;
      if (performance.now() - checkpoint >= 8) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        checkpoint = performance.now();
      }
    }
  } finally {
    steps.return();
  }
}
