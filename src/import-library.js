import { previewCSV, materializeCSV, CSVError } from "./csv.js";

export const IMPORT_LIMITS = Object.freeze({
  datasets: 3,
  totalSourceBytes: 1500000,
});
const plainObject = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = (id) => /^local_[a-f0-9]{16}$/.test(id);

export function validateImportRecord(id, value) {
  if (!validId(id) || !plainObject(value))
    throw new CSVError(
      "An imported dataset has an invalid identifier or record.",
    );
  if (
    typeof value.filename !== "string" ||
    !value.filename.trim() ||
    value.filename.length > 255
  )
    throw new CSVError(
      "An imported dataset needs a filename of at most 255 characters.",
    );
  if (typeof value.source !== "string")
    throw new CSVError("The imported source text is missing.");
  if (
    typeof value.header !== "boolean" ||
    ![",", ";", "\t"].includes(value.delimiter)
  )
    throw new CSVError("The imported delimiter or header decision is invalid.");
  if (
    !Array.isArray(value.columns) ||
    value.columns.length < 1 ||
    value.columns.length > 50 ||
    value.columns.some(
      (c) =>
        !plainObject(c) ||
        typeof c.name !== "string" ||
        !["numeric", "string"].includes(c.type),
    )
  )
    throw new CSVError("The imported column decisions are invalid.");
  if (!Array.isArray(value.missingValues))
    throw new CSVError("The imported missing-value decisions are invalid.");
  if (
    typeof value.importedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.importedAt) ||
    !Number.isFinite(Date.parse(value.importedAt))
  )
    throw new CSVError("The import date is invalid.");
  const record = {
    filename: value.filename,
    source: value.source,
    delimiter: value.delimiter,
    header: value.header,
    missingValues: [...value.missingValues],
    columns: value.columns.map((c) => ({ name: c.name, type: c.type })),
    importedAt: value.importedAt,
  };
  const preview = previewCSV(record.source, record);
  if (preview.columns.length !== record.columns.length)
    throw new CSVError(
      "The imported column decisions do not match the source file.",
    );
  if (!preview.valid)
    throw new CSVError(
      "An imported numeric column still contains unresolved conversion errors.",
    );
  return record;
}

export function validateImportLibrary(value = {}) {
  if (!plainObject(value))
    throw new CSVError("The imported-data library has an invalid format.");
  const entries = Object.entries(value);
  if (entries.length > IMPORT_LIMITS.datasets)
    throw new CSVError(
      "Keep at most three imported datasets in browser practice. Export a project before removing an older import.",
    );
  let bytes = 0;
  const records = entries.map(([id, candidate]) => {
    const record = validateImportRecord(id, candidate);
    bytes += new TextEncoder().encode(record.source).length;
    if (bytes > IMPORT_LIMITS.totalSourceBytes)
      throw new CSVError(
        "The imported sources together exceed the 1.5 MB local library limit.",
      );
    return [id, record];
  });
  return Object.fromEntries(records);
}

export function createImportRecord(
  source,
  filename,
  preview,
  importedAt = new Date().toISOString(),
) {
  if (!preview.valid)
    throw new CSVError("Resolve the import preview’s conversion errors first.");
  return {
    source,
    filename,
    delimiter: preview.delimiter,
    header: preview.header,
    missingValues: [...preview.missingValues],
    columns: preview.columns.map((c) => ({ name: c.name, type: c.type })),
    importedAt,
  };
}

export function importCatalog(records) {
  return Object.fromEntries(
    Object.entries(records).map(([id, record]) => {
      const preview = previewCSV(record.source, record);
      return [
        id,
        {
          id,
          file: id + ".csv",
          title: record.filename,
          unit: "One imported record",
          description: `Imported locally from ${record.filename}. ${preview.blankLines ? `${preview.blankLines} blank physical line(s) were skipped. ` : ""}Original source text and import decisions are retained for export. These are your supplied data; their content has not been independently verified.`,
          synthetic: false,
          data: materializeCSV(preview, id),
          record,
        },
      ];
    }),
  );
}

export function nativeImportOptions(data) {
  const strings = [],
    numbers = [];
  data.columns.forEach((column, i) =>
    (column.type === "string" ? strings : numbers).push(i + 1),
  );
  return [
    "clear",
    "varnames(1)",
    "case(preserve)",
    "asdouble",
    'encoding("utf-8")',
    "bindquotes(strict)",
    "maxquotedrows(unlimited)",
    ...(strings.length ? [`stringcols(${strings.join(" ")})`] : []),
    ...(numbers.length ? [`numericcols(${numbers.join(" ")})`] : []),
  ].join(" ");
}

export function nativeImportCommand(file, data) {
  if (!/^[A-Za-z0-9_-]+\.csv$/.test(file))
    throw new CSVError("The normalized export filename is invalid.");
  return `import delimited using "${file}", ${nativeImportOptions(data)}`;
}
