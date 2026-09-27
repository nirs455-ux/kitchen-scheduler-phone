// העתק של השרת (main.py) שרץ בתוך הטלפון: אותן כתובות /api/... ואותם כללים,
// רק שהנתונים ב-Store במקום SQLite והשיבוץ ב-Solver במקום OR-Tools.
const LocalApi = (() => {
  const EXPORT_FORMAT = "kitchen-scheduler";
  const EXPORT_VERSION = 1;
  const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const DB = () => Store.db;

  class ApiError extends Error {
    constructor(msg, status = 400) { super(msg); this.status = status; }
  }

  // ---------------------------------------------------------------- helpers
  function cleanName(value, label = "שם") {
    value = String(value ?? "").trim();
    if (!value) throw new ApiError(`${label} לא יכול להיות ריק`);
    if (value.length > 60) throw new ApiError(`${label} ארוך מדי (עד 60 תווים)`);
    return value;
  }
  function checkTime(value, label) {
    if (!value || !TIME_RE.test(value)) throw new ApiError(`${label}: שעה לא תקינה, צריך להיות בפורמט 08:30`);
    return value;
  }
  function checkColor(value) {
    value = String(value ?? "").trim();
    return /^#[0-9A-Fa-f]{6}$/.test(value) ? value : "#1E5AA8";
  }
  function checkSlot(value) {
    const v = parseInt(value, 10);
    if (Number.isNaN(v)) throw new ApiError("יחידת זמן לא תקינה");
    if (![15, 30, 60].includes(v)) throw new ApiError("יחידת הזמן צריכה להיות 15, 30 או 60 דקות");
    return v;
  }
  function optInt(value, label, lo = 0, hi = 200) {
    if (value === null || value === undefined || value === "") return null;
    const v = Number(value);
    if (!Number.isInteger(v)) throw new ApiError(`${label}: מספר לא תקין`);
    if (v < lo || v > hi) throw new ApiError(`${label}: צריך להיות בין ${lo} ל-${hi}`);
    return v;
  }
  const truthy = v => !!v && v !== "0";
  const nowIso = (withSeconds = true) => {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    return withSeconds ? `${s}:${p(d.getSeconds())}` : s;
  };
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function addDays(iso, n) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function weekdayOf(iso) {   // ראשון = 0 ... שבת = 6
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }
  const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  const toMin = t => { const [h, m] = t.split(":"); return +h * 60 + +m; };
  const spanMin = (a, b) => { const d = toMin(b) - toMin(a); return d > 0 ? d : d + 1440; };
  const fmtD = iso => { const [, m, d] = iso.split("-"); return `${d}/${m}`; };
  const round1 = v => Math.round(v * 10) / 10;
  const cmp = (...pairs) => { for (const [a, b] of pairs) { if (a < b) return -1; if (a > b) return 1; } return 0; };
  // NULL קודם, כמו ORDER BY ב-SQLite
  const nk = v => (v === null || v === undefined ? -Infinity : v);

  function activeRid() {
    const db = DB();
    const rid = db.meta.active_restaurant_id;
    if (rid && Store.byId("restaurants", rid)) return rid;
    const first = [...db.restaurants].sort((a, b) => a.id - b.id)[0];
    if (first) { db.meta.active_restaurant_id = first.id; return first.id; }
    return null;
  }
  function requireRid() {
    const rid = activeRid();
    if (!rid) throw new ApiError("עדיין לא הוגדרה מסעדה");
    return rid;
  }
  function getRestaurant(rid) {
    const r = Store.byId("restaurants", rid);
    if (!r) throw new ApiError("המסעדה לא נמצאה", 404);
    return r;
  }
  function getPlan(pid) {
    const p = Store.byId("day_plans", pid);
    if (!p) throw new ApiError("היום לא נמצא", 404);
    return p;
  }
  function getStation(sid, rid) {
    const s = Store.byId("stations", sid);
    if (!s || s.restaurant_id !== rid) throw new ApiError("העמדה לא נמצאה", 404);
    return s;
  }
  function getEmployee(eid, rid) {
    const e = Store.byId("employees", eid);
    if (!e || e.restaurant_id !== rid) throw new ApiError("העובד לא נמצא", 404);
    return e;
  }

  // ---------------------------------------------------------------- מחיקות (כמו ON DELETE ב-SQLite)
  function deleteSeatsWhere(fn) { Store.remove("schedule_seats", fn); }
  function deleteWeek(wid) { deleteSeatsWhere(q => q.week_id === wid); Store.remove("schedule_weeks", w => w.id === wid); }
  function deletePlan(pid) { Store.remove("requirements", q => q.plan_id === pid); Store.remove("day_plans", p => p.id === pid); }
  function deleteStation(sid) {
    Store.remove("requirements", q => q.station_id === sid);
    Store.remove("employee_stations", x => x.station_id === sid);
    deleteSeatsWhere(q => q.station_id === sid);
    Store.remove("stations", s => s.id === sid);
  }
  function deleteEmployee(eid) {
    Store.remove("employee_stations", x => x.employee_id === eid);
    Store.remove("availability", a => a.employee_id === eid);
    Store.remove("week_subs", x => x.employee_id === eid);
    Store.remove("week_avail", x => x.employee_id === eid);
    for (const q of DB().schedule_seats) if (q.employee_id === eid) q.employee_id = null;
    Store.remove("employees", e => e.id === eid);
  }
  function deleteRestaurant(rid) {
    Store.where("schedule_weeks", w => w.restaurant_id === rid).forEach(w => deleteWeek(w.id));
    Store.where("employees", e => e.restaurant_id === rid).forEach(e => deleteEmployee(e.id));
    Store.where("day_plans", p => p.restaurant_id === rid).forEach(p => deletePlan(p.id));
    Store.where("stations", s => s.restaurant_id === rid).forEach(s => deleteStation(s.id));
    Store.remove("restaurants", r => r.id === rid);
  }

  // ---------------------------------------------------------------- plans
  function planWindows(plan) {
    let w = Array.isArray(plan.windows) ? plan.windows : null;
    if (!w && typeof plan.windows === "string") { try { w = JSON.parse(plan.windows); } catch (e) { w = null; } }
    if ((!w || !w.length) && plan.open_time && plan.close_time) w = [[plan.open_time, plan.close_time]];
    return (w || []).map(x => [x[0], x[1], x.length > 2 && x[2] !== null && x[2] !== undefined ? parseInt(x[2], 10) : 0]);
  }
  function planClose(plan) {
    const wins = planWindows(plan).sort((a, b) => cmp([a[0], b[0]]));
    return wins.length ? wins[wins.length - 1][1] : null;
  }
  function ensureWeekdays(rid) {
    for (let wd = 0; wd < 7; wd++) {
      if (!DB().day_plans.some(p => p.restaurant_id === rid && p.kind === "weekday" && p.weekday === wd)) {
        Store.insert("day_plans", {restaurant_id: rid, kind: "weekday", weekday: wd, plan_date: null, name: null,
          is_open: 1, open_time: "12:00", close_time: "23:00", note: null, windows: [["12:00", "23:00"]], closers: 0});
      }
    }
  }
  function createRestaurant(name, slot = 30) {
    const r = Store.insert("restaurants", {name, slot_minutes: slot, created_at: nowIso(), closing_minutes: 30,
      staff_type: "kitchen"});
    ensureWeekdays(r.id);
    return r.id;
  }
  function copyPlanContents(srcId, dstId) {
    if (srcId === dstId) return;
    const src = getPlan(srcId), dst = getPlan(dstId);
    Object.assign(dst, {is_open: src.is_open, open_time: src.open_time, close_time: src.close_time,
      windows: planWindows(src).map(w => [w[0], w[1]]), closers: src.closers || 0});
    Store.remove("requirements", q => q.plan_id === dstId);
    for (const q of Store.where("requirements", q => q.plan_id === srcId)) {
      Store.insert("requirements", {plan_id: dstId, station_id: q.station_id, start_time: q.start_time,
        end_time: q.end_time, count: q.count, end_mode: q.end_mode});
    }
  }
  const stationOf = sid => (sid ? Store.byId("stations", sid) : null);
  const reqOrder = (a, b) => cmp([a.start_time, b.start_time], [a.end_time ? 1 : 0, b.end_time ? 1 : 0],
    [nk(stationOf(a.station_id)?.sort_order), nk(stationOf(b.station_id)?.sort_order)], [a.id, b.id]);

  function loadPlans(rid) {
    return Store.where("day_plans", p => p.restaurant_id === rid).sort((a, b) => a.id - b.id).map(p => ({
      ...p, windows: planWindows(p),
      requirements: Store.where("requirements", q => q.plan_id === p.id).sort(reqOrder).map(q => {
        const s = stationOf(q.station_id);
        return {...q, station_name: s ? s.name : null, station_color: s ? s.color : null, station_active: s ? s.is_active : null};
      }),
    }));
  }
  function loadEmployees(rid) {
    return Store.where("employees", e => e.restaurant_id === rid)
      .sort((a, b) => cmp([a.sort_order, b.sort_order], [a.id, b.id]))
      .map(e => ({
        ...e,
        stations: Store.where("employee_stations", x => x.employee_id === e.id).map(x => ({station_id: x.station_id, level: x.level})),
        availability: Store.where("availability", a => a.employee_id === e.id)
          .sort((a, b) => a.weekday - b.weekday).map(a => ({...a})),
      }));
  }
  const stationsOf = rid => Store.where("stations", s => s.restaurant_id === rid)
    .sort((a, b) => cmp([a.sort_order, b.sort_order], [a.id, b.id]));

  // ---------------------------------------------------------------- export / import
  function exportRestaurant(rid) {
    const rest = getRestaurant(rid);
    return {
      format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: nowIso(),
      restaurant: {name: rest.name, slot_minutes: rest.slot_minutes, closing_minutes: rest.closing_minutes,
        staff_type: rest.staff_type || "kitchen"},
      stations: stationsOf(rid).map(s => ({key: s.id, name: s.name, color: s.color, sort_order: s.sort_order, is_active: s.is_active})),
      plans: loadPlans(rid).map(p => ({
        kind: p.kind, weekday: p.weekday, plan_date: p.plan_date, name: p.name, is_open: p.is_open,
        open_time: p.open_time, close_time: p.close_time, note: p.note, windows: p.windows, closers: p.closers,
        requirements: p.requirements.map(q => ({station_key: q.station_id, start_time: q.start_time,
          end_time: q.end_time, end_mode: q.end_mode, count: q.count})),
      })),
      employees: loadEmployees(rid).map(e => ({
        name: e.name, is_active: e.is_active, max_shifts_week: e.max_shifts_week, max_hours_week: e.max_hours_week,
        target_shifts_week: e.target_shifts_week, note: e.note, sort_order: e.sort_order,
        stations: e.stations.map(x => ({station_key: x.station_id, level: x.level})),
        availability: e.availability.map(a => ({weekday: a.weekday, start_time: a.start_time, end_time: a.end_time})),
      })),
    };
  }

  function importRestaurant(data, name, includeDates = true, includeEmployees = true) {
    if (!data || typeof data !== "object" || data.format !== EXPORT_FORMAT)
      throw new ApiError("הקובץ הזה לא נראה כמו ייצוא של סידור העבודה");
    const info = data.restaurant || {};
    const rname = cleanName(name || info.name, "שם המסעדה");
    const slot = [15, 30, 60].includes(info.slot_minutes) ? info.slot_minutes : 30;
    const cm = info.closing_minutes;
    const rid = Store.insert("restaurants", {name: rname, slot_minutes: slot, created_at: nowIso(),
      closing_minutes: Number.isInteger(cm) ? cm : 30, staff_type: info.staff_type === "floor" ? "floor" : "kitchen"}).id;
    const keyMap = new Map();
    (data.stations || []).forEach((s, i) => {
      const st = Store.insert("stations", {restaurant_id: rid, name: cleanName(s.name, "שם עמדה"), color: checkColor(s.color),
        sort_order: parseInt(s.sort_order ?? i, 10), is_active: (s.is_active ?? 1) ? 1 : 0});
      keyMap.set(s.key, st.id);
    });
    for (const p of data.plans || []) {
      const kind = p.kind;
      if (!["weekday", "date", "preset"].includes(kind)) continue;
      if (kind === "date" && (!includeDates || !DATE_RE.test(p.plan_date || ""))) continue;
      if (kind === "weekday" && !(Number.isInteger(p.weekday) && p.weekday >= 0 && p.weekday < 7)) continue;
      const plan = Store.insert("day_plans", {restaurant_id: rid, kind,
        weekday: kind === "weekday" ? p.weekday : null, plan_date: kind === "date" ? p.plan_date : null,
        name: p.name ?? null, is_open: (p.is_open ?? 1) ? 1 : 0, open_time: p.open_time ?? null,
        close_time: p.close_time ?? null, note: p.note ?? null,
        windows: p.windows && p.windows.length ? p.windows : null,
        closers: Number.isInteger(p.closers) ? p.closers : null});
      for (const q of p.requirements || []) {
        const hasKey = q.station_key !== null && q.station_key !== undefined;
        const sid = hasKey ? keyMap.get(q.station_key) : null;
        if (hasKey && !sid) continue;
        const mode = ["fixed", "min"].includes(q.end_mode) ? q.end_mode : null;
        const end = mode ? q.end_time : null;
        if (TIME_RE.test(q.start_time || "") && (end === null || end === undefined || TIME_RE.test(end))) {
          Store.insert("requirements", {plan_id: plan.id, station_id: sid, start_time: q.start_time,
            end_time: end ?? null, count: Math.max(1, parseInt(q.count ?? 1, 10)), end_mode: mode});
        }
      }
    }
    // כמו migrate_day_closers בגרסת המחשב: קבצים ישנים בלי מספר סוגרים ליום
    for (const plan of Store.where("day_plans", p => p.restaurant_id === rid && (p.closers === null || p.closers === undefined))) {
      const wins = planWindows(plan);
      plan.closers = wins.reduce((n, w) => n + w[2], 0);
      plan.windows = wins.map(w => [w[0], w[1]]);
    }
    if (includeEmployees) {
      (data.employees || []).forEach((e, i) => {
        const emp = Store.insert("employees", {restaurant_id: rid, name: cleanName(e.name, "שם עובד"),
          is_active: (e.is_active ?? 1) ? 1 : 0, max_shifts_week: e.max_shifts_week ?? null,
          max_hours_week: e.max_hours_week ?? null, target_shifts_week: e.target_shifts_week ?? null,
          note: e.note ?? null, sort_order: parseInt(e.sort_order ?? i, 10)});
        for (const x of e.stations || []) {
          const sid = keyMap.get(x.station_key);
          if (sid && ["primary", "secondary"].includes(x.level) &&
              !DB().employee_stations.some(r => r.employee_id === emp.id && r.station_id === sid)) {
            DB().employee_stations.push({employee_id: emp.id, station_id: sid, level: x.level});
          }
        }
        for (const a of e.availability || []) {
          if (Number.isInteger(a.weekday) && a.weekday >= 0 && a.weekday < 7 && TIME_RE.test(a.start_time || "") &&
              TIME_RE.test(a.end_time || "") && a.start_time !== a.end_time) {
            setAvailability(emp.id, a.weekday, a.start_time, a.end_time);
          }
        }
      });
    }
    ensureWeekdays(rid);
    return rid;
  }

  function setAvailability(eid, wd, start, end) {
    Store.remove("availability", a => a.employee_id === eid && a.weekday === wd);
    DB().availability.push({employee_id: eid, weekday: wd, start_time: start, end_time: end});
  }

  // ---------------------------------------------------------------- schedule helpers
  function weekStartOf(iso) {
    if (!DATE_RE.test(iso || "")) throw new ApiError("תאריך לא תקין");
    return addDays(iso, -weekdayOf(iso));   // ראשון
  }
  function planForDate(rid, iso) {
    let plan = DB().day_plans.find(p => p.restaurant_id === rid && p.kind === "date" && p.plan_date === iso);
    if (!plan) plan = DB().day_plans.find(p => p.restaurant_id === rid && p.kind === "weekday" && p.weekday === weekdayOf(iso));
    const reqs = Store.where("requirements", q => q.plan_id === plan.id && (!q.station_id || stationOf(q.station_id)?.is_active))
      .sort(reqOrder);
    return [plan, reqs];
  }
  function covers(avail, start, endOrNone) {
    const aS = toMin(avail.start_time);
    const aLen = spanMin(avail.start_time, avail.end_time);
    const off = (((toMin(start) - aS) % 1440) + 1440) % 1440;
    if (off >= aLen) return false;
    if (endOrNone) return off + spanMin(start, endOrNone) <= aLen;
    return true;
  }

  class Ctx {
    constructor(rid, weekStart) {
      this.weekStart = weekStart;
      const cm = getRestaurant(rid).closing_minutes;
      this.cleanup = cm === null || cm === undefined ? 30 : cm;
      this.stations = new Map(Store.where("stations", s => s.restaurant_id === rid).map(s => [s.id, s]));
      this.floor = getRestaurant(rid).staff_type === "floor";
      this.emps = applyWeek(loadEmployees(rid).filter(e => e.is_active), weekStart);
      this.skill = new Map();
      this.avail = new Map();
      for (const e of this.emps) {
        for (const x of e.stations) this.skill.set(`${e.id}|${x.station_id}`, x.level);
        for (const a of e.availability) this.avail.set(`${e.id}|${a.weekday}`, a);
      }
      this.finalClose = {};
      for (let i = 0; i < 7; i++) {
        const iso = addDays(weekStart, i);
        const [plan] = planForDate(rid, iso);
        this.finalClose[iso] = plan.is_open ? planClose(plan) : null;
      }
    }
    // רק משמרת שמסתיימת בשעת הסגירה של סוף היום יכולה לסגור
    closeEnd(seat) {
      const final = this.finalClose[seat.plan_date];
      if (!final) return null;
      if (seat.shift_end && seat.shift_end !== final) return null;
      return final;
    }
    requiredEnd(seat) {
      if (seat.end_time) return seat.end_time;
      if (seat.end_mode === "fixed" || seat.end_mode === "min") return seat.shift_end || null;
      return null;
    }
    interval(seat) {
      const day = daysBetween(this.weekStart, seat.plan_date);
      const start = day * 1440 + toMin(seat.start_time);
      const end = seat.end_time || seat.shift_end || this.closeEnd(seat) || seat.start_time;
      return [start, start + spanMin(seat.start_time, end)];
    }
    stationName(seat) {
      return seat.station_id ? this.stations.get(seat.station_id).name : "עובד";
    }
    staticIssues(emp, seat) {
      const issues = [];
      if (seat.station_id && !this.skill.has(`${emp.id}|${seat.station_id}`))
        issues.push([3, `לא עובד בעמדה ${this.stationName(seat)}`]);
      const wd = weekdayOf(seat.plan_date);
      const a = this.avail.get(`${emp.id}|${wd}`);
      if (!a) issues.push([3, emp.week_submitted ? `לא זמין השבוע ביום ${WEEKDAYS[wd]}` : `לא עובד ביום ${WEEKDAYS[wd]}`]);
      else if (!covers(a, seat.start_time, this.requiredEnd(seat)))
        issues.push([2, `זמין רק ${a.start_time}-${a.end_time}`]);
      return issues;
    }
  }

  function seatHours(q, cleanup = 0) {
    if (q.actual_start && q.actual_end) return [spanMin(q.actual_start, q.actual_end) / 60, true];
    const end = q.end_time || q.shift_end;
    if (!end) return [0, false];
    return [(spanMin(q.start_time, end) + (q.end_time ? cleanup : 0)) / 60, false];
  }

  // שעות ב-3 השבועות שלפני ws, לכל עובד. weeks = שבועות שבהם עבד (שבוע בלי משמרות = חופש, לא נספר)
  function historyBefore(rid, ws, cleanup) {
    const out = new Map();
    for (let k = 1; k <= 3; k++) {
      const w = DB().schedule_weeks.find(x => x.restaurant_id === rid && x.week_start === addDays(ws, -7 * k));
      if (!w) continue;
      const perEmp = new Map();
      for (const q of DB().schedule_seats) {
        if (q.week_id !== w.id || !q.employee_id) continue;
        perEmp.set(q.employee_id, (perEmp.get(q.employee_id) || 0) + seatHours(q, cleanup)[0] * 60);
      }
      for (const [eid, min] of perEmp) {
        const h = out.get(eid) || {minutes: 0, weeks: 0};
        h.minutes += min; h.weeks += 1;
        out.set(eid, h);
      }
    }
    return out;
  }

  // זמינות לשבוע: אם הוזנה לעובד זמינות מיוחדת לשבוע ws, היא מחליפה את הקבועה (גם מקסימום המשמרות)
  function applyWeek(emps, ws) {
    for (const e of emps) {
      const sub = DB().week_subs.find(x => x.employee_id === e.id && x.week_start === ws);
      e.week_submitted = !!sub;
      if (!sub) continue;
      e.availability = Store.where("week_avail", a => a.employee_id === e.id && a.week_start === ws)
        .sort((a, b) => a.weekday - b.weekday).map(a => ({...a}));
      if (sub.max_shifts !== null && sub.max_shifts !== undefined) e.max_shifts_week = sub.max_shifts;
    }
    return emps;
  }

  function cleanupOf(rid) {
    const cm = getRestaurant(rid).closing_minutes;
    return cm === null || cm === undefined ? 30 : cm;
  }

  function weekPayload(rid, ws) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const iso = addDays(ws, i);
      const [plan, reqs] = planForDate(rid, iso);
      days.push({date: iso, weekday: i, is_exception: plan.kind === "date", name: plan.name,
        is_open: !!plan.is_open, windows: planWindows(plan),
        closers: plan.is_open ? (plan.closers || 0) : 0,
        needed: plan.is_open ? reqs.reduce((n, q) => n + q.count, 0) : 0});
    }
    const week = DB().schedule_weeks.find(w => w.restaurant_id === rid && w.week_start === ws);
    let seats = [];
    if (week) {
      seats = Store.where("schedule_seats", q => q.week_id === week.id).map(q => {
        const s = stationOf(q.station_id), e = q.employee_id ? Store.byId("employees", q.employee_id) : null;
        return {...q, station_name: s ? s.name : null, station_color: s ? s.color : null, employee_name: e ? e.name : null,
          _so: s ? s.sort_order : null};
      }).sort((a, b) => cmp([a.plan_date, b.plan_date], [a.start_time, b.start_time],
        [a.end_time ? 1 : 0, b.end_time ? 1 : 0], [nk(a._so), nk(b._so)], [a.id, b.id]));
      seats.forEach(q => delete q._so);
    }
    const emps = applyWeek(loadEmployees(rid).filter(e => e.is_active), ws);
    const cleanup = cleanupOf(rid);
    const hist = historyBefore(rid, ws, cleanup);
    const summary = emps.map(e => {
      const mine = seats.filter(q => q.employee_id === e.id);
      const hours = mine.reduce((n, q) => n + seatHours(q, cleanup)[0], 0);
      return {id: e.id, name: e.name, shifts: mine.length, hours: round1(hours),
        hours4: round1(hours + ((hist.get(e.id) || {}).minutes || 0) / 60),
        closings: mine.filter(q => q.end_time).length, max_shifts: e.max_shifts_week};
    });
    const ready = {employees: emps.length, with_availability: emps.filter(e => e.availability.length).length,
      needed: days.reduce((n, d) => n + d.needed, 0)};
    const weekAvail = emps.map(e => ({id: e.id, name: e.name, submitted: e.week_submitted,
      max_shifts: e.max_shifts_week, days: e.availability.map(a => ({weekday: a.weekday, start_time: a.start_time, end_time: a.end_time}))}));
    return {week_start: ws, built: !!week, built_at: week ? week.built_at : null, days, seats, summary, ready,
      week_avail: weekAvail, staff_type: getRestaurant(rid).staff_type || "kitchen"};
  }

  function getSeat(seatId, rid) {
    const q = Store.byId("schedule_seats", seatId);
    const w = q && Store.byId("schedule_weeks", q.week_id);
    if (!q || !w || w.restaurant_id !== rid) throw new ApiError("המשמרת לא נמצאה", 404);
    return [q, w];
  }

  // ---------------------------------------------------------------- routes
  const R = [];
  const route = (method, path, fn) => R.push([method, new RegExp("^" + path.replace(/<int>/g, "(\\d+)") + "$"), fn]);

  route("GET", "/api/state", () => {
    const rid = activeRid();
    const restaurants = [...DB().restaurants].sort((a, b) => a.id - b.id).map(r => ({id: r.id, name: r.name}));
    if (!rid) return {restaurant: null, restaurants, weekday_names: WEEKDAYS};
    ensureWeekdays(rid);
    const plans = loadPlans(rid);
    const dates = plans.filter(p => p.kind === "date").sort((a, b) => cmp([a.plan_date, b.plan_date]));
    const today = todayIso();
    const holidays = Holidays.upcoming(today);
    if (holidays) {
      const taken = new Set(dates.map(p => p.plan_date));
      for (const h of holidays) h.has_plan = taken.has(h.date);
    }
    return {
      restaurant: {...getRestaurant(rid)}, restaurants, stations: stationsOf(rid).map(s => ({...s})),
      employees: loadEmployees(rid),
      weekdays: plans.filter(p => p.kind === "weekday").sort((a, b) => a.weekday - b.weekday),
      dates, presets: plans.filter(p => p.kind === "preset").sort((a, b) => cmp([a.name || "", b.name || ""])),
      holidays, today, weekday_names: WEEKDAYS,
    };
  });

  // restaurants
  route("POST", "/api/restaurants", (p, b) => {
    const rid = createRestaurant(cleanName(b.name, "שם המסעדה"), checkSlot(b.slot_minutes ?? 30));
    if (b.staff_type === "floor") getRestaurant(rid).staff_type = "floor";
    DB().meta.active_restaurant_id = rid;
    return {id: rid};
  });
  route("PUT", "/api/restaurants/<int>", ([rid], b) => {
    const rest = getRestaurant(rid);
    const closing = optInt(b.closing_minutes ?? rest.closing_minutes, "זמן סגירה", 0, 240);
    const name = cleanName(b.name, "שם המסעדה"), slot = checkSlot(b.slot_minutes ?? 30);
    const staffType = b.staff_type ?? rest.staff_type ?? "kitchen";
    if (!["kitchen", "floor"].includes(staffType)) throw new ApiError("סוג צוות לא תקין");
    Object.assign(rest, {name, slot_minutes: slot, closing_minutes: closing === null ? 30 : closing, staff_type: staffType});
    return {ok: true};
  });
  route("DELETE", "/api/restaurants/<int>", ([rid]) => {
    getRestaurant(rid);
    deleteRestaurant(rid);
    delete DB().meta.active_restaurant_id;
    return {ok: true};
  });
  route("POST", "/api/restaurants/<int>/activate", ([rid]) => {
    getRestaurant(rid);
    DB().meta.active_restaurant_id = rid;
    return {ok: true};
  });
  route("POST", "/api/restaurants/<int>/duplicate", ([rid], b) => {
    const data = exportRestaurant(rid);
    const id = importRestaurant(data, cleanName(b.name, "שם המסעדה"), truthy(b.include_dates), truthy(b.include_employees ?? true));
    DB().meta.active_restaurant_id = id;
    return {id};
  });
  route("GET", "/api/restaurants/<int>/export", ([rid]) => exportRestaurant(rid));
  route("POST", "/api/import", (p, b) => {
    const id = importRestaurant(b.data, b.name, truthy(b.include_dates), truthy(b.include_employees ?? true));
    DB().meta.active_restaurant_id = id;
    return {id};
  });

  // stations
  route("POST", "/api/stations", (p, b) => {
    const rid = requireRid();
    const name = cleanName(b.name, "שם העמדה");
    const mine = Store.where("stations", s => s.restaurant_id === rid);
    if (mine.some(s => s.name === name)) throw new ApiError("כבר יש עמדה בשם הזה");
    const top = mine.reduce((m, s) => Math.max(m, s.sort_order), -1);
    return {id: Store.insert("stations", {restaurant_id: rid, name, color: checkColor(b.color), sort_order: top + 1, is_active: 1}).id};
  });
  route("PUT", "/api/stations/<int>", ([sid], b) => {
    const rid = requireRid();
    const st = getStation(sid, rid);
    const name = cleanName(b.name ?? st.name, "שם העמדה");
    if (DB().stations.some(s => s.restaurant_id === rid && s.name === name && s.id !== sid)) throw new ApiError("כבר יש עמדה בשם הזה");
    Object.assign(st, {name, color: checkColor(b.color ?? st.color), is_active: (b.is_active ?? st.is_active) ? 1 : 0});
    return {ok: true};
  });
  route("DELETE", "/api/stations/<int>", ([sid]) => {
    getStation(sid, requireRid());
    deleteStation(sid);
    return {ok: true};
  });
  route("POST", "/api/stations/<int>/move", ([sid], b) => {
    const rid = requireRid();
    getStation(sid, rid);
    const step = (b.dir ?? 1) < 0 ? -1 : 1;
    const list = stationsOf(rid);
    const i = list.findIndex(s => s.id === sid), j = i + step;
    if (j >= 0 && j < list.length) {
      [list[i], list[j]] = [list[j], list[i]];
      list.forEach((s, order) => { s.sort_order = order; });
    }
    return {ok: true};
  });

  // day plans
  route("PUT", "/api/plans/<int>", ([pid], b) => {
    const plan = getPlan(pid);
    const isOpen = (b.is_open ?? plan.is_open) ? 1 : 0;
    let windows = planWindows(plan);
    if ("windows" in b) {
      windows = [];
      for (const w of b.windows || []) {
        if (!Array.isArray(w) || ![2, 3].includes(w.length)) throw new ApiError("חלון פעילות לא תקין");
        const a = checkTime(w[0], "שעת פתיחה"), z = checkTime(w[1], "שעת סגירה");
        if (a === z) throw new ApiError("שעת הפתיחה והסגירה זהות");
        windows.push([a, z]);
      }
      windows.sort((x, y) => cmp([x[0], y[0]]));
    }
    if (isOpen && !windows.length) throw new ApiError("ביום פתוח צריך לפחות חלון פעילות אחד");
    let name = plan.name;
    if ("name" in b) {
      name = String(b.name ?? "").trim().slice(0, 60) || null;
      if (plan.kind === "preset" && !name) throw new ApiError("לתבנית חייב להיות שם");
    }
    const closers = "closers" in b ? (optInt(b.closers, "כמה סוגרים", 0, 50) || 0) : (plan.closers || 0);
    Object.assign(plan, {is_open: isOpen,
      open_time: windows.length ? windows[0][0] : plan.open_time,
      close_time: windows.length ? windows[windows.length - 1][1] : plan.close_time,
      windows: windows.map(w => [w[0], w[1]]), closers, name, note: b.note ?? plan.note});
    return {ok: true};
  });
  route("DELETE", "/api/plans/<int>", ([pid]) => {
    const plan = getPlan(pid);
    if (plan.kind === "weekday") throw new ApiError("אי אפשר למחוק יום מהשבוע הרגיל. אפשר לסמן אותו כסגור.");
    deletePlan(pid);
    return {ok: true};
  });
  route("POST", "/api/plans/<int>/copy-to-weekdays", ([pid], b) => {
    const plan = getPlan(pid);
    const targets = (b.weekdays || []).map(Number).filter(w => Number.isInteger(w) && w >= 0 && w < 7);
    if (!targets.length) throw new ApiError("לא נבחרו ימים");
    for (const wd of targets) {
      const row = DB().day_plans.find(p => p.restaurant_id === plan.restaurant_id && p.kind === "weekday" && p.weekday === wd);
      copyPlanContents(pid, row.id);
    }
    return {ok: true};
  });
  route("POST", "/api/plans/<int>/save-preset", ([pid], b) => {
    const plan = getPlan(pid);
    const name = cleanName(b.name, "שם התבנית");
    const np = Store.insert("day_plans", {restaurant_id: plan.restaurant_id, kind: "preset", weekday: null, plan_date: null,
      name, is_open: 1, open_time: null, close_time: null, note: null, windows: null, closers: null});
    copyPlanContents(pid, np.id);
    return {id: np.id};
  });
  route("POST", "/api/plans/<int>/apply-preset", ([pid], b) => {
    const plan = getPlan(pid);
    const preset = getPlan(parseInt(b.preset_id || 0, 10));
    if (preset.kind !== "preset" || preset.restaurant_id !== plan.restaurant_id) throw new ApiError("התבנית לא נמצאה");
    copyPlanContents(preset.id, pid);
    return {ok: true};
  });
  route("POST", "/api/dates", (p, b) => {
    const rid = requireRid();
    const d = String(b.date || "").trim();
    if (!DATE_RE.test(d)) throw new ApiError("תאריך לא תקין");
    if (DB().day_plans.some(x => x.restaurant_id === rid && x.kind === "date" && x.plan_date === d))
      throw new ApiError("כבר יש חריג לתאריך הזה", 409);
    let srcId;
    if (b.preset_id) {
      const preset = getPlan(parseInt(b.preset_id, 10));
      if (preset.kind !== "preset" || preset.restaurant_id !== rid) throw new ApiError("התבנית לא נמצאה");
      srcId = preset.id;
    } else {
      srcId = DB().day_plans.find(x => x.restaurant_id === rid && x.kind === "weekday" && x.weekday === weekdayOf(d)).id;
    }
    const np = Store.insert("day_plans", {restaurant_id: rid, kind: "date", weekday: null, plan_date: d,
      name: String(b.name || "").trim().slice(0, 60) || null, is_open: 1, open_time: null, close_time: null,
      note: null, windows: null, closers: null});
    copyPlanContents(srcId, np.id);
    return {id: np.id};
  });

  // requirements
  function readRequirement(rid, b) {
    const stationId = b.station_id ? getStation(parseInt(b.station_id, 10), rid).id : null;
    const start = checkTime(b.start_time, "שעת הגעה");
    let mode = null, end = null;
    if (b.end_time) {
      mode = "fixed";
      end = checkTime(b.end_time, "שעת סיום");
      if (end === start) throw new ApiError("שעת ההגעה והסיום זהות");
    }
    const count = Number(b.count ?? 1);
    if (!Number.isInteger(count)) throw new ApiError("כמות עובדים לא תקינה");
    if (count < 1 || count > 50) throw new ApiError("כמות העובדים צריכה להיות בין 1 ל-50");
    return {station_id: stationId, start_time: start, end_time: end, count, end_mode: mode};
  }
  route("POST", "/api/plans/<int>/requirements", ([pid], b) => {
    const plan = getPlan(pid);
    return {id: Store.insert("requirements", {plan_id: pid, ...readRequirement(plan.restaurant_id, b)}).id};
  });
  route("PUT", "/api/requirements/<int>", ([qid], b) => {
    const q = Store.byId("requirements", qid);
    const plan = q && Store.byId("day_plans", q.plan_id);
    if (!q || !plan) throw new ApiError("הדרישה לא נמצאה", 404);
    Object.assign(q, readRequirement(plan.restaurant_id, b));
    return {ok: true};
  });
  route("DELETE", "/api/requirements/<int>", ([qid]) => {
    Store.remove("requirements", q => q.id === qid);
    return {ok: true};
  });

  // employees
  route("POST", "/api/employees", (p, b) => {
    const rid = requireRid();
    const name = cleanName(b.name, "שם העובד");
    const mine = Store.where("employees", e => e.restaurant_id === rid);
    if (mine.some(e => e.name === name)) throw new ApiError("כבר יש עובד בשם הזה");
    const top = mine.reduce((m, e) => Math.max(m, e.sort_order), -1);
    return {id: Store.insert("employees", {restaurant_id: rid, name, is_active: 1, max_shifts_week: null,
      max_hours_week: null, target_shifts_week: null, note: null, sort_order: top + 1}).id};
  });
  route("PUT", "/api/employees/<int>", ([eid], b) => {
    const rid = requireRid();
    const e = getEmployee(eid, rid);
    const name = cleanName(b.name ?? e.name, "שם העובד");
    if (DB().employees.some(x => x.restaurant_id === rid && x.name === name && x.id !== eid)) throw new ApiError("כבר יש עובד בשם הזה");
    const maxS = "max_shifts_week" in b ? optInt(b.max_shifts_week, "מקסימום משמרות", 0, 14) : e.max_shifts_week;
    const maxH = "max_hours_week" in b ? optInt(b.max_hours_week, "מקסימום שעות", 0, 120) : e.max_hours_week;
    Object.assign(e, {name, is_active: (b.is_active ?? e.is_active) ? 1 : 0, max_shifts_week: maxS,
      max_hours_week: maxH, note: b.note ?? e.note});
    return {ok: true};
  });
  route("DELETE", "/api/employees/<int>", ([eid]) => {
    getEmployee(eid, requireRid());
    deleteEmployee(eid);
    return {ok: true};
  });
  route("PUT", "/api/employees/<int>/stations", ([eid], b) => {
    const rid = requireRid();
    getEmployee(eid, rid);
    const st = getStation(parseInt(b.station_id || 0, 10), rid);
    Store.remove("employee_stations", x => x.employee_id === eid && x.station_id === st.id);
    if (["primary", "secondary"].includes(b.level)) DB().employee_stations.push({employee_id: eid, station_id: st.id, level: b.level});
    return {ok: true};
  });
  route("PUT", "/api/employees/<int>/availability", ([eid], b) => {
    getEmployee(eid, requireRid());
    const wd = b.weekday;
    if (!(Number.isInteger(wd) && wd >= 0 && wd < 7)) throw new ApiError("יום לא תקין");
    if (b.available) {
      const start = checkTime(b.start_time, "משעה"), end = checkTime(b.end_time, "עד שעה");
      if (start === end) throw new ApiError("שעת ההתחלה והסיום זהות");
      setAvailability(eid, wd, start, end);
    } else {
      Store.remove("availability", a => a.employee_id === eid && a.weekday === wd);
    }
    return {ok: true};
  });
  route("POST", "/api/employees/<int>/availability/fill", ([eid], b) => {
    const rid = requireRid();
    getEmployee(eid, rid);
    Store.remove("availability", a => a.employee_id === eid);
    if (b.mode !== "clear") {
      // מכסה גם את שעות הפעילות וגם את כל המשמרות שהוגדרו באותו יום (למשל הכנות לפני הפתיחה)
      const fmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      for (const plan of Store.where("day_plans", p => p.restaurant_id === rid && p.kind === "weekday" && p.is_open).sort((a, b) => a.id - b.id)) {
        const spans = planWindows(plan).map(w => [w[0], w[1]]);
        for (const q of Store.where("requirements", q => q.plan_id === plan.id).sort((a, b) => a.id - b.id)) {
          if (q.end_time) spans.push([q.start_time, q.end_time]);
          if (spans.length) spans.push([q.start_time, spans[spans.length - 1][1]]);
        }
        if (!spans.length) continue;
        const start = Math.min(...spans.map(([a]) => toMin(a)));
        let end = Math.max(...spans.map(([a, z]) => toMin(a) + spanMin(a, z)));
        end = Math.min(end, start + 1439);
        DB().availability.push({employee_id: eid, weekday: plan.weekday, start_time: fmt(start), end_time: fmt(end)});
      }
    }
    return {ok: true};
  });

  // זמינות לשבוע מסוים. submitted=false מחזיר לזמינות הקבועה.
  route("PUT", "/api/week-availability/<int>", ([eid], b) => {
    getEmployee(eid, requireRid());
    const ws = weekStartOf(b.week_start);
    Store.remove("week_subs", x => x.employee_id === eid && x.week_start === ws);
    Store.remove("week_avail", x => x.employee_id === eid && x.week_start === ws);
    if (!b.submitted) return {ok: true};
    const maxS = optInt(b.max_shifts, "מקסימום משמרות", 0, 14);
    const days = [];
    for (const d of b.days || []) {
      const wd = d.weekday;
      if (!(Number.isInteger(wd) && wd >= 0 && wd < 7)) throw new ApiError("יום לא תקין");
      const start = checkTime(d.start_time, "משעה"), end = checkTime(d.end_time, "עד שעה");
      if (start === end) throw new ApiError(`${WEEKDAYS[wd]}: שעת ההתחלה והסיום זהות`);
      days.push({employee_id: eid, week_start: ws, weekday: wd, start_time: start, end_time: end});
    }
    DB().week_subs.push({employee_id: eid, week_start: ws, max_shifts: maxS});
    DB().week_avail.push(...days);
    return {ok: true};
  });

  // schedule
  route("GET", "/api/schedule", (p, b, query) => {
    const rid = requireRid();
    return weekPayload(rid, weekStartOf(query.get("week_start") || todayIso()));
  });

  route("POST", "/api/schedule/build", async (p, b) => {
    const rid = requireRid();
    const ws = weekStartOf(b.week_start);
    const week = DB().schedule_weeks.find(w => w.restaurant_id === rid && w.week_start === ws);
    let manual = [];
    if (week && (b.keep_manual ?? true)) {
      manual = Store.where("schedule_seats", q => q.week_id === week.id && q.is_manual && q.employee_id).map(q => ({...q}));
    }
    const seats = [], closersNeeded = new Map();
    for (let i = 0; i < 7; i++) {
      const iso = addDays(ws, i);
      const [plan, reqs] = planForDate(rid, iso);
      if (!plan.is_open) continue;
      if (plan.closers) closersNeeded.set(`${iso}|${planClose(plan)}`, plan.closers);
      for (const q of reqs) {
        for (let k = 0; k < q.count; k++) {
          seats.push({plan_date: iso, station_id: q.station_id, start_time: q.start_time, end_time: null,
            end_mode: q.end_mode, shift_end: q.end_mode ? q.end_time : null});
        }
      }
    }
    if (!seats.length) throw new ApiError("אין מה לשבץ בשבוע הזה: לא הוגדרו משמרות באף יום.");
    const ctx = new Ctx(rid, ws);
    ctx.history = historyBefore(rid, ws, ctx.cleanup);
    for (const seat of seats) seat.close_end = ctx.closeEnd(seat);
    const fixed = {}, used = new Set();
    const validEmps = new Set(ctx.emps.map(e => e.id));
    for (const m of manual) {
      for (let i = 0; i < seats.length; i++) {
        const seat = seats[i];
        if (!used.has(i) && validEmps.has(m.employee_id) &&
            ["plan_date", "station_id", "start_time", "end_mode", "shift_end"].every(k => (seat[k] ?? null) === (m[k] ?? null))) {
          fixed[i] = m.employee_id;
          used.add(i);
          break;
        }
      }
    }
    const {result, closers} = await Solver.solveWeek(ctx, seats, fixed, closersNeeded);
    let weekId;
    if (week) {
      deleteSeatsWhere(q => q.week_id === week.id);
      weekId = week.id;
    } else {
      weekId = Store.insert("schedule_weeks", {restaurant_id: rid, week_start: ws, built_at: null}).id;
    }
    seats.forEach((seat, i) => {
      Store.insert("schedule_seats", {week_id: weekId, plan_date: seat.plan_date, station_id: seat.station_id,
        start_time: seat.start_time, end_time: closers.has(i) ? seat.close_end : null,
        employee_id: result.has(i) ? result.get(i) : null, is_manual: i in fixed ? 1 : 0,
        end_mode: seat.end_mode, shift_end: seat.shift_end, actual_start: null, actual_end: null});
    });
    Store.byId("schedule_weeks", weekId).built_at = nowIso(false);
    return weekPayload(rid, ws);
  });

  route("DELETE", "/api/schedule", (p, b, query) => {
    const rid = requireRid();
    const ws = weekStartOf(query.get("week_start"));
    Store.where("schedule_weeks", w => w.restaurant_id === rid && w.week_start === ws).forEach(w => deleteWeek(w.id));
    return {ok: true};
  });

  route("GET", "/api/schedule/seats/<int>/candidates", ([seatId]) => {
    const rid = requireRid();
    const [row, week] = getSeat(seatId, rid);
    const seat = {...row, week_start: week.week_start};
    const ctx = new Ctx(rid, week.week_start);
    const others = Store.where("schedule_seats", q => q.week_id === seat.week_id && q.id !== seatId && q.employee_id);
    const [s0, s1] = ctx.interval(seat);
    const hist = historyBefore(rid, week.week_start, ctx.cleanup);
    const out = ctx.emps.map(e => {
      const issues = ctx.staticIssues(e, seat);
      const mine = others.filter(q => q.employee_id === e.id);
      for (const q of mine) {
        const [q0, q1] = ctx.interval(q);
        if (q.plan_date === seat.plan_date || (q0 < s1 && s0 < q1)) {
          const what = q.start_time + (q.shift_end ? `-${q.shift_end}` : "") + (q.end_time ? ", סוגר" : "");
          issues.push([2, `כבר משובץ ב-${fmtD(q.plan_date)}: ${ctx.stationName(q)}, ${what}`]);
        }
      }
      if (e.max_shifts_week !== null && e.max_shifts_week !== undefined && mine.length + 1 > e.max_shifts_week)
        issues.push([1, `יעבור את המקסימום (${e.max_shifts_week} משמרות)`]);
      const level = seat.station_id ? (ctx.skill.get(`${e.id}|${seat.station_id}`) || null) : null;
      issues.sort((a, b) => cmp([b[0], a[0]], [b[1], a[1]]));
      return {id: e.id, name: e.name, level, shifts: mine.length, closings: mine.filter(q => q.end_time).length,
        hours: round1(mine.reduce((n, q) => n + seatHours(q, ctx.cleanup)[0], 0)),
        hours4: round1(Store.where("schedule_seats", q => q.week_id === seat.week_id && q.employee_id === e.id)
          .reduce((n, q) => n + seatHours(q, ctx.cleanup)[0], 0) + ((hist.get(e.id) || {}).minutes || 0) / 60),
        issues: issues.map(x => x[1]), score: issues.reduce((n, x) => n + x[0], 0), current: e.id === seat.employee_id};
    });
    out.sort((a, b) => cmp([a.score, b.score], [a.level === "secondary" ? 1 : 0, b.level === "secondary" ? 1 : 0],
      [a.shifts, b.shifts], [a.name, b.name]));
    return {seat: {...seat, station_name: ctx.stationName(seat)}, candidates: out};
  });

  route("PUT", "/api/schedule/seats/<int>", ([seatId], b) => {
    const rid = requireRid();
    const [seat, week] = getSeat(seatId, rid);
    if ("actual_start" in b || "actual_end" in b) {
      const aS = b.actual_start || null, aE = b.actual_end || null;
      if (aS || aE) {
        checkTime(aS, "שעת התחלה בפועל");
        checkTime(aE, "שעת סיום בפועל");
        if (aS === aE) throw new ApiError("שעת ההתחלה והסיום זהות");
      }
      Object.assign(seat, {actual_start: aS, actual_end: aE});
      return {ok: true};
    }
    if ("closing" in b) {
      let end = null;
      if (b.closing) {
        end = new Ctx(rid, week.week_start).closeEnd(seat);
        if (!end) throw new ApiError("המשמרת הזו לא מסתיימת בשעת הסגירה, אז היא לא סוגרת");
      }
      seat.end_time = end;
      return {ok: true};
    }
    if (b.employee_id) {
      getEmployee(parseInt(b.employee_id, 10), rid);
      Object.assign(seat, {employee_id: parseInt(b.employee_id, 10), is_manual: 1});
    } else {
      Object.assign(seat, {employee_id: null, is_manual: 0});
    }
    return {ok: true};
  });

  // tracking
  route("GET", "/api/stats", (p, b, query) => {
    const rid = requireRid();
    const today = todayIso();
    const dFrom = query.get("from") || addDays(today, -27);
    const dTo = query.get("to") || today;
    if (!DATE_RE.test(dFrom) || !DATE_RE.test(dTo) || dFrom > dTo) throw new ApiError("טווח תאריכים לא תקין");
    const weeksById = new Map(Store.where("schedule_weeks", w => w.restaurant_id === rid).map(w => [w.id, w]));
    const rows = [];
    for (const q of DB().schedule_seats) {
      const w = weeksById.get(q.week_id);
      const e = q.employee_id && Store.byId("employees", q.employee_id);
      if (w && e && q.plan_date >= dFrom && q.plan_date <= dTo) rows.push({...q, week_start: w.week_start, employee_name: e.name});
    }
    const weeks = [...new Set(rows.map(r => r.week_start))].sort();
    const perEmp = new Map(), perWeek = new Map(), perWd = new Map();
    let total = 0, actualN = 0;
    const cleanup = cleanupOf(rid);
    for (const r of rows) {
      const [h, actual] = seatHours(r, cleanup);
      total += h;
      actualN += actual ? 1 : 0;
      if (!perEmp.has(r.employee_id)) perEmp.set(r.employee_id, {id: r.employee_id, name: r.employee_name, hours: 0, closings: 0, dates: new Set()});
      const e = perEmp.get(r.employee_id);
      e.hours += h;
      e.closings += r.end_time ? 1 : 0;
      e.dates.add(r.plan_date);
      if (!perWeek.has(r.week_start)) perWeek.set(r.week_start, {week_start: r.week_start, hours: 0, shifts: 0});
      const wk = perWeek.get(r.week_start);
      wk.hours += h;
      wk.shifts += 1;
      const wd = weekdayOf(r.plan_date);
      perWd.set(wd, (perWd.get(wd) || 0) + h);
    }
    const emps = [...perEmp.values()].map(e => ({id: e.id, name: e.name, days: e.dates.size, hours: round1(e.hours), closings: e.closings}))
      .sort((a, b) => b.hours - a.hours);
    return {
      range: {from: dFrom, to: dTo}, weeks: weeks.length,
      kitchen: {hours: round1(total), shifts: rows.length, closings: rows.filter(r => r.end_time).length, actual_share: actualN},
      per_week: [...perWeek.values()].sort((a, b) => cmp([a.week_start, b.week_start])).map(w => ({...w, hours: round1(w.hours)})),
      by_weekday: [...perWd.keys()].sort((a, b) => a - b).map(wd => ({weekday: wd, hours: round1(perWd.get(wd))})),
      employees: emps,
    };
  });

  // ---------------------------------------------------------------- dispatcher
  let queue = Promise.resolve();

  // כל הקריאות רצות אחת אחרי השנייה, ושינוי נשמר מיד. שגיאה מבטלת את השינויים של אותה קריאה.
  function call(method, url, body) {
    const run = async () => {
      const u = new URL(url, "http://local");
      for (const [m, re, fn] of R) {
        const match = m === method && u.pathname.match(re);
        if (!match) continue;
        const params = match.slice(1).map(Number);
        const writes = method !== "GET";
        const before = writes ? JSON.stringify(Store.db) : null;
        try {
          const res = await fn(params, body || {}, u.searchParams);
          await Store.save();
          return JSON.parse(JSON.stringify(res));
        } catch (e) {
          if (writes) Store.setData(JSON.parse(before));
          throw e;
        }
      }
      throw new ApiError(`לא נמצא: ${method} ${u.pathname}`, 404);
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  return {call, ApiError, exportRestaurant};
})();
