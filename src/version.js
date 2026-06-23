// App version, computed live from the GitHub repo's commit history.
//
//   Version = YY.MM.COMMIT
//     YY     last two digits of the year of the latest commit
//     MM     two-digit month of the latest commit
//     COMMIT the latest commit's ordinal within that calendar month
//            (i.e. how many commits landed on the default branch that month)
//
// Result is cached in localStorage so we don't hit GitHub's unauthenticated
// rate limit (60 req/hr) on every load.

const REPO = 'magmalabsdev/capture';
const API = `https://api.github.com/repos/${REPO}/commits`;
const CACHE_KEY = 'capture.version.v1';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

async function computeVersion() {
  // Latest commit on the default branch → the "last update".
  const latest = await fetchJSON(`${API}?per_page=1`);
  if (!Array.isArray(latest) || !latest.length) throw new Error('no commits');
  const c = latest[0].commit;
  const d = new Date((c.committer && c.committer.date) || (c.author && c.author.date));
  if (Number.isNaN(d.getTime())) throw new Error('bad commit date');

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-based
  const since = new Date(Date.UTC(year, month, 1)).toISOString();
  const until = new Date(Date.UTC(year, month + 1, 1)).toISOString();

  // Count every commit in that calendar month (paging through if needed).
  let count = 0;
  for (let page = 1; page <= 20; page += 1) {
    const batch = await fetchJSON(`${API}?since=${since}&until=${until}&per_page=100&page=${page}`);
    if (!Array.isArray(batch) || !batch.length) break;
    count += batch.length;
    if (batch.length < 100) break;
  }

  const yy = String(year).slice(-2);
  const mm = String(month + 1).padStart(2, '0');
  return `${yy}.${mm}.${count}`;
}

/**
 * Resolve the version string (cached). Returns '' on failure so callers can
 * simply hide the label rather than show a broken value.
 */
export async function getVersion() {
  // Baked in at build time (desktop app) — avoids any network dependency.
  if (typeof globalThis !== 'undefined' && globalThis.__CAPTURE_VERSION__) {
    return globalThis.__CAPTURE_VERSION__;
  }
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && cached.v && Date.now() - cached.at < CACHE_TTL_MS) return cached.v;
  } catch {
    /* ignore */
  }
  try {
    const v = await computeVersion();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ v, at: Date.now() }));
    } catch {
      /* ignore */
    }
    return v;
  } catch {
    // Fall back to a stale cached value if we have one, else nothing.
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.v) return cached.v;
    } catch {
      /* ignore */
    }
    return '';
  }
}
