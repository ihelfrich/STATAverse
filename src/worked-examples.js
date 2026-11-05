import catalog from "../assets/data/worked-examples.json" with { type: "json" };
export const WORKED_EXAMPLES = catalog;
export const exampleById = (id) => catalog.find((example) => example.id === id);

export function splitDoFile(source, example) {
  if (typeof source !== "string" || source.length > 200000)
    throw new Error(
      "The do-file is missing or exceeds the reader's size limit.",
    );
  const lines = source.split("\n").map((line) => line.replace(/\r$/, ""));
  const starts = [0];
  for (let i = 1; i < lines.length; i++) {
    if (
      /^\* SECTION \d+:/.test(lines[i]) ||
      (/^\*{8,}\s*$/.test(lines[i]) &&
        /^\*\s+[^*]/.test(lines[i + 1] || "") &&
        /^\*{8,}\s*$/.test(lines[i + 2] || ""))
    )
      starts.push(i);
  }
  if (starts.length !== example.sections.length)
    throw new Error(
      "The section outline and do-file do not match. Reconnect and reload the updated example.",
    );
  return starts.map((start, index) => ({
    id: index === 0 ? "preparation" : "section-" + index,
    title: example.sections[index],
    start: start + 1,
    end: starts[index + 1] ?? lines.length,
    lines: lines.slice(start, starts[index + 1] ?? lines.length),
    guide: example.guides?.[index] || null,
  }));
}
export function sourceMatches(source, query, limit = 30) {
  const needle = String(query || "")
    .trim()
    .toLocaleLowerCase();
  if (!needle) return { total: 0, matches: [] };
  const matches = [];
  let total = 0;
  source.split("\n").forEach((line, index) => {
    if (!line.toLocaleLowerCase().includes(needle)) return;
    total++;
    if (matches.length < limit)
      matches.push({ line: index + 1, text: line.trim().slice(0, 180) });
  });
  return { total, matches };
}
export function resolveSection(sections, id, hash = "") {
  const line = /^#L([1-9]\d*)$/.exec(hash);
  if (line) {
    const number = Number(line[1]);
    const index = sections.findIndex(
      (s) => number >= s.start && number <= s.end,
    );
    if (index >= 0) return { index, line: number };
  }
  const index = sections.findIndex((s) => s.id === id);
  return { index: Math.max(0, index), line: null };
}
export function exampleAddress(example, section, line = null) {
  if (
    !exampleById(example.id) ||
    !/^preparation$|^section-\d+$/.test(section.id)
  )
    throw new Error("Unknown example or section.");
  return (
    "?" +
    new URLSearchParams({ example: example.id, section: section.id }) +
    (Number.isSafeInteger(line) && line > 0 ? "#L" + line : "")
  );
}
