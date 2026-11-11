// The Console's teaching datasets. The three small lesson datasets are kept
// as they are; the larger ones below are simulated here from a fixed seed, so
// every visitor gets the same numbers. None describes real people, firms or
// countries, and each description says what was built into the data.
import { DATASETS, createDataset } from "./datasets.js";

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
    chance: (p) => (uniform() < p ? 1 : 0),
    pick: (list) => list[Math.floor(uniform() * list.length)],
    poisson(mean) {
      const limit = Math.exp(-mean);
      let k = 0,
        p = uniform();
      while (p > limit) {
        k++;
        p *= uniform();
      }
      return k;
    },
  };
}
const round = (x, places = 2) => {
  const scale = 10 ** places;
  return Math.round(x * scale) / scale;
};
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));

function schools() {
  const r = generator(4101),
    values = [];
  for (let school = 1; school <= 24; school++) {
    const treated = school % 2,
      effect = r.normal() * 3,
      classsize = 18 + Math.floor(r.uniform() * 14);
    for (let k = 1; k <= 20; k++) {
      const ses = round(r.normal(), 2),
        female = r.chance(0.5),
        pretest = round(
          clamp(50 + 6 * ses + effect + r.normal() * 9, 5, 98),
          1,
        ),
        attend = Math.round(clamp(88 + 3 * ses + r.normal() * 6, 50, 100)),
        posttest = round(
          clamp(
            52 +
              0.6 * (pretest - 50) +
              4 * treated +
              1.5 * ses +
              0.15 * (attend - 88) -
              0.2 * (classsize - 24) +
              effect +
              r.normal() * 7,
            5,
            100,
          ),
          1,
        );
      values.push([
        school,
        (school - 1) * 20 + k,
        treated,
        female,
        ses,
        classsize,
        attend,
        pretest,
        posttest,
      ]);
    }
  }
  return {
    title: "A tutoring programme assigned to whole schools",
    unit: "One fictional pupil; 20 pupils in each of 24 schools",
    description:
      "A simulated experiment. Twelve of 24 schools were given a tutoring programme, so treatment varies by school, not by pupil. The programme raises the later test score by 4 points, and pupils in the same school share a common shock.",
    columns: [
      ["school", "School"],
      ["pupil", "Pupil ID"],
      ["treated", "Has tutoring programme"],
      ["female", "Female"],
      ["ses", "Family background index (standardised)"],
      ["classsize", "Pupils in the class"],
      ["attend", "Classes attended (%)"],
      ["pretest", "Test score before the programme"],
      ["posttest", "Test score after the programme"],
    ],
    values,
  };
}

function firms() {
  const r = generator(7702),
    sectors = ["Manufacturing", "Services", "Retail"],
    values = [];
  for (let firm = 1; firm <= 60; firm++) {
    const sector = sectors[firm % 3],
      quality = r.normal() * 0.5,
      // A third adopt in 2016, a third in 2019, a third never.
      adopted = firm % 3 === 0 ? 2016 : firm % 3 === 1 ? 2019 : 0,
      exporter = r.chance(0.35 + 0.2 * (quality > 0));
    let size = 3.2 + quality + r.normal() * 0.4;
    for (let year = 2012; year <= 2021; year++) {
      const policy = adopted && year >= adopted ? 1 : 0;
      size += 0.02 + r.normal() * 0.05;
      const employees = Math.max(3, Math.round(Math.exp(size))),
        lsales =
          1.1 +
          0.95 * Math.log(employees) +
          0.6 * quality +
          0.03 * (year - 2012) +
          0.09 * policy +
          0.12 * exporter +
          r.normal() * 0.12,
        sales = round(Math.exp(lsales), 1),
        rd = round(
          Math.max(0, sales * (0.03 + 0.02 * quality) + r.normal()),
          1,
        ),
        profit = round(sales * (0.08 + 0.02 * quality + r.normal() * 0.03), 1);
      values.push([
        firm,
        year,
        sector,
        employees,
        sales,
        rd,
        profit,
        exporter,
        policy,
      ]);
    }
  }
  return {
    title: "Sixty firms followed for ten years",
    unit: "One fictional firm in one year, 2012 to 2021",
    description:
      "A simulated panel. A support policy reaches a third of the firms in 2016 and another third in 2019; the rest never get it. The policy raises sales by about 9 percent. Firms differ in an unobserved quality that also raises sales, which is what fixed effects remove.",
    columns: [
      ["firm", "Firm ID"],
      ["year", "Year"],
      ["sector", "Sector"],
      ["employees", "Employees"],
      ["sales", "Sales (thousands)"],
      ["rd", "Research spending (thousands)"],
      ["profit", "Profit (thousands)"],
      ["exporter", "Sells abroad"],
      ["policy", "Policy in force"],
    ],
    values,
  };
}

function trade() {
  const r = generator(1503),
    names = [
      "Aldor",
      "Brevia",
      "Corvan",
      "Delmar",
      "Estara",
      "Fenmark",
      "Galdor",
      "Halvia",
      "Ilmen",
      "Jorland",
      "Kestria",
      "Lumera",
      "Morvane",
      "Norvik",
      "Ostrel",
      "Pellan",
    ],
    countries = names.map((name) => ({
      name,
      x: r.uniform() * 9000,
      y: r.uniform() * 5000,
      gdp: Math.round(Math.exp(4 + r.normal() * 1.2) * 10) / 10,
      language: Math.floor(r.uniform() * 5),
      bloc: r.chance(0.5),
    })),
    values = [];
  for (const o of countries)
    for (const d of countries) {
      if (o === d) continue;
      const distance = Math.max(
          120,
          Math.round(Math.hypot(o.x - d.x, o.y - d.y)),
        ),
        contig = distance < 1100 ? 1 : 0,
        comlang = o.language === d.language ? 1 : 0,
        fta = o.bloc && d.bloc ? 1 : 0,
        mean = Math.exp(
          6.4 +
            0.85 * Math.log(o.gdp) +
            0.8 * Math.log(d.gdp) -
            1.0 * Math.log(distance) +
            0.45 * contig +
            0.3 * comlang +
            0.4 * fta,
        ),
        // Multiplicative noise whose spread grows with the mean, and some
        // pairs that do not trade at all.
        flow =
          r.uniform() < 0.07
            ? 0
            : Math.round(mean * Math.exp(r.normal() * 0.6 - 0.18));
      values.push([
        o.name,
        d.name,
        flow,
        o.gdp,
        d.gdp,
        distance,
        contig,
        comlang,
        fta,
      ]);
    }
  return {
    title: "Trade between sixteen invented countries",
    unit: "One exporter and importer pair",
    description:
      "A simulated gravity dataset. Trade rises with both economies' size and falls with distance, with an elasticity of minus one; a trade agreement raises it by about 49 percent. Some pairs trade nothing, which is why a log-linear regression loses them and Poisson does not.",
    columns: [
      ["exporter", "Exporting country"],
      ["importer", "Importing country"],
      ["trade", "Exports (millions)"],
      ["gdp_o", "Exporter GDP (billions)"],
      ["gdp_d", "Importer GDP (billions)"],
      ["distance", "Distance (km)"],
      ["contig", "Share a border"],
      ["comlang", "Share a language"],
      ["fta", "Trade agreement in force"],
    ],
    values,
  };
}

function labor() {
  const r = generator(9204),
    regions = ["North", "South", "East", "West"],
    values = [];
  for (let id = 1; id <= 600; id++) {
    const ability = r.normal(),
      female = r.chance(0.5),
      parent = Math.round(clamp(11 + r.normal() * 3, 4, 20)),
      near = r.chance(0.4),
      education = Math.round(
        clamp(
          9.5 + 0.28 * parent + 1.1 * near + 1.2 * ability + r.normal() * 1.6,
          8,
          20,
        ),
      ),
      experience = Math.round(clamp(r.uniform() * 34 + r.normal() * 2, 0, 40)),
      region = r.pick(regions),
      union = r.chance(
        1 /
          (1 + Math.exp(-(-1.1 + 0.03 * experience - 0.06 * (education - 12)))),
      ),
      hours = Math.round(clamp(39 - 3 * female + r.normal() * 6, 10, 65)),
      lwage =
        1.55 +
        0.075 * education +
        0.032 * experience -
        0.0006 * experience ** 2 -
        0.11 * female +
        0.12 * union +
        0.14 * ability +
        (region === "North" ? 0.06 : 0) +
        r.normal() * 0.3,
      wage = round(Math.exp(lwage), 2),
      latent = 0.5 * Math.log(wage) - 0.02 * (hours - 39) + r.normal() * 0.9,
      satisfaction =
        latent < 0.6
          ? 1
          : latent < 1.2
            ? 2
            : latent < 1.8
              ? 3
              : latent < 2.5
                ? 4
                : 5;
    // A few people did not report a wage.
    values.push([
      id,
      r.uniform() < 0.03 ? null : wage,
      education,
      experience,
      female,
      union,
      hours,
      region,
      parent,
      near,
      satisfaction,
    ]);
  }
  return {
    title: "Wages, schooling and an instrument",
    unit: "One fictional worker",
    description:
      "A simulated survey of 600 workers. Schooling raises the log wage by 0.075 a year, but an unobserved ability raises both schooling and wages, so regress overstates the return. Growing up near a college raises schooling and affects wages in no other way. A few wages are missing, and satisfaction is rated from 1 (low) to 5 (high).",
    columns: [
      ["id", "Worker ID"],
      ["wage", "Hourly wage"],
      ["education", "Years of schooling"],
      ["experience", "Years of work experience"],
      ["female", "Female"],
      ["union", "In a union"],
      ["hours", "Weekly hours"],
      ["region", "Region"],
      ["parent_educ", "A parent's years of schooling"],
      ["near_college", "Grew up near a college"],
      ["satisfaction", "Job rating"],
    ],
    values,
  };
}

function macro() {
  const r = generator(3305),
    values = [];
  let growth = 2.4,
    inflation = 2.2,
    unemployment = 5.5,
    rate = 3;
  for (let t = 0; t < 120; t++) {
    const shock = r.normal();
    growth = 0.9 + 0.62 * growth - 0.08 * (rate - 3) + shock * 1.1;
    unemployment = clamp(
      1.1 + 0.8 * unemployment - 0.12 * (growth - 2.4) + r.normal() * 0.25,
      2,
      12,
    );
    inflation = clamp(
      0.5 + 0.75 * inflation - 0.1 * (unemployment - 5.5) + r.normal() * 0.45,
      -1,
      9,
    );
    rate = clamp(
      0.3 +
        0.8 * rate +
        0.25 * (inflation - 2) +
        0.05 * (growth - 2.4) +
        r.normal() * 0.2,
      0,
      12,
    );
    values.push([
      140 + t,
      1995 + Math.floor(t / 4),
      (t % 4) + 1,
      round(growth, 2),
      round(inflation, 2),
      round(unemployment, 2),
      round(rate, 2),
    ]);
  }
  return {
    title: "Thirty years of quarterly figures for an invented economy",
    unit: "One quarter, 1995 to 2024",
    description:
      "A simulated time series. Each series depends on its own last value, growth falls when the interest rate is high, and the rate follows inflation. The variable date counts quarters as Stata does, so format date %tq followed by tsset date declares the data.",
    columns: [
      ["date", "Quarter (Stata quarterly date)"],
      ["year", "Year"],
      ["quarter", "Quarter of the year"],
      ["growth", "GDP growth (% a year)"],
      ["inflation", "Inflation (% a year)"],
      ["unemployment", "Unemployment rate (%)"],
      ["rate", "Policy interest rate (%)"],
    ],
    values,
  };
}

function health() {
  const r = generator(5806),
    values = [];
  for (let id = 1; id <= 360; id++) {
    const clinic = ((id - 1) % 6) + 1,
      treated = r.chance(0.5),
      age = Math.round(clamp(52 + r.normal() * 11, 25, 85)),
      female = r.chance(0.52),
      smoker = r.chance(0.24),
      before = Math.round(
        clamp(148 + 0.35 * (age - 52) + 5 * smoker + r.normal() * 11, 115, 195),
      ),
      after = Math.round(
        clamp(before - 4 - 8 * treated + 3 * smoker + r.normal() * 9, 95, 200),
      ),
      // Visits are a count with more spread than a Poisson allows.
      frailty = Math.exp(r.normal() * 0.55),
      visits = r.poisson(
        Math.exp(0.6 + 0.012 * (age - 52) + 0.3 * smoker - 0.25 * treated) *
          frailty,
      ),
      improved = after <= before - 10 ? 1 : 0,
      dropped = r.uniform() < 0.05;
    values.push([
      id,
      clinic,
      treated,
      age,
      female,
      smoker,
      before,
      dropped ? null : after,
      dropped ? null : improved,
      visits,
    ]);
  }
  return {
    title: "A blood-pressure trial in six clinics",
    unit: "One fictional patient",
    description:
      "A simulated randomised trial with 360 patients. The drug lowers systolic pressure by 8 mmHg beyond the fall seen without it. About one patient in twenty left before the second reading. Visits are a count with more spread than a Poisson model allows.",
    columns: [
      ["id", "Patient ID"],
      ["clinic", "Clinic"],
      ["treated", "Given the drug"],
      ["age", "Age"],
      ["female", "Female"],
      ["smoker", "Smokes"],
      ["bp_before", "Systolic pressure at entry (mmHg)"],
      ["bp_after", "Systolic pressure at 12 weeks (mmHg)"],
      ["improved", "Pressure fell by 10 mmHg or more"],
      ["visits", "Clinic visits in the following year"],
    ],
    values,
  };
}

const BUILT = { schools, firms, trade, labor, macro, health };

function rowsOf(data) {
  return {
    columns: data.columns.map(([name, label], j) => ({
      name,
      label,
      type: data.values.some((row) => typeof row[j] === "string")
        ? "string"
        : "numeric",
    })),
    rows: data.values.map((row) =>
      Object.fromEntries(data.columns.map(([name], j) => [name, row[j]])),
    ),
  };
}

/** Every dataset sysuse can load in the Console, lesson datasets first. */
export const LIBRARY = {};
for (const [id, data] of Object.entries(DATASETS))
  LIBRARY[id] = {
    id,
    file: data.file ?? `${id}.csv`,
    title: data.title,
    unit: data.unit,
    description: data.description,
    data: createDataset(id),
  };
for (const [id, build] of Object.entries(BUILT)) {
  const data = build();
  LIBRARY[id] = {
    id,
    file: `${id}.csv`,
    title: data.title,
    unit: data.unit,
    description: data.description,
    data: rowsOf(data),
  };
}
