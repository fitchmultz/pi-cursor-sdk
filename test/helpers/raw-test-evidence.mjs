import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeRawTestEvidence(directory, filename, data) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), data);
}
