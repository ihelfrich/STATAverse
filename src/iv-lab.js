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
function clearFeedback() {
  $("#iv-feedback").textContent = "";
  delete $("#iv-feedback").dataset.correct;
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
  clearFeedback();
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
    clearFeedback();
    render();
  } catch (error) {
    setValid(false, `${error.message} Results retain the last valid settings.`);
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
$("#iv-candidate").addEventListener("input", renderAR);
$("#iv-window").addEventListener("change", renderAR);
$("#iv-test-truth").addEventListener("click", () => {
  $("#iv-candidate").value = parameters.beta;
  renderAR();
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
const tasks = {
  ratio: {
    options: {},
    view: "stages",
    prompt:
      "Use the first-stage and reduced-form slopes to calculate the IV ratio. Enter the ratio to three decimal places.",
    label: "IV ratio",
    answer: (s) => s.iv.b,
    feedback: (s) =>
      `Reduced form ÷ first stage = ${f(s.reduced.b)} ÷ ${f(s.first.b)} ≈ ${f(s.iv.b)}. The calculation uses the unrounded slopes.`,
    placeholder: "e.g. 1.234",
  },
  weak: {
    options: { pi: 0.06 },
    view: "uncertainty",
    prompt:
      "With a weak first stage, inspect the Anderson–Rubin set. Does it contain a bounded interval, two pieces, or all values? Enter “bounded”, “two pieces” or “all values”.",
    label: "Set shape",
    answer: () => "all values",
    feedback: () =>
      "For this particular sample, every candidate passes the test. A different seed can produce two unbounded pieces or a bounded set; weak population relevance alone does not fix the sample's set shape.",
    placeholder: "bounded, two pieces, or all values",
  },
  invalid: {
    options: { delta: 0.8 },
    view: "stages",
    prompt:
      "The first stage is strong, but δ = 0.8 violates exclusion. Use β + δ/π to find the population IV limit. Enter its value.",
    label: "Population IV limit",
    answer: (s) => s.population.iv,
    feedback: (s) =>
      `The population IV ratio is ${f(s.population.iv)}, while β = ${f(s.parameters.beta)}. More observations concentrate the estimator around the wrong target when this violation persists.`,
    placeholder: "e.g. 1.234",
  },
  residual: {
    options: {},
    view: "stages",
    prompt:
      "Both second-stage procedures give the same slope. To compute the correct IV covariance, should the residual use observed x or fitted x? Enter “observed x” or “fitted x”.",
    label: "Regressor in the residual",
    answer: () => "observed x",
    feedback: () =>
      "Use observed x: y − intercept − b × x. The IV covariance accounts for the instrument through projected regressors, while measuring the structural residual with the actual regressor.",
    placeholder: "observed x or fitted x",
  },
};
function renderTask() {
  const task = tasks[$("#iv-task").value];
  $("#iv-task-prompt").textContent = task.prompt;
  $("#iv-answer-label").textContent = task.label;
  $("#iv-answer").placeholder = task.placeholder;
  $("#iv-answer").value = "";
  clearFeedback();
}
$("#iv-task").addEventListener("change", renderTask);
$("#iv-task-load").addEventListener("click", () => {
  const task = tasks[$("#iv-task").value];
  load(task.options);
  setView(task.view);
  $("#iv-feedback").textContent =
    "Exercise settings loaded. Use the results above, then enter your answer.";
});
$("#iv-answer-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const task = tasks[$("#iv-task").value],
    expectedSettings = ivParameters(task.options),
    feedback = $("#iv-feedback");
  if (
    !valid ||
    Object.keys(IV_DEFAULTS).some((k) => parameters[k] !== expectedSettings[k])
  ) {
    feedback.textContent =
      "Load this exercise's settings before checking your answer. Your current sample uses different settings.";
    delete feedback.dataset.correct;
    return;
  }
  const answer = $("#iv-answer").value.trim().toLowerCase(),
    expected = task.answer(sample);
  const correct =
    typeof expected === "number"
      ? answer !== "" &&
        Number.isFinite(Number(answer)) &&
        Math.abs(Number(answer) - expected) <= 0.001
      : answer === expected;
  feedback.dataset.correct = String(correct);
  feedback.textContent = correct
    ? `Correct. ${task.feedback(sample)}`
    : answer === ""
      ? "Enter an answer before checking."
      : `Recheck ${$("#iv-task").value === "ratio" ? "the reduced-form slope divided by the first-stage slope" : $("#iv-task").value === "invalid" ? "β + δ/π using the population controls" : $("#iv-task").value === "weak" ? "the confidence set above the plot" : "the residual used by the correct 2SLS covariance"}.`;
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
renderTask();
render();
