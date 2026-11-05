import { zipSync, strToU8 } from "fflate";
import {
  INFERENCE_DEFAULTS,
  INFERENCE_METHODS,
  INFERENCE_PRESETS,
  inferenceParameters,
  inferenceSample,
  inferenceCSV,
  inferenceDoFile,
  inferenceSimulationDoFile,
} from "./labs/inference-model.js";
import { singleIntervals, repeatedIntervals } from "./labs/inference-charts.js";
import { scatterPlot } from "./labs/scatter.js";
import { escapeHTML as h, fmt } from "./render.js";

const $ = (selector) => document.querySelector(selector);
const f = (value) => fmt(value, 3);
const percent = (value) => `${(100 * value).toFixed(1)}%`;
const table = (caption, heads, rows) =>
  `<table><caption>${h(caption)}</caption><thead><tr>${heads.map((x) => `<th scope="col">${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x, i) => (i ? `<td>${h(x)}</td>` : `<th scope="row">${h(x)}</th>`)).join("")}</tr>`).join("")}</tbody></table>`;
let parameters = { ...INFERENCE_DEFAULTS },
  sample = inferenceSample(parameters),
  simulation = null,
  selected = 0,
  windowStart = 0,
  active = "sample",
  worker = null,
  runId = 0,
  valid = true,
  point = 1,
  plot = null;
const sliderDefinitions = [
  [
    "beta",
    "True coefficient",
    "β",
    -5,
    5,
    0.1,
    "The population effect of a one-unit change in x.",
  ],
  [
    "sigma",
    "Error scale",
    "σ",
    0.1,
    5,
    0.1,
    "Population root mean conditional error variance.",
  ],
  [
    "heterogeneity",
    "Variance growth",
    "h",
    0,
    1.5,
    0.1,
    "Zero gives constant conditional variance; larger values increase variance with x.",
  ],
  [
    "errorICC",
    "Within-group error correlation",
    "ρₑ",
    0,
    0.95,
    0.05,
    "Conditional on x; zero removes shared group shocks.",
  ],
  [
    "xICC",
    "Within-group x correlation",
    "ρₓ",
    0,
    0.95,
    0.05,
    "Larger values put more predictor variation between groups.",
  ],
];
$("#inference-sliders").innerHTML = sliderDefinitions
  .map(
    ([id, title, symbol, min, max, step, description]) =>
      `<div class="lab-control"><label for="inference-${id}">${h(title)} <span>${h(symbol)}</span></label><div><input id="inference-${id}" name="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${parameters[id]}" aria-describedby="help-${id}"><output for="inference-${id}" id="value-${id}">${parameters[id].toFixed(2)}</output></div><small id="help-${id}">${h(description)}</small></div>`,
  )
  .join("");
$("#inference-scenario").innerHTML =
  INFERENCE_PRESETS.map(
    (p) => `<option value="${p.id}">${h(p.title)}</option>`,
  ).join("") + '<option value="custom">Custom parameters</option>';
$("#inference-scenario-description").textContent =
  INFERENCE_PRESETS[0].description;
function syncControls(values = parameters) {
  for (const [name, value] of Object.entries(values)) {
    const input = $(`#inference-${name}`);
    if (input) input.value = value;
    const output = $(`#value-${name}`);
    if (output) output.textContent = value.toFixed(2);
  }
}
function announce(text) {
  $("#inference-announcement").textContent = text;
}
function setView(view, focus = false) {
  active = view;
  for (const id of ["sample", "repeated", "method"]) {
    const button = $(`#inference-tab-${id}`),
      shown = id === view;
    button.setAttribute("aria-selected", String(shown));
    button.tabIndex = shown ? 0 : -1;
    $(`#inference-panel-${id}`).hidden = !shown;
  }
  if (view === "sample") renderSample();
  if (view === "repeated" && simulation) renderSimulation();
  if (focus) $(`#inference-tab-${view}`).focus();
}
function renderMetrics() {
  $("#inference-metrics").innerHTML = [
    ["True coefficient β", f(parameters.beta)],
    ["This sample's estimate", f(sample.b)],
    ["Observations", sample.n.toLocaleString()],
    ["Independent groups", sample.groups],
  ]
    .map(
      ([label, value]) =>
        `<div><span>${h(label)}</span><strong>${h(value)}</strong></div>`,
    )
    .join("");
}
function selectPoint(id) {
  point = id;
  const row = sample.rows[id - 1];
  $("#inspect-group").value = row.cluster;
  plot?.select(id);
  highlightGroup();
  $("#inference-observation").textContent =
    `Observation ${id}, group ${row.cluster}: x = ${f(row.x)}, y = ${f(row.y)}, residual = ${f(sample.residuals[id - 1])}.`;
}
function highlightGroup() {
  const input = $("#inspect-group"),
    group = input.valueAsNumber;
  if (!Number.isInteger(group) || group < 1 || group > sample.groups) {
    input.value = sample.rows[point - 1].cluster;
    return;
  }
  for (const dot of $("#inference-residuals").querySelectorAll(
    "[data-observation]",
  ))
    dot.classList.toggle(
      "in-group",
      sample.rows[Number(dot.dataset.observation) - 1].cluster === group,
    );
}
function renderSample() {
  renderMetrics();
  $("#sample-number").value = sample.replication + 1;
  $("#interval-level").textContent =
    `${parameters.confidence * 100}% confidence intervals`;
  singleIntervals($("#single-intervals"), sample);
  $("#inference-comparison").innerHTML = table(
    `Sample ${sample.replication + 1} · null β = ${f(parameters.nullValue)}`,
    [
      "Method",
      "Coefficient",
      "Std. error",
      "df",
      "Lower",
      "Upper",
      "p-value",
      "Contains β?",
    ],
    INFERENCE_METHODS.map(({ id, title }) => {
      const m = sample.methods[id];
      return [
        title,
        f(sample.b),
        f(m.se),
        m.df,
        f(m.lo),
        f(m.hi),
        m.p === null ? "undefined" : m.p < 0.001 ? "<0.001" : f(m.p),
        m.covers ? "Yes" : "No",
      ];
    }),
  );
  $("#inspect-group").max = sample.groups;
  point = Math.min(point, sample.n);
  plot = scatterPlot($("#inference-residuals"), {
    points: sample.rows.map((r, i) => ({
      id: r.id,
      x: r.x,
      y: sample.residuals[i],
    })),
    xLabel: "Predictor x",
    yLabel: "OLS residual",
    title: "OLS residuals by predictor, with a selected group",
    selected: point,
    onSelect: selectPoint,
  });
  selectPoint(point);
  renderCode();
}
function currentCode() {
  return $("#inference-code-kind").value === "simulation"
    ? inferenceSimulationDoFile(parameters)
    : inferenceDoFile(sample);
}
function renderCode() {
  $("#inference-code").textContent = currentCode();
  $("#copy-inference-code").textContent = "Copy do-file";
}
function chooseSample(index) {
  if (!Number.isInteger(index) || index < 0 || index >= 2000) {
    $("#sample-status").textContent =
      "Enter a whole sample number from 1 to 2,000.";
    return;
  }
  $("#sample-status").textContent = "";
  sample = inferenceSample(parameters, index);
  point = 1;
  renderSample();
}
function applyParameters() {
  try {
    if (!$("#parameter-form").checkValidity())
      throw new Error(
        "Complete each parameter with a value in its stated range.",
      );
    const values = Object.fromEntries(new FormData($("#parameter-form")));
    const next = inferenceParameters(
      Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, Number(v)]),
      ),
    );
    parameters = next;
    valid = true;
    simulation = null;
    selected = 0;
    windowStart = 0;
    sample = inferenceSample(parameters);
    point = 1;
    $("#parameter-status").textContent = "";
    $("#export-inference").disabled = false;
    $("#run-simulation").disabled = false;
    $("#run-simulation-inline").disabled = false;
    $("#simulation-results").hidden = true;
    $("#simulation-empty").hidden = false;
    $("#simulation-status").textContent =
      "Parameters updated. Run repeated samples for this population.";
    renderSample();
    if (active === "repeated") setView("repeated");
  } catch (error) {
    valid = false;
    $("#parameter-status").textContent =
      error.message + " The displayed results retain the last valid settings.";
    $("#export-inference").disabled = true;
    $("#run-simulation").disabled = true;
    $("#run-simulation-inline").disabled = true;
  }
}
function busy(value) {
  $("#parameter-fields").disabled = value;
  $("#reset-inference").disabled = value;
  $("#run-simulation").disabled = value || !valid;
  $("#run-simulation-inline").disabled = value || !valid;
  $("#cancel-simulation").hidden = !value;
  $("#simulation-progress").hidden = !value;
  $("#export-inference").disabled = value || !valid;
}
function runSimulation() {
  if (worker || !valid) return;
  const id = ++runId;
  busy(true);
  setView("repeated");
  $(".inference-tabs").scrollIntoView({ block: "start" });
  $("#simulation-progress").max = parameters.repetitions;
  $("#simulation-progress").value = 0;
  $("#simulation-status").textContent =
    `Running ${parameters.repetitions.toLocaleString()} samples…`;
  try {
    worker = new Worker(new URL("./inference-worker.js", import.meta.url), {
      type: "module",
    });
    const finish = (message) => {
      worker?.terminate();
      worker = null;
      busy(false);
      $("#simulation-status").textContent = message;
    };
    worker.onmessage = ({ data }) => {
      if (id !== runId) return;
      if (data.kind === "progress") {
        $("#simulation-progress").value = data.completed;
        return;
      }
      if (data.kind === "error") {
        finish(`Simulation stopped: ${data.message}`);
        return;
      }
      if (data.kind === "complete") {
        simulation = {
          parameters: { ...parameters },
          records: data.records,
          summary: data.summary,
        };
        selected = 0;
        windowStart = 0;
        finish(
          `Completed ${data.records.length.toLocaleString()} samples. All three methods used the same draws.`,
        );
        renderSimulation();
        announce(
          "Simulation complete. Coverage and Monte Carlo uncertainty are available.",
        );
      }
    };
    worker.onerror = (event) => {
      if (id === runId) {
        event.preventDefault();
        finish(
          "The simulation worker could not finish. Your sample remains available; reload and retry.",
        );
      }
    };
    worker.postMessage({ parameters: { ...parameters } });
  } catch {
    worker?.terminate();
    worker = null;
    busy(false);
    $("#simulation-status").textContent =
      "This browser could not start a background worker. The single-sample experiment remains available.";
  }
}
function renderSimulation() {
  if (!simulation) return;
  const { summary, records } = simulation;
  $("#simulation-empty").hidden = true;
  $("#simulation-results").hidden = false;
  $("#simulation-count").textContent =
    `${records.length.toLocaleString()} completed samples · seed ${parameters.seed}`;
  $("#coverage-target").textContent =
    `Nominal coverage ${parameters.confidence * 100}%`;
  $("#coverage-comparison").innerHTML = INFERENCE_METHODS.map(
    ({ id, title }) => {
      const c = summary.methods[id].coverage;
      return `<div class="coverage-row"><strong>${h(title)}</strong><div class="coverage-track" role="img" aria-label="${h(title)} coverage ${percent(c.rate)}, 95% Monte Carlo interval ${percent(c.lo)} to ${percent(c.hi)}"><span class="coverage-fill" style="width:${c.rate * 100}%"></span><span class="coverage-range" style="left:${c.lo * 100}%;width:${(c.hi - c.lo) * 100}%"></span><span class="coverage-point" style="left:${c.rate * 100}%"></span><span class="coverage-target" style="left:${parameters.confidence * 100}%"></span></div><div class="coverage-numbers">${percent(c.rate)} <small>${c.count}/${c.total} · ${percent(c.lo)}–${percent(c.hi)}</small></div></div>`;
    },
  ).join("");
  const nullTrue = parameters.beta === parameters.nullValue;
  $("#simulation-summary").innerHTML = table(
    "All completed repetitions",
    [
      "Method",
      "Mean SE",
      "Mean interval width",
      nullTrue ? "False rejection rate" : "Power against chosen null",
      "95% MC range",
    ],
    INFERENCE_METHODS.map(({ id, title }) => {
      const m = summary.methods[id];
      return [
        title,
        f(m.meanSE),
        f(m.meanWidth),
        percent(m.rejection.rate),
        `${percent(m.rejection.lo)}–${percent(m.rejection.hi)}`,
      ];
    }),
  );
  $("#simulation-interpretation").textContent =
    `Across these draws, the mean coefficient is ${f(summary.meanB)}, estimated bias is ${f(summary.bias)}, and the empirical standard deviation of the coefficient is ${f(summary.empiricalSD)}. The Monte Carlo standard error of the mean coefficient is ${f(summary.meanMCSE)}. Compare the empirical standard deviation with each method's mean reported SE. ${nullTrue ? "The chosen null equals the true coefficient, so rejection measures false positives." : `The null (${f(parameters.nullValue)}) differs from the true coefficient (${f(parameters.beta)}), so rejection measures power in this generator.`} More repetitions improve simulation precision; they do not add observations to an individual regression.`;
  renderRepeated();
}
function selectRepetition(index, focus = false) {
  selected = index;
  windowStart = Math.floor(index / 60) * 60;
  renderRepeated();
  if (focus) $("#repeated-intervals svg").focus();
  announce(`Selected sample ${index + 1}.`);
}
function renderRepeated() {
  if (!simulation) return;
  const method = $("#interval-method").value,
    record = simulation.records[selected],
    ci = record.methods[method];
  $("#interval-window").textContent =
    `Showing samples ${windowStart + 1}–${Math.min(windowStart + 60, simulation.records.length)}. Selected sample ${selected + 1}: estimate ${f(record.b)}, interval [${f(ci.lo)}, ${f(ci.hi)}], ${ci.covers ? "contains" : "does not contain"} β.`;
  $("#interval-previous").disabled = windowStart === 0;
  $("#interval-next").disabled = windowStart + 60 >= simulation.records.length;
  repeatedIntervals($("#repeated-intervals"), {
    records: simulation.records,
    parameters,
    method,
    start: windowStart,
    selected,
    onSelect: selectRepetition,
  });
}
$("#parameter-form").addEventListener("submit", (event) =>
  event.preventDefault(),
);
$("#parameter-form").addEventListener("input", (event) => {
  const output = $(`#value-${event.target.name}`);
  if (output) output.textContent = Number(event.target.value).toFixed(2);
});
$("#parameter-form").addEventListener("change", (event) => {
  if (event.target.id === "inference-scenario") {
    const preset = INFERENCE_PRESETS.find((p) => p.id === event.target.value);
    if (!preset) return;
    syncControls({ ...parameters, ...preset.values });
    $("#inference-scenario-description").textContent = preset.description;
  } else if (
    [
      "groups",
      "perGroup",
      "beta",
      "sigma",
      "heterogeneity",
      "errorICC",
      "xICC",
    ].includes(event.target.name)
  ) {
    $("#inference-scenario").value = "custom";
    $("#inference-scenario-description").textContent =
      "Custom population. The generated relationship remains exogenous by construction.";
  }
  applyParameters();
});
$("#reset-inference").addEventListener("click", () => {
  syncControls(INFERENCE_DEFAULTS);
  $("#inference-scenario").value = "independent";
  $("#inference-scenario-description").textContent =
    INFERENCE_PRESETS[0].description;
  applyParameters();
});
for (const id of ["#run-simulation", "#run-simulation-inline"])
  $(id).addEventListener("click", runSimulation);
$("#cancel-simulation").addEventListener("click", () => {
  runId++;
  worker?.terminate();
  worker = null;
  busy(false);
  $("#simulation-status").textContent =
    "Simulation canceled. No partial run was added; any earlier completed run remains available.";
});
$("#sample-number").addEventListener("change", (event) =>
  chooseSample(event.target.valueAsNumber - 1),
);
$("#next-inference-sample").addEventListener("click", () =>
  chooseSample((sample.replication + 1) % 2000),
);
$("#inspect-group").addEventListener("change", highlightGroup);
$("#interval-method").addEventListener("change", renderRepeated);
$("#interval-previous").addEventListener("click", () =>
  selectRepetition(Math.max(0, windowStart - 60)),
);
$("#interval-next").addEventListener("click", () =>
  selectRepetition(Math.min(simulation.records.length - 1, windowStart + 60)),
);
$("#inspect-repetition").addEventListener("click", () => {
  chooseSample(selected);
  setView("sample", true);
});
for (const id of ["sample", "repeated", "method"]) {
  $(`#inference-tab-${id}`).addEventListener("click", () => setView(id));
  $(`#inference-tab-${id}`).addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const ids = ["sample", "repeated", "method"],
        i = ids.indexOf(active);
      setView(
        event.key === "Home"
          ? ids[0]
          : event.key === "End"
            ? ids[2]
            : ids[(i + (event.key === "ArrowRight" ? 1 : 2)) % 3],
        true,
      );
    }
  });
}
document.querySelectorAll("[data-inference-view]").forEach((button) =>
  button.addEventListener("click", () => {
    setView(button.dataset.inferenceView);
    $(".inference-tabs").scrollIntoView({ block: "start" });
  }),
);
$("[data-inference-jump]").addEventListener("click", () =>
  $("#inference-parameters").scrollIntoView({ block: "start" }),
);
$("#inference-code-kind").addEventListener("change", renderCode);
$("#copy-inference-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentCode());
    $("#copy-inference-code").textContent = "Copied";
  } catch {
    $("#copy-inference-code").textContent = "Select and copy the code below";
  }
});
$("#export-inference").addEventListener("click", () => {
  if (!valid || worker) return;
  const files = {
    "inference-sample.csv": strToU8(inferenceCSV(sample)),
    "analysis.do": strToU8(inferenceDoFile(sample)),
    "simulation.do": strToU8(inferenceSimulationDoFile(parameters)),
    "experiment.json": strToU8(
      JSON.stringify(
        {
          version: 1,
          parameters,
          sampleNumber: sample.replication + 1,
          completedRepetitions: simulation?.records.length || 0,
          summary: simulation?.summary || null,
        },
        null,
        2,
      ),
    ),
    "README.txt": strToU8(
      "STATAverse inference experiment\n\nAll observations are synthetic. Extract this folder and change Stata's working directory to it. analysis.do fits the exact displayed sample with conventional, HC1 and one-way clustered covariance. simulation.do independently generates repeated native draws from the same population design and writes native-repetitions.dta and native-repetitions.csv (replaced on rerun). The browser and Stata random-number streams differ; equal seeds do not give equal samples.\n\nIf repetitions.csv is present, it contains every completed browser repetition's estimate, intervals and standard errors. experiment.json records parameters and the browser numerical summary. Canceled or incomplete runs are excluded. The generator, formulas and limits are described in the lab. Java-dependent native CSV import may depend on the local Stata installation; simulation.do generates its own data without CSV import.\n",
    ),
  };
  if (simulation) {
    const headers = [
      "sample",
      "b",
      ...INFERENCE_METHODS.flatMap((m) =>
        ["se", "lo", "hi", "covers", "rejects"].map((k) => `${m.id}_${k}`),
      ),
    ];
    const rows = simulation.records.map((r) =>
      [
        r.replication + 1,
        r.b,
        ...INFERENCE_METHODS.flatMap((m) => [
          r.methods[m.id].se,
          r.methods[m.id].lo,
          r.methods[m.id].hi,
          Number(r.methods[m.id].covers),
          Number(r.methods[m.id].rejects),
        ]),
      ].join(","),
    );
    files["repetitions.csv"] = strToU8(
      headers.join(",") + "\n" + rows.join("\n") + "\n",
    );
  }
  const url = URL.createObjectURL(
    new Blob([zipSync(files)], { type: "application/zip" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "stataverse-inference-experiment.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce(
    "Experiment exported with the displayed sample and any completed simulation.",
  );
});
window.addEventListener("pagehide", () => worker?.terminate());
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (active === "sample") singleIntervals($("#single-intervals"), sample);
    if (active === "repeated") renderRepeated();
  }, 150);
});
syncControls();
renderSample();
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("../../service-worker.js").catch(() => {});
