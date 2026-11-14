// A fingerprint of the data in memory, so that use, import and the like can
// tell whether the data have changed since they were last saved or loaded.
// It is a hash over every cell, computed as a stream: a text built from the
// cells would pass the longest string a browser can make (about 536 million
// characters) at roughly 28 million cells, well within the datasets a
// student can load.

const bits = new Float64Array(1),
  words = new Uint32Array(bits.buffer);

/** Two independent 32-bit FNV-1a lanes, so that a collision is negligible. */
class Hash {
  constructor() {
    this.a = 0x811c9dc5;
    this.b = 0x01000193;
  }
  word(w) {
    this.a = Math.imul(this.a ^ w, 0x01000193) >>> 0;
    this.b = Math.imul((this.b ^ w) + 0x9e3779b9, 0x85ebca6b) >>> 0;
  }
  number(x) {
    bits[0] = x;
    this.word(words[0]);
    this.word(words[1]);
  }
  text(s) {
    const value = String(s ?? "");
    this.word(value.length);
    for (let i = 0; i < value.length; i++) this.word(value.charCodeAt(i));
  }
}

export function fingerprint(data) {
  const hash = new Hash();
  hash.number(data.n);
  hash.number(data.variables.length);
  for (const v of data.variables) {
    hash.text(v.name);
    hash.text(v.type);
    hash.text(v.format);
    hash.text(v.label);
    const values = v.data;
    hash.number(values.length);
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (typeof value === "number") {
        hash.word(0);
        hash.number(value);
      } else {
        hash.word(1);
        hash.text(value);
      }
    }
  }
  return `${hash.a.toString(16)}:${hash.b.toString(16)}`;
}
