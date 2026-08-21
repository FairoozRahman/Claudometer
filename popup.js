/* Claudometer — toolbar popup
 *
 * Exists mainly for one reason: chrome.permissions.request() only succeeds
 * inside a genuine user gesture in an extension page (popup or options page).
 * A click handled inside the injected HUD's shadow DOM, forwarded to the
 * service worker as a message, does not carry that gesture across the
 * boundary — Chrome rejects the request outright. So the "run on all
 * websites" toggle has to live here, not in the floating panel.
 */

'use strict';

const K = { settings: 'cm.settings', state: 'cm.state' };
const DEFAULT_SETTINGS = {
  tooltips: true, alerts: true, theme: 'dark', view: 'compact', pos: null, allSites: false, pollMinutes: 2
};
const ALL_SITES_PERM = { origins: ['<all_urls>'] };
const ALL_SITES_ID = 'cm-all-sites';

const $ = id => document.getElementById(id);

async function getSettings() {
  const bag = await chrome.storage.local.get(K.settings);
  return { ...DEFAULT_SETTINGS, ...(bag[K.settings] || {}) };
}

async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [K.settings]: next });
  return next;
}

function renderStatus(state) {
  const dot = $('dot');
  const status = $('status');

  if (!state || state.status !== 'OK' || !state.fiveHour) {
    dot.style.color = 'var(--muted)';
    status.textContent = state && state.status === 'UNAUTHENTICATED'
      ? 'Not logged in to claude.ai'
      : 'No reading yet — open claude.ai';
    return;
  }

  const pct = state.fiveHour.pct;
  dot.style.color = pct >= 85 ? '#E57373' : pct >= 60 ? '#FFB74D' : '#81C784';
  const staleTxt = state.stale ? ' (stale)' : '';
  status.textContent = `${pct.toFixed(1)}% of 5-hour session used${staleTxt}`;
}

/** Run content.js into every already-open tab so the toggle takes effect immediately. */
async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) { return; }

  await Promise.all(tabs.map(async tab => {
    if (!tab.id || !tab.url) return;
    if (!/^https?:\/\//.test(tab.url)) return;           // skip chrome://, file://, etc.
    if (tab.url.startsWith('https://claude.ai/')) return; // already covered statically
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (_) { /* page disallows injection (Web Store, PDF viewer, …) — skip it */ }
  }));
}

async function registerAllSites() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] });
  if (existing.length) return;
  // NB: the API is registerContentScripts (plural) taking an array — there is
  // no singular registerContentScript. Easy to typo; fails with a plain
  // "is not a function" rather than anything that hints at the real cause.
  await chrome.scripting.registerContentScripts([{
    id: ALL_SITES_ID,
    matches: ['<all_urls>'],
    excludeMatches: ['https://claude.ai/*'],
    js: ['content.js'],
    runAt: 'document_idle',
    persistAcrossSessions: true
  }]);
}

async function unregisterAllSites() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALL_SITES_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ALL_SITES_ID] });
}

function showError(msg) {
  const el = $('allSitesError');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

async function onAllSitesChange(e) {
  const checkbox = e.target;
  const wantOn = checkbox.checked;
  checkbox.disabled = true;
  showError('');

  try {
    if (wantOn) {
      const granted = await chrome.permissions.request(ALL_SITES_PERM);
      if (!granted) {
        checkbox.checked = false;
        showError('Permission was not granted.');
        return;
      }
      await registerAllSites();
      await patchSettings({ allSites: true });
      await injectIntoOpenTabs(); // content.js reads cm.settings itself and mounts if allowed
    } else {
      await unregisterAllSites();
      await patchSettings({ allSites: false });
      // Deliberately not calling chrome.permissions.remove() here: keeping the
      // grant means flipping this back on later is instant, with no re-prompt.
      // chrome://extensions → Site access is the place to revoke it for good.
    }
  } catch (err) {
    console.error('[Claudometer]', err);
    checkbox.checked = !wantOn;
    showError(String(err && err.message || err));
  } finally {
    checkbox.disabled = false;
  }
}

async function boot() {
  const [settings, stateBag] = await Promise.all([
    getSettings(),
    chrome.storage.local.get(K.state)
  ]);
  renderStatus(stateBag[K.state]);

  $('hudToggle').checked = settings.view !== 'hidden';
  $('hudToggle').addEventListener('change', e => {
    patchSettings({ view: e.target.checked ? 'compact' : 'hidden' });
  });

  let granted = false;
  try { granted = await chrome.permissions.contains(ALL_SITES_PERM); } catch (_) { /* ignore */ }
  $('allSitesToggle').checked = settings.allSites && granted;
  $('allSitesToggle').addEventListener('change', onAllSitesChange);

  $('openClaude').addEventListener('click', () => chrome.tabs.create({ url: 'https://claude.ai/' }));
}

boot();
