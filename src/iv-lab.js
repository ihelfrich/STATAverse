import { INVESTIGATION_CATALOG } from "./labs/investigation-catalog.js";
import { zipSync, strToU8 } from "fflate";
import {
  IV_DEFAULTS,
  IV_PRESETS,
  ivParameters,
  ivSample,
  arTest,
  ivCSV,
  ivDoFile,
} from "./labs/iv-model.js";
import { scatterPlot } from "./labs/scatter.js";
import { escapeHTML as h, fmt } from "./render.js";
const $ = (s) => document.querySelector(s),
  f = (v) => (v === null ? "unavailable" : fmt(v, 3));
let investigations = null;
let parameters = { ...IV_DEFAULTS },
  sample = ivSample(parameters),
  selected = 1,
  plot = null,
  active = "stages",
  valid = true,
  pending = null;
const sliders = [
  [
    "pi",
    "First-stage strength",
    "π",
    0,
    2,
    0.01,
    "How much x changes when z increases by one.",
  ],
  [
    "rho",
    "Endogeneity",
    "ρ",
    -0.95,
    0.95,
    0.05,
    "Correlation between v and u in the population.",
  ],
  [
    "delta",
    "Direct effect of z",
    "δ",
    -2,
    2,
    0.05,
    "Zero satisfies exclusion in this experiment.",
  ],
  [
    "beta",
    "True structural coefficient",
    "β",
    -5,
    5,
    0.1,
    "Known because this population is synthetic.",
  ],
  [
    "sigma",
    "Error scale",
    "σ",
    0.1,
    5,
    0.1,
    "Population standard deviation of u.",
  ],
];
function sliderHTML([id, title, symbol, min, max, step, help]) {
  return `<div class="lab-control"><label for="iv-${id}">${h(title)} <span>${h(symbol)}</span></label><div><input id="iv-${id}" name="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${parameters[id]}" aria-describedby="iv-help-${id}"><output for="iv-${id}" id="iv-value-${id}">${parameters[id].toFixed(2)}</output></div><small id="iv-help-${id}">${h(help)}</small></div>`;
}
$("#iv-sliders").innerHTML = sliders.slice(0, 3).map(sliderHTML).join("");
$("#iv-extra-sliders").innerHTML = sliders.slice(3).map(sliderHTML).join("");
$("#iv-scenario").innerHTML =
  IV_PRESETS.map((p) => `<option value="${p.id}">${h(p.title)}</option>`).join(
    "",
  ) + '<option value="custom">Custom settings</option>';
function syncForm() {
  for (const [key, value] of Object.entries(parameters)) {
    const input = $(`#iv-${key}`);
    if (input) input.value = String(value);
    const output = $(`#iv-value-${key}`);
    if (output) output.textContent = Number(value).toFixed(2);
  }
}
function updateScenario() {
  const preset = IV_PRESETS.find((p) =>
    Object.entries(p.values).every(([k, v]) => parameters[k] === v),
  );
  $("#iv-scenario").value = preset?.id || "custom";
  $("#iv-scenario-description").textContent =
    preset?.description ||
    "The controls define this population. Estimates below use one sample drawn from it.";
}
function candidateValue() {
  const input = $("#iv-candidate");
  return input.value !== "" && input.checkValidity()
    ? input.valueAsNumber
    : null;
}
function setValid(value, message = "") {
  valid = value;
  $("#iv-status").textContent = message;
  $("#export-iv").disabled = !valid || candidateValue() === null;
  $("#iv-new-sample").disabled = !valid;
}
function load(values) {
  if (pending) cancelAnimationFrame(pending);
  pending = null;
  parameters = ivParameters({ ...IV_DEFAULTS, ...values });
  sample = ivSample(parameters);
  selected = Math.min(selected, sample.n);
  syncForm();
  updateScenario();
  setValid(true);
  investigations?.changed();
  render();
}
function updateFromForm() {
  pending = null;
  try {
    if (!$("#iv-form").checkValidity())
      throw new Error("Check the sample and population settings.");
    const values = {};
    for (const key of Object.keys(IV_DEFAULTS))
      values[key] =
        key === "robust"
          ? $("#iv-robust").value === "true"
          : Number($(`#iv-${key}`).value);
    parameters = ivParameters(values);
    sample = ivSample(parameters);
    selected = Math.min(selected, sample.n);
    syncForm();
    updateScenario();
    setValid(true);
    investigations?.changed();
    render();
  } catch (error) {
    setValid(false, `${error.message} Results retain the last valid settings.`);
    investigations?.changed();
  }
}
$("#iv-form").addEventListener("submit", (e) => e.preventDefault());
$("#iv-form").addEventListener("input", (event) => {
  if (event.target.id === "iv-scenario") return;
  setValid(false, "Updating the sample…");
  if (pending) cancelAnimationFrame(pending);
  pending = requestAnimationFrame(updateFromForm);
});
$("#iv-scenario").addEventListener("change", () => {
  const preset = IV_PRESETS.find((p) => p.id === $("#iv-scenario").value);
  if (preset) load({ ...parameters, ...preset.values });
});
$("#reset-iv").addEventListener("click", () => load(IV_DEFAULTS));
$("#iv-new-sample").addEventListener("click", () =>
  load({
    ...parameters,
    seed: parameters.seed === 4294967295 ? 1 : parameters.seed + 1,
  }),
);
function table(caption, heads, rows) {
  return `<table><caption>${h(caption)}</caption><thead><tr>${heads.map((x) => `<th scope="col">${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x, i) => (i ? `<td>${h(x)}</td>` : `<th scope="row">${h(x)}</th>`)).join("")}</tr>`).join("")}</tbody></table>`;
}
function renderSummary() {
  $("#iv-assumptions").innerHTML =
    `<span class="${parameters.delta === 0 ? "" : "failed"}">Exclusion: ${parameters.delta === 0 ? "holds in this population" : "violated (δ ≠ 0)"}</span><span class="${parameters.pi !== 0 ? "" : "failed"}">Population relevance: ${parameters.pi !== 0 ? `π = ${f(parameters.pi)}` : "absent (π = 0)"}</span><span>Known β = ${f(parameters.beta)} · n = ${sample.n}</span>`;
  $("#iv-stages").innerHTML = [
    [
      "01 · First-stage slope",
      f(sample.first.b),
      `x on z · F = ${f(sample.firstF)}`,
    ],
    ["02 · Reduced-form slope", f(sample.reduced.b), "y on z"],
    [
      "03 · IV ratio",
      f(sample.iv?.b ?? null),
      `${f(sample.reduced.b)} ÷ ${f(sample.first.b)}`,
    ],
  ]
    .map(
      ([title, value, note]) =>
        `<div class="iv-stage"><span>${h(title)}</span><strong>${h(value)}</strong><code>${h(note)}</code></div>`,
    )
    .join("");
  $("#iv-comparison").innerHTML = table(
    `${parameters.confidence * 100}% Wald intervals · ${parameters.robust ? "HC1" : "conventional"} covariance · df = ${sample.n - 2}`,
    ["Method", "Estimate", "Std. error", "Lower", "Upper", "Population limit"],
    [
      [
        "OLS",
        f(sample.ols.b),
        f(sample.ols.se),
        f(sample.ols.lo),
        f(sample.ols.hi),
        f(sample.population.ols),
      ],
      [
        "2SLS",
        f(sample.iv?.b ?? null),
        f(sample.iv?.se ?? null),
        f(sample.iv?.lo ?? null),
        f(sample.iv?.hi ?? null),
        sample.population.iv === null ? "undefined" : f(sample.population.iv),
      ],
    ],
  );
  $("#iv-interpretation").textContent =
    parameters.delta !== 0
      ? `Exclusion fails: the population IV ratio is ${parameters.pi === 0 ? "undefined because π = 0" : f(sample.population.iv)}, while the structural coefficient is ${f(parameters.beta)}. First-stage strength cannot establish validity.`
      : parameters.pi === 0
        ? "The population first stage is zero. A sample IV ratio may still be computable, but it does not identify β. Examine the Anderson–Rubin confidence set before interpreting precision."
        : `The population OLS slope is ${f(sample.population.ols)} and the valid-instrument IV limit is ${f(parameters.beta)}. These are population quantities; the estimates in one sample fluctuate. With a weak first stage, a Wald interval can give a misleading impression of precision.`;
  $("#iv-naive").innerHTML = sample.iv
    ? `<p>The correct 2SLS standard error is <strong>${f(sample.iv.se)}</strong>. Regressing y on fitted x gives <strong>${f(sample.naive.se)}</strong>, despite returning the same slope (${f(sample.iv.b)}).</p>`
    : "<p>The sample first stage is too close to zero for a numerically reliable IV point estimate.</p>";
  $("#iv-code").textContent = [
    `regress x z${parameters.robust ? ", vce(robust)" : ""}`,
    "test z",
    `regress y z${parameters.robust ? ", vce(robust)" : ""}`,
    `regress y x${parameters.robust ? ", vce(robust)" : ""}`,
    `ivregress 2sls y (x = z), small${parameters.robust ? " vce(robust)" : ""} level(${parameters.confidence * 100})`,
    "",
    "* Stata 19+",
    `estat weakrobust, ar ci level(${parameters.confidence * 100})`,
  ].join("\n");
}
function selectRecord(id) {
  selected = id;
  $("#iv-record").value = id;
  plot?.select(id);
  const row = sample.rows[id - 1];
  investigations?.changed();
  $("#iv-record-values").innerHTML = `<dl>${[
    ["z", row.z],
    ["x", row.x],
    ["y", row.y],
    ["fitted x", sample.first.fitted[id - 1]],
    ["first-stage residual", sample.first.residuals[id - 1]],
  ]
    .map(
      ([label, value]) =>
        `<div><dt>${h(label)}</dt><dd>${h(f(value))}</dd></div>`,
    )
    .join("")}</dl>`;
}
function renderScatter() {
  const view = $("#iv-view").value;
  const ids = new Set(
    Array.from({ length: Math.min(300, sample.n) }, (_, i) =>
      Math.floor((i * sample.n) / Math.min(300, sample.n)),
    ),
  );
  if (!ids.has(selected - 1)) {
    ids.delete([...ids].at(-1));
    ids.add(selected - 1);
  }
  const rows = [...ids].sort((a, b) => a - b).map((i) => sample.rows[i]);
  const model =
    view === "first"
      ? sample.first
      : view === "reduced"
        ? sample.reduced
        : sample.ols;
  const lines = [
    { intercept: model.intercept, slope: model.b, style: "adjusted" },
  ];
  if (view === "structural" && sample.iv)
    lines.push({
      intercept: sample.iv.intercept,
      slope: sample.iv.b,
      style: "secondary",
    });
  plot = scatterPlot($("#iv-scatter"), {
    points: rows.map((r) => ({
      id: r.id,
      x: view === "structural" ? r.x : r.z,
      y: view === "first" ? r.x : r.y,
    })),
    lines,
    xLabel: view === "structural" ? "x" : "instrument z",
    yLabel: view === "first" ? "x" : "y",
    title:
      view === "first"
        ? "First stage"
        : view === "reduced"
          ? "Reduced form"
          : "OLS and IV fitted lines",
    selected,
    onSelect: selectRecord,
  });
  $("#iv-plot-note").textContent =
    `${sample.n > 300 ? `Showing 300 of ${sample.n} observations; every calculation uses all ${sample.n}. Enter a record number to inspect any observation. ` : `All ${sample.n} observations shown. `}${view === "structural" ? "Blue line: OLS. Dashed line: IV (a structural fit, not the conditional mean of y given x)." : "The line is the sample regression fit."}`;
  $("#iv-record").max = sample.n;
  selectRecord(selected);
}
$("#iv-view").addEventListener("change", renderScatter);
$("#iv-record").addEventListener("change", () => {
  const input = $("#iv-record"),
    id = input.valueAsNumber;
  if (!input.checkValidity() || !Number.isInteger(id)) {
    input.value = selected;
    return;
  }
  selected = id;
  renderScatter();
});
const endpoint = (v) =>
  v === Infinity
    ? "∞"
    : v === -Infinity
      ? "−∞"
      : Math.abs(v) > 1e6
        ? v.toExponential(3)
        : f(v);
function setText(set) {
  if (set.kind === "unavailable")
    return "Unavailable: singular residual covariance";
  if (set.kind === "all") return "All real values";
  if (set.kind === "empty") return "Empty set";
  return set.intervals
    .map(
      ([lo, hi]) =>
        `${lo === -Infinity ? "(" : "["}${endpoint(lo)}, ${endpoint(hi)}${hi === Infinity ? ")" : "]"}`,
    )
    .join(" ∪ ");
}
function renderAR() {
  const candidate = candidateValue();
  $("#export-iv").disabled = !valid || candidate === null;
  $("#iv-set-label").textContent =
    `${parameters.confidence * 100}% Anderson–Rubin confidence set`;
  $("#iv-set").textContent = setText(sample.ar);
  $("#iv-set-explanation").textContent =
    sample.ar.kind === "all"
      ? "This test rejects no coefficient value. The sample provides no finite bound on β through this test."
      : sample.ar.kind === "two-rays"
        ? "Two unbounded pieces: intermediate values are rejected, while sufficiently large positive and negative values remain in the set."
        : sample.ar.kind === "bounded"
          ? "The accepted candidates form a bounded interval. Its endpoints need not be symmetric around the IV estimate."
          : "The set notation describes the accepted values; finite endpoints are rounded for display.";
  $("#iv-ar-method").textContent =
    `${parameters.robust ? "HC1 covariance with an approximate F reference" : "Conventional covariance with an exact F reference under valid-instrument, normal and homoskedastic assumptions"}; degrees of freedom 1 and ${sample.n - 2}. ${parameters.delta !== 0 ? "Exclusion is violated in the current population, so this set has no valid-instrument coverage guarantee." : "The weak-instrument protection still requires a valid instrument."}`;
  if (candidate === null)
    $("#iv-ar-result").textContent =
      "Enter a finite candidate between −1,000,000 and 1,000,000. The confidence set remains unchanged; export is disabled until the candidate is valid.";
  else {
    const t = arTest(sample, candidate);
    $("#iv-ar-result").textContent =
      t.f === null
        ? t.reason
        : `Candidate b = ${f(candidate)}: F = ${f(t.f)}, p ${t.p < 0.001 ? "< 0.001" : `= ${f(t.p)}`}. ${t.accepted ? "Not rejected; included in the confidence set." : "Rejected; excluded from the confidence set."}`;
  }
  const w = 640,
    height = 250,
    left = 62,
    right = 20,
    top = 20,
    bottom = 48,
    half = Number($("#iv-window").value),
    x = (v) => left + ((v + half) / (2 * half)) * (w - left - right),
    y = (v) => height - bottom - v * (height - bottom - top),
    alpha = 1 - parameters.confidence;
  const candidates = new Set(
    Array.from({ length: 161 }, (_, i) => -half + (2 * half * i) / 160),
  );
  // Add the peak and local detail so a narrow acceptance region does not fall
  // between a fixed grid's points when students choose a wide plotting window.
  for (const b of [
    ...sample.ar.intervals.flat(),
    parameters.beta,
    candidate,
    ...(sample.iv
      ? [-8, -4, -2, -1, -0.5, 0, 0.5, 1, 2, 4, 8].map(
          (k) => sample.iv.b + k * sample.iv.se,
        )
      : []),
  ])
    if (b !== null && Number.isFinite(b) && Math.abs(b) <= half)
      candidates.add(b);
  const curve = [...candidates]
    .sort((a, b) => a - b)
    .map((b) => {
      const p = arTest(sample, b).p;
      return p === null ? null : [x(b), y(p)];
    });
  const path = curve
    .map((p, i) =>
      p ? `${i === 0 || !curve[i - 1] ? "M" : "L"}${p[0]},${p[1]}` : "",
    )
    .join(" ");
  const bands = sample.ar.intervals
    .filter(([lo, hi]) => lo <= half && hi >= -half)
    .map(
      ([lo, hi]) =>
        `<rect class="iv-ar-accepted" x="${x(Math.max(lo, -half))}" y="${top}" width="${Math.max(0, x(Math.min(hi, half)) - x(Math.max(lo, -half)))}" height="${height - bottom - top}"/>${lo < -half ? `<text x="${left + 4}" y="${top + 15}">←</text>` : ""}${hi > half ? `<text x="${w - right - 16}" y="${top + 15}">→</text>` : ""}`,
    )
    .join("");
  const ticks =
    [0, 0.25, 0.5, 0.75, 1]
      .map(
        (p) =>
          `<text x="${left - 10}" y="${y(p) + 4}" text-anchor="end">${p.toFixed(2)}</text>`,
      )
      .join("") +
    [-half, -half / 2, 0, half / 2, half]
      .map(
        (b) =>
          `<text x="${x(b)}" y="${height - bottom + 22}" text-anchor="middle">${b}</text>`,
      )
      .join("");
  $("#iv-ar-plot").innerHTML =
    `<svg viewBox="0 0 ${w} ${height}" role="img" aria-label="Anderson–Rubin p-values across candidate coefficients"><desc>Green shading marks the accepted set within the plotted window. The blue curve is the p-value; the dashed horizontal line marks ${alpha.toFixed(2)}. The solid green vertical line is the known true coefficient. The dashed vertical line marks the candidate when visible.</desc>${bands}<line class="iv-ar-axis" x1="${left}" x2="${left}" y1="${top}" y2="${height - bottom}"/><line class="iv-ar-axis" x1="${left}" x2="${w - right}" y1="${height - bottom}" y2="${height - bottom}"/>${ticks}<line class="iv-ar-critical" x1="${left}" x2="${w - right}" y1="${y(alpha)}" y2="${y(alpha)}"/><path class="iv-ar-curve" d="${path}"/>${Math.abs(parameters.beta) <= half ? `<line class="iv-ar-truth" x1="${x(parameters.beta)}" x2="${x(parameters.beta)}" y1="${top}" y2="${height - bottom}"/>` : ""}${candidate !== null && Math.abs(candidate) <= half ? `<line class="iv-ar-candidate" x1="${x(candidate)}" x2="${x(candidate)}" y1="${top}" y2="${height - bottom}"/>` : ""}<text x="${w / 2}" y="${height - 5}" text-anchor="middle">Candidate coefficient b</text><text transform="translate(14 ${height / 2}) rotate(-90)" text-anchor="middle">p-value</text></svg>`;
}
$("#iv-candidate").addEventListener("input", () => {
  renderAR();
  investigations?.changed();
});
$("#iv-window").addEventListener("change", () => {
  renderAR();
  investigations?.changed();
});
$("#iv-test-truth").addEventListener("click", () => {
  $("#iv-candidate").value = parameters.beta;
  renderAR();
  investigations?.changed();
});
$("#iv-disconnected").addEventListener("click", () =>
  load({ pi: 0.06, seed: 8 }),
);
function setView(view, focus = false) {
  active = view;
  for (const name of ["stages", "uncertainty", "method"]) {
    const tab = $(`#iv-tab-${name}`);
    tab.setAttribute("aria-selected", String(view === name));
    tab.tabIndex = view === name ? 0 : -1;
    $(`#iv-panel-${name}`).hidden = view !== name;
  }
  if (view === "stages") renderScatter();
  if (view === "uncertainty") renderAR();
  if (focus) $(`#iv-tab-${view}`).focus();
  investigations?.changed();
}
const tabs = ["stages", "uncertainty", "method"];
tabs.forEach((name, index) => {
  const tab = $(`#iv-tab-${name}`);
  tab.addEventListener("click", () => setView(name));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 2
          : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
    setView(tabs[next], true);
  });
});
$("#export-iv").addEventListener("click", () => {
  const candidate = candidateValue();
  if (!valid || candidate === null) return;
  const files = {
    "iv-sample.csv": ivCSV(sample),
    "analysis.do": ivDoFile(sample, candidate),
    "settings.json":
      JSON.stringify(
        {
          parameters,
          candidate,
          source: "STATAverse synthetic IV lab",
          schema: 1,
        },
        null,
        2,
      ) + "\n",
    "README.txt": `STATAverse instrumental-variables experiment\n\nSynthetic data; no student or uploaded records. All calculations ran in your browser.\nOpen Stata in this folder and run analysis.do. The CSV preserves the exact browser draws; the seed does not reproduce them in Stata's different generator.\n\nPopulation: x = pi*z + v; y = 2 + beta*x + delta*z + u; u = sigma*(rho*v + sqrt(1-rho^2)*e). z, v and e are independent standard normals.\nIV requires pi != 0 and delta = 0 in this population. The first stage does not test exclusion.\n\n${parameters.confidence * 100}% Anderson-Rubin set: ${setText(sample.ar)}\n${parameters.robust ? "HC1 with approximate F reference." : "Conventional F reference under the valid normal homoskedastic model."}\nFinite endpoints in this README are rounded; recompute with the provided data.\nThe official confidence-set command in analysis.do requires Stata 19+ and is commented for compatibility. The transformed-outcome test runs directly.\n`,
  };
  const investigation = investigations?.record();
  if (investigation)
    files["investigation.json"] = JSON.stringify(investigation, null, 2) + "\n";
  const bytes = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/zip" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `stataverse-iv-${parameters.seed}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  $("#iv-status").textContent =
    "Export prepared: exact sample, Stata do-file, settings and notes.";
});
function render() {
  renderSummary();
  if (active === "stages") renderScatter();
  if (active === "uncertainty") renderAR();
}
const mobileControls = matchMedia("(max-width: 850px)");
$("#iv-controls-disclosure").open = !mobileControls.matches;
mobileControls.addEventListener("change", (event) => {
  $("#iv-controls-disclosure").open = !event.matches;
});
syncForm();
updateScenario();
render();

const investigationAdapter = {
  snapshot: () => ({
    parameters: { ...parameters },
    sample,
    valid:
      valid && (candidateValue() !== null || $("#iv-candidate").value === ""),
    view: active,
    plot: $("#iv-view").value,
    selected,
    candidate: $("#iv-candidate").value,
    window: Number($("#iv-window").value),
  }),
  apply: (state) => {
    load(state.parameters);
    selected = state.selected;
    $("#iv-view").value = state.plot;
    $("#iv-candidate").value = state.candidate;
    $("#iv-window").value = state.window;
    setView(state.view);
  },
};

let guideLoading = null,
  guideAttempts = 0;
$("#iv-guide-select").innerHTML =
  '<option value="">Open exploration</option>' +
  INVESTIGATION_CATALOG.filter((g) => g.lab === "iv")
    .map((g) => `<option value="${g.id}">${h(g.title)}</option>`)
    .join("");
$("#iv-guide-summary").textContent =
  "Choose a guided investigation, or explore freely. Guided tasks, settings and notes resume from Saved work.";
async function loadGuides() {
  if (investigations || guideLoading) return;
  $("#iv-guide-summary").textContent = "Loading guided investigations…";
  $("#iv-guide-retry").hidden = true;
  const moduleURL = new URL("./iv-investigation-ui.js", import.meta.url);
  if (++guideAttempts > 1) moduleURL.search = `retry=${guideAttempts}`;
  guideLoading = import(moduleURL.href)
    .then((module) => {
      investigations = module.initializeIVInvestigations(investigationAdapter);
    })
    .catch(() => {
      $("#iv-guide-storage").hidden = false;
      $("#iv-guide-storage").textContent =
        "Guided tasks could not load. Your experiment is still available. Reconnect if needed, then retry.";
      $("#iv-guide-retry").hidden = false;
    })
    .finally(() => {
      guideLoading = null;
    });
  return guideLoading;
}
$("#iv-guide-select").addEventListener("change", (event) => {
  if (investigations) return;
  if (event.target.value) {
    history.replaceState(null, "", `#investigation=${event.target.value}`);
    loadGuides();
  } else {
    history.replaceState(null, "", location.pathname + location.search);
    $("#iv-guide-summary").textContent =
      "Open exploration. Choose an investigation when you want guided tasks.";
  }
});
$("#iv-guide-retry").addEventListener("click", loadGuides);
window.addEventListener("hashchange", () => {
  if (new URLSearchParams(location.hash.slice(1)).has("investigation"))
    loadGuides();
});
if (new URLSearchParams(location.hash.slice(1)).has("investigation"))
  loadGuides();
