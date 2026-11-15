// The regular expressions of regexm(), regexr() and regexs(): Henry
// Spencer's library, which Stata keeps for these functions, read here as
// Stata 19 reads it (ustrregexm() and the other ustrregex functions use ICU
// instead). It works on the bytes of the UTF-8 text, so . matches one byte
// of é, not the letter. Its operators are ^ $ . [ ] ( ) | * + ? and \,
// which makes the next character literal: there is no {n}, no \d, \s or \w
// (\d is d), no [[:alpha:]] class (that is the set [[:alph followed by a
// literal ]), no lazy *?, and no (?i). ^ and $ match only at the start and
// end of the whole string, wherever they stand in the pattern. Of several
// alternatives the first that lets the whole pattern match is taken, not
// the longest, and * + ? are greedy. A pattern the library cannot read is
// reported with its message, as "nested *?+", rather than raised.
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
  const single = (atom, pos) => {
    if (pos >= length) return false;
    if (atom.t === "any") return true;
    if (atom.t === "lit") return s[pos] === atom.bytes[0];
    return !!atom.set[s[pos]] !== atom.negated;
  };
  for (let start = 0; start <= (anchored ? 0 : length); start++) {
    const slots = new Array(2 * NSUBEXP).fill(-1),
      stack = [];
    let pc = 0,
      pos = start;
    for (;;) {
      if (++steps > STEPS)
        throw new StataError(
          "regular expression too complex for the browser",
          901,
        );
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
          let count = 0;
          while (single(step.atom, pos + count)) count++;
          if (count < step.least) ok = false;
          else {
            if (count > step.least)
              stack.push({
                pc: pc + 1,
                base: pos,
                count: count - 1,
                least: step.least,
                slots: slots.slice(),
              });
            pos += count;
            pc++;
          }
          break;
        }
      }
      if (ok) continue;
      const choice = stack.pop();
      if (!choice) break;
      pc = choice.pc;
      for (let k = 0; k < slots.length; k++) slots[k] = choice.slots[k];
      if (choice.base === undefined) pos = choice.pos;
      else {
        pos = choice.base + choice.count;
        if (choice.count > choice.least) {
          choice.count--;
          stack.push(choice);
        }
      }
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
