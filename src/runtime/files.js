// Finding a file in the session's folder. Names are matched without regard
// to case when no file has the exact name, as Stata finds them on macOS and
// Windows: `use left` opens Left.dta there.

/** The name a file is kept under, or "" when there is none. */
export function findFile(files, name) {
  if (!files || !name) return "";
  if (files.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of files.keys()) if (key.toLowerCase() === lower) return key;
  return "";
}
