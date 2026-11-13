// The smallest and largest of a list of numbers. Spreading a list into
// Math.min passes every value as an argument, which overflows the stack once
// a dataset has a few hundred thousand observations; these loop instead.
// Like Math.min and Math.max, an empty list gives Infinity and -Infinity,
// and NaN wins.
export function least(values) {
  let out = Infinity;
  for (const v of values) {
    if (Number.isNaN(v)) return NaN;
    if (v < out) out = v;
  }
  return out;
}
export function greatest(values) {
  let out = -Infinity;
  for (const v of values) {
    if (Number.isNaN(v)) return NaN;
    if (v > out) out = v;
  }
  return out;
}
