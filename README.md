# OEE Monitoring — Raspberry Pi HMI 480×320

Ini antarmuka web (SPA) untuk memantau OEE dua line produksi di layar sentuh 3.5" Raspberry Pi (landscape **480 × 320**).

> **Status: Tahap 1** — Frontend + Mock Backend (in-memory).
> Belum ada SQLite, belum ada serial ESP32, belum ada firmware (semuanya masuk Tahap 2).

## Struktur

```
oee-project/
├── frontend/
│   ├── index.html      # SPA: Dashboard, Report, Setting, Numpad, Dev Switcher
│   ├── styles.css      # Kanvas fixed 480x320, palet eksak PDF
│   └── app.js          # Vanilla JS: navigasi, WebSocket, numpad
└── backend/
    ├── mock_server.py  # FastAPI in-memory + simulator asyncio 1 dtk
    └── requirements.txt
```

Seluruh ikon berupa **SVG inline** (sprite `<symbol>`). Tidak ada framework, font eksternal, atau CDN, jadi tetap jalan offline di Pi.

## Menjalankan

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r backend\requirements.txt     # Linux/Pi: .venv/bin/pip
.\.venv\Scripts\python backend\mock_server.py               # Linux/Pi: .venv/bin/python
```

Lalu buka **http://localhost:8000**. Backend juga menyajikan frontend dari origin yang sama.

Variabel opsional: `OEE_HOST` (default `0.0.0.0`), `OEE_PORT` (default `8000`).
Kalau frontend dibuka dari origin lain, tambahkan `?api=http://<host>:8000`.

Mode kiosk di Pi (contoh):

```bash
chromium-browser --kiosk --window-size=480,320 --noerrdialogs --disable-pinch http://localhost:8000
```

## Dev State Switcher (uji 10 tampilan PDF)

Cara membuka: tekan **`D`** di keyboard, atau **tekan-tahan judul layar ±0.8 detik** di layar sentuh.
Shortcut langsung: **`1`–`9`, `0`**.

| # | Tampilan | # | Tampilan |
|---|----------|---|----------|
| 1 | Both Running | 6 | Report — belum pilih sesi |
| 2 | Line 1 Running, Line 2 Stop | 7 | Report — sesi terpilih |
| 3 | Both Stop | 8 | Detail Data — Produk |
| 4 | Offline / Idle | 9 | Detail Data — A/P/Q |
| 5 | Start Sesi Running 0.0% | 10 | System Setting |

Panel ini juga punya tombol untuk mengganti ONLINE/OFFLINE dan mengganti status per line.

## API Mock

| Method | Path | Fungsi |
|--------|------|--------|
| WS | `/ws` | Broadcast snapshot state tiap 1 detik |
| GET | `/api/state` | Snapshot state saat ini |
| POST | `/api/session/toggle` | START ↔ STOP sesi (sesi yang dihentikan masuk ke daftar Report) |
| POST | `/api/mock/toggle-state` | `{scenario}` atau `{line_id?, status}` / `{connection}` |
| GET | `/api/sessions` | Daftar sesi mock |
| PUT | `/api/settings/{line_id}` | `{target?, cycle_time?}` (1–9999) |

Nilai `scenario` yang tersedia: `both_running`, `line2_stop`, `both_stop`, `idle_offline`, `start_session`.

## Catatan

- Mock memproduksi barang secara acak dengan kecepatan ±90% dari ideal (`1 / cycle_time`). Dengan cycle time default 60 detik, counter naik pelan. Kalau mau demo lebih cepat, set Ideal Cycle Time ke 2–5 detik lewat numpad.
- Data contoh di Report (sesi `01-01-2026 07:00:00`) memakai angka literal dari spesifikasi.
