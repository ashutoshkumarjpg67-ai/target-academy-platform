/* Target Academy — Next-Level Enhancements (v71)
   1. Skeleton shimmer loaders
   2. Offline / online live status banner
   3. Daily Study Streak, XP & Level badges
   4. 1-Click WhatsApp Parent Report formatter & sharer */

export function skeletonHTML(kind = "dashboard") {
  if (kind === "list") {
    return `<div class="skel-wrap" aria-busy="true" aria-label="Loading">
      <div class="skel-card"><div class="skel-line w-40"></div><div class="skel-line w-90"></div><div class="skel-line w-70"></div></div>
      <div class="skel-card"><div class="skel-line w-55"></div><div class="skel-line w-85"></div><div class="skel-line w-60"></div></div>
      <div class="skel-card"><div class="skel-line w-45"></div><div class="skel-line w-80"></div></div>
    </div>`;
  }
  return `<div class="skel-wrap" aria-busy="true" aria-label="Loading">
    <div class="skel-card skel-hero"><div class="skel-line w-40"></div><div class="skel-line w-75"></div><div class="skel-line w-55"></div></div>
    <div class="skel-grid">
      <div class="skel-tile"><div class="skel-dot"></div><div class="skel-line w-60"></div><div class="skel-line w-45"></div></div>
      <div class="skel-tile"><div class="skel-dot"></div><div class="skel-line w-65"></div><div class="skel-line w-40"></div></div>
      <div class="skel-tile"><div class="skel-dot"></div><div class="skel-line w-55"></div><div class="skel-line w-50"></div></div>
      <div class="skel-tile"><div class="skel-dot"></div><div class="skel-line w-70"></div><div class="skel-line w-45"></div></div>
    </div>
    <div class="skel-card"><div class="skel-line w-40"></div><div class="skel-line w-90"></div><div class="skel-line w-75"></div></div>
  </div>`;
}

export function initOfflineBanner() {
  if (document.getElementById("offlineBar")) return;
  const bar = document.createElement("div");
  bar.id = "offlineBar";
  bar.className = "offline-bar hidden";
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span>📡</span><span><b>Offline Mode</b> — इंटरनेट नहीं है, कैश किया गया डेटा दिख रहा है</span>`;
  document.body.appendChild(bar);
  const sync = () => { bar.classList.toggle("hidden", navigator.onLine !== false); };
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  sync();
}

const LEVELS = [
  { min: 0, name: "Beginner", hi: "शुरुआत", badge: "🌱" },
  { min: 100, name: "Rising Star", hi: "उभरता सितारा", badge: "⭐" },
  { min: 300, name: "Scholar", hi: "मेधावी छात्र", badge: "🎓" },
  { min: 650, name: "Topper", hi: "टॉपर", badge: "🏆" },
  { min: 1200, name: "Legend", hi: "चैंपियन", badge: "👑" },
];

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + "T00:00:00").getTime();
  const b = new Date(isoB + "T00:00:00").getTime();
  return Math.round((b - a) / 86400000);
}

function loadStreak(userId) {
  const key = `ta_streak_${userId || "guest"}`;
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    if (raw && typeof raw === "object") return raw;
  } catch (_) {}
  return { streak: 0, best: 0, xp: 0, lastDay: "", seenEvents: {} };
}

function saveStreak(userId, st) {
  const key = `ta_streak_${userId || "guest"}`;
  try { localStorage.setItem(key, JSON.stringify(st)); } catch (_) {}
}

export function recordStudyActivity(userId, points = 10, eventId = "") {
  if (!userId) return loadStreak(userId);
  const st = loadStreak(userId);
  const today = todayKey();
  if (st.lastDay !== today) {
    if (st.lastDay && daysBetween(st.lastDay, today) === 1) st.streak = (st.streak || 0) + 1;
    else st.streak = 1;
    st.best = Math.max(st.best || 0, st.streak);
    st.lastDay = today;
    st.seenEvents = {};
    st.xp = (st.xp || 0) + 10;
  }
  if (eventId && !st.seenEvents[eventId]) {
    st.seenEvents[eventId] = 1;
    st.xp = (st.xp || 0) + Math.max(0, points);
  }
  saveStreak(userId, st);
  return st;
}

export function streakCardHTML(userId, { attemptsCount = 0, attPresent = 0 } = {}) {
  const st = recordStudyActivity(userId, 0);
  const totalXP = (st.xp || 0) + attemptsCount * 25 + attPresent * 5;
  let curIdx = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (totalXP >= LEVELS[i].min) curIdx = i;
  }
  const cur = LEVELS[curIdx];
  const next = LEVELS[curIdx + 1] || null;
  const pct = next ? Math.min(100, Math.round(((totalXP - cur.min) / (next.min - cur.min)) * 100)) : 100;
  const streak = Math.max(1, st.streak || 1);
  return `<div class="streak-card">
    <div class="sk-top">
      <div class="sk-flame">
        <span class="sk-fire">🔥</span>
        <div>
          <div class="sk-days">${streak} दिन की स्ट्रीक</div>
          <div class="sk-sub">बेस्ट: ${Math.max(streak, st.best || streak)} दिन • रोज़ पढ़ें, आगे बढ़ें</div>
        </div>
      </div>
      <div class="sk-lvl">
        <span class="sk-badge">${cur.badge} ${cur.name}</span>
        <div class="sk-xp">${totalXP.toLocaleString("en-IN")} XP</div>
      </div>
    </div>
    <div class="prog sk-prog"><div style="width:${pct}%"></div></div>
    <div class="sk-foot">
      <span>${cur.hi}</span>
      <span>${next ? `अगला लेवल (${next.name}): ${next.min - totalXP} XP बाकी` : "मैक्स लेवल हासिल! 👑"}</span>
    </div>
  </div>`;
}

export function shareWhatsAppReport(info = {}) {
  const lines = [
    "🎓 *Target Academy — Progress Report*",
    info.studentName ? `👤 छात्र: *${info.studentName}*${info.className ? ` (${info.className})` : ""}` : "",
    info.title ? `📝 टेस्ट: *${info.title}*` : "",
    info.score != null && info.maxScore != null ? `🏆 अंक: *${info.score}/${info.maxScore}* (${info.percent ?? 0}%) ${info.passed ? "✅ PASS" : "💪 प्रयास जारी"}` : "",
    info.right != null ? `📊 सही: ${info.right} | गलत: ${info.wrong ?? 0} | छोड़े: ${info.skip ?? 0}` : "",
    info.attendancePct != null ? `✅ उपस्थिति: *${info.attendancePct}%* (${info.attPresent ?? 0}/${info.attTotal ?? 0} दिन)` : "",
    info.feeDue != null ? `💰 फ़ीस स्थिति: ${info.feeDue > 0 ? `₹${info.feeDue.toLocaleString("en-IN")} बकाया` : "सब जमा ✅"}` : "",
    "— Target Academy Coaching Centre, Manikpur, Gopalganj",
  ].filter(Boolean);
  const text = lines.join("\n");
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener");
  return text;
}

/* ---------- v75: Cloud TTS (Gemini voice via Supabase Edge Function "tts") ---------- */
const _ttsCache = new Map();
function pcmToWavBlob(b64, rate = 24000) {
  const bin = atob(b64), len = bin.length;
  const buf = new ArrayBuffer(44 + len), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + len, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, len, true);
  const u8 = new Uint8Array(buf, 44);
  for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: "audio/wav" });
}
export async function cloudTTS(sb, text, voice = "Kore") {
  const key = voice + "|" + text;
  if (_ttsCache.has(key)) return _ttsCache.get(key);
  const { data, error } = await sb.functions.invoke("tts", { body: { text, voice } });
  if (error || !data || !data.audio) throw new Error((data && data.error) || (error && error.message) || "tts failed");
  const url = URL.createObjectURL(pcmToWavBlob(data.audio, data.sampleRate || 24000));
  if (_ttsCache.size >= 12) { const first = _ttsCache.keys().next().value; try { URL.revokeObjectURL(_ttsCache.get(first)); } catch (_) {} _ttsCache.delete(first); }
  _ttsCache.set(key, url);
  return url;
}

/* ---------- v75: Offline snapshots (last seen screen readable without internet) ---------- */
const SNAP_TABS = new Set(["home", "study", "tests", "fees", "attendance", "timetable", "homework", "notif", "live", "top"]);
const snapKey = (uid, tab) => `ta_snap_${uid}_${tab}`;
export function saveSnapshot(uid, tab, html) {
  if (!uid || !SNAP_TABS.has(tab) || !html || html.length > 400000) return;
  if (html.includes("skel-wrap") || html.includes('class="loading"')) return;
  try { localStorage.setItem(snapKey(uid, tab), JSON.stringify({ t: Date.now(), html })); } catch (_) { /* quota */ }
}
export function loadSnapshot(uid, tab) {
  try { const o = JSON.parse(localStorage.getItem(snapKey(uid, tab)) || "null"); return o && o.html ? o : null; } catch (_) { return null; }
}
export function watchSnapshots(root, getCtx) {
  // v81: lightweight snapshot only on pagehide/visibilitychange (never continuous
  // MutationObserver, which previously serialized innerHTML on every timer tick).
  const run = () => {
    const c = getCtx();
    if (!c || !c.userId || !c.online || c.view !== "tab") return;
    saveSnapshot(c.userId, c.tab, root.innerHTML);
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") run(); });
  window.addEventListener("pagehide", run);
}

/* ---------- v75: Realtime notifications ---------- */
let _rt = null;
export function subscribeRealtime(sb, userId, onNotice) {
  if (_rt || !userId) return;
  try {
    _rt = sb.channel("ta-notif-" + userId)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: "user_id=eq." + userId }, (p) => { try { onNotice(p.new); } catch (_) {} })
      .subscribe();
  } catch (_) { _rt = null; }
}
