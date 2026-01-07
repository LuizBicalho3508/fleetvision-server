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

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// --- TRACCAR PROXY ---
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

const proxyOptions = {
  target: 'http://127.0.0.1:8082',
  router: () => traccarConfig.url,
  changeOrigin: true,
  pathRewrite: (path) => path.startsWith('/api') ? path : '/api' + path,
  onProxyReq: (proxyReq, req) => {
    if (traccarConfig.token) proxyReq.setHeader('Authorization', `Bearer ${traccarConfig.token}`);
    if (req.method === 'POST' || req.method === 'PUT') proxyReq.setHeader('Content-Type', 'application/json');
  },
  onError: (err, req, res) => { if(!res.headersSent) res.status(502).json({ error: 'Erro Traccar', details: err.message }); }
};

app.use('/api', createProxyMiddleware(proxyOptions));
app.use('/notifications', createProxyMiddleware(proxyOptions));

// --- STORAGE ---
const storageApp = express.Router();
// IMPORTANTE: Serve a pasta de uploads na rota /uploads
storageApp.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, 'file-' + Date.now() + path.extname(file.originalname))
})});

// Rota Status Simplificada (Evita travamento Admin)
storageApp.get('/status', async (req, res) => {
  try {
    const mem = await si.mem();
    res.json({
      cpu: 10, // Mock para evitar delay excessivo
      ram: { total: mem.total, used: mem.used, percent: (mem.used/mem.total)*100 },
      disk: { total: 0, used: 0, percent: 0 },
      uptime: si.time().uptime,
      os: 'Linux VPS'
    });
  } catch (e) {
    res.json({ cpu: 0, ram: {}, disk: {}, uptime: 0, os: 'Error' });
  }
});

// Ícones Customizados
storageApp.get('/custom_icons', (req, res) => {
  db.all("SELECT * FROM custom_icons", (err, rows) => {
    if (err) return res.status(500).json([]);
    const icons = rows.map(r => { try { return JSON.parse(r.json); } catch { return { id: r.id, url: '', name: 'Error' }; } });
    res.json(icons);
  });
});

storageApp.post('/custom_icons', (req, res) => {
  const { name, url } = req.body;
  const id = Date.now();
  const json = JSON.stringify({ id, name, url });
  db.run("INSERT INTO custom_icons (id, json) VALUES (?, ?)", [id, json], function(err) {
    if(err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id, name, url });
  });
});

storageApp.delete('/custom_icons/:id', (req, res) => {
  db.run("DELETE FROM custom_icons WHERE id = ?", [req.params.id], (err) => res.json({ success: true }));
});

// Rotas Padrão
storageApp.get('/config', (req, res) => { db.get("SELECT value FROM config WHERE key = 'system'", (err, row) => res.json(row ? JSON.parse(row.value) : {})); });
storageApp.post('/config', (req, res) => { db.run("INSERT OR REPLACE INTO config (key, value) VALUES ('system', ?)", [JSON.stringify(req.body)], () => { updateConfig(); res.json({ success: true }); }); });
storageApp.post('/upload', upload.single('file'), (req, res) => { if(!req.file) return res.status(400).json({error:'Erro'}); res.json({ url: `/storage/uploads/${req.file.filename}` }); });

// CRUD Genérico
storageApp.get('/:key', (req, res, next) => { 
  if(['config','upload','status','custom_icons'].includes(req.params.key)) return next();
  db.all(`SELECT json FROM ${req.params.key}`, (e,r) => res.json(r ? r.map(x=>JSON.parse(x.json)) : [])); 
});
storageApp.post('/:key', (req, res, next) => { 
  if(['config','upload','custom_icons'].includes(req.params.key)) return next();
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
  if(['config','upload','custom_icons'].includes(req.params.key)) return next();
  db.run(`DELETE FROM ${req.params.key} WHERE id=?`, [req.params.id], ()=>res.json({success:true})); 
});

app.use('/storage', storageApp);

db.serialize(() => {
  const tables = ["config","clients","drivers","user_devices","custom_icons","profiles","custom_events","alert_rules","route_schedules","maint_plans","maint_logs","geofences","checklists","checklist_templates"];
  tables.forEach(t => db.run(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY, json TEXT)`));
});

app.listen(PORT, () => console.log(`Backend running ${PORT}`));
