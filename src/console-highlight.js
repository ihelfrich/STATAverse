// Colour for the Console's editor. The do-file is split into spans by kind
// (comment, command, string, macro, number); the text itself is unchanged,
// so the layer sits exactly behind what the student types.
const PREFIXES = new Set([
  "quietly",
  "qui",
  "noisily",
  "capture",
  "cap",
  "by",
  "bysort",
  "bys",
  "xi",
]);
const WORDS = new Set([
  "foreach",
  "forvalues",
  "while",
  "if",
  "else",
  "program",
  "end",
  "local",
  "global",
  "tempvar",
  "tempname",
  "tempfile",
  "continue",
  "exit",
  "version",
  "set",
  "input",
  "simulate",
  "bootstrap",
  "jackknife",
  ...PREFIXES,
]);
const TOKEN =
  /(\/\/.*$)|("[^"\n]*"?)|(`[^'`\n]*'|\$\{?\w+\}?)|((?<![\w.])\d*\.?\d+(?:e[+-]?\d+)?(?![\w]))|([A-Za-z_]\w*)|(:)|(\s+)|([^\s\w])|(\w+)/gi;

function matcher(commands) {
  const known = commands.map((command) => [
    command.name,
    command.minimum ?? command.name.length,
  ]);
  const seen = new Map();
  return (word) => {
    if (!seen.has(word))
      seen.set(
        word,
        WORDS.has(word) ||
          known.some(
            ([name, minimum]) =>
              name.startsWith(word) && word.length >= minimum,
          ),
      );
    return seen.get(word);
  };
}

/** A fragment holding the text, with a span around each coloured part. */
export function highlight(text, commands) {
  const isCommand = matcher(commands),
    out = document.createDocumentFragment(),
    add = (value, kind) => {
      if (!kind) return out.append(value);
      const span = document.createElement("span");
      span.className = `hl-${kind}`;
      span.textContent = value;
      out.append(span);
    };
  text.split("\n").forEach((line, k) => {
    if (k) out.append("\n");
    if (/^\s*\*/.test(line)) return add(line, "comment");
    // The next word is a command at the start of a line and after a prefix.
    let expecting = true;
    for (const m of line.matchAll(TOKEN)) {
      if (m[1]) add(m[1], "comment");
      else if (m[2]) add(m[2], "string");
      else if (m[3]) add(m[3], "macro");
      else if (m[4]) add(m[4], "number");
      else if (m[5]) {
        const word = m[5];
        if (expecting && isCommand(word)) {
          add(word, "command");
          expecting = PREFIXES.has(word) && !/^by/.test(word);
          continue;
        }
        add(word);
      } else if (m[6]) {
        // After "by x:" or "simulate ...:" a command follows.
        add(m[6]);
        expecting = true;
        continue;
      } else add(m[0]);
      if (!m[7]) expecting = false;
    }
  });
  return out;
}
