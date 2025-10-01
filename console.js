// YouTube Transcript Extractor – paste this whole file into your browser console on a YouTube video page.
// It finds available caption tracks, fetches JSON (fmt=json3), extracts all segs[].utf8 strings,
// concatenates them, shows a floating UI with the text, and lets you download as TXT, Markdown, or PDF.
// Now also programmatically enables CC (Subtitles) so no manual click is required.
// Works on watch pages (youtube.com/watch?v=...) and Shorts (youtube.com/shorts/...).

(function () {
  const SCRIPT_ID = 'yt-transcript-extractor-panel';

  // --- Config ----------------------------------------------------------------
  const PREFERRED_LANG = 'en';
  // Tunables for observing and enabling captions (more generous to avoid races)
  const AUTO_ENABLE_CC_ATTEMPTS = (typeof globalThis !== 'undefined' && typeof globalThis.AUTO_ENABLE_CC_ATTEMPTS !== 'undefined') ? globalThis.AUTO_ENABLE_CC_ATTEMPTS : 6;
  const OBSERVE_WAIT_MS = (typeof globalThis !== 'undefined' && typeof globalThis.OBSERVE_WAIT_MS !== 'undefined') ? globalThis.OBSERVE_WAIT_MS : 6000; // total time we'll wait for a timedtext hit
  const OBSERVE_POLL_INTERVAL_MS = (typeof globalThis !== 'undefined' && typeof globalThis.OBSERVE_POLL_INTERVAL_MS !== 'undefined') ? globalThis.OBSERVE_POLL_INTERVAL_MS : 300;
  const PLAYER_LOAD_MAX_WAIT_MS = 5000;
  const CC_CLICK_RETRY_INTERVAL_MS = 500;
  // Removed playback nudge timing (we no longer manipulate video playback)
  // Hint image uses hosted PNG from GitHub raw (loaded later in the UI)
  // ---------------------------------------------------------------------------

  // --- Trusted Types helpers (for CSP with require-trusted-types-for 'script') ---
  // We need a policy to assign to <script>.src as a TrustedScriptURL.
  // If TT is unavailable, we degrade to a no-op shaper.
  const TT = (() => {
    try {
      if (window.trustedTypes?.createPolicy) {
        // Keep the policy name stable to avoid duplicates across re-runs.
        // Browsers ignore re-creation with the same name but it's fine to try.
        return window.trustedTypes.createPolicy('ytte_trusted_policy', {
          createScriptURL: (url) => url,
        });
      }
    } catch {}
    // Fallback shim with same interface
    return { createScriptURL: (url) => url };
  })();

  // If the host page uses a script nonce, reuse it for injected scripts.
  function currentScriptNonce() {
    try {
      const s = document.querySelector('script[nonce]');
      return s?.nonce || s?.getAttribute?.('nonce') || '';
    } catch { return ''; }
  }

  async function loadScriptTrusted(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // Satisfy Trusted Types (when enforced) by providing a TrustedScriptURL
      // and satisfy CSP nonces if present on the page.
      try {
        s.src = TT.createScriptURL(url);
      } catch (e) {
        return reject(e);
      }
      const nonce = currentScriptNonce();
      if (nonce) s.setAttribute('nonce', nonce);
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + url));
      document.head.appendChild(s);
    });
  }
  // -------------------------------------------------------------------------

  // --- Trusted Types–safe SVG factory (no innerHTML) -----------------------
  function createIconSvg(pathD, viewBox = '0 0 24 24') {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', pathD);
    svg.appendChild(path);
    return svg;
  }
  // -------------------------------------------------------------------------

  // Guard: remove prior instance if re-run
  const existing = document.getElementById(SCRIPT_ID);
  if (existing) existing.remove();

  // Utilities
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- NEW: CC (Subtitles) auto-toggle --------------------------------------
  // Wait for an element matching any of the selectors to appear.
  async function waitForAnySelector(selectors, { timeout = 5000, interval = 100 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      await sleep(interval);
    }
    return null;
  }

  function getMoviePlayer() {
    // Prefer the polymer/player instance if available
    return window.yt?.player?.getPlayerByElement?.(document.getElementById('movie_player'))
      || document.getElementById('movie_player')
      || document.querySelector('#movie_player, ytd-player #movie_player');
  }

  function getHtml5Video() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  async function waitForPlayerReady(timeoutMs = PLAYER_LOAD_MAX_WAIT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const player = getMoviePlayer();
      const video = getHtml5Video();
      if (player || video) return { player, video };
      await sleep(100);
    }
    return { player: getMoviePlayer(), video: getHtml5Video() };
  }

  // Removed: playback nudge helper; we no longer play/pause/mute the video.

  function getCaptionsButton() {
    // Works both in default and theater modes
    return document.querySelector('.ytp-subtitles-button');
  }

  function isCcOn() {
    const btn = getCaptionsButton();
    const pressed = btn?.getAttribute('aria-pressed');
    return pressed === 'true';
  }

  async function clickCaptionsButtonIfOff() {
    const btn = getCaptionsButton();
    if (!btn) return false;
    if (isCcOn()) return true;
    btn.click(); // synthetic click is accepted for this control
    await sleep(200);
    return isCcOn();
  }

  function tryLoadCaptionsModule(player) {
    try {
      if (player?.loadModule) player.loadModule('captions');
      // A harmless option write that also prods the module to wake up
      if (player?.setOption) player.setOption('captions', 'fontSize', 1);
    } catch {}
  }

  async function robustEnableCaptions(preferredLang) {
    // 1) Make sure player/video exist and wake captions module if possible
    const { player } = await waitForPlayerReady();
    if (player) tryLoadCaptionsModule(player);
    // 2) If API supports track selection, set desired language (best-effort)
    try {
      if (player?.setOption && preferredLang) {
        player.setOption('captions', 'track', { languageCode: preferredLang });
      }
    } catch {}
    // 3) Ensure CC button is ON, retrying a few times in case UI not mounted yet
    const deadline = Date.now() + OBSERVE_WAIT_MS;
    while (Date.now() < deadline) {
      const ok = await clickCaptionsButtonIfOff();
      if (ok) return true;
      await sleep(CC_CLICK_RETRY_INTERVAL_MS);
    }
    return isCcOn();
  }

  // Replace with a more robust implementation (loads module, clicks CC)
  async function setCaptionsEnabled(enable, { timeout = 4000, lang = PREFERRED_LANG } = {}) {
    if (!enable) {
      const btn = getCaptionsButton();
      if (btn && isCcOn()) { btn.click(); await sleep(150); }
      return !isCcOn();
    }
    const ok = await robustEnableCaptions(lang);
    if (ok) return true;
    // Last-ditch: retry clicking within the provided timeout (no playback manipulation)
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await clickCaptionsButtonIfOff()) return true;
      await sleep(250);
    }
    return isCcOn();
  }
  // --------------------------------------------------------------------------

  // --- NEW: Timedtext network sniffer ---------------------------------------
  function ensureTimedtextSpy() {
    if (window.__ytTimedtextSpyInstalled) return window.__ytTimedtextSpy;
    const listeners = new Set();
    const hits = []; // { url, ts }
    const notify = (hit) => { for (const fn of listeners) try { fn(hit); } catch {} };
    const push = (url) => {
      const abs = (() => {
        try { return new URL(url, location.origin).toString(); }
        catch { return String(url || ''); }
      })();
      const hit = { url: abs, ts: Date.now() };
      hits.push(hit);
      notify(hit);
    };
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const req = args[0];
        const url = (typeof req === 'string') ? req : (req && req.url);
        if (url && /\/api\/timedtext\b/.test(url)) push(url);
      } catch {}
      return origFetch.apply(this, args);
    };
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
      try { this.__tt_url = url; } catch {}
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        const u = this.__tt_url;
        if (u && /\/api\/timedtext\b/.test(u)) {
          const abs = new URL(u, location.origin).toString();
          this.addEventListener('loadstart', () => push(abs), { once: true });
        }
      } catch {}
      return XS.apply(this, arguments);
    };
    // Also observe ResourceTiming (catches some requests that bypass XHR/fetch hooks)
    try {
      if (!window.__ytPerfObsInstalled && 'PerformanceObserver' in window) {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e && e.name && /\/api\/timedtext\b/.test(e.name)) push(e.name);
          }
        });
        po.observe({ entryTypes: ['resource'] });
        window.__ytPerfObsInstalled = true;
      }
    } catch {}
    const api = {
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      getAll() { return hits.slice().sort((a, b) => b.ts - a.ts); }
    };
    window.__ytTimedtextSpyInstalled = true;
    window.__ytTimedtextSpy = api;
    return api;
  }
  // --------------------------------------------------------------------------

  // Wait until a timedtext URL appears for this video (or return last best)
  async function waitForTimedtextObservedForVideo(isForThisVideo, { timeout = OBSERVE_WAIT_MS, interval = OBSERVE_POLL_INTERVAL_MS } = {}) {
    const spy = ensureTimedtextSpy();
    const deadline = Date.now() + timeout;
    const first = spy.getAll().find((h) => isForThisVideo(h.url));
    if (first) return first.url;
    while (Date.now() < deadline) {
      await sleep(interval);
      const hit = spy.getAll().find((h) => isForThisVideo(h.url));
      if (hit) return hit.url;
    }
    return '';
  }

  function getVideoId() {
    try {
      const u = new URL(location.href);
      const v = u.searchParams.get('v');
      if (v) return v;
      // Shorts URL pattern: /shorts/{id}
      const parts = location.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' && parts[1]) return parts[1];
      // Polymer element sometimes stores it
      const flexy = document.querySelector('ytd-watch-flexy');
      const vid = flexy?.getAttribute('video-id');
      if (vid) return vid;
    } catch (e) {}
    return null;
  }

  function getPlayerResponse() {
    try {
      const flexy = document.querySelector('ytd-watch-flexy');
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
      if (flexy && flexy.playerResponse) return flexy.playerResponse;
      const prAttr = flexy?.getAttribute('player-response');
      if (prAttr) return JSON.parse(prAttr);
    } catch (e) {}
    return null;
  }

  function getCaptionTracks(pr) {
    return (
      pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
    );
  }

  function pickDefaultTrack(tracks) {
    if (!tracks || !tracks.length) return null;
    // Prefer English manual, then English ASR, then first
    const enManual = tracks.find((t) => t.languageCode?.startsWith('en') && !/asr/i.test(t.kind || ''));
    if (enManual) return enManual;
    const enAny = tracks.find((t) => t.languageCode?.startsWith('en'));
    if (enAny) return enAny;
    return tracks[0];
  }

  function ensureJson3(urlStr) {
    try {
      const u = new URL(urlStr, location.origin);
      const fmt = (u.searchParams.get('fmt') || '').toLowerCase();
      // Only append fmt=json3 if missing; do not override existing fmt to preserve the original URL fully
      if (!fmt) u.searchParams.set('fmt', 'json3');
      return u.toString();
    } catch (e) {
      return urlStr;
    }
  }

  function buildFallbackUrl(videoId, lang) {
    const u = new URL('https://www.youtube.com/api/timedtext');
    u.searchParams.set('v', videoId);
    u.searchParams.set('fmt', 'json3');
    u.searchParams.set('lang', lang || 'en');
    // Try ASR if manual not available
    u.searchParams.set('kind', 'asr');
    return u.toString();
  }

  function buildMinimalJson3Url(videoId, lang, kind) {
    const u = new URL('https://www.youtube.com/api/timedtext');
    u.searchParams.set('v', videoId);
    u.searchParams.set('fmt', 'json3');
    u.searchParams.set('lang', lang || 'en');
    if (kind && /asr/i.test(kind)) u.searchParams.set('kind', 'asr');
    return u.toString();
  }

  function buildFallbackVttUrl(videoId, lang) {
    const u = new URL('https://www.youtube.com/api/timedtext');
    u.searchParams.set('v', videoId);
    u.searchParams.set('fmt', 'vtt');
    u.searchParams.set('lang', lang || 'en');
    u.searchParams.set('kind', 'asr');
    return u.toString();
  }

  function augmentTimedtextUrl(urlStr) {
    try {
      const u = new URL(urlStr, location.origin);
      // Preserve all existing params; add only if missing
      const setIfMissing = (k, v) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };

      // fmt
      setIfMissing('fmt', 'json3');

      // Client info
      const ver = (window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION')) || '2.20240101.00.00';
      setIfMissing('c', 'WEB');
      setIfMissing('cver', String(ver));
      setIfMissing('cplayer', 'UNIPLAYER');

      // Brand/Browser
      const ua = navigator.userAgent || '';
      const chromeVer = (ua.match(/Chrome\/([\d.]+)/) || [])[1];
      setIfMissing('cbr', 'Chrome');
      if (chromeVer) setIfMissing('cbrver', chromeVer);

      // Platform/OS
      const plat = navigator.platform || '';
      const isMac = /Mac/i.test(plat) || /Macintosh/i.test(ua);
      const isWin = /Win/i.test(plat) || /Windows/i.test(ua);
      const isLinux = /Linux/i.test(plat);
      if (isMac) setIfMissing('cbrand', 'apple');
      setIfMissing('cplatform', 'DESKTOP');
      if (isMac) {
        setIfMissing('cos', 'Macintosh');
        const macVer = (ua.match(/Mac OS X ([0-9_]+)/) || [])[1];
        if (macVer) setIfMissing('cosver', macVer);
      } else if (isWin) {
        setIfMissing('cos', 'Windows');
        const winVer = (ua.match(/Windows NT ([0-9.]+)/) || [])[1];
        if (winVer) setIfMissing('cosver', winVer.replace(/\./g, '_'));
      } else if (isLinux) {
        setIfMissing('cos', 'X11');
        setIfMissing('cosver', '');
      }

      // Extra flags that appear commonly
      setIfMissing('xorb', '2');
      setIfMissing('xobt', '3');
      setIfMissing('xovt', '3');

      // Ensure sparams is percent-encoded (commas -> %2C) by re-setting it through URLSearchParams
      if (u.searchParams.has('sparams')) {
        const sp = u.searchParams.get('sparams') || '';
        // Re-set the raw value (with commas). URLSearchParams will encode on serialization.
        u.searchParams.set('sparams', sp);
      }

      return u.toString();
    } catch (e) {
      return urlStr;
    }
  }

  // Heuristic: decide if a timedtext URL is "strong" (has signed/authoritative params).
  // Short URLs like ?v=...&lang=en&fmt=vtt are considered weak and often return HTML.
  function isStrongTimedtextUrl(urlStr) {
    try {
      const u = new URL(urlStr, location.origin);
      const p = u.searchParams;
      const hasSig = p.has('signature') || p.has('sig') || p.has('s');
      const hasSparams = p.has('sparams');
      const hasKeyish = p.has('key') || p.has('expire') || p.has('ei') || p.has('caps') || p.has('opi') || p.has('pot') || p.has('potc');
      return hasSig || hasSparams || hasKeyish;
    } catch {
      return false;
    }
  }

  // NEW: Rewrite only the caption language while preserving every other param.
  // Safe because YT signatures cover params listed in sparams, and lang is typically NOT in sparams.
  function rewriteTimedtextLang(urlStr, newLang) {
    try {
      const u = new URL(urlStr, location.origin);
      if (newLang) {
        u.searchParams.set('lang', newLang);
        // Keep UI locale in sync if present; harmless if missing.
        if (u.searchParams.has('hl')) u.searchParams.set('hl', newLang);
        // Remove translation override that can conflict with lang=
        u.searchParams.delete('tlang');
      }
      // Do NOT touch signature/s/sparams/key/expire/etc.
      return u.toString();
    } catch {
      return urlStr;
    }
  }

  // Build a fully "downloadable" timedtext URL from any input URL (or synthesize one).
  // Guarantees: fmt=json3, sparams percent-encoded, UA/client flags added,
  // and preserves signed params (signature/sig/s, key, pot/potc, etc.)
  function makeDownloadableTimedtextUrl(urlStr, videoId, lang, kind) {
    try {
      // If nothing provided, start from a minimal json3 URL for this video/lang/kind
      const base = urlStr && urlStr.trim() ? urlStr : buildMinimalJson3Url(videoId, lang, kind);
      const u = new URL(base, location.origin);
      if (!u.searchParams.get('fmt')) u.searchParams.set('fmt', 'json3');
      // Re-apply sparams so commas become %2C on serialization
      if (u.searchParams.has('sparams')) {
        const sp = u.searchParams.get('sparams') || '';
        u.searchParams.set('sparams', sp);
      }
      // Add client/UA params without dropping any existing signed params
      return augmentTimedtextUrl(u.toString());
    } catch {
      return urlStr;
    }
  }

  function ytClientHeaders() {
    try {
      const name = window.ytcfg?.get?.('INNERTUBE_CLIENT_NAME') || '1';
      const ver = window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '2.20240101.00.00';
      return {
        'X-YouTube-Client-Name': String(name),
        'X-YouTube-Client-Version': String(ver),
        'Accept': '*/*',
      };
    } catch (e) {
      return { 'Accept': '*/*' };
    }
  }

  function stripXssiPrefix(s) {
    return s.replace(/^\)\]\}'\s*/, '');
  }

  function jsonFromXmlTranscript(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('XML parse error');
    }
    const entries = Array.from(doc.getElementsByTagName('text'));
    if (entries.length) {
      const events = entries.map((n) => {
        let t = (n.textContent || '').replace(/\u200b/g, '');
        if (!t.endsWith('\n')) t += '\n';
        return { segs: [{ utf8: t }] };
      });
      return { events };
    }
    // TTML fallback: <tt>...<p>text</p>...</tt>
    const ps = Array.from(doc.getElementsByTagName('p'));
    const events = ps.map((n) => {
      let t = (n.textContent || '').replace(/\u200b/g, '');
      if (!t.endsWith('\n')) t += '\n';
      return { segs: [{ utf8: t }] };
    });
    return { events };
  }

  function vttToEvents(vttString) {
    const lines = vttString.split(/\r?\n/);
    let i = 0;
    if (/^WEBVTT/i.test(lines[0] || '')) i = 1;
    const events = [];
    let buf = [];
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) {
        if (buf.length) {
          events.push({ segs: [{ utf8: buf.join(' ') + '\n' }] });
          buf = [];
        }
        continue;
      }
      if (/^NOTE($|\s)/i.test(l)) continue;
      if (l.includes('-->')) continue; // timespan line
      buf.push(l.trim());
    }
    if (buf.length) events.push({ segs: [{ utf8: buf.join(' ') + '\n' }] });
    return { events };
  }

  async function fetchJson(url) {
    const tryParse = (raw) => JSON.parse(stripXssiPrefix(raw.trim()));
    const res = await fetch(url, { credentials: 'same-origin', headers: ytClientHeaders() });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();

    try {
      return tryParse(body);
    } catch (_) {
      // WebVTT?
      if (/^WEBVTT/i.test(body)) {
        try { return vttToEvents(body); } catch (_) {}
      }
      // Retry once forcing fmt=json3 if current fmt isn't json3 and URL isn't signed.
      try {
        const u = new URL(url, location.origin);
        const fmt = (u.searchParams.get('fmt') || '').toLowerCase();
        const hasSig = u.searchParams.has('signature') || u.searchParams.has('sig') || u.searchParams.has('s');
        if (fmt !== 'json3' && !hasSig) {
          u.searchParams.set('fmt', 'json3');
          const rJ = await fetch(u.toString(), { credentials: 'same-origin', headers: ytClientHeaders() });
          const bJ = await rJ.text();
          try { return tryParse(bJ); } catch (_) {
            if (/^WEBVTT/i.test(bJ)) { try { return vttToEvents(bJ); } catch (_) {} }
            if (/^(<\?xml|<transcript|<text[\s>]|<tt[\s>])/i.test(bJ)) { try { return jsonFromXmlTranscript(bJ); } catch (_) {} }
          }
        }
      } catch (_) {}
      // Retry once with fmt=srv3 if current fmt wasn't srv3
      try {
        const u = new URL(url, location.origin);
        const fmt = (u.searchParams.get('fmt') || '').toLowerCase();
        const hasSig = u.searchParams.has('signature') || u.searchParams.has('sig') || u.searchParams.has('s');
        if (fmt !== 'srv3' && !hasSig) {
          u.searchParams.set('fmt', 'srv3');
          const r2 = await fetch(u.toString(), { credentials: 'same-origin', headers: ytClientHeaders() });
          const b2 = await r2.text();
          try { return tryParse(b2); } catch (_) {
            if (/^WEBVTT/i.test(b2)) {
              try { return vttToEvents(b2); } catch (_) {}
            }
            if (/^(<\?xml|<transcript|<text[\s>]|<tt[\s>])/i.test(b2)) {
              try { return jsonFromXmlTranscript(b2); } catch (_) {}
            }
          }
        }
      } catch (_) {}

      // If the response was HTML, try constructing a minimal timedtext URL (strip signatures and extras).
      try {
        if (/text\/html/i.test(ct) && /\/api\/timedtext/.test(url)) {
          const o = new URL(url, location.origin);
          const v = o.searchParams.get('v');
          const lang = o.searchParams.get('lang') || o.searchParams.get('hl') || 'en';
          const kind = o.searchParams.get('kind');
          if (v) {
            const u2 = new URL('https://www.youtube.com/api/timedtext');
            u2.searchParams.set('v', v);
            u2.searchParams.set('lang', lang);
            u2.searchParams.set('fmt', 'json3');
            if (kind) u2.searchParams.set('kind', kind);
            const r3 = await fetch(u2.toString(), { credentials: 'same-origin', headers: ytClientHeaders() });
            const b3 = await r3.text();
            try { return tryParse(b3); } catch (_) {
              if (/^WEBVTT/i.test(b3)) {
                try { return vttToEvents(b3); } catch (_) {}
              }
              if (/^(<\?xml|<transcript|<text[\s>]|<tt[\s>])/i.test(b3)) {
                try { return jsonFromXmlTranscript(b3); } catch (_) {}
              }
            }
            // Try VTT minimal as last resort
            u2.searchParams.set('fmt', 'vtt');
            const r4 = await fetch(u2.toString(), { credentials: 'same-origin', headers: ytClientHeaders() });
            const b4 = await r4.text();
            if (/^WEBVTT/i.test(b4)) {
              try { return vttToEvents(b4); } catch (_) {}
            }
            if (/^(<\?xml|<transcript|<text[\s>]|<tt[\s>])/i.test(b4)) {
              try { return jsonFromXmlTranscript(b4); } catch (_) {}
            }
          }
        }
      } catch (_) {}

      // XML fallback
      if (/^(<\?xml|<transcript|<text[\s>]|<tt[\s>])/i.test(body)) {
        try {
          return jsonFromXmlTranscript(body);
        } catch (_) {}
      }

      throw new Error(
        'Response was not JSON. Status ' +
          res.status +
          '. Content-Type: ' +
          ct +
          '. URL: ' +
          url +
          '. First 120 chars: ' +
          body.slice(0, 120)
      );
    }
  }

  function extractUtf8TextFromJson3(json) {
    // Expect shape: { events: [ { segs: [ { utf8: '...' }, ... ] }, ... ] }
    const events = json?.events || [];
    const parts = [];
    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      for (const s of ev.segs) {
        if (s?.utf8 != null) parts.push(s.utf8);
      }
      // Ensure a line break between events when they didn't contain one
      if (parts.length && !parts[parts.length - 1].endsWith('\n')) parts.push('\n');
    }
    let text = parts.join('');
    // Clean up common artifacts
    text = text
      .replace(/\u200b/g, '') // zero-width space
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  }

  function formatMarkdown(title, url, body) {
    const dt = new Date().toISOString();
    return `# ${title || 'YouTube Transcript'}\n\n- Source: ${url}\n- Exported: ${dt}\n\n---\n\n${body}\n`;
  }

  function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  async function ensureJsPDF() {
    if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
    // Load via TT-aware loader to satisfy CSP / Trusted Types.
    await loadScriptTrusted('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
    await sleep(50);
    if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
    throw new Error('jsPDF not available after load');
  }

  function buildPanel() {
    const styleId = SCRIPT_ID + '-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        #${SCRIPT_ID} {
          --bg: #2D353B; --bg-elev: #232A2E; --text: #D3C6AA; --muted: #9DA9A0;
          /* Accent switched to AQUA from palette.md */
          --accent: #83C092; /* aqua */
          --accent-2: #83C092; /* keep secondary accent in aqua family */
          --border: #475258; --muted-2: #859289;
          position: fixed; inset: auto 16px  auto auto; top: 16px; right: 16px; z-index: 2147483647;
          width: clamp(280px, 92vw, 720px);
          /* Give a smaller default height so it doesn't cover the CC button */
          height: clamp(220px, 56vh, 640px);
          max-height: 85vh;
          display: flex; flex-direction: column;
          background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,.6), 0 0 0 1px rgba(163,190,140,.1);
          overflow: hidden; box-sizing: border-box;
          font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
        }
        #${SCRIPT_ID} * { scrollbar-width: thin; }
        /* Resize handle */
        #${SCRIPT_ID} .ytte-resize-handle{position:absolute;z-index:3;bottom:10px;right:10px;width:14px;height:14px;border:1px solid var(--border);border-radius:4px;opacity:.8;cursor:nwse-resize;user-select:none;-webkit-user-select:none;touch-action:none;background:linear-gradient(135deg, transparent 48%, var(--muted) 49% 51%, transparent 52%)}
        #${SCRIPT_ID} .ytte-resize-handle:hover{opacity:1}
        #${SCRIPT_ID} .ytte-resize-handle:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
        /* Header */
        #${SCRIPT_ID} .ytte-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:var(--bg-elev);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:2}
        #${SCRIPT_ID} .ytte-title{font-weight:600;font-size:14px}
        #${SCRIPT_ID} .ytte-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        #${SCRIPT_ID} .ytte-select{background:#343F44;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:13px;transition:border .2s,box-shadow .2s}
        #${SCRIPT_ID} .ytte-select:focus{outline:none;border-color:var(--accent-2);box-shadow:0 0 0 3px rgba(127,187,179,.15)}
        #${SCRIPT_ID} .ytte-extract{background:var(--accent);color:#2D353B;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;font-weight:600;font-size:13px;transition:transform .15s,box-shadow .15s,filter .15s}
        #${SCRIPT_ID} .ytte-extract:hover{filter:saturate(108%);transform:translateY(-1px);box-shadow:0 4px 12px rgba(131,192,146,.30)}
        #${SCRIPT_ID} .ytte-extract:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
        #${SCRIPT_ID} .ytte-close{background:transparent;color:var(--muted-2);border:none;font-size:20px;line-height:1;cursor:pointer;border-radius:8px;padding:4px 6px}
        #${SCRIPT_ID} .ytte-close:hover{color:#E67E80;background:rgba(230,126,128,.1)}
        /* Body */
        /* Make body fill panel via flex to avoid leftover/empty area on resize */
        #${SCRIPT_ID} .ytte-body{
          display:flex;flex-direction:column;gap:10px;padding:12px 14px;
          background:var(--bg);
          /* Let the body be the scroll container to prevent overflow when the panel shrinks */
          overflow:auto;scrollbar-gutter:stable both-edges;
          flex:1 1 auto;min-height:0; /* critical for proper flex scrolling */
        }
        #${SCRIPT_ID} .ytte-info{font-size:12px;color:var(--muted);line-height:1.5}
        #${SCRIPT_ID} .ytte-row{display:flex;gap:8px;align-items:center}
        #${SCRIPT_ID} .ytte-input{flex:1;background:var(--bg-elev);color:var(--muted-2);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12px;font-family:ui-monospace,Monaco,"Cascadia Code",monospace}
        /* Icon button (used for copy buttons) */
        #${SCRIPT_ID} .ytte-iconbtn{
          background:#343F44;color:var(--text);border:1px solid var(--border);
          border-radius:8px;padding:6px 8px;cursor:pointer;line-height:0;display:inline-flex;
          align-items:center;justify-content:center;
        }
        #${SCRIPT_ID} .ytte-copy{display:none} /* legacy class no longer shown */
        #${SCRIPT_ID} .ytte-iconbtn:hover{border-color:var(--accent);background:#3D484D}
        #${SCRIPT_ID} .ytte-iconbtn.is-copied{background:#425047;color:var(--accent);border-color:var(--accent)}
        /* Make the transcript block flex so it shrinks gracefully with the panel */
        #${SCRIPT_ID} .ytte-textarea-wrapper{
          position:relative;width:100%;
          display:flex;flex:1 1 auto;min-height:0; /* allow child to shrink */
        }
        #${SCRIPT_ID} .ytte-textarea{
          width:100%;
          /* Remove fixed vh height to avoid overflow on panel resize; let it grow/shrink with flex */
          height:auto;
          flex:1 1 auto; min-height:120px; /* still tall enough to be usable */
          resize:vertical;
          background:#232A2E;color:var(--text);border:1px solid var(--border);border-radius:8px;
          padding:8px;font-size:14px;line-height:1.6;
          font-family:ui-monospace,Monaco,"Cascadia Code",monospace;
          box-sizing:border-box;overflow:auto;scrollbar-gutter:stable both-edges
        }
        #${SCRIPT_ID} .ytte-textarea::placeholder{color:#7A8478;font-style:italic}
        #${SCRIPT_ID} .ytte-copy-transcript{
          position:absolute;top:8px;right:8px;
          background:#343F44;color:var(--text);border:1px solid var(--border);
          border-radius:6px;padding:6px;cursor:pointer;opacity:0.9;
          transition:opacity .2s,border-color .2s,background .2s; line-height:0;
        }
        #${SCRIPT_ID} .ytte-copy-transcript:hover{opacity:1;border-color:var(--accent);background:#3D484D}
        #${SCRIPT_ID} .ytte-copy-transcript.is-copied{background:#425047;color:var(--accent);border-color:var(--accent)}
        /* Sticky actions: stay visible but never force overflow */
        #${SCRIPT_ID} .ytte-actions{
          display:flex;flex-wrap:wrap;gap:8px;position:sticky;bottom:0;
          background:linear-gradient(to top, var(--bg) 80%, transparent);
          backdrop-filter:blur(4px);border-top:1px solid rgba(71,82,88,.5);
          padding:8px 0 0;z-index:2
        }
        #${SCRIPT_ID} .ytte-btn{background:#343F44;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;font-weight:500;transition:transform .1s}
        #${SCRIPT_ID} .ytte-btn:active{transform:scale(.98)}
        #${SCRIPT_ID} .ytte-btn--txt:hover{border-color:#DBBC7F;color:#DBBC7F;background:#3D484D}
        #${SCRIPT_ID} .ytte-btn--md:hover{border-color:#E69875;color:#E69875;background:#3D484D}
        #${SCRIPT_ID} .ytte-btn--pdf:hover{border-color:#D699B6;color:#D699B6;background:#3D484D}
        /* Scrollbars */
        #${SCRIPT_ID} .ytte-body::-webkit-scrollbar{width:10px}
        #${SCRIPT_ID} .ytte-body::-webkit-scrollbar-track{background:#232A2E;border-radius:8px}
        #${SCRIPT_ID} .ytte-body::-webkit-scrollbar-thumb{background:var(--accent);border-radius:8px;border:2px solid #232A2E}
        #${SCRIPT_ID} .ytte-body::-webkit-scrollbar-thumb:hover{background:#8BC8A2}
        #${SCRIPT_ID} .ytte-textarea::-webkit-scrollbar{width:10px}
        #${SCRIPT_ID} .ytte-textarea::-webkit-scrollbar-track{background:#232A2E;border-radius:8px}
        #${SCRIPT_ID} .ytte-textarea::-webkit-scrollbar-thumb{background:var(--accent);border-radius:8px;border:2px solid #232A2E}
        #${SCRIPT_ID} .ytte-textarea::-webkit-scrollbar-thumb:hover{background:#8BC8A2}
        /* Hint */
        #${SCRIPT_ID} .ytte-hint{background:#1D2529;border:1px dashed #3D484D;border-radius:8px;padding:10px;margin:8px 14px;display:block}
        #${SCRIPT_ID} .ytte-hint.is-hidden{display:none}
        #${SCRIPT_ID} .ytte-hint-title{font-size:13px;color:#E6EDF3;margin-bottom:8px;font-weight:500}
        #${SCRIPT_ID} .ytte-hint img{width:33%;height:auto;border-radius:6px;display:block}
        #${SCRIPT_ID} .ytte-hint-note{font-size:12px;color:#9BA7AD;margin-top:6px}
        /* Responsive */
        @media (max-width: 768px){
          #${SCRIPT_ID}{right: max(8px, env(safe-area-inset-right, 8px)); top: max(8px, env(safe-area-inset-top, 8px)); width: calc(100vw - 2*max(8px, env(safe-area-inset-right, 8px)));}
          #${SCRIPT_ID} .ytte-header{gap:10px;padding:10px 12px}
          #${SCRIPT_ID} .ytte-controls{flex:1 1 100%}
          #${SCRIPT_ID} .ytte-extract{flex:0 0 auto}
          /* Smaller default height on mobile as well */
          #${SCRIPT_ID}{height: clamp(220px, 48vh, 560px);}
          #${SCRIPT_ID} .ytte-resize-handle{display:none}
        }
        @media (max-width: 480px){
          #${SCRIPT_ID} .ytte-controls{flex-direction:column;align-items:stretch}
          #${SCRIPT_ID} .ytte-row{flex-direction:column;align-items:stretch}
          #${SCRIPT_ID} .ytte-extract{width:100%}
          #${SCRIPT_ID} .ytte-actions{position:sticky}
        }
      `;
      document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.id = SCRIPT_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'YouTube Transcript Extractor');

    const header = document.createElement('div');
    header.className = 'ytte-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'ytte-title';
    titleEl.textContent = 'Transcript Extractor';

    const controls = document.createElement('div');
    controls.className = 'ytte-controls';

    const trackSel = document.createElement('select');
    trackSel.className = 'ytte-select';
    trackSel.title = 'Caption track';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'ytte-extract';
    refreshBtn.textContent = 'Extract Transcript';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ytte-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';

    controls.append(trackSel, refreshBtn);
    header.append(titleEl, controls, closeBtn);

    const body = document.createElement('div');
    body.className = 'ytte-body';

    const info = document.createElement('div');
    info.className = 'ytte-info';

    // CC toggle hint (shows until a strong observed URL is found)
    const hint = document.createElement('div');
    hint.className = 'ytte-hint';
    const hintTitle = document.createElement('div');
    hintTitle.className = 'ytte-hint-title';
    hintTitle.textContent = 'Toggle CC button to trigger the caption';
    const hintImg = document.createElement('img');
    // Use hosted PNG on GitHub raw to avoid local path issues
    const CC_TOGGLE_IMAGE_URL = 'https://raw.githubusercontent.com/withLinda/youtube-closed-caption-tool/refs/heads/main/images/toggle-CC-button.png';
    hintImg.src = CC_TOGGLE_IMAGE_URL;
    // Fallback to singular folder name if needed
    hintImg.addEventListener('error', () => {
      try {
        if (!/\bimage\/toggle-CC-button\.png$/.test(hintImg.src)) {
          hintImg.src = 'image/toggle-CC-button.png';
        }
      } catch {}
    }, { once: true });
    hintImg.alt = 'Toggle CC (Subtitles) to trigger captions';
    const hintNote = document.createElement('div');
    hintNote.className = 'ytte-hint-note';
    hintNote.textContent = 'The tool auto-enables CC, but clicking it manually helps trigger the caption URL.';
    hint.append(hintTitle, hintImg, hintNote);

    const observedRow = document.createElement('div');
    observedRow.className = 'ytte-row';
    const observedUrlInput = document.createElement('input');
    observedUrlInput.className = 'ytte-input';
    observedUrlInput.type = 'text';
    observedUrlInput.placeholder = 'Observed Network URL (exact, read-only)';
    observedUrlInput.readOnly = true;
    const copyObservedUrlBtn = document.createElement('button');
    copyObservedUrlBtn.className = 'ytte-iconbtn';
    copyObservedUrlBtn.setAttribute('aria-label','Copy observed network URL');
    copyObservedUrlBtn.title = 'Copy observed network URL';
    copyObservedUrlBtn.appendChild(
      createIconSvg('M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z')
    );
    observedRow.append(observedUrlInput, copyObservedUrlBtn);

    const taWrapper = document.createElement('div');
    taWrapper.className = 'ytte-textarea-wrapper';
    
    const ta = document.createElement('textarea');
    ta.className = 'ytte-textarea';
    ta.placeholder = 'Transcript will appear here...';
    
    const copyTranscriptBtn = document.createElement('button');
    copyTranscriptBtn.className = 'ytte-copy-transcript';
    copyTranscriptBtn.setAttribute('aria-label','Copy transcript to clipboard');
    copyTranscriptBtn.title = 'Copy transcript to clipboard';
    copyTranscriptBtn.appendChild(
      createIconSvg('M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z')
    );
    
    taWrapper.append(ta, copyTranscriptBtn);

    const actions = document.createElement('div');
    actions.className = 'ytte-actions';
    const dlTxt = document.createElement('button'); dlTxt.className = 'ytte-btn ytte-btn--txt'; dlTxt.textContent = 'Download .txt';
    const dlMd  = document.createElement('button'); dlMd.className  = 'ytte-btn ytte-btn--md';  dlMd.textContent  = 'Download .md';
    const dlPdf = document.createElement('button'); dlPdf.className = 'ytte-btn ytte-btn--pdf'; dlPdf.textContent = 'Download .pdf';
    actions.append(dlTxt, dlMd, dlPdf);

    body.append(info, hint, observedRow, taWrapper, actions);
    panel.append(header, body);

    // Subtle resize handle (desktop only)
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'ytte-resize-handle';
    resizeHandle.setAttribute('aria-label', 'Resize transcript panel');
    resizeHandle.title = 'Drag to resize. Double‑click to reset. Use arrow keys for fine control (Shift for larger steps).';
    resizeHandle.tabIndex = 0;
    panel.appendChild(resizeHandle);

    closeBtn.addEventListener('click', () => panel.remove());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.remove(); }, { once: true });

    document.body.appendChild(panel);
    return { panel, trackSel, refreshBtn, info, ta, dlTxt, dlMd, dlPdf, observedUrlInput, copyObservedUrlBtn, resizeHandle, copyTranscriptBtn, hint };
  }

  function titleAndAuthor(pr) {
    const title = pr?.videoDetails?.title || document.title.replace(/ - YouTube$/, '');
    const author = pr?.videoDetails?.author || '';
    return { title, author };
  }

  // Main controller
  (async function main() {
    const vid = getVideoId();
    const pr = getPlayerResponse();
    const {
      panel, trackSel, refreshBtn, info, ta, dlTxt, dlMd, dlPdf,
      observedUrlInput, copyObservedUrlBtn, resizeHandle, copyTranscriptBtn, hint
    } = buildPanel();

    // Resizable panel setup
    (function setupResizable(panelEl, handleEl){
      const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
      const MIN_W = 280;
      const MIN_H = 220;
      const maxW = () => Math.max(MIN_W, Math.min(960, window.innerWidth - 32));
      const maxH = () => Math.max(MIN_H, Math.floor(window.innerHeight * 0.85));
      let startX = 0, startY = 0, startW = 0, startH = 0, dragging = false;

      const applySize = (w, h) => {
        const W = clamp(w, MIN_W, maxW());
        const H = clamp(h, MIN_H, maxH());
        panelEl.style.width = W + 'px';
        panelEl.style.height = H + 'px';
      };
      const currentSize = () => {
        const r = panelEl.getBoundingClientRect();
        return { w: r.width, h: r.height };
      };

      // Pointer-based resize
      handleEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handleEl.setPointerCapture(e.pointerId);
        dragging = true;
        const { w, h } = currentSize();
        startW = w; startH = h; startX = e.clientX; startY = e.clientY;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'nwse-resize';
      });
      handleEl.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX; // moving left (negative) should increase width (right-anchored)
        const dy = e.clientY - startY; // moving down increases height (top-anchored)
        const newW = startW - dx;
        const newH = startH + dy;
        applySize(newW, newH);
      });
      const stopDrag = (e) => {
        if (!dragging) return;
        dragging = false;
        try { handleEl.releasePointerCapture(e.pointerId); } catch {}
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      };
      handleEl.addEventListener('pointerup', stopDrag);
      handleEl.addEventListener('pointercancel', stopDrag);

      // Keyboard resizing for accessibility
      handleEl.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 40 : 12;
        const { w, h } = currentSize();
        let nw = w, nh = h;
        if (e.key === 'ArrowLeft') { nw = w + step; }
        else if (e.key === 'ArrowRight') { nw = w - step; }
        else if (e.key === 'ArrowUp') { nh = h + step; }
        else if (e.key === 'ArrowDown') { nh = h - step; }
        else if (e.key === 'Enter') { /* no-op reserved */ return; }
        else { return; }
        e.preventDefault();
        applySize(nw, nh);
      });

      // Double-click to reset to responsive defaults
      handleEl.addEventListener('dblclick', () => {
        panelEl.style.width = '';
        panelEl.style.height = '';
      });

      // Keep within viewport on window resize
      window.addEventListener('resize', () => {
        if (!panelEl.style.width && !panelEl.style.height) return; // using defaults
        const { w, h } = currentSize();
        applySize(w, h);
      });
    })(panel, resizeHandle);

    if (!vid) {
      info.textContent = 'Could not determine video ID. Navigate to a YouTube video page and try again.';
      return;
    }

    const tracks = getCaptionTracks(pr);
    const defaultTrack = pickDefaultTrack(tracks);

    const { title, author } = titleAndAuthor(pr);

    // NEW: start network spy and update Observed URL when we see a matching v=
    const spy = ensureTimedtextSpy();
    const isForThisVideo = (u) => {
      try {
        const p = new URL(u);
        const vv = p.searchParams.get('v');
        return !vv || vv === vid;
      } catch {
        return true;
      }
    };
    // Only consider strong (signed/complete) URLs as "observed"
    const latestObservedForThisVideo = () => {
      const all = spy.getAll();
      const m = all.find((h) => isForThisVideo(h.url) && isStrongTimedtextUrl(h.url));
      return m ? m.url : '';
    };
    const existingObserved = latestObservedForThisVideo();
    if (existingObserved) { observedUrlInput.value = existingObserved; hint.classList.add('is-hidden'); }
    info.textContent = 'Listening for caption URL… The hint image stays visible until a valid URL is observed. When detected, extraction runs automatically.';
    refreshBtn.title = 'Extract now (also runs automatically when a caption URL is observed).';

    // Always listen; auto-extract once a strong timedtext URL for this video is seen.
    let __autoExtractedFrom = '';
    let __autoExtracting = false;
    spy.on(async (hit) => {
      if (isForThisVideo(hit.url) && isStrongTimedtextUrl(hit.url)) {
        const strong = hit.url;
        observedUrlInput.value = strong; // store only strong URLs
        try { hint.classList.add('is-hidden'); } catch {}
        if (__autoExtractedFrom !== strong && !__autoExtracting) {
          __autoExtracting = true;
          try {
            await extractSelected();
            __autoExtractedFrom = strong;
          } finally {
            __autoExtracting = false;
          }
        }
      }
    });

    // Populate selector
    const makeOptionLabel = (t) => {
      const parts = [];
      if (t.languageName?.simpleText) parts.push(t.languageName.simpleText);
      else if (t.languageCode) parts.push(t.languageCode);
      if (/asr/i.test(t.kind || '')) parts.push('(auto)');
      if (t.name?.simpleText) parts.push('-', t.name.simpleText);
      return parts.join(' ');
    };

    // Clear existing options without touching innerHTML (Trusted Types safe)
    while (trackSel.options.length > 0) {
      trackSel.remove(0);
    }
    if (tracks.length) {
      tracks.forEach((t, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = makeOptionLabel(t);
        if (t === defaultTrack) opt.selected = true;
        trackSel.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '-1';
      opt.textContent = 'No tracks listed (observed network URL only)';
      trackSel.appendChild(opt);
    }

    async function extractSelected() {
      try {
        let observedExact = (observedUrlInput.value || '').trim();
        // Ensure captions are actually ON before we attempt observation
        await robustEnableCaptions(PREFERRED_LANG);
        // Determine the best track to fall back to up front (selected → default).
        let trackToUse = null;
        if (Array.isArray(tracks) && tracks.length) {
          const idx = parseInt(trackSel.value, 10);
          if (Number.isFinite(idx) && idx >= 0 && tracks[idx]) {
            trackToUse = tracks[idx];
          }
          if (!trackToUse) trackToUse = pickDefaultTrack(tracks);
        }

        // If we have nothing observed yet, try a few enable/wait cycles (no playback nudging).
        if (!observedExact) {
          let ccOk = false;
          const perAttemptWait = Math.max(OBSERVE_POLL_INTERVAL_MS, Math.floor(OBSERVE_WAIT_MS / Math.max(1, AUTO_ENABLE_CC_ATTEMPTS)));
          for (let i = 0; i < AUTO_ENABLE_CC_ATTEMPTS && !observedExact; i++) {
            ccOk = (await setCaptionsEnabled(true, { timeout: 4000, lang: PREFERRED_LANG })) || ccOk;
            observedExact = await waitForTimedtextObservedForVideo(isForThisVideo, { timeout: perAttemptWait, interval: OBSERVE_POLL_INTERVAL_MS });
          }
          if (observedExact) {
            observedUrlInput.value = observedExact;
            try { if (isStrongTimedtextUrl(observedExact)) hint.classList.add('is-hidden'); } catch {}
          }
        }

        // 1) Prefer observed strong timedtext URL. Rewrite ONLY lang (preserve signatures).
        if (observedExact && isStrongTimedtextUrl(observedExact)) {
          const selectedLang = (trackToUse?.languageCode || PREFERRED_LANG);
          const observedWithLang = rewriteTimedtextLang(observedExact, selectedLang);
          try {
            info.textContent = `Extracting from observed timedtext URL (lang=${selectedLang})…`;
            const json = await fetchJson(observedWithLang);
            const text = extractUtf8TextFromJson3(json);
            ta.value = text || '[Empty transcript]';
            observedUrlInput.value = observedWithLang; // show strong URL with new lang
            try { hint.classList.add('is-hidden'); } catch {}
            info.textContent = `${title || 'Video'} by ${author || 'Unknown'} — ${location.href.split('&pp=')[0]} (observed URL, lang set)`;
            return;
          } catch (_) {
            // continue to fallback below
          }
        }

        // 2) Fall back to selected track (prefer EN/default).

        if (trackToUse && (trackToUse.baseUrl || trackToUse.vssId || trackToUse.languageCode)) {
          info.textContent = 'No observed URL — fetching from selected track…';
          const lang = trackToUse.languageCode || PREFERRED_LANG;
          const manualUrl = makeDownloadableTimedtextUrl(trackToUse.baseUrl || '', vid, lang, trackToUse.kind);
          // Do not store short/minimal URLs in the observed field; keep it for strong ones only
          try {
            const json = await fetchJson(manualUrl);
            const text = extractUtf8TextFromJson3(json);
            ta.value = text || '[Empty transcript]';
            info.textContent = `${title || 'Video'} by ${author || 'Unknown'} — ${location.href.split('&pp=')[0]} (track fallback)`;
            return;
          } catch (_) {
            // continue to minimal fallback
          }
        }

        // 3) Synthesized minimal EN JSON3 timedtext (then VTT) for this video.
        info.textContent = 'No tracks listed — trying minimal EN timedtext…';
        const minimalUrl = buildMinimalJson3Url(vid, PREFERRED_LANG, trackToUse?.kind || null);
        try {
          const json = await fetchJson(minimalUrl);
          const text = extractUtf8TextFromJson3(json);
          ta.value = text || '[Empty transcript]';
          // Do not store short/minimal URLs in the observed field
          info.textContent = `${title || 'Video'} by ${author || 'Unknown'} — ${location.href.split('&pp=')[0]} (minimal EN)`;
          return;
        } catch (_) {
          const vttUrl = buildFallbackVttUrl(vid, PREFERRED_LANG);
          try {
            const json = await fetchJson(vttUrl);
            const text = extractUtf8TextFromJson3(json);
            ta.value = text || '[Empty transcript]';
            // Do not store short/minimal URLs in the observed field
            info.textContent = `${title || 'Video'} by ${author || 'Unknown'} — ${location.href.split('&pp=')[0]} (VTT fallback)`;
            return;
          } catch (err) {
            console.error(err);
            // Keep listening silently; once a valid timedtext URL appears, extraction runs automatically.
            info.textContent = 'Listening for caption URL… Toggle the CC button if needed.';
            return;
          }
        }
      } catch (e) {
        console.error(e);
        // Keep the UI in a listening state rather than showing a hard failure.
        info.textContent = 'Listening for caption URL… Toggle the CC button if needed.';
      }
    }

    refreshBtn.addEventListener('click', extractSelected);
    panel.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        extractSelected();
      }
    });

    // --- NEW: Try to auto-enable CC shortly after panel appears -------------
    // Do this after the spy is armed so we can catch the first timedtext call.
    (async () => {
      try {
        // Give the player a brief moment to finish hydrating UI.
        await sleep(300);
        // Try multiple times; extractSelected() will also fall back if nothing is observed
        for (let i = 0; i < AUTO_ENABLE_CC_ATTEMPTS; i++) {
          const ok = await setCaptionsEnabled(true, { timeout: 4000 });
          if (ok) {
            break;
          }
        }
      } catch {}
    })();
    // ------------------------------------------------------------------------

    copyObservedUrlBtn.addEventListener('click', async () => {
      try {
        const val = observedUrlInput.value || '';
        if (!val) return;
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(val);
        } else {
          observedUrlInput.select();
          document.execCommand('copy');
          observedUrlInput.blur();
        }
        copyObservedUrlBtn.classList.add('is-copied');
        setTimeout(() => { copyObservedUrlBtn.dataset.copied = 'false'; copyObservedUrlBtn.classList.remove('is-copied'); }, 1200);
      } catch (_) {}
    });

    copyTranscriptBtn.addEventListener('click', async () => {
      try {
        const val = ta.value || '';
        if (!val || val === '[Empty transcript]') return;
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(val);
        } else {
          ta.select();
          document.execCommand('copy');
          ta.blur();
        }
        copyTranscriptBtn.classList.add('is-copied');
        setTimeout(() => { copyTranscriptBtn.classList.remove('is-copied'); }, 1200);
      } catch (_) {}
    });

    // Downloads
    dlTxt.addEventListener('click', () => {
      const name = (title || `youtube-${vid}`).replace(/[^\w\-]+/g, '_') + '.txt';
      const blob = new Blob([ta.value], { type: 'text/plain;charset=utf-8' });
      downloadBlob(name, blob);
    });

    dlMd.addEventListener('click', () => {
      const name = (title || `youtube-${vid}`).replace(/[^\w\-]+/g, '_') + '.md';
      const md = formatMarkdown(title, location.href, ta.value);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      downloadBlob(name, blob);
    });

    dlPdf.addEventListener('click', async () => {
      try {
        dlPdf.textContent = 'Preparing PDF...';
        dlPdf.disabled = true;
        const JS = await ensureJsPDF();
        const doc = new JS({ unit: 'pt', format: 'a4' });
        const margin = 40;
        const pageWidth = doc.internal.pageSize.getWidth();
        const usable = pageWidth - margin * 2;
        const header = (title || `YouTube Transcript (${vid})`);
        doc.setFont('Times', 'bold');
        doc.setFontSize(14);
        doc.text(header, margin, 50, { maxWidth: usable });
        doc.setFont('Times', 'normal');
        doc.setFontSize(11);
        const lines = doc.splitTextToSize(ta.value || '', usable);
        let y = 80;
        const lineHeight = 14;
        const pageHeight = doc.internal.pageSize.getHeight();
        for (const line of lines) {
          if (y > pageHeight - margin) {
            doc.addPage();
            y = margin;
          }
          doc.text(line, margin, y);
          y += lineHeight;
        }
        const name = (title || `youtube-${vid}`).replace(/[^\w\-]+/g, '_') + '.pdf';
        doc.save(name);
      } catch (e) {
        alert('PDF export failed: ' + e.message);
      } finally {
        dlPdf.textContent = 'Download .pdf';
        dlPdf.disabled = false;
      }
    });

    // Auto-run once
    await extractSelected();
  })();
})();
