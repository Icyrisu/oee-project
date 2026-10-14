# Aturan Agen Antigravity — Tahap 1 (Frontend & Mock Backend)

Simpan file ini di `.agent/rules/phase1-rules.md` di proyek **Antigravity**. Dokumen ini mengikat agen AI untuk menyelesaikan tahap antarmuka pengguna tanpa terkontaminasi logika database atau serial hardware.

## 1. Aturan Wajib Antarmuka (480x320 SPA)
1. **Dimensi Tetap 480x320:**
   * Atur CSS kanvas utama: `width: 480px; height: 320px; max-width: 480px; max-height: 320px; overflow: hidden; position: relative; margin: 0 auto;`.
   * Tidak boleh ada *scroll bar* vertikal maupun horizontal pada kondisi apa pun.
2. **Palet Warna Eksak Sesuai `OEE Web.pdf`:**
   * Latar utama: `#000000` (Pure Black).
   * Status Running / Badge Online / Bar Sesi: `#A3F268` (Lime Green), teks hitam `#000000`.
   * Status Stop / Tombol Stop / Badge Offline / Angka Reject: `#FF3B30` (Red), teks hitam pada card/pill.
   * Status Idle / Tombol Start / Tombol Detail & Export & Back / Angka OEE: `#5279FD` (Blue).
   * Permukaan Kartu Konten & Ikon Aktif: `#FFFFFF` (White) dengan `border-radius: 12px` hingga `14px`.
3. **Navigasi Single Page Application (SPA):**
   * Tiga layar utama (**Dashboard**, **Report**, **Setting**) wajib berada dalam satu file `index.html`.
   * Perpindahan layar dilakukan murni via pergantian kelas CSS (misal `.active` / `.hidden`) menggunakan JavaScript tanpa memicu *refresh* browser.
4. **On-Screen Touch Numpad Modal:**
   * Sediakan dialog/modal kalkulator sentuh sederhana untuk layar sentuh 3.5" Raspberry Pi saat nilai angka pada halaman Setting disentuh. Tombol sentuh minimal berukuran `40px × 40px`.

## 2. Aturan Mock Backend (FastAPI In-Memory)
1. **Zero Database Dependency:**
   * Dilarang membuat koneksi SQLite atau file `.db` pada tahap ini. Gunakan *dictionary* Python in-memory.
2. **Zero Serial Hardware Dependency:**
   * Dilarang mengimpor atau memanggil modul `serial` / `pyserial`.
   * Sediakan *background loop* berbasis `asyncio.sleep(1)` yang memancarkan data JSON via WebSocket `/ws` untuk mensimulasikan live update di layar.
3. **Dev Switcher / State Toggle Bar (Untuk Testing):**
   * Sediakan tombol kontrol tersembunyi atau bilah kecil penguji di bawah/header (atau shortcut keyboard) untuk menguji ke-10 tampilan visual dari PDF (misal: tombol ganti ke *Both Running*, *Line 2 Stop*, *Idle Offline*, dsb).
