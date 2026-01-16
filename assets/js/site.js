(function () {
  "use strict";

  var glossaryState = {
    active: null,
    bound: false,
  };

  function slugify(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function wrapCheckDetails(callout) {
    var details = document.createElement("details");
    details.className = "check-details";
    var summary = document.createElement("summary");
    summary.textContent = "Show expected";
    details.appendChild(summary);

    while (callout.children.length > 1) {
      details.appendChild(callout.children[1]);
    }

    callout.appendChild(details);
  }

  function addNoteField(callout, key) {
    var label = document.createElement("label");
    label.className = "note-label";
    label.textContent = "Your notes";

    var textarea = document.createElement("textarea");
    textarea.className = "note-field";
    textarea.setAttribute("data-note", key);
    textarea.setAttribute("placeholder", "Type your response here...");

    label.appendChild(textarea);
    callout.appendChild(label);
  }

  function wrapCallouts(container) {
    var markers = new Set(["[TRY]", "[PREDICT]", "[CHECK]", "[REFLECT]"]);
    var node = container.firstElementChild;
    var noteIndex = 0;

    while (node) {
      var nextNode = node.nextElementSibling;
      if (node.tagName === "P" && markers.has(node.textContent.trim())) {
        var type = node.textContent.trim().slice(1, -1).toLowerCase();
        var callout = document.createElement("section");
        callout.className = "callout " + type;

        var title = document.createElement("div");
        title.className = "callout-title";
        title.textContent = type.toUpperCase();
        callout.appendChild(title);

        var sibling = nextNode;
        while (sibling) {
          if (sibling.tagName === "P" && markers.has(sibling.textContent.trim())) {
            break;
          }
          if (/^H[1-6]$/.test(sibling.tagName)) {
            break;
          }
          var move = sibling;
          sibling = sibling.nextElementSibling;
          callout.appendChild(move);
        }

        if (type === "check") {
          wrapCheckDetails(callout);
        }
        if (type === "predict" || type === "reflect") {
          addNoteField(callout, type + "-" + noteIndex);
          noteIndex += 1;
        }

        node.replaceWith(callout);
        node = sibling;
        continue;
      }

      node = nextNode;
    }
  }

  function wrapAnswerKeys(container) {
    var paragraphs = container.querySelectorAll("p");
    paragraphs.forEach(function (para) {
      var text = para.textContent.trim().toLowerCase();
      if (!text.startsWith("answer key")) {
        return;
      }
      var list = para.nextElementSibling;
      if (!list || (list.tagName !== "UL" && list.tagName !== "OL")) {
        return;
      }
      var details = document.createElement("details");
      details.className = "answer-key";
      var summary = document.createElement("summary");
      summary.textContent = para.textContent.trim();
      details.appendChild(summary);
      details.appendChild(list);
      para.replaceWith(details);
    });
  }

  function addCopyButtons(container) {
    var codes = container.querySelectorAll("pre > code");
    codes.forEach(function (code) {
      var pre = code.parentElement;
      var wrapper = document.createElement("div");
      wrapper.className = "code-block";
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      var button = document.createElement("button");
      button.type = "button";
      button.className = "copy-button";
      button.textContent = "Copy";
      button.addEventListener("click", function () {
        var text = code.textContent;
        if (!navigator.clipboard) {
          return;
        }
        navigator.clipboard.writeText(text).then(function () {
          button.textContent = "Copied";
          setTimeout(function () {
            button.textContent = "Copy";
          }, 1500);
        });
      });

      wrapper.appendChild(button);
    });
  }

  function enableCheckboxes(container) {
    var checkboxes = container.querySelectorAll("input[type=\"checkbox\"]");
    checkboxes.forEach(function (checkbox) {
      checkbox.removeAttribute("disabled");
    });
    return Array.from(checkboxes);
  }

  function initProgress(container, checkboxes) {
    var progress = document.querySelector("[data-progress]");
    if (!progress) {
      return function () {};
    }
    var bar = progress.querySelector(".progress-bar");
    var label = progress.querySelector(".progress-label");
    var total = checkboxes.length;

    function update() {
      if (!total) {
        label.textContent = "No tasks yet";
        bar.style.width = "0%";
        return;
      }
      var done = checkboxes.filter(function (cb) {
        return cb.checked;
      }).length;
      var pct = Math.round((done / total) * 100);
      bar.style.width = pct + "%";
      label.textContent = done + "/" + total + " tasks";
    }

    update();
    return update;
  }

  function bindPersistedInputs(container, checkboxes, updateProgress) {
    var storageKey = "stataverse:progress:" + window.location.pathname;
    var stored = null;
    try {
      stored = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    } catch (err) {
      stored = null;
    }

    if (stored && Array.isArray(stored.checks)) {
      checkboxes.forEach(function (checkbox, index) {
        checkbox.checked = Boolean(stored.checks[index]);
      });
    }

    var notes = container.querySelectorAll("textarea[data-note]");
    if (stored && stored.notes) {
      notes.forEach(function (note) {
        if (stored.notes[note.dataset.note]) {
          note.value = stored.notes[note.dataset.note];
        }
      });
    }

    function save() {
      var payload = {
        checks: checkboxes.map(function (cb) {
          return cb.checked;
        }),
        notes: {},
      };
      notes.forEach(function (note) {
        if (note.value.trim()) {
          payload.notes[note.dataset.note] = note.value;
        }
      });
      window.localStorage.setItem(storageKey, JSON.stringify(payload));
      updateProgress();
    }

    checkboxes.forEach(function (checkbox) {
      checkbox.addEventListener("change", save);
    });

    notes.forEach(function (note) {
      note.addEventListener("input", save);
    });

    updateProgress();
  }

  function buildToc(container) {
    var toc = document.querySelector("[data-toc]");
    if (!toc) {
      return;
    }
    var headings = Array.from(container.querySelectorAll("h2"));
    if (!headings.length) {
      toc.textContent = "No sections";
      return;
    }

    var list = document.createElement("ul");
    headings.forEach(function (heading) {
      var id = slugify(heading.textContent || "section");
      heading.id = id;
      var item = document.createElement("li");
      var link = document.createElement("a");
      link.href = "#" + id;
      link.textContent = heading.textContent;
      item.appendChild(link);
      list.appendChild(item);
    });

    toc.appendChild(list);
  }

  function initGlossary(container) {
    var terms = container.querySelectorAll(".glossary-term");
    if (!terms.length) {
      return;
    }

    function closeBubble() {
      if (!glossaryState.active) {
        return;
      }
      glossaryState.active.button.setAttribute("aria-expanded", "false");
      glossaryState.active.bubble.remove();
      glossaryState.active = null;
    }

    terms.forEach(function (term) {
      if (term.dataset.glossaryReady === "true") {
        return;
      }
      term.dataset.glossaryReady = "true";
      term.setAttribute("type", "button");
      term.setAttribute("aria-expanded", "false");
      term.addEventListener("click", function (event) {
        event.stopPropagation();
        var definition = term.getAttribute("data-definition");
        if (!definition) {
          return;
        }
        if (glossaryState.active && glossaryState.active.button === term) {
          closeBubble();
          return;
        }
        closeBubble();
        var bubble = document.createElement("div");
        bubble.className = "glossary-bubble";
        bubble.textContent = definition;
        document.body.appendChild(bubble);

        var rect = term.getBoundingClientRect();
        var top = window.scrollY + rect.bottom + 8;
        var left = window.scrollX + rect.left;
        var maxLeft = window.scrollX + document.documentElement.clientWidth - bubble.offsetWidth - 12;
        if (left > maxLeft) {
          left = maxLeft;
        }
        bubble.style.top = top + "px";
        bubble.style.left = left + "px";

        term.setAttribute("aria-expanded", "true");
        glossaryState.active = { button: term, bubble: bubble };
      });
    });

    if (!glossaryState.bound) {
      document.addEventListener("click", function () {
        closeBubble();
      });

      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          closeBubble();
        }
      });
      glossaryState.bound = true;
    }
  }

  function parseCsv(text) {
    var lines = text.trim().split(/\r?\n/);
    if (!lines.length) {
      return { headers: [], rows: [] };
    }
    var headers = lines[0].split(",").map(function (header) {
      return header.trim();
    });
    var rows = lines.slice(1).map(function (line) {
      return line.split(",").map(function (cell) {
        return cell.trim();
      });
    });
    return { headers: headers, rows: rows };
  }

  function buildSummary(headers, rows) {
    var summary = [];
    headers.forEach(function (header, index) {
      var values = rows.map(function (row) {
        return parseFloat(row[index]);
      });
      var numeric = values.filter(function (value) {
        return Number.isFinite(value);
      });
      if (!numeric.length) {
        return;
      }
      var total = numeric.reduce(function (acc, value) {
        return acc + value;
      }, 0);
      var mean = total / numeric.length;
      var min = Math.min.apply(null, numeric);
      var max = Math.max.apply(null, numeric);
      summary.push({
        name: header,
        mean: mean,
        min: min,
        max: max,
      });
    });
    return summary;
  }

  function renderDataPreview(container) {
    var csvPath = container.getAttribute("data-csv-preview");
    if (!csvPath || container.dataset.previewReady === "true") {
      return;
    }
    container.dataset.previewReady = "true";
    var previewRows = parseInt(container.getAttribute("data-preview-rows"), 10) || 5;

    fetch(csvPath)
      .then(function (res) {
        if (!res.ok) {
          throw new Error("Failed to load CSV");
        }
        return res.text();
      })
      .then(function (text) {
        var parsed = parseCsv(text);
        if (!parsed.headers.length) {
          container.textContent = "No data found.";
          return;
        }

        var meta = document.createElement("p");
        meta.className = "muted";
        meta.textContent = "Rows: " + parsed.rows.length + " | Columns: " + parsed.headers.length;
        container.appendChild(meta);

        var table = document.createElement("table");
        var thead = document.createElement("thead");
        var headRow = document.createElement("tr");
        parsed.headers.forEach(function (header) {
          var th = document.createElement("th");
          th.textContent = header;
          headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        var tbody = document.createElement("tbody");
        parsed.rows.slice(0, previewRows).forEach(function (row) {
          var tr = document.createElement("tr");
          row.forEach(function (cell) {
            var td = document.createElement("td");
            td.textContent = cell;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        container.appendChild(table);

        var summaryData = buildSummary(parsed.headers, parsed.rows);
        if (summaryData.length) {
          var summaryGrid = document.createElement("div");
          summaryGrid.className = "data-summary";
          summaryData.slice(0, 6).forEach(function (stat) {
            var card = document.createElement("div");
            card.className = "summary-card";
            card.innerHTML =
              "<strong>" +
              stat.name +
              "</strong>Mean: " +
              stat.mean.toFixed(2) +
              "<br>Min: " +
              stat.min.toFixed(2) +
              "<br>Max: " +
              stat.max.toFixed(2);
            summaryGrid.appendChild(card);
          });
          container.appendChild(summaryGrid);
        }
      })
      .catch(function () {
        container.textContent = "Could not load data preview.";
      });
  }

  function initDataPreviews(container) {
    var previews = container.querySelectorAll("[data-csv-preview]");
    previews.forEach(function (preview) {
      renderDataPreview(preview);
    });
  }

  function initCharts(container) {
    if (!window.Chart) {
      return;
    }
    var charts = container.querySelectorAll("canvas[data-chart]");
    charts.forEach(function (canvas) {
      if (canvas.dataset.chartReady === "true") {
        return;
      }
      canvas.dataset.chartReady = "true";
      var csvPath = canvas.getAttribute("data-csv");
      var xKey = canvas.getAttribute("data-x");
      var yKey = canvas.getAttribute("data-y");
      var type = canvas.getAttribute("data-chart-type") || "scatter";
      if (!csvPath || !xKey || !yKey) {
        return;
      }
      fetch(csvPath)
        .then(function (res) {
          if (!res.ok) {
            throw new Error("Failed to load chart data");
          }
          return res.text();
        })
        .then(function (text) {
          var parsed = parseCsv(text);
          var xIndex = parsed.headers.indexOf(xKey);
          var yIndex = parsed.headers.indexOf(yKey);
          if (xIndex === -1 || yIndex === -1) {
            return;
          }
          var points = parsed.rows
            .map(function (row) {
              return {
                x: parseFloat(row[xIndex]),
                y: parseFloat(row[yIndex]),
              };
            })
            .filter(function (point) {
              return Number.isFinite(point.x) && Number.isFinite(point.y);
            })
            .slice(0, 120);

          new window.Chart(canvas, {
            type: type,
            data: {
              datasets: [
                {
                  label: yKey + " vs " + xKey,
                  data: points,
                  backgroundColor: "rgba(31, 111, 84, 0.6)",
                },
              ],
            },
            options: {
              responsive: true,
              scales: {
                x: {
                  title: {
                    display: true,
                    text: xKey,
                  },
                },
                y: {
                  title: {
                    display: true,
                    text: yKey,
                  },
                },
              },
              plugins: {
                legend: {
                  display: false,
                },
              },
            },
          });
        })
        .catch(function () {
          canvas.insertAdjacentHTML("afterend", "<p class=\"muted\">Chart unavailable.</p>");
        });
    });
  }

  function initModelSelectors(container) {
    var selectors = container.querySelectorAll("[data-model-selector]");
    selectors.forEach(function (selector) {
      if (selector.dataset.ready === "true") {
        return;
      }
      selector.dataset.ready = "true";

      var tabs = selector.querySelectorAll("[data-model-tab]");
      var panels = selector.querySelectorAll("[data-model-panel]");
      if (!tabs.length || !panels.length) {
        return;
      }

      function activateTab(target) {
        tabs.forEach(function (tab) {
          var isActive = tab.getAttribute("data-model-tab") === target;
          tab.classList.toggle("active", isActive);
          tab.setAttribute("aria-pressed", isActive ? "true" : "false");
        });
        panels.forEach(function (panel) {
          var isActive = panel.getAttribute("data-model-panel") === target;
          panel.classList.toggle("active", isActive);
        });
      }

      tabs.forEach(function (tab) {
        tab.setAttribute("type", "button");
        tab.setAttribute("aria-pressed", "false");
        tab.addEventListener("click", function () {
          activateTab(tab.getAttribute("data-model-tab"));
        });
      });

      activateTab(tabs[0].getAttribute("data-model-tab"));
    });
  }

  function renderMath(container) {
    if (!window.renderMathInElement) {
      return;
    }
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\\\[", right: "\\\\]", display: true },
        { left: "\\\\(", right: "\\\\)", display: false },
      ],
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
    });
  }

  function enhanceRoot(container) {
    initGlossary(container);
    initDataPreviews(container);
    initCharts(container);
    initModelSelectors(container);
    renderMath(container);
  }

  
  function initScriptLibrary() {
    var library = document.querySelector("[data-script-library]");
    if (!library) {
      return;
    }
    var searchInput = document.getElementById("script-search");
    var chipContainer = document.querySelector("[data-filter-chips]");
    var activeFilter = "all";
    var scripts = [];

    function renderScripts(list) {
      library.innerHTML = "";
      if (!list.length) {
        var empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No scripts match your search.";
        library.appendChild(empty);
        return;
      }

      list.forEach(function (item) {
        var card = document.createElement("article");
        card.className = "script-card";

        var tagRow = document.createElement("div");
        tagRow.className = "script-tags";
        item.tags.forEach(function (tag) {
          var span = document.createElement("span");
          span.className = "script-tag";
          span.textContent = tag;
          tagRow.appendChild(span);
        });

        var title = document.createElement("h3");
        title.textContent = item.title;

        var summary = document.createElement("p");
        summary.className = "muted";
        summary.textContent = item.summary;

        var level = document.createElement("span");
        level.className = "pill";
        level.textContent = item.level;

        var link = document.createElement("a");
        link.className = "text-link";
        link.href = "./script.html?id=" + encodeURIComponent(item.id);
        link.textContent = "Open script";

        card.appendChild(tagRow);
        card.appendChild(title);
        card.appendChild(summary);
        card.appendChild(level);
        card.appendChild(link);

        library.appendChild(card);
      });
    }

    function filterScripts() {
      var query = searchInput ? searchInput.value.trim().toLowerCase() : "";
      var filtered = scripts.filter(function (item) {
        var matchesFilter = activeFilter === "all" || item.tags.includes(activeFilter);
        if (!matchesFilter) {
          return false;
        }
        if (!query) {
          return true;
        }
        var haystack = [item.title, item.summary, item.level, item.tags.join(" ")]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });
      renderScripts(filtered);
    }

    if (chipContainer) {
      chipContainer.addEventListener("click", function (event) {
        var target = event.target;
        if (!target.matches("[data-filter]")) {
          return;
        }
        activeFilter = target.getAttribute("data-filter") || "all";
        chipContainer.querySelectorAll(".filter-chip").forEach(function (chip) {
          chip.classList.toggle("active", chip === target);
        });
        filterScripts();
      });
    }

    if (searchInput) {
      searchInput.addEventListener("input", filterScripts);
    }

    fetch("./scripts.json")
      .then(function (res) {
        if (!res.ok) {
          throw new Error("Failed to load scripts");
        }
        return res.json();
      })
      .then(function (data) {
        scripts = data;
        filterScripts();
      })
      .catch(function () {
        library.innerHTML = "";
        var error = document.createElement("p");
        error.className = "muted";
        error.textContent = "Script library unavailable.";
        library.appendChild(error);
      });
  }

  function initScriptPage() {
    var page = document.querySelector("[data-script-page]");
    if (!page) {
      return;
    }
    var params = new URLSearchParams(window.location.search);
    var id = params.get("id");
    if (!id) {
      page.querySelector("[data-script-title]").textContent = "Script not found";
      page.querySelector("[data-script-summary]").textContent =
        "Missing script id. Return to the library.";
      return;
    }

    fetch("./scripts.json")
      .then(function (res) {
        if (!res.ok) {
          throw new Error("Failed to load scripts");
        }
        return res.json();
      })
      .then(function (data) {
        var match = data.find(function (item) {
          return item.id === id;
        });
        if (!match) {
          throw new Error("Script not found");
        }
        var title = page.querySelector("[data-script-title]");
        var summary = page.querySelector("[data-script-summary]");
        var tags = page.querySelector("[data-script-tags]");
        var download = page.querySelector("[data-script-download]");
        var content = page.querySelector("[data-md]");

        title.textContent = match.title;
        summary.textContent = match.summary;
        document.title = match.title + " | STATAverse";

        tags.innerHTML = "";
        match.tags.forEach(function (tag) {
          var span = document.createElement("span");
          span.className = "pill";
          span.textContent = tag;
          tags.appendChild(span);
        });
        var level = document.createElement("span");
        level.className = "pill";
        level.textContent = match.level;
        tags.appendChild(level);

        download.setAttribute("href", "./scripts/" + match.id + ".do");
        download.setAttribute("download", match.id + ".do");

        if (content) {
          content.setAttribute("data-md", "./content/" + match.id + ".md");
          renderMarkdownLessons();
        }
      })
      .catch(function () {
        page.querySelector("[data-script-title]").textContent = "Script not found";
        page.querySelector("[data-script-summary]").textContent =
          "This script does not exist yet.";
      });
  }

  function initSiteSearch() {
    var page = document.querySelector("[data-search-page]");
    if (!page) {
      return;
    }
    var input = document.getElementById("site-search");
    var filters = page.querySelector("[data-site-filters]");
    var results = page.querySelector("[data-site-results]");
    var indexSrc = page.getAttribute("data-index-src") || "assets/data/site-index.json";
    var base = page.getAttribute("data-base") || "";
    var activeFilter = "all";
    var items = [];

    function render(list) {
      results.innerHTML = "";
      if (!list.length) {
        var empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No results found.";
        results.appendChild(empty);
        return;
      }

      list.forEach(function (item) {
        var card = document.createElement("article");
        card.className = "script-card";

        var tagRow = document.createElement("div");
        tagRow.className = "script-tags";

        var typeTag = document.createElement("span");
        typeTag.className = "script-tag";
        typeTag.textContent = item.type;
        tagRow.appendChild(typeTag);

        (item.tags || []).forEach(function (tag) {
          var span = document.createElement("span");
          span.className = "script-tag";
          span.textContent = tag;
          tagRow.appendChild(span);
        });

        var title = document.createElement("h3");
        title.textContent = item.title;

        var summary = document.createElement("p");
        summary.className = "muted";
        summary.textContent = item.summary || "";

        var meta = document.createElement("span");
        meta.className = "pill";
        meta.textContent = item.level || "All";

        var link = document.createElement("a");
        link.className = "text-link";
        link.href = base + item.path;
        link.textContent = "Open";

        card.appendChild(tagRow);
        card.appendChild(title);
        card.appendChild(summary);
        card.appendChild(meta);
        card.appendChild(link);

        results.appendChild(card);
      });
    }

    function filterItems() {
      var query = input ? input.value.trim().toLowerCase() : "";
      var filtered = items.filter(function (item) {
        var matchesType = activeFilter === "all" || item.type === activeFilter;
        if (!matchesType) {
          return false;
        }
        if (!query) {
          return true;
        }
        var haystack = [item.title, item.summary, item.level, (item.tags || []).join(" ")]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      });
      render(filtered);
    }

    if (filters) {
      filters.addEventListener("click", function (event) {
        var target = event.target;
        if (!target.matches("[data-filter]")) {
          return;
        }
        activeFilter = target.getAttribute("data-filter") || "all";
        filters.querySelectorAll(".filter-chip").forEach(function (chip) {
          chip.classList.toggle("active", chip === target);
        });
        filterItems();
      });
    }

    if (input) {
      input.addEventListener("input", filterItems);
    }

    fetch(indexSrc)
      .then(function (res) {
        if (!res.ok) {
          throw new Error("Failed to load search index");
        }
        return res.json();
      })
      .then(function (data) {
        items = data;
        filterItems();
      })
      .catch(function () {
        results.innerHTML = "";
        var error = document.createElement("p");
        error.className = "muted";
        error.textContent = "Search index unavailable.";
        results.appendChild(error);
      });
  }

  function initWorkspace() {
    var page = document.querySelector("[data-workspace]");
    if (!page) {
      return;
    }
    var nameInput = document.getElementById("workspace-name");
    var roleInput = document.getElementById("workspace-role");
    var focusInput = document.getElementById("workspace-focus");
    var exportButton = page.querySelector("[data-export-notes]");
    var importInput = document.getElementById("workspace-import");
    var clearButton = page.querySelector("[data-clear-notes]");
    var modulesCount = page.querySelector("[data-modules-count]");
    var tasksCount = page.querySelector("[data-tasks-count]");
    var notesCount = page.querySelector("[data-notes-count]");
    var progressDetail = page.querySelector("[data-progress-detail]");

    function loadProfile() {
      try {
        var profile = JSON.parse(localStorage.getItem("stataverse:user") || "{}");
        if (nameInput) nameInput.value = profile.name || "";
        if (roleInput) roleInput.value = profile.role || "";
        if (focusInput) focusInput.value = profile.focus || "";
      } catch (err) {
        return;
      }
    }

    function saveProfile() {
      var profile = {
        name: nameInput ? nameInput.value.trim() : "",
        role: roleInput ? roleInput.value.trim() : "",
        focus: focusInput ? focusInput.value.trim() : "",
      };
      localStorage.setItem("stataverse:user", JSON.stringify(profile));
    }

    function collectProgress() {
      var keys = Object.keys(localStorage).filter(function (key) {
        return key.indexOf("stataverse:progress:") === 0;
      });
      var taskTotal = 0;
      var noteTotal = 0;
      keys.forEach(function (key) {
        try {
          var value = JSON.parse(localStorage.getItem(key) || "{}");
          if (Array.isArray(value.checks)) {
            taskTotal += value.checks.filter(Boolean).length;
          }
          if (value.notes) {
            noteTotal += Object.keys(value.notes).length;
          }
        } catch (err) {
          return;
        }
      });
      modulesCount.textContent = keys.length;
      tasksCount.textContent = taskTotal;
      notesCount.textContent = noteTotal;
      if (progressDetail) {
        progressDetail.textContent = keys.length
          ? "Progress stored for " + keys.length + " module(s)."
          : "No module progress saved yet.";
      }
      return keys;
    }

    function exportWorkspace() {
      var payload = {
        profile: JSON.parse(localStorage.getItem("stataverse:user") || "{}"),
        progress: {},
      };
      Object.keys(localStorage).forEach(function (key) {
        if (key.indexOf("stataverse:progress:") === 0) {
          payload.progress[key] = localStorage.getItem(key);
        }
      });
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "stataverse-workspace.json";
      link.click();
      URL.revokeObjectURL(url);
    }

    function importWorkspace(file) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          if (data.profile) {
            localStorage.setItem("stataverse:user", JSON.stringify(data.profile));
          }
          if (data.progress) {
            Object.keys(data.progress).forEach(function (key) {
              localStorage.setItem(key, data.progress[key]);
            });
          }
          loadProfile();
          collectProgress();
        } catch (err) {
          return;
        }
      };
      reader.readAsText(file);
    }

    if (nameInput) nameInput.addEventListener("input", saveProfile);
    if (roleInput) roleInput.addEventListener("input", saveProfile);
    if (focusInput) focusInput.addEventListener("input", saveProfile);
    if (exportButton) exportButton.addEventListener("click", exportWorkspace);
    if (importInput) {
      importInput.addEventListener("change", function () {
        if (importInput.files && importInput.files[0]) {
          importWorkspace(importInput.files[0]);
          importInput.value = "";
        }
      });
    }
    if (clearButton) {
      clearButton.addEventListener("click", function () {
        Object.keys(localStorage).forEach(function (key) {
          if (key.indexOf("stataverse:progress:") === 0 || key === "stataverse:user") {
            localStorage.removeItem(key);
          }
        });
        loadProfile();
        collectProgress();
      });
    }

    loadProfile();
    collectProgress();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      return;
    }
    var parts = window.location.pathname.split("/").filter(Boolean);
    var base = "/";
    if (parts.length) {
      base += parts[0] + "/";
    }
    navigator.serviceWorker.register(base + "service-worker.js").catch(function () {});
  }

  function enhanceLesson(container) {
    wrapCallouts(container);
    wrapAnswerKeys(container);
    addCopyButtons(container);
    var checkboxes = enableCheckboxes(container);
    var updateProgress = initProgress(container, checkboxes);
    buildToc(container);
    bindPersistedInputs(container, checkboxes, updateProgress);
    enhanceRoot(container);
  }

  function renderMarkdownLessons() {
    var containers = document.querySelectorAll("[data-md]");
    if (!containers.length) {
      return;
    }
    if (!window.marked) {
      containers.forEach(function (container) {
        container.textContent = "Markdown renderer is not available.";
      });
      return;
    }

    containers.forEach(function (container) {
      var mdPath = container.getAttribute("data-md");
      if (!mdPath) {
        return;
      }

      fetch(mdPath)
        .then(function (res) {
          if (!res.ok) {
            throw new Error("Failed to load lesson");
          }
          return res.text();
        })
        .then(function (markdown) {
          container.innerHTML = window.marked.parse(markdown, {
            gfm: true,
            breaks: false,
          });
          enhanceLesson(container);
          enhanceRoot(document);
        })
        .catch(function () {
          container.textContent = "Could not load lesson content.";
        });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initScriptPage();
    initScriptLibrary();
    initSiteSearch();
    initWorkspace();
    renderMarkdownLessons();
    enhanceRoot(document);
    registerServiceWorker();
  });
})();
