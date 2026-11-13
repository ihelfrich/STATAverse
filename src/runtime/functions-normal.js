// The standard normal distribution: density, cumulative and inverse.
// normal() is W. J. Cody's rational Chebyshev approximation (Math. Comp.
// 1969) and invnormal() is Wichura's AS 241 (Applied Statistics 1988), the
// algorithms whose doubles Stata's normal() and invnormal() return: the
// series and Newton steps used before were off by up to about 1e-14.
import { MISSING } from "./values.js";

const SQRT_2PI = Math.sqrt(2 * Math.PI);
export const density = (z) => Math.exp(-0.5 * z * z) / SQRT_2PI;

const A = [
    2.2352520354606839287, 161.02823106855587881, 1067.6894854603709582,
    18154.981253343561249, 0.065682337918207449113,
  ],
  B = [
    47.20258190468824187, 976.09855173777669322, 10260.932208618978205,
    45507.789335026729956,
  ],
  C = [
    0.39894151208813466764, 8.8831497943883759412, 93.506656132177855979,
    597.27027639480026226, 2494.5375852903726711, 6848.1904505362823326,
    11602.651437647350124, 9842.7148383839780218, 1.0765576773720192317e-8,
  ],
  D = [
    22.266688044328115691, 235.38790178262499861, 1519.377599407554805,
    6485.558298266760755, 18615.571640885098091, 34900.952721145977266,
    38912.003286093271411, 19685.429676859990727,
  ],
  P = [
    0.21589853405795699, 0.1274011611602473639, 0.022235277870649807,
    0.001421619193227893466, 2.9112874951168792e-5, 0.02307344176494017303,
  ],
  Q = [
    1.28426009614491121, 0.468238212480865118, 0.0659881378689285515,
    0.00378239633202758244, 7.29751555083966205e-5,
  ];
const SQRT_32 = 5.656854249492380195206754896838,
  ONE_OVER_SQRT_2PI = 0.398942280401432677939946059934;
/** exp(-x^2 / 2) times a factor, with x^2 split so it loses no digits. */
function gaussianTimes(x, factor) {
  const near = Math.trunc(x * 16) / 16,
    rest = (x - near) * (x + near);
  return Math.exp(-near * near * 0.5) * Math.exp(-rest * 0.5) * factor;
}
/** Pr(Z <= z) and Pr(Z > z), each to full relative precision. */
function tails(z) {
  const y = Math.abs(z);
  if (y <= 0.67448975) {
    let numerator = 0,
      denominator = 0;
    if (y > Number.EPSILON / 2) {
      const square = z * z;
      numerator = A[4] * square;
      denominator = square;
      for (let i = 0; i < 3; i++) {
        numerator = (numerator + A[i]) * square;
        denominator = (denominator + B[i]) * square;
      }
    }
    const t = (z * (numerator + A[3])) / (denominator + B[3]);
    return [0.5 + t, 0.5 - t];
  }
  let small;
  if (y <= SQRT_32) {
    let numerator = C[8] * y,
      denominator = y;
    for (let i = 0; i < 7; i++) {
      numerator = (numerator + C[i]) * y;
      denominator = (denominator + D[i]) * y;
    }
    small = gaussianTimes(y, (numerator + C[7]) / (denominator + D[7]));
  } else if (z > -37.5193 && z < 37.5193) {
    const inverse = 1 / (z * z);
    let numerator = P[5] * inverse,
      denominator = inverse;
    for (let i = 0; i < 4; i++) {
      numerator = (numerator + P[i]) * inverse;
      denominator = (denominator + Q[i]) * inverse;
    }
    const t = (inverse * (numerator + P[4])) / (denominator + Q[4]);
    small = gaussianTimes(z, (ONE_OVER_SQRT_2PI - t) / y);
  } else small = 0;
  return z > 0 ? [1 - small, small] : [small, 1 - small];
}
export const normal = (z) => tails(z)[0];

export function invnormal(p) {
  if (!(p > 0 && p < 1)) return MISSING;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (
      (q *
        (((((((r * 2509.0809287301226727 + 33430.575583588128105) * r +
          67265.770927008700853) *
          r +
          45921.953931549871457) *
          r +
          13731.693765509461125) *
          r +
          1971.5909503065514427) *
          r +
          133.14166789178437745) *
          r +
          3.387132872796366608)) /
      (((((((r * 5226.495278852545925 + 28729.085735721942674) * r +
        39307.89580009271061) *
        r +
        21213.794301586595867) *
        r +
        5394.1960214247511077) *
        r +
        687.1870074920579083) *
        r +
        42.313330701600911252) *
        r +
        1)
    );
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p)),
    value;
  if (r <= 5) {
    r -= 1.6;
    value =
      (((((((r * 7.7454501427834140764e-4 + 0.0227238449892691845833) * r +
        0.24178072517745061177) *
        r +
        1.27045825245236838258) *
        r +
        3.64784832476320460504) *
        r +
        5.7694972214606914055) *
        r +
        4.6303378461565452959) *
        r +
        1.42343711074968357734) /
      (((((((r * 1.05075007164441684324e-9 + 5.475938084995344946e-4) * r +
        0.0151986665636164571966) *
        r +
        0.14810397642748007459) *
        r +
        0.68976733498510000455) *
        r +
        1.6763848301838038494) *
        r +
        2.05319162663775882187) *
        r +
        1);
  } else {
    r -= 5;
    value =
      (((((((r * 2.01033439929228813265e-7 + 2.71155556874348757815e-5) * r +
        0.0012426609473880784386) *
        r +
        0.026532189526576123093) *
        r +
        0.29656057182850489123) *
        r +
        1.7848265399172913358) *
        r +
        5.4637849111641143699) *
        r +
        6.6579046435011037772) /
      (((((((r * 2.04426310338993978564e-15 + 1.4215117583164458887e-7) * r +
        1.8463183175100546818e-5) *
        r +
        7.868691311456132591e-4) *
        r +
        0.0148753612908506148525) *
        r +
        0.13692988092273580531) *
        r +
        0.59983220655588793769) *
        r +
        1);
  }
  return q < 0 ? -value : value;
}
