// Macro substitution: `local', $global, ${global}, `=exp', `:extended fcn',
// and the increment forms `++i' and `i++'. Substitution is text replacement;
// nothing here evaluates JavaScript.
import { StataError } from "./errors.js";

const NAME = /^[A-Za-z_][A-Za-z_0-9]*$/;

/**
 * env: { locals (Map), globals (Map), evaluate(text) for `=exp',
 * extended(text) for `:fcn' }.
 */
export function expandMacros(source, env, depth = 0) {
  if (depth > 64)
    throw new StataError("macro substitution is nested too deeply", 198);
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i],
      next = source[i + 1];
    if (c === "\\" && (next === "`" || next === "$")) {
      out += next;
      i++;
    } else if (c === "`" && next !== '"') {
      let end = i + 1,
        nesting = 1;
      for (; end < source.length; end++) {
        if (source[end] === "`" && source[end + 1] !== '"') nesting++;
        else if (
          source[end] === "'" &&
          source[end - 1] !== '"' &&
          --nesting === 0
        )
          break;
      }
      if (nesting) {
        // An unmatched ` is ordinary text.
        out += c;
        continue;
      }
      const inner = expandMacros(source.slice(i + 1, end), env, depth + 1);
      out += expandMacros(reference(inner, env), env, depth + 1);
      i = end;
    } else if (c === "$" && next === "{") {
      const end = source.indexOf("}", i);
      if (end < 0) {
        out += c;
        continue;
      }
      const name = expandMacros(source.slice(i + 2, end), env, depth + 1);
      out += expandMacros(env.globals.get(name) ?? "", env, depth + 1);
      i = end;
    } else if (c === "$" && /[A-Za-z_]/.test(next ?? "")) {
      const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i + 1))[0];
      out += expandMacros(env.globals.get(name) ?? "", env, depth + 1);
      i += name.length;
    } else out += c;
  }
  return out;
}

function reference(inner, env) {
  const text = inner.trim();
  if (text.startsWith("=")) return env.evaluate(text.slice(1));
  if (text.startsWith(":")) return env.extended(text.slice(1));
  let m;
  if ((m = /^([resc])\((\w+)\)$/.exec(text)))
    return String(env.result?.(m[1], m[2]) ?? "");
  if ((m = /^(\+\+|--)\s*([A-Za-z_][A-Za-z_0-9]*)$/.exec(text))) {
    const value = Number(env.locals.get(m[2]) ?? 0) + (m[1] === "++" ? 1 : -1);
    env.locals.set(m[2], String(value));
    return String(value);
  }
  if ((m = /^([A-Za-z_][A-Za-z_0-9]*)\s*(\+\+|--)$/.exec(text))) {
    const before = env.locals.get(m[1]) ?? "0";
    env.locals.set(m[1], String(Number(before) + (m[2] === "++" ? 1 : -1)));
    return before;
  }
  if (!/^[A-Za-z_0-9]{1,31}$/.test(text)) return "";
  return env.locals.get(text) ?? "";
}

export const isMacroName = (name) => NAME.test(name) && name.length <= 31;

/** Splits a macro list into words; "quoted words" and `"compound"' stay whole. */
export function macroWords(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    let j = i;
    if (text[i] === "`" && text[i + 1] === '"') {
      let depth = 1;
      for (j = i + 2; j < text.length && depth; j++) {
        if (text[j] === "`" && text[j + 1] === '"') (depth++, j++);
        else if (text[j] === '"' && text[j + 1] === "'") (depth--, j++);
      }
      out.push({ text: text.slice(i + 2, j - 2), quoted: true });
    } else if (text[i] === '"') {
      j = text.indexOf('"', i + 1);
      j = j < 0 ? text.length : j + 1;
      out.push({ text: text.slice(i + 1, j - 1), quoted: true });
    } else {
      while (j < text.length && !/\s/.test(text[j])) j++;
      out.push({ text: text.slice(i, j), quoted: false });
    }
    i = j;
  }
  return out;
}
