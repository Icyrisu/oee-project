# OEE Monitoring — Raspberry Pi HMI (FastAPI + SQLite + SPA)

Aplikasi HMI pemantauan OEE (*Overall Equipment Effectiveness*) untuk 2 line produksi manufaktur pada layar sentuh Raspberry Pi (resolusi standar **480 × 320** atau auto-fit layar monitor).

Aplikasi berjalan secara lokal tanpa memerlukan koneksi internet, menggunakan **FastAPI** dengan database lokal **SQLite (WAL)**, antarmuka Single Page Application (**Vanilla HTML/CSS/JS**), serta siap dihubungkan ke **Node-RED** sebagai jembatan komunikasi serial ESP32.

---

## Arsitektur Sistem

```text
┌─────────────────┐       USB Serial (115200)       ┌────────────────────────┐
│  Hardware ESP32 │ ──────────────────────────────> │   Node-RED (Bridge)    │
│  (Sensor & PB)  │                                 │ Flow: Serial in ->     │
└─────────────────┘                                 │       HTTP Request     │
                                                    └───────────┬────────────┘
                                                                │ POST /api/ingest
                                                                ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Raspberry Pi — FastAPI Backend & SQLite WAL                                │
│                                                                            │
│  - Engine OEE & Sesi Produksi                                              │
│  - Database lokal: oee_local.db (Settings, Sesi, Log Status)               │
│  - Pemulihan otomatis jika mati listrik mendadak (Resume / Akhiri)         │
│  - WebSocket Server (/ws broadcast state tiap 1 detik)                     │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │ WebSocket /ws & REST
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ Chromium Kiosk — Frontend SPA                                              │
│ Dashboard Real-time · Report Riwayat Sesi · System Setting (Touch Numpad)  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Struktur Proyek

```text
oee-project/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── config.py         # Konfigurasi port, path DB, timeout link
│   │   ├── db.py             # SQLite WAL & inisialisasi skema tabel
│   │   ├── engine.py         # State runtime, logika sesi, checkpoint
│   │   ├── hub.py            # WebSocket client broadcaster
│   │   ├── oee.py            # Fungsi murni perhitungan A/P/Q/OEE
│   │   ├── repository.py     # Akses query SQL SQLite
│   │   ├── routes.py         # Endpoint REST API & WebSocket
│   │   └── schemas.py        # Validasi Pydantic
│   ├── run.py                # Entrypoint server (Uvicorn)
│   ├── requirements.txt      # Dependency produksi
│   └── requirements-dev.txt  # Dependency pengujian (pytest, httpx)
├── frontend/
│   ├── index.html            # SPA: Dashboard, Report, Setting, Modal Numpad & Recovery
│   ├── styles.css            # Desain responsif, touch-friendly, palet HMI
│   └── app.js                # State UI, navigasi, WebSocket client, kalkulator sentuh
├── tests/
│   ├── test_api.py           # Pengujian endpoint FastAPI
│   ├── test_engine.py        # Pengujian engine runtime & sesi
│   └── test_oee.py           # Pengujian rumus A/P/Q/OEE
├── tools/
│   └── fake_feeder.py        # Simulator data pengganti ESP32/Node-RED untuk testing
└── deploy/
    └── oee-backend.service   # Unit service systemd untuk autostart di Raspberry Pi
```

---

## Cara Menjalankan

### 1. Persiapan Virtual Environment

```bash
# Clone atau buka direktori proyek
cd oee-project

# Buat virtual environment
python -m venv .venv

# Aktifkan virtual environment
# Di Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# Di Raspberry Pi (Linux):
source .venv/bin/activate

# Install dependency
pip install -r backend/requirements.txt
```

### 2. Menjalankan Backend

```bash
python backend/run.py
```

Server berjalan pada port `8000`. Buka browser di **http://localhost:8000**.
*(Frontend disajikan langsung dari backend pada alamat yang sama)*.

### 3. Menjalankan Pengujian Otomatis

```bash
pip install -r backend/requirements-dev.txt
pytest tests -v
```

---

## Pengujian Tanpa Hardware (Fake Feeder)

Untuk menguji aplikasi tanpa perangkat keras ESP32 atau Node-RED, jalankan script `fake_feeder.py` di terminal terpisah:

```bash
python tools/fake_feeder.py
```

Opsi tambahan:
* `--l1-state RUNNING` / `STOP` / `IDLE` (mengatur status line 1)
* `--l2-state RUNNING` / `STOP` / `IDLE` (mengatur status line 2)
* `--emg1` (simulasikan tombol Emergency Stop line 1 ditekan)
* `--rate 0.5` (interval pengiriman dalam detik)

---

## Kontrak Integrasi Node-RED (`POST /api/ingest`)

Node-RED bertindak murni sebagai **bridge serial USB**:
1. Membaca paket serial NDJSON dari port USB ESP32 (`/dev/ttyUSB0` atau `/dev/ttyACM0`) pada baud rate `115200`.
2. Melakukan HTTP POST JSON ke `http://127.0.0.1:8000/api/ingest`.

Format JSON payload yang diterima `/api/ingest`:

```json
{
  "ts_ms": 124500,
  "esp32_connected": true,
  "line1": {
    "state": "RUNNING",
    "emg": false,
    "temp_c": 30.2,
    "good_delta": 1,
    "reject_delta": 0,
    "last_mm": 145
  },
  "line2": {
    "state": "STOP",
    "emg": false,
    "temp_c": 31.0,
    "good_delta": 0,
    "reject_delta": 0,
    "last_mm": 0
  }
}
```

* Keterangan:
  * `state`: `"RUNNING"`, `"STOP"`, atau `"IDLE"`.
  * `emg`: `true` jika tombol Emergency Stop ditekan (mesin otomatis dipaksa STOP).
  * `good_delta`: Jumlah barang bagus yang baru terdeteksi (ditambahkan ke counter jika sesi aktif).
  * `reject_delta`: Jumlah barang reject yang baru terdeteksi.

---

## Logika Sesi & Pemulihan Mati Listrik

1. **Status Mesin vs Sesi:**
   * Saat sesi **belum dimulai** (tombol masih bertuliskan `START`), status mesin pada layar tetap `IDLE` dan produk belum dihitung.
   * Saat tombol `START` ditekan, sesi dimulai dan tombol berubah menjadi `STOP`.
   * Di line fisik, PB1 digunakan untuk RUN/STOP motor, PB2 untuk menandai barang reject, dan EMG untuk Emergency Stop.
2. **Kalkulasi Availability:**
   * Availability dihitung dengan rumus: $\text{Availability} = \frac{\text{Run Time}}{\text{Planned Production Time}}$.
   * Jika Planned Time diatur `0` (belum ditentukan), pembagi otomatis menggunakan **lama sesi berjalan** ($\text{Elapsed Time}$). Kondisi mesin berhenti (STOP) otomatis terbaca sebagai downtime yang menurunkan Availability.
3. **Pemulihan Sesi (Crash Recovery):**
   * Backend menyimpan checkpoint data ke SQLite secara berkala setiap 5 detik.
   * Jika Raspberry Pi mati listrik mendadak saat sesi sedang berlangsung, saat backend kembali menyala antarmuka akan menampilkan pop-up konfirmasi:
     * **RESUME SESI:** Melanjutkan sesi produksi dari data terakhir.
     * **AKHIRI SESI:** Menutup sesi tersebut dan menyimpannya secara rapi ke riwayat laporan.

---

## Menjalankan Otomatis di Raspberry Pi (Autostart)

Salin unit service systemd:

```bash
sudo cp deploy/oee-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable oee-backend
sudo systemctl start oee-backend
```

Untuk mode Chromium Kiosk layar penuh pada Raspberry Pi OS:

```bash
chromium-browser --kiosk --window-size=480,320 --noerrdialogs --disable-pinch http://localhost:8000
```
