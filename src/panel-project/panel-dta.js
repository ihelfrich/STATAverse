// The simulated panel in the two forms a Console session reads: the bytes of
// a .dta file, which keep every storage type, the %td date and the labels,
// and (from panel-data.js) CSV text.
import { Dataset } from "../runtime/store.js";
import { MISSING } from "../runtime/values.js";
import { writeDta } from "../console-dta.js";
import { buildPanel } from "./panel-data.js";

export const PANEL_FILE = "panel.dta";

// A fixed time stamp, so that the same panel is the same bytes every time.
const STAMP = new Date(2026, 0, 1, 12, 0);

/** The panel as a runtime Dataset. */
export function panelDataset(panel = buildPanel()) {
  const data = new Dataset();
  data.setObservations(panel.observations);
  for (const v of panel.variables) {
    if (v.string)
      data.generate(v.name, v.values, { type: v.type, string: true });
    else {
      const values = new Float64Array(panel.observations);
      for (let row = 0; row < values.length; row++)
        values[row] = Number.isNaN(v.values[row]) ? MISSING : v.values[row];
      data.generate(v.name, values, { type: v.type });
    }
    const made = data.get(v.name);
    made.format = v.format;
    made.label = v.label;
  }
  data.label = panel.label;
  return data;
}

/**
 * The panel as the bytes of a .dta file. Give them to a session with
 * session.addData(PANEL_FILE, bytes), then run: use "panel.dta", clear
 */
export function panelDta(panel = buildPanel()) {
  const data = panelDataset(panel);
  return writeDta(
    { ...data.snapshot(), notes: data.notes, chars: data.chars },
    STAMP,
  );
}
