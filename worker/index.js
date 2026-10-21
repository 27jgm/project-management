import { authenticate } from './auth.js';
import { applySync, loadState } from './repo.js';
import { handleMcp } from './mcp.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const user = await authenticate(request, env);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    if (url.pathname === '/mcp') return handleMcp(request, env, user);

    if (url.pathname === '/api/state' && request.method === 'GET') return json(await loadState(env.DB, user));

    if (url.pathname === '/api/sync' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      return json(await applySync(env.DB, body));
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
