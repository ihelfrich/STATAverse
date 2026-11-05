import { escapeHTML as h, fmt } from "../render.js";

let plotSerial = 0;
/** SVG plot with one keyboard stop, arrow-key point navigation and linked selection. */
export function scatterPlot(
  container,
  {
    points,
    lines = [],
    xLabel,
    yLabel,
    title,
    selected = 1,
    onSelect,
    zero = true,
  },
) {
  const width = 560,
    height = 340,
    margin = { left: 104, right: 24, top: 24, bottom: 60 };
  const extent = (values) => {
    const low = Math.min(...values),
      high = Math.max(...values),
      span = high - low || 1;
    return [low - span * 0.1, high + span * 0.1];
  };
  const [xMin, xMax] = extent(points.map((p) => p.x));
  const [yMin, yMax] = extent(points.map((p) => p.y));
  const x = (v) =>
    margin.left +
    ((v - xMin) / (xMax - xMin)) * (width - margin.left - margin.right);
  const y = (v) =>
    height -
    margin.bottom -
    ((v - yMin) / (yMax - yMin)) * (height - margin.top - margin.bottom);
  const clip = `lab-plot-${++plotSerial}`;
  const tickDigits = (span) =>
    Math.max(1, Math.min(4, Math.ceil(-Math.log10(span / 4))));
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const xv = xMin + (i * (xMax - xMin)) / 4,
      yv = yMin + (i * (yMax - yMin)) / 4;
    return `<line class="lab-gridline" x1="${margin.left}" x2="${width - margin.right}" y1="${y(yv)}" y2="${y(yv)}"/><text x="${margin.left - 9}" y="${y(yv) + 4}" text-anchor="end">${fmt(yv, tickDigits(yMax - yMin))}</text><text x="${x(xv)}" y="${height - margin.bottom + 23}" text-anchor="middle">${fmt(xv, tickDigits(xMax - xMin))}</text>`;
  }).join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="lab-scatter" role="group" aria-label="${h(title)}"><desc>${h(xLabel)} on the horizontal axis and ${h(yLabel)} on the vertical axis. Each point is one synthetic observation. Select a point, or use arrow keys while a point has focus, to inspect the same observation across views.</desc><defs><clipPath id="${clip}"><rect x="${margin.left}" y="${margin.top}" width="${width - margin.left - margin.right}" height="${height - margin.top - margin.bottom}"/></clipPath></defs>${ticks}<g clip-path="url(#${clip})">${zero && xMin < 0 && xMax > 0 ? `<line class="lab-zero" x1="${x(0)}" x2="${x(0)}" y1="${margin.top}" y2="${height - margin.bottom}"/>` : ""}${zero && yMin < 0 && yMax > 0 ? `<line class="lab-zero" x1="${margin.left}" x2="${width - margin.right}" y1="${y(0)}" y2="${y(0)}"/>` : ""}${lines.map((line) => `<line class="lab-fit ${h(line.style || "")}" x1="${x(xMin)}" y1="${y(line.intercept + line.slope * xMin)}" x2="${x(xMax)}" y2="${y(line.intercept + line.slope * xMax)}"/>`).join("")}${points.map((p) => `<circle class="lab-point ${p.id === selected ? "selected" : ""}" data-observation="${p.id}" cx="${x(p.x)}" cy="${y(p.y)}" r="${p.id === selected ? 6 : 3.8}" tabindex="${p.id === selected ? 0 : -1}" role="button" aria-pressed="${p.id === selected}" aria-label="Observation ${p.id}: ${h(xLabel)} ${fmt(p.x)}, ${h(yLabel)} ${fmt(p.y)}"/>`).join("")}</g><text class="lab-axis-title" x="${(margin.left + width - margin.right) / 2}" y="${height - 7}" text-anchor="middle">${h(xLabel)}</text><text class="lab-axis-title" transform="translate(15 ${(margin.top + height - margin.bottom) / 2}) rotate(-90)" text-anchor="middle">${h(yLabel)}</text></svg>`;
  for (const point of container.querySelectorAll("[data-observation]")) {
    point.addEventListener("click", () =>
      onSelect(Number(point.dataset.observation)),
    );
    point.addEventListener("keydown", (event) => {
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key)
      ) {
        event.preventDefault();
        const index = points.findIndex(
          (p) => p.id === Number(point.dataset.observation),
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? points.length - 1
              : (index +
                  (["ArrowRight", "ArrowDown"].includes(event.key)
                    ? 1
                    : points.length - 1)) %
                points.length;
        onSelect(points[next].id);
        container
          .querySelector(`[data-observation="${points[next].id}"]`)
          .focus();
      } else if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        onSelect(Number(point.dataset.observation));
      }
    });
  }
  return {
    select(id) {
      for (const point of container.querySelectorAll("[data-observation]")) {
        const active = Number(point.dataset.observation) === id;
        point.classList.toggle("selected", active);
        point.setAttribute("aria-pressed", String(active));
        point.setAttribute("tabindex", active ? "0" : "-1");
        point.setAttribute("r", active ? "6" : "3.8");
      }
    },
  };
}
