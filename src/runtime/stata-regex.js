// The regular expressions of regexm(), regexr() and regexs(). Which
// library reads a pattern depends on the version the session runs under,
// as in Stata.
//
// Under version 17 and before: Henry Spencer's library, read here as
// Stata 19 reads it under that version (ustrregexm() and the other
// ustrregex functions use ICU instead). It works on the bytes of the UTF-8
// text, so . matches one byte of é, not the letter. Its operators are
// ^ $ . [ ] ( ) | * + ? and \, which makes the next character literal:
// there is no {n}, no \d, \s or \w (\d is d), no [[:alpha:]] class (that
// is the set [[:alph followed by a literal ]), no lazy *?, and no (?i). ^
// and $ match only at the start and end of the whole string, wherever they
// stand in the pattern. Of several alternatives the first that lets the
// whole pattern match is taken, not the longest, and * + ? are greedy. A
// pattern the library cannot read is reported with its message, as
// "nested *?+", rather than raised.
//
// Under version 18 and later, which is what Stata 18 and 19 use when no
// version is set: a Perl-style library, still on the bytes of the text.
// \d \s \w \b, {n,m}, [[:space:]] and the other POSIX classes, lazy
// quantifiers, look-around, back-references and a leading (?i) all work,
// and \w and the classes know only ASCII letters. A pattern it cannot
// read matches nothing, without a message. regexr() puts its replacement
// in as written. These patterns are read by the browser's own regular
// expressions on the text's bytes; the few constructs that engine lacks
// (possessive and atomic groups, \p{}, flags set partway through) are
// refused with a message instead of being read differently.
import { StataError } from "./errors.js";
import { decodeBytes, encodeText } from "./values.js";

const NSUBEXP = 10;
const META = new Set([..."^$.[()|?*+\\"].map((c) => c.charCodeAt(0)));
const isMult = (c) => c === 42 || c === 43 || c === 63; // * + ?

class PatternError extends Error {}
const fail = (message) => {
  throw new PatternError(message);
};

/**
 * The program for a pattern, as Spencer's regcomp() builds it, or a
 * PatternError with its message. Each step is checked in the order
 * regcomp() checks it, so the message is the one Stata prints.
 */
function parse(text) {
  let p = encodeText(text);
  // The library reads a C string, which ends at the first zero byte.
  const zero = p.indexOf(0);
  if (zero >= 0) p = p.subarray(0, zero);
  let i = 0,
    groups = 1;
  const at = () => (i < p.length ? p[i] : 0);

  function reg(paren) {
    let n = 0,
      width = true;
    if (paren) {
      if (groups >= NSUBEXP) fail("too many ()");
      n = groups++;
    }
    const branches = [];
    for (;;) {
      const seq = [];
      let wide = false;
      while (i < p.length && at() !== 124 && at() !== 41) {
        const piece = regpiece();
        seq.push(piece.node);
        if (piece.width) wide = true;
      }
      branches.push(seq);
      if (!wide) width = false;
      if (at() !== 124) break;
      i++;
    }
    if (paren) {
      if (at() !== 41) fail("unterminated ()");
      i++;
    } else if (i < p.length) fail(at() === 41 ? "unmatched ()" : "junk on end");
    return { node: { t: "alt", branches, group: n }, width };
  }

  function regpiece() {
    const atom = regatom(),
      op = at();
    if (!isMult(op)) return atom;
    if (!atom.width && op !== 63) fail("*+ operand could be empty");
    i++;
    if (isMult(at())) fail("nested *?+");
    return {
      node: {
        t: op === 42 ? "star" : op === 43 ? "plus" : "opt",
        atom: atom.node,
        simple: !!atom.simple,
      },
      width: op === 43,
    };
  }

  function regatom() {
    const c = p[i++];
    switch (c) {
      case 94:
        return { node: { t: "bol" }, width: false };
      case 36:
        return { node: { t: "eol" }, width: false };
      case 46:
        return { node: { t: "any" }, width: true, simple: true };
      case 91: {
        // A set: ] or - first is literal, as is - last; a range runs from
        // the byte before the - to the byte after it; \ is literal.
        let negated = false;
        if (at() === 94) {
          negated = true;
          i++;
        }
        const set = new Uint8Array(256);
        if (at() === 93 || at() === 45) set[p[i++]] = 1;
        while (i < p.length && at() !== 93) {
          if (at() === 45) {
            i++;
            if (at() === 93 || i >= p.length) set[45] = 1;
            else {
              let from = p[i - 2] + 1;
              const to = p[i];
              if (from > to + 1) fail("invalid [] range");
              for (; from <= to; from++) set[from] = 1;
              i++;
            }
          } else set[p[i++]] = 1;
        }
        if (at() !== 93) fail("unmatched []");
        i++;
        return { node: { t: "set", negated, set }, width: true, simple: true };
      }
      case 40:
        return reg(true);
      case 63:
      case 43:
      case 42:
        return fail("?+* follows nothing");
      case 92:
        if (i >= p.length) fail("trailing \\");
        return {
          node: { t: "lit", bytes: [p[i++]] },
          width: true,
          simple: true,
        };
      default: {
        // A run of ordinary bytes; a * + or ? after it applies to its last.
        i--;
        let length = 0;
        while (i + length < p.length && !META.has(p[i + length])) length++;
        if (length > 1 && isMult(p[i + length] ?? 0)) length--;
        const bytes = [...p.subarray(i, i + length)];
        i += length;
        return {
          node: { t: "lit", bytes },
          width: true,
          simple: length === 1,
        };
      }
    }
  }

  return reg(false).node;
}

/**
 * The parsed pattern as a list of instructions for a backtracking machine
 * that keeps its choices on a stack of its own, so that a long string
 * cannot exhaust the browser's call stack. Its choices are Spencer's, in
 * his order: of two branches the first, and of x* or x+ another pass
 * through x before what follows, so it finds the match regexec() finds.
 * A group's slots are written each time the group is entered and left, so
 * a group in a loop ends with its last pass, as in regexec().
 */
function assemble(tree) {
  const code = [];
  const emit = (node) => {
    switch (node.t) {
      case "alt": {
        const { group, branches } = node,
          jumps = [];
        if (group) code.push({ op: "save", slot: 2 * group });
        branches.forEach((branch, k) => {
          const last = k === branches.length - 1,
            split = last ? null : { op: "split", next: code.length + 1 };
          if (split) code.push(split);
          branch.forEach(emit);
          if (split) {
            const jump = { op: "jump" };
            code.push(jump);
            jumps.push(jump);
            split.other = code.length;
          }
        });
        for (const jump of jumps) jump.to = code.length;
        if (group) code.push({ op: "save", slot: 2 * group + 1 });
        return;
      }
      case "opt": {
        const split = { op: "split", next: code.length + 1 };
        code.push(split);
        emit(node.atom);
        split.other = code.length;
        return;
      }
      case "star":
      case "plus": {
        const least = node.t === "star" ? 0 : 1;
        if (node.simple) {
          code.push({ op: "repeat", atom: node.atom, least });
          return;
        }
        const top = code.length;
        if (least) {
          emit(node.atom);
          code.push({ op: "split", next: top, other: code.length + 1 });
        } else {
          const split = { op: "split", next: top + 1 };
          code.push(split);
          emit(node.atom);
          code.push({ op: "jump", to: top });
          split.other = code.length;
        }
        return;
      }
      default:
        code.push({ ...node, op: node.t });
    }
  };
  emit(tree);
  code.push({ op: "match" });
  // What must hold just after a repeat for the match to go on, when the
  // next step tests one byte or the end: Spencer's STAR tries a count only
  // where the next byte is the one wanted, and this does the same for a
  // byte, a set or the end, so a repeat backs off at once over the counts
  // that cannot match. (".*x$" on a long string is then quick, as in
  // Stata.)
  code.forEach((step, k) => {
    if (step.op !== "repeat") return;
    const next = code[k + 1];
    if (next.op === "lit" || next.op === "set" || next.op === "eol")
      step.follow = next;
  });
  // The bytes every match must hold, as regcomp() keeps them to pass over
  // a string quickly: the literal runs of a pattern of one branch.
  const must =
    tree.branches.length === 1
      ? tree.branches[0].filter((n) => n.t === "lit").map((n) => n.bytes)
      : [];
  return {
    code,
    must,
    anchored: tree.branches.length === 1 && tree.branches[0][0]?.t === "bol",
  };
}

// Steps one match may take before the browser gives up on it.
const STEPS = 50_000_000;
// Above this length, the runs of a repeated atom and the places where the
// step after a repeat can match are read once for the whole string, so
// that trying each start costs no more than a step.
const SHORT = 64;

const holds = (s, bytes) => {
  outer: for (let i = 0; i + bytes.length <= s.length; i++) {
    for (let k = 0; k < bytes.length; k++)
      if (s[i + k] !== bytes[k]) continue outer;
    return true;
  }
  return false;
};

/**
 * Spencer's regexec(): the leftmost match of the program in the bytes s,
 * or null. Returns { starts, ends }, byte offsets of the whole match (0)
 * and of each group, -1 where a group took no part.
 */
function execute({ code, must, anchored }, s) {
  const length = s.length;
  if (!must.every((bytes) => holds(s, bytes))) return null;
  let steps = 0;
  const tooComplex = () =>
    new StataError("regular expression too complex for the browser", 901);
  const test = (atom, pos) =>
    pos < length &&
    (atom.t === "any" ||
      (atom.t === "lit"
        ? s[pos] === atom.bytes[0]
        : !!atom.set[s[pos]] !== atom.negated));
  const tables = new Map();
  // For each position, how many bytes from there the atom matches.
  const runs = (atom) => {
    let table = tables.get(atom);
    if (!table) {
      table = new Int32Array(length + 1);
      for (let p = length - 1; p >= 0; p--)
        table[p] = test(atom, p) ? table[p + 1] + 1 : 0;
      tables.set(atom, table);
    }
    return table;
  };
  // For each position, the last at or before it where the step matches.
  const places = (step) => {
    let table = tables.get(step);
    if (!table) {
      table = new Int32Array(length + 1);
      for (let p = 0, last = -1; p <= length; p++)
        table[p] = last = test(step, p) ? p : last;
      tables.set(step, table);
    }
    return table;
  };
  // How many bytes from pos the repeated atom matches, all there are.
  const run = (atom, pos) => {
    if (atom.t === "any") return length - pos;
    if (length > SHORT) return runs(atom)[pos];
    let count = 0;
    while (test(atom, pos + count)) count++;
    return count;
  };
  // The largest count, from count down to least, after which the step
  // that follows the repeat can match; -1 when there is none.
  const fit = (follow, base, count, least) => {
    if (!follow || count < least) return count < least ? -1 : count;
    if (follow.op === "eol") return base + count === length ? count : -1;
    if (length > SHORT) count = places(follow)[base + count] - base;
    else while (count >= least && !test(follow, base + count)) count--;
    return count < least ? -1 : count;
  };
  for (let start = 0; start <= (anchored ? 0 : length); start++) {
    const slots = new Array(2 * NSUBEXP).fill(-1),
      stack = [];
    let pc = 0,
      pos = start;
    for (;;) {
      if (++steps > STEPS) throw tooComplex();
      const step = code[pc];
      let ok = true;
      switch (step.op) {
        case "match":
          slots[0] = start;
          slots[1] = pos;
          return {
            starts: slots.filter((_, k) => k % 2 === 0),
            ends: slots.filter((_, k) => k % 2 === 1),
          };
        case "bol":
          ok = pos === 0;
          pc++;
          break;
        case "eol":
          ok = pos === length;
          pc++;
          break;
        case "any":
          ok = pos < length;
          pos++;
          pc++;
          break;
        case "set":
          ok = pos < length && !!step.set[s[pos]] !== step.negated;
          pos++;
          pc++;
          break;
        case "lit": {
          const bytes = step.bytes;
          ok = pos + bytes.length <= length;
          for (let k = 0; ok && k < bytes.length; k++)
            ok = s[pos + k] === bytes[k];
          pos += bytes.length;
          pc++;
          break;
        }
        case "save":
          slots[step.slot] = pos;
          pc++;
          break;
        case "jump":
          pc = step.to;
          break;
        case "split":
          stack.push({ pc: step.other, pos, slots: slots.slice() });
          pc = step.next;
          break;
        case "repeat": {
          // As many as there are, then one fewer at a time.
          const count = fit(step.follow, pos, run(step.atom, pos), step.least);
          if (count < 0) ok = false;
          else {
            if (count > step.least)
              stack.push({
                pc: pc + 1,
                base: pos,
                count: count - 1,
                least: step.least,
                follow: step.follow,
                slots: slots.slice(),
              });
            pos += count;
            pc++;
          }
          break;
        }
      }
      if (ok) continue;
      let choice;
      while ((choice = stack.pop())) {
        if (choice.base === undefined) {
          pos = choice.pos;
          break;
        }
        const count = fit(
          choice.follow,
          choice.base,
          choice.count,
          choice.least,
        );
        if (count < 0) continue;
        pos = choice.base + count;
        if (count > choice.least) {
          choice.count = count - 1;
          stack.push(choice);
        }
        break;
      }
      if (!choice) break;
      pc = choice.pc;
      for (let k = 0; k < slots.length; k++) slots[k] = choice.slots[k];
    }
  }
  return null;
}

const programs = new Map();
/**
 * The compiled pattern, or { error } with the library's message. Patterns
 * are kept, as a variable's pattern is read once for each observation.
 */
export function stataPattern(pattern) {
  let found = programs.get(pattern);
  if (!found) {
    try {
      found = { program: assemble(parse(pattern)) };
    } catch (error) {
      if (!(error instanceof PatternError)) throw error;
      found = { error: error.message };
    }
    if (programs.size > 500) programs.clear();
    programs.set(pattern, found);
  }
  return found;
}

/**
 * The match of a compiled pattern in text: { bytes, starts, ends } or
 * null. A match that takes too long for the browser is refused, r(901).
 */
export function stataMatch(program, text) {
  const bytes = encodeText(text),
    found = execute(program, bytes);
  return found && { bytes, ...found };
}

/** The text of the bytes from start to end. */
export function bytesText(bytes, start, end) {
  return decodeBytes(bytes.subarray(start, end));
}

// ----- the library of Stata 18 and later -----

const SPACE = "\\t\\n\\v\\f\\r ";
const POSIX_CLASSES = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: SPACE,
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
  word: "\\w",
};
const latinOf = (bytes) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096)
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return out;
};
const escapeLiteral = (text) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

class Unsupported extends Error {}
const unsupported = (what) => {
  throw new Unsupported(what);
};

/**
 * A pattern of the newer library as a JavaScript expression over the
 * text's bytes (each byte one character). Throws Unsupported for what the
 * browser's engine would read differently, and SyntaxError for what
 * neither can read.
 */
function translate(pattern) {
  let p = latinOf(encodeText(pattern));
  const zero = p.indexOf("\0");
  if (zero >= 0) p = p.slice(0, zero);
  let flags = "";
  const lead = /^\(\?([a-zA-Z]+)\)/.exec(p);
  if (lead) {
    for (const flag of lead[1]) {
      if (!"ims".includes(flag)) unsupported(`the flag (?${flag})`);
      if (!flags.includes(flag)) flags += flag;
    }
    p = p.slice(lead[0].length);
  }
  const dotAll = flags.includes("s"),
    multiline = flags.includes("m");
  let out = "",
    inClass = false,
    classStart = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      const next = p[i + 1];
      if (next === undefined) throw new SyntaxError("trailing backslash");
      if (next === "Q") {
        const end = p.indexOf("\\E", i + 2),
          literal = p.slice(i + 2, end < 0 ? p.length : end);
        out += escapeLiteral(literal);
        i = end < 0 ? p.length : end + 1;
        classStart = false;
        continue;
      }
      if (next === "E") {
        i++;
        continue;
      }
      i++;
      classStart = false;
      if (next === "s") {
        out += inClass ? SPACE : `[${SPACE}]`;
        // A - after a class is itself, not the start of a range.
        if (inClass && p[i + 1] === "-" && p[i + 2] !== "]") out += "\\";
      } else if (next === "S") {
        if (inClass) unsupported("\\S inside brackets");
        out += `[^${SPACE}]`;
      } else if (next === "A" && !inClass) out += "(?<![\\s\\S])";
      else if (next === "z" && !inClass) out += "(?![\\s\\S])";
      else if (next === "Z" && !inClass) out += "(?=\\n?(?![\\s\\S]))";
      else if ("pPXRKGChHvVNgxoeac".includes(next) && /[A-Za-z]/.test(next)) {
        // \xhh, \e, \a and \cX read the same in both; the rest do not.
        if (next === "x" && /^[0-9A-Fa-f]{2}/.test(p.slice(i + 1)))
          ((out += `\\x${p.slice(i + 1, i + 3)}`), (i += 2));
        else if (next === "e") out += "\\x1b";
        else if (next === "a") out += "\\x07";
        else unsupported(`\\${next}`);
      } else out += `\\${next}`;
      continue;
    }
    if (inClass) {
      if (c === "[" && p[i + 1] === ":") {
        const end = p.indexOf(":]", i + 2),
          name = end < 0 ? "" : p.slice(i + 2, end);
        if (name && POSIX_CLASSES[name] !== undefined) {
          out += POSIX_CLASSES[name];
          i = end + 1;
          if (p[i + 1] === "-" && p[i + 2] !== "]") out += "\\";
          classStart = false;
          continue;
        }
        if (name && /^\^?\w+$/.test(name)) unsupported(`the class [:${name}:]`);
      }
      if (c === "]" && !classStart) inClass = false;
      else if (c === "[") {
        out += "\\[";
        classStart = false;
        continue;
      }
      out += c;
      classStart = classStart && c === "^";
      continue;
    }
    if (c === "[") {
      inClass = true;
      classStart = true;
      out += c;
      if (p[i + 1] === "^") ((out += "^"), i++);
      // A ] first in the set is itself.
      if (p[i + 1] === "]") ((out += "\\]"), i++, (classStart = false));
      continue;
    }
    if (c === "(" && p[i + 1] === "?") {
      const rest = p.slice(i + 2);
      if (/^[:=!]|^<[=!]|^<[A-Za-z_]\w*>|^P<[A-Za-z_]\w*>/.test(rest)) {
        if (rest.startsWith("P<")) {
          out += "(?";
          i += 2;
          continue;
        }
        out += c;
        continue;
      }
      if (rest.startsWith("#")) {
        const end = p.indexOf(")", i);
        if (end < 0) throw new SyntaxError("unclosed comment");
        i = end;
        continue;
      }
      unsupported(`the group (?${rest.slice(0, 1)}`);
    }
    if ((c === "+" || c === "*" || c === "?" || c === "}") && p[i + 1] === "+")
      unsupported("a possessive quantifier");
    if (c === ".") {
      out += dotAll ? "[\\s\\S]" : "[^\\n]";
      continue;
    }
    if (c === "$" && !multiline) {
      out += "(?=\\n?(?![\\s\\S]))";
      continue;
    }
    out += c;
  }
  if (inClass) throw new SyntaxError("unclosed set");
  return new RegExp(out, `d${flags.replace("s", "")}`);
}

const modern = new Map();
/**
 * A pattern as Stata 18 and later read it: { re }, { invalid: true } when
 * Stata cannot read it (it then matches nothing), or { unsupported } when
 * the browser would read it differently.
 */
export function modernPattern(pattern) {
  let found = modern.get(pattern);
  if (!found) {
    try {
      found = { re: translate(pattern) };
    } catch (error) {
      if (error instanceof Unsupported) found = { unsupported: error.message };
      else if (error instanceof SyntaxError) found = { invalid: true };
      else throw error;
    }
    if (modern.size > 500) modern.clear();
    modern.set(pattern, found);
  }
  return found;
}

/** The match of such a pattern: { bytes, starts, ends, modern } or null. */
export function modernMatch(re, text) {
  const bytes = encodeText(text),
    found = re.exec(bytes.length === text.length ? text : latinOf(bytes));
  if (!found) return null;
  const starts = [],
    ends = [];
  for (const span of found.indices) {
    starts.push(span ? span[0] : -1);
    ends.push(span ? span[1] : -1);
  }
  return { bytes, starts, ends, modern: true };
}
