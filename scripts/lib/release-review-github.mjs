import assert from "node:assert/strict";

const api = "https://api.github.com";

function client(token) {
	assert.ok(token, "GH_TOKEN is required to collect release PR and issue context");
	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	async function request(url, options = {}) {
		const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
		assert.ok(response.ok, `GitHub context request failed: ${response.status} ${new URL(url).pathname}`);
		return response;
	}
	return {
		async get(path) {
			return (await request(`${api}${path}`)).json();
		},
		async pages(path) {
			let url = `${api}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
			const result = [];
			while (url) {
				const response = await request(url);
				const page = await response.json();
				assert.ok(Array.isArray(page), "GitHub context page is not an array");
				result.push(...page);
				url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
			}
			return result;
		},
		async closingIssues(owner, name, number) {
			const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
				repository(owner:$owner,name:$name) { pullRequest(number:$number) {
					closingIssuesReferences(first:100,after:$cursor) {
						nodes { number title body state url closedAt repository { nameWithOwner } }
						pageInfo { hasNextPage endCursor }
					}
				} }
			}`;
			const issues = [];
			let cursor = null;
			do {
				const response = await request(`${api}/graphql`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ query, variables: { owner, name, number, cursor } }),
				});
				const data = await response.json();
				assert.ok(!data.errors?.length, `GitHub closing-issue query failed: ${JSON.stringify(data.errors)}`);
				const connection = data.data?.repository?.pullRequest?.closingIssuesReferences;
				assert.ok(connection, `GitHub did not return closing issues for PR #${number}`);
				issues.push(...connection.nodes);
				cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
				assert.ok(!connection.pageInfo.hasNextPage || cursor, "GitHub omitted the closing-issue continuation");
			} while (cursor);
			return issues;
		},
		async reviewThreads(owner, name, number) {
			const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
				repository(owner:$owner,name:$name) { pullRequest(number:$number) {
					reviewThreads(first:100,after:$cursor) {
						nodes { id isResolved isOutdated path line comments(first:1) { nodes { databaseId } } }
						pageInfo { hasNextPage endCursor }
					}
				} }
			}`;
			const threads = [];
			let cursor = null;
			do {
				const response = await request(`${api}/graphql`, {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ query, variables: { owner, name, number, cursor } }),
				});
				const data = await response.json();
				assert.ok(!data.errors?.length, `GitHub review-thread query failed: ${JSON.stringify(data.errors)}`);
				const connection = data.data?.repository?.pullRequest?.reviewThreads;
				assert.ok(connection, `GitHub did not return review threads for PR #${number}`);
				threads.push(...connection.nodes.map(({ comments, ...thread }) => ({
					...thread, rootCommentId: comments.nodes[0]?.databaseId ?? null,
				})));
				cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
				assert.ok(!connection.pageInfo.hasNextPage || cursor, "GitHub omitted the review-thread continuation");
			} while (cursor);
			return threads;
		},
	};
}

export async function latestPublishedRelease(repository, token) {
	return client(token).get(`/repos/${repository}/releases/latest`);
}

function comment(item) {
	return { id: item.id, author: item.user?.login, body: item.body, url: item.html_url, createdAt: item.created_at };
}

export async function collectReleaseContext({ repository, commits, token, prospective }) {
	const [owner, name, ...extra] = repository.split("/");
	assert.ok(owner && name && extra.length === 0, "Expected an owner/repository identity");
	const github = client(token);
	const pulls = new Map();
	for (const sha of commits) {
		for (const pull of await github.pages(`/repos/${repository}/commits/${sha}/pulls`)) {
			if (pull.merged_at) pulls.set(pull.number, pull);
		}
	}
	if (prospective) {
		assert.ok(Number.isSafeInteger(prospective.number) && prospective.number > 0, "Expected an open PR number");
		const pull = await github.get(`/repos/${repository}/pulls/${prospective.number}`);
		assert.equal(pull.number, prospective.number, "Prospective PR number changed");
		assert.equal(pull.state, "open", "Prospective release PR is not open");
		assert.equal(pull.base?.repo?.full_name, repository, "Prospective PR targets a different repository");
		assert.equal(pull.base?.ref, "main", "Prospective release PR does not target main");
		assert.equal(pull.head?.sha, prospective.head, "Prospective release PR head differs from the reviewed source");
		pulls.set(pull.number, pull);
	}
	const issues = new Map();
	const reviewedPulls = [];
	for (const pull of pulls.values()) {
		const [comments, reviews, reviewComments, closingIssues, reviewThreads] = await Promise.all([
			github.pages(`/repos/${repository}/issues/${pull.number}/comments`),
			github.pages(`/repos/${repository}/pulls/${pull.number}/reviews`),
			github.pages(`/repos/${repository}/pulls/${pull.number}/comments`),
			github.closingIssues(owner, name, pull.number),
			github.reviewThreads(owner, name, pull.number),
		]);
		for (const issue of closingIssues) issues.set(`${issue.repository.nameWithOwner}#${issue.number}`, issue);
		reviewedPulls.push({
			number: pull.number, title: pull.title, body: pull.body, url: pull.html_url,
			mergedAt: pull.merged_at, mergeCommit: pull.merged_at ? pull.merge_commit_sha : null,
			...(pull.merged_at ? {} : { state: pull.state, head: pull.head.sha }),
			closingIssues: closingIssues.map((issue) => issue.url),
			comments: comments.map(comment),
			reviews: reviews.map((review) => ({ ...comment(review), state: review.state, commit: review.commit_id, submittedAt: review.submitted_at })),
			reviewComments: reviewComments.map((entry) => ({ ...comment(entry), path: entry.path, line: entry.line,
				originalLine: entry.original_line, inReplyToId: entry.in_reply_to_id, reviewId: entry.pull_request_review_id })),
			reviewThreads,
		});
	}
	const reviewedIssues = [];
	for (const issue of issues.values()) {
		const comments = await github.pages(`/repos/${issue.repository.nameWithOwner}/issues/${issue.number}/comments`);
		reviewedIssues.push({ ...issue, comments: comments.map(comment) });
	}
	return { repository, commits, pulls: reviewedPulls, issues: reviewedIssues };
}
