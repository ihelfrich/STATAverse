// Random numbers. The generator is the 64-bit Mersenne Twister (MT19937-64)
// seeded as its reference implementation seeds it, which is what Stata's
// default generator is: after the same set seed, runiform() returns the same
// doubles as Stata, draw for draw. Stata turns each 64-bit output into a
// double by dividing by 2^64 with rounding to nearest.
//
// Only runiform() is matched to Stata. rnormal() and the other generators
// here are built on runiform() by documented methods and give different
// draws from Stata's, though the same ones on every run of this site.
import { invnormal } from "./functions-normal.js";

const NN = 312,
  MM = 156,
  MATRIX_A = 0xb5026f5aa96619e9n,
  UPPER = 0xffffffff80000000n,
  LOWER = 0x7fffffffn,
  MASK = (1n << 64n) - 1n;

export const DEFAULT_SEED = 123456789;

export class Generator {
  constructor(seed = DEFAULT_SEED) {
    this.state = new Array(NN);
    this.state[0] = BigInt.asUintN(64, BigInt(Math.trunc(seed)));
    for (let i = 1; i < NN; i++) {
      const previous = this.state[i - 1];
      this.state[i] =
        (6364136223846793005n * (previous ^ (previous >> 62n)) + BigInt(i)) &
        MASK;
    }
    this.index = NN;
  }
  next() {
    const mt = this.state;
    if (this.index >= NN) {
      const twist = (x) => (x >> 1n) ^ (x & 1n ? MATRIX_A : 0n);
      let i = 0;
      for (; i < NN - MM; i++)
        mt[i] = mt[i + MM] ^ twist((mt[i] & UPPER) | (mt[i + 1] & LOWER));
      for (; i < NN - 1; i++)
        mt[i] = mt[i + MM - NN] ^ twist((mt[i] & UPPER) | (mt[i + 1] & LOWER));
      mt[NN - 1] = mt[MM - 1] ^ twist((mt[NN - 1] & UPPER) | (mt[0] & LOWER));
      this.index = 0;
    }
    let x = mt[this.index++];
    x ^= (x >> 29n) & 0x5555555555555555n;
    x ^= (x << 17n) & 0x71d67fffeda60000n;
    x ^= (x << 37n) & 0xfff7eee000000000n;
    x ^= x >> 43n;
    return x & MASK;
  }
  /** A uniform draw on (0, 1), as Stata's runiform(). */
  uniform() {
    for (;;) {
      const value = Number(this.next()) / 2 ** 64;
      if (value > 0 && value < 1) return value;
    }
  }
  normal() {
    return invnormal(this.uniform());
  }
}
