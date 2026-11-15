// Random numbers. The generator is the 64-bit Mersenne Twister (MT19937-64)
// seeded as its reference implementation seeds it, which is what Stata's
// default generator (mt64) is. After the same set seed, runiform() and
// rnormal() return the same doubles as Stata 19, draw for draw.
//
// runiform() is the reference implementation's genrand64_real3: the top 52
// bits of a 64-bit output plus one half, times 2^-52, so a draw is never 0
// or 1.
//
// rnormal() is the rectangle-wedge-tail method of Marsaglia, MacLaren and
// Bray (1964) as Knuth gives it (TAOCP vol. 2, 3.4.1, Algorithm M), with
// Walker's alias method choosing the piece; Stata's documentation cites these
// three. Stata's version, found by experiment: the half-normal is cut at
// multiples of 1/8 into 31 rectangles under the density, 31 wedges above them
// and a tail beyond 3.875, and the 63 pieces share 64 alias cells. Each draw
// takes one uniform for the sign (negative when it is at least one half), one
// for the cell (64u) and one for the place within the piece; a wedge then
// takes pairs of uniforms by Knuth's steps M4 to M6, and the tail pairs by
// M7 and M8, until one is accepted. The cell tables below are the doubles
// Stata computes for itself at startup. They were read from 3,000,000 draws
// of rnormal() in Stata 19 MP and agree with every one of a further 1,000,000;
// thresholds are known to about 1e-16, which can matter only for a uniform
// that close to one of them. docs/numerical-contract.md has the rest.
//
// CUT is each cell's probability of keeping its own piece: a rectangle (cells
// 0 to 31: rectangle max(c - 1, 0)), a wedge (cells 32 to 62: wedge c - 32) or
// the tail (cell 63). Otherwise the draw falls in the cell's alias rectangle.
const CUT = [
  1, 0.844724120355528, 0.6217009867662424, 0.7558700540153123,
  0.23696983029195817, 0.9402295905531441, 0.2973535154714907,
  0.8430987520048364, 0.8451220303623262, 0.3039521097395871,
  0.24380299599459201, 0.7329442276829976, 0.8108672892551441,
  0.5189824855487387, 0.899419586772923, 1, 0.8638554642110088,
  0.6675357641014177, 0.5078344293706786, 0.3803504132786207,
  0.2804528078970966, 0.2035869055493029, 0.14549700002545685,
  0.10236992497157693, 0.0709095745910081, 0.048356128563180056,
  0.03246476891679628, 0.021457901975846072, 0.013962923120732107,
  0.008944984355714669, 0.005641530917879112, 0.003502906204233769,
  0.033089787138461335, 0.08122704031419203, 0.12563894477810233,
  0.16441968073624758, 0.19608174188665017, 0.21964769951767504,
  0.2346911650610597, 0.24132586958856805, 0.24014797730378223,
  0.23214179792971024, 0.21856232105380347, 0.20080916790287306,
  0.18030570717636984, 0.1583945853553287, 0.13625735938806183,
  0.11486195237551067, 0.0949378998640763, 0.07697629618504787,
  0.0612492743125862, 0.0478428426580656, 0.036696865684431534,
  0.02764669635317396, 0.02046217040231746, 0.01488107607342748,
  0.010635581199599065, 0.007471263943059969, 0.005159261302968177,
  0.003502596909922606, 0.0023380048480349247, 0.0015345894892162537,
  0.000990525533324016, 0.006823980768146609,
];
const SPREAD = [
  0.125, 0.1479773064221132, 0.20106128615008875, 0.16537234057094657,
  0.5274933093634494, 0.13294625191115456, 0.4203750535849461,
  0.14826258454630348, 0.14790763405659793, 0.4112489961234174,
  0.5127090398953618, 0.17054503641450763, 0.15415592866598918,
  0.2408559122526708, 0.13897851663259234, 0.125, 0.144700132346986,
  0.18725588458659564, 0.24614321670727052, 0.328644312286925,
  0.4457077856958553, 0.6139884078631402, 0.8591242429612254,
  1.2210617526066012, 1.7628084884301505, 2.5849877505532795, 3.850327729741788,
  5.825359820391822, 8.952280186546352, 13.974311751606523, 22.157106257071217,
  35.68465517258767,
];
const ALIAS_BASE = [
  0, -0.5550187851854823, 0.04457354995065688, -0.012022396497970878,
  0.461179478921746, -1.3413358492406182, 0.6971011522118727,
  0.20332054972658353, 0.31791297340461777, 1.070414655731183,
  1.209699159957124, 1.0319329782109272, 0.9640884130634194, 1.4901342025090325,
  0.6322132984004392, 0, -0.6681418796986168, -0.12598029051801846,
  -0.0039795700056085015, 0.17327308420976112, 0.20127963617690892,
  0.34304627727622294, 0.35371613674413793, 0.6107444163498622,
  0.6154598125419556, 0.8686483423559789, 0.9958057381434511,
  0.9972589449627188, 1.1232299191064747, 1.2488717850908233,
  1.3742908077050062, 1.4995605975388635, -0.00427777402419472,
  0.11394897816458795, 0.2320384633973923, 0.35040336982788184,
  -0.03048844517271236, 0.08981593964323648, 0.46166724557025,
  0.21023887926399704, 0.5854942853788073, 0.33720952688533307,
  -0.03496157258320082, 0.09359179938039061, 0.47250412306836,
  0.7264743396075043, 0.23028096666451375, 0.6087790906339732, 0.36188793014178,
  0.8645755255435347, -0.0081556893428412, 0.11871915099713883,
  0.49523814669842936, 0.7464459039413086, 0.24738879783607723,
  0.9981117665451353, 0.6236562609037812, 0.374059062011048, 0.8743517478348186,
  1.1245606364729275, -0.00029293549060156, 0.12480788149080309,
  0.4998760615441294, 0.7491411415705768,
];
const ALIAS_SPREAD = [
  0, 0.8050187851854823, 0.3304264500493431, 0.5120223964979709,
  0.163820521078254, 2.091335849240618, 0.17789884778812726, 0.7966794502734165,
  0.8070870265953822, 0.17958534426881698, 0.16530084004287598,
  0.4680670217890727, 0.6609115869365806, 0.2598657974909675,
  1.2427867015995608, 0, 0.9181418796986168, 0.37598029051801846,
  0.2539795700056085, 0.20172691579023888, 0.17372036382309108,
  0.15695372272377708, 0.1462838632558621, 0.13925558365013777,
  0.1345401874580444, 0.1313516576440211, 0.12919426185654892,
  0.12774105503728114, 0.1267700808935253, 0.1261282149091768,
  0.1257091922949938, 0.1254394024611365, 0.1292777740241947,
  0.13605102183541204, 0.1429615366026077, 0.14959663017211816,
  0.15548844517271235, 0.16018406035676352, 0.16333275442974998,
  0.16476112073600296, 0.16450571462119265, 0.16279047311466693,
  0.15996157258320082, 0.1564082006196094, 0.15249587693164002,
  0.14852566039249573, 0.14471903333548625, 0.14122090936602688,
  0.13811206985822, 0.13542447445646533, 0.1331556893428412,
  0.13128084900286116, 0.12976185330157064, 0.1285540960586914,
  0.12761120216392277, 0.12688823345486466, 0.1263437390962188,
  0.125940937988952, 0.1256482521651814, 0.12543936352707258,
  0.12529293549060155, 0.12519211850919693, 0.1251239384558706,
  0.12585885842942326,
];
// In a rectangle cell kept for its own rectangle k, the draw is k/8 + f * SPREAD[c].
// In the alias rectangle it is ALIAS_BASE[c] + f * ALIAS_SPREAD[c].

const WIDTH = 0.125,
  TAIL = 3.875;
// Knuth's E for each wedge: the scale that puts the wedge under the triangle
// U <= V. Below x = 1 the density is concave and its tangent at the right
// end bounds it; above, it is convex and its chord does.
const WEDGE_SCALE = Array.from({ length: 31 }, (_, k) => {
  const a = k * WIDTH,
    b = a + WIDTH;
  return b <= 1 ? 1 / (WIDTH * b) : 1 / (Math.exp((b * b - a * a) / 2) - 1);
});

// The natural logarithm rounded correctly to the nearest double, as Stata's
// C library gives it; JavaScript's Math.log can be one bit off. It sums
// atanh's series in 160-bit fixed point, which is slow but serves only the
// tail, about one draw in ten thousand.
const FRACTION = 160n;
function atanhFixed(num, den) {
  const s = (num << FRACTION) / den,
    s2 = (s * s) >> FRACTION;
  let term = s,
    sum = 0n;
  for (let k = 1n; term > 0n; k += 2n) {
    sum += term / k;
    term = (term * s2) >> FRACTION;
  }
  return sum;
}
const LN2_FIXED = 2n * atanhFixed(1n, 3n);
const view = new DataView(new ArrayBuffer(8));
function roundedLog(v) {
  view.setFloat64(0, v);
  const high = view.getUint32(0),
    exponent = ((high >>> 20) & 0x7ff) - 1023,
    mantissa =
      (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4)) | (1n << 52n);
  const fixed =
    BigInt(exponent) * LN2_FIXED +
    2n * atanhFixed(mantissa - (1n << 52n), mantissa + (1n << 52n));
  return Number(fixed) * 2 ** -Number(FRACTION);
}

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
    return (Number(this.next() >> 12n) + 0.5) * 2 ** -52;
  }
  /** A standard normal draw, as Stata's rnormal(). */
  normal() {
    const negative = this.uniform() >= 0.5,
      cell = Math.floor(64 * this.uniform()),
      f = this.uniform();
    let x;
    if (f >= CUT[cell]) x = ALIAS_BASE[cell] + f * ALIAS_SPREAD[cell];
    else if (cell < 32) x = Math.max(cell - 1, 0) * WIDTH + f * SPREAD[cell];
    else if (cell < 63) x = this.wedge(cell - 32);
    else x = this.tail();
    return negative ? -x : x;
  }
  // Knuth's steps M4 to M6: a point under the wedge above rectangle k.
  wedge(k) {
    const a = k * WIDTH,
      b = a + WIDTH,
      scale = WEDGE_SCALE[k];
    for (;;) {
      let u = this.uniform(),
        v = this.uniform();
      if (u > v) [u, v] = [v, u];
      const x = a + u * WIDTH;
      if (v - u <= scale * (Math.exp((b * b - x * x) / 2) - 1)) return x;
    }
  }
  // Knuth's steps M7 and M8: the tail beyond 3.875.
  tail() {
    for (;;) {
      const u = this.uniform(),
        v = this.uniform();
      const x = Math.sqrt(TAIL * TAIL - 2 * roundedLog(v));
      if (x * u < TAIL) return x;
    }
  }
}
