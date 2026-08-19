# 🧯 Cek & Pemeliharaan APAR — Scan QR

Aplikasi web sederhana (statis, tanpa server/backend) untuk mencatat pemeriksaan bulanan APAR
dengan scan QR/barcode, lalu mengekspor hasilnya ke Excel dengan format yang sama seperti file
**DATA FSS & APAR**.

## Fitur

- 📷 **Scan QR/barcode** langsung dari kamera HP (pakai library `html5-qrcode`), atau input kode manual.
- Setiap kode otomatis dicocokkan ke data alat (Ruangan, Gedung, Lantai, Merk, Kapasitas, Jenis Gas).
- Form **KONDISI**: Kebersihan Tabung APAR, Pemeriksaan Indikator Tekanan, Pemeriksaan Kunci
  Pengaman, Pemeriksaan Selang Semprot, Pemeriksaan Nozzle, TAG Label Pemeliharaan, EVIDEN —
  sesuai kolom di file *Pemeliharaan APAR Bulanan*.
- **KETERANGAN** + tombol **Upload/Ambil Foto** (langsung membuka kamera/galeri HP).
- Tab **📊 Log Data & Download**: tabel rekap semua alat + status (`Belum` / `✅ Selesai`),
  progress `X dari Y tugas selesai` (jadi **Done All** kalau semua sudah dikerjakan), dan tombol
  **Download Excel** untuk mengekspor hasil pemeriksaan (termasuk foto bukti tertanam di kolom FOTO).
- Halaman **`generate.html`**: cetak/generate QR untuk ditempel di tiap APAR.
- Data pemeriksaan tersimpan otomatis di `localStorage` browser (per perangkat) — jalan 100% offline
  setelah halaman pertama kali dibuka.

## Struktur file

```
├── index.html      # Halaman utama: scan, isi form, log data, download
├── generate.html   # Halaman cetak QR kode untuk setiap alat
└── README.md
```

## Cara pakai

1. Buka `generate.html` → cetak/tempel QR di setiap APAR.
2. Buka `index.html` di HP → tab **Scan APAR** → scan QR / ketik kode → isi form kondisi → **Simpan**.
3. Buka tab **Log Data & Download** untuk lihat rekap dan **Download Excel**.

## Cara deploy ke GitHub Pages

1. Buat repository baru di GitHub, upload/`push` semua file di folder ini (`index.html`,
   `generate.html`, `README.md`).
2. Masuk ke **Settings → Pages**.
3. Pada **Source**, pilih branch `main` dan folder `/root`, lalu **Save**.
4. Tunggu 1–2 menit, aplikasi akan aktif di:
   `https://<username-github>.github.io/<nama-repo>/`
5. Buka link tersebut di HP (perlu izin kamera untuk fitur scan).

### Push lewat command line (opsional)

```bash
git init
git add .
git commit -m "Aplikasi cek & pemeliharaan APAR"
git branch -M main
git remote add origin https://github.com/<username-anda>/<nama-repo>.git
git push -u origin main
```

## Catatan

- Data master alat (ruangan, gedung, merk, kode, dst.) tertanam langsung di dalam `index.html`
  dan `generate.html`, jadi tidak perlu file Excel terpisah untuk menjalankan aplikasinya.
- Jika ingin update data master (ada alat baru/pindah), edit array `APAR_DATA` di kedua file
  tersebut.
- Data isian (kondisi, foto, keterangan) tersimpan per-perangkat di browser. Kalau ganti HP/browser,
  history sebelumnya tidak otomatis pindah — cukup **Download Excel** secara rutin sebagai backup.
