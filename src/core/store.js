/* ---------- store ---------- */
import { TODAY, diffD, iso, parse, uid } from './utils.js';
import { PCOLORS, TEAMS_SEED } from './constants.js';

const COLLAPSED_KEY = 'do.sidebar-collapsed';
/* Server-backed collections: synced one entity at a time. Every other key of S.data is a setting. */
export const ENTITY_KINDS = ['members', 'projects', 'tasks', 'comments', 'activity', 'notifs', 'files', 'events', 'savedViews', 'teams'];
const emptyData = () => ({ ...Object.fromEntries(ENTITY_KINDS.map(k => [k, []])), ws: {}, workspaces: [], me: '', projOrder: [] });
export const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'indigo',
  side: 'comfortable',
  density: 'comfortable',
  weekStart: 1,
  dateFmt: 'MMM d',
  lang: 'English (US)',
  tz: '(GMT-03:00) Buenos Aires',
  motion: 'system',
  home: 'home',
  openTasks: 'drawer',
  name: '',
  title: '',
};
export const S = {
  data: emptyData(),
  prefs: { ...DEFAULT_PREFS },
  views: {},
  ui: {
    fx: {},
    auth: null,
    authStep: 'login',
    onb: 0,
    onbData: { use: 'product', team: 'kanban', size: '2-10', ws: '', proj: 'Website Launch', tmpl: 'web', invites: '' },
    route: 'home',
    params: {},
    history: [],
    collapsed: localStorage.getItem(COLLAPSED_KEY) === '1',
    mnav: false,
    expanded: { p1: true },
    drawer: null,
    drawerFull: false,
    drawerTab: 'comments',
    modals: [],
    pop: null,
    palette: null,
    loading: false,
    offline: false,
    sel: new Set(),
    composer: null,
    editCell: null,
    openTasks: {},
    collapsedGroups: {},
    calDate: iso(TODAY),
    calMode: 'month',
    tlZoom: 'week',
    tlGroup: 'status',
    fileView: 'grid',
    projView: 'grid',
    homeTab: 'upcoming',
    inboxCat: 'all',
    inboxUnread: false,
    inboxSel: null,
    notifFilter: 'all',
    settings: 'appearance',
    searchQ: '',
    searchCat: 'all',
    myView: 'list',
    membersTab: 'members',
    collapsedCols: {},
    errors: {},
    drafts: {},
  },
};
/* ---------- persistence: D1 via the Worker ---------- */
let synced = new Map(); // "kind/id" or "@setting" -> JSON last known to the server
let queue = Promise.resolve();
let onRemoteChange = () => {};
export const onRemote = fn => (onRemoteChange = fn);

function snapshot() {
  const snap = new Map();
  for (const [k, v] of Object.entries(S.data)) {
    if (ENTITY_KINDS.includes(k)) for (const e of v) snap.set(`${k}/${e.id}`, JSON.stringify(e));
    else snap.set(`@${k}`, JSON.stringify(v));
  }
  snap.set('@prefs', JSON.stringify(S.prefs));
  snap.set('@views', JSON.stringify(S.views));
  return snap;
}
function entityOf(kind, id) {
  return S.data[kind].find(e => e.id === id);
}

export async function hydrate() {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load workspace (${res.status})`);
  const { data, prefs, views } = await res.json();
  S.data = Object.assign(emptyData(), data);
  for (const k of ['activity', 'notifs']) S.data[k].sort((a, b) => (b.at || 0) - (a.at || 0));
  S.prefs = { ...DEFAULT_PREFS, ...prefs };
  S.views = views;
  synced = snapshot();
  S.ui.offline = false;
}

function push() {
  const now = snapshot();
  const upserts = {},
    deletes = {},
    settings = {};
  for (const [k, json] of now) {
    if (synced.get(k) === json) continue;
    if (k[0] === '@') settings[k.slice(1)] = JSON.parse(json);
    else {
      const [kind, id] = k.split('/');
      (upserts[kind] ||= []).push(entityOf(kind, id));
    }
  }
  for (const k of synced.keys()) {
    if (!now.has(k) && k[0] !== '@') {
      const [kind, id] = k.split('/');
      (deletes[kind] ||= []).push(id);
    }
  }
  if (!Object.keys(upserts).length && !Object.keys(deletes).length && !Object.keys(settings).length) return Promise.resolve();
  return fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upserts, deletes, settings }) })
    .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
    .then(({ rekeyed }) => {
      for (const [id, key] of Object.entries(rekeyed || {})) {
        const t = task(id);
        if (t) t.key = key;
      }
      synced = snapshot();
      if (S.ui.offline) S.ui.offline = false;
      if (Object.keys(rekeyed || {}).length) onRemoteChange();
    })
    .catch(() => {
      if (!S.ui.offline) {
        S.ui.offline = true;
        onRemoteChange();
      }
    });
}

export let _saveT;
export function save() {
  try {
    localStorage.setItem(COLLAPSED_KEY, S.ui.collapsed ? '1' : '0');
  } catch {
    /* storage blocked: the sidebar just won't be remembered */
  }
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    queue = queue.then(push);
  }, 150);
}

/* Pulls changes made elsewhere (MCP, another tab) once nothing local is waiting to be pushed. */
export async function refresh() {
  await queue;
  const dirty = [...snapshot()].some(([k, v]) => synced.get(k) !== v);
  if (dirty) return;
  try {
    const before = JSON.stringify([...synced]);
    await hydrate();
    if (JSON.stringify([...synced]) !== before) onRemoteChange();
  } catch {
    /* stay on the data we have */
  }
}

/* ---------- lookups ---------- */
export const D = () => S.data;
export const me = () => D().members.find(m => m.id === D().me);
export const mem = id => D().members.find(m => m.id === id);
export const proj = id => D().projects.find(p => p.id === id);
export const task = id => D().tasks.find(t => t.id === id);
export const pColor = p => PCOLORS[p?.color] || PCOLORS.slate;
export const visibleProjects = () =>
  D()
    .projOrder.map(proj)
    .filter(Boolean)
    .filter(p => !p.archived);
export const canSee = p => !p.private || p.members.includes(D().me);
export const tasksOf = pid => D().tasks.filter(t => t.project === pid && !t.archived);
export const allTasks = () => D().tasks.filter(t => !t.archived && canSee(proj(t.project)));
export const isOver = t => t.due && t.status !== 'done' && diffD(parse(t.due), TODAY) < 0;
export const commentsOf = tid => D().comments.filter(c => c.task === tid);
export function progressOf(pid) {
  const ts = tasksOf(pid);
  if (!ts.length) return 0;
  return Math.round((ts.filter(t => t.status === 'done').length / ts.length) * 100);
}
export function taskProg(t) {
  if (t.status === 'done') return 100;
  if (t.subtasks.length) return Math.round((t.subtasks.filter(s => s.done).length / t.subtasks.length) * 100);
  return { backlog: 0, todo: 5, progress: 45, review: 80 }[t.status] || 0;
}

/* ---------- activity + notification helpers ---------- */
export function logAct(verb, t, extra = '') {
  D().activity.unshift({ id: uid('a'), by: D().me, verb, task: t?.id || null, project: t?.project || null, at: Date.now(), extra });
  if (t) t.updated = Date.now();
}

/* ---------- teams (workspace data, seeded on first use) ---------- */
export const NO_TEAM = { id: '', name: 'No team', icon: 'users', c: '#8A867E', desc: '' };
export function teamsList() {
  const d = D();
  if (!d.teams) d.teams = TEAMS_SEED.map(t => ({ ...t }));
  return d.teams;
}
export function team(id) {
  return teamsList().find(t => t.id === id) || null;
}
export const TM = new Proxy({}, { get: (_, k) => team(k) || NO_TEAM });
