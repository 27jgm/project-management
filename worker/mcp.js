/* Stateless MCP server (Streamable HTTP, JSON responses) over the same D1 data the UI uses.
   Tool names follow Linear's MCP so existing prompts and habits carry over. */
import { allocateKey, deleteStmt, getSetting, upsertStmt } from './repo.js';
import {
  LABELS,
  PRIORITIES,
  PRIORITY_NAMES,
  PROJECT_COLORS,
  PROJECT_STATUSES,
  STATUSES,
  STATUS_NAMES,
  activity,
  htmlToMd,
  mdToHtml,
  newProject,
  newTask,
  uid,
} from './model.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

class ToolError extends Error {}
const fail = msg => {
  throw new ToolError(msg);
};

/* ---------- lookups ---------- */
async function findProject(db, ref) {
  if (!ref) fail('project is required');
  const row = await db.prepare('SELECT seq, data FROM projects WHERE id = ?1 OR key = ?1 COLLATE NOCASE OR name = ?1 COLLATE NOCASE LIMIT 1').bind(ref).first();
  if (!row) fail(`Project not found: ${ref}`);
  return { ...JSON.parse(row.data), seq: row.seq };
}
async function findTask(db, ref) {
  if (!ref) fail('issue is required');
  const row = await db.prepare('SELECT data FROM tasks WHERE id = ?1 OR key = ?1 COLLATE NOCASE LIMIT 1').bind(ref).first();
  if (!row) fail(`Issue not found: ${ref}`);
  return JSON.parse(row.data);
}
const oneOf = (name, v, allowed) => (allowed.includes(v) ? v : fail(`${name} must be one of: ${allowed.join(', ')}`));

/* ---------- presenters ---------- */
const projectView = p => ({
  id: p.id,
  key: p.key,
  name: p.name,
  status: p.status,
  description: htmlToMd(p.desc),
  start: p.start,
  due: p.due,
  color: p.color,
  icon: p.icon,
  archived: !!p.archived,
});
const issueView = (t, full) => ({
  key: t.key,
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  labels: t.labels,
  start: t.start,
  due: t.due,
  estimate: t.estimate,
  project: t.project,
  archived: !!t.archived,
  updated: new Date(t.updated).toISOString(),
  ...(full && { description: htmlToMd(t.desc), subtasks: t.subtasks }),
});
const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

/* ---------- writes ---------- */
async function me(db) {
  return getSetting(db, 'me', 'm1');
}
async function nextOrder(db) {
  const r = await db.prepare("SELECT MAX(json_extract(data, '$.order')) AS n FROM tasks").first();
  return (r?.n || 0) + 1;
}

function applyIssueFields(t, a) {
  if (a.title !== undefined) t.title = a.title;
  if (a.description !== undefined) t.desc = mdToHtml(a.description);
  if (a.status !== undefined) t.status = oneOf('status', a.status, STATUSES);
  if (a.priority !== undefined) t.priority = oneOf('priority', a.priority, PRIORITIES);
  if (a.labels !== undefined) t.labels = a.labels.map(l => oneOf('label', l, LABELS));
  if (a.due !== undefined) t.due = a.due;
  if (a.start !== undefined) t.start = a.start;
  if (a.estimate !== undefined) t.estimate = a.estimate;
  if (a.archived !== undefined) t.archived = a.archived;
  for (const s of a.add_subtasks || []) t.subtasks.push({ id: uid('s'), title: s, done: false });
  for (const s of a.complete_subtasks || []) {
    const sub = t.subtasks.find(x => x.id === s || x.title.toLowerCase() === s.toLowerCase());
    if (sub) sub.done = true;
  }
  t.updated = Date.now();
}

/* ---------- tools ---------- */
const str = description => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'list_projects',
    description: 'List projects. Each has a short key (e.g. WEB) used as the prefix of its issue keys.',
    inputSchema: { type: 'object', properties: { query: str('Match against name or key'), include_archived: { type: 'boolean' } } },
    async run(db, a) {
      const rows = (await db.prepare('SELECT seq, data FROM projects ORDER BY rowid').all()).results;
      const q = a.query?.toLowerCase();
      return rows
        .map(r => ({ ...JSON.parse(r.data), seq: r.seq }))
        .filter(p => (a.include_archived || !p.archived) && (!q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)))
        .map(projectView);
    },
  },
  {
    name: 'get_project',
    description: 'Get one project by id, key or name, with issue counts per status.',
    inputSchema: { type: 'object', properties: { project: str('Project id, key or name') }, required: ['project'] },
    async run(db, a) {
      const p = await findProject(db, a.project);
      const counts = (await db.prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE project = ? AND archived = 0 GROUP BY status').bind(p.id).all()).results;
      return { ...projectView(p), issues_by_status: Object.fromEntries(counts.map(c => [c.status, c.n])) };
    },
  },
  {
    name: 'save_project',
    description: 'Create a project (name and key required) or update one (pass project).',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Existing project id, key or name. Omit to create.'),
        name: str('Project name'),
        key: str('2-5 letter uppercase prefix for issue keys. Required when creating.'),
        description: str('Markdown'),
        status: { type: 'string', enum: PROJECT_STATUSES },
        color: { type: 'string', enum: PROJECT_COLORS },
        icon: str('Lucide icon name'),
        start: str('YYYY-MM-DD'),
        due: str('YYYY-MM-DD'),
        archived: { type: 'boolean' },
      },
    },
    async run(db, a) {
      let p;
      const stmts = [];
      if (a.project) p = await findProject(db, a.project);
      else {
        if (!a.name || !a.key) fail('name and key are required to create a project');
        const key = a.key.toUpperCase();
        if (!/^[A-Z][A-Z0-9]{1,4}$/.test(key)) fail('key must be 2-5 letters/digits starting with a letter');
        if (await db.prepare('SELECT 1 FROM projects WHERE key = ?').bind(key).first()) fail(`Project key already in use: ${key}`);
        p = newProject({ id: uid('p'), key, name: a.name, members: [await me(db)] });
        const order = await getSetting(db, 'projOrder', []);
        stmts.push(
          db
            .prepare('INSERT INTO settings (key, value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2')
            .bind('projOrder', JSON.stringify([...order, p.id])),
        );
        stmts.push(upsertStmt(db, 'activity', activity(await me(db), 'created project', null, p.id)));
      }
      if (a.name) p.name = a.name;
      if (a.description !== undefined) p.desc = mdToHtml(a.description);
      if (a.status) p.status = oneOf('status', a.status, PROJECT_STATUSES);
      if (a.color) p.color = oneOf('color', a.color, PROJECT_COLORS);
      for (const k of ['icon', 'start', 'due', 'archived']) if (a[k] !== undefined) p[k] = a[k];
      stmts.push(upsertStmt(db, 'projects', p));
      await db.batch(stmts);
      return projectView(p);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues, newest-updated first. All filters are optional and combine with AND.',
    inputSchema: {
      type: 'object',
      properties: {
        project: str('Project id, key or name'),
        status: { type: 'string', enum: STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        label: { type: 'string', enum: LABELS },
        query: str('Substring of title'),
        due_before: str('YYYY-MM-DD, inclusive'),
        updated_since: str('ISO timestamp or YYYY-MM-DD'),
        include_archived: { type: 'boolean' },
        limit: { type: 'number', description: 'Default 50, max 250' },
      },
    },
    async run(db, a) {
      const where = [];
      const args = [];
      const add = (sql, v) => (where.push(sql), args.push(v));
      if (a.project) add('project = ?', (await findProject(db, a.project)).id);
      if (a.status) add('status = ?', oneOf('status', a.status, STATUSES));
      if (a.priority) add('priority = ?', oneOf('priority', a.priority, PRIORITIES));
      if (a.label) add("EXISTS (SELECT 1 FROM json_each(tasks.data, '$.labels') WHERE value = ?)", a.label);
      if (a.query) add("json_extract(data, '$.title') LIKE ?", `%${a.query}%`);
      if (a.due_before) add('due IS NOT NULL AND due <= ?', a.due_before);
      if (a.updated_since) add('updated >= ?', Date.parse(a.updated_since) || fail('updated_since is not a valid date'));
      if (!a.include_archived) where.push('archived = 0');
      const limit = Math.min(Math.max(a.limit || 50, 1), 250);
      const sql = `SELECT data FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated DESC LIMIT ${limit}`;
      return (
        await db
          .prepare(sql)
          .bind(...args)
          .all()
      ).results.map(r => issueView(JSON.parse(r.data)));
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by key (e.g. WEB-204) or id, including description, subtasks and comments.',
    inputSchema: { type: 'object', properties: { issue: str('Issue key or id') }, required: ['issue'] },
    async run(db, a) {
      const t = await findTask(db, a.issue);
      const comments = (await db.prepare('SELECT data FROM comments WHERE task = ? ORDER BY at').bind(t.id).all()).results.map(r => {
        const c = JSON.parse(r.data);
        return { id: c.id, at: new Date(c.at).toISOString(), text: htmlToMd(c.text) };
      });
      return { ...issueView(t, true), comments };
    },
  },
  {
    name: 'save_issue',
    description: 'Create an issue (project and title required) or update one (pass issue). Only the fields you pass change. Archive instead of deleting.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: str('Existing issue key or id. Omit to create.'),
        project: str('Project id, key or name. Required when creating.'),
        title: str('Title'),
        description: str('Markdown'),
        status: {
          type: 'string',
          enum: STATUSES,
          description: Object.entries(STATUS_NAMES)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
        },
        priority: {
          type: 'string',
          enum: PRIORITIES,
          description: Object.entries(PRIORITY_NAMES)
            .map(([k, v]) => `${k}=${v}`)
            .join(', '),
        },
        labels: { type: 'array', items: { type: 'string', enum: LABELS }, description: 'Replaces the existing labels' },
        start: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
        estimate: { type: ['string', 'null'], description: 'e.g. 2d' },
        add_subtasks: { type: 'array', items: { type: 'string' }, description: 'Titles of subtasks to append' },
        complete_subtasks: { type: 'array', items: { type: 'string' }, description: 'Subtask ids or titles to mark done' },
        archived: { type: 'boolean' },
      },
    },
    async run(db, a) {
      const by = await me(db);
      let t;
      let verb;
      if (a.issue) {
        t = await findTask(db, a.issue);
        const old = { status: t.status, archived: t.archived };
        applyIssueFields(t, a);
        verb = t.status !== old.status ? (t.status === 'done' ? 'completed' : 'moved') : t.archived !== old.archived ? 'archived' : 'updated';
      } else {
        if (!a.title) fail('title is required to create an issue');
        const p = await findProject(db, a.project);
        const key = await allocateKey(db, p.id);
        t = newTask(p.id, { id: uid('t'), key, assignee: by }, await nextOrder(db));
        applyIssueFields(t, a);
        verb = 'created';
      }
      await db.batch([
        upsertStmt(db, 'tasks', t),
        upsertStmt(db, 'activity', activity(by, verb, t, t.project, verb === 'moved' ? `to ${STATUS_NAMES[t.status]}` : '')),
      ]);
      return issueView(t, true);
    },
  },
  {
    name: 'list_comments',
    description: 'List comments on an issue, oldest first.',
    inputSchema: { type: 'object', properties: { issue: str('Issue key or id') }, required: ['issue'] },
    async run(db, a) {
      const t = await findTask(db, a.issue);
      return (await db.prepare('SELECT data FROM comments WHERE task = ? ORDER BY at').bind(t.id).all()).results.map(r => {
        const c = JSON.parse(r.data);
        return { id: c.id, at: new Date(c.at).toISOString(), text: htmlToMd(c.text) };
      });
    },
  },
  {
    name: 'save_comment',
    description: 'Add a comment to an issue, or edit one (pass id).',
    inputSchema: {
      type: 'object',
      properties: { issue: str('Issue key or id'), body: str('Markdown'), id: str('Existing comment id to edit') },
      required: ['issue', 'body'],
    },
    async run(db, a) {
      const t = await findTask(db, a.issue);
      let c;
      if (a.id) {
        const row = await db.prepare('SELECT data FROM comments WHERE id = ? AND task = ?').bind(a.id, t.id).first();
        if (!row) fail(`Comment not found: ${a.id}`);
        c = { ...JSON.parse(row.data), text: mdToHtml(a.body) };
      } else c = { id: uid('c'), task: t.id, by: await me(db), at: Date.now(), text: mdToHtml(a.body), re: {} };
      const stmts = [upsertStmt(db, 'comments', c)];
      if (!a.id) stmts.push(upsertStmt(db, 'activity', activity(c.by, 'commented on', t, t.project)));
      await db.batch(stmts);
      return { id: c.id, at: new Date(c.at).toISOString(), text: a.body };
    },
  },
  {
    name: 'delete_comment',
    description: 'Delete a comment by id.',
    inputSchema: { type: 'object', properties: { id: str('Comment id') }, required: ['id'] },
    async run(db, a) {
      await deleteStmt(db, 'comments', a.id).run();
      return 'Deleted';
    },
  },
  {
    name: 'list_issue_statuses',
    description: 'The fixed set of issue statuses, in workflow order.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => STATUSES.map(id => ({ id, name: STATUS_NAMES[id] })),
  },
  {
    name: 'list_issue_labels',
    description: 'The fixed set of issue labels and priorities accepted by save_issue.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => ({ labels: LABELS, priorities: PRIORITIES }),
  },
];

/* ---------- JSON-RPC ---------- */
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(msg, env) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return null; // notification
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'do', version: '1.0.0' },
        instructions: 'Personal project management (replaces Linear/Jira). Issues are addressed by key, e.g. WEB-204. Descriptions and comments are Markdown.',
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      try {
        return rpcResult(id, text(await tool.run(env.DB, params.arguments || {})));
      } catch (e) {
        if (!(e instanceof ToolError)) console.error(e);
        return rpcResult(id, { isError: true, ...text(e instanceof ToolError ? e.message : 'Internal error') });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 });
  }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(m => dispatch(m, env)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}
