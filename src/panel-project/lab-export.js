// The do-file a student takes away from the project lab: the commands that
// ran without error, in the order the session holds them, under a header
// that Stata needs to run them from a fresh start.
import { LAB_STEPS, PANEL_LOAD, SESSION_HEADER } from "./lab-steps.js";

/** The name a student puts their own file's name in place of. */
export const PLACEHOLDER = "YOUR-FILE.dta";

/** The name the lab gives the simulated panel it offers as a download. */
export const PANEL_CSV = "panel.csv";

/**
 * The lines that load that CSV as the lab holds the panel. import delimited
 * reads fiscal_ye as a number and datadate as text such as 31dec2016; the
 * steps need the four characters MMDD and a Stata date. These are the lines
 * the lab itself writes when the CSV is opened in the page.
 */
export const PANEL_CSV_LOAD = [
  `import delimited using "${PANEL_CSV}", clear case(preserve) asdouble`,
  "tostring fiscal_ye, replace format(%04.0f)",
  'generate long datadate_days = date(datadate, "DMY")',
  "drop datadate",
  "rename datadate_days datadate",
  "format datadate %td",
];

const tidy = (text) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * The do-file. `timeline` is the session's record: entries
 * { kind: "step", step, text } for a step's run and { kind: "typed", text }
 * for a command typed in the command line that changed the session.
 * `load` is the lines that load a student's own file; without it the file
 * is the bundled panel and the use line names a placeholder.
 */
export function doFileOf({ timeline, load = "", fileName = "", date = "" }) {
  const own = !!load,
    parts = [
      [
        "* Firm-year panel: from the merged file to a results table",
        `* Written from the STATAverse project lab${date ? ` on ${date}` : ""}.`,
        "* It holds the commands that ran without error there, in order.",
        own
          ? `* It was run on ${fileName}. Put that file in Stata's working directory,\n* or give its full path in the line that loads it.`
          : `* It was run on the lab's simulated panel. To use your own merged file,\n* put its name in place of ${PLACEHOLDER} in the use line below.`,
      ].join("\n"),
      SESSION_HEADER,
    ];
  if (!own)
    parts.push(
      [
        "* the data",
        `use "${PLACEHOLDER}", clear`,
        `* The simulated panel downloaded from the lab as ${PANEL_CSV} loads with the`,
        "* lines below in place of the use line: the CSV holds fiscal_ye as a number",
        "* and datadate as text, and the steps need them as text and as a date.",
        ...PANEL_CSV_LOAD.map((line) => `* ${line}`),
      ].join("\n"),
    );
  let typed = false;
  for (const entry of timeline) {
    if (entry.kind === "typed") {
      parts.push(
        `${typed ? "" : "* typed in the command line\n"}${tidy(entry.text)}`,
      );
      typed = true;
      continue;
    }
    typed = false;
    const step = LAB_STEPS.find((each) => each.id === entry.step);
    // The bundled panel's own use line gives way to the placeholder above.
    const text = own
      ? entry.text
      : entry.text
          .split("\n")
          .filter((line) => line.trim() !== PANEL_LOAD)
          .join("\n");
    parts.push(`*** ${step.number}. ${step.title}\n${tidy(text)}`);
  }
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}
