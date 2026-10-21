/* Entity shapes shared by the sync endpoint and the MCP tools. They mirror what the UI creates
   (src/actions/actions.js createTask) so rows written here render without any migration. */

export const STATUSES = ['backlog', 'todo', 'progress', 'review', 'done'];
export const STATUS_NAMES = { backlog: 'Backlog', todo: 'To Do', progress: 'In Progress', review: 'Review', done: 'Done' };
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
export const PRIORITY_NAMES = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };
export const LABELS = ['design', 'frontend', 'backend', 'research', 'content', 'bug', 'qa', 'growth'];
export const PROJECT_STATUSES = ['planning', 'active', 'risk', 'hold', 'complete'];
export const PROJECT_COLORS = ['indigo', 'blue', 'violet', 'teal', 'rose', 'amber', 'green', 'slate'];

export const uid = p => p + crypto.randomUUID().replace(/-/g, '').slice(0, 8);

export function newTask(project, fields, order) {
  const now = Date.now();
  return {
    project,
    title: 'Untitled',
    status: 'todo',
    assignee: null,
    priority: 'none',
    due: null,
    start: null,
    labels: [],
    subtasks: [],
    attachments: [],
    deps: [],
    desc: '',
    estimate: null,
    created: now,
    updated: now,
    order,
    fav: false,
    recur: null,
    ...fields,
  };
}

export function newProject(fields) {
  return {
    icon: 'folder',
    color: 'indigo',
    status: 'active',
    team: '',
    lead: null,
    due: null,
    start: null,
    fav: false,
    members: [],
    desc: '',
    milestones: [],
    seq: 0,
    ...fields,
  };
}

export function activity(by, verb, task, project, extra = '') {
  return { id: uid('a'), by, verb, task: task?.id || null, project: project || task?.project || null, at: Date.now(), extra };
}

/* ---------- description: the UI stores HTML, MCP clients read and write Markdown ---------- */
const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = s =>
  escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

export function mdToHtml(md) {
  const out = [];
  let list = null;
  const close = () => list && (out.push(`</${list}>`), (list = null));
  for (const line of String(md ?? '').split('\n')) {
    const ul = /^\s*[-*]\s+(.*)/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
    const h = /^(#{1,3})\s+(.*)/.exec(line);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (list !== tag) (close(), out.push(`<${tag}>`), (list = tag));
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else {
      close();
      if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('');
}

export function htmlToMd(html) {
  return String(html ?? '')
    .replace(/<h([1-3])[^>]*>(.*?)<\/h\1>/gi, (_, n, t) => `${'#'.repeat(n)} ${t}\n\n`)
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<\/(ul|ol|p)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(b|strong)>(.*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>(.*?)<\/\1>/gi, '*$2*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* A fresh database holds nothing but the workspace shell and one member: the signed-in owner. */
export function emptyWorkspace(user) {
  const email = user.email || 'owner@localhost';
  const name = email.split('@')[0];
  return {
    settings: {
      ws: { name: 'Personal', url: 'do', c: '#1D1C1A' },
      workspaces: [{ id: 'w1', name: 'Personal', c: '#1D1C1A', plan: 'Personal' }],
      me: 'm1',
      projOrder: [],
      recentSearches: [],
      sessions: [],
      invoices: [],
      tfa: false,
      notifPrefs: {
        email_mention: false,
        email_assign: false,
        email_digest: false,
        email_comment: false,
        push_mention: false,
        push_assign: false,
        push_comment: false,
        push_due: true,
        mention_all: false,
        assign_self: true,
      },
      prefs: { name, title: '' },
    },
    records: {
      members: [{ id: 'm1', name, email, role: 'Owner', team: '', title: '', c: '#5A67D8', status: 'active', last: 0, tz: '' }],
    },
  };
}
export const COLLECTIONS = ['members', 'projects', 'tasks', 'comments', 'activity', 'notifs', 'files', 'events', 'savedViews', 'teams'];
