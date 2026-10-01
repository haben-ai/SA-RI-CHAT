'use strict';
(() => {
  // Replaced at build time from environment variables (see build.mjs).
  const API = '__SUPABASE_URL__';
  const KEY = '__SUPABASE_ANON_KEY__';

  const PAGE = 30;            // messages per page
  const CACHE_N = 50;         // messages kept on the device for instant start
  const BUCKET = 'chat-photos';
  const COLS = 'id,sender_id,message_type,content,created_at';
  const DAY = 864e5;

  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const msgsEl = $('msgs');
  const input = $('input');

  // ---------- small utilities ----------

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('pc.' + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('pc.' + k, JSON.stringify(v)); } catch (e) { /* full / private mode */ } },
    clear() {
      try { Object.keys(localStorage).forEach((k) => k.startsWith('pc.') && localStorage.removeItem(k)); } catch (e) { /* ignore */ }
    },
  };

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

  class HttpError extends Error {
    constructor(status) { super('HTTP ' + status); this.status = status; }
  }
  const isNet = (e) => !(e instanceof HttpError);
  const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- session & HTTP ----------

  // S = { at, rt, exp, room, me } — Supabase anonymous-auth tokens + room membership.
  let S = store.get('session');
  let anon = null;          // anonymous tokens obtained on the access screen
  let refreshing = null;
  let refreshTimer = 0;

  const tokens = (t) => ({ at: t.access_token, rt: t.refresh_token, exp: Date.now() + t.expires_in * 1000 });
  const saveSession = () => store.set('session', S);

  async function call(path, opts, bearer) {
    const headers = Object.assign({ apikey: KEY }, opts && opts.headers);
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    const r = await fetch(API + path, Object.assign({}, opts, { headers }));
    if (!r.ok) throw new HttpError(r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }

  function token(force) {
    if (!S) return Promise.reject(new HttpError(401));
    // Another tab may already have refreshed.
    const saved = store.get('session');
    if (saved && saved.room === S.room && saved.exp > S.exp) Object.assign(S, saved);
    if (!force && S.exp - Date.now() > 60e3) return Promise.resolve(S.at);
    if (!refreshing) {
      refreshing = call('/auth/v1/token?grant_type=refresh_token', json({ refresh_token: S.rt }))
        .then((t) => {
          if (!S) throw new HttpError(401);
          Object.assign(S, tokens(t));
          saveSession();
          scheduleRefresh();
          rt.auth();
          return S.at;
        })
        .catch((e) => {
          const saved2 = store.get('session');
          if (!isNet(e) && e.status < 500 && !(saved2 && S && saved2.rt !== S.rt)) {
            wipe('Your session has ended. Please enter the code again.');
          }
          throw e;
        })
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (S) refreshTimer = setTimeout(() => token(true).catch(() => {}), Math.max(10e3, S.exp - Date.now() - 300e3));
  }

  async function api(path, opts, retried) {
    try {
      return await call(path, opts, await token());
    } catch (e) {
      if (!retried && e.status === 401 && S) { S.exp = 0; return api(path, opts, true); }
      throw e;
    }
  }
  const rpc = (fn, args) => api('/rest/v1/rpc/' + fn, json(args));

  // ---------- connection status ----------

  function status(text) {
    const s = $('status');
    s.textContent = text;
    s.className = 'status' + (text === 'Connected' ? ' ok' : text === 'Offline' ? ' off' : '');
    $('menuStatus').textContent = text === 'Reconnecting…' ? 'Connection lost. Trying again…' : 'Status: ' + text;
  }

  // ---------- realtime (minimal Phoenix client, private broadcast channel) ----------

  const rt = {
    ws: null, ref: 0, joinRef: null, hbRef: null, hbTimer: 0, retryTimer: 0, joinTimer: 0,
    tries: 0, joined: false,

    connect() {
      if (this.ws || !S) return;
      clearTimeout(this.retryTimer);
      if (navigator.onLine === false) { status('Offline'); return; }
      status(this.tries ? 'Reconnecting…' : 'Connecting…');
      const ws = this.ws = new WebSocket(API.replace(/^http/, 'ws') +
        '/realtime/v1/websocket?apikey=' + encodeURIComponent(KEY) + '&vsn=1.0.0');
      ws.onopen = () => {
        token().then((at) => {
          if (this.ws !== ws) return;
          this.joinRef = null;
          this.joinRef = this.send('phx_join', {
            config: { broadcast: { ack: false, self: false }, presence: { key: '', enabled: false }, postgres_changes: [], private: true },
            access_token: at,
          });
          this.hbTimer = setInterval(() => this.beat(), 30e3);
        }, () => ws.close());
      };
      ws.onmessage = (e) => { try { this.onMsg(JSON.parse(e.data)); } catch (err) { /* ignore malformed */ } };
      ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.down(); } };
      // Slow networks: give the handshake + join up to 30 s.
      this.joinTimer = setTimeout(() => { if (this.ws === ws && !this.joined) ws.close(); }, 30e3);
    },

    send(event, payload, topic) {
      const ref = String(++this.ref);
      this.ws.send(JSON.stringify({ topic: topic || 'realtime:room:' + S.room, event, payload, ref, join_ref: this.joinRef || ref }));
      return ref;
    },

    beat() {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (this.hbRef) { this.ws.close(); return; } // previous heartbeat never answered → dead link
      this.hbRef = this.send('heartbeat', {}, 'phoenix');
    },

    onMsg(m) {
      if (m.topic === 'phoenix') { if (m.ref === this.hbRef) this.hbRef = null; return; }
      if (m.event === 'phx_reply' && m.ref === this.joinRef) {
        if (m.payload && m.payload.status === 'ok') {
          this.joined = true;
          this.tries = 0;
          clearTimeout(this.joinTimer);
          status('Connected');
          onConnected();
        } else {
          // Rejected: maybe the access token is no longer valid. A forced refresh either fixes it
          // or, if the session itself was revoked, returns the user to the access screen.
          this.ws.close();
          token(true).catch(() => {});
        }
        return;
      }
      if (m.event === 'broadcast' && m.payload && m.payload.event === 'msg') { incoming(m.payload.payload); return; }
      if (m.event === 'phx_error' || m.event === 'phx_close' ||
        (m.event === 'system' && m.payload && m.payload.status === 'error')) {
        if (this.ws) this.ws.close();
      }
    },

    down() {
      clearInterval(this.hbTimer);
      clearTimeout(this.joinTimer);
      this.hbRef = null;
      this.joined = false;
      if (!S) return;
      if (navigator.onLine === false) { status('Offline'); return; }
      status('Reconnecting…');
      const s = [1, 2, 5, 10, 20, 30, 60][Math.min(this.tries++, 6)];
      this.retryTimer = setTimeout(() => this.connect(), s * 1000 * (0.75 + Math.random() / 2));
    },

    now() { this.tries = 0; clearTimeout(this.retryTimer); if (!this.ws) this.connect(); },
    restart() { this.stop(); this.connect(); },
    auth() { if (this.joined) this.send('access_token', { access_token: S.at }); },
    stop() {
      clearTimeout(this.retryTimer);
      clearTimeout(this.joinTimer);
      clearInterval(this.hbTimer);
      const ws = this.ws;
      this.ws = null;
      this.joined = false;
      this.hbRef = null;
      if (ws) ws.close();
    },
  };

  // ---------- messages state & rendering ----------

  const byId = new Map();   // id → { m, el, t, st, busy, photo, local }
  let newestMs = null;      // newest server timestamp seen (ms)
  let oldest = null;        // { ms, raw } oldest server message loaded (pagination cursor)
  let atStart = false;      // reached the first message of the room
  let outbox = [];          // unsent text messages, persisted
  let unread = 0;
  let cacheTimer = 0;

  const fmtTime = (iso) => {
    const d = new Date(iso);
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t
      : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + t;
  };
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const toBottom = () => { list.scrollTop = list.scrollHeight; };

  // Insert in chronological order; unsent messages (no timestamp) stay at the bottom.
  function place(node, ms) {
    node.dataset.k = ms == null ? '' : ms;
    let ref = null;
    if (ms != null) {
      for (let c = msgsEl.lastElementChild; c; c = c.previousElementSibling) {
        if (c.dataset.k !== '' && +c.dataset.k <= ms) break;
        ref = c;
      }
    }
    msgsEl.insertBefore(node, ref);
  }

  function setState(rec, st) {
    rec.st = st;
    const t = rec.t;
    const time = rec.m.created_at ? fmtTime(rec.m.created_at) : '';
    t.textContent = '';
    if (rec.m.sender_id !== S.me) { t.textContent = time; return; }
    if (st === 'sent') { t.textContent = time + ' ✓'; return; }
    if (st === 'failed') {
      const b = el('button', null, 'Retry');
      b.type = 'button';
      b.onclick = () => deliver(rec);
      t.append(el('span', 'bad', 'Not sent — '), b);
      return;
    }
    t.textContent = st;
  }

  function render(m, local) {
    let rec = byId.get(m.id);
    if (rec) {                                       // duplicate → just confirm
      if (!rec.m.created_at && m.created_at) settle(rec, m.created_at);
      return rec;
    }
    const node = el('div', 'm ' + (m.sender_id === S.me ? 'me' : 'them'));
    node.dataset.id = m.id;
    const b = node.appendChild(el('div', 'b'));
    rec = { m, el: node, t: null, st: '', local };
    if (m.message_type === 'image') {
      b.classList.add('img');
      b.appendChild(photoEl(rec));
    } else {
      b.textContent = m.content;
    }
    rec.t = node.appendChild(el('div', 't'));
    byId.set(m.id, rec);
    place(node, m.created_at ? Date.parse(m.created_at) : null);
    setState(rec, m.created_at ? 'sent' : 'Sending…');
    return rec;
  }

  // A server-confirmed message (from history, sync or realtime).
  function addServer(m) {
    const ms = Date.parse(m.created_at);
    if (newestMs == null || ms > newestMs) newestMs = ms;
    if (!oldest || ms < oldest.ms) oldest = { ms, raw: m.created_at };
    return render(m);
  }

  function settle(rec, createdAt) {
    const ms = Date.parse(createdAt);
    rec.m.created_at = createdAt;
    if (newestMs == null || ms > newestMs) newestMs = ms;
    place(rec.el, ms);
    setState(rec, 'sent');
    outbox = outbox.filter((o) => o.id !== rec.m.id);
    store.set('outbox', outbox);
    saveCache();
  }

  function incoming(m) {
    if (!m || !m.id || byId.has(m.id) && byId.get(m.id).m.created_at) return;
    const stick = nearBottom();
    addServer(m);
    if (stick || m.sender_id === S.me) toBottom();
    if (document.hidden && m.sender_id !== S.me) document.title = '(' + (++unread) + ') Private Chat';
    saveCache();
  }

  function updateOlder() {
    const b = $('older');
    b.hidden = atStart || !oldest;
    b.disabled = false;
    b.textContent = 'Load older messages';
  }

  // Keep the newest confirmed messages on the device so the chat opens
  // instantly (and offline) and only the difference is downloaded.
  function saveCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(() => {
      if (!S) return;
      const rows = [];
      let c = msgsEl.lastElementChild;
      for (; c && rows.length < CACHE_N; c = c.previousElementSibling) {
        const r = byId.get(c.dataset.id);
        if (r && r.m.created_at) rows.push(r.m);
      }
      // "start" = the cache holds the whole conversation, so no "Load older" button is needed.
      store.set('cache', { room: S.room, start: atStart && !c, rows: rows.reverse() });
    }, 300);
  }

  // ---------- loading history ----------

  let syncing = null;
  const sync = () => syncing || (syncing = doSync().catch(() => {}).finally(() => { syncing = null; }));

  async function doSync() {
    if (!S) return;
    const base = '/rest/v1/messages?select=' + COLS + '&room_id=eq.' + S.room;
    if (newestMs == null) {
      const rows = await api(base + '&order=created_at.desc&limit=' + PAGE);
      rows.reverse().forEach(addServer);
      atStart = rows.length < PAGE;
      updateOlder();
      toBottom();
    } else {
      // Small overlap guards against clock/commit-order edge cases; duplicates are ignored.
      const since = new Date(newestMs - 5000).toISOString();
      const rows = await api(base + '&created_at=gte.' + encodeURIComponent(since) + '&order=created_at.asc&limit=100');
      if (rows.length === 100) { resetHistory(); return doSync(); } // long gap: just show the latest page
      const stick = nearBottom();
      rows.forEach(addServer);
      if (stick) toBottom();
    }
    msgsEl.classList.add('loaded');
    saveCache();
  }

  function resetHistory() {
    byId.forEach((rec, id) => {
      if (rec.m.created_at) { rec.el.remove(); byId.delete(id); }
    });
    newestMs = null;
    oldest = null;
  }

  $('older').onclick = async () => {
    const b = $('older');
    b.disabled = true;
    b.textContent = 'Loading…';
    try {
      const rows = await api('/rest/v1/messages?select=' + COLS + '&room_id=eq.' + S.room +
        '&created_at=lt.' + encodeURIComponent(oldest.raw) + '&order=created_at.desc&limit=' + PAGE);
      const h = list.scrollHeight;
      const top = list.scrollTop;
      rows.forEach(addServer);
      list.scrollTop = top + (list.scrollHeight - h);
      if (rows.length < PAGE) atStart = true;
      updateOlder();
    } catch (e) {
      b.disabled = false;
      b.textContent = 'Could not load. Tap to retry';
    }
  };

  // ---------- sending ----------

  let sendLock = false;

  function sendText() {
    const text = input.value.trim();
    if (!text || sendLock) return;
    sendLock = true;
    setTimeout(() => { sendLock = false; }, 400);
    input.value = '';
    grow();
    const m = { id: uuid(), sender_id: S.me, message_type: 'text', content: text, created_at: null };
    outbox.push(m);
    store.set('outbox', outbox);
    const rec = render(m);
    toBottom();
    deliver(rec);
  }

  async function deliver(rec) {
    if (rec.busy || !S) return;
    rec.busy = true;
    try {
      if (rec.photo) await uploadPhoto(rec);
      setState(rec, 'Sending…');
      const at = await rpc('send_message', {
        p_id: rec.m.id, p_room: S.room, p_type: rec.m.message_type, p_content: rec.m.content,
      });
      if (!rec.m.created_at) settle(rec, at); else setState(rec, 'sent');
    } catch (e) {
      if (S && !rec.m.created_at) setState(rec, 'failed');
    }
    rec.busy = false;
  }

  // Re-send everything of mine that is not confirmed yet (safe: ids make it idempotent).
  function retryFailed() {
    byId.forEach((rec) => { if (!rec.m.created_at && !rec.busy && rec.m.sender_id === S.me) deliver(rec); });
  }

  // ---------- photos ----------

  const signed = store.get('signed') || {};   // storage path → [signed url, expiry ms]
  let signQueue = new Map();
  let signTimer = 0;

  // Ask for display URLs in one batched request; images download only when visible (loading=lazy).
  function want(path, img) {
    img.dataset.p = path;
    const s = signed[path];
    if (s && s[1] - Date.now() > DAY) { img.src = s[0]; return; }
    if (!signQueue.has(path)) signQueue.set(path, []);
    signQueue.get(path).push(img);
    clearTimeout(signTimer);
    signTimer = setTimeout(flushSign, 20);
  }

  async function flushSign() {
    const q = signQueue;
    signQueue = new Map();
    const paths = Array.from(q.keys());
    if (!paths.length || !S) return;
    try {
      const res = await api('/storage/v1/object/sign/' + BUCKET, json({ expiresIn: 7 * 86400, paths }));
      const exp = Date.now() + 7 * DAY - 60e3;
      res.forEach((r, i) => {
        const p = r.path || paths[i];
        if (!r.signedURL || !q.has(p)) return;
        signed[p] = [API + '/storage/v1' + r.signedURL, exp];
        q.get(p).forEach((img) => { img.src = signed[p][0]; });
      });
      Object.keys(signed).forEach((k) => { if (signed[k][1] < Date.now()) delete signed[k]; });
      store.set('signed', signed);
    } catch (e) { /* retried on reconnect */ }
  }

  function photoEl(rec) {
    let c = {};
    try { c = JSON.parse(rec.m.content); } catch (e) { /* ignore */ }
    const img = el('img');
    img.alt = 'Photo';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = Math.min(240, c.w || 240);          // never upscale small photos
    img.height = c.w && c.h ? Math.round(img.width * c.h / c.w) : 180;
    img.onclick = () => view(rec);
    img.onerror = () => {
      if (img.dataset.p && !img.dataset.again) {
        img.dataset.again = '1';
        delete signed[img.dataset.p];
        img.removeAttribute('src');
        want(img.dataset.p, img);
      }
    };
    if (rec.local) img.src = rec.local.thumb; else if (c.t) want(c.t, img);
    return img;
  }

  function view(rec) {
    const v = $('viewer');
    const img = $('vImg');
    const msg = $('vMsg');
    v.hidden = false;
    img.removeAttribute('src');
    img.hidden = true;
    msg.textContent = 'Loading photo…';
    img.onload = () => { img.hidden = false; msg.textContent = ''; };
    img.onerror = () => { msg.textContent = 'Photo could not be loaded.'; };
    if (rec.local) { img.src = rec.local.full; return; }
    try { want(JSON.parse(rec.m.content).f, img); } catch (e) { msg.textContent = 'Photo could not be loaded.'; }
  }
  $('viewer').onclick = () => { $('viewer').hidden = true; $('vImg').removeAttribute('src'); };

  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => res({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }

  function toJpeg(img, max, q) {
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)); // never enlarge
    const w = Math.max(1, Math.round(img.naturalWidth * s));
    const h = Math.max(1, Math.round(img.naturalHeight * s));
    const c = el('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, w, h);
    x.drawImage(img, 0, 0, w, h);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res({ b, w, h }) : rej(new Error('encode'))), 'image/jpeg', q));
  }

  // Re-encoding also strips EXIF metadata (GPS location, camera info).
  async function compressPhoto(file) {
    const { img, url } = await loadImage(file);
    try {
      let out;
      for (const [max, q] of [[1280, 0.8], [1280, 0.7], [1280, 0.6], [1280, 0.5], [1024, 0.6], [800, 0.6], [640, 0.6]]) {
        out = await toJpeg(img, max, q);
        if (out.b.size <= 300e3) break;
      }
      if (out.b.size > 1e6) throw new Error('too large');
      const thumb = await toJpeg(img, 360, 0.6);
      return { full: out.b, thumb: thumb.b, w: out.w, h: out.h };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function putObject(path, blob, onProgress) {
    return token().then((at) => new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('POST', API + '/storage/v1/object/' + BUCKET + '/' + path);
      x.setRequestHeader('apikey', KEY);
      x.setRequestHeader('Authorization', 'Bearer ' + at);
      x.setRequestHeader('Content-Type', 'image/jpeg');
      x.setRequestHeader('Cache-Control', 'max-age=31536000');
      x.setRequestHeader('x-upsert', 'false');
      x.timeout = 180e3;
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => {
        // Already uploaded by an earlier attempt → fine.
        if (x.status < 300 || x.status === 409 || /Duplicate|already exists/i.test(x.responseText)) res();
        else rej(new HttpError(x.status));
      };
      x.onerror = x.ontimeout = () => rej(new TypeError('network'));
      x.send(blob);
    }));
  }

  async function uploadPhoto(rec) {
    const p = rec.photo;
    const c = JSON.parse(rec.m.content);
    const total = p.thumb.size + p.full.size;
    const show = (done) => setState(rec, 'Uploading… ' + Math.round(done / total * 100) + '%');
    show(p.tDone ? p.thumb.size : 0);
    if (!p.tDone) { await putObject(c.t, p.thumb, (f) => show(f * p.thumb.size)); p.tDone = true; }
    if (!p.fDone) { await putObject(c.f, p.full, (f) => show(p.thumb.size + f * p.full.size)); p.fDone = true; }
  }

  function note(text) {
    const n = $('note');
    n.textContent = text || '';
    n.hidden = !text;
  }

  async function sendPhoto(file) {
    if (file.type && !/^image\//.test(file.type)) { note('Please choose a photo.'); return; }
    note(file.size > 1e6 ? 'Photo is large. Compressing…' : 'Compressing photo…');
    let photo;
    try {
      photo = await compressPhoto(file);
    } catch (e) {
      note('This photo could not be prepared. Please try another one.');
      setTimeout(() => note(''), 5000);
      return;
    }
    note('');
    const id = uuid();
    const content = JSON.stringify({ f: S.room + '/' + id + '.jpg', t: S.room + '/' + id + '_t.jpg', w: photo.w, h: photo.h });
    const m = { id, sender_id: S.me, message_type: 'image', content, created_at: null };
    const rec = render(m, { thumb: URL.createObjectURL(photo.thumb), full: URL.createObjectURL(photo.full) });
    rec.photo = photo;
    toBottom();
    deliver(rec);
  }

  // ---------- connection lifecycle ----------

  function onConnected() {
    sync().then(retryFailed);
    document.querySelectorAll('img[data-p]:not([src])').forEach((img) => want(img.dataset.p, img));
  }

  addEventListener('online', () => { if (S) rt.now(); });
  addEventListener('offline', () => { if (S) status('Offline'); });

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    unread = 0;
    document.title = 'Private Chat';
    if (!S) return;
    // Mobile browsers silently kill sockets in the background: after a long pause, reconnect (which also syncs).
    if (Date.now() - hiddenAt > 60e3 || !rt.ws) rt.restart();
  });

  // Keep the composer above the on-screen keyboard (iOS ignores interactive-widget).
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => {
      const stick = nearBottom();
      document.documentElement.style.setProperty('--vh', vv.height + 'px');
      if (vv.offsetTop) window.scrollTo(0, 0);
      if (stick) toBottom();
    };
    vv.addEventListener('resize', fit);
    fit();
  }

  // ---------- screens ----------

  function openChat() {
    $('gate').hidden = true;
    $('chat').hidden = false;
    const cache = store.get('cache');
    if (cache && cache.room === S.room && cache.rows.length) {
      cache.rows.forEach(addServer);
      atStart = !!cache.start;
      msgsEl.classList.add('loaded');
    }
    outbox = (store.get('outbox') || []).filter((o) => o.sender_id === S.me);
    outbox.forEach((o) => setState(render(o), 'failed')); // re-sent automatically once connected
    updateOlder();
    toBottom();
    scheduleRefresh();
    rt.connect();
    if (!rt.ws) sync(); // offline-start: still try once in case navigator.onLine is wrong
  }

  function showGate(msg) {
    $('chat').hidden = true;
    $('gate').hidden = false;
    $('gateErr').textContent = msg || '';
  }

  function wipe(msg) {
    rt.stop();
    clearTimeout(refreshTimer);
    store.clear();
    S = null;
    byId.forEach((rec) => { if (rec.local) { URL.revokeObjectURL(rec.local.thumb); URL.revokeObjectURL(rec.local.full); } });
    byId.clear();
    Object.keys(signed).forEach((k) => delete signed[k]);
    msgsEl.textContent = '';
    msgsEl.classList.remove('loaded');
    newestMs = null;
    oldest = null;
    atStart = false;
    outbox = [];
    closeMenus();
    showGate(msg);
  }

  $('gateForm').onsubmit = async (e) => {
    e.preventDefault();
    const code = $('code').value.trim();
    const who = (document.querySelector('input[name=who]:checked') || {}).value;
    const err = (t) => { $('gateErr').textContent = t; };
    if (!code) return err('Please enter the access code.');
    if (!who) return err('Please choose Person A or Person B.');
    const btn = $('enter');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    err('');
    try {
      if (!anon || anon.exp - Date.now() < 120e3) anon = tokens(await call('/auth/v1/signup', json({})));
      const r = await call('/rest/v1/rpc/join_room', json({ p_code: code, p_participant: who }), anon.at);
      if (r && r.room_id) {
        S = Object.assign({}, anon, { room: r.room_id, me: who });
        anon = null;
        saveSession();
        $('code').value = '';
        openChat();
      } else {
        err(r && r.error === 'rate_limited'
          ? 'Too many attempts. Please wait 15 minutes and try again.'
          : 'The access code is incorrect.');
      }
    } catch (ex) {
      if (!isNet(ex)) console.warn('Access failed with HTTP', ex.status, '— see README "Troubleshooting".');
      err(isNet(ex) ? 'No connection. Please check your internet and try again.' : 'Something went wrong. Please try again.');
    }
    btn.disabled = false;
    btn.textContent = 'Enter chat';
  };

  // ---------- composer & menus ----------

  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, 140) + 'px';
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
  });
  $('composer').onsubmit = (e) => { e.preventDefault(); sendText(); input.focus(); };

  function closeMenus() {
    $('menu').hidden = true;
    $('plusMenu').hidden = true;
    $('menuBtn').setAttribute('aria-expanded', 'false');
    $('plus').setAttribute('aria-expanded', 'false');
  }
  function toggle(btn, menu) {
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }
  $('menuBtn').onclick = (e) => { e.stopPropagation(); toggle($('menuBtn'), $('menu')); };
  $('plus').onclick = (e) => { e.stopPropagation(); toggle($('plus'), $('plusMenu')); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.pop')) closeMenus(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenus(); $('viewer').hidden = true; }
  });

  $('photoBtn').onclick = () => { closeMenus(); $('file').click(); };
  $('file').onchange = () => {
    const f = $('file').files[0];
    $('file').value = '';
    if (f) sendPhoto(f);
  };

  $('clearBtn').onclick = () => {
    if (confirm('Clear this device’s session? You will need the access code to enter again.')) wipe();
  };

  $('leaveBtn').onclick = async () => {
    if (!confirm('Leave the chat on this device? You will need the access code to enter again.')) return;
    closeMenus();
    status('Leaving…');
    const room = S.room;
    // Best effort: revoke this device's access on the server, then forget everything locally.
    const timeout = new Promise((res) => setTimeout(res, 5000));
    try {
      const at = await Promise.race([token(), timeout]);
      if (at) {
        await Promise.race([
          call('/rest/v1/rpc/leave_room', json({ p_room: room }), at)
            .then(() => call('/auth/v1/logout', { method: 'POST' }, at)),
          timeout,
        ]);
      }
    } catch (e) { /* offline: local data is still cleared */ }
    wipe();
  };

  // ---------- start ----------

  if (S && S.room && S.rt) openChat(); else { S = null; showGate(); }

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => { navigator.serviceWorker.register('service-worker.js').catch(() => {}); });
  }
})();
