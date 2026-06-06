const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Sicherstellen dass data-Ordner existiert
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Datenbank initialisieren
const db = new Database(path.join(DATA_DIR, 'aufmass.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS jahre (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jahr INTEGER NOT NULL,
    erstellt_am TEXT DEFAULT (datetime('now')),
    archiviert INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS aufmasse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jahr_id INTEGER NOT NULL,
    quelle TEXT NOT NULL,
    blaetter TEXT NOT NULL,
    futter TEXT NOT NULL,
    erstellt_am TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (jahr_id) REFERENCES jahre(id)
  );
`);

// Aktuelles Jahr sicherstellen
const aktuellesJahr = new Date().getFullYear();
const jahrRow = db.prepare('SELECT id FROM jahre WHERE jahr = ? AND archiviert = 0').get(aktuellesJahr);
if (!jahrRow) {
  db.prepare('INSERT INTO jahre (jahr) VALUES (?)').run(aktuellesJahr);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── API Routes ────────────────────────────────────────────────────────────────

// API Key speichern
app.post('/api/settings/apikey', (req, res) => {
  const { apikey } = req.body;
  if (!apikey) return res.status(400).json({ error: 'Kein API-Key' });
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('apikey', apikey);
  res.json({ ok: true });
});

// API Key Status prüfen (ohne den Key zurückzugeben)
app.get('/api/settings/apikey/status', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('apikey');
  res.json({ vorhanden: !!row?.value });
});

// Aktuelles Jahr + alle Aufmaße laden
app.get('/api/aufmasse', (req, res) => {
  const jahre = db.prepare('SELECT * FROM jahre ORDER BY jahr DESC').all();
  const aktiv = jahre.find(j => !j.archiviert);
  if (!aktiv) return res.json({ aufmasse: [], jahre: [], aktuellesJahr: null });

  const aufmasse = db.prepare('SELECT * FROM aufmasse WHERE jahr_id = ? ORDER BY erstellt_am ASC').all(aktiv.id);
  const parsed = aufmasse.map(a => ({
    ...a,
    blaetter: JSON.parse(a.blaetter),
    futter: JSON.parse(a.futter),
    gruppe: `${aktiv.jahr}`
  }));

  res.json({
    aufmasse: parsed,
    jahre: jahre,
    aktuellesJahr: aktiv
  });
});

// Archiviertes Jahr laden
app.get('/api/aufmasse/jahr/:jahrId', (req, res) => {
  const jahr = db.prepare('SELECT * FROM jahre WHERE id = ?').get(req.params.jahrId);
  if (!jahr) return res.status(404).json({ error: 'Jahr nicht gefunden' });

  const aufmasse = db.prepare('SELECT * FROM aufmasse WHERE jahr_id = ? ORDER BY erstellt_am ASC').all(jahr.id);
  const parsed = aufmasse.map(a => ({
    ...a,
    blaetter: JSON.parse(a.blaetter),
    futter: JSON.parse(a.futter),
    gruppe: `${jahr.jahr}`
  }));

  res.json({ aufmasse: parsed, jahr });
});

// PDF hochladen & auslesen
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });

  const keyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('apikey');
  if (!keyRow?.value) return res.status(400).json({ error: 'Kein API-Key gesetzt' });

  const base64 = req.file.buffer.toString('base64');

  try {
    const prompt = `Du analysierst ein handgeschriebenes Aufmaßblatt für Zimmertüren.
Extrahiere alle Zeilen mit Einträgen. Regeln:
- Zahl in Türmaß → Türblatt (Normmaße mm: 610,625,735,750,760,810,860,985,1010)
- Zahl in Wandstärke → Türfutter (Zahl=Futtertiefe mm, Breite=Türmaß der Zeile). Zeile hat BEIDES → sowohl Türblatt als auch Türfutter anlegen.
- LA in Sonstiges → la:1 für diese Zeile (Lichtausschnitt, +7.6kg bei 860mm, +5.8kg bei 735mm)
- Kopfzeile Straße + Etage als quelle
You MUST respond with ONLY a JSON object, no explanation, no text before or after, no markdown:
{"quelle":"...","blaetter":[{"maß":"860 mm","breite":86.0,"anzahl":1,"la":0,"räume":["Raum"]}],"futter":[{"maß":"860/160","breite":86.0,"tiefe":16.0,"anzahl":1,"räume":["Raum"]}]}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': keyRow.value,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = data.content?.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text);

    // Aktuelles Jahr finden
    const aktuellesJahr = new Date().getFullYear();
    let jahrRow = db.prepare('SELECT id FROM jahre WHERE jahr = ? AND archiviert = 0').get(aktuellesJahr);
    if (!jahrRow) {
      const info = db.prepare('INSERT INTO jahre (jahr) VALUES (?)').run(aktuellesJahr);
      jahrRow = { id: info.lastInsertRowid };
    }

    // Speichern
    db.prepare('INSERT INTO aufmasse (jahr_id, quelle, blaetter, futter) VALUES (?, ?, ?, ?)')
      .run(jahrRow.id, parsed.quelle, JSON.stringify(parsed.blaetter || []), JSON.stringify(parsed.futter || []));

    res.json({ ok: true, quelle: parsed.quelle, blaetter: parsed.blaetter?.length || 0, futter: parsed.futter?.length || 0 });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aufmaß löschen
app.delete('/api/aufmasse/:id', (req, res) => {
  db.prepare('DELETE FROM aufmasse WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Jahresbericht erstellen & Jahr archivieren
app.post('/api/jahresabschluss', (req, res) => {
  const aktiv = db.prepare('SELECT * FROM jahre WHERE archiviert = 0').get();
  if (!aktiv) return res.status(400).json({ error: 'Kein aktives Jahr' });

  // Jahr archivieren
  db.prepare('UPDATE jahre SET archiviert = 1 WHERE id = ?').run(aktiv.id);

  // Neues Jahr anlegen
  const neuesJahr = aktiv.jahr + 1;
  const info = db.prepare('INSERT INTO jahre (jahr) VALUES (?)').run(neuesJahr);

  res.json({ ok: true, archiviert: aktiv.jahr, neuesJahr });
});

// Alle archivierten Jahre
app.get('/api/jahre', (req, res) => {
  const jahre = db.prepare('SELECT * FROM jahre ORDER BY jahr DESC').all();
  res.json(jahre);
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Aufmaß-App läuft auf Port ${PORT}`));
