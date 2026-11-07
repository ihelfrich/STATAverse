import {
  EditorState,
  StateEffect,
  StateField,
  Prec,
  Compartment,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  Decoration,
} from "@codemirror/view";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  syntaxTree,
} from "@codemirror/language";
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  toggleComment,
  toggleBlockComment,
} from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { SUPPORTED_COMMANDS } from "./engine.js";
import { SUPPORTED_FUNCTIONS } from "./expression.js";
import { executionRange } from "./do-file.js";
import { EGEN_FUNCTIONS } from "./grouped-data.js";

const commands = new Set(SUPPORTED_COMMANDS);
const functions = SUPPORTED_FUNCTIONS;
function commentEdit(view, command) {
  return command({
    state: view.state,
    dispatch: (transaction) =>
      view.dispatch({
        changes: transaction.changes,
        selection: transaction.selection,
        effects: transaction.effects,
        annotations: isolateHistory.of("full"),
        userEvent: "input.comment",
        scrollIntoView: true,
      }),
  });
}
const stata = StreamLanguage.define({
  name: "stata-practice",
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
  },
  startState: () => ({ block: false }),
  token(stream, state) {
    if (state.block) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.block = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.match(/\s*\*.*/)) return "comment";
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.block = true;
      return "comment";
    }
    if (stream.match(/"[^"]*(?:"|$)/)) return "string";
    if (stream.match(/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/[A-Za-z_]\w*/)) {
      const word = stream.current();
      if (commands.has(word)) return "keyword";
      if (functions.includes(word)) return "builtin";
      if (
        [
          "if",
          "in",
          "double",
          "float",
          "byte",
          "int",
          "long",
          "vce",
          "robust",
          "residuals",
          "xb",
          "frequency",
        ].includes(word)
      )
        return "atom";
      return "variableName";
    }
    if (stream.match(/[+\-*/^=<>!&|]+/)) return "operator";
    stream.next();
    return null;
  },
});
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#164dd0", fontWeight: "600" },
  { tag: tags.string, color: "#96510c" },
  { tag: tags.number, color: "#8a3fa0" },
  { tag: tags.comment, color: "#647284", fontStyle: "italic" },
  { tag: tags.atom, color: "#166a60" },
  { tag: tags.standard(tags.name), color: "#166a60" },
]);
const markExecution = StateEffect.define();
const executionMarks = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    if (tr.docChanged) value = Decoration.none;
    for (const effect of tr.effects)
      if (effect.is(markExecution)) {
        const marks = [];
        const { from, to, error } = effect.value;
        const first = tr.state.doc.lineAt(Math.min(from, tr.state.doc.length));
        const last = tr.state.doc.lineAt(
          Math.min(Math.max(from, to - 1), tr.state.doc.length),
        );
        for (let line = first.number; line <= last.number; line++)
          marks.push(
            Decoration.line({
              class: error ? "cm-execution-error" : "cm-executed",
            }).range(tr.state.doc.line(line).from),
          );
        value = Decoration.set(marks);
      }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function createCommandEditor(
  parent,
  { onChange, onRun, variables, announce },
) {
  let replacing = false;
  const readOnly = new Compartment();
  const view = new EditorView({
    parent,
    extensions: [
      readOnly.of(EditorState.readOnly.of(false)),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      bracketMatching(),
      closeBrackets(),
      stata,
      syntaxHighlighting(highlight),
      executionMarks,
      highlightSelectionMatches(),
      EditorView.contentAttributes.of({
        id: "command-editor",
        "aria-label": "Stata commands",
        "aria-describedby": "editor-description",
        spellcheck: "false",
        autocapitalize: "off",
        "data-gramm": "false",
      }),
      EditorView.lineWrapping,
      EditorState.transactionFilter.of((tr) => {
        if (tr.newDoc.length <= 50000) return tr;
        announce(
          "The editor supports up to 50,000 characters. This edit was not applied.",
        );
        return [];
      }),
      Prec.highest(
        keymap.of([
          { key: "Mod-/", run: (view) => commentEdit(view, toggleComment) },
          {
            key: "Alt-A",
            mac: "Ctrl-A",
            run: (view) => commentEdit(view, toggleBlockComment),
          },
          {
            key: "Mod-Enter",
            run: () => {
              onRun("current");
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            run: () => {
              onRun("all");
              return true;
            },
          },
        ]),
      ),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      autocompletion({
        override: [
          (context) => {
            const token = syntaxTree(context.state).resolveInner(
              context.pos,
              -1,
            );
            if (/string|comment/i.test(token.name)) return null;
            const word = context.matchBefore(/[A-Za-z_]\w*/);
            if (!word && !context.explicit) return null;
            const from = word?.from ?? context.pos;
            const prefix = context.state.doc.sliceString(
              context.state.doc.lineAt(from).from,
              from,
            );
            const egenFunction = /^\s*egen\s+(?:double\s+)?\w+\s*=\s*$/.test(
              prefix,
            );
            const options = egenFunction
              ? EGEN_FUNCTIONS.map((label) => ({
                  label,
                  type: "function",
                  detail: "egen function",
                }))
              : !prefix.trim()
                ? [...commands].map((label) => ({
                    label,
                    type: "keyword",
                    detail: "command",
                  }))
                : [
                    ...variables().map((column) => ({
                      label: column.name,
                      type: "variable",
                      detail: column.type,
                      info: column.label || "Variable in the current dataset",
                    })),
                    ...functions.map((label) => ({ label, type: "function" })),
                    ...[
                      "if",
                      "in",
                      "vce(robust)",
                      "missing",
                      "frequency",
                      "residuals",
                    ].map((label) => ({ label, type: "keyword" })),
                  ];
            return { from, options, validFor: /^\w*$/ };
          },
        ],
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !replacing) onChange();
        if (update.docChanged || update.selectionSet) {
          const selection = update.state.selection.main;
          const line = update.state.doc.lineAt(selection.head);
          const status = document.querySelector("#editor-position");
          if (status)
            status.textContent = selection.empty
              ? `Line ${line.number} · column ${selection.head - line.from + 1}`
              : `${selection.to - selection.from} characters selected`;
          const button = document.querySelector("#run-line");
          if (button)
            button.textContent = selection.empty
              ? "Run current command"
              : "Run selection";
        }
      }),
    ],
  });
  return {
    setReadOnly(value) {
      view.dispatch({
        effects: readOnly.reconfigure([
          EditorState.readOnly.of(value),
          EditorView.contentAttributes.of({ "aria-readonly": String(value) }),
        ]),
      });
    },
    getValue: () => view.state.doc.toString(),
    setValue(value) {
      replacing = true;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: 0 },
      });
      replacing = false;
    },
    focus: () => view.focus(),
    range() {
      const { from, to } = view.state.selection.main;
      return executionRange(view.state.doc.toString(), from, to);
    },
    mark(from, to, error = false) {
      view.dispatch({ effects: markExecution.of({ from, to, error }) });
    },
    advance(after) {
      const source = view.state.doc.toString();
      const range = executionRange(source, Math.min(source.length, after + 1));
      const anchor = range?.from ?? source.length;
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      view.focus();
    },
  };
}
