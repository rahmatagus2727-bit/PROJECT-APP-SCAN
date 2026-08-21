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
// Initialize SQLite Database Engine (sql.js) with Auto-Healing
// -------------------------------------------------------------
let SQL = null;
let sqliteDb = null;

function createTables(db) {
  db.run(`
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
      role TEXT DEFAULT 'petugas',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deleted_users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT,
      details TEXT,
      pemeriksa TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function restoreFromBackups(db) {
  // Migrate from JSON if SQLite table is empty but JSON exists
  try {
    const rowCheck = db.exec("SELECT COUNT(*) as count FROM inspections");
    const count = rowCheck[0]?.values[0]?.[0] || 0;
    if (count === 0 && fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, 'utf-8');
      const jsonLogs = JSON.parse(raw) || {};
      for (const key in jsonLogs) {
        const entry = jsonLogs[key];
        if (entry && (entry.id || entry.kode)) {
          const docId = String(entry.kode || entry.id).trim();
          const rawJson = JSON.stringify(entry);
          db.run(`
            INSERT OR REPLACE INTO inspections (
              id, kode, gedung, ruangan, lantai, merk, kapasitas, jenisGas,
              kebersihanTabung, indikatorTekanan, kunciPengaman, selangSemprot, nozzle, tagLabel,
              status, keterangan, foto, pemeriksa, tanggal, raw_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `, [
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
        }
      }
      console.log(`✨ Restored ${Object.keys(jsonLogs).length} records from JSON backup to SQLite.`);
    }
  } catch (migErr) {
    console.warn('JSON to SQLite migration notice:', migErr);
  }

  // Ensure role column exists and migrate/seed default users
  try {
    try {
      db.run("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'petugas'");
    } catch (e) {}

    const userCheck = db.exec("SELECT COUNT(*) as count FROM users");
    const userCount = userCheck[0]?.values[0]?.[0] || 0;
    
    let deletedSet = new Set();
    try {
      const delRes = db.exec("SELECT id, email, name FROM deleted_users");
      if (delRes && delRes[0] && delRes[0].values) {
        delRes[0].values.forEach(([dId, dEmail, dName]) => {
          if (dId) deletedSet.add(String(dId).toLowerCase().trim());
          if (dEmail) deletedSet.add(String(dEmail).toLowerCase().trim());
          if (dName) deletedSet.add(String(dName).toLowerCase().trim());
        });
      }
    } catch (e) {}

    const defaultUsers = [
      { id: 'user_admin', email: 'admin@apar.id', name: 'Admin K3 / Pemeliharaan', password: 'admin', role: 'admin' },
      { id: 'user_rizky', email: 'rizky@apar.id', name: 'Rizky (Petugas Utama)', password: '123', role: 'petugas' },
      { id: 'user_petugas1', email: 'petugas1@apar.id', name: 'Petugas Lapangan 1', password: '123', role: 'petugas' },
      { id: 'user_petugas2', email: 'petugas2@apar.id', name: 'Petugas Lapangan 2', password: '123', role: 'petugas' }
    ];

    defaultUsers.forEach(u => {
      const cleanId = String(u.id).toLowerCase().trim();
      const cleanEmail = String(u.email || '').toLowerCase().trim();
      const cleanName = String(u.name || '').toLowerCase().trim();

      if (!deletedSet.has(cleanId) && !deletedSet.has(cleanEmail) && !deletedSet.has(cleanName)) {
        db.run(`INSERT OR IGNORE INTO users (id, email, name, password, role, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [u.id, cleanEmail, u.name, u.password || '123', u.role || 'petugas', u.createdAt || new Date().toISOString()]);
      }
    });
  } catch (uErr) {
    console.warn('User setup warning:', uErr);
  }
}

async function rebuildCorruptedDatabase() {
  console.warn('⚠️ SQLite database corrupted or malformed. Auto-repairing and rebuilding...');
  try {
    if (fs.existsSync(SQLITE_FILE)) {
      try {
        fs.renameSync(SQLITE_FILE, SQLITE_FILE + '.corrupt_' + Date.now());
      } catch (e) {
        fs.unlinkSync(SQLITE_FILE);
      }
    }
  } catch (e) {}

  if (!SQL) {
    SQL = await initSqlJs();
  }
  sqliteDb = new SQL.Database();
  createTables(sqliteDb);
  restoreFromBackups(sqliteDb);
  persistSqliteToDisk();
  console.log('✅ SQLite database successfully healed and rebuilt.');
}

async function initSqliteEngine() {
  try {
    SQL = await initSqlJs();
    let loadedFromDisk = false;

    if (fs.existsSync(SQLITE_FILE)) {
      try {
        const fileBuffer = fs.readFileSync(SQLITE_FILE);
        if (fileBuffer && fileBuffer.length > 0) {
          const testDb = new SQL.Database(fileBuffer);
          // Verify integrity
          testDb.exec("PRAGMA quick_check;");
          sqliteDb = testDb;
          loadedFromDisk = true;
          console.log('📦 Loaded existing SQLite database from disk (passed integrity check).');
        }
      } catch (loadErr) {
        console.warn('Existing SQLite file corrupted or unreadable:', loadErr.message);
      }
    }

    if (!loadedFromDisk) {
      await rebuildCorruptedDatabase();
      return;
    }

    createTables(sqliteDb);
    restoreFromBackups(sqliteDb);
    persistSqliteToDisk();
    console.log('✅ SQLite Database Engine fully initialized.');
  } catch (err) {
    console.error('Fatal error initializing SQLite engine, attempting fresh build:', err);
    try {
      await rebuildCorruptedDatabase();
    } catch (rebuildErr) {
      console.error('Failed to rebuild SQLite database:', rebuildErr);
    }
  }
}

function persistSqliteToDisk() {
  if (!sqliteDb) return;
  try {
    const data = sqliteDb.export();
    const buffer = Buffer.from(data);
    const tmpFile = SQLITE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, buffer);
    fs.renameSync(tmpFile, SQLITE_FILE);
  } catch (err) {
    console.error('Error saving SQLite database to disk:', err);
  }
}

function syncJsonBackup(docId, entry) {
  try {
    let currentLogs = {};
    if (fs.existsSync(LOG_FILE)) {
      try {
        currentLogs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')) || {};
      } catch (e) {}
    }
    const cleanId = String(docId).trim().toLowerCase();
    if (entry) {
      currentLogs[docId] = entry;
    } else {
      delete currentLogs[docId];
      for (const k in currentLogs) {
        if (k.toLowerCase() === cleanId || 
            (currentLogs[k] && (String(currentLogs[k].kode || '').trim().toLowerCase() === cleanId || String(currentLogs[k].id || '').trim().toLowerCase() === cleanId))) {
          delete currentLogs[k];
        }
      }
    }
    fs.writeFileSync(LOG_FILE, JSON.stringify(currentLogs, null, 2), 'utf-8');
  } catch (e) {
    console.warn('JSON backup sync error:', e);
  }
}

function upsertInspectionInSqlite(entry) {
  if (!entry) return;
  const docId = String(entry.kode || entry.id).trim();
  const rawJson = JSON.stringify(entry);

  // Sync to JSON backup file
  syncJsonBackup(docId, entry);

  if (!sqliteDb) {
    return;
  }

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

  try {
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
  } catch (dbErr) {
    console.error('Error writing to SQLite, attempting recovery:', dbErr.message);
    rebuildCorruptedDatabase().then(() => {
      try {
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
        persistSqliteToDisk();
      } catch (retryErr) {
        console.error('Retry after healing failed:', retryErr);
      }
    });
  }
}

function getAllInspectionsFromSqlite() {
  if (!sqliteDb) {
    if (fs.existsSync(LOG_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')) || {};
      } catch (e) {}
    }
    return {};
  }
  try {
    const res = sqliteDb.exec("SELECT id, raw_json FROM inspections");
    if (!res || !res[0]) {
      if (fs.existsSync(LOG_FILE)) {
        try {
          return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')) || {};
        } catch (e) {}
      }
      return {};
    }
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
    // Auto-heal on malformed error
    rebuildCorruptedDatabase();
    if (fs.existsSync(LOG_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')) || {};
      } catch (e) {}
    }
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

  // Instant broadcast to all connected devices in realtime via SSE
  broadcastUpdate({
    type: 'update',
    docId,
    entry,
    totalLogs: Object.keys(logs).length,
    timestamp: Date.now()
  });

  // Background Automatic Sync to Google Sheets & Drive (Single Centralized Database)
  const targetScriptUrl = APP_SETTINGS.googleScriptUrl || '';
  if (targetScriptUrl && targetScriptUrl.startsWith('http')) {
    callGoogleAppsScript(targetScriptUrl, entry)
      .then(gasRes => {
        console.log(`⚡ Auto-synced inspection ${docId} to Google Sheets. OK:`, gasRes.ok);
      })
      .catch(gasErr => {
        console.warn(`⚠️ Background Google Sheets sync error for ${docId}:`, gasErr.message);
      });
  }

  res.json({
    success: true,
    message: 'Data berhasil disimpan ke database SQLite, disiarkan secara real-time, dan disinkronkan ke Google Sheets.',
    docId,
    totalLogs: Object.keys(logs).length
  });
});

// Delete single log entry
app.delete('/api/apar_log/:id', (req, res) => {
  const docId = req.params.id;
  if (!docId) {
    return res.status(400).json({ success: false, message: 'Kode / ID APAR wajib diisi.' });
  }

  const cleanId = String(docId).trim();
  const lowerCleanId = cleanId.toLowerCase();

  // Sync / remove from JSON backup file
  syncJsonBackup(cleanId, null);

  if (sqliteDb) {
    try {
      sqliteDb.run("DELETE FROM inspections WHERE id = ? OR kode = ? OR LOWER(id) = ? OR LOWER(kode) = ?", [cleanId, cleanId, lowerCleanId, lowerCleanId]);
      sqliteDb.run(`INSERT INTO audit_logs (action, details, pemeriksa) VALUES ('DELETE_SINGLE', ?, 'Petugas/Admin')`, [`Hapus log ${cleanId}`]);
      persistSqliteToDisk();
    } catch (err) {
      console.warn('SQLite single delete warning:', err);
    }
  }

  const currentLogs = getAllInspectionsFromSqlite();

  // Instant broadcast via SSE to ALL connected clients
  broadcastUpdate({
    type: 'delete_single',
    docId: cleanId,
    totalLogs: Object.keys(currentLogs).length,
    timestamp: Date.now()
  });

  // Auto delete in Google Sheets if URL configured
  const targetScriptUrl = APP_SETTINGS.googleScriptUrl || '';
  if (targetScriptUrl && targetScriptUrl.startsWith('http')) {
    callGoogleAppsScript(targetScriptUrl, { action: 'delete', kode: cleanId, id: cleanId }).catch(() => {});
  }

  res.json({ success: true, message: `Log ${cleanId} berhasil dihapus.`, totalLogs: Object.keys(currentLogs).length });
});

// Reset log if needed
app.delete('/api/apar_log', (req, res) => {
  if (sqliteDb) {
    sqliteDb.run("DELETE FROM inspections");
    sqliteDb.run(`INSERT INTO audit_logs (action, details, pemeriksa) VALUES ('RESET_ALL', 'Semua riwayat dihapus', 'Admin')`);
    persistSqliteToDisk();
  }
  if (fs.existsSync(LOG_FILE)) {
    try { fs.writeFileSync(LOG_FILE, '{}', 'utf-8'); } catch (e) {}
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
// User Authentication & Management Endpoints (SQLite Powered)
// -------------------------------------------------------------
app.get('/api/users', (req, res) => {
  if (!sqliteDb) {
    return res.json({ success: true, users: [] });
  }
  try {
    // Automatically purge stale deleted_users records for active accounts
    sqliteDb.run(`
      DELETE FROM deleted_users 
      WHERE lower(id) IN (SELECT lower(id) FROM users)
         OR (email IS NOT NULL AND trim(email) != '' AND lower(email) IN (SELECT lower(email) FROM users WHERE email IS NOT NULL AND trim(email) != ''))
         OR (name IS NOT NULL AND trim(name) != '' AND lower(name) IN (SELECT lower(name) FROM users WHERE name IS NOT NULL AND trim(name) != ''))
    `);

    const resUsers = sqliteDb.exec(`
      SELECT id, email, name, password, role, created_at FROM users 
      ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, name ASC
    `);
    if (!resUsers || !resUsers[0]) {
      return res.json({ success: true, users: [] });
    }
    const list = resUsers[0].values.map(([id, email, name, password, role, created_at]) => ({
      id,
      email,
      name: name || email,
      password: password || '123',
      role: role || (id === 'user_admin' ? 'admin' : 'petugas'),
      created_at
    }));
    res.json({ success: true, users: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/users', (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name && !email) {
    return res.status(400).json({ success: false, message: 'Nama atau ID Petugas wajib diisi.' });
  }

  const cleanName = (name || email).trim();
  const cleanEmail = (email || `${cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_')}@apar.id`).trim().toLowerCase();
  const cleanPass = password ? String(password).trim() : '123';
  const cleanRole = (role === 'admin' || cleanName.toLowerCase().includes('admin')) ? 'admin' : 'petugas';
  const newId = 'user_' + Date.now();

  if (sqliteDb) {
    try {
      // Remove from deleted_users if re-creating
      sqliteDb.run("DELETE FROM deleted_users WHERE lower(id) = ? OR lower(email) = ? OR lower(name) = ? OR lower(id) = ?", [
        newId.toLowerCase(), cleanEmail, cleanName.toLowerCase(), cleanEmail
      ]);

      sqliteDb.run("INSERT OR REPLACE INTO users (id, email, name, password, role) VALUES (?, ?, ?, ?, ?)", [
        newId, cleanEmail, cleanName, cleanPass, cleanRole
      ]);
      persistSqliteToDisk();

      // Update USERS_FILE
      try {
        const all = sqliteDb.exec("SELECT id, email, name, password, role, created_at FROM users");
        if (all && all[0]) {
          const list = all[0].values.map(([id, email, name, password, role, created_at]) => ({
            id, email, name, password, role, created_at
          }));
          fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
        }
      } catch (e) {}

      broadcastUpdate({
        type: 'user_updated',
        user: { id: newId, email: cleanEmail, name: cleanName, role: cleanRole, password: cleanPass },
        timestamp: Date.now()
      });

      return res.json({
        success: true,
        message: `Akun "${cleanName}" (${cleanRole}) berhasil dibuat.`,
        user: { id: newId, email: cleanEmail, name: cleanName, role: cleanRole, password: cleanPass }
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  res.status(500).json({ success: false, message: 'Database server belum siap.' });
});

app.delete('/api/users/:id', (req, res) => {
  const userId = req.params.id;
  if (!userId) {
    return res.status(400).json({ success: false, message: 'ID Petugas wajib disertakan.' });
  }

  const cleanTarget = String(userId).trim().toLowerCase();

  if (cleanTarget === 'user_admin' || cleanTarget === 'admin@apar.id' || cleanTarget === 'admin') {
    return res.status(400).json({ success: false, message: 'Akun Admin utama tidak boleh dihapus.' });
  }

  if (sqliteDb) {
    try {
      let userEmail = '';
      let userName = cleanTarget;

      // Find details before deleting
      const userRow = sqliteDb.exec("SELECT id, email, name FROM users WHERE lower(id) = ? OR lower(email) = ?", [cleanTarget, cleanTarget]);
      if (userRow && userRow[0] && userRow[0].values && userRow[0].values.length > 0) {
        const [uId, uEm, uNm] = userRow[0].values[0];
        if (uEm) userEmail = String(uEm).toLowerCase().trim();
        if (uNm) userName = String(uNm).trim();
        sqliteDb.run("INSERT OR REPLACE INTO deleted_users (id, email, name) VALUES (?, ?, ?)", [
          String(uId).toLowerCase(), userEmail, userName
        ]);
      } else {
        sqliteDb.run("INSERT OR REPLACE INTO deleted_users (id, email, name) VALUES (?, ?, ?)", [
          cleanTarget, '', userName
        ]);
      }

      sqliteDb.run("DELETE FROM users WHERE lower(id) = ? OR lower(email) = ?", [
        cleanTarget, cleanTarget
      ]);

      persistSqliteToDisk();

      // Update USERS_FILE
      try {
        const all = sqliteDb.exec("SELECT id, email, name, password, role, created_at FROM users");
        if (all && all[0]) {
          const list = all[0].values.map(([id, email, name, password, role, created_at]) => ({
            id, email, name, password, role, created_at
          }));
          fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
        } else {
          fs.writeFileSync(USERS_FILE, '[]', 'utf-8');
        }
      } catch (e) {}

      broadcastUpdate({
        type: 'user_deleted',
        deletedUserId: cleanTarget,
        deletedUserEmail: userEmail,
        deletedUserName: userName,
        timestamp: Date.now()
      });

      return res.json({ success: true, message: 'Akun petugas berhasil dihapus.' });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  res.status(500).json({ success: false, message: 'Database server belum siap.' });
});

app.post('/api/auth/register', (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email && !name) {
    return res.status(400).json({ success: false, message: 'Nama atau email petugas wajib diisi.' });
  }

  const cleanName = name ? name.trim() : (email ? email.split('@')[0] : 'Petugas');
  const cleanEmail = email ? email.trim().toLowerCase() : `${cleanName.toLowerCase().replace(/[^a-z0-9]/g, '_')}@apar.id`;
  const cleanPass = password ? String(password).trim() : '123';
  const cleanRole = role || 'petugas';
  
  if (sqliteDb) {
    try {
      // Clear from deleted_users if re-registering
      sqliteDb.run("DELETE FROM deleted_users WHERE lower(email) = ? OR lower(name) = ?", [cleanEmail, cleanName.toLowerCase()]);

      const existing = sqliteDb.exec("SELECT id FROM users WHERE lower(email) = ? OR lower(name) = ?", [cleanEmail, cleanName.toLowerCase()]);
      if (existing && existing[0] && existing[0].values.length > 0) {
        sqliteDb.run("UPDATE users SET name = ?, password = ?, role = ? WHERE lower(email) = ?", [
          cleanName, cleanPass, cleanRole, cleanEmail
        ]);
      } else {
        const newId = 'user_' + Date.now();
        sqliteDb.run("INSERT INTO users (id, email, name, password, role) VALUES (?, ?, ?, ?, ?)", [
          newId, cleanEmail, cleanName, cleanPass, cleanRole
        ]);
      }
      persistSqliteToDisk();

      return res.json({
        success: true,
        message: 'Akun petugas aktif.',
        user: { email: cleanEmail, name: cleanName, role: cleanRole }
      });
    } catch (dbErr) {
      console.warn('Register db warning:', dbErr);
    }
  }

  return res.status(500).json({ success: false, message: 'Database server belum siap.' });
});

app.post('/api/auth/login', (req, res) => {
  const { identifier, email, username, password } = req.body;
  const inputId = (identifier || email || username || '').trim();
  const inputPass = password ? String(password).trim() : '';

  if (!inputId) {
    return res.status(400).json({ success: false, message: 'Nama atau ID Pengguna wajib diisi.' });
  }
  if (!inputPass) {
    return res.status(400).json({ success: false, message: 'PIN / Kata Sandi wajib diisi.' });
  }

  const cleanInput = inputId.toLowerCase();
  
  if (sqliteDb) {
    try {
      // 1. First, search for active user in users table
      const check = sqliteDb.exec(
        `SELECT id, email, name, password, role FROM users 
         WHERE lower(email) = ? 
            OR lower(name) = ? 
            OR lower(id) = ?
            OR lower(email) = ?
            OR ('user_' || lower(?)) = lower(id)
            OR lower(name) LIKE ?
         LIMIT 1`,
        [cleanInput, cleanInput, cleanInput, cleanInput + '@apar.id', cleanInput, cleanInput + '%']
      );

      if (check && check[0] && check[0].values.length > 0) {
        const [id, uEmail, uName, uPass, uRole] = check[0].values[0];
        const savedPass = String(uPass || '').trim();

        // Clear any stale deleted_users entry for this active account!
        sqliteDb.run(
          "DELETE FROM deleted_users WHERE lower(id) = ? OR lower(email) = ? OR lower(name) = ?",
          [String(id).toLowerCase(), String(uEmail || '').toLowerCase(), String(uName || '').toLowerCase()]
        );

        // STRICT password verification
        if (savedPass !== inputPass) {
          return res.status(401).json({
            success: false,
            message: 'Kata sandi atau PIN salah! Silakan periksa kembali.'
          });
        }

        const effectiveRole = uRole || (id === 'user_admin' || String(uName).toLowerCase().includes('admin') ? 'admin' : 'petugas');

        return res.json({
          success: true,
          message: `Login berhasil sebagai ${effectiveRole === 'admin' ? 'Admin' : 'Petugas'}.`,
          user: { id, email: uEmail, name: uName || inputId, role: effectiveRole }
        });
      }

      // 2. Only if NOT found in users table, check if user was deleted
      const isDeleted = sqliteDb.exec(
        "SELECT id, name FROM deleted_users WHERE (id IS NOT NULL AND trim(id) != '' AND lower(id) = ?) OR (email IS NOT NULL AND trim(email) != '' AND lower(email) = ?)",
        [cleanInput, cleanInput]
      );
      if (isDeleted && isDeleted[0] && isDeleted[0].values.length > 0) {
        return res.status(401).json({
          success: false,
          isDeleted: true,
          message: '⚠️ AKUN TIDAK TERSEDIA!\n\nAkun Anda telah dihapus oleh Admin K3 dan tidak dapat digunakan lagi.'
        });
      }

      return res.status(401).json({
        success: false,
        message: 'Akun tidak ditemukan! Pastikan Nama/ID benar atau hubungi Admin K3 untuk didaftarkan.'
      });
    } catch (dbErr) {
      console.warn('Login db warning:', dbErr);
    }
  }

  // Fallback if sqliteDb is busy or in-memory reload: check USERS_FILE
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf-8');
      const list = JSON.parse(raw) || [];
      const match = list.find(u => 
        (u.email && u.email.toLowerCase() === cleanInput) ||
        (u.name && u.name.toLowerCase() === cleanInput) ||
        (u.id && u.id.toLowerCase() === cleanInput) ||
        (u.id && u.id.toLowerCase() === 'user_' + cleanInput) ||
        (u.name && u.name.toLowerCase().startsWith(cleanInput))
      );

      if (match) {
        if (String(match.password || '').trim() === inputPass) {
          const effectiveRole = match.role || (match.id === 'user_admin' ? 'admin' : 'petugas');
          return res.json({
            success: true,
            message: `Login berhasil sebagai ${effectiveRole === 'admin' ? 'Admin' : 'Petugas'}.`,
            user: { id: match.id, email: match.email, name: match.name, role: effectiveRole }
          });
        } else {
          return res.status(401).json({
            success: false,
            message: 'Kata sandi atau PIN salah! Silakan periksa kembali.'
          });
        }
      }
    }
  } catch (fsErr) {}

  // Built-in hard fallback for default admin
  if (cleanInput === 'admin' || cleanInput === 'user_admin' || cleanInput === 'admin@apar.id') {
    if (inputPass === 'admin' || inputPass === '123') {
      return res.json({
        success: true,
        message: 'Login berhasil sebagai Admin.',
        user: { id: 'user_admin', email: 'admin@apar.id', name: 'Admin K3 / Pemeliharaan', role: 'admin' }
      });
    } else {
      return res.status(401).json({
        success: false,
        message: 'Kata sandi atau PIN salah! Silakan periksa kembali.'
      });
    }
  }

  return res.status(401).json({
    success: false,
    message: 'Akun tidak ditemukan! Pastikan Nama/ID benar atau hubungi Admin untuk didaftarkan.'
  });
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

// Helper function to reliably call Google Apps Script webhook
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

  try {
    // Standard fetch with redirect: 'follow' automatically handles Google's 302 redirect
    // by converting to GET for script.googleusercontent.com echo endpoint
    let response = await fetch(cleanUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: bodyStr,
      redirect: 'follow'
    });

    let text = await response.text();

    // If fetch didn't follow redirect automatically
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
      const redirectUrl = response.headers.get('location');
      response = await fetch(redirectUrl, { method: 'GET' });
      text = await response.text();
    }

    return {
      status: response.status,
      ok: response.ok || response.status === 200,
      text: text
    };
  } catch (err) {
    console.warn('POST to Google Apps Script failed:', err.message);
    return {
      status: 500,
      ok: false,
      text: err.message
    };
  }
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
    const text = (gasResult.text || '').trim();

    // 3. Detect HTML responses (Google Sign-In / Access Denied / 404 / Error Pages)
    const isHtml = text.startsWith('<') || text.includes('<!DOCTYPE html>') || text.includes('<html');

    if (isHtml) {
      if (text.includes('accounts.google.com') || text.includes('Sign in') || text.includes('serviceLogin') || text.includes('authorization_required')) {
        return res.status(400).json({
          success: false,
          message: 'Akses Ditolak Google: Pengaturan "Who has access" di Google Apps Script belum diset ke "Anyone" (Siapa saja). Solusi: Buka Google Apps Script > Deploy > Manage deployments > Edit > ganti "Who has access" ke "Anyone" > Deploy ulang.'
        });
      }

      if (text.includes('Script function not found') || text.includes('doGet') || text.includes('doPost')) {
        return res.status(400).json({
          success: false,
          message: 'Fungsi doPost/doGet tidak ditemukan di Google Apps Script. Pastikan Anda telah menyalin seluruh kode di tutorial (termasuk doGet & doPost) lalu buat "New deployment".'
        });
      }

      if (gasResult.status === 405 || text.includes('405') || text.includes('Method Not Allowed')) {
        return res.status(400).json({
          success: false,
          message: 'Google Apps Script mengembalikan 405 Not Allowed. Solusi: Buka Google Apps Script > Klik "Deploy" > "Manage deployments" > Edit (ikon pensil) > Version: pilih "New version" > Klik "Deploy".'
        });
      }

      return res.status(400).json({
        success: false,
        message: 'Google Apps Script mengembalikan halaman HTML (bukan respon JSON). Pastikan "Who has access" diatur ke "Anyone", sertakan fungsi doGet & doPost, lalu buat New Deployment.'
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
      const errMsg = result.error || result.message || 'Google Apps Script mengembalikan error. Periksa kembali script Anda.';
      return res.status(gasResult.status >= 400 ? gasResult.status : 400).json({
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

