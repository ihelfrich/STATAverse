import { marked } from "marked";
import katex from "katex";
import renderMathInElement from "katex/contrib/auto-render";
// Preserve TeX delimiters before Markdown consumes backslash escapes.
marked.use({
  extensions: [
    {
      name: "displayMath",
      level: "block",
      start: (src) => src.search(/\\\[|\$\$/),
      tokenizer(src) {
        const m = /^(?:\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$)\s*/.exec(src);
        if (m) return { type: "displayMath", raw: m[0], text: m[1] ?? m[2] };
      },
      renderer: (token) =>
        katex.renderToString(token.text, {
          displayMode: true,
          throwOnError: false,
          trust: false,
        }),
    },
    {
      name: "inlineMath",
      level: "inline",
      start: (src) => src.indexOf("\\("),
      tokenizer(src) {
        const m = /^\\\(([\s\S]*?)\\\)/.exec(src);
        if (m) return { type: "inlineMath", raw: m[0], text: m[1] };
      },
      renderer: (token) =>
        katex.renderToString(token.text, { throwOnError: false, trust: false }),
    },
  ],
});
window.marked = { parse: marked.parse };
window.renderMathInElement = renderMathInElement;
