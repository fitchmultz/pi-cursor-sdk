import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
	checkpointCloudSmokeShutdown,
	createCloudSmokeShutdownController,
	installCloudSmokeSignalHandlers,
} from "../../scripts/lib/cloud-smoke-shutdown.mjs";

const [evidencePath, releasePath, mode] = process.argv.slice(2);
const temporary = `${evidencePath}.tmp`;
const shutdown = createCloudSmokeShutdownController(async () => {});
installCloudSmokeSignalHandlers(shutdown, process, () => { process.exitCode = 1; });
writeFileSync(temporary, "staged\n");

function waitForRelease() {
	const deadline = Date.now() + 5_000;
	while (!existsSync(releasePath) && Date.now() < deadline) {}
	if (!existsSync(releasePath)) throw new Error("release file was not created");
}

try {
	if (mode === "postcommit") {
		await checkpointCloudSmokeShutdown(shutdown);
		renameSync(temporary, evidencePath);
		process.stdout.write("COMMITTED\n");
	} else {
		// Production finalization follows async work, not a cold event-loop turn.
		await new Promise((resolve) => setTimeout(resolve, 1));
		process.stdout.write("FINALIZING\n");
	}
	waitForRelease();
	await checkpointCloudSmokeShutdown(shutdown);
	if (mode !== "postcommit") renameSync(temporary, evidencePath);
	process.stdout.write("UNEXPECTED_SUCCESS\n");
	process.exitCode = 2;
} catch (error) {
	rmSync(temporary, { force: true });
	process.stdout.write(`INTERRUPTED ${error instanceof Error ? error.message : String(error)}\n`);
}
