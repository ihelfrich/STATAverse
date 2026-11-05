import {
  REGRESSION_DEFAULTS,
  REGRESSION_PRESETS,
  analyzeRegression,
  leaveOneOut,
  regressionCSV,
  regressionDoFile,
} from "./labs/regression-model.js";
import { scatterPlot } from "./labs/scatter.js";
import { escapeHTML as h, fmt, table } from "./render.js";
import { zipSync, strToU8 } from "fflate";
import { registerOffline } from "./offline.js";

const $ = (selector) => document.querySelector(selector);
const viewNames = ["overview", "partial", "influence", "stata"];
let parameters = { ...REGRESSION_DEFAULTS },
  analysis,
  selected = 1,
  perturbation = null,
  activeView = "overview",
  plots = [];
const b = (model, name) => model.coefficients.find((c) => c.name === name);
const f = (value) => fmt(value, 3);
const announce = (message) => {
  $("#lab-status").textContent = message;
};
$("#scenario").innerHTML =
  REGRESSION_PRESETS.map(
    (preset) => `<option value="${preset.id}">${h(preset.title)}</option>`,
  ).join("") + '<option value="custom">Custom settings</option>';
function writeControls() {
  for (const key of ["beta", "gamma", "rho", "sigma"]) {
    $(`#parameter-${key}`).value = parameters[key];
    $(`#value-${key}`).textContent = parameters[key].toFixed(
      key === "rho" ? 2 : 1,
    );
  }
  $("#sample-size").value = parameters.n;
  $("#random-seed").value = parameters.seed;
  $("#robust-covariance").checked = parameters.robust;
}
function readControls() {
  return {
    ...Object.fromEntries(
      ["beta", "gamma", "rho", "sigma"].map((key) => [
        key,
        Number($(`#parameter-${key}`).value),
      ]),
    ),
    n: Number($("#sample-size").value),
    seed: Number($("#random-seed").value),
    robust: $("#robust-covariance").checked,
  };
}
function compareRow(title, code, coefficient, n, df) {
  return `<tr><th scope="row"><strong>${h(title)}</strong><code>${h(code)}</code></th><td>${f(coefficient.b)}</td><td>${f(coefficient.se)}</td><td>[${f(coefficient.lo)}, ${f(coefficient.hi)}]</td><td>${n}</td><td>${df}</td></tr>`;
}
function comparison(rows, caption) {
  return `<div class="lab-table-wrap" tabindex="0" role="region" aria-label="${h(caption)}"><table class="model-comparison"><caption>${h(caption)}</caption><thead><tr><th scope="col">Model</th><th scope="col">x coefficient</th><th scope="col">Std. error</th><th scope="col">95% interval</th><th scope="col">N</th><th scope="col">Residual df</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderOverview() {
  const covariance = parameters.robust ? "HC1 robust" : "Conventional";
  $("#coefficient-comparison").innerHTML = comparison(
    compareRow(
      "Without z",
      "regress y x",
      analysis.short,
      parameters.n,
      analysis.simple.df,
    ) +
      compareRow(
        "With z",
        "regress y x z",
        analysis.b,
        parameters.n,
        analysis.full.df,
      ),
    `${covariance} standard errors · identical observations in both models`,
  );
  const difference = analysis.short.b - analysis.b.b;
  $("#experiment-reading").textContent =
    `The unadjusted x coefficient is ${f(analysis.short.b)}; adjustment for z changes it by ${f(-difference)} to ${f(analysis.b.b)}. The original generator's direct effect is ${f(parameters.beta)}. ${perturbation ? "One modified observation is included in both estimates." : "The adjusted estimate still differs from the known effect because this is a finite random sample."}`;
}
function drawPlots() {
  const meanZ =
    analysis.rows.reduce((sum, row) => sum + row.z, 0) / analysis.rows.length;
  const onSelect = (id) => selectObservation(id);
  plots = [
    scatterPlot($("#raw-plot"), {
      points: analysis.rows.map((r) => ({ id: r.id, x: r.x, y: r.y })),
      lines: [
        {
          slope: analysis.short.b,
          intercept: b(analysis.simple, "_cons").b,
          style: "unadjusted",
        },
        {
          slope: analysis.b.b,
          intercept:
            b(analysis.full, "_cons").b + analysis.zCoefficient.b * meanZ,
          style: "adjusted",
        },
      ],
      xLabel: "x",
      yLabel: "y",
      title: "Observed y against x",
      selected,
      onSelect,
    }),
    scatterPlot($("#partial-plot"), {
      points: analysis.residualized,
      lines: [
        { slope: analysis.partialSlope, intercept: 0, style: "adjusted" },
      ],
      xLabel: "x after removing z",
      yLabel: "y after removing z",
      title: "Partial regression of y on x after removing z",
      selected,
      onSelect,
    }),
    scatterPlot($("#influence-plot"), {
      points: analysis.influence.map((r) => ({
        id: r.id,
        x: r.leverage,
        y: r.standardized,
      })),
      xLabel: "Leverage in the full model",
      yLabel: "Standardized residual",
      title: "Leverage and standardized residuals",
      selected,
      onSelect,
    }),
  ];
}
function renderPartial() {
  const row = analysis.rows[selected - 1],
    residual = analysis.residualized[selected - 1];
  $("#residual-steps").innerHTML = [
    [
      "Remove z from x",
      "regress x z",
      `Observed x ${f(row.x)} − fitted x ${f(analysis.xOnZ.fitted[selected - 1])} = residual x ${f(residual.x)}`,
    ],
    [
      "Remove z from y",
      "regress y z",
      `Observed y ${f(row.y)} − fitted y ${f(analysis.yOnZ.fitted[selected - 1])} = residual y ${f(residual.y)}`,
    ],
    [
      "Relate the residuals",
      "regress ry rx, noconstant",
      `Observation ${selected} now appears at (${f(residual.x)}, ${f(residual.y)}) in the partial-regression plot.`,
    ],
  ]
    .map(
      ([title, command, description], i) =>
        `<section><span class="step-index">0${i + 1}</span><h3>${title}</h3><code>${command}</code><p>${description}</p></section>`,
    )
    .join("");
  $("#fwl-equality").innerHTML =
    `<div><span>Full-model x coefficient</span><strong>${f(analysis.b.b)}</strong></div><span class="identity-symbol">=</span><div><span>Partial-regression slope</span><strong>${f(analysis.partialSlope)}</strong></div><small>Difference before display rounding: ${Math.abs(analysis.b.b - analysis.partialSlope).toExponential(1)}</small>`;
  $("#ovb-identity").innerHTML =
    `<div><span>Unadjusted slope</span><strong>${f(analysis.short.b)}</strong></div><span class="identity-symbol">=</span><div><span>Adjusted x slope</span><strong>${f(analysis.b.b)}</strong></div><span class="identity-symbol">+</span><div><span>Fitted z coefficient × slope of z on x</span><strong>${f(analysis.zCoefficient.b)} × ${f(analysis.zOnXSlope)}</strong></div>`;
  $("#population-comparison").textContent =
    `In the original population generator, the unadjusted slope is β + γρ = ${f(parameters.beta)} + (${f(parameters.gamma)} × ${f(parameters.rho)}) = ${f(analysis.populationShortSlope)}. That population expression and the sample decomposition are different statements. ${perturbation ? "The sample includes a manual change, so it is no longer an untouched draw from this generator." : "Neither requires the sample coefficient to equal its population target exactly."}`;
  $("#variation-summary").innerHTML =
    `<div><span>Sample correlation, x and z</span><strong>${f(analysis.sampleCorrelation)}</strong></div><div><span>x variation remaining after adjustment</span><strong>${(100 * analysis.remainingXVariation).toFixed(1)}%</strong></div><div><span>Partial R² of x given z</span><strong>${f(analysis.partialR2)}</strong></div><p>As x becomes more predictable from z, less independent x variation remains. The coefficient can still be defined while its estimated uncertainty grows.</p>`;
  $("#partial-table").innerHTML = table(
    [
      "ID",
      "x",
      "Fitted x on z",
      "Residual x",
      "y",
      "Fitted y on z",
      "Residual y",
    ],
    analysis.rows.map((r, i) => [
      r.id,
      f(r.x),
      f(analysis.xOnZ.fitted[i]),
      f(analysis.residualized[i].x),
      f(r.y),
      f(analysis.yOnZ.fitted[i]),
      f(analysis.residualized[i].y),
    ]),
  );
}
function renderInfluence() {
  const diagnostic = analysis.influence[selected - 1];
  $("#influence-values").innerHTML =
    `<dl><div><dt>Leverage</dt><dd>${f(diagnostic.leverage)}</dd></div><div><dt>Standardized residual</dt><dd>${f(diagnostic.standardized)}</dd></div><div><dt>Cook’s distance</dt><dd>${f(diagnostic.cook)}</dd></div></dl>`;
  const deleted = leaveOneOut(analysis, selected);
  $("#deletion-comparison").innerHTML = comparison(
    compareRow(
      "All observations",
      "regress y x z",
      analysis.b,
      analysis.full.n,
      analysis.full.df,
    ) +
      compareRow(
        `Without observation ${selected}`,
        `regress y x z if id != ${selected}`,
        b(deleted, "x"),
        deleted.n,
        deleted.df,
      ),
    "Sensitivity of the adjusted x coefficient",
  );
  for (const name of ["x", "y"]) {
    const value = perturbation?.id === selected ? perturbation[`d${name}`] : 0;
    $(`#modify-${name}`).value = value;
    $(`#value-modify-${name}`).textContent = fmt(value, 1);
  }
}
function renderStata() {
  $("#lab-code").textContent = regressionDoFile(analysis);
  $("#lab-data-table").innerHTML = table(
    ["id", "x", "z", "y"],
    analysis.rows.map((r) => [r.id, f(r.x), f(r.z), f(r.y)]),
  );
}
function selectObservation(id) {
  if (!Number.isInteger(id) || id < 1 || id > parameters.n) {
    announce(`Choose an observation from 1 to ${parameters.n}.`);
    return;
  }
  selected = id;
  for (const plot of plots) plot.select(id);
  for (const name of ["selected-observation", "influence-observation"]) {
    $(`#${name}`).value = id;
    $(`#${name}`).max = parameters.n;
  }
  const row = analysis.rows[id - 1],
    residual = analysis.residualized[id - 1];
  $("#selected-summary").textContent =
    `x ${f(row.x)} · z ${f(row.z)} · y ${f(row.y)} → residual x ${f(residual.x)}, residual y ${f(residual.y)}`;
  if (activeView === "partial") renderPartial();
  if (activeView === "influence") renderInfluence();
}
function update() {
  try {
    const next = readControls();
    if (perturbation?.id > next.n) {
      perturbation = null;
      announce(
        "The modified observation is outside the new sample size; its modification was cleared.",
      );
    }
    const result = analyzeRegression(next, perturbation);
    analysis = result;
    parameters = result.parameters;
    selected = Math.min(selected, parameters.n);
    $("#lab-error").hidden = true;
    $("#modified-warning").hidden = !perturbation;
    for (const key of ["beta", "gamma", "rho", "sigma"])
      $(`#value-${key}`).textContent = parameters[key].toFixed(
        key === "rho" ? 2 : 1,
      );
    drawPlots();
    renderOverview();
    selectObservation(selected);
    if (activeView === "stata") renderStata();
  } catch (error) {
    $("#lab-error").hidden = false;
    $("#lab-error").textContent =
      `Change not applied: ${error.message} The previous valid experiment remains displayed.`;
  }
}
function setView(name, focus = false) {
  activeView = name;
  for (const item of viewNames) {
    $(`#lab-tab-${item}`).setAttribute("aria-selected", String(item === name));
    $(`#lab-tab-${item}`).tabIndex = item === name ? 0 : -1;
    $(`#lab-panel-${item}`).hidden = item !== name;
  }
  if (name === "partial") renderPartial();
  if (name === "influence") renderInfluence();
  if (name === "stata") renderStata();
  if (focus) $(`#lab-tab-${name}`).focus();
}
for (const name of viewNames) {
  $(`#lab-tab-${name}`).addEventListener("click", () => setView(name));
  $(`#lab-tab-${name}`).addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = viewNames.indexOf(name);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? viewNames.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : viewNames.length - 1)) %
            viewNames.length;
    setView(viewNames[next], true);
  });
}
for (const key of ["beta", "gamma", "rho", "sigma"])
  $(`#parameter-${key}`).addEventListener("input", () => {
    $("#scenario").value = "custom";
    $("#scenario-description").textContent =
      "Compare the displayed estimates as you vary one relationship at a time.";
    update();
  });
for (const name of ["sample-size", "random-seed", "robust-covariance"])
  $(`#${name}`).addEventListener("change", update);
for (const name of ["selected-observation", "influence-observation"])
  $(`#${name}`).addEventListener("change", (event) =>
    selectObservation(Number(event.target.value)),
  );
$("#scenario").addEventListener("change", () => {
  const preset = REGRESSION_PRESETS.find((p) => p.id === $("#scenario").value);
  if (!preset) return;
  parameters = { ...parameters, ...preset.values };
  perturbation = null;
  $("#scenario-description").textContent = preset.description;
  writeControls();
  update();
});
$("#reset-experiment").addEventListener("click", () => {
  parameters = { ...REGRESSION_DEFAULTS };
  perturbation = null;
  selected = 1;
  $("#scenario").value = "confounding";
  $("#scenario-description").textContent = REGRESSION_PRESETS[0].description;
  writeControls();
  update();
  announce("Restored the initial experiment and its original observations.");
});
$("#new-sample").addEventListener("click", () => {
  parameters.seed = parameters.seed === 4294967295 ? 1 : parameters.seed + 1;
  perturbation = null;
  writeControls();
  update();
  announce(`Drew a new sample with seed ${parameters.seed}.`);
});
for (const axis of ["x", "y"])
  $(`#modify-${axis}`).addEventListener("input", () => {
    perturbation = {
      id: selected,
      dx: Number($("#modify-x").value),
      dy: Number($("#modify-y").value),
    };
    if (!perturbation.dx && !perturbation.dy) perturbation = null;
    update();
  });
$("#remove-modification").addEventListener("click", () => {
  perturbation = null;
  update();
  announce("Restored the original observation.");
});
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce(`Prepared ${name}. Check your browser downloads.`);
}
$("#download-lab-data").addEventListener("click", () =>
  download(
    "regression-lab.csv",
    regressionCSV(analysis),
    "text/csv;charset=utf-8",
  ),
);
$("#copy-lab-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(regressionDoFile(analysis));
    announce(
      "Copied the do-file. Export the CSV with it to reproduce this experiment.",
    );
  } catch {
    announce(
      "The browser could not copy the do-file. Use Export experiment to download it.",
    );
  }
});
$("#export-lab").addEventListener("click", () => {
  const files = {
    "regression-lab.csv": strToU8(regressionCSV(analysis)),
    "analysis.do": strToU8(regressionDoFile(analysis)),
    "experiment.json": strToU8(
      JSON.stringify(
        {
          version: 1,
          generator: "STATAverse regression lab / mulberry32 + Box–Muller",
          parameters,
          perturbation,
        },
        null,
        2,
      ),
    ),
    "README.txt": strToU8(
      "STATAverse regression lab\n\nAll data are synthetic. Extract the ZIP, change Stata's working directory to this folder and run analysis.do. The CSV contains the exact displayed observations. The browser seed is not a Stata seed.\n\nThe do-file includes commands that require installed Stata (avplot, estimates, influence diagnostics). The browser practice engine implements a smaller subset.\n\nFull and unadjusted models use the same observations. Partial-regression slopes equal the full-model x coefficient, while default standard errors from a residual regression need not agree. Use the full model for inference. Classical Cook's distance and standardized residuals use conventional residual variance. A diagnostic does not justify automatic deletion.\n",
    ),
  };
  download(
    "stataverse-regression-experiment.zip",
    zipSync(files, { level: 6 }),
    "application/zip",
  );
});
$("#scenario-description").textContent = REGRESSION_PRESETS[0].description;
document.querySelectorAll("[data-lab-jump]").forEach((button) =>
  button.addEventListener("click", () => {
    const name = button.dataset.labJump;
    if (name !== "controls") setView("overview");
    const element =
      name === "controls"
        ? $(".experiment-controls")
        : name === "plots"
          ? $(".lab-tabs")
          : $("#coefficient-comparison");
    element.scrollIntoView({ block: "start" });
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
  }),
);
writeControls();
update();
registerOffline();
