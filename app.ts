import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

type GitObj = { type: string; content: Buffer };
type CommitMeta = { oid: string; tree: string; parents: string[]; message: string; author: string; timestamp: string };
type Repo = {
  id: number; nodeId: string; owner: string; name: string; fullName: string;
  description: string | null; private: boolean; defaultBranch: string;
  createdAt: string; updatedAt: string;
  refs: Map<string, string>; objects: Map<string, GitObj>; commits: Map<string, CommitMeta>;
  files: Map<string, Map<string, string>>;
  issues: any[]; labels: any[]; pulls: any[]; comments: any[];
  issueSeq: number; pullSeq: number; labelSeq: number; commentSeq: number;
};
type Pkt = { data: Buffer; flush: boolean; delim: boolean; end: number };
type Tok = { t: string; v: string };

export function createApp() {
  let idSeq = 1;
  let reqSeq = 1;
  let clock = 0;
  let currentHost = "localhost";
  const BASE_TS = 1704067200;
  const ZERO = "0".repeat(40);
  const repos = new Map<string, Repo>();

  function viewerLogin() {
    return "adaiversen";
  }

  for (let seedIndex = 1; seedIndex <= 30; seedIndex++) {
    const seedName = "repo-" + String(seedIndex).padStart(2, "0");
    makeRepo(viewerLogin(), seedName, { description: "Seeded repository " + seedName });
  }

  function tick() { return new Date((BASE_TS + clock++) * 1000).toISOString(); }
  function hash(s: string) { return createHash("sha1").update(s).digest("hex"); }
  function hashInt(s: string) { return parseInt(hash(s).slice(0, 8), 16); }
  function nid(type: string, id: any) { return Buffer.from(type + "-" + id).toString("base64url"); }
  function reqId() { return "gh-" + hash("req:" + reqSeq++).slice(0, 24); }
  function gitHash(type: string, content: Buffer) {
    return createHash("sha1").update(type + " " + content.length + "\0").update(content).digest("hex");
  }
  function apiBase(r: Repo) { return "http://" + currentHost + "/api/v3/repos/" + r.fullName; }
  function htmlBase(r: Repo) { return "https://github.com/" + r.fullName; }

  function send(res: any, status: number, body: any, headers?: any) {
    const h: any = headers || {};
    let data: Buffer;
    if (body === undefined || body === null) data = Buffer.alloc(0);
    else if (Buffer.isBuffer(body)) data = body;
    else {
      data = Buffer.from(JSON.stringify(body));
      if (!h["Content-Type"]) h["Content-Type"] = "application/json";
    }
    res.writeHead(status, h);
    res.end(data);
  }

  function readBody(req: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => resolve(Buffer.concat(parts)));
      req.on("error", reject);
    });
  }

  function authed(req: any) {
    const token = process.env.MAKEFUN_SHOP_TOKEN;
    if (!token) return false;
    return String(req.headers.authorization || "") === "Bearer " + token;
  }

  function findRepo(owner: string, name: string): Repo | null {
    return repos.get((owner + "/" + name).toLowerCase()) || null;
  }
  function repoById(id: any): Repo | null {
    for (const r of repos.values()) if (String(r.id) === String(id)) return r;
    return null;
  }

  function writeBlob(r: Repo, content: Buffer) {
    const oid = gitHash("blob", content);
    r.objects.set(oid, { type: "blob", content });
    return oid;
  }

  function buildTreeFor(r: Repo, files: Map<string, string>) {
    const newNode = () => ({ f: new Map<string, any>(), d: new Map<string, any>() });
    const root: any = newNode();
    for (const [p, oid] of files) {
      const parts = p.split("/").filter(Boolean);
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!node.d.has(seg)) node.d.set(seg, newNode());
        node = node.d.get(seg);
      }
      if (parts.length) node.f.set(parts[parts.length - 1], oid);
    }
    const emit = (node: any): string => {
      const entries: any[] = [];
      for (const [n, oid] of node.f) {
        entries.push({ sort: n, buf: Buffer.concat([Buffer.from("100644 " + n + "\0", "utf8"), Buffer.from(oid, "hex")]) });
      }
      for (const [n, child] of node.d) {
        const co = emit(child);
        entries.push({ sort: n + "/", buf: Buffer.concat([Buffer.from("40000 " + n + "\0", "utf8"), Buffer.from(co, "hex")]) });
      }
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.sort, "utf8"), Buffer.from(b.sort, "utf8")));
      const content = Buffer.concat(entries.map(e => e.buf));
      const oid = gitHash("tree", content);
      r.objects.set(oid, { type: "tree", content });
      return oid;
    };
    return emit(root);
  }

  function makeCommit(r: Repo, message: string, files: Map<string, string>, parents: string[]) {
    const tree = buildTreeFor(r, files);
    const when = BASE_TS + clock;
    const ident = "maker <maker@make.fun>";
    const text = "tree " + tree + "\n" + parents.map(p => "parent " + p + "\n").join("") +
      "author " + ident + " " + when + " +0000\ncommitter " + ident + " " + when + " +0000\n\n" + message + "\n";
    const content = Buffer.from(text, "utf8");
    const oid = gitHash("commit", content);
    r.objects.set(oid, { type: "commit", content });
    clock++;
    const meta: CommitMeta = { oid, tree, parents, message, author: ident, timestamp: new Date(when * 1000).toISOString() };
    r.commits.set(oid, meta);
    r.updatedAt = meta.timestamp;
    return meta;
  }

  function makeRepo(owner: string, name: string, opts?: any): Repo | null {
    owner = owner || viewerLogin();
    name = name || "repo-" + idSeq;
    const key = (owner + "/" + name).toLowerCase();
    if (repos.has(key)) return null;
    opts = opts || {};
    const created = tick();
    const r: Repo = {
      id: idSeq++, nodeId: "", owner, name, fullName: owner + "/" + name,
      description: opts.description === undefined ? null : opts.description,
      private: !!opts.private, defaultBranch: opts.default_branch || opts.defaultBranch || "main",
      createdAt: created, updatedAt: created,
      refs: new Map(), objects: new Map(), commits: new Map(), files: new Map(),
      issues: [], labels: [], pulls: [], comments: [],
      issueSeq: 1, pullSeq: 1, labelSeq: 1, commentSeq: 1
    };
    r.nodeId = nid("Repository", r.id);
    repos.set(key, r);
    const blob = writeBlob(r, Buffer.from("# " + name + "\n", "utf8"));
    const files = new Map<string, string>();
    files.set("README.md", blob);
    r.files.set(r.defaultBranch, files);
    const c = makeCommit(r, "Initial commit", files, []);
    r.refs.set("refs/heads/" + r.defaultBranch, c.oid);
    return r;
  }

  function userJson(login: string = viewerLogin()) {
    const id = hashInt(login);
    return {
      login, id, node_id: nid("User", id), avatar_url: "", gravatar_id: "",
      url: "http://" + currentHost + "/api/v3/users/" + login,
      html_url: "https://github.com/" + login, type: "User", site_admin: false
    };
  }
  function labelJson(l: any) {
    return { id: l.id, node_id: nid("Label", l.id), name: l.name, color: l.color, description: l.description, default: l.default };
  }
  function commitJson(r: Repo, m: CommitMeta) {
    const url = apiBase(r) + "/git/commits/" + m.oid;
    return {
      sha: m.oid, node_id: nid("Commit", m.oid), url,
      html_url: htmlBase(r) + "/commit/" + m.oid,
      commit: {
        author: { name: "maker", email: "maker@make.fun", date: m.timestamp },
        committer: { name: "maker", email: "maker@make.fun", date: m.timestamp },
        message: m.message,
        tree: { sha: m.tree, url: apiBase(r) + "/git/trees/" + m.tree },
        parent: m.parents.map(p => ({ sha: p, url: apiBase(r) + "/git/commits/" + p })),
        verification: { verified: false, reason: "unsigned", signature: null, payload: null }
      },
      parents: m.parents.map(p => ({ sha: p, url: apiBase(r) + "/git/commits/" + p, html_url: htmlBase(r) + "/commit/" + p })),
      stats: { total: 0, additions: 0, deletions: 0 }, files: []
    };
  }
  function repoJson(r: Repo) {
    let openIssues = 0;
    for (const i of r.issues) if (i.state === "open") openIssues++;
    for (const p of r.pulls) if (p.state === "open") openIssues++;
    return {
      id: r.id, node_id: r.nodeId, name: r.name, full_name: r.fullName,
      owner: userJson(r.owner), private: r.private, html_url: htmlBase(r),
      description: r.description, fork: false, url: apiBase(r),
      created_at: r.createdAt, updated_at: r.updatedAt, pushed_at: r.updatedAt,
      size: 0, stargazers_count: 0, watchers_count: 0, language: null,
      has_issues: true, has_projects: true, has_wiki: true, has_pages: false,
      has_downloads: true, archived: false, disabled: false,
      forks_count: 0, open_issues_count: openIssues, license: null,
      allow_forking: true, is_template: false, topics: [], visibility: r.private ? "private" : "public",
      default_branch: r.defaultBranch
    };
  }
  function issueJson(r: Repo, i: any) {
    const labels = i.labels.map((n: string) => r.labels.find(l => l.name === n)).filter(Boolean).map(labelJson);
    const out: any = {
      id: i.id, node_id: nid("Issue", i.id), url: apiBase(r) + "/issues/" + i.number,
      repository_url: apiBase(r), labels_url: apiBase(r) + "/issues/" + i.number + "/labels{/name}",
      comments_url: apiBase(r) + "/issues/" + i.number + "/comments",
      events_url: apiBase(r) + "/issues/" + i.number + "/events",
      html_url: htmlBase(r) + "/issues/" + i.number,
      number: i.number, state: i.state, title: i.title, body: i.body || "",
      user: userJson(i.user || r.owner), labels, assignees: [], milestone: null,
      locked: false, comments: r.comments.filter(c => c.issueNumber === i.number).length,
      closed_at: i.state === "closed" ? i.updatedAt : null,
      created_at: i.createdAt, updated_at: i.updatedAt, author_association: "OWNER"
    };
    if (i.pullRequest) out.pull_request = i.pullRequest;
    return out;
  }
  function branchJson(r: Repo, name: string, oid: string) {
    return {
      name, commit: { sha: oid, url: apiBase(r) + "/commits/" + oid },
      protected: false, protection: null
    };
  }
  function pullJson(r: Repo, p: any) {
    const headOid = r.refs.get("refs/heads/" + p.head) || ZERO;
    const baseOid = r.refs.get("refs/heads/" + p.base) || ZERO;
    return {
      id: p.id, node_id: nid("PullRequest", p.id), url: apiBase(r) + "/pulls/" + p.number,
      html_url: htmlBase(r) + "/pull/" + p.number,
      diff_url: htmlBase(r) + "/pull/" + p.number + ".diff",
      patch_url: htmlBase(r) + "/pull/" + p.number + ".patch",
      issue_url: apiBase(r) + "/issues/" + p.number,
      number: p.number, state: p.state, locked: false, title: p.title,
      user: userJson(r.owner), body: p.body || "",
      created_at: p.createdAt, updated_at: p.updatedAt,
      closed_at: p.state === "closed" ? p.updatedAt : null,
      merged_at: p.mergedAt || null,
      merge_commit_sha: p.mergeCommitSha || null,
      assignee: null, assignees: [], requested_reviewers: [], requested_teams: [],
      labels: [], milestone: null,
      head: { label: r.owner + ":" + p.head, ref: p.head, sha: headOid, user: userJson(r.owner), repo: repoJson(r) },
      base: { label: r.owner + ":" + p.base, ref: p.base, sha: baseOid, user: userJson(r.owner), repo: repoJson(r) },
      _links: {
        self: { href: apiBase(r) + "/pulls/" + p.number },
        html: { href: htmlBase(r) + "/pull/" + p.number },
        issue: { href: apiBase(r) + "/issues/" + p.number },
        comments: { href: apiBase(r) + "/issues/" + p.number + "/comments" },
        review_comments: { href: apiBase(r) + "/pulls/" + p.number + "/comments" },
        review_events: { href: apiBase(r) + "/pulls/" + p.number + "/events" },
        commits: { href: apiBase(r) + "/pulls/" + p.number + "/commits" },
        statuses: { href: apiBase(r) + "/statuses/" + headOid }
      },
      merged: !!p.merged, mergeable: p.mergeable !== false, rebaseable: p.mergeable !== false,
      mergeable_state: p.mergeable === false ? "conflict" : "clean",
      merged_by: p.mergedBy ? userJson(p.mergedBy) : null,
      comments: r.comments.filter(c => c.issueNumber === p.number).length,
      review_comments: 0, commits: 0, additions: 0, deletions: 0, changed_files: 0,
      maintainer_can_modify: false
    };
  }

  function validateLabels(r: Repo, labels: any) {
    if (labels === undefined || labels === null) return [];
    if (!Array.isArray(labels)) return null;
    const names: string[] = [];
    for (const l of labels) {
      const n = typeof l === "string" ? l : l && typeof l.name === "string" ? l.name : null;
      if (!n) return null;
      if (!r.labels.some(x => x.name === n)) return null;
      if (names.indexOf(n) < 0) names.push(n);
    }
    return names;
  }

  function createIssueInternal(r: Repo, data: any) {
    const labels = validateLabels(r, data.labels);
    if (labels === null) return { error: { message: "Validation Failed", errors: [{ resource: "Issue", field: "labels", code: "invalid" }] } };
    const n = r.issueSeq++;
    const t = tick();
    const i = {
      id: idSeq++, number: n, title: String(data.title || ""), body: data.body || "",
      state: data.state || "open", labels, user: data.user || r.owner,
      createdAt: t, updatedAt: t, pullRequest: null
    };
    r.issues.push(i);
    return { issue: i };
  }

  function createPullInternal(r: Repo, data: any) {
    const n = r.pullSeq++;
    const t = tick();
    const p = {
      id: idSeq++, number: n, title: String(data.title || ""), body: data.body || "",
      state: "open", head: String(data.head || ""), base: String(data.base || ""),
      merged: false, mergedAt: null, mergedBy: null, mergeCommitSha: null,
      mergeable: true, createdAt: t, updatedAt: t
    };
    r.pulls.push(p);
    r.issues.push({
      id: idSeq++, number: n, title: p.title, body: p.body, state: "open",
      labels: [], user: r.owner, createdAt: t, updatedAt: t,
      pullRequest: {
        url: apiBase(r) + "/pulls/" + n, html_url: htmlBase(r) + "/pull/" + n,
        diff_url: htmlBase(r) + "/pull/" + n + ".diff", patch_url: htmlBase(r) + "/pull/" + n + ".patch",
        merged_at: null
      }
    });
    return p;
  }

  function mergePullInternal(r: Repo, p: any, data: any) {
    if (p.merged) return { error: { status: 405, body: { message: "Pull Request is already merged" } } };
    if (!p.head || !p.base || p.head === p.base) return { error: { status: 405, body: { message: "Pull Request is not mergeable" } } };
    const baseRef = r.refs.get("refs/heads/" + p.base);
    const headFiles = r.files.get(p.head);
    if (!baseRef || !headFiles) return { error: { status: 405, body: { message: "Pull Request is not mergeable" } } };
    const msg = (data && data.commit_title) || "Merge pull request #" + p.number + " from " + p.head;
    const c = makeCommit(r, msg, headFiles, [baseRef]);
    r.refs.set("refs/heads/" + p.base, c.oid);
    r.files.set(p.base, new Map(headFiles));
    p.merged = true;
    p.state = "closed";
    p.mergedAt = c.timestamp;
    p.mergeCommitSha = c.oid;
    p.mergedBy = r.owner;
    p.updatedAt = c.timestamp;
    const issue = r.issues.find(i => i.number === p.number);
    if (issue) {
      issue.state = "closed";
      issue.updatedAt = c.timestamp;
      if (issue.pullRequest) issue.pullRequest.merged_at = c.timestamp;
    }
    return { sha: c.oid, merged: true, message: "Pull Request successfully merged" };
  }

  function contentJson(r: Repo, p: string, oid: string, content: Buffer) {
    return {
      name: p.split("/").filter(Boolean).pop() || p,
      path: p, sha: oid, size: content.length, type: "file",
      content: content.toString("base64"), encoding: "base64",
      url: apiBase(r) + "/contents/" + p,
      git_url: apiBase(r) + "/git/blobs/" + oid,
      html_url: htmlBase(r) + "/blob/" + (r.refs.get("refs/heads/" + r.defaultBranch) || "") + "/" + p,
      download_url: "https://raw.githubusercontent.com/" + r.fullName + "/" + r.defaultBranch + "/" + p,
      _links: {
        self: apiBase(r) + "/contents/" + p,
        git: apiBase(r) + "/git/blobs/" + oid,
        html: htmlBase(r) + "/blob/" + r.defaultBranch + "/" + p
      }
    };
  }

  function parseJson(body: Buffer) {
    try { return JSON.parse(body.toString("utf8")); } catch { return null; }
  }

  async function handleRest(req: any, res: any, seg: string[], query: URLSearchParams, body: Buffer) {
    if (!authed(req)) { send(res, 401, { message: "Requires authentication" }); return; }
    const method = req.method || "GET";
    const writes = ["POST", "PUT", "PATCH"].indexOf(method) >= 0;
    const hasBody = writes && body.length > 0;
    let data: any = writes ? (hasBody ? parseJson(body) : {}) : null;
    if (hasBody && data === null) { send(res, 400, { message: "Bad Request" }); return; }

    if (seg.length === 2) {
      if (method === "GET") {
        send(res, 200, {
          current_user_url: "http://" + currentHost + "/api/v3/user",
          repository_url: "http://" + currentHost + "/api/v3/repos/{owner}/{repo}",
          meta_url: "http://" + currentHost + "/api/v3/meta"
        }, { "X-OAuth-Scopes": "repo, read:org" });
        return;
      }
      send(res, 404, { message: "Not Found" }); return;
    }
    if (seg[2] === "meta" && seg.length === 3) {
      send(res, 200, {
        verifiable_password_authentication: false,
        installed_version: "1.0.0",
        ssh_key_fingerprints: {}, ssh_key: "", hooks: [], git: [],
        web: [], api: [], importer: []
      });
      return;
    }
    if (seg[2] === "user" && seg[3] === "repos") {
      if (method === "POST") {
        if (!data || typeof data.name !== "string" || !data.name) {
          send(res, 422, { message: "Validation Failed", errors: [{ resource: "Repository", field: "name", code: "missing" }] }); return;
        }
        const ownerName = data.owner || viewerLogin();
        const existing = findRepo(ownerName, data.name);
        if (existing) {
          existing.refs.clear(); existing.objects.clear(); existing.commits.clear(); existing.files.clear();
          existing.issues.length = 0; existing.labels.length = 0; existing.pulls.length = 0; existing.comments.length = 0;
          existing.issueSeq = 1; existing.pullSeq = 1; existing.labelSeq = 1; existing.commentSeq = 1;
          existing.updatedAt = tick();
          send(res, 422, { message: "Repository already exists", errors: [{ resource: "Repository", field: "name", code: "already_exists" }] }); return;
        }
        const r = makeRepo(ownerName, data.name, data);
        if (!r) { send(res, 422, { message: "Repository already exists", errors: [{ resource: "Repository", field: "name", code: "already_exists" }] }); return; }
        send(res, 201, repoJson(r)); return;
      }
      if (method === "GET") {
        const perPage = Math.min(Math.max(parseInt(query.get("per_page") || "30", 10) || 30, 1), 100);
        const page = Math.max(parseInt(query.get("page") || "1", 10) || 1, 1);
        const all = Array.from(repos.values());
        const total = all.length;
        const items = all.slice((page - 1) * perPage, page * perPage).map(repoJson);
        const headers: any = {};
        if (total > perPage) {
          const last = Math.ceil(total / perPage);
          const base = "http://" + currentHost + "/api/v3/user/repos";
          const link = (p: number, rel: string) => "<" + base + "?page=" + p + "&per_page=" + perPage + '>; rel="' + rel + '"';
          const parts = [link(1, "first")];
          if (page > 1) parts.push(link(page - 1, "prev"));
          if (page < last) parts.push(link(page + 1, "next"));
          parts.push(link(last, "last"));
          headers.Link = parts.join(", ");
        }
        send(res, 200, items, headers); return;
      }
      send(res, 404, { message: "Not Found" }); return;
    }
    if (seg[2] === "user" && seg.length === 3 && method === "GET") {
      send(res, 200, { ...userJson(viewerLogin()), name: viewerLogin(), company: "make.fun", bio: null }); return;
    }
    if (seg[2] !== "repos" || seg.length < 5) { send(res, 404, { message: "Not Found" }); return; }
    const r = findRepo(decodeURIComponent(seg[3]), decodeURIComponent(seg[4]));
    if (!r) { send(res, 404, { message: "Not Found" }); return; }
    const rest = seg.slice(5);

    if (rest.length === 0) {
      if (method === "GET") { send(res, 200, repoJson(r)); return; }
      if (method === "PATCH") {
        if (data) {
          if (typeof data.description !== "undefined") r.description = data.description;
          if (typeof data.private !== "undefined") r.private = !!data.private;
          if (typeof data.default_branch === "string" && r.refs.has("refs/heads/" + data.default_branch)) r.defaultBranch = data.default_branch;
          if (typeof data.name === "string" && data.name && data.name !== r.name) {
            const key = (r.owner + "/" + data.name).toLowerCase();
            if (!repos.has(key)) { repos.delete((r.owner + "/" + r.name).toLowerCase()); r.name = data.name; r.fullName = r.owner + "/" + r.name; repos.set(key, r); }
          }
        }
        r.updatedAt = tick();
        send(res, 200, repoJson(r)); return;
      }
      if (method === "DELETE") {
        r.refs.clear(); r.objects.clear(); r.commits.clear(); r.files.clear();
        r.issues.length = 0; r.labels.length = 0; r.pulls.length = 0; r.comments.length = 0;
        repos.delete((r.owner + "/" + r.name).toLowerCase());
        send(res, 204, null); return;
      }
      send(res, 404, { message: "Not Found" }); return;
    }

    if (rest[0] === "contents") {
      const p = rest.slice(1).map(decodeURIComponent).join("/");
      const branch = String(query.get("ref") || query.get("branch") || (data && data.branch) || r.defaultBranch);
      const files = r.files.get(branch) || r.files.get(r.defaultBranch) || new Map<string, string>();
      if (method === "GET") {
        if (!p || files.has(p)) {
          if (!p) { send(res, 404, { message: "Not Found" }); return; }
          const oid = files.get(p)!;
          const obj = r.objects.get(oid);
          send(res, 200, contentJson(r, p, oid, obj ? obj.content : Buffer.alloc(0))); return;
        }
        const prefix = p.replace(/\/$/, "") + "/";
        const names = new Set<string>();
        for (const f of files.keys()) {
          if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split("/")[0]);
        }
        if (names.size === 0) { send(res, 404, { message: "Not Found" }); return; }
        const listing = Array.from(names).sort().map(n => {
          const full = prefix + n;
          if (files.has(full)) {
            const oid = files.get(full)!;
            const obj = r.objects.get(oid);
            return { name: n, path: full, sha: oid, size: obj ? obj.content.length : 0, type: "file", url: apiBase(r) + "/contents/" + full, download_url: "https://raw.githubusercontent.com/" + r.fullName + "/" + branch + "/" + full };
          }
          return { name: n, path: full, sha: hash(prefix + n), size: 0, type: "dir", url: apiBase(r) + "/contents/" + full, download_url: null };
        });
        send(res, 200, listing); return;
      }
      if (method === "PUT") {
        if (!data || typeof data.content !== "string") { send(res, 422, { message: "Validation Failed", errors: [{ resource: "Content", field: "content", code: "missing" }] }); return; }
        const content = Buffer.from(data.content, "base64");
        const oid = writeBlob(r, content);
        const next = new Map(files);
        next.set(p, oid);
        r.files.set(branch, next);
        const parent = r.refs.get("refs/heads/" + branch);
        const c = makeCommit(r, data.message || ("Add " + p), next, parent ? [parent] : []);
        r.refs.set("refs/heads/" + branch, c.oid);
        send(res, 201, { content: contentJson(r, p, oid, content), commit: commitJson(r, c) }); return;
      }
      if (method === "DELETE") {
        if (!files.has(p)) { send(res, 404, { message: "Not Found" }); return; }
        const oid = files.get(p)!;
        const next = new Map(files);
        next.delete(p);
        r.files.set(branch, next);
        const parent = r.refs.get("refs/heads/" + branch);
        const c = makeCommit(r, (data && data.message) || ("Delete " + p), next, parent ? [parent] : []);
        r.refs.set("refs/heads/" + branch, c.oid);
        send(res, 200, { content: null, commit: commitJson(r, c) }); return;
      }
      send(res, 404, { message: "Not Found" }); return;
    }

    await handleRepoExtras(req, res, method, data, query, r, rest);
  }

  async function handleRepoExtras(req: any, res: any, method: string, data: any, query: URLSearchParams, r: Repo, rest: string[]) {
    const section = rest[0];

    if (section === "labels") {
      if (rest.length === 1) {
        if (method === "GET") {
          const perPage = Math.min(Math.max(parseInt(query.get("per_page") || "30", 10) || 30, 1), 100);
          const page = Math.max(parseInt(query.get("page") || "1", 10) || 1, 1);
          send(res, 200, r.labels.slice((page - 1) * perPage, page * perPage).map(labelJson)); return;
        }
        if (method === "POST") {
          if (!data || typeof data.name !== "string" || !data.name) { send(res, 422, { message: "Validation Failed" }); return; }
          if (r.labels.some(l => l.name === data.name)) { send(res, 422, { message: "Validation Failed", errors: [{ resource: "Label", field: "name", code: "already_exists" }] }); return; }
          const l = { id: idSeq++, name: data.name, color: String(data.color || "ededed").replace(/^#/, ""), description: data.description || null, default: false };
          r.labels.push(l);
          send(res, 201, labelJson(l)); return;
        }
        send(res, 404, { message: "Not Found" }); return;
      }
      const name = decodeURIComponent(rest[1]);
      const l = r.labels.find(x => x.name === name);
      if (!l) { send(res, 404, { message: "Not Found" }); return; }
      if (method === "GET") { send(res, 200, labelJson(l)); return; }
      if (method === "PATCH") {
        if (data) {
          if (typeof data.name === "string" && data.name) l.name = data.name;
          if (typeof data.color === "string") l.color = data.color.replace(/^#/, "");
          if (typeof data.description !== "undefined") l.description = data.description;
        }
        send(res, 200, labelJson(l)); return;
      }
      if (method === "DELETE") { r.labels = r.labels.filter(x => x !== l); send(res, 204, null); return; }
      send(res, 404, { message: "Not Found" }); return;
    }

    if (section === "issues") {
      if (rest.length === 1) {
        if (method === "GET") {
          const state = (query.get("state") || "open").toLowerCase();
          const labelsFilter = (query.get("labels") || "").split(",").map(s => s.trim()).filter(Boolean);
          const sort = query.get("sort") || "created";
          const desc = (query.get("direction") || "desc").toLowerCase() !== "asc";
          let items = r.issues.slice();
          if (state !== "all") items = items.filter(i => i.state === state);
          for (const label of labelsFilter) items = items.filter(i => i.labels.indexOf(label) >= 0);
          items.sort((a, b) => {
            const av = sort === "updated" ? a.updatedAt : a.createdAt;
            const bv = sort === "updated" ? b.updatedAt : b.createdAt;
            if (av === bv) return desc ? b.number - a.number : a.number - b.number;
            return desc ? (av > bv ? -1 : 1) : (av < bv ? -1 : 1);
          });
          const perPage = Math.min(Math.max(parseInt(query.get("per_page") || "30", 10) || 30, 1), 100);
          const page = Math.max(parseInt(query.get("page") || "1", 10) || 1, 1);
          send(res, 200, items.slice((page - 1) * perPage, page * perPage).map(i => issueJson(r, i))); return;
        }
        if (method === "POST") {
          if (!data || typeof data.title !== "string" || !data.title) {
            send(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "title", code: "missing" }] }); return;
          }
          const made = createIssueInternal(r, data);
          if (made.error) { send(res, 422, made.error); return; }
          send(res, 201, issueJson(r, made.issue)); return;
        }
        send(res, 404, { message: "Not Found" }); return;
      }
      const number = parseInt(rest[1], 10);
      const issue = r.issues.find(i => i.number === number);
      if (!issue) { send(res, 404, { message: "Not Found" }); return; }
      if (rest.length === 2) {
        if (method === "GET") { send(res, 200, issueJson(r, issue)); return; }
        if (method === "PATCH") {
          if (data) {
            if (typeof data.title === "string" && data.title) issue.title = data.title;
            if (typeof data.body !== "undefined") issue.body = data.body;
            if (typeof data.state === "string") issue.state = data.state.toLowerCase() === "closed" ? "closed" : "open";
            if (typeof data.labels !== "undefined") {
              const names = validateLabels(r, data.labels);
              if (names === null) { send(res, 422, { message: "Validation Failed", errors: [{ resource: "Issue", field: "labels", code: "invalid" }] }); return; }
              issue.labels = names;
            }
          }
          issue.updatedAt = tick();
          send(res, 200, issueJson(r, issue)); return;
        }
        send(res, 404, { message: "Not Found" }); return;
      }
      if (rest[2] === "comments") {
        if (method === "GET") {
          const items = r.comments.filter(c => c.issueNumber === number);
          send(res, 200, items.map(c => ({
            id: c.id, node_id: nid("IssueComment", c.id), url: apiBase(r) + "/issues/comments/" + c.id,
            html_url: htmlBase(r) + "/issues/" + number + "#issuecomment-" + c.id,
            body: c.body, user: userJson(c.user), created_at: c.createdAt, updated_at: c.updatedAt,
            issue_url: apiBase(r) + "/issues/" + number, author_association: "OWNER"
          }))); return;
        }
        if (method === "POST") {
          if (!data || typeof data.body !== "string") { send(res, 422, { message: "Validation Failed" }); return; }
          const t = tick();
          const c = { id: idSeq++, issueNumber: number, body: data.body, user: r.owner, createdAt: t, updatedAt: t };
          r.comments.push(c);
          send(res, 201, {
            id: c.id, node_id: nid("IssueComment", c.id), url: apiBase(r) + "/issues/comments/" + c.id,
            html_url: htmlBase(r) + "/issues/" + number + "#issuecomment-" + c.id,
            body: c.body, user: userJson(c.user), created_at: c.createdAt, updated_at: c.updatedAt,
            issue_url: apiBase(r) + "/issues/" + number, author_association: "OWNER"
          }); return;
        }
        send(res, 404, { message: "Not Found" }); return;
      }
      if (rest[2] === "labels") {
        if (method === "GET") { send(res, 200, issue.labels.map(n => r.labels.find(l => l.name === n)).filter(Boolean).map(labelJson)); return; }
        if (method === "PUT") {
          const names = validateLabels(r, data && data.labels);
          if (names === null) { send(res, 422, { message: "Validation Failed" }); return; }
          issue.labels = names;
          send(res, 200, issue.labels.map(n => r.labels.find(l => l.name === n)).filter(Boolean).map(labelJson)); return;
        }
        if (method === "POST") {
          const incoming = data && (data.labels || (data.name ? [data.name] : []));
          const names = validateLabels(r, incoming);
          if (names === null) { send(res, 422, { message: "Validation Failed" }); return; }
          for (const n of names) if (issue.labels.indexOf(n) < 0) issue.labels.push(n);
          send(res, 200, issue.labels.map(n => r.labels.find(l => l.name === n)).filter(Boolean).map(labelJson)); return;
        }
        if (method === "DELETE") {
          if (rest.length > 3) {
            const n = decodeURIComponent(rest[3]);
            issue.labels = issue.labels.filter(x => x !== n);
          } else issue.labels = [];
          send(res, 200, issue.labels.map(n => r.labels.find(l => l.name === n)).filter(Boolean).map(labelJson)); return;
        }
        send(res, 404, { message: "Not Found" }); return;
      }
      send(res, 404, { message: "Not Found" }); return;
    }

    if (section === "pulls") {
      if (rest.length === 1) {
        if (method === "GET") {
          const state = (query.get("state") || "open").toLowerCase();
          let items = r.pulls.slice();
          if (state !== "all") items = items.filter(p => p.state === state || (state === "closed" && p.merged));
          send(res, 200, items.map(p => pullJson(r, p))); return;
        }
        if (method === "POST") {
          if (!data || typeof data.title !== "string" || !data.head || !data.base) {
            send(res, 422, { message: "Validation Failed" }); return;
          }
          const p = createPullInternal(r, data);
          send(res, 201, pullJson(r, p)); return;
        }
        send(res, 404, { message: "Not Found" }); return;
      }
      const number = parseInt(rest[1], 10);
      const p = r.pulls.find(x => x.number === number);
      if (!p) { send(res, 404, { message: "Not Found" }); return; }
      if (rest[2] === "merge" && method === "PUT") {
        const merged = mergePullInternal(r, p, data);
        if (merged.error) { send(res, merged.error.status, merged.error.body); return; }
        send(res, 200, merged); return;
      }
      if (rest.length === 2 && method === "GET") { send(res, 200, pullJson(r, p)); return; }
      if (rest.length === 2 && method === "PATCH") {
        if (data) {
          if (typeof data.title === "string" && data.title) p.title = data.title;
          if (typeof data.body !== "undefined") p.body = data.body;
          if (data.state === "closed") {
            p.state = "closed";
            p.updatedAt = tick();
            const issue = r.issues.find(i => i.number === p.number);
            if (issue) { issue.state = "closed"; issue.updatedAt = p.updatedAt; }
          }
        }
        send(res, 200, pullJson(r, p)); return;
      }
      if (rest[2] === "commits" && method === "GET") {
        const oid = r.refs.get("refs/heads/" + p.head);
        const m = oid ? r.commits.get(oid) : null;
        send(res, 200, m ? [commitJson(r, m)] : []); return;
      }
      send(res, 404, { message: "Not Found" }); return;
    }

    if (section === "branches") {
      if (method === "GET" && rest.length === 1) {
        send(res, 200, Array.from(r.refs.entries()).filter(([k]) => k.startsWith("refs/heads/"))
          .map(([k, v]) => branchJson(r, k.slice("refs/heads/".length), v))); return;
      }
      if (method === "GET" && rest.length === 2) {
        const name = rest.slice(1).map(decodeURIComponent).join("/");
        const oid = r.refs.get("refs/heads/" + name);
        if (!oid) { send(res, 404, { message: "Not Found" }); return; }
        const m = r.commits.get(oid);
        const b: any = branchJson(r, name, oid);
        if (m) b.commit = commitJson(r, m).commit && Object.assign(b.commit, { sha: oid, url: apiBase(r) + "/commits/" + oid });
        send(res, 200, b); return;
      }
      send(res, 404, { message: "Not Found" }); return;
    }

    if (section === "commits") {
      if (method === "GET" && rest.length === 1) {
        const sha = query.get("sha");
        const items = Array.from(r.commits.values()).filter(c => !sha || c.oid === sha);
        items.sort((a, b) => b.timestamp < a.timestamp ? -1 : b.timestamp > a.timestamp ? 1 : 0);
        send(res, 200, items.map(c => commitJson(r, c))); return;
      }
      if (method === "GET" && rest.length === 2) {
        const m = r.commits.get(rest[1]) || Array.from(r.commits.values()).find(c => c.oid.startsWith(rest[1]));
        if (!m) { send(res, 404, { message: "Not Found" }); return; }
        send(res, 200, commitJson(r, m)); return;
      }
      send(res, 404, { message: "Not Found" }); return;
    }

    send(res, 404, { message: "Not Found" });
  }

  function tokenize(q: string): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    while (i < q.length) {
      const c = q[i];
      if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === ",") { i++; continue; }
      if (c === "#") { while (i < q.length && q[i] !== "\n") i++; continue; }
      if (c === '"') {
        if (q.slice(i, i + 3) === '"""') {
          let j = i + 3;
          while (j < q.length && q.slice(j, j + 3) !== '"""') j++;
          out.push({ t: "STR", v: q.slice(i + 3, j) });
          i = j + 3;
        } else {
          let j = i + 1;
          let s = "";
          while (j < q.length && q[j] !== '"') {
            if (q[j] === "\\") {
              j++;
              const e = q[j];
              if (e === "n") s += "\n";
              else if (e === "t") s += "\t";
              else if (e === "u" && j + 4 < q.length) { s += String.fromCharCode(parseInt(q.slice(j + 1, j + 5), 16)); j += 4; }
              else s += e;
              j++;
            } else { s += q[j]; j++; }
          }
          out.push({ t: "STR", v: s });
          i = j + 1;
        }
        continue;
      }
      if (q.slice(i, i + 3) === "...") { out.push({ t: "...", v: "..." }); i += 3; continue; }
      if ("!$():=@[]{}|&".indexOf(c) >= 0) { out.push({ t: c, v: c }); i++; continue; }
      if (/[-0-9]/.test(c)) {
        let j = i;
        while (j < q.length && /[-0-9.eE+]/.test(q[j])) j++;
        out.push({ t: "NUM", v: q.slice(i, j) });
        i = j; continue;
      }
      if (/[_A-Za-z]/.test(c)) {
        let j = i;
        while (j < q.length && /[_A-Za-z0-9]/.test(q[j])) j++;
        out.push({ t: "NAME", v: q.slice(i, j) });
        i = j; continue;
      }
      i++;
    }
    out.push({ t: "EOF", v: "" });
    return out;
  }

  class GqlParser {
    toks: Tok[];
    pos: number;
    constructor(q: string) { this.toks = tokenize(q); this.pos = 0; }
    peek(t: string) { return this.toks[this.pos] && this.toks[this.pos].t === t; }
    name(v: string) { return this.peek("NAME") && this.toks[this.pos].v === v; }
    take(): Tok { return this.toks[this.pos++]; }
    expect(t: string): Tok {
      if (!this.peek(t)) return { t: "", v: "" };
      return this.take();
    }
    eof() { return this.peek("EOF"); }
    parseDocument() {
      const defs: any[] = [];
      while (!this.eof()) {
        if (this.name("fragment")) defs.push(this.parseFragment());
        else if (this.peek("{") || this.peek("NAME")) defs.push(this.parseOperation());
        else this.take();
      }
      return defs;
    }
    parseFragment() {
      this.take();
      const name = this.expect("NAME").v;
      this.expect("NAME");
      const type = this.expect("NAME").v;
      while (this.peek("@")) { this.take(); this.expect("NAME"); if (this.peek("(")) this.parseArgs(); }
      return { kind: "frag", name, type, sel: this.parseSelSet() };
    }
    parseOperation() {
      let op = "query";
      let name: string | null = null;
      if (this.peek("{")) return { kind: "op", op, name, vars: [], sel: this.parseSelSet() };
      if (this.peek("NAME")) {
        op = this.take().v;
        if (this.peek("NAME")) name = this.take().v;
      }
      const vars: any[] = [];
      if (this.peek("(")) {
        this.take();
        while (!this.peek(")") && !this.eof()) {
          this.expect("$");
          const vn = this.expect("NAME").v;
          this.expect(":");
          const type = this.parseType();
          let def: any = null;
          if (this.peek("=")) { this.take(); def = this.parseValue(); }
          while (this.peek("@")) { this.take(); this.expect("NAME"); if (this.peek("(")) this.parseArgs(); }
          vars.push({ name: vn, type, def });
        }
        this.expect(")");
      }
      while (this.peek("@")) { this.take(); this.expect("NAME"); if (this.peek("(")) this.parseArgs(); }
      return { kind: "op", op, name, vars, sel: this.parseSelSet() };
    }
    parseType(): string {
      let t = this.expect("NAME").v;
      if (this.peek("!")) { this.take(); t += "!"; }
      if (this.peek("[")) {
        this.take();
        t = "[" + this.parseType() + "]";
        if (this.peek("!")) { this.take(); t += "!"; }
      }
      return t;
    }
    parseArgs() {
      const args: any = {};
      this.expect("(");
      while (!this.peek(")") && !this.eof()) {
        const k = this.expect("NAME").v;
        this.expect(":");
        args[k] = this.parseValue();
      }
      this.expect(")");
      return args;
    }
    parseValue(): any {
      if (this.peek("$")) { this.take(); return { kind: "var", name: this.expect("NAME").v }; }
      const t = this.take();
      if (t.t === "STR") return { kind: "str", v: t.v };
      if (t.t === "NUM") return { kind: "num", v: Number(t.v) };
      if (t.t === "NAME") {
        if (t.v === "true") return { kind: "bool", v: true };
        if (t.v === "false") return { kind: "bool", v: false };
        if (t.v === "null") return { kind: "null", v: null };
        return { kind: "enum", v: t.v };
      }
      if (t.t === "[") {
        const list: any[] = [];
        while (!this.peek("]") && !this.eof()) list.push(this.parseValue());
        this.expect("]");
        return { kind: "list", v: list };
      }
      if (t.t === "{") {
        const obj: any = {};
        while (!this.peek("}") && !this.eof()) {
          const k = this.expect("NAME").v;
          this.expect(":");
          obj[k] = this.parseValue();
        }
        this.expect("}");
        return { kind: "obj", v: obj };
      }
      return { kind: "str", v: "" };
    }
    parseSelSet(): any[] {
      const sels: any[] = [];
      this.expect("{");
      while (!this.peek("}") && !this.eof()) {
        if (this.peek("...")) {
          this.take();
          if (this.name("on")) {
            this.take();
            const type = this.expect("NAME").v;
            sels.push({ kind: "inline", type, sel: this.parseSelSet() });
          } else if (this.peek("NAME")) {
            sels.push({ kind: "spread", name: this.take().v });
          } else {
            sels.push({ kind: "inline", type: null, sel: this.parseSelSet() });
          }
          continue;
        }
        let alias: string | null = null;
        if (this.peek("NAME") && this.toks[this.pos + 1] && this.toks[this.pos + 1].t === ":") {
          alias = this.take().v;
          this.take();
        }
        const name = this.expect("NAME").v;
        const args = this.peek("(") ? this.parseArgs() : {};
        while (this.peek("@")) {
          this.take();
          const dn = this.expect("NAME").v;
          const dargs = this.peek("(") ? this.parseArgs() : {};
          if (dn === "skip" || dn === "include") (args as any).__directive = { name: dn, args: dargs };
        }
        const sel = this.peek("{") ? this.parseSelSet() : null;
        sels.push({ kind: "field", alias: alias || name, name, args, sel });
      }
      this.expect("}");
      return sels;
    }
  }

  function valueOf(v: any, vars: any): any {
    if (!v) return null;
    if (v.kind === "var") return vars && Object.prototype.hasOwnProperty.call(vars, v.name) ? vars[v.name] : null;
    if (v.kind === "str" || v.kind === "num" || v.kind === "bool" || v.kind === "enum") return v.v;
    if (v.kind === "null") return null;
    if (v.kind === "list") return v.v.map((x: any) => valueOf(x, vars));
    if (v.kind === "obj") {
      const o: any = {};
      for (const k of Object.keys(v.v)) o[k] = valueOf(v.v[k], vars);
      return o;
    }
    return null;
  }
  function argsOf(raw: any, vars: any) {
    const out: any = {};
    for (const k of Object.keys(raw || {})) {
      if (k === "__directive") continue;
      out[k] = valueOf(raw[k], vars);
    }
    return out;
  }

  const GQL: any = {
    Query: { kind: "OBJECT", fields: [
      { name: "repository", args: [{ name: "owner", type: "String!" }, { name: "name", type: "String!" }], type: "Repository" },
      { name: "viewer", args: [], type: "User" },
      { name: "user", args: [{ name: "login", type: "String!" }], type: "User" },
      { name: "node", args: [{ name: "id", type: "ID!" }], type: "Node" },
      { name: "search", args: [{ name: "query", type: "String!" }, { name: "type", type: "SearchType" }, { name: "first", type: "Int" }], type: "SearchResultItemConnection" }
    ] },
    Mutation: { kind: "OBJECT", fields: [
      { name: "createPullRequest", args: [{ name: "input", type: "CreatePullRequestInput!" }], type: "CreatePullRequestPayload" },
      { name: "createIssue", args: [{ name: "input", type: "CreateIssueInput!" }], type: "CreateIssuePayload" }
    ] },
    Repository: { kind: "OBJECT", fields: [
      { name: "id", args: [], type: "ID!" }, { name: "name", args: [], type: "String!" },
      { name: "nameWithOwner", args: [], type: "String!" }, { name: "description", args: [], type: "String" },
      { name: "url", args: [], type: "URI!" }, { name: "isPrivate", args: [], type: "Boolean!" },
      { name: "defaultBranchRef", args: [], type: "Ref" },
      { name: "issues", args: [{ name: "states", type: "[IssueState!]" }, { name: "orderBy", type: "IssueOrder" }, { name: "first", type: "Int" }, { name: "labels", type: "[String!]" }], type: "IssueConnection" },
      { name: "issue", args: [{ name: "number", type: "Int!" }], type: "Issue" },
      { name: "pullRequests", args: [{ name: "states", type: "[PullRequestState!]" }, { name: "orderBy", type: "IssueOrder" }, { name: "first", type: "Int" }], type: "PullRequestConnection" },
      { name: "pullRequest", args: [{ name: "number", type: "Int!" }], type: "PullRequest" },
      { name: "labels", args: [{ name: "first", type: "Int" }], type: "LabelConnection" }
    ] },
    Issue: { kind: "OBJECT", fields: [
      { name: "id", args: [], type: "ID!" }, { name: "number", args: [], type: "Int!" },
      { name: "title", args: [], type: "String!" }, { name: "body", args: [], type: "String" },
      { name: "state", args: [], type: "IssueState!" }, { name: "url", args: [], type: "URI!" },
      { name: "createdAt", args: [], type: "DateTime!" }, { name: "updatedAt", args: [], type: "DateTime!" },
      { name: "author", args: [], type: "Actor" }, { name: "labels", args: [{ name: "first", type: "Int" }], type: "LabelConnection" }
    ] },
    PullRequest: { kind: "OBJECT", fields: [
      { name: "id", args: [], type: "ID!" }, { name: "number", args: [], type: "Int!" },
      { name: "title", args: [], type: "String!" }, { name: "body", args: [], type: "String" },
      { name: "state", args: [], type: "PullRequestState!" }, { name: "merged", args: [], type: "Boolean!" },
      { name: "mergedAt", args: [], type: "DateTime" }, { name: "url", args: [], type: "URI!" },
      { name: "headRefName", args: [], type: "String!" }, { name: "baseRefName", args: [], type: "String!" },
      { name: "createdAt", args: [], type: "DateTime!" }, { name: "updatedAt", args: [], type: "DateTime!" },
      { name: "author", args: [], type: "Actor" }, { name: "labels", args: [{ name: "first", type: "Int" }], type: "LabelConnection" }
    ] },
    Label: { kind: "OBJECT", fields: [
      { name: "id", args: [], type: "ID!" }, { name: "name", args: [], type: "String!" },
      { name: "color", args: [], type: "String!" }, { name: "description", args: [], type: "String" }
    ] },
    User: { kind: "OBJECT", fields: [
      { name: "id", args: [], type: "ID!" }, { name: "login", args: [], type: "String!" },
      { name: "name", args: [], type: "String" }, { name: "url", args: [], type: "URI!" }
    ] },
    Ref: { kind: "OBJECT", fields: [{ name: "name", args: [], type: "String!" }, { name: "target", args: [], type: "Commit" }] },
    Commit: { kind: "OBJECT", fields: [{ name: "oid", args: [], type: "GitObjectID!" }, { name: "message", args: [], type: "String" }] },
    IssueConnection: { kind: "OBJECT", fields: [
      { name: "totalCount", args: [], type: "Int!" }, { name: "nodes", args: [], type: "[Issue]" },
      { name: "edges", args: [], type: "[IssueEdge]" }, { name: "pageInfo", args: [], type: "PageInfo!" }
    ] },
    IssueEdge: { kind: "OBJECT", fields: [{ name: "node", args: [], type: "Issue" }, { name: "cursor", args: [], type: "String!" }] },
    PullRequestConnection: { kind: "OBJECT", fields: [
      { name: "totalCount", args: [], type: "Int!" }, { name: "nodes", args: [], type: "[PullRequest]" },
      { name: "edges", args: [], type: "[PullRequestEdge]" }, { name: "pageInfo", args: [], type: "PageInfo!" }
    ] },
    PullRequestEdge: { kind: "OBJECT", fields: [{ name: "node", args: [], type: "PullRequest" }, { name: "cursor", args: [], type: "String!" }] },
    LabelConnection: { kind: "OBJECT", fields: [{ name: "totalCount", args: [], type: "Int!" }, { name: "nodes", args: [], type: "[Label]" }, { name: "edges", args: [], type: "[LabelEdge]" }] },
    LabelEdge: { kind: "OBJECT", fields: [{ name: "node", args: [], type: "Label" }, { name: "cursor", args: [], type: "String!" }] },
    PageInfo: { kind: "OBJECT", fields: [
      { name: "hasNextPage", args: [], type: "Boolean!" }, { name: "hasPreviousPage", args: [], type: "Boolean!" },
      { name: "startCursor", args: [], type: "String" }, { name: "endCursor", args: [], type: "String" }
    ] },
    SearchResultItemConnection: { kind: "OBJECT", fields: [
      { name: "issueCount", args: [], type: "Int!" }, { name: "nodes", args: [], type: "[SearchResultItem]" },
      { name: "edges", args: [], type: "[SearchResultItemEdge]" }
    ] },
    SearchResultItemEdge: { kind: "OBJECT", fields: [{ name: "node", args: [], type: "SearchResultItem" }] },
    CreatePullRequestPayload: { kind: "OBJECT", fields: [
      { name: "clientMutationId", args: [], type: "String" }, { name: "pullRequest", args: [], type: "PullRequest" }
    ] },
    CreateIssuePayload: { kind: "OBJECT", fields: [
      { name: "clientMutationId", args: [], type: "String" }, { name: "issue", args: [], type: "Issue" }
    ] },
    CreatePullRequestInput: { kind: "INPUT_OBJECT", inputFields: [
      { name: "repositoryId", type: "ID!" }, { name: "title", type: "String!" }, { name: "head", type: "String!" },
      { name: "base", type: "String!" }, { name: "body", type: "String" }, { name: "clientMutationId", type: "String" }
    ] },
    CreateIssueInput: { kind: "INPUT_OBJECT", inputFields: [
      { name: "repositoryId", type: "ID!" }, { name: "title", type: "String!" }, { name: "body", type: "String" },
      { name: "clientMutationId", type: "String" }
    ] },
    SearchType: { kind: "ENUM", enumValues: [{ name: "ISSUE" }, { name: "REPOSITORY" }, { name: "USER" }, { name: "WIKI" }] },
    IssueState: { kind: "ENUM", enumValues: [{ name: "OPEN" }, { name: "CLOSED" }] },
    PullRequestState: { kind: "ENUM", enumValues: [{ name: "OPEN" }, { name: "CLOSED" }, { name: "MERGED" }] },
    IssueOrderField: { kind: "ENUM", enumValues: [{ name: "CREATED_AT" }, { name: "UPDATED_AT" }, { name: "COMMENTS" }] },
    OrderDirection: { kind: "ENUM", enumValues: [{ name: "ASC" }, { name: "DESC" }] },
    IssueOrder: { kind: "INPUT_OBJECT", inputFields: [{ name: "field", type: "IssueOrderField!" }, { name: "direction", type: "OrderDirection!" }] },
    Node: { kind: "INTERFACE", fields: [{ name: "id", args: [], type: "ID!" }] },
    Actor: { kind: "INTERFACE", fields: [{ name: "login", args: [], type: "String!" }] },
    SearchResultItem: { kind: "UNION", possibleTypes: ["Issue", "PullRequest", "Repository", "User"] },
    String: { kind: "SCALAR" }, ID: { kind: "SCALAR" }, Int: { kind: "SCALAR" }, Boolean: { kind: "SCALAR" },
    DateTime: { kind: "SCALAR" }, URI: { kind: "SCALAR" }, GitObjectID: { kind: "SCALAR" }
  };

  function mkType(kind: string, name: any, ofType: any) {
    const t: any = { __typename: "__Type", kind, name: name || null, description: null };
    t.__resolvers = {
      kind: () => kind,
      name: () => name || null,
      description: () => null,
      fields: () => (kind === "OBJECT" || kind === "INTERFACE") && GQL[name] ? (GQL[name].fields || []).map(fieldNode) : null,
      inputFields: () => kind === "INPUT_OBJECT" && GQL[name] ? (GQL[name].inputFields || []).map(inputNode) : null,
      interfaces: () => [],
      possibleTypes: () => kind === "UNION" && GQL[name] && GQL[name].possibleTypes ? GQL[name].possibleTypes.map(typeDesc) : null,
      enumValues: () => kind === "ENUM" && GQL[name] && GQL[name].enumValues ? GQL[name].enumValues.map((e: any) => ({
        __typename: "__EnumValue", name: e.name, description: null, isDeprecated: false, deprecationReason: null
      })) : null,
      ofType: () => ofType || null,
      specifiedByURL: () => null
    };
    t.__childTypes = { fields: "__Field", inputFields: "__InputValue", enumValues: "__EnumValue", ofType: "__Type", interfaces: "__Type", possibleTypes: "__Type" };
    return t;
  }
  function typeDesc(name: string) {
    const def = GQL[name];
    return mkType(def && def.kind ? def.kind : "SCALAR", name, null);
  }
  function typeRef(s: string) {
    s = String(s || "").trim();
    if (s.endsWith("!")) return mkType("NON_NULL", null, typeRef(s.slice(0, -1)));
    if (s.startsWith("[") && s.endsWith("]")) return mkType("LIST", null, typeRef(s.slice(1, -1)));
    const def = GQL[s];
    return mkType(def && def.kind ? def.kind : "SCALAR", s, null);
  }
  function inputNode(v: any) {
    return {
      __typename: "__InputValue", name: v.name, description: null, defaultValue: null,
      isDeprecated: false, deprecationReason: null, type: typeRef(v.type),
      __childTypes: { type: "__Type" }
    };
  }
  function fieldNode(f: any) {
    return {
      __typename: "__Field", name: f.name, description: null, isDeprecated: false, deprecationReason: null,
      args: (f.args || []).map(inputNode), type: typeRef(f.type),
      __childTypes: { args: "__InputValue", type: "__Type" }
    };
  }
  function schemaNode() {
    return {
      __typename: "__Schema",
      queryType: { name: "Query" }, mutationType: { name: "Mutation" }, subscriptionType: null,
      types: Object.keys(GQL).map(typeDesc),
      directives: [
        { __typename: "__Directive", name: "include", description: null, locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"], isRepeatable: false, args: [inputNode({ name: "if", type: "Boolean!" })] },
        { __typename: "__Directive", name: "skip", description: null, locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"], isRepeatable: false, args: [inputNode({ name: "if", type: "Boolean!" })] }
      ],
      __childTypes: { types: "__Type", directives: "__Directive", queryType: "__Type", mutationType: "__Type", subscriptionType: "__Type" }
    };
  }

  function userNode(login: string = viewerLogin()) {
    const id = hashInt(login);
    return { __typename: "User", id: nid("User", id), login, name: login, url: "https://github.com/" + login };
  }
  function labelConnection(r: Repo, names: string[]) {
    const nodes = names.map(n => r.labels.find(l => l.name === n)).filter(Boolean).map(l => ({
      __typename: "Label", id: nid("Label", l.id), name: l.name, color: l.color, description: l.description
    }));
    return {
      __typename: "LabelConnection", totalCount: nodes.length, nodes,
      edges: nodes.map(n => ({ node: n, cursor: Buffer.from(String(n.name)).toString("base64url") })),
      __childTypes: { nodes: "Label", edges: "LabelEdge" }
    };
  }
  function pageInfo() {
    return { __typename: "PageInfo", hasNextPage: false, hasPreviousPage: false, startCursor: "", endCursor: "" };
  }
  function applyOrder(items: any[], orderBy: any, timeOf: (x: any) => string) {
    const field = orderBy && orderBy.field ? String(orderBy.field) : "CREATED_AT";
    const dir = orderBy && orderBy.direction ? String(orderBy.direction).toUpperCase() : "DESC";
    const value = (x: any) => {
      if (field === "UPDATED_AT") return x.updatedAt || timeOf(x);
      if (field === "COMMENTS") return 0;
      if (field === "NUMBER") return x.number;
      return timeOf(x);
    };
    items.sort((a, b) => {
      const av = value(a), bv = value(b);
      let c = 0;
      if (typeof av === "number" && typeof bv === "number") c = av - bv;
      else c = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      if (!c) c = a.number - b.number;
      return dir === "ASC" ? c : -c;
    });
    return items;
  }
  function issueConnection(r: Repo, args: any) {
    let items = r.issues.slice();
    if (args.states) {
      const states = Array.isArray(args.states) ? args.states : [args.states];
      items = items.filter(i => states.map((s: any) => String(s).toUpperCase()).indexOf(i.state.toUpperCase()) >= 0);
    }
    if (args.labels) {
      const labels = Array.isArray(args.labels) ? args.labels : [args.labels];
      for (const l of labels) items = items.filter(i => i.labels.indexOf(String(l)) >= 0);
    }
    applyOrder(items, args.orderBy, (x: any) => x.createdAt);
    if (args.first) items = items.slice(0, Math.max(0, Number(args.first)));
    const nodes = items.map(i => issueNode(r, i));
    return {
      __typename: "IssueConnection", totalCount: nodes.length, nodes,
      edges: nodes.map(n => ({ __typename: "IssueEdge", node: n, cursor: String(n.number) })),
      pageInfo: pageInfo(),
      __childTypes: { nodes: "Issue", edges: "IssueEdge", pageInfo: "PageInfo" }
    };
  }
  function pullConnection(r: Repo, args: any) {
    let items = r.pulls.slice();
    if (args.states) {
      const states = Array.isArray(args.states) ? args.states : [args.states];
      items = items.filter(p => states.map((s: any) => String(s).toUpperCase()).some((s: string) =>
        s === p.state.toUpperCase() || (s === "MERGED" && p.merged)));
    }
    applyOrder(items, args.orderBy, (x: any) => x.createdAt);
    if (args.first) items = items.slice(0, Math.max(0, Number(args.first)));
    const nodes = items.map(p => pullNode(r, p));
    return {
      __typename: "PullRequestConnection", totalCount: nodes.length, nodes,
      edges: nodes.map(n => ({ __typename: "PullRequestEdge", node: n, cursor: String(n.number) })),
      pageInfo: pageInfo(),
      __childTypes: { nodes: "PullRequest", edges: "PullRequestEdge", pageInfo: "PageInfo" }
    };
  }
  function issueNode(r: Repo, i: any) {
    return {
      __typename: "Issue", id: nid("Issue", i.id), number: i.number, title: i.title, body: i.body,
      state: i.state.toUpperCase(), url: htmlBase(r) + "/issues/" + i.number,
      createdAt: i.createdAt, updatedAt: i.updatedAt,
      author: userNode(i.user || r.owner), labels: labelConnection(r, i.labels),
      __childTypes: { labels: "LabelConnection", author: "User" }
    };
  }
  function pullNode(r: Repo, p: any) {
    return {
      __typename: "PullRequest", id: nid("PullRequest", p.id), number: p.number, title: p.title, body: p.body,
      state: p.merged ? "MERGED" : p.state.toUpperCase(), merged: !!p.merged, mergedAt: p.mergedAt,
      url: htmlBase(r) + "/pull/" + p.number, headRefName: p.head, baseRefName: p.base,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
      author: userNode(r.owner), labels: labelConnection(r, []),
      __childTypes: { labels: "LabelConnection", author: "User" }
    };
  }
  function repositoryNode(r: Repo) {
    return {
      __typename: "Repository", id: r.nodeId, name: r.name, nameWithOwner: r.fullName,
      description: r.description, url: htmlBase(r), isPrivate: !!r.private,
      __childTypes: { issues: "IssueConnection", issue: "Issue", pullRequests: "PullRequestConnection", pullRequest: "PullRequest", labels: "LabelConnection", defaultBranchRef: "Ref" },
      __resolvers: {
        id: () => r.nodeId,
        name: () => r.name,
        nameWithOwner: () => r.fullName,
        description: () => r.description,
        url: () => htmlBase(r),
        isPrivate: () => !!r.private,
        defaultBranchRef: () => ({
          __typename: "Ref", name: r.defaultBranch,
          target: { __typename: "Commit", oid: r.refs.get("refs/heads/" + r.defaultBranch) || ZERO, message: "" },
          __childTypes: { target: "Commit" }
        }),
        issues: (src: any, args: any) => issueConnection(r, args),
        issue: (src: any, args: any) => { const i = r.issues.find(x => x.number === Number(args.number)); return i ? issueNode(r, i) : null; },
        pullRequests: (src: any, args: any) => pullConnection(r, args),
        pullRequest: (src: any, args: any) => { const p = r.pulls.find(x => x.number === Number(args.number)); return p ? pullNode(r, p) : null; },
        labels: () => labelConnection(r, r.labels.map(l => l.name))
      }
    };
  }
  function resolveRepoInput(input: any): Repo | null {
    if (!input) return null;
    if (input.repositoryId) {
      const decoded = Buffer.from(String(input.repositoryId), "base64url").toString("utf8");
      const m = decoded.match(/Repository-(\d+)/);
      if (m) { const rr = repoById(m[1]); if (rr) return rr; }
      const rr2 = repoById(String(input.repositoryId));
      if (rr2) return rr2;
      if (String(input.repositoryId).indexOf("/") > 0) {
        const parts = String(input.repositoryId).split("/");
        return findRepo(parts[0], parts[1]);
      }
    }
    if (input.owner && (input.name || input.repo)) return findRepo(input.owner, input.name || input.repo);
    if (input.nameWithOwner) { const parts = String(input.nameWithOwner).split("/"); return findRepo(parts[0], parts[1]); }
    return null;
  }
  function searchConnection(args: any) {
    const q = String(args.query || "").toLowerCase();
    let nodes: any[] = [];
    const type = args.type ? String(args.type).toUpperCase() : "ISSUE";
    if (type === "REPOSITORY") nodes = Array.from(repos.values()).filter(r => r.fullName.toLowerCase().indexOf(q) >= 0).map(repositoryNode);
    else if (type === "USER") nodes = [userNode(viewerLogin())].filter(u => u.login.toLowerCase().indexOf(q) >= 0);
    else {
      for (const r of repos.values()) {
        for (const i of r.issues) if ((i.title + " " + i.body).toLowerCase().indexOf(q) >= 0) nodes.push(issueNode(r, i));
        for (const p of r.pulls) if ((p.title + " " + p.body).toLowerCase().indexOf(q) >= 0) nodes.push(pullNode(r, p));
      }
    }
    if (args.first) nodes = nodes.slice(0, Math.max(0, Number(args.first)));
    return {
      __typename: "SearchResultItemConnection", issueCount: nodes.length, nodes,
      edges: nodes.map(n => ({ __typename: "SearchResultItemEdge", node: n })),
      __childTypes: { nodes: null, edges: "SearchResultItemEdge" }
    };
  }

  const queryResolvers: any = {
    repository: (src: any, args: any) => { const r = findRepo(String(args.owner || ""), String(args.name || "")); return r ? repositoryNode(r) : null; },
    viewer: () => userNode(viewerLogin()),
    user: (src: any, args: any) => userNode(String(args.login || viewerLogin())),
    node: (src: any, args: any) => {
      const decoded = Buffer.from(String(args.id || ""), "base64url").toString("utf8");
      let m = decoded.match(/Repository-(\d+)/);
      if (m) { const r = repoById(m[1]); return r ? repositoryNode(r) : null; }
      m = decoded.match(/Issue-(\d+)/);
      if (m) for (const r of repos.values()) { const i = r.issues.find(x => x.id === Number(m![1])); if (i) return issueNode(r, i); }
      m = decoded.match(/PullRequest-(\d+)/);
      if (m) for (const r of repos.values()) { const p = r.pulls.find(x => x.id === Number(m![1])); if (p) return pullNode(r, p); }
      return null;
    },
    search: (src: any, args: any) => searchConnection(args)
  };
  const mutationResolvers: any = {
    createPullRequest: (src: any, args: any) => {
      const input = args.input || {};
      const r = resolveRepoInput(input);
      const p = r ? createPullInternal(r, { title: input.title, body: input.body, head: input.head || input.headRefName, base: input.base || input.baseRefName }) : null;
      return { clientMutationId: input.clientMutationId || null, pullRequest: r && p ? pullNode(r, p) : null };
    },
    createIssue: (src: any, args: any) => {
      const input = args.input || {};
      const r = resolveRepoInput(input);
      const made = r ? createIssueInternal(r, { title: input.title, body: input.body }) : null;
      return { clientMutationId: input.clientMutationId || null, issue: r && made && made.issue ? issueNode(r, made.issue) : null };
    }
  };

  function expandSel(sel: any[], typename: string, fragments: any, visited: Set<string>): any[] {
    const out: any[] = [];
    for (const s of sel) {
      if (s.kind === "field") out.push(s);
      else if (s.kind === "inline") { if (!s.type || s.type === typename) out.push(...expandSel(s.sel, typename, fragments, visited)); }
      else if (s.kind === "spread") {
        const frag = fragments[s.name];
        if (frag && !visited.has(s.name)) {
          visited.add(s.name);
          if (!frag.type || frag.type === typename) out.push(...expandSel(frag.sel, typename, fragments, visited));
        }
      }
    }
    return out;
  }
  function executeSel(sel: any[], value: any, ctx: any, errors: any[], tname: string): any {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(v => executeSel(sel, v, ctx, errors, tname));
    const out: any = {};
    const typename = (value && value.__typename) || tname;
    const fields = expandSel(sel, typename, ctx.fragments || {}, new Set());
    for (const f of fields) {
      const dir = f.args && f.args.__directive;
      if (dir) {
        const cond = valueOf(dir.args.if, ctx.vars);
        if ((dir.name === "skip" && cond) || (dir.name === "include" && !cond)) continue;
      }
      if (f.name === "__typename") { out[f.alias] = typename; continue; }
      if (f.name === "__schema" && typename === "Query") {
        const value2 = schemaNode();
        out[f.alias] = f.sel ? executeSel(f.sel, value2, ctx, errors, "__Schema") : value2;
        continue;
      }
      if (f.name === "__type" && typename === "Query") {
        const name = argsOf(f.args, ctx.vars).name;
        const td = GQL[name] ? typeDesc(String(name)) : null;
        out[f.alias] = f.sel && td ? executeSel(f.sel, td, ctx, errors, "__Type") : td;
        continue;
      }
      let raw: any;
      if (value.__resolvers && Object.prototype.hasOwnProperty.call(value.__resolvers, f.name)) {
        raw = value.__resolvers[f.name](value, argsOf(f.args, ctx.vars), ctx);
      } else if (Object.prototype.hasOwnProperty.call(value, f.name)) {
        const v = value[f.name];
        raw = typeof v === "function" ? v() : v;
      } else {
        errors.push({ message: 'Cannot query field "' + f.name + '" on type "' + typename + '".', locations: [{ line: 1, column: 1 }] });
        continue;
      }
      if (f.sel) {
        const childType = (value.__childTypes && value.__childTypes[f.name]) || (raw && raw.__typename) || "";
        out[f.alias] = executeSel(f.sel, raw, ctx, errors, childType);
      } else out[f.alias] = raw;
    }
    return out;
  }

  async function handleGraphql(req: any, res: any, body: Buffer) {
    if (!authed(req)) { send(res, 401, { message: "Requires authentication" }); return; }
    let payload = parseJson(body);
    if (!payload) payload = { query: "" };
    const isArray = Array.isArray(payload);
    const items: any[] = isArray ? payload : [payload];
    const results: any[] = [];
    for (const item of items) {
      const parser = new GqlParser(String(item.query || ""));
      const defs = parser.parseDocument();
      const fragments: any = {};
      for (const d of defs) if (d.kind === "frag") fragments[d.name] = d;
      let ops = defs.filter(d => d.kind === "op");
      if (item.operationName) {
        const selected = ops.filter(o => o.name === item.operationName);
        if (selected.length) ops = selected;
      }
      const errors: any[] = [];
      const data: any = {};
      for (const op of ops) {
        const ctx: any = { vars: {}, fragments };
        const provided = item.variables || {};
        for (const v of op.vars) {
          ctx.vars[v.name] = Object.prototype.hasOwnProperty.call(provided, v.name) ? provided[v.name] : (v.def ? valueOf(v.def, {}) : null);
        }
        const isMut = op.op === "mutation";
        const root = { __typename: isMut ? "Mutation" : "Query", __resolvers: isMut ? mutationResolvers : queryResolvers, __childTypes: {} };
        const part = executeSel(op.sel, root, ctx, errors, isMut ? "Mutation" : "Query");
        for (const k of Object.keys(part || {})) data[k] = part[k];
      }
      const result: any = { data };
      if (errors.length) result.errors = errors;
      results.push(result);
    }
    send(res, 200, isArray ? results : results[0]);
  }

  const TOOLS = [
    { name: "create_repo", description: "Create a new repository", inputSchema: { type: "object", properties: { owner: { type: "string" }, name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" } }, required: ["name"] } },
    { name: "get_repo", description: "Get a repository", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, name: { type: "string" } }, required: ["repo"] } },
    { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } } }, required: ["repo", "title"] } },
    { name: "list_issues", description: "List issues", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["repo"] } },
    { name: "create_pull_request", description: "Create a pull request", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, head: { type: "string" }, base: { type: "string" }, body: { type: "string" } }, required: ["repo", "title", "head", "base"] } },
    { name: "merge_pull_request", description: "Merge a pull request", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "integer" }, commit_title: { type: "string" } }, required: ["repo", "pull_number"] } }
  ];
  const REQUIRED_ARGS: any = {
    create_repo: ["name"], get_repo: ["repo"], create_issue: ["repo", "title"],
    list_issues: ["repo"], create_pull_request: ["repo", "title", "head", "base"], merge_pull_request: ["repo", "pull_number"]
  };

  function rpcError(id: any, code: number, message: string) {
    return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
  }
  function toolResult(id: any, value: any, isError?: boolean) {
    const result: any = { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
    if (isError) result.isError = true;
    return { jsonrpc: "2.0", id, result };
  }

  function callTool(name: string, args: any) {
    const owner = String(args.owner || viewerLogin());
    const repoName = String(args.repo || args.name || "");
    const r = findRepo(owner, repoName);
    if (name === "create_repo") {
      const created = makeRepo(owner, String(args.name), args);
      return created ? repoJson(created) : { message: "Repository already exists" };
    }
    if (!r) return { error: "Repository not found" };
    if (name === "get_repo") return repoJson(r);
    if (name === "create_issue") {
      const made = createIssueInternal(r, { title: args.title, body: args.body, labels: args.labels });
      return made.error ? made.error : issueJson(r, made.issue);
    }
    if (name === "list_issues") {
      const state = String(args.state || "open").toLowerCase();
      return r.issues.filter(i => state === "all" || i.state === state).map(i => issueJson(r, i));
    }
    if (name === "create_pull_request") {
      const p = createPullInternal(r, { title: args.title, body: args.body, head: args.head, base: args.base });
      return pullJson(r, p);
    }
    if (name === "merge_pull_request") {
      const num = Number(args.pull_number);
      const p = r.pulls.find(x => x.number === num);
      if (!p) return { message: "Pull request not found" };
      const merged = mergePullInternal(r, p, args);
      return merged.error ? merged.error.body : merged;
    }
    return { error: "Unknown tool" };
  }

  async function handleMcp(req: any, res: any, body: Buffer) {
    if (!authed(req)) { send(res, 401, { message: "Unauthorized" }); return; }
    let msg: any;
    try { msg = JSON.parse(body.toString("utf8")); }
    catch { send(res, 400, rpcError(null, -32700, "Parse error")); return; }

    if (Array.isArray(msg)) {
      const results: any[] = [];
      for (const m of msg) {
        const one = handleMcpMessage(m, req, res);
        if (one === null) continue;
        results.push(one);
      }
      if (results.length === 0) { res.writeHead(202); res.end(); return; }
      send(res, 200, results); return;
    }
    const one = handleMcpMessage(msg, req, res);
    if (one === null) { res.writeHead(202); res.end(); return; }
    send(res, 200, one);
  }

  function handleMcpMessage(msg: any, req: any, res: any) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return rpcError(msg && msg.id, -32600, "Invalid Request");
    const id = msg.id === undefined ? null : msg.id;
    const method = String(msg.method || "");
    if (method.indexOf("notifications/") === 0) return null;
    if (method === "initialize") {
      res.setHeader("Mcp-Session-Id", "makefun-session-1");
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "makefun-github-core", version: "1.0.0" }
      } };
    }
    if (method === "server/discover") {
      return { jsonrpc: "2.0", id, result: {
        name: "makefun-github-core", version: "1.0.0",
        protocolVersion: "2025-03-26", tools: TOOLS.map(t => t.name), capabilities: { tools: { listChanged: false } }
      } };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (method === "tools/call") {
      const params = msg.params || {};
      const name = String(params.name || "");
      const args = params.arguments || {};
      const known = TOOLS.some(t => t.name === name);
      if (!known) return rpcError(id, -32601, "Unknown tool: " + name);
      for (const key of REQUIRED_ARGS[name] || []) {
        if (args[key] === undefined || args[key] === null || args[key] === "") {
          return toolResult(id, "missing required argument: " + key, true);
        }
      }
      const out = callTool(name, args);
      if (out && out.error && (out.error === "Unknown tool" || out.error === "Repository not found")) return rpcError(id, -32602, String(out.error));
      return toolResult(id, out);
    }
    if (method === "ping" || method === "server/ping") return { jsonrpc: "2.0", id, result: {} };
    return rpcError(id, -32601, "Method not found: " + method);
  }

  function pktLine(s: string) {
    const b = Buffer.from(s, "utf8");
    const len = b.length + 4;
    return Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0")), b]);
  }
  function pktBuf(b: Buffer) {
    const len = b.length + 4;
    return Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0")), b]);
  }
  const PKT_FLUSH = Buffer.from("0000");
  const PKT_DELIM = Buffer.from("0001");

  function parsePkt(buf: Buffer, start?: number) {
    const lines: Pkt[] = [];
    let pos = start || 0;
    while (pos + 4 <= buf.length) {
      const raw = buf.slice(pos, pos + 4).toString("ascii");
      if (raw === "0000") { lines.push({ data: Buffer.alloc(0), flush: true, delim: false, end: pos + 4 }); pos += 4; continue; }
      if (raw === "0001") { lines.push({ data: Buffer.alloc(0), flush: false, delim: true, end: pos + 4 }); pos += 4; continue; }
      if (!/^[0-9a-fA-F]{4}$/.test(raw)) break;
      const len = parseInt(raw, 16);
      if (len < 4 || pos + len > buf.length) break;
      lines.push({ data: buf.slice(pos + 4, pos + len), flush: false, delim: false, end: pos + len });
      pos += len;
    }
    return lines;
  }

  function packHeader(type: number, size: number) {
    const bytes: number[] = [];
    let s = size;
    let c = (type << 4) | (s & 0x0f);
    s = Math.floor(s / 16);
    while (s > 0) {
      c |= 0x80;
      bytes.push(c);
      c = s & 0x7f;
      s = Math.floor(s / 128);
    }
    bytes.push(c);
    return Buffer.from(bytes);
  }
  function uint32(n: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
  }
  function buildPack(objs: GitObj[]) {
    const chunks: Buffer[] = [Buffer.from("PACK"), uint32(2), uint32(objs.length)];
    const typeNum: any = { commit: 1, tree: 2, blob: 3, tag: 4 };
    for (const o of objs) {
      const t = typeNum[o.type] || 3;
      chunks.push(packHeader(t, o.content.length));
      chunks.push(deflateSync(o.content));
    }
    const body = Buffer.concat(chunks);
    const sum = createHash("sha1").update(body).digest();
    return Buffer.concat([body, sum]);
  }
  function sideBand(pack: Buffer) {
    const out: Buffer[] = [];
    const chunkSize = 65515;
    for (let i = 0; i < pack.length; i += chunkSize) {
      const chunk = pack.subarray(i, i + chunkSize);
      out.push(pktBuf(Buffer.concat([Buffer.from([1]), chunk])));
    }
    out.push(PKT_FLUSH);
    return out;
  }
  function sideLine(s: string) { return pktBuf(Buffer.concat([Buffer.from([1]), Buffer.from(s, "utf8")])); }

  function inflateAt(buf: Buffer, start: number, expected: number) {
    for (let end = start + 1; end <= buf.length; end++) {
      try {
        const d = inflateSync(buf.subarray(start, end));
        if (d.length >= expected) return { data: d.subarray(0, expected), pos: end };
      } catch {}
    }
    return { data: Buffer.alloc(0), pos: Math.min(start + 1, buf.length) };
  }
  function readOfsDelta(buf: Buffer, pos: number) {
    let c = buf[pos++];
    let v = c & 0x7f;
    while (c & 0x80) { c = buf[pos++]; v = ((v + 1) << 7) | (c & 0x7f); }
    return { v, pos };
  }
  function readVar(buf: Buffer, pos: number) {
    let v = 0, shift = 0, c = 0;
    do { c = buf[pos++]; v |= (c & 0x7f) << shift; shift += 7; } while (c & 0x80);
    return { v, pos };
  }
  function applyDelta(base: Buffer, delta: Buffer) {
    let pos = 0;
    const bs = readVar(delta, pos); pos = bs.pos;
    const rs = readVar(delta, pos); pos = rs.pos;
    const out: Buffer[] = [];
    while (pos < delta.length) {
      const op = delta[pos++];
      if (op & 0x80) {
        let off = 0, size = 0;
        if (op & 0x01) off = delta[pos++];
        if (op & 0x02) off |= delta[pos++] << 8;
        if (op & 0x04) off |= delta[pos++] << 16;
        if (op & 0x08) off |= delta[pos++] << 24;
        if (op & 0x10) size = delta[pos++];
        if (op & 0x20) size |= delta[pos++] << 8;
        if (op & 0x40) size |= delta[pos++] << 16;
        if (size === 0) size = 0x10000;
        out.push(base.subarray(off, off + size));
      } else if (op !== 0) {
        out.push(delta.subarray(pos, pos + op));
        pos += op;
      }
    }
    return Buffer.concat(out);
  }
  function treeEntries(content: Buffer) {
    const entries: any[] = [];
    let pos = 0;
    while (pos < content.length) {
      const space = content.indexOf(0x20, pos);
      if (space < 0) break;
      const mode = content.slice(pos, space).toString("ascii");
      const nul = content.indexOf(0, space + 1);
      if (nul < 0) break;
      const name = content.slice(space + 1, nul).toString("utf8");
      const oid = content.slice(nul + 1, nul + 21).toString("hex");
      entries.push({ mode, name, oid });
      pos = nul + 21;
    }
    return entries;
  }
  function treePaths(r: Repo, treeOid: string, prefix: string, out: Map<string, string>, depth: number) {
    if (depth > 32) return;
    const tree = r.objects.get(treeOid);
    if (!tree || tree.type !== "tree") return;
    for (const e of treeEntries(tree.content)) {
      const path = prefix ? prefix + "/" + e.name : e.name;
      if (e.mode === "40000" || e.mode === "040000") treePaths(r, e.oid, path, out, depth + 1);
      else out.set(path, e.oid);
    }
  }
  function populateFromPack(r: Repo) {
    for (const [oid, obj] of r.objects) {
      if (obj.type !== "commit" || r.commits.has(oid)) continue;
      const text = obj.content.toString("utf8");
      const treeMatch = text.match(/^tree ([0-9a-f]{40})/m);
      const parents = text.split("\n").filter(l => l.indexOf("parent ") === 0).map(l => l.slice(7).trim());
      const split = text.indexOf("\n\n");
      const message = split >= 0 ? text.slice(split + 2).trimEnd() : "";
      const authorLine = text.split("\n").find(l => l.indexOf("author ") === 0) || "";
      const author = authorLine.slice(7).trim() || "maker <maker@make.fun>";
      r.commits.set(oid, { oid, tree: treeMatch ? treeMatch[1] : "", parents, message, author, timestamp: r.updatedAt });
    }
    for (const [oid, meta] of r.commits) {
      const files = new Map<string, string>();
      if (meta.tree) treePaths(r, meta.tree, "", files, 0);
      if (!files.size) continue;
      const match = Array.from(r.refs.entries()).find(entry => entry[1] === oid && entry[0].indexOf("refs/heads/") === 0);
      if (match) r.files.set(match[0].slice("refs/heads/".length), files);
    }
  }
  function applyPack(r: Repo, buf: Buffer) {
    if (buf.length < 32 || buf.slice(0, 4).toString("ascii") !== "PACK") return;
    const count = buf.readUInt32BE(8);
    let pos = 12;
    const byOffset = new Map<number, GitObj>();
    const names: any = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
    for (let i = 0; i < count && pos < buf.length - 20; i++) {
      const start = pos;
      let c = buf[pos++];
      const type = (c >> 4) & 7;
      let size = c & 0x0f;
      let shift = 4;
      while (c & 0x80) { c = buf[pos++]; size |= (c & 0x7f) << shift; shift += 7; }
      let baseOffset: number | null = null;
      let baseOid: string | null = null;
      if (type === 6) {
        const d = readOfsDelta(buf, pos);
        pos = d.pos;
        baseOffset = start - d.v;
      } else if (type === 7) {
        baseOid = buf.slice(pos, pos + 20).toString("hex");
        pos += 20;
      }
      const inflated = inflateAt(buf, pos, size);
      pos = inflated.pos;
      let content = inflated.data;
      let objType = "";
      if (names[type]) objType = names[type];
      else if (type === 6 || type === 7) {
        const base = type === 6 ? byOffset.get(baseOffset!) : (baseOid ? r.objects.get(baseOid) : undefined);
        if (!base) continue;
        content = applyDelta(base.content, content);
        objType = base.type;
      } else continue;
      const oid = gitHash(objType, content);
      r.objects.set(oid, { type: objType, content });
      byOffset.set(start, { type: objType, content });
    }
  }
  function isAncestor(r: Repo, oldOid: string, newOid: string) {
    if (oldOid === newOid) return true;
    const seen = new Set<string>();
    const queue = [newOid];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === oldOid) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = r.objects.get(cur);
      if (!obj || obj.type !== "commit") continue;
      const text = obj.content.toString("utf8");
      const parents = text.split("\n").filter(l => l.startsWith("parent ")).map(l => l.slice(7).trim());
      for (const p of parents) queue.push(p);
    }
    return false;
  }

  async function handleGit(req: any, res: any, pathname: string, query: URLSearchParams, body: Buffer): Promise<boolean> {
    const m = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (!m) return false;
    const owner = decodeURIComponent(m[1]);
    const name = decodeURIComponent(m[2]);
    const action = m[3];
    const r = findRepo(owner, name);
    if (!r) { send(res, 404, Buffer.from("Not Found\n"), { "Content-Type": "text/plain" }); return true; }
    const gp = String(req.headers["git-protocol"] || "");
    const headOid = r.refs.get("refs/heads/" + r.defaultBranch) || (Array.from(r.refs.values())[0] || ZERO);
    const allRefs: string[][] = [["HEAD", headOid]];
    for (const [ref, oid] of r.refs) allRefs.push([ref, oid]);
    if (!r.refs.has("refs/heads/main")) allRefs.push(["refs/heads/main", headOid]);

    if (action === "info/refs" && req.method === "GET") {
      const service = String(query.get("service") || "git-upload-pack");
      if (service === "git-upload-pack" && gp.indexOf("version=2") >= 0) {
        const caps = ["ls-refs", "fetch=shallow", "object-format=sha1", "server-option", "agent=makefun/1.0"];
        const out: Buffer[] = [pktLine("version 2\n")];
        for (const c of caps) out.push(pktLine(c + "\n"));
        out.push(PKT_FLUSH);
        send(res, 200, Buffer.concat(out), { "Content-Type": "application/x-git-upload-pack-advertisement", "Cache-Control": "no-cache" });
        return true;
      }
      const caps = service === "git-receive-pack"
        ? ["report-status", "report-status-v2", "side-band-64k", "delete-refs", "quiet", "atomic", "ofs-delta", "agent=makefun/1.0"]
        : ["multi_ack_detailed", "no-done", "side-band-64k", "thin-pack", "ofs-delta", "agent=makefun/1.0"];
      const out: Buffer[] = [pktLine("# service=" + service + "\n"), PKT_FLUSH];
      out.push(pktBuf(Buffer.concat([Buffer.from(headOid + " HEAD\0"), Buffer.from(caps.join(" ") + "\n")])));
      for (const [ref, oid] of allRefs) out.push(pktLine(oid + " " + ref + "\n"));
      out.push(PKT_FLUSH);
      send(res, 200, Buffer.concat(out), { "Content-Type": "application/x-" + service + "-advertisement", "Cache-Control": "no-cache" });
      return true;
    }

    if (action === "git-upload-pack" && req.method === "POST") {
      const out: Buffer[] = [];
      if (gp.indexOf("version=2") >= 0) {
        const lines = parsePkt(body);
        let i = 0;
        const commands: string[] = [];
        while (i < lines.length && !lines[i].flush) { commands.push(lines[i].data.toString("utf8").trim()); i++; }
        if (i < lines.length) i++;
        let cmd = "";
        for (const c of commands) if (c.indexOf("command=") === 0) cmd = c.slice(8);
        for (let ci = 0; ci < commands.length; ci++) {
          const args: string[] = [];
          while (i < lines.length && !lines[i].flush && !lines[i].delim) { args.push(lines[i].data.toString("utf8").trim()); i++; }
          if (i < lines.length) i++;
          if (cmd === "ls-refs") {
            const prefixes = args.filter(a => a.indexOf("ref-prefix ") === 0).map(a => a.slice(11));
            const symrefs = args.indexOf("symrefs") >= 0;
            for (const [ref, oid] of allRefs) {
              if (prefixes.length && !prefixes.some(p => ref.indexOf(p) === 0)) continue;
              const extra = symrefs && ref === "HEAD" ? " symref=HEAD:refs/heads/" + r.defaultBranch : "";
              out.push(pktLine(oid + " " + ref + extra + "\n"));
            }
            out.push(PKT_FLUSH);
          } else if (cmd === "fetch") {
            const pack = buildPack(Array.from(r.objects.values()));
            for (const b of sideBand(pack)) out.push(b);
          } else out.push(PKT_FLUSH);
          if (ci < commands.length - 1) out.push(PKT_DELIM);
        }
      } else {
        const pack = buildPack(Array.from(r.objects.values()));
        for (const b of sideBand(pack)) out.push(b);
      }
      send(res, 200, Buffer.concat(out), { "Content-Type": "application/x-git-upload-pack-result", "Cache-Control": "no-cache" });
      return true;
    }

    if (action === "git-receive-pack" && req.method === "POST") {
      const lines = parsePkt(body);
      const cmds: any[] = [];
      let firstFlushEnd = body.length;
      for (const line of lines) {
        if (line.flush) { firstFlushEnd = line.end; break; }
        const s = line.data.toString("utf8");
        const m = s.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) ([^\s\0]+)/i);
        if (!m) continue;
        let ref = m[3];
        const nulAt = ref.indexOf("\0");
        if (nulAt >= 0) ref = ref.slice(0, nulAt);
        const spaceAt = ref.indexOf(" ");
        if (spaceAt >= 0) ref = ref.slice(0, spaceAt);
        cmds.push({ old: m[1], new: m[2], ref });
      }
      const packAt = body.indexOf(Buffer.from("PACK", "ascii"), Math.min(firstFlushEnd, body.length));
      if (packAt >= 0) applyPack(r, body.subarray(packAt));
      const report: Buffer[] = [sideLine("unpack ok\n")];
      for (const c of cmds) {
        const cur = r.refs.get(c.ref) || ZERO;
        let ok = false;
        let reason = "";
        if (c.new === ZERO) { r.refs.delete(c.ref); ok = true; }
        else if (c.old === ZERO) {
          if (cur === ZERO) { r.refs.set(c.ref, c.new); ok = true; }
          else reason = "already exists";
        } else if (cur !== c.old) reason = "fetch first";
        else if (isAncestor(r, c.old, c.new)) { r.refs.set(c.ref, c.new); ok = true; }
        else reason = "non-fast-forward";
        report.push(sideLine(ok ? "ok " + c.ref + "\n" : "ng " + c.ref + " " + reason + "\n"));
      }
      if (packAt >= 0) populateFromPack(r);
      report.push(PKT_FLUSH);
      send(res, 200, Buffer.concat(report), { "Content-Type": "application/x-git-receive-pack-result", "Cache-Control": "no-cache" });
      return true;
    }

    send(res, 405, Buffer.from("Method Not Allowed\n"), { "Content-Type": "text/plain" });
    return true;
  }

  const server = createServer(async (req: any, res: any) => {
    let pathname = "/";
    let query = new URLSearchParams();
    try {
      const u = new URL(req.url || "/", "http://localhost");
      pathname = u.pathname;
      query = u.searchParams;
    } catch {}
    currentHost = String(req.headers.host || "localhost");
    if (pathname.indexOf("/api/v3") === 0) res.setHeader("X-GitHub-Request-Id", reqId());
    let body = Buffer.alloc(0);
    if (req.method !== "GET" && req.method !== "HEAD") {
      try { body = await readBody(req); } catch { body = Buffer.alloc(0); }
    }
    if (pathname === "/healthz") { send(res, 200, { ok: true }); return; }
    try {
      const seg = pathname.split("/").filter(Boolean);
      if (seg[0] === "api" && seg[1] === "v3") { await handleRest(req, res, seg, query, body); return; }
      if (pathname === "/api/graphql") { await handleGraphql(req, res, body); return; }
      if (pathname === "/mcp") { await handleMcp(req, res, body); return; }
      if (await handleGit(req, res, pathname, query, body)) return;
      send(res, 404, { message: "Not Found" });
    } catch {
      send(res, 500, { message: "Internal Server Error" });
    }
  });
  return server;
}
