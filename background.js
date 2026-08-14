/* Claudometer — background service worker (MV3)
 *
 * Responsibilities:
 *   - Poll claude.ai's internal usage endpoints every POLL_MINUTES.
 *   - Normalise wildly-uncertain payload shapes into a stable state object.
 *   - Derive "last prompt impact" (delta) and "hourly burn rate" from history.
 *   - Persist everything to chrome.storage.local so content.js can render it.
 *
 * IMPORTANT — endpoint status:
 *   https://claude.ai/api/organizations              (undocumented, internal)
 *   https://claude.ai/api/organizations/{id}/usage   (undocumented, internal)
 *   These are NOT part of the documented Anthropic API. They can change or
 *   disappear without notice. parseUsage() below is deliberately tolerant so a
 *   field rename degrades to "unknown" rather than crashing the HUD.
 */

'use strict';

const API_BASE = 'https://claude.ai/api';
const LOGIN_URL = 'https://claude.ai/login';

const POLL_MINUTES = 2;
const ALARM_POLL = 'claudometer:poll';

const REQUEST_TIMEOUT_MS = 15000;
const ORG_TTL_MS = 24 * 60 * 60 * 1000; // cache org id for a day

const HISTORY_MAX = 90;                 // ~3h of 2-min samples
const MIN_SAMPLE_GAP_MS = 45 * 1000;    // collapse bursts of polls into one sample
const BURN_WINDOW_MS = 60 * 60 * 1000;  // burn rate looks back 1h
const BURN_MIN_SPAN_MS = 4 * 60 * 1000; // ...but needs >=4min of real span

const K = {
  state: 'cm.state',
  history: 'cm.history',
  settings: 'cm.settings',
  org: 'cm.org',
  alerts: 'cm.alerts'
};

const DEFAULT_SETTINGS = {
  tooltips: true,
  alerts: true,
  theme: 'dark',         // 'dark' | 'light'
  view: 'compact',       // 'compact' | 'detail' | 'hidden'
  pos: null,             // { top, left } in px, persisted across pages
  allSites: false        // run the HUD on every site, not just claude.ai — set via popup.html
};

const ALL_SITES_ID = 'cm-all-sites';
const ALL_SITES_PERM = { origins: ['<all_urls>'] };

const STATUS = {
  OK: 'OK',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  ERROR: 'ERROR',
  UNKNOWN: 'UNKNOWN'
};

/* ------------------------------------------------------------------ *
 * storage helpers
 * ------------------------------------------------------------------ */

async function get(key, fallback) {
  const bag = await chrome.storage.local.get(key);
  return bag[key] === undefined ? fallback : bag[key];
}

async function set(obj) {
  return chrome.storage.local.set(obj);
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await get(K.settings, {})) };
}

/* ------------------------------------------------------------------ *
 * networking
 * ------------------------------------------------------------------ */

/**
 * Ask an open claude.ai tab to make the request for us.
 *
 * This is the preferred path. A fetch issued from the content script is
 * genuinely same-origin: it carries the session cookies, the Cloudflare
 * clearance cookie and normal browser headers. A fetch issued from the service
 * worker is cross-origin from `chrome-extension://…` and, while host_permissions
 * let it through CORS and `credentials:'include'` does attach cookies, the edge
 * in front of claude.ai frequently answers those with 403.
 */
async function fetchViaTab(path) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  } catch (_) {
    return null;
  }
  // Prefer the focused tab, it is the most likely to be fully loaded.
  tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'CM_FETCH',
        path
      });
      if (res && typeof res.status === 'number') return res;
    } catch (_) {
      // No content script in that tab (e.g. still loading). Try the next one.
    }
  }
  return null;
}

/** Direct fetch from the service worker. Fallback for when no tab is open. */
async function fetchDirect(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(API_BASE + path, {
      method: 'GET',
      credentials: 'include',
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json' }
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: r.status, json, text: json ? null : text.slice(0, 300) };
  } catch (e) {
    return { status: 0, json: null, error: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(path) {
  const viaTab = await fetchViaTab(path);
  if (viaTab) return viaTab;
  return fetchDirect(path);
}

/* ------------------------------------------------------------------ *
 * org id resolution
 * ------------------------------------------------------------------ */

async function resolveOrgId({ force = false } = {}) {
  const cached = await get(K.org, null);
  if (!force && cached && cached.id && Date.now() - cached.at < ORG_TTL_MS) {
    return { id: cached.id, status: 200 };
  }

  const res = await apiGet('/organizations');
  if (res.status === 401 || res.status === 403) {
    return { id: null, status: res.status };
  }
  if (res.status !== 200 || !res.json) {
    return { id: null, status: res.status || 0, error: res.error || res.text };
  }

  const list = Array.isArray(res.json) ? res.json : (res.json.organizations || []);
  if (!list.length) return { id: null, status: 200, error: 'no organizations returned' };

  // Prefer an org that actually has chat capability; otherwise take the first.
  const withChat = list.find(o => {
    const caps = o && (o.capabilities || o.capability_list);
    return Array.isArray(caps) && caps.some(c => String(c).includes('chat'));
  });
  const org = withChat || list[0];
  const id = org && (org.uuid || org.id || org.organization_id);
  if (!id) return { id: null, status: 200, error: 'organization has no uuid field' };

  await set({ [K.org]: { id, at: Date.now(), name: org.name || null } });
  return { id, status: 200 };
}

/* ------------------------------------------------------------------ *
 * payload parsing (tolerant by design)
 * ------------------------------------------------------------------ */

/* Live payload shape, captured 2026-08-14 (trimmed):
 *
 *   {
 *     "five_hour":      { "utilization": 20.0, "resets_at": "2026-08-14T15:50:00.489577+00:00", … },
 *     "seven_day":      { "utilization": 25.0, "resets_at": "2026-08-14T12:00:00.489599+00:00", … },
 *     "seven_day_opus": null,
 *     "limits": [
 *       { "kind": "session",     "group": "session", "percent": 20,
 *         "severity": "normal",  "resets_at": "…",   "is_active": false },
 *       { "kind": "weekly_all",  "group": "weekly",  "percent": 25,
 *         "severity": "normal",  "resets_at": "…",   "is_active": true  }
 *     ],
 *     "extra_usage": { "is_enabled": false, … },
 *     "spend":       { "percent": 0, "enabled": false, "used": { "amount_minor": 0, … }, … }
 *   }
 *
 * Two things this confirmed:
 *   - `utilization` is on a 0-100 scale, NOT 0-1. Pinned below, no longer guessed.
 *   - `limits[]` is the richer source: it carries claude.ai's OWN `severity`
 *     rating, so the HUD can agree with the site instead of re-deriving tiers.
 *
 * Unused sibling keys (seven_day_sonnet, nimbus_quill, tangelo, iguana_necktie,
 * omelette_promotional, cinder_cove, amber_ladder …) are ignored; several are
 * null for most accounts and appear to be unshipped buckets.
 */

const LEGACY_KEYS = {
  fiveHour: ['five_hour', 'fiveHour', 'five_hour_limit', 'current_session'],
  sevenDay: ['seven_day', 'sevenDay', 'seven_day_limit', 'weekly'],
  sevenDayOpus: ['seven_day_opus', 'sevenDayOpus', 'weekly_opus']
};
const PCT_KEYS = ['utilization', 'percent', 'percent_used', 'percentage_used', 'percentage', 'used_percent'];
const RESET_KEYS = ['resets_at', 'reset_at', 'resetsAt', 'resets', 'next_reset', 'reset_time', 'ends_at'];

/** limits[].kind (or .group) -> our slot. */
const KIND_TO_SLOT = {
  session: 'fiveHour',
  five_hour: 'fiveHour',
  weekly_all: 'sevenDay',
  weekly: 'sevenDay',
  weekly_opus: 'sevenDayOpus',
  opus: 'sevenDayOpus'
};

/** claude.ai's severity vocabulary -> our tier names. */
const SEVERITY_TO_TIER = {
  normal: 'normal',
  warning: 'warn',
  warn: 'warn',
  critical: 'crit',
  danger: 'crit'
};

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

const clampPct = n => Math.max(0, Math.min(100, n));

function toIso(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    // Heuristic: seconds vs milliseconds since epoch.
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parse one of the top-level `five_hour` / `seven_day` objects. */
function parseLegacyWindow(payload, groupKeys) {
  const w = pick(payload, groupKeys);
  if (!w || typeof w !== 'object') return null;

  let pct = Number(pick(w, PCT_KEYS));

  if (!Number.isFinite(pct)) {
    // Fall back to remaining/limit style payloads if utilisation is absent.
    const remaining = Number(pick(w, ['remaining', 'remaining_count', 'remaining_dollars']));
    const limit = Number(pick(w, ['limit', 'total', 'cap', 'limit_dollars']));
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      pct = ((limit - remaining) / limit) * 100;
    }
  }
  if (!Number.isFinite(pct)) return null;

  return {
    pct: clampPct(pct),
    resetsAt: toIso(pick(w, RESET_KEYS)),
    severity: null,
    isActive: null
  };
}

/** Usage-credit overage, only meaningful once the account has it switched on. */
function parseCredits(root) {
  const extra = root.extra_usage;
  const spend = root.spend;
  const enabled = (extra && extra.is_enabled === true) || (spend && spend.enabled === true);
  if (!enabled) return null;

  let used = null;
  const u = spend && spend.used;
  if (u && Number.isFinite(Number(u.amount_minor))) {
    const exp = Number.isFinite(Number(u.exponent)) ? Number(u.exponent) : 2;
    used = Number(u.amount_minor) / Math.pow(10, exp);
  }

  const pctRaw = Number(spend && spend.percent);
  const pctAlt = Number(extra && extra.utilization);

  return {
    used,
    currency: (u && u.currency) || (extra && extra.currency) || 'USD',
    pct: Number.isFinite(pctRaw) ? clampPct(pctRaw)
       : Number.isFinite(pctAlt) ? clampPct(pctAlt) : null,
    severity: SEVERITY_TO_TIER[String(spend && spend.severity || '').toLowerCase()] || null
  };
}

function parseUsage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  // Some responses nest everything one level down.
  const root = payload.usage && typeof payload.usage === 'object' ? payload.usage : payload;

  const out = { fiveHour: null, sevenDay: null, sevenDayOpus: null, credits: null };

  // Preferred source: the structured limits[] array, which carries claude.ai's
  // own severity rating and tells us which windows actually exist.
  if (Array.isArray(root.limits)) {
    const filledByKind = new Set();
    for (const l of root.limits) {
      if (!l || typeof l !== 'object') continue;

      // `group` is a coarse bucket — several entries can share group "weekly"
      // (weekly_all, weekly_opus, …). Matching on it is a weaker signal than an
      // exact `kind` match, so it must never overwrite a slot an exact match
      // already filled, or a secondary pool would clobber the real number.
      const byKind = KIND_TO_SLOT[l.kind];
      const slot = byKind || KIND_TO_SLOT[l.group];
      if (!slot) continue;
      if (!byKind && filledByKind.has(slot)) continue;

      const pct = Number(pick(l, PCT_KEYS));
      if (!Number.isFinite(pct)) continue;
      if (byKind) filledByKind.add(slot);

      out[slot] = {
        pct: clampPct(pct),
        resetsAt: toIso(l.resets_at),
        severity: SEVERITY_TO_TIER[String(l.severity || '').toLowerCase()] || null,
        isActive: typeof l.is_active === 'boolean' ? l.is_active : null
      };
    }
  }

  // The top-level objects carry the same numbers but `utilization` is a float
  // where limits[].percent is rounded to an integer — so prefer it for the
  // value, and rely on it entirely when limits[] is missing.
  for (const slot of Object.keys(LEGACY_KEYS)) {
    const legacy = parseLegacyWindow(root, LEGACY_KEYS[slot]);
    if (!legacy) continue;
    if (!out[slot]) out[slot] = legacy;
    else {
      out[slot].pct = legacy.pct;
      if (!out[slot].resetsAt) out[slot].resetsAt = legacy.resetsAt;
    }
  }

  out.credits = parseCredits(root);

  if (!out.fiveHour && !out.sevenDay) return null; // shape we do not recognise
  return out;
}

/* ------------------------------------------------------------------ *
 * derived metrics
 * ------------------------------------------------------------------ */

/* Observed live: the endpoint recomputes `resets_at` on every request, so the
 * SAME 5-hour window reports timestamps a few hundred milliseconds apart on
 * consecutive polls (measured: 438ms over a 5.5s gap). Comparing those strings
 * for equality classifies every poll as a roll-over, which permanently
 * suppresses the delta and pins the burn rate at zero. Compare with tolerance
 * instead — a real roll-over moves the timestamp by hours, not milliseconds. */
const RESET_JITTER_MS = 2 * 60 * 1000;

/** Did the usage window roll over between these two samples? */
function windowRolled(prev, curr) {
  if (!prev || !curr) return false;

  if (prev.resetsAt && curr.resetsAt) {
    const a = Date.parse(prev.resetsAt);
    const b = Date.parse(curr.resetsAt);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return Math.abs(b - a) > RESET_JITTER_MS;
    }
  }

  // No usable timestamps: utilisation only falls when a window rolls over.
  return curr.pct + 0.5 < prev.pct;
}

/**
 * Last prompt impact = rise in 5h utilisation since the previous sample.
 * Suppressed across a roll-over, because the drop to ~0 is a reset, not a refund.
 */
function computeDelta(prevSample, curr) {
  if (!prevSample || !curr) return null;
  if (windowRolled(prevSample, curr)) return null;
  const d = curr.pct - prevSample.pct;
  if (!Number.isFinite(d)) return null;
  return d > 0 ? Number(d.toFixed(2)) : 0;
}

/**
 * Burn rate = total upward movement inside the last BURN_WINDOW_MS,
 * extrapolated to an hourly pace. Downward steps (window resets) are dropped
 * rather than netted out, so a reset does not fake a negative burn.
 */
function computeBurnRate(history) {
  const cutoff = Date.now() - BURN_WINDOW_MS;
  const pts = history.filter(p => p.t >= cutoff);
  if (pts.length < 2) return null;

  const span = pts[pts.length - 1].t - pts[0].t;
  if (span < BURN_MIN_SPAN_MS) return null;

  let rise = 0;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    if (windowRolled({ pct: prev.pct, resetsAt: prev.r },
                     { pct: cur.pct, resetsAt: cur.r })) continue;
    const d = cur.pct - prev.pct;
    if (d > 0) rise += d;
  }

  const hours = span / 3600000;
  const rate = rise / hours;
  return Number.isFinite(rate) ? Number(rate.toFixed(1)) : null;
}

/**
 * Runway = how long the remaining 5h allowance lasts at the current pace,
 * capped at the time left in the window (you cannot overspend past a reset).
 */
function computeRunway(fiveHour, burnRate) {
  if (!fiveHour || !burnRate || burnRate <= 0) return null;
  const remaining = Math.max(0, 100 - fiveHour.pct);
  const ms = (remaining / burnRate) * 3600000;
  const resetMs = fiveHour.resetsAt ? new Date(fiveHour.resetsAt).getTime() - Date.now() : null;
  const survivesWindow = resetMs !== null && ms >= resetMs;
  return { ms, survivesWindow };
}

/* ------------------------------------------------------------------ *
 * notifications
 * ------------------------------------------------------------------ */

const ALERT_THRESHOLDS = [60, 85, 95];

async function maybeAlert(state) {
  const settings = await getSettings();
  if (!settings.alerts || state.status !== STATUS.OK || !state.fiveHour) return;

  const key = state.fiveHour.resetsAt || 'nowindow';
  const store = await get(K.alerts, {});
  const already = store[key] || 0;

  const crossed = ALERT_THRESHOLDS.filter(t => state.fiveHour.pct >= t);
  const highest = crossed.length ? crossed[crossed.length - 1] : 0;
  if (highest <= already) return;

  try {
    await chrome.notifications.create(`cm-${key}-${highest}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: highest >= 95 ? 'Claudometer — session almost gone'
           : highest >= 85 ? 'Claudometer — session critical'
           : 'Claudometer — session warning',
      message: `${state.fiveHour.pct.toFixed(1)}% of your 5-hour window is used.` +
               (state.burnRate ? ` Burning ~${state.burnRate}%/hr.` : ''),
      priority: highest >= 85 ? 2 : 0
    });
  } catch (_) { /* notifications can be blocked by the OS */ }

  await set({ [K.alerts]: { [key]: highest } }); // single-key store, old windows drop out
}

/* ------------------------------------------------------------------ *
 * badge
 * ------------------------------------------------------------------ */

async function paintBadge(state) {
  try {
    if (state.status === STATUS.UNAUTHENTICATED) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#546E7A' });
      return;
    }
    if (state.status !== STATUS.OK || !state.fiveHour) {
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    const pct = Math.round(state.fiveHour.pct);
    await chrome.action.setBadgeText({ text: String(pct) });
    await chrome.action.setBadgeBackgroundColor({
      color: pct >= 85 ? '#E57373' : pct >= 60 ? '#FFB74D' : '#81C784'
    });
  } catch (_) { /* action API unavailable */ }
}

/* ------------------------------------------------------------------ *
 * the poll
 * ------------------------------------------------------------------ */

let polling = false;

async function poll(reason = 'alarm') {
  if (polling) return;
  polling = true;
  try {
    const prev = await get(K.state, null);

    // 1 + 3. Resolve the organization uuid.
    let org = await resolveOrgId();
    if (org.status === 401 || org.status === 403) {
      return commit({ status: STATUS.UNAUTHENTICATED, reason });
    }
    if (!org.id) {
      return commit({ status: STATUS.ERROR, error: org.error || `organizations HTTP ${org.status}`, reason }, prev);
    }

    // 4. Fetch usage for that org.
    let res = await apiGet(`/organizations/${encodeURIComponent(org.id)}/usage`);

    // A stale cached org id also surfaces as 404 — refresh it once and retry.
    if (res.status === 404) {
      org = await resolveOrgId({ force: true });
      if (org.id) res = await apiGet(`/organizations/${encodeURIComponent(org.id)}/usage`);
    }

    if (res.status === 401 || res.status === 403) {
      return commit({ status: STATUS.UNAUTHENTICATED, reason });
    }
    if (res.status !== 200 || !res.json) {
      return commit({
        status: STATUS.ERROR,
        error: res.error || res.text || `usage HTTP ${res.status}`,
        reason
      }, prev);
    }

    // 5. Normalise.
    const parsed = parseUsage(res.json);
    if (!parsed) {
      return commit({
        status: STATUS.ERROR,
        error: 'Unrecognised usage payload shape',
        sample: JSON.stringify(res.json).slice(0, 400),
        reason
      }, prev);
    }

    // Delta + burn rate.
    const history = await get(K.history, []);
    let delta = prev ? prev.delta : null;

    if (parsed.fiveHour) {
      const last = history.length ? history[history.length - 1] : null;
      const lastAsWindow = last ? { pct: last.pct, resetsAt: last.r } : null;
      const sample = { t: Date.now(), pct: parsed.fiveHour.pct, r: parsed.fiveHour.resetsAt };
      const d = computeDelta(lastAsWindow, parsed.fiveHour);

      // poll() also fires on navigation and on manual refresh, so samples can
      // land seconds apart. Appending those would crowd real 2-minute samples
      // out of the burn window and shrink its span. Collapse them into the tail
      // instead, keeping the newest reading.
      if (!last || sample.t - last.t >= MIN_SAMPLE_GAP_MS) {
        history.push(sample);
        while (history.length > HISTORY_MAX) history.shift();
        delta = d;
      } else {
        history[history.length - 1] = { ...sample, t: last.t };
        // A genuine jump inside that short gap is still real usage; a flat
        // re-poll must not wipe the delta the last spaced sample established.
        if (Number.isFinite(d) && d > 0) delta = d;
      }

      await set({ [K.history]: history });
    }

    const burnRate = computeBurnRate(history);
    const runway = computeRunway(parsed.fiveHour, burnRate);

    await commit({
      status: STATUS.OK,
      fiveHour: parsed.fiveHour,
      sevenDay: parsed.sevenDay,
      sevenDayOpus: parsed.sevenDayOpus,
      credits: parsed.credits,
      delta,
      burnRate,
      runway,
      reason
    });
  } catch (e) {
    await commit({ status: STATUS.ERROR, error: String(e && e.message || e), reason });
  } finally {
    polling = false;
  }
}

/**
 * Write state. On a transient error we keep the last known-good numbers around
 * so the HUD shows stale-but-useful data instead of blanking out.
 */
async function commit(next, prevForCarryOver) {
  const state = { ...next, updatedAt: Date.now() };

  if (next.status === STATUS.ERROR && prevForCarryOver && prevForCarryOver.fiveHour) {
    state.fiveHour = prevForCarryOver.fiveHour;
    state.sevenDay = prevForCarryOver.sevenDay;
    state.sevenDayOpus = prevForCarryOver.sevenDayOpus;
    state.credits = prevForCarryOver.credits;
    state.burnRate = prevForCarryOver.burnRate;
    state.runway = prevForCarryOver.runway;
    state.delta = prevForCarryOver.delta;
    state.stale = true;
    state.staleSince = prevForCarryOver.updatedAt || null;
  }

  await set({ [K.state]: state });
  await paintBadge(state);
  await maybeAlert(state);
  return state;
}

/* ------------------------------------------------------------------ *
 * wiring
 * ------------------------------------------------------------------ */

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_POLL);
  if (!existing) {
    await chrome.alarms.create(ALARM_POLL, {
      periodInMinutes: POLL_MINUTES,
      delayInMinutes: 0.1
    });
  }
}

/**
 * popup.js is what actually requests the <all_urls> permission and registers
 * the dynamic content script (it needs the popup's user gesture to do so —
 * neither the service worker nor a message from a content script counts as
 * one). This function only reconciles: it runs at startup/install and
 * whenever the permission is revoked, so a registration can never survive
 * without its permission, and a stale "on" setting can never survive without
 * its registration.
 */
async function syncAllSitesRegistration() {
  const settings = await getSettings();
  let granted = false;
  try { granted = await chrome.permissions.contains(ALL_SITES_PERM); } catch (_) { /* ignore */ }

  if (settings.allSites && granted) {
    try {
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] });
      if (!existing.length) {
        await chrome.scripting.registerContentScripts([{
          id: ALL_SITES_ID,
          matches: ['<all_urls>'],
          excludeMatches: ['https://claude.ai/*'],
          js: ['content.js'],
          runAt: 'document_idle',
          persistAcrossSessions: true
        }]);
      }
    } catch (e) { console.error('[Claudometer] failed to register all-sites script:', e); }
    return;
  }

  // Permission missing (revoked via chrome://extensions) but the setting
  // still says "on" — bring storage back in line so the popup toggle does
  // not lie, then make sure nothing is left registered.
  if (settings.allSites && !granted) {
    await set({ [K.settings]: { ...settings, allSites: false } });
  }
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_ID] });
  } catch (_) { /* nothing registered */ }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await get(K.settings, null);
  if (!settings) await set({ [K.settings]: DEFAULT_SETTINGS });
  await ensureAlarm();
  await syncAllSitesRegistration();
  poll('installed');
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await syncAllSitesRegistration();
  poll('startup');
});

// The user can revoke site access from chrome://extensions at any time,
// independent of our own toggle — catch that the moment it happens.
chrome.permissions.onRemoved.addListener(perm => {
  if (perm.origins && perm.origins.includes('<all_urls>')) syncAllSitesRegistration();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_POLL) poll('alarm');
});

// A fresh navigation on claude.ai is a good moment to re-check: cookies may
// have just changed (login/logout) and a tab is guaranteed to be available.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url && tab.url.startsWith('https://claude.ai/')) {
    poll('navigation');
  }
});

// Toolbar clicks open popup.html (manifest action.default_popup) rather than
// firing action.onClicked — Chrome never delivers that event once a popup is
// set. The popup owns "show/hide HUD" and "run on all sites" now.

chrome.notifications.onClicked.addListener(async id => {
  if (!String(id).startsWith('cm-')) return;
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
  else chrome.tabs.create({ url: 'https://claude.ai/' });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'CM_REFRESH') {
    poll('manual').then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'CM_OPEN_LOGIN') {
    chrome.tabs.create({ url: LOGIN_URL });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'CM_GET') {
    Promise.all([get(K.state, null), getSettings()])
      .then(([state, settings]) => sendResponse({ state, settings }));
    return true;
  }

  if (msg.type === 'CM_SET_SETTINGS') {
    getSettings()
      .then(s => set({ [K.settings]: { ...s, ...msg.patch } }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Kick once on worker spin-up so a woken worker never sits on empty state.
ensureAlarm();
poll('worker-start');
