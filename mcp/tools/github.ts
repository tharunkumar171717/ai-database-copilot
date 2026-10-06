/**
 * Read-only access to the one GitHub repository the code tools may inspect.
 *
 * The repository comes from env (CODE_REPOSITORY), never from the model.
 * CODE_REF is the default branch; the model may read any other branch, tag
 * or commit of that same repository. Each commit is downloaded once as a tarball and extracted into a
 * cached snapshot under the OS temp dir (/tmp on Vercel); tools then search
 * and read that snapshot. Nothing here can write to GitHub.
 *
 * GITHUB_TOKEN is optional (fine-grained, read-only "Contents" + "Metadata").
 * Without it public repositories still work, with GitHub's lower rate limits.
 */
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { Octokit } from "@octokit/rest";
import * as tar from "tar";

/** Errors whose message is safe and useful to show to the model. */
export class CodeToolError extends Error {}

export type RepoRef = { owner: string; name: string };

export type Workspace = {
  repo: RepoRef;
  ref: string;
  sha: string;
  root: string;
  files: string[]; // repo-relative POSIX paths of indexable text files
};

const DEFAULT_REPOSITORY = "tharunkumar171717/incident-investigator";
const DEFAULT_REF = "main";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const SHA_CACHE_MS = 60_000;
const MAX_SNAPSHOTS = 8;

const ROOT = path.join(os.tmpdir(), "ai-database-copilot", "workspaces");
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", ".next", "out", "target", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|jar|war|class|so|dylib|dll|exe|bin|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|lock|min\.js|map|pyc|o|a)$/i;
/** Files that commonly hold secrets are never indexed or read, even if committed. */
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$)[^/]*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)|[^/]*\.(pem|key|p12|pfx))$/i;

// --- Configuration ------------------------------------------------------------

const REPO_RE = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

export function configuredRepo(): { repo: RepoRef; ref: string } {
  const full = (process.env.CODE_REPOSITORY || DEFAULT_REPOSITORY).trim().replace(/\.git$/, "");
  const m = full.match(REPO_RE);
  if (!m) throw new CodeToolError("CODE_REPOSITORY must look like owner/name.");
  return { repo: { owner: m[1], name: m[2] }, ref: (process.env.CODE_REF || DEFAULT_REF).trim() };
}

let octokit: Octokit | undefined;

/** Read-only Octokit client. Authenticated only if GITHUB_TOKEN is set. */
export function readClient(): Octokit {
  octokit ??= new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
    userAgent: "ai-database-copilot",
    request: { timeout: 30_000 },
  });
  return octokit;
}

// --- Errors -------------------------------------------------------------------

type OctokitLikeError = {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | undefined>; data?: { message?: string } };
};

/** Maps Octokit/network failures to messages the model can act on (no tokens or URLs with credentials). */
export function toGitHubError(err: unknown, what: string): CodeToolError {
  if (err instanceof CodeToolError) return err;
  const e = (err ?? {}) as OctokitLikeError;
  const status = typeof e.status === "number" ? e.status : 0;
  const ghMessage = (e.response?.data?.message ?? e.message ?? "unknown error").slice(0, 200);

  if (status === 401) return new CodeToolError("GitHub rejected the server token (401). Check GITHUB_TOKEN.");
  if (status === 403 || status === 429) {
    if (e.response?.headers?.["x-ratelimit-remaining"] === "0" || /rate limit/i.test(ghMessage)) {
      return new CodeToolError("GitHub API rate limit reached. Try again in a few minutes (or set GITHUB_TOKEN).");
    }
    return new CodeToolError(`GitHub denied access while trying to ${what}: ${ghMessage}`);
  }
  if (status === 404) return new CodeToolError(`Not found on GitHub while trying to ${what}. The branch, commit or path does not exist.`);
  if (status === 422) return new CodeToolError(`GitHub rejected the request to ${what}: ${ghMessage}`);
  if (status >= 500 || status === 0) return new CodeToolError(`GitHub is unavailable (${status || "network error"}) while trying to ${what}. Retry shortly.`);
  return new CodeToolError(`GitHub error ${status} while trying to ${what}: ${ghMessage}`);
}

// --- Ref -> SHA -----------------------------------------------------------------

const shaCache = new Map<string, { sha: string; at: number }>();

/** Validates a branch, tag or commit SHA from the model. */
export function cleanRef(ref: string): string {
  const r = ref.trim();
  if (!r || r.length > 200 || !/^[\w./-]+$/.test(r) || r.includes("..") || r.startsWith("/") || r.startsWith("-") || r.endsWith(".lock")) {
    throw new CodeToolError(`Invalid ref "${ref}". Use a branch name, tag or commit SHA.`);
  }
  return r;
}

export async function resolveSha(repo: RepoRef, ref: string): Promise<string> {
  const key = `${repo.owner}/${repo.name}@${ref}`;
  const cached = shaCache.get(key);
  if (cached && Date.now() - cached.at < SHA_CACHE_MS) return cached.sha;
  try {
    const { data } = await readClient().request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: repo.owner,
      repo: repo.name,
      ref,
      headers: { accept: "application/vnd.github.sha" },
    });
    const sha = String(data).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new CodeToolError(`Could not resolve "${ref}" to a commit.`);
    if (shaCache.size > 200) shaCache.clear();
    shaCache.set(key, { sha, at: Date.now() });
    return sha;
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404 || status === 422) {
      throw new CodeToolError(`Ref "${ref}" was not found in ${repo.owner}/${repo.name}. Use list_branches to see the branches.`);
    }
    throw toGitHubError(err, `resolve "${ref}" in ${key.split("@")[0]}`);
  }
}

// --- Snapshot -------------------------------------------------------------------

const inflight = new Map<string, Promise<Workspace>>();

/** The cached snapshot of CODE_REPOSITORY at `ref` (default CODE_REF), downloaded on first use. */
export async function getWorkspace(refInput?: string): Promise<Workspace> {
  const { repo, ref: defaultRef } = configuredRepo();
  const ref = refInput ? cleanRef(refInput) : defaultRef;
  const sha = await resolveSha(repo, ref);
  const key = `${repo.owner}__${repo.name}__${sha}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = load(repo, ref, sha, key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function load(repo: RepoRef, ref: string, sha: string, key: string): Promise<Workspace> {
  const dir = path.join(ROOT, key);
  const root = path.join(dir, "src");
  const ready = await stat(path.join(dir, ".ready")).then(() => true, () => false);

  if (!ready) {
    await pruneSnapshots();
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    await mkdir(path.join(tmp, "src"), { recursive: true });
    try {
      const archive = path.join(tmp, "repo.tar.gz");
      await download(repo, sha, archive);
      // node-tar strips absolute paths and ".." entries by default.
      await tar.x({ file: archive, cwd: path.join(tmp, "src"), strip: 1 });
      await rm(archive, { force: true });
      await writeFile(path.join(tmp, ".ready"), new Date().toISOString());
      await rm(dir, { recursive: true, force: true });
      await rename(tmp, dir);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }
  return { repo, ref, sha, root: await realpath(root), files: await indexFiles(root) };
}

/** Keeps /tmp bounded: removes the oldest snapshots once there are MAX_SNAPSHOTS. */
async function pruneSnapshots() {
  const entries = await readdir(ROOT, { withFileTypes: true }).catch(() => []);
  const dirs = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && !e.name.includes(".tmp-"))
      .map(async (e) => ({ dir: path.join(ROOT, e.name), at: (await stat(path.join(ROOT, e.name))).mtimeMs })),
  );
  dirs.sort((a, b) => a.at - b.at);
  for (const d of dirs.slice(0, Math.max(0, dirs.length - MAX_SNAPSHOTS + 1))) {
    await rm(d.dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function download(repo: RepoRef, sha: string, dest: string) {
  const token = process.env.GITHUB_TOKEN;
  let res: Response;
  try {
    // fetch follows GitHub's redirect to a short-lived codeload URL; the body is streamed to disk.
    res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/tarball/${sha}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/vnd.github+json",
        "User-Agent": "ai-database-copilot",
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw toGitHubError(err, "download the repository archive");
  }
  if (!res.ok || !res.body) {
    throw toGitHubError({ status: res.status, message: res.statusText }, `download ${repo.owner}/${repo.name}@${sha.slice(0, 7)}`);
  }
  const tooLarge = () => new CodeToolError(`Repository archive exceeds ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_ARCHIVE_BYTES) throw tooLarge();

  let seen = 0;
  const body = Readable.fromWeb(res.body as NodeReadableStream);
  body.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > MAX_ARCHIVE_BYTES) body.destroy(tooLarge());
  });
  await pipeline(body, createWriteStream(dest));
}

async function indexFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string) {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      // Dirent does not follow symlinks, so symlinked files/dirs are never indexed.
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(childRel);
      } else if (e.isFile() && !BINARY_EXT.test(e.name) && !SECRET_FILE.test(childRel)) {
        out.push(childRel);
      }
    }
  }
  await walk("");
  return out.sort();
}

// --- Path safety ------------------------------------------------------------------

/** Validates a repo-relative path from the model: no absolute paths, no "..", no NUL. Returns a clean POSIX path. */
export function cleanRepoPath(rel: string): string {
  const p = rel.trim().replace(/\\/g, "/");
  if (!p || p.includes("\0") || p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) {
    throw new CodeToolError(`Path "${rel}" is outside the repository. Use a repository-relative path such as "src/index.ts".`);
  }
  return p.replace(/^(\.\/)+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
}

/** Reads a text file from the snapshot, or null if missing/binary/too large. Refuses anything that escapes the snapshot. */
export async function readText(ws: Workspace, rel: string): Promise<string | null> {
  const clean = cleanRepoPath(rel);
  if (SECRET_FILE.test(clean)) throw new CodeToolError(`Reading "${clean}" is not allowed: it may contain secrets.`);
  const abs = path.join(ws.root, clean);
  try {
    const info = await lstat(abs);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    // Guard against symlinked parent directories pointing outside the snapshot.
    const real = await realpath(abs);
    if (!real.startsWith(ws.root + path.sep)) return null;
    const buf = await readFile(real);
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}
