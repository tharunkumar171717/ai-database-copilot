/**
 * Read-only code tools for incident investigation.
 *
 * Every tool works on the single repository configured by CODE_REPOSITORY
 * (see ./github.ts); the model can choose refs (branch/tag/SHA, default
 * CODE_REF), paths, symbols and commits inside that repository but never the
 * repository itself. Outputs are capped
 * so a tool never returns a whole repository. Nothing here writes to GitHub
 * or executes repository code.
 */
import { CodeToolError, configuredRepo, getWorkspace, readClient, readText, toGitHubError, cleanRepoPath, type Workspace } from "./github";
import { parseLogs, parseStackTrace } from "./stack-trace";

export const MAX_READ_LINES = 300;
const MAX_OUTPUT_CHARS = 15_000;
const MAX_COMMIT_PATCH_CHARS = 8_000;

// --- Helpers ---------------------------------------------------------------------

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", cs: "csharp",
  php: "php", swift: "swift", scala: "scala", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  sql: "sql", sh: "bash", bash: "bash", yml: "yaml", yaml: "yaml", json: "json", toml: "toml",
  md: "markdown", html: "html", css: "css", scss: "scss", vue: "vue", svelte: "svelte",
  tf: "hcl", graphql: "graphql", prisma: "prisma",
};

function languageFor(p: string): string {
  const base = basename(p).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return EXT_LANG[ext] ?? "text";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function numberLines(lines: string[], start: number): string {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)} | ${l}`).join("\n");
}

/** Minimal glob: supports *, ** and ? against repo-relative paths. A glob without "/" matches basenames anywhere. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return glob.includes("/") ? new RegExp(`^${re}$`) : new RegExp(`(^|/)${re}$`);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basename(p: string) {
  return p.split("/").pop() ?? p;
}

const shortSha = (sha: string) => sha.slice(0, 7);

// Small per-process cache so repeated searches don't re-read every file.
const contentCache = new Map<string, string | null>();
const CACHE_LIMIT = 4000;

async function cachedText(ws: Workspace, rel: string): Promise<string | null> {
  const key = `${ws.root}\0${rel}`;
  if (contentCache.has(key)) return contentCache.get(key)!;
  const text = await readText(ws, rel);
  if (contentCache.size > CACHE_LIMIT) contentCache.clear();
  contentCache.set(key, text);
  return text;
}

async function fileLines(ws: Workspace, rel: string): Promise<{ path: string; lines: string[] }> {
  const p = cleanRepoPath(rel);
  const text = await cachedText(ws, p);
  if (text === null) {
    const similar = ws.files.filter((f) => basename(f) === basename(p)).slice(0, 5);
    throw new CodeToolError(`File not found or not a text file: ${p}.` + (similar.length ? ` Did you mean: ${similar.join(", ")}?` : ""));
  }
  return { path: p, lines: text.split(/\r?\n/) };
}

function filterFiles(ws: Workspace, pathPrefix?: string, glob?: string): string[] {
  const prefix = pathPrefix ? cleanRepoPath(pathPrefix) : "";
  let re: RegExp | null = null;
  if (glob) {
    if (glob.length > 200) throw new CodeToolError("Glob is too long.");
    re = globToRegExp(glob);
  }
  return ws.files.filter((f) => (!prefix || f === prefix || f.startsWith(`${prefix}/`)) && (!re || re.test(f)));
}

function header(ws: Workspace) {
  return `[${ws.repo.owner}/${ws.repo.name}@${ws.ref} ${shortSha(ws.sha)}]`;
}

// --- Repository tools ------------------------------------------------------------

export async function listRepositoryFiles(input: { path_prefix?: string; glob?: string; limit?: number; ref?: string }): Promise<string> {
  const ws = await getWorkspace(input.ref);
  const files = filterFiles(ws, input.path_prefix, input.glob);
  const limit = input.limit ?? 200;
  return truncate(
    `${header(ws)} ${files.length} file(s)${files.length > limit ? `, showing first ${limit}` : ""}:\n` +
      (files.slice(0, limit).join("\n") || "(none)"),
    MAX_OUTPUT_CHARS,
  );
}

export async function searchCode(input: {
  query: string;
  regex?: boolean;
  case_sensitive?: boolean;
  path_prefix?: string;
  file_glob?: string;
  max_results?: number;
  ref?: string;
}): Promise<string> {
  const ws = await getWorkspace(input.ref);
  let re: RegExp;
  try {
    re = new RegExp(input.regex ? input.query : escapeRegExp(input.query), input.case_sensitive ? "" : "i");
  } catch (e) {
    throw new CodeToolError(`Invalid regular expression: ${(e as Error).message}`);
  }
  const max = input.max_results ?? 30;
  const hits: string[] = [];
  const filesHit = new Set<string>();
  let total = 0;
  for (const file of filterFiles(ws, input.path_prefix, input.file_glob)) {
    const text = await cachedText(ws, file);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      filesHit.add(file);
      if (hits.length < max) hits.push(`${file}:${i + 1}: ${truncate(lines[i].trim(), 200)}`);
    }
  }
  if (total === 0) return `${header(ws)} No matches for ${JSON.stringify(input.query)}.`;
  return truncate(
    `${header(ws)} ${total} match(es) in ${filesHit.size} file(s)${total > max ? `, showing ${max}` : ""}:\n${hits.join("\n")}`,
    MAX_OUTPUT_CHARS,
  );
}

export async function readFileRange(input: { path: string; start_line?: number; end_line?: number; ref?: string }): Promise<string> {
  const ws = await getWorkspace(input.ref);
  const { path, lines } = await fileLines(ws, input.path);
  const start = Math.min(input.start_line ?? 1, lines.length);
  const end = Math.min(input.end_line ?? start + 199, start + MAX_READ_LINES - 1, lines.length);
  if (end < start) throw new CodeToolError("end_line must be >= start_line.");
  return truncate(`${header(ws)} ${path} (lines ${start}-${end} of ${lines.length})\n${numberLines(lines.slice(start - 1, end), start)}`, MAX_OUTPUT_CHARS);
}

export async function getFile(input: { path: string; ref?: string }): Promise<string> {
  const ws = await getWorkspace(input.ref);
  const { path, lines } = await fileLines(ws, input.path);
  const head = numberLines(lines.slice(0, 150), 1);
  return truncate(
    `${header(ws)}\npath: ${path}\nlanguage: ${languageFor(path)}\nlines: ${lines.length}\n---\n${head}${lines.length > 150 ? "\n… (use read_file for more)" : ""}`,
    MAX_OUTPUT_CHARS,
  );
}

function definitionPatterns(symbol: string): RegExp[] {
  const s = escapeRegExp(symbol);
  return [
    new RegExp(`\\b(def|async\\s+def|class)\\s+${s}\\b`), // python
    new RegExp(`\\bfunction\\s*\\*?\\s+${s}\\b`), // js function
    new RegExp(`\\b(const|let|var)\\s+${s}\\s*=\\s*(async\\s*)?(\\(|function|[A-Za-z_$][\\w$]*\\s*=>)`), // js arrow
    new RegExp(`\\b(class|interface|type|enum|struct|trait|module)\\s+${s}\\b`),
    new RegExp(`\\bfunc\\s+(\\([^)]*\\)\\s*)?${s}\\s*\\(`), // go
    new RegExp(`\\bfn\\s+${s}\\b`), // rust
    new RegExp(`^\\s*(export\\s+)?(public|private|protected|static|async|\\s)*\\s*${s}\\s*\\([^)]*\\)\\s*(:\\s*[^={]+)?\\{`), // method
    new RegExp(`^\\s*${s}\\s*[:=]\\s*(async\\s*)?(function|\\()`), // object method / assignment
    new RegExp(`\\bdef\\s+(self\\.)?${s}\\b`), // ruby
  ];
}

export async function findReferences(input: { symbol: string; path_prefix?: string; max_results?: number; ref?: string }): Promise<string> {
  const ws = await getWorkspace(input.ref);
  const symbol = input.symbol.split(".").pop()!;
  const word = new RegExp(`(^|[^\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
  const defs = definitionPatterns(symbol);
  const definitions: string[] = [];
  const references: string[] = [];
  const max = input.max_results ?? 30;
  for (const file of filterFiles(ws, input.path_prefix)) {
    const text = await cachedText(ws, file);
    if (!text || !text.includes(symbol)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!word.test(line)) continue;
      const entry = `${file}:${i + 1}: ${truncate(line.trim(), 200)}`;
      if (defs.some((d) => d.test(line))) {
        if (definitions.length < 20) definitions.push(entry);
      } else if (references.length < max) references.push(entry);
    }
  }
  return truncate(
    `${header(ws)}\nDefinitions of ${symbol} (${definitions.length}):\n${definitions.join("\n") || "(none found)"}\n\n` +
      `References (${references.length}${references.length >= max ? "+" : ""}):\n${references.join("\n") || "(none found)"}`,
    MAX_OUTPUT_CHARS,
  );
}

// --- Git history tools (read-only GitHub API) ---------------------------------------

export async function getRecentCommits(input: { path?: string; limit?: number; ref?: string }): Promise<string> {
  const ws = await getWorkspace(input.ref);
  const path = input.path ? cleanRepoPath(input.path) : undefined;
  try {
    const { data } = await readClient().repos.listCommits({
      owner: ws.repo.owner,
      repo: ws.repo.name,
      sha: ws.sha,
      path,
      per_page: input.limit ?? 10,
    });
    if (!data.length) return `${header(ws)} No commits found.`;
    return `${header(ws)}\n` + data
      .map(
        (c) =>
          `${shortSha(c.sha)} ${c.commit.author?.date?.slice(0, 10) ?? ""} ${c.commit.author?.name ?? c.author?.login ?? "?"}: ${truncate(c.commit.message.split("\n")[0], 120)}`,
      )
      .join("\n");
  } catch (err) {
    throw toGitHubError(err, "list commits");
  }
}

export async function getCommit(input: { sha: string; path?: string }): Promise<string> {
  const { repo } = configuredRepo();
  const path = input.path ? cleanRepoPath(input.path) : undefined;
  try {
    const { data } = await readClient().repos.getCommit({ owner: repo.owner, repo: repo.name, ref: input.sha });
    const files = (data.files ?? []).filter((f) => !path || f.filename === path || f.filename.startsWith(`${path}/`));
    let budget = MAX_COMMIT_PATCH_CHARS;
    const parts = files.slice(0, 30).map((f) => {
      const summary = `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`;
      if (budget <= 0) return `${summary}\n(patch omitted)`;
      const patch = f.patch ? truncate(f.patch, Math.max(300, Math.min(3000, budget))) : "(no textual patch)";
      budget -= patch.length;
      return `${summary}\n${patch}`;
    });
    return truncate(
      `commit ${data.sha}\nauthor: ${data.commit.author?.name ?? "?"} ${data.commit.author?.date ?? ""}\n\n${truncate(data.commit.message, 1000)}\n\n` +
        `${files.length} file(s) changed${files.length > 30 ? ", showing 30" : ""}\n\n${parts.join("\n\n")}`,
      MAX_OUTPUT_CHARS,
    );
  } catch (err) {
    throw toGitHubError(err, `read commit ${input.sha}`);
  }
}

export async function listBranches(input: { limit?: number }): Promise<string> {
  const { repo, ref } = configuredRepo();
  const limit = input.limit ?? 100;
  try {
    const gh = readClient();
    const names: string[] = [];
    for await (const { data } of gh.paginate.iterator(gh.repos.listBranches, { owner: repo.owner, repo: repo.name, per_page: 100 })) {
      names.push(...data.map((b) => `${b.name} ${shortSha(b.commit.sha)}${b.name === ref ? " (investigated)" : ""}${b.protected ? " [protected]" : ""}`));
      if (names.length >= limit + 1) break;
    }
    return `${repo.owner}/${repo.name}: ${names.length > limit ? `more than ${limit}` : names.length} branch(es)${names.length > limit ? `, showing ${limit}` : ""}\n${names.slice(0, limit).join("\n") || "(none)"}`;
  } catch (err) {
    throw toGitHubError(err, "list branches");
  }
}

export async function getBranch(input: { name?: string }): Promise<string> {
  const { repo, ref } = configuredRepo();
  const name = input.name ?? ref;
  try {
    const { data } = await readClient().repos.getBranch({ owner: repo.owner, repo: repo.name, branch: name });
    return (
      `branch ${data.name}\nhead ${data.commit.sha}\n` +
      `${data.commit.commit.author?.date ?? ""} ${truncate(data.commit.commit.message.split("\n")[0], 120)}\nprotected: ${data.protected}`
    );
  } catch (err) {
    throw toGitHubError(err, `read branch ${name}`);
  }
}

// --- Incident parsing ----------------------------------------------------------------

/** Parses a pasted stack trace and/or logs into frames and error-level log lines. Pure, no I/O. */
export function parseIncidentText(input: { text: string }) {
  const stack = parseStackTrace(input.text);
  const logs = parseLogs(input.text);
  const leveled = logs.filter((l) => l.level);
  const byLevel: Record<string, number> = {};
  for (const l of leveled) byLevel[l.level!] = (byLevel[l.level!] ?? 0) + 1;
  return {
    runtime: stack?.runtime ?? "unknown",
    error_type: stack?.errorType ?? null,
    error_message: stack?.errorMessage ?? null,
    // Application frames only, innermost first.
    frames: (stack?.frames ?? []).slice(0, 20),
    logs: {
      lines_with_level: leveled.length,
      by_level: byLevel,
      errors: leveled
        .filter((l) => l.level === "fatal" || l.level === "error" || l.level === "warn")
        .slice(0, 20)
        .map((l) => ({ line_no: l.line_no, level: l.level, logged_at: l.logged_at, message: truncate(l.message, 300) })),
    },
  };
}
