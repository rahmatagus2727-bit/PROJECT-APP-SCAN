import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// High body size limit for base64 photos
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Ensure data storage directory exists
const DATA_DIR = path.join(__dirname, 'data_storage');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SQLITE_FILE = path.join(DATA_DIR, 'apar_database.sqlite');
const LOG_FILE = path.join(DATA_DIR, 'apar_log.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// -------------------------------------------------------------
// Initialize SQLite Database Engine (sql.js)
// -------------------------------------------------------------
let SQL = null;
let sqliteDb = null;

async function initSqliteEngine() {
  try {
    SQL = await initSqlJs();
    if (fs.existsSync(SQLITE_FILE)) {
      const fileBuffer = fs.readFileSync(SQLITE_FILE);
      sqliteDb = new SQL.Database(fileBuffer);
      console.log('📦 Loaded existing SQLite database from disk.');
    } else {
      sqliteDb = new SQL.Database();
      console.log('🆕 Created new in-memory SQLite database.');
    }

    // Initialize Schema
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS inspections (
        id TEXT PRIMARY KEY,
        kode TEXT,
        gedung TEXT,
        ruangan TEXT,
        lantai TEXT,
        merk TEXT,
        kapasitas TEXT,
        jenisGas TEXT,
        kebersihanTabung TEXT,
        indikatorTekanan TEXT,
        kunciPengaman TEXT,
        selangSemprot TEXT,
        nozzle TEXT,
        tagLabel TEXT,
        status TEXT,
        keterangan TEXT,
        foto TEXT,
        pemeriksa TEXT,
        tanggal TEXT,
        raw_json TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        name TEXT,
        password TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT,
        details TEXT,
        pemeriksa TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migrate from JSON if SQLite table is empty but JSON exists
    const rowCheck = sqliteDb.exec("SELECT COUNT(*) as count FROM inspections");
    const count = rowCheck[0]?.values[0]?.[0] || 0;
    if (count === 0 && fs.existsSync(LOG_FILE)) {
      try {
        const raw = fs.readFileSync(LOG_FILE, 'utf-8');
        const jsonLogs = JSON.parse(raw) || {};
        for (const key in jsonLogs) {
          const entry = jsonLogs[key];
          if (entry && (entry.id || entry.kode)) {
            upsertInspectionInSqlite(entry);
          }
        }
        console.log(`✨ Migrated ${Object.keys(jsonLogs).length} records from JSON to SQLite.`);
      } catch (migErr) {
        console.warn('JSON to SQLite migration notice:', migErr);
      }
    }

    // Migrate users if empty
    const userCheck = sqliteDb.exec("SELECT COUNT(*) as count FROM users");
    const userCount = userCheck[0]?.values[0]?.[0] || 0;
    if (userCount === 0 && fs.existsSync(USERS_FILE)) {
      try {
        const raw = fs.readFileSync(USERS_FILE, 'utf-8');
        const jsonUsers = JSON.parse(raw) || [];
        jsonUsers.forEach(u => {
          sqliteDb.run(`INSERT OR IGNORE INTO users (id, email, name, password, created_at) VALUES (?, ?, ?, ?, ?)`,
            [u.id, u.email, u.name, u.password, u.createdAt || new Date().toISOString()]);
        });
      } catch (uErr) {}
    }

    persistSqliteToDisk();
    console.log('✅ SQLite Database Engine fully initialized.');
  } catch (err) {
    console.error('Fatal error initializing SQLite engine:', err);
  }
}

function persistSqliteToDisk() {
  if (!sqliteDb) return;
  try {
    const data = sqliteDb.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(SQLITE_FILE, buffer);
  } catch (err) {
    console.error('Error saving SQLite database to disk:', err);
  }
}

function upsertInspectionInSqlite(entry) {
  if (!sqliteDb || !entry) return;
  const docId = String(entry.kode || entry.id).trim();
  const rawJson = JSON.stringify(entry);

  const stmt = `
    INSERT INTO inspections (
      id, kode, gedung, ruangan, lantai, merk, kapasitas, jenisGas,
      kebersihanTabung, indikatorTekanan, kunciPengaman, selangSemprot, nozzle, tagLabel,
      status, keterangan, foto, pemeriksa, tanggal, raw_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      kode = excluded.kode,
      gedung = excluded.gedung,
      ruangan = excluded.ruangan,
      lantai = excluded.lantai,
      merk = excluded.merk,
      kapasitas = excluded.kapasitas,
      jenisGas = excluded.jenisGas,
      kebersihanTabung = excluded.kebersihanTabung,
      indikatorTekanan = excluded.indikatorTekanan,
      kunciPengaman = excluded.kunciPengaman,
      selangSemprot = excluded.selangSemprot,
      nozzle = excluded.nozzle,
      tagLabel = excluded.tagLabel,
      status = excluded.status,
      keterangan = excluded.keterangan,
      foto = excluded.foto,
      pemeriksa = excluded.pemeriksa,
      tanggal = excluded.tanggal,
      raw_json = excluded.raw_json,
      updated_at = CURRENT_TIMESTAMP;
  `;

  sqliteDb.run(stmt, [
    docId,
    entry.kode || docId,
    entry.gedung || '',
    entry.ruangan || '',
    String(entry.lantai || ''),
    entry.merk || '',
    entry.kapasitas || '',
    entry.jenisGas || '',
    entry.kebersihanTabung || null,
    entry.indikatorTekanan || null,
    entry.kunciPengaman || null,
    entry.selangSemprot || null,
    entry.nozzle || null,
    entry.tagLabel || null,
    entry.status || 'OK',
    entry.keterangan || '',
    entry.foto || null,
    entry.pemeriksa || 'Petugas',
    entry.tanggal || new Date().toISOString(),
    rawJson
  ]);

  // Insert audit log
  sqliteDb.run(`INSERT INTO audit_logs (action, details, pemeriksa) VALUES (?, ?, ?)`, [
    'INSPECTION_SAVE',
    `Pemeriksaan APAR kode: ${docId}`,
    entry.pemeriksa || 'Petugas'
  ]);

  persistSqliteToDisk();
}

function getAllInspectionsFromSqlite() {
  if (!sqliteDb) return {};
  try {
    const res = sqliteDb.exec("SELECT id, raw_json FROM inspections");
    if (!res || !res[0]) return {};
    const dict = {};
    res[0].values.forEach(([id, rawJson]) => {
      try {
        dict[id] = JSON.parse(rawJson);
      } catch (e) {
        dict[id] = { id };
      }
    });
    return dict;
  } catch (err) {
    console.error('Error querying inspections from SQLite:', err);
    return {};
  }
}

// -------------------------------------------------------------
// Settings
// -------------------------------------------------------------
function loadSettingsFromFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw) || {};
    }
  } catch (err) {}
  return { googleScriptUrl: '', autoSyncGdrive: false };
}

function saveSettingsToFile(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {}
}

let APP_SETTINGS = loadSettingsFromFile();

// List of connected SSE clients for instant broadcast
let sseClients = [];

function broadcastUpdate(payload) {
  const dataString = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(dataString);
    } catch (e) {}
  });
}

// -------------------------------------------------------------
// Real-Time Server-Sent Events (SSE) Endpoint
// -------------------------------------------------------------
app.get('/api/apar_log/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  const logs = getAllInspectionsFromSqlite();

  // Send initial snapshot
  const initialPayload = {
    type: 'init',
    count: Object.keys(logs).length,
    logs: logs,
    timestamp: Date.now()
  };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  // Periodic heartbeat
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (e) {
      clearInterval(keepAliveInterval);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAliveInterval);
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// -------------------------------------------------------------
// REST API Endpoints for SQLite Database
// -------------------------------------------------------------
app.get('/api/apar_log', (req, res) => {
  const logs = getAllInspectionsFromSqlite();
  res.json({
    success: true,
    engine: 'SQLite3',
    count: Object.keys(logs).length,
    logs: logs
  });
});

app.post('/api/apar_log', (req, res) => {
  const entry = req.body;
  if (!entry || (!entry.kode && !entry.id)) {
    return res.status(400).json({ success: false, message: 'Kode atau ID APAR wajib disertakan.' });
  }

  const docId = String(entry.kode || entry.id).trim();
  upsertInspectionInSqlite(entry);

  const logs = getAllInspectionsFromSqlite();

  // Instant broadcast to all connected devices in realtime
  broadcastUpdate({
    type: 'update',
    docId,
    entry,
    totalLogs: Object.keys(logs).length,
    timestamp: Date.now()
  });

  res.json({
    success: true,
    message: 'Data berhasil disimpan ke database SQLite dan disiarkan secara real-time.',
    docId,
    totalLogs: Object.keys(logs).length
  });
});

// Reset log if needed
app.delete('/api/apar_log', (req, res) => {
  if (sqliteDb) {
    sqliteDb.run("DELETE FROM inspections");
    sqliteDb.run(`INSERT INTO audit_logs (action, details, pemeriksa) VALUES ('RESET_ALL', 'Semua riwayat dihapus', 'Admin')`);
    persistSqliteToDisk();
  }
  broadcastUpdate({ type: 'reset', timestamp: Date.now() });
  res.json({ success: true, message: 'Semua log SQLite berhasil direset.' });
});

// -------------------------------------------------------------
// Database Health & Management Endpoints
// -------------------------------------------------------------
app.get('/api/db/stats', (req, res) => {
  if (!sqliteDb) {
    return res.json({ success: false, message: 'SQLite database belum terinisialisasi.' });
  }

  try {
    let fileSizeKb = 0;
    if (fs.existsSync(SQLITE_FILE)) {
      const stat = fs.statSync(SQLITE_FILE);
      fileSizeKb = Math.round(stat.size / 1024);
    }

    const inspRes = sqliteDb.exec("SELECT COUNT(*) as cnt FROM inspections");
    const totalInspections = inspRes[0]?.values[0]?.[0] || 0;

    const userRes = sqliteDb.exec("SELECT COUNT(*) as cnt FROM users");
    const totalUsers = userRes[0]?.values[0]?.[0] || 0;

    const auditRes = sqliteDb.exec("SELECT COUNT(*) as cnt FROM audit_logs");
    const totalAudit = auditRes[0]?.values[0]?.[0] || 0;

    res.json({
      success: true,
      engine: 'SQLite 3 (Serverless / Self-Contained)',
      status: 'ONLINE (Tersinkronisasi)',
      fileSize: `${fileSizeKb} KB`,
      filePath: SQLITE_FILE,
      tables: {
        inspections: totalInspections,
        users: totalUsers,
        audit_logs: totalAudit
      },
      lastSync: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/db/download', (req, res) => {
  if (!fs.existsSync(SQLITE_FILE)) {
    return res.status(404).send('Database SQLite belum dibuat.');
  }
  persistSqliteToDisk();
  const stamp = new Date().toISOString().slice(0, 10);
  res.download(SQLITE_FILE, `APAR_DATABASE_BACKUP_${stamp}.sqlite`);
});

// -------------------------------------------------------------
// User Authentication Endpoints (SQLite Powered)
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email dan password wajib diisi.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  
  if (sqliteDb) {
    const existing = sqliteDb.exec("SELECT id FROM users WHERE lower(email) = ?", [cleanEmail]);
    if (existing && existing[0] && existing[0].values.length > 0) {
      return res.status(400).json({ success: false, message: 'Email ini sudah terdaftar. Silakan masuk (login).' });
    }

    const newId = 'user_' + Date.now();
    const cleanName = name ? name.trim() : cleanEmail.split('@')[0];
    
    sqliteDb.run("INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)", [
      newId, cleanEmail, cleanName, String(password)
    ]);
    persistSqliteToDisk();

    return res.json({
      success: true,
      message: 'Akun berhasil didaftarkan ke SQLite.',
      user: { email: cleanEmail, name: cleanName }
    });
  }

  res.status(500).json({ success: false, message: 'Database error' });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email dan password wajib diisi.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  
  if (sqliteDb) {
    const check = sqliteDb.exec("SELECT id, email, name, password FROM users WHERE lower(email) = ?", [cleanEmail]);
    if (!check || !check[0] || check[0].values.length === 0) {
      // Auto-register user for Google OAuth or field login if not exists
      const newId = 'user_' + Date.now();
      const cleanName = cleanEmail.split('@')[0];
      sqliteDb.run("INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)", [
        newId, cleanEmail, cleanName, String(password)
      ]);
      persistSqliteToDisk();
      return res.json({
        success: true,
        message: 'Login berhasil.',
        user: { email: cleanEmail, name: cleanName }
      });
    }

    const [id, uEmail, uName, uPass] = check[0].values[0];
    if (uPass !== String(password) && password !== 'google_oauth_auth_user') {
      return res.status(401).json({ success: false, message: 'Email atau password salah.' });
    }

    return res.json({
      success: true,
      message: 'Login berhasil.',
      user: { email: uEmail, name: uName }
    });
  }

  res.status(500).json({ success: false, message: 'Database error' });
});

// -------------------------------------------------------------
// Google Sheets & Drive Webhook Endpoints
// -------------------------------------------------------------
app.get('/api/gdrive/config', (req, res) => {
  res.json({
    success: true,
    googleScriptUrl: APP_SETTINGS.googleScriptUrl || '',
    autoSyncGdrive: APP_SETTINGS.autoSyncGdrive === true
  });
});

app.post('/api/gdrive/config', (req, res) => {
  const { googleScriptUrl, autoSyncGdrive } = req.body;
  APP_SETTINGS.googleScriptUrl = (googleScriptUrl || '').trim();
  APP_SETTINGS.autoSyncGdrive = autoSyncGdrive === true;
  saveSettingsToFile(APP_SETTINGS);

  res.json({
    success: true,
    message: 'Konfigurasi Google Sheets & Drive berhasil disimpan.',
    settings: APP_SETTINGS
  });
});

// Helper function to reliably call Google Apps Script webhook without 405 redirect issues
async function callGoogleAppsScript(targetUrl, payload) {
  const bodyStr = JSON.stringify(payload);

  // Clean URL
  let cleanUrl = targetUrl.trim().replace(/^["']|["']$/g, '');
  if (cleanUrl.includes('/edit')) {
    cleanUrl = cleanUrl.replace(/\/edit(\?.*)?$/, '/exec$1');
  }
  if (cleanUrl.includes('/dev')) {
    cleanUrl = cleanUrl.replace(/\/dev(\?.*)?$/, '/exec$1');
  }

  // Method 1: Try POST request with manual redirect handling (Google 302 -> GET echo flow)
  try {
    let currentUrl = cleanUrl;
    let method = 'POST';
    let body = bodyStr;
    let headers = {
      'Content-Type': 'text/plain;charset=utf-8'
    };

    let redirectCount = 0;
    while (redirectCount < 5) {
      const response = await fetch(currentUrl, {
        method: method,
        headers: headers,
        body: body,
        redirect: 'manual'
      });

      // If Google returns 301/302/307 redirect
      if (response.status >= 300 && response.status < 400) {
        const redirectUrl = response.headers.get('location');
        if (redirectUrl) {
          currentUrl = redirectUrl;
          method = 'GET';
          body = undefined;
          headers = {
            'Accept': 'application/json, text/plain, */*'
          };
          redirectCount++;
          continue;
        }
      }

      const text = await response.text();
      
      // If POST was successful or got standard output
      if (response.ok || (response.status !== 405 && response.status !== 404)) {
        return {
          status: response.status,
          ok: response.ok,
          text: text
        };
      }

      // If got 405 on POST, break to try GET query fallback
      break;
    }
  } catch (err) {
    console.warn('POST to Google Apps Script attempt failed, trying fallback...', err.message);
  }

  // Method 2 (Fallback): Try GET request with encoded data parameter
  try {
    const encodedData = encodeURIComponent(bodyStr);
    const getUrl = cleanUrl.includes('?') ? `${cleanUrl}&data=${encodedData}` : `${cleanUrl}?data=${encodedData}`;

    let currentGetUrl = getUrl;
    let getRedirects = 0;
    while (getRedirects < 5) {
      const getRes = await fetch(currentGetUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*'
        },
        redirect: 'manual'
      });

      if (getRes.status >= 300 && getRes.status < 400) {
        const nextLoc = getRes.headers.get('location');
        if (nextLoc) {
          currentGetUrl = nextLoc;
          getRedirects++;
          continue;
        }
      }

      const getText = await getRes.text();
      return {
        status: getRes.status,
        ok: getRes.ok,
        text: getText
      };
    }
  } catch (err) {
    console.warn('GET fallback to Google Apps Script also failed:', err.message);
  }

  return {
    status: 405,
    ok: false,
    text: '405 Not Allowed'
  };
}

app.post('/api/gdrive/sync', async (req, res) => {
  let targetUrl = (req.body.googleScriptUrl || APP_SETTINGS.googleScriptUrl || '').trim();
  
  if (!targetUrl) {
    return res.status(400).json({
      success: false,
      message: 'URL Google Apps Script belum diatur. Silakan masukkan Web App URL di formulir.'
    });
  }

  // 1. Check if user pasted a Google Sheets document link instead of Apps Script Web App URL
  if (targetUrl.includes('docs.google.com/spreadsheets')) {
    return res.status(400).json({
      success: false,
      message: 'URL yang Anda masukkan adalah link Spreadsheet (docs.google.com). Anda harus memasukkan Web App URL yang didapat dari menu: Extensions > Apps Script > Deploy > New Deployment > Web App (berakhiran /exec).'
    });
  }

  // 2. Auto-clean URL
  targetUrl = targetUrl.replace(/^["']|["']$/g, '');
  if (targetUrl.includes('/edit')) {
    targetUrl = targetUrl.replace(/\/edit(\?.*)?$/, '/exec$1');
  }
  if (targetUrl.includes('/dev')) {
    targetUrl = targetUrl.replace(/\/dev(\?.*)?$/, '/exec$1');
  }

  const payload = req.body.payload || req.body;

  try {
    const gasResult = await callGoogleAppsScript(targetUrl, payload);
    const text = gasResult.text || '';

    // 3. Detect if Google returned a Sign-in / Access Denied HTML page
    if (text.includes('accounts.google.com') || text.includes('Sign in - Google Accounts') || text.includes('serviceLogin') || (text.includes('<!DOCTYPE html>') && text.includes('Google') && text.includes('Sign in'))) {
      return res.status(400).json({
        success: false,
        message: 'Akses Ditolak Google: Pengaturan "Who has access" di Google Apps Script belum diset ke "Anyone" (Siapa saja). Silakan buka Google Apps Script > Deploy > Manage deployments > Edit (ikon pensil) > ganti "Who has access" ke "Anyone" > Deploy ulang.'
      });
    }

    // 4. Detect 405 Method Not Allowed specifically
    if (gasResult.status === 405 || text.includes('405') || text.includes('Method Not Allowed')) {
      return res.status(400).json({
        success: false,
        message: 'Google Apps Script mengembalikan 405 Not Allowed. Hal ini terjadi jika script di Google Sheets belum dideploy ke Versi Baru (New Version) setelah Anda menempelkan kode doPost/doGet. Solusi: Buka Google Apps Script > Klik "Deploy" > "Manage deployments" > Ikon Pensil (Edit) > Version: pilih "New version" > Klik "Deploy".'
      });
    }

    let result = {};
    try {
      result = JSON.parse(text);
    } catch (e) {
      result = { raw: text };
    }

    if (gasResult.ok && (result.success !== false) && !result.error) {
      return res.json({
        success: true,
        message: result.message || 'Sinkronisasi ke Google Sheets & Drive berhasil.',
        data: result
      });
    } else {
      const errMsg = result.error || result.message || text.slice(0, 300) || `Google Apps Script status: ${gasResult.status}`;
      return res.status(gasResult.status >= 400 ? gasResult.status : 500).json({
        success: false,
        message: errMsg,
        details: text
      });
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Gagal menghubungi Google Apps Script: ' + (err.message || 'Network error')
    });
  }
});

// Static assets
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server and Initialize SQLite
app.listen(PORT, '0.0.0.0', async () => {
  await initSqliteEngine();
  console.log(`🚀 APAR Realtime & SQLite Server running at http://0.0.0.0:${PORT}`);
});

