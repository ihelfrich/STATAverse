// Finding a file in the session's folder. Names are matched without regard
// to case when no file has the exact name, as Stata finds them on macOS and
// Windows: `use left` opens Left.dta there.
import { StataError } from "./errors.js";
import { displayWidth, truncateColumns } from "./values.js";

/**
 * The name a file is kept under in the session's folder, which is Stata's
 * working directory: ./people.dta is people.dta.
 */
export function folderName(name) {
  return String(name).replace(/^(?:\.\/+)+/, "");
}

/**
 * The session's folder: a Map of the files in it, by name, in which
 * ./people.dta is people.dta whichever command writes or reads it.
 */
export class Folder extends Map {
  get(name) {
    return super.get(folderName(name));
  }
  has(name) {
    return super.has(folderName(name));
  }
  set(name, file) {
    return super.set(folderName(name), file);
  }
  delete(name) {
    return super.delete(folderName(name));
  }
}

/** The name a file is kept under, or "" when there is none. */
export function findFile(files, name) {
  if (!files || !name) return "";
  if (files.has(name)) return name;
  name = folderName(name);
  if (files.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of files.keys()) if (key.toLowerCase() === lower) return key;
  return "";
}

/** The name of tempfile number k, in Stata's temporary folder. */
export const temporaryFileName = (k) =>
  `/tmp/St00001.${String(k).padStart(6, "0")}`;

/**
 * confirm file filename and confirm new file filename. A file is there
 * when it is in the session's folder (found as use finds it) or is a
 * folder mkdir made; a new file cannot be one that is there, nor be put in
 * a folder that is not. As recorded from Stata 19.
 */
export function confirmFile(session, isNew, text) {
  const rest = text.trim(),
    m = /^(?:`"([^"]*)"'|"([^"]*)"|([^\s",]+))/.exec(rest);
  if (!m) throw new StataError("'' found where filename expected", 7);
  const name = m[1] ?? m[2] ?? m[3],
    after = rest.slice(m[0].length).trim();
  if (after)
    throw new StataError(
      `'${after.startsWith(",") ? "," : after.split(/\s+/)[0]}' found where nothing expected`,
      7,
    );
  const folders = session.folders ?? new Set(),
    folder = (path) => {
      const kept = folderName(path).replace(/\/+$/, "");
      return folders.has(session.cwd ? `${session.cwd}/${kept}` : kept);
    },
    there = !!findFile(session.files, name) || folder(name);
  if (!isNew) {
    if (!there) throw new StataError(`file ${name} not found`, 601);
    return;
  }
  if (there) throw new StataError(`file ${name} already exists`, 602);
  const slash = folderName(name).lastIndexOf("/");
  if (slash > 0 && !folder(folderName(name).slice(0, slash)))
    throw new StataError(`file ${name} could not be opened`, 603);
}

/**
 * A message about a file as an SMCL paragraph: words wrapped at width, the
 * later lines indented, a word too long for a line of its own cut where
 * the line ends and continued on the next after "> ", as Stata 19 shows
 * a long file name. save's messages are {p 0 4 2} (width linesize - 2,
 * indent 4); export delimited's refusal is a plain paragraph (width
 * linesize, indent 0).
 */
export function fileMessage(text, width, indent = 0) {
  const lines = [],
    lead = " ".repeat(indent);
  let line = "",
    used = 0,
    fresh = true;
  const newLine = (more) => {
    lines.push(line);
    line = lead + more;
    used = indent + more.length;
  };
  for (const word of text.split(" ")) {
    const size = displayWidth(word);
    if (!fresh && used + 1 + size <= width) {
      line += " " + word;
      used += 1 + size;
      continue;
    }
    if (!fresh) newLine("");
    let rest = word;
    while (used + displayWidth(rest) > width) {
      const cut = truncateColumns(rest, Math.max(1, width - used)) || rest[0];
      line += cut;
      rest = rest.slice(cut.length);
      newLine("> ");
    }
    line += rest;
    used += displayWidth(rest);
    fresh = false;
  }
  lines.push(line);
  return lines.join("\n");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The text of a file as do, run, include and log read it: Stata scans for
 * an encoding only in import delimited and reads every other text file as
 * its bytes. The scan names a short ASCII file UTF-16 or UTF-32 (a 29-byte
 * do-file is UTF-16LE to it), so bytes with no zero among them that the scan
 * named so are read as the UTF-8 they are.
 */
export function plainText(stored) {
  const bytes = stored?.bytes;
  if (
    bytes instanceof Uint8Array &&
    /^UTF-(16|32)/.test(stored.encoding ?? "") &&
    !bytes.includes(0)
  )
    try {
      return strictUtf8.decode(bytes);
    } catch {
      // Not UTF-8: the scan's reading stands.
    }
  return stored?.text;
}
