// margins' numerical chain rule, as Stata takes it after the fixed-effects
// models, whose equation has no constant (xtlogit, fe; clogit; xtpoisson,
// fe). Stata finds the derivative of each prediction in the linear index by
// stepping one coefficient, b_j, the first whose column is nowhere zero, and
// dividing the change by x_j. With a constant to step that derivative is
// exact to many digits, and margins here takes it analytically; without one
// the step deriv() chooses can be large (the average prediction barely moves
// when x_j is centred or the prediction saturates), and Stata's printed
// effect and standard error carry its error. This follows Mata's deriv() as
// _marg.mata calls it: a step (|b_j| + 1e-4) * 1e-4, scaled until the
// average moves between the bounds 1e-5 and 1e-3, central differences, and
// every step rounded to float.

/** Lagrange interpolation in (dv, scale) to the scale at which dv is x. */
function linear(x, y0, x0, y1, x1) {
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}
function quadratic(x, y0, x0, y1, x1, y2, x2) {
  return (
    (y0 * (x - x1) * (x - x2)) / ((x0 - x1) * (x0 - x2)) +
    (y1 * (x - x0) * (x - x2)) / ((x1 - x0) * (x1 - x2)) +
    (y2 * (x - x0) * (x - x1)) / ((x2 - x0) * (x2 - x1))
  );
}
const unusable = (v) => !Number.isFinite(v);

/**
 * deriv()'s search for the scale of the step h: at(delta) returns the
 * predictions at b_j + delta and their weighted average, value is the
 * average at b. Returns the scale with the predictions a step either side.
 */
export function searchStep(at, value, h) {
  const step = (scale) => Math.fround(h * scale);
  let goal0 = (Math.abs(value) + 1e-5) * 1e-5,
    goal1 = (Math.abs(value) + 1e-3) * 1e-3,
    mgoal = (goal0 + goal1) / 2,
    mingoal = (Math.abs(value) + 1e-10) * 1e-10,
    scale = 1,
    minus = at(-step(scale));
  const scale0 = scale,
    minus0 = minus;
  let dv = Math.abs(value - minus.sum),
    scale1 = 0,
    dv1 = 0,
    scale2 = 0,
    dv2 = 0,
    nflat = 0;
  const outside = () => dv < goal0 || dv > goal1;
  for (let iter = 1; iter <= 20 && outside(); iter++) {
    let next =
      dv < mingoal
        ? 2 * scale
        : iter === 1
          ? linear(mgoal, scale, dv, scale1, dv1)
          : quadratic(mgoal, scale, dv, scale1, dv1, scale2, dv2);
    if (
      unusable(next) ||
      next <= 0 ||
      (dv > goal1 && next > scale) ||
      (dv < goal0 && next < scale)
    )
      next = dv < goal0 ? 2 * scale : scale / 2;
    scale2 = scale1;
    dv2 = dv1;
    scale1 = scale;
    dv1 = dv;
    scale = next;
    minus = at(-step(scale));
    dv = Math.abs(value - minus.sum);
    // A flat average: four steps in a row that change nothing.
    if (dv) nflat = -20;
    else if (++nflat > 4) return { delta: 0 };
  }
  if (!outside()) return { delta: step(scale), plus: at(step(scale)), minus };
  // The goal was not met: start again from the first scale, looking at
  // both sides of b.
  scale = scale0;
  minus = minus0;
  let plus = at(step(scale));
  goal0 = (Math.abs(value) + 1e-5) * 1e-5;
  goal1 = (Math.abs(value) + 1e-3) * 1e-3;
  mgoal = (goal0 + goal1) / 2;
  mingoal = (Math.abs(value) + 1e-12) * 1e-12;
  const both = () =>
    (Math.abs(value - plus.sum) + Math.abs(value - minus.sum)) / 2;
  dv = both();
  let bestdv = dv,
    bestscale = scale;
  scale1 = 0;
  dv1 = 0;
  for (let iter = 1; iter <= 40 && outside(); iter++) {
    let next =
      dv < mingoal
        ? 2 * scale
        : iter === 1
          ? linear(mgoal, scale, dv, scale1, dv1)
          : quadratic(mgoal, scale, dv, scale1, dv1, scale2, dv2);
    if (
      unusable(next) ||
      next <= 0 ||
      (dv > goal1 && next > scale) ||
      (dv < goal0 && next < scale)
    )
      next = dv < goal0 ? 2 * scale : scale / 2;
    scale2 = scale1;
    dv2 = dv1;
    scale1 = scale;
    dv1 = dv;
    scale = next;
    minus = at(-step(scale));
    plus = at(step(scale));
    dv = both();
    if (dv > 1.1 * bestdv || (dv >= 0.9 * bestdv && scale < bestscale)) {
      bestdv = dv;
      bestscale = scale;
    }
  }
  if (outside()) {
    if (!(bestdv >= mingoal)) return { delta: 0 };
    scale = bestscale;
    minus = at(-step(scale));
    plus = at(step(scale));
  }
  return { delta: step(scale), plus, minus };
}

/**
 * The derivative of each observation's prediction in its linear index, and
 * the second derivative, as Stata's chain rule takes them by stepping
 * coefficient j. rows: [{ index, x, w }] with index(delta) the linear index
 * at b_j + delta (summed afresh, as Stata's predict does), x the value of
 * column j and w the normalised weight; link is the prediction's mean and
 * its derivatives in the index. Stata steps a coefficient whose column is
 * nowhere zero, since it divides by x.
 *
 * Where the index moves by less than 1e-3 the second difference is mostly
 * rounding (a unit in the last place over delta^2 x^2), which in Stata
 * depends on the last bits of the coefficients; there it is taken
 * analytically, which the difference approaches to within (delta x)^2 / 12.
 */
export function chainDerivatives(rows, link, bj) {
  const [mean, , curve] = link,
    at = (delta) => {
      const values = rows.map((r) => mean(r.index(delta)));
      return {
        values,
        sum: values.reduce((t, v, n) => t + rows[n].w * v, 0),
      };
    },
    base = at(0),
    { delta, plus, minus } = searchStep(
      at,
      base.sum,
      (Math.abs(bj) + 1e-4) * 1e-4,
    );
  return rows.map((r, n) => {
    if (!delta) return { slope: 0, curve: 0 };
    return {
      slope: (plus.values[n] - minus.values[n]) / (2 * delta) / r.x,
      curve:
        Math.abs(delta * r.x) < 1e-3
          ? curve(r.index(0))
          : (plus.values[n] + minus.values[n] - 2 * base.values[n]) /
            (delta * delta) /
            (r.x * r.x),
    };
  });
}
