/* D1 access: loading the whole workspace for the UI, applying UI diffs, and the helpers the MCP
   tools share. Typed tables keep derived, indexable columns next to the JSON entity. */
import { COLLECTIONS, emptyWorkspace } from './model.js';

const now = () => Date.now();
const J = JSON.stringify;

/* Per-kind SQL: derives the indexed columns from the entity JSON. */
const TYPED = {
  projects: {
    sql: `INSERT INTO projects (id, key, name, archived, seq, updated, data) VALUES (?1,?2,?3,?4,?5,?6,?7)
          ON CONFLICT(id) DO UPDATE SET key=?2, name=?3, archived=?4, seq=MAX(projects.seq, ?5), updated=?6, data=?7`,
    bind: p => [p.id, p.key, p.name, p.archived ? 1 : 0, p.seq || 0, now(), J(p)],
  },
  tasks: {
    sql: `INSERT INTO tasks (id, key, project, status, priority, assignee, due, archived, updated, data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
          ON CONFLICT(id) DO UPDATE SET key=?2, project=?3, status=?4, priority=?5, assignee=?6, due=?7, archived=?8, updated=?9, data=?10`,
    bind: t => [t.id, t.key, t.project, t.status, t.priority || 'none', t.assignee || null, t.due || null, t.archived ? 1 : 0, t.updated || now(), J(t)],
  },
  comments: {
    sql: `INSERT INTO comments (id, task, at, data) VALUES (?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET task=?2, at=?3, data=?4`,
    bind: c => [c.id, c.task, c.at || now(), J(c)],
  },
};

export function upsertStmt(db, kind, entity) {
  const t = TYPED[kind];
  if (t) return db.prepare(t.sql).bind(...t.bind(entity));
  return db.prepare('INSERT INTO records (kind, id, data) VALUES (?1,?2,?3) ON CONFLICT(kind, id) DO UPDATE SET data=?3').bind(kind, entity.id, J(entity));
}
export function deleteStmt(db, kind, id) {
  if (TYPED[kind]) return db.prepare(`DELETE FROM ${kind} WHERE id = ?`).bind(id);
  return db.prepare('DELETE FROM records WHERE kind = ?1 AND id = ?2').bind(kind, id);
}

const parseRows = rows => rows.map(r => JSON.parse(r.data));

async function bootstrap(db, user) {
  const { settings, records } = emptyWorkspace(user);
  const stmts = Object.entries(settings).map(([k, v]) => db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?1,?2)').bind(k, J(v)));
  for (const [kind, list] of Object.entries(records)) for (const e of list) stmts.push(upsertStmt(db, kind, e));
  await db.batch(stmts);
}

/* Everything the UI needs, shaped like the old localStorage blob: { data, prefs, views }. */
export async function loadState(db, user) {
  if (!(await db.prepare("SELECT 1 FROM settings WHERE key = 'me'").first())) await bootstrap(db, user);
  const [projects, tasks, comments, records, settings] = await db.batch([
    db.prepare('SELECT seq, data FROM projects ORDER BY rowid'),
    db.prepare('SELECT data FROM tasks ORDER BY rowid'),
    db.prepare('SELECT data FROM comments ORDER BY at'),
    db.prepare('SELECT kind, data FROM records ORDER BY rowid'),
    db.prepare('SELECT key, value FROM settings'),
  ]);
  const data = Object.fromEntries(COLLECTIONS.map(k => [k, []]));
  // `seq` is bumped server-side by the MCP tools, so the column is authoritative.
  data.projects = projects.results.map(r => ({ ...JSON.parse(r.data), seq: r.seq }));
  data.tasks = parseRows(tasks.results);
  data.comments = parseRows(comments.results);
  for (const r of records.results) (data[r.kind] ||= []).push(JSON.parse(r.data));
  const s = Object.fromEntries(settings.results.map(r => [r.key, JSON.parse(r.value)]));
  const { prefs, views, ...rest } = s;
  Object.assign(data, rest);
  return { data, prefs: prefs || {}, views: views || {} };
}

/* Hands out the next issue number for a project. Atomic, so the UI and MCP never share a key. */
export async function allocateKey(db, projectId) {
  const row = await db.prepare('UPDATE projects SET seq = MAX(seq, 200) + 1 WHERE id = ? RETURNING key, seq').bind(projectId).first();
  return row ? `${row.key}-${row.seq}` : null;
}

/* Applies a UI diff: { upserts: {kind: [entity]}, deletes: {kind: [id]}, settings: {key: value} }.
   Returns { rekeyed } for tasks whose key was taken by an issue created elsewhere in the meantime. */
export async function applySync(db, body) {
  const upserts = body.upserts || {};
  const rekeyed = {};
  const tasks = upserts.tasks || [];
  if (tasks.length) {
    const keys = [...new Set(tasks.map(t => t.key))];
    const taken = await db
      .prepare(`SELECT id, key FROM tasks WHERE key IN (${keys.map(() => '?').join(',')})`)
      .bind(...keys)
      .all();
    const owner = new Map(taken.results.map(r => [r.key, r.id]));
    for (const t of tasks) {
      if (owner.has(t.key) && owner.get(t.key) !== t.id) {
        t.key = await allocateKey(db, t.project);
        rekeyed[t.id] = t.key;
      }
    }
  }
  const stmts = [];
  for (const [kind, list] of Object.entries(upserts)) for (const e of list) stmts.push(upsertStmt(db, kind, e));
  for (const [kind, ids] of Object.entries(body.deletes || {})) for (const id of ids) stmts.push(deleteStmt(db, kind, id));
  for (const [k, v] of Object.entries(body.settings || {}))
    stmts.push(db.prepare('INSERT INTO settings (key, value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2').bind(k, J(v)));
  for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
  return { rekeyed };
}

export async function getSetting(db, key, fallback) {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return r ? JSON.parse(r.value) : fallback;
}
