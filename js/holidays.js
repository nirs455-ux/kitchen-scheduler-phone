// חגים וערבי חג לפי הלוח העברי של הדפדפן (Intl), במקום pyluach שבגרסת המחשב.
// אותם שמות ואותם כללים כמו pyluach (ישראל): חג = יום שבתון, "חג, יום עבודה" = חול המועד, חנוכה, פורים וכו'.
const Holidays = (() => {
  let fmt = null;
  try {
    fmt = new Intl.DateTimeFormat("en-u-ca-hebrew", {day: "numeric", month: "long", timeZone: "UTC"});
    const probe = fmt.formatToParts(new Date(Date.UTC(2026, 8, 12)));   // א' בתשרי תשפ"ז
    if (!probe.some(p => p.type === "month" && p.value === "Tishri")) fmt = null;
  } catch (e) { fmt = null; }

  const DAY = 86400000;
  function heb(t) {
    const parts = fmt.formatToParts(new Date(t));
    return {day: +parts.find(p => p.type === "day").value, month: parts.find(p => p.type === "month").value};
  }

  // t = חצות UTC של התאריך. מחזיר [שם, האם שבתון] או null
  function festival(t) {
    const {day, month} = heb(t);
    if (month === "Tishri") {
      if (day === 1 || day === 2) return ["ראש השנה", true];
      if (day === 10) return ["יום כיפור", true];
      if (day === 15) return ["סוכות", true];
      if (day >= 16 && day <= 21) return ["סוכות", false];
      if (day === 22) return ["שמיני עצרת", true];
    }
    if (month === "Shevat" && day === 15) return ["ט״ו בשבט", false];
    if (month === "Adar I" && day === 14) return ["פורים קטן", false];
    if (month === "Adar" || month === "Adar II") {
      if (day === 14) return ["פורים", false];
      if (day === 15) return ["שושן פורים", false];
    }
    if (month === "Nisan") {
      if (day === 15 || day === 21) return ["פסח", true];
      if (day >= 16 && day <= 20) return ["פסח", false];
    }
    if (month === "Iyar") {
      if (day === 14) return ["פסח שני", false];
      if (day === 18) return ["ל״ג בעומר", false];
    }
    if (month === "Sivan" && day === 6) return ["שבועות", true];
    if (month === "Av" && day === 15) return ["ט״ו באב", false];
    for (let k = 0; k < 8; k++) {
      const h = heb(t - k * DAY);
      if (h.month === "Kislev" && h.day === 25) return ["חנוכה", false];
    }
    return null;
  }

  const name = t => { const f = festival(t); return f ? f[0] : null; };
  const iso = t => new Date(t).toISOString().slice(0, 10);

  // כמו upcoming_holidays בגרסת המחשב. null = הדפדפן לא תומך בלוח העברי.
  function upcoming(todayIso, days = 75) {
    if (!fmt) return null;
    const [y, m, d] = todayIso.split("-").map(Number);
    const t0 = Date.UTC(y, m - 1, d);
    const out = [];
    let prev = name(t0 - DAY);
    for (let i = 0; i <= days; i++) {
      const t = t0 + i * DAY;
      const f = festival(t);
      const nxt = name(t + DAY);
      if (f) out.push({date: iso(t), name: f[0], kind: f[1] ? "חג" : "חג, יום עבודה"});
      else if (nxt && nxt !== prev) out.push({date: iso(t), name: "ערב " + nxt, kind: "ערב חג"});
      prev = f ? f[0] : null;
    }
    return out;
  }

  return {festival, upcoming, supported: () => !!fmt};
})();
