// SMCL, the markup of Stata's Results window, rendered as Stata renders it
// to a text log: styles and links leave their text, {c #} and {char #} give
// a character, {col #}, {space #}, {hline}, {dup}, {ralign}, {lalign},
// {center} and {right} place text, and {p} paragraphs wrap their words at
// the line size. A directive Stata does not know is printed as it is
// written. Recorded from Stata 19 (version 17) in batch mode.
import { displayWidth } from "./values.js";

// Characters 128 to 159 as Windows code page 1252 has them; 160 to 255
// are Latin-1, which Unicode keeps at the same numbers.
const CP1252 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
/** The character a code from 0 to 255 stands for in SMCL, or null. */
export function codeCharacter(code) {
  if (!Number.isInteger(code) || code < 0 || code > 255) return null;
  if (code === 0) return " ";
  if (code >= 128 && code < 160) return CP1252[code - 128];
  return String.fromCharCode(code);
}

// {c name}: the line-drawing characters, as a text log draws them, and the
// names SMCL gives some others.
const NAMED = {
  "|": "|",
  "-": "-",
  "+": "+",
  TT: "-",
  BT: "-",
  LT: "|",
  RT: "|",
  TLC: "+",
  TRC: "+",
  BLC: "+",
  BRC: "+",
  "S|": "$",
  "'g": "`",
  "-(": "{",
  ")-": "}",
  "L-": "£",
  "Y=": "¥",
  ae: "æ",
  AE: "Æ",
  ss: "ß",
  "o/": "ø",
  "O/": "Ø",
};
// The accents SMCL composes with a letter: {c e'} is é, {c e'g} è.
const ACCENTS = {
  "'": "́",
  "'g": "̀",
  "^": "̂",
  "~": "̃",
  ":": "̈",
  ",": "̧",
};
function namedCharacter(name) {
  if (Object.hasOwn(NAMED, name)) return NAMED[name];
  if (/^\d+$/.test(name)) return codeCharacter(Number(name));
  if (/^0x[0-9a-f]+$/i.test(name)) return codeCharacter(parseInt(name, 16));
  const m = /^([A-Za-z])('g|['^~:,])$/.exec(name);
  if (m) {
    const composed = (m[1] + ACCENTS[m[2]]).normalize("NFC");
    if (composed.length === 1 && composed.charCodeAt(0) >= 0xc0)
      return composed;
  }
  return null;
}

// The paragraph directives that name their indents: first line, the
// lines after it, and the right margin.
const PARAGRAPHS = {
  pstd: [4, 4, 2],
  phang: [4, 8, 2],
  pmore: [8, 8, 2],
  pin: [8, 8, 2],
  phang2: [8, 12, 2],
  pmore2: [12, 12, 2],
  pin2: [12, 12, 2],
  phang3: [12, 16, 2],
  pmore3: [16, 16, 2],
  pin3: [16, 16, 2],
  psee: [4, 13, 2],
};
const STYLES = new Set([
  "txt",
  "text",
  "res",
  "result",
  "err",
  "error",
  "inp",
  "input",
  "com",
  "cmd",
  "hi",
  "hilite",
  "bf",
  "it",
  "sf",
  "ul",
]);
// Directives that link to something: their text, or what they link to.
const LINKS = new Set([
  "help",
  "helpb",
  "stata",
  "browse",
  "view",
  "net",
  "search",
  "dialog",
  "matacmd",
  "ado",
  "mansection",
  "manpage",
  "newvar",
  "update",
  "back",
]);
const SILENT = new Set([
  "marker",
  "vieweralsosee",
  "viewerjumpto",
  "viewerdialog",
]);

/** The index of the brace that closes the one at start, or -1. */
function closing(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++)
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  return -1;
}
/** The first colon of a directive outside the braces nested in it. */
function topColon(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++)
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    else if (text[i] === ":" && !depth) return i;
  return -1;
}
const count = (word, minimum = 0) =>
  /^-?\d+$/.test(word ?? "") && Number(word) >= minimum ? Number(word) : null;

/**
 * The pieces of SMCL text: strings of text and the directives that place
 * text or start and end paragraphs, the text inside a directive rendered.
 */
function pieces(text, linesize) {
  const out = [];
  let i = 0,
    plain = "";
  const flush = () => {
    if (plain) out.push(plain);
    plain = "";
  };
  // Text inside a directive, rendered by itself as plain text.
  const inner = (body) =>
    pieces(body, linesize)
      .map((piece) => (typeof piece === "string" ? piece : (piece.text ?? "")))
      .join("");
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) {
      plain += text.slice(i);
      break;
    }
    plain += text.slice(i, open);
    const close = closing(text, open);
    if (close < 0) {
      plain += text.slice(open);
      break;
    }
    const content = text.slice(open + 1, close),
      literal = text.slice(open, close + 1);
    i = close + 1;
    if (/^\s*asis\s*$/.test(content)) {
      plain += text.slice(i);
      break;
    }
    const colon = topColon(content),
      head = (colon < 0 ? content : content.slice(0, colon)).trim(),
      body = colon < 0 ? null : content.slice(colon + 1),
      [name = "", ...args] = head.split(/\s+/);
    let piece = null;
    // A character's name may hold a colon, as {c a:} does.
    const character = /^\s*(?:c|char)\s+(\S+)\s*$/.exec(content);
    if (character) {
      const shown = namedCharacter(character[1]);
      if (shown !== null) piece = shown;
    } else if (STYLES.has(name)) {
      if (body !== null && !args.length) piece = inner(body);
      else if (
        body === null &&
        (!args.length || (name === "ul" && /^(on|off)$/.test(args.join(" "))))
      )
        piece = "";
    } else if (name === "reset" && body === null && !args.length) piece = "";
    else if (LINKS.has(name) && args.length)
      piece = body === null ? args.join(" ") : inner(body);
    else if (name === "manlink" || name === "manlinki") {
      if (body === null && args.length >= 2)
        piece = `[${args[0]}] ${args.slice(1).join(" ")}`;
    } else if (SILENT.has(name)) piece = "";
    else if (name === "space" && body === null) {
      const n = count(args[0]);
      if (n !== null && args.length === 1) piece = " ".repeat(n);
    } else if (name === "hline" && body === null) {
      if (!args.length) piece = { kind: "hline" };
      else {
        const n = count(args[0]);
        if (n !== null && args.length === 1) piece = "-".repeat(n);
      }
    } else if (name === ".-" && body === null && !args.length)
      piece = { kind: "rule" };
    else if (name === "..." && body === null && !args.length) piece = "";
    else if (name === "col" && body === null) {
      const n = count(args[0]);
      if (n !== null && args.length === 1)
        piece = { kind: "col", column: n, text: literal };
    } else if (name === "dup" && body !== null) {
      const n = count(args[0]);
      if (n !== null && args.length === 1) piece = inner(body).repeat(n);
    } else if (
      /^(ralign|lalign|center|rcenter)$/.test(name) &&
      body !== null &&
      args.length === 1 &&
      count(args[0]) !== null
    ) {
      const width = count(args[0]),
        shown = inner(body),
        room = Math.max(0, width - displayWidth(shown)),
        left =
          name === "ralign"
            ? room
            : name === "lalign"
              ? 0
              : name === "center"
                ? Math.floor(room / 2)
                : Math.ceil(room / 2);
      piece = " ".repeat(left) + shown + " ".repeat(room - left);
    } else if (
      (name === "right" || name === "center") &&
      body !== null &&
      !args.length
    )
      piece = { kind: name, text: inner(body) };
    else if (name === "bind" && body !== null && !args.length)
      piece = { kind: "bind", text: inner(body) };
    else if (name === "break" && body === null && !args.length)
      piece = { kind: "break", text: "\n" };
    else if (name === "title" && body !== null && !args.length) {
      const shown = inner(body);
      piece = `${shown}\n${"-".repeat(displayWidth(shown))}`;
    } else if (name === "p_end" && body === null && !args.length)
      piece = { kind: "p_end" };
    else if (name === "p" && body === null && args.length <= 4) {
      const numbers = args.map((word) => count(word));
      if (numbers.every((n) => n !== null)) {
        const [first = 0, rest = 0, right = 0] = numbers;
        piece = { kind: "p", indents: [first, rest, right] };
      }
    } else if (Object.hasOwn(PARAGRAPHS, name) && body === null && !args.length)
      piece = { kind: "p", indents: PARAGRAPHS[name] };
    if (piece === null) plain += literal;
    else if (typeof piece === "string") plain += piece;
    else {
      flush();
      piece.literal = literal;
      out.push(piece);
    }
  }
  flush();
  return out;
}

// Spaces that {bind:} keeps from being broken, and {break}'s line break,
// inside a paragraph's text.
const BOUND = "\u0000",
  BREAK = "\u0001";

/** A paragraph's words wrapped between its indents and right margin. */
function wrap(text, [first, rest, right], linesize) {
  const width = linesize - right,
    lines = [];
  text.split(BREAK).forEach((segment, k) => {
    let line = " ".repeat(k ? rest : first),
      words = 0;
    for (const word of segment.split(/\s+/).filter(Boolean)) {
      const shown = word.replaceAll(BOUND, " "),
        used = displayWidth(line),
        // A line longer than the screen wraps there, and goes on from
        // where it wrapped.
        column = used > linesize ? used % linesize : used;
      if (words && column + 1 + displayWidth(shown) > width) {
        lines.push(line);
        line = " ".repeat(rest) + shown;
      } else line += (words ? " " : "") + shown;
      words++;
    }
    lines.push(line);
  });
  return lines;
}

/** SMCL text as the Results window shows it, lines joined by newlines. */
export function renderSmcl(text, linesize = 79) {
  if (!/[{]/.test(text)) return text;
  const lines = [];
  let line = "",
    paragraph = null,
    pending = false;
  const write = (shown) => {
      if (pending && shown) {
        lines.push(line);
        line = "";
        pending = false;
      }
      const parts = shown.split("\n");
      line += parts[0];
      for (const part of parts.slice(1)) {
        lines.push(line);
        line = part;
      }
    },
    // Ends a paragraph: its lines, then any line breaks that followed its
    // last word.
    finish = (newline) => {
      const trailing = /\n[\s\n]*$/.exec(paragraph.text)?.[0] ?? "",
        breaks = trailing.split("\n").length - 1,
        wrapped = wrap(
          paragraph.text.replace(/\n/g, " "),
          paragraph.indents,
          linesize,
        );
      paragraph = null;
      lines.push(...wrapped.slice(0, -1));
      line = wrapped.at(-1);
      if (newline) write("\n");
      write("\n".repeat(breaks));
    };
  for (const piece of pieces(text, linesize)) {
    if (typeof piece === "string") {
      if (paragraph) paragraph.text += piece;
      else write(piece);
      continue;
    }
    if (piece.kind === "p") {
      if (paragraph) finish(true);
      else if (pending) {
        lines.push(line);
        line = "";
        pending = false;
      } else if (line) write("\n");
      paragraph = { indents: piece.indents, text: "" };
    } else if (piece.kind === "p_end") {
      if (paragraph) {
        finish(false);
        pending = true;
      }
    } else if (paragraph) {
      // Inside a paragraph {col} is printed as written.
      paragraph.text +=
        piece.kind === "bind"
          ? piece.text.replace(/\s/g, BOUND)
          : piece.kind === "break"
            ? BREAK
            : piece.kind === "col"
              ? piece.literal
              : (piece.text ?? "");
    } else if (piece.kind === "col")
      write(" ".repeat(Math.max(0, piece.column - 1 - displayWidth(line))));
    else if (piece.kind === "hline")
      write("-".repeat(Math.max(0, linesize - displayWidth(line))));
    else if (piece.kind === "rule") write(`${"-".repeat(linesize)}\n`);
    else if (piece.kind === "right")
      write(
        " ".repeat(
          Math.max(0, linesize - displayWidth(line) - displayWidth(piece.text)),
        ) + piece.text,
      );
    else if (piece.kind === "center")
      write(
        " ".repeat(
          Math.max(
            0,
            Math.floor((linesize - displayWidth(piece.text)) / 2) -
              displayWidth(line),
          ),
        ) + piece.text,
      );
    else write(piece.text ?? "");
  }
  if (paragraph) finish(false);
  lines.push(line);
  return lines.join("\n");
}
