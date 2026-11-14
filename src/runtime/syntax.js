// The command grammar. A command declares what it accepts in the notation of
// Stata's own syntax command, for example
//
//   varlist [if] [in] [, Detail MEANonly SEParator(integer 5)]
//
// and applySyntax checks a command line against that declaration, rejecting
// anything outside it before the command runs. It returns the locals Stata's
// syntax would set, so user programs can call the same code, plus the same
// information in structured form for the runtime's own commands.
import { StataError } from "./errors.js";
import { expandVarlist } from "./varlist.js";
import { parseNumlist } from "./numlist.js";
import {
  formatNumber,
  isName,
  isNumericType,
  isReserved,
  isStringType,
  isType,
} from "./values.js";

const POSITIONAL =
  /^(varlist|varname|newvarlist|newvarname|namelist|name|anything)(?:\((.*)\))?$/;
const WEIGHTS = { fw: "fweight", aw: "aweight", pw: "pweight", iw: "iweight" };
// What a user may type inside [ ] for each weight, with its shortest form.
const WEIGHT_WORDS = [
  ["fweight", 2, "fweight"],
  ["frequency", 4, "fweight"],
  ["aweight", 2, "aweight"],
  ["cellsize", 4, "aweight"],
  ["pweight", 2, "pweight"],
  ["iweight", 2, "iweight"],
  ["weight", 1, null],
];
const OPTION_KINDS = new Set([
  "integer",
  "real",
  "string",
  "name",
  "namelist",
  "varlist",
  "varname",
  "numlist",
  "passthru",
  "cilevel",
]);

// Calls visit(i, character, top) for every character; top is true when the
// character is outside quotes ("..." and `"..."') and outside ( ) and [ ].
// The brackets themselves are not top-level.
function scan(text, visit) {
  let depth = 0,
    quote = false,
    compound = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i],
      next = text[i + 1];
    let top = false;
    if (compound) {
      if (c === "`" && next === '"') compound++;
      else if (c === '"' && next === "'") {
        compound--;
        if (visit(i, c, false) === false) return;
        i++;
        if (visit(i, next, false) === false) return;
        continue;
      }
    } else if (quote) {
      if (c === '"') quote = false;
    } else if (c === "`" && next === '"') compound = 1;
    else if (c === '"') quote = true;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else top = depth === 0;
    if (visit(i, c, top) === false) return;
  }
  if (quote || compound) throw new StataError("too few quotes", 132);
}

// Splits on blanks that are outside quotes and parentheses.
function words(text) {
  const out = [];
  let start = -1;
  scan(text, (i, c, top) => {
    if (top && /\s/.test(c)) {
      if (start >= 0) out.push(text.slice(start, i));
      start = -1;
    } else if (start < 0) start = i;
  });
  if (start >= 0) out.push(text.slice(start));
  return out;
}

function unquote(text) {
  const t = text.trim();
  if (t.startsWith('`"') && t.endsWith("\"'")) return t.slice(2, -2);
  if (
    t.length >= 2 &&
    t.startsWith('"') &&
    t.endsWith('"') &&
    !t.slice(1, -1).includes('"')
  )
    return t.slice(1, -1);
  return null;
}

export function parseDeclaration(declaration) {
  const parsed = {
    positional: null,
    if: null,
    in: null,
    using: null,
    exp: null,
    weights: [],
    options: [],
    star: false,
    hasOptions: false,
  };
  // Elements are separated by blanks; [ and ] mark what is optional.
  const elements = [];
  let optional = 0,
    inOptions = false,
    current = "",
    depth = 0,
    quoted = false;
  const push = () => {
    if (current)
      elements.push({ text: current, optional: optional > 0, inOptions });
    current = "";
  };
  for (const c of declaration) {
    if (quoted) {
      current += c;
      if (c === '"') quoted = false;
    } else if (c === '"') {
      current += c;
      quoted = true;
    } else if (depth > 0) {
      current += c;
      if (c === "(") depth++;
      else if (c === ")") depth--;
    } else if (c === "(") {
      current += c;
      depth++;
    } else if (c === "[") {
      push();
      optional++;
    } else if (c === "]") {
      push();
      optional--;
    } else if (c === ",") {
      push();
      inOptions = true;
      parsed.hasOptions = true;
    } else if (/\s/.test(c)) push();
    else current += c;
  }
  push();
  let unavailable = false;
  for (const element of elements) {
    const { text } = element;
    let m;
    if (element.inOptions) {
      // Options after a bar are ones Stata has and this runtime does not
      // act on yet. Naming one is refused, so it is never silently ignored.
      if (text === "|") {
        unavailable = true;
        continue;
      }
      if (text === "*") {
        parsed.star = true;
        continue;
      }
      m = /^([A-Za-z_][A-Za-z_0-9]*)(?:\((.*)\))?$/.exec(text);
      if (!m)
        throw new Error("Unreadable option in syntax declaration: " + text);
      const off = /^no[A-Z]/.test(m[1]),
        word = off ? m[1].slice(2) : m[1],
        capitals = /^[A-Z_0-9]*/.exec(word)[0].length,
        [kind = "flag", ...rest] = (m[2] ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      if (m[2] !== undefined && !OPTION_KINDS.has(kind))
        throw new Error(
          "Unsupported option type in syntax declaration: " + text,
        );
      parsed.options.push({
        name: word.toLowerCase(),
        // No capital letters means the whole word must be typed.
        minimum: capitals || word.length,
        kind: off
          ? "off"
          : kind === "string" && rest[0] === "asis"
            ? "asis"
            : kind,
        default: kind === "integer" || kind === "real" ? rest[0] : undefined,
        required: !element.optional && !unavailable,
        unavailable,
      });
    } else if ((m = POSITIONAL.exec(text))) {
      const specs = {};
      for (const part of (m[2] ?? "").match(/\w+=(?:"[^"]*"|\S+)|\w+/g) ?? []) {
        const [key, value] = part.split(/=(.*)/s);
        specs[key] = value === undefined ? true : value.replace(/^"|"$/g, "");
      }
      parsed.positional = { kind: m[1], optional: element.optional, specs };
    } else if ((m = /^(if|in|using)(\/?)$/.exec(text)))
      parsed[m[1]] = { optional: element.optional, bare: !!m[2] };
    else if ((m = /^=(\/?)exp$/.exec(text)))
      parsed.exp = { optional: element.optional, bare: !!m[1] };
    else if (WEIGHTS[text] || Object.values(WEIGHTS).includes(text))
      parsed.weights.push(WEIGHTS[text] ?? text);
    else throw new Error("Unreadable element in syntax declaration: " + text);
  }
  return parsed;
}

const notAllowed = (what) => new StataError(`${what} not allowed`, 101);

/**
 * Where a single = (not part of ==, !=, ~=, <= or >=) stands in an
 * expression, outside quotes: { at, open, close }, open and close the
 * indices of the brackets around it (-1 when it is at the top), or null
 * when there is none.
 */
export function loneEquals(text) {
  const opens = [];
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quote = !quote;
    if (quote) continue;
    if (c === "(" || c === "[") opens.push(i);
    else if (c === ")" || c === "]") opens.pop();
    else if (
      c === "=" &&
      !/[=!~<>]/.test(text[i - 1] ?? "") &&
      text[i + 1] !== "="
    ) {
      const open = opens.at(-1) ?? -1;
      let close = -1;
      for (let j = i, depth = 0; open >= 0 && j < text.length; j++)
        if (text[j] === "(" || text[j] === "[") depth++;
        else if ((text[j] === ")" || text[j] === "]") && --depth < 0) {
          close = j;
          break;
        }
      return { at: i, open, close };
    }
  }
  return null;
}

// Finds where each clause of the part before the comma begins.
export function clauses(head, expAllowed = true) {
  const found = [];
  // A weight is a top-level [ ... ] that follows a blank; x[_n-1] is not one.
  let depth = 0;
  const flags = [];
  scan(head, (i, c, top) => {
    flags[i] = top;
  });
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === "[" && !flags[i]) {
      // flags is false for brackets; find those opened at the top level.
      const opensAtTop = depthBefore(head, flags, i) === 0;
      if (opensAtTop && (i === 0 || /\s/.test(head[i - 1])))
        found.push({ kind: "weight", at: i, after: i });
    }
  }
  // A file may be called using.dta: using followed by a period is a name.
  const word =
    /(?<![\w\u0080-\u{10FFFF}.])(if|in|using(?!\.))(?![\w\u0080-\u{10FFFF}])/gu;
  for (let m; (m = word.exec(head));)
    if (flags[m.index])
      found.push({ kind: m[1], at: m.index, after: m.index + m[1].length });
  found.sort((a, b) => a.at - b.at);
  // =exp can only come before every other clause.
  const limit = found[0]?.at ?? head.length;
  for (let i = 0; i < limit; i++)
    if (
      flags[i] &&
      head[i] === "=" &&
      !/[=!~<>]/.test(head[i - 1] ?? "") &&
      // Where no =exp is declared, == belongs to an expression.
      (expAllowed || head[i + 1] !== "=")
    ) {
      found.unshift({ kind: "exp", at: i, after: i + 1 });
      break;
    }
  return found.map((clause, k) => ({
    ...clause,
    text: head.slice(clause.after, found[k + 1]?.at ?? head.length).trim(),
  }));
}
// Bracket depth just before position i, ignoring quoted text.
function depthBefore(head, flags, i) {
  let depth = 0,
    quoted = false;
  for (let k = 0; k < i; k++) {
    const c = head[k];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
  }
  return quoted ? 1 : depth;
}

export function splitAtComma(text) {
  let comma = -1;
  scan(text, (i, c, top) => {
    if (top && c === ",") {
      comma = i;
      return false;
    }
  });
  return comma < 0
    ? [text, null]
    : [text.slice(0, comma), text.slice(comma + 1)];
}

function range(text, n) {
  const m = /^(-?\d+|[fFlL])(?:\/(-?\d+|[fFlL]))?$/.exec(
    text.replace(/\s+/g, ""),
  );
  if (!m) throw new StataError("invalid syntax", 198);
  const bound = (word) => {
    if (/^[fF]$/.test(word)) return 1;
    if (/^[lL]$/.test(word)) return n;
    const k = Number(word);
    return k < 0 ? n + 1 + k : k;
  };
  // Zero, or a count from the end that runs past the first observation,
  // is no observation number at all.
  for (const word of [m[1], m[2]])
    if (word !== undefined && /\d/.test(word) && bound(word) < 1)
      throw new StataError(`'${word}' invalid observation number`, 198);
  const first = bound(m[1]),
    last = bound(m[2] ?? m[1]);
  if (!(first >= 1 && first <= last && last <= n))
    throw new StataError("observation numbers out of range", 198);
  return [first, last];
}

function weightType(word, allowed) {
  for (const [full, minimum, type] of WEIGHT_WORDS)
    if (word.length >= minimum && full.startsWith(word)) {
      const resolved = type ?? allowed[0];
      if (!allowed.includes(resolved)) throw notAllowed(`${resolved}s`);
      return resolved;
    }
  throw new StataError("invalid syntax", 198);
}

function checkCount(count, specs, kind) {
  const single = kind === "varname" || kind === "newvarname" || kind === "name",
    maximum = single
      ? 1
      : specs.max === undefined
        ? Infinity
        : Number(specs.max),
    minimum = specs.min === undefined ? 1 : Number(specs.min);
  if (count > maximum)
    throw new StataError("too many variables specified", 103);
  if (count < minimum) throw new StataError("too few variables specified", 102);
}

function newVariables(text, context) {
  const names = [],
    types = [],
    typed = [],
    labels = [],
    tokens = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    let type = context.defaultType ?? "float",
      token = tokens[i];
    typed.push(isType(token) || token === "str");
    if (isType(token) || token === "str") {
      type = token;
      token = tokens[++i];
      if (token === undefined)
        throw new StataError("too few variables specified", 102);
    }
    // name:label attaches a value label, which generate handles itself.
    const name = token.split(":")[0];
    if (name === "_all") throw notAllowed("_all");
    if (!isName(name) || isReserved(name))
      throw new StataError(`${name} invalid name`, 198);
    if (context.names.includes(name))
      throw new StataError(`variable ${name} already defined`, 110);
    names.push(name);
    types.push(type);
    labels.push(token.split(":")[1] ?? "");
  }
  return { names, types, typed, labels };
}

function existingVariables(text, specs, context) {
  const names = expandVarlist(text, context.names);
  for (const name of names) {
    const type = context.types?.[name];
    if (!type) continue;
    // syntax's own words for a string variable where numbers are wanted.
    if (specs.numeric && isStringType(type))
      throw new StataError(
        `string variables not allowed in varlist;\n${name} is a string variable`,
        109,
      );
    if (specs.string && isNumericType(type))
      throw new StataError("type mismatch", 109);
  }
  return names;
}

function nameList(text) {
  const names = text.split(/\s+/).filter(Boolean);
  for (const name of names)
    if (!isName(name)) throw new StataError(`${name} invalid name`, 198);
  return names;
}

// Splits the text after the comma into name and name(argument) items.
export function optionItems(text) {
  // Each further comma turns the options off and on again: a word after an
  // odd number of them is invalid (Stata's message ends in a blank), and
  // the words after an even number are options, so ", detail," and
  // ",,, detail" are both detail.
  const kept = [];
  for (let k = 0, rest = text; rest !== null; k++) {
    const [piece, after] = splitAtComma(rest);
    if (k % 2 === 0) kept.push(piece);
    else if (piece.trim())
      throw new StataError(`invalid '${piece.trim().split(/\s+/)[0]}' `, 198);
    rest = after;
  }
  text = kept.join(" ");
  // Stata allows a blank between an option's name and its parenthesis.
  const joined = [];
  for (const word of words(text))
    if (
      word.startsWith("(") &&
      /^[A-Za-z_][A-Za-z_0-9]*$/.test(joined.at(-1) ?? "")
    )
      joined[joined.length - 1] += word;
    else joined.push(word);
  return joined.map((word) => {
    const m = /^([A-Za-z_][A-Za-z_0-9]*)(?:\(([\s\S]*)\))?$/.exec(word);
    // A parenthesis left open, as by(region, wants its close.
    if (!m && /^[A-Za-z_]\w*\(/.test(word) && !/\)$/.test(word))
      throw new StataError(") required", 100);
    // A close with no open is an option of its own.
    if (!m && /^[A-Za-z_]\w*\)/.test(word))
      throw new StataError("option ) not allowed", 198);
    if (!m) throw new StataError(`option ${word} not allowed`, 198);
    return { word, name: m[1], argument: m[2] };
  });
}

function matchOption(name, declared) {
  for (const option of declared) {
    const full = option.kind === "off" ? "no" + option.name : option.name,
      minimum = option.kind === "off" ? option.minimum + 2 : option.minimum;
    if (name.length >= minimum && full.startsWith(name))
      return { option, on: true };
    // noCONStant also accepts constant, and Detail also accepts nodetail;
    // each asks for the default.
    const opposite = option.kind === "off" ? name : name.slice(2);
    if (
      (option.kind === "off" ||
        (option.kind === "flag" && name.startsWith("no"))) &&
      opposite.length >= option.minimum &&
      option.name.startsWith(opposite)
    )
      return { option, on: false };
  }
  return null;
}

function optionValue(option, argument, context) {
  const invalid = () =>
    new StataError(`option ${option.name}() incorrectly specified`, 198);
  const text = argument.trim();
  switch (option.kind) {
    case "integer":
      if (!/^[+-]?\d+$/.test(text)) throw invalid();
      return { local: String(Number(text)), value: Number(text) };
    case "real":
    case "cilevel": {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text))
        throw invalid();
      const value = Number(text);
      if (option.kind === "cilevel" && !(value >= 10 && value <= 99.99))
        throw new StataError(
          `${option.name}() must be between 10 and 99.99 inclusive`,
          198,
        );
      return { local: formatNumber(value), value };
    }
    case "asis":
      return { local: text, value: text };
    case "string": {
      const inner = unquote(text),
        value = inner ?? words(text).join(" ");
      return { local: value, value };
    }
    case "name":
    case "namelist": {
      const names = nameList(text);
      if (!names.length) throw invalid();
      if (option.kind === "name" && names.length > 1)
        throw new StataError("too many names specified", 103);
      return {
        local: names.join(" "),
        value: option.kind === "name" ? names[0] : names,
      };
    }
    case "varlist":
    case "varname": {
      const names = expandVarlist(text, context.names);
      if (!names.length) throw invalid();
      if (option.kind === "varname" && names.length > 1)
        throw new StataError("too many variables specified", 103);
      return {
        local: names.join(" "),
        value: option.kind === "varname" ? names[0] : names,
      };
    }
    case "numlist": {
      const numbers = parseNumlist(text);
      if (!numbers.length) throw invalid();
      return { local: numbers.map(formatNumber).join(" "), value: numbers };
    }
    case "passthru":
      return { local: `${option.name}(${text})`, value: text };
  }
  throw invalid();
}

/**
 * Checks the text after a command name against a declaration.
 *
 * context: names (variables in order), types (name to storage type),
 * n (observations), level (default confidence level), defaultType, and
 * optionally expression(text, clause), which is called with each if and =exp
 * so that the caller can compile it and raise its own errors.
 *
 * Returns { locals, varlist, names, anything, types, if, in, exp, weight,
 * using, options }.
 */
export function applySyntax(declaration, text, context) {
  const decl =
      typeof declaration === "string"
        ? parseDeclaration(declaration)
        : declaration,
    locals = {},
    result = { locals, options: {} },
    [head, optionText] = splitAtComma(text),
    found = clauses(head, !!decl.exp),
    leading = head.slice(0, found[0]?.at ?? head.length).trim();

  for (const kind of ["exp", "if", "in", "using", "weight"]) {
    const matches = found.filter((clause) => clause.kind === kind),
      allowed = kind === "weight" ? decl.weights.length : decl[kind];
    if (matches.length > 1) throw new StataError("invalid syntax", 198);
    if (matches.length && !allowed)
      throw notAllowed(
        kind === "exp" ? "=exp" : kind === "weight" ? "weights" : kind,
      );
    if (!matches.length && allowed && kind !== "weight" && !decl[kind].optional)
      throw new StataError(`${kind === "exp" ? "=exp" : kind} required`, 100);
  }

  // The varlist or other leading argument.
  const position = decl.positional;
  if (!position) {
    if (leading) throw notAllowed("varlist");
  } else if (position.kind === "anything") {
    if (!leading && !position.optional)
      throw new StataError(`${position.specs.id ?? "something"} required`, 100);
    locals[position.specs.name ?? "anything"] = leading;
    result.anything = leading;
  } else if (position.kind === "namelist" || position.kind === "name") {
    const names = nameList(leading);
    if (!names.length && !position.optional)
      throw new StataError("name required", 100);
    if (names.length) checkCount(names.length, position.specs, position.kind);
    locals.namelist = names.join(" ");
    result.names = names;
  } else if (position.kind.startsWith("new")) {
    if (!leading) {
      if (!position.optional) throw new StataError("varlist required", 100);
      locals.varlist = locals.typlist = "";
      result.varlist = [];
      result.types = [];
    } else {
      const { names, types, typed, labels } = newVariables(leading, context);
      result.typed = typed;
      result.labels = labels;
      checkCount(names.length, position.specs, position.kind);
      locals.varlist = names.join(" ");
      locals.typlist = types.join(" ");
      result.varlist = names;
      result.types = types;
    }
  } else {
    let names;
    if (leading) {
      names = existingVariables(leading, position.specs, context);
      checkCount(names.length, position.specs, position.kind);
    } else if (!position.optional)
      throw new StataError("varlist required", 100);
    else
      names =
        position.specs.default === "none"
          ? []
          : existingVariables("_all", position.specs, context);
    locals.varlist = names.join(" ");
    result.varlist = names;
  }

  for (const clause of found) {
    if (clause.kind === "weight") continue;
    if (!clause.text) throw new StataError("invalid syntax", 198);
    if (clause.kind === "if") {
      context.expression?.(clause.text, "if");
      locals.if = decl.if.bare ? clause.text : "if " + clause.text;
      result.if = clause.text;
    } else if (clause.kind === "in") {
      const [first, last] = range(clause.text, context.n ?? 0);
      locals.in = (decl.in.bare ? "" : "in ") + `${first}/${last}`;
      result.in = [first, last];
    } else if (clause.kind === "exp") {
      if (clause.text.startsWith("="))
        throw new StataError("invalid syntax", 198);
      context.expression?.(clause.text, "exp");
      locals.exp = decl.exp.bare ? clause.text : "= " + clause.text;
      result.exp = clause.text;
    } else {
      const inner = unquote(clause.text);
      if (inner === null && /\s/.test(clause.text))
        throw new StataError("invalid file specification", 198);
      const file = inner ?? clause.text;
      locals.using = decl.using.bare ? file : 'using `"' + file + "\"'";
      result.using = file;
    }
  }
  const weight = found.find((clause) => clause.kind === "weight");
  if (weight) {
    const close = head.indexOf("]", weight.at),
      m = /^\s*([A-Za-z]+)\s*=\s*([\s\S]+?)\s*$/.exec(
        head.slice(weight.at + 1, close < 0 ? head.length : close),
      );
    if (close < 0 || !m) throw new StataError("invalid syntax", 198);
    const type = weightType(m[1], decl.weights);
    context.expression?.(m[2], "weight");
    locals.weight = type;
    locals.exp = "= " + m[2];
    result.weight = { type, exp: m[2] };
  }

  // Options.
  const items = optionText === null ? [] : optionItems(optionText);
  if (items.length && !decl.hasOptions) throw notAllowed("options");
  const seen = new Set(),
    extra = [];
  for (const item of items) {
    const match = matchOption(item.name, decl.options);
    if (!match) {
      // Stata names an option written with an argument as name().
      if (!decl.star)
        throw new StataError(
          `option ${item.name}${item.argument === undefined ? "" : "()"} not allowed`,
          198,
        );
      extra.push(item.word);
      continue;
    }
    const { option, on } = match;
    if (option.unavailable)
      throw new StataError(
        `option ${option.name} is not available in the browser yet`,
        198,
      );
    if (seen.has(option))
      throw new StataError(`option ${option.name} not allowed`, 198);
    seen.add(option);
    if (option.kind === "flag" || option.kind === "off") {
      if (item.argument !== undefined)
        throw new StataError(`option ${item.name}() not allowed`, 198);
      if (on) {
        locals[option.name] =
          option.kind === "off" ? "no" + option.name : option.name;
        result.options[option.name] = option.kind !== "off";
      }
    } else {
      if (item.argument === undefined)
        throw new StataError(`option ${item.name} incorrectly specified`, 198);
      const { local, value } = optionValue(option, item.argument, context);
      locals[option.name] = local;
      result.options[option.name] = value;
    }
  }
  for (const option of decl.options) {
    if (seen.has(option) || option.unavailable) continue;
    if (option.required)
      throw new StataError(`option ${option.name}() required`, 198);
    if (option.kind === "cilevel") {
      result.options[option.name] = context.level ?? 95;
      locals[option.name] = formatNumber(context.level ?? 95);
    } else if (option.default !== undefined) {
      result.options[option.name] = Number(option.default);
      locals[option.name] = formatNumber(Number(option.default));
    }
  }
  if (decl.star) {
    locals.options = extra.join(" ");
    result.options["*"] = extra;
  }
  return result;
}
