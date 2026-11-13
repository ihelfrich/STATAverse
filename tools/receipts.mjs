// Where checks write their screenshots and receipts.
//
// By default they go to .build/receipts, which git ignores, so `npm run check`
// leaves the tree as it found it. To refresh the copies kept in the
// repository, run the check with STATAVERSE_RECEIPTS=docs/verification.
import fs from "node:fs";
import path from "node:path";

export const receiptDir = () =>
  process.env.STATAVERSE_RECEIPTS || ".build/receipts";

export const receiptPath = (name) => {
  const file = path.join(receiptDir(), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
};

export const screenshotPath = (name) =>
  receiptPath(path.join("screenshots", name));
