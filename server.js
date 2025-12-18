const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');
const si = require('systeminformation');

const app = express();
const PORT = 3001;

const DATA_DIR = '/var/www/fleetvision-data';
const DB_FILE = path.join(DATA_DIR, 'fleetvision.sqlite');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new sqlite3.Database(DB_FILE);
db.configure('busyTimeout', 5000);
db.run("PRAGMA journal_mode = WAL;");

// --- TRACCAR CONFIG ---
let traccarConfig = { url: 'http://127.0.0.1:8082', token: '' };
const updateConfig = () => {
  db.get("SELECT value FROM config WHERE key = 'system'", (err, row) => {
    if(row) {
      try {
        const c = JSON.parse(row.value);
        traccarConfig.url = (c.traccarUrl || 'http://127.0.0.1:8082').replace(/\/$/, '');
        traccarConfig.token = c.traccarToken;
      } catch (e) {}
    }
  });
};
updateConfig();
setInterval(updateConfig, 60000);

// ==================================================================
// 1. MIDDLEWARES GLOBAIS (CORS PRIMEIRO!)
// ==================================================================
app.use(cors()); // <--- CORS deve vir ANTES de tudo para evitar bloqueios 502/Network Error

// ==================================================================
// 2. PROXY (API TRACCAR)
// ==================================================================
const proxyOptions = {
  target: 'http://127.0.0.1:8082',
  router: () => traccarConfig.url,
  changeOrigin: true,
  pathRewrite: (path) => path.startsWith('/api') ? path : '/api' + path,
  onProxyReq: (proxyReq, req) => {
    if (traccarConfig.token) proxyReq.setHeader('Authorization', `Bearer ${traccarConfig.token}`);
    if (req.method === 'POST' || req.method === 'PUT') {
        proxyReq.setHeader('Content-Type', 'application/json');
    }
  },
  onError: (err, req, res) => {
    console.error('Proxy Error:', err.message);
    if(!res.headersSent) res.status(502).json({ error: 'Erro de Conexão com Traccar', details: err.message });
  }
};

app.use('/api', createProxyMiddleware(proxyOptions));
app.use('/notifications', createProxyMiddleware(proxyOptions));

// ==================================================================
// 3. STORAGE (BANCO DE DADOS LOCAL)
// ==================================================================
const storageApp = express.Router();
storageApp.use(bodyParser.json({ limit: '50mb' }));
storageApp.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
storageApp.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, 'file-' + Date.now() + path.extname(file.originalname))
})});

// Rota Específica para Perfis (Garante que funciona mesmo se a genérica falhar)
storageApp.get('/profiles', (req, res) => {
  db.all("SELECT * FROM profiles ORDER BY name", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const profiles = rows.map(r => {
        try { return { ...r, permissions: JSON.parse(r.permissions || '[]') }; }
        catch { return { ...r, permissions: [] }; }
    });
    res.json(profiles);
  });
});

storageApp.post('/profiles', (req, res) => {
  const { name, permissions } = req.body;
  db.run("INSERT INTO profiles (name, permissions) VALUES (?, ?)", [name, JSON.stringify(permissions || [])], function(err) {
    if(err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

// Config & Status
storageApp.get('/status', async (req, res) => {
  try {
    const [cpu, mem, disk, os] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize(), si.osInfo()]);
    res.json({ cpu: cpu.currentLoad, ram: mem.total, disk: disk[0].size, os: os.distro });
  } catch (e) { res.json({cpu:0}); }
});
storageApp.get('/config', (req, res) => { db.get("SELECT value FROM config WHERE key = 'system'", (err, row) => res.json(row ? JSON.parse(row.value) : {})); });
storageApp.post('/config', (req, res) => { db.run("INSERT OR REPLACE INTO config (key, value) VALUES ('system', ?)", [JSON.stringify(req.body)], () => { updateConfig(); res.json({ success: true }); }); });
storageApp.post('/upload', upload.single('file'), (req, res) => { if(!req.file) return res.status(400).json({error:'Erro'}); res.json({ url: `/storage/uploads/${req.file.filename}` }); });

// CRUD Genérico (Fallback)
storageApp.get('/:key', (req, res, next) => { 
  if(['config','upload','status','profiles','asaas'].includes(req.params.key)) return next();
  db.all(`SELECT json FROM ${req.params.key}`, (e,r) => {
    if(e) return res.json([]); // Retorna array vazio em caso de erro de tabela inexistente
    res.json(r ? r.map(x=>JSON.parse(x.json)) : []);
  }); 
});
storageApp.post('/:key', (req, res, next) => { 
  if(['config','upload','profiles','asaas'].includes(req.params.key)) return next();
  const list = Array.isArray(req.body) ? req.body : [req.body];
  db.serialize(() => {
    db.run(`DELETE FROM ${req.params.key}`); 
    const stmt = db.prepare(`INSERT INTO ${req.params.key} (id,json) VALUES (?,?)`); 
    list.forEach(i => stmt.run(i.id || Date.now(), JSON.stringify(i))); 
    stmt.finalize(); 
    res.json({success:true});
  }); 
});
storageApp.delete('/:key/:id', (req, res, next) => { 
  if(['config','upload','profiles','asaas'].includes(req.params.key)) return next();
  db.run(`DELETE FROM ${req.params.key} WHERE id=?`, [req.params.id], ()=>res.json({success:true})); 
});

app.use('/storage', storageApp);

// Garante tabelas
db.serialize(() => {
  const tables = ["config","clients","drivers","user_devices","custom_icons","profiles","custom_events","alert_rules","route_schedules","maint_plans","maint_logs","geofences","checklists","checklist_templates"];
  tables.forEach(t => db.run(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY, json TEXT)`));
  // Tabela específica para profiles se não existir
  db.run("CREATE TABLE IF NOT EXISTS profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, permissions TEXT)");
});

app.listen(PORT, () => console.log(`Backend running ${PORT}`));
