// The firm-year panel the project lab works on. Every value is simulated
// here from a fixed seed: no row, firm, identifier or name comes from a data
// vendor or describes a real company. The Big Four auditors are named because
// the exercise classifies auditors by name; every other auditor is invented.
//
// What is built in, so that the analysis has something true to find:
//   - Non-audit fees rise with firm size, with a Big Four auditor and with
//     asset turnover. Turnover has the same effect within a firm as between
//     firms.
//   - A chief executive who also chairs the board has no effect on fees
//     within a firm. Firms differ in a fixed way in how much they buy, and
//     the firms that buy more are also the firms more inclined to combine the
//     two posts, so a pooled regression finds a positive coefficient that
//     firm fixed effects remove.
//   - A positive operating cash flow has no effect on fees.
//   - A small share of rows carry ratios that are far too large, which is
//     what makes capping the ratios matter, and a handful carry values that
//     cannot be right (a negative fee, negative assets).
//
// The draws use arithmetic, powers, Math.log, Math.exp, Math.sqrt and
// Math.cos, and every stored number is rounded (thousandths of a million
// dollars, whole dollars of fees), so a last-bit difference between
// JavaScript engines in one of those functions does not reach the panel.

export const PANEL_SEED = 2393;
export const FIRST_YEAR = 2004;
export const LAST_YEAR = 2023;

export const PANEL_LABEL = "Simulated firm-year panel, fiscal years 2004-2023";

/**
 * The variables in file order: name, Stata storage type, format, label. A
 * str variable is as wide as its longest value and takes Stata's format for
 * that width; both are filled in by buildPanel().
 */
export const PANEL_VARIABLES = [
  ["firmid", "long", "%12.0g", "Firm number (panel identifier)"],
  ["gvkey", "str6", "", "Firm key in the accounting file"],
  ["conm", "str", "", "Company name"],
  ["fyear", "int", "%8.0g", "Fiscal year"],
  ["datadate", "int", "%td", "Fiscal year-end date"],
  ["at", "double", "%10.0g", "Total assets ($ millions)"],
  ["dltt", "double", "%10.0g", "Long-term debt ($ millions)"],
  ["ni", "double", "%10.0g", "Net income ($ millions)"],
  ["sale", "double", "%10.0g", "Net sales ($ millions)"],
  ["oancf", "double", "%10.0g", "Operating cash flow ($ millions)"],
  ["sich", "int", "%8.0g", "Four-digit SIC industry code"],
  ["titleann", "str", "", "Chief executive's title for the year"],
  ["non_audit_fees", "double", "%10.0g", "Non-audit fees ($)"],
  ["audit_fees", "double", "%10.0g", "Audit fees ($)"],
  ["total_fees", "double", "%10.0g", "Total fees paid to the auditor ($)"],
  ["auditor_name", "str", "", "Auditor name"],
  ["fiscal_ye", "str4", "", "Fiscal year-end in the fee file (MMDD)"],
  ["match_exec", "byte", "%8.0g", "Merge with executive file (3 = matched)"],
  ["match_audit", "byte", "%8.0g", "Merge with audit-fee file (3 = matched)"],
].map(([name, type, format, label]) => ({ name, type, format, label }));

// Everything that shapes the panel. tools/check-project-native.mjs records
// what installed Stata estimates from the panel these values produce; change
// one and the fixture has to be recorded again.
const P = {
  firms: 5500,
  // The share of firms the executive file covers at some time.
  coveredShare: 0.21,
  // Size, log of assets in $ millions.
  sizeCovered: [8.0, 1.62],
  sizeOther: [4.95, 3.0],
  // What the fee equation holds.
  feeConstant: 11.85,
  feeSize: 0.67,
  feeTurnover: 0.125,
  feeCashFlow: 0,
  feeLeverage: 0.3,
  feeRoa: -0.35,
  feeLoss: 0.06,
  feeBigFour: 0.36,
  // The firm's fixed level of buying, and how far it moves with the firm's
  // inclination to combine the two posts.
  firmEffect: 0.55,
  chairLoading: 0.1,
  feeNoise: 0.72,
  feeNoisePersistence: 0.3,
};

function generator(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () =>
    Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  return {
    uniform,
    normal,
    chance: (p) => uniform() < p,
    whole: (low, high) => low + Math.floor(uniform() * (high - low + 1)),
    pick: (list) => list[Math.floor(uniform() * list.length)],
    exponential: (mean) => -mean * Math.log(1 - uniform()),
    /** One of a list of [value, weight] pairs. */
    weighted(pairs) {
      let total = 0;
      for (const pair of pairs) total += pair[1];
      let u = uniform() * total;
      for (const pair of pairs) {
        u -= pair[1];
        if (u < 0) return pair[0];
      }
      return pairs.at(-1)[0];
    },
  };
}

const round = (x, places) => {
  const scale = 10 ** places;
  return Math.round(x * scale) / scale;
};
const cdf = (z) => 1 / (1 + Math.exp(-1.702 * z));

// Two-digit SIC groups: weight among non-financial firms, the four-digit
// codes used, the level of log turnover, and the noun a company name takes.
const INDUSTRIES = [
  [73, 136, [7370, 7372, 7373, 7374], -0.45, ["SOFTWARE", "SYSTEMS", "DATA"]],
  [
    28,
    108,
    [2834, 2835, 2836, 2860],
    -0.75,
    ["PHARMA", "THERAPEUTICS", "CHEMICAL"],
  ],
  [
    36,
    70,
    [3661, 3663, 3674, 3690],
    -0.25,
    ["ELECTRONICS", "SEMICONDUCTOR", "DEVICES"],
  ],
  [
    38,
    66,
    [3823, 3841, 3842, 3845],
    -0.4,
    ["INSTRUMENTS", "MEDICAL", "DEVICES"],
  ],
  [
    35,
    62,
    [3531, 3559, 3571, 3576],
    -0.15,
    ["MACHINERY", "EQUIPMENT", "SYSTEMS"],
  ],
  [13, 44, [1311, 1381, 1389], -1.15, ["PETROLEUM", "ENERGY", "DRILLING"]],
  [
    37,
    33,
    [3711, 3714, 3721, 3728],
    0.05,
    ["MOTORS", "AEROSPACE", "COMPONENTS"],
  ],
  [
    48,
    29,
    [4812, 4813, 4833, 4841],
    -0.85,
    ["TELECOM", "COMMUNICATIONS", "BROADCASTING"],
  ],
  [80, 25, [8011, 8051, 8062, 8071], 0.1, ["HEALTH", "CARE", "CLINICS"]],
  [
    50,
    24,
    [5045, 5047, 5065, 5090],
    0.75,
    ["DISTRIBUTION", "SUPPLY", "WHOLESALE"],
  ],
  [20, 23, [2011, 2040, 2080, 2086], 0.15, ["FOODS", "BEVERAGE", "BRANDS"]],
  [87, 19, [8711, 8731, 8742], 0.0, ["ENGINEERING", "CONSULTING", "RESEARCH"]],
  [33, 17, [3312, 3334, 3350], 0.05, ["STEEL", "METALS", "ALLOYS"]],
  [34, 16, [3411, 3443, 3490], 0.0, ["FABRICATION", "HARDWARE", "METALWORKS"]],
  [26, 14, [2621, 2631, 2670], -0.05, ["PAPER", "PACKAGING", "FIBRE"]],
  [59, 13, [5912, 5940, 5961], 0.7, ["RETAIL", "STORES", "OUTFITTERS"]],
  [79, 13, [7948, 7990, 7997], -0.6, ["ENTERTAINMENT", "RESORTS", "GAMING"]],
  [15, 12, [1520, 1531], -0.1, ["HOMES", "BUILDERS", "CONSTRUCTION"]],
  [51, 11, [5122, 5140, 5171], 1.0, ["DISTRIBUTORS", "TRADING", "SUPPLY"]],
  [27, 10, [2711, 2721, 2741], -0.2, ["MEDIA", "PUBLISHING", "PRESS"]],
  [30, 10, [3011, 3080, 3089], 0.05, ["PLASTICS", "RUBBER", "POLYMERS"]],
  [42, 10, [4213, 4220], 0.35, ["FREIGHT", "LOGISTICS", "TRUCKING"]],
  [45, 9, [4512, 4513, 4522], -0.15, ["AIRLINES", "AVIATION", "AIR"]],
  [29, 9, [2911, 2990], 0.3, ["REFINING", "PETROLEUM", "FUELS"]],
  [58, 9, [5810, 5812], 0.25, ["RESTAURANTS", "DINING", "KITCHENS"]],
  [56, 16, [5600, 5621, 5651], 0.65, ["APPAREL", "FASHION", "STORES"]],
  [53, 14, [5311, 5331, 5399], 0.8, ["STORES", "MERCHANTS", "RETAIL"]],
  [10, 14, [1040, 1090], -0.9, ["MINING", "GOLD", "MINERALS"]],
  [23, 13, [2300, 2320, 2330], 0.2, ["APPAREL", "TEXTILES", "GARMENTS"]],
  [40, 12, [4011, 4013], -0.9, ["RAILWAY", "RAIL", "TRANSPORT"]],
  [54, 12, [5411, 5412], 1.05, ["GROCERS", "MARKETS", "FOODS"]],
  [70, 12, [7011, 7041], -0.7, ["HOTELS", "LODGING", "HOSPITALITY"]],
  [82, 12, [8200, 8220], -0.1, ["EDUCATION", "LEARNING", "SCHOOLS"]],
  [25, 12, [2510, 2520, 2531], 0.3, ["FURNITURE", "INTERIORS", "SEATING"]],
  [32, 12, [3211, 3241, 3270], -0.2, ["GLASS", "CEMENT", "MATERIALS"]],
  [16, 11, [1600, 1623], 0.3, ["INFRASTRUCTURE", "CONTRACTORS", "PAVING"]],
  [24, 11, [2421, 2430, 2452], 0.1, ["LUMBER", "TIMBER", "WOOD"]],
  [39, 11, [3942, 3944, 3990], 0.1, ["TOYS", "GOODS", "PRODUCTS"]],
  [44, 11, [4400, 4412], -0.8, ["SHIPPING", "MARINE", "TANKERS"]],
  [57, 11, [5700, 5731], 0.75, ["FURNISHINGS", "ELECTRONICS", "STORES"]],
  [22, 10, [2200, 2211, 2250], 0.15, ["TEXTILES", "MILLS", "FABRICS"]],
];
// Banks, insurers, other financial firms and utilities, which the analysis
// sets aside.
const FINANCIALS = [
  [
    60,
    34,
    [6020, 6021, 6022, 6035],
    -2.85,
    ["BANCORP", "BANCSHARES", "FINANCIAL"],
  ],
  [61, 6, [6111, 6141, 6153], -1.9, ["CREDIT", "LENDING", "FINANCE"]],
  [62, 9, [6199, 6211, 6282], -1.3, ["CAPITAL", "SECURITIES", "ADVISORS"]],
  [63, 15, [6311, 6321, 6331], -1.35, ["INSURANCE", "ASSURANCE", "MUTUAL"]],
  [67, 18, [6722, 6726, 6798], -2.1, ["TRUST", "PROPERTIES", "REALTY"]],
  [49, 18, [4911, 4922, 4931, 4941], -1.0, ["UTILITIES", "POWER", "GAS"]],
];
const LEGAL = [
  ["INC", 46],
  ["CORP", 30],
  ["CO", 8],
  ["LTD", 6],
  ["HOLDINGS INC", 6],
  ["GROUP INC", 4],
];

const ONSETS =
  "b br c cr d dr f fl g gl h j k kl l m n p pr qu r s sk st t tr v w z".split(
    " ",
  );
const VOWELS = "a e i o u a e o ai ea io ou".split(" ");
const CODAS = "n r l s x th nd rn lt m rd st ck".split(" ");

/** An invented company root such as VELMORAN: two or three made syllables. */
function root(r) {
  let text = "";
  const parts = r.chance(0.45) ? 3 : 2;
  for (let k = 0; k < parts; k++) text += r.pick(ONSETS) + r.pick(VOWELS);
  if (r.chance(0.7)) text += r.pick(CODAS);
  return text.toUpperCase();
}

const CHAIR_TITLES = [
  ["Chairman & CEO", 30],
  ["Chairman, President & CEO", 22],
  ["Chairman of the Board & CEO", 8],
  ["Chairman and Chief Executive Officer", 8],
  ["Chairman of the Board, President and Chief Executive Officer", 5],
  ["CEO & Chairman of the Board", 5],
  ["President, CEO & Chairman", 4],
  ["Chair & CEO", 4],
  ["Executive Chairman & CEO", 3],
  ["Founder, Chairman & CEO", 3],
  ["Chairwoman & CEO", 1],
  ["Co-Chairman & CEO", 1],
];
const OTHER_TITLES = [
  ["President & CEO", 40],
  ["President, CEO & Director", 12],
  ["CEO", 10],
  ["Chief Executive Officer", 8],
  ["CEO & Director", 8],
  ["President and Chief Executive Officer", 8],
  ["CEO & President", 4],
  ["Chief Executive Officer and Director", 4],
  ["President, Chief Executive Officer & Director", 3],
  ["Founder & CEO", 2],
  ["Interim CEO", 1.5],
  ["Co-CEO", 1],
];
// A vice chair is not the chair, though the word is in the title.
const VICE_TITLES = [
  ["Vice Chairman & CEO", 5],
  ["Vice-Chairman, President & CEO", 2],
  ["Vice Chair & CEO", 2],
  ["Vice Chairman of the Board & CEO", 2],
  ["CEO & Vice Chairman", 2],
  ["Vice  Chairman & CEO", 1],
];

const BIG_FOUR = [
  [
    ["Deloitte & Touche LLP", 70],
    ["DELOITTE & TOUCHE LLP", 12],
    ["Deloitte & Touche", 10],
    ["Deloitte LLP", 8],
  ],
  [
    ["Ernst & Young LLP", 72],
    ["ERNST & YOUNG LLP", 12],
    ["Ernst & Young", 16],
  ],
  [
    ["KPMG LLP", 74],
    ["KPMG", 18],
    ["Kpmg LLP", 8],
  ],
  [
    ["PricewaterhouseCoopers LLP", 66],
    ["PRICEWATERHOUSECOOPERS LLP", 10],
    ["PricewaterhouseCoopers", 10],
    ["PwC LLP", 9],
    ["PwC", 5],
  ],
];
// Invented firms. None of the names holds a Big Four name inside it.
const SMALL_AUDITORS = [
  "Harlow Finch LLP",
  "Braddock & Sills LLP",
  "Tennant Rowe & Co",
  "Marlin Okafor LLP",
  "Castellan Audit Group",
  "Whitlow Pryce LLP",
  "Dunmore & Hale",
  "Ostrander Vale LLP",
  "Quillfeather LLP",
  "Brightwater Assurance",
  "Sorrel & Thane LLP",
  "Kestrel Audit Partners",
  "Lindqvist Moor LLP",
  "Pemberton Ruiz & Co",
  "Aldergate LLP",
  "Hartsfield Okoro LLP",
  "Vantongeren & Lisle",
  "Northmere Assurance",
  "Calloway Stride LLP",
  "Ibarra Whitcombe LLP",
  "Thistlewood & Crane",
  "Marchetti Dolan LLP",
];

// Months a fiscal year ends in, by share of firms.
const YEAR_END_MONTHS = [
  [12, 765],
  [6, 47],
  [9, 42],
  [3, 40],
  [10, 23],
  [1, 19],
  [8, 14],
  [4, 13],
  [7, 11],
  [11, 10],
  [5, 9],
  [2, 7],
];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthDays = (year, month) =>
  month === 2 && leap(year) ? 29 : MONTH_DAYS[month - 1];
/** Days from 1 January 1960, which is how Stata counts a daily date. */
function dailyDate(year, month, day) {
  let days = 0;
  for (let y = 1960; y < year; y++) days += leap(y) ? 366 : 365;
  for (let m = 1; m < month; m++) days += monthDays(year, m);
  return days + day - 1;
}
const two = (x) => String(x).padStart(2, "0");

/** A title or auditor name as someone keyed it: case and stray spaces vary. */
function keyed(r, text) {
  const u = r.uniform();
  let out = text;
  if (u < 0.07) out = text.toLowerCase();
  else if (u < 0.15) out = text.toUpperCase();
  const v = r.uniform();
  if (v < 0.03) out = ` ${out}`;
  else if (v < 0.08) out = `${out} `;
  else if (v < 0.09) out = `  ${out} `;
  return out;
}

/**
 * The panel, as columns. Numeric columns are Float64Arrays in which NaN
 * stands for Stata's missing value; string columns are arrays of text in
 * which "" is the empty string. Rows are sorted by firmid and fyear.
 */
export function buildPanel(seed = PANEL_SEED) {
  const r = generator(seed),
    columns = Object.fromEntries(PANEL_VARIABLES.map((v) => [v.name, []])),
    years = LAST_YEAR - FIRST_YEAR + 1,
    // Fee levels by industry and by year, the same for every firm.
    industryLevel = new Map(
      [...INDUSTRIES, ...FINANCIALS].map((row) => [row[0], 0.22 * r.normal()]),
    ),
    yearLevel = [];
  for (let t = 0; t < years; t++)
    yearLevel.push(
      0.3 * Math.exp(-t / 3) + 0.012 * t + 0.05 * r.normal() - 0.12,
    );
  const names = new Set();
  let key = 900000;

  for (let firm = 1; firm <= P.firms; firm++) {
    const covered = r.chance(P.coveredShare);
    // The years the firm is in the file.
    let start, end;
    do {
      const birth = 1972 + Math.floor(r.uniform() * 52),
        life = covered
          ? 6 + Math.floor(r.exponential(34))
          : 1 +
            Math.floor(
              r.chance(0.32)
                ? r.exponential(24)
                : r.exponential(3.0) + r.exponential(3.0),
            );
      start = Math.max(FIRST_YEAR, birth);
      end = Math.min(LAST_YEAR, birth + life - 1);
    } while (end < start || (covered && end < FIRST_YEAR + 2));
    const span = end - start + 1,
      gap = span >= 4 && r.chance(0.035) ? start + r.whole(1, span - 2) : 0;

    // What the firm is.
    const financial = r.chance(covered ? 0.19 : 0.29),
      industry = r.weighted(
        (financial ? FINANCIALS : INDUSTRIES).map((row) => [row, row[1]]),
      ),
      sic = r.pick(industry[2]),
      [sizeMean, sizeSpread] = covered ? P.sizeCovered : P.sizeOther,
      size0 =
        sizeMean +
        sizeSpread * r.normal() +
        (financial ? 0.8 : 0) +
        (covered ? 0 : -0.2),
      growth = (covered ? 0.045 : 0.02) + 0.09 * r.normal(),
      sizeShock = covered ? 0.2 : 0.33,
      turnoverLevel =
        industry[3] +
        0.42 * r.normal() -
        0.13 * (size0 - 8) +
        (covered ? 0.02 : -0.25),
      leverageLevel = 0.2 + 0.2 * r.normal() + (financial ? -0.02 : 0),
      roaLevel =
        0.045 +
        0.045 * r.normal() +
        (covered ? 0 : -0.05 * Math.max(0, 6.5 - size0)),
      month = r.weighted(YEAR_END_MONTHS),
      // A firm on a 52- or 53-week year ends it on a weekday near the month
      // end, and the fee file records that day.
      weekYear = r.chance(0.035),
      // The firm's inclination to combine chief executive and chair, and the
      // firm's fixed level of non-audit buying, which moves with it.
      inclination = r.normal(),
      own = r.normal(),
      buying = P.chairLoading * inclination + P.firmEffect * own,
      auditLevel = 0.2 * own + 0.48 * r.normal(),
      zeroLevel = 1.05 * r.normal(),
      // Accounting items: some firms never have them, some lose a few years.
      noAccounts = !covered && r.chance(0.225),
      holeRate = covered ? 0.002 : 0.42 * r.uniform() ** 2.2,
      noIndustry = r.chance(0.014),
      // The audit-fee file covers fewer firms each year.
      auditRank = r.uniform(),
      // Years the executive file covers the firm.
      execStart = !covered
        ? 9999
        : r.chance(0.6)
          ? Math.max(start, FIRST_YEAR + 1)
          : Math.max(start, FIRST_YEAR + 1) + r.whole(1, 7),
      execEnd = !covered ? 0 : r.chance(0.6) ? end : end - r.whole(1, 10);
    // The auditor, and the way the fee file spells the name, which stays
    // the same for as long as the engagement does.
    const engage = () => {
      const big = r.chance(cdf(0.62 * (size0 - 5.4)));
      return {
        big,
        name: big ? r.weighted(r.pick(BIG_FOUR)) : r.pick(SMALL_AUDITORS),
      };
    };
    let auditor = engage();
    let name;
    do name = `${root(r)} ${r.pick(industry[4])} ${r.weighted(LEGAL)}`;
    while (names.has(name));
    names.add(name);
    key += r.whole(1, 17);

    // Paths that carry over from year to year.
    let sizePath = (sizeShock / Math.sqrt(1 - 0.85 ** 2)) * r.normal(),
      turnoverPath = 0.22 * r.normal(),
      leveragePath = 0.105 * r.normal(),
      feePath = P.feeNoise * r.normal(),
      zeroPath = r.normal(),
      previousAssets = NaN,
      // The chief executive in post: a draw, years in post, and a style of
      // title that stays with the person.
      person = null;
    const newPerson = (first) => ({
      draw: r.normal(),
      tenure: first ? r.whole(0, 9) : 0,
      vice: r.chance(0.014),
      chairTitle: r.weighted(CHAIR_TITLES),
      otherTitle: r.weighted(OTHER_TITLES),
      viceTitle: r.weighted(VICE_TITLES),
    });

    for (let year = start; year <= end; year++) {
      const t = year - FIRST_YEAR,
        mid = (start + end) / 2;
      sizePath = 0.85 * sizePath + sizeShock * r.normal();
      turnoverPath = 0.75 * turnoverPath + 0.12 * r.normal();
      leveragePath = 0.7 * leveragePath + 0.075 * r.normal();
      feePath =
        P.feeNoisePersistence * feePath +
        P.feeNoise * Math.sqrt(1 - P.feeNoisePersistence ** 2) * r.normal();
      zeroPath = 0.6 * zeroPath + 0.8 * r.normal();
      if (!person || r.chance(0.17)) person = newPerson(!person);
      else person.tenure++;
      if (r.chance(0.035)) auditor = engage();
      const bigFour = auditor.big;

      // The year's true figures.
      const size = size0 + growth * (year - mid) + sizePath,
        assets = Math.exp(size),
        lagAssets = Number.isNaN(previousAssets)
          ? Math.exp(size - growth - 0.1 * r.normal())
          : previousAssets,
        turnover = Math.exp(turnoverLevel + turnoverPath),
        leverage = Math.max(
          0,
          leverageLevel + leveragePath + 0.012 * (size - 8),
        ),
        badYear = r.chance(covered ? 0.075 : 0.2),
        goodYear = r.chance(0.03),
        roa =
          roaLevel +
          (badYear
            ? -Math.abs(r.normal()) * (covered ? 0.33 : 0.6)
            : goodYear
              ? Math.abs(r.normal()) * 0.13
              : 0.036 * r.normal()),
        cashFlow = roa + 0.095 + 0.062 * r.normal() + 0.012 * (size - 8),
        positiveCashFlow = cashFlow > 0 ? 1 : 0,
        // Whether chief executive and chair are one person this year.
        latent =
          inclination +
          0.22 * (size0 - 8) +
          1.3 * person.draw +
          0.3 * Math.min(person.tenure, 4) -
          (0.52 + 0.07 * (t - 1)),
        chair = latent > 0;
      previousAssets = assets;
      const drawTitle = r.uniform(),
        drawForm = keyed(
          r,
          person.vice && !chair
            ? person.viceTitle
            : chair
              ? person.chairTitle
              : person.otherTitle,
        ),
        // Fees. The ratios enter as they truly are, not as mis-keyed.
        logFee =
          P.feeConstant +
          P.feeSize * (size - 8) +
          P.feeTurnover * turnover +
          P.feeCashFlow * positiveCashFlow +
          P.feeLeverage * leverage +
          P.feeRoa * Math.max(roa, -0.6) +
          P.feeLoss * (roa < 0 ? 1 : 0) +
          P.feeBigFour * (bigFour ? 1 : 0) +
          industryLevel.get(industry[0]) +
          yearLevel[t] +
          buying +
          feePath,
        noFee =
          zeroLevel +
            0.75 * zeroPath -
            0.3 * (size - 8) -
            0.35 * (bigFour ? 1 : 0) +
            0.02 * (t - 9) >
          1.72,
        logAudit =
          14.36 +
          0.44 * (size - 8) +
          0.3 * leverage +
          0.12 * (bigFour ? 1 : 0) +
          auditLevel +
          0.4 * (feePath / P.feeNoise) * 0.3 +
          0.25 * r.normal(),
        // Mis-keyed figures: a ratio many times its true value.
        slip = r.uniform(),
        slipSize = Math.exp(0.9 + 0.9 * Math.abs(r.normal())),
        zeroDraw = r.uniform(),
        slipSign = r.chance(0.5) ? 1 : -1,
        holeDraw = r.uniform(),
        itemDraw = r.uniform(),
        auditDraw = r.uniform(),
        formDraw = r.uniform(),
        dayDraw = r.whole(1, 6),
        otherFee = r.chance(0.04) ? Math.exp(9 + 1.5 * r.normal()) : 0,
        auditorText = keyed(r, auditor.name),
        wrongFee = r.chance(0.0006),
        wrongAssets = r.chance(0.0002);
      if (year === gap) continue;

      const hasAccounts = !noAccounts && holeDraw >= holeRate,
        execMatched = year >= execStart && year <= execEnd && hasAccounts,
        // The share of firms the fee file covers falls over the years, and
        // it covers nearly every firm the executive file does.
        auditMatched =
          (covered
            ? auditRank < 0.9 - 0.0045 * t
            : auditRank < 0.7 - 0.0125 * t) !==
          auditDraw < 0.045;
      let shownTurnover = turnover,
        shownLeverage = leverage,
        shownRoa = roa;
      if (slip < 0.0035) shownTurnover = turnover * slipSize * 2;
      else if (slip < 0.0065) shownRoa = slipSign * 0.35 * slipSize;
      else if (slip < 0.009) shownLeverage = (leverage + 0.1) * slipSize * 0.6;

      const fiscalYear = month >= 6 ? year : year + 1,
        lastDay = monthDays(fiscalYear, month);
      columns.firmid.push(firm);
      columns.gvkey.push(String(key));
      columns.conm.push(name);
      columns.fyear.push(year);
      columns.datadate.push(dailyDate(fiscalYear, month, lastDay));
      if (hasAccounts) {
        const shownAssets = round(wrongAssets ? -assets : assets, 3);
        columns.at.push(shownAssets);
        columns.dltt.push(
          itemDraw < 0.004 ? NaN : round(shownLeverage * assets, 3),
        );
        columns.ni.push(itemDraw > 0.992 ? NaN : round(shownRoa * assets, 3));
        columns.sale.push(
          itemDraw > 0.992
            ? NaN
            : round((shownTurnover * (assets + lagAssets)) / 2, 3),
        );
        columns.oancf.push(
          itemDraw > 0.984 ? NaN : round(cashFlow * assets, 3),
        );
        columns.sich.push(noIndustry ? NaN : sic);
      } else
        for (const item of ["at", "dltt", "ni", "sale", "oancf", "sich"])
          columns[item].push(NaN);
      columns.titleann.push(execMatched && drawTitle >= 0.038 ? drawForm : "");
      if (auditMatched) {
        const audit = Math.max(8000, Math.round(Math.exp(logAudit))),
          fee = wrongFee
            ? -Math.round(Math.exp(logFee - 2))
            : noFee
              ? 0
              : Math.max(500, Math.round(Math.exp(logFee)));
        columns.non_audit_fees.push(fee);
        columns.audit_fees.push(audit);
        columns.total_fees.push(audit + fee + Math.round(otherFee));
        columns.auditor_name.push(auditorText);
        // The year-end the fee file holds: usually the accounting file's.
        let feeMonth = month,
          feeDay = lastDay;
        if (weekYear && formDraw < 0.82) {
          feeDay = lastDay - dayDraw;
          if (formDraw < 0.25) {
            feeMonth = (month % 12) + 1;
            feeDay = dayDraw > 3 ? dayDraw - 3 : dayDraw;
          }
        } else if (formDraw > 0.988) {
          feeMonth = r.weighted(YEAR_END_MONTHS);
          feeDay = monthDays(2023, feeMonth);
        }
        // A few were keyed as numbers and lost the leading zero.
        columns.fiscal_ye.push(
          (feeMonth < 10 && zeroDraw < 0.02
            ? String(feeMonth)
            : two(feeMonth)) + two(feeDay),
        );
      } else {
        for (const item of ["non_audit_fees", "audit_fees", "total_fees"])
          columns[item].push(NaN);
        columns.auditor_name.push("");
        columns.fiscal_ye.push("");
      }
      columns.match_exec.push(execMatched ? 3 : 1);
      columns.match_audit.push(auditMatched ? 3 : 1);
    }
  }

  const observations = columns.firmid.length;
  return {
    label: PANEL_LABEL,
    observations,
    variables: PANEL_VARIABLES.map((v) => {
      const string = v.type.startsWith("str"),
        values = string ? columns[v.name] : Float64Array.from(columns[v.name]);
      let type = v.type,
        format = v.format;
      if (string) {
        let width = 1;
        for (const text of values) if (text.length > width) width = text.length;
        if (type === "str") type = `str${width}`;
        format = `%${Math.max(9, width)}s`;
      }
      return { ...v, type, format, string, values };
    }),
  };
}

const MONTH_NAMES = "jan feb mar apr may jun jul aug sep oct nov dec".split(
  " ",
);
/** A daily date as %td shows it and as export delimited writes it. */
export function dateText(days) {
  let year = 1960,
    left = days;
  for (;;) {
    const length = leap(year) ? 366 : 365;
    if (left < length) break;
    left -= length;
    year++;
  }
  let month = 1;
  while (left >= monthDays(year, month)) left -= monthDays(year, month++);
  return `${two(left + 1)}${MONTH_NAMES[month - 1]}${year}`;
}

const quoted = (text) =>
  /[",\n]/.test(text) || text !== text.trim() || text === ""
    ? text === ""
      ? ""
      : `"${text.replaceAll('"', '""')}"`
    : text;

/**
 * The panel as comma-separated text, one header line and one line per
 * firm-year. Missing numbers and empty strings are empty fields, dates are
 * written as 31dec2005, and a string with a comma or with spaces at either
 * end is quoted so that the spaces survive.
 */
export function panelCsv(panel = buildPanel()) {
  const lines = [panel.variables.map((v) => v.name).join(",")],
    cells = new Array(panel.variables.length);
  for (let row = 0; row < panel.observations; row++) {
    for (const [k, v] of panel.variables.entries()) {
      const value = v.values[row];
      cells[k] = v.string
        ? quoted(value)
        : Number.isNaN(value)
          ? ""
          : v.format === "%td"
            ? dateText(value)
            : String(value);
    }
    lines.push(cells.join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A short fingerprint of the panel's contents (FNV-1a over the CSV text), so
 * a page or a test can tell that it holds the panel the fixtures were
 * recorded from.
 */
export function panelFingerprint(panel = buildPanel()) {
  const text = panelCsv(panel);
  let a = 0x811c9dc5,
    b = 0x01000193;
  for (let k = 0; k < text.length; k++) {
    const code = text.charCodeAt(k);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
