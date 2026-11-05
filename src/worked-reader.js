import {
  WORKED_EXAMPLES,
  exampleById,
  splitDoFile,
  sourceMatches,
  resolveSection,
  exampleAddress,
} from "./worked-examples.js";
import { WORKED_EXAMPLE_HASHES } from "./worked-example-hashes.js";
import { escapeHTML as h } from "./render.js";
const $ = (s) => document.querySelector(s);
const cache = new Map(),
  answers = new Map();
let state = null,
  generation = 0,
  controller = null;
const ordinaryClick = (event) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey;
const navigate = (address) => {
  if (
    location.pathname + location.search + location.hash !==
    location.pathname + address
  )
    history.pushState(null, "", location.pathname + address);
};
function clearActions() {
  $("#example-download").disabled = $("#example-copy").disabled = true;
  $("#example-action-status").textContent = "";
  $("#example-copy-fallback").hidden = true;
  $("#example-copy-text").value = "";
}
function showLibrary() {
  generation++;
  controller?.abort();
  state = null;
  $("#example-library").hidden = false;
  $("#example-reader").hidden = true;
  document.title = "Worked Stata examples · STATAverse";
  clearActions();
}
function validOutput(value, hash) {
  if (
    value?.sourceSha256 !== hash ||
    !Array.isArray(value.rows) ||
    value.rows.length !== 17
  )
    return false;
  const expected = new Set(
    ["pooled", "fe", "re"].flatMap((model) =>
      ["experience", "competition", "innovation"].map(
        (term) => model + ":" + term,
      ),
    ),
  );
  for (const term of ["experience", "competition", "innovation"])
    for (const part of ["within", "mean"])
      expected.add("hybrid:" + term + "_" + part);
  expected.add("dynamic_ab:L.y");
  expected.add("dynamic_ab:x");
  return (
    value.rows.every(
      (row) =>
        Number.isFinite(row.b) &&
        Number.isFinite(row.se) &&
        row.se > 0 &&
        expected.delete(row.model + ":" + row.term),
    ) && expected.size === 0
  );
}
async function getSource(example, signal) {
  if (cache.has(example.id)) return cache.get(example.id);
  const response = await fetch("scripts/" + example.file, { signal });
  if (!response.ok)
    throw new Error(
      "This do-file could not be loaded. Reconnect and retry; previously viewed files may be available offline.",
    );
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 200000)
    throw new Error("The downloaded file exceeds the reader's size limit.");
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hash = Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== WORKED_EXAMPLE_HASHES[example.id])
    throw new Error(
      "The do-file and reader are different versions. Reconnect and reload this page before continuing.",
    );
  const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  const result = {
    source,
    sections: splitDoFile(source, example),
    output: null,
  };
  if (example.id === "panel") {
    try {
      const response = await fetch("../assets/data/panel-output.json", {
        signal,
      });
      if (response.ok) {
        const output = await response.json();
        if (validOutput(output, hash)) result.output = output;
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
    }
  }
  cache.set(example.id, result);
  return result;
}
function renderNative() {
  const region = $("#example-native-output"),
    table = $("#example-native-table");
  region.hidden =
    state.example.id !== "panel" || ![2, 3, 4, 7, 8].includes(state.index);
  $("#example-output-jump").hidden = region.hidden;
  if (region.hidden) {
    table.replaceChildren();
    return;
  }
  if (!state.output) {
    table.textContent =
      "Reference estimates are unavailable for this file. Reconnect and reload to retrieve the matching reference.";
    return;
  }
  const dynamic = state.index === 7;
  const terms = dynamic
    ? [
        ["L.y", "Lagged y"],
        ["x", "Current x"],
      ]
    : [
        ["experience", "Experience"],
        ["competition", "Competition"],
        ["innovation", "Innovation"],
      ];
  const columns = dynamic
    ? [["dynamic_ab", "", "Dynamic AB"]]
    : [
        ["pooled", "", "Pooled"],
        ["fe", "", "FE"],
        ["re", "", "RE"],
        ["hybrid", "_within", "Within"],
        ["hybrid", "_mean", "Between"],
      ];
  table.innerHTML = `<table class="${dynamic ? "dynamic" : "static"}"><caption>${dynamic ? "Separate dynamic process: coefficients and standard errors." : "Static panel: 200 firms, 10 years. Standard errors are in parentheses."}</caption><thead><tr><th scope="col">Regressor</th>${columns.map(([, , title]) => `<th scope="col">${h(title)}</th>`).join("")}</tr></thead><tbody>${terms
    .map(
      ([term, label]) =>
        `<tr><th scope="row">${h(label)}</th>${columns
          .map(([model, suffix]) => {
            const row = state.output.rows.find(
              (r) => r.model === model && r.term === term + suffix,
            );
            return `<td>${row.b.toFixed(3)}<span>(${row.se.toFixed(3)})</span></td>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}
function questionKey() {
  return state.example.id + ":" + state.index;
}
function renderFeedback() {
  const question = state.sections[state.index].guide?.question;
  if (!question) return;
  const answer = answers.get(questionKey());
  $("#example-check").disabled = answer?.choice === undefined;
  const feedback = $("#example-feedback");
  feedback.className = "";
  feedback.textContent = "";
  if (!answer?.checked) return;
  const correct = answer.choice === question.correct;
  feedback.className = correct ? "correct" : "revise";
  feedback.textContent =
    (correct ? "Correct. " : "The answer needs revising. ") +
    question.feedback[answer.choice];
}
function renderSection({ focus = false } = {}) {
  if (!state) return;
  const section = state.sections[state.index];
  $("#example-section-position").textContent =
    state.index === 0
      ? "Preparation"
      : `Section ${state.index} of ${state.sections.length - 1}`;
  $("#example-section-title").textContent = section.title;
  $("#example-scope").textContent = state.example.scope;
  $("#example-explanation").hidden = !section.guide?.explanation;
  $("#example-explanation").textContent = section.guide?.explanation || "";
  $("#example-line-range").textContent =
    `Lines ${section.start}–${section.end}`;
  $("#example-source").innerHTML = section.lines
    .map((line, i) => {
      const number = section.start + i;
      return `<span id="code-L${number}" class="code-source-line${/^\s*\*/.test(line) ? " comment" : ""}${number === state.line ? " selected" : ""}"><span class="code-line-number" aria-hidden="true">${number}</span>${h(line) || " "}</span>`;
    })
    .join("");
  $("#example-source").scrollTop = 0;
  $("#example-source").scrollLeft = 0;
  $("#example-sections").innerHTML = state.sections
    .map(
      (s, i) =>
        `<a href="${exampleAddress(state.example, s)}" data-section="${i}"${i === state.index ? ' aria-current="step"' : ""}><span aria-hidden="true">${i === 0 ? "—" : String(i).padStart(2, "0")}</span><span>${h(s.title)}</span></a>`,
    )
    .join("");
  $("#example-previous").disabled = state.index === 0;
  $("#example-next").disabled = state.index === state.sections.length - 1;
  const question = section.guide?.question;
  $("#example-question").hidden = !question;
  $("#example-question-jump").hidden = !question;
  $("#example-question-title").textContent = question?.prompt || "";
  const answer = answers.get(questionKey());
  $("#example-options").innerHTML = question
    ? question.options
        .map(
          (text, i) =>
            `<label><input type="radio" name="example-interpretation" value="${i}"${answer?.choice === i ? " checked" : ""} /><span>${h(text)}</span></label>`,
        )
        .join("")
    : "";
  renderFeedback();
  renderNative();
  if (focus) {
    if (state.line) {
      $("#example-source").focus();
      $("#code-L" + state.line).scrollIntoView({ block: "center" });
    } else {
      $("#example-section-title").focus();
      $("#example-section-title").scrollIntoView({ block: "start" });
    }
  }
}
function selectSection(index, line = null, focus = true) {
  if (!state || !state.sections[index]) return;
  state.index = index;
  state.line = line;
  navigate(exampleAddress(state.example, state.sections[index], line));
  renderSection({ focus });
}
async function readLocation({ focus = false, retry = false } = {}) {
  const query = new URLSearchParams(location.search),
    id = query.get("example");
  if (!id) {
    showLibrary();
    return;
  }
  if (state?.example.id === id && !retry) {
    Object.assign(
      state,
      resolveSection(state.sections, query.get("section"), location.hash),
    );
    renderSection({ focus });
    return;
  }
  const token = ++generation;
  controller?.abort();
  controller = new AbortController();
  state = null;
  const example = exampleById(id);
  $("#example-library").hidden = true;
  $("#example-reader").hidden = false;
  $("#example-content").hidden = true;
  $("#example-retry").hidden = true;
  clearActions();
  $("#example-title").textContent = example?.title || "Example not found";
  $("#example-summary").textContent =
    example?.summary ||
    "Choose a worked example from the library. No do-file was loaded for this address.";
  $("#example-level").textContent = example?.level || "Worked Stata examples";
  document.title = (example?.title || "Example not found") + " · STATAverse";
  for (const kind of ["prerequisite", "companion"]) {
    const link = $("#example-" + kind);
    link.hidden = !example;
    if (example) {
      link.textContent = example[kind].label + " →";
      link.href = example[kind].href;
    }
  }
  $("#example-load-status").textContent = example ? "Loading the do-file…" : "";
  if (!example) return;
  try {
    const loaded = await getSource(example, controller.signal);
    if (token !== generation) return;
    state = {
      example,
      ...loaded,
      ...resolveSection(loaded.sections, query.get("section"), location.hash),
    };
    $("#example-content").hidden = false;
    $("#example-load-status").textContent = "";
    $("#example-download").disabled = $("#example-copy").disabled = false;
    $("#example-switch").value = example.id;
    $("#example-search").value = "";
    $("#example-search-status").textContent = "";
    $("#example-matches").replaceChildren();
    const focusSection = Boolean(state.line) || Boolean(query.get("section"));
    renderSection({ focus: focus && focusSection });
    if (!focus && focusSection) {
      $(
        state.line ? "#code-L" + state.line : "#example-section-title",
      ).scrollIntoView({ block: state.line ? "center" : "start" });
    }
    if (focus && !focusSection) {
      $("#example-title").focus();
      $("#example-title").scrollIntoView({ block: "start" });
    }
  } catch (error) {
    if (token !== generation || error.name === "AbortError") return;
    $("#example-load-status").textContent =
      error.message || "The example could not be loaded. Reconnect and retry.";
    $("#example-retry").hidden = false;
  }
}
function openExample(id) {
  navigate("?" + new URLSearchParams({ example: id }));
  void readLocation({ focus: true });
}
$("#example-switch").innerHTML = WORKED_EXAMPLES.map(
  (e) => `<option value="${e.id}">${h(e.title)}</option>`,
).join("");
$(".example-list").addEventListener("click", (event) => {
  const link = event.target.closest('a[href^="?example="]');
  if (!link || !ordinaryClick(event)) return;
  event.preventDefault();
  openExample(new URL(link.href).searchParams.get("example"));
});
$("#example-back").addEventListener("click", (event) => {
  if (!ordinaryClick(event)) return;
  event.preventDefault();
  navigate("");
  showLibrary();
  $("#library-title").focus();
  $("#library-title").scrollIntoView({ block: "start" });
});
$("#example-switch").addEventListener("change", (event) =>
  openExample(event.target.value),
);
$("#example-sections").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-section]");
  if (!link || !ordinaryClick(event)) return;
  event.preventDefault();
  selectSection(Number(link.dataset.section));
});
$("#example-previous").addEventListener("click", () =>
  selectSection(state.index - 1),
);
$("#example-next").addEventListener("click", () =>
  selectSection(state.index + 1),
);
$("#example-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state) return;
  const result = sourceMatches(state.source, $("#example-search").value);
  $("#example-search-status").textContent = !$("#example-search").value.trim()
    ? "Enter a word or command to find."
    : `${result.total} matching ${result.total === 1 ? "line" : "lines"}.${result.total > result.matches.length ? ` Showing the first ${result.matches.length}.` : ""}`;
  $("#example-matches").innerHTML = result.matches
    .map(
      (m) =>
        `<button type="button" data-line="${m.line}"><span>Line ${m.line}</span>${h(m.text)}</button>`,
    )
    .join("");
});
$("#example-matches").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-line]");
  if (!button || !state) return;
  const line = Number(button.dataset.line),
    index = state.sections.findIndex((s) => line >= s.start && line <= s.end);
  selectSection(index, line);
});
$("#example-options").addEventListener("change", (event) => {
  const question = state?.sections[state.index].guide?.question,
    choice = Number(event.target.value);
  if (!question || !question.options[choice]) return;
  answers.set(questionKey(), { choice, checked: false });
  renderFeedback();
});
$("#example-check").addEventListener("click", () => {
  const answer = answers.get(questionKey());
  if (!answer) return;
  answer.checked = true;
  renderFeedback();
});
$("#example-retry").addEventListener("click", () => {
  const id = new URLSearchParams(location.search).get("example");
  cache.delete(id);
  void readLocation({ retry: true });
});
$("#example-copy").addEventListener("click", async () => {
  if (!state) return;
  const value = state.source,
    token = generation;
  try {
    await navigator.clipboard.writeText(value);
    if (token !== generation) return;
    $("#example-action-status").textContent =
      "The complete do-file was copied. Sections share data and macros; run the complete file first.";
  } catch {
    if (token !== generation) return;
    $("#example-action-status").textContent =
      "Copy is unavailable. Download the do-file or select the complete text below.";
    $("#example-copy-fallback").hidden = false;
    $("#example-copy-text").value = value;
    $("#example-copy-text").focus();
    $("#example-copy-text").select();
  }
});
$("#example-download").addEventListener("click", () => {
  if (!state) return;
  const url = URL.createObjectURL(
      new Blob([state.source], { type: "text/plain;charset=utf-8" }),
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = state.example.file;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#example-action-status").textContent =
    "The complete do-file was prepared. Check your downloads.";
});
window.addEventListener("popstate", () => void readLocation());
void readLocation();
