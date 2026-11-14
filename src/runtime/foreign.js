// import and export for files from other programs: Excel workbooks
// (excel.js), SPSS .sav files and SAS transport files. The import and export
// commands of delimited.js still handle delimited text.
import { StataError } from "./errors.js";
import { DELIMITED_COMMANDS } from "./delimited.js";
import { exportExcel, importExcel, putexcel, readWorkbook } from "./excel.js";
import { exportSasxport, importSasxport, readXport } from "./sasxport.js";
import { importSpss, readSav } from "./spss.js";

const delimited = (name) =>
  DELIMITED_COMMANDS.find((command) => command.name === name).run;

function importCommand(session, text, ctx) {
  const m = /^\s*(\w+)\b\s*([\s\S]*)$/.exec(text);
  switch (m?.[1]) {
    case "excel":
      return importExcel(session, m[2], ctx);
    case "spss":
      return importSpss(session, m[2], ctx);
    case "sasxport5":
      return importSasxport(session, m[2], ctx, 5);
    case "sasxport8":
      return importSasxport(session, m[2], ctx, 8);
    case "sas":
      throw new StataError(
        "import sas (.sas7bdat files) is not available in the browser",
        198,
        SAS_REFUSAL,
      );
    default:
      return delimited("import")(session, text, ctx);
  }
}

function exportCommand(session, text, ctx) {
  const m = /^\s*(\w+)\b\s*([\s\S]*)$/.exec(text);
  switch (m?.[1]) {
    case "excel":
      return exportExcel(session, m[2], ctx);
    case "sasxport5":
      return exportSasxport(session, m[2], ctx, 5);
    case "sasxport8":
      return exportSasxport(session, m[2], ctx, 8);
    default:
      return delimited("export")(session, text, ctx);
  }
}

export const FOREIGN_COMMANDS = [
  { name: "import", minimum: 6, run: importCommand },
  { name: "export", minimum: 6, run: exportCommand },
  { name: "putexcel", minimum: 8, run: putexcel },
];

/** The kind of a file the Console keeps as bytes, from its name. */
export function binaryKind(name) {
  const m = /\.(xlsx|xlsm|xls|sav|zsav|xpt|v5xpt|v8xpt|xpf|sas7bdat)$/i.exec(
    name,
  );
  return m ? m[1].toLowerCase() : null;
}

const SAS_REFUSAL =
  "In SAS, write the data as a transport (.xpt) or CSV file, or in Stata run import sas and save a .dta file; then add that file.";

/**
 * Reads a file as it is added, so a damaged file is reported at once, and
 * says what it holds: the sheets of a workbook, or the size of a dataset.
 */
export function checkForeign(kind, name, file) {
  if (kind === "sas7bdat")
    throw new StataError(
      `${name}: SAS datasets (.sas7bdat) are not read in the browser`,
      198,
      SAS_REFUSAL,
    );
  if (["xlsx", "xlsm", "xls"].includes(kind)) {
    const book = readWorkbook(file, name);
    return { sheets: book.sheets.map((sheet) => sheet.name) };
  }
  const data =
    kind === "sav" || kind === "zsav"
      ? readSav(file.bytes, name)
      : readXport(file.bytes, name);
  return { rows: data.n, variables: data.variables.length };
}
