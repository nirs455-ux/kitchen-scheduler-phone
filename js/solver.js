// שיבוץ שבועי בלי OR-Tools: אותם אילוצים ואותה פונקציית ניקוד כמו solve_week בגרסת המחשב,
// ובמקום פותר CP-SAT - בנייה חמדנית ואחריה חיפוש מקומי (simulated annealing) לכמה שניות.
//
// אילוצים קשיחים: רק מי שעובד בעמדה וזמין בשעות, משמרת אחת ביום לכל טבח, בלי חפיפה בין ימים,
// מקסימום משמרות, סוגר רק מי שזמין עד הסגירה, ולא יותר סוגרים ממה שהוגדר ליום.
// הניקוד (גבוה = טוב), לפי סדר החשיבות:
//   100000 לכל משמרת מאוישת, 10000 לכל סוגר, 2000 לכל טבח שסוגר לפחות פעם,
//   -5 לכל דקה של פער בין הכי הרבה שעות להכי מעט, -150 על כל סגירה מעבר לחלק ההוגן,
//   -500 על סגירה שנייה בסופ"ש, -300 על סגירה ביומיים ברצף, -50 לפער בסגירות,
//   +10 לכל שעה שהסוגר הגיע אחרי תחילת היום, -50 על עמדה משנית, -20 לפער במשמרות.
const Solver = (() => {
  const toMin = t => { const [h, m] = t.split(":"); return +h * 60 + +m; };
  const spanMin = (a, b) => { const d = toMin(b) - toMin(a); return d > 0 ? d : d + 1440; };
  const weekdayOf = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

  function rng(seed) {   // mulberry32 - כדי שאותם נתונים ייתנו אותה תוצאה
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const popcount = x => { let n = 0; while (x) { x &= x - 1; n++; } return n; };

  // מכין את כל מה שלא משתנה בזמן החיפוש, ומחזיר פונקציית ניקוד למצב (asg, cls)
  function prepare(ctx, seats, fixed, closersNeeded) {
    const n = seats.length, emps = ctx.emps, E = emps.length;
    const eIdx = new Map(emps.map((e, k) => [e.id, k]));
    const fx = seats.map((_, i) => (i in fixed ? eIdx.get(fixed[i]) : -1));
    const isFixed = i => fx[i] >= 0;
    const iv = seats.map(q => ctx.interval(q));
    const cand = seats.map((q, i) => (isFixed(i) ? [] : emps.map((e, k) => k).filter(k => !ctx.staticIssues(emps[k], q).length)));
    const candSet = cand.map(c => new Set(c));
    const conf = seats.map((q, i) => seats.map((r, j) => i !== j &&
      (q.plan_date === r.plan_date || (iv[i][0] < iv[j][1] && iv[j][0] < iv[i][1]))));

    const gkey = seats.map(q => {
      const k = q.close_end ? `${q.plan_date}|${q.close_end}` : null;
      return k && closersNeeded.has(k) ? k : null;
    });
    const canClose = seats.map((q, i) => {
      if (!gkey[i]) return new Set();
      const closing = {...q, end_time: q.close_end};
      const list = isFixed(i) ? [fx[i]] : cand[i];
      return new Set(list.filter(k => !ctx.staticIssues(emps[k], closing).length));
    });
    const groups = new Map();
    seats.forEach((q, i) => {
      if (!gkey[i] || !canClose[i].size) return;
      if (!groups.has(gkey[i])) groups.set(gkey[i], {need: closersNeeded.get(gkey[i]), seats: []});
      groups.get(gkey[i]).seats.push(i);
    });
    const hasW = emps.map((e, k) => seats.some((q, i) => canClose[i].has(k)));
    const nCloserEmps = hasW.filter(Boolean).length;
    const totalNeed = [...closersNeeded.values()].reduce((a, b) => a + b, 0);
    const fair = Math.ceil(totalNeed / Math.max(1, nCloserEmps));

    const dayFirst = {};
    for (const q of seats) dayFirst[q.plan_date] = Math.min(dayFirst[q.plan_date] ?? Infinity, toMin(q.start_time));
    const hoursLate = seats.map(q => Math.floor((toMin(q.start_time) - dayFirst[q.plan_date]) / 60));
    const seatMin = seats.map(q => { const end = q.shift_end || q.close_end; return end ? spanMin(q.start_time, end) : 0; });
    const dayIdx = seats.map(q => Math.round((Date.parse(q.plan_date + "T00:00:00Z") - Date.parse(ctx.weekStart + "T00:00:00Z")) / 86400000));
    const weekend = seats.map(q => [5, 6].includes(weekdayOf(q.plan_date)));
    const secondary = seats.map(q => emps.map(e => !!q.station_id && ctx.skill.get(`${e.id}|${q.station_id}`) === "secondary"));

    const share = Math.ceil(n / Math.max(1, E));
    const fixedCount = emps.map((e, k) => fx.filter(f => f === k).length);
    const inMin = [], inMinH = [], cap = [];
    emps.forEach((e, k) => {
      const mine = seats.map((q, i) => i).filter(i => candSet[i].has(k));
      const fixedMine = seats.map((q, i) => i).filter(i => fx[i] === k);
      inMin[k] = mine.length + fixedMine.length > 0;
      let possibleDays = new Set([...mine, ...fixedMine].map(i => seats[i].plan_date)).size;
      const max = e.max_shifts_week;
      if (max !== null && max !== undefined) possibleDays = Math.min(possibleDays, max);
      inMinH[k] = inMin[k] && possibleDays >= share;
      cap[k] = max === null || max === undefined ? Infinity : Math.max(0, max - fixedCount[k]);
    });
    const cleanup = ctx.cleanup;

    const shifts = new Int32Array(E), closes = new Int32Array(E), hours = new Int32Array(E),
      wk = new Int32Array(E), mask = new Int32Array(E);
    function score(asg, cls) {
      shifts.fill(0); closes.fill(0); hours.fill(0); wk.fill(0); mask.fill(0);
      let filled = 0, closed = 0, late = 0, sec = 0;
      for (let i = 0; i < n; i++) {
        const k = asg[i];
        if (k < 0) continue;
        if (!isFixed(i)) { filled++; if (secondary[i][k]) sec++; }
        shifts[k]++;
        hours[k] += seatMin[i];
        if (cls[i]) {
          closed++; closes[k]++; hours[k] += cleanup; late += hoursLate[i];
          if (weekend[i]) wk[k]++;
          mask[k] |= 1 << dayIdx[i];
        }
      }
      let once = 0, maxH = 0, minH = 20000, maxS = 0, minS = 20, maxC = 0, minC = 20, pen = 0;
      for (let k = 0; k < E; k++) {
        if (hours[k] > maxH) maxH = hours[k];
        if (shifts[k] > maxS) maxS = shifts[k];
        if (closes[k] > maxC) maxC = closes[k];
        if (inMin[k]) {
          if (shifts[k] < minS) minS = shifts[k];
          if (closes[k] < minC) minC = closes[k];
        }
        if (inMinH[k] && hours[k] < minH) minH = hours[k];
        if (hasW[k]) {
          if (closes[k]) once++;
          pen += 150 * Math.max(0, closes[k] - fair) + 500 * Math.max(0, wk[k] - 1) + 300 * popcount(mask[k] & (mask[k] >> 1));
        }
      }
      return 100000 * filled + 10000 * closed + 2000 * once - 5 * (maxH - minH) - pen - 50 * (maxC - minC)
        + 10 * late - 50 * sec - 20 * (maxS - minS);
    }
    return {n, E, emps, eIdx, fx, isFixed, cand, candSet, conf, gkey, canClose, groups, hoursLate, cap, score};
  }

  async function solveWeek(ctx, seats, fixed, closersNeeded, opts = {}) {
    const M = prepare(ctx, seats, fixed, closersNeeded);
    const {n, E, fx, isFixed, cand, candSet, conf, canClose, groups, hoursLate, cap} = M;
    const rand = rng(opts.seed ?? 20260927);
    const timeMs = opts.timeMs ?? 2500;
    const pick = arr => arr[Math.floor(rand() * arr.length)];
    const free = seats.map((q, i) => i).filter(i => !isFixed(i) && cand[i].length);
    const closable = [...groups.values()].flatMap(g => g.seats);

    const asg = new Int32Array(n), cls = new Uint8Array(n);
    const nonFixedCount = new Int32Array(E);

    // שינויים עם אפשרות ביטול
    let log = [];
    function setAsg(i, k) {
      log.push([i, asg[i], cls[i]]);
      if (asg[i] >= 0 && !isFixed(i)) nonFixedCount[asg[i]]--;
      asg[i] = k;
      if (k >= 0 && !isFixed(i)) nonFixedCount[k]++;
      if (cls[i] && (k < 0 || !canClose[i].has(k))) cls[i] = 0;
    }
    function setCls(i, v) { log.push([i, asg[i], cls[i]]); cls[i] = v; }
    function undo() {
      for (let t = log.length - 1; t >= 0; t--) {
        const [i, a, c] = log[t];
        if (asg[i] !== a) {
          if (asg[i] >= 0 && !isFixed(i)) nonFixedCount[asg[i]]--;
          if (a >= 0 && !isFixed(i)) nonFixedCount[a]++;
          asg[i] = a;
        }
        cls[i] = c;
      }
      log = [];
    }
    const conflictsOf = (k, i, ignore = -1) => {
      const out = [];
      for (let j = 0; j < n; j++) if (j !== i && j !== ignore && asg[j] === k && conf[i][j]) out.push(j);
      return out;
    };
    const fitsCap = (k, extra = 1) => nonFixedCount[k] + extra <= cap[k];
    const canTake = (k, i, ignore = -1) => candSet[i].has(k) && !conflictsOf(k, i, ignore).length;

    function greedy() {
      asg.fill(-1); cls.fill(0); nonFixedCount.fill(0);
      for (let i = 0; i < n; i++) if (isFixed(i)) asg[i] = fx[i];
      const hours = new Float64Array(E);
      const order = [...free].sort((a, b) => cand[a].length - cand[b].length || rand() - 0.5);
      for (const i of order) {
        let best = -1, bestH = Infinity;
        for (const k of cand[i]) {
          if (!fitsCap(k) || conflictsOf(k, i).length) continue;
          const h = hours[k] + rand();
          if (h < bestH) { bestH = h; best = k; }
        }
        if (best >= 0) { asg[i] = best; nonFixedCount[best]++; hours[best] += 1; }
      }
      const closesOf = new Int32Array(E);
      for (const g of groups.values()) {
        const opts = g.seats.filter(i => asg[i] >= 0 && canClose[i].has(asg[i]))
          .sort((a, b) => closesOf[asg[a]] - closesOf[asg[b]] || hoursLate[b] - hoursLate[a]);
        for (const i of opts.slice(0, g.need)) { cls[i] = 1; closesOf[asg[i]]++; }
      }
      log = [];
    }

    // מהלכים. מחזיר false אם המהלך לא אפשרי (ואז אין מה לבטל)
    function moveReassign() {
      const i = pick(free);
      const k = pick(cand[i]);
      if (k === asg[i]) return false;
      const old = asg[i];
      const conflicts = conflictsOf(k, i);
      if (conflicts.some(isFixed)) return false;
      let ejected = conflicts;
      if (!fitsCap(k, 1 - conflicts.length)) {
        const others = free.filter(j => j !== i && asg[j] === k && !conflicts.includes(j));
        if (!others.length) return false;
        ejected = [...conflicts, pick(others)];
      }
      const wasClosing = cls[i];
      setAsg(i, k);
      for (const j of ejected) setAsg(j, -1);
      if (old >= 0) {
        for (const j of ejected) {
          if (canTake(old, j) && fitsCap(old)) { setAsg(j, old); break; }
        }
      }
      if (wasClosing && !cls[i] && canClose[i].has(k)) setCls(i, 1);
      return true;
    }
    function moveSwap() {
      const i = pick(free), j = pick(free);
      const a = asg[i], b = asg[j];
      if (i === j || a === b) return false;
      if (b >= 0 && !canTake(b, i, j)) return false;
      if (a >= 0 && !canTake(a, j, i)) return false;
      const ci = cls[i], cj = cls[j];
      setAsg(i, b); setAsg(j, a);
      if (ci && b >= 0 && canClose[i].has(b)) setCls(i, 1);
      if (cj && a >= 0 && canClose[j].has(a)) setCls(j, 1);
      return true;
    }
    function moveClose() {
      if (!closable.length) return false;
      const i = pick(closable);
      if (asg[i] < 0 || !canClose[i].has(asg[i])) return false;
      const g = groups.get(M.gkey[i]);
      const on = g.seats.filter(j => cls[j]);
      if (cls[i]) {
        setCls(i, 0);
        if (rand() < 0.6) {
          const alt = g.seats.filter(j => j !== i && !cls[j] && asg[j] >= 0 && canClose[j].has(asg[j]));
          if (alt.length) setCls(pick(alt), 1);
        }
      } else {
        setCls(i, 1);
        if (on.length >= g.need) setCls(pick(on), 0);
      }
      return true;
    }
    function moveDrop() {
      const i = pick(free);
      if (asg[i] < 0) return false;
      setAsg(i, -1);
      return true;
    }

    // ליטוש: עובר על כל ההחלפות האפשריות ומקבל כל שיפור, עד שאין יותר
    function polish(cur) {
      const tryIt = ok => {
        if (!ok) { undo(); return false; }
        const s = M.score(asg, cls);
        if (s > cur) { cur = s; log = []; return true; }
        undo();
        return false;
      };
      for (let improved = true, pass = 0; improved && pass < 20; pass++) {
        improved = false;
        for (const i of free) {
          for (const k of cand[i]) {
            if (k === asg[i] || !fitsCap(k) || conflictsOf(k, i).length) continue;
            log = [];
            const c = cls[i];
            setAsg(i, k);
            if (c && canClose[i].has(k)) setCls(i, 1);
            if (tryIt(true)) improved = true;
          }
          for (const j of free) {
            if (j <= i) continue;
            const a = asg[i], b = asg[j];
            if (a === b || (b >= 0 && !canTake(b, i, j)) || (a >= 0 && !canTake(a, j, i))) continue;
            // flip = גם הסוגר עובר ביניהן, רק כשהן באותה קבוצת סגירה (אותו יום)
            for (const flip of M.gkey[i] && M.gkey[i] === M.gkey[j] ? [false, true] : [false]) {
              log = [];
              const ci = cls[i], cj = cls[j];
              setAsg(i, b); setAsg(j, a);
              const [ni, nj] = flip ? [cj, ci] : [ci, cj];
              setCls(i, ni && b >= 0 && canClose[i].has(b) ? 1 : 0);
              setCls(j, nj && a >= 0 && canClose[j].has(a) ? 1 : 0);
              if (tryIt(true)) { improved = true; break; }
            }
          }
        }
        for (const g of groups.values()) {
          for (const i of g.seats) {
            for (const j of g.seats) {
              if (i === j || !cls[i] || cls[j] || asg[j] < 0 || !canClose[j].has(asg[j])) continue;
              log = [];
              setCls(i, 0); setCls(j, 1);
              if (tryIt(true)) improved = true;
            }
          }
        }
      }
      return cur;
    }

    let best = null, bestScore = -Infinity;
    const t0 = Date.now();
    const restarts = 3;
    for (let r = 0; r < restarts; r++) {
      greedy();
      let cur = M.score(asg, cls);
      if (cur > bestScore) { bestScore = cur; best = [Int32Array.from(asg), Uint8Array.from(cls)]; }
      if (!free.length && !closable.length) break;
      const tStart = Date.now(), budget = timeMs / restarts;
      const T0 = 2000, T1 = 1;
      let lastYield = Date.now();
      for (let it = 0; ; it++) {
        if ((it & 255) === 0) {
          const now = Date.now();
          if (now - tStart >= budget) break;
          if (now - lastYield > 40) { await new Promise(res => setTimeout(res, 0)); lastYield = Date.now(); }
        }
        const frac = Math.min(1, (Date.now() - tStart) / budget);
        const T = T0 * Math.pow(T1 / T0, frac);
        const u = rand();
        log = [];
        const ok = u < 0.5 ? moveReassign() : u < 0.7 ? moveSwap() : u < 0.97 ? moveClose() : moveDrop();
        if (!ok) { undo(); continue; }
        const s = M.score(asg, cls);
        const d = s - cur;
        if (d >= 0 || rand() < Math.exp(d / T)) {
          cur = s;
          log = [];
          if (cur > bestScore) { bestScore = cur; best = [Int32Array.from(asg), Uint8Array.from(cls)]; }
        } else {
          undo();
        }
      }
      asg.set(best[0]); cls.set(best[1]);
      nonFixedCount.fill(0);
      for (let i = 0; i < n; i++) if (asg[i] >= 0 && !isFixed(i)) nonFixedCount[asg[i]]++;
      log = [];
      cur = polish(bestScore);
      if (cur > bestScore) { bestScore = cur; best = [Int32Array.from(asg), Uint8Array.from(cls)]; }
    }
    const result = new Map(), closers = new Set();
    for (let i = 0; i < n; i++) {
      if (best[0][i] >= 0) result.set(i, M.emps[best[0][i]].id);
      if (best[1][i]) closers.add(i);
    }
    return {result, closers, score: bestScore, elapsed: Date.now() - t0};
  }

  return {solveWeek, prepare};
})();
