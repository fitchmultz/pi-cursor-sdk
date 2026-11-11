import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function hash(path, algorithm = "sha256", encoding = "hex") {
	return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}
