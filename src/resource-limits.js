export const RESOURCE_LIMITS = Object.freeze({
  fieldCharacters: 10000,
  dataCharacters: 2000000,
  historyCharacters: 1000000,
  undoBytes: 32000000,
  resultBytes: 16000000,
  timelineBytes: 8000000,
});

/** Conservative structural estimate, not a measurement of the browser heap. */
export function estimatedBytes(value) {
  const pending = [value],
    seen = new WeakSet();
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") bytes += 2 * item.length;
    else if (item && typeof item === "object") {
      if (seen.has(item)) continue;
      seen.add(item);
      bytes += 32;
      if (Array.isArray(item)) {
        bytes += 8 * item.length;
        for (const v of item) pending.push(v);
      } else
        for (const [key, v] of Object.entries(item)) {
          bytes += 2 * key.length + 8;
          pending.push(v);
        }
    } else bytes += 8;
  }
  return bytes;
}

export function dataResourceError(data) {
  let characters = 0;
  for (const column of data.columns) {
    characters += column.label?.length || 0;
    if ((column.label?.length || 0) > RESOURCE_LIMITS.fieldCharacters)
      return "A variable label exceeds the browser limit of 10,000 characters.";
  }
  for (const row of data.rows)
    for (const column of data.columns) {
      const value = row[column.name];
      if (typeof value !== "string") continue;
      if (value.length > RESOURCE_LIMITS.fieldCharacters)
        return "A string value exceeds the browser limit of 10,000 characters.";
      characters += value.length;
      if (characters > RESOURCE_LIMITS.dataCharacters)
        return "The working dataset would exceed 2 million text characters. Use a smaller selection or continue this transformation in Stata.";
    }
  return null;
}
