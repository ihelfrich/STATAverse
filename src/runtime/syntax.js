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
import { expandVarlist, joinRanges } from "./varlist.js";
import { checkedNumlist, parseNumlist } from "./numlist.js";
import {
  formatNumber,
  isName,
  isNumericType,
  isReserved,
  reservedNameMessage,
  isStringType,
  isType,
  parseNumber,
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
        // What a varlist, numlist or namelist option allows: max=2,
        // numeric, integer, >0, ascending and the like.
        specs: Object.fromEntries(
          rest.map((word) => {
            const [key, value] = word.split(/=(.*)/s);
            return /^[<>]/.test(word)
              ? [word.replace(/[\d.+-]+$/, ""), Number(/[\d.+-]+$/.exec(word))]
              : [key, value === undefined ? true : value];
          }),
        ),
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
// The kinds of option for which an empty argument, as by(), is the same as
// not giving the option at all.
const EMPTY_IS_UNSET = new Set([
  "name",
  "namelist",
  "varlist",
  "varname",
  "numlist",
  "cilevel",
  "passthru",
]);

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
      // Stata reads > =, < =, ! = and ~ = as one operator.
      !/[=!~<>]\s*$/.test(text.slice(0, i)) &&
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

/**
 * What stands on either side of a lone = found by loneEquals: the operands
 * between it and the nearest & or | at its own depth (Stata binds = as
 * tightly as ==), as { left, right } texts.
 */
export function equalsOperands(text, lone) {
  const edge = (from, step) => {
    let depth = 0,
      quote = false,
      i = from;
    for (; i >= 0 && i < text.length; i += step) {
      const c = text[i];
      if (c === '"') quote = !quote;
      if (quote) continue;
      if ((step > 0 ? "([" : ")]").includes(c)) depth++;
      else if ((step > 0 ? ")]" : "([").includes(c) && --depth < 0) break;
      else if (!depth && (c === "&" || c === "|")) break;
    }
    return i;
  };
  return {
    left: text.slice(edge(lone.at - 1, -1) + 1, lone.at).trim(),
    right: text.slice(lone.at + 1, edge(lone.at + 1, 1)).trim(),
  };
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
      // After an operator it is a coefficient, [/athrho] or [eq]x, in an
      // expression: replace w = w + [/athrho], count if x > [eq]x.
      if (
        opensAtTop &&
        (i === 0 || /\s/.test(head[i - 1])) &&
        !/[-+/^=<>&|!(,]$/.test(head.slice(0, i).trimEnd())
      )
        found.push({ kind: "weight", at: i, after: i });
    }
  }
  // A file may be called using.dta: using followed by a period is a name.
  const word =
    /(?<![\w\u0080-\u{10FFFF}.])(if|in|using(?!\.))(?![\w\u0080-\u{10FFFF}])/gu;
  for (let m; (m = word.exec(head));)
    if (
      flags[m.index] &&
      // After an operator in an expression, if and in are names: gen y =
      // x * if x == 1 is if not found. (After a varlist, x* if is not.)
      !(
        m[1] !== "using" &&
        /(?:[-+*/^&|<>!~]|[=!~<>]=)\s*$/.test(head.slice(0, m.index)) &&
        (found.some((clause) => clause.kind === "if") ||
          /(?:^|[^=!~<>])=(?!=)/.test(head.slice(0, m.index)))
      )
    )
      found.push({ kind: m[1], at: m.index, after: m.index + m[1].length });
  found.sort((a, b) => a.at - b.at);
  // =exp can only come before every other clause.
  const limit = found[0]?.at ?? head.length;
  for (let i = 0; i < limit; i++)
    if (
      flags[i] &&
      head[i] === "=" &&
      !/[=!~<>]\s*$/.test(head.slice(0, i)) &&
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

/**
 * True when the weight was written [weight=exp] or [w=exp] and so left
 * its kind to the command.
 */
export function genericWeight(text) {
  return /\[\s*w(?:e(?:i(?:g(?:ht?)?)?)?)?\s*=/.test(splitAtComma(text)[0]);
}
const WEIGHT_NAMES = {
  aweight: "analytic",
  fweight: "frequency",
  pweight: "sampling",
  iweight: "importance",
};
/** What Stata says when it takes [weight=exp] as the kind given. */
export const assumedWeights = (type) =>
  `(${WEIGHT_NAMES[type]} weights assumed)`;

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
    // p1-p4 stands for p1 p2 p3 p4, as in Stata's newvarlist.
    tokens = text
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((token) => {
        const range = /^([A-Za-z_]\w*?)(\d+)-([A-Za-z_]\w*?)(\d+)$/.exec(token);
        if (!range || range[1] !== range[3] || +range[2] > +range[4])
          return [token];
        return Array.from(
          { length: range[4] - range[2] + 1 },
          (_, k) => `${range[1]}${+range[2] + k}`,
        );
      });
  for (let i = 0; i < tokens.length; i++) {
    let type = context.defaultType ?? "float",
      token = tokens[i];
    typed.push(isType(token) || token === "str");
    if (isType(token) || token === "str") {
      type = token;
      token = tokens[++i];
      // A type with no name after it names nothing.
      if (token === undefined) {
        typed.pop();
        break;
      }
    }
    // name:label attaches a value label, which generate handles itself.
    const name = token.split(":")[0];
    if (name === "_all" || name === "_skip") throw notAllowed(name);
    // A list that starts with a word of the syntax names no variable.
    if (
      (context.program || context.newlist) &&
      !names.length &&
      /^(with|using|in|if)$/.test(name)
    )
      throw new StataError("varlist required", 100);
    // A name that starts well and then meets a character no name has is
    // refused by that character, as Stata's parser reads it (y@ is "@
    // invalid name"); a range (y-z) is not a new name at all.
    const stray =
      /^[\p{L}_][\w\u0080-\u{10FFFF}.]*([^\w\u0080-\u{10FFFF}.])/u.exec(name);
    if (
      stray &&
      context.names.includes(name.slice(0, stray.index + stray[0].length - 1))
    )
      throw new StataError(
        `variable ${name.slice(0, stray[0].length - 1)} already defined`,
        110,
      );
    if (stray?.[1] === "-") throw new StataError("invalid syntax", 198);
    if (stray) throw new StataError(`${stray[1]} invalid name`, 198);
    if (!isName(name)) throw new StataError(`${name} invalid name`, 198);
    // syntax keeps _skip for itself.
    if (name === "_skip") throw notAllowed("_skip");
    if (isReserved(name)) throw new StataError(reservedNameMessage(name), 198);
    if (context.names.includes(name) || names.includes(name))
      throw new StataError(`variable ${name} already defined`, 110);
    names.push(name);
    types.push(type);
    labels.push(token.split(":")[1] ?? "");
  }
  return { names, types, typed, labels };
}

/**
 * The names of foreach ... of newlist: each a valid name of at most 32
 * characters, none a variable already there, none twice.
 */
export function newVariableNames(text, existing) {
  for (const word of text.split(/\s+/))
    if (/^[A-Za-z_]\w*$/.test(word) && word.length > 32)
      throw new StataError(`${word} invalid varname`, 198);
  return newVariables(text, { names: existing, newlist: true }).names;
}

function existingVariables(text, specs, context) {
  const names = expandVarlist(text, context.names, context.parentheses);
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

// ----- varlist(fv) and varlist(ts) -----

/** Splits text at blanks, or at a separator, outside parentheses. */
function topSplit(text, separator = null) {
  const out = [];
  let depth = 0,
    current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (!depth && (separator ? text.startsWith(separator, i) : /\s/.test(c))) {
      if (separator) {
        out.push(current);
        i += separator.length - 1;
      } else if (current) out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (separator || current) out.push(current);
  return out;
}

// An operator before the period: a factor-variable part (i, ibn, ib2,
// ib(first), i(1 2), b2, b(#2), bn, 2, i2, 2b, i2b, 2bn, 2o, o2, c, co, o)
// and time-series ones (L2, D, L(1/2), ...), the factor part before or
// after them, either of them perhaps missing.
const FACTOR =
    "ibn|ib\\d+|ib\\([^)]*\\)|i\\([^)]*\\)|io\\d+|i\\d+(?:bn|b|o)?|i|bn|b\\d+|b\\([^)]*\\)|\\d+(?:bn|b|o)?|o\\d+|co|c|o",
  SERIES = "(?:[LFDSlfds](?:\\d+|\\([^)]*\\))?)*",
  OPERATOR = new RegExp(`^(${FACTOR})?(${SERIES})$`),
  OPERATOR_AFTER = new RegExp(`^(${SERIES})(${FACTOR})$`);

/**
 * A factor operator as Stata's syntax spells it in `varlist': b2 is ib2,
 * b(#1) is i, 2 and 2b alone are i2 and i2b2, co is o; in an interaction a
 * level marked as base is the level alone (2b.g#c.x is 2.g#c.x).
 */
function factorSpelling(fv, alone) {
  if (fv === null || fv === "c" || fv === "o") return fv;
  if (fv === "co") return "o";
  let m;
  if (/^i?b\(#1\)$/.test(fv)) return "i";
  // b(2) is b2.
  if ((m = /^i?b\((\d+)\)$/.exec(fv))) return `ib${m[1]}`;
  if ((m = /^i?(b\d+|b\([^)]*\)|bn)$/.exec(fv))) return `i${m[1]}`;
  if ((m = /^i?(\d+)(bn|b|o)?$/.exec(fv))) {
    const [, level, mark = ""] = m;
    if (!alone) return mark === "b" ? level : `${level}${mark}`;
    if (mark === "bn") return `i${level}bn`;
    return mark ? `i${level}${mark}${level}` : `i${level}`;
  }
  if ((m = /^i?o(\d+)$/.exec(fv))) return `io${m[1]}`;
  return fv;
}

/**
 * One part of a factor-variable or time-series term, as i.g, L2.x, cL.x,
 * i.(g h) or L(1/2).x: the members it stands for, each { fv, ts, name,
 * typed }, fv the factor operator (null for none), ts the time-series ones
 * in Stata's order and typed the operator as written (cL).
 */
function operatorMembers(part, resolve) {
  if (/^\(.*\)$/.test(part))
    return topSplit(part.slice(1, -1)).flatMap((inner) =>
      operatorMembers(inner, resolve),
    );
  const segments = topSplit(part, "."),
    target = segments.pop();
  let fv = null,
    typed = null,
    chains = [[]];
  for (const segment of segments) {
    const before = OPERATOR.exec(segment),
      after = before ? null : OPERATOR_AFTER.exec(segment),
      factor = before ? before[1] : after?.[2],
      series = before ? before[2] : after?.[1];
    if ((!before && !after) || !segment)
      throw new StataError("invalid syntax", 198);
    if (factor) {
      fv = factor;
      typed = segment;
    }
    for (const [, letter, count] of series.matchAll(
      /([LFDSlfds])(\d+|\([^)]*\))?/g,
    )) {
      const counts = count?.startsWith("(")
        ? parseNumlist(count.slice(1, -1))
        : [count === undefined ? 1 : Number(count)];
      chains = chains.flatMap((chain) =>
        counts.map((k) => [...chain, [letter.toUpperCase(), k]]),
      );
    }
  }
  // L(0/1).x is x and L.x; LD.x and DL.x are the same, written LD.
  const spelled = chains.map((chain) =>
    ["L", "F", "D", "S"]
      .map((letter) => {
        const k = chain
          .filter(([l]) => l === letter)
          .reduce((t, [, n]) => t + n, 0);
        return k === 0 ? "" : k === 1 ? letter : `${letter}${k}`;
      })
      .join(""),
  );
  const names = /^\(.*\)$/.test(target)
    ? topSplit(target.slice(1, -1))
    : [target];
  return names.flatMap((name) => {
    const stray = /[^\w\u0080-\u{10FFFF}]/u.exec(name);
    if (stray) throw new StataError(`${stray[0]} invalid name`, 198);
    if (!name) throw new StataError("invalid syntax", 198);
    const variable = resolve(name);
    return spelled.map((ts) => ({ fv, ts, name: variable, typed }));
  });
}

/**
 * The varlist of a program whose syntax allows factor variables (fv) or
 * time-series operators (ts), written as Stata's syntax leaves it in
 * `varlist': names in full, c.x alone as x, 2.g alone as i2.g, a bare
 * variable in an interaction a factor one, the factors of an interaction
 * before its continuous parts, a##b as a b a#b, and each term once.
 */
function operatorVarlist(text, specs, context, found = {}) {
  const out = [],
    resolve = (name) => expandVarlist(name, context.names)[0],
    check = (member, factor) => {
      const type = context.types?.[member.name];
      // Under varlist(ts) a factor operator is refused: c, cL and co as
      // operators Stata does not know, o as one not allowed.
      if ((factor || member.fv !== null) && !specs.fv) {
        if (member.fv?.startsWith("c"))
          throw new StataError(`${member.typed}:  operator invalid`, 198);
        if (member.fv === "o")
          throw new StataError("o. operator not allowed", 101);
        throw new StataError("factor-variable operators not allowed", 101);
      }
      if (member.ts && !specs.ts)
        throw new StataError("time-series operators not allowed", 101);
      if (factor && isStringType(type))
        throw new StataError(
          `${member.name}:  string variables may not be used as factor variables`,
          109,
        );
      if (member.ts && isStringType(type))
        throw new StataError(
          `${member.name}:  may not use time-series operators on string variables`,
          109,
        );
      if (member.ts && !context.timeSet)
        throw new StataError("time variable not set", 111);
      if (factor) found.fv = true;
      if (member.ts) found.ts = true;
    },
    spell = (fv, member) =>
      fv || member.ts ? `${fv ?? ""}${member.ts}.${member.name}` : member.name,
    // A term alone: c. is dropped and a level gets i before it. c. alone
    // is not a factor operator to s(fvops).
    factorial = (member) => member.fv !== null && member.fv !== "c",
    alone = (member) => {
      check(member, factorial(member));
      const fv = factorSpelling(member.fv, true);
      return spell(fv === "c" ? null : fv, member);
    },
    interaction = (members) => {
      const parts = members.map((member) => ({
        member,
        fv: factorSpelling(member.fv ?? "i", false),
      }));
      for (const part of parts) check(part.member, true);
      return [
        ...parts.filter((part) => part.fv !== "c"),
        ...parts.filter((part) => part.fv === "c"),
      ]
        .map((part) => spell(part.fv, part.member))
        .join("#");
    },
    product = (lists) =>
      lists.reduce(
        (all, list) => all.flatMap((done) => list.map((one) => [...done, one])),
        [[]],
      ),
    // A variable may stand twice, and so may a term with only time-series
    // operators; a factor term or an interaction stands once, and i.g
    // before or after ib2.g is ib2.g.
    push = (term, factor = true) => {
      if (!factor) return void out.push(term);
      if (out.includes(term)) return;
      const base = /^i(?:b[^.]*)?\.([^.#]+)$/.exec(term),
        other = base
          ? out.findIndex(
              (t) =>
                /^i(?:b[^.]*)?\.([^.#]+)$/.exec(t)?.[1] === base[1] &&
                (t === `i.${base[1]}` || term === `i.${base[1]}`),
            )
          : -1;
      if (other < 0) out.push(term);
      else if (term !== `i.${base[1]}`) out[other] = term;
    };
  for (const word of joinRanges(topSplit(text))) {
    // A plain word is read as any varlist is: abbreviations, ranges and
    // wildcards.
    if (!/[.#()]/.test(word)) {
      for (const name of existingVariables(word, specs, context))
        push(name, false);
      continue;
    }
    const groups = topSplit(word, "##").map((group) =>
      topSplit(group, "#").map((part) => operatorMembers(part, resolve)),
    );
    if (groups.some((group) => group.some((members) => !members.length)))
      throw new StataError("invalid syntax", 198);
    if (groups.length === 1) {
      for (const members of product(groups[0]))
        if (members.length === 1)
          push(alone(members[0]), factorial(members[0]));
        else push(interaction(members));
      continue;
    }
    // a##b##c: every combination of the groups, in the order of binary
    // counting; a bare variable there is a factor one. A term it makes
    // twice (c.x##c.x has x twice) stands once.
    const made = new Set();
    for (let mask = 1; mask < 1 << groups.length; mask++)
      for (const members of product(
        groups.filter((_, k) => mask & (1 << k)).flat(),
      ))
        if (members.length > 1) push(interaction(members));
        else {
          const member = { ...members[0], fv: members[0].fv ?? "i" },
            spelled = alone(member);
          if (!made.has(spelled)) push(spelled, factorial(member));
          made.add(spelled);
        }
  }
  return out;
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

/**
 * An option's argument read as its declaration says. A number option's
 * error names the option as it was typed (cut() for CUToff), and a number
 * that is not one is an error a * in the declaration takes instead
 * (error.passes); a varlist, numlist or namelist names it in full.
 */
function optionValue(option, argument, context, typed = option.name) {
  const invalid = () =>
    Object.assign(
      new StataError(`option ${typed}() incorrectly specified`, 198),
      { passes: true },
    );
  // An error in a varlist, name or numlist is told as being in the option.
  const within = (read, wrap) => {
    try {
      return read();
    } catch (error) {
      if (error instanceof StataError) error.message = wrap(error.message);
      throw error;
    }
  };
  const text = argument.trim(),
    specs = option.specs ?? {},
    full = option.name,
    // How many items the option allows, as syntax's max= and min= say.
    count = (n, what) => {
      const single = option.kind === "name" || option.kind === "varname",
        most = single ? 1 : Number(specs.max ?? Infinity),
        least = single ? 1 : Number(specs.min ?? 1),
        lead = what === "names" ? `option ${full}():` : `${full}():`;
      if (n > most)
        throw new StataError(`${lead}  too many ${what} specified`, 103);
      if (n < least)
        throw new StataError(`${lead}  too few ${what} specified`, 102);
    };
  switch (option.kind) {
    case "integer": {
      // Any number that is a whole one in the range of a long: 1e2, 2.0,
      // +3; not a missing value.
      const value = /^\.[a-z]?$/.test(text) ? undefined : parseNumber(text);
      if (
        value === undefined ||
        !Number.isInteger(value) ||
        value < -2147483647 ||
        value > 2147483620
      )
        throw invalid();
      return { local: formatNumber(value + 0), value: value + 0 };
    }
    case "real": {
      // A missing value is a number here, in a program's syntax.
      const value =
        /^\.[a-z]?$/.test(text) && !context.program
          ? undefined
          : parseNumber(text);
      if (value === undefined) throw invalid();
      return { local: formatNumber(value), value };
    }
    case "cilevel": {
      // A level is written plainly: 1e1 is not read.
      const missing = /^\.[a-z]?$/.test(text);
      if (!missing && !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text))
        throw new StataError(`${text} found where number expected`, 198);
      const value = missing ? NaN : Number(text);
      if (!(value >= 10 && value <= 99.99))
        throw new StataError(
          "level() must be between 10 and 99.99 inclusive",
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
      count(names.length, "names");
      return {
        local: names.join(" "),
        value: option.kind === "name" ? names[0] : names,
      };
    }
    case "varlist":
    case "varname": {
      const names = within(
        () => expandVarlist(text, context.names),
        (message) => `${message}\n(error in option ${typed}())`,
      );
      if (!names.length) throw invalid();
      count(names.length, "variables");
      for (const name of names)
        if (specs.numeric && isStringType(context.types?.[name]))
          throw new StataError(
            `string variables not allowed in option ${full}();\n${name} is a string variable`,
            109,
          );
      return {
        local: names.join(" "),
        value: option.kind === "varname" ? names[0] : names,
      };
    }
    case "numlist": {
      const range = Object.entries(specs)
          .filter(([key]) => /^[<>]=?$/.test(key))
          .map(([key, bound]) => `${key}${bound}`)
          .join(" "),
        values = within(
          () =>
            checkedNumlist(text, {
              ...specs,
              range: range || undefined,
              missingokay: specs.missingokay ?? specs.miss,
            }),
          (message) => `${full}() invalid -- ${message}`,
        );
      if (!values.length) throw invalid();
      const numbers = values.map((v) =>
        typeof v === "number" ? v : parseNumber(v),
      );
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

  // A program's syntax reads its varlist first: pn in, with no varlist,
  // wants one before anything is said of in.
  if (
    context.program &&
    !leading &&
    decl.positional &&
    !decl.positional.optional &&
    /^(new)?var(list|name)$/.test(decl.positional.kind)
  )
    throw new StataError("varlist required", 100);
  for (const kind of ["exp", "if", "in", "using", "weight"]) {
    const matches = found.filter((clause) => clause.kind === kind),
      allowed = kind === "weight" ? decl.weights.length : decl[kind];
    if (matches.length > 1) throw new StataError("invalid syntax", 198);
    if (matches.length && !allowed)
      throw notAllowed(
        kind === "exp"
          ? "=exp"
          : kind === "weight"
            ? "weights"
            : kind === "in"
              ? "in range"
              : kind,
      );
    // A missing =exp is reported after the varlist, as syntax checks it.
    if (
      !matches.length &&
      allowed &&
      kind !== "weight" &&
      kind !== "exp" &&
      !decl[kind].optional
    )
      throw new StataError(`${kind} required`, 100);
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
      // A newvarlist of a type alone, as byte, is a list of none.
      if (names.length || position.kind !== "newvarlist")
        checkCount(names.length, position.specs, position.kind);
      locals.varlist = names.join(" ");
      locals.typlist = types.join(" ");
      result.varlist = names;
      result.types = types;
    }
  } else {
    let names;
    // Whether the varlist had factor variables or time-series operators,
    // which a program's syntax reports in s(fvops) and s(tsops).
    if (position.specs.fv || position.specs.ts) result.operators = {};
    if (leading) {
      names = result.operators
        ? operatorVarlist(leading, position.specs, context, result.operators)
        : existingVariables(leading, position.specs, context);
      // _all with no variables in memory is a list of none, which Stata's
      // drop, keep, describe, order, sort and the others accept.
      if (names.length || !/^\s*_all\s*$/.test(leading))
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

  if (decl.exp && !decl.exp.optional && !found.some((c) => c.kind === "exp"))
    throw new StataError("=exp required", 100);

  // An if or =exp that ends in an operator just before the options is read
  // with the comma, which Stata names: if x == 1 & , is 1& invalid name.
  const beforeComma = (clause) =>
    optionText !== null &&
    clause === found.at(-1) &&
    /(?:[-+*/^&|<>!~]|==|[<>!~]=)\s*$/.test(clause.text)
      ? `${clause.text},`
      : clause.text;
  for (const clause of found) {
    if (clause.kind === "weight") continue;
    if (!clause.text) throw new StataError("invalid syntax", 198);
    if (clause.kind === "if") {
      context.expression?.(beforeComma(clause), "if");
      locals.if = decl.if.bare ? clause.text : "if " + clause.text;
      // Read with the comma, an operator after a string is passed over:
      // summarize x if s == "a" & , detail is summarize x if s == "a".
      result.if = beforeComma(clause);
    } else if (clause.kind === "in") {
      const [first, last] = range(clause.text, context.n ?? 0);
      locals.in = (decl.in.bare ? "" : "in ") + `${first}/${last}`;
      result.in = [first, last];
    } else if (clause.kind === "exp") {
      // A second = names what follows it: gen z = = x is =x invalid name.
      if (/^=(?!=)/.test(clause.text))
        throw new StataError(
          `=${/^=\s*([^\s\-+*/^<>&|!~=,()[\]]*)/.exec(clause.text)[1]} invalid name`,
          198,
        );
      if (clause.text.startsWith("="))
        throw new StataError("invalid syntax", 198);
      context.expression?.(beforeComma(clause), "exp");
      locals.exp = decl.exp.bare ? clause.text : "= " + clause.text;
      result.exp = beforeComma(clause);
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
  // A comma is an option list, empty or not: count , is options not
  // allowed.
  if (optionText !== null && !decl.hasOptions) throw notAllowed("options");
  const seen = new Set(),
    extra = [];
  for (const item of items) {
    const match = matchOption(item.name, decl.options);
    if (!match) {
      // Stata names an option written with an argument as name().
      if (!decl.star) {
        const error = new StataError(
          `option ${item.name}${item.argument === undefined ? "" : "()"} not allowed`,
          198,
        );
        // The options this command does take, for the Console to suggest
        // the nearest of them; what Stata prints is unchanged.
        error.allowed = decl.options
          .filter((option) => !option.unavailable)
          .map((option) =>
            option.kind === "off" ? "no" + option.name : option.name,
          );
        throw error;
      }
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
    if (option.kind === "flag" || option.kind === "off") {
      seen.add(option);
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
      // An empty argument, as by(), is the option not given.
      if (!item.argument.trim() && EMPTY_IS_UNSET.has(option.kind)) continue;
      let read;
      try {
        read = optionValue(option, item.argument, context, item.name);
      } catch (error) {
        if (!(decl.star && error.passes)) throw error;
        extra.push(item.word);
        continue;
      }
      seen.add(option);
      locals[option.name] = read.local;
      result.options[option.name] = read.value;
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
