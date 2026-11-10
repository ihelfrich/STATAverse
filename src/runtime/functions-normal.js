// The standard normal distribution: density, cumulative and inverse.
import { MISSING } from "./values.js";

const SQRT_2PI = Math.sqrt(2 * Math.PI);
export const density = (z) => Math.exp(-0.5 * z * z) / SQRT_2PI;
// Upper tail of the standard normal for z >= 0.
function upperTail(z) {
  if (z < 3) {
    // Series for the central part: 0.5 + phi(z) * sum z^(2k+1) / (2k+1)!!
    let term = z,
      sum = z;
    for (let k = 1; k < 200; k++) {
      term *= (z * z) / (2 * k + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 0.5 - density(z) * sum;
  }
  // Continued fraction for the tail, evaluated from the inside out.
  let fraction = 0;
  for (let k = 160; k >= 1; k--) fraction = k / (z + fraction);
  return density(z) / (z + fraction);
}
export function normal(z) {
  if (z < -38) return 0;
  if (z > 38) return 1;
  return z < 0 ? upperTail(-z) : 1 - upperTail(z);
}
export function invnormal(p) {
  if (!(p > 0 && p < 1)) return MISSING;
  // Acklam's rational approximation, then Newton steps on the exact CDF.
  const a = [
      -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
      1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
    ],
    b = [
      -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
      6.680131188771972e1, -1.328068155288572e1,
    ],
    c = [
      -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
      -2.549732539343734, 4.374664141464968, 2.938163982698783,
    ],
    d = [
      7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
      3.754408661907416,
    ];
  const tail = (q) =>
    (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  let x;
  if (p < 0.02425) x = tail(Math.sqrt(-2 * Math.log(p)));
  else if (p > 1 - 0.02425) x = -tail(Math.sqrt(-2 * Math.log(1 - p)));
  else {
    const q = p - 0.5,
      r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  for (let k = 0; k < 3; k++) {
    // Work with the smaller tail so the difference keeps its precision.
    const error = x < 0 ? normal(x) - p : 1 - p - upperTail(x),
      step = error / density(x);
    x -= step / (1 + (x * step) / 2);
  }
  return x;
}
