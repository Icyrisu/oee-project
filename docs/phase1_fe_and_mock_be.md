# Spesifikasi Teknis Tahap 1: Frontend SPA 480x320 & Mock Backend

Dokumen ini adalah acuan pengembangan **Tahap 1** untuk agen di **Antigravity**. Fokus tahap ini adalah menghasilkan **antarmuka web (SPA) ukuran 480x320 yang 100% presisi dengan `OEE Web.pdf`** dan didukung oleh **Mock Backend (Python FastAPI in-memory)** tanpa koneksi ke database SQLite atau hardware serial ESP32 terlebih dahulu.

---

## 1. Lingkup Pekerjaan Tahap 1 (In-Scope vs Out-of-Scope)

* **IN-SCOPE (Dikerjakan Sekarang):**
  * File Frontend: `frontend/index.html`, `frontend/styles.css`, `frontend/app.js` (Vanilla JS, CSS Grid/Flexbox, SVG murni).
  * Ukuran layar terkunci fixed **`480px × 320px`** tanpa scrollbar.
  * Implementasi 3 Layar utama (**Dashboard**, **Report**, **Setting**) dan sub-layar (*Detail Data* & *Numpad Modal*).
  * Mock Backend: `backend/mock_server.py` (FastAPI) yang menyediakan REST API & WebSocket dengan data tiruan di memori (*in-memory state*) dan simulator interval waktu nyata.
  * Fitur simulasi penggantian status (Running, Stop, Idle, Online, Offline) via tombol UI untuk memverifikasi ke-10 tampilan visual dari PDF.
* **OUT-OF-SCOPE (Ditunda ke Tahap 2):**
  * Penyimpanan persisten ke database SQLite dan file WAL.
  * Pembacaan port USB Serial (`pyserial`) ke perangkat keras ESP32.
  * Kode program firmware Arduino ESP32 (`.ino`).

---

## 2. Spesifikasi UI/UX 480x320 & 10 State Visual (Sesuai `OEE Web.pdf`)

Layout menggunakan orientasi *landscape* dengan kanvas total **480 × 320 piksel**. Latar belakang utama adalah hitam pekat (`#000000`).

### 2.1. Navigasi Sisi Kanan (Fixed Right Sidebar)
* Lebar sidebar: `68px`, tinggi: `320px`, posisi tetap di sisi kanan.
* Berisi 3 ikon vertikal berukuran sentuh minimal `52px × 52px`:
  1. **Top Icon (4 Kotak Grid):** Layar 1 — Dashboard (`OEE Monitoring`).
  2. **Middle Icon (Dokumen Chart Batang):** Layar 2 — Report (`OEE Report`).
  3. **Bottom Icon (3 Slider Horizontal):** Layar 3 — Setting (`System Setting`).
* **Visual Indikator Aktif:** Menu yang aktif memiliki kotak putih membulat (`background: #FFFFFF`, `border-radius: 12px`) dengan ikon hitam (`#000000`). Menu tidak aktif berlatar hitam dengan garis ikon putih (`#FFFFFF`).

---

### 2.2. Layar 1: Dashboard (`OEE Monitoring`) — 5 State Warna Kartu

Area konten di sebelah kiri sidebar berukuran `412px × 320px`, dibagi menjadi 2 kolom (Line 1 di kiri, Line 2 di kanan).

* **Header:**
  * Kiri: Teks **`OEE`** (tebal) **`Monitoring`** (miring) warna putih.
  * Kanan: Dua tombol/badge berbentuk kapsul (*pill*):
    * Pill 1: Tombol Sesi (`STOP` merah `#FF3B30` teks hitam saat sesi aktif, atau `START` biru `#5279FD` teks hitam saat idle).
    * Pill 2: Status Koneksi (`ONLINE` hijau `#A3F268` teks hitam, atau `OFFLINE` merah `#FF3B30` teks hitam).
* **Kartu Baris Atas (Status, Suhu, & OEE %):**
  * Teks atas: `<Status> - <Suhu> °C` (contoh: `Running - 30.2 °C`).
  * Teks tengah: Angka OEE besar tebal (contoh: `88.5%` atau `0.0%`).
  * Garis bawah kartu: *Progress bar* horizontal tipis (fill putih, track hitam).
  * **5 State Warna Kartu Atas (Halaman 1–5 PDF):**
    1. *State 1 (Both Running):* Kedua kartu atas hijau terang `#A3F268` (teks hitam).
    2. *State 2 (Line 1 Running, Line 2 Stop):* Kartu Line 1 hijau `#A3F268`, kartu Line 2 merah `#FF3B30`.
    3. *State 3 (Both Stop):* Kedua kartu atas merah terang `#FF3B30`.
    4. *State 4 (Offline / Idle):* Pill atas `START` + `OFFLINE`, kedua kartu atas biru `#5279FD` (`Idle - 30.2 °C` / `0.0%`), counter bawah menampilkan `-/- pcs` dan `- pcs`.
    5. *State 5 (Start Sesi Running 0.0%):* Pill atas `STOP` + `ONLINE`, kedua kartu atas hijau `#A3F268` (`Running` / `0.0%`), counter bawah `-/- pcs` dan `- pcs`.
* **Kartu Baris Bawah (Counter Produk — Putih `#FFFFFF`):**
  * `Good Product`: Label hitam, angka biru besar `#5279FD` (contoh: `7/10 pcs`).
  * `Reject Product`: Label hitam, angka merah besar `#FF3B30` (contoh: `2 pcs`).

---

### 2.3. Layar 2: Report (`OEE Report`) — 4 Sub-View

* **Header:** Judul **`OEE`** **`Report`** warna putih. Tombol pill biru **`BACK`** (`#5279FD`) muncul di kanan atas saat berada di *Detail Data View*.
* **Session Selector Bar:** Bilah bulat warna hijau `#A3F268` dengan teks sesi (misal `Select Session Data` atau `01-01-2026 07:00:00`) dan ikon kaca pembesar di kanan.
* **4 Sub-State Tampilan:**
  1. *Sub-State 6 (Belum Pilih Sesi):* Tombol biru `Detail Data` & `Export Data`, dua kartu putih dengan *donut chart* hitam `0%`.
  2. *Sub-State 7 (Sesi Terpilih):* Tombol biru `Detail Data` & `Export Data`, dua kartu putih dengan *donut chart* lingkaran biru `#5279FD` menampilkan angka OEE sesi (`88,5%` dan `79,2%`).
  3. *Sub-State 8 (Detail Data — Produk):* Tombol `Detail Data` & `Export Data` hilang, tombol `BACK` muncul. Kartu putih menampilkan `OEE Line 1` (`88.5%`), `Good Product` (`7`), `Reject Product` (`2`) dan nilai Line 2 setara.
  4. *Sub-State 9 (Detail Data — Breakdown A/P/Q):* Kartu putih menampilkan rincian: `Availability Line 1` (`90.0%`), `Performance Line 1` (`80.5%`), `Quality Line 1` (`70.0%`) dan nilai Line 2 setara.

---

### 2.4. Layar 3: Setting (`System Setting`) & Numpad Modal

* **Header:** Judul **`System`** **`Setting`** warna putih, subjudul hijau `#A3F268` bertuliskan `Production Line 1` dan `Production Line 2`.
* **Dua Kartu Putih Berdampingan:**
  * `Quantity Target`: Angka biru besar `#5279FD` (contoh: `30 pcs`).
  * `Ideal Cycle Time`: Angka biru besar `#5279FD` (contoh: `60s`).
  * `Production Time`: Waktu produksi berjalan (contoh: `2h 45m 0s`).
* **On-Screen Touch Numpad (Modal Sentuh):**
  * Ketika nilai `Quantity Target` atau `Ideal Cycle Time` disentuh, muncul *modal pop-up* di tengah layar `480x320` berisi tombol sentuh besar (`1–9`, `0`, `CLEAR`, `OK`, `CANCEL`) sehingga operator bisa mengubah nilai tanpa keyboard fisik.

---

## 3. Spesifikasi Mock Backend (FastAPI In-Memory)

File `backend/mock_server.py` bertindak sebagai penyedia data tiruan:

1. **State In-Memory:**
   * Menyimpan variabel status `session_active`, `is_online`, parameter Line 1 dan Line 2 (`status`, `temp_c`, `good`, `reject`, `target`, `cycle_time`, `run_seconds`).
2. **WebSocket `/ws`:**
   * Melakukan *broadcast* data state setiap 1 detik ke frontend.
   * Mensimulasikan kenaikan `Production Time` dan kenaikan acak pada `Good Product` saat sesi aktif dalam status `Running`.
3. **REST Endpoints:**
   * `POST /api/session/toggle`: Mengubah state sesi (`START` <-> `STOP`).
   * `POST /api/mock/toggle-state`: Endpoint khusus pengujian untuk mengganti status mesin (`RUNNING`, `STOP`, `IDLE`) dan koneksi (`ONLINE`, `OFFLINE`).
   * `GET /api/sessions`: Mengembalikan daftar sesi *mock* untuk dropdown laporan.
   * `PUT /api/settings/{line_id}`: Memperbarui nilai target dan cycle time di memori.
