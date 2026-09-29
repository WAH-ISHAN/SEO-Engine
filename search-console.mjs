import { GoogleAuth } from 'google-auth-library';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function createSearchConsole(dataDir) {
  const property = process.env.GOOGLE_SEARCH_CONSOLE_PROPERTY || 'sc-domain:tenderhub.lk';
  const credentialJson = process.env.GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON || '';
  const file = join(dataDir, 'search-console-status.json');
  let stored = {};
  try { stored = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  let state = {
    ...(stored.property === property ? stored : {}),
    property, configured: Boolean(credentialJson), connected: Boolean(credentialJson && stored.property === property && stored.connected),
  };
  if (!credentialJson) state = { property, configured: false, connected: false, last_error: 'Google Search Console credentials are not configured.' };

  async function sync() {
    if (!credentialJson) return;
    state = { ...state, last_attempted_at: new Date().toISOString() };
    try {
      if (!['sc-domain:tenderhub.lk', 'https://tenderhub.lk/'].includes(property)) throw new Error('Search Console property must belong to tenderhub.lk.');
      let credentials;
      try { credentials = JSON.parse(credentialJson); } catch { throw new Error('Invalid service-account credential JSON.'); }
      if (credentials.type !== 'service_account' || !credentials.client_email || !credentials.private_key) throw new Error('A Google service-account credential is required.');
      const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/webmasters'] });
      const client = await auth.getClient();
      const base = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(property);
      await client.request({ url: base, timeout: 15000 });
      const sitemap = 'https://tenderhub.lk/sitemap.xml';
      await client.request({ url: base + '/sitemaps/' + encodeURIComponent(sitemap), method: 'PUT', timeout: 15000 });
      const end = new Date(Date.now() - 3 * 86400000);
      const start = new Date(end.getTime() - 27 * 86400000);
      const range = { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), type: 'web', dataState: 'final' };
      const [totals, pages] = await Promise.all([
        client.request({ url: base + '/searchAnalytics/query', method: 'POST', data: range, timeout: 15000 }),
        client.request({ url: base + '/searchAnalytics/query', method: 'POST', data: { ...range, dimensions: ['page'], rowLimit: 25 }, timeout: 15000 }),
      ]);
      state = {
        configured: true, connected: true, property, last_error: null,
        last_attempted_at: state.last_attempted_at,
        last_synced_at: new Date().toISOString(), sitemap_submitted_at: new Date().toISOString(),
        date_range: range, metrics: totals.data.rows?.[0] ?? null,
        pages: (pages.data.rows ?? []).map(row => ({ url: row.keys[0], clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })),
      };
    } catch (error) {
      // Do not serialize auth objects, request headers, tokens or credentials.
      const code = error.response?.status;
      state = { ...state, connected: false, last_error: code ? 'Google Search Console request failed (HTTP ' + code + '). Check API enablement and property permissions.' : 'Google Search Console connection failed. Check service-account credentials and network access.' };
    }
    writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  }
  return { status: () => state, sync };
}
