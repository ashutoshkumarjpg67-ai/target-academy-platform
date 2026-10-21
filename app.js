import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js?v=16";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $app = document.getElementById("app");
const $tabbar = document.getElementById("tabbar");
const $logout = document.getElementById("logoutBtn");
const $bell = document.getElementById("bellBtn");
const $toast = document.getElementById("toast");

let me = null;        // auth user
let profile = null;   // profiles row (role, full_name...)
let myClasses = [];   // classes visible to me
let tab = "home";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(msg, ms = 2600) {
  $toast.textContent = msg; $toast.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => $toast.classList.add("hidden"), ms);
}
const isStaff = () => profile && (profile.role === "admin" || profile.role === "teacher");

/* ---------------- Photo pick (Camera / Gallery) + auto-compress ----------------
   Compression runs 100% inside the browser (Canvas) — free, no server/AI
   cost. A 3-5 MB camera photo typically becomes 150-350 KB, so storage
   use drops ~90%. Non-image files pass through untouched. */
const fmtKB = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

async function compressImageFile(file, maxDim = 1280, quality = 0.82) {
  if (!file || !/^image\//.test(file.type) || file.type === "image/gif") return file;
  try {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (_) { bmp = await createImageBitmap(file); }
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size <= 350 * 1024) { if (bmp.close) bmp.close(); return file; }
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", quality));
    if (!blob || blob.size >= file.size) return file;
    const base = (file.name || "photo").replace(/\.[^.]+$/, "");
    return new File([blob], base + ".jpg", { type: "image/jpeg" });
  } catch (_) { return file; }
}

async function prepareUploadFile(file) {
  const out = await compressImageFile(file);
  if (out !== file) toast(`📷 Photo compress हो गया: ${fmtKB(file.size)} → ${fmtKB(out.size)}`);
  return out;
}

// Turns a plain <input type=file> into a "📷 Camera / 🖼️ Gallery" picker.
// The chosen file is placed back into the original input, so existing
// save handlers keep reading input.files[0] unchanged.
function enhanceFilePicker(input, { imageOnly = false } = {}) {
  if (!input || input.dataset.enhanced) return;
  input.dataset.enhanced = "1";
  input.style.display = "none";
  const cam = document.createElement("input");
  cam.type = "file"; cam.accept = "image/*"; cam.capture = "environment"; cam.style.display = "none";
  const wrap = document.createElement("div");
  wrap.className = "filepick";
  wrap.innerHTML = `
    <div class="fp-btns">
      <button type="button" class="light fp-cam">📷 Camera</button>
      <button type="button" class="light fp-gal">${imageOnly ? "🖼️ Gallery" : "📁 File / Gallery"}</button>
    </div>
    <div class="fp-name muted">कोई file नहीं चुनी</div>`;
  input.after(cam, wrap);
  const nameEl = wrap.querySelector(".fp-name");
  const pick = (f) => {
    if (!f) return;
    try { const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; } catch (_) {}
    nameEl.textContent = `✔ ${f.name} (${fmtKB(f.size)})`;
  };
  wrap.querySelector(".fp-cam").onclick = () => cam.click();
  wrap.querySelector(".fp-gal").onclick = () => input.click();
  cam.onchange = () => { pick(cam.files[0]); cam.value = ""; };
  input.addEventListener("change", () => pick(input.files[0]));
}

/* ---------------- Photo viewer (click → बड़ा) ---------------- */
function viewPhoto(url) {
  if (!url) return;
  closePhoto();
  const d = document.createElement("div");
  d.className = "lightbox"; d.id = "photoLightbox";
  d.innerHTML = `<button class="lb-x" aria-label="बंद करें">✕</button><img src="${url}" alt="photo">`;
  d.onclick = () => closePhoto();
  document.body.appendChild(d);
}
function closePhoto() { const d = document.getElementById("photoLightbox"); if (d) d.remove(); }
document.addEventListener("click", (e) => {
  const t = e.target.closest ? e.target.closest("[data-zoom]") : null;
  if (t) viewPhoto(t.dataset.zoom);
});

/* ---------------- Notifications ---------------- */
async function notifyUsers(userIds, kind, title, body) {
  try {
    const rows = [...new Set(userIds || [])].filter(id => id && (!me || id !== me.id))
      .map(user_id => ({ user_id, kind, title, body: body || null }));
    if (rows.length) {
      await sb.from("notifications").insert(rows);
      // Phone push as well (fire-and-forget): reaches students even
      // when the app is closed, if they enabled phone notifications.
      try {
        sb.functions.invoke("push", { body: { action: "send", user_ids: rows.map(r => r.user_id), title, body: body || "" } }).then(() => {}, () => {});
      } catch (_) { /* push must never break the main action */ }
    }
  } catch (_) { /* notifications must never break the main action */ }
}
async function notifyClassStudents(classId, kind, title, body) {
  if (!classId) return;
  const { data } = await sb.from("enrollments").select("user_id").eq("class_id", classId);
  await notifyUsers((data || []).map(e => e.user_id), kind, title, body);
}
async function refreshBell() {
  const badge = document.getElementById("bellBadge");
  if (!badge || !me) return;
  const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", me.id).eq("is_read", false);
  if (count) { badge.textContent = count > 99 ? "99+" : count; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");
}

/* ---------------- Phone push (Web Push, v20) ---------------- */
if ("serviceWorker" in navigator) { navigator.serviceWorker.register("sw.js").catch(() => {}); }
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function savePushSub(sub) {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys) return;
  await sb.from("push_subscriptions").upsert(
    { user_id: me.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200) },
    { onConflict: "endpoint" });
}
async function syncPush() {
  try {
    if (!pushSupported() || Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { data } = await sb.functions.invoke("push", { body: { action: "config" } });
      if (!data?.publicKey) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(data.publicKey) });
    }
    await savePushSub(sub);
  } catch (_) { /* push is optional; never block the app */ }
}
async function enablePush() {
  if (!pushSupported()) { toast("इस browser में phone सूचना नहीं चलती — Chrome से खोलें"); return; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("सूचना की अनुमति नहीं मिली — browser settings में Allow करें"); return; }
  await syncPush();
  toast("📲 Phone सूचना चालू हो गई!");
  if (tab === "notif") renderNotifs();
}
const roleName = (r) => ({admin:"Admin • व्यवस्थापक", teacher:"Teacher • शिक्षक", student:"Student • छात्र", parent:"Parent • अभिभावक"}[r] || r);

/* ---------------- Auth screens ---------------- */
function renderAuth(mode = "login") {
  document.body.classList.add("auth-mode");
  $tabbar.classList.add("hidden"); $logout.classList.add("hidden"); if ($bell) $bell.classList.add("hidden");
  $app.innerHTML = `
    <div class="hero">
      <img src="icon.svg" alt="Target Academy logo" class="auth-logo" data-zoom="icon.svg">
      <span class="badge">ADMISSION OPEN</span>
      <h1>पढ़ाई अब हर घर तक 📚</h1>
      <p>Target Academy के notes, study material और online tests — अब एक ही app में। Login करके अपनी class की पढ़ाई शुरू करें।</p>
    </div>
    <div class="card">
      <h3>${mode === "login" ? "Login करें" : "नया खाता बनाएँ (Sign up)"}</h3>
      ${mode === "signup" ? `<label>पूरा नाम (Full name)</label><input id="f_name" autocomplete="name" placeholder="जैसे: Rahul Kumar">` : ""}
      <label>Email</label>
      <input id="f_email" type="email" autocomplete="email" placeholder="you@example.com">
      <label>Password</label>
      <input id="f_pass" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" placeholder="••••••••">
      <div class="error" id="authErr"></div>
      <button class="gold" id="authGo" style="width:100%">${mode === "login" ? "Login" : "खाता बनाएँ"}</button>
      <p style="margin-top:12px">
        ${mode === "login"
          ? `खाता नहीं है? <button class="link" id="authSwap">Sign up करें</button>`
          : `पहले से खाता है? <button class="link" id="authSwap">Login करें</button>`}
      </p>
      <p class="muted">नया खाता बनने पर आप Student बनेंगे। Teacher/Admin की भूमिका Academy द्वारा दी जाएगी।</p>
    </div>`;
  document.getElementById("authSwap").onclick = () => renderAuth(mode === "login" ? "signup" : "login");
  document.getElementById("authGo").onclick = async () => {
    const email = document.getElementById("f_email").value.trim();
    const pass = document.getElementById("f_pass").value;
    const err = document.getElementById("authErr");
    err.textContent = "";
    try {
      if (mode === "signup") {
        const name = document.getElementById("f_name").value.trim();
        if (!name) throw new Error("कृपया अपना नाम लिखें");
        const { error } = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
        if (error) throw error;
        toast("खाता बन गया! अब Login करें (email confirm माँगे तो inbox देखें)");
        renderAuth("login");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        await boot();
      }
    } catch (e) { err.textContent = e.message; }
  };
}

/* ---------------- Boot / session ---------------- */
async function boot() {
  const { data } = await sb.auth.getUser();
  me = data?.user || null;
  if (!me) { renderAuth("login"); return; }
  const { data: prof, error } = await sb.from("profiles").select("*").eq("id", me.id).single();
  if (error || !prof) { $app.innerHTML = `<div class="card"><h3>Profile नहीं मिली</h3><p>कृपया Academy से संपर्क करें।</p></div>`; return; }
  profile = prof;
  const { data: cls } = await sb.from("classes").select("*").order("sort_order");
  myClasses = cls || [];
  $logout.classList.remove("hidden");
  if ($bell) { $bell.classList.remove("hidden"); $bell.onclick = () => { tab = "notif"; renderShell(); }; refreshBell(); }
  syncPush();
  renderShell();
}
$logout.onclick = async () => { await sb.auth.signOut(); location.reload(); };

/* ---------------- Shell + tabs ---------------- */
function renderShell() {
  const tabs = [
    { id: "home", ic: "🏠", label: "Home" },
    { id: "study", ic: "📚", label: "Notes" },
    { id: "tests", ic: "📝", label: "Tests" },
    ...(!isStaff() ? [{ id: "fees", ic: "💰", label: "Fees" }] : []),
    ...(isStaff() ? [{ id: "manage", ic: "🛠️", label: "Manage" }] : []),
    ...(profile.role === "admin" ? [{ id: "users", ic: "👥", label: "Users" }] : []),
    { id: "more", ic: "☰", label: "More" },
  ];
  document.body.classList.remove("auth-mode");
  const navHTML = tabs.map(t => `<button data-tab="${t.id}" class="${tab === t.id ? "active" : ""}"><span class="ic">${t.ic}</span>${t.label}</button>`).join("");
  const extraTabs = [
    { id: "doubts", ic: "❓", label: "Doubts" },
    { id: "tutor", ic: "🤖", label: "AI Tutor" },
    { id: "live", ic: "📺", label: "Live Class" },
    { id: "top", ic: "🏆", label: "Leaderboard" },
    { id: "homework", ic: "📒", label: "Homework" },
    { id: "attendance", ic: "✅", label: "Attendance" },
    { id: "timetable", ic: "🗓️", label: "Timetable" },
  ];
  const sideTabs = [...tabs.slice(0, -1), ...extraTabs, tabs[tabs.length - 1]];
  const sideHTML = sideTabs.map(t => `<button data-tab="${t.id}" class="${tab === t.id ? "active" : ""}"><span class="ic">${t.ic}</span>${t.label}</button>`).join("");
  $tabbar.innerHTML = navHTML;
  $tabbar.classList.remove("hidden");
  const $sidenav = document.getElementById("sidenav");
  if ($sidenav) {
    $sidenav.innerHTML = sideHTML;
    $sidenav.querySelectorAll("button").forEach(b => b.onclick = () => { tab = b.dataset.tab; renderShell(); });
  }
  $tabbar.querySelectorAll("button").forEach(b => b.onclick = () => { tab = b.dataset.tab; renderShell(); });
  ({ home: renderHome, study: renderStudy, tests: renderTests, fees: renderFeesStudent, doubts: renderDoubts, tutor: renderTutor, live: renderLive, top: renderTop, notif: renderNotifs, homework: renderHomework, attendance: renderAttendance, timetable: renderTimetable, manage: renderManage, users: renderUsers, more: renderMore }[tab] || renderHome)();
}

/* ---------------- Home (EduPlus-style dashboard) ---------------- */
function dayGreet() {
  const h = new Date().getHours();
  return h < 12 ? "Good Morning" : h < 17 ? "Good Afternoon" : "Good Evening";
}
function subjStyle(name = "") {
  const n = name.toLowerCase();
  if (n.includes("math") || n.includes("गणित")) return { i: "π", c: "#7c3aed" };
  if (n.includes("phys") || n.includes("भौतिक")) return { i: "⚛", c: "#16a34a" };
  if (n.includes("chem") || n.includes("रसायन")) return { i: "🧪", c: "#ea580c" };
  if (n.includes("bio") || n.includes("जीव")) return { i: "🌿", c: "#059669" };
  if (n.includes("eng")) return { i: "A", c: "#dc2626" };
  if (n.includes("hindi") || n.includes("हिन्दी") || n.includes("हिंदी")) return { i: "अ", c: "#b45309" };
  if (n.includes("social") || n.includes("sst") || n.includes("सामाजिक")) return { i: "🌍", c: "#0891b2" };
  if (n.includes("comp") || n.includes("कंप्यूटर")) return { i: "💻", c: "#4f46e5" };
  if (n.includes("sanskrit") || n.includes("संस्कृत")) return { i: "ॐ", c: "#be185d" };
  if (n.includes("sci") || n.includes("विज्ञान")) return { i: "🔬", c: "#0d9488" };
  return { i: "📘", c: "#17457f" };
}
function greetHTML(sub) {
  return `<div class="greet">
    <div class="avatar">${esc((profile.full_name || "T").trim()[0].toUpperCase())}</div>
    <div><div class="g1">${dayGreet()} 🌤️ • ${esc(roleName(profile.role))}</div>
    <div class="g2">${esc(profile.full_name)}</div>
    <div class="g3">${esc(sub)}</div></div></div>`;
}
function qaHTML(items) {
  return `<div class="qa-grid">${items.map(x => `
    <div class="qa" data-go="${x.go}"><div class="qi" style="background:${x.bg}">${x.ic}</div><div class="ql">${x.label}</div></div>`).join("")}</div>`;
}
function wireQA() {
  $app.querySelectorAll("[data-go]").forEach(el => el.onclick = () => { tab = el.dataset.go; renderShell(); });
}

async function renderHome() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  if (!isStaff()) {
    const [{ data: enr }, { data: subjects }, { data: chapters }, { data: notes }, { data: mats }, { data: prog }, { data: attempts }, { data: anns }] = await Promise.all([
      sb.from("enrollments").select("class_id").eq("user_id", me.id),
      sb.from("subjects").select("*").order("sort_order"),
      sb.from("chapters").select("*").order("sort_order"),
      sb.from("notes").select("id,class_id,subject_id").eq("status", "published"),
      sb.from("materials").select("id,class_id,subject_id").eq("status", "published"),
      sb.from("content_progress").select("*").eq("user_id", me.id).eq("completed", true),
      sb.from("test_attempts").select("*").eq("student_id", me.id).neq("status", "in_progress").order("submitted_at", { ascending: false }),
      sb.from("announcements").select("*").order("created_at", { ascending: false }).limit(4),
    ]);
    const enrolledIds = (enr || []).map(e => e.class_id);
    const mySubjs = (subjects || []).filter(s => enrolledIds.includes(s.class_id));
    const items = [...(notes || []).map(n => ({ ...n, type: "note" })), ...(mats || []).map(m => ({ ...m, type: "material" }))];
    const doneSet = new Set((prog || []).map(p => p.item_type + ":" + p.item_id));
    const totalItems = items.length;
    const doneItems = items.filter(x => doneSet.has(x.type + ":" + x.id)).length;
    const syllabusPct = totalItems ? Math.round((doneItems / totalItems) * 100) : 0;
    const testsGiven = (attempts || []).length;
    const accuracy = testsGiven ? Math.round((attempts || []).reduce((s, a) => s + (+a.percent || 0), 0) / testsGiven) : 0;
    // मेरा लक्ष्य algorithm: tests से 60% (आधा = कितनी बार test दिया, आधा = औसत score) + पढ़ाई से 40%।
    // Notes/materials ही न हों तो पूरा % tests से बनता है।
    const activityPct = Math.min(100, testsGiven * 20);
    const testPct = Math.round(0.5 * activityPct + 0.5 * accuracy);
    const goalPct = totalItems ? Math.round(0.6 * testPct + 0.4 * syllabusPct) : testPct;
    const quotes = ["अनुशासन आज, सफलता कल। मेहनत कभी बेकार नहीं जाती।", "छोटे-छोटे कदम रोज़ — बड़ी मंज़िल एक दिन।", "आज का अभ्यास, कल का परिणाम।"];
    const quote = quotes[new Date().getDate() % quotes.length];

    $app.innerHTML = `
      ${greetHTML("Keep going! आपकी मेहनत रंग लाएगी ✨")}
      <div class="goal">
        <h2>मेरा लक्ष्य 🎯</h2>
        <div class="sub">पढ़ें • अभ्यास करें • सफल हों</div>
        <div class="prog"><div style="width:${goalPct}%"></div></div>
        <div class="pct">${goalPct}% लक्ष्य पूरा 🎯</div>
        <div class="pct" style="font-weight:600; opacity:.85">📝 Tests: ${testsGiven} दिए • औसत Score ${accuracy}% &nbsp;•&nbsp; 📚 Notes: ${totalItems ? `${doneItems}/${totalItems} पढ़े` : "अभी नहीं आए"}</div>
        <div class="pct" style="font-weight:600; opacity:.85">${testsGiven ? "और tests दें, score सुधारें — % और बढ़ेगा 📈" : "पहला test देकर शुरुआत करें — % बढ़ना शुरू होगा 📈"}</div>
        <span class="quote">“${quote}”</span>
        <svg class="mount" viewBox="0 0 200 90" aria-hidden="true"><circle cx="168" cy="16" r="10" fill="#ffd23e"/><path d="M0 90 L55 34 L86 62 L118 18 L150 52 L200 90 Z" fill="#17457f" opacity=".28"/><path d="M62 90 L118 18 L172 90 Z" fill="#0e2f5e" opacity=".5"/><path d="M118 18 L128 30 L118 36 L107 29 Z" fill="#fff"/><rect x="117" y="2" width="2.4" height="17" fill="#8a6400"/><path d="M119.5 2 L133 6 L119.5 10 Z" fill="#d64541"/></svg>
        <div style="margin-top:12px"><button class="small" data-go="study">पढ़ाई जारी रखें →</button></div>
      </div>
      ${qaHTML([
        { go: "tests", ic: "📝", label: "Test दें", bg: "#fde8e8" },
        { go: "study", ic: "📚", label: "Notes पढ़ें", bg: "#e2f4ec" },
        { go: "fees", ic: "💰", label: "मेरी Fees", bg: "#e8effe" },
        { go: "more", ic: "👤", label: "My Profile", bg: "#fdf3d7" },
      ])}
      <div class="card"><h3>📊 मेरी प्रगति</h3>
        <div class="stats">
          <div class="stat"><div class="si" style="background:#e8f1fe">📝</div><div class="n">${testsGiven}</div><div class="l">Tests दिए</div></div>
          <div class="stat"><div class="si" style="background:#e2f4ec">🎯</div><div class="n">${accuracy}%</div><div class="l">औसत Score</div></div>
          <div class="stat"><div class="si" style="background:#efe7fd">🎓</div><div class="n">${enrolledIds.length}</div><div class="l">मेरी Classes</div></div>
        </div></div>
      <div class="card"><h3>📖 पढ़ाई जारी रखें</h3>
        ${mySubjs.length ? `<div class="subj-grid">${mySubjs.map(s => {
          const st = subjStyle(s.name);
          const sItems = items.filter(x => x.subject_id === s.id);
          const sDone = sItems.filter(x => doneSet.has(x.type + ":" + x.id)).length;
          const p = sItems.length ? Math.round((sDone / sItems.length) * 100) : 0;
          return `<div class="subj" data-entersubj="${s.class_id}" style="cursor:pointer"><div class="sic" style="background:${st.c}">${st.i}</div>
            <div style="flex:1"><div class="st">${esc(s.name)}${s.name_hi ? ` • ${esc(s.name_hi)}` : ""}</div>
            <div class="ss">${(chapters || []).filter(c => c.subject_id === s.id).length} Chapters</div>
            <div class="bar"><div style="width:${p}%; background:${st.c}"></div></div></div>
            <div class="sp">${p}%</div></div>`;
        }).join("")}</div>` : `<p>अभी किसी class में enrollment नहीं है। Academy में संपर्क करें — आपका नाम आपकी class में जोड़ दिया जाएगा।</p>`}
      </div>
      <div class="card"><h3>🕘 ताज़ा गतिविधि</h3>
        ${(attempts || []).slice(0, 3).map(a => `<div class="act"><div class="ai" style="background:${a.passed ? "#e2f4ec" : "#fdecea"}">${a.passed ? "🏆" : "📝"}</div>
          <div><div class="at">Test पूरा किया — Score ${a.score}/${a.max_score} (${a.percent}%)</div>
          <div class="as">${new Date(a.submitted_at).toLocaleString("hi-IN")}</div></div></div>`).join("")}
        ${(anns || []).map(a => `<div class="act"><div class="ai" style="background:#fdf3d7">📢</div>
          <div><div class="at">${esc(a.title)}</div><div class="as">${esc(a.body || "")}</div></div></div>`).join("")}
        ${!(attempts || []).length && !(anns || []).length ? `<p>अभी कोई गतिविधि नहीं है।</p>` : ""}
      </div>`;
    wireQA();
    $app.querySelectorAll("[data-entersubj]").forEach(el => el.onclick = () => { studyClassId = +el.dataset.entersubj; tab = "study"; renderShell(); });
    return;
  }

  // ---- Staff / Admin dashboard ----
  const [{ count: sc }, { count: qc }, { count: tc }, { data: recentUsers }, { data: recentAttempts }, { data: anns }, { data: profs }] = await Promise.all([
    sb.from("profiles").select("*", { count: "exact", head: true }).eq("role", "student"),
    sb.from("questions").select("*", { count: "exact", head: true }),
    sb.from("tests").select("*", { count: "exact", head: true }),
    sb.from("profiles").select("*").order("created_at", { ascending: false }).limit(4),
    sb.from("test_attempts").select("*").neq("status", "in_progress").order("submitted_at", { ascending: false }).limit(4),
    sb.from("announcements").select("*").order("created_at", { ascending: false }).limit(3),
    sb.from("profiles").select("id,full_name"),
  ]);
  const nameOf = (id) => (profs || []).find(p => p.id === id)?.full_name || "Student";
  $app.innerHTML = `
    ${greetHTML("हर बच्चे की सफलता, हमारी पहचान 🌟")}
    ${qaHTML([
      { go: "manage", ic: "🏫", label: "Classes", bg: "#e8effe" },
      { go: "tests", ic: "📝", label: "Tests", bg: "#fde8e8" },
      { go: "study", ic: "📚", label: "Content", bg: "#e2f4ec" },
      profile.role === "admin"
        ? { go: "users", ic: "👥", label: "Students", bg: "#fdf3d7" }
        : { go: "more", ic: "👤", label: "My Profile", bg: "#fdf3d7" },
    ])}
    <div class="card"><h3>📊 Academy एक नज़र में</h3>
      <div class="stats">
        <div class="stat"><div class="si" style="background:#e8f1fe">👥</div><div class="n">${sc ?? 0}</div><div class="l">Students</div></div>
        <div class="stat"><div class="si" style="background:#fdf3d7">❓</div><div class="n">${qc ?? 0}</div><div class="l">Questions</div></div>
        <div class="stat"><div class="si" style="background:#fde8e8">📝</div><div class="n">${tc ?? 0}</div><div class="l">Tests</div></div>
      </div></div>
    <div class="card"><h3>🕘 ताज़ा गतिविधि</h3>
      ${(recentUsers || []).map(u => `<div class="act"><div class="ai" style="background:#e8effe">👤</div>
        <div><div class="at">नया खाता: ${esc(u.full_name)} (${esc(u.role)})</div>
        <div class="as">${new Date(u.created_at).toLocaleString("hi-IN")}</div></div></div>`).join("")}
      ${(recentAttempts || []).map(a => `<div class="act"><div class="ai" style="background:${a.passed ? "#e2f4ec" : "#fdecea"}">📝</div>
        <div><div class="at">${esc(nameOf(a.student_id))} ने test दिया — ${a.score}/${a.max_score} (${a.percent}%)</div>
        <div class="as">${new Date(a.submitted_at).toLocaleString("hi-IN")}</div></div></div>`).join("")}
      ${(anns || []).map(a => `<div class="act"><div class="ai" style="background:#fdf3d7">📢</div>
        <div><div class="at">${esc(a.title)}</div><div class="as">${esc(a.body || "")}</div></div></div>`).join("")}
      ${!(recentUsers || []).length && !(recentAttempts || []).length ? `<p>अभी कोई गतिविधि नहीं है।</p>` : ""}
    </div>`;
  wireQA();
}

/* ---------------- Manage: academic structure (staff) ---------------- */
async function renderManage() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const [{ data: classes }, { data: subjects }, { data: chapters }] = await Promise.all([
    sb.from("classes").select("*").order("sort_order"),
    sb.from("subjects").select("*").order("sort_order"),
    sb.from("chapters").select("*").order("sort_order"),
  ]);
  const subsOf = (cid) => (subjects || []).filter(s => s.class_id === cid);
  const chapsOf = (sid) => (chapters || []).filter(c => c.subject_id === sid);

  $app.innerHTML = `
    <div class="card">
      <h3>🏫 Classes, Subjects व Chapters</h3>
      <p>यही ढाँचा notes, materials, questions और tests की नींव है।</p>
      ${(classes || []).map(c => `
        <div class="item"><div><div class="t">${esc(c.name)}</div>
          <div class="s">${subsOf(c.id).map(s => `${esc(s.name)} (${chapsOf(s.id).length} ch)`).join(" • ") || "कोई subject नहीं"}</div></div>
        </div>
        ${subsOf(c.id).map(s => `<div class="item" style="padding-left:18px"><div><div class="t" style="font-size:14px">📖 ${esc(s.name)}${s.name_hi ? ` • ${esc(s.name_hi)}` : ""}</div>
          <div class="s">${chapsOf(s.id).map(ch => esc(ch.name)).join(", ") || "कोई chapter नहीं"}</div></div>
          <button class="light small" data-addchap="${s.id}">+ Chapter</button></div>`).join("")}
        <div style="margin:8px 0 2px"><button class="light small" data-addsub="${c.id}">+ Subject जोड़ें (${esc(c.name)})</button></div>
      `).join("") || `<p>अभी कोई class नहीं है — नीचे से पहली class बनाएँ।</p>`}
      <label>नई Class का नाम</label>
      <div class="row"><input id="newClass" placeholder="जैसे: Class 10"><button class="gold" id="addClassBtn">जोड़ें</button></div>
    </div>
    <div id="fees"></div>
    <div id="qbank"></div>
    <div class="card">
      <h3>📢 Notice डालें</h3>
      <label>शीर्षक</label><input id="annTitle" placeholder="जैसे: कल छुट्टी रहेगी">
      <label>विवरण</label><textarea id="annBody" placeholder="विस्तार से लिखें…"></textarea>
      <div class="error" id="annErr"></div>
      <button class="gold" id="annBtn" style="width:100%">सभी को भेजें</button>
    </div>`;

  document.getElementById("addClassBtn").onclick = async () => {
    const name = document.getElementById("newClass").value.trim();
    if (!name) return toast("Class का नाम लिखें");
    const { error } = await sb.from("classes").insert({ name, sort_order: (classes || []).length + 1 });
    if (error) return toast("Error: " + error.message);
    toast("Class जुड़ गई ✅"); renderManage();
  };
  $app.querySelectorAll("[data-addsub]").forEach(b => b.onclick = async () => {
    const name = prompt("Subject का नाम (English):"); if (!name) return;
    const name_hi = prompt("Subject का नाम (हिंदी) — खाली छोड़ सकते हैं:") || null;
    const { error } = await sb.from("subjects").insert({ class_id: +b.dataset.addsub, name, name_hi });
    if (error) return toast("Error: " + error.message);
    toast("Subject जुड़ गया ✅"); renderManage();
  });
  $app.querySelectorAll("[data-addchap]").forEach(b => b.onclick = async () => {
    const name = prompt("Chapter का नाम:"); if (!name) return;
    const { error } = await sb.from("chapters").insert({ subject_id: +b.dataset.addchap, name });
    if (error) return toast("Error: " + error.message);
    toast("Chapter जुड़ गया ✅"); renderManage();
  });
  document.getElementById("annBtn").onclick = async () => {
    const title = document.getElementById("annTitle").value.trim();
    const body = document.getElementById("annBody").value.trim();
    const err = document.getElementById("annErr");
    if (!title) { err.textContent = "शीर्षक लिखें"; return; }
    const { error } = await sb.from("announcements").insert({ author_id: me.id, class_id: null, title, body });
    if (error) { err.textContent = error.message; return; }
    const { data: studs } = await sb.from("profiles").select("id").in("role", ["student", "parent"]);
    await notifyUsers((studs || []).map(p => p.id), "announcement", "📢 " + title, body);
    toast("Notice भेज दिया गया 📢"); tab = "home"; renderShell();
  };
  renderQBank(subjects || [], chapters || []);
  renderFees();
}

/* ---------------- Fees (staff) ---------------- */
async function renderFees() {
  const host = document.getElementById("fees");
  if (!host) return;
  const [{ data: plans }, { data: records }, { data: studs }, { data: enrAll }] = await Promise.all([
    sb.from("fee_plans").select("*"),
    sb.from("fee_records").select("*").order("created_at", { ascending: false }).limit(60),
    sb.from("profiles").select("id,full_name").eq("role", "student"),
    sb.from("enrollments").select("*"),
  ]);
  const planOf = (cid, type) => (plans || []).find(p => p.class_id === cid && p.fee_type === type)?.amount ?? "";
  const nameOf = (id) => (studs || []).find(s => s.id === id)?.full_name || "Student";
  const totalDue = (records || []).reduce((s, r) => s + (+r.amount - +r.paid_amount), 0);
  const totalPaid = (records || []).reduce((s, r) => s + +r.paid_amount, 0);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = new Date();
  const defaultPeriod = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;

  host.innerHTML = `
    <div class="card"><h3>💰 Fees</h3>
      <div class="stats">
        <div class="stat"><div class="si" style="background:#e2f4ec">✅</div><div class="n">₹${totalPaid.toLocaleString("en-IN")}</div><div class="l">कुल जमा</div></div>
        <div class="stat"><div class="si" style="background:#fdecea">⏳</div><div class="n">₹${totalDue.toLocaleString("en-IN")}</div><div class="l">कुल बकाया</div></div>
        <div class="stat"><div class="si" style="background:#e8f1fe">🧾</div><div class="n">${(records || []).length}</div><div class="l">Fee records</div></div>
      </div>
      <label>Class के हिसाब से Fee तय करें</label>
      ${myClasses.map(c => `<div class="row" style="align-items:flex-end; margin-bottom:4px">
        <div style="flex:1.4"><b>${esc(c.name)}</b></div>
        <div><label>महीने की (₹)</label><input type="number" id="fp_m_${c.id}" value="${planOf(c.id, "monthly")}" placeholder="जैसे 800"></div>
        <div><label>साल की (₹)</label><input type="number" id="fp_y_${c.id}" value="${planOf(c.id, "yearly")}" placeholder="जैसे 8000"></div>
        <div style="flex:0 0 auto"><button class="light small" data-fpsave="${c.id}">Save</button></div>
      </div>`).join("")}
      <label style="margin-top:14px">पूरी Class के लिए Fee बनाएँ</label>
      <div class="row">
        <div><label>Class</label><select id="fg_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
        <div><label>प्रकार</label><select id="fg_type"><option value="monthly">महीने की</option><option value="yearly">साल की</option><option value="admission">Admission</option><option value="exam">Exam</option><option value="other">अन्य</option></select></div>
      </div>
      <div class="row">
        <div><label>समय (Period)</label><input id="fg_period" value="${defaultPeriod}"></div>
        <div><label>रकम (₹)</label><input id="fg_amount" type="number" placeholder="ऊपर तय fee से अपने-आप आएगी"></div>
        <div><label>आखिरी तारीख़</label><input id="fg_due" type="date"></div>
      </div>
      <div class="error" id="fg_err"></div>
      <button class="gold" id="fg_gen" style="width:100%">सभी Students के लिए Fee बनाएँ</button>
      <label style="margin-top:14px">ताज़ा Fee Records</label>
      ${(records || []).map(r => `<div class="item"><div>
          <div class="t" style="font-size:14px">${esc(nameOf(r.student_id))}</div>
          <div class="s">${esc(r.fee_type)} • ${esc(r.period)} • ₹${r.amount} में से ₹${r.paid_amount} जमा${+r.amount - +r.paid_amount > 0 ? ` • <b style="color:var(--bad)">बकाया ₹${+r.amount - +r.paid_amount}</b>` : ""}</div></div>
        <span style="display:flex; gap:6px; align-items:center">
          <span class="pill ${r.status === "paid" ? "green" : r.status === "partial" ? "gold" : "red"}">${r.status}</span>
          ${r.status !== "paid" ? `<button class="light small" data-fpay="${r.id}:${+r.amount - +r.paid_amount}">+ Payment</button>` : ""}
        </span></div>`).join("") || `<p class="muted">अभी कोई fee record नहीं है।</p>`}
    </div>`;

  host.querySelectorAll("[data-fpsave]").forEach(b => b.onclick = async () => {
    const cid = +b.dataset.fpsave;
    for (const [type, el] of [["monthly", "fp_m_"], ["yearly", "fp_y_"]]) {
      const v = document.getElementById(el + cid).value;
      if (v === "") continue;
      const { error } = await sb.from("fee_plans").upsert({ class_id: cid, fee_type: type, amount: +v }, { onConflict: "class_id,fee_type" });
      if (error) return toast("Error: " + error.message);
    }
    toast("Fee तय हो गई 💰"); renderFees();
  });
  const syncAmt = () => {
    const cid = +document.getElementById("fg_class").value;
    const type = document.getElementById("fg_type").value;
    const p = (plans || []).find(x => x.class_id === cid && x.fee_type === type);
    if (p) document.getElementById("fg_amount").value = p.amount;
  };
  document.getElementById("fg_class").onchange = syncAmt;
  document.getElementById("fg_type").onchange = syncAmt;
  syncAmt();
  document.getElementById("fg_gen").onclick = async () => {
    const err = document.getElementById("fg_err"); err.textContent = "";
    const cid = +document.getElementById("fg_class").value;
    const type = document.getElementById("fg_type").value;
    const period = document.getElementById("fg_period").value.trim();
    const amount = +document.getElementById("fg_amount").value;
    const due = document.getElementById("fg_due").value || null;
    if (!period || !amount) { err.textContent = "Period और रकम भरें"; return; }
    const studsInClass = (enrAll || []).filter(e => e.class_id === cid).map(e => e.user_id);
    if (!studsInClass.length) { err.textContent = "इस class में कोई student नहीं है"; return; }
    const rows = studsInClass.map(sid => ({ student_id: sid, class_id: cid, fee_type: type, period, amount, due_date: due, recorded_by: me.id }));
    const { error } = await sb.from("fee_records").upsert(rows, { onConflict: "student_id,fee_type,period", ignoreDuplicates: true });
    if (error) { err.textContent = error.message; return; }
    notifyUsers(studsInClass, "fee", "🧾 नई Fee बनी",
      `${type} fee (${period}): ₹${amount}${due ? ` • जमा करने की अंतिम तारीख़: ${due}` : ""} — समय पर जमा कर दें।`);
    toast(`Fee बन गई — ${studsInClass.length} students के लिए 🧾`); renderFees();
  };
  host.querySelectorAll("[data-fpay]").forEach(b => b.onclick = async () => {
    const [id, dueAmt] = b.dataset.fpay.split(":");
    const v = prompt(`कितने ₹ जमा हुए? (बकाया ₹${dueAmt})`);
    if (!v) return;
    const rec = (records || []).find(r => r.id === +id);
    const paid = +rec.paid_amount + +v;
    const status = paid >= +rec.amount ? "paid" : "partial";
    const { error } = await sb.from("fee_records").update({ paid_amount: paid, status, updated_at: new Date().toISOString() }).eq("id", +id);
    if (error) return toast("Error: " + error.message);
    const dueLeft = +rec.amount - paid;
    notifyUsers([rec.student_id], "fee", "💰 Fee जमा हो गई",
      `आपकी ${rec.fee_type} fee (${rec.period}) के ₹${v} जमा हो गए। कुल जमा: ₹${paid} / ₹${rec.amount}${dueLeft > 0 ? ` • बकाया: ₹${dueLeft}` : " • पूरी fee जमा हो गई ✅"}`);
    toast("Payment दर्ज हो गया ✅"); renderFees();
  });
}

/* ---------------- Question Bank (staff only) ---------------- */
async function renderQBank(subjects, chapters) {
  const host = document.getElementById("qbank");
  if (!host) return;
  const { data: qs } = await sb.from("questions").select("*").order("created_at", { ascending: false }).limit(30);
  const subName = (id) => (subjects.find(s => s.id === id) || {}).name || "";
  host.innerHTML = `
    <div class="card"><h3>❓ Question Bank (${qs ? qs.length : 0} ताज़ा)</h3>
      <p>यहीं के सवाल tests में लगेंगे। सही उत्तर सिर्फ़ staff देख सकता है — students को कभी नहीं दिखता।</p>
      <label>प्रकार</label>
      <select id="q_type">
        <option value="mcq_single">MCQ (एक सही उत्तर)</option>
        <option value="true_false">सही / ग़लत</option>
        <option value="fill_blank">रिक्त स्थान भरें</option>
        <option value="short">छोटा उत्तर (teacher जाँचेंगे)</option>
        <option value="descriptive">बड़ा उत्तर (teacher जाँचेंगे)</option>
      </select>
      <label>Class</label><select id="q_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <label>Subject</label><select id="q_subject"><option value="">—</option>${subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select>
      <label>Chapter</label><select id="q_chapter"><option value="">—</option>${chapters.map(ch => `<option value="${ch.id}">${esc(ch.name)}</option>`).join("")}</select>
      <label>सवाल</label><textarea id="q_text" placeholder="सवाल यहाँ लिखें…"></textarea>
      <div id="q_opts">
        <label>विकल्प (MCQ के लिए)</label>
        <div class="row"><input id="q_oA" placeholder="A"><input id="q_oB" placeholder="B"></div>
        <div class="row"><input id="q_oC" placeholder="C"><input id="q_oD" placeholder="D"></div>
      </div>
      <label>सही उत्तर</label>
      <select id="q_correct_sel">
        <option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option>
        <option value="true">सही (True)</option><option value="false">ग़लत (False)</option>
      </select>
      <input id="q_correct_text" class="hidden" placeholder="सही उत्तर लिखें (रिक्त स्थान के लिए)">
      <label>समझाएँ (Explanation — result के बाद दिखेगा)</label><textarea id="q_expl" placeholder="उत्तर क्यों सही है…"></textarea>
      <div class="row">
        <div><label>अंक</label><input id="q_marks" type="number" value="1" min="0" step="0.5"></div>
        <div><label>कठिनाई</label><select id="q_diff"><option>easy</option><option selected>medium</option><option>hard</option></select></div>
      </div>
      <div class="error" id="q_err"></div>
      <button class="gold" id="q_add" style="width:100%">सवाल जोड़ें</button>
      <div style="margin-top:10px">
      ${(qs || []).map(q => `<div class="item"><div><div class="t" style="font-size:14px">${esc(q.question_text.slice(0, 90))}${q.question_text.length > 90 ? "…" : ""}</div>
        <div class="s">${esc(q.qtype)} • ${esc(subName(q.subject_id))} • ${q.marks} अंक • सही: ${esc(JSON.stringify(q.correct_answer))}</div></div>
        <button class="danger small" data-qdel="${q.id}">✕</button></div>`).join("")}
      </div>
    </div>`;
  const typeSel = document.getElementById("q_type");
  const syncQ = () => {
    const t = typeSel.value;
    document.getElementById("q_opts").classList.toggle("hidden", t !== "mcq_single");
    document.getElementById("q_correct_sel").classList.toggle("hidden", t === "fill_blank" || t === "short" || t === "descriptive");
    document.getElementById("q_correct_text").classList.toggle("hidden", t !== "fill_blank");
  };
  typeSel.onchange = syncQ; syncQ();
  host.querySelectorAll("[data-qdel]").forEach(b => b.onclick = async () => {
    if (!confirm("यह सवाल हटाएँ?")) return;
    const { error } = await sb.from("questions").delete().eq("id", +b.dataset.qdel);
    if (error) return toast("Error: " + error.message);
    toast("सवाल हटा दिया"); renderManage();
  });
  document.getElementById("q_add").onclick = async () => {
    const err = document.getElementById("q_err"); err.textContent = "";
    const t = typeSel.value;
    const text = document.getElementById("q_text").value.trim();
    if (!text) { err.textContent = "सवाल लिखें"; return; }
    let options = null, correct = null;
    if (t === "mcq_single") {
      options = ["A", "B", "C", "D"].map(k => ({ key: k, text: document.getElementById("q_o" + k).value.trim() }));
      if (options.some(o => !o.text)) { err.textContent = "चारों विकल्प लिखें"; return; }
      correct = [document.getElementById("q_correct_sel").value];
    } else if (t === "true_false") {
      options = [{ key: "true", text: "सही" }, { key: "false", text: "ग़लत" }];
      correct = [document.getElementById("q_correct_sel").value === "false" ? "false" : "true"];
    } else if (t === "fill_blank") {
      const v = document.getElementById("q_correct_text").value.trim();
      if (!v) { err.textContent = "सही उत्तर लिखें"; return; }
      correct = [v];
    }
    const { error } = await sb.from("questions").insert({
      teacher_id: me.id,
      class_id: +document.getElementById("q_class").value,
      subject_id: document.getElementById("q_subject").value ? +document.getElementById("q_subject").value : null,
      chapter_id: document.getElementById("q_chapter").value ? +document.getElementById("q_chapter").value : null,
      qtype: t, question_text: text, options, correct_answer: correct,
      explanation: document.getElementById("q_expl").value.trim() || null,
      marks: +document.getElementById("q_marks").value || 1,
      difficulty: document.getElementById("q_diff").value,
      status: "published",
    });
    if (error) { err.textContent = error.message; return; }
    toast("सवाल जुड़ गया ❓"); renderManage();
  };
}

/* ---------------- Users & enrollment (admin) ---------------- */
async function renderUsers() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const [{ data: users }, { data: enr }] = await Promise.all([
    sb.from("profiles").select("*").order("created_at", { ascending: false }),
    sb.from("enrollments").select("*"),
  ]);
  const enrOf = (uid) => (enr || []).filter(e => e.user_id === uid).map(e => e.class_id);
  const className = (id) => (myClasses.find(c => c.id === id) || {}).name || "?";
  const urlMap = {};
  const photoPaths = (users || []).filter(u => u.photo_path).map(u => u.photo_path);
  if (photoPaths.length) {
    const { data: signed } = await sb.storage.from("avatars").createSignedUrls(photoPaths, 3600);
    (signed || []).forEach(s => { if (s.path && s.signedUrl) urlMap[s.path] = s.signedUrl; });
  }

  $app.innerHTML = `
    <div class="card"><h3>➕ नया Student ख़ुद जोड़ें</h3>
      <p>Student को sign up करने की ज़रूरत नहीं — आप ही खाता बनाकर login की जानकारी उसे दे दीजिए।</p>
      <label>Student का नाम</label><input id="ns_name" placeholder="जैसे: Rahul Kumar">
      <label>Email (student या parent का)</label><input id="ns_email" type="email" placeholder="student@example.com">
      <label>Password (आप तय करें — student को यही बताना होगा)</label><input id="ns_pass" type="text" placeholder="कम से कम 6 अक्षर, जैसे: rahul123">
      <label>पिता का नाम</label><input id="ns_father" placeholder="Father's name">
      <label>माता का नाम (ऐच्छिक)</label><input id="ns_mother" placeholder="Mother's name">
      <div class="row">
        <div><label>जन्मतिथि (Date of Birth)</label><input id="ns_dob" type="date"></div>
        <div><label>Admission की तारीख़</label><input id="ns_adm" type="date"></div>
      </div>
      <label>मोबाइल नंबर</label><input id="ns_phone" type="tel" placeholder="10 अंकों का नंबर">
      <label>पता</label><input id="ns_addr" placeholder="गाँव / मोहल्ला, जिला">
      <label>Class में जोड़ें</label><select id="ns_class"><option value="">— बाद में जोड़ूँगा —</option>${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <div class="error" id="ns_err"></div>
      <div id="ns_done"></div>
      <button class="gold" id="ns_add" style="width:100%">Student बनाएँ</button>
    </div>
    <div class="card"><h3>👥 सभी Users (${(users || []).length})</h3>
    <p>Role बदलना और student को class में जोड़ना यहीं से होगा।</p>
    ${(users || []).map(u => `
      <div class="item" style="align-items:flex-start">
        ${u.photo_path && urlMap[u.photo_path]
          ? `<img src="${urlMap[u.photo_path]}" alt="" class="zoomable" title="बड़ा देखने के लिए दबाएँ" data-zoom="${urlMap[u.photo_path]}" style="width:44px; height:44px; border-radius:50%; object-fit:cover; flex:0 0 auto">`
          : `<div class="avatar" style="width:44px; height:44px; font-size:17px">${esc((u.full_name || "?").trim()[0].toUpperCase())}</div>`}
        <div style="flex:1">
          <div class="t">${esc(u.full_name)} ${u.id === me.id ? '<span class="pill gold">आप</span>' : ""}</div>
          <div class="s">${esc(roleName(u.role))}${u.role === "student" ? " • " + (enrOf(u.id).map(className).join(", ") || "कोई class नहीं") : ""}
          ${u.father_name ? `<br>पिता: ${esc(u.father_name)}` : ""}${u.dob ? ` • जन्म: ${esc(u.dob)}` : ""}${u.admission_date ? `<br>Admission: ${esc(u.admission_date)}` : ""}${u.phone ? ` • 📞 ${esc(u.phone)}` : ""}</div>
          <div id="edit-${u.id}" class="hidden" style="margin-top:8px">
            <label>नाम</label><input id="e_name-${u.id}" value="${esc(u.full_name)}">
            <label>पिता का नाम</label><input id="e_father-${u.id}" value="${esc(u.father_name || "")}">
            <label>माता का नाम</label><input id="e_mother-${u.id}" value="${esc(u.mother_name || "")}">
            <div class="row">
              <div><label>जन्मतिथि</label><input id="e_dob-${u.id}" type="date" value="${esc(u.dob || "")}"></div>
              <div><label>Admission तारीख़</label><input id="e_adm-${u.id}" type="date" value="${esc(u.admission_date || "")}"></div>
            </div>
            <label>मोबाइल</label><input id="e_phone-${u.id}" value="${esc(u.phone || "")}">
            <label>पता</label><input id="e_addr-${u.id}" value="${esc(u.address || "")}">
            <label>Profile Photo</label><input id="e_photo-${u.id}" type="file" accept="image/*">
            <button class="gold small" data-save="${u.id}" style="margin-top:8px">💾 Save करें</button>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end">
          <select data-role="${u.id}" style="width:auto; padding:7px">
            ${["student","teacher","parent","admin"].map(r => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}
          </select>
          ${u.role === "student" ? `<select data-enroll="${u.id}" style="width:auto; padding:7px">
            <option value="">+ Class…</option>
            ${myClasses.filter(c => !enrOf(u.id).includes(c.id)).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
          </select>` : ""}
          <button class="light small" data-edit="${u.id}">✏️ Edit</button>
          ${u.id !== me.id ? `<button class="danger small" data-deluser="${u.id}" data-delname="${esc(u.full_name)}">🗑 Delete</button>` : ""}
        </div>
      </div>`).join("")}
  </div>`;

  $app.querySelectorAll("[data-role]").forEach(sel => sel.onchange = async () => {
    const { error } = await sb.from("profiles").update({ role: sel.value }).eq("id", sel.dataset.role);
    if (error) return toast("Error: " + error.message);
    toast("Role बदल गया ✅"); renderUsers();
  });
  $app.querySelectorAll("[data-enroll]").forEach(sel => sel.onchange = async () => {
    if (!sel.value) return;
    const { error } = await sb.from("enrollments").insert({ user_id: sel.dataset.enroll, class_id: +sel.value });
    if (error) return toast("Error: " + error.message);
    const { data: cls } = await sb.from("classes").select("name").eq("id", +sel.value).single();
    notifyUsers([sel.dataset.enroll], "admission", "✅ Admission हो गया",
      `आपको ${cls?.name || "class"} में दाख़िला मिल गया है। अब Notes, Tests और Homework आपको इसी app में मिलेंगे। 🎓`);
    toast("Student class में जुड़ गया 🎓"); renderUsers();
  });
  $app.querySelectorAll("[data-deluser]").forEach(b => b.onclick = async () => {
    const name = b.dataset.delname;
    if (!confirm(`"${name}" को हटाएँ? उसकी fees, results, attendance, submissions — सारा data हट जाएगा और वह फिर login नहीं कर पाएगा।`)) return;
    if (!confirm("पक्का? यह वापस नहीं होगा।")) return;
    const { data: gone, error } = await sb.from("profiles").delete().eq("id", b.dataset.deluser).select("id");
    if (error) return toast("Error: " + error.message);
    if (!gone || !gone.length) return toast("❌ नहीं हटा — database ने रोक दिया, मुझे बताइए");
    toast("User हटा दिया गया 🗑"); renderUsers();
  });
  $app.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    document.getElementById("edit-" + b.dataset.edit).classList.toggle("hidden");
  });
  $app.querySelectorAll('input[id^="e_photo-"]').forEach(i => enhanceFilePicker(i, { imageOnly: true }));
  $app.querySelectorAll("[data-save]").forEach(b => b.onclick = async () => {
    const uid = b.dataset.save;
    try {
      let photo_path;
      const file0 = document.getElementById("e_photo-" + uid).files[0];
      if (file0) {
        const file = await prepareUploadFile(file0);
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        photo_path = `${uid}/${Date.now()}.${ext}`;
        const { error: ue } = await sb.storage.from("avatars").upload(photo_path, file, { upsert: true });
        if (ue) throw ue;
      }
      const upd = {
        full_name: document.getElementById("e_name-" + uid).value.trim(),
        father_name: document.getElementById("e_father-" + uid).value.trim() || null,
        mother_name: document.getElementById("e_mother-" + uid).value.trim() || null,
        dob: document.getElementById("e_dob-" + uid).value || null,
        admission_date: document.getElementById("e_adm-" + uid).value || null,
        phone: document.getElementById("e_phone-" + uid).value.trim() || null,
        address: document.getElementById("e_addr-" + uid).value.trim() || null,
      };
      if (photo_path) upd.photo_path = photo_path;
      const { error } = await sb.from("profiles").update(upd).eq("id", uid);
      if (error) throw error;
      toast("Details save हो गए ✅"); renderUsers();
    } catch (e) { toast("Error: " + e.message); }
  });
  document.getElementById("ns_add").onclick = async () => {
    const err = document.getElementById("ns_err");
    const done = document.getElementById("ns_done");
    err.textContent = ""; done.innerHTML = "";
    const name = document.getElementById("ns_name").value.trim();
    const email = document.getElementById("ns_email").value.trim();
    const pass = document.getElementById("ns_pass").value;
    const classId = document.getElementById("ns_class").value;
    if (!name || !email || !pass) { err.textContent = "नाम, email और password — तीनों भरें"; return; }
    if (pass.length < 6) { err.textContent = "Password कम से कम 6 अक्षरों का रखें"; return; }
    const btn = document.getElementById("ns_add");
    btn.disabled = true; btn.textContent = "बन रहा है…";
    try {
      // Separate throwaway client so the admin's own login session is untouched.
      const sbNew = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, storageKey: "sb-student-create" } });
      const { data, error } = await sbNew.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
      await sbNew.auth.signOut();
      if (error) throw error;
      const newId = data?.user?.id;
      if (!newId) throw new Error("खाता नहीं बना — शायद यह email पहले से मौजूद है");
      if (classId) {
        const { error: e2 } = await sb.from("enrollments").insert({ user_id: newId, class_id: +classId });
        if (e2) throw e2;
      }
      const details = {
        father_name: document.getElementById("ns_father").value.trim() || null,
        mother_name: document.getElementById("ns_mother").value.trim() || null,
        dob: document.getElementById("ns_dob").value || null,
        admission_date: document.getElementById("ns_adm").value || new Date().toISOString().slice(0, 10),
        phone: document.getElementById("ns_phone").value.trim() || null,
        address: document.getElementById("ns_addr").value.trim() || null,
      };
      const { error: e3 } = await sb.from("profiles").update(details).eq("id", newId);
      if (e3) throw e3;
      const { data: clsN } = classId ? await sb.from("classes").select("name").eq("id", +classId).single() : { data: null };
      notifyUsers([newId], "welcome", "🎉 Target Academy में स्वागत है!",
        `आपका खाता बन गया है${clsN?.name ? ` और आपको ${clsN.name} में दाख़िला मिल गया है` : ""}। यहाँ Notes, Tests, Homework और Fees — सब एक ही जगह मिलेगा। पढ़ाई के लिए शुभकामनाएँ! 📚`);
      done.innerHTML = `<div class="card" style="background:#e2f4ec; border-color:#bfe6d2; margin:10px 0">
        <b>✅ Student बन गया!</b><br>ये जानकारी student को दे दीजिए —<br>
        📧 Email: <b>${esc(email)}</b><br>🔑 Password: <b>${esc(pass)}</b><br>
        🔗 Link: ashutoshkumarjpg67-ai.github.io/target-academy-platform</div>`;
      toast("Student बन गया 🎓");
      setTimeout(renderUsers, 4000);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = "Student बनाएँ";
    }
  };
}

/* ---------------- Study: Notes + Materials ---------------- */
let studyClassId = null;
let matFilter = "all";
const KIND_ICON = { pdf: "📕", worksheet: "📝", practice: "✍️", summary: "📋", revision: "🔁", question_bank: "❓", sample_paper: "📄", pyq: "🗂️", image: "🖼️", video_link: "🎬", doc: "📘" };

async function openStoredFile(bucket, path) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) return toast("File खुल नहीं रही: " + error.message);
  window.open(data.signedUrl, "_blank");
}
async function uploadTo(bucket, classId, file) {
  file = await prepareUploadFile(file);
  const safe = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${classId}/${Date.now()}_${safe}`;
  const { error } = await sb.storage.from(bucket).upload(path, file);
  if (error) throw error;
  return path;
}

async function renderStudy() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const [{ data: subjects }, { data: chapters }, { data: notes }, { data: materials }, { data: bms }, { data: prog }] = await Promise.all([
    sb.from("subjects").select("*").order("sort_order"),
    sb.from("chapters").select("*").order("sort_order"),
    sb.from("notes").select("*").order("created_at", { ascending: false }),
    sb.from("materials").select("*").order("created_at", { ascending: false }),
    sb.from("bookmarks").select("*").eq("user_id", me.id),
    sb.from("content_progress").select("*").eq("user_id", me.id),
  ]);
  const subName = (id) => (subjects || []).find(s => s.id === id)?.name || "";
  const chapName = (id) => (chapters || []).find(c => c.id === id)?.name || "";
  const clsName = (id) => (myClasses.find(c => c.id === id) || {}).name || "";
  const isBm = (type, id) => (bms || []).some(b => b.item_type === type && b.item_id === id);
  const isDone = (type, id) => (prog || []).some(p => p.item_type === type && p.item_id === id && p.completed);
  if (studyClassId && !myClasses.some(c => c.id === studyClassId)) studyClassId = null;
  const inClass = (x) => !studyClassId || x.class_id === studyClassId;
  const myNotes = (notes || []).filter(inClass);
  const myMats = (materials || []).filter(inClass);
  const dispMats = matFilter === "pdfs" ? myMats.filter(m => m.file_path)
    : matFilter === "videos" ? myMats.filter(m => m.external_url || m.kind === "video_link")
    : myMats;
  const mySubjs = (subjects || []).filter(s => !studyClassId || s.class_id === studyClassId);

  const itemCard = (x, type) => `
    <div class="item">
      <div>
        <div class="t">${type === "material" ? (KIND_ICON[x.kind] || "📄") + " " : "📗 "}${esc(x.title)}</div>
        <div class="s">${esc(clsName(x.class_id))} • ${esc(subName(x.subject_id))}${x.chapter_id ? " • " + esc(chapName(x.chapter_id)) : ""}${x.difficulty ? " • " + esc(x.difficulty) : ""}${x.description ? "<br>" + esc(x.description) : ""}</div>
        ${type === "note" && x.body ? `<div class="note-body" id="body-${x.id}"></div>` : ""}
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end">
        ${isStaff() ? `<span class="pill ${x.status === "published" ? "green" : ""}">${esc(x.status)}</span>` : ""}
        <div class="row" style="flex-wrap:nowrap">
          <button class="light small" data-bm="${type}:${x.id}">${isBm(type, x.id) ? "★" : "☆"}</button>
          ${type === "note" && x.body ? `<button class="small" data-body="${x.id}">पढ़ें</button>` : ""}
          ${x.file_path ? `<button class="small" data-open="${type}:${x.id}">खोलें</button>` : ""}
          ${x.external_url ? `<button class="small" data-ext="${x.id}">खोलें</button>` : ""}
        </div>
        ${!isStaff() ? `<button class="light small" data-done="${type}:${x.id}">${isDone(type, x.id) ? "✓ पढ़ लिया" : "पढ़ा हुआ निशान लगाएँ"}</button>` : ""}
      </div>
    </div>`;

  $app.innerHTML = `
    <div class="card"><h3>🎓 Class चुनें</h3>
      <div class="row">
        <button class="${!studyClassId ? "" : "light"}" data-cls="">सभी Classes</button>
        ${myClasses.map(c => `<button class="${c.id === studyClassId ? "" : "light"}" data-cls="${c.id}">${esc(c.name)}</button>`).join("")}
      </div>
      <p class="muted" style="margin-bottom:0">Notes और Material class के हिसाब से अलग-अलग दिखते हैं।</p>
    </div>
    <div class="card"><h3>📚 Subjects</h3>
      <div class="subj-grid">${mySubjs.map(s => {
        const st = subjStyle(s.name);
        return `<div class="subj"><div class="sic" style="background:${st.c}">${st.i}</div>
          <div style="flex:1"><div class="st">${esc(s.name)}${s.name_hi ? ` • ${esc(s.name_hi)}` : ""}</div>
          <div class="ss">${esc(clsName(s.class_id))} • ${(chapters || []).filter(c => c.subject_id === s.id).length} Chapters • ${myNotes.filter(n => n.subject_id === s.id).length + myMats.filter(m => m.subject_id === s.id).length} items</div></div></div>`;
      }).join("") || `<p class="muted">इस class में अभी subjects नहीं हैं।</p>`}</div>
    </div>
    ${isStaff() ? `
    <div class="card"><h3>➕ Note / Material जोड़ें</h3>
      <label>प्रकार</label>
      <select id="n_kind"><option value="note">📗 Note (लिखा हुआ / PDF)</option><option value="material">📕 Study Material (file / link)</option></select>
      <label>शीर्षक</label><input id="n_title" placeholder="जैसे: प्रकाश संश्लेषण — सारांश">
      <label>Class</label><select id="n_class">${myClasses.map(c => `<option value="${c.id}" ${c.id === studyClassId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <label>Subject</label><select id="n_subject"><option value="">— कोई नहीं —</option>${(subjects || []).map(s => `<option value="${s.id}">${esc(s.name)} (${esc(clsName(s.class_id))})</option>`).join("")}</select>
      <label>Chapter</label><select id="n_chapter"><option value="">— कोई नहीं —</option>${(chapters || []).map(ch => `<option value="${ch.id}">${esc(ch.name)}</option>`).join("")}</select>
      <div id="matKindWrap" class="hidden"><label>Material का प्रकार</label>
        <select id="n_matkind">${Object.keys(KIND_ICON).map(k => `<option value="${k}">${k}</option>`).join("")}</select></div>
      <label>Note का text (सिर्फ़ Note के लिए, खाली छोड़ सकते हैं)</label><textarea id="n_body" placeholder="Note यहाँ लिखें…"></textarea>
      <label>File (PDF / image / doc) — या नीचे link</label><input id="n_file" type="file">
      <label>बाहरी link (video आदि)</label><input id="n_url" placeholder="https://…">
      <label>स्थिति</label><select id="n_status"><option value="published">Published (students को दिखेगा)</option><option value="draft">Draft (सिर्फ़ staff)</option></select>
      <div class="error" id="n_err"></div>
      <button class="gold" id="n_add" style="width:100%">जोड़ें</button>
    </div>` : ""}
    <div class="mtabs">
      ${[["all", "सभी"], ["notes", "📗 Notes"], ["pdfs", "📕 PDFs / Files"], ["videos", "🎬 Videos"]].map(([k, l]) =>
        `<button class="chip ${matFilter === k ? "on" : ""}" data-mf="${k}">${l}</button>`).join("")}
    </div>
    ${matFilter === "all" || matFilter === "notes" ? `
    <div class="card"><h3>📗 Notes (${myNotes.length})</h3>
      ${myNotes.map(n => itemCard(n, "note")).join("") || "<p>इस class के notes जल्द आ रहे हैं।</p>"}</div>` : ""}
    ${matFilter !== "notes" ? `
    <div class="card"><h3>📚 Study Material (${dispMats.length})</h3>
      ${dispMats.map(m => itemCard(m, "material")).join("") || "<p>इस class का material जल्द आ रहा है।</p>"}</div>` : ""}`;

  const noteById = (id) => (notes || []).find(n => n.id === id);
  const matById = (id) => (materials || []).find(m => m.id === id);
  $app.querySelectorAll("[data-cls]").forEach(b => b.onclick = () => { studyClassId = b.dataset.cls ? +b.dataset.cls : null; renderStudy(); });
  $app.querySelectorAll("[data-mf]").forEach(b => b.onclick = () => { matFilter = b.dataset.mf; renderStudy(); });
  $app.querySelectorAll("[data-open]").forEach(b => b.onclick = () => {
    const [type, id] = b.dataset.open.split(":");
    if (type === "note") openStoredFile("notes-files", noteById(+id).file_path);
    else openStoredFile("materials", matById(+id).file_path);
  });
  $app.querySelectorAll("[data-ext]").forEach(b => b.onclick = () => window.open(matById(+b.dataset.ext).external_url, "_blank"));
  $app.querySelectorAll("[data-body]").forEach(b => b.onclick = () => {
    const el = document.getElementById("body-" + b.dataset.body);
    el.textContent = el.textContent ? "" : (noteById(+b.dataset.body).body || "");
  });
  $app.querySelectorAll("[data-bm]").forEach(b => b.onclick = async () => {
    const [type, id] = b.dataset.bm.split(":");
    if (isBm(type, +id)) await sb.from("bookmarks").delete().eq("user_id", me.id).eq("item_type", type).eq("item_id", +id);
    else await sb.from("bookmarks").insert({ user_id: me.id, item_type: type, item_id: +id });
    renderStudy();
  });
  $app.querySelectorAll("[data-done]").forEach(b => b.onclick = async () => {
    const [type, id] = b.dataset.done.split(":");
    await sb.from("content_progress").upsert(
      { user_id: me.id, item_type: type, item_id: +id, completed: !isDone(type, +id), last_opened_at: new Date().toISOString() },
      { onConflict: "user_id,item_type,item_id" });
    renderStudy();
  });

  if (isStaff()) {
    const kindSel = document.getElementById("n_kind");
    enhanceFilePicker(document.getElementById("n_file"));
    kindSel.onchange = () => document.getElementById("matKindWrap").classList.toggle("hidden", kindSel.value !== "material");
    document.getElementById("n_add").onclick = async () => {
      const err = document.getElementById("n_err"); err.textContent = "";
      const kind = kindSel.value;
      const title = document.getElementById("n_title").value.trim();
      const class_id = +document.getElementById("n_class").value;
      const subject_id = document.getElementById("n_subject").value ? +document.getElementById("n_subject").value : null;
      const chapter_id = document.getElementById("n_chapter").value ? +document.getElementById("n_chapter").value : null;
      const status = document.getElementById("n_status").value;
      const file = document.getElementById("n_file").files[0];
      if (!title) { err.textContent = "शीर्षक लिखें"; return; }
      try {
        if (kind === "note") {
          let file_path = null;
          if (file) file_path = await uploadTo("notes-files", class_id, file);
          const { error } = await sb.from("notes").insert({
            teacher_id: me.id, class_id, subject_id, chapter_id, title,
            body: document.getElementById("n_body").value.trim() || null, file_path, status });
          if (error) throw error;
        } else {
          let file_path = null;
          if (file) file_path = await uploadTo("materials", class_id, file);
          const { error } = await sb.from("materials").insert({
            teacher_id: me.id, class_id, subject_id, chapter_id, title,
            kind: document.getElementById("n_matkind").value, file_path,
            external_url: document.getElementById("n_url").value.trim() || null, status });
          if (error) throw error;
        }
        toast("जुड़ गया ✅"); renderStudy();
      } catch (e) { err.textContent = e.message; }
    };
  }
}

/* ---------------- Fees (student / parent section) ---------------- */
async function renderFeesStudent() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const { data: records } = await sb.from("fee_records").select("*").order("created_at", { ascending: false });
  const recs = records || [];
  let nameOf = () => "";
  if (profile.role === "parent" && recs.length) {
    const ids = [...new Set(recs.map(r => r.student_id))];
    const { data: kids } = await sb.from("profiles").select("id,full_name").in("id", ids);
    nameOf = (id) => (kids || []).find(k => k.id === id)?.full_name || "Student";
  }
  const clsName = (id) => (myClasses.find(c => c.id === id) || {}).name || "Class";
  const totalDue = recs.reduce((s, r) => s + (+r.amount - +r.paid_amount), 0);
  const totalPaid = recs.reduce((s, r) => s + +r.paid_amount, 0);
  const byClass = {};
  recs.forEach(r => { (byClass[r.class_id || 0] = byClass[r.class_id || 0] || []).push(r); });

  $app.innerHTML = `
    <div class="card"><h3>💰 ${profile.role === "parent" ? "बच्चों की Fees" : "मेरी Fees"}</h3>
      <div class="stats">
        <div class="stat"><div class="si" style="background:#e2f4ec">✅</div><div class="n">₹${totalPaid.toLocaleString("en-IN")}</div><div class="l">कुल जमा</div></div>
        <div class="stat"><div class="si" style="background:#fdecea">⏳</div><div class="n">₹${totalDue.toLocaleString("en-IN")}</div><div class="l">कुल बकाया</div></div>
        <div class="stat"><div class="si" style="background:#e8f1fe">🧾</div><div class="n">${recs.length}</div><div class="l">Records</div></div>
      </div>
      ${totalDue > 0 ? `<p style="color:var(--bad); font-weight:700">⚠️ ₹${totalDue.toLocaleString("en-IN")} बकाया है — कृपया academy में जमा करें।</p>` : `<p style="font-weight:700; color:var(--ok)">कोई बकाया नहीं 🎉</p>`}
    </div>
    ${Object.keys(byClass).length ? Object.entries(byClass).map(([cid, list]) => `
      <div class="card"><h3>🎓 ${esc(clsName(+cid))}</h3>
        ${list.map(r => `<div class="item"><div>
          <div class="t" style="font-size:14px">${esc(r.fee_type)} — ${esc(r.period)}${profile.role === "parent" ? ` • ${esc(nameOf(r.student_id))}` : ""}</div>
          <div class="s">₹${r.amount} में से ₹${r.paid_amount} जमा${r.due_date ? ` • आखिरी तारीख़: ${esc(r.due_date)}` : ""}${+r.amount - +r.paid_amount > 0 ? ` • <b style="color:var(--bad)">बकाया ₹${+r.amount - +r.paid_amount}</b>` : ""}</div></div>
          <span class="pill ${r.status === "paid" ? "green" : r.status === "partial" ? "gold" : "red"}">${r.status}</span></div>`).join("")}
      </div>`).join("") : `<div class="card"><p class="muted">अभी कोई fee record नहीं है। Fee बनते ही यहाँ दिखेगी।</p></div>`}`;
}

/* ---------------- Test Center ---------------- */
let run = null; // live attempt runtime

async function renderTests() {
  if (run) { renderRun(); return; }
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const [{ data: tests }, { data: myAttempts }, { data: allQ }, { data: subjects }] = await Promise.all([
    sb.from("tests").select("*").order("created_at", { ascending: false }),
    sb.from("test_attempts").select("*").eq("student_id", me.id).order("started_at", { ascending: false }),
    isStaff() ? sb.from("questions").select("*").order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    sb.from("subjects").select("*").order("sort_order"),
  ]);
  const attemptsOf = (tid) => (myAttempts || []).filter(a => a.test_id === tid);
  if (tests) tests.sort((a, b) => (a.class_id || 0) - (b.class_id || 0));
  const testRow = (t) => {
    const mine = attemptsOf(t.id);
    const submitted = mine.filter(a => a.status !== "in_progress");
    const live = mine.find(a => a.status === "in_progress");
    return `<div class="item"><div>
        <div class="t">${esc(t.title)}</div>
        <div class="s">${esc((myClasses.find(c => c.id === t.class_id) || {}).name || "")} • ⏱ ${t.duration_minutes} मिनट • ${t.total_marks} अंक${t.instant_feedback ? " • ⚡ Practice Mode" : ""}${+t.negative_marking ? ` • ग़लत पर −${t.negative_marking}` : ""}${submitted.length ? `<br>मेरा score: <b>${submitted[0].score}/${submitted[0].max_score}</b> (${submitted[0].percent}%) ${submitted[0].passed ? "✅ Pass" : "❌ Fail"}` : ""}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end">
        <span class="pill ${t.status === "published" ? "green" : ""}">${esc(t.status)}</span>
        ${isStaff() ? `<div class="row" style="flex-wrap:nowrap">
            <button class="light small" data-tpreview="${t.id}">👁 देखें</button>
            <button class="light small" data-tinst="${t.id}:${t.instant_feedback ? 1 : 0}" title="Practice Mode चालू/बंद करें">⚡ ${t.instant_feedback ? "ON" : "OFF"}</button>
            <button class="light small" data-tresults="${t.id}">Results</button>
            <button class="light small" data-tpub="${t.id}:${t.status}">${t.status === "published" ? "Draft करें" : "Publish"}</button>
            <button class="danger small" data-tdel="${t.id}">✕</button></div>`
          : t.status === "published" ? (live
            ? `<button class="gold small" data-tstart="${t.id}">▶ जारी रखें</button>`
            : submitted.length
              ? `<button class="small" data-tresult="${submitted[0].id}:${t.id}">Result देखें</button>`
              : `<button class="gold small" data-tstart="${t.id}">▶ Test शुरू करें</button>`) : ""}
      </div></div>`;
  };
  const groupedTests = () => {
    if (!tests || !tests.length) return `<div class="card"><p>अभी कोई test नहीं है।</p></div>`;
    const classIds = [...new Set(tests.map(t => t.class_id))];
    return classIds.map(cid => {
      const inClass = tests.filter(t => t.class_id === cid);
      const subsHere = (subjects || []).filter(s => s.class_id === cid);
      const knownIds = new Set(subsHere.map(s => s.id));
      let html = `<div style="margin:16px 0 4px; font-weight:900; color:var(--navy); font-size:17px">🎓 ${esc((myClasses.find(c => c.id === cid) || {}).name || "Class")}</div>`;
      subsHere.forEach(s => {
        const inSub = inClass.filter(t => t.subject_id === s.id);
        if (!inSub.length) return;
        html += `<details class="card" open><summary style="font-weight:900; color:var(--navy); font-size:16px; cursor:pointer">📚 ${esc(s.name)}${s.name_hi ? ` • ${esc(s.name_hi)}` : ""} <span class="muted" style="font-weight:600">(${inSub.length} test${inSub.length > 1 ? "s" : ""})</span></summary>${inSub.map(testRow).join("")}</details>`;
      });
      const rest = inClass.filter(t => !t.subject_id || !knownIds.has(t.subject_id));
      if (rest.length) html += `<details class="card" open><summary style="font-weight:900; color:var(--navy); font-size:16px; cursor:pointer">📚 अन्य Tests <span class="muted" style="font-weight:600">(${rest.length})</span></summary>${rest.map(testRow).join("")}</details>`;
      return html;
    }).join("");
  };

  $app.innerHTML = `
    ${isStaff() ? `
    <details class="card"><summary>➕ नया Test बनाएँ</summary>
      <label>Test का नाम</label><input id="t_title" placeholder="जैसे: Science — Chapter 5 Test">
      <div class="row">
        <div><label>Class</label><select id="t_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
        <div><label>समय (मिनट)</label><input id="t_dur" type="number" value="30" min="1"></div>
      </div>
      <div class="row">
        <div><label>Negative marking (प्रति ग़लत)</label><input id="t_neg" type="number" value="0" min="0" step="0.25"></div>
        <div><label>Pass %</label><input id="t_pass" type="number" value="33" min="0" max="100"></div>
        <div><label>कोशिशें (attempts)</label><input id="t_max" type="number" value="1" min="1"></div>
      </div>
      <label class="checkrow"><input type="checkbox" id="t_instant" checked><span><b>⚡ Practice Mode</b> — option चुनते ही student को सही/ग़लत + explanation दिखेगा (पहला click ही उत्तर माना जाएगा, बाद में बदल नहीं सकेगा)</span></label>
      <label>सवाल चुनें (Question Bank से)</label>
      <div id="t_picker" style="max-height:260px; overflow:auto"></div>
      <div class="error" id="t_err"></div>
      <button class="gold" id="t_create" style="width:100%">Test बनाएँ (Draft)</button>
      <p class="muted">Test पहले Draft बनेगा — सूची में Publish दबाकर students के लिए खोलें।</p>
    </details>` : ""}
    <div class="card"><h3>📝 ${isStaff() ? "सभी Tests" : "मेरे Tests"}</h3>
    <p class="muted" style="margin:0">Tests subject के हिसाब से बँटे हैं — subject खोलकर उसके tests देखें।</p></div>
    ${groupedTests()}
    <div id="tResults"></div>`;

  if (isStaff()) {
    const picker = document.getElementById("t_picker");
    const classSel = document.getElementById("t_class");
    const drawPicker = () => {
      const cid = +classSel.value;
      const list = (allQ || []).filter(q => q.class_id === cid);
      picker.innerHTML = list.length ? list.map(q => `
        <label class="checkrow"><input type="checkbox" class="tq" value="${q.id}">
        <span><b>${esc(q.question_text.slice(0, 80))}</b><br><span class="muted">${esc(q.qtype)} • ${q.marks} अंक</span></span></label>`).join("")
        : `<p class="muted">इस class के लिए Question Bank में सवाल नहीं हैं — पहले Manage → Question Bank में सवाल जोड़ें।</p>`;
    };
    classSel.onchange = drawPicker; drawPicker();
    document.getElementById("t_create").onclick = async () => {
      const err = document.getElementById("t_err"); err.textContent = "";
      const title = document.getElementById("t_title").value.trim();
      const picked = [...picker.querySelectorAll(".tq:checked")].map(x => +x.value);
      if (!title) { err.textContent = "Test का नाम लिखें"; return; }
      if (!picked.length) { err.textContent = "कम से कम एक सवाल चुनें"; return; }
      const total = picked.reduce((s, id) => s + (+((allQ || []).find(q => q.id === id) || {}).marks || 1), 0);
      const pickedQs = picked.map(id => (allQ || []).find(q => q.id === id)).filter(Boolean);
      const subjIds = [...new Set(pickedQs.map(q => q.subject_id).filter(Boolean))];
      const chapIds = [...new Set(pickedQs.map(q => q.chapter_id).filter(Boolean))];
      const { data: t, error } = await sb.from("tests").insert({
        teacher_id: me.id, class_id: +classSel.value, title,
        subject_id: subjIds.length === 1 ? subjIds[0] : null,
        chapter_id: chapIds.length === 1 ? chapIds[0] : null,
        duration_minutes: +document.getElementById("t_dur").value || 30,
        negative_marking: +document.getElementById("t_neg").value || 0,
        passing_percent: +document.getElementById("t_pass").value || 33,
        max_attempts: +document.getElementById("t_max").value || 1,
        instant_feedback: document.getElementById("t_instant").checked,
        total_marks: total, status: "draft",
      }).select().single();
      if (error) { err.textContent = error.message; return; }
      const { error: e2 } = await sb.from("test_questions").insert(picked.map((qid, i) => ({ test_id: t.id, question_id: qid, sort_order: i + 1 })));
      if (e2) { err.textContent = e2.message; return; }
      toast("Test बन गया 📝 — अब Publish करें"); renderTests();
    };
    $app.querySelectorAll("[data-tpub]").forEach(b => b.onclick = async () => {
      const [id, st] = b.dataset.tpub.split(":");
      const publishing = st !== "published";
      const { error } = await sb.from("tests").update({ status: publishing ? "published" : "draft" }).eq("id", +id);
      if (error) return toast("Error: " + error.message);
      if (publishing) {
        const t = (tests || []).find(x => x.id === +id);
        if (t) await notifyClassStudents(t.class_id, "test", "📝 नया Test: " + t.title, "नया test शुरू हो गया है — Tests section में जाकर दें।");
      }
      renderTests();
    });
    $app.querySelectorAll("[data-tdel]").forEach(b => b.onclick = async () => {
      if (!confirm("यह test और उसके सारे results हट जाएँगे। पक्का?")) return;
      const { error } = await sb.from("tests").delete().eq("id", +b.dataset.tdel);
      if (error) return toast("Error: " + error.message);
      renderTests();
    });
    $app.querySelectorAll("[data-tresults]").forEach(b => b.onclick = () => renderTestResults(+b.dataset.tresults));
    $app.querySelectorAll("[data-tpreview]").forEach(b => b.onclick = () => previewTest((tests || []).find(x => x.id === +b.dataset.tpreview)));
    $app.querySelectorAll("[data-tinst]").forEach(b => b.onclick = async () => {
      const [id, on] = b.dataset.tinst.split(":");
      const { error } = await sb.from("tests").update({ instant_feedback: on !== "1" }).eq("id", +id);
      if (error) return toast("Error: " + error.message);
      toast(on === "1" ? "⚡ Practice Mode बंद — अब जवाब submit के बाद मिलेगा" : "⚡ Practice Mode चालू — option चुनते ही जवाब मिलेगा");
      renderTests();
    });
  }
  $app.querySelectorAll("[data-tstart]").forEach(b => b.onclick = () => {
    const t = (tests || []).find(x => x.id === +b.dataset.tstart);
    startTest(t, attemptsOf(t.id));
  });
  $app.querySelectorAll("[data-tresult]").forEach(b => b.onclick = () => {
    const [aid, tid] = b.dataset.tresult.split(":");
    showResult(+aid, (tests || []).find(x => x.id === +tid));
  });
}

async function renderTestResults(testId) {
  const host = document.getElementById("tResults");
  host.innerHTML = `<div class="card"><div class="loading">Results लोड हो रहे हैं…</div></div>`;
  const [{ data: attempts }, { data: studs }] = await Promise.all([
    sb.from("test_attempts").select("*").eq("test_id", testId).order("percent", { ascending: false }),
    sb.from("profiles").select("id,full_name").eq("role", "student"),
  ]);
  const nameOf = (id) => (studs || []).find(s => s.id === id)?.full_name || "Student";
  host.innerHTML = `<div class="card"><h3>🏆 Results</h3>
    ${(attempts && attempts.length) ? attempts.map(a => `<div class="item"><div>
      <div class="t">${esc(nameOf(a.student_id))}</div>
      <div class="s">${a.status === "in_progress" ? "⏳ Test चल रहा है" : `${new Date(a.submitted_at).toLocaleString("hi-IN")} • ${Math.round((a.time_taken_seconds || 0) / 60)} मिनट`}</div></div>
      ${a.status === "in_progress" ? `<span class="pill gold">LIVE</span>` : `<span class="pill ${a.passed ? "green" : "red"}">${a.score}/${a.max_score} • ${a.percent}%</span>`}
    </div>`).join("") : `<p>अभी किसी student ने यह test नहीं दिया।</p>`}
  </div>`;
  host.scrollIntoView({ behavior: "smooth" });
}

/* ----- Staff preview of a test (questions + answers, no attempt created) ----- */
async function previewTest(test) {
  if (!test) return;
  $app.innerHTML = `<div class="loading">Test खुल रहा है…</div>`;
  const { data: tqs } = await sb.from("test_questions").select("question_id, sort_order").eq("test_id", test.id).order("sort_order");
  const ids = (tqs || []).map(x => x.question_id);
  if (!ids.length) { $app.innerHTML = `<div class="card"><p>इस test में अभी कोई सवाल नहीं है।</p><button class="light" id="pv_back">← Tests पर वापस</button></div>`; document.getElementById("pv_back").onclick = renderTests; return; }
  const { data: qs } = await sb.from("questions").select("*").in("id", ids);
  const byId = {}; (qs || []).forEach(q => byId[q.id] = q);
  const ordered = ids.map(id => byId[id]).filter(Boolean);
  $app.innerHTML = `
    <div class="card">
      <button class="light small" id="pv_back">← Tests पर वापस</button>
      <h3 style="margin-top:10px">👁 ${esc(test.title)}</h3>
      <p class="muted">${esc((myClasses.find(c => c.id === test.class_id) || {}).name || "")} • ⏱ ${test.duration_minutes} मिनट • ${test.total_marks} अंक • ${ordered.length} सवाल • ${esc(test.status)}</p>
      <p class="muted">यह सिर्फ़ जाँच के लिए है — यहाँ कोई attempt नहीं बनता और कोई result save नहीं होता। हरे रंग में सही उत्तर दिखा है।</p>
    </div>
    ${ordered.map((q, i) => {
      const opts = Array.isArray(q.options) ? q.options : [];
      const corr = Array.isArray(q.correct_answer) ? q.correct_answer.map(String) : [];
      return `<div class="card">
        <div class="t">प्रश्न ${i + 1}. ${esc(q.question_text)}</div>
        <div class="s">${esc(q.qtype)} • ${q.marks} अंक</div>
        ${opts.length ? opts.map(o => `<div style="margin-top:8px; padding:10px 12px; border-radius:10px; border:1.5px solid ${corr.includes(String(o.key)) ? "var(--green, #1a9e54)" : "#e3e8f2"}; background:${corr.includes(String(o.key)) ? "#e9f9f0" : "#fff"}"><b>${esc(o.key)}.</b> ${esc(o.text)} ${corr.includes(String(o.key)) ? "✅" : ""}</div>`).join("")
          : (corr.length ? `<div style="margin-top:8px; padding:10px 12px; border-radius:10px; background:#e9f9f0; border:1.5px solid var(--green, #1a9e54)"><b>उत्तर:</b> ${esc(corr.join(", "))}</div>` : "")}
        ${q.explanation ? `<p class="muted" style="margin-top:8px">💡 ${esc(q.explanation)}</p>` : ""}
      </div>`;
    }).join("")}
    <div class="card"><button class="light" id="pv_back2" style="width:100%">← Tests पर वापस</button></div>`;
  document.getElementById("pv_back").onclick = renderTests;
  document.getElementById("pv_back2").onclick = renderTests;
  window.scrollTo({ top: 0 });
}

/* ----- Taking a test ----- */
async function startTest(test, myAttempts) {
  let attempt = (myAttempts || []).find(a => a.status === "in_progress");
  if (!attempt) {
    const doneCount = (myAttempts || []).filter(a => a.status !== "in_progress").length;
    if (doneCount >= (test.max_attempts || 1)) return toast("इस test की सारी कोशिशें ख़त्म हो गई हैं");
    const { data, error } = await sb.from("test_attempts").insert({ test_id: test.id, student_id: me.id }).select().single();
    if (error) return toast("Error: " + error.message);
    attempt = data;
  }
  const { data: qs, error } = await sb.rpc("get_test_questions", { p_test_id: test.id });
  if (error) return toast("सवाल नहीं मिले: " + error.message);
  const { data: saved } = await sb.from("attempt_responses").select("*").eq("attempt_id", attempt.id);
  run = {
    test, attempt, qs: qs || [], idx: 0,
    answers: new Map((saved || []).map(r => [r.question_id, r.answer])),
    review: new Set((saved || []).filter(r => r.marked_for_review).map(r => r.question_id)),
    feedback: new Map(),
    endsAt: new Date(attempt.started_at).getTime() + test.duration_minutes * 60000,
    timer: null,
  };
  if (test.instant_feedback) {
    const answeredMcq = run.qs.filter(x => (x.qtype === "mcq_single" || x.qtype === "true_false") && run.answers.has(x.question_id) && run.answers.get(x.question_id) !== null);
    await Promise.all(answeredMcq.map(async x => {
      const { data } = await sb.rpc("reveal_answer", { p_attempt_id: attempt.id, p_question_id: x.question_id });
      if (data && data[0]) run.feedback.set(x.question_id, data[0]);
    }));
  }
  renderRun();
  run.timer = setInterval(tickTimer, 500); tickTimer();
}
function tickTimer() {
  if (!run) return;
  const left = run.endsAt - Date.now();
  const el = document.getElementById("tTimer");
  if (el) {
    const s = Math.max(0, Math.floor(left / 1000));
    el.textContent = `⏱ ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    el.classList.toggle("low", left < 60000);
  }
  if (left <= 0) finishTest(true);
}
async function saveAnswer(qid) {
  if (!run) return;
  await sb.from("attempt_responses").upsert({
    attempt_id: run.attempt.id, question_id: qid,
    answer: run.answers.get(qid) ?? null,
    marked_for_review: run.review.has(qid),
    answered_at: new Date().toISOString(),
  }, { onConflict: "attempt_id,question_id" });
}
function renderRun() {
  const { test, qs } = run;
  const q = qs[run.idx];
  const answered = qs.filter(x => run.answers.has(x.question_id) && run.answers.get(x.question_id) !== null).length;
  const opts = Array.isArray(q.options) ? q.options : [];
  let body = "";
  const fb = (test.instant_feedback && run.feedback) ? run.feedback.get(q.question_id) : null;
  if (q.qtype === "mcq_single" || q.qtype === "true_false") {
    const cur = (run.answers.get(q.question_id) || [])[0];
    const keyLabel = (o) => esc(o.key === "true" ? "✓" : o.key === "false" ? "✗" : o.key);
    if (fb) {
      const rightKey = Array.isArray(fb.correct_answer) ? String(fb.correct_answer[0]) : null;
      body = opts.map(o => `<button class="option ${String(o.key) === rightKey ? "right" : cur === o.key ? "wrong" : ""}" disabled><span class="k">${keyLabel(o)}</span>${esc(o.text)}</button>`).join("")
        + `<div class="expl-box">${fb.is_correct ? "✅ <b>सही उत्तर!</b> बहुत बढ़िया 🎉" : "❌ <b>ग़लत उत्तर</b> — सही उत्तर ऊपर हरे रंग में दिखा है।"}${fb.explanation ? `<br>💡 <b>Explanation:</b> ${esc(fb.explanation)}` : ""}</div>
        <p class="muted" style="margin-top:6px">🔒 यह उत्तर lock हो गया है — अब अगले सवाल पर जाएँ।</p>`;
    } else {
      body = opts.map(o => `<button class="option ${cur === o.key ? "sel" : ""}" data-opt="${esc(o.key)}"><span class="k">${keyLabel(o)}</span>${esc(o.text)}</button>`).join("");
    }
  } else if (q.qtype === "fill_blank" || q.qtype === "short" || q.qtype === "descriptive") {
    const cur = (run.answers.get(q.question_id) || [])[0] || "";
    body = `<input id="ansText" placeholder="अपना उत्तर लिखें…" value="${esc(cur)}">
      ${q.qtype !== "fill_blank" ? `<p class="muted">यह उत्तर teacher ख़ुद जाँचेंगे।</p>` : ""}`;
  }
  $app.innerHTML = `
    <div class="card">
      <div class="test-top">
        <h3 style="margin:0">${esc(test.title)}</h3>
        <span style="display:flex; gap:8px; align-items:center">
          <span class="cnt">${run.idx + 1} / ${qs.length}</span>
          <span class="timer-pill" id="tTimer">⏱ --:--</span>
        </span>
      </div>
      <div class="prog" style="margin:12px 0 4px"><div style="width:${qs.length ? (answered / qs.length) * 100 : 0}%"></div></div>
      <p class="muted">सवाल ${run.idx + 1} / ${qs.length} • उत्तर दिए: ${answered} • यह सवाल ${q.marks} अंक का</p>
      ${test.instant_feedback
        ? `<p class="muted" style="margin-top:2px">⚡ <b>Practice Mode:</b> option चुनते ही ✅ सही / ❌ ग़लत + explanation दिखेगा। पहला click ही आपका उत्तर होगा — बाद में बदलेगा नहीं।</p>`
        : `<p class="muted" style="margin-top:2px">एक उत्तर चुनें — वह सिर्फ़ save होगा। ✅ सही / ❌ ग़लत और 💡 explanation, submit के बाद result में मिलेगा।</p>`}
      <div style="font-size:17px; font-weight:700; line-height:1.5; margin:12px 0">${esc(q.question_text)}</div>
      ${body}
      <div class="row" style="margin-top:14px">
        ${fb ? "" : `<button class="light" id="clearQ">🧹 उत्तर हटाएँ</button>`}
        <button class="${run.review.has(q.question_id) ? "gold" : "light"}" id="revQ">🔖 Review के लिए रखें</button>
      </div>
      <button class="gold" id="submitTest" style="width:100%; margin-top:12px">✅ Test Submit करें</button>
    </div>
    <div class="card" style="margin-bottom:170px"><h3>सवाल सूची</h3>
      <div class="grid">${qs.map((x, i) => `<button class="${i === run.idx ? "cur" : ""} ${run.review.has(x.question_id) ? "review" : run.answers.has(x.question_id) && run.answers.get(x.question_id) !== null ? "done" : ""}" data-jump="${i}">${i + 1}</button>`).join("")}</div>
      <p class="muted">गहरा नीला = उत्तर दिया • पीला = review के लिए • घेरा = वर्तमान सवाल</p>
    </div>
    <div class="runnav">
      <button class="light" id="prevQ" ${run.idx === 0 ? "disabled" : ""}>← पिछला सवाल</button>
      <button class="gold" id="nextQ" ${run.idx === qs.length - 1 ? "disabled" : ""}>अगला सवाल →</button>
    </div>`;
  $app.querySelectorAll("[data-opt]").forEach(b => b.onclick = async () => {
    if (run.test.instant_feedback) {
      if (run.answers.has(q.question_id) && run.answers.get(q.question_id) !== null) return; // first click locks
      run.answers.set(q.question_id, [b.dataset.opt]);
      await saveAnswer(q.question_id);
      const { data } = await sb.rpc("reveal_answer", { p_attempt_id: run.attempt.id, p_question_id: q.question_id });
      if (data && data[0]) run.feedback.set(q.question_id, data[0]);
      renderRun();
      return;
    }
    run.answers.set(q.question_id, [b.dataset.opt]); await saveAnswer(q.question_id); renderRun();
  });
  const txt = document.getElementById("ansText");
  if (txt) txt.onchange = async () => { run.answers.set(q.question_id, [txt.value]); await saveAnswer(q.question_id); renderRun(); };
  document.getElementById("prevQ").onclick = () => { run.idx--; renderRun(); };
  document.getElementById("nextQ").onclick = () => { run.idx++; renderRun(); };
  const clearBtn = document.getElementById("clearQ");
  if (clearBtn) clearBtn.onclick = async () => {
    run.answers.delete(q.question_id); await saveAnswer(q.question_id); renderRun();
  };
  document.getElementById("revQ").onclick = async () => {
    run.review.has(q.question_id) ? run.review.delete(q.question_id) : run.review.add(q.question_id);
    await saveAnswer(q.question_id); renderRun();
  };
  $app.querySelectorAll("[data-jump]").forEach(b => b.onclick = () => { run.idx = +b.dataset.jump; renderRun(); });
  document.getElementById("submitTest").onclick = () => {
    if (confirm("Test submit करें? इसके बाद उत्तर नहीं बदल सकेंगे।")) finishTest(false);
  };
  tickTimer();
}
async function finishTest(auto) {
  if (!run) return;
  const { attempt, test } = run;
  clearInterval(run.timer);
  const { data, error } = await sb.rpc("submit_attempt", { p_attempt_id: attempt.id });
  run = null;
  if (error) { toast("Submit में दिक्कत: " + error.message); tab = "tests"; renderShell(); return; }
  if (auto) toast("⏰ समय ख़त्म — test अपने-आप submit हो गया");
  showResult(data.id, test);
}

/* ----- Result + review ----- */
async function showResult(attemptId, test) {
  tab = "tests";
  $app.innerHTML = `<div class="loading">Result लोड हो रहा है…</div>`;
  $tabbar.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.tab === "tests"));
  const { data: attempt } = await sb.from("test_attempts").select("*").eq("id", attemptId).single();
  const { data: review, error } = await sb.rpc("get_attempt_review", { p_attempt_id: attemptId });
  const pct = attempt ? +attempt.percent || 0 : 0;
  const C = 2 * Math.PI * 44;
  $app.innerHTML = `
    <div class="card">
      <div class="ring-wrap">
        <div class="ring">
          <svg width="104" height="104"><circle cx="52" cy="52" r="44" stroke="#e6ecf6" stroke-width="10" fill="none"/>
          <circle cx="52" cy="52" r="44" stroke="${attempt?.passed ? "#0e9f6e" : "#d64541"}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C - (C * pct) / 100}"/></svg>
          <div class="ring-c">${pct}%<br><span style="font-size:11px; color:var(--muted)">${attempt?.passed ? "PASS ✅" : "FAIL ❌"}</span></div>
        </div>
        <div>
          <h3 style="margin-bottom:4px">${esc(test ? test.title : "Test Result")}</h3>
          <p>Score: <b>${attempt?.score} / ${attempt?.max_score}</b><br>समय लगा: ${Math.round((attempt?.time_taken_seconds || 0) / 60)} मिनट<br>स्थिति: ${attempt?.passed ? "आप पास हैं 🎉" : "कोई बात नहीं — अभ्यास जारी रखें 💪"}</p>
        </div>
      </div>
    </div>
    ${error ? `<div class="card"><p>विस्तृत review अभी उपलब्ध नहीं है (${esc(error.message)})। Result ऊपर दिखा दिया गया है।</p></div>`
    : `<div class="card"><h3>📖 उत्तरों की समीक्षा</h3>
      ${(review || []).map((r, i) => {
        const mine = Array.isArray(r.my_answer) ? r.my_answer[0] : null;
        const right = Array.isArray(r.correct_answer) ? r.correct_answer[0] : null;
        const opts = Array.isArray(r.options) ? r.options : [];
        const optText = (k) => (opts.find(o => o.key === k)?.text ?? k);
        return `<div style="padding:14px 0; border-bottom:1px solid var(--line)">
          <div style="font-weight:700">Q${i + 1}. ${esc(r.question_text)}</div>
          <div style="margin-top:6px">
            ${r.is_correct === null ? `<span class="pill gold">Teacher जाँचेंगे</span>` : r.is_correct ? `<span class="pill green">✅ सही • +${r.marks_awarded} अंक</span>` : `<span class="pill red">❌ ग़लत • ${r.marks_awarded} अंक</span>`}
          </div>
          ${opts.length ? opts.map(o => `<div class="option ${String(o.key) === String(right) ? "right" : String(o.key) === String(mine) ? "wrong" : ""}" style="cursor:default"><span class="k">${esc(o.key)}</span>${esc(o.text)}</div>`).join("")
            : `<div class="s" style="margin-top:6px">आपका उत्तर: <b>${mine === null || mine === undefined ? "— (नहीं दिया)" : esc(mine)}</b><br>सही उत्तर: <b>${esc(right ?? "—")}</b></div>`}
          ${r.explanation ? `<div class="expl-box">💡 <b>Explanation:</b> ${esc(r.explanation)}</div>` : ""}
        </div>`;
      }).join("")}
    </div>`}
    <button class="light" style="width:100%" onclick="location.reload()">← Tests पर वापस</button>`;
}

/* ---------------- More / Profile ---------------- */
async function renderMore() {
  let classNames = [];
  let testsGiven = 0, avg = 0;
  if (profile.role === "student") {
    const [{ data: enr }, { data: atts }] = await Promise.all([
      sb.from("enrollments").select("class_id").eq("user_id", me.id),
      sb.from("test_attempts").select("percent").eq("student_id", me.id).neq("status", "in_progress"),
    ]);
    classNames = (enr || []).map(e => (myClasses.find(c => c.id === e.class_id) || {}).name).filter(Boolean);
    testsGiven = (atts || []).length;
    avg = testsGiven ? Math.round((atts || []).reduce((s, a) => s + (+a.percent || 0), 0) / testsGiven) : 0;
  }
  let myFees = [];
  if (profile.role === "student" || profile.role === "parent") {
    const { data } = await sb.from("fee_records").select("*").order("created_at", { ascending: false }).limit(12);
    myFees = data || [];
  }
  let myPhoto = null;
  if (profile.photo_path) {
    const { data } = await sb.storage.from("avatars").createSignedUrl(profile.photo_path, 3600);
    myPhoto = data?.signedUrl || null;
  }
  const feeDueTotal = myFees.reduce((s, r) => s + (+r.amount - +r.paid_amount), 0);
  $app.innerHTML = `
    <div class="card" style="text-align:center">
      ${myPhoto
        ? `<img src="${myPhoto}" alt="" class="zoomable" title="बड़ा देखने के लिए दबाएँ" data-zoom="${myPhoto}" style="width:76px; height:76px; border-radius:50%; object-fit:cover; margin:4px auto 10px; display:block; border:3px solid var(--gold)">`
        : `<div class="avatar" style="width:76px; height:76px; font-size:30px; margin:4px auto 10px">${esc((profile.full_name || "T").trim()[0].toUpperCase())}</div>`}
      <div style="font-size:19px; font-weight:900; color:var(--navy)">${esc(profile.full_name)}</div>
      <div class="muted">${esc(me.email)}</div>
      <div style="margin-top:8px"><span class="pill gold">${esc(roleName(profile.role))}</span></div>
      ${profile.role === "student" ? `<div class="stats" style="margin-top:14px">
        <div class="stat"><div class="n">${testsGiven}</div><div class="l">Tests दिए</div></div>
        <div class="stat"><div class="n">${avg}%</div><div class="l">औसत Score</div></div>
        <div class="stat"><div class="n">${classNames.length}</div><div class="l">Classes</div></div>
      </div>` : ""}
    </div>
    ${(profile.role === "student" || profile.role === "parent") ? `
    <div class="card"><h3>💰 ${profile.role === "parent" ? "बच्चे की Fees" : "मेरी Fees"}</h3>
      ${feeDueTotal > 0 ? `<p style="color:var(--bad); font-weight:700">कुल बकाया: ₹${feeDueTotal.toLocaleString("en-IN")}</p>` : `<p class="ok" style="font-weight:700">कोई बकाया नहीं 🎉</p>`}
      ${myFees.map(r => `<div class="item"><div><div class="t" style="font-size:14px">${esc(r.fee_type)} — ${esc(r.period)}</div>
        <div class="s">₹${r.amount} में से ₹${r.paid_amount} जमा${r.due_date ? ` • आखिरी तारीख़: ${esc(r.due_date)}` : ""}</div></div>
        <span class="pill ${r.status === "paid" ? "green" : r.status === "partial" ? "gold" : "red"}">${r.status}</span></div>`).join("") || `<p class="muted">अभी कोई fee record नहीं है।</p>`}
    </div>` : ""}
    <div class="card">
      ${profile.role === "student" ? `<div class="menu-item"><span class="mi">🎓</span>मेरी Classes<span class="arr">${esc(classNames.join(", ") || "—")}</span></div>` : ""}
      <div class="menu-item" data-nav="doubts" style="cursor:pointer"><span class="mi">❓</span>Doubts<span class="arr">›</span></div>
      <div class="menu-item" data-nav="tutor" style="cursor:pointer"><span class="mi">🤖</span>AI Tutor<span class="arr">›</span></div>
      <div class="menu-item" data-nav="live" style="cursor:pointer"><span class="mi">📺</span>Live Class<span class="arr">›</span></div>
      <div class="menu-item" data-nav="top" style="cursor:pointer"><span class="mi">🏆</span>Leaderboard<span class="arr">›</span></div>
      <div class="menu-item" data-nav="homework" style="cursor:pointer"><span class="mi">📒</span>Homework<span class="arr">›</span></div>
      <div class="menu-item" data-nav="attendance" style="cursor:pointer"><span class="mi">✅</span>Attendance<span class="arr">›</span></div>
      <div class="menu-item" data-nav="timetable" style="cursor:pointer"><span class="mi">🗓️</span>Timetable<span class="arr">›</span></div>
      <div class="menu-item"><span class="mi">🎯</span>Target Academy<span class="arr">Manikpur, Gopalganj</span></div>
      <div class="menu-item"><span class="mi">👨‍🏫</span>Director<span class="arr">Ashutosh Kumar</span></div>
      <div class="menu-item"><span class="mi">📱</span>Platform<span class="arr">Target Academy v2</span></div>
    </div>
    <button class="danger" style="width:100%" onclick="document.getElementById('logoutBtn').click()">🚪 Logout करें</button>`;
  $app.querySelectorAll("[data-nav]").forEach(el => el.onclick = () => { tab = el.dataset.nav; renderShell(); });
}

/* ---------------- Start ---------------- */
sb.auth.onAuthStateChange(() => { /* boot handles routing */ });
boot();

/* ---------------- Notifications / Live / Leaderboard ---------------- */
async function renderNotifs() {
  const { data: rows } = await sb.from("notifications").select("*").eq("user_id", me.id).order("created_at", { ascending: false }).limit(50);
  const icons = { announcement: "📢", test: "📝", doubt: "❓", live: "📺", note: "📚", assignment: "📒", fee: "💰", result: "🏆", admission: "✅", welcome: "🎉" };
  const unread = (rows || []).filter(n => !n.is_read).length;
  $app.innerHTML = `
    <div class="card"><h3 style="margin:0">📲 Phone पर सूचना</h3>
      <p class="muted" style="margin:6px 0 0">चालू करने पर हर नई सूचना (notice, test, doubt का जवाब, live class) सीधे आपके phone पर आएगी — app बंद हो तब भी।</p>
      ${pushSupported()
        ? (Notification.permission === "granted"
          ? `<p style="margin:10px 0 0">✅ इस phone पर सूचना चालू है।</p>`
          : Notification.permission === "denied"
            ? `<p style="margin:10px 0 0">⚠️ Browser ने सूचना रोक रखी है — Chrome की Site Settings में Notifications को Allow करें।</p>`
            : `<button id="npBtn" style="margin-top:10px">📲 Phone सूचना चालू करें</button>`)
        : `<p style="margin:10px 0 0">यह browser phone सूचना नहीं देता — app को Chrome में खोलें।</p>`}
    </div>
    <div class="card"><h3 style="margin:0">🔔 मेरी सूचनाएँ ${unread ? `<span class="pill green">${unread} नई</span>` : ""}</h3>
      <p class="muted" style="margin:6px 0 0">Academy की हर नई जानकारी — notice, नए tests, doubt के जवाब — यहाँ मिलेगी।</p>
      ${unread ? `<button class="light" id="nReadAll" style="margin-top:10px">✓ सभी को पढ़ा हुआ mark करें</button>` : ""}
    </div>
    ${(rows || []).map(n => `
      <div class="card" data-nread="${n.id}" style="cursor:pointer;${n.is_read ? "opacity:.72" : ""}">
        <div class="row" style="justify-content:space-between">
          <b>${icons[n.kind] || "🔔"} ${esc(n.title)}</b>${n.is_read ? "" : `<span class="pill green">नया</span>`}
        </div>
        ${n.body ? `<p class="muted" style="margin:6px 0 0">${esc(n.body)}</p>` : ""}
        <div class="s muted" style="margin-top:6px">${new Date(n.created_at).toLocaleString("hi-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</div>
      </div>`).join("") || `<div class="card"><p class="muted">अभी कोई सूचना नहीं है।</p></div>`}`;
  const npBtn = document.getElementById("npBtn");
  if (npBtn) npBtn.onclick = enablePush;
  const allBtn = document.getElementById("nReadAll");
  if (allBtn) allBtn.onclick = async () => {
    await sb.from("notifications").update({ is_read: true }).eq("user_id", me.id).eq("is_read", false);
    refreshBell(); renderNotifs();
  };
  $app.querySelectorAll("[data-nread]").forEach(c => c.onclick = async () => {
    await sb.from("notifications").update({ is_read: true }).eq("id", +c.dataset.nread);
    refreshBell(); renderNotifs();
  });
}

async function renderLive() {
  const clsName = (id) => (myClasses.find(c => c.id === id) || {}).name || "";
  const { data: rows, error } = await sb.from("live_classes").select("*").order("starts_at", { ascending: true });
  if (error) { $app.innerHTML = `<div class="card"><h3>📺 Live Class</h3><p class="muted">यह feature अभी तैयार हो रहा है।</p></div>`; return; }
  const cutoff = Date.now() - 2 * 3600 * 1000;
  const up = (rows || []).filter(r => new Date(r.starts_at).getTime() > cutoff);
  const past = (rows || []).filter(r => new Date(r.starts_at).getTime() <= cutoff).reverse();
  const fmt = (iso) => new Date(iso).toLocaleString("hi-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const card = (r, old) => `
    <div class="card" ${old ? `style="opacity:.65"` : ""}>
      <h3 style="margin:0">📺 ${esc(r.title)}</h3>
      <div class="s muted" style="margin-top:4px">${esc(clsName(r.class_id))} • 🕐 ${fmt(r.starts_at)}</div>
      <div class="row" style="margin-top:10px">
        <a href="${esc(r.meet_link)}" target="_blank" rel="noopener"><button>▶ Join करें</button></a>
        ${isStaff() ? `<button class="danger small" data-lcdel="${r.id}">हटाएँ</button>` : ""}
      </div>
    </div>`;
  $app.innerHTML = `
    ${isStaff() ? `<div class="card"><h3>📺 नई Live Class रखें</h3>
      <label>Class</label><select id="lc_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <label>शीर्षक</label><input id="lc_title" placeholder="जैसे: Physics — प्रकाशिकी Revision">
      <label>Join Link (Google Meet / Zoom / YouTube Live)</label><input id="lc_link" placeholder="https://meet.google.com/...">
      <label>तारीख़ और समय</label><input id="lc_time" type="datetime-local">
      <p class="err" id="lcErr"></p>
      <button id="lcBtn">📺 Live Class बनाएँ</button>
      <p class="muted" style="margin:8px 0 0">बनाते ही उस class के students को सूचना चली जाएगी।</p></div>` : ""}
    <div class="card"><h3 style="margin:0">📺 आने वाली Live Classes</h3></div>
    ${up.map(r => card(r, false)).join("") || `<div class="card"><p class="muted">अभी कोई live class तय नहीं है।</p></div>`}
    ${past.length ? `<div class="card"><h3 style="margin:0">पिछली Classes</h3></div>${past.map(r => card(r, true)).join("")}` : ""}`;
  if (isStaff()) {
    document.getElementById("lcBtn").onclick = async () => {
      const err = document.getElementById("lcErr");
      const class_id = +document.getElementById("lc_class").value;
      const title = document.getElementById("lc_title").value.trim();
      const meet_link = document.getElementById("lc_link").value.trim();
      const tval = document.getElementById("lc_time").value;
      if (!title) { err.textContent = "शीर्षक लिखें"; return; }
      if (!/^https?:\/\//i.test(meet_link)) { err.textContent = "सही join link डालें (https:// से शुरू)"; return; }
      if (!tval) { err.textContent = "तारीख़ और समय चुनें"; return; }
      const { error } = await sb.from("live_classes").insert({ class_id, title, meet_link, starts_at: new Date(tval).toISOString(), created_by: me.id });
      if (error) { err.textContent = error.message; return; }
      await notifyClassStudents(class_id, "live", "📺 Live Class: " + title, fmt(new Date(tval).toISOString()) + " — Join link Live Class section में मिलेगा।");
      toast("Live Class बन गई 📺"); renderLive();
    };
    $app.querySelectorAll("[data-lcdel]").forEach(b => b.onclick = async () => {
      if (!confirm("यह live class हटाएँ?")) return;
      const { error } = await sb.from("live_classes").delete().eq("id", +b.dataset.lcdel);
      if (error) return toast("Error: " + error.message);
      renderLive();
    });
  }
}

let topClass = "all";
async function renderTop() {
  const { data, error } = await sb.rpc("get_leaderboard", { p_class_id: topClass === "all" ? null : +topClass });
  if (error) { $app.innerHTML = `<div class="card"><h3>🏆 Leaderboard</h3><p class="muted">यह feature अभी तैयार हो रहा है।</p></div>`; return; }
  const medals = ["🥇", "🥈", "🥉"];
  $app.innerHTML = `
    <div class="card"><h3 style="margin:0">🏆 Leaderboard</h3>
      <p class="muted" style="margin:6px 0 0">Tests में सबसे अच्छे score वाले students — मेहनत का सम्मान!</p>
      <div class="row" style="margin-top:10px">
        <button class="${topClass === "all" ? "" : "light"} small" data-tclass="all">सभी Classes</button>
        ${myClasses.map(c => `<button class="${String(topClass) === String(c.id) ? "" : "light"} small" data-tclass="${c.id}">${esc(c.name)}</button>`).join("")}
      </div></div>
    ${(data || []).map((r, i) => `
      <div class="card" ${r.student_id === me.id ? `style="border:2px solid var(--gold,#c9a227)"` : ""}>
        <div class="row" style="justify-content:space-between">
          <b>${medals[i] || (i + 1) + "."} ${esc(r.full_name)}${r.student_id === me.id ? " (आप)" : ""}</b>
          <span class="pill ${i === 0 ? "green" : ""}">${r.avg_pct}% औसत</span>
        </div>
        <div class="s muted" style="margin-top:4px">Tests दिए: ${r.tests_given}</div>
      </div>`).join("") || `<div class="card"><p class="muted">अभी किसी ने test नहीं दिया है — पहले test के बाद रैंकिंग यहाँ दिखेगी।</p></div>`}`;
  $app.querySelectorAll("[data-tclass]").forEach(b => b.onclick = () => { topClass = b.dataset.tclass; renderTop(); });
}

/* ---------------- AI Tutor ---------------- */
let tutorChat = [];   // {role:'me'|'ai', text} — kept while the app stays open
let tutorBusy = false;
async function renderTutor() {
  const chips = ["प्रकाश का अपवर्तन समझाइए", "Photosynthesis क्या होता है?", "त्रिभुज के कोणों का योग 180° क्यों होता है?", "Water cycle समझाइए", "x + 5 = 12 कैसे हल होगा?"];
  const bubble = (m) => m.role === "me"
    ? `<div class="chatrow me"><div class="bubble me">${esc(m.text)}</div></div>`
    : `<div class="chatrow"><div class="bubble ai"><b>🤖 AI Tutor</b><br>${esc(m.text).replace(/\n/g, "<br>")}</div></div>`;
  $app.innerHTML = `
    <div class="card"><h3 style="margin:0">🤖 AI Tutor</h3>
      <p class="muted" style="margin:6px 0 0">पढ़ाई का कोई भी सवाल पूछें — AI Tutor आसान हिंदी में step-by-step समझाएगा।</p>
      ${tutorChat.length ? "" : `<div class="row" style="margin-top:10px">${chips.map(c => `<button class="light small" data-tchip="${esc(c)}">${esc(c)}</button>`).join("")}</div>`}
    </div>
    <div id="tutorMsgs">${tutorChat.map(bubble).join("")}${tutorBusy ? `<div class="chatrow"><div class="bubble ai">🤖 लिख रहा है…</div></div>` : ""}</div>
    <form id="tutorForm" class="card">
      <div class="row">
        <input id="tutorInput" placeholder="अपना सवाल लिखें…" style="flex:1" ${tutorBusy ? "disabled" : ""}>
        <button type="submit" ${tutorBusy ? "disabled" : ""}>पूछें ➤</button>
      </div>
      ${tutorChat.length ? `<button type="button" class="light small" id="tutorClear" style="margin-top:8px">🧹 बातचीत साफ़ करें</button>` : ""}
    </form>`;
  const send = async (text) => {
    const q = (text || "").trim(); if (!q || tutorBusy) return;
    tutorChat.push({ role: "me", text: q });
    tutorBusy = true; renderTutor();
    const history = tutorChat.slice(0, -1).map(m => ({ role: m.role === "ai" ? "ai" : "user", text: m.text }));
    const { data, error } = await sb.functions.invoke("ask-tutor", { body: { question: q, history } });
    tutorBusy = false;
    if (error || !data?.answer) tutorChat.push({ role: "ai", text: "माफ़ करना, अभी जवाब नहीं बन पाया। थोड़ी देर बाद फिर कोशिश करें।" });
    else tutorChat.push({ role: "ai", text: data.answer });
    renderTutor();
  };
  document.getElementById("tutorForm").onsubmit = (e) => { e.preventDefault(); send(document.getElementById("tutorInput").value); };
  $app.querySelectorAll("[data-tchip]").forEach(b => b.onclick = () => send(b.dataset.tchip));
  const clr = document.getElementById("tutorClear");
  if (clr) clr.onclick = () => { tutorChat = []; renderTutor(); };
  window.scrollTo(0, document.body.scrollHeight);
}

/* ---------------- Doubts ---------------- */
let doubtTab = "open"; // staff filter: open | answered | all
async function renderDoubts() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const [{ data: doubts }, { data: subjects }] = await Promise.all([
    sb.from("doubts").select("*").order("created_at", { ascending: false }),
    sb.from("subjects").select("*").order("sort_order"),
  ]);
  const list = doubts || [];
  const subName = (id) => (subjects || []).find(s => s.id === id)?.name || "";
  const clsName = (id) => (myClasses.find(c => c.id === id) || {}).name || "";
  const nameMap = {};
  if (isStaff() && list.length) {
    const ids = [...new Set(list.flatMap(d => [d.student_id, d.answered_by]).filter(Boolean))];
    const { data: profs } = await sb.from("profiles").select("id,full_name").in("id", ids);
    (profs || []).forEach(p => nameMap[p.id] = p.full_name);
  }
  const statusPill = (d) => d.status === "answered"
    ? `<span class="pill green">✅ जवाब मिल गया</span>`
    : d.status === "closed" ? `<span class="pill">बंद</span>` : `<span class="pill gold">⏳ जवाब बाकी</span>`;
  const doubtCard = (d, staffView) => `
    <div class="card">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start">
        <div style="font-weight:700; font-size:15.5px; line-height:1.45">❓ ${esc(d.question_text)}</div>
        ${statusPill(d)}
      </div>
      <p class="muted" style="margin:6px 0 0">${staffView ? `👤 ${esc(nameMap[d.student_id] || "Student")} • ` : ""}${d.class_id ? esc(clsName(d.class_id)) + " • " : ""}${d.subject_id ? esc(subName(d.subject_id)) + " • " : ""}${new Date(d.created_at).toLocaleString("hi-IN")}</p>
      ${d.answer_text ? `<div class="expl-box" style="margin-top:10px">💬 <b>जवाब${staffView && d.answered_by && nameMap[d.answered_by] ? ` — ${esc(nameMap[d.answered_by])}` : ""}:</b><br><span style="white-space:pre-wrap">${esc(d.answer_text)}</span>${d.answered_at ? `<br><span class="muted">${new Date(d.answered_at).toLocaleString("hi-IN")}</span>` : ""}</div>` : ""}
      ${d.ai_answer ? `<div class="expl-box" style="margin-top:10px; background:#eef4ff; border-color:#9db9e8">🤖 <b>AI का जवाब:</b><br><span style="white-space:pre-wrap">${esc(d.ai_answer)}</span></div>`
        : `<div style="margin-top:10px"><button class="light small" data-dai="${d.id}">🤖 AI से जवाब लें</button></div>`}
      ${staffView && d.status === "open" ? `
        <label style="margin-top:10px">अपना जवाब लिखें</label>
        <textarea id="da-${d.id}" placeholder="समझाकर जवाब लिखें…"></textarea>
        <div class="error" id="de-${d.id}"></div>
        <button class="gold" data-dans="${d.id}" style="width:100%">जवाब भेजें</button>` : ""}
    </div>`;

  const wireAI = () => {
    $app.querySelectorAll("[data-dai]").forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = "🤖 AI जवाब ला रहा है…";
      const { error } = await sb.functions.invoke("answer-doubt", { body: { doubt_id: +b.dataset.dai } });
      if (error) toast("AI जवाब अभी नहीं आ पाया — Sir जवाब देंगे");
      renderDoubts();
    });
  };

  if (isStaff()) {
    const open = list.filter(d => d.status === "open");
    const answered = list.filter(d => d.status !== "open");
    const shown = doubtTab === "open" ? open : doubtTab === "answered" ? answered : list;
    $app.innerHTML = `
      <div class="card"><h3>❓ Students के Doubts</h3>
        <div class="row">
          <button class="${doubtTab === "open" ? "" : "light"}" data-dtab="open">⏳ जवाब बाकी (${open.length})</button>
          <button class="${doubtTab === "answered" ? "" : "light"}" data-dtab="answered">✅ जवाब दिए (${answered.length})</button>
          <button class="${doubtTab === "all" ? "" : "light"}" data-dtab="all">सभी (${list.length})</button>
        </div>
        <p class="muted" style="margin:8px 0 0">Student जो सवाल पूछता है, वह यहाँ आता है। जवाब लिखकर भेजें — student को उसी समय दिख जाएगा।</p>
      </div>
      ${shown.map(d => doubtCard(d, true)).join("") || `<div class="card"><p class="muted">इस सूची में अभी कोई doubt नहीं है।</p></div>`}`;
    $app.querySelectorAll("[data-dtab]").forEach(b => b.onclick = () => { doubtTab = b.dataset.dtab; renderDoubts(); });
    $app.querySelectorAll("[data-dans]").forEach(b => b.onclick = async () => {
      const id = +b.dataset.dans;
      const txt = document.getElementById("da-" + id).value.trim();
      const err = document.getElementById("de-" + id);
      if (!txt) { err.textContent = "पहले जवाब लिखें"; return; }
      const { error } = await sb.from("doubts").update({ answer_text: txt, answered_by: me.id, status: "answered", answered_at: new Date().toISOString() }).eq("id", id);
      if (error) { err.textContent = error.message; return; }
      const d0 = (list || []).find(x => x.id === id);
      if (d0) await notifyUsers([d0.student_id], "doubt", "✅ आपके doubt का जवाब आ गया", (d0.question_text || "").slice(0, 120));
      toast("जवाब भेज दिया ✅"); renderDoubts();
    });
    wireAI();
    return;
  }

  // Student view: ask + my doubts
  const { data: enr } = await sb.from("enrollments").select("class_id").eq("user_id", me.id);
  const enrolledIds = (enr || []).map(e => e.class_id);
  const mySubjs = (subjects || []).filter(s => enrolledIds.includes(s.class_id));
  $app.innerHTML = `
    <div class="card"><h3>❓ अपना Doubt पूछें</h3>
      <p class="muted" style="margin-top:0">पढ़ाई में जो समझ न आए, यहाँ लिखें — Sir जवाब देंगे।</p>
      <label>Subject</label>
      <select id="db_subject"><option value="">— सामान्य सवाल —</option>${mySubjs.map(s => `<option value="${s.id}">${esc(s.name)}${s.name_hi ? " • " + esc(s.name_hi) : ""} (${esc(clsName(s.class_id))})</option>`).join("")}</select>
      <label>अपना सवाल लिखें</label>
      <textarea id="db_q" placeholder="जैसे: प्रकाश का अपवर्तन किसे कहते हैं? उदाहरण के साथ समझाइए…"></textarea>
      <div class="error" id="db_err"></div>
      <button class="gold" id="db_ask" style="width:100%">Doubt भेजें</button>
    </div>
    <div class="card"><h3>🙋 मेरे Doubts (${list.length})</h3>
      <p class="muted" style="margin:0">जवाब मिलते ही यहाँ ✅ दिखेगा।</p>
    </div>
    ${list.map(d => doubtCard(d, false)).join("") || `<div class="card"><p class="muted">अभी आपने कोई doubt नहीं पूछा।</p></div>`}`;
  document.getElementById("db_ask").onclick = async () => {
    const err = document.getElementById("db_err"); err.textContent = "";
    const q = document.getElementById("db_q").value.trim();
    if (!q) { err.textContent = "पहले अपना सवाल लिखें"; return; }
    const sid = document.getElementById("db_subject").value;
    const subj = mySubjs.find(s => s.id === +sid);
    const { data: nd, error } = await sb.from("doubts").insert({
      student_id: me.id,
      subject_id: subj ? subj.id : null,
      class_id: subj ? subj.class_id : (enrolledIds[0] || null),
      question_text: q,
    }).select().single();
    if (error) { err.textContent = error.message; return; }
    toast("Doubt भेज दिया ❓ — 🤖 AI जवाब ला रहा है…");
    if (nd) { try { await sb.functions.invoke("answer-doubt", { body: { doubt_id: nd.id } }); } catch (_) { /* AI न आए तो Sir जवाब देंगे */ } }
    renderDoubts();
  };
  wireAI();
}

/* ---------------- Homework ---------------- */
let hwClassId = null, hwOpenId = null, hwSubmitId = null;
async function renderHomework() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const [{ data: assigns }, { data: subs }, { data: subjects }] = await Promise.all([
    sb.from("assignments").select("*").order("created_at", { ascending: false }),
    sb.from("submissions").select("*"),
    sb.from("subjects").select("*"),
  ]);
  const subName = (id) => (subjects || []).find(s => s.id === id)?.name || "";
  const clsName = (id) => (myClasses.find(c => c.id === id) || {}).name || "";
  const list = (assigns || []).filter(a => !hwClassId || a.class_id === hwClassId);
  const mySub = (aid) => (subs || []).find(s => s.assignment_id === aid && s.student_id === me.id);
  const chips = `<div class="card"><h3>🎓 Class चुनें</h3><div class="row">
    <button class="${!hwClassId ? "" : "light"}" data-hwcls="">सभी Classes</button>
    ${myClasses.map(c => `<button class="${c.id === hwClassId ? "" : "light"}" data-hwcls="${c.id}">${esc(c.name)}</button>`).join("")}</div></div>`;

  let staffForm = "";
  if (isStaff()) {
    staffForm = `<div class="card"><h3>➕ नया Homework दें</h3>
      <label>शीर्षक</label><input id="hw_title" placeholder="जैसे: Chapter 5 के प्रश्न 1–10">
      <div class="row">
        <div><label>Class</label><select id="hw_class">${myClasses.map(c => `<option value="${c.id}" ${c.id === hwClassId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
        <div><label>Subject</label><select id="hw_subject"><option value="">— कोई नहीं —</option>${(subjects || []).map(s => `<option value="${s.id}">${esc(s.name)} (${esc(clsName(s.class_id))})</option>`).join("")}</select></div>
      </div>
      <label>निर्देश</label><textarea id="hw_ins" placeholder="क्या करना है, साफ़ लिखें…"></textarea>
      <div class="row">
        <div><label>जमा करने की आखिरी तारीख़</label><input id="hw_due" type="date"></div>
        <div><label>पूर्णांक (अंक)</label><input id="hw_marks" type="number" placeholder="जैसे 10"></div>
      </div>
      <div class="error" id="hw_err"></div>
      <button class="gold" id="hw_add" style="width:100%">Homework भेजें</button></div>`;
  }

  const cards = list.map(a => {
    const mine = !isStaff() ? mySub(a.id) : null;
    const subCount = (subs || []).filter(s => s.assignment_id === a.id).length;
    const overdue = a.due_at && new Date(a.due_at) < new Date();
    return `<div class="card">
      <div style="display:flex; justify-content:space-between; gap:10px">
        <h3 style="margin:0; font-size:16px">📒 ${esc(a.title)}</h3>
        ${a.max_marks ? `<span class="pill gold">${a.max_marks} अंक</span>` : ""}
      </div>
      <p class="muted" style="margin:6px 0">${esc(clsName(a.class_id))}${a.subject_id ? " • " + esc(subName(a.subject_id)) : ""}${a.due_at ? ` • आखिरी तारीख़: <b style="color:${overdue ? "var(--bad)" : "inherit"}">${new Date(a.due_at).toLocaleDateString("hi-IN")}</b>` : ""}</p>
      ${a.instructions ? `<p style="white-space:pre-wrap; margin:6px 0">${esc(a.instructions)}</p>` : ""}
      ${isStaff() ? `<p class="muted">जमा किए: <b>${subCount}</b> students</p>
        <button class="light small" data-hwopen="${a.id}">${hwOpenId === a.id ? "Submissions छिपाएँ" : "Submissions देखें"}</button>
        <button class="danger small" data-hwdel="${a.id}">✕ हटाएँ</button>
        ${hwOpenId === a.id ? `<div style="margin-top:10px">${(subs || []).filter(s => s.assignment_id === a.id).map(s => `
          <div class="item"><div style="flex:1"><div class="t" style="font-size:14px" data-subname="${s.student_id}">Student</div>
            <div class="s">${new Date(s.submitted_at).toLocaleString("hi-IN")}${s.body ? `<br>${esc(s.body)}` : ""}</div>
            ${s.file_path ? `<button class="small light" data-hwfile="${esc(s.file_path)}">📎 File खोलें</button>` : ""}
            <div class="row" style="margin-top:6px">
              <div><label>अंक</label><input type="number" id="gm-${s.id}" value="${s.marks ?? ""}" style="width:90px"></div>
              <div style="flex:2"><label>Feedback</label><input id="gf-${s.id}" value="${esc(s.feedback || "")}"></div>
              <div style="flex:0 0 auto"><button class="small gold" data-grade="${s.id}">Save</button></div>
            </div></div>
            <span class="pill ${s.status === "reviewed" ? "green" : "gold"}">${esc(s.status)}</span></div>`).join("") || `<p class="muted">अभी किसी ने जमा नहीं किया।</p>`}</div>` : ""}`
      : mine ? `<p>✅ <b>जमा किया</b> — ${new Date(mine.submitted_at).toLocaleString("hi-IN")}
          ${mine.status === "reviewed" ? `<br>🏅 अंक: <b>${mine.marks ?? "—"}${a.max_marks ? " / " + a.max_marks : ""}</b>${mine.feedback ? `<br>💬 ${esc(mine.feedback)}` : ""}` : `<br><span class="muted">Teacher की जाँच बाकी है</span>`}</p>
          ${mine.file_path ? `<button class="small light" data-hwfile="${esc(mine.file_path)}">📎 मेरी File</button>` : ""}
          ${a.allow_resubmit || mine.status !== "reviewed" ? `<button class="small" data-hwsub="${a.id}">फिर से जमा करें</button>` : ""}`
      : `<p style="color:var(--bad); font-weight:700">⏳ अभी जमा नहीं किया</p>
          <button class="gold small" data-hwsub="${a.id}">📤 Homework जमा करें</button>`}
      ${hwSubmitId === a.id && !isStaff() ? `<div style="margin-top:10px">
          <label>उत्तर लिखें</label><textarea id="sub_body" placeholder="अपना homework यहाँ लिखें…">${mine ? esc(mine.body || "") : ""}</textarea>
          <label>फ़ोटो / File (ऐच्छिक)</label><input id="sub_file" type="file">
          <div class="error" id="sub_err"></div>
          <button class="gold" id="sub_send" style="width:100%">जमा करें</button></div>` : ""}
    </div>`;
  }).join("");

  $app.innerHTML = chips + staffForm + (cards || `<div class="card"><p class="muted">इस class में अभी कोई homework नहीं है।</p></div>`);

  $app.querySelectorAll("[data-hwcls]").forEach(b => b.onclick = () => { hwClassId = b.dataset.hwcls ? +b.dataset.hwcls : null; renderHomework(); });
  if (isStaff()) {
    document.getElementById("hw_add").onclick = async () => {
      const err = document.getElementById("hw_err"); err.textContent = "";
      const title = document.getElementById("hw_title").value.trim();
      if (!title) { err.textContent = "शीर्षक लिखें"; return; }
      const due = document.getElementById("hw_due").value;
      const { error } = await sb.from("assignments").insert({
        teacher_id: me.id, title, class_id: +document.getElementById("hw_class").value,
        subject_id: document.getElementById("hw_subject").value ? +document.getElementById("hw_subject").value : null,
        instructions: document.getElementById("hw_ins").value.trim() || null,
        due_at: due ? new Date(due + "T23:59:00").toISOString() : null,
        max_marks: document.getElementById("hw_marks").value ? +document.getElementById("hw_marks").value : null,
        status: "published" });
      if (error) { err.textContent = error.message; return; }
      toast("Homework भेज दिया 📒"); renderHomework();
    };
    $app.querySelectorAll("[data-hwdel]").forEach(b => b.onclick = async () => {
      if (!confirm("यह homework और उसकी सारी submissions हट जाएँगी। पक्का?")) return;
      const { error } = await sb.from("assignments").delete().eq("id", +b.dataset.hwdel);
      if (error) return toast("Error: " + error.message);
      renderHomework();
    });
    $app.querySelectorAll("[data-hwopen]").forEach(b => b.onclick = async () => {
      hwOpenId = hwOpenId === +b.dataset.hwopen ? null : +b.dataset.hwopen;
      await renderHomework();
      if (hwOpenId) {
        const ids = [...new Set([...$app.querySelectorAll("[data-subname]")].map(el => el.dataset.subname))];
        if (ids.length) {
          const { data: names } = await sb.from("profiles").select("id,full_name").in("id", ids);
          $app.querySelectorAll("[data-subname]").forEach(el => el.textContent = (names || []).find(n => n.id === el.dataset.subname)?.full_name || "Student");
        }
      }
    });
    $app.querySelectorAll("[data-grade]").forEach(b => b.onclick = async () => {
      const sid = +b.dataset.grade;
      const { error } = await sb.from("submissions").update({
        marks: document.getElementById("gm-" + sid).value ? +document.getElementById("gm-" + sid).value : null,
        feedback: document.getElementById("gf-" + sid).value.trim() || null,
        status: "reviewed" }).eq("id", sid);
      if (error) return toast("Error: " + error.message);
      toast("अंक दे दिए 🏅"); renderHomework();
    });
  } else {
    $app.querySelectorAll("[data-hwsub]").forEach(b => b.onclick = () => { hwSubmitId = hwSubmitId === +b.dataset.hwsub ? null : +b.dataset.hwsub; renderHomework(); });
    const send = document.getElementById("sub_send");
    enhanceFilePicker(document.getElementById("sub_file"));
    if (send) send.onclick = async () => {
      const err = document.getElementById("sub_err"); err.textContent = "";
      const a = list.find(x => x.id === hwSubmitId);
      try {
        let file_path = mySub(a.id)?.file_path || null;
        const f0 = document.getElementById("sub_file").files[0];
        if (f0) {
          const f = await prepareUploadFile(f0);
          const ext = (f.name.split(".").pop() || "bin").toLowerCase();
          file_path = `${me.id}/hw-${a.id}-${Date.now()}.${ext}`;
          const { error: ue } = await sb.storage.from("avatars").upload(file_path, f, { upsert: true });
          if (ue) throw ue;
        }
        const { error } = await sb.from("submissions").upsert({
          assignment_id: a.id, student_id: me.id,
          body: document.getElementById("sub_body").value.trim() || null,
          file_path, status: "submitted", submitted_at: new Date().toISOString(),
        }, { onConflict: "assignment_id,student_id" });
        if (error) throw error;
        hwSubmitId = null; toast("Homework जमा हो गया ✅"); renderHomework();
      } catch (e) { err.textContent = e.message; }
    };
  }
  $app.querySelectorAll("[data-hwfile]").forEach(b => b.onclick = () => openStoredFile("avatars", b.dataset.hwfile));
}

/* ---------------- Attendance ---------------- */
let attClassId = null, attDate = null, attMarks = {};
async function renderAttendance() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const today = new Date().toISOString().slice(0, 10);
  if (!attDate) attDate = today;
  const clsName = (id) => (myClasses.find(c => c.id === id) || {}).name || "";

  if (isStaff()) {
    if (!attClassId && myClasses.length) attClassId = myClasses[0].id;
    const [{ data: enr }, { data: existing }] = await Promise.all([
      sb.from("enrollments").select("user_id").eq("class_id", attClassId),
      sb.from("attendance").select("*").eq("class_id", attClassId).eq("on_date", attDate),
    ]);
    const ids = (enr || []).map(e => e.user_id);
    const { data: studs } = ids.length ? await sb.from("profiles").select("id,full_name").in("id", ids) : { data: [] };
    (existing || []).forEach(r => attMarks[r.student_id] = r.status);
    $app.innerHTML = `
      <div class="card"><h3>✅ हाज़िरी लगाएँ</h3>
        <div class="row">
          <div><label>Class</label><select id="att_class">${myClasses.map(c => `<option value="${c.id}" ${c.id === attClassId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
          <div><label>तारीख़</label><input id="att_date" type="date" value="${attDate}"></div>
        </div>
        <p class="muted">हर student के सामने Present / Absent / Leave चुनें, फिर save करें।</p>
        ${(studs || []).map(s => `<div class="item"><div class="t" style="font-size:14px">${esc(s.full_name)}</div>
          <div style="display:flex; gap:5px">
            ${[["present", "P", "var(--ok)"], ["absent", "A", "var(--bad)"], ["leave", "L", "#b8860b"]].map(([v, l, col]) => `
              <button class="small ${attMarks[s.id] === v ? "" : "light"}" data-att="${s.id}:${v}" style="${attMarks[s.id] === v ? `background:${col}` : ""}">${l}</button>`).join("")}
          </div></div>`).join("") || `<p class="muted">इस class में कोई student नहीं है।</p>`}
        <button class="gold" id="att_save" style="width:100%; margin-top:10px">हाज़िरी Save करें</button>
      </div>`;
    document.getElementById("att_class").onchange = (e) => { attClassId = +e.target.value; attMarks = {}; renderAttendance(); };
    document.getElementById("att_date").onchange = (e) => { attDate = e.target.value; attMarks = {}; renderAttendance(); };
    $app.querySelectorAll("[data-att]").forEach(b => b.onclick = () => {
      const [sid, v] = b.dataset.att.split(":"); attMarks[sid] = v; renderAttendance();
    });
    document.getElementById("att_save").onclick = async () => {
      const rows = Object.entries(attMarks).map(([sid, st]) => ({ student_id: sid, class_id: attClassId, on_date: attDate, status: st, marked_by: me.id }));
      if (!rows.length) return toast("पहले हाज़िरी चुनें");
      const { error } = await sb.from("attendance").upsert(rows, { onConflict: "student_id,on_date" });
      if (error) return toast("Error: " + error.message);
      toast(`हाज़िरी save हो गई ✅ (${rows.length} students)`); attMarks = {}; renderAttendance();
    };
    return;
  }

  // Student / parent view
  const { data: recs } = await sb.from("attendance").select("*").order("on_date", { ascending: false }).limit(60);
  let nameOf = () => "";
  if (profile.role === "parent" && (recs || []).length) {
    const ids = [...new Set(recs.map(r => r.student_id))];
    const { data: kids } = await sb.from("profiles").select("id,full_name").in("id", ids);
    nameOf = (id) => (kids || []).find(k => k.id === id)?.full_name || "Student";
  }
  const mine = (recs || []);
  const total = mine.length, present = mine.filter(r => r.status === "present").length;
  const pct = total ? Math.round((present / total) * 100) : 0;
  $app.innerHTML = `
    <div class="card"><h3>✅ ${profile.role === "parent" ? "बच्चों की हाज़िरी" : "मेरी हाज़िरी"}</h3>
      <div class="stats">
        <div class="stat"><div class="si" style="background:#e2f4ec">🙋</div><div class="n">${present}</div><div class="l">Present दिन</div></div>
        <div class="stat"><div class="si" style="background:#e8f1fe">📅</div><div class="n">${total}</div><div class="l">कुल दिन</div></div>
        <div class="stat"><div class="si" style="background:#fdf3d7">📊</div><div class="n">${pct}%</div><div class="l">उपस्थिति</div></div>
      </div></div>
    <div class="card"><h3>ताज़ा हाज़िरी</h3>
      ${mine.map(r => `<div class="item"><div><div class="t" style="font-size:14px">${new Date(r.on_date + "T00:00:00").toLocaleDateString("hi-IN", { weekday: "short", day: "numeric", month: "short" })}</div>
        <div class="s">${esc(clsName(r.class_id))}${profile.role === "parent" ? " • " + esc(nameOf(r.student_id)) : ""}</div></div>
        <span class="pill ${r.status === "present" ? "green" : r.status === "absent" ? "red" : "gold"}">${r.status}</span></div>`).join("") || `<p class="muted">अभी कोई हाज़िरी दर्ज नहीं है।</p>`}
    </div>`;
}

/* ---------------- Timetable ---------------- */
let ttClassId = null;
const WEEKDAYS = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
async function renderTimetable() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  if (!ttClassId && myClasses.length) ttClassId = myClasses[0].id;
  const [{ data: entries }, { data: subjects }, { data: staffList }] = await Promise.all([
    sb.from("timetable_entries").select("*").eq("class_id", ttClassId).order("starts_at"),
    sb.from("subjects").select("*"),
    isStaff() ? sb.from("profiles").select("id,full_name,role").in("role", ["teacher", "admin"]) : Promise.resolve({ data: [] }),
  ]);
  const subName = (id) => (subjects || []).find(s => s.id === id)?.name || "—";
  const staffName = (id) => (staffList || []).find(s => s.id === id)?.full_name || "";
  const fmt = (t) => (t || "").slice(0, 5);
  $app.innerHTML = `
    <div class="card"><h3>🗓️ Timetable</h3>
      <div class="row">${myClasses.map(c => `<button class="${c.id === ttClassId ? "" : "light"}" data-ttcls="${c.id}">${esc(c.name)}</button>`).join("")}</div>
    </div>
    ${isStaff() ? `<div class="card"><h3>➕ Period जोड़ें</h3>
      <div class="row">
        <div><label>दिन</label><select id="tt_day">${WEEKDAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select></div>
        <div><label>Subject</label><select id="tt_subject">${(subjects || []).filter(s => s.class_id === ttClassId).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("") || `<option value="">— subject नहीं है —</option>`}</select></div>
      </div>
      <div class="row">
        <div><label>शुरू</label><input id="tt_from" type="time" value="09:00"></div>
        <div><label>ख़त्म</label><input id="tt_to" type="time" value="09:45"></div>
        <div><label>Teacher</label><select id="tt_teacher"><option value="">— कोई नहीं —</option>${(staffList || []).map(s => `<option value="${s.id}">${esc(s.full_name)}</option>`).join("")}</select></div>
      </div>
      <div class="error" id="tt_err"></div>
      <button class="gold" id="tt_add" style="width:100%">Period जोड़ें</button></div>` : ""}
    ${WEEKDAYS.map((d, i) => {
      const dayEntries = (entries || []).filter(e => e.weekday === i);
      if (!dayEntries.length) return "";
      return `<div class="card"><h3>${d}</h3>
        ${dayEntries.map(e => `<div class="item"><div><div class="t" style="font-size:14px">${esc(subName(e.subject_id))}</div>
          <div class="s">🕐 ${fmt(e.starts_at)} – ${fmt(e.ends_at)}${e.teacher_id && staffName(e.teacher_id) ? " • 👨‍🏫 " + esc(staffName(e.teacher_id)) : ""}</div></div>
          ${isStaff() ? `<button class="danger small" data-ttdel="${e.id}">✕</button>` : ""}</div>`).join("")}
      </div>`;
    }).join("") || `<div class="card"><p class="muted">इस class का timetable अभी नहीं बना है।</p></div>`}`;

  $app.querySelectorAll("[data-ttcls]").forEach(b => b.onclick = () => { ttClassId = +b.dataset.ttcls; renderTimetable(); });
  if (isStaff()) {
    document.getElementById("tt_add").onclick = async () => {
      const err = document.getElementById("tt_err"); err.textContent = "";
      const from = document.getElementById("tt_from").value, to = document.getElementById("tt_to").value;
      if (!from || !to) { err.textContent = "समय चुनें"; return; }
      const { error } = await sb.from("timetable_entries").insert({
        class_id: ttClassId, weekday: +document.getElementById("tt_day").value,
        subject_id: document.getElementById("tt_subject").value ? +document.getElementById("tt_subject").value : null,
        teacher_id: document.getElementById("tt_teacher").value || null,
        starts_at: from, ends_at: to });
      if (error) { err.textContent = error.message; return; }
      toast("Period जुड़ गया 🗓️"); renderTimetable();
    };
    $app.querySelectorAll("[data-ttdel]").forEach(b => b.onclick = async () => {
      const { error } = await sb.from("timetable_entries").delete().eq("id", +b.dataset.ttdel);
      if (error) return toast("Error: " + error.message);
      renderTimetable();
    });
  }
}
