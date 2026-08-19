// ==========================================================================
// firebase-config.js — Konfigurasi database bersama (Firebase Firestore)
// ==========================================================================
// Supaya progres/riwayat pemeriksaan bisa dilihat SEMUA orang (bukan cuma
// 1 HP), aplikasi ini butuh 1 database gratis di Firebase.
//
// Cara dapetin isian di bawah (5-10 menit, gratis, tanpa kartu kredit):
//   1. Buka https://console.firebase.google.com → Add project → kasih nama
//      bebas (misal "apar-fss") → lanjut sampai selesai (Analytics boleh
//      dimatikan).
//   2. Di menu kiri: Build → Firestore Database → Create database →
//      pilih lokasi (misal asia-southeast1/asia-southeast2) → mode
//      "Start in test mode" (nanti bisa diperketat, lihat README).
//   3. Di menu kiri: klik ⚙️ (Project settings) → scroll ke "Your apps" →
//      klik ikon web </> → kasih nama app → Register app.
//   4. Firebase akan menampilkan objek `firebaseConfig` — copy semua nilai
//      di dalamnya ke bawah ini (apiKey, authDomain, projectId, dst).
//
// Selama nilai di bawah masih "GANTI_...", aplikasi otomatis jalan pakai
// localStorage seperti biasa (riwayat cuma tersimpan di 1 HP) supaya tidak
// error. Setelah diisi dengan benar, otomatis pindah ke mode database
// bersama.
// ==========================================================================

const firebaseConfig = {
  apiKey: "GANTI_DENGAN_API_KEY",
  authDomain: "GANTI_DENGAN_PROJECT_ID.firebaseapp.com",
  projectId: "GANTI_DENGAN_PROJECT_ID",
  storageBucket: "GANTI_DENGAN_PROJECT_ID.appspot.com",
  messagingSenderId: "GANTI_DENGAN_SENDER_ID",
  appId: "GANTI_DENGAN_APP_ID",
};
