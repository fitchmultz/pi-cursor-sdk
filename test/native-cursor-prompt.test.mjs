import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { concurrentFixture, retainNativeEvidence, setupNativeCursorHarness, state } from "./helpers/native-cursor-harness.mjs";

setupNativeCursorHarness();

test("native user origin survives hidden notices, budgeted bootstrap, incremental images and custom-only continuation", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ root, create }) => {
    process.env.PI_CURSOR_LOCAL_RESUME = "1";
    const notice = join(root, "native-notice.mjs");
    await writeFile(notice, `export default function(pi) {
      let continueOnce;
      pi.on("before_agent_start", event => {
        continueOnce = ["BUDGETED_NATIVE_REQUEST", "RESET_ONLY_NATIVE_REQUEST"].includes(event.prompt) ? event.prompt : undefined;
        return { message: { customType: "native-notice", content: "HIDDEN_NATIVE_NOTICE", display: false } };
      });
      pi.on("agent_before_settle", (event, ctx) => {
        if (!continueOnce) return;
        const edits = continueOnce === "RESET_ONLY_NATIVE_REQUEST" ? [{ type: "context_edit",
          targetId: ctx.sessionManager.getBranch().find(e => e.type === "message" && e.message.role === "user").id,
          replacement: { content: "Edited historical native input" } }] : [];
        continueOnce = undefined;
        return { entries: [...event.entries, ...edits, { type: "custom_message", customType: "native-continuation",
          content: "CUSTOM_ONLY_CONTINUATION", display: false }], continue: true };
      });
    }`);
    const owner = await create("native-input", { afterExtensions: [notice] });
    const config = owner.session.modelRuntime.getProvider("cursor");
    const boundaries = [];
    owner.session.extensionRunner.getModelRegistry().registerProvider({ ...config, streamSimple: (model, context, options) => {
      boundaries.push({ providerRoles: context.messages.map(m => m.role),
        nativeRoles: owner.manager.buildSessionProjection().messages.map(m => m.role),
        customTypes: context.messages.map(m => m.customType ?? null) });
      return config.streamSimple(model, context, options);
    } });
    await owner.session.setModel({ ...owner.session.model, contextWindow: 4096, maxTokens: 1024 });
    const image = { type: "image", mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
    const latestImage = { ...image, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AFr/AH8E6QHZ96OSLAAAAABJRU5ErkJggg==" };
    const start = state.sends.length;
    await owner.session.prompt(`OLD_NATIVE_REQUEST ${"old history ".repeat(3000)}`, { images: [image] });
    if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) {
      await mkdir(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, { recursive: true });
      await writeFile(join(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, "native-input-first-send.json"),
        JSON.stringify({ send: state.sends.at(-1), boundary: boundaries.at(-1),
          userImages: owner.manager.buildSessionProjection().messages.findLast(m => m.role === "user").content.filter(b => b.type === "image") }, null, 2));
    }
    assert.deepEqual(state.sends.at(-1).message.images, [{ data: image.data, mimeType: image.mimeType }],
      "actual user image must survive the host's trailing custom→user conversion");
    assert.deepEqual(boundaries[0].nativeRoles, ["system", "user", "custom"]);
    assert.deepEqual(boundaries[0].providerRoles, ["system", "user", "user"], "installed Pi conversion erases custom origin before provider dispatch");
    assert.ok(boundaries[0].customTypes.every(value => value === null));
    const originalAgent = state.sends.at(-1).agentId;
    await owner.session.prompt("LATEST_NATIVE_REQUEST", { images: [latestImage] });
    let send = state.sends.at(-1);
    assert.equal(send.agentId, originalAgent, "hidden notices must not force a new ordinary session agent");
    assert.match(send.message.text, /User: LATEST_NATIVE_REQUEST/);
    assert.match(send.message.text, /Background context: HIDDEN_NATIVE_NOTICE/);
    assert.ok(send.message.text.indexOf("User: LATEST_NATIVE_REQUEST") < send.message.text.indexOf("Background context: HIDDEN_NATIVE_NOTICE"),
      "actual native request precedes its pending notice in the SDK payload");
    assert.doesNotMatch(send.message.text, /OLD_NATIVE_REQUEST/);
    assert.deepEqual(send.message.images, [{ data: latestImage.data, mimeType: latestImage.mimeType }]);
    await owner.session.prompt("TEXT_ONLY_NATIVE_REQUEST");
    assert.equal(state.sends.at(-1).message.images, undefined, "a new image-free native request cannot reuse an old attachment");
    assert.equal(state.sends.at(-1).agentId, originalAgent);
    await owner.session.reload();
    await owner.session.setModel({ ...owner.session.model, contextWindow: 4096, maxTokens: 1024 });
    await owner.session.prompt("BUDGETED_NATIVE_REQUEST", { images: [latestImage] });
    const sends = state.sends.slice(start);
    const bootstrap = sends.at(-2);
    assert.match(bootstrap.message.text, /Cursor SDK tool boundary:/);
    assert.match(bootstrap.message.text, /Earlier transcript omitted/);
    assert.match(bootstrap.message.text, /User: BUDGETED_NATIVE_REQUEST/);
    assert.match(bootstrap.message.text, /Background context: HIDDEN_NATIVE_NOTICE/);
    assert.deepEqual(bootstrap.message.images, [{ data: latestImage.data, mimeType: latestImage.mimeType }]);
    const continuation = sends.at(-1);
    assert.equal(continuation.agentId, bootstrap.agentId);
    assert.match(continuation.message.text, /Background context: CUSTOM_ONLY_CONTINUATION/);
    assert.doesNotMatch(continuation.message.text, /BUDGETED_NATIVE_REQUEST|HIDDEN_NATIVE_NOTICE/);
    assert.equal(continuation.message.images, undefined, "no native user was submitted for this continuation");
    await owner.session.prompt("RESET_ONLY_NATIVE_REQUEST", { images: [latestImage] });
    await retainNativeEvidence("native-input", owner.manager, owner.cwd);
    if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) await writeFile(join(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, "native-input-payloads.json"), JSON.stringify({ sends: state.sends.slice(start), boundaries }, null, 2));
    const resetContinuation = state.sends.at(-1);
    assert.notEqual(resetContinuation.agentId, state.sends.at(-2).agentId, "the native context edit requires a fresh bootstrap");
    assert.match(resetContinuation.message.text, /Background context: CUSTOM_ONLY_CONTINUATION/);
    assert.match(resetContinuation.message.text, /No new user request was submitted; earlier user requests are history/);
    assert.doesNotMatch(resetContinuation.message.text, /Answer the latest user request above/);
    assert.equal(resetContinuation.message.images, undefined, "even a full bootstrap without new native input cannot resend an old image");
    assert.equal(owner.session.messages.at(-1).stopReason, "stop", owner.session.messages.at(-1).errorMessage);
    const persisted = (await readFile(owner.manager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(persisted.some(e => e.type === "custom_message" && e.customType === "native-notice" && e.display === false));
    const resume = persisted.findLast(e => e.type === "custom" && e.customType === "cursor-sdk-agent-resume");
    assert.equal(resume.data.agentId, resetContinuation.agentId);
    assert.equal(resume.data.scopeKey, owner.manager.getSessionFile());
    const starts = persisted.filter(e => e.type === "custom" && e.customType === "pi-cursor-sdk:usage-v1" && e.data.kind === "start");
    assert.equal(starts.length, state.sends.length - start, "each real send retains its own one-shot native accounting origin");
    assert.ok(starts.every(e => e.data.origin.sessionId === owner.manager.getSessionId()));
    const runs = persisted.filter(e => e.type === "custom" && e.customType === "pi-cursor-sdk:usage-v1" && e.data.kind === "run");
    assert.equal(new Set(runs.map(e => e.data.runId)).size, starts.length, "each SDK run retains a distinct durable fact");
    assert.ok(runs.every(run => starts.some(origin => origin.data.turnId === run.data.turnId && origin.data.origin.anchorId === run.data.origin.anchorId)));
    assert.deepEqual(runs.map(run => run.data.runId), state.sends.slice(start).map(send => send.runId), "durable facts join the actual SDK sends");
    for (const send of state.sends.slice(start)) {
      assert.equal(send.message.text.match(/Do not comment on GitHub issues or PRs unless the user asked\./g)?.length, 1,
        "GitHub soft guidance survives bootstrap, incremental and custom-only native input selection");
    }
  });
});

for (const transform of ["equivalent conversion", "changed payload", "changed order"]) {
  test(`native source-role evidence handles ${transform}`, { timeout: 60000 }, async (t) => {
    await concurrentFixture(t, async ({ root, create }) => {
      const extension = join(root, "origin-transform.mjs");
      await writeFile(extension, `import { convertToLlm } from "@earendil-works/pi-coding-agent";
        export default function(pi) {
          pi.on("before_agent_start", () => ({ message: {
            customType: "same-text-notice", content: ${JSON.stringify(transform === "changed order" ? "ORDERED_NOTICE" : "IDENTICAL_USER_AND_NOTICE")}, display: false } }));
          pi.on("context_with_system", event => ({ messages: ${
            transform === "equivalent conversion" ? "convertToLlm(event.messages)"
              : transform === "changed order" ? "[...event.messages.slice(0, -2), event.messages.at(-1), event.messages.at(-2)]"
              : 'event.messages.map(m => m.role === "custom" ? { ...m, content: "TRANSFORMED_NOTICE" } : m)'
          } }));
        }`);
      const owner = await create(`origin-${transform}`, { afterExtensions: [extension] });
      const start = state.sends.length;
      await owner.session.prompt("IDENTICAL_USER_AND_NOTICE");
      const firstAgent = state.sends.at(-1).agentId;
      await owner.session.prompt("IDENTICAL_USER_AND_NOTICE");
      const send = state.sends.at(-1);
      assert.equal(owner.session.messages.at(-1).stopReason, "stop");
      assert.match(send.message.text, /Do not comment on GitHub issues or PRs unless the user asked\./);
      if (transform === "equivalent conversion") {
        assert.equal(send.agentId, firstAgent, "public conversion does not change canonical native source identity");
        assert.equal(send.message.text.match(/User: IDENTICAL_USER_AND_NOTICE/g)?.length, 1);
        assert.equal(send.message.text.match(/Background context: IDENTICAL_USER_AND_NOTICE/g)?.length, 1,
          "identical content cannot turn an injected notice into a native user submission");
      } else {
        assert.notEqual(send.agentId, firstAgent, "unmatched transformed requests retain conservative bootstrap planning");
        assert.match(send.message.text, transform === "changed order" ? /User: ORDERED_NOTICE/ : /User: TRANSFORMED_NOTICE/);
        assert.doesNotMatch(send.message.text, /Background context:/, "stale canonical role indexes must not be applied");
      }
      const label = `origin-${transform.replaceAll(" ", "-")}`;
      await retainNativeEvidence(label, owner.manager, owner.cwd);
      if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) await writeFile(join(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, `${label}-payloads.json`),
        JSON.stringify(state.sends.slice(start), null, 2));
    });
  });
}

test("offline native Cloud fresh prompts preserve genuine input and notices without historical requests or images", { timeout: 60000 }, async (t) => {
  await concurrentFixture(t, async ({ root, create }) => {
    const notice = join(root, "cloud-native-notice.mjs");
    await writeFile(notice, `export default function(pi) {
      let continueOnce = false;
      pi.on("before_agent_start", event => {
        continueOnce = event.prompt === "CURRENT_CLOUD_REQUEST";
        return { message: { customType: "cloud-native-notice", content: "CLOUD_BACKGROUND_NOTICE", display: false } };
      });
      pi.on("agent_before_settle", event => {
        if (!continueOnce) return;
        continueOnce = false;
        return { entries: [...event.entries, { type: "custom_message", customType: "cloud-native-continuation",
          content: "CLOUD_CUSTOM_ONLY_CONTINUATION", display: false }], continue: true };
      });
    }`);
    const owner = await create("cloud-native-input", { afterExtensions: [notice], flags: {
      "cursor-runtime": "cloud", "cursor-cloud-ack": true, "cursor-cloud-context": "fresh", "cursor-cloud-allow-local-state": true,
    } });
    const image = { type: "image", mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
    const latestImage = { ...image, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AFr/AH8E6QHZ96OSLAAAAABJRU5ErkJggg==" };
    const start = state.sends.length;
    await owner.session.prompt("OLD_CLOUD_REQUEST", { images: [image] });
    assert.deepEqual(state.sends.at(-1).message.images, [{ data: image.data, mimeType: image.mimeType }]);
    await owner.session.prompt("TEXT_ONLY_CLOUD_REQUEST");
    assert.equal(state.sends.at(-1).message.images, undefined);
    assert.doesNotMatch(state.sends.at(-1).message.text, /OLD_CLOUD_REQUEST/);
    await owner.session.prompt("CURRENT_CLOUD_REQUEST", { images: [latestImage] });
    const current = state.sends.at(-2);
    assert.match(current.message.text, /User: CURRENT_CLOUD_REQUEST/);
    assert.match(current.message.text, /Background context: CLOUD_BACKGROUND_NOTICE/);
    assert.deepEqual(current.message.images, [{ data: latestImage.data, mimeType: latestImage.mimeType }]);
    const continuation = state.sends.at(-1);
    assert.match(continuation.message.text, /Background context: CLOUD_CUSTOM_ONLY_CONTINUATION/);
    assert.match(continuation.message.text, /No new user request was submitted/);
    assert.doesNotMatch(continuation.message.text, /CURRENT_CLOUD_REQUEST|TEXT_ONLY_CLOUD_REQUEST|OLD_CLOUD_REQUEST/);
    assert.equal(continuation.message.images, undefined);
    assert.equal(owner.session.messages.at(-1).stopReason, "stop", owner.session.messages.at(-1).errorMessage);
    assert.ok(state.sends.slice(start).every(send => state.created.find(agent => agent.agentId === send.agentId).options.cloud));
    assert.ok(state.sends.slice(start).every(send => send.message.text.includes("Do not comment on GitHub issues or PRs unless the user asked.")),
      "offline Cloud fresh/custom-only payloads preserve the same GitHub soft guidance");
    await retainNativeEvidence("cloud-native-input", owner.manager, owner.cwd);
    if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) await writeFile(join(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, "cloud-native-input-payloads.json"), JSON.stringify(state.sends.slice(start), null, 2));
  });
});
