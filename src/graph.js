import { escapeHTML as h, fmt, table } from "./render.js";
export function renderGraph(container, graph) {
  if (!graph) {
    container.innerHTML =
      '<div class="empty-state"><h3>A graph starts with a question.</h3><p>Run a graph command to connect values in the dataset to a visual pattern.</p><code>scatter score hours</code><code>histogram score, frequency</code></div>';
    return;
  }
  const W = 570,
    H = 355,
    left = 62,
    right = 22,
    top = 26,
    bottom = 53;
  const xValues =
    graph.kind === "scatter" ? graph.points.map((p) => p.x) : graph.values;
  let minX = Math.min(...xValues),
    maxX = Math.max(...xValues);
  let bins = [];
  if (graph.kind === "histogram") {
    const nBins = Math.min(
      10,
      Math.max(4, Math.ceil(Math.sqrt(xValues.length))),
    );
    if (minX === maxX) {
      const padding = Math.max(0.5, Math.abs(minX) * 0.05);
      minX -= padding;
      maxX += padding;
    }
    const width = (maxX - minX) / nBins;
    bins = Array.from({ length: nBins }, (_, i) => ({
      lo: minX + i * width,
      hi: minX + (i + 1) * width,
      n: 0,
    }));
    for (const v of xValues)
      bins[Math.min(nBins - 1, Math.floor((v - minX) / width))].n++;
  }
  let minY =
      graph.kind === "scatter" ? Math.min(...graph.points.map((p) => p.y)) : 0,
    maxY =
      graph.kind === "scatter"
        ? Math.max(...graph.points.map((p) => p.y))
        : Math.max(...bins.map((b) => b.n));
  const dx = maxX - minX || Math.max(1, Math.abs(minX) * 0.1),
    dy = maxY - minY || Math.max(1, Math.abs(minY) * 0.1);
  if (graph.kind === "scatter") {
    minX -= dx * 0.08;
    maxX += dx * 0.08;
    minY -= dy * 0.14;
    maxY += dy * 0.14;
  } else maxY += Math.max(1, dy * 0.15);
  const x = (v) => left + ((v - minX) / (maxX - minX)) * (W - left - right),
    y = (v) => H - bottom - ((v - minY) / (maxY - minY)) * (H - top - bottom);
  const marks = Array.from({ length: 6 }, (_, i) => {
    const xv = minX + ((maxX - minX) * i) / 5,
      yv = minY + ((maxY - minY) * i) / 5;
    return `<line class="gridline" x1="${left}" y1="${y(yv)}" x2="${W - right}" y2="${y(yv)}"/><text x="${left - 9}" y="${y(yv) + 3}" text-anchor="end">${fmt(yv, 1)}</text><text x="${x(xv)}" y="${H - bottom + 23}" text-anchor="middle">${fmt(xv, 1)}</text>`;
  }).join("");
  let slope = graph.line?.slope,
    intercept = graph.line?.intercept,
    residuals = false;
  container.innerHTML = `<h3 class="chart-title">${h(graph.title)}</h3><p class="chart-caption">${graph.kind === "scatter" ? `${graph.points.length} complete observations · ${graph.model ? "OLS fitted line in amber" : "One point per observation"}` : `${graph.values.length} observed values · Frequency (count)`}</p><div class="plot-holder"></div><p class="graph-reading" role="status">${graph.kind === "scatter" ? "Select a point to read its coordinates." : "Bar heights count observations in each interval."}</p>${graph.line ? `<section class="graph-controls"><h3>Explore how the fitted line works</h3><p>Move the line and watch the sum of squared residuals change. These controls illustrate the fit; they do not change your regression results.</p><div class="slider-row"><label for="slope">Slope</label><input type="range" id="slope" min="${slope - Math.max(2, Math.abs(slope))}" max="${slope + Math.max(2, Math.abs(slope))}" step="0.01" value="${slope}"><output for="slope" id="slope-value">${fmt(slope)}</output></div><div class="slider-row"><label for="intercept">Intercept</label><input type="range" id="intercept" min="${intercept - dy}" max="${intercept + dy}" step="0.01" value="${intercept}"><output for="intercept" id="intercept-value">${fmt(intercept)}</output></div><label class="residual-toggle"><input type="checkbox" id="show-residuals"> Show residual distances</label><p class="sse-line" aria-live="polite"></p><button type="button" class="quiet-button" id="reset-line">Restore OLS line</button></section>` : ""}<details class="chart-data"><summary>Read the plotted data as a table</summary>${
    graph.kind === "scatter"
      ? table(
          [graph.x, graph.y],
          graph.points.map((p) => [fmt(p.x), fmt(p.y)]),
        )
      : table(
          ["Interval from", "Interval to", "Frequency"],
          bins.map((b) => [fmt(b.lo), fmt(b.hi), b.n]),
        )
  }</details>`;
  function draw() {
    const points =
      graph.kind === "scatter"
        ? graph.points
            .map(
              (p, i) =>
                `${residuals && graph.line ? `<line class="residual-line" x1="${x(p.x)}" x2="${x(p.x)}" y1="${y(p.y)}" y2="${y(intercept + slope * p.x)}"/>` : ""}<circle class="dot" cx="${x(p.x)}" cy="${y(p.y)}" r="4.3" tabindex="0" role="button" data-point="${i}" aria-label="${h(graph.x)} ${fmt(p.x)}, ${h(graph.y)} ${fmt(p.y)}"/>`,
            )
            .join("")
        : bins
            .map(
              (b) =>
                `<rect x="${x(b.lo) + 1}" y="${y(b.n)}" width="${Math.max(0, x(b.hi) - x(b.lo) - 2)}" height="${y(0) - y(b.n)}" fill="#547e5f"><title>${fmt(b.lo)} to ${fmt(b.hi)}: ${b.n} observations</title></rect>`,
            )
            .join("");
    const line = graph.line
      ? `<line class="fit-line" x1="${x(minX)}" x2="${x(maxX)}" y1="${y(intercept + slope * minX)}" y2="${y(intercept + slope * maxX)}"/>`
      : "";
    container.querySelector(".plot-holder").innerHTML =
      `<svg class="plot" viewBox="0 0 ${W} ${H}" role="group" aria-label="${h(graph.title)}"><defs><clipPath id="plot-clip"><rect x="${left}" y="${top}" width="${W - left - right}" height="${H - top - bottom}"/></clipPath></defs>${marks}<g clip-path="url(#plot-clip)">${line}${points}</g><text class="axis-title" x="${(left + W - right) / 2}" y="${H - 8}" text-anchor="middle">${h(graph.x || graph.name)}</text><text class="axis-title" transform="translate(15 ${(top + H - bottom) / 2}) rotate(-90)" text-anchor="middle">${h(graph.y || "Frequency")}</text></svg>`;
    container.querySelectorAll("[data-point]").forEach((dot) => {
      const select = () => {
        const p = graph.points[Number(dot.dataset.point)];
        container.querySelector(".graph-reading").textContent =
          `${graph.x}: ${fmt(p.x)} · ${graph.y}: ${fmt(p.y)}${graph.line ? ` · residual from displayed line: ${fmt(p.y - (intercept + slope * p.x))}` : ""}`;
      };
      dot.addEventListener("click", select);
      dot.addEventListener("focus", select);
      dot.addEventListener("keydown", (e) => {
        if (["Enter", " "].includes(e.key)) {
          e.preventDefault();
          select();
        }
      });
    });
    if (graph.line) {
      const sse = graph.points.reduce(
          (s, p) => s + (p.y - intercept - slope * p.x) ** 2,
          0,
        ),
        ols = graph.points.reduce(
          (s, p) =>
            s + (p.y - graph.line.intercept - graph.line.slope * p.x) ** 2,
          0,
        );
      container.querySelector(".sse-line").textContent =
        `Squared residuals: ${fmt(sse, 2)} · OLS minimum: ${fmt(ols, 2)}`;
    }
  }
  draw();
  if (graph.line) {
    container.querySelector("#slope").addEventListener("input", (e) => {
      slope = Number(e.target.value);
      container.querySelector("#slope-value").value = fmt(slope);
      draw();
    });
    container.querySelector("#intercept").addEventListener("input", (e) => {
      intercept = Number(e.target.value);
      container.querySelector("#intercept-value").value = fmt(intercept);
      draw();
    });
    container
      .querySelector("#show-residuals")
      .addEventListener("change", (e) => {
        residuals = e.target.checked;
        draw();
      });
    container.querySelector("#reset-line").addEventListener("click", () => {
      slope = graph.line.slope;
      intercept = graph.line.intercept;
      container.querySelector("#slope").value = slope;
      container.querySelector("#intercept").value = intercept;
      container.querySelector("#slope-value").value = fmt(slope);
      container.querySelector("#intercept-value").value = fmt(intercept);
      draw();
    });
  }
}
