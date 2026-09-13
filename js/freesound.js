// Freesound (https://freesound.org) text search: lets users pull in real
// recorded sound effects instead of only the procedural builtins/manual
// uploads. Uses the user's own API key, sent as a query-string token so the
// request stays a "simple" CORS GET (no custom Authorization header, so no
// preflight requirement on Freesound's side).

const FREESOUND_BASE = 'https://freesound.org/apiv2';

export async function searchFreesound(apiKey, query, { pageSize = 15 } = {}) {
  if (!apiKey) throw new Error('Freesound API key required.');
  const q = (query || '').trim();
  if (!q) throw new Error('Enter a search term.');

  const params = new URLSearchParams({
    query: q,
    token: apiKey,
    fields: 'id,name,duration,previews,license,username',
    page_size: String(pageSize),
  });

  let res;
  try {
    res = await fetch(`${FREESOUND_BASE}/search/text/?${params.toString()}`);
  } catch (err) {
    throw new Error(`Could not reach Freesound (network/CORS error): ${err.message}`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('Freesound rejected the API key — check it in settings.');
    const body = await res.text().catch(() => '');
    throw new Error(`Freesound search failed (${res.status}): ${body.slice(0, 200) || res.statusText}`);
  }

  const data = await res.json();
  return (data.results || [])
    .map((r) => ({
      id: r.id,
      name: r.name,
      duration: r.duration,
      license: r.license,
      username: r.username,
      previewUrl: (r.previews && (r.previews['preview-hq-mp3'] || r.previews['preview-lq-mp3'])) || null,
    }))
    .filter((r) => r.previewUrl);
}

export function isCC0(license) {
  return !!license && /publicdomain|cc0|zero/i.test(license);
}
