#!/usr/bin/env node
/**
 * Backlog MCP Server — CRUD over the markdown backlog, with ATOMIC collision-safe id assignment.
 *
 * Why this exists (TASK-57): `npx backlog task create` can reuse an id and OVERWRITE an existing
 * task (the CEN-24 clobber). This server reimplements CRUD directly against backlog/tasks/*.md and
 * owns id allocation under a lockfile, so a create can never collide. Structured JSON params also
 * drop the CLI's shell arg-parse footguns (backticks / angle-brackets / pipes).
 *
 * Backlog compatibility: writes the exact file shape the `npx backlog` CLI + board read —
 *   frontmatter (id/title/status/assignee/labels/dependencies/ordinal/dates)
 *   + `## Acceptance Criteria` / AC:BEGIN..END, `## Implementation Plan` / SECTION:PLAN,
 *     `## Implementation Notes` / SECTION:NOTES.
 * Tasks are resolved by frontmatter `id`, not filename (matches the CLI).
 *
 * Backlog dir: per-call `dir` param, else $BACKLOG_DIR, else `<cwd>/backlog`. One server serves both
 * the workspace (TASK-*) and centre (CEN-*) backlogs — the id prefix is derived from that dir's config.
 *
 * Start:  stdio (Claude Code manages it) — or set MCP_PORT for HTTP.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, openSync, closeSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

// ── Jira-like model constants ────────────────────────────────────────────────
const ISSUE_TYPES = ['epic', 'story', 'task', 'subtask', 'bug'] as const;
const LINK_TYPES = ['blocks', 'blocked-by', 'relates', 'duplicates', 'duplicated-by'] as const;
// Inverse of each link type, so a link is maintained on BOTH tasks (A blocks B ⇒ B blocked-by A).
const LINK_INVERSE: Record<string, string> = {
  blocks: 'blocked-by', 'blocked-by': 'blocks',
  relates: 'relates',
  duplicates: 'duplicated-by', 'duplicated-by': 'duplicates',
};

// ── Home (persisted default backlog dir) ─────────────────────────────────────
// Resolution order: explicit `dir` param → persisted home (set_home) → $BACKLOG_DIR → <cwd>/backlog.
// The home is stored per-user so a fresh stdio spawn keeps it; explicit `dir` still overrides per call
// (multi-backlog use — e.g. a TASK-* and a CEN-* backlog — stays supported).

function configPath(): string {
  return process.env.BACKLOG_MCP_CONFIG ?? join(homedir(), '.config', 'backlog-mcp', 'config.json');
}
function readHome(): string | undefined {
  try { const h = JSON.parse(readFileSync(configPath(), 'utf8')).home; return h ? String(h) : undefined; } catch { return undefined; }
}
function writeHome(path: string): string {
  const home = resolve(path);
  const cfg = configPath();
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ home }, null, 2));
  return home;
}

// ── Backlog dir + config ─────────────────────────────────────────────────────

function backlogDir(dir?: string): string {
  return resolve(dir ?? readHome() ?? process.env.BACKLOG_DIR ?? join(process.cwd(), 'backlog'));
}
function tasksDir(dir?: string): string {
  return join(backlogDir(dir), 'tasks');
}
function readConfig(dir?: string): { prefix: string; defaultStatus: string; statuses: string[] } {
  const cfgPath = join(backlogDir(dir), 'config.yml');
  let prefix = 'task', defaultStatus = 'To Do', statuses = ['To Do', 'In Progress', 'Done'];
  try {
    const raw = readFileSync(cfgPath, 'utf8');
    const p = raw.match(/^task_prefix:\s*"?([^"\n]+)"?/m); if (p) prefix = p[1].trim();
    const d = raw.match(/^default_status:\s*"?([^"\n]+)"?/m); if (d) defaultStatus = d[1].trim();
    const s = raw.match(/^statuses:\s*\[([^\]]*)\]/m);
    if (s) statuses = s[1].split(',').map((x) => x.replace(/["\s]/g, '').replace(/^\s+|\s+$/g, '').replace(/"/g, '')).map((x) => x.trim()).filter(Boolean);
  } catch { /* defaults */ }
  return { prefix, defaultStatus, statuses };
}

// ── Task file model + parse/render ───────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  status: string;
  type: string;        // Jira-like issue type: epic|story|task|subtask|bug (default 'task')
  parent: string;      // parent task id ('' = none) — epic⊃story⊃task⊃subtask
  reporter: string;    // who filed it ('' = none)
  priority: string;    // e.g. highest|high|medium|low ('' = none)
  assignee: string[];
  labels: string[];
  dependencies: string[];
  links: Array<{ type: string; target: string }>; // typed cross-links (blocks/relates/duplicates…)
  dev: string[];       // git/pr dev-panel refs (branch:… / commit:… / pr:… / merged:…)
  qmetry: string[];    // qmetry refs (suite:… / run:…:result)
  ordinal: number;
  created: string;
  updated: string;
  ac: Array<{ checked: boolean; text: string }>;
  plan: string;
  notes: string;
  file: string; // absolute path
}

const AC_BEGIN = '<!-- AC:BEGIN -->', AC_END = '<!-- AC:END -->';
const PLAN_BEGIN = '<!-- SECTION:PLAN:BEGIN -->', PLAN_END = '<!-- SECTION:PLAN:END -->';
const NOTES_BEGIN = '<!-- SECTION:NOTES:BEGIN -->', NOTES_END = '<!-- SECTION:NOTES:END -->';

function between(s: string, a: string, b: string): string {
  const i = s.indexOf(a); if (i < 0) return '';
  const j = s.indexOf(b, i + a.length); if (j < 0) return '';
  return s.slice(i + a.length, j).replace(/^\n+|\n+$/g, '');
}

/** Minimal YAML scalar: single-quote only when needed (colon, leading special, quote); else plain. */
function yamlScalar(v: string): string {
  if (v === '') return "''";
  if (/[:#\n]|^[\s>|&*!?@`"'\[\]{},%-]|:\s/.test(v) || /\s$/.test(v)) return `'${v.replace(/'/g, "''")}'`;
  return v;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/); const out: Record<string, string> = {};
  if (!m) return out;
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]; let val = kv[2];
    if (val === '>-' || val === '>' || val === '|' || val === '|-') {
      // folded/literal block — gather following more-indented lines
      const buf: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) { buf.push(lines[++i].trim()); }
      out[key] = buf.join(' ');
    } else {
      out[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

function parseList(raw: string, key: string): string[] {
  // block list:  key:\n  - a\n  - b   OR inline  key: []
  const re = new RegExp(`^${key}:\\s*(\\[\\s*\\])?\\s*$`, 'm');
  const m = raw.match(re);
  const fm = raw.match(/^---\n([\s\S]*?)\n---/); if (!fm) return [];
  const lines = fm[1].split('\n');
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (idx < 0) return [];
  if (/\[\s*\]/.test(lines[idx])) return [];
  const out: string[] = [];
  for (let i = idx + 1; i < lines.length && /^\s*-\s+/.test(lines[i]); i++) out.push(lines[i].replace(/^\s*-\s+/, '').replace(/^['"]|['"]$/g, '').trim());
  return out;
}

function parseAc(raw: string): Array<{ checked: boolean; text: string }> {
  const block = between(raw, AC_BEGIN, AC_END);
  if (!block) return [];
  return block.split('\n').map((l) => {
    const m = l.match(/^- \[([ xX])\]\s*(?:#\d+\s+)?(.*)$/);
    return m ? { checked: m[1].toLowerCase() === 'x', text: m[2] } : null;
  }).filter(Boolean) as Array<{ checked: boolean; text: string }>;
}

function parseTask(file: string): Task {
  const raw = readFileSync(file, 'utf8');
  const fm = parseFrontmatter(raw);
  return {
    id: fm.id ?? '', title: fm.title ?? '', status: fm.status ?? '',
    type: (fm.type ?? 'task').toLowerCase(), parent: fm.parent ?? '', reporter: fm.reporter ?? '', priority: fm.priority ?? '',
    assignee: parseList(raw, 'assignee'), labels: parseList(raw, 'labels'), dependencies: parseList(raw, 'dependencies'),
    links: parseList(raw, 'links').map((s) => { const i = s.indexOf(':'); return i < 0 ? { type: 'relates', target: s.toUpperCase() } : { type: s.slice(0, i).trim(), target: s.slice(i + 1).trim().toUpperCase() }; }),
    dev: parseList(raw, 'dev'), qmetry: parseList(raw, 'qmetry'),
    ordinal: Number(fm.ordinal ?? 0), created: fm.created_date ?? '', updated: fm.updated_date ?? '',
    ac: parseAc(raw), plan: between(raw, PLAN_BEGIN, PLAN_END), notes: between(raw, NOTES_BEGIN, NOTES_END), file,
  };
}

function renderTask(t: Omit<Task, 'file'>): string {
  const listBlock = (key: string, items: string[]) => `${key}: ${items.length ? '\n' + items.map((x) => `  - ${yamlScalar(x)}`).join('\n') : '[]'}`;
  const lines = [
    '---',
    `id: ${t.id}`,
    `title: ${yamlScalar(t.title)}`,
    `status: ${yamlScalar(t.status)}`,
    `type: ${t.type || 'task'}`,
  ];
  if (t.parent) lines.push(`parent: ${t.parent}`);
  if (t.reporter) lines.push(`reporter: ${yamlScalar(t.reporter)}`);
  if (t.priority) lines.push(`priority: ${yamlScalar(t.priority)}`);
  lines.push(listBlock('assignee', t.assignee));
  lines.push(`created_date: '${t.created}'`, `updated_date: '${t.updated}'`);
  lines.push(listBlock('labels', t.labels), listBlock('dependencies', t.dependencies));
  if (t.links.length) lines.push(listBlock('links', t.links.map((l) => `${l.type}:${l.target}`)));
  if (t.dev.length) lines.push(listBlock('dev', t.dev));
  if (t.qmetry.length) lines.push(listBlock('qmetry', t.qmetry));
  lines.push(`ordinal: ${t.ordinal}`, '---');
  const fm = lines.join('\n');
  const ac = t.ac.length
    ? t.ac.map((a, i) => `- [${a.checked ? 'x' : ' '}] #${i + 1} ${a.text}`).join('\n')
    : '';
  return [
    fm, '',
    '## Acceptance Criteria', AC_BEGIN, ac, AC_END, '',
    '## Implementation Plan', '', PLAN_BEGIN, t.plan, PLAN_END, '',
    '## Implementation Notes', '', NOTES_BEGIN, t.notes, NOTES_END, '',
  ].join('\n');
}

// ── id allocation + lock ─────────────────────────────────────────────────────

function listFiles(dir?: string): string[] {
  const d = tasksDir(dir);
  try { return readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => join(d, f)); } catch { return []; }
}
function allIds(dir?: string): Set<string> {
  const ids = new Set<string>();
  for (const f of listFiles(dir)) { try { const id = parseFrontmatter(readFileSync(f, 'utf8')).id; if (id) ids.add(id.toUpperCase()); } catch { /* skip */ } }
  return ids;
}
function findFileById(id: string, dir?: string): string | undefined {
  const want = id.toUpperCase();
  for (const f of listFiles(dir)) { try { if ((parseFrontmatter(readFileSync(f, 'utf8')).id ?? '').toUpperCase() === want) return f; } catch { /* skip */ } }
  return undefined;
}
export function nextId(dir?: string): { id: string; num: number } {
  const { prefix } = readConfig(dir);
  const up = prefix.toUpperCase();
  let max = 0;
  for (const id of allIds(dir)) { const m = id.match(new RegExp(`^${up}-(\\d+)$`)); if (m) max = Math.max(max, Number(m[1])); }
  return { id: `${up}-${max + 1}`, num: max + 1 };
}
function slug(title: string): string {
  return title.replace(/[^\p{L}\p{N}\s—-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}

const LOCK_TTL_MS = 10_000;
async function withLock<T>(dir: string | undefined, fn: () => T): Promise<T> {
  const lock = join(backlogDir(dir), '.mcp-lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { const fd = openSync(lock, 'wx'); closeSync(fd); break; } // atomic create — acquired
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_TTL_MS) { unlinkSync(lock); continue; } } catch { /* gone — retry */ }
      if (Date.now() > deadline) throw new Error('backlog is locked by another writer (timeout)');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already released */ } }
}

function now(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── MCP tools ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'backlog', version: '0.3.0' });
const ok = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const err = (m: string) => ({ isError: true, content: [{ type: 'text' as const, text: m }] });
const summary = (t: Task) => ({
  id: t.id, type: t.type, title: t.title, status: t.status,
  ...(t.parent ? { parent: t.parent } : {}), ...(t.priority ? { priority: t.priority } : {}),
  labels: t.labels, acDone: t.ac.filter((a) => a.checked).length, acTotal: t.ac.length,
});

server.tool('task_list', 'List backlog tasks (id, type, title, status, parent, labels, AC progress). Optional filters: status, type, parent, assignee, label.', {
  dir: z.string().optional().describe('backlog dir; default $BACKLOG_DIR or <cwd>/backlog'),
  status: z.string().optional().describe('filter by exact status, e.g. "In Progress"'),
  type: z.enum(ISSUE_TYPES).optional().describe('filter by issue type'),
  parent: z.string().optional().describe('filter to direct children of this parent id'),
  assignee: z.string().optional().describe('filter to tasks assigned to this name'),
  label: z.string().optional().describe('filter to tasks carrying this label'),
}, async ({ dir, status, type, parent, assignee, label }) => {
  let tasks = listFiles(dir).map(parseTask);
  if (status) tasks = tasks.filter((t) => t.status.toLowerCase() === status.toLowerCase());
  if (type) tasks = tasks.filter((t) => t.type === type);
  if (parent) tasks = tasks.filter((t) => t.parent.toUpperCase() === parent.toUpperCase());
  if (assignee) tasks = tasks.filter((t) => t.assignee.some((a) => a.toLowerCase() === assignee.toLowerCase()));
  if (label) tasks = tasks.filter((t) => t.labels.some((l) => l.toLowerCase() === label.toLowerCase()));
  tasks.sort((a, b) => a.ordinal - b.ordinal);
  return ok(tasks.map(summary));
});

server.tool('task_get', 'Read one task in full (frontmatter + acceptance criteria + plan + notes).', {
  id: z.string().describe('task id, e.g. TASK-57 or CEN-24'),
  dir: z.string().optional(),
}, async ({ id, dir }) => {
  const f = findFileById(id, dir); if (!f) return err(`no task ${id}`);
  const t = parseTask(f);
  const children = listFiles(dir).map(parseTask).filter((c) => c.parent.toUpperCase() === t.id.toUpperCase()).map((c) => c.id);
  return ok({
    ...summary(t), reporter: t.reporter || undefined, assignee: t.assignee,
    links: t.links, children, dev: t.dev, qmetry: t.qmetry,
    created: t.created, updated: t.updated, ac: t.ac, plan: t.plan, notes: t.notes, file: t.file,
  });
});

server.tool('task_create', 'Create a task with an ATOMIC collision-safe id (never overwrites). Structured params — no shell escaping. Supports Jira-like type/parent/reporter/priority/assignee.', {
  title: z.string().describe('task title'),
  type: z.enum(ISSUE_TYPES).optional().describe('issue type (default task): epic|story|task|subtask|bug'),
  parent: z.string().optional().describe('parent task id (epic⊃story⊃task⊃subtask) — must exist'),
  acceptanceCriteria: z.array(z.string()).optional().describe('acceptance criteria, one requirement each'),
  plan: z.string().optional(),
  notes: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.array(z.string()).optional().describe('assignees (agent/human names)'),
  reporter: z.string().optional().describe('who filed it'),
  priority: z.string().optional().describe('highest|high|medium|low'),
  status: z.string().optional().describe('default = the backlog default status'),
  dir: z.string().optional(),
}, async (p) => {
  try { return ok(await createTask(p)); } catch (e: any) { return err(String(e?.message ?? e)); }
});

/** Allocate an id and write a new task — the whole thing under the dir lock so concurrent
 *  creates can never collide. `wx` on the write is the final guard against ever clobbering. */
export async function createTask(p: {
  title: string; type?: string; parent?: string; acceptanceCriteria?: string[]; plan?: string; notes?: string;
  labels?: string[]; assignee?: string[]; reporter?: string; priority?: string; status?: string; dir?: string;
}): Promise<{ created: string; file: string }> {
  const { dir } = p;
  return withLock(dir, () => {
    if (p.parent && !findFileById(p.parent, dir)) throw new Error(`parent ${p.parent} does not exist`);
    const { id, num } = nextId(dir); // allocated INSIDE the lock → race-free
    const file = join(tasksDir(dir), `${id.toLowerCase()} - ${slug(p.title)}.md`);
    if (allIds(dir).has(id) || existsSync(file)) throw new Error(`id ${id} would collide — aborted`);
    const cfg = readConfig(dir);
    const ts = now();
    const task: Omit<Task, 'file'> = {
      id, title: p.title, status: p.status ?? cfg.defaultStatus,
      type: (p.type ?? 'task').toLowerCase(), parent: (p.parent ?? '').toUpperCase(), reporter: p.reporter ?? '', priority: p.priority ?? '',
      assignee: p.assignee ?? [], labels: p.labels ?? [], dependencies: [], links: [], dev: [], qmetry: [],
      ordinal: num * 1000, created: ts, updated: ts,
      ac: (p.acceptanceCriteria ?? []).map((text) => ({ checked: false, text })), plan: p.plan ?? '', notes: p.notes ?? '',
    };
    writeFileSync(file, renderTask(task), { flag: 'wx' }); // wx = fail if exists, never clobber
    return { created: id, file };
  });
}

server.tool('task_update', 'Update a task: status/type/parent/reporter/priority/assignee/labels, plan/notes (replace), append a comment, or check/uncheck an AC. Set parent to "" to clear it.', {
  id: z.string(),
  status: z.string().optional(),
  type: z.enum(ISSUE_TYPES).optional(),
  parent: z.string().optional().describe('parent id (must exist, no cycles); "" clears it'),
  reporter: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.array(z.string()).optional().describe('REPLACES the assignee list'),
  labels: z.array(z.string()).optional().describe('REPLACES the labels list'),
  plan: z.string().optional().describe('REPLACES the plan section'),
  notes: z.string().optional().describe('REPLACES the notes section'),
  comment: z.string().optional().describe('APPENDS a timestamped line to the notes section'),
  checkAc: z.number().optional().describe('1-based AC number to mark done'),
  uncheckAc: z.number().optional().describe('1-based AC number to mark not-done'),
  dir: z.string().optional(),
}, async ({ id, status, type, parent, reporter, priority, assignee, labels, plan, notes, comment, checkAc, uncheckAc, dir }) => {
  try {
    return ok(await withLock(dir, () => {
      const f = findFileById(id, dir); if (!f) throw new Error(`no task ${id}`);
      const t = parseTask(f);
      if (status) t.status = status;
      if (type) t.type = type.toLowerCase();
      if (parent !== undefined) {
        if (parent === '') t.parent = '';
        else {
          const pid = parent.toUpperCase();
          if (pid === t.id.toUpperCase()) throw new Error('a task cannot be its own parent');
          if (!findFileById(pid, dir)) throw new Error(`parent ${pid} does not exist`);
          // walk the parent chain to reject a cycle
          let cur: string | undefined = pid, guard = 0;
          while (cur && guard++ < 100) { if (cur.toUpperCase() === t.id.toUpperCase()) throw new Error('parent would create a cycle'); const pf = findFileById(cur, dir); cur = pf ? (parseTask(pf).parent || undefined) : undefined; }
          t.parent = pid;
        }
      }
      if (reporter !== undefined) t.reporter = reporter;
      if (priority !== undefined) t.priority = priority;
      if (assignee !== undefined) t.assignee = assignee;
      if (labels !== undefined) t.labels = labels;
      if (plan !== undefined) t.plan = plan;
      if (notes !== undefined) t.notes = notes;
      if (comment) t.notes = (t.notes ? t.notes + '\n\n' : '') + `> [${now()}] ${comment}`;
      if (checkAc) { if (!t.ac[checkAc - 1]) throw new Error(`no AC #${checkAc}`); t.ac[checkAc - 1].checked = true; }
      if (uncheckAc) { if (!t.ac[uncheckAc - 1]) throw new Error(`no AC #${uncheckAc}`); t.ac[uncheckAc - 1].checked = false; }
      t.updated = now();
      writeFileSync(f, renderTask(t));
      return summary(parseTask(f));
    }));
  } catch (e: any) { return err(String(e?.message ?? e)); }
});

server.tool('task_delete', 'Delete a task file (destructive).', {
  id: z.string(), dir: z.string().optional(),
}, async ({ id, dir }) => {
  try {
    return ok(await withLock(dir, () => {
      const f = findFileById(id, dir); if (!f) throw new Error(`no task ${id}`);
      unlinkSync(f);
      return { deleted: id };
    }));
  } catch (e: any) { return err(String(e?.message ?? e)); }
});

server.tool('task_link', 'Link two tasks with a typed relationship (blocks/blocked-by/relates/duplicates/duplicated-by). Maintains the INVERSE on the other task automatically. Set remove=true to unlink both sides.', {
  id: z.string(),
  type: z.enum(LINK_TYPES),
  target: z.string().describe('the other task id'),
  remove: z.boolean().optional(),
  dir: z.string().optional(),
}, async ({ id, type, target, remove, dir }) => {
  try {
    return ok(await withLock(dir, () => {
      const fa = findFileById(id, dir); if (!fa) throw new Error(`no task ${id}`);
      const fb = findFileById(target, dir); if (!fb) throw new Error(`no task ${target}`);
      const a = parseTask(fa), b = parseTask(fb);
      if (a.id.toUpperCase() === b.id.toUpperCase()) throw new Error('cannot link a task to itself');
      const inv = LINK_INVERSE[type] ?? 'relates';
      const srcU = a.id.toUpperCase(), tgtU = b.id.toUpperCase();
      const has = (t: Task, ty: string, tg: string) => t.links.some((l) => l.type === ty && l.target.toUpperCase() === tg);
      if (remove) {
        a.links = a.links.filter((l) => !(l.type === type && l.target.toUpperCase() === tgtU));
        b.links = b.links.filter((l) => !(l.type === inv && l.target.toUpperCase() === srcU));
      } else {
        if (!has(a, type, tgtU)) a.links.push({ type, target: b.id });
        if (!has(b, inv, srcU)) b.links.push({ type: inv, target: a.id });
      }
      a.updated = now(); b.updated = now();
      writeFileSync(fa, renderTask(a)); writeFileSync(fb, renderTask(b));
      return { [a.id]: a.links, [b.id]: b.links };
    }));
  } catch (e: any) { return err(String(e?.message ?? e)); }
});

server.tool('task_dev_scan', 'Dev-panel: scan a git repo for this task id in branch names + commit messages (Smart-Commit convention, e.g. a branch `CEN-12-…` or a commit mentioning CEN-12) and report branches/commits/merged. Optionally persist into the task dev: field.', {
  id: z.string(),
  repo: z.string().describe('absolute path to the git repo to scan'),
  persist: z.boolean().optional().describe('write the findings into the task dev: field'),
  dir: z.string().optional(),
}, async ({ id, repo, persist, dir }) => {
  try {
    const f = findFileById(id, dir); if (!f) return err(`no task ${id}`);
    const git = (args: string[]) => { try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
    const idU = id.toUpperCase();
    const branches = git(['branch', '-a', '--format=%(refname:short)']).split('\n').filter((b) => b && b.toUpperCase().includes(idU));
    const commits = git(['log', '--all', `--grep=${idU}`, '-i', '--oneline', '-n', '50']).split('\n').filter(Boolean);
    const base = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '') || 'main';
    const mergedSet = new Set(git(['branch', '-a', '--merged', base, '--format=%(refname:short)']).split('\n').filter(Boolean));
    const merged = branches.filter((b) => mergedSet.has(b));
    const dev = [...branches.map((b) => `branch:${b}`), ...commits.slice(0, 20).map((c) => `commit:${c}`), ...merged.map((b) => `merged:${b}`)];
    if (persist) await withLock(dir, () => { const t = parseTask(f); t.dev = dev; t.updated = now(); writeFileSync(f, renderTask(t)); });
    return ok({ id: idU, repo, branches, commits, mergedBranches: merged, persisted: !!persist });
  } catch (e: any) { return err(String(e?.message ?? e)); }
});

server.tool('task_qmetry', 'Attach a QMetry reference to the task (a suite or a run, with an optional result). Passive ref stored in the task qmetry: field. Re-attaching the same id replaces it; remove=true detaches.', {
  id: z.string(),
  kind: z.enum(['suite', 'run']),
  ref: z.string().describe('the QMetry id, e.g. a suite QS-12 or a run QR-88'),
  result: z.string().optional().describe('for a run: passed|failed|blocked|…'),
  remove: z.boolean().optional(),
  dir: z.string().optional(),
}, async ({ id, kind, ref, result, remove, dir }) => {
  try {
    return ok(await withLock(dir, () => {
      const f = findFileById(id, dir); if (!f) throw new Error(`no task ${id}`);
      const t = parseTask(f);
      const key = `${kind}:${ref}`;
      t.qmetry = t.qmetry.filter((q) => q !== key && !q.startsWith(key + ':'));
      if (!remove) t.qmetry.push(`${key}${result ? ':' + result : ''}`);
      t.updated = now(); writeFileSync(f, renderTask(t));
      return { id: t.id, qmetry: t.qmetry };
    }));
  } catch (e: any) { return err(String(e?.message ?? e)); }
});

server.tool('task_tree', 'Show the parent/child hierarchy as a tree (epic⊃story⊃task⊃subtask). Optional root id; else all top-level (parentless) tasks.', {
  root: z.string().optional(),
  dir: z.string().optional(),
}, async ({ root, dir }) => {
  const tasks = listFiles(dir).map(parseTask);
  const byParent = new Map<string, Task[]>();
  for (const t of tasks) { const p = t.parent.toUpperCase(); if (!byParent.has(p)) byParent.set(p, []); byParent.get(p)!.push(t); }
  const node = (t: Task): unknown => ({ id: t.id, type: t.type, title: t.title, status: t.status, children: (byParent.get(t.id.toUpperCase()) ?? []).sort((a, b) => a.ordinal - b.ordinal).map(node) });
  if (root) { const f = findFileById(root, dir); if (!f) return err(`no task ${root}`); return ok(node(parseTask(f))); }
  return ok(tasks.filter((t) => !t.parent).sort((a, b) => a.ordinal - b.ordinal).map(node));
});

server.tool('set_home', 'Set the DEFAULT backlog dir (persisted per-user), so later calls need no `dir`. Explicit `dir` still overrides per call. Optionally init the dir (create tasks/ + config.yml) when it is empty.', {
  path: z.string().describe('absolute path to the backlog dir — the folder that contains (or will contain) tasks/'),
  init: z.boolean().optional().describe('create tasks/ + a default config.yml if missing'),
  prefix: z.string().optional().describe('task id prefix when init-ing a fresh backlog, e.g. TASK'),
}, async ({ path, init, prefix }) => {
  try {
    const home = writeHome(path);
    if (init) {
      mkdirSync(join(home, 'tasks'), { recursive: true });
      const cfg = join(home, 'config.yml');
      if (!existsSync(cfg)) writeFileSync(cfg, `task_prefix: "${prefix ?? 'TASK'}"\ndefault_status: "To Do"\nstatuses: ["To Do", "In Progress", "Done"]\n`);
    }
    return ok({ home, tasksDir: existsSync(join(home, 'tasks')), config: existsSync(join(home, 'config.yml')), note: 'later task_* calls default here; pass `dir` to override' });
  } catch (e: any) { return err(String(e?.message ?? e)); }
});

server.tool('get_home', 'Show the current default backlog dir and how it was resolved.', {}, async () => {
  const home = readHome();
  return ok({ home: home ?? null, resolved: backlogDir(), source: home ? 'set_home' : (process.env.BACKLOG_DIR ? 'BACKLOG_DIR' : 'cwd/backlog'), config: configPath() });
});

// ── Transport ────────────────────────────────────────────────────────────────
// Default: stdio (Claude Code manages the process). Set MCP_PORT to run as HTTP.

if (process.env.BACKLOG_MCP_LIB) {
  // imported as a library (tests) — do not start a transport
} else if (process.env.MCP_PORT) {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  app.post('/mcp', async (req, res) => {
    const incomingId = req.headers['mcp-session-id'] as string | undefined;
    if (incomingId && sessions.has(incomingId)) { await sessions.get(incomingId)!.handleRequest(req, res, req.body); return; }
    const sessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
    sessions.set(sessionId, transport);
    transport.onclose = () => sessions.delete(sessionId);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const PORT = Number(process.env.MCP_PORT);
  app.listen(PORT, () => console.error(`Backlog MCP → http://localhost:${PORT}/mcp`));
} else {
  (async () => { await server.connect(new StdioServerTransport()); })();
}
