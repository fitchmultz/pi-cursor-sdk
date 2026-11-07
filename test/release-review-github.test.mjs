import assert from "node:assert/strict";
import test from "node:test";
import { collectReleaseContext, latestPublishedRelease } from "../scripts/lib/release-review-github.mjs";

// These response shapes, cursors, and IDs come from the real merged PR #382 and issue #380.
const repository = "fitchmultz/pi-cursor-sdk";
const merge = "423b53bbe5546743bbbaabf853295da56c0b9dea";
const threadCursor = "Y3Vyc29yOnYyOpK0MjAyNi0xMC0yM1QyMzoxNjo0M1rOr80uUQ==";
const pull = {
	number: 382, title: "fix: keep patched SDK Zod peer outside bridge bundle",
	body: "Fixes #380", html_url: `https://github.com/${repository}/pull/382`,
	merged_at: "2026-10-24T02:34:10Z", merge_commit_sha: merge,
};
const rootComment = {
	id: 4365004402, user: { login: "pi-durable[bot]" }, body: "Root zod gets packed into the bundle",
	html_url: `${pull.html_url}#discussion_r4365004402`, created_at: "2026-10-23T23:16:43Z",
	path: "package-lock.json", line: null, original_line: 3832,
	in_reply_to_id: null, pull_request_review_id: 5635429592,
};
const secondRootComment = {
	id: 4365006388, user: { login: "pi-durable[bot]" }, body: "The package-metadata contract now fails.",
	html_url: `${pull.html_url}#discussion_r4365006388`, created_at: "2026-10-23T23:17:09Z",
	path: "package.json", line: null, original_line: 171,
	in_reply_to_id: null, pull_request_review_id: 5635432293,
};
const reply = {
	id: 4365647739, user: { login: "fitchmultz" }, body: "Fixed in a0fee4f.",
	html_url: `${pull.html_url}#discussion_r4365647739`, created_at: "2026-10-24T02:14:04Z",
	path: "package-lock.json", line: null, original_line: 3832,
	in_reply_to_id: 4365004402, pull_request_review_id: 5636378420,
};
const secondReply = {
	id: 4365647881, user: { login: "fitchmultz" }, body: "Fixed in a0fee4f.",
	html_url: `${pull.html_url}#discussion_r4365647881`, created_at: "2026-10-24T02:14:06Z",
	path: "package.json", line: null, original_line: 171,
	in_reply_to_id: 4365006388, pull_request_review_id: 5636378512,
};

function connection(name, nodes, hasNextPage, endCursor) {
	return { data: { repository: { pullRequest: {
		[name]: { nodes, pageInfo: { hasNextPage, endCursor } },
	} } } };
}

test("release context follows GitHub pagination and retains review and closing-issue relationships", async (t) => {
	const seen = [];
	t.mock.method(globalThis, "fetch", async (address, options = {}) => {
		const url = new URL(address);
		assert.equal(url.origin, "https://api.github.com");
		assert.equal(options.headers.Authorization, "Bearer captured-contract-token");
		seen.push(`${options.method ?? "GET"} ${url.pathname}${url.search}`);
		if (url.pathname === "/graphql") {
			const { query, variables } = JSON.parse(options.body);
			assert.deepEqual({ owner: variables.owner, name: variables.name, number: variables.number },
				{ owner: "fitchmultz", name: "pi-cursor-sdk", number: 382 });
			if (query.includes("closingIssuesReferences")) {
				assert.equal(variables.cursor, null);
				return Response.json(connection("closingIssuesReferences", [{
					number: 380, title: "Repair the SDK's unpatched Zod v4 peer through supported packaging",
					body: "Put the Cursor SDK's actual Zod v4/v4-mini imports through supported packaging.",
					state: "CLOSED", url: `https://github.com/${repository}/issues/380`,
					closedAt: "2026-10-24T02:34:11Z", repository: { nameWithOwner: repository },
				}], false, "MQ"));
			}
			assert.match(query, /reviewThreads/);
			if (variables.cursor === null) {
				return Response.json(connection("reviewThreads", [{
					id: "PRRT_kwDOSUUmq86vzS5R", isResolved: true, isOutdated: true,
					path: "package-lock.json", line: null, comments: { nodes: [{ databaseId: 4365004402 }] },
				}], true, threadCursor));
			}
			assert.equal(variables.cursor, threadCursor);
			return Response.json(connection("reviewThreads", [{
				id: "PRRT_kwDOSUUmq86vzTM4", isResolved: true, isOutdated: true,
				path: "package.json", line: null, comments: { nodes: [{ databaseId: 4365006388 }] },
			}], false, "Y3Vyc29yOnYyOpK0MjAyNi0xMC0yM1QyMzoxNzowOVrOr80zOA=="));
		}
		if (url.pathname === `/repos/${repository}/commits/${merge}/pulls`) return Response.json([pull]);
		if (url.pathname === `/repos/${repository}/issues/382/comments`) return Response.json([{
			id: 6376678713, user: { login: "fitchmultz" }, body: "Tracked in #380.",
			html_url: `${pull.html_url}#issuecomment-6376678713`, created_at: "2026-10-23T23:19:26Z",
		}]);
		if (url.pathname === `/repos/${repository}/pulls/382/reviews`) return Response.json([{
			id: 5635429592, user: { login: "pi-durable[bot]" }, body: "", state: "COMMENTED",
			commit_id: "156c029df0056077692e9f985b60a5ecac67ff69",
			html_url: `${pull.html_url}#pullrequestreview-5635429592`, submitted_at: "2026-10-23T23:16:43Z",
		}]);
		if (url.pathname === `/repos/${repository}/pulls/382/comments`) {
			return Response.json([rootComment], { headers: {
				Link: '<https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=4>; rel="last"',
			} });
		}
		if (url.pathname === "/repositories/1229268651/pulls/382/comments") {
			const page = url.searchParams.get("page");
			if (page === "2") return Response.json([secondRootComment], { headers: {
				Link: '<https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=1>; rel="prev", <https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=3>; rel="next", <https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=4>; rel="last", <https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=1>; rel="first"',
			} });
			if (page === "3") return Response.json([reply], { headers: {
				Link: '<https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=2>; rel="prev", <https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=4>; rel="next", <https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=4>; rel="last", <https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=1>; rel="first"',
			} });
			assert.equal(page, "4");
			return Response.json([secondReply], { headers: {
				Link: '<https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=3>; rel="prev", <https://api.github.com/repositories/1229268651/pulls/382/comments?per_page=1&page=1>; rel="first"',
			} });
		}
		if (url.pathname === `/repos/${repository}/issues/380/comments`) return Response.json([{
			id: 6378623039, user: { login: "fitchmultz" }, body: "Delivered through existing #382.",
			html_url: `https://github.com/${repository}/issues/380#issuecomment-6378623039`,
			created_at: "2026-10-24T02:14:09Z",
		}]);
		assert.fail(`Unexpected GitHub request: ${url}`);
	});

	const result = await collectReleaseContext({ repository, commits: [merge], token: "captured-contract-token" });
	assert.equal(result.pulls.length, 1);
	assert.equal(result.pulls[0].mergeCommit, merge);
	assert.equal(result.pulls[0].reviews[0].commit, "156c029df0056077692e9f985b60a5ecac67ff69");
	assert.deepEqual(result.pulls[0].reviewComments.map((item) => [item.id, item.inReplyToId]),
		[[4365004402, null], [4365006388, null], [4365647739, 4365004402], [4365647881, 4365006388]]);
	assert.deepEqual(result.pulls[0].reviewThreads.map((thread) => [thread.rootCommentId, thread.isResolved]),
		[[4365004402, true], [4365006388, true]]);
	assert.deepEqual(result.pulls[0].closingIssues, [`https://github.com/${repository}/issues/380`]);
	assert.equal(result.issues[0].comments[0].id, 6378623039);
	assert.ok(seen.some((request) => request.includes("/repositories/1229268651/pulls/382/comments?per_page=1&page=2")));
	assert.equal(seen.filter((request) => request === "POST /graphql").length, 3);
});

test("latest published release propagates a real GitHub service failure", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("Bad Gateway", { status: 502 }));
	await assert.rejects(latestPublishedRelease(repository, "captured-contract-token"), /GitHub context request failed: 502 \/repos\/fitchmultz\/pi-cursor-sdk\/releases\/latest/);
});

test("release context follows multiple closing-issue pages from a merged PR", async (t) => {
	const source = "55131c218fcf30a25cc6c60e236aea59003a601c";
	t.mock.method(globalThis, "fetch", async (address, options = {}) => {
		const url = new URL(address);
		if (url.pathname === "/graphql") {
			const { query, variables } = JSON.parse(options.body);
			assert.equal(variables.number, 367);
			if (query.includes("reviewThreads")) return Response.json(connection("reviewThreads", [], false, null));
			assert.match(query, /closingIssuesReferences/);
			const number = variables.cursor === null ? 364 : 365;
			if (number === 365) assert.equal(variables.cursor, "MQ");
			return Response.json(connection("closingIssuesReferences", [{
				number, title: `Issue ${number}`, body: "", state: "CLOSED",
				url: `https://github.com/${repository}/issues/${number}`,
				closedAt: "2026-10-20T03:34:59Z", repository: { nameWithOwner: repository },
			}], number === 364, number === 364 ? "MQ" : "Mg"));
		}
		if (url.pathname.endsWith(`/commits/${source}/pulls`)) return Response.json([{
			number: 367, title: "fix(tui): filter background SDK logs and future Claude hook notices",
			body: "Fixes #364\nFixes #365", html_url: `https://github.com/${repository}/pull/367`,
			merged_at: "2026-10-20T03:34:58Z", merge_commit_sha: source,
		}]);
		if (/\/(?:issues\/(?:364|365|367)\/comments|pulls\/367\/(?:comments|reviews))$/.test(url.pathname)) {
			return Response.json([]);
		}
		assert.fail(`Unexpected GitHub request: ${url}`);
	});
	const result = await collectReleaseContext({ repository, commits: [source], token: "captured-contract-token" });
	assert.deepEqual(result.issues.map((issue) => issue.number), [364, 365]);
	assert.deepEqual(result.pulls[0].closingIssues, [
		`https://github.com/${repository}/issues/364`, `https://github.com/${repository}/issues/365`,
	]);
});

test("prospective release context includes the open PR only for the exact reviewed head", async (t) => {
	// This open PR's identity and API shape were observed on GitHub.
	const head = "12564f0e21ea08eaa1937dff7a1f0677a9d7424e";
	t.mock.method(globalThis, "fetch", async (address, options = {}) => {
		const url = new URL(address);
		if (url.pathname === `/repos/${repository}/pulls/389`) return Response.json({
			number: 389, state: "open", merged_at: null, merge_commit_sha: "b490a768b298d3f270cccac9897054718b5af02a",
			title: "Load @cursor/sdk lazily and fill the model-list cache in RPC mode",
			body: "Pi no longer evaluates `@cursor/sdk` at extension load.",
			html_url: `https://github.com/${repository}/pull/389`,
			head: { sha: head }, base: { ref: "main", repo: { full_name: repository } },
		});
		if (url.pathname === "/graphql") {
			const { query, variables } = JSON.parse(options.body);
			assert.equal(variables.number, 389);
			return Response.json(connection(query.includes("reviewThreads") ? "reviewThreads" : "closingIssuesReferences", [], false, null));
		}
		if (/\/(?:issues\/389\/comments|pulls\/389\/(?:comments|reviews))$/.test(url.pathname)) return Response.json([]);
		assert.fail(`Unexpected GitHub request: ${url}`);
	});
	const options = { repository, commits: [], token: "captured-contract-token", prospective: { number: 389, head } };
	const result = await collectReleaseContext(options);
	assert.equal(result.pulls.length, 1);
	assert.equal(result.pulls[0].head, head);
	assert.equal(result.pulls[0].state, "open");
	assert.equal(result.pulls[0].mergeCommit, null);
	assert.match(result.pulls[0].body, /extension load/);
	await assert.rejects(collectReleaseContext({ ...options, prospective: { number: 389, head: merge } }),
		/Prospective release PR head differs from the reviewed source/);
});
