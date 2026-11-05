import { PracticeSession } from "./engine.js";
import { table, fmt } from "./render.js";
import { registerOffline } from "./offline.js";
const session = new PracticeSession(),
  commands = {
    scatter: "scatter score hours",
    summarize: "summarize hours score",
    regress: "regress score hours",
  };
function show(command) {
  session.load("study");
  const result = session.run(commands[command]).at(-1);
  document.querySelector("#preview-command").textContent =
    ". " + commands[command];
  document
    .querySelectorAll("[data-preview]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.preview === command)),
    );
  const container = document.querySelector("#preview-result");
  if (command === "summarize") {
    container.innerHTML =
      table(
        ["Variable", "Obs.", "Mean", "Std. dev."],
        result.stats.map((s) => [s.name, s.n, fmt(s.mean), fmt(s.sd)]),
      ) +
      '<p class="result-annotation">24 rows are in memory. Each variable has 23 nonmissing values; they are missing in different rows.</p>';
    document.querySelector("#preview-reading").textContent =
      "A variable’s observation count can differ from the dataset’s row count.";
  } else if (command === "regress") {
    container.innerHTML =
      `<div class="result-metrics"><div class="result-metric">Observations<strong>${result.model.n}</strong></div><div class="result-metric">R-squared<strong>${fmt(result.model.r2)}</strong></div></div>` +
      table(
        ["Variable", "Coefficient", "Std. err."],
        result.model.coefficients.map((c) => [c.name, fmt(c.b), fmt(c.se)]),
      ) +
      '<p class="result-annotation">An additional study hour is associated with about 5.28 more score points here. This is a fitted association in synthetic data, not an estimated intervention effect.</p>';
    document.querySelector("#preview-reading").textContent =
      "The model uses 22 observations with both hours and score observed.";
  } else {
    const points = result.graph.points,
      x = (v) => 49 + ((v - 1) / 9) * 380,
      y = (v) => 230 - ((v - 40) / 60) * 205;
    container.innerHTML = `<svg viewBox="0 0 470 285" role="img" aria-label="Scatterplot of exam score against study hours for 22 complete fictional observations; scores generally increase with hours.">${[40, 50, 60, 70, 80, 90, 100].map((v) => `<line x1="49" x2="429" y1="${y(v)}" y2="${y(v)}" stroke="#e0e8d9"/><text x="38" y="${y(v) + 3}" text-anchor="end" fill="#627459" font-size="10" font-family="monospace">${v}</text>`).join("")}${[2, 4, 6, 8, 10].map((v) => `<text x="${x(v)}" y="253" text-anchor="middle" fill="#627459" font-size="10" font-family="monospace">${v}</text>`).join("")}${points.map((p) => `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="4.2" fill="#507e5b" stroke="white" stroke-width="1"/>`).join("")}<text x="239" y="278" text-anchor="middle" fill="#52634e" font-size="11" font-family="sans-serif">Weekly study hours</text><text x="49" y="13" fill="#52634e" font-size="10" font-family="sans-serif">Exam score</text></svg>`;
    document.querySelector("#preview-reading").textContent =
      "Each point connects two values from the same observation.";
  }
}
document
  .querySelectorAll("[data-preview]")
  .forEach((b) => b.addEventListener("click", () => show(b.dataset.preview)));
show("scatter");
registerOffline();
