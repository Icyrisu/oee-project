/* =====================================================================
   OEE Monitoring HMI — Tahap 1 (Vanilla JS, tanpa dependensi)
   - SPA 3 layar (Dashboard / Report / Setting) via pergantian kelas CSS
   - Live data via WebSocket /ws dari mock backend FastAPI
   - Numpad sentuh untuk Setting
   - Dev State Switcher untuk menguji 10 tampilan visual PDF
   ===================================================================== */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Konfigurasi
  // ------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const API_BASE = (params.get('api') ||
    (location.protocol.startsWith('http') ? location.origin : 'http://localhost:8000')).replace(/\/$/, '');
  const WS_URL = API_BASE.replace(/^http/, 'ws') + '/ws';

  const LINES = [1, 2];
  const STATUS_LABEL = { RUNNING: 'Running', STOP: 'Stop', IDLE: 'Idle' };
  const STATUS_CLASS = { RUNNING: 'is-running', STOP: 'is-stop', IDLE: 'is-idle' };
  const STATUS_CYCLE = ['RUNNING', 'STOP', 'IDLE'];
  const DONUT_C = 2 * Math.PI * 48;          // keliling lingkaran donut (r = 48)
  const WS_STALE_MS = 4000;                   // tanpa pesan > 4 dtk = dianggap putus
  const REFERENCE_SESSION_ID = 1;             // sesi acuan PDF (01-01-2026 07:00:00)
  const NUMPAD_MAX_DIGITS = 5;
  const FIELD_META = {
    target:      { title: 'Quantity Target',  unit: 'pcs', isTime: false, min: 1, max: 9999 },
    cycle_time:  { title: 'Ideal Cycle Time', unit: 's',   isTime: false, min: 1, max: 9999 },
    run_seconds: { title: 'Production Time',  unit: 'min', isTime: true,  min: 0, max: 9999 },
  };

  // ------------------------------------------------------------------
  // State UI
  // ------------------------------------------------------------------
  const ui = {
    screen: 'dashboard',
    live: null,              // snapshot terakhir dari backend
    wsConnected: false,
    sessionBusy: false,
    report: { sessions: [], selectedId: null, view: 'summary', page: 0, listOpen: false },
    numpad: null,            // { line, field, value, fresh }
    devOpen: false,
    devCurrent: null,
  };

  // ------------------------------------------------------------------
  // Helper
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const fmt1 = (v) => (Math.round((Number(v) || 0) * 10) / 10).toFixed(1);
  const fmtDonut = (v) => (!v ? '0%' : fmt1(v).replace('.', ',') + '%');
  const fmtDuration = (sec) => {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
  };
  const findLine = (data, id) => (data && Array.isArray(data.lines) ? data.lines.find((l) => l.id === id) : null);

  function setText(el, text) {
    if (el && el.textContent !== text) { el.textContent = text; return true; }
    return false;
  }

  let toastTimer = null;
  function toast(msg, type = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast show ${type}`.trim();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
  }

  // ------------------------------------------------------------------
  // REST API
  // ------------------------------------------------------------------
  async function api(path, options = {}) {
    const res = await fetch(API_BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (typeof body.detail === 'string') msg = body.detail;
      } catch (_) { /* abaikan */ }
      throw new Error(msg);
    }
    return res.json();
  }
  const post = (path, body) => api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });

  function applyLive(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.lines)) return;
    ui.live = snapshot;
    renderDashboard();
    renderSetting();
  }

  // ------------------------------------------------------------------
  // WebSocket (auto-reconnect + watchdog)
  // ------------------------------------------------------------------
  let ws = null;
  let wsRetry = 0;
  let wsRetryTimer = null;
  let wsLastMsg = 0;

  function connectWS() {
    clearTimeout(wsRetryTimer);
    try {
      ws = new WebSocket(WS_URL);
    } catch (_) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      wsRetry = 0;
      wsLastMsg = Date.now();
      ui.wsConnected = true;
      renderDashboard();
    };
    ws.onmessage = (ev) => {
      wsLastMsg = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'state') applyLive(msg);
    };
    ws.onclose = () => {
      ws = null;
      if (ui.wsConnected) { ui.wsConnected = false; renderDashboard(); }
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws && ws.close(); } catch (_) { /* abaikan */ } };
  }

  function scheduleReconnect() {
    wsRetry = Math.min(wsRetry + 1, 5);
    wsRetryTimer = setTimeout(connectWS, 1000 * wsRetry);
  }

  setInterval(() => {
    if (ui.wsConnected && ws && Date.now() - wsLastMsg > WS_STALE_MS) ws.close();
  }, 1000);

  // ------------------------------------------------------------------
  // Navigasi SPA
  // ------------------------------------------------------------------
  function showScreen(name) {
    ui.screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
    $$('.nav-btn').forEach((b) => {
      const on = b.dataset.target === name;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    closeSessionList();
    if (name === 'report' && !ui.report.sessions.length) loadSessions();
  }

  // ------------------------------------------------------------------
  // Layar 1 — Dashboard
  // ------------------------------------------------------------------
  function renderDashboard() {
    const d = ui.live;
    const linked = ui.wsConnected && !!d;
    const online = linked && d.is_online;
    const active = linked && d.session_active;

    // Pill sesi: STOP (merah) saat aktif, START (biru) saat idle
    const btn = $('btn-session-toggle');
    setText(btn, active ? 'STOP' : 'START');
    btn.classList.toggle('pill-red', active);
    btn.classList.toggle('pill-blue', !active);
    btn.disabled = !linked || ui.sessionBusy;

    // Pill koneksi
    const conn = $('badge-connection');
    setText(conn, online ? 'ONLINE' : 'OFFLINE');
    conn.classList.toggle('pill-green', online);
    conn.classList.toggle('pill-red', !online);

    LINES.forEach((id) => {
      const line = findLine(d, id);
      const status = linked && line ? line.status : 'IDLE';
      const temp = line ? fmt1(line.temp_c) : '--.-';

      const card = $(`card-status-${id}`);
      const cls = `status-card ${STATUS_CLASS[status] || 'is-idle'}`;
      if (card.className !== cls) card.className = cls;

      setText($(`status-text-${id}`), `${STATUS_LABEL[status] || 'Idle'} - ${temp} °C`);

      const oee = active && line ? clamp(Number(line.oee) || 0, 0, 100) : 0;
      setText($(`oee-value-${id}`), `${fmt1(oee)}%`);
      $(`progress-${id}`).style.width = `${oee}%`;

      const hasCount = active && line && (line.good + line.reject) > 0;
      setText($(`good-${id}`), hasCount ? `${line.good}/${line.target}` : '-/-');
      setText($(`reject-${id}`), hasCount ? String(line.reject) : '-');
    });
  }

  async function toggleSession() {
    if (ui.sessionBusy) return;
    ui.sessionBusy = true;
    renderDashboard();
    try {
      applyLive(await post('/api/session/toggle'));
      const active = ui.live.session_active;
      toast(active ? 'Session started' : 'Session stopped & saved', 'success');
      if (!active) ui.report.sessions = [];   // paksa muat ulang daftar sesi
    } catch (_) {
      toast('Backend offline', 'error');
    } finally {
      ui.sessionBusy = false;
      renderDashboard();
    }
  }

  // ------------------------------------------------------------------
  // Layar 2 — Report
  // ------------------------------------------------------------------
  const selectedSession = () => ui.report.sessions.find((s) => s.id === ui.report.selectedId) || null;

  async function loadSessions() {
    try {
      const data = await api('/api/sessions');
      ui.report.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    } catch (_) {
      toast('Failed to load sessions — backend offline', 'error');
    }
    if (ui.report.selectedId != null && !selectedSession()) ui.report.selectedId = null;
    renderSessionList();
    renderReport();
    return ui.report.sessions;
  }

  function renderReport() {
    const r = ui.report;
    const s = selectedSession();
    const detail = r.view === 'detail';

    setText($('session-label'), s ? s.label : 'Select Session Data');
    $('btn-report-back').classList.toggle('hidden', !detail);
    $('report-actions').classList.toggle('hidden', detail);
    $('report-summary').classList.toggle('hidden', detail);
    $('report-detail').classList.toggle('hidden', !detail);

    LINES.forEach((id) => {
      const ln = findLine(s, id);
      const v = ln ? clamp(Number(ln.oee) || 0, 0, 100) : 0;
      const arc = $(`donut-arc-${id}`);
      arc.style.strokeDashoffset = String(DONUT_C * (1 - v / 100));
      arc.classList.toggle('empty', v === 0);
      setText($(`donut-label-${id}`), fmtDonut(v));
    });

    if (detail) renderDetail(s);
  }

  function renderDetail(s) {
    const page = ui.report.page;
    LINES.forEach((id) => {
      const ln = findLine(s, id) || {};
      const rows = page === 0
        ? [
            [`OEE Line ${id}`, `${fmt1(ln.oee)}%`, 'text-blue'],
            ['Good Product', String(ln.good ?? 0), 'text-blue'],
            ['Reject Product', String(ln.reject ?? 0), 'text-red'],
          ]
        : [
            [`Availability Line ${id}`, `${fmt1(ln.availability)}%`, 'text-blue'],
            [`Performance Line ${id}`, `${fmt1(ln.performance)}%`, 'text-blue'],
            [`Quality Line ${id}`, `${fmt1(ln.quality)}%`, 'text-blue'],
          ];
      rows.forEach(([label, value, cls], i) => {
        setText($(`d${id}-l${i}`), label);
        const v = $(`d${id}-v${i}`);
        setText(v, value);
        v.className = `row-value ${cls}`;
      });
    });
    $$('.pager .dot').forEach((dot) => {
      const on = Number(dot.dataset.page) === page;
      dot.classList.toggle('active', on);
      dot.setAttribute('aria-selected', String(on));
    });
  }

  function setDetailPage(page) {
    const p = clamp(page, 0, 1);
    if (p === ui.report.page) return;
    ui.report.page = p;
    renderReport();
  }

  function renderSessionList() {
    const box = $('session-items');
    box.textContent = '';
    if (!ui.report.sessions.length) {
      const empty = document.createElement('p');
      empty.className = 'session-empty';
      empty.textContent = 'No session data';
      box.appendChild(empty);
      return;
    }
    ui.report.sessions.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = `session-item-${s.id}`;
      b.className = 'session-item' + (s.id === ui.report.selectedId ? ' selected' : '');
      b.dataset.id = String(s.id);
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(s.id === ui.report.selectedId));

      const name = document.createElement('span');
      name.textContent = s.label;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `L1 ${fmt1(findLine(s, 1)?.oee)}% · L2 ${fmt1(findLine(s, 2)?.oee)}%`;

      b.append(name, meta);
      box.appendChild(b);
    });
  }

  function openSessionList() {
    ui.report.listOpen = true;
    $('session-list').classList.remove('hidden');
    $('btn-session-select').setAttribute('aria-expanded', 'true');
    renderSessionList();
    loadSessions();
  }
  function closeSessionList() {
    if (!ui.report.listOpen) return;
    ui.report.listOpen = false;
    $('session-list').classList.add('hidden');
    $('btn-session-select').setAttribute('aria-expanded', 'false');
  }

  function selectSession(id) {
    ui.report.selectedId = id;
    ui.report.page = 0;
    closeSessionList();
    renderReport();
  }

  function requireSession() {
    const s = selectedSession();
    if (s) return s;
    toast('Select a session first');
    return null;
  }

  function exportSession(s) {
    const rows = [
      ['Session', s.label],
      ['Started', s.started_at || ''],
      ['Ended', s.ended_at || ''],
      [],
      ['Line', 'OEE (%)', 'Availability (%)', 'Performance (%)', 'Quality (%)', 'Good (pcs)', 'Reject (pcs)', 'Production Time'],
    ];
    (s.lines || []).forEach((l) => rows.push([
      `Line ${l.id}`, fmt1(l.oee), fmt1(l.availability), fmt1(l.performance), fmt1(l.quality),
      l.good, l.reject, fmtDuration(l.run_seconds),
    ]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `OEE_${s.label.replace(/[^0-9A-Za-z]+/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Session data exported (CSV)', 'success');
  }

  // ------------------------------------------------------------------
  // Layar 3 — Setting
  // ------------------------------------------------------------------
  function renderSetting() {
    LINES.forEach((id) => {
      const line = findLine(ui.live, id);
      setText($(`val-target-${id}`), line ? String(line.target) : '-');
      setText($(`val-cycle-${id}`), line ? String(line.cycle_time) : '-');
      setText($(`val-runtime-${id}`), fmtDuration(line ? line.run_seconds : 0));
    });
  }

  // ------------------------------------------------------------------
  // Numpad Modal
  // ------------------------------------------------------------------
  function openNumpad(line, field) {
    const ln = findLine(ui.live, line);
    if (!ln || !ui.wsConnected) { toast('Backend offline — cannot edit', 'error'); return; }
    const meta = FIELD_META[field];
    if (!meta) return;
    const rawVal = ln[field];
    const initialVal = meta.isTime ? Math.floor((Number(rawVal) || 0) / 60) : (rawVal ?? 0);
    ui.numpad = { line, field, value: String(initialVal), fresh: true };
    setText($('numpad-sub'), `Production Line ${line}`);
    setText($('numpad-title'), meta.title);
    setText($('numpad-unit'), meta.unit);
    renderNumpad();
    $('numpad-overlay').classList.remove('hidden');
  }

  function closeNumpad() {
    ui.numpad = null;
    $('numpad-overlay').classList.add('hidden');
  }

  function renderNumpad() {
    const n = ui.numpad;
    const el = $('numpad-value');
    setText(el, n.value || '0');
    el.classList.toggle('fresh', n.fresh || !n.value);
  }

  function numpadKey(key) {
    const n = ui.numpad;
    if (!n) return;
    if (/^\d$/.test(key)) {
      if (n.fresh) { n.value = ''; n.fresh = false; }   // ketikan pertama menimpa nilai lama
      if (n.value.length >= NUMPAD_MAX_DIGITS) { return; }
      n.value = n.value === '0' ? key : n.value + key;
    } else if (key === 'clear') {
      n.value = ''; n.fresh = false;
    } else if (key === 'back') {
      n.value = n.fresh ? '' : n.value.slice(0, -1); n.fresh = false;
    } else if (key === 'cancel') {
      closeNumpad(); return;
    } else if (key === 'ok') {
      submitNumpad(); return;
    }
    renderNumpad();
  }

  async function submitNumpad() {
    const n = ui.numpad;
    if (!n) return;
    const meta = FIELD_META[n.field];
    const num = parseInt(n.value, 10);
    if (isNaN(num) || num < meta.min || num > meta.max) {
      toast(`Value must be ${meta.min} – ${meta.max}`, 'error');
      return;
    }
    const okBtn = $('key-ok');
    okBtn.disabled = true;
    try {
      const payloadVal = meta.isTime ? num * 60 : num;
      applyLive(await put(`/api/settings/${n.line}`, { [n.field]: payloadVal }));
      toast(`${meta.title} Line ${n.line} saved`, 'success');
      closeNumpad();
    } catch (e) {
      toast(`Save failed: ${e.message}`, 'error');
    } finally {
      okBtn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Dev State Switcher (10 tampilan visual PDF)
  // ------------------------------------------------------------------
  const DEV_STATES = [
    { n: 1,  label: 'Both Running',          color: 'c-green', run: () => devScenario('both_running') },
    { n: 2,  label: 'L1 Running · L2 Stop',  color: 'c-mixed', run: () => devScenario('line2_stop') },
    { n: 3,  label: 'Both Stop',             color: 'c-red',   run: () => devScenario('both_stop') },
    { n: 4,  label: 'Offline · Idle',        color: 'c-blue',  run: () => devScenario('idle_offline') },
    { n: 5,  label: 'Start Session 0.0%',    color: 'c-green', run: () => devScenario('start_session') },
    { n: 6,  label: 'Report · No Session',   color: '',        run: () => devReport(false, 'summary', 0) },
    { n: 7,  label: 'Report · Session Picked', color: '',      run: () => devReport(true, 'summary', 0) },
    { n: 8,  label: 'Detail · Product',      color: '',        run: () => devReport(true, 'detail', 0) },
    { n: 9,  label: 'Detail · A / P / Q',    color: '',        run: () => devReport(true, 'detail', 1) },
    { n: 10, label: 'System Setting',        color: '',        run: () => showScreen('setting') },
  ];

  function buildDevPanel() {
    const grid = $('dev-grid');
    DEV_STATES.forEach((st) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dev-btn';
      b.id = `dev-state-${st.n}`;
      b.dataset.state = String(st.n);
      const num = document.createElement('span');
      num.className = `dev-num ${st.color}`.trim();
      num.textContent = String(st.n);
      const label = document.createElement('span');
      label.textContent = st.label;
      b.append(num, label);
      grid.appendChild(b);
    });
  }

  function toggleDev(force) {
    ui.devOpen = typeof force === 'boolean' ? force : !ui.devOpen;
    $('dev-overlay').classList.toggle('hidden', !ui.devOpen);
  }

  function runDevState(n) {
    const st = DEV_STATES.find((s) => s.n === n);
    if (!st) return;
    ui.devCurrent = n;
    $$('.dev-btn[data-state]').forEach((b) => b.classList.toggle('current', Number(b.dataset.state) === n));
    toggleDev(false);
    st.run();
  }

  async function devScenario(name) {
    showScreen('dashboard');
    try {
      applyLive(await post('/api/mock/toggle-state', { scenario: name }));
    } catch (_) {
      toast('Backend offline — run backend/mock_server.py', 'error');
    }
  }

  async function devReport(pick, view, page) {
    showScreen('report');
    if (pick && !ui.report.sessions.length) await loadSessions();
    const ref = ui.report.sessions.find((s) => s.id === REFERENCE_SESSION_ID) || ui.report.sessions[0];
    ui.report.selectedId = pick && ref ? ref.id : null;
    ui.report.view = ui.report.selectedId != null ? view : 'summary';
    ui.report.page = page;
    renderReport();
  }

  async function devToggle(body) {
    try {
      applyLive(await post('/api/mock/toggle-state', body));
    } catch (_) {
      toast('Backend offline — run backend/mock_server.py', 'error');
    }
  }

  // ------------------------------------------------------------------
  // Event binding
  // ------------------------------------------------------------------
  function bindEvents() {
    // Sidebar
    $$('.nav-btn').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.target)));

    // Dashboard
    $('btn-session-toggle').addEventListener('click', toggleSession);

    // Report
    $('btn-session-select').addEventListener('click', () => (ui.report.listOpen ? closeSessionList() : openSessionList()));
    $('session-items').addEventListener('click', (e) => {
      const item = e.target.closest('.session-item');
      if (item) selectSession(Number(item.dataset.id));
    });
    $('screen-report').addEventListener('pointerdown', (e) => {
      if (ui.report.listOpen && !e.target.closest('#session-list, #btn-session-select')) closeSessionList();
    });
    $('btn-detail').addEventListener('click', () => {
      ui.report.view = 'detail';
      ui.report.page = 0;
      renderReport();
    });
    $('btn-export').addEventListener('click', () => {
      const s = requireSession();
      if (s) exportSession(s);
    });
    $('btn-report-back').addEventListener('click', () => {
      ui.report.view = 'summary';
      renderReport();
    });
    $$('.pager .dot').forEach((dot) => dot.addEventListener('click', () => setDetailPage(Number(dot.dataset.page))));

    // Detail: tap card berganti halaman (Product <-> Avi/Per/Qu)
    $('detail-cards').addEventListener('click', () => {
      setDetailPage(ui.report.page === 0 ? 1 : 0);
    });

    // Setting → Numpad
    $$('.setting-row.editable').forEach((row) => row.addEventListener('click', () => {
      openNumpad(Number(row.dataset.line), row.dataset.field);
    }));
    $('numpad-grid').addEventListener('click', (e) => {
      const key = e.target.closest('.key');
      if (key && !key.disabled) numpadKey(key.dataset.key);
    });
    $('numpad-overlay').addEventListener('pointerdown', (e) => {
      if (e.target.id === 'numpad-overlay') closeNumpad();   // tap di luar modal = batal
    });

    // Dev panel
    $('dev-grid').addEventListener('click', (e) => {
      const b = e.target.closest('.dev-btn[data-state]');
      if (b) runDevState(Number(b.dataset.state));
    });
    $('dev-close').addEventListener('click', () => toggleDev(false));
    $('dev-overlay').addEventListener('pointerdown', (e) => {
      if (e.target.id === 'dev-overlay') toggleDev(false);
    });
    $('dev-conn').addEventListener('click', () => {
      devToggle({ connection: ui.live && ui.live.is_online ? 'OFFLINE' : 'ONLINE' });
    });
    LINES.forEach((id) => $(`dev-line-${id}`).addEventListener('click', () => {
      const cur = findLine(ui.live, id)?.status || 'IDLE';
      const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(cur) + 1) % STATUS_CYCLE.length];
      devToggle({ line_id: id, status: next });
    }));

    $('dev-fullscreen').addEventListener('click', toggleFullscreen);

    // Double-click judul layar = toggle fullscreen
    $$('.title').forEach((el) => {
      el.addEventListener('dblclick', toggleFullscreen);
      let timer = null;
      const cancel = () => clearTimeout(timer);
      el.addEventListener('pointerdown', () => { timer = setTimeout(() => toggleDev(true), 800); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, cancel));
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (ui.numpad) {
        const map = { Enter: 'ok', Escape: 'cancel', Backspace: 'back', Delete: 'clear' };
        if (/^\d$/.test(e.key)) numpadKey(e.key);
        else if (map[e.key]) numpadKey(map[e.key]);
        else return;
        e.preventDefault();
        return;
      }
      if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
      if (e.key === 'd' || e.key === 'D') { toggleDev(); return; }
      if (e.key === 'Escape') { toggleDev(false); closeSessionList(); return; }
      if (/^\d$/.test(e.key)) runDevState(e.key === '0' ? 10 : Number(e.key));
    });

    // Kiosk: cegah menu konteks saat tekan-tahan
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ------------------------------------------------------------------
  // Auto Fullscreen & Viewport Fit
  // ------------------------------------------------------------------
  function updateLayoutScale() {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (!vw || !vh) return;

    const baseAspect = 480 / 320; // 1.5
    const windowAspect = vw / vh;

    let scale, baseWidth, baseHeight;

    if (windowAspect >= baseAspect) {
      scale = vh / 320;
      baseWidth = Math.max(480, Math.round(vw / scale));
      baseHeight = 320;
    } else {
      scale = vw / 480;
      baseWidth = 480;
      baseHeight = Math.max(320, Math.round(vh / scale));
    }

    document.documentElement.style.setProperty('--app-scale', scale);
    document.documentElement.style.setProperty('--app-width', `${baseWidth}px`);
    document.documentElement.style.setProperty('--app-height', `${baseHeight}px`);
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  function init() {
    updateLayoutScale();
    window.addEventListener('resize', updateLayoutScale);
    window.addEventListener('orientationchange', updateLayoutScale);
    document.addEventListener('fullscreenchange', updateLayoutScale);
    buildDevPanel();
    bindEvents();
    renderDashboard();
    renderSetting();
    renderReport();
    connectWS();
  }

  init();
})();
