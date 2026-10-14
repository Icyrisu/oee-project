# Spesifikasi Teknis Tahap 2: Database SQLite, Protokol Serial, & Firmware ESP32

Dokumen ini disimpan sebagai acuan **Tahap 2** setelah Tahap 1 (Frontend & Mock Backend) selesai diverifikasi di layar 480x320.

---

## 1. Skema Database SQLite (`oee_local.db`)
* Mengaktifkan mode WAL untuk melindungi SD card:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  ```
* Tabel:
  1. `line_settings` (`line_id INT PRIMARY KEY, target_qty INT, ideal_cycle_sec REAL, planned_prod_sec INT, updated_at TIMESTAMP`)
  2. `production_sessions` (`id INTEGER PRIMARY KEY AUTOINCREMENT, session_label TEXT, started_at TIMESTAMP, ended_at TIMESTAMP, is_active INT, l1_good INT, l1_reject INT, l1_run_sec INT, l1_avail REAL, l1_perf REAL, l1_qual REAL, l1_oee REAL, l2_good INT, l2_reject INT, l2_run_sec INT, l2_avail REAL, l2_perf REAL, l2_qual REAL, l2_oee REAL`)
  3. `state_logs` (`id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INT, line_id INT, state TEXT, temp_c REAL, timestamp TIMESTAMP`)

---

## 2. Worker Komunikasi Serial USB (Raspberry Pi 4B)
* Membaca port `/dev/ttyUSB0` atau `/dev/ttyACM0` pada baud rate `115200`.
* Menguraikan paket NDJSON dari ESP32:
  ```json
  {"ts_ms":124500,"line1":{"state":"RUNNING","emg":false,"temp_c":30.2,"good_delta":1,"reject_delta":0,"last_mm":145},"line2":{"state":"STOP","emg":false,"temp_c":31.0,"good_delta":0,"reject_delta":0,"last_mm":0}}
  ```
* Menghitung OEE secara *real-time* di memori RAM dan menyimpan *checkpoint* ke SQLite hanya jika terjadi event produksi atau perubahan status.

---

## 3. Firmware ESP32 Tanpa Modul Layar OLED (`firmware/esp32_oee_no_oled.ino`)
* Menghilangkan seluruh pemanggilan library `<Wire.h>`, `<Adafruit_GFX.h>`, `<Adafruit_SSD1306.h>`.
* Pinout 2 Line (Sesuai Buku Panduan Smart Manufacturing):
  * Line 1: `START=19`, `STOP=18`, `EMG=5`, `RELAY=27` (Active LOW), `PHOTO=36`, `TRIG=33`, `ECHO=32`.
  * Line 2: `START=17`, `STOP=16`, `EMG=4`, `RELAY=14` (Active LOW), `PHOTO=39`, `TRIG=26`, `ECHO=25`.
  * Sensor Suhu: DS18B20 1-Wire pada `GPIO13` (`TEMP1_ADDR` & `TEMP2_ADDR`).
* Logika Kualitas Ultrasonik: `THRESH_MM = 100` (`< 100 mm` = **Reject**, `100..300 mm` = **Good**).
