# 📷 Scan QR APAR & FSS — Pemeliharaan Bulanan

Aplikasi web sederhana untuk scan QR/barcode kode alat APAR & FSS, mengisi
checklist **KONDISI** dan **KETERANGAN** (sesuai form *Pemeliharaan APAR
Bulanan*), lalu mengekspor hasilnya kembali ke file Excel **Data FSS &
APAR**.

Riwayat & progres pemeriksaan sekarang bisa disimpan di **database bersama
(Firebase Firestore)** — jadi semua petugas, dari HP masing-masing, melihat
progres tugas yang sama secara realtime. Lihat bagian
[🔗 Aktifkan Database Bersama](#-aktifkan-database-bersama-supaya-progres-terlihat-semua-orang)
di bawah.

## ✨ Fitur

- **Scan QR** kode alat (pakai kamera HP) atau ketik kode manual.
- Data alat (Ruangan, Gedung, Lantai, Merk, Kapasitas, Jenis Gas, Kode)
  otomatis muncul dari `data.js` (sumber: `DATA FSS & APAR`).
- Checklist **KONDISI**: Kebersihan Tabung APAR, Pemeriksaan Indikator
  Tekanan, Pemeriksaan Kunci Pengaman, Pemeriksaan Selang Semprot,
  Pemeriksaan Nozzle, TAG Label Pemeliharaan, dan **EVIDEN** (otomatis
  terisi berdasarkan ada/tidaknya foto bukti).
- Kolom **KETERANGAN** + tombol **Upload Foto** (langsung buka kamera/galeri
  HP) sebagai bukti pemeriksaan.
- Tab **Riwayat & Rekap**: daftar semua alat yang sudah discan/diisi
  (ditandai ✅), pencarian, progres tugas (`x / total selesai`, dan
  **"Done All"** kalau semua sudah selesai), serta tombol **Download Excel**.
- Download Excel berisi seluruh data asli + kolom tambahan `QRkode`,
  `KONDISI` (7 sub-kolom), `KETERANGAN`, foto bukti (ter-embed di sel),
  tanggal periksa, dan status tugas.
- Generator QR (`generate.html`) untuk mencetak/print QR semua alat
  berdasarkan kolom `kode`.
- 100% berjalan di browser (client-side, tanpa perlu bikin server sendiri).
  Riwayat pemeriksaan disinkronkan **realtime** ke database bersama
  (Firebase Firestore) begitu `firebase-config.js` diisi — kalau belum
  diisi, otomatis fallback ke `localStorage` (riwayat cuma di 1 HP).
- Indikator status database (🟢 tersambung / 📴 mode lokal) muncul di
  bagian atas halaman Scan.

## 📁 Struktur Project

```
.
├── index.html          # Halaman utama: scan, checklist, riwayat, download
├── generate.html       # Halaman generate/print QR kode alat
├── data.js             # Data master FSS & APAR (hasil ekspor dari Excel)
├── firebase-config.js  # Isi kredensial Firebase di sini (lihat panduan di bawah)
├── style.css           # Style bersama (dark theme, mobile-friendly)
└── README.md
```

## 🔗 Aktifkan Database Bersama (supaya progres terlihat semua orang)

Defaultnya aplikasi jalan pakai `localStorage` (riwayat cuma di 1 HP).
Supaya SEMUA petugas melihat progres yang sama secara realtime, sambungkan
ke **Firebase Firestore** — gratis, cukup 5-10 menit, tanpa kartu kredit:

1. Buka [console.firebase.google.com](https://console.firebase.google.com) →
   **Add project** → kasih nama bebas (misal `apar-fss`) → lanjut sampai
   selesai (Google Analytics boleh dimatikan).
2. Di menu kiri: **Build → Firestore Database → Create database** → pilih
   lokasi server terdekat (misal `asia-southeast2` untuk Jakarta) → pilih
   **Start in test mode** (biar langsung bisa baca/tulis; nanti bisa
   diperketat, lihat poin 5).
3. Di menu kiri klik ⚙️ **Project settings** → scroll ke **Your apps** →
   klik ikon web `</>` → kasih nama app → **Register app**. Firebase akan
   menampilkan objek `firebaseConfig`.
4. Copy semua nilai (`apiKey`, `authDomain`, `projectId`, dst) ke file
   `firebase-config.js` di project ini, menggantikan tulisan
   `GANTI_DENGAN_...`. Simpan file, lalu buka/refresh `index.html` — kalau
   berhasil, badge di atas halaman Scan berubah jadi 🟢 **"Tersambung —
   progres terlihat oleh semua orang"**.
5. **Keamanan (disarankan)**: mode "test mode" di langkah 2 membuat siapa
   saja yang tahu URL bisa baca/tulis data selama 30 hari lalu terkunci
   otomatis. Untuk pemakaian jangka panjang, buka **Firestore Database →
   Rules** dan ganti jadi aturan permanen, misalnya:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /apar_log/{docId} {
         allow read, write: if true; // internal tool, tanpa login user
       }
     }
   }
   ```
   Ini tetap terbuka (karena aplikasi tidak pakai login), jadi jangan sebar
   luaskan URL aplikasinya ke publik — cukup ke tim yang bertugas.
6. Kalau aplikasi di-host di GitHub Pages/hosting publik, `firebase-config.js`
   ikut ter-upload dan isinya (apiKey dkk) akan terlihat siapa saja yang
   buka source halaman — ini **normal dan aman** untuk Firebase (apiKey web
   bukan rahasia, proteksi sebenarnya ada di Firestore Rules poin 5, bukan
   di apiKey-nya).

## 🚀 Cara Pakai

1. Buka `index.html` langsung di browser HP/laptop (atau host via GitHub
   Pages, lihat di bawah).
2. Tab **Scan** → tekan **Mulai Scan QR**, izinkan akses kamera, arahkan ke
   QR alat. Data alat muncul otomatis.
3. Isi checklist **KONDISI**, tulis **KETERANGAN**, upload foto bukti bila
   perlu, lalu tekan **Simpan Hasil Pemeriksaan**.
4. Tab **Riwayat & Rekap** → lihat semua alat yang sudah diperiksa (✅),
   pantau progres tugas, lalu **Download Excel** kapan saja untuk laporan.
5. Butuh cetak QR baru/ulang? Buka `generate.html`.

## 🔄 Memperbarui data alat (`data.js`)

`data.js` dibuat dari sheet **APAR** pada file
`DATA_FSS___APAR_-_Copy.xlsx`. Kalau data master di Excel berubah
(tambah/kurang alat, ganti merk, dsb), regenerate `data.js` dengan salah
satu cara:

- **Manual**: edit array `APAR_DATA` di `data.js` langsung (formatnya JSON
  biasa, tiap alat 1 objek dengan field `no, ruangan, gedung, lantai, merk,
  kapasitas, jenisGas, kode, id`).
- **Dari Excel** (perlu Python + openpyxl), lalu tempel ulang ke `data.js`:
  ```python
  import openpyxl, json
  wb = openpyxl.load_workbook("DATA_FSS___APAR_-_Copy.xlsx", data_only=True)
  ws = wb["APAR"]
  rows = []
  for row in ws.iter_rows(min_row=3, values_only=True):
      no, ruangan, gedung, lantai, merk, kap, jenis, kode, qr = row
      if ruangan is None and gedung is None:
          continue
      rows.append({
          "no": no, "ruangan": ruangan, "gedung": gedung, "lantai": lantai,
          "merk": merk, "kapasitas": kap, "jenisGas": jenis,
          "kode": str(int(kode)) if isinstance(kode, (int, float)) else (str(kode).strip() if kode else None),
      })
  for i, r in enumerate(rows):
      r["id"] = r["kode"] if r["kode"] else f"row{i+1}"
  print(json.dumps(rows, ensure_ascii=False, indent=2))
  ```
  Setiap baris **wajib** punya kolom `kode` supaya bisa discan — kalau
  kosong, alat tetap muncul di rekap/download tapi tidak bisa dicari lewat
  scan QR.

## ⬆️ Upload ke GitHub

Repo ini sudah disiapkan sebagai git repository lokal (`git init` + commit
pertama). Untuk mengunggahnya ke akun GitHub Anda:

```bash
# 1. Buat repo baru di GitHub (lewat web, tanpa README/gitignore bawaan)
# 2. Di folder project ini, jalankan:
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git branch -M main
git push -u origin main
```

Ganti `USERNAME/NAMA-REPO` sesuai repo GitHub Anda.

### Hosting gratis via GitHub Pages (opsional)

Setelah push ke GitHub:
1. Buka repo → **Settings** → **Pages**.
2. Source: pilih branch `main`, folder `/ (root)` → **Save**.
3. Tunggu 1–2 menit, aplikasi bisa diakses via
   `https://USERNAME.github.io/NAMA-REPO/` — bisa langsung dibuka dari HP
   untuk scan QR tanpa perlu install apa-apa (butuh izin kamera & koneksi
   internet untuk load library QR/Excel dari CDN).

## 🛠️ Library yang dipakai (via CDN)

- [html5-qrcode](https://github.com/mebjas/html5-qrcode) — scan QR pakai kamera.
- [qrcodejs](https://github.com/davidshimjs/qrcodejs) — generate QR di `generate.html`.
- [ExcelJS](https://github.com/exceljs/exceljs) — membuat file `.xlsx` (termasuk embed foto) langsung di browser.
- [Firebase Firestore](https://firebase.google.com/docs/firestore) — database bersama realtime (opsional, lihat panduan setup di atas).

Tidak ada dependency npm/build step — cukup buka file `.html`-nya.

## 🐛 Perbaikan bug Scan QR

Beberapa perbaikan yang sudah dimasukkan supaya scan lebih stabil:

- **Kamera gagal buka ulang** setelah tekan "Scan Lagi" — sekarang start/stop
  kamera dijaga pakai status resmi dari library (`getState()`) supaya tidak
  ada 2 proses start/stop yang tabrakan.
- **1 kode kebaca 2x** (double-fire) saat kamera membaca QR yang sama
  beberapa kali per detik — sekarang ada debounce 2 detik untuk kode yang
  identik.
- **Salah baca barcode lain** (bukan QR) — scanner sekarang dikunci hanya
  membaca format QR Code saja.
- **Kamera tetap menyala di background** saat pindah ke tab Riwayat atau
  aplikasi di-minimize — sekarang otomatis berhenti supaya tidak boros
  baterai dan tidak bikin state kacau saat kembali.
- **Pesan error kamera lebih jelas** — izin ditolak, kamera tidak
  ditemukan, atau kamera sedang dipakai aplikasi lain, masing-masing
  ditampilkan dengan pesan yang jelas alih-alih error teknis mentah.

## ⚠️ Catatan

- Kolom `QRkode` yang sebelumnya `#VALUE!` di file sumber sekarang diisi
  otomatis dengan nilai `kode` yang sama dipakai untuk membuat QR-nya.
- Foto bukti otomatis dikompres (resize + kualitas diturunkan) sebelum
  disimpan, supaya muat di batas ukuran dokumen Firestore (1MB) dan hemat
  kuota data.
- Kalau `firebase-config.js` belum diisi, aplikasi tetap bisa dipakai
  normal (fallback ke `localStorage`), hanya saja riwayatnya tidak
  tersinkron ke petugas lain.
