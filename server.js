import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// High body size limit for base64 photos
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Ensure data storage directory exists
const DATA_DIR = path.join(__dirname, 'data_storage');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const LOG_FILE = path.join(DATA_DIR, 'apar_log.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function loadLogsFromFile() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, 'utf-8');
      return JSON.parse(raw) || {};
    }
  } catch (err) {
    console.error('Error reading apar_log.json:', err);
  }
  return {};
}

function saveLogsToFile(logs) {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing apar_log.json:', err);
  }
}

function loadUsersFromFile() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const raw = fs.readFileSync(USERS_FILE, 'utf-8');
      return JSON.parse(raw) || [];
    }
  } catch (err) {
    console.error('Error reading users.json:', err);
  }
  return [];
}

function saveUsersToFile(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing users.json:', err);
  }
}

let IN_MEMORY_LOGS = loadLogsFromFile();
let IN_MEMORY_USERS = loadUsersFromFile();

// List of connected SSE clients for instant broadcast
let sseClients = [];

function broadcastUpdate(payload) {
  const dataString = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(dataString);
    } catch (e) {
      // client disconnected
    }
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

  // Send initial snapshot
  const initialPayload = {
    type: 'init',
    count: Object.keys(IN_MEMORY_LOGS).length,
    logs: IN_MEMORY_LOGS,
    timestamp: Date.now()
  };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  // Periodic heartbeat to prevent mobile timeouts
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
// REST API Endpoints for Logs
// -------------------------------------------------------------
app.get('/api/apar_log', (req, res) => {
  res.json({
    success: true,
    count: Object.keys(IN_MEMORY_LOGS).length,
    logs: IN_MEMORY_LOGS
  });
});

app.post('/api/apar_log', (req, res) => {
  const entry = req.body;
  if (!entry || (!entry.kode && !entry.id)) {
    return res.status(400).json({ success: false, message: 'Kode atau ID APAR wajib disertakan.' });
  }

  const docId = String(entry.kode || entry.id).trim();
  IN_MEMORY_LOGS[docId] = entry;
  if (entry.id) IN_MEMORY_LOGS[String(entry.id).trim()] = entry;
  if (entry.kode) IN_MEMORY_LOGS[String(entry.kode).trim()] = entry;

  saveLogsToFile(IN_MEMORY_LOGS);

  // Instant broadcast to all connected devices in realtime
  broadcastUpdate({
    type: 'update',
    docId,
    entry,
    totalLogs: Object.keys(IN_MEMORY_LOGS).length,
    timestamp: Date.now()
  });

  res.json({
    success: true,
    message: 'Data berhasil disimpan dan disiarkan secara real-time ke semua perangkat.',
    docId,
    totalLogs: Object.keys(IN_MEMORY_LOGS).length
  });
});

// Reset log if needed
app.delete('/api/apar_log', (req, res) => {
  IN_MEMORY_LOGS = {};
  saveLogsToFile(IN_MEMORY_LOGS);
  broadcastUpdate({ type: 'reset', timestamp: Date.now() });
  res.json({ success: true, message: 'Semua log berhasil direset.' });
});

// -------------------------------------------------------------
// User Authentication Endpoints (Shared across all users)
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email dan password wajib diisi.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const existing = IN_MEMORY_USERS.find(u => u.email.toLowerCase() === cleanEmail);
  if (existing) {
    return res.status(400).json({ success: false, message: 'Email ini sudah terdaftar. Silakan masuk (login).' });
  }

  const newUser = {
    id: 'user_' + Date.now(),
    email: cleanEmail,
    name: name ? name.trim() : cleanEmail.split('@')[0],
    password: String(password), // simple secure storage
    createdAt: new Date().toISOString()
  };

  IN_MEMORY_USERS.push(newUser);
  saveUsersToFile(IN_MEMORY_USERS);

  res.json({
    success: true,
    message: 'Akun berhasil didaftarkan.',
    user: { email: newUser.email, name: newUser.name }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email dan password wajib diisi.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const user = IN_MEMORY_USERS.find(u => u.email.toLowerCase() === cleanEmail);

  if (!user || user.password !== String(password)) {
    return res.status(401).json({ success: false, message: 'Email atau password salah.' });
  }

  res.json({
    success: true,
    message: 'Login berhasil.',
    user: { email: user.email, name: user.name }
  });
});

// Static assets
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 APAR Realtime Server running at http://0.0.0.0:${PORT}`);
});

