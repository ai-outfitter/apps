import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { verify } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const origin = "https://api.github.com";
const date = "2026-01-01T00:00:00Z";
const mainRef = "refs/heads/main";
const bridgePath = process.env.FOUNDRY_GOVERNANCE_FORGEJO_BRIDGE;
const forgejoBridge = bridgePath && await import(pathToFileURL(bridgePath).href);

// Regular files let Git run in sandboxes that deny the socket-backed libuv
// stdio pipes. Give Git only fixture data and an isolated configuration.
export function gitCommand(args, options = {}) {
  const stdio = mkdtempSync(join(tmpdir(), "governance-git-io-"));
  const files = ["in", "out", "err"].map((name) => join(stdio, name));
  writeFileSync(files[0], options.input ?? "");
  const fds = [openSync(files[0], "r"), openSync(files[1], "w"), openSync(files[2], "w")];
  try {
    const result = spawnSync("git", args, { stdio: fds, env: options.env });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, readFileSync(files[2], "utf8"));
    return readFileSync(files[1], "utf8");
  } finally {
    for (const fd of fds) closeSync(fd);
    rmSync(stdio, { recursive: true, force: true });
  }
}

export const paths = {
  pr: ".github/pull_request_template.md",
  bug: ".github/ISSUE_TEMPLATE/bug_report.md",
  feature: ".github/ISSUE_TEMPLATE/feature_request.md",
};
export const blankRepository = "blank/repo";
const selectedRepositories = new Set(["missing/repo", "custom/repo", "team/inherited", "team/repo", "limited/repo", blankRepository]);
export const unselectedRepository = "team/unselected";
export const wrongIdRepository = "team/wrong-id";
export const templateBranch = "outfitter/community-templates";
export const blankTemplates = { [paths.pr]: " \t\n", [paths.bug]: "" };
export const wrongBugPath = ".github/ISSUE_TEMPLATE/local_bug.yml";
export const blankYamlPath = ".github/ISSUE_TEMPLATE/bug_alternative.yml";
export const unrelatedPath = "notes/sentinel.txt";
const allTemplates = {
  [paths.pr]: "## Goal\n\nFixture contributors need context.\n\n## Changes\n\nDescribe the concrete changes.\n\n## Demo\n\nShow before and after, then give reproduction steps.\n",
  [paths.bug]: "---\nname: Bug report\nabout: Report a problem\n---\n\nDescribe the steps and observations.\n",
  [paths.feature]: "---\nname: Feature request\nabout: Propose an improvement\n---\n\nDescribe the use case and desired outcome.\n",
};
const readme = { "README.md": "Disposable governance repository.\n" };
const testWorkflow = {
  ".github/workflows/ci.yml": "name: CI\non: [pull_request, merge_group]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n",
};

function repository(directory, name, files) {
  const git = (args, input) => gitCommand([
    "-C", directory, "--git-dir", name, ...args,
  ], {
    input,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Governance fixture",
      GIT_COMMITTER_NAME: "Governance fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  const existing = (ref) => {
    try { return git(["rev-parse", "--verify", ref]).trim(); }
    catch { return null; }
  };
  const commit = (ref, parent, additions, message) => {
    git(["read-tree", ...(parent ? [parent] : ["--empty"])]);
    for (const [path, contents] of Object.entries(additions)) {
      assert.ok(path && !path.startsWith("/") && !path.split("/").includes(".."));
      const blob = git(["hash-object", "-w", "--stdin"], contents).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    }
    const tree = git(["write-tree"]).trim();
    const oid = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]).trim();
    git(["update-ref", ref, oid, parent ?? "0".repeat(40)]);
    return oid;
  };
  const entries = (ref, path = "") => {
    const tree = path ? `${ref}:${path}` : ref;
    if (!existing(tree)) return null;
    return git(["ls-tree", "-z", tree]).split("\0").filter(Boolean).map((line) => {
      const [, mode, type, oid, name] = /^(\d+) (\w+) ([a-f\d]+)\t([\s\S]+)$/.exec(line);
      return { name, mode: Number.parseInt(mode, 8), type, oid };
    });
  };
  const file = (ref, path) => {
    const object = `${ref}:${path}`;
    return existing(object) ? git(["cat-file", "blob", object]) : null;
  };
  const blob = (oid) => {
    const text = git(["cat-file", "blob", oid]);
    return { text, byteSize: Buffer.byteLength(text), isBinary: false, isTruncated: false };
  };
  git(["init", "--quiet", "--bare", "--initial-branch=main"]);
  commit(mainRef, null, files, "Seed disposable repository");
  return { git, existing, commit, entries, file, blob, pulls: [] };
}

export function githubFixture(token, { appId, publicKey }) {
  const directory = mkdtempSync(join(tmpdir(), "governance-git-"));
  const fixtures = new Map();
  const requests = [];
  const installationTokens = new Map();
  const forgejoReceipts = [];
  const repo = (name) => {
    const result = fixtures.get(name);
    assert.ok(result, `Unexpected fixture repository ${name}`);
    return result;
  };
  const partialBug = allTemplates[paths.bug].replace("Describe the steps", "Our custom support instructions describe the steps");
  const partialFeature = allTemplates[paths.feature].replace("Describe the use case", "Our customized feature instructions describe the use case");
  const addRepo = (name, files) => fixtures.set(name, repository(directory, `${name.replace("/", "-")}.git`, { ...readme, ...files }));
  addRepo("missing/repo", testWorkflow);
  addRepo("custom/repo", { ...testWorkflow, [paths.bug]: partialBug, [paths.feature]: partialFeature });
  addRepo("team/repo", { ...testWorkflow, [paths.bug]: partialBug });
  addRepo("team/inherited", testWorkflow);
  addRepo(unselectedRepository, testWorkflow);
  addRepo(wrongIdRepository, testWorkflow);
  addRepo("team/.github", allTemplates);
  addRepo("limited/repo", testWorkflow);
  addRepo("limited/.github", { [paths.pr]: allTemplates[paths.pr], [paths.bug]: partialBug });
  addRepo(blankRepository, {
    ...testWorkflow,
    ...blankTemplates,
    [wrongBugPath]: "name: Local bug report\ndescription: Missing form body\n",
    [blankYamlPath]: " \n",
    [paths.feature]: partialFeature,
    [unrelatedPath]: "Preserve this line.  \r\nAnd this one.\n",
  });

  const listing = (git, oid, path) => {
    const entries = git.entries(oid, path);
    return entries ? { object: { entries } } : null;
  };
  const refId = (name, ref) => `fixture-ref:${name}:${ref}`;
  const githubUrl = (name, suffix) => `https://github.com/${name}/${suffix}`;
  const repositoryId = (name) => [...fixtures.keys()].indexOf(name) + 1;
  const installationId = (name) => 1000 + repositoryId(name);
  const installed = (name) => selectedRepositories.has(name) || name === wrongIdRepository;
  const mintPath = (name) => `/app/installations/${installationId(name)}/access_tokens`;
  const appRequest = (method, path, body, jwt) => {
    const [header, payload, signature] = jwt.split(".");
    assert.ok(signature && verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
    assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
    assert.equal(JSON.parse(Buffer.from(payload, "base64url")).iss, appId);
    const name = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path)?.[1];
    if (method === "GET" && name) {
      repo(name);
      return installed(name)
        ? Response.json({ id: installationId(name), app_id: Number(appId), suspended_at: null })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    const target = [...fixtures.keys()].find((repository) => mintPath(repository) === path);
    assert.ok(method === "POST" && target && installed(target), `Unexpected GitHub App request ${method} ${path}`);
    assert.deepEqual(body, { repositories: [target.split("/")[1]], permissions: { contents: "read" } });
    const scopedToken = `ghs_fixture-${repositoryId(target)}`;
    installationTokens.set(scopedToken, target);
    return Response.json({
      token: scopedToken,
      expires_at: "2099-01-01T00:00:00Z",
      permissions: { contents: "read", metadata: "read" },
      repositories: [{ id: target === wrongIdRepository ? repositoryId("team/repo") : repositoryId(target), full_name: target }],
    }, { status: 201 });
  };
  const rest = async (method, path, search, body, authorized) => {
    const [, name, suffix] = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(path) ?? [];
    if (path === "/user" && method === "GET") return Response.json({ login: "fixture" });
    if (method === "GET" && name?.endsWith("/.github") && !fixtures.has(name))
      return Response.json({ message: "Not Found" }, { status: 404 });
    const git = repo(name);
    if (!authorized && !name.endsWith("/.github")) return new Response(null, { status: 401 });
    if (name.endsWith("/.github")) {
      assert.equal(method, "GET", "Public owner defaults are read-only");
      assert.equal(authorized, false, "Public owner defaults must not receive the actor's credential");
    }
    if (method === "GET" && !suffix) return Response.json({
      id: repositoryId(name),
      node_id: name,
      name: name.split("/")[1],
      full_name: name,
      owner: { login: name.split("/")[0], type: "Organization" },
      default_branch: "main",
      visibility: name.endsWith("/.github") ? "public" : "private",
      private: !name.endsWith("/.github"),
      has_issues: true,
      archived: false,
      disabled: false,
      allow_auto_merge: true,
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      permissions: { push: true, admin: true },
    });
    if (method === "GET" && suffix === "/rules/branches/main")
      return Response.json([{ type: "merge_queue", ruleset_id: 1 }]);
    if (method === "GET" && suffix === "/branches/main")
      return Response.json({ protected: true, commit: { sha: git.existing(mainRef) } });
    if (method === "GET" && suffix === "/actions/permissions/workflow")
      return Response.json({ default_workflow_permissions: "read", can_approve_pull_request_reviews: true });
    const [, type, oid] = /^\/git\/(commits|trees|blobs)\/([a-f0-9]{40})$/.exec(suffix) ?? [];
    if (method === "GET" && type === "commits")
      return Response.json({ tree: { sha: git.existing(`${oid}^{tree}`) } });
    if (method === "GET" && type === "trees")
      return Response.json({
        truncated: false,
        tree: git.entries(oid).map(({ name: path, mode, type: objectType, oid: sha }) => ({
          path, mode: mode.toString(8).padStart(6, "0"), type: objectType, sha,
        })),
      });
    if (method === "GET" && type === "blobs")
      return Response.json({ encoding: "base64", content: Buffer.from(git.blob(oid).text).toString("base64") });
    if (method === "GET" && suffix === "/pulls") {
      const state = search.get("state") ?? "open";
      const head = search.get("head");
      const owner = name.split("/")[0];
      assert.ok(["open", "closed", "all"].includes(state), `Unexpected PR state filter ${state}`);
      const matching = git.pulls.filter((pr) =>
        (state === "all" || pr.state === state) && (!head || head === `${owner}:${pr.head.ref}`));
      return Response.json(matching.slice(0, Number(search.get("per_page") ?? 30)));
    }
    const [, base, head] = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(suffix) ?? [];
    if (method === "GET" && base) {
      const [behind_by, ahead_by] = git.git(["rev-list", "--left-right", "--count", `${base}...${head}`]).trim().split(/\s+/).map(Number);
      const files = git.git(["diff-tree", "--no-commit-id", "--name-status", "-r", base, head])
        .trim().split("\n").filter(Boolean).map((line) => {
          const [status, filename] = line.split("\t");
          return { filename, status: { A: "added", M: "modified" }[status] ?? status };
        });
      return Response.json({ ahead_by, behind_by, files });
    }
    if (method === "POST" && suffix === "/pulls") {
      assert.equal(body.base, "main");
      assert.equal(body.draft, true);
      assert.ok(!git.pulls.some((pr) =>
        pr.state === "open" && pr.head.ref === body.head && pr.base.ref === body.base), "Duplicate open fixture PR");
      const sha = git.existing(`refs/heads/${body.head}`);
      assert.ok(sha);
      const number = git.pulls.length + 1;
      const pr = {
        number,
        node_id: `fixture-pr:${name}:${number}`,
        html_url: githubUrl(name, `pull/${number}`),
        state: "open",
        draft: body.draft,
        head: { ref: body.head, sha },
        base: { ref: body.base, sha: git.existing(mainRef) },
      };
      if (forgejoBridge) {
        const receipt = await forgejoBridge.mirrorDraft({ repository: name, git, body });
        assert.deepEqual(receipt.head, pr.head);
        assert.deepEqual(receipt.base, pr.base);
        forgejoReceipts.push(receipt);
      }
      git.pulls.push(pr);
      return Response.json(pr, { status: 201 });
    }
    assert.fail(`Unexpected fixture REST request ${method} ${path}`);
  };
  const graphql = (query, variables) => {
    const input = variables.input;
    if (input && query.includes("CreateRefInput")) {
      const git = repo(input.repositoryId);
      git.git(["update-ref", input.name, input.oid, "0".repeat(40)]);
      return { ref: { id: refId(input.repositoryId, input.name) } };
    }
    if (input && query.includes("CreateCommitOnBranchInput")) {
      const { repositoryNameWithOwner: name, branchName } = input.branch;
      const git = repo(name);
      const ref = `refs/heads/${branchName}`;
      if (git.existing(ref) !== input.expectedHeadOid)
        return { errors: [{ message: "Expected head does not match fixture ref" }] };
      const additions = Object.fromEntries(input.fileChanges.additions.map(({ path, contents }) => [
        path, Buffer.from(contents, "base64").toString("utf8"),
      ]));
      const oid = git.commit(ref, input.expectedHeadOid, additions, input.message.headline);
      return { createCommitOnBranch: { commit: { oid, url: githubUrl(name, `commit/${oid}`) } } };
    }

    const name = `${variables.owner}/${variables.name}`;
    if (!fixtures.has(name) && name.endsWith("/.github")) return { repository: null };
    const git = repo(name);
    if (query.includes("defaultBranchRef")) {
      const oid = git.existing(mainRef);
      const target = { oid, tree: { entries: git.entries(oid) } };
      for (const [, alias, path] of query.matchAll(/(\w+)\s*:\s*file\(path:\s*"([^"]+)"\)/g))
        target[alias] = listing(git, oid, path);
      return { repository: {
        id: name,
        isPrivate: !name.endsWith("/.github"),
        visibility: name.endsWith("/.github") ? "PUBLIC" : "PRIVATE",
        mergeQueue: { id: "fixture-queue" },
        autoMergeAllowed: true,
        defaultBranchRef: { name: "main", target },
      } };
    }
    if (query.includes("object(oid:")) {
      const objects = [...query.matchAll(/(\w+)\s*:\s*object\(oid:\s*"([a-f0-9]+)"\)/g)];
      assert.ok(objects.length, "Unrecognized GitHub blob query");
      return { repository: Object.fromEntries(objects.map(([, alias, oid]) => [alias, git.blob(oid)])) };
    }
    if (query.includes("object(expression:")) {
      return { repository: Object.fromEntries(Object.entries(variables).filter(([key]) => /^f\d+$/.test(key)).map(([key, expression]) => {
        const [ref, path] = expression.split(":");
        return [key, { text: git.file(ref, path) }];
      })) };
    }
    if (query.includes("qualifiedName:")) {
      const { ref } = variables;
      const oid = git.existing(ref);
      return { repository: {
        id: name,
        autoMergeAllowed: true,
        squashMergeAllowed: true,
        mergeCommitAllowed: true,
        rebaseMergeAllowed: true,
        ref: oid ? {
          id: refId(name, ref),
          target: { oid },
          associatedPullRequests: { nodes: git.pulls.filter(({ head }) => `refs/heads/${head.ref}` === ref).map((pr) => ({
            id: pr.node_id, number: pr.number, url: pr.html_url, baseRefName: pr.base.ref,
          })) },
        } : null,
      } };
    }
    if (query.includes("mergeQueue(branch")) return { repository: { mergeQueue: { id: "fixture-queue" } } };
    assert.fail("Unexpected fixture GraphQL operation");
  };
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, origin, "The fixture rejects all network destinations");
    const { method } = request;
    const auth = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    const scopedRepository = installationTokens.get(auth);
    const credential = !auth ? "public" : auth === token ? "actor" : scopedRepository ? "installation" : "app";
    const body = request.body ? await request.json() : undefined;
    const path = decodeURIComponent(url.pathname);
    if (path === "/graphql") {
      const operation = body.query.trim().split(/[({\s]/)[0];
      assert.ok(operation === "mutation" || operation === "query");
      requests.push({ operation, path, credential, name: body.query.match(/\b(\w+)\(input:\s*\$input\)/)?.[1] });
      if (credential === "installation") {
        assert.equal(operation, "query", "Installation credential cannot mutate");
        assert.equal(`${body.variables?.owner}/${body.variables?.name}`, scopedRepository);
      } else {
        assert.equal(credential, "actor", "GitHub GraphQL requires a repository credential");
      }
      const result = graphql(body.query, body.variables ?? {});
      return Response.json(result.errors ? result : { data: result });
    }
    requests.push({ operation: method, path, search: url.search, credential });
    if (credential === "app") return appRequest(method, path, body, auth);
    if (credential === "installation") {
      assert.equal(method, "GET", "Installation credential cannot mutate");
      assert.ok(path === `/repos/${scopedRepository}` || path.startsWith(`/repos/${scopedRepository}/`));
    }
    return rest(method, path, url.searchParams, body, credential !== "public");
  };
  return {
    fetch,
    requests,
    repo,
    mintPath,
    verifyForgejoDrafts: async () => forgejoBridge ? Promise.all(forgejoReceipts.map(forgejoBridge.verifyDraft)) : null,
    mutations: () => requests.filter(({ operation, path, credential }) =>
      operation !== "GET" && operation !== "query" &&
      !(credential === "app" && operation === "POST" && path.endsWith("/access_tokens"))),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
