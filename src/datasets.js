// Synthetic teaching data. No student records or observed study participants.
// Deliberately small so a learner can inspect every observation.
export const DATASETS = {
  study: {
    id: "study",
    file: "study.csv",
    title: "Study time and exam scores",
    unit: "One fictional student",
    description:
      "24 fictional students. Study hours, attendance and exam scores are illustrative; these data cannot establish a causal effect of studying.",
    columns: [
      ["id", "Student ID"],
      ["hours", "Weekly study hours"],
      ["attendance", "Classes attended (%)"],
      ["score", "Exam score (0–100)"],
      ["group", "Tutorial group"],
    ],
    values: [
      [1, 2, 65, 48, "A"],
      [2, 3, 80, 59, "B"],
      [3, 4, 75, 57, "A"],
      [4, 5, 90, 72, "B"],
      [5, 6, 85, 70, "A"],
      [6, 7, 95, 82, "B"],
      [7, 8, 90, 79, "A"],
      [8, 9, 100, 91, "B"],
      [9, 2, 80, 56, "A"],
      [10, 3, 70, 50, "B"],
      [11, 4, 90, 69, "A"],
      [12, 5, 75, 61, "B"],
      [13, 6, 95, 80, "A"],
      [14, 7, 80, 71, "B"],
      [15, 8, 100, 90, "A"],
      [16, 9, 85, 81, "B"],
      [17, 1, 60, 43, "A"],
      [18, 10, 95, 94, "B"],
      [19, null, 80, 66, "A"],
      [20, 4, null, 63, "B"],
      [21, 6, 85, null, "A"],
      [22, 3, 85, 60, "B"],
      [23, 7, 90, 78, "A"],
      [24, 5, 80, 67, "B"],
    ],
  },
  wages: {
    id: "wages",
    file: "wages.csv",
    title: "Education and hourly wages",
    unit: "One fictional worker",
    description:
      "30 fictional workers. Wages vary with education and experience in this constructed example. The sample is not representative of a population.",
    columns: [
      ["id", "Worker ID"],
      ["education", "Years of education"],
      ["experience", "Years of experience"],
      ["wage", "Hourly wage (dollars)"],
      ["sector", "Sector"],
    ],
    values: Array.from({ length: 30 }, (_, i) => {
      const education = 10 + ((i * 7) % 11),
        experience = 1 + ((i * 13) % 29);
      return [
        i + 1,
        education,
        experience,
        Math.round(
          (4 +
            0.8 * education +
            0.38 * experience +
            (((i * 17) % 13) - 6) * 0.8) *
            100,
        ) / 100,
        i % 2 ? "Services" : "Industry",
      ];
    }),
  },
  clinic: {
    id: "clinic",
    file: "clinic.csv",
    title: "Clinic data with quality issues",
    unit: "One recorded visit",
    description:
      "12 synthetic visit records with a duplicate identifier, missing values and a deliberately implausible age. Practice checking data before analysis.",
    columns: [
      ["id", "Visit ID"],
      ["age", "Age (years)"],
      ["wait", "Waiting time (minutes)"],
      ["clinic", "Clinic code"],
    ],
    values: [
      [1, 29, 12, "North"],
      [2, 42, 18, "South"],
      [3, 36, null, "North"],
      [4, 51, 25, "South"],
      [5, 34, 9, "North"],
      [5, 34, 9, "North"],
      [6, 210, 31, "South"],
      [7, null, 14, "North"],
      [8, 47, 22, "South"],
      [9, 22, 8, "North"],
      [10, 38, 17, "South"],
      [11, 65, 28, "North"],
    ],
  },
};
export function createDataset(id = "study") {
  const data = DATASETS[id];
  if (!data) throw new Error("Unknown practice dataset.");
  return {
    id,
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
export function toCSV(dataset) {
  const cell = (v) =>
    v === null || v === undefined
      ? ""
      : /[",\n\r]/.test(String(v))
        ? '"' + String(v).replaceAll('"', '""') + '"'
        : String(v);
  return (
    [
      dataset.columns.map((c) => c.name).join(","),
      ...dataset.rows.map((r) =>
        dataset.columns.map((c) => cell(r[c.name])).join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}
