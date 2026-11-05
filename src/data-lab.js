import { zipSync, strToU8 } from "fflate";
import { escapeHTML as h } from "./render.js";
import {
  MERGE_SCENARIOS,
  MERGE_CODES,
  KEEP_CODES,
  auditKeys,
  mergeScenario,
  reshapeScenario,
  mergeData,
  reshapeData,
  mergeCommand,
  reshapeCommand,
  dataProject,
} from "./labs/data-model.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const valueText = (value) =>
  value === null ? "." : value === "" ? '""' : String(value);
const missing = (value) => value === null || value === "";
const joinValues = (values) => values.map(valueText).join(", ");
const plural = (n, singular, multiple = singular + "s") =>
  `${n} ${n === 1 ? singular : multiple}`;
let mode = "merge",
  sources,
  result,
  failure,
  selected = { row: 0, column: 0 };

$("#merge-example").innerHTML = MERGE_SCENARIOS.map(
  (s) => `<option value="${s.id}">${h(s.title)}</option>`,
).join("");
function mergeOptions() {
  return {
    keys: $$("#merge-keys input:checked").map((x) => x.value),
    type: $("#merge-type").value,
    keep: $("#merge-keep").value,
    overlap: $("#merge-overlap").value,
  };
}
function reshapeOptions() {
  return {
    direction: $("#reshape-direction").value,
    i: ["id"],
    j: "term",
    stubs: $$("#reshape-controls input:checked").map((x) => x.value),
  };
}
function chooseExample() {
  const scenario = MERGE_SCENARIOS.find(
    (s) => s.id === $("#merge-example").value,
  );
  for (const id of ["reverse", "duplicate", "missing"])
    $("#merge-" + id).checked = false;
  $("#merge-type").value = scenario.type;
  $("#merge-keep").value = "all";
  $("#merge-overlap").value = "master";
  $("#merge-description").textContent = scenario.description;
  $("#merge-keys").innerHTML = scenario.master.columns
    .filter((c) => scenario.using.columns.some((u) => u.name === c.name))
    .map(
      (c) =>
        `<label><input type="checkbox" name="merge-key" value="${h(c.name)}" ${scenario.keys.includes(c.name) ? "checked" : ""}> ${h(c.name)}</label>`,
    )
    .join("");
}
function syncDirection() {
  const wide = $("#reshape-direction").value === "wide";
  $("#group-stub-option").hidden = !wide;
  $("#varying-option").hidden = !wide;
  $("#varying-option").disabled = !wide;
  if (!wide) {
    $("#group-stub-option input").checked = false;
    if ($("#reshape-issue").value === "varying")
      $("#reshape-issue").value = "none";
  }
  $("#reshape-issue option[value='gap']").textContent = wide
    ? "Remove one student–term record"
    : "Remove the hours2 column";
  $("#reshape-condition").textContent = wide
    ? "A student–term pair must identify one row. Variables left outside the stubs must be constant within each student."
    : "Each student ID must identify one row. Column suffixes 1 and 2 become values of term.";
}
function tableHTML(data, side, keys = [], output = false) {
  const interactive = output && mode === "reshape";
  const caption = output
    ? "Result values; select a row or cell to trace its source"
    : `${data.title}; source row numbers are positions before the operation`;
  return `<div class="data-table-wrap" tabindex="0" role="region" aria-label="${h(output ? "Result table" : data.title + " source table")}"><table class="data-grid ${output ? "result-grid" : ""}"><caption class="sr-only">${h(caption)}</caption><thead><tr><th scope="col" class="row-position">${output && mode === "merge" ? "Trace" : "Row"}</th>${data.columns.map((c) => `<th scope="col" class="${keys.includes(c.name) ? "key-column " : ""}${c.type === "string" ? "string-value" : ""}">${h(c.name)}</th>`).join("")}</tr></thead><tbody>${data.rows.map((row, r) => `<tr data-row="${r + 1}"><th scope="row" class="row-position">${output && mode === "merge" ? `<button type="button" data-output-row="${r}" data-output-column="0" tabindex="${r === 0 ? 0 : -1}" aria-pressed="false" aria-label="Trace result row ${r + 1}">${r + 1} <span aria-hidden="true">↗</span></button>` : r + 1}</th>${data.columns.map((c, col) => `<td data-column="${h(c.name)}" class="${keys.includes(c.name) ? "key-column " : ""}${c.type === "string" ? "string-value " : ""}${missing(row[c.name]) ? "missing-value" : ""}">${interactive ? `<button type="button" data-output-row="${r}" data-output-column="${col}" tabindex="${r === 0 && col === 0 ? 0 : -1}" aria-pressed="false" aria-label="Trace ${h(c.name)}, result row ${r + 1}, value ${h(valueText(row[c.name]))}">${h(valueText(row[c.name]))}</button>` : c.name === "_merge" ? `<span class="merge-status" title="${h(MERGE_CODES[row[c.name]])}">${row[c.name]}</span>` : h(valueText(row[c.name]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function auditHTML(data, keys, uniqueRequired) {
  if (!keys.length) return "Select at least one key variable.";
  const audit = auditKeys(data, keys);
  return `<strong>${plural(audit.distinct, "distinct key")}</strong> · ${audit.unique ? "no repeated keys" : plural(audit.duplicates.length, "repeated key")}<br>${uniqueRequired ? "Unique keys required here." : "Repeated keys allowed here."}${audit.missingRows.length ? ` ${plural(audit.missingRows.length, "row")} with a missing key.` : ""}`;
}
function sourceCard(data, side, keys, required) {
  const role =
    side === "master"
      ? "Master · currently in memory"
      : side === "using"
        ? "Using · second table"
        : "Source · currently in memory";
  return `<article class="source-card" data-source="${side}"><header><span class="source-role">${role}</span><h3>${h(data.title)}</h3><p>${plural(data.rows.length, "row")} · ${h(data.unit)}</p></header>${tableHTML(data, side, keys)}<p class="key-audit">${auditHTML(data, keys, required)}</p></article>`;
}
function renderSources(options) {
  $("#source-tables").classList.toggle("single-source", mode === "reshape");
  if (mode === "merge") {
    $("#source-summary").textContent = "Key columns shaded";
    $("#source-tables").innerHTML =
      sourceCard(
        sources.master,
        "master",
        options.keys,
        options.type !== "m:1",
      ) +
      sourceCard(sources.using, "using", options.keys, options.type !== "1:m");
  } else {
    const keys =
      options.direction === "long" ? options.i : [...options.i, options.j];
    $("#source-summary").textContent =
      options.direction === "long"
        ? "One row per student"
        : "One row per student–term";
    $("#source-tables").innerHTML = sourceCard(sources, "source", keys, true);
  }
}
function markSource(side, rows, kind = "source-selected") {
  for (const position of rows)
    $(`[data-source="${side}"] tr[data-row="${position}"]`)?.classList.add(
      kind,
    );
}
function renderFailure() {
  $("#operation-error").hidden = false;
  $("#result-content").hidden = true;
  $("#result-summary").textContent = "Operation stopped";
  $("#export-data").disabled = true;
  let details = "";
  const problems = failure.details?.problems || [];
  if (mode === "merge") {
    details = problems
      .map((p) => {
        const rows = p.duplicates.flatMap((d) => d.positions);
        markSource(p.side, rows, "source-problem");
        return `<p>${h(p.side === "master" ? "Master" : "Using")}: ${p.duplicates.map((d) => `key ${h(joinValues(d.keys))} occurs in rows ${d.positions.join(", ")}`).join("; ")}.</p>`;
      })
      .join("");
  } else {
    details = problems
      .map((p) => {
        markSource("source", p.positions, "source-problem");
        return `<p>Key ${h(joinValues(p.keys))} occurs in source rows ${p.positions.join(", ")}.</p>`;
      })
      .join("");
    details += (failure.details?.varying || [])
      .map((v) => {
        markSource("source", v.positions, "source-problem");
        return `<p>For id ${h(joinValues(v.keys))}, <code>${h(v.name)}</code> differs across source rows ${v.positions.join(", ")}. Include ${h(v.name)} among the stubs if that variation belongs in the data.</p>`;
      })
      .join("");
  }
  $("#operation-error").innerHTML =
    `<strong>r(${failure.code || 198}) · ${h(failure.message)}</strong>${details}<p>The source tables are unchanged. Adjust the settings or source condition to try again.</p>`;
  $("#data-script").textContent =
    "A complete export becomes available when the operation succeeds.";
}
function renderMerge() {
  $("#merge-composition").hidden = false;
  $("#merge-composition").innerHTML = Object.entries(result.counts)
    .filter(([code, n]) => n || Number(code) <= 3)
    .map(([code, n]) => {
      const retained = KEEP_CODES[result.options.keep].includes(Number(code));
      return `<div class="merge-count code-${code}${retained ? "" : " excluded"}"><strong>${n}</strong><span>${code} · ${h(MERGE_CODES[code])}${retained ? "" : " · excluded"}</span></div>`;
    })
    .join("");
  $("#result-summary").textContent =
    `${plural(result.data.rows.length, "row")} retained${result.excluded ? ` · ${result.excluded} excluded` : ""}`;
  const matched =
    result.keptCounts[3] + result.keptCounts[4] + result.keptCounts[5];
  $("#result-explanation").textContent =
    `${plural(result.totalRows, "row")} before the retention rule; ${plural(matched, "retained row")} link both sources. ${!result.data.rows.length ? "No rows satisfy the current retention rule." : result.keptCounts[1] || result.keptCounts[2] ? "An unmatched row has missing values for variables available only from the absent source." : "Every retained row has a record in both sources."} Counts above describe the full merge, including excluded categories.`;
  const cautions = [];
  if (result.missingKeyMatches)
    cautions.push(
      `${plural(result.missingKeyMatches, "matched row")} ${result.missingKeyMatches === 1 ? "has" : "have"} a missing key. Stata matches identical missing keys; this does not establish that the records describe the same person or entity.`,
    );
  if (result.overlapping.length)
    cautions.push(
      `Overlapping non-key variables: ${result.overlapping.join(", ")}. ${result.options.overlap === "master" ? "The default keeps master values, including missing values. _merge = 3 does not rule out a conflict." : "Code 5 takes precedence when any observed values conflict, even if another missing value was filled. Missing using values never replace observed master values."}`,
    );
  if (
    $("#merge-example").value === "orders" &&
    (result.keptCounts[1] || result.keptCounts[2])
  )
    cautions.push(
      "An unmatched customer row is not an additional order. Inspect which source is absent before interpreting the row count.",
    );
  $("#result-caution").hidden = !cautions.length;
  $("#result-caution").textContent = cautions.join(" ");
  $("#selection-help").textContent =
    "Select a row number to trace both sources. ↑ and ↓ move between result rows.";
}
function renderReshape() {
  $("#merge-composition").hidden = true;
  const long = result.options.direction === "long";
  $("#result-summary").textContent =
    `${sources.rows.length} → ${plural(result.data.rows.length, "row")}`;
  $("#result-explanation").textContent =
    `The number of students stays at ${result.identifiers}. ${long ? `Term indexes ${result.periods.join(" and ")} become rows within each student.` : `Term indexes ${result.periods.join(" and ")} become suffixes on the selected measurement columns.`} ${result.missingCells ? `${plural(result.missingCells, "missing cell")} arise from an absent source column or student–term record.` : "No result cells require an absent source column or student–term record."} Existing missing values remain missing.`;
  const unused = long
    ? sources.columns
        .filter(
          (c) =>
            /^(score|hours)\d+$/.test(c.name) &&
            !result.options.stubs.some((s) => c.name.startsWith(s)),
        )
        .map((c) => c.name)
    : [];
  $("#result-caution").hidden = !unused.length;
  $("#result-caution").textContent =
    `Unselected measurement columns ${unused.join(", ")} remain separate columns and repeat within each student. Include their stub if you want them to follow the term index too.`;
  $("#selection-help").textContent =
    "Select any result cell to trace its origin. Arrow keys move between cells; Home and End move within a row.";
}
function renderMethod() {
  $("#method-content").innerHTML =
    mode === "merge"
      ? `<h3>Keys and the unit of observation</h3><p><code>master</code> is the table in memory; <code>using</code> is the table loaded by the merge command. The key can contain several variables. In <code>m:1</code>, the using key must be unique; several master rows can link to the same using record. <code>1:m</code> reverses that requirement. <code>1:1</code> requires uniqueness in both.</p><p>A key declaration is a check on these tables, not evidence that the match is substantively correct. Missing keys match identical missing keys. Review unmatched rows and overlapping values before choosing a retained sample.</p><h3>Overlapping values and _merge</h3><p>Stata normally keeps the master value of a non-key variable found in both sources. <code>update</code> fills missing master values; <code>update replace</code> also replaces conflicting observed values. Codes 1 and 2 identify unmatched rows. With update, code 4 indicates a fill without a conflict, and code 5 indicates at least one conflict, whether or not another value was filled. A retained matched sample includes codes 3, 4 and 5.</p><p>Identifying duplicates does not justify deleting them. A repeated customer ID among orders is expected; the same repeated key in a customer register requires investigation. Many-to-many merges are outside this lab.</p>`
      : `<h3>Identifiers, indexes and stubs</h3><p><code>i(id)</code> identifies the student; <code>j(term)</code> identifies the repeated measurement. In a wide table, score1 and score2 belong to the <code>score</code> stub. Reshaping long separates the suffix into term and puts both measurements in score.</p><p>Reshaping wide needs a unique student–term pair and constant values within a student for variables outside the stubs. If group changes over time, including it as a stub preserves that change in group1 and group2. Decide whether the change is valid before using this as a repair.</p><p>A larger row count after reshaping long does not mean more independent students. A missing source column or absent student–term record creates missing result cells; an observed missing value is also preserved. Select the cell to distinguish these cases.</p>`;
}
function render() {
  result = null;
  failure = null;
  selected = { row: 0, column: 0 };
  const options = mode === "merge" ? mergeOptions() : reshapeOptions();
  sources =
    mode === "merge"
      ? mergeScenario($("#merge-example").value, {
          reverse: $("#merge-reverse").checked,
          duplicate: $("#merge-duplicate").checked,
          missing: $("#merge-missing").checked,
        })
      : reshapeScenario({
          direction: options.direction,
          issue: $("#reshape-issue").value,
        });
  if (mode === "merge")
    $("#overlap-control").hidden = !sources.master.columns.some(
      (c) =>
        !options.keys.includes(c.name) &&
        sources.using.columns.some((u) => u.name === c.name),
    );
  $("#data-command").textContent =
    mode === "merge" ? mergeCommand(options) : reshapeCommand(options);
  $("#result-title").textContent =
    mode === "merge"
      ? "Merged result"
      : options.direction === "long"
        ? "Long result"
        : "Wide result";
  renderSources(options);
  renderMethod();
  try {
    result =
      mode === "merge"
        ? mergeData(sources.master, sources.using, options)
        : reshapeData(sources, options);
  } catch (error) {
    failure = error;
  }
  $('[data-jump="record-trace"]').disabled = !!failure;
  if (failure) renderFailure();
  else {
    $("#operation-error").hidden = true;
    $("#result-content").hidden = false;
    $("#export-data").disabled = false;
    if (mode === "merge") renderMerge();
    else renderReshape();
    $("#output-table").innerHTML = tableHTML(
      result.data,
      "result",
      mode === "merge" ? options.keys : ["id"],
      true,
    );
    $("#data-script").textContent = dataProject(mode, sources, result)[
      "analysis.do"
    ];
    selectOutput(0, 0);
  }
  $("#data-announcement").textContent = failure
    ? `Operation stopped: ${failure.message}`
    : `${mode === "merge" ? "Merge" : "Reshape"} result updated: ${plural(result.data.rows.length, "row")}.`;
}
function selectOutput(row, column, focus = false) {
  if (!result?.data.rows.length) {
    $("#trace-content").textContent = "No rows satisfy the retention rule.";
    return;
  }
  selected = { row, column };
  $$(".source-selected, .cell-selected, .output-selected").forEach((e) =>
    e.classList.remove("source-selected", "cell-selected", "output-selected"),
  );
  let target;
  $$("#output-table button").forEach((button) => {
    const on =
      Number(button.dataset.outputRow) === row &&
      Number(button.dataset.outputColumn) === column;
    button.tabIndex = on ? 0 : -1;
    button.setAttribute("aria-pressed", String(on));
    if (on) {
      target = button;
      button.closest("tr").classList.add("output-selected");
    }
  });
  const line = result.lineage[row],
    values = result.data.rows[row];
  if (mode === "merge") {
    markSource("master", line.master ? [line.master] : []);
    markSource("using", line.using ? [line.using] : []);
    const node = (side, pos) =>
      `<div class="trace-node ${side}-node ${pos ? "" : "absent-node"}">${side === "master" ? "Master" : "Using"}${pos ? ` row ${pos}` : " absent"}<small>${h(pos ? sources[side].title : "No source record with this key")}</small>${pos ? `<dl class="trace-values">${sources[side].columns.map((c) => `<dt>${h(c.name)}</dt><dd>${h(valueText(sources[side].rows[pos - 1][c.name]))}</dd>`).join("")}</dl>` : ""}</div>`;
    $("#trace-content").innerHTML =
      `<p class="trace-selection">Result row ${row + 1}</p><p class="trace-key">${result.options.keys.map((k) => `${h(k)} = ${h(valueText(values[k]))}`).join("<br>")}</p><div class="trace-path">${node("master", line.master)}${node("using", line.using)}</div><p class="trace-note"><code>_merge = ${values._merge}</code><br>${h(MERGE_CODES[values._merge])}</p>${line.decisions.map((d) => `<p class="trace-detail"><strong>${h(d.name)}: ${h(valueText(d.result))}</strong>Master ${h(valueText(d.master))}; using ${h(valueText(d.using))}.<br>${h(d.action)}.</p>`).join("")}`;
  } else {
    const name = result.data.columns[column].name,
      cell = line.cells[name],
      value = values[name];
    markSource("source", cell?.row ? [cell.row] : line.sourceRows);
    if (cell?.row)
      $(
        `[data-source="source"] tr[data-row="${cell.row}"] td[data-column="${cell.column}"]`,
      )?.classList.add("cell-selected");
    let explanation;
    if (cell?.row)
      explanation = `<div class="trace-node">Source row ${cell.row}<small>${h(cell.column)} = ${h(valueText(sources.rows[cell.row - 1][cell.column]))}</small></div><p class="trace-note">${missing(value) ? "The source cell exists and its value is already missing. Reshape preserves that missing value." : "This value comes directly from the highlighted source cell."}${result.options.direction === "wide" && (name === "id" || result.retained.includes(name)) ? " This identifier or retained attribute agrees across all source rows for the student." : ""}</p>`;
    else if (cell?.derived)
      explanation = `<div class="trace-node">${h(cell.derived)}<small>Derived index, not a measurement</small></div><p class="trace-note">The selected measurement columns ending in ${h(valueText(value))} supply this term. Their suffix becomes the value of term.</p>`;
    else
      explanation = `<div class="trace-node absent-node">No source cell<small>${result.options.direction === "long" ? "The corresponding measurement column is absent." : "This student's record for the corresponding term is absent."}</small></div><p class="trace-note">Reshape creates a missing value to complete the output layout. It does not supply an observed measurement.</p>`;
    $("#trace-content").innerHTML =
      `<p class="trace-selection">${h(name)} = ${h(valueText(value))}</p><p class="trace-key">Result row ${row + 1} · id ${h(valueText(values.id))}</p><div class="trace-path">${explanation}</div>`;
  }
  if (focus) target?.focus({ preventScroll: true });
}
$("#output-table").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-output-row]");
  if (button)
    selectOutput(
      Number(button.dataset.outputRow),
      Number(button.dataset.outputColumn),
    );
});
$("#output-table").addEventListener("keydown", (event) => {
  if (
    !event.target.matches("button[data-output-row]") ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  const lastRow = result.data.rows.length - 1,
    lastColumn = mode === "merge" ? 0 : result.data.columns.length - 1;
  let { row, column } = selected;
  if (event.key === "ArrowDown") row = Math.min(lastRow, row + 1);
  else if (event.key === "ArrowUp") row = Math.max(0, row - 1);
  else if (event.key === "ArrowRight")
    column = Math.min(lastColumn, column + 1);
  else if (event.key === "ArrowLeft") column = Math.max(0, column - 1);
  else if (event.key === "Home") {
    if (mode === "merge") row = 0;
    else column = 0;
  } else if (event.key === "End") {
    if (mode === "merge") row = lastRow;
    else column = lastColumn;
  } else return;
  event.preventDefault();
  selectOutput(row, column, true);
  event.target
    .closest(".data-table-wrap")
    .querySelector('[tabindex="0"]')
    ?.scrollIntoView({ block: "nearest", inline: "nearest" });
});
function setMode(next) {
  mode = next;
  for (const id of ["merge", "reshape"]) {
    $("#mode-" + id).setAttribute("aria-pressed", String(mode === id));
    $("#" + id + "-controls").hidden = mode !== id;
  }
  $("#settings-title").textContent =
    mode === "merge" ? "Merge settings" : "Reshape settings";
  render();
}
for (const id of ["merge", "reshape"])
  $("#mode-" + id).addEventListener("click", () => {
    history.replaceState(null, "", `#${id}`);
    setMode(id);
  });
window.addEventListener("hashchange", () =>
  setMode(location.hash === "#reshape" ? "reshape" : "merge"),
);
$("#merge-controls").addEventListener("change", (event) => {
  if (event.target.id === "merge-example") chooseExample();
  if (event.target.id === "merge-reverse") {
    const type = $("#merge-type").value;
    $("#merge-type").value =
      type === "m:1" ? "1:m" : type === "1:m" ? "m:1" : type;
  }
  render();
});
$("#reshape-controls").addEventListener("change", () => {
  syncDirection();
  render();
});
$("#reset-data").addEventListener("click", () => {
  if (mode === "merge") {
    $("#merge-example").value = "orders";
    chooseExample();
  } else {
    $("#reshape-direction").value = "long";
    $("#reshape-issue").value = "none";
    $$("#reshape-controls input").forEach(
      (x) => (x.checked = x.value !== "group"),
    );
    syncDirection();
  }
  render();
});
$("#export-data").addEventListener("click", () => {
  if (!result || failure) return;
  const files = Object.fromEntries(
    Object.entries(dataProject(mode, sources, result)).map(([name, text]) => [
      name,
      strToU8(text),
    ]),
  );
  const url = URL.createObjectURL(
      new Blob([zipSync(files)], { type: "application/zip" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = `stataverse-${mode}-project.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#data-announcement").textContent =
    "Project exported with source CSVs, browser result, settings and Stata do-file.";
});
$$("[data-jump]").forEach((button) =>
  button.addEventListener("click", () => {
    const target = $("#" + button.dataset.jump);
    if (!target || target.closest("[hidden]")) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  }),
);
chooseExample();
syncDirection();
setMode(location.hash === "#reshape" ? "reshape" : "merge");
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("../../service-worker.js").catch(() => {});
