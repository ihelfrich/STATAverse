// The data browser: Stata's Data Editor as a drawer of the Console. browse
// and edit open it; it shows the data in memory a page at a time, in the
// order of a column if asked, limited to rows where a value contains what
// is looked for, with value labels or the numbers under them. With editing
// on, a changed value is made by a replace command that is run and shown
// in Results, as the Data Editor shows the command it ran.

const PAGE = 100;

/**
 * A string as an expression whose value is exactly that text. Stata reads
 * $name and `name' inside quotes as macros, and a backslash before either
 * as an escape, so those characters, and the double quote, are joined in
 * with char() rather than written inside the quotes.
 */
export function stringValue(text) {
  const pieces = [];
  for (const [, plain, special] of String(text).matchAll(
    /([^"$`]*)(["$`]?)/g,
  )) {
    if (plain) pieces.push(`"${plain}"`);
    if (special) pieces.push(`char(${special.charCodeAt(0)})`);
  }
  return pieces.length ? pieces.join(" + ") : '""';
}

/**
 * A value as Stata reads it in an expression of a replace command. In a
 * variable with a value label, the label's text stands for its number, as
 * Stata's Data Editor takes it; `column.codes` holds the label's pairs.
 */
export function replaceValue(text, column) {
  const typed = text.trim();
  if (/^str/.test(column.type)) return stringValue(text);
  if (typed === "" || /^\.[a-z]?$/.test(typed)) return typed || ".";
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(typed)) return typed;
  const codes = column.codes ?? [],
    named =
      codes.find(([, label]) => label === typed) ??
      codes.find(([, label]) => label.toLowerCase() === typed.toLowerCase());
  if (named) return String(named[0]);
  return null;
}

/**
 * A value as the editor offers it for change. A float is shown as the
 * shortest decimal stored as the same float, so that one made from 4.1
 * reads 4.1, as in Stata's Data Editor, and not 4.099999904632568.
 */
export function editText(value, type) {
  if (value === null) return ".";
  if (typeof value !== "number" || type !== "float") return String(value);
  for (let digits = 1; digits <= 9; digits++) {
    const text = String(Number(value.toPrecision(digits)));
    if (Math.fround(Number(text)) === value) return text;
  }
  return String(value);
}

export function mountBrowser({ drawer, ask, run, onOpen }) {
  const $ = (id) => document.getElementById(id),
    table = $("browse-table"),
    head = table.querySelector("thead"),
    body = table.querySelector("tbody"),
    find = $("browse-find"),
    labels = $("browse-labels"),
    editing = $("browse-edit"),
    range = $("browse-range"),
    note = $("browse-note"),
    scope = $("browse-where"),
    whole = $("browse-all"),
    previous = $("browse-prev"),
    next = $("browse-next"),
    go = $("browse-go");
  const state = {
    where: "",
    from: 0,
    order: null,
    find: "",
    labels: true,
    edit: false,
  };
  let page = null,
    // The cell to put the focus back on once a change has been made.
    refocus = null,
    asked = 0,
    busy = false;

  function header(columns) {
    const row = document.createElement("tr"),
      corner = document.createElement("th");
    corner.scope = "col";
    corner.textContent = "Obs";
    row.append(corner);
    for (const column of columns) {
      const cell = document.createElement("th"),
        button = document.createElement("button"),
        type = document.createElement("span");
      cell.scope = "col";
      const sorted = state.order?.name === column.name;
      cell.setAttribute(
        "aria-sort",
        sorted ? (state.order.descending ? "descending" : "ascending") : "none",
      );
      button.type = "button";
      button.className = "browse-sort";
      button.textContent = column.name;
      button.title = [
        column.label,
        `Sort the view by ${column.name}; the data in memory keep their order`,
      ]
        .filter(Boolean)
        .join(". ");
      button.addEventListener("click", () => {
        state.order =
          state.order?.name !== column.name
            ? { name: column.name, descending: false }
            : state.order.descending
              ? null
              : { name: column.name, descending: true };
        state.from = 0;
        refresh();
      });
      type.className = "browse-type";
      type.textContent = column.valueLabel
        ? `${column.type} · ${column.valueLabel}`
        : column.type;
      cell.append(button, type);
      row.append(cell);
    }
    head.textContent = "";
    head.append(row);
  }

  function editCell(cell, row, k) {
    if (busy || cell.querySelector("input")) return;
    const column = page.columns[k],
      input = document.createElement("input"),
      raw = row.raw[k];
    input.type = "text";
    input.className = "browse-input";
    const before = editText(raw, column.type);
    input.value = before;
    input.setAttribute(
      "aria-label",
      `New value of ${column.name} in observation ${row.obs}`,
    );
    cell.textContent = "";
    cell.append(input);
    input.focus();
    input.select();
    let done = false;
    // Escape, or Enter on an unchanged value, puts the focus back on the
    // cell; leaving the input for elsewhere leaves the focus there.
    const close = (back) => {
      done = true;
      note.textContent = "";
      if (back) {
        refocus = { obs: row.obs, k };
        show();
        return;
      }
      // Leaving for another cell: only this one is drawn again, so that
      // the click that left it still reaches the cell it was on.
      cell.textContent = "";
      cell.append(cellButton(cell, row, k));
    };
    input.addEventListener("keydown", async (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (input.value === before) {
        close(true);
        return;
      }
      const value = replaceValue(input.value, column);
      if (value === null) {
        const named = (column.codes ?? []).map(([, label]) => label);
        note.textContent = `${column.name} is numeric: type a number${named.length ? `, a label of ${column.valueLabel} (${named.slice(0, 6).join(", ")}${named.length > 6 ? ", …" : ""})` : ""}, or . for missing.`;
        return;
      }
      done = true;
      note.textContent = "";
      refocus = { obs: row.obs, k };
      await run(`replace ${column.name} = ${value} in ${row.obs}`);
    });
    input.addEventListener("blur", () => {
      if (!done) close(false);
    });
  }

  /** The button of an editable cell, which opens it for change. */
  function cellButton(cell, row, k) {
    const column = page.columns[k],
      text = row.cells[k],
      button = document.createElement("button");
    button.type = "button";
    button.className = "browse-cell";
    button.textContent = text;
    button.setAttribute(
      "aria-label",
      `${column.name}, observation ${row.obs}: ${text || "empty"}. Change`,
    );
    button.addEventListener("click", () => editCell(cell, row, k));
    return button;
  }

  function show() {
    body.textContent = "";
    if (!page) return;
    header(page.columns);
    for (const row of page.rows) {
      const line = document.createElement("tr"),
        obs = document.createElement("th");
      obs.scope = "row";
      obs.textContent = row.obs;
      line.append(obs);
      row.cells.forEach((text, k) => {
        const column = page.columns[k],
          cell = document.createElement("td"),
          raw = row.raw[k],
          numeric = !/^str/.test(column.type);
        if (numeric) cell.className = "is-number";
        if (numeric && column.valueLabel && typeof raw === "number")
          cell.classList.toggle("is-labelled", text !== String(raw));
        if (raw === null) cell.classList.add("is-missing");
        if (state.edit) {
          const button = cellButton(cell, row, k);
          cell.append(button);
          if (refocus?.obs === row.obs && refocus.k === k) {
            refocus = null;
            queueMicrotask(() => button.focus());
          }
        } else cell.textContent = text;
        line.append(cell);
      });
      body.append(line);
    }
    const last = page.from + page.rows.length;
    range.textContent = !page.columns.length
      ? "No data in memory."
      : page.shown
        ? `Rows ${(page.from + 1).toLocaleString("en-US")}–${last.toLocaleString("en-US")} of ${page.shown.toLocaleString("en-US")}${page.shown < page.observations ? ` (of ${page.observations.toLocaleString("en-US")} observations)` : ""}`
        : page.observations
          ? "No row matches."
          : "No observations.";
    previous.disabled = page.from <= 0;
    next.disabled = last >= page.shown;
    go.max = String(Math.max(1, page.shown));
    scope.textContent = state.where.trim()
      ? `Showing browse ${state.where.trim()}`
      : "";
    whole.hidden = !state.where.trim();
    table.hidden = !page.columns.length;
  }

  async function refresh() {
    if (!drawer.open) return;
    const ticket = ++asked;
    let reply;
    try {
      reply = await ask({
        kind: "peek",
        request: { ...state, count: PAGE },
      });
    } catch (error) {
      if (ticket !== asked) return;
      note.textContent = `The data cannot be shown: ${error.message}.`;
      return;
    }
    if (ticket !== asked) return;
    page = reply;
    state.from = reply.from;
    // A row past the end shows the last page, and says so.
    note.textContent = reply.past
      ? `There ${reply.shown === 1 ? "is" : "are"} only ${reply.shown.toLocaleString("en-US")} row${reply.shown === 1 ? "" : "s"}; the last page is shown.`
      : "";
    show();
  }

  let typing = null;
  find.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      state.find = find.value;
      state.from = 0;
      refresh();
    }, 200);
  });
  labels.addEventListener("click", () => {
    state.labels = !state.labels;
    labels.setAttribute("aria-pressed", String(state.labels));
    refresh();
  });
  editing.addEventListener("click", () => {
    state.edit = !state.edit;
    editing.setAttribute("aria-pressed", String(state.edit));
    show();
  });
  whole.addEventListener("click", () => {
    state.where = "";
    state.from = 0;
    refresh();
  });
  previous.addEventListener("click", () => {
    state.from = Math.max(0, state.from - PAGE);
    refresh();
  });
  next.addEventListener("click", () => {
    state.from += PAGE;
    refresh();
  });
  go.addEventListener("change", () => {
    const row = Math.floor(Number(go.value));
    if (!(row >= 1)) return;
    state.from = Math.floor((row - 1) / PAGE) * PAGE;
    refresh();
  });
  drawer.addEventListener("toggle", () => {
    if (drawer.open) refresh();
  });

  return {
    /**
     * Opens the browser as browse or edit with what followed them; with
     * labels false, as browse, nolabel, numbers are shown in place of
     * their value labels.
     */
    open(where = "", edit = false, showLabels = true) {
      state.where = where;
      state.from = 0;
      state.edit = edit;
      state.labels = showLabels;
      labels.setAttribute("aria-pressed", String(showLabels));
      editing.setAttribute("aria-pressed", String(edit));
      const was = drawer.open;
      drawer.open = true;
      if (was) refresh();
      onOpen?.();
    },
    refresh,
    setBusy(running) {
      busy = running;
      for (const button of drawer.querySelectorAll("button, input"))
        if (button !== find && button !== labels) button.disabled = running;
      if (!running && page) {
        previous.disabled = page.from <= 0;
        next.disabled = page.from + page.rows.length >= page.shown;
      }
    },
  };
}
