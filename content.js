/* Claudometer — content script
 *
 * Two jobs:
 *   1. Act as a same-origin fetch proxy for the service worker. Requests made
 *      from here carry the claude.ai session cookies and the edge clearance
 *      cookie exactly as the site's own XHRs do.
 *   2. Mount the floating HUD inside a closed shadow root so no styles cross
 *      in either direction.
 */

'use strict';

(() => {
  if (window.__claudometerMounted) return;
  window.__claudometerMounted = true;

  const API_BASE = 'https://claude.ai/api';
  const HOST_ID = 'claudometer-host';
  // Read once from the manifest rather than hardcoding a string that drifts
  // out of sync the moment manifest.json's version is next bumped.
  const EXT_VERSION = chrome.runtime.getManifest().version;
  const TIP_DELAY_MS = 300;

  const DEFAULT_SETTINGS = {
    tooltips: true,
    alerts: true,
    theme: 'dark',
    view: 'compact',
    pos: null,
    allSites: false,
    pollMinutes: 2
  };

  const POLL_MINUTES_CHOICES = [1, 5, 10, 15, 30];

  // The static manifest entry only matches claude.ai; this script also runs
  // on every other site once popup.js registers it there (gated behind the
  // "Run on all websites" toggle, which needs the <all_urls> permission).
  const isClaudeTab = location.hostname === 'claude.ai';

  /* Minimum styling needed for the HUD to be visible and correctly positioned.
   * Inlined so it cannot fail; styles.css layers the full design on top. */
  const CRITICAL_CSS = `
.cm-root{position:fixed!important;z-index:2147483647!important;isolation:isolate;
  pointer-events:none;color:#E8E6E3;
  font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.cm-compact,.cm-detail,.cm-nub{pointer-events:auto;background:rgba(24,26,28,.92);
  border:1px solid rgba(255,255,255,.14);border-radius:12px;box-sizing:border-box}
.cm-compact{width:158px;min-height:45px;padding:5px 6px 5px 8px}
.cm-detail{width:296px}
.cm-nub{width:26px;height:26px;text-align:center;cursor:pointer}
.c-row{display:flex;align-items:center;gap:5px}
.c-row .spacer{flex:1 1 auto}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.hidden{display:none!important}
`;

  /* ---------------------------------------------------------------- *
   * 1. Fetch proxy
   * ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'CM_FETCH') return;

    // Only ever proxy same-origin claude.ai API paths.
    const path = String(msg.path || '');
    if (!path.startsWith('/')) {
      sendResponse({ status: 0, error: 'bad path' });
      return false;
    }

    fetch(API_BASE + path, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    })
      .then(async r => {
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* HTML error page etc. */ }
        sendResponse({ status: r.status, json, text: json ? null : text.slice(0, 300) });
      })
      .catch(e => sendResponse({ status: 0, json: null, error: String(e && e.message || e) }));

    return true; // async
  });

  /* ---------------------------------------------------------------- *
   * helpers
   * ---------------------------------------------------------------- */

  const alive = () => {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  };

  function send(msg) {
    return new Promise(resolve => {
      if (!alive()) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, res => {
          void chrome.runtime.lastError; // swallow "no receiver"
          resolve(res || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /* ---------------------------------------------------------------- *
   * Icons — inline SVG, Feather/Lucide-style (1.5px stroke, 24x24 grid),
   * dropped in wherever a unicode/emoji glyph used to sit. currentColor
   * means each icon already tracks --fg / hover state for free.
   * ---------------------------------------------------------------- */

  const ICON_PATHS = {
    maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>'
            + '<line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/>'
            + '<line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
    sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/>'
       + '<line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>'
       + '<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/>'
       + '<line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>'
       + '<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>'
           + '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'
  };

  function icon(name, size = 14) {
    return `<svg class="cm-svg" width="${size}" height="${size}" viewBox="0 0 24 24" `
      + `fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" `
      + `stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  }

  /** 0–59 normal, 60–84 warning, 85–100 critical. */
  function tier(pct) {
    if (!Number.isFinite(pct)) return 'normal';
    if (pct >= 85) return 'crit';
    if (pct >= 60) return 'warn';
    return 'normal';
  }

  /**
   * Prefer claude.ai's own `severity` when the payload supplies it, so the HUD
   * never disagrees with the site's own colouring. Fall back to the spec
   * thresholds when it does not.
   */
  function tierOf(w) {
    if (!w) return 'normal';
    return w.severity || tier(w.pct);
  }

  const TIER_LABEL = { normal: 'Normal', warn: 'Warning', crit: 'Critical' };
  const TIER_DOT = { normal: '🟢', warn: '🟡', crit: '🔴' };

  function fmtPct(n, dp = 1) {
    if (!Number.isFinite(n)) return '—';
    const r = Number(n.toFixed(dp));
    return (Number.isInteger(r) ? r.toFixed(0) : r.toFixed(dp));
  }

  /** "2 hrs 15 mins" */
  function humanDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return 'now';
    const total = Math.round(ms / 60000);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h && m) return `${h} hr${h > 1 ? 's' : ''} ${m} min${m > 1 ? 's' : ''}`;
    if (h) return `${h} hr${h > 1 ? 's' : ''}`;
    return `${m} min${m === 1 ? '' : 's'}`;
  }

  /** "2h 15m" / "45m" — tight form for the ~150px-wide compact HUD. */
  function humanDurationShort(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0m';
    const total = Math.round(ms / 60000);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }

  /** "just now" / "2 mins ago" / "1 hr ago" */
  function humanAgo(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'just now';
    const s = Math.floor(ms / 1000);
    if (s < 45) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }

  function clockAt(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function dateAt(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  /* ---------------------------------------------------------------- *
   * 2. UI
   * ---------------------------------------------------------------- */

  let state = null;
  let settings = { ...DEFAULT_SETTINGS };

  let host, root, shell, tipEl;
  let tipTimer = null, liveTimer = null, observer = null;
  let mounted = false;

  function mount() {
    if (document.getElementById(HOST_ID)) return;

    // Re-mounting after the SPA sweeps our host away must not leave the old
    // interval and observer running.
    clearInterval(liveTimer);
    observer?.disconnect();

    host = document.createElement('div');
    host.id = HOST_ID;
    // !important on every declaration: this element lives in the page's own
    // light DOM (everything past it is shadow-encapsulated and immune to page
    // CSS by construction), so it's the one place a host page's own
    // `#claudometer-host { z-index: 1 !important }` — or a blanket reset some
    // sites apply — could actually win a normal-priority declaration. isolation
    // gives it a clean stacking context of its own; pointer-events:none is
    // belt-and-suspenders since the box is 0x0 anyway, matched by
    // pointer-events:auto on the actual visible card (see CRITICAL_CSS/styles.css).
    host.style.cssText = 'all:initial!important;position:fixed!important;top:0!important;'
      + 'left:0!important;width:0!important;height:0!important;'
      + 'z-index:2147483647!important;isolation:isolate!important;pointer-events:none!important;';
    // documentElement (<html>) rather than <body>: some SPAs apply a
    // transform/filter/will-change to their root app div inside <body> for
    // GPU-accelerated transitions, which would make a position:fixed
    // descendant track THAT element's box instead of the viewport. Attaching
    // as a sibling of <body> avoids ever being inside such an ancestor.
    (document.documentElement || document.body).appendChild(host);

    // 'open' isolates styles exactly as 'closed' does — the difference is only
    // whether page script can reach .shadowRoot, which buys nothing here since
    // the host is trivially findable anyway. Open mode keeps the HUD
    // inspectable in DevTools, which matters a lot more.
    root = host.attachShadow({ mode: 'open' });

    // styles.css arrives over an async fetch. Until it lands the panel has no
    // `position: fixed`, so it would lay out inside the 0x0 host at the top-left
    // of the page — invisible in practice. Ship just enough CSS inline to
    // guarantee the HUD is positioned and legible even if that fetch never
    // completes (a strict page CSP, for instance).
    const bootStyle = document.createElement('style');
    bootStyle.textContent = CRITICAL_CSS;
    root.appendChild(bootStyle);

    const style = document.createElement('style');
    root.appendChild(style);
    fetch(chrome.runtime.getURL('styles.css'))
      .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(css => { style.textContent = css; })
      .catch(e => console.error(
        '[Claudometer] styles.css failed to load (%s) — running on fallback styling.', e.message));

    shell = document.createElement('div');
    shell.className = 'cm-root theme-dark s-normal';
    root.appendChild(shell);

    tipEl = document.createElement('div');
    tipEl.className = `cm-tip theme-${settings.theme === 'light' ? 'light' : 'dark'}`;
    root.appendChild(tipEl);

    shell.addEventListener('click', onClick);
    shell.addEventListener('change', onChange);
    shell.addEventListener('pointerdown', onPointerDown);
    shell.addEventListener('mouseover', onHoverIn);
    shell.addEventListener('mouseout', onHoverOut);
    shell.addEventListener('focusout', hideTip);

    window.addEventListener('resize', () => { applyPosition(); hideTip(); });

    // The SPA occasionally rewrites large chunks of the DOM; re-attach if our
    // host gets swept away.
    observer = new MutationObserver(() => {
      if (!document.getElementById(HOST_ID)) { mount(); render(); }
    });
    observer.observe(document.documentElement, { childList: true });

    liveTimer = setInterval(updateLive, 1000);
    document.addEventListener('visibilitychange', onVisible);
  }

  /** Tear the HUD out of a non-claude.ai page when "all sites" is switched off. */
  function unmount() {
    if (!mounted) return;
    clearInterval(liveTimer);
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVisible);
    hideTip();
    host?.remove();
    host = root = shell = tipEl = null;
    mounted = false;
  }

  /** Mount only where allowed: always on claude.ai, elsewhere only when opted in. */
  function tryMount() {
    if (mounted) return;
    if (!isClaudeTab && !settings.allSites) return;
    mount();
    mounted = true;
    render();
  }

  function onVisible() {
    if (!document.hidden) send({ type: 'CM_REFRESH' });
  }

  /* ------------------------- positioning ------------------------- */

  function applyPosition() {
    if (!shell) return;
    const box = shell.firstElementChild;
    const w = box ? box.offsetWidth || 140 : 140;
    const h = box ? box.offsetHeight || 45 : 45;

    let { top, left } = settings.pos || {};
    if (!Number.isFinite(top) || !Number.isFinite(left)) {
      // Default: top-right, just clear of the browser toolbar/bookmarks bar.
      left = window.innerWidth - w - 20;
      top = 20;
    }
    shell.style.left = clamp(left, 4, Math.max(4, window.innerWidth - w - 4)) + 'px';
    shell.style.top = clamp(top, 4, Math.max(4, window.innerHeight - h - 4)) + 'px';
  }

  let drag = null;

  function onPointerDown(e) {
    const handle = e.target.closest('[data-drag]');
    if (!handle) return;
    if (e.target.closest('button, input, label, a')) return;
    if (e.button !== 0) return;

    const rect = shell.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
    shell.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
    hideTip();
  }

  function onPointerMove(e) {
    if (!drag) return;
    drag.moved = true;
    shell.style.left = (e.clientX - drag.dx) + 'px';
    shell.style.top = (e.clientY - drag.dy) + 'px';
  }

  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    if (drag && drag.moved) {
      const rect = shell.getBoundingClientRect();
      // Deliberately local-only — see the comment on setView() below. Writing
      // this to shared storage meant dragging the HUD in one tab silently
      // relocated it in every other open tab too.
      settings.pos = { top: rect.top, left: rect.left };
      applyPosition();
    }
    drag = null;
  }

  /* --------------------------- tooltips -------------------------- */

  function onHoverIn(e) {
    if (!settings.tooltips) return;
    const el = e.target.closest?.('[data-tip]');
    if (!el || !shell.contains(el)) return;

    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(el), TIP_DELAY_MS);
  }

  function onHoverOut(e) {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    hideTip();
  }

  function showTip(el) {
    if (!settings.tooltips) return;
    tipEl.textContent = el.getAttribute('data-tip') || '';
    tipEl.classList.add('show');

    const t = el.getBoundingClientRect();
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;

    let left = t.left + t.width / 2 - tw / 2;
    let top = t.top - th - 8;
    if (top < 6) top = t.bottom + 8;                       // flip under
    left = clamp(left, 6, window.innerWidth - tw - 6);

    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }

  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) tipEl.classList.remove('show');
  }

  /* ---------------------------- events --------------------------- */

  function setView(view) {
    // Global by design: minimizing/maximizing in one tab is meant to do the
    // same everywhere, same as toggling theme or alerts. `pos` (drag
    // position) is the one piece of UI state that stays tab-local — see
    // onPointerUp().
    settings.view = view;
    send({ type: 'CM_SET_SETTINGS', patch: { view } });
    render();
  }

  function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    hideTip();

    switch (act) {
      case 'expand': return setView('detail');
      case 'minimize': return setView('compact');
      case 'close': return setView('hidden');
      case 'restore': return setView('compact');
      case 'theme': {
        settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
        send({ type: 'CM_SET_SETTINGS', patch: { theme: settings.theme } });
        return render();
      }
      case 'login':
        return void send({ type: 'CM_OPEN_LOGIN' });
      case 'refresh': {
        // No manual cleanup needed: render() replaces the whole panel's
        // innerHTML once the poll resolves, so this spinning button — along
        // with its class — is simply discarded with the rest of the old DOM.
        btn.classList.add('spinning');
        return void send({ type: 'CM_REFRESH' }).then(() => render());
      }
    }
  }

  function onChange(e) {
    const el = e.target;
    if (el.matches('[data-set]')) {
      const key = el.getAttribute('data-set');
      const value = el.tagName === 'SELECT' ? Number(el.value) : el.checked;
      settings[key] = value;
      send({ type: 'CM_SET_SETTINGS', patch: { [key]: value } });
      if (key === 'tooltips' && !el.checked) hideTip();
    }
  }

  /* ---------------------------- render --------------------------- */

  const isUnauth = () => state && state.status === 'UNAUTHENTICATED';
  const hasData = () => state && state.fiveHour && Number.isFinite(state.fiveHour.pct);

  function rootTier() {
    if (isUnauth() || !hasData()) return 'off';
    return tierOf(state.fiveHour);
  }

  function render() {
    if (!shell) return;

    const themeCls = settings.theme === 'light' ? 'light' : 'dark';
    shell.className = `cm-root theme-${themeCls} s-${rootTier()}`;
    // Kept in sync here rather than only at mount time: theme toggles re-render
    // without remounting, and a tooltip mid-fade shouldn't flash the old theme.
    if (tipEl) tipEl.className = `cm-tip theme-${themeCls}`;

    if (settings.view === 'hidden') shell.innerHTML = nubHtml();
    else if (settings.view === 'detail') shell.innerHTML = detailHtml();
    else shell.innerHTML = compactHtml();

    applyPosition();
    updateLive();
  }

  const themeIcon = () => icon(settings.theme === 'dark' ? 'moon' : 'sun');
  const themeTip = () => (settings.theme === 'dark'
    ? 'Switch to light theme'
    : 'Switch to dark theme');

  function nubHtml() {
    return `<div class="cm-nub glass" data-act="restore"
                 data-tip="Show Claudometer">◔</div>`;
  }

  /* ---- compact ---- */

  function compactHtml() {
    if (isUnauth()) {
      return `
      <div class="cm-compact glass" data-drag>
        <div class="c-row">
          <span class="c-offline" data-tip="Claudometer can't read your usage — no active claude.ai session.">⚠️ Offline</span>
          <span class="spacer"></span>
          <button class="ic" data-act="expand" data-tip="Open detailed view">${icon('maximize')}</button>
        </div>
        <div class="c-row">
          <button class="c-login" data-act="login" data-tip="Open the claude.ai login page in a new tab">Log in</button>
          <span class="spacer"></span>
          <button class="ic" data-act="theme" data-tip="${esc(themeTip())}">${themeIcon()}</button>
        </div>
      </div>`;
    }

    if (!hasData()) {
      const err = state && state.status === 'ERROR';
      return `
      <div class="cm-compact glass" data-drag>
        <div class="c-row">
          <span class="c-offline" data-tip="${esc(err ? (state.error || 'Usage lookup failed') : 'Waiting for the first reading…')}">${err ? '⚠️ No data' : '◔ Loading…'}</span>
          <span class="spacer"></span>
          <button class="ic" data-act="expand" data-tip="Open detailed view">${icon('maximize')}</button>
        </div>
        <div class="c-row">
          <button class="c-login" data-act="refresh" data-tip="Poll claude.ai again now">Retry</button>
          <span class="spacer"></span>
          <button class="ic" data-act="theme" data-tip="${esc(themeTip())}">${themeIcon()}</button>
        </div>
      </div>`;
    }

    const pct = state.fiveHour.pct;
    const t = tierOf(state.fiveHour);
    const delta = state.delta;
    const burn = state.burnRate;
    const resetIso = state.fiveHour.resetsAt || '';

    const deltaTxt = Number.isFinite(delta) ? `+${fmtPct(delta)}%` : '—';
    const burnTxt = Number.isFinite(burn) ? `${fmtPct(burn)}%/h` : '—/h';

    return `
    <div class="cm-compact glass" data-drag>
      <div class="c-row">
        <span data-tip="5-hour session window: ${fmtPct(pct)}% used (${TIER_LABEL[t]})">${TIER_DOT[t]}</span>
        <span class="c-quota" data-tip="Share of your 5-hour session allowance consumed">${fmtPct(pct)}%</span>
        ${resetIso ? `
        <span class="c-used">•</span>
        <span class="c-metric" data-tip="Time remaining until the 5-hour session window resets"
              data-live="reset5" data-iso="${esc(resetIso)}" data-short="1">🕒 —</span>` : ''}
        <span class="spacer"></span>
        <button class="ic" data-act="expand" data-tip="Open detailed view">${icon('maximize')}</button>
      </div>
      <div class="c-row">
        <span class="c-metric ${Number.isFinite(delta) && delta > 0 ? 'pos' : ''}"
              data-tip="Last prompt impact — how much the session gauge moved between the two most recent checks (~2 min apart)">💬 ${deltaTxt}</span>
        <span class="c-metric"
              data-tip="Hourly burn rate — recent consumption extrapolated to a per-hour pace">🔥 ${burnTxt}</span>
        <span class="spacer"></span>
        <button class="ic" data-act="theme" data-tip="${esc(themeTip())}">${themeIcon()}</button>
      </div>
    </div>`;
  }

  /* ---- detail ---- */

  function headHtml() {
    return `
    <div class="d-head" data-drag>
      <span class="d-title" data-tip="Drag this bar to move the HUD">CLAUDOMETER</span>
      <button class="ic ic-refresh" data-act="refresh" data-tip="Refresh now">${icon('refresh', 18)}</button>
      <button class="ic" data-act="theme" data-tip="${esc(themeTip())}">${themeIcon()}</button>
      <button class="ic" data-act="minimize" data-tip="Minimise to compact HUD">${icon('minimize')}</button>
      <button class="ic" data-act="close" data-tip="Hide Claudometer (a small ◔ handle stays in the corner)">${icon('close')}</button>
    </div>`;
  }

  function settingsHtml() {
    return `
    <div class="sec">
      <div class="sec-head"><span class="sec-title">Settings</span></div>
      <label class="toggle" data-tip="Show these glass tooltips on hover. Turning this off suppresses every tooltip in the HUD.">
        <input type="checkbox" data-set="tooltips" ${settings.tooltips ? 'checked' : ''}>
        <span>Enable Hover Tooltips</span>
      </label>
      <label class="toggle" data-tip="Desktop notification when the session window crosses 60%, 85% and 95%.">
        <input type="checkbox" data-set="alerts" ${settings.alerts ? 'checked' : ''}>
        <span>Desktop Alerts</span>
      </label>
      <div class="row" style="margin-top:6px;align-items:center" data-tip="How often Claudometer polls claude.ai for a fresh reading. Shorter intervals notice changes sooner; longer intervals poll less often.">
        <span class="k">Auto-Refresh</span>
        <select class="sel" data-set="pollMinutes">
          ${POLL_MINUTES_CHOICES.map(m => `<option value="${m}" ${Number(settings.pollMinutes) === m ? 'selected' : ''}>Every ${m} min${m === 1 ? '' : 's'}</option>`).join('')}
        </select>
      </div>
      <div class="row" style="margin-top:6px" data-tip="Chrome only grants site access from an extension's own popup, not from a page — open it via the toolbar icon to change this.">
        <span class="k">Runs on</span>
        <span class="v">${settings.allSites ? 'All websites' : 'Claude.ai only'} — toggle in toolbar</span>
      </div>
    </div>`;
  }

  function footHtml() {
    const when = state && state.updatedAt
      ? new Date(state.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      : '—';
    const agoIso = state && state.updatedAt ? new Date(state.updatedAt).toISOString() : '';
    const stale = state && state.stale
      ? `<span class="stale-chip" data-tip="${esc(state.error || 'Last poll failed')}">stale</span>` : '';
    return `
    <div class="foot">
      <span data-tip="Claudometer polls claude.ai every 2 minutes">Updated ${esc(when)}${agoIso
        ? ` (<span data-live="ago" data-iso="${esc(agoIso)}">—</span>)`
        : ''}</span>
      ${stale}
      <span class="spacer"></span>
      <span data-tip="Percentages come from claude.ai's own usage endpoint">v${esc(EXT_VERSION)}</span>
    </div>`;
  }

  function detailHtml() {
    if (isUnauth()) {
      return `
      <div class="cm-detail glass">
        ${headHtml()}
        <div class="d-body">
          <div class="state">
            <span class="emoji">⚠️</span>
            <div class="msg">Not Logged In to Claude.ai</div>
            <div class="sub">Claudometer reads your limits from your own browser session.<br>Sign in and the gauges fill in automatically.</div>
            <button class="btn" data-act="login" data-tip="Opens https://claude.ai/login in a new tab">Log in to Claude.ai</button>
          </div>
          ${settingsHtml()}
          ${footHtml()}
        </div>
      </div>`;
    }

    if (!hasData()) {
      const err = state && state.status === 'ERROR';
      return `
      <div class="cm-detail glass">
        ${headHtml()}
        <div class="d-body">
          <div class="state">
            <span class="emoji">${err ? '⚠️' : '◔'}</span>
            <div class="msg">${err ? 'Couldn’t read usage' : 'Waiting for first reading'}</div>
            <div class="sub">${esc(err ? (state.error || 'The usage endpoint did not return data Claudometer understands.') : 'The first poll runs within a couple of minutes.')}</div>
            <button class="btn ghost" data-act="refresh" data-tip="Poll claude.ai again now">Try again</button>
          </div>
          ${settingsHtml()}
          ${footHtml()}
        </div>
      </div>`;
    }

    return `
    <div class="cm-detail glass">
      ${headHtml()}
      <div class="d-body">
        ${sessionSection()}
        ${weeklySection()}
        ${burnSection()}
        ${creditsSection()}
        ${settingsHtml()}
        ${footHtml()}
      </div>
    </div>`;
  }

  function sessionSection() {
    const w = state.fiveHour;
    const t = tierOf(w);
    const delta = state.delta;

    return `
    <div class="sec s-${t}">
      <div class="sec-head">
        <span class="sec-title">5-Hour Session</span>
        <span class="sec-pct" data-tip="Share of the rolling 5-hour allowance consumed">${fmtPct(w.pct)}%</span>
        <span class="tag" data-tip="Under 60% Normal · 60–84% Warning · 85%+ Critical">${TIER_LABEL[t]}</span>
      </div>
      <div class="bar" data-tip="${fmtPct(w.pct)}% of the 5-hour window used">
        <i style="width:${clamp(w.pct, 0, 100)}%"></i>
      </div>
      <div class="rows">
        <div class="row" data-tip="When this rolling window rolls over and the gauge returns to 0%">
          <span class="k">Resets in</span>
          <span class="v" data-live="reset5" data-iso="${esc(w.resetsAt || '')}">—</span>
        </div>
        <div class="row" data-tip="Movement in the session gauge between the two most recent polls — in practice, the cost of your last prompt or two">
          <span class="k">Last prompt impact</span>
          <span class="v accent">${Number.isFinite(delta) ? `+${fmtPct(delta)}%` : '—'}</span>
        </div>
      </div>
    </div>`;
  }

  function weeklySection() {
    const w = state.sevenDay;
    if (!w) {
      return `
      <div class="sec">
        <div class="sec-head"><span class="sec-title">7-Day Weekly Cap</span></div>
        <div class="rows"><div class="row"
             data-tip="claude.ai did not report a 7-day window for this account — plans without a weekly cap simply omit it">
          <span class="k">Not reported for this account</span></div></div>
      </div>`;
    }
    const t = tierOf(w);

    return `
    <div class="sec s-${t}">
      <div class="sec-head">
        <span class="sec-title">7-Day Weekly Cap</span>
        <span class="sec-pct" data-tip="Share of the weekly allowance consumed">${fmtPct(w.pct)}%</span>
        <span class="tag" data-tip="Under 60% Normal · 60–84% Warning · 85%+ Critical">${TIER_LABEL[t]}</span>
      </div>
      <div class="bar" data-tip="${fmtPct(w.pct)}% of the weekly cap used">
        <i style="width:${clamp(w.pct, 0, 100)}%"></i>
      </div>
      <div class="rows">
        <div class="row" data-tip="Date and time the weekly cap rolls over">
          <span class="k">Resets</span>
          <span class="v">${esc(w.resetsAt ? dateAt(w.resetsAt) : '—')}</span>
        </div>
        <div class="row" data-tip="Time remaining until the weekly reset">
          <span class="k">That&rsquo;s in</span>
          <span class="v" data-live="reset7" data-iso="${esc(w.resetsAt || '')}" data-bare="1">—</span>
        </div>
        ${state.sevenDayOpus ? `
        <div class="row" data-tip="Some plans meter the largest model against its own weekly pool">
          <span class="k">Weekly (Opus pool)</span>
          <span class="v">${fmtPct(state.sevenDayOpus.pct)}%</span>
        </div>` : ''}
      </div>
    </div>`;
  }

  function burnSection() {
    const burn = state.burnRate;
    const runway = state.runway;

    let runwayTxt = '—';
    let runwayTip = 'Needs a measurable burn rate before a runway can be projected.';
    if (runway && Number.isFinite(runway.ms)) {
      if (runway.survivesWindow) {
        runwayTxt = 'Infinite Runway ♾️';
        runwayTip = 'At the current pace your remaining allowance outlives the window — it resets before you run out.';
      } else {
        runwayTxt = `≈ ${humanDuration(runway.ms)}`;
        runwayTip = 'Remaining session allowance divided by the current hourly pace.';
      }
    }

    return `
    <div class="sec s-${tierOf(state.fiveHour)}">
      <div class="sec-head"><span class="sec-title">Burn Rate &amp; Velocity</span></div>
      <div class="rows">
        <div class="row" data-tip="Total upward movement over the last hour of polls, extrapolated to an hourly pace. Window resets are excluded rather than netted out.">
          <span class="k">Hourly pace</span>
          <span class="v big">🔥 ${Number.isFinite(burn) ? `~${fmtPct(burn)}% / hr` : '—'}</span>
        </div>
        <div class="row" data-tip="${esc(runwayTip)}">
          <span class="k">Estimated runway</span>
          <span class="v accent">${esc(runwayTxt)}</span>
        </div>
      </div>
    </div>`;
  }

  /**
   * Usage credits (pay-as-you-go overage past the plan limits). The endpoint
   * reports this as `extra_usage` / `spend`, both switched off for most
   * accounts — so this whole section is omitted unless it is actually enabled.
   */
  function creditsSection() {
    const c = state.credits;
    if (!c) return '';

    const money = Number.isFinite(c.used)
      ? new Intl.NumberFormat([], { style: 'currency', currency: c.currency || 'USD' }).format(c.used)
      : '—';

    return `
    <div class="sec s-${c.severity || tier(c.pct)}">
      <div class="sec-head">
        <span class="sec-title">Usage Credits</span>
        ${Number.isFinite(c.pct) ? `<span class="sec-pct" data-tip="Share of your credit spend limit used">${fmtPct(c.pct)}%</span>` : ''}
      </div>
      ${Number.isFinite(c.pct) ? `<div class="bar" data-tip="${fmtPct(c.pct)}% of your credit limit used">
        <i style="width:${clamp(c.pct, 0, 100)}%"></i>
      </div>` : ''}
      <div class="rows">
        <div class="row" data-tip="Credits billed beyond your plan's included limits this period">
          <span class="k">Spent this period</span>
          <span class="v accent">${esc(money)}</span>
        </div>
      </div>
    </div>`;
  }

  /** Tick the countdowns without re-rendering (keeps hover and focus intact). */
  function updateLive() {
    if (!shell) return;
    shell.querySelectorAll('[data-live]').forEach(el => {
      const iso = el.getAttribute('data-iso');
      if (!iso) { el.textContent = '—'; return; }
      const target = new Date(iso).getTime();
      if (!Number.isFinite(target)) { el.textContent = '—'; return; }

      // "ago" elements count up from a past timestamp; reset countdowns count
      // down to a future one — same tick, opposite direction.
      if (el.getAttribute('data-live') === 'ago') {
        el.textContent = humanAgo(Date.now() - target);
        return;
      }

      const ms = target - Date.now();

      // Compact HUD's row-1 countdown: short form, clock glyph baked in since
      // this element's whole textContent gets replaced every tick anyway.
      if (el.getAttribute('data-short')) {
        el.textContent = `🕒 ${humanDurationShort(ms)}`;
        return;
      }

      if (ms <= 0) { el.textContent = 'any moment'; return; }
      el.textContent = el.getAttribute('data-bare')
        ? humanDuration(ms)
        : `${humanDuration(ms)} at ${clockAt(iso)}`;
    });
  }

  /* ---------------------------------------------------------------- *
   * boot
   * ---------------------------------------------------------------- */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let dirty = false;

    if (changes['cm.state']) { state = changes['cm.state'].newValue; dirty = true; }

    if (changes['cm.settings']) {
      const newStored = changes['cm.settings'].newValue || {};
      const wasAllSites = settings.allSites;
      const localPos = settings.pos; // drag position: tab-local, never adopted from storage

      settings = { ...DEFAULT_SETTINGS, ...newStored };
      settings.pos = localPos;

      dirty = true;

      // "Run on all websites" flipping live: mount into a tab that already has
      // this script sitting idle, or tear the HUD out of one that opted back out.
      if (!isClaudeTab && !wasAllSites && settings.allSites) tryMount();
      if (!isClaudeTab && wasAllSites && !settings.allSites) unmount();
    }

    if (dirty && mounted) render();
  });

  async function boot() {
    const res = await send({ type: 'CM_GET' });
    if (res) {
      state = res.state;
      settings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
    }
    tryMount();
    // Only a claude.ai tab can usefully trigger a poll — the extension's
    // fetch proxy only ever targets claude.ai tabs regardless of who asks,
    // but there is no reason for every other open site to also ping it.
    if (isClaudeTab) send({ type: 'CM_REFRESH' });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.addEventListener('pagehide', () => {
    clearInterval(liveTimer);
  });
})();
