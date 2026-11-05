import { CSV_LIMITS, previewCSV } from "./csv.js";
import { createImportRecord } from "./import-library.js";
import { escapeHTML as h, fmt } from "./render.js";

export function setupImportDialog(dialog, onImport) {
  const $ = (selector) => dialog.querySelector(selector);
  let source = null,
    filename = "",
    preview = null,
    choices = [],
    readGeneration = 0;
  function status(message, failed = false) {
    $("#csv-status").textContent = message;
    $("#csv-status").classList.toggle("error", failed);
  }
  function refresh() {
    if (source === null) return;
    $("#csv-confirm").disabled = true;
    try {
      const selected = $("#csv-delimiter").value;
      const options = {
        delimiter: selected === "tab" ? "\t" : selected,
        header: $("#csv-header").checked,
        missingValues: $("#csv-missing")
          .value.split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        columns: choices,
      };
      preview = previewCSV(source, options);
      $("#csv-details").textContent =
        `${filename} · ${preview.rows.toLocaleString()} observations · ${preview.columns.length} variables${preview.blankLines ? ` · ${preview.blankLines} blank line(s) skipped` : ""}`;
      const columnMarkup = preview.columns
        .map(
          (column, i) =>
            `<div class="csv-column"><div class="csv-source-name"><strong>${h(column.label || "(empty header)")}</strong><span>Column ${i + 1} · ${column.missing} missing after conversion</span></div><label>Stata name<input data-csv-name="${i}" value="${h(column.name)}" maxlength="32" spellcheck="false"></label><label>Read as<select data-csv-type="${i}"><option value="auto" ${!choices[i]?.type ? "selected" : ""}>Automatic (${column.suggestedType === "numeric" ? "number" : "text"})</option><option value="numeric" ${choices[i]?.type === "numeric" ? "selected" : ""}>Number</option><option value="string" ${choices[i]?.type === "string" ? "selected" : ""}>Text</option></select></label><p class="csv-column-reason">${h(column.reason)}${column.renamed ? " The original heading is retained as a variable label." : ""}</p>${column.failures.length ? `<p class="csv-conversion-error">${column.invalidIndices.length} value(s) cannot be read as numbers. ${column.failures.map((f) => `Line ${f.line}: “${h(f.value.slice(0, 100))}” (${h(f.reason)})`).join("; ")}. Change the type, or explicitly identify a missing-value marker.</p>` : ""}</div>`,
        )
        .join("");
      // Keep live controls in place. Replacing them on change interrupts Tab
      // navigation and drops focus from keyboard-operated select controls.
      const rendered = document.createElement("div");
      rendered.innerHTML = columnMarkup;
      const existing = $("#csv-columns");
      if (existing.children.length !== rendered.children.length) {
        existing.replaceChildren(...rendered.children);
      } else {
        [...rendered.children].forEach((next, i) => {
          const current = existing.children[i];
          for (const selector of [".csv-source-name", ".csv-column-reason"])
            current.querySelector(selector).innerHTML =
              next.querySelector(selector).innerHTML;
          current.querySelector("input").value =
            next.querySelector("input").value;
          const select = current.querySelector("select");
          select.options[0].textContent =
            next.querySelector("option").textContent;
          select.value = next.querySelector("select").value;
          current.querySelector(".csv-conversion-error")?.remove();
          const error = next.querySelector(".csv-conversion-error");
          if (error) current.append(error);
        });
      }
      $("#csv-preview").innerHTML =
        `<table><caption>Preview after your decisions · first ${Math.min(8, preview.rows)} observations</caption><thead><tr>${preview.columns.map((c) => `<th scope="col">${h(c.name)}<small>${c.type === "numeric" ? "number" : "text"}</small></th>`).join("")}</tr></thead><tbody>${Array.from(
          { length: Math.min(8, preview.rows) },
          (_, row) =>
            `<tr>${preview.columns
              .map((column) => {
                const invalid = column.invalidIndices.includes(row),
                  value = column.values[row];
                return `<td ${invalid ? 'class="invalid-cell"' : ""}>${invalid ? `Invalid: ${h(column.rawValues[row].slice(0, 120))}` : value === null ? '<span title="Numeric missing">.</span>' : value === "" ? '<span class="empty-cell">empty</span>' : h(typeof value === "number" ? fmt(value, 6) : value.slice(0, 120))}</td>`;
              })
              .join("")}</tr>`,
        ).join("")}</tbody></table>`;
      $("#csv-preview").hidden = false;
      $("#csv-confirm").disabled = !preview.valid;
      status(
        preview.valid
          ? "Review the preview and column decisions below. Your original source will be retained."
          : "Resolve the highlighted conversion errors. Invalid values will not be silently changed to missing.",
        !preview.valid,
      );
    } catch (error) {
      preview = null;
      $("#csv-preview").hidden = true;
      status(error.message, true);
    }
  }
  $("#csv-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    const generation = ++readGeneration;
    source = null;
    preview = null;
    choices = [];
    $("#csv-confirm").disabled = true;
    $("#csv-settings").hidden = true;
    $("#csv-columns").innerHTML = "";
    $("#csv-preview").innerHTML = "";
    $("#csv-details").textContent = "";
    if (!file) return;
    try {
      if (file.size > CSV_LIMITS.bytes)
        throw new Error("Choose a UTF-8 text file no larger than 1 MB.");
      const bytes = await file.arrayBuffer();
      if (generation !== readGeneration) return;
      try {
        source = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new Error(
          "This file is not valid UTF-8 text. Export it as a UTF-8 CSV before importing.",
        );
      }
      filename = file.name;
      $("#csv-delimiter").value = "auto";
      $("#csv-header").checked = true;
      $("#csv-missing").value = "";
      $("#csv-settings").hidden = false;
      refresh();
    } catch (error) {
      status(error.message, true);
    }
  });
  for (const id of ["#csv-delimiter", "#csv-header"])
    $(id).addEventListener("change", () => {
      choices = [];
      refresh();
    });
  $("#csv-missing").addEventListener("change", refresh);
  $("#csv-columns").addEventListener("change", (event) => {
    const name = event.target.dataset.csvName;
    const type = event.target.dataset.csvType;
    if (name !== undefined)
      choices[Number(name)] = {
        ...choices[Number(name)],
        name: event.target.value,
      };
    if (type !== undefined) {
      choices[Number(type)] = { ...choices[Number(type)] };
      if (event.target.value === "auto") delete choices[Number(type)].type;
      else choices[Number(type)].type = event.target.value;
    }
    refresh();
  });
  $("#csv-confirm").addEventListener("click", () => {
    if (!preview?.valid || source === null) return;
    try {
      onImport(createImportRecord(source, filename, preview));
      dialog.close();
    } catch (error) {
      status(error.message, true);
    }
  });
  dialog.addEventListener("close", () => {
    readGeneration++;
    source = null;
    preview = null;
    choices = [];
    $("#csv-file").value = "";
    $("#csv-settings").hidden = true;
    $("#csv-columns").innerHTML = "";
    $("#csv-preview").innerHTML = "";
    $("#csv-details").textContent = "";
    status("");
    $("#csv-confirm").disabled = true;
  });
}
