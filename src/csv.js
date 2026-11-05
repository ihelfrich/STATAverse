/** Bounded, local-only delimited text ingestion. No evaluation or silent coercion. */
export const CSV_LIMITS = Object.freeze({
  bytes: 1000000,
  rows: 5000,
  columns: 50,
  cells: 100000,
  fieldLength: 10000,
});
const delimiters = [",", "\t", ";"];
const numericPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const reservedNames = new Set([
  "_n",
  "_N",
  "_rc",
  "_all",
  "_cons",
  "__proto__",
  "constructor",
  "prototype",
]);

export class CSVError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = "CSVError";
    this.line = line;
  }
}

export function parseDelimited(source, delimiter = ",") {
  if (typeof source !== "string")
    throw new CSVError("The file must contain text.");
  if (!delimiters.includes(delimiter))
    throw new CSVError("Choose comma, tab or semicolon as the delimiter.");
  if (new TextEncoder().encode(source).length > CSV_LIMITS.bytes)
    throw new CSVError("The file exceeds the 1 MB browser practice limit.");
  if (source.includes("\0"))
    throw new CSVError(
      "The file contains null bytes. Export a UTF-8 text CSV, rather than a spreadsheet workbook or UTF-16 file.",
    );
  const text = source.replace(/^\uFEFF/, "");
  const records = [],
    lines = [];
  let row = [],
    field = "",
    state = "start",
    line = 1,
    recordLine = 1,
    recordHasContent = false,
    blankLines = 0,
    cells = 0;
  function pushField() {
    row.push(field);
    if (row.length > CSV_LIMITS.columns)
      throw new CSVError(
        "The file exceeds the 50-column browser practice limit.",
        recordLine,
      );
    field = "";
    state = "start";
  }
  function pushRecord() {
    if (!recordHasContent && row.length === 0 && field === "") {
      blankLines++;
      return;
    }
    pushField();
    cells += row.length;
    if (cells > CSV_LIMITS.cells + CSV_LIMITS.columns)
      throw new CSVError(
        "The file exceeds the 100,000-cell browser practice limit.",
        recordLine,
      );
    records.push(row);
    lines.push(recordLine);
    if (records.length > CSV_LIMITS.rows + 1)
      throw new CSVError(
        "The file exceeds the 5,000-observation browser practice limit.",
        recordLine,
      );
    row = [];
    recordHasContent = false;
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === "quoted") {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else state = "closed";
      } else {
        field += char;
        if (char === "\n" || (char === "\r" && text[i + 1] !== "\n")) line++;
      }
    } else if (char === delimiter) {
      recordHasContent = true;
      pushField();
    } else if (char === "\r" || char === "\n") {
      pushRecord();
      if (char === "\r" && text[i + 1] === "\n") i++;
      line++;
      recordLine = line;
      state = "start";
    } else if (state === "closed") {
      if (char !== " " && char !== "\t")
        throw new CSVError(
          "Unexpected text after a closing quote. A quoted field must end before the next delimiter.",
          line,
        );
    } else if (char === '"') {
      if (state !== "start")
        throw new CSVError(
          "A quote appeared inside an unquoted field. Quote the entire field and double any embedded quotes.",
          line,
        );
      state = "quoted";
      recordHasContent = true;
    } else {
      field += char;
      state = "unquoted";
      recordHasContent = true;
    }
    if (field.length > CSV_LIMITS.fieldLength)
      throw new CSVError(
        "A field exceeds the 10,000-character limit.",
        recordLine,
      );
  }
  if (state === "quoted")
    throw new CSVError(
      "A quoted field was not closed before the end of the file.",
      recordLine,
    );
  if (recordHasContent || row.length || field.length) pushRecord();
  if (!records.length) throw new CSVError("The file contains no records.");
  const width = records[0].length;
  for (let i = 1; i < records.length; i++)
    if (records[i].length !== width)
      throw new CSVError(
        `Expected ${width} fields but found ${records[i].length}. Check the delimiter and quoted fields.`,
        lines[i],
      );
  return { records, lines, delimiter, blankLines };
}

export function detectDelimiter(source) {
  const candidates = delimiters.flatMap((delimiter) => {
    try {
      const parsed = parseDelimited(source, delimiter);
      return [{ delimiter, columns: parsed.records[0].length }];
    } catch {
      return [];
    }
  });
  const multi = candidates.filter((c) => c.columns > 1);
  if (multi.length === 1) return multi[0].delimiter;
  if (multi.length > 1)
    throw new CSVError(
      "More than one delimiter gives a consistent table. Choose comma, tab or semicolon explicitly.",
    );
  // A single-column CSV is valid. Parsing it as comma also supplies a useful error for malformed files.
  if (candidates.some((c) => c.delimiter === ",")) return ",";
  parseDelimited(source, ",");
  throw new CSVError(
    "The delimiter could not be identified. Choose it explicitly.",
  );
}

export function validVariableName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name) &&
    !reservedNames.has(name)
  );
}

function proposedNames(headers) {
  const used = new Set();
  return headers.map((header, i) => {
    let base = header
      .trim()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9_]/g, "_");
    if (!base || /^_+$/.test(base)) base = `v${i + 1}`;
    if (/^[0-9]/.test(base)) base = "v_" + base;
    base = base.slice(0, 32);
    if (reservedNames.has(base)) base = "v" + base.slice(0, 31);
    let name = base,
      suffix = 2;
    while (used.has(name)) {
      const ending = "_" + suffix++;
      name = base.slice(0, 32 - ending.length) + ending;
    }
    used.add(name);
    return name;
  });
}

function numericValue(text) {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === ".") return { value: null };
  if (!numericPattern.test(trimmed)) return { error: "not a decimal number" };
  const value = Number(trimmed);
  if (!Number.isFinite(value))
    return { error: "outside the finite numeric range" };
  if (/^[+-]?\d+(?:\.0*)?$/.test(trimmed) && !Number.isSafeInteger(value))
    return {
      error: "an integer too large to preserve exactly as a browser number",
    };
  if (value === 0 && /[1-9]/.test(trimmed.split(/[eE]/)[0]))
    return { error: "too small to represent without rounding to zero" };
  return { value };
}

function suggestType(values, missingValues) {
  const observed = values.filter(
    (v) => v.trim() !== "" && v.trim() !== "." && !missingValues.includes(v),
  );
  if (!observed.length)
    return {
      type: "string",
      reason: "No observed numeric values establish a type; review the choice.",
    };
  if (observed.some((v) => /^[+-]?0\d/.test(v.trim())))
    return {
      type: "string",
      reason: "Leading zeros were retained. These values may be identifiers.",
    };
  const invalid = observed.find((v) => numericValue(v).error);
  if (invalid !== undefined)
    return {
      type: "string",
      reason:
        "Text or numbers requiring an explicit precision decision are present.",
    };
  return {
    type: "numeric",
    reason:
      "Every observed value is a finite decimal number; blank fields and dots become numeric missing.",
  };
}

export function previewCSV(source, options = {}) {
  const delimiter =
    options.delimiter === undefined || options.delimiter === "auto"
      ? detectDelimiter(source)
      : options.delimiter;
  const parsed = parseDelimited(source, delimiter);
  const header = options.header !== false;
  const headers = header
    ? parsed.records[0]
    : parsed.records[0].map((_, i) => `v${i + 1}`);
  const records = header ? parsed.records.slice(1) : parsed.records;
  const sourceLines = header ? parsed.lines.slice(1) : parsed.lines;
  if (!records.length)
    throw new CSVError("The file has a header but no observations.");
  if (
    records.length > CSV_LIMITS.rows ||
    records.length * headers.length > CSV_LIMITS.cells
  )
    throw new CSVError(
      "The data exceed the 5,000-observation or 100,000-cell browser practice limit.",
    );
  const missingValues = options.missingValues || [];
  if (
    !Array.isArray(missingValues) ||
    missingValues.length > 10 ||
    missingValues.some((v) => typeof v !== "string" || v.length > 50)
  )
    throw new CSVError(
      "Use at most ten missing-value markers, each up to 50 characters.",
    );
  const names = proposedNames(headers);
  const columns = headers.map((label, i) => {
    const values = records.map((row) => row[i]);
    const suggestion = suggestType(values, missingValues);
    const choice = options.columns?.[i] || {};
    const type = choice.type || suggestion.type;
    const name = choice.name ?? names[i];
    if (!validVariableName(name))
      throw new CSVError(
        `Column ${i + 1} needs a valid Stata name (letters, digits and underscores; at most 32 characters).`,
      );
    if (!["numeric", "string"].includes(type))
      throw new CSVError(`Column ${i + 1} has an invalid type.`);
    const failures = [];
    const invalidIndices = [];
    const converted = values.map((value, j) => {
      if (missingValues.includes(value)) return type === "numeric" ? null : "";
      if (type === "string") return value;
      const parsed = numericValue(value);
      if (parsed.error) invalidIndices.push(j);
      if (parsed.error && failures.length < 5)
        failures.push({ line: sourceLines[j], value, reason: parsed.error });
      return parsed.value ?? null;
    });
    return {
      name,
      label,
      type,
      suggestedType: suggestion.type,
      reason: suggestion.reason,
      renamed: name !== label,
      sourceIndex: i,
      missing: converted.filter((v) => v === null || v === "").length,
      failures,
      invalidIndices,
      rawValues: values,
      values: converted,
    };
  });
  if (new Set(columns.map((c) => c.name)).size !== columns.length)
    throw new CSVError(
      "Variable names must be unique. Rename the repeated columns.",
    );
  return {
    delimiter,
    header,
    missingValues: [...missingValues],
    columns,
    rows: records.length,
    blankLines: parsed.blankLines,
    sourceLines,
    valid: columns.every((c) => !c.failures.length),
  };
}

export function materializeCSV(preview, id) {
  if (!preview.valid)
    throw new CSVError(
      "Resolve the numeric conversion errors before importing. Invalid text will not be silently changed to missing.",
    );
  return {
    id,
    columns: preview.columns.map(({ name, label, type }) => ({
      name,
      label,
      type,
    })),
    rows: Array.from({ length: preview.rows }, (_, i) =>
      Object.fromEntries(
        preview.columns.map((column) => [column.name, column.values[i]]),
      ),
    ),
  };
}
