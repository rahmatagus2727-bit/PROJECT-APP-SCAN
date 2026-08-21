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
const ARCHIVES_FILE = path.join(DATA_DIR, 'period_archives.json');

// Indonesian Month Names
const MONTH_NAMES_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

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

    CREATE TABLE IF NOT EXISTS period_archives (
      id TEXT PRIMARY KEY,
      period_key TEXT UNIQUE,
      period_label TEXT,
      total_items INTEGER DEFAULT 0,
      good_items INTEGER DEFAULT 0,
      bad_items INTEGER DEFAULT 0,
      raw_data TEXT,
      gdrive_sheet_url TEXT,
      archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      archived_by TEXT
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

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT,
      title TEXT,
      message TEXT,
      kode TEXT,
      pemeriksa TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_read INTEGER DEFAULT 0
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
// Settings & Monthly Cycle Configuration
// -------------------------------------------------------------
function loadSettingsFromFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw) || {};
    }
  } catch (err) {}
  return { googleScriptUrl: '', autoSyncGdrive: false, autoCycleOnComplete: true };
}

function saveSettingsToFile(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {}
}

let APP_SETTINGS = loadSettingsFromFile();

// Helper: Get Current Period Information & Deadline
function getCurrentPeriodInfo() {
  const now = new Date();
  const year = now.getFullYear();
  const monthIdx = now.getMonth();
  const monthNum = String(monthIdx + 1).padStart(2, '0');
  const monthName = MONTH_NAMES_ID[monthIdx];
  const defPeriodKey = `${year}-${monthNum}`;
  const defPeriodLabel = `${monthName} ${year}`;

  const activeKey = APP_SETTINGS.activePeriodKey || defPeriodKey;
  const activeLabel = APP_SETTINGS.activePeriodLabel || defPeriodLabel;

  let targetYear = year;
  let targetMonthNum = monthIdx + 1;
  if (activeKey && activeKey.includes('-')) {
    const [y, m] = activeKey.split('-').map(Number);
    if (y && m) {
      targetYear = y;
      targetMonthNum = m;
    }
  }

  const lastDay = new Date(targetYear, targetMonthNum, 0).getDate();
  const targetMonthName = MONTH_NAMES_ID[targetMonthNum - 1] || monthName;
  const deadlineStr = `${lastDay} ${targetMonthName} ${targetYear}`;

  const today = new Date();
  const deadlineDate = new Date(targetYear, targetMonthNum - 1, lastDay, 23, 59, 59);
  const diffMs = deadlineDate.getTime() - today.getTime();
  const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  const isNearDeadline = daysRemaining <= 5;

  return {
    activePeriodKey: activeKey,
    activePeriodLabel: activeLabel,
    year: targetYear,
    monthName: targetMonthName,
    monthNum: targetMonthNum,
    deadlineDate: deadlineStr,
    daysRemaining,
    isNearDeadline,
    autoCycleOnComplete: APP_SETTINGS.autoCycleOnComplete !== false
  };
}

function computeNextPeriod(currentPeriodKey) {
  let [y, m] = (currentPeriodKey || '').split('-').map(Number);
  if (!y || !m) {
    const now = new Date();
    y = now.getFullYear();
    m = now.getMonth() + 1;
  }
  m += 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  const monthIdx = m - 1;
  const monthNum = String(m).padStart(2, '0');
  const monthName = MONTH_NAMES_ID[monthIdx];
  const nextKey = `${y}-${monthNum}`;
  const nextLabel = `${monthName} ${y}`;
  const lastDay = new Date(y, m, 0).getDate();
  return {
    periodKey: nextKey,
    periodLabel: nextLabel,
    year: y,
    monthName,
    monthNum: m,
    deadlineDate: `${lastDay} ${monthName} ${y}`
  };
}

function getAllPeriodArchivesFromSqlite() {
  if (!sqliteDb) {
    if (fs.existsSync(ARCHIVES_FILE)) {
      try { return JSON.parse(fs.readFileSync(ARCHIVES_FILE, 'utf-8')) || []; } catch (e) {}
    }
    return [];
  }
  try {
    const res = sqliteDb.exec(`SELECT id, period_key, period_label, total_items, good_items, bad_items, raw_data, gdrive_sheet_url, archived_at, archived_by FROM period_archives ORDER BY datetime(archived_at) DESC`);
    if (!res || !res[0]) {
      if (fs.existsSync(ARCHIVES_FILE)) {
        try { return JSON.parse(fs.readFileSync(ARCHIVES_FILE, 'utf-8')) || []; } catch (e) {}
      }
      return [];
    }
    const cols = res[0].columns;
    const list = res[0].values.map(row => {
      const obj = {};
      cols.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
    return list;
  } catch (e) {
    console.warn('Error querying period archives:', e);
    return [];
  }
}

async function archiveCurrentPeriodAndStartNext(triggeredBy = 'Sistem', customNextKey = null) {
  const currentInfo = getCurrentPeriodInfo();
  const currentLogs = getAllInspectionsFromSqlite();
  const logValues = Object.values(currentLogs);
  const totalItems = logValues.length;
  
  let goodItems = 0;
  let badItems = 0;
  logValues.forEach(item => {
    if (item.status === 'OK' || item.status === 'good') goodItems++;
    else badItems++;
  });

  const nextInfo = customNextKey ? {
    periodKey: customNextKey,
    periodLabel: customNextKey
  } : computeNextPeriod(currentInfo.activePeriodKey);

  const archiveId = `archive_${currentInfo.activePeriodKey}_${Date.now()}`;
  const rawDataJson = JSON.stringify(currentLogs);
  const nowIso = new Date().toISOString();

  // Save to SQLite archives
  if (sqliteDb) {
    try {
      sqliteDb.run(`
        INSERT OR REPLACE INTO period_archives (
          id, period_key, period_label, total_items, good_items, bad_items, raw_data, archived_at, archived_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        archiveId,
        currentInfo.activePeriodKey,
        currentInfo.activePeriodLabel,
        totalItems,
        goodItems,
        badItems,
        rawDataJson,
        nowIso,
        triggeredBy
      ]);

      // Reset active inspections in SQLite so the new month starts completely fresh (0 progress)
      sqliteDb.run("DELETE FROM inspections");

      // Log to audit table
      sqliteDb.run(`
        INSERT INTO audit_logs (action, details, pemeriksa)
        VALUES ('PERIOD_ARCHIVED_AND_CYCLED', ?, ?)
      `, [
        `Periode ${currentInfo.activePeriodLabel} diarsipkan (${totalItems} APAR). Memulai periode baru ${nextInfo.periodLabel}.`,
        triggeredBy
      ]);

      persistSqliteToDisk();
    } catch (dbErr) {
      console.error('Error archiving period in SQLite:', dbErr);
    }
  }

  // Sync / Reset local JSON files
  try {
    let archivesList = [];
    if (fs.existsSync(ARCHIVES_FILE)) {
      try { archivesList = JSON.parse(fs.readFileSync(ARCHIVES_FILE, 'utf-8')) || []; } catch (e) {}
    }
    archivesList = archivesList.filter(a => a.period_key !== currentInfo.activePeriodKey);
    archivesList.unshift({
      id: archiveId,
      period_key: currentInfo.activePeriodKey,
      period_label: currentInfo.activePeriodLabel,
      total_items: totalItems,
      good_items: goodItems,
      bad_items: badItems,
      archived_at: nowIso,
      archived_by: triggeredBy
    });
    fs.writeFileSync(ARCHIVES_FILE, JSON.stringify(archivesList, null, 2), 'utf-8');

    // Reset current active log JSON
    fs.writeFileSync(LOG_FILE, '{}', 'utf-8');
  } catch (fsErr) {
    console.warn('JSON file archive sync notice:', fsErr);
  }

  // Update Settings to next period
  APP_SETTINGS.activePeriodKey = nextInfo.periodKey;
  APP_SETTINGS.activePeriodLabel = nextInfo.periodLabel;
  saveSettingsToFile(APP_SETTINGS);

  // Add system notification
  const cycleNotif = addNotificationToSqlite({
    type: 'period_cycled',
    title: `🎉 Periode Baru Dimulai: ${nextInfo.periodLabel}`,
    message: `Periode ${currentInfo.activePeriodLabel} telah berhasil diselesaikan & diarsipkan (${totalItems} APAR). Siklus tugas checklist telah di-refresh untuk ${nextInfo.periodLabel} (Tenggat: ${nextInfo.deadlineDate || 'Akhir Bulan'}).`,
    kode: 'CYCLE',
    pemeriksa: triggeredBy,
    details: JSON.stringify({
      archivedPeriod: currentInfo.activePeriodLabel,
      newPeriod: nextInfo.periodLabel,
      totalArchived: totalItems
    })
  });

  // Sync to Google Apps Script (create new sheet tab for next month & archive current month)
  const targetScriptUrl = APP_SETTINGS.googleScriptUrl || '';
  if (targetScriptUrl && targetScriptUrl.startsWith('http')) {
    callGoogleAppsScript(targetScriptUrl, {
      action: 'archive_month',
      periodLabel: currentInfo.activePeriodLabel,
      periodKey: currentInfo.activePeriodKey,
      nextPeriodLabel: nextInfo.periodLabel,
      nextPeriodKey: nextInfo.periodKey,
      totalItems: totalItems,
      items: logValues
    }).catch(gasErr => {
      console.warn('GAS Archive month webhook notice:', gasErr.message);
    });
  }

  // Real-time broadcast to all connected devices
  broadcastUpdate({
    type: 'period_cycled',
    archivedPeriod: {
      key: currentInfo.activePeriodKey,
      label: currentInfo.activePeriodLabel,
      totalItems
    },
    newPeriod: {
      key: nextInfo.periodKey,
      label: nextInfo.periodLabel,
      deadlineDate: nextInfo.deadlineDate
    },
    notification: cycleNotif,
    timestamp: Date.now()
  });

  return {
    success: true,
    archivedPeriod: currentInfo,
    newPeriod: nextInfo,
    totalArchived: totalItems
  };
}

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

function addNotificationToSqlite(notif) {
  if (!sqliteDb) return null;
  try {
    const id = notif.id || `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const type = notif.type || 'info';
    const title = notif.title || 'Notifikasi';
    const message = notif.message || '';
    const kode = notif.kode || '';
    const pemeriksa = notif.pemeriksa || '';
    const details = typeof notif.details === 'string' ? notif.details : JSON.stringify(notif.details || {});
    const createdAt = notif.created_at || new Date().toISOString();
    const isRead = notif.is_read ? 1 : 0;

    sqliteDb.run(`
      INSERT OR REPLACE INTO notifications (id, type, title, message, kode, pemeriksa, details, created_at, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, type, title, message, kode, pemeriksa, details, createdAt, isRead]);

    persistSqliteToDisk();

    const fullNotif = { id, type, title, message, kode, pemeriksa, details, created_at: createdAt, is_read: isRead };
    
    // Instant broadcast notification to all users in real-time
    broadcastUpdate({
      type: 'notification',
      notification: fullNotif,
      unreadCount: getUnreadNotificationCount(),
      timestamp: Date.now()
    });

    return fullNotif;
  } catch (err) {
    console.warn('Error adding notification to SQLite:', err);
    return null;
  }
}

function getRecentNotificationsFromSqlite(limit = 100) {
  if (!sqliteDb) return [];
  try {
    const res = sqliteDb.exec(`SELECT id, type, title, message, kode, pemeriksa, details, created_at, is_read FROM notifications ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ${limit}`);
    if (!res || !res[0]) return [];
    const cols = res[0].columns;
    return res[0].values.map(row => {
      const obj = {};
      cols.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  } catch (e) {
    return [];
  }
}

function getUnreadNotificationCount() {
  if (!sqliteDb) return 0;
  try {
    const res = sqliteDb.exec(`SELECT COUNT(*) FROM notifications WHERE is_read = 0`);
    return res[0]?.values[0]?.[0] || 0;
  } catch (e) {
    return 0;
  }
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
  const notifs = getRecentNotificationsFromSqlite(30);
  const unreadCount = getUnreadNotificationCount();
  const periodInfo = getCurrentPeriodInfo();

  // Send initial snapshot with inspections, notifications, and period cycle info
  const initialPayload = {
    type: 'init',
    count: Object.keys(logs).length,
    logs: logs,
    notifications: notifs,
    unreadCount: unreadCount,
    period: periodInfo,
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

// Notification REST Endpoints
app.get('/api/notifications', (req, res) => {
  const notifs = getRecentNotificationsFromSqlite(100);
  const unreadCount = getUnreadNotificationCount();
  res.json({
    success: true,
    notifications: notifs,
    unreadCount: unreadCount
  });
});

app.post('/api/notifications/read', (req, res) => {
  if (sqliteDb) {
    try {
      const { id } = req.body || {};
      if (id) {
        sqliteDb.run("UPDATE notifications SET is_read = 1 WHERE id = ?", [id]);
      } else {
        sqliteDb.run("UPDATE notifications SET is_read = 1");
      }
      persistSqliteToDisk();
    } catch (e) {
      console.warn('Error marking notifications as read:', e);
    }
  }
  const unreadCount = getUnreadNotificationCount();
  broadcastUpdate({ type: 'notifications_read', unreadCount, timestamp: Date.now() });
  res.json({ success: true, unreadCount });
});

app.delete('/api/notifications', (req, res) => {
  if (sqliteDb) {
    try {
      sqliteDb.run("DELETE FROM notifications");
      persistSqliteToDisk();
    } catch (e) {}
  }
  broadcastUpdate({ type: 'notifications_cleared', unreadCount: 0, timestamp: Date.now() });
  res.json({ success: true, message: 'Semua log notifikasi telah dibersihkan.' });
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

  // Create real-time notification for all users & admin
  const petugasName = entry.pemeriksa || 'Petugas Lapangan';
  const lokasiStr = [entry.ruangan, entry.gedung ? `Gd. ${entry.gedung}` : ''].filter(Boolean).join(' - ') || 'Lokasi Terdaftar';
  
  const notifObj = addNotificationToSqlite({
    type: 'task_submitted',
    title: `📋 Tugas Masuk: APAR Kode ${docId}`,
    message: `Pemeriksaan APAR Kode ${docId} (${lokasiStr}) telah selesai dikerjakan oleh ${petugasName}. Status: ${entry.status || 'OK'}.`,
    kode: docId,
    pemeriksa: petugasName,
    details: JSON.stringify({
      kode: docId,
      ruangan: entry.ruangan || '',
      gedung: entry.gedung || '',
      status: entry.status || 'OK',
      pemeriksa: petugasName,
      hasPhoto: !!entry.foto
    })
  });

  // Instant broadcast to all connected devices in realtime via SSE
  broadcastUpdate({
    type: 'update',
    docId,
    entry,
    notification: notifObj,
    totalLogs: Object.keys(logs).length,
    timestamp: Date.now()
  });

  // Background Automatic Sync to Google Sheets & Drive (Single Centralized Database)
  const targetScriptUrl = APP_SETTINGS.googleScriptUrl || '';
  if (targetScriptUrl && targetScriptUrl.startsWith('http')) {
    const periodInfo = getCurrentPeriodInfo();
    const gasPayload = {
      ...entry,
      periodLabel: entry.periodLabel || periodInfo.activePeriodLabel,
      periodKey: entry.periodKey || periodInfo.activePeriodKey
    };
    callGoogleAppsScript(targetScriptUrl, gasPayload)
      .then(gasRes => {
        console.log(`⚡ Auto-synced inspection ${docId} to Google Sheets (${gasPayload.periodLabel}). OK:`, gasRes.ok);
      })
      .catch(gasErr => {
        console.warn(`⚠️ Background Google Sheets sync error for ${docId}:`, gasErr.message);
      });
  }

  res.json({
    success: true,
    message: 'Data berhasil disimpan ke database SQLite, disiarkan secara real-time, dan disinkronkan ke Google Sheets.',
    docId,
    notification: notifObj,
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

  // Create real-time notification about deleted task
  const delNotif = addNotificationToSqlite({
    type: 'task_deleted',
    title: `🗑️ Data Dihapus: APAR Kode ${cleanId}`,
    message: `Data pemeriksaan APAR Kode ${cleanId} telah dihapus dari riwayat sistem.`,
    kode: cleanId,
    pemeriksa: req.query.pemeriksa || 'Admin/Petugas',
    details: JSON.stringify({ kode: cleanId })
  });

  // Instant broadcast via SSE to ALL connected clients
  broadcastUpdate({
    type: 'delete_single',
    docId: cleanId,
    notification: delNotif,
    totalLogs: Object.keys(currentLogs).length,
    timestamp: Date.now()
  });

  // Auto delete in Google Sheets if URL configured
  const targetScriptUrl = APP_SETTINGS.googleScriptUrl || '';
  if (targetScriptUrl && targetScriptUrl.startsWith('http')) {
    callGoogleAppsScript(targetScriptUrl, { action: 'delete', kode: cleanId, id: cleanId }).catch(() => {});
  }

  res.json({ success: true, message: `Log ${cleanId} berhasil dihapus.`, notification: delNotif, totalLogs: Object.keys(currentLogs).length });
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

  const resetNotif = addNotificationToSqlite({
    type: 'system_reset',
    title: `⚠️ Riwayat Direset: Seluruh Data Dikosongkan`,
    message: `Seluruh riwayat pemeriksaan APAR di database telah direset oleh Administrator K3.`,
    kode: 'ALL',
    pemeriksa: 'Admin K3',
    details: '{}'
  });

  broadcastUpdate({ type: 'reset', notification: resetNotif, timestamp: Date.now() });
  res.json({ success: true, message: 'Semua log SQLite berhasil direset.', notification: resetNotif });
});

// -------------------------------------------------------------
// Period & Monthly Task Cycling Endpoints
// -------------------------------------------------------------
app.get('/api/periods', (req, res) => {
  const currentInfo = getCurrentPeriodInfo();
  const archives = getAllPeriodArchivesFromSqlite();
  const activeLogs = getAllInspectionsFromSqlite();
  const totalActive = Object.keys(activeLogs).length;

  res.json({
    success: true,
    activePeriod: currentInfo,
    totalActive,
    archives: archives.map(a => ({
      id: a.id,
      period_key: a.period_key,
      period_label: a.period_label,
      total_items: a.total_items,
      good_items: a.good_items,
      bad_items: a.bad_items,
      archived_at: a.archived_at,
      archived_by: a.archived_by
    }))
  });
});

app.post('/api/periods/next', async (req, res) => {
  const triggeredBy = req.body?.triggeredBy || req.body?.pemeriksa || 'Admin K3';
  const customNextKey = req.body?.customNextKey || null;

  try {
    const cycleResult = await archiveCurrentPeriodAndStartNext(triggeredBy, customNextKey);
    res.json({
      success: true,
      message: `Periode ${cycleResult.archivedPeriod.activePeriodLabel} berhasil diarsipkan. Siklus baru untuk ${cycleResult.newPeriod.periodLabel} siap digunakan!`,
      data: cycleResult
    });
  } catch (err) {
    console.error('Error cycling period:', err);
    res.status(500).json({ success: false, message: 'Gagal menyelesaikan siklus periode: ' + err.message });
  }
});

app.get('/api/periods/archive/:periodKey', (req, res) => {
  const periodKey = req.params.periodKey;
  if (!periodKey) {
    return res.status(400).json({ success: false, message: 'Period key wajib disertakan.' });
  }

  let foundArchive = null;
  if (sqliteDb) {
    try {
      const result = sqliteDb.exec("SELECT id, period_key, period_label, total_items, good_items, bad_items, raw_data, archived_at, archived_by FROM period_archives WHERE period_key = ? OR id = ?", [periodKey, periodKey]);
      if (result && result[0] && result[0].values[0]) {
        const row = result[0].values[0];
        let rawData = {};
        try { rawData = JSON.parse(row[6]); } catch (e) {}
        foundArchive = {
          id: row[0],
          period_key: row[1],
          period_label: row[2],
          total_items: row[3],
          good_items: row[4],
          bad_items: row[5],
          data: rawData,
          archived_at: row[7],
          archived_by: row[8]
        };
      }
    } catch (e) {
      console.warn('Archive query error:', e);
    }
  }

  if (!foundArchive && fs.existsSync(ARCHIVES_FILE)) {
    try {
      const archives = JSON.parse(fs.readFileSync(ARCHIVES_FILE, 'utf-8')) || [];
      const match = archives.find(a => a.period_key === periodKey || a.id === periodKey);
      if (match) {
        foundArchive = match;
      }
    } catch (e) {}
  }

  if (!foundArchive) {
    return res.status(404).json({ success: false, message: `Arsip untuk periode ${periodKey} tidak ditemukan.` });
  }

  res.json({
    success: true,
    archive: foundArchive
  });
});

app.post('/api/periods/config', (req, res) => {
  const { activePeriodKey, activePeriodLabel, autoCycleOnComplete } = req.body || {};
  if (activePeriodKey) APP_SETTINGS.activePeriodKey = activePeriodKey;
  if (activePeriodLabel) APP_SETTINGS.activePeriodLabel = activePeriodLabel;
  if (typeof autoCycleOnComplete === 'boolean') APP_SETTINGS.autoCycleOnComplete = autoCycleOnComplete;

  saveSettingsToFile(APP_SETTINGS);

  const currentInfo = getCurrentPeriodInfo();
  broadcastUpdate({
    type: 'period_config_updated',
    period: currentInfo,
    timestamp: Date.now()
  });

  res.json({
    success: true,
    message: 'Pengaturan periode berhasil diperbarui.',
    period: currentInfo
  });
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

