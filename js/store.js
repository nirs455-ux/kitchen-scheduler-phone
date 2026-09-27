// שכבת הנתונים של גרסת הטלפון: אותן טבלאות כמו scheduler.db, כמערכים בזיכרון,
// ונשמרות כמסמך אחד ב-IndexedDB בתוך הטלפון. אין שרת ואין סנכרון עם המחשב (ראה גיבוי/ייבוא).
const Store = (() => {
  const TABLES = ["restaurants", "stations", "day_plans", "requirements", "employees",
                  "employee_stations", "availability", "schedule_weeks", "schedule_seats"];
  const BACKUP_FORMAT = "kitchen-scheduler-phone";
  const IDB_NAME = "kitchen-scheduler", IDB_STORE = "kv", IDB_KEY = "db";

  function empty() {
    const d = {meta: {}, seq: {}};
    for (const t of TABLES) d[t] = [];
    return d;
  }
  let DB = empty();

  function insert(table, row) {
    const id = (DB.seq[table] || 0) + 1;
    DB.seq[table] = id;
    const r = {id, ...row};
    DB[table].push(r);
    return r;
  }
  const byId = (table, id) => DB[table].find(r => r.id === id) || null;
  const where = (table, fn) => DB[table].filter(fn);
  function remove(table, fn) { DB[table] = DB[table].filter(r => !fn(r)); }

  // ---------- IndexedDB
  let idbPromise = null;
  function idb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return idbPromise;
  }
  async function idbGet() {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPut(value) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const hasIdb = () => typeof indexedDB !== "undefined";

  async function load() {
    if (!hasIdb()) return;
    const saved = await idbGet();
    if (saved) setData(saved);
    // מבקש מהדפדפן לא למחוק את הנתונים כשחסר מקום
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
  }
  async function save() {
    if (hasIdb()) await idbPut(DB);
  }

  function setData(data) {
    const d = empty();
    d.meta = {...(data.meta || {})};
    d.seq = {...(data.seq || {})};
    for (const t of TABLES) {
      d[t] = Array.isArray(data[t]) ? data[t].map(r => ({...r})) : [];
      const top = d[t].reduce((m, r) => Math.max(m, r.id || 0), 0);
      d.seq[t] = Math.max(d.seq[t] || 0, top);
    }
    DB = d;
  }

  // ---------- גיבוי מלא (כל המסעדות, כולל סידורים שנבנו)
  function backup() {
    return {format: BACKUP_FORMAT, version: 1, exported_at: new Date().toISOString(), ...JSON.parse(JSON.stringify(DB))};
  }
  function isBackup(data) {
    return !!data && data.format === BACKUP_FORMAT && Array.isArray(data.restaurants);
  }
  async function restore(data) {
    if (!isBackup(data)) throw new Error("הקובץ הזה לא נראה כמו גיבוי מלא של סידור העבודה");
    setData(data);
    await save();
  }

  return {
    get db() { return DB; },
    TABLES, insert, byId, where, remove, load, save, setData, backup, isBackup, restore,
  };
})();
