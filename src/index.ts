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
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

// ── Backlog dir + config ─────────────────────────────────────────────────────

function backlogDir(dir?: string): string {
  return resolve(dir ?? process.env.BACKLOG_DIR ?? join(process.cwd(), 'backlog'));
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
  assignee: string[];
  labels: string[];
  dependencies: string[];
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
    assignee: parseList(raw, 'assignee'), labels: parseList(raw, 'labels'), dependencies: parseList(raw, 'dependencies'),
    ordinal: Number(fm.ordinal ?? 0), created: fm.created_date ?? '', updated: fm.updated_date ?? '',
    ac: parseAc(raw), plan: between(raw, PLAN_BEGIN, PLAN_END), notes: between(raw, NOTES_BEGIN, NOTES_END), file,
  };
}

function renderTask(t: Omit<Task, 'file'>): string {
  const fm = [
    '---',
    `id: ${t.id}`,
    `title: ${yamlScalar(t.title)}`,
    `status: ${yamlScalar(t.status)}`,
    `assignee: ${t.assignee.length ? '\n' + t.assignee.map((a) => `  - ${yamlScalar(a)}`).join('\n') : '[]'}`,
    `created_date: '${t.created}'`,
    `updated_date: '${t.updated}'`,
    `labels: ${t.labels.length ? '\n' + t.labels.map((l) => `  - ${yamlScalar(l)}`).join('\n') : '[]'}`,
    `dependencies: ${t.dependencies.length ? '\n' + t.dependencies.map((d) => `  - ${yamlScalar(d)}`).join('\n') : '[]'}`,
    `ordinal: ${t.ordinal}`,
    '---',
  ].join('\n');
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

const server = new McpServer({ name: 'backlog', version: '0.1.0' });
const ok = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const err = (m: string) => ({ isError: true, content: [{ type: 'text' as const, text: m }] });
const summary = (t: Task) => ({ id: t.id, title: t.title, status: t.status, labels: t.labels, acDone: t.ac.filter((a) => a.checked).length, acTotal: t.ac.length });

server.tool('task_list', 'List backlog tasks (id, title, status, labels, AC progress). Optional status filter.', {
  dir: z.string().optional().describe('backlog dir; default $BACKLOG_DIR or <cwd>/backlog'),
  status: z.string().optional().describe('filter by exact status, e.g. "In Progress"'),
}, async ({ dir, status }) => {
  let tasks = listFiles(dir).map(parseTask);
  if (status) tasks = tasks.filter((t) => t.status.toLowerCase() === status.toLowerCase());
  tasks.sort((a, b) => a.ordinal - b.ordinal);
  return ok(tasks.map(summary));
});

server.tool('task_get', 'Read one task in full (frontmatter + acceptance criteria + plan + notes).', {
  id: z.string().describe('task id, e.g. TASK-57 or CEN-24'),
  dir: z.string().optional(),
}, async ({ id, dir }) => {
  const f = findFileById(id, dir); if (!f) return err(`no task ${id}`);
  const t = parseTask(f);
  return ok({ ...summary(t), assignee: t.assignee, created: t.created, updated: t.updated, ac: t.ac, plan: t.plan, notes: t.notes, file: t.file });
});

server.tool('task_create', 'Create a task with an ATOMIC collision-safe id (never overwrites). Structured params — no shell escaping.', {
  title: z.string().describe('task title'),
  acceptanceCriteria: z.array(z.string()).optional().describe('acceptance criteria, one requirement each'),
  plan: z.string().optional(),
  notes: z.string().optional(),
  labels: z.array(z.string()).optional(),
  status: z.string().optional().describe('default = the backlog default status'),
  dir: z.string().optional(),
}, async (p) => {
  try { return ok(await createTask(p)); } catch (e: any) { return err(String(e?.message ?? e)); }
});

/** Allocate an id and write a new task — the whole thing under the dir lock so concurrent
 *  creates can never collide. `wx` on the write is the final guard against ever clobbering. */
export async function createTask(p: {
  title: string; acceptanceCriteria?: string[]; plan?: string; notes?: string; labels?: string[]; status?: string; dir?: string;
}): Promise<{ created: string; file: string }> {
  const { dir } = p;
  return withLock(dir, () => {
    const { id, num } = nextId(dir); // allocated INSIDE the lock → race-free
    const file = join(tasksDir(dir), `${id.toLowerCase()} - ${slug(p.title)}.md`);
    if (allIds(dir).has(id) || existsSync(file)) throw new Error(`id ${id} would collide — aborted`);
    const cfg = readConfig(dir);
    const ts = now();
    const task: Omit<Task, 'file'> = {
      id, title: p.title, status: p.status ?? cfg.defaultStatus, assignee: [], labels: p.labels ?? [], dependencies: [],
      ordinal: num * 1000, created: ts, updated: ts,
      ac: (p.acceptanceCriteria ?? []).map((text) => ({ checked: false, text })), plan: p.plan ?? '', notes: p.notes ?? '',
    };
    writeFileSync(file, renderTask(task), { flag: 'wx' }); // wx = fail if exists, never clobber
    return { created: id, file };
  });
}

server.tool('task_update', 'Update a task: status, plan, notes (replace), append a comment to notes, or check/uncheck an AC by number.', {
  id: z.string(),
  status: z.string().optional(),
  plan: z.string().optional().describe('REPLACES the plan section'),
  notes: z.string().optional().describe('REPLACES the notes section'),
  comment: z.string().optional().describe('APPENDS a timestamped line to the notes section'),
  checkAc: z.number().optional().describe('1-based AC number to mark done'),
  uncheckAc: z.number().optional().describe('1-based AC number to mark not-done'),
  dir: z.string().optional(),
}, async ({ id, status, plan, notes, comment, checkAc, uncheckAc, dir }) => {
  try {
    return ok(await withLock(dir, () => {
      const f = findFileById(id, dir); if (!f) throw new Error(`no task ${id}`);
      const t = parseTask(f);
      if (status) t.status = status;
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
