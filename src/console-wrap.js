// How Stata breaks an error message wider than the linesize, for Results,
// a copied record and a text log. Most messages are printed as display
// prints a line: cut where the next character would pass the linesize, the
// rest after "> ". A few are SMCL paragraphs, broken between words, their
// later lines indented; checked against Stata 19 at linesizes 40 and 79.
import { wrapCharacters } from "./runtime/echo.js";

// "file ... not found", as each command prints it: {p 0 4 2} (later lines
// indented by four, two columns kept free on the right) or {p 0 0 0}.
// append and estimates use print it as a plain line. Every rule here was
// checked against Stata 19 at each linesize from 40 to 100.
const FILE_NOT_FOUND = /^file .+ not found$/;
const PARAGRAPHS = [
  {
    // import excel's refusal of firstrow with a variable list.
    message: /^option firstrow not allowed with extvarlist; /,
    indent: 0,
    right: 0,
  },
  {
    command:
      /^(?:u|us|use|merge|joinby|do|ru|run|include|insheet|inf|infi|infil|infile|infix|cross|labelbook|d|de|des|desc|descr|descri|describ|describe|type|erase|copy|checksum|graph use|import sasxport5)$/,
    message: FILE_NOT_FOUND,
    indent: 4,
    right: 2,
  },
  {
    command:
      /^import (?:delim|delimi|delimit|delimite|delimited|exc|exce|excel|sas|spss|sasxport8)$/,
    message: FILE_NOT_FOUND,
    indent: 0,
    right: 0,
  },
  {
    // merge's keys that do not identify observations: {p 0 4 2}.
    message:
      /^variables? .+ do(?:es)? not uniquely identify observations in the (?:master|using) data$/,
    indent: 4,
    right: 2,
  },
  {
    // append's and merge's string/numeric mismatch: {p 0 2 2}.
    message: /^(?:key )?variable \S+ is \S+ in master but \S+ in using data$/,
    indent: 2,
    right: 2,
  },
];

/** The command a record ran, less capture, noisily and quietly. */
function commandWord(command = "") {
  const words = command
    .trim()
    .replace(
      /^(?:(?:cap|capt|captu|captur|capture|n|no|noi|nois|noisi|noisil|noisily|qui|quie|quiet|quietl|quietly)\s+)+/,
      "",
    )
    .split(/[\s,]+/);
  return words[0] === "import" || words[0] === "graph"
    ? `${words[0]} ${words[1] ?? ""}`
    : words[0];
}

/**
 * A paragraph broken between words into lines of at most width - right
 * characters, lines after the first indented. A word too long for a line
 * of its own is cut where the line ends, the rest going on after "> " on
 * the next line, as Stata cuts it.
 */
function paragraph(text, width, indent, right) {
  const most = Math.max(width - right, indent + 3),
    pad = " ".repeat(indent),
    lines = [];
  let line = "";
  const start = (word) => {
    line = (lines.length ? pad : "") + word;
    while (line.length > most) {
      lines.push(line.slice(0, most));
      line = `${pad}> ${line.slice(most)}`;
    }
  };
  for (const word of text.split(" "))
    if (!line) start(word);
    else if (line.length + 1 + word.length <= most) line += ` ${word}`;
    else {
      lines.push(line);
      start(word);
    }
  if (line) lines.push(line);
  return lines;
}

/**
 * The lines of an error message (one line of a record, which may itself
 * hold several) as Stata prints it at the linesize, after the command the
 * record ran.
 */
export function errorText(text, width = 79, command = "") {
  const word = commandWord(command);
  return text.split("\n").flatMap((line) => {
    const rule = PARAGRAPHS.find(
      (each) =>
        each.message.test(line) && (!each.command || each.command.test(word)),
    );
    if (!rule) return wrapCharacters(line, width);
    return line.length <= width - rule.right
      ? [line]
      : paragraph(line, width, rule.indent, rule.right);
  });
}
