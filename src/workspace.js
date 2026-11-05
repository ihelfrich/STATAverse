import { PRACTICE_KEY, parseStore, validateBackup } from "./persistence.js";
import { BUILDER_KEY, validateBuilder } from "./do-builder-model.js";
import {
  LAB_PROGRESS_KEY,
  parseLabProgress,
  withLabProgressLock,
  renewLabProgress,
} from "./lab-progress.js";
import { INVESTIGATION_CATALOG } from "./labs/investigation-catalog.js";
const $ = (selector) => document.querySelector(selector);
const fields = ["name", "role", "focus"];
const status = $("#workspace-status");
function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle("workspace-error", error);
}
function keys() {
  return Object.keys(localStorage).filter(
    (key) =>
      key === "stataverse:user" ||
      key === PRACTICE_KEY ||
      key === BUILDER_KEY ||
      key === LAB_PROGRESS_KEY ||
      key.startsWith("stataverse:progress:"),
  );
}
function collect() {
  const raw = localStorage.getItem(PRACTICE_KEY);
  const builder = localStorage.getItem(BUILDER_KEY);
  const labs = localStorage.getItem(LAB_PROGRESS_KEY);
  const labProgress = labs !== null ? parseLabProgress(labs) : null;
  if (labProgress) delete labProgress.generation;
  const hasLabWork =
    labProgress &&
    (Object.keys(labProgress.completed).length ||
      Object.keys(labProgress.drafts || {}).length);
  return validateBackup({
    profile: JSON.parse(localStorage.getItem("stataverse:user") || "{}"),
    progress: Object.fromEntries(
      keys()
        .filter((key) => key.startsWith("stataverse:progress:"))
        .map((key) => [key, localStorage.getItem(key)]),
    ),
    ...(raw ? { practice: parseStore(raw) } : {}),
    ...(builder ? { builder: validateBuilder(JSON.parse(builder)) } : {}),
    ...(hasLabWork ? { labs: labProgress } : {}),
  });
}
function refresh() {
  try {
    const data = collect();
    for (const field of fields)
      $(`#workspace-${field}`).value = data.profile[field];
    const legacy = Object.values(data.progress).map(JSON.parse),
      guided = Object.values(data.practice?.lessons || {}),
      labs = [
        ...new Set([
          ...Object.keys(data.labs?.completed || {}),
          ...Object.keys(data.labs?.drafts || {}),
        ]),
      ].map((id) => [id, data.labs?.completed[id] || []]),
      free = Object.values(data.practice?.free || {});
    $("[data-modules-count]").textContent =
      legacy.length + guided.length + labs.length;
    $("[data-tasks-count]").textContent =
      legacy.reduce((n, item) => n + item.checks.filter(Boolean).length, 0) +
      guided.reduce((n, item) => n + item.completed.length, 0) +
      labs.reduce((n, [, steps]) => n + steps.length, 0);
    $("[data-notes-count]").textContent =
      legacy.reduce(
        (n, item) =>
          n + Object.values(item.notes).filter((note) => note.trim()).length,
        0,
      ) +
      [...guided, ...free, ...Object.values(data.labs?.drafts || {})].filter(
        (item) => item.note.trim(),
      ).length;
    $("[data-progress-detail]").textContent =
      `${guided.length} practice lessons, ${free.length} open datasets, ${labs.length} lab investigations and ${legacy.length} reading modules saved on this device. Reading checkboxes are self-reported; practice and investigation tasks use supported checks rather than secure assessments.`;
    $("#lab-resume-links").replaceChildren();
    if (data.builder) {
      const link = document.createElement("a");
      link.href = "../ScriptLibrary/builder.html";
      link.textContent = "Do-file builder: resume saved plan";
      $("#lab-resume-links").append(link);
    }
    for (const [id, steps] of labs) {
      const guide = INVESTIGATION_CATALOG.find((g) => g.id === id),
        link = document.createElement("a");
      const draft = data.labs?.drafts?.[id];
      link.href = `../${guide.path}${draft ? `&step=${draft.step}` : ""}`;
      link.textContent = `${guide.title}: ${steps.length}/${guide.steps.length} tasks checked${draft ? ` · resume ${guide.steps.find((s) => s.id === draft.step).title}` : ""}`;
      $("#lab-resume-links").append(link);
    }
  } catch (error) {
    report(
      `Saved work could not be read: ${error.message} Existing data have been left in place.`,
      true,
    );
  }
}
function writeAtomically(changes) {
  const before = new Map(
    changes.map(([key]) => [key, localStorage.getItem(key)]),
  );
  try {
    for (const [key, value] of changes) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  } catch (error) {
    let restored = true;
    for (const [key, value] of before) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        restored = false;
      }
    }
    throw new Error(
      restored
        ? "Browser storage refused the change. The previous saved work was restored."
        : "Browser storage refused the change and recovery was incomplete. Keep your backup file; do not close an open practice session.",
    );
  }
}
for (const field of fields)
  $(`#workspace-${field}`).addEventListener("input", () => {
    try {
      localStorage.setItem(
        "stataverse:user",
        JSON.stringify(
          Object.fromEntries(
            fields.map((name) => [name, $(`#workspace-${name}`).value]),
          ),
        ),
      );
      report("Profile saved on this device.");
    } catch {
      report(
        "This browser could not save the profile. Browser storage may be disabled or full.",
        true,
      );
    }
  });
$("[data-export-notes]").addEventListener("click", () => {
  try {
    const blob = new Blob([JSON.stringify(collect(), null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "stataverse-workspace.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    report(
      "Prepared a backup with practice commands, progress and notes. Check your downloads.",
    );
  } catch (error) {
    report(`Backup could not be created: ${error.message}`, true);
  }
});
$("#workspace-import").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 5000000)
      throw new Error("The backup exceeds the 5 MB limit.");
    const data = validateBackup(JSON.parse(await file.text()));
    const changes = [
      ["stataverse:user", JSON.stringify(data.profile)],
      ...Object.entries(data.progress),
      ...(data.practice ? [[PRACTICE_KEY, JSON.stringify(data.practice)]] : []),
      ...(data.builder ? [[BUILDER_KEY, JSON.stringify(data.builder)]] : []),
      ...(data.labs
        ? [[LAB_PROGRESS_KEY, JSON.stringify(renewLabProgress(data.labs))]]
        : []),
    ];
    const overwrites = changes.filter(
      ([key]) => localStorage.getItem(key) !== null,
    ).length;
    if (
      overwrites &&
      !confirm(
        `Import this backup? It will replace ${overwrites} existing saved section(s), including the profile. Export a backup first if you need to keep both. Other saved sections will remain.`,
      )
    ) {
      report("Import canceled. Your saved work is unchanged.");
      return;
    }
    await withLabProgressLock(() => writeAtomically(changes));
    refresh();
    report(
      "Backup imported. Reload any open practice or lab tab to use the imported work.",
    );
  } catch (error) {
    report(`Import failed: ${error.message}`, true);
  }
});
$("[data-clear-notes]").addEventListener("click", async () => {
  if (
    !confirm(
      "Clear all STATAverse practice, notes and profile on this device? Export a backup first if you want to keep them.",
    )
  )
    return;
  try {
    await withLabProgressLock(() =>
      writeAtomically([
        ...keys()
          .filter((key) => key !== LAB_PROGRESS_KEY)
          .map((key) => [key, null]),
        [LAB_PROGRESS_KEY, JSON.stringify(renewLabProgress())],
      ]),
    );
    refresh();
    report(
      "STATAverse saved work cleared on this device. Reload any open practice tab.",
    );
  } catch (error) {
    report(error.message, true);
  }
});
window.addEventListener("storage", (event) => {
  if (
    event.key === null ||
    event.key === PRACTICE_KEY ||
    event.key === BUILDER_KEY ||
    event.key?.startsWith("stataverse:")
  )
    refresh();
});
refresh();
