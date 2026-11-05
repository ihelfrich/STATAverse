import { escapeHTML as h, fmt } from "../render.js";
import { INFERENCE_METHODS } from "./inference-model.js";
const dimensions = (container) =>
  Math.max(
    340,
    Math.min(1000, container.getBoundingClientRect().width || innerWidth - 64),
  );
function scaleFor(width, values, left) {
  const low = Math.min(...values),
    high = Math.max(...values),
    span = high - low || 1;
  const min = low - 0.12 * span,
    max = high + 0.12 * span;
  return {
    min,
    max,
    x: (value) => left + ((value - min) / (max - min)) * (width - left - 22),
  };
}
function ticks(scale, y, width, left) {
  return (
    `<line class="axis" x1="${left}" x2="${width - 22}" y1="${y}" y2="${y}"/>` +
    Array.from({ length: 3 }, (_, i) => {
      const value = scale.min + (i * (scale.max - scale.min)) / 2;
      return `<text x="${scale.x(value)}" y="${y + 22}" text-anchor="middle">${fmt(value, 2)}</text>`;
    }).join("")
  );
}
export function singleIntervals(container, sample) {
  const width = dimensions(container),
    left = width < 500 ? 105 : 175,
    height = 192;
  const values = [
    sample.parameters.beta,
    ...Object.values(sample.methods).flatMap((m) => [m.lo, m.hi]),
  ];
  const scale = scaleFor(width, values, left);
  container.innerHTML = `<svg class="inference-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${sample.parameters.confidence * 100}% intervals for the same coefficient; exact values in the following table"><line class="target" x1="${scale.x(sample.parameters.beta)}" x2="${scale.x(sample.parameters.beta)}" y1="24" y2="148"/><text x="${scale.x(sample.parameters.beta)}" y="14" text-anchor="middle">β</text>${INFERENCE_METHODS.map(
    ({ id, title }, i) => {
      const method = sample.methods[id],
        y = 42 + i * 43,
        style = method.covers ? "covered" : "missed";
      return `<text class="label" x="4" y="${y + 4}">${h(width < 500 ? { conventional: "Conventional", hc1: "HC1", cluster: "CR1" }[id] : title)}</text><line class="estimate-line ${style}" x1="${scale.x(method.lo)}" x2="${scale.x(method.hi)}" y1="${y}" y2="${y}"/><circle class="${style}" cx="${scale.x(sample.b)}" cy="${y}" r="5"/>`;
    },
  ).join("")}${ticks(scale, 154, width, left)}</svg>`;
}
export function repeatedIntervals(
  container,
  { records, parameters, method, start, selected, onSelect },
) {
  const entries = records.slice(start, start + 60),
    width = dimensions(container),
    left = 42;
  const scale = scaleFor(
    width,
    [
      parameters.beta,
      ...entries.flatMap((r) =>
        INFERENCE_METHODS.flatMap(({ id }) => [
          r.methods[id].lo,
          r.methods[id].hi,
        ]),
      ),
    ],
    left,
  );
  const height = entries.length * 9 + 74;
  container.innerHTML = `<svg class="inference-chart" viewBox="0 0 ${width} ${height}" tabindex="0" role="group" aria-label="Intervals for samples ${start + 1} through ${start + entries.length}. Selected sample ${selected + 1}. Use arrow keys to change the selection."><line class="target" x1="${scale.x(parameters.beta)}" x2="${scale.x(parameters.beta)}" y1="24" y2="${height - 40}"/><text x="${scale.x(parameters.beta)}" y="14" text-anchor="middle">β = ${fmt(parameters.beta, 2)}</text>${entries
    .map((record, i) => {
      const ci = record.methods[method],
        y = 30 + i * 9,
        style = ci.covers ? "covered" : "missed";
      return `<g data-replication="${record.replication}"><line class="${style} ${record.replication === selected ? "selected-interval" : ""}" x1="${scale.x(ci.lo)}" x2="${scale.x(ci.hi)}" y1="${y}" y2="${y}"/><circle class="${style}" cx="${scale.x(record.b)}" cy="${y}" r="${record.replication === selected ? 3.5 : 1.8}"/>${ci.covers ? "" : `<path class="missed" d="M ${scale.x(record.b) - 3} ${y - 3} l 6 6 m -6 0 l 6 -6"/>`}<line class="interval-hit" x1="${left}" x2="${width - 22}" y1="${y}" y2="${y}"/>${i % 10 === 0 ? `<text x="4" y="${y + 4}">${record.replication + 1}</text>` : ""}</g>`;
    })
    .join("")}${ticks(scale, height - 35, width, left)}</svg>`;
  const svg = container.querySelector("svg");
  svg.addEventListener("click", (event) => {
    const target = event.target.closest("[data-replication]");
    if (target) onSelect(Number(target.dataset.replication), false);
  });
  svg.addEventListener("keydown", (event) => {
    const changes = {
      ArrowLeft: -1,
      ArrowUp: -1,
      ArrowRight: 1,
      ArrowDown: 1,
      Home: -selected,
      End: records.length - 1 - selected,
    };
    if (Object.hasOwn(changes, event.key)) {
      event.preventDefault();
      onSelect(
        Math.max(
          0,
          Math.min(records.length - 1, selected + changes[event.key]),
        ),
        true,
      );
    }
  });
}
