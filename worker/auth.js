/* Cloudflare Access gate. Access authenticates at the edge and forwards a signed JWT; the Worker
   re-verifies it so the app stays closed even if a route is ever exposed outside Access. */

const b64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const json = s => JSON.parse(new TextDecoder().decode(b64(s)));

let jwks = { keys: null, at: 0 };
async function signingKeys(team, force) {
  if (!force && jwks.keys && Date.now() - jwks.at < 36e5) return jwks.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Could not load Access signing keys');
  jwks = { keys: (await res.json()).keys, at: Date.now() };
  return jwks.keys;
}

async function verify(token, env) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('Malformed token');
  const header = json(h);
  const claims = json(p);
  if (header.alg !== 'RS256') throw new Error('Unsupported algorithm');
  let key = (await signingKeys(env.ACCESS_TEAM_DOMAIN)).find(k => k.kid === header.kid);
  if (!key) key = (await signingKeys(env.ACCESS_TEAM_DOMAIN, true)).find(k => k.kid === header.kid);
  if (!key) throw new Error('Unknown signing key');
  const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, b64(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('Bad signature');
  const aud = [].concat(claims.aud || []);
  if (!aud.includes(env.ACCESS_AUD)) throw new Error('Wrong audience');
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new Error('Wrong issuer');
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error('Token expired');
  return claims;
}

/* Returns { email, name } for the caller, or null when the request is not authenticated.
   Service tokens (used by MCP clients) carry no email; they are reported by client id. */
export async function authenticate(request, env) {
  if (env.DEV_BYPASS_ACCESS === '1') return { email: env.DEV_EMAIL || 'dev@localhost', name: 'Dev' };
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('Cookie') || '')?.[1];
  if (!token) return null;
  try {
    const c = await verify(token, env);
    return { email: c.email || null, name: c.email || c.common_name || 'service' };
  } catch {
    return null;
  }
}
