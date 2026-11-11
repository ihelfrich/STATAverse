// The page side of the Console's map: steps drawn as cards joined by lines,
// beside the do-files they write. The cards are ordinary form controls in
// the order they run, so the map can be read and filled in from the
// keyboard; dragging only rearranges it.
import {
  GROUPS,
  KINDS,
  STARTERS,
  addStep,
  build,
  complete,
  fieldsOf,
  fileOf,
  files,
  followsModel,
  linesOf,
  pathTo,
  removeStep,
  restore,
  rootOf,
  sequence,
  stepOf,
} from "./console-map-model.js";

const KEY = "stataverse:console:map:v1",
  WIDTH = 252,
  ACROSS = 64,
  DOWN = 18,
  EDGE = 16,
  SVG = "http://www.w3.org/2000/svg";
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function mountMap({
  steps,
  links,
  canvas,
  starter,
  code,
  names,
  library,
  uploads,
  run,
  render,
  colour,
}) {
  let map = null,
    focused = null,
    fresh = new Set(),
    shown = null,
    busy = false,
    known = [];
  // Cards show their command; the one being edited also shows its fields.
  const open = new Set(),
    cards = new Map(),
    states = new Map(),
    results = new Map(),
    paths = new Map();
  try {
    map = restore(JSON.parse(localStorage.getItem(KEY)));
  } catch {
    map = null;
  }
  map ??= build(STARTERS[0].tree);
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(map));
    } catch {
      // The map then lasts for this visit only.
    }
  };

  // ----- where each card sits -----
  function arrange() {
    if (!cards.size || !steps.offsetParent) return;
    const height = (step) => cards.get(step.id).offsetHeight,
      children = (step) => map.steps.filter((s) => s.parent === step.id),
      span = (step) => {
        const below = children(step);
        return Math.max(
          height(step),
          below.reduce((sum, child) => sum + span(child), 0) +
            DOWN * Math.max(0, below.length - 1),
        );
      },
      at = new Map();
    const place = (step, depth, top) => {
      const room = span(step),
        below = children(step),
        block =
          below.reduce((sum, child) => sum + span(child), 0) +
          DOWN * Math.max(0, below.length - 1);
      at.set(step.id, {
        x: EDGE + depth * (WIDTH + ACROSS),
        y: top + (room - height(step)) / 2,
      });
      let y = top + (room - block) / 2;
      for (const child of below) {
        place(child, depth + 1, y);
        y += span(child) + DOWN;
      }
    };
    place(rootOf(map), 0, EDGE);
    let right = 0,
      bottom = 0;
    for (const step of map.steps) {
      // A card the student has moved stays where it was put.
      const spot =
        step.x === undefined ? at.get(step.id) : { x: step.x, y: step.y };
      const card = cards.get(step.id);
      card.style.left = `${spot.x}px`;
      card.style.top = `${spot.y}px`;
      right = Math.max(right, spot.x + WIDTH);
      bottom = Math.max(bottom, spot.y + card.offsetHeight);
    }
    canvas.style.width = `${right + EDGE}px`;
    canvas.style.height = `${bottom + EDGE}px`;
    links.setAttribute("width", right + EDGE);
    links.setAttribute("height", bottom + EDGE);
    join();
  }
  function join() {
    for (const step of map.steps) {
      if (step.parent === null) continue;
      const from = cards.get(step.parent),
        to = cards.get(step.id),
        x1 = from.offsetLeft + WIDTH,
        y1 = from.offsetTop + from.offsetHeight / 2,
        x2 = to.offsetLeft,
        y2 = to.offsetTop + Math.min(to.offsetHeight / 2, 60),
        bend = Math.max(24, Math.abs(x2 - x1) / 2);
      paths
        .get(step.id)
        .setAttribute(
          "d",
          `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 - 7} ${y2}`,
        );
    }
  }

  // ----- the do-files the map writes, beside it -----
  let written = new Map();
  function write(changed) {
    const before = written;
    written = new Map();
    code.textContent = "";
    for (const file of files(map)) {
      const block = el("div", "mapcode-file"),
        listing = el("pre", "mapcode-lines");
      block.append(el("h3", "mapcode-name", file.name));
      if (!file.lines.length)
        listing.append(el("span", "mapcode-empty", "(nothing yet)"));
      file.lines.forEach((line, k) => {
        const row = el("span", "mapcode-line"),
          key = `${file.name}\n${k}`;
        row.dataset.step = line.step;
        row.append(colour(line.text));
        written.set(key, line.text);
        // A line that is new or different from a moment ago is marked.
        if (changed && before.size && before.get(key) !== line.text)
          row.classList.add("is-changed");
        listing.append(row, "\n");
      });
      block.append(listing);
      code.append(block);
    }
    if (shown !== null) point(shown, true);
  }
  /** Lights the lines a card wrote, and the card a line belongs to. */
  function point(id, on) {
    shown = on ? id : null;
    for (const row of code.querySelectorAll(".mapcode-line"))
      row.classList.toggle("is-linked", on && Number(row.dataset.step) === id);
    for (const [key, item] of cards)
      item.classList.toggle("is-linked", on && key === id);
  }
  code.addEventListener("click", (event) => {
    const row = event.target.closest(".mapcode-line");
    if (!row) return;
    const id = Number(row.dataset.step),
      item = cards.get(id);
    if (!item) return;
    point(id, true);
    item.scrollIntoView({ block: "center", inline: "center" });
    item.querySelector(".map-edit:not([hidden]), input, select")?.focus();
  });

  // ----- the variable names, to put in a field -----
  function showNames(list) {
    known = list;
    names.textContent = "";
    for (const name of list) {
      const item = el("li"),
        button = el("button", "map-name", name);
      button.type = "button";
      button.title = `Put ${name} in the field you last used`;
      button.addEventListener("click", () => insert(name));
      item.append(button);
      names.append(item);
    }
    if (!list.length)
      names.append(el("li", "map-names-none", "run a step to see them"));
  }
  /** The names in the dataset the first step loads, before anything runs. */
  function expected() {
    const dataset = rootOf(map).fields.dataset ?? "";
    return library[dataset]?.data.columns.map((column) => column.name) ?? [];
  }
  function insert(name) {
    const step = focused && stepOf(map, focused.id),
      control = step
        ? cards.get(step.id)?.querySelector(`[data-field="${focused.field}"]`)
        : null;
    if (!control || control.options || control.closest("[hidden]"))
      return false;
    const before = control.value;
    control.value =
      before && !/[\s(=]$/.test(before) ? `${before} ${name}` : before + name;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.focus();
    return true;
  }

  // ----- one card -----
  function describe(step) {
    const position = sequence(map)
      .filter((entry) => !entry.guard)
      .findIndex((entry) => entry.id === step.id);
    return `step ${position + 1}, ${KINDS[step.kind].title}`;
  }
  function refresh(step) {
    const card = cards.get(step.id),
      kind = KINDS[step.kind],
      lines = kind.file
        ? complete(step)
          ? [`do "${kind.file(step.fields)}"`]
          : []
        : linesOf(step);
    card.querySelector(".map-code").textContent = lines.length
      ? lines.join("\n")
      : "Fill in the fields above.";
    card.dataset.complete = String(complete(step));
    card.querySelector(".map-run").disabled = busy || !complete(step);
    card.shut();
    diagram(step, card);
    outcome(step, card);
  }
  // A model is also drawn as its variables with arrows to the outcome.
  function diagram(step, card) {
    const holder = card.querySelector(".map-paths");
    if (!holder) return;
    holder.textContent = "";
    const fields = step.fields,
      target = String(fields.outcome ?? "").trim(),
      endogenous =
        fields.command === "ivregress 2sls"
          ? String(fields.extra ?? "").split("=")[0]
          : "",
      terms = `${fields.predictors ?? ""} ${endogenous}`
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 8);
    holder.hidden = !target || !terms.length;
    if (holder.hidden) return;
    const from = el("span", "map-from");
    for (const term of terms) {
      const pill = el("span", "map-pill", term),
        estimate = step.estimates?.[term];
      if (estimate !== undefined) {
        pill.append(el("span", "map-estimate", estimate));
        pill.title = `Coefficient on ${term}: ${estimate}`;
      }
      from.append(pill);
    }
    holder.append(
      from,
      el("span", "map-arrow"),
      el("span", "map-pill map-outcome", target),
    );
  }
  // What the step printed when it last ran: an error on the card itself,
  // and the whole output behind a button.
  function outcome(step, card) {
    const result = results.get(step.id),
      peek = card.querySelector(".map-peek"),
      problem = card.querySelector(".map-problem");
    problem.hidden = !result?.rc;
    problem.textContent = result?.rc
      ? result.records
          .at(-1)
          .lines.filter((line) => line.trim())
          .slice(0, 3)
          .join(" ")
      : "";
    peek.hidden = !result || !result.records.length;
  }
  function closeOutput() {
    for (const panel of steps.querySelectorAll(".map-output")) panel.remove();
    for (const button of steps.querySelectorAll(".map-peek"))
      button.setAttribute("aria-expanded", "false");
  }
  function openOutput(step, card, button) {
    const already = card.querySelector(".map-output");
    closeOutput();
    if (already) return;
    const result = results.get(step.id);
    if (!result) return;
    const panel = el("div", "map-output"),
      close = el("button", "map-output-close", "Close"),
      log = el("pre", "map-output-log");
    close.type = "button";
    close.addEventListener("click", () => {
      closeOutput();
      button.focus();
    });
    panel.tabIndex = 0;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", `What ${describe(step)} printed`);
    for (const record of result.records) log.append(render(record));
    panel.append(close, log);
    card.append(panel);
    button.setAttribute("aria-expanded", "true");
    panel.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function card(step) {
    const kind = KINDS[step.kind],
      item = el("li", "map-step"),
      head = el("div", "map-head"),
      title = el("span", "map-kind", kind.title),
      label = describe(step);
    item.dataset.kind = step.kind;
    item.dataset.state = states.get(step.id) ?? "";
    item.setAttribute("aria-label", label);
    const edit = el("button", "map-edit"),
      form = el("div", "map-fields"),
      shut = () => {
        const visible = open.has(step.id) || !complete(step);
        form.hidden = !visible;
        edit.textContent = visible ? "Done" : "Edit";
        edit.setAttribute("aria-expanded", String(visible));
        edit.hidden = !complete(step);
      };
    edit.type = "button";
    edit.addEventListener("click", () => {
      if (open.has(step.id)) open.delete(step.id);
      else open.add(step.id);
      shut();
      arrange();
      if (!form.hidden) form.querySelector("input, select, textarea")?.focus();
    });
    item.shut = shut;
    head.append(title, el("span", "map-state"), edit);
    if (step.parent !== null) {
      const remove = el("button", "map-remove", "×");
      remove.type = "button";
      remove.setAttribute(
        "aria-label",
        `Remove ${label} and the steps after it`,
      );
      remove.addEventListener("click", () => {
        removeStep(map, step.id);
        save();
        draw();
      });
      head.append(remove);
    }
    item.append(head);
    drag(head, step, item);
    item.addEventListener("pointerenter", () => point(step.id, true));
    item.addEventListener("pointerleave", () => point(step.id, false));
    item.addEventListener("focusin", () => point(step.id, true));

    for (const field of fieldsOf(step)) {
      const wrap = el("label", "map-field"),
        caption = el("span", "", field.label);
      let control;
      if (field.type === "dataset") {
        control = el("select");
        control.append(new Option("no data (start empty)", ""));
        const site = el("optgroup");
        site.label = "This site's datasets";
        for (const entry of Object.values(library))
          site.append(new Option(`${entry.id}: ${entry.title}`, entry.id));
        control.append(site);
        const own = uploads().filter((name) => !/\.do$/i.test(name));
        // A file named by a saved map is offered even before it is added
        // again, so that the choice is not silently changed.
        const wanted = fileOf(step.fields.dataset ?? "");
        if (wanted && !own.includes(wanted)) own.push(wanted);
        if (own.length) {
          const mine = el("optgroup");
          mine.label = "Your files";
          for (const name of own) mine.append(new Option(name, `file:${name}`));
          control.append(mine);
        }
      } else if (field.options) {
        control = el("select");
        for (const option of field.options) control.append(new Option(option));
      } else if (field.type === "lines") {
        control = el("textarea");
        control.rows = 3;
      } else {
        control = el("input");
        control.type = "text";
      }
      if (!control.options) {
        control.placeholder = field.placeholder ?? "";
        control.spellcheck = false;
        control.autocapitalize = "off";
        control.autocomplete = "off";
      }
      control.value = step.fields[field.id] ?? "";
      control.dataset.field = field.id;
      control.addEventListener("focus", () => {
        focused = { id: step.id, field: field.id };
      });
      control.addEventListener(control.options ? "change" : "input", () => {
        step.fields[field.id] = control.value;
        open.add(step.id);
        delete step.estimates;
        results.delete(step.id);
        save();
        // A choice can change which fields apply, so the map is drawn again.
        if (control.options) {
          draw({ id: step.id, field: field.id }, true);
          if (field.type === "dataset") showNames(expected());
        } else {
          refresh(step);
          arrange();
          write(true);
        }
      });
      wrap.append(caption, control);
      form.append(wrap);
    }
    item.append(form);
    if (kind.model) item.append(el("div", "map-paths"));
    item.append(el("code", "map-code"));
    const problem = el("p", "map-problem");
    problem.hidden = true;
    item.append(problem);

    const foot = el("div", "map-foot"),
      go = el("button", "map-run", "Run to here"),
      peek = el("button", "map-peek", "Result"),
      more = el("select", "map-add");
    go.type = "button";
    go.addEventListener("click", () => start(pathTo(map, step.id)));
    peek.type = "button";
    peek.hidden = true;
    peek.setAttribute("aria-expanded", "false");
    peek.addEventListener("click", () => openOutput(step, item, peek));
    more.setAttribute("aria-label", `Add a step after ${label}`);
    more.append(new Option("Add a step…", ""));
    for (const group of GROUPS) {
      const section = el("optgroup");
      section.label = group;
      for (const [id, next] of Object.entries(KINDS)) {
        if (id === "data" || next.group !== group) continue;
        if (next.needsModel && !followsModel(map, step.id)) continue;
        section.append(new Option(`${next.title}: ${next.hint}`, id));
      }
      if (section.children.length) more.append(section);
    }
    more.addEventListener("change", () => {
      if (!more.value) return;
      const added = addStep(map, step.id, more.value);
      fresh = new Set([added.id]);
      open.add(added.id);
      save();
      draw({ id: added.id }, true);
    });
    foot.append(go, peek, more);
    item.append(foot);
    return item;
  }
  function drag(handle, step, item) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button") || event.button) return;
      const startX = event.clientX - item.offsetLeft,
        startY = event.clientY - item.offsetTop;
      let moved = false;
      handle.setPointerCapture(event.pointerId);
      const move = (e) => {
        const x = Math.max(0, e.clientX - startX),
          y = Math.max(0, e.clientY - startY);
        if (!moved && Math.hypot(x - item.offsetLeft, y - item.offsetTop) < 4)
          return;
        moved = true;
        item.classList.add("is-dragged");
        item.style.left = `${x}px`;
        item.style.top = `${y}px`;
        join();
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        item.classList.remove("is-dragged");
        if (!moved) return;
        step.x = item.offsetLeft;
        step.y = item.offsetTop;
        save();
        arrange();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
  }

  // ----- the whole map -----
  function draw(focus, changed = false) {
    steps.textContent = "";
    links.textContent = "";
    cards.clear();
    paths.clear();
    // Cards go in the order they run, which is the order they are read in.
    const order = sequence(map).filter((entry) => !entry.guard);
    for (const { id } of order) {
      const step = stepOf(map, id),
        item = card(step);
      if (fresh.has(id)) item.classList.add("is-new");
      cards.set(id, item);
      steps.append(item);
      if (step.parent !== null) {
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("class", "map-link");
        path.dataset.state = states.get(id) ?? "";
        if (fresh.has(id)) path.classList.add("is-new");
        paths.set(id, path);
        links.append(path);
      }
      refresh(step);
    }
    if (fresh.size)
      // A new link is drawn in once; after that its dashes would leave gaps.
      setTimeout(() => {
        for (const node of [...cards.values(), ...paths.values()])
          node.classList.remove("is-new");
      }, 700);
    fresh = new Set();
    arrange();
    write(changed);
    if (!known.length) showNames(expected());
    if (focus) {
      const target = cards
        .get(focus.id)
        ?.querySelector(
          focus.field ? `[data-field="${focus.field}"]` : "input, select",
        );
      target?.focus({ preventScroll: false });
    }
  }
  function mark(id, state, result) {
    states.set(id, state);
    if (result) {
      // Guard commands (preserve, restore) share the card of their branch.
      const before = results.get(id);
      results.set(id, {
        rc: result.rc,
        records: [...(before?.records ?? []), ...result.output],
      });
    }
    const item = cards.get(id);
    if (item) {
      item.dataset.state = state;
      const step = stepOf(map, id);
      if (step) outcome(step, item);
    }
    const path = paths.get(id);
    if (path) path.dataset.state = state;
    if (state === "running")
      item?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  async function start(entries) {
    if (busy) return;
    closeOutput();
    states.clear();
    results.clear();
    for (const step of map.steps) mark(step.id, "");
    await run(
      entries.filter((entry) => entry.lines.length),
      mark,
    );
    arrange();
  }
  window.addEventListener("resize", arrange);

  for (const entry of STARTERS)
    starter.append(new Option(entry.title, entry.id));
  starter.addEventListener("change", () => {
    const chosen = STARTERS.find((entry) => entry.id === starter.value);
    starter.value = "";
    if (!chosen) return;
    map = build(chosen.tree);
    states.clear();
    results.clear();
    open.clear();
    fresh = new Set(map.steps.map((step) => step.id));
    save();
    showNames(expected());
    draw();
  });

  return {
    draw,
    files: () =>
      files(map).map((file) => ({
        name: file.name,
        text: file.lines.map((line) => line.text).join("\n") + "\n",
      })),
    runAll: () => start(sequence(map)),
    tidy() {
      for (const step of map.steps) {
        delete step.x;
        delete step.y;
      }
      save();
      arrange();
    },
    setBusy(running) {
      busy = running;
      for (const step of map.steps) {
        const button = cards.get(step.id)?.querySelector(".map-run");
        if (button) button.disabled = running || !complete(step);
      }
    },
    setNames: (list) => showNames(list.length ? list : expected()),
    /** The plain variable names of a model step, for reading coefficients. */
    termsOf(id) {
      const step = stepOf(map, id);
      if (!step || !KINDS[step.kind].model) return [];
      const endogenous =
        step.fields.command === "ivregress 2sls"
          ? String(step.fields.extra ?? "").split("=")[0]
          : "";
      return `${step.fields.predictors ?? ""} ${endogenous}`
        .trim()
        .split(/\s+/)
        .filter((term) => /^[A-Za-z_]\w*$/.test(term))
        .slice(0, 8);
    },
    setEstimates(id, estimates) {
      const step = stepOf(map, id);
      if (!step) return;
      step.estimates = estimates;
      const item = cards.get(id);
      if (item) {
        diagram(step, item);
        arrange();
      }
    },
    /** Starts the map again from one of the student's files. */
    startFrom(name) {
      map = build(["data", { dataset: `file:${name}` }]);
      states.clear();
      results.clear();
      open.clear();
      save();
      known = [];
      draw();
    },
    insert,
  };
}
