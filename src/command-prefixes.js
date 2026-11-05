import { StataError } from "./expression.js";

export function commandPrefixes(source, quiet = false) {
  let command = source.trim(),
    captures = 0;
  const prefixes = [];
  for (;;) {
    const match = command.match(/^([a-z]+)\b\s*:?\s*/);
    const prefix =
      match &&
      match[1].length >= 3 &&
      ["capture", "quietly", "noisily"].find((name) =>
        name.startsWith(match[1]),
      );
    if (!prefix) break;
    if (prefixes.length === 32)
      throw new StataError("Use at most 32 command prefixes.", 901);
    prefixes.push(prefix);
    if (prefix === "capture") captures++;
    quiet = prefix !== "noisily";
    command = command.slice(match[0].length).trim();
  }
  return { command, prefixes, captures, quiet };
}

export const capturable = (error) =>
  error instanceof StataError && error.code !== 901;
