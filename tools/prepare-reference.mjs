import fs from "node:fs/promises";
import { DATASETS, createDataset, toCSV } from "../src/datasets.js";
await fs.mkdir("tests/fixtures", { recursive: true });
for (const data of Object.values(DATASETS))
  await fs.writeFile(
    `tests/fixtures/${data.file}`,
    toCSV(createDataset(data.id)),
  );
