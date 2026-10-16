/* =====================================================================
   OEE Monitoring HMI (Vanilla JS, zero external dependencies)
   - 3-Screen SPA (Dashboard / Report / Setting)
   - Real-time live data via WebSocket /ws from FastAPI backend
   - Touch Virtual Numpad for Settings
   - Production session lifecycle with End Session confirmation modal
   - Delete Session with confirmation modal
   - 3-Page Report Detail (Counts, OEE Metrics, Chart.js Visuals)
   - Offline Excel (.xlsx) detailed export with SheetJS
   - Interrupted session recovery modal
   ===================================================================== */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const API_BASE = (params.get('api') ||
    (location.protocol.startsWith('http') ? location.origin : 'http://localhost:8000')).replace(/\/$/, '');
  const WS_URL = API_BASE.replace(/^http/, 'ws') + '/ws';

  const LINES = [1, 2];
  const STATUS_LABEL = { RUNNING: 'Running', STOP: 'Stop', IDLE: 'Idle' };
  const STATUS_CLASS = { RUNNING: 'is-running', STOP: 'is-stop', IDLE: 'is-idle' };
  const DONUT_C = 2 * Math.PI * 48;          // donut circle circumference (r = 48)
  const WS_STALE_MS = 4000;                   // no message > 4s = considered stale
  const NUMPAD_MAX_DIGITS = 5;
  const FIELD_META = {
    target:          { title: 'Quantity Target',  unit: 'pcs', isTime: false, min: 1, max: 9999 },
    cycle_time:      { title: 'Ideal Cycle Time', unit: 's',   isTime: false, min: 1, max: 9999 },
    planned_seconds: { title: 'Production Time',  unit: 's',   isTime: true,  min: 0, max: 864000 },
  };

  // ------------------------------------------------------------------
  // UI State
  // ------------------------------------------------------------------
  const ui = {
    screen: 'dashboard',
    live: null,              // latest snapshot from backend
    wsConnected: false,
    sessionBusy: false,
    report: { sessions: [], selectedId: null, view: 'summary', page: 0, listOpen: false },
    numpad: null,            // { line, field, value, fresh }
    devOpen: false,
    recoveryHandled: false,
  };

  let chartL1 = null;
  let chartL2 = null;

  // ------------------------------------------------------------------
  // Helpers
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
  // REST API Client
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
      } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }
  const post = (path, body) => api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });

  function checkRecovery(snap) {
    if (snap.recovery_pending && snap.recovery_session && !ui.recoveryHandled) {
      const rec = snap.recovery_session;
      setText($('rec-started'), rec.started_at ? rec.started_at.replace('T', ' ') : '-');
      setText($('rec-duration'), fmtDuration(rec.elapsed_sec || 0));
      setText($('rec-l1-good'), rec.l1_good || 0);
      setText($('rec-l1-reject'), rec.l1_reject || 0);
      setText($('rec-l2-good'), rec.l2_good || 0);
      setText($('rec-l2-reject'), rec.l2_reject || 0);
      $('recovery-overlay').classList.remove('hidden');
    } else {
      $('recovery-overlay').classList.add('hidden');
    }
    if ($('dev-hw-status')) {
      setText($('dev-hw-status'), snap.is_online ? 'ONLINE (Data Ingested)' : 'OFFLINE (No Data)');
    }
  }

  async function handleRecovery(action) {
    ui.recoveryHandled = true;
    $('recovery-overlay').classList.add('hidden');
    try {
      const res = await post('/api/session/recovery', { action });
      applyLive(res);
      toast(action === 'resume' ? 'Session resumed' : 'Previous session ended', 'success');
      if (action === 'end') loadSessions();
    } catch (e) {
      toast(`Failed to process session: ${e.message}`, 'error');
    }
  }

  function applyLive(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.lines)) return;
    ui.live = snapshot;
    renderDashboard();
    renderSetting();
    checkRecovery(snapshot);
  }

  // ------------------------------------------------------------------
  // WebSocket (Auto-reconnect & watchdog)
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
    ws.onerror = () => { try { ws && ws.close(); } catch (_) { /* ignore */ } };
  }

  function scheduleReconnect() {
    wsRetry = Math.min(wsRetry + 1, 5);
    wsRetryTimer = setTimeout(connectWS, 1000 * wsRetry);
  }

  setInterval(() => {
    if (ui.wsConnected && ws && Date.now() - wsLastMsg > WS_STALE_MS) ws.close();
  }, 1000);

  // ------------------------------------------------------------------
  // SPA Navigation
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
    if (name === 'info') renderInfo();
  }

  async function renderInfo() {
    const cur = $('info-current-url');
    const hs = $('info-hotspot-url');

    try {
      const net = await api('/api/network');
      if (cur) {
        if (net.lan_ip) {
          cur.textContent = `http://${net.lan_ip}:8000`;
          cur.className = 'info-val badge-green';
        } else {
          cur.textContent = 'Disconnected';
          cur.className = 'info-val badge-dark';
        }
      }
      if (hs && net.hotspot_ip) {
        hs.textContent = `http://${net.hotspot_ip}:8000`;
      }
    } catch (_) {
      if (cur && location.hostname && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' && location.hostname !== '10.42.0.1') {
        const port = location.port ? `:${location.port}` : '';
        cur.textContent = `http://${location.hostname}${port}`;
      }
    }
  }

  // ------------------------------------------------------------------
  // Screen 1 — Dashboard
  // ------------------------------------------------------------------
  function renderDashboard() {
    const d = ui.live;
    const linked = ui.wsConnected && !!d;
    const online = linked && d.is_online;
    const active = linked && d.session_active;

    // Session pill: END (red) when active, START (blue) when idle
    // Validation: Cannot START when machine is offline
    const btn = $('btn-session-toggle');
    setText(btn, active ? 'END' : 'START');
    btn.classList.toggle('pill-red', active);
    btn.classList.toggle('pill-blue', !active);
    btn.disabled = !linked || ui.sessionBusy || (!active && !online);
    if (!active && !online) {
      btn.title = 'Cannot start session while machine is offline';
    } else {
      btn.title = '';
    }

    // Connection pill
    const conn = $('badge-connection');
    setText(conn, online ? 'ONLINE' : 'OFFLINE');
    conn.classList.toggle('pill-green', online);
    conn.classList.toggle('pill-red', !online);

    LINES.forEach((id) => {
      const line = findLine(d, id);
      const status = linked && line ? line.status : 'IDLE';
      const hasTemp = online && line && line.temp_c != null;
      const tempText = hasTemp ? `${fmt1(line.temp_c)} °C` : '--.- °C';

      const card = $(`card-status-${id}`);
      const cls = `status-card ${STATUS_CLASS[status] || 'is-idle'}`;
      if (card.className !== cls) card.className = cls;

      setText($(`status-text-${id}`), `${STATUS_LABEL[status] || 'Idle'} - ${tempText}`);

      const oee = active && line ? clamp(Number(line.oee) || 0, 0, 100) : 0;
      setText($(`oee-value-${id}`), `${fmt1(oee)}%`);
      $(`progress-${id}`).style.width = `${oee}%`;

      const hasCount = active && line && (line.good + line.reject) > 0;
      setText($(`good-${id}`), hasCount ? `${line.good}/${line.target}` : '-/-');
      setText($(`reject-${id}`), hasCount ? String(line.reject) : '-');
    });
  }

  function onSessionToggleClick() {
    if (ui.sessionBusy || !ui.live) return;
    if (!ui.live.session_active && !ui.live.is_online) {
      toast('Cannot start session while machine is offline', 'error');
      return;
    }
    if (ui.live.session_active) {
      // Require confirmation before ending active session
      openEndConfirmation();
    } else {
      executeToggleSession();
    }
  }

  function openEndConfirmation() {
    $('confirm-overlay').classList.remove('hidden');
  }

  function closeEndConfirmation() {
    $('confirm-overlay').classList.add('hidden');
  }

  async function executeToggleSession() {
    if (ui.sessionBusy) return;
    ui.sessionBusy = true;
    renderDashboard();
    try {
      applyLive(await post('/api/session/toggle'));
      const active = ui.live.session_active;
      toast(active ? 'Session started' : 'Session ended & saved', 'success');
      if (!active) ui.report.sessions = [];   // force refresh session list
    } catch (e) {
      toast(e.message || 'Backend error', 'error');
    } finally {
      ui.sessionBusy = false;
      renderDashboard();
    }
  }

  // ------------------------------------------------------------------
  // Screen 2 — Report
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
    $('btn-report-delete').classList.toggle('hidden', !s || !detail);
    $('report-pager').classList.toggle('hidden', !detail);
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
    const showCharts = page === 2;

    $('detail-cards').classList.toggle('hidden', showCharts);
    $('detail-charts').classList.toggle('hidden', !showCharts);

    if (showCharts) {
      renderCharts(s);
    } else {
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
    }

    $$('#report-pager .dot').forEach((dot) => {
      const on = Number(dot.dataset.page) === page;
      dot.classList.toggle('active', on);
      dot.setAttribute('aria-selected', String(on));
    });
  }

  function renderCharts(s) {
    if (typeof Chart === 'undefined') return;
    const l1 = findLine(s, 1) || {};
    const l2 = findLine(s, 2) || {};
    chartL1 = createOrUpdateChart(chartL1, 'chart-line-1', l1);
    chartL2 = createOrUpdateChart(chartL2, 'chart-line-2', l2);
  }

  const barValuePlugin = {
    id: 'barValueLabels',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea } = chart;
      chart.data.datasets.forEach((dataset, i) => {
        const meta = chart.getDatasetMeta(i);
        meta.data.forEach((bar, index) => {
          const val = Number(dataset.data[index]) || 0;
          const text = `${val.toFixed(1)}%`;
          ctx.save();
          ctx.font = '600 11px Poppins, sans-serif';
          ctx.textBaseline = 'middle';
          const textWidth = ctx.measureText(text).width;
          if (bar.x > chartArea.left + textWidth + 14) {
            // Draw inside the bar in white
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'right';
            ctx.fillText(text, bar.x - 6, bar.y);
          } else {
            // Draw outside the bar in dark text
            ctx.fillStyle = '#111827';
            ctx.textAlign = 'left';
            ctx.fillText(text, Math.min(bar.x + 5, chartArea.right - textWidth - 2), bar.y);
          }
          ctx.restore();
        });
      });
    },
  };

  function createOrUpdateChart(chartInst, canvasId, line) {
    const canvas = $(canvasId);
    if (!canvas) return null;
    const data = [
      clamp(Number(line.availability) || 0, 0, 100),
      clamp(Number(line.performance) || 0, 0, 100),
      clamp(Number(line.quality) || 0, 0, 100),
      clamp(Number(line.oee) || 0, 0, 100),
    ];
    if (chartInst) {
      chartInst.data.datasets[0].data = data;
      chartInst.update();
      return chartInst;
    }
    const ctx = canvas.getContext('2d');
    return new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['Avail', 'Perf', 'Qual', 'OEE'],
        datasets: [{
          data,
          backgroundColor: ['#5279FD', '#10B981', '#F59E0B', '#8B5CF6'],
          borderRadius: 4,
          barThickness: 14,
        }],
      },
      plugins: [barValuePlugin],
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: Math.max(window.devicePixelRatio || 1, 2.5),
        animation: { duration: 200 },
        layout: {
          padding: { right: 8, left: 2, top: 4, bottom: 4 },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${ctx.raw.toFixed(1)}%`,
            },
          },
        },
        scales: {
          x: {
            min: 0,
            max: 100,
            ticks: {
              stepSize: 25,
              callback: (val) => `${val}%`,
              font: { size: 9, family: 'Poppins', weight: '500' },
              color: '#6B7280',
            },
            grid: { color: 'rgba(0,0,0,0.06)' },
          },
          y: {
            ticks: {
              font: { size: 11, weight: '700', family: 'Poppins' },
              color: '#111827',
            },
            grid: { display: false },
          },
        },
      },
    });
  }

  function setDetailPage(page) {
    const p = clamp(page, 0, 2);
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

  // ------------------------------------------------------------------
  // Session Deletion
  // ------------------------------------------------------------------
  function openDeleteConfirmation() {
    const s = selectedSession();
    if (!s) return;
    setText($('delete-session-label'), s.label || `#${s.id}`);
    $('delete-overlay').classList.remove('hidden');
  }

  function closeDeleteConfirmation() {
    $('delete-overlay').classList.add('hidden');
  }

  async function executeDeleteSession() {
    const s = selectedSession();
    if (!s) return;
    closeDeleteConfirmation();
    try {
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      toast('Session deleted successfully', 'success');
      ui.report.selectedId = null;
      ui.report.view = 'summary';
      await loadSessions();
    } catch (e) {
      toast(`Failed to delete session: ${e.message}`, 'error');
    }
  }

  // ------------------------------------------------------------------
  // System Power Off Modal
  // ------------------------------------------------------------------
  function openPowerOffConfirmation() {
    $('poweroff-overlay').classList.remove('hidden');
  }

  function closePowerOffConfirmation() {
    $('poweroff-overlay').classList.add('hidden');
  }

  async function executePowerOff() {
    setText($('poweroff-title'), 'Shutting Down...');
    setText($('poweroff-desc'), 'Closing database and turning off Raspberry Pi safely. Please wait until the green activity LED stops blinking before unplugging the power supply.');
    $('btn-poweroff-cancel').disabled = true;
    $('btn-poweroff-confirm').disabled = true;
    setText($('btn-poweroff-confirm'), 'SHUTTING DOWN...');

    try {
      await api('/api/system/poweroff', { method: 'POST' });
    } catch (_) {
      // Normal if network drops during OS shutdown
    }
  }

  // ------------------------------------------------------------------
  // Excel Export (.xlsx)
  // ------------------------------------------------------------------
  function exportSession(s) {
    const l1 = findLine(s, 1) || {};
    const l2 = findLine(s, 2) || {};
    const totalGood = (l1.good || 0) + (l2.good || 0);
    const totalReject = (l1.reject || 0) + (l2.reject || 0);
    const totalProd = totalGood + totalReject;
    const avgOee = fmt1(((Number(l1.oee) || 0) + (Number(l2.oee) || 0)) / 2);
    const cleanLabel = (s.label || 'session').replace(/[^0-9A-Za-z]+/g, '-');

    if (typeof XLSX !== 'undefined') {
      try {
        const wsData = [
          ['OEE PRODUCTION REPORT — SUMMARY & DETAILS'],
          [],
          ['SESSION INFORMATION'],
          ['Session ID', s.id],
          ['Session Label', s.label || '-'],
          ['Start Time', s.started_at ? s.started_at.replace('T', ' ') : '-'],
          ['End Time', s.ended_at ? s.ended_at.replace('T', ' ') : '-'],
          ['Total Elapsed Duration', fmtDuration(s.elapsed_sec || 0)],
          ['Exported At', new Date().toLocaleString()],
          [],
          ['PRODUCTION LINE COMPARISON'],
          [
            'Line Name', 'Target (pcs)', 'Good (pcs)', 'Reject (pcs)', 'Total (pcs)',
            'Ideal Cycle Time (s)', 'Planned Time', 'Actual Run Time', 'Downtime',
            'Availability (%)', 'Performance (%)', 'Quality (%)', 'Overall OEE (%)'
          ],
          [
            'Line 1', l1.target ?? '-', l1.good ?? 0, l1.reject ?? 0, (l1.good ?? 0) + (l1.reject ?? 0),
            l1.cycle_time ?? '-', fmtDuration(l1.planned_seconds ?? 0), fmtDuration(l1.run_seconds ?? 0),
            fmtDuration(Math.max(0, (s.elapsed_sec || 0) - (l1.run_seconds || 0))),
            `${fmt1(l1.availability)}%`, `${fmt1(l1.performance)}%`, `${fmt1(l1.quality)}%`, `${fmt1(l1.oee)}%`
          ],
          [
            'Line 2', l2.target ?? '-', l2.good ?? 0, l2.reject ?? 0, (l2.good ?? 0) + (l2.reject ?? 0),
            l2.cycle_time ?? '-', fmtDuration(l2.planned_seconds ?? 0), fmtDuration(l2.run_seconds ?? 0),
            fmtDuration(Math.max(0, (s.elapsed_sec || 0) - (l2.run_seconds || 0))),
            `${fmt1(l2.availability)}%`, `${fmt1(l2.performance)}%`, `${fmt1(l2.quality)}%`, `${fmt1(l2.oee)}%`
          ],
          [],
          ['PLANT TOTALS & AVERAGES'],
          ['Total Good Products', `${totalGood} pcs`],
          ['Total Reject Products', `${totalReject} pcs`],
          ['Overall Quality Rate', `${totalProd > 0 ? fmt1((totalGood / totalProd) * 100) : 0}%`],
          ['Plant Average OEE', `${avgOee}%`],
        ];

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        ws['!cols'] = [
          { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
          { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 16 },
          { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 18 }
        ];
        XLSX.utils.book_append_sheet(wb, ws, 'OEE Report');
        XLSX.writeFile(wb, `OEE_${cleanLabel}.xlsx`);
        toast('Session data exported (Excel .xlsx)', 'success');
        return;
      } catch (err) {
        console.warn('XLSX export failed, falling back to CSV', err);
      }
    }

    // Fallback CSV
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
    a.download = `OEE_${cleanLabel}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Session data exported', 'success');
  }

  // ------------------------------------------------------------------
  // Screen 3 — Setting
  // ------------------------------------------------------------------
  function renderSetting() {
    const isLocked = Boolean(ui.live?.session_active);
    $$('.setting-row.editable').forEach((row) => {
      row.classList.toggle('locked', isLocked);
    });
    const banner = $('setting-lock-banner');
    if (banner) banner.classList.toggle('hidden', !isLocked);

    LINES.forEach((id) => {
      const line = findLine(ui.live, id);
      setText($(`val-target-${id}`), line ? String(line.target) : '-');
      setText($(`val-cycle-${id}`), line ? String(line.cycle_time) : '-');
      setText($(`val-runtime-${id}`), fmtDuration(line ? (line.planned_seconds ?? 0) : 0));
    });
  }

  // ------------------------------------------------------------------
  // Touch Virtual Numpad Modal
  // ------------------------------------------------------------------
  function parseDurationSec(txt) {
    if (!txt) return 0;
    const m = String(txt).match(/(\d+)\s*h\s*(\d+)\s*m\s*(\d+)\s*s/i);
    if (m) {
      return (parseInt(m[1], 10) * 3600) + (parseInt(m[2], 10) * 60) + parseInt(m[3], 10);
    }
    return 0;
  }

  function openNumpad(line, field) {
    if (ui.live?.session_active) {
      toast('Settings are locked during an active session', 'error');
      return;
    }
    const meta = FIELD_META[field];
    if (!meta) return;
    const ln = findLine(ui.live, line);
    let rawVal = ln ? ln[field] : undefined;
    if (rawVal === undefined) {
      if (field === 'target') {
        const txt = $(`val-target-${line}`)?.textContent;
        rawVal = parseInt(txt, 10) || 10;
      } else if (field === 'cycle_time') {
        const txt = $(`val-cycle-${line}`)?.textContent;
        rawVal = parseInt(txt, 10) || 60;
      } else if (field === 'planned_seconds' || field === 'run_seconds') {
        const txt = $(`val-runtime-${line}`)?.textContent;
        rawVal = parseDurationSec(txt);
      } else {
        rawVal = 0;
      }
    }

    if (meta.isTime) {
      const totalSec = Number(rawVal) || 0;
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      ui.numpad = {
        line,
        field,
        isTime: true,
        activeSeg: 'h',
        time: { h: String(h), m: String(m), s: String(s) },
        fresh: true,
      };
    } else {
      ui.numpad = {
        line,
        field,
        isTime: false,
        value: String(Number(rawVal) || 0),
        fresh: true,
      };
    }

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
    if (!n) return;
    if (!n.isTime) {
      $('numpad-display').classList.remove('hidden');
      $('numpad-time-display').classList.add('hidden');
      const el = $('numpad-value');
      setText(el, n.value || '0');
      el.classList.toggle('fresh', n.fresh || !n.value);
    } else {
      $('numpad-display').classList.add('hidden');
      $('numpad-time-display').classList.remove('hidden');
      ['h', 'm', 's'].forEach((seg) => {
        const btn = $(`seg-${seg}`);
        const valEl = $(`seg-val-${seg}`);
        setText(valEl, n.time[seg] || '0');
        const isActive = n.activeSeg === seg;
        btn.classList.toggle('active', isActive);
        btn.classList.toggle('fresh', isActive && n.fresh);
      });
    }
  }

  function numpadKey(key) {
    const n = ui.numpad;
    if (!n) return;

    if (key === 'cancel') {
      closeNumpad();
      return;
    }
    if (key === 'save' || key === 'ok') {
      submitNumpad();
      return;
    }

    if (!n.isTime) {
      if (/^\d$/.test(key)) {
        if (n.fresh) { n.value = ''; n.fresh = false; }
        if (n.value.length >= NUMPAD_MAX_DIGITS) { return; }
        n.value = n.value === '0' ? key : n.value + key;
      } else if (key === 'clear') {
        n.value = '0';
        n.fresh = true;
      } else if (key === 'delete' || key === 'back') {
        if (n.fresh) {
          n.value = '0';
        } else {
          n.value = n.value.slice(0, -1);
          if (!n.value) n.value = '0';
        }
        n.fresh = false;
      }
    } else {
      const seg = n.activeSeg;
      const maxDigits = seg === 'h' ? 3 : 2;
      if (/^\d$/.test(key)) {
        let cur = n.fresh ? '' : n.time[seg];
        if (cur === '0') cur = '';
        if (cur.length < maxDigits) {
          let next = cur + key;
          if (seg !== 'h' && parseInt(next, 10) > 59) {
            next = '59';
          }
          n.time[seg] = next;
          n.fresh = false;
          // Auto-advance to seconds if 2 digits of minutes filled
          if (seg === 'm' && next.length === 2) {
            n.activeSeg = 's';
            n.fresh = true;
          }
        }
      } else if (key === 'clear') {
        n.time[seg] = '0';
        n.fresh = true;
      } else if (key === 'delete' || key === 'back') {
        if (n.fresh) {
          n.time[seg] = '0';
        } else {
          n.time[seg] = n.time[seg].slice(0, -1);
          if (!n.time[seg]) n.time[seg] = '0';
        }
        n.fresh = false;
      }
    }
    renderNumpad();
  }

  async function submitNumpad() {
    const n = ui.numpad;
    if (!n) return;
    const meta = FIELD_META[n.field];

    let payloadVal;
    if (!n.isTime) {
      const num = parseInt(n.value, 10);
      if (isNaN(num) || num < meta.min || num > meta.max) {
        toast(`Value must be between ${meta.min} and ${meta.max}`, 'error');
        return;
      }
      payloadVal = num;
    } else {
      const h = parseInt(n.time.h, 10) || 0;
      const m = parseInt(n.time.m, 10) || 0;
      const s = parseInt(n.time.s, 10) || 0;
      if (h < 0 || h > 240 || m < 0 || m > 59 || s < 0 || s > 59) {
        toast('Invalid time format (m and s must be 0-59)', 'error');
        return;
      }
      payloadVal = (h * 3600) + (m * 60) + s;
      if (payloadVal < meta.min || payloadVal > meta.max) {
        toast(`Total duration must be between ${meta.min} and ${meta.max} seconds`, 'error');
        return;
      }
    }

    if (!ui.wsConnected) {
      toast('Backend offline — settings cannot be saved', 'error');
      return;
    }
    const saveBtn = $('key-save') || $('key-ok');
    if (saveBtn) saveBtn.disabled = true;
    try {
      applyLive(await put(`/api/settings/${n.line}`, { [n.field]: payloadVal }));
      toast(`${meta.title} Line ${n.line} saved`, 'success');
      closeNumpad();
    } catch (e) {
      toast(`Failed to save: ${e.message}`, 'error');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // System Info & Display Modal
  // ------------------------------------------------------------------
  function toggleDev(force) {
    ui.devOpen = typeof force === 'boolean' ? force : !ui.devOpen;
    $('dev-overlay').classList.toggle('hidden', !ui.devOpen);
  }

  // ------------------------------------------------------------------
  // Event Binding
  // ------------------------------------------------------------------
  function bindEvents() {
    // Sidebar
    $$('.nav-btn').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.target)));

    // Dashboard — Session start / confirmation
    $('btn-session-toggle').addEventListener('click', onSessionToggleClick);

    // End Session Confirmation Modal
    $('btn-confirm-cancel').addEventListener('click', closeEndConfirmation);
    $('btn-confirm-end').addEventListener('click', () => {
      closeEndConfirmation();
      executeToggleSession();
    });
    $('confirm-overlay').addEventListener('pointerdown', (e) => {
      if (e.target.id === 'confirm-overlay') closeEndConfirmation();
    });

    // Delete Session Confirmation Modal
    $('btn-report-delete').addEventListener('click', openDeleteConfirmation);
    $('btn-delete-cancel').addEventListener('click', closeDeleteConfirmation);
    $('btn-delete-confirm').addEventListener('click', executeDeleteSession);
    $('delete-overlay').addEventListener('pointerdown', (e) => {
      if (e.target.id === 'delete-overlay') closeDeleteConfirmation();
    });

    // Power Off Confirmation Modal
    $('btn-open-poweroff').addEventListener('click', openPowerOffConfirmation);
    $('btn-poweroff-cancel').addEventListener('click', closePowerOffConfirmation);
    $('btn-poweroff-confirm').addEventListener('click', executePowerOff);
    $('poweroff-overlay').addEventListener('pointerdown', (e) => {
      if (e.target.id === 'poweroff-overlay') closePowerOffConfirmation();
    });

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

    // Pager dots directly under session select bar
    $$('#report-pager .dot').forEach((dot) => {
      dot.addEventListener('click', () => setDetailPage(Number(dot.dataset.page)));
    });

    // Detail: tap card or charts to cycle through pages 0 -> 1 -> 2 -> 0
    $('detail-cards').addEventListener('click', () => {
      setDetailPage((ui.report.page + 1) % 3);
    });
    $('detail-charts').addEventListener('click', () => {
      setDetailPage((ui.report.page + 1) % 3);
    });

    // Setting → Touch Virtual Numpad
    $$('.setting-row.editable').forEach((row) => row.addEventListener('click', () => {
      openNumpad(Number(row.dataset.line), row.dataset.field);
    }));
    ['h', 'm', 's'].forEach((seg) => {
      $(`seg-${seg}`).addEventListener('click', () => {
        if (ui.numpad && ui.numpad.isTime) {
          ui.numpad.activeSeg = seg;
          ui.numpad.fresh = true;
          renderNumpad();
        }
      });
    });
    $('numpad-grid').addEventListener('click', (e) => {
      const key = e.target.closest('.key');
      if (key && !key.disabled) numpadKey(key.dataset.key);
    });
    $('numpad-overlay').addEventListener('pointerdown', (e) => {
      if (e.target.id === 'numpad-overlay') closeNumpad();   // tap outside modal = cancel
    });

    // Recovery Modal buttons
    $('btn-recovery-resume').addEventListener('click', () => handleRecovery('resume'));
    $('btn-recovery-end').addEventListener('click', () => handleRecovery('end'));

    // System info panel
    $('dev-close').addEventListener('click', () => toggleDev(false));
    $('dev-overlay').addEventListener('pointerdown', (e) => {
      if (e.target.id === 'dev-overlay') toggleDev(false);
    });
    $('dev-fullscreen').addEventListener('click', toggleFullscreen);

    // Double-click title = toggle fullscreen; long-press = open system info
    $$('.title').forEach((el) => {
      el.addEventListener('dblclick', toggleFullscreen);
      let timer = null;
      const cancel = () => clearTimeout(timer);
      el.addEventListener('pointerdown', () => { timer = setTimeout(() => toggleDev(true), 800); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, cancel));
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (ui.numpad) {
        const map = { Enter: 'save', Escape: 'cancel', Backspace: 'delete', Delete: 'delete' };
        if (/^\d$/.test(e.key)) numpadKey(e.key);
        else if (map[e.key]) numpadKey(map[e.key]);
        else if (ui.numpad.isTime && (e.key === 'Tab' || e.key === 'ArrowRight')) {
          const order = ['h', 'm', 's'];
          ui.numpad.activeSeg = order[(order.indexOf(ui.numpad.activeSeg) + 1) % 3];
          ui.numpad.fresh = true;
          renderNumpad();
        } else if (ui.numpad.isTime && e.key === 'ArrowLeft') {
          const order = ['h', 'm', 's'];
          ui.numpad.activeSeg = order[(order.indexOf(ui.numpad.activeSeg) + 2) % 3];
          ui.numpad.fresh = true;
          renderNumpad();
        } else return;
        e.preventDefault();
        return;
      }
      if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
      if (e.key === 'd' || e.key === 'D') { toggleDev(); return; }
      if (e.key === 'Escape') {
        closeEndConfirmation();
        closeDeleteConfirmation();
        closePowerOffConfirmation();
        toggleDev(false);
        closeSessionList();
        return;
      }
    });

    // Kiosk: prevent context menu on long-press
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
    bindEvents();
    renderDashboard();
    renderSetting();
    renderReport();
    renderInfo();
    connectWS();
  }

  init();
})();
