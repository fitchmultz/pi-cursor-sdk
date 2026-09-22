import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { isSafePosixStoreUsername, recommendedStoreRoot } from "../src/cursor-config.js";
import { splitStoreRootSegments, validateStoreRootPath } from "../src/cursor-store-root-path.js";

describe("cursor-store-root-path", () => {
	it("splits absolute paths into usable segments", () => {
		expect(splitStoreRootSegments("/var/tmp/alice/pi-cursor-sdk")).toEqual(["var", "tmp", "alice", "pi-cursor-sdk"]);
		expect(splitStoreRootSegments("C:\\Users\\alice\\pi-cursor-sdk")).toEqual(["Users", "alice", "pi-cursor-sdk"]);
	});

	it("rejects relative, root, and unsafe segment paths", () => {
		expect(validateStoreRootPath("relative-store")).toBe("relative");
		expect(validateStoreRootPath("/")).toBe("filesystem-root");
		expect(validateStoreRootPath("/var/tmp/foo/../bar")).toBe("unsafe-segment");
		expect(validateStoreRootPath("/var/tmp/alice/pi-cursor-sdk")).toBeUndefined();
	});
});

describe("recommendedStoreRoot", () => {
	it("computes conventional explicit paths from mocked identity without touching the filesystem", () => {
		expect(recommendedStoreRoot("linux", {}, { username: "alice", uid: 1000 })).toBe(
			join("/var/tmp", "alice", "pi-cursor-sdk"),
		);
		expect(recommendedStoreRoot("linux", {}, { username: "../etc", uid: 42 })).toBe(
			join("/var/tmp", "uid-42", "pi-cursor-sdk"),
		);
		expect(recommendedStoreRoot("linux", { USER: "../etc", LOGNAME: "x", USERNAME: "y" })).toBe(
			recommendedStoreRoot("linux", {}),
		);
		expect(recommendedStoreRoot("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toBe(
			win32.join("C:\\Users\\me\\AppData\\Local", "pi-cursor-sdk"),
		);
		expect(isSafePosixStoreUsername("alice")).toBe(true);
		expect(isSafePosixStoreUsername("../etc")).toBe(false);
	});
});
