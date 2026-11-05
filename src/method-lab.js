import {
  METHOD_GROUPS,
  compareMethods,
  comparisonQuery,
  methodPlanText,
} from "./method-comparison.js";
import { escapeHTML as h } from "./render.js";
const $ = (selector) => document.querySelector(selector);
let comparison = compareMethods({});
let revision = 0;
$("#method-questions").innerHTML = METHOD_GROUPS.map(
  (group, i) =>
    `<div class="method-question"><label for="method-${group.id}"><span aria-hidden="true">0${i + 1}</span>${h(group.title)}</label><p>${h(group.subtitle)}</p><select id="method-${group.id}" name="${group.id}" aria-describedby="method-hint-${group.id}"><option value="">Select…</option>${group.options.map((o) => `<option value="${o.id}">${h(o.label)}</option>`).join("")}</select><p id="method-hint-${group.id}" class="method-hint"></p></div>`,
).join("");
function render({ updateURL = true } = {}) {
  revision++;
  const selections = Object.fromEntries(
    METHOD_GROUPS.map((g) => [g.id, $(`#method-${g.id}`).value]),
  );
  comparison = compareMethods(selections);
  for (const g of METHOD_GROUPS) {
    const option = g.options.find((o) => o.id === comparison.selections[g.id]);
    $(`#method-hint-${g.id}`).textContent = option?.hint || "";
  }
  if (updateURL) {
    const query = comparisonQuery(comparison.selections);
    history.replaceState(
      null,
      "",
      location.pathname + (query ? "?" + query : ""),
    );
  }
  const ready = comparison.missing.length === 0;
  $("#method-results").hidden = !ready;
  $("#method-jump").hidden = !ready;
  $("#method-empty").hidden = ready;
  $("#method-copy").disabled = $("#method-download").disabled = !ready;
  $("#method-action-status").textContent = "";
  $("#method-copy-label").hidden = $("#method-copy-fallback").hidden = true;
  $("#method-copy-fallback").value = "";
  if (!ready) {
    $("#method-status").textContent =
      "Still needed: " + comparison.missing.join("; ") + ".";
    return;
  }
  $("#method-status").textContent =
    `${comparison.methods.length} specifications to examine. Their assumptions and targets may differ.`;
  $("#method-notices").innerHTML = comparison.notices
    .map(
      (n) =>
        `<section class="method-notice ${n.kind}"><h3>${h(n.title)}</h3><p>${h(n.text)}</p></section>`,
    )
    .join("");
  $("#method-index").innerHTML = comparison.methods
    .map((m) => `<a href="#method-card-${m.id}">${h(m.title)}</a>`)
    .join("");
  $("#method-cards").innerHTML = comparison.methods
    .map(
      (m, i) =>
        `<article class="method-specification" id="method-card-${m.id}" aria-labelledby="method-title-${m.id}"><div class="method-specification-heading"><span class="method-number" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><div><p class="eyebrow">${h(m.category)}</p><h3 id="method-title-${m.id}">${h(m.title)}</h3></div></div><p>${h(m.why)}</p><p class="method-scope">${h(m.scope)}</p><h4>Conditions to examine</h4><ul>${m.assumptions.map((a) => `<li>${h(a)}</li>`).join("")}</ul><details class="method-code"><summary>Stata syntax and checks${m.blocked ? " · inference unresolved" : ""}</summary><p>Replace the variable names with your own. These templates require full Stata; they do not run in the browser practice interpreter.</p><pre tabindex="0" role="region" aria-label="${h(m.title)} Stata template"><code>${h(m.code)}</code></pre><p><strong>Checks.</strong> ${h(m.diagnostic)}</p><p><strong>Limit.</strong> ${h(m.pitfall)}</p></details><div class="method-related">${(m.links || []).map((l) => `<a href="${h(l.href)}">${h(l.label)} →</a>`).join("")}</div></article>`,
    )
    .join("");
}
function readURL() {
  const parsed = compareMethods(
    Object.fromEntries(new URLSearchParams(location.search)),
  );
  for (const group of METHOD_GROUPS)
    $(`#method-${group.id}`).value = parsed.selections[group.id];
  render({ updateURL: false });
}
$("#method-form").addEventListener("submit", (event) => event.preventDefault());
$("#method-form").addEventListener("change", () => render());
$("#method-form").addEventListener("reset", (event) => {
  event.preventDefault();
  for (const group of METHOD_GROUPS) $(`#method-${group.id}`).value = "";
  render();
});
window.addEventListener("popstate", readURL);
const text = () =>
  methodPlanText(
    comparison,
    new URL("?" + comparisonQuery(comparison.selections), location.href).href,
  );
$("#method-copy").addEventListener("click", async () => {
  const value = text();
  const copiedRevision = revision;
  try {
    await navigator.clipboard.writeText(value);
    if (copiedRevision !== revision) return;
    $("#method-action-status").textContent =
      "Comparison copied, including assumptions, limitations and a link to reopen it.";
  } catch {
    if (copiedRevision !== revision) return;
    $("#method-action-status").textContent =
      "Copy is unavailable. Download the comparison or select the text below.";
    $("#method-copy-label").hidden = $("#method-copy-fallback").hidden = false;
    $("#method-copy-fallback").value = value;
    $("#method-copy-fallback").focus();
    $("#method-copy-fallback").select();
  }
});
$("#method-download").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([text()], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "stataverse-method-comparison.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#method-action-status").textContent =
    "Comparison prepared with assumptions, limitations and a link to reopen it. Check your downloads.";
});
readURL();
$("#method-fields").disabled = false;
$("#method-reset").disabled = false;
$("#method-loading").hidden = true;
