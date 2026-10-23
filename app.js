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
let pendingRoleHint = null; // role tab chosen on the login screen
let myClasses = [];   // classes visible to me
let tab = "home";
let lastTab = null, navFromPop = false, curView = "tab"; // back-button (history) support
let revState = null; // result-review paging state
const REV_PAGE = 20;

window.addEventListener("popstate", (e) => {
  if (!profile) return;
  if (run) {
    if (confirm("A test is in progress — leave it and go to the Tests list? Your attempt will stay saved, and you can resume later with 'Continue'.")) {
      clearInterval(run.timer); run = null; tab = "tests"; navFromPop = true; renderShell();
    } else { try { history.pushState({ view: "run" }, ""); } catch (err) {} }
    return;
  }
  if (curView === "result" || curView === "preview") { tab = "tests"; navFromPop = true; renderShell(); return; }
  tab = (e.state && e.state.tab) || "home"; navFromPop = true; renderShell();
});

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(msg, ms = 2600) {
  $toast.textContent = msg; $toast.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => $toast.classList.add("hidden"), ms);
}
const isStaff = () => profile && (profile.role === "admin" || profile.role === "teacher");

/* ---------------- CSV export (v45 — client-side, only data already loaded on screen) ---------------- */
function downloadCSV(filename, headers, rows) {
  const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = "\uFEFF" + [headers, ...rows].map(r => r.map(q).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

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
  if (out !== file) toast(`📷 Photo compressed: ${fmtKB(file.size)} → ${fmtKB(out.size)}`);
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
    <div class="fp-name muted">No file chosen</div>`;
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

/* ---------------- Brand logo (v49 — admin-changeable) ----------------
   The admin can upload a new coaching logo (Manage → Coaching Logo). It
   lives in the PUBLIC images bucket at the fixed path branding/logo.png.
   Every logo <img class="brand-logo"> tries that URL first, with a ?v=
   cache-buster taken from localStorage "logo_v" (bumped on each admin
   upload), and falls back to the bundled icon.svg if no custom logo has
   been uploaded yet — so existing installs keep the current logo until
   an admin changes it. The PWA/manifest icon always stays bundled. */
const BRAND_LOGO_URL = `${SUPABASE_URL}/storage/v1/object/public/images/branding/logo.png`;
const BUNDLED_LOGO = "icon.svg?v=31";
const brandLogoURL = () => { let v = ""; try { v = localStorage.getItem("logo_v") || ""; } catch (_) {} return BRAND_LOGO_URL + "?v=" + (v || "1"); };
function applyBrandLogo(root = document) {
  root.querySelectorAll("img.brand-logo").forEach(img => {
    const url = brandLogoURL();
    img.onerror = () => { img.onerror = null; if (img.getAttribute("src") !== BUNDLED_LOGO) img.src = BUNDLED_LOGO; if ("zoom" in img.dataset) img.dataset.zoom = BUNDLED_LOGO; };
    if (img.getAttribute("src") !== url) img.src = url;
    if ("zoom" in img.dataset) img.dataset.zoom = url;
  });
}

/* ---------------- Own profile photo (v49) ----------------
   Shared by the student Profile page and the More page (where staff
   land). The picked file is auto-compressed in the browser, uploaded
   to the avatars bucket under the user's own folder (same pattern as
   the staff user-edit flow) and saved to profiles.photo_path. */
async function uploadOwnPhoto(fileInput) {
  const f = fileInput && fileInput.files && fileInput.files[0];
  if (!f) { toast("Take or choose a photo first"); return false; }
  const file = await prepareUploadFile(f);
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${me.id}/${Date.now()}.${ext}`;
  const { error: ue } = await sb.storage.from("avatars").upload(path, file, { upsert: true });
  if (ue) throw ue;
  const { error } = await sb.from("profiles").update({ photo_path: path }).eq("id", me.id);
  if (error) throw error;
  profile.photo_path = path;
  return true;
}

/* ---------------- Photo viewer (click → बड़ा) ---------------- */
function viewPhoto(url) {
  if (!url) return;
  closePhoto();
  const d = document.createElement("div");
  d.className = "lightbox"; d.id = "photoLightbox";
  d.innerHTML = `<button class="lb-x" aria-label="Close">✕</button><img src="${url}" alt="photo">`;
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
  if (!pushSupported()) { toast("Phone notifications don't work in this browser — open in Chrome"); return; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Notification permission not granted — allow it in browser settings"); return; }
  await syncPush();
  toast("📲 Phone notifications are on!");
  if (tab === "notif") renderNotifs();
}
/* ---------------- Splash (Phase 1, design photo 1) ---------------- */
const hideSplash = () => { const s = document.getElementById("splash"); if (!s || s.classList.contains("gone")) return; s.classList.add("gone"); setTimeout(() => s.remove(), 550); };
window.addEventListener("load", () => setTimeout(hideSplash, 1200));
setTimeout(hideSplash, 3400);

const roleName = (r) => ({admin:"Admin", teacher:"Teacher", student:"Student", parent:"Parent"}[r] || r);

/* ---------------- Auth screens ---------------- */
let authRole = "student";
function renderAuth(mode = "login") {
  document.body.classList.add("auth-mode");
  $tabbar.classList.add("hidden"); $logout.classList.add("hidden"); if ($bell) $bell.classList.add("hidden");
  const roleTabs = `
    <div class="role-tabs" id="roleTabs">
      ${[["student", "Student"], ["teacher", "Teacher"], ["admin", "Admin"]].map(([r, l]) => `<button type="button" class="rtab ${authRole === r ? "on" : ""}" data-role="${r}">${l}</button>`).join("")}
    </div>`;
  $app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-brand">
        <img src="icon.svg?v=31" alt="Target Academy logo" class="auth-logo brand-logo" data-zoom="icon.svg?v=31">
        <div class="ab-name">TARGET ACADEMY</div>
        <div class="ab-sub">COACHING CENTRE</div>
        <div class="ab-by">By Ashutosh Kumar</div>
      </div>
      <div class="card auth-card">
        <h3 class="auth-h">${mode === "login" ? "लॉगिन करें" : "नया खाता बनाएँ"}</h3>
        ${roleTabs}
        ${mode === "signup" ? `<label>पूरा नाम</label><input id="f_name" autocomplete="name" placeholder="जैसे — रवि कुमार">` : ""}
        <label>ईमेल</label>
        <input id="f_email" type="email" autocomplete="email" placeholder="you@example.com">
        <label>पासवर्ड</label>
        <div class="pw-wrap"><input id="f_pass" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" placeholder="••••••••"><button type="button" class="pw-eye" id="pwEye" aria-label="Show password">👁️</button></div>
        ${mode === "login" ? `<div class="auth-row"><label class="remember"><input type="checkbox" id="f_rem" checked> मुझे याद रखें</label><button type="button" class="link" id="authForgot">Forgot Password?</button></div>` : ""}
        <div class="error" id="authErr"></div>
        <button class="gold" id="authGo" style="width:100%">${mode === "login" ? "Login" : "Create Account"}</button>
        <div class="auth-or"><span>या</span></div>
        <button type="button" class="btn-outline" id="authSwap" style="width:100%">${mode === "login" ? "Create Account" : "Already have an account? Login"}</button>
        <p class="muted" style="margin-top:12px">नया खाता छात्र के रूप में बनता है। शिक्षक/एडमिन की भूमिका Academy द्वारा दी जाती है।</p>
      </div>
    </div>`;
  applyBrandLogo();
  $app.querySelectorAll(".rtab").forEach(b => b.onclick = () => { authRole = b.dataset.role; renderAuth(mode); });
  document.getElementById("pwEye").onclick = () => { const p = document.getElementById("f_pass"); p.type = p.type === "password" ? "text" : "password"; };
  document.getElementById("authSwap").onclick = () => renderAuth(mode === "login" ? "signup" : "login");
  const forgot = document.getElementById("authForgot");
  if (forgot) forgot.onclick = async () => {
    const email = document.getElementById("f_email").value.trim();
    const err = document.getElementById("authErr");
    if (!email) { err.textContent = "पहले अपना ईमेल लिखें"; return; }
    err.textContent = "";
    const { error } = await sb.auth.resetPasswordForEmail(email);
    if (error) { err.textContent = error.message; return; }
    toast("📧 पासवर्ड बदलने का लिंक आपके ईमेल पर भेज दिया गया है");
  };
  document.getElementById("authGo").onclick = async () => {
    const email = document.getElementById("f_email").value.trim();
    const pass = document.getElementById("f_pass").value;
    const err = document.getElementById("authErr");
    err.textContent = "";
    try {
      if (mode === "signup") {
        const name = document.getElementById("f_name").value.trim();
        if (!name) throw new Error("Please enter your name");
        const { error } = await sb.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
        if (error) throw error;
        toast("Account created! Now log in (if email confirmation is asked, check your inbox)");
        renderAuth("login");
      } else {
        pendingRoleHint = authRole;
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error) throw error;
        await boot();
      }
    } catch (e) { pendingRoleHint = null; err.textContent = e.message; }
  };
}

/* ---------------- Boot / session ---------------- */
async function boot() {
  applyBrandLogo();
  const { data } = await sb.auth.getUser();
  me = data?.user || null;
  if (!me) { renderAuth("login"); return; }
  const { data: prof, error } = await sb.from("profiles").select("*").eq("id", me.id).single();
  if (error || !prof) { $app.innerHTML = `<div class="card"><h3>Profile not found</h3><p>Please contact the Academy.</p></div>`; return; }
  profile = prof;
  if (pendingRoleHint) {
    if (profile.role !== pendingRoleHint) toast("यह खाता " + ({ student: "छात्र", teacher: "शिक्षक", admin: "एडमिन", parent: "अभिभावक" }[profile.role] || profile.role) + " के रूप में है — उसी से लॉगिन हो गया है");
    pendingRoleHint = null;
  }
  const { data: cls } = await sb.from("classes").select("*").order("sort_order");
  myClasses = cls || [];
  if (!isStaff()) {
    // Students/parents: ONLY the classes they are enrolled in exist for them
    // (class-specific tests, notes, timetable, live classes, homework…).
    const { data: enr } = await sb.from("enrollments").select("class_id").eq("user_id", me.id);
    const mine = new Set((enr || []).map(e => e.class_id));
    myClasses = myClasses.filter(c => mine.has(c.id));
  }
  $logout.classList.remove("hidden");
  if ($bell) { $bell.classList.remove("hidden"); $bell.onclick = () => { tab = "notif"; renderShell(); }; refreshBell(); }
  syncPush();
  renderShell();
}
$logout.onclick = async () => { await sb.auth.signOut(); location.reload(); };

/* ---------------- Shell + tabs ---------------- */
const TABHEAD = {
  study: ["📚", "स्टडी मटेरियल • Study Material", "नोट्स, PDF और वीडियो — आपकी कक्षाओं के लिए"],
  tests: ["📝", "टेस्ट • Tests", "आपकी कक्षाओं के अभ्यास टेस्ट और परीक्षाएँ"],
  fees: ["💰", "फ़ीस • Fees", "फ़ीस रिकॉर्ड और भुगतान"],
  doubts: ["❓", "Doubts • सवाल-जवाब", "सवाल पूछें — शिक्षक और AI जवाब देंगे"],
  tutor: ["🤖", "AI Tutor • AI शिक्षक", "कुछ भी सीखें, कदम-दर-कदम"],
  live: ["📺", "Live Class • लाइव क्लास", "आने वाली लाइव कक्षाएँ"],
  top: ["🏆", "Leaderboard • मेरिट सूची", "Academy के टॉप छात्र"],
  homework: ["📒", "होमवर्क • Homework", "शिक्षकों के दिए हुए काम"],
  attendance: ["✅", "उपस्थिति • Attendance", "उपस्थिति रिकॉर्ड"],
  timetable: ["🗓️", "समय-सारणी • Timetable", "कक्षा की समय-सारणी"],
  notif: ["🔔", "सूचनाएँ • Notifications", "सभी ताज़ा जानकारी"],
  manage: ["🛠️", "प्रबंध • Manage", "कक्षाएँ, विषय, प्रश्न, टेस्ट और मटेरियल"],
  users: ["👥", "उपयोगकर्ता • Users", "छात्र, शिक्षक और कक्षा नामांकन"],
  studio: ["🎬", "Video Studio • वीडियो स्टूडियो", "YouTube पाठ से नोट्स और MCQ बनाएँ"],
};
function setPageHead() {
  const ph = document.getElementById("pagehead");
  if (!ph) return;
  const h = TABHEAD[tab];
  if (h) {
    ph.className = "pagehead";
    ph.innerHTML = `<div class="ph-ic">${h[0]}</div><div style="min-width:0"><div class="ph-t">${h[1]}</div><div class="ph-s">${h[2]}</div></div>`;
  } else ph.className = "hidden";
}
function hidePageHead() {
  const ph = document.getElementById("pagehead");
  if (ph) ph.className = "hidden";
}
function renderShell() {
  if (lastTab === null) { try { history.replaceState({ tab }, ""); } catch (e) {} }
  else if (tab !== lastTab && !navFromPop) { try { history.pushState({ tab }, ""); } catch (e) {} }
  lastTab = tab; navFromPop = false; curView = "tab";
  const tabs = [
    { id: "home", ic: "🏠", label: "Dashboard" },
    { id: "study", ic: "📚", label: "Study" },
    { id: "tests", ic: "📝", label: "Test" },
    { id: "fees", ic: "💰", label: "Fees" },
    ...(isStaff() ? [{ id: "manage", ic: "🛠️", label: "Manage" }] : []),
    ...(profile.role === "admin" ? [{ id: "users", ic: "👥", label: "Users" }] : []),
    { id: "more", ic: "☰", label: "More" },
  ];
  document.body.classList.remove("auth-mode");
  const staffBar = [
    ["home", "🏠", "Dashboard"],
    ...(profile.role === "admin" ? [["users", "👥", "Students"]] : []),
    ["manage", "🛠️", "Study"],
    ["fees", "💰", "Fees"],
    ["more", "☰", "More"],
  ];
  const staffBarIds = staffBar.map(([id]) => id);
  const navHTML = !isStaff()
    ? [["home", "🏠", "Home"], ["study", "📚", "Study"], ["tests", "📝", "Test"], ["profile", "👤", "Profile"]].map(([id, ic, label]) => `<button data-tab="${id}" class="${tab === id ? "active" : ""}"><span class="ic">${ic}</span>${label}</button>`).join("")
    : staffBar.map(([id, ic, label]) => `<button data-tab="${id}" class="${tab === id || (id === "more" && !staffBarIds.includes(tab)) ? "active" : ""}"><span class="ic">${ic}</span>${label}</button>`).join("");
  const extraTabs = [
    { id: "doubts", ic: "❓", label: "Doubts" },
    { id: "tutor", ic: "🤖", label: "AI Tutor" },
    { id: "live", ic: "📺", label: "Live Class" },
    { id: "top", ic: "🏆", label: "Leaderboard" },
    { id: "homework", ic: "📒", label: "Homework" },
    { id: "attendance", ic: "✅", label: "Attendance" },
    { id: "timetable", ic: "🗓️", label: "Timetable" },
    { id: "studio", ic: "🎬", label: "Video Studio" },
  ];
  const byId = {};
  [...tabs, ...extraTabs].forEach(t => { byId[t.id] = t; });
  const sideGroups = [
    ["मुख्य • Main", ["home", "study", "tests", "fees"]],
    ["पढ़ाई • Learn", ["homework", "live", "timetable", ...(isStaff() ? [] : ["studio"])]],
    ["सहायता और प्रगति • Help & Progress", ["doubts", "tutor", "top", "attendance"]],
    ...(isStaff() ? [["स्टाफ़ • Staff", ["manage", "studio", ...(profile.role === "admin" ? ["users"] : [])]]] : []),
    ["खाता • Account", ["more"]],
  ];
  const sideHTML = sideGroups.map(([label, ids]) => {
    const btns = ids.map(id => byId[id]).filter(Boolean).map(t => `<button data-tab="${t.id}" class="${tab === t.id ? "active" : ""}"><span class="ic">${t.ic}</span>${t.label}</button>`).join("");
    return btns ? `<div class="side-group">${label}</div>${btns}` : "";
  }).join("");
  $tabbar.innerHTML = navHTML;
  $tabbar.classList.remove("hidden");
  const $sidenav = document.getElementById("sidenav");
  if ($sidenav) {
    $sidenav.innerHTML = sideHTML;
    $sidenav.querySelectorAll("button").forEach(b => b.onclick = () => { tab = b.dataset.tab; renderShell(); });
  }
  $tabbar.querySelectorAll("button").forEach(b => b.onclick = () => { tab = b.dataset.tab; renderShell(); });
  setPageHead();
  ({ home: renderHome, study: renderStudy, tests: renderTests, fees: isStaff() ? renderFeesPage : renderFeesStudent, doubts: renderDoubts, tutor: renderTutor, live: renderLive, top: renderTop, notif: renderNotifs, homework: renderHomework, attendance: renderAttendance, timetable: renderTimetable, manage: renderManage, users: renderUsers, studio: renderStudio, more: renderMore, profile: renderProfile }[tab] || renderHome)();
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
function greetHTML(sub, photoUrl) {
  return `<div class="greet">
    <div class="avatar">${photoUrl ? `<img src="${photoUrl}" alt="">` : esc((profile.full_name || "T").trim()[0].toUpperCase())}</div>
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
  $app.innerHTML = `<div class="loading">Loading…</div>`;
  if (!isStaff()) {
    const [{ data: enr }, { data: subjects }, { data: chapters }, { data: notes }, { data: mats }, { data: prog }, { data: attempts }, { data: anns }, { data: lives }, { data: tt }, { data: att }, { data: pubTests }, { data: assigns }, { data: subs }, { data: feeRecs }] = await Promise.all([
      sb.from("enrollments").select("class_id").eq("user_id", me.id),
      sb.from("subjects").select("*").order("sort_order"),
      sb.from("chapters").select("*").order("sort_order"),
      sb.from("notes").select("id,class_id,subject_id").eq("status", "published"),
      sb.from("materials").select("id,class_id,subject_id").eq("status", "published"),
      sb.from("content_progress").select("*").eq("user_id", me.id).eq("completed", true),
      sb.from("test_attempts").select("*").eq("student_id", me.id).neq("status", "in_progress").order("submitted_at", { ascending: false }),
      sb.from("announcements").select("*").order("created_at", { ascending: false }).limit(4),
      sb.from("live_classes").select("*").gte("starts_at", new Date(Date.now() - 2 * 3600 * 1000).toISOString()).order("starts_at", { ascending: true }).limit(10),
      sb.from("timetable_entries").select("*"),
      sb.from("attendance").select("*").eq("student_id", me.id).order("on_date", { ascending: false }).limit(400),
      sb.from("tests").select("*").eq("status", "published"),
      sb.from("assignments").select("*"),
      sb.from("submissions").select("assignment_id,student_id").eq("student_id", me.id),
      sb.from("fee_records").select("*"),
    ]);
    const enrolledIds = (enr || []).map(e => e.class_id);
    let greetPhoto = null;
    if (profile.photo_path) {
      const { data: sg } = await sb.storage.from("avatars").createSignedUrl(profile.photo_path, 3600);
      greetPhoto = sg?.signedUrl || null;
    }
    const myLives = (lives || []).filter(l => enrolledIds.includes(l.class_id)).slice(0, 3);
    const clsNames = myClasses.map(c => c.name).join(", ");
    const testById = {}; (pubTests || []).forEach(t => { testById[t.id] = t; });
    const subById = {}; (subjects || []).forEach(s => { subById[s.id] = s; });
    const todayWd = new Date().getDay();
    const todayTT = (tt || []).filter(e => enrolledIds.includes(e.class_id) && e.weekday === todayWd)
      .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    const attTotal = (att || []).length;
    const attPresent = (att || []).filter(r => r.status === "present").length;
    const attPct = attTotal ? Math.round((attPresent / attTotal) * 100) : null;
    const attemptedIds = new Set((attempts || []).map(a => a.test_id));
    const upcoming = (pubTests || []).filter(t => enrolledIds.includes(t.class_id) && !attemptedIds.has(t.id))
      .sort((a, b) => (a.starts_at ? new Date(a.starts_at).getTime() : Infinity) - (b.starts_at ? new Date(b.starts_at).getTime() : Infinity));
    const nextTest = upcoming[0] || null;
    const feeDue = (feeRecs || []).reduce((s, r) => s + Math.max(0, +r.amount - +r.paid_amount), 0);
    const mySubIds = new Set((subs || []).map(s => s.assignment_id));
    const hwPending = (assigns || []).filter(a => enrolledIds.includes(a.class_id) && !mySubIds.has(a.id)).length;
    const recent = (attempts || []).slice(0, 3);
    const pillFor = (p) => p >= 75 ? `<span class="pill green">बहुत अच्छा</span>` : p >= 50 ? `<span class="pill green">अच्छा</span>` : p >= 33 ? `<span class="pill gold">ठीक है</span>` : `<span class="pill red">अभ्यास करें</span>`;

    $app.innerHTML = `
      <div class="dash-head" id="dashHead" role="button">
        <div class="avatar">${greetPhoto ? `<img src="${greetPhoto}" alt="">` : esc((profile.full_name || "T").trim()[0].toUpperCase())}</div>
        <div style="flex:1; min-width:0">
          <div class="dh-name">${esc(profile.full_name)}</div>
          <div class="dh-sub">${clsNames ? esc(clsNames) : "Target Academy"} • छात्र</div>
        </div>
        <span class="dh-chev">›</span>
      </div>
      <div class="motto"><span class="mo-ic">🔔</span><span>मेहनत आज की पहचान है, कल यही सफलता बनेगी।</span></div>
      <div class="stile-grid">
        <div class="stile" data-go="timetable"><span class="si2" style="background:#e8f1fe">📅</span><div class="sl">आज की क्लास</div><div class="sv">${todayTT.length ? todayTT.length + " क्लास" : "कोई नहीं"}</div><div class="ssub">${todayTT.length ? esc(subById[todayTT[0].subject_id]?.name || "क्लास") + " • " + String(todayTT[0].starts_at || "").slice(0, 5) : "आज कोई क्लास नहीं है"}</div></div>
        <div class="stile" data-go="tests"><span class="si2" style="background:#e2f4ec">📝</span><div class="sl">अगली परीक्षा</div><div class="sv">${nextTest ? (nextTest.starts_at ? new Date(nextTest.starts_at).toLocaleDateString("hi-IN", { day: "numeric", month: "short" }) : "तैयार है") : "—"}</div><div class="ssub">${nextTest ? esc(nextTest.title) : "कोई आगामी टेस्ट नहीं"}</div></div>
        <div class="stile" data-go="attendance"><span class="si2" style="background:#e6f7f0">✅</span><div class="sl">उपस्थिति</div><div class="sv">${attPct === null ? "—" : attPct + "%"}</div><div class="ssub">${attTotal ? attPresent + "/" + attTotal + " दिन उपस्थित" : "अभी रिकॉर्ड नहीं"}</div></div>
        <div class="stile" data-go="fees"><span class="si2" style="background:#fdf3d7">₹</span><div class="sl">फ़ीस स्थिति</div><div class="sv">${feeDue > 0 ? "₹" + feeDue.toLocaleString("en-IN") : "₹0"}</div><div class="ssub" style="color:${feeDue > 0 ? "var(--bad)" : "var(--ok)"}; font-weight:800">${feeDue > 0 ? "बकाया है" : "कोई बकाया नहीं 🎉"}</div></div>
      </div>
      <div class="card"><h3>हाल के परिणाम</h3>
        ${recent.length ? recent.map(a => { const t = testById[a.test_id]; return `<div class="frow"><div class="fic" style="background:${a.passed ? "#e2f4ec" : "#fdecea"}">${a.passed ? "🏆" : "📝"}</div>
          <div style="flex:1; min-width:0"><div class="ft">${esc(t?.title || "टेस्ट")}</div><div class="fs">${t?.subject_id && subById[t.subject_id] ? esc(subById[t.subject_id].name) + " • " : ""}${new Date(a.submitted_at).toLocaleDateString("hi-IN", { day: "numeric", month: "short" })}</div></div>
          <div style="text-align:right; flex:0 0 auto"><div style="font-weight:900; color:var(--navy)">${a.score}/${a.max_score}</div>${pillFor(+a.percent || 0)}</div></div>`; }).join("") : `<p class="muted" style="margin:0">अभी कोई टेस्ट नहीं दिया है — पहला टेस्ट देकर शुरुआत करें।</p>`}
        <button data-go="tests" style="width:100%; margin-top:12px">View All ›</button>
      </div>
      ${myLives.length ? `<div class="card"><h3>📺 आने वाली Live Classes</h3>
        ${myLives.map(l => { const isLive = new Date(l.starts_at).getTime() <= Date.now(); return `<div class="frow"><div class="fic" style="background:#fdecea">📺</div>
          <div style="flex:1"><div class="ft">${esc(l.title)}</div><div class="fs">${esc((myClasses.find(c => c.id === l.class_id) || {}).name || "")} • 🕐 ${new Date(l.starts_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</div></div>
          ${isLive ? `<button class="gold small" data-join="${esc(l.meet_link)}">▶ Join</button>` : `<span class="pill gold">जल्द आ रही है</span>`}</div>`; }).join("")}
      </div>` : ""}
      <div class="card"><h3>अपडेट</h3>
        <div class="hubrow" data-nav="homework"><span class="hic" style="background:#e2f4ec">📒</span><span class="hub-tx"><span class="hub-t">होमवर्क</span><span class="hub-d">${hwPending ? hwPending + " होमवर्क करना बाकी है" : "सारा होमवर्क पूरा है 🎉"}</span></span>${hwPending ? `<span class="pill gold">${hwPending} बाकी</span>` : ""}<span class="arr">›</span></div>
        ${(anns || []).slice(0, 2).map(a => `<div class="hubrow" data-nav="notif"><span class="hic" style="background:#fdf3d7">📢</span><span class="hub-tx"><span class="hub-t">${esc(a.title)}</span><span class="hub-d">${new Date(a.created_at).toLocaleDateString("hi-IN", { day: "numeric", month: "short" })}${a.body ? " • " + esc(a.body) : ""}</span></span><span class="pill ${annCatMeta[annCatOf(a)].pill}">${annCatOf(a)}</span><span class="arr">›</span></div>`).join("")}
        ${!hwPending && !(anns || []).length ? `<p class="muted" style="margin:4px 0 0">कोई नया अपडेट नहीं है।</p>` : ""}
      </div>`;
    wireQA();
    document.getElementById("dashHead").onclick = () => { tab = "profile"; renderShell(); };
    $app.querySelectorAll("[data-nav]").forEach(el => el.onclick = () => { tab = el.dataset.nav; renderShell(); });
    $app.querySelectorAll("[data-join]").forEach(b => b.onclick = () => window.open(b.dataset.join, "_blank"));
    return;
  }

  // ---- Staff / Admin dashboard ----
  const todayISO = new Date().toISOString().slice(0, 10);
  const [{ count: sc }, { count: qc }, { count: tc }, { data: recentUsers }, { data: recentAttempts }, { data: anns }, { data: profs }, { count: dc }, { data: sLives }, { data: feeRows }, { data: attToday }, { data: ttAll }, { data: subjAll }, { data: feeAll }, { data: recentFees }] = await Promise.all([
    sb.from("profiles").select("*", { count: "exact", head: true }).eq("role", "student"),
    sb.from("questions").select("*", { count: "exact", head: true }),
    sb.from("tests").select("*", { count: "exact", head: true }),
    sb.from("profiles").select("*").order("created_at", { ascending: false }).limit(4),
    sb.from("test_attempts").select("*").neq("status", "in_progress").order("submitted_at", { ascending: false }).limit(4),
    sb.from("announcements").select("*").order("created_at", { ascending: false }).limit(3),
    sb.from("profiles").select("id,full_name"),
    sb.from("doubts").select("*", { count: "exact", head: true }).eq("status", "open"),
    sb.from("live_classes").select("*").gte("starts_at", new Date(Date.now() - 2 * 3600 * 1000).toISOString()).order("starts_at", { ascending: true }).limit(10),
    sb.from("fee_records").select("paid_amount").gte("created_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
    sb.from("attendance").select("status").eq("on_date", todayISO),
    sb.from("timetable_entries").select("*"),
    sb.from("subjects").select("id,name,class_id"),
    sb.from("fee_records").select("amount,paid_amount"),
    sb.from("fee_records").select("*").order("created_at", { ascending: false }).limit(3),
  ]);
  const nameOf = (id) => (profs || []).find(p => p.id === id)?.full_name || "Student";
  let greetPhoto = null;
  if (profile.photo_path) {
    const { data: sg } = await sb.storage.from("avatars").createSignedUrl(profile.photo_path, 3600);
    greetPhoto = sg?.signedUrl || null;
  }
  const monthFees = (feeRows || []).reduce((s, r) => s + (+r.paid_amount || 0), 0);
  const totalDueAll = (feeAll || []).reduce((s, r) => s + Math.max(0, +r.amount - +r.paid_amount), 0);
  const attMarked = (attToday || []).length;
  const attPresentN = (attToday || []).filter(r => r.status === "present").length;
  const attPctToday = attMarked ? Math.round((attPresentN / attMarked) * 100) : null;
  const todayWdS = new Date().getDay();
  const clsNameS = (id) => (myClasses.find(c => c.id === id) || {}).name || "";
  const subNameS = (id) => (subjAll || []).find(s => s.id === id)?.name || "क्लास";
  const todayClasses = (ttAll || []).filter(e => e.weekday === todayWdS)
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const todayStr = new Date().toLocaleDateString("hi-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $app.innerHTML = `
    <div class="dash-head">
      <div class="avatar">${greetPhoto ? `<img src="${greetPhoto}" alt="">` : esc((profile.full_name || "T").trim()[0].toUpperCase())}</div>
      <div style="flex:1; min-width:0">
        <div class="dh-name">नमस्ते, ${esc(profile.full_name)} 🙏</div>
        <div class="dh-sub">Target Academy • ${todayStr}</div>
      </div>
    </div>
    <div class="searchbar"><span>🔍</span><input id="homeQ" placeholder="नोट्स, वीडियो, PDF खोजें…"><button class="small gold" id="homeGo">Search</button></div>
    <div class="stile-grid">
      <div class="stile" ${profile.role === "admin" ? `data-go="users"` : ""}><span class="si2" style="background:#e8f1fe">👥</span><div class="sl">कुल छात्र</div><div class="sv">${sc ?? 0}</div><div class="ssub">Academy में कुल छात्र</div></div>
      <div class="stile" data-go="attendance"><span class="si2" style="background:#e6f7f0">✅</span><div class="sl">आज की उपस्थिति</div><div class="sv">${attMarked ? attPresentN + "/" + attMarked : "—"}</div><div class="ssub">${attMarked ? attPctToday + "% छात्र उपस्थित" : "आज अभी दर्ज नहीं हुई"}</div></div>
      <div class="stile" data-go="fees"><span class="si2" style="background:#e2f4ec">💰</span><div class="sl">फ़ीस — इस माह वसूली</div><div class="sv">₹${monthFees.toLocaleString("en-IN")}</div><div class="ssub" style="color:${totalDueAll > 0 ? "var(--bad)" : "var(--ok)"}; font-weight:800">कुल बकाया ₹${totalDueAll.toLocaleString("en-IN")}</div></div>
      <div class="stile" data-go="doubts"><span class="si2" style="background:#fdecea">❓</span><div class="sl">बिना-जवाब Doubts</div><div class="sv">${dc ?? 0}</div><div class="ssub">${dc ? "जवाब का इंतज़ार है" : "सभी सवालों के जवाब मिल गए 🎉"}</div></div>
    </div>
    <div class="card"><h3>⚡ त्वरित कार्य • Quick Actions</h3>
      <div class="qa-grid3">
        ${profile.role === "admin" ? `<div class="qa" data-go="users"><div class="qi" style="background:#fdf3d7">👥</div><div class="ql">Add Student</div></div>` : ""}
        <div class="qa" data-go="attendance"><div class="qi" style="background:#e6f7f0">✅</div><div class="ql">Mark Attendance</div></div>
        <div class="qa" data-go="fees"><div class="qi" style="background:#e2f4ec">💰</div><div class="ql">Fees</div></div>
        <div class="qa" data-go="tests"><div class="qi" style="background:#fde8e8">📝</div><div class="ql">Create Test</div></div>
        <div class="qa" data-go="study"><div class="qi" style="background:#e2f4ec">📚</div><div class="ql">Add Notes</div></div>
        <div class="qa" data-go="manage"><div class="qi" style="background:#e8effe">📢</div><div class="ql">Send Notice</div></div>
      </div>
    </div>
    <div class="card"><h3>🗓️ आज की कक्षाएँ</h3>
      ${todayClasses.length ? todayClasses.map(e => `<div class="frow"><div class="fic" style="background:#e8f1fe">🕐</div>
        <div style="flex:1; min-width:0"><div class="ft">${esc(subNameS(e.subject_id))}</div><div class="fs">${esc(clsNameS(e.class_id))} • ${String(e.starts_at || "").slice(0, 5)} – ${String(e.ends_at || "").slice(0, 5)}</div></div>
        <button class="light small" data-go="timetable">Timetable</button></div>`).join("") : `<p class="muted" style="margin:0">आज कोई क्लास समय-सारणी में नहीं है।</p>`}
    </div>
    <div class="card"><h3>📊 Academy एक नज़र में</h3>
      <div class="stats">
        <div class="stat"><div class="si" style="background:#e8f1fe">👥</div><div class="n">${sc ?? 0}</div><div class="l">छात्र</div></div>
        <div class="stat"><div class="si" style="background:#fdf3d7">❓</div><div class="n">${qc ?? 0}</div><div class="l">प्रश्न बैंक</div></div>
        <div class="stat"><div class="si" style="background:#fde8e8">📝</div><div class="n">${tc ?? 0}</div><div class="l">टेस्ट</div></div>
      </div></div>
    <div class="card"><h3>📌 आज का काम</h3>
      <div class="frow" data-go="doubts" style="cursor:pointer"><div class="fic" style="background:#fdecea">❓</div>
        <div style="flex:1"><div class="ft">जवाब बाकी Doubts</div><div class="fs">छात्रों के सवाल जिन्हें आपका जवाब चाहिए</div></div>
        <span class="pill ${dc ? "red" : "green"}">${dc ?? 0}</span></div>
      <div class="frow" data-go="fees" style="cursor:pointer"><div class="fic" style="background:#e2f4ec">💰</div>
        <div style="flex:1"><div class="ft">इस माह की फ़ीस वसूली</div><div class="fs">पूरा विवरण फ़ीस सेक्शन में देखें</div></div>
        <span class="pill green">₹${monthFees.toLocaleString("en-IN")}</span></div>
      <div class="frow" data-go="live" style="cursor:pointer"><div class="fic" style="background:#e8f1fe">📺</div>
        <div style="flex:1"><div class="ft">आने वाली Live Classes</div><div class="fs">${(sLives || []).length ? "अगली: " + esc(sLives[0].title) : "कोई तय नहीं है"}</div></div>
        <span class="pill gold">${(sLives || []).length}</span></div>
    </div>
    ${(sLives || []).length ? `<div class="card"><h3>📺 Live Classes</h3>
      ${(sLives || []).slice(0, 3).map(l => { const isLive = new Date(l.starts_at).getTime() <= Date.now(); return `<div class="frow"><div class="fic" style="background:#fdecea">📺</div>
        <div style="flex:1"><div class="ft">${esc(l.title)}</div><div class="fs">${esc((myClasses.find(c => c.id === l.class_id) || {}).name || "")} • 🕐 ${new Date(l.starts_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</div></div>
        ${isLive ? `<button class="gold small" data-join="${esc(l.meet_link)}">▶ Join</button>` : `<span class="pill gold">जल्द आ रही है</span>`}</div>`; }).join("")}
    </div>` : ""}
    <div class="card"><h3>🕘 हाल की गतिविधि</h3>
      ${(recentUsers || []).map(u => `<div class="act"><div class="ai" style="background:#e8effe">👤</div>
        <div><div class="at">नया खाता: ${esc(u.full_name)} (${esc(roleName(u.role))})</div>
        <div class="as">${new Date(u.created_at).toLocaleString("en-IN")}</div></div></div>`).join("")}
      ${(recentAttempts || []).map(a => `<div class="act"><div class="ai" style="background:${a.passed ? "#e2f4ec" : "#fdecea"}">📝</div>
        <div><div class="at">${esc(nameOf(a.student_id))} ने टेस्ट दिया — ${a.score}/${a.max_score} (${a.percent}%)</div>
        <div class="as">${new Date(a.submitted_at).toLocaleString("en-IN")}</div></div></div>`).join("")}
      ${(recentFees || []).map(r => `<div class="act"><div class="ai" style="background:#e2f4ec">💰</div>
        <div><div class="at">${esc(nameOf(r.student_id))} — फ़ीस ₹${(+r.paid_amount || 0).toLocaleString("en-IN")} / ₹${(+r.amount || 0).toLocaleString("en-IN")} (${esc(r.fee_type || "")} • ${esc(r.period || "")})</div>
        <div class="as">${new Date(r.created_at).toLocaleString("en-IN")}</div></div></div>`).join("")}
      ${(anns || []).map(a => `<div class="act"><div class="ai" style="background:#fdf3d7">📢</div>
        <div style="flex:1"><div class="at">${esc(a.title)}</div><div class="as">${esc(a.body || "")}</div></div><span class="pill ${annCatMeta[annCatOf(a)].pill}">${annCatOf(a)}</span></div>`).join("")}
      ${!(recentUsers || []).length && !(recentAttempts || []).length && !(recentFees || []).length ? `<p class="muted">अभी कोई गतिविधि नहीं है।</p>` : ""}
    </div>
    <div class="card"><h3>🧭 सभी सेवाएँ</h3>
      <div class="hubrow" data-go="top"><span class="hic" style="background:#fff4cf">🏆</span><span class="hub-tx"><span class="hub-t">Leaderboard रिपोर्ट</span><span class="hub-d">Academy के टॉप छात्र और परिणाम</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-go="tests"><span class="hic" style="background:#fde8e8">📊</span><span class="hub-tx"><span class="hub-t">Test परिणाम रिपोर्ट</span><span class="hub-d">किसी भी टेस्ट के नतीजे देखें</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-go="more"><span class="hic" style="background:#e8f1fe">☰</span><span class="hub-tx"><span class="hub-t">सभी सेक्शन और खाता</span><span class="hub-d">Video Studio, प्रबंध, सूचनाएँ — सब कुछ एक जगह</span></span><span class="arr">›</span></div>
    </div>`;
  wireQA();
  const hq2 = document.getElementById("homeQ");
  const goSearch2 = () => { studyQuery = (hq2?.value || "").trim(); studyLesson = null; tab = "study"; renderShell(); };
  document.getElementById("homeGo")?.addEventListener("click", goSearch2);
  hq2?.addEventListener("keydown", (e) => { if (e.key === "Enter") goSearch2(); });
  $app.querySelectorAll("[data-join]").forEach(b => b.onclick = () => window.open(b.dataset.join, "_blank"));
}

/* ---------------- Manage: academic structure (staff) ---------------- */
async function renderManage() {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
  const [{ data: classes }, { data: subjects }, { data: chapters }] = await Promise.all([
    sb.from("classes").select("*").order("sort_order"),
    sb.from("subjects").select("*").order("sort_order"),
    sb.from("chapters").select("*").order("sort_order"),
  ]);
  const subsOf = (cid) => (subjects || []).filter(s => s.class_id === cid);
  const chapsOf = (sid) => (chapters || []).filter(c => c.subject_id === sid);

  $app.innerHTML = `
    ${profile.role === "admin" ? `
    <div class="card pol-sec">
      <h3>🏫 Coaching Logo</h3>
      <p class="muted" style="margin:0 0 10px">This logo shows in the app header, on the login screen and on the opening (splash) screen. Upload a clear, square image — it is compressed automatically before upload. (The installed app's home-screen icon stays the default one.)</p>
      <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap">
        <img class="brand-logo" src="icon.svg?v=31" alt="Coaching logo" style="width:72px; height:72px; border-radius:16px; object-fit:cover; border:2px solid var(--gold); background:var(--navy)">
        <div style="flex:1; min-width:210px">
          <input type="file" id="logoFile" accept="image/*">
          <button class="gold" id="logoBtn" style="width:100%; margin-top:8px">Change Logo</button>
        </div>
      </div>
    </div>` : ""}
    <div class="card pol-sec">
      <h3>🏫 Classes, Subjects & Chapters</h3>
      <p>This structure is the foundation of notes, materials, questions and tests.</p>
      ${(classes || []).map(c => `
        <div class="item"><div><div class="t">${esc(c.name)}</div>
          <div class="s">${subsOf(c.id).map(s => `${esc(s.name)} (${chapsOf(s.id).length} ch)`).join(" • ") || "No subjects"}</div></div>
        </div>
        ${subsOf(c.id).map(s => `<div class="item" style="padding-left:18px"><div><div class="t" style="font-size:14px">📖 ${esc(s.name)}${s.name_hi ? ` • ${esc(s.name_hi)}` : ""}</div>
          <div class="s">${chapsOf(s.id).map(ch => esc(ch.name)).join(", ") || "No chapters"}</div></div>
          <button class="light small" data-addchap="${s.id}">+ Chapter</button></div>`).join("")}
        <div style="margin:8px 0 2px"><button class="light small" data-addsub="${c.id}">+ Add Subject (${esc(c.name)})</button></div>
      `).join("") || `<p>No classes yet — create the first class below.</p>`}
      <label>New Class Name</label>
      <div class="row"><input id="newClass" placeholder="e.g. Class 10"><button class="gold" id="addClassBtn">Add</button></div>
    </div>
    <div class="card pol-sec"><h3>💰 Fees</h3><p class="muted" style="margin:0 0 10px">Fees now has its own section — open it from the Fees tab below.</p><button class="gold" id="goFees" style="width:100%">💰 Open Fees Section</button></div>
    <div id="qbank"></div>
    <div class="card pol-sec">
      <h3>📢 Post a Notice</h3>
      <label>Title</label><input id="annTitle" placeholder="e.g. Holiday tomorrow">
      <label>Details</label><textarea id="annBody" placeholder="Write in detail…"></textarea>
      <label>श्रेणी • Category</label><select id="annCat"><option value="सूचना">📢 सूचना</option><option value="परीक्षा">📝 परीक्षा</option><option value="छुट्टी">🏖 छुट्टी</option><option value="महत्वपूर्ण">🔴 महत्वपूर्ण</option></select>
      <div class="error" id="annErr"></div>
      <button class="gold" id="annBtn" style="width:100%">Send to All</button>
    </div>`;

  document.getElementById("addClassBtn").onclick = async () => {
    const name = document.getElementById("newClass").value.trim();
    if (!name) return toast("Enter the class name");
    const { error } = await sb.from("classes").insert({ name, sort_order: (classes || []).length + 1 });
    if (error) return toast("Error: " + error.message);
    toast("Class added ✅"); renderManage();
  };
  $app.querySelectorAll("[data-addsub]").forEach(b => b.onclick = async () => {
    const name = prompt("Subject name (English):"); if (!name) return;
    const name_hi = prompt("Subject name (Hindi) — you may leave it blank:") || null;
    const { error } = await sb.from("subjects").insert({ class_id: +b.dataset.addsub, name, name_hi });
    if (error) return toast("Error: " + error.message);
    toast("Subject added ✅"); renderManage();
  });
  $app.querySelectorAll("[data-addchap]").forEach(b => b.onclick = async () => {
    const name = prompt("Chapter name:"); if (!name) return;
    const { error } = await sb.from("chapters").insert({ subject_id: +b.dataset.addchap, name });
    if (error) return toast("Error: " + error.message);
    toast("Chapter added ✅"); renderManage();
  });
  document.getElementById("annBtn").onclick = async () => {
    const title = document.getElementById("annTitle").value.trim();
    const body = document.getElementById("annBody").value.trim();
    const err = document.getElementById("annErr");
    if (!title) { err.textContent = "Enter a title"; return; }
    const annCategory = document.getElementById("annCat")?.value || "सूचना";
    const { error } = await sb.from("announcements").insert({ author_id: me.id, class_id: null, title, body, category: annCategory });
    if (error) { err.textContent = error.message; return; }
    const { data: studs } = await sb.from("profiles").select("id").in("role", ["student", "parent"]);
    await notifyUsers((studs || []).map(p => p.id), "announcement", "📢 " + title, body);
    toast("Notice sent 📢"); tab = "home"; renderShell();
  };
  document.getElementById("goFees").onclick = () => { tab = "fees"; renderShell(); };
  applyBrandLogo();
  const logoFile = document.getElementById("logoFile");
  if (logoFile) {
    enhanceFilePicker(logoFile, { imageOnly: true });
    document.getElementById("logoBtn").onclick = async () => {
      const f = logoFile.files[0];
      if (!f) return toast("Choose a logo image first");
      const btn = document.getElementById("logoBtn");
      btn.disabled = true; btn.textContent = "Uploading…";
      try {
        const file = await prepareUploadFile(f);
        const { error } = await sb.storage.from("images").upload("branding/logo.png", file, { upsert: true, contentType: file.type || "image/png" });
        if (error) throw error;
        try { localStorage.setItem("logo_v", String(Date.now())); } catch (_) {}
        applyBrandLogo();
        toast("🏫 Logo updated — the new logo now shows across the app");
        renderManage();
      } catch (e) { toast("Error: " + e.message); btn.disabled = false; btn.textContent = "Change Logo"; }
    };
  }
  renderQBank(subjects || [], chapters || []);
}

/* ---------------- Fees (staff) ---------------- */
async function renderFeesPage() {
  $app.innerHTML = `
    <div class="card pol-sec"><h3>💰 Fees • फ़ीस प्रबंधन</h3>
      <p class="muted" style="margin:0">Set the fee for a class, create fees for the whole class and record payments. When a fee is created or a payment is recorded, the student automatically gets a notification (app + phone).</p>
    </div>
    <div id="fees"></div>`;
  renderFees();
}
async function renderFees() {
  const host = document.getElementById("fees");
  if (!host) return;
  const [{ data: plans }, { data: records }, { data: studs }, { data: enrAll }] = await Promise.all([
    sb.from("fee_plans").select("*"),
    sb.from("fee_records").select("*").order("created_at", { ascending: false }).limit(60),
    sb.from("profiles").select("id,full_name,phone").eq("role", "student"),
    sb.from("enrollments").select("*"),
  ]);
  const planOf = (cid, type) => (plans || []).find(p => p.class_id === cid && p.fee_type === type)?.amount ?? "";
  const nameOf = (id) => (studs || []).find(s => s.id === id)?.full_name || "Student";
  const phoneOf = (id) => (studs || []).find(s => s.id === id)?.phone || "";
  const waLink = (phone, text) => {
    const p = (phone || "").replace(/\D/g, "");
    const num = p.length === 10 ? "91" + p : p;
    return (num ? `https://wa.me/${num}` : "https://wa.me/") + `?text=${encodeURIComponent(text)}`;
  };
  const waReceipt = (r) => {
    const due = +r.amount - +r.paid_amount;
    const cls = (myClasses.find(c => c.id === r.class_id) || {}).name || "";
    return `🙏 Namaste! Target Academy Coaching Centre — Fee Receipt ✅\n\nStudent: ${nameOf(r.student_id)}${cls ? ` (${cls})` : ""}\nFee: ${r.fee_type} — ${r.period}\nJama (Paid): ₹${r.paid_amount} / ₹${r.amount}` + (due > 0 ? `\nBaki (Due): ₹${due}` : `\nPoori fee jama ho gayi hai ✅`) + `\n\nDhanyavaad! 🙏`;
  };
  const totalDue = (records || []).reduce((s, r) => s + (+r.amount - +r.paid_amount), 0);
  const totalPaid = (records || []).reduce((s, r) => s + +r.paid_amount, 0);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const now = new Date();
  const defaultPeriod = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  const thisMonthPaid = (records || []).filter(r => r.period === defaultPeriod).reduce((s, r) => s + +r.paid_amount, 0);

  host.innerHTML = `
    <div class="card pol-sec v45rows"><h3>💰 Fees • फ़ीस</h3>
      <div class="stats">
        <div class="stat"><div class="si" style="background:#e2f4ec">✅</div><div class="n">₹${totalPaid.toLocaleString("en-IN")}</div><div class="l">कुल वसूली • Collected</div></div>
        <div class="stat"><div class="si" style="background:#fdecea">⏳</div><div class="n">₹${totalDue.toLocaleString("en-IN")}</div><div class="l">कुल बकाया • Due</div></div>
        <div class="stat"><div class="si" style="background:#e8f1fe">🧾</div><div class="n">₹${thisMonthPaid.toLocaleString("en-IN")}</div><div class="l">इस माह वसूली • ${esc(defaultPeriod)}</div></div>
      </div>
      <label>Set Fees by Class</label>
      ${myClasses.map(c => `<div class="row" style="align-items:flex-end; margin-bottom:4px">
        <div style="flex:1.4"><b>${esc(c.name)}</b></div>
        <div><label>Monthly (₹)</label><input type="number" id="fp_m_${c.id}" value="${planOf(c.id, "monthly")}" placeholder="e.g. 800"></div>
        <div><label>Yearly (₹)</label><input type="number" id="fp_y_${c.id}" value="${planOf(c.id, "yearly")}" placeholder="e.g. 8000"></div>
        <div style="flex:0 0 auto"><button class="light small" data-fpsave="${c.id}">Save</button></div>
      </div>`).join("")}
      <label style="margin-top:14px">Create Fee for the Whole Class</label>
      <div class="row">
        <div><label>Class</label><select id="fg_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
        <div><label>Type</label><select id="fg_type"><option value="monthly">Monthly</option><option value="yearly">Yearly</option><option value="admission">Admission</option><option value="exam">Exam</option><option value="other">Other</option></select></div>
      </div>
      <div class="row">
        <div><label>Period</label><input id="fg_period" value="${defaultPeriod}"></div>
        <div><label>Amount (₹)</label><input id="fg_amount" type="number" placeholder="Auto-filled from the fee set above"></div>
        <div><label>Due Date</label><input id="fg_due" type="date"></div>
      </div>
      <div class="error" id="fg_err"></div>
      <button class="gold" id="fg_gen" style="width:100%">Create Fee for All Students</button>
      <div class="v45-head" style="margin-top:14px"><label style="margin:0">Recent Fee Records • ताज़ा फ़ीस रिकॉर्ड</label><button class="light small" id="feesCsvBtn">⬇ CSV Download</button></div>
      <p class="muted" style="margin:0 0 6px">Tap 📲 WhatsApp on any paid record to send the fee receipt on WhatsApp. Tap 🗑 Delete to remove a record created by mistake.</p>
      ${(records || []).map(r => `<div class="item"><div>
          <div class="t" style="font-size:14px">${esc(nameOf(r.student_id))}</div>
          <div class="s">${esc(r.fee_type)} • ${esc(r.period)} • ₹${r.paid_amount} of ₹${r.amount} paid${+r.amount - +r.paid_amount > 0 ? ` • <b style="color:var(--bad)">Due ₹${+r.amount - +r.paid_amount}</b>` : ""}</div></div>
        <span style="display:flex; gap:6px; align-items:center">
          <span class="pill ${r.status === "paid" ? "green" : r.status === "partial" ? "gold" : "red"}">${r.status === "paid" ? "Paid • जमा" : r.status === "partial" ? "Partial • आंशिक" : "Pending • बाकी"}</span>
          ${+r.paid_amount > 0 ? `<a class="light small" style="background:#e7f8ee; border-color:#25d366; color:#075e54; text-decoration:none" href="${waLink(phoneOf(r.student_id), waReceipt(r))}" target="_blank" rel="noopener">📲 WhatsApp</a>` : ""}
          ${r.status !== "paid" ? `<button class="light small" data-fpay="${r.id}:${+r.amount - +r.paid_amount}">+ Payment</button>` : ""}
          <button class="light small" style="color:var(--bad)" data-fdel="${r.id}">🗑 Delete</button>
        </span></div>`).join("") || `<p class="muted">No fee records yet.</p>`}
    </div>`;

  host.querySelectorAll("[data-fpsave]").forEach(b => b.onclick = async () => {
    const cid = +b.dataset.fpsave;
    for (const [type, el] of [["monthly", "fp_m_"], ["yearly", "fp_y_"]]) {
      const v = document.getElementById(el + cid).value;
      if (v === "") continue;
      const { error } = await sb.from("fee_plans").upsert({ class_id: cid, fee_type: type, amount: +v }, { onConflict: "class_id,fee_type" });
      if (error) return toast("Error: " + error.message);
    }
    toast("Fee saved 💰"); renderFees();
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
    if (!period || !amount) { err.textContent = "Enter the period and amount"; return; }
    const studsInClass = (enrAll || []).filter(e => e.class_id === cid).map(e => e.user_id);
    if (!studsInClass.length) { err.textContent = "There is no student in this class"; return; }
    const rows = studsInClass.map(sid => ({ student_id: sid, class_id: cid, fee_type: type, period, amount, due_date: due, recorded_by: me.id }));
    const { error } = await sb.from("fee_records").upsert(rows, { onConflict: "student_id,fee_type,period", ignoreDuplicates: true });
    if (error) { err.textContent = error.message; return; }
    notifyUsers(studsInClass, "fee", "🧾 New Fee Created",
      `${type} fee (${period}): ₹${amount}${due ? ` • Last date to pay: ${due}` : ""} — please pay on time.`);
    toast(`Fee created — for ${studsInClass.length} students 🧾`); renderFees();
  };
  host.querySelectorAll("[data-fpay]").forEach(b => b.onclick = async () => {
    const [id, dueAmt] = b.dataset.fpay.split(":");
    const v = prompt(`How much was paid (₹)? (Due ₹${dueAmt})`);
    if (!v) return;
    const rec = (records || []).find(r => r.id === +id);
    const paid = +rec.paid_amount + +v;
    const status = paid >= +rec.amount ? "paid" : "partial";
    const { error } = await sb.from("fee_records").update({ paid_amount: paid, status, updated_at: new Date().toISOString() }).eq("id", +id);
    if (error) return toast("Error: " + error.message);
    const dueLeft = +rec.amount - paid;
    notifyUsers([rec.student_id], "fee", "💰 Fee Paid",
      `₹${v} has been paid towards your ${rec.fee_type} fee (${rec.period}). Total paid: ₹${paid} / ₹${rec.amount}${dueLeft > 0 ? ` • Due: ₹${dueLeft}` : " • Full fee paid ✅"}`);
    toast("Payment recorded ✅"); renderFees();
  });
  host.querySelectorAll("[data-fdel]").forEach(b => b.onclick = async () => {
    const rec = (records || []).find(r => r.id === +b.dataset.fdel);
    if (!rec) return;
    const warn = +rec.paid_amount > 0 ? `\n\n⚠️ Warning: ₹${rec.paid_amount} is already PAID on this record — deleting will also remove that payment record!` : "";
    if (!confirm(`Delete this fee record?\n\n${nameOf(rec.student_id)} — ${rec.fee_type} (${rec.period}) • ₹${rec.amount}${warn}\n\nThis cannot be undone.`)) return;
    const { data: del, error } = await sb.from("fee_records").delete().eq("id", rec.id).select("id");
    if (error) return toast("Error: " + error.message);
    if (!del || !del.length) return toast("Could not delete — permission issue");
    toast("Fee record deleted 🗑"); renderFees();
  });
  document.getElementById("feesCsvBtn").onclick = () => {
    if (!(records || []).length) return toast("No fee records to download");
    downloadCSV("fees.csv", ["Student", "Class", "Type", "Period", "Amount", "Paid", "Balance", "Status", "Due Date"],
      records.map(r => [nameOf(r.student_id), (myClasses.find(c => c.id === r.class_id) || {}).name || "", r.fee_type, r.period, r.amount, r.paid_amount, +r.amount - +r.paid_amount, r.status, r.due_date || ""]));
    toast("CSV downloaded ⬇");
  };
}

/* ---------------- Question Bank (staff only) ---------------- */
async function renderQBank(subjects, chapters) {
  const host = document.getElementById("qbank");
  if (!host) return;
  const { data: qs } = await sb.from("questions").select("*").order("created_at", { ascending: false }).limit(30);
  const subName = (id) => (subjects.find(s => s.id === id) || {}).name || "";
  host.innerHTML = `
    <div class="card pol-sec"><h3>❓ Question Bank (${qs ? qs.length : 0} recent)</h3>
      <p>Questions from here will be used in tests. Only staff can see the correct answers — students never see them.</p>
      <label>Type</label>
      <select id="q_type">
        <option value="mcq_single">MCQ (one correct answer)</option>
        <option value="true_false">True / False</option>
        <option value="fill_blank">Fill in the blank</option>
        <option value="short">Short answer (teacher will check)</option>
        <option value="descriptive">Long answer (teacher will check)</option>
      </select>
      <label>Class</label><select id="q_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <label>Subject</label><select id="q_subject"><option value="">—</option>${subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select>
      <label>Chapter</label><select id="q_chapter"><option value="">—</option>${chapters.map(ch => `<option value="${ch.id}">${esc(ch.name)}</option>`).join("")}</select>
      <label>Question</label><textarea id="q_text" placeholder="Write the question here…"></textarea>
      <div id="q_opts">
        <label>Options (for MCQ)</label>
        <div class="row"><input id="q_oA" placeholder="A"><input id="q_oB" placeholder="B"></div>
        <div class="row"><input id="q_oC" placeholder="C"><input id="q_oD" placeholder="D"></div>
      </div>
      <label>Correct Answer</label>
      <select id="q_correct_sel">
        <option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option>
        <option value="true">True</option><option value="false">False</option>
      </select>
      <input id="q_correct_text" class="hidden" placeholder="Write the correct answer (for fill in the blank)">
      <label>Explanation (shown after the result)</label><textarea id="q_expl" placeholder="Why is this answer correct…"></textarea>
      <div class="row">
        <div><label>Marks</label><input id="q_marks" type="number" value="1" min="0" step="0.5"></div>
        <div><label>Difficulty</label><select id="q_diff"><option>easy</option><option selected>medium</option><option>hard</option></select></div>
      </div>
      <div class="error" id="q_err"></div>
      <button class="gold" id="q_add" style="width:100%">Add Question</button>
      <div class="v45rows" style="margin-top:10px">
      ${(qs || []).map(q => `<div class="item"><div><div class="t" style="font-size:14px">${esc(q.question_text.slice(0, 90))}${q.question_text.length > 90 ? "…" : ""}</div>
        <div class="s">${esc(q.qtype)} • ${esc(subName(q.subject_id))} • ${q.marks} marks • Correct: ${esc(JSON.stringify(q.correct_answer))}</div></div>
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
    if (!confirm("Delete this question?")) return;
    const { error } = await sb.from("questions").delete().eq("id", +b.dataset.qdel);
    if (error) return toast("Error: " + error.message);
    toast("Question deleted"); renderManage();
  });
  document.getElementById("q_add").onclick = async () => {
    const err = document.getElementById("q_err"); err.textContent = "";
    const t = typeSel.value;
    const text = document.getElementById("q_text").value.trim();
    if (!text) { err.textContent = "Write the question"; return; }
    let options = null, correct = null;
    if (t === "mcq_single") {
      options = ["A", "B", "C", "D"].map(k => ({ key: k, text: document.getElementById("q_o" + k).value.trim() }));
      if (options.some(o => !o.text)) { err.textContent = "Write all four options"; return; }
      correct = [document.getElementById("q_correct_sel").value];
    } else if (t === "true_false") {
      options = [{ key: "true", text: "True" }, { key: "false", text: "False" }];
      correct = [document.getElementById("q_correct_sel").value === "false" ? "false" : "true"];
    } else if (t === "fill_blank") {
      const v = document.getElementById("q_correct_text").value.trim();
      if (!v) { err.textContent = "Write the correct answer"; return; }
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
    toast("Question added ❓"); renderManage();
  };
}

/* ---------------- Users & enrollment (admin) ---------------- */
async function renderUsers() {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
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
    <div class="card pol-sec"><h3>➕ Add a New Student Yourself</h3>
      <p>The student doesn't need to sign up — create the account yourself and give them the login details.</p>
      <label>Student's Name</label><input id="ns_name" placeholder="e.g. Rahul Kumar">
      <label>Email (student's or parent's)</label><input id="ns_email" type="email" placeholder="student@example.com">
      <label>Password (you decide — you will need to tell this to the student)</label><input id="ns_pass" type="text" placeholder="At least 6 characters, e.g. rahul123">
      <label>Father's Name</label><input id="ns_father" placeholder="Father's name">
      <label>Mother's Name (optional)</label><input id="ns_mother" placeholder="Mother's name">
      <div class="row">
        <div><label>Date of Birth</label><input id="ns_dob" type="date"></div>
        <div><label>Admission Date</label><input id="ns_adm" type="date"></div>
      </div>
      <label>Mobile Number</label><input id="ns_phone" type="tel" placeholder="10-digit number">
      <label>Address</label><input id="ns_addr" placeholder="Village / locality, district">
      <label>Add to Class</label><select id="ns_class"><option value="">— Will add later —</option>${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <div class="error" id="ns_err"></div>
      <div id="ns_done"></div>
      <button class="gold" id="ns_add" style="width:100%">Create Student</button>
    </div>
    <div class="card v45rows"><h3>👥 All Users • सभी उपयोगकर्ता (${(users || []).length})</h3>
    <p>Change roles and add students to classes from here.</p>
    <div class="v45-tools">
      <input type="search" id="uSearch" placeholder="🔍 नाम, फ़ोन या क्लास खोजें…">
      <select id="uRoleFilter"><option value="">सभी • All Roles</option><option value="student">छात्र • Student</option><option value="teacher">शिक्षक • Teacher</option><option value="parent">अभिभावक • Parent</option><option value="admin">एडमिन • Admin</option></select>
      <button class="light small" id="usersCsvBtn">⬇ CSV Download</button>
      <span class="muted" style="font-size:12.5px">दिख रहे: <b id="uCount">${(users || []).length}</b></span>
    </div>
    ${(users || []).map(u => `
      <div class="item" data-urow data-urole="${esc(u.role)}" data-usearch="${esc((u.full_name + " " + (u.phone || "") + " " + enrOf(u.id).map(className).join(" ") + " " + roleName(u.role)).toLowerCase())}" style="align-items:flex-start">
        ${u.photo_path && urlMap[u.photo_path]
          ? `<img src="${urlMap[u.photo_path]}" alt="" class="zoomable" title="Tap to view larger" data-zoom="${urlMap[u.photo_path]}" style="width:44px; height:44px; border-radius:50%; object-fit:cover; flex:0 0 auto">`
          : `<div class="avatar" style="width:44px; height:44px; font-size:17px">${esc((u.full_name || "?").trim()[0].toUpperCase())}</div>`}
        <div style="flex:1">
          <div class="t">${esc(u.full_name)} ${u.id === me.id ? '<span class="pill gold">You</span>' : ""}</div>
          <div class="s">${esc(roleName(u.role))}${u.role === "student" ? " • " + (enrOf(u.id).map(className).join(", ") || "No class") : ""}
          ${u.father_name ? `<br>Father: ${esc(u.father_name)}` : ""}${u.dob ? ` • Born: ${esc(u.dob)}` : ""}${u.admission_date ? `<br>Admission: ${esc(u.admission_date)}` : ""}${u.phone ? ` • 📞 ${esc(u.phone)}` : ""}</div>
          <div id="edit-${u.id}" class="hidden" style="margin-top:8px">
            <label>Name</label><input id="e_name-${u.id}" value="${esc(u.full_name)}">
            <label>Father's Name</label><input id="e_father-${u.id}" value="${esc(u.father_name || "")}">
            <label>Mother's Name</label><input id="e_mother-${u.id}" value="${esc(u.mother_name || "")}">
            <div class="row">
              <div><label>Date of Birth</label><input id="e_dob-${u.id}" type="date" value="${esc(u.dob || "")}"></div>
              <div><label>Admission Date</label><input id="e_adm-${u.id}" type="date" value="${esc(u.admission_date || "")}"></div>
            </div>
            <label>Mobile</label><input id="e_phone-${u.id}" value="${esc(u.phone || "")}">
            <label>Address</label><input id="e_addr-${u.id}" value="${esc(u.address || "")}">
            <label>Profile Photo</label><input id="e_photo-${u.id}" type="file" accept="image/*">
            <button class="gold small" data-save="${u.id}" style="margin-top:8px">💾 Save</button>
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
    toast("Role changed ✅"); renderUsers();
  });
  $app.querySelectorAll("[data-enroll]").forEach(sel => sel.onchange = async () => {
    if (!sel.value) return;
    const { error } = await sb.from("enrollments").insert({ user_id: sel.dataset.enroll, class_id: +sel.value });
    if (error) return toast("Error: " + error.message);
    const { data: cls } = await sb.from("classes").select("name").eq("id", +sel.value).single();
    notifyUsers([sel.dataset.enroll], "admission", "✅ Admission Done",
      `You have got admission in ${cls?.name || "your class"}. Now you will find Notes, Tests and Homework in this app itself. 🎓`);
    toast("Student added to the class 🎓"); renderUsers();
  });
  $app.querySelectorAll("[data-deluser]").forEach(b => b.onclick = async () => {
    const name = b.dataset.delname;
    if (!confirm(`Delete "${name}"? Their fees, results, attendance, submissions — all data will be deleted and they will no longer be able to log in.`)) return;
    if (!confirm("Are you sure? This cannot be undone.")) return;
    const { data: gone, error } = await sb.from("profiles").delete().eq("id", b.dataset.deluser).select("id");
    if (error) return toast("Error: " + error.message);
    if (!gone || !gone.length) return toast("❌ Not deleted — the database blocked it, please tell me");
    toast("User deleted 🗑"); renderUsers();
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
      toast("Details saved ✅"); renderUsers();
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
    if (!name || !email || !pass) { err.textContent = "Fill in all three — name, email and password"; return; }
    if (pass.length < 6) { err.textContent = "Keep the password at least 6 characters long"; return; }
    const btn = document.getElementById("ns_add");
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      // Separate throwaway client so the admin's own login session is untouched.
      const sbNew = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, storageKey: "sb-student-create" } });
      const { data, error } = await sbNew.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
      await sbNew.auth.signOut();
      if (error) throw error;
      const newId = data?.user?.id;
      if (!newId) throw new Error("Account not created — this email may already exist");
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
      notifyUsers([newId], "welcome", "🎉 Welcome to Target Academy!",
        `Your account has been created${clsN?.name ? ` and you have got admission in ${clsN.name}` : ""}. Here you will find Notes, Tests, Homework and Fees — everything in one place. Best wishes for your studies! 📚`);
      done.innerHTML = `<div class="card" style="background:#e2f4ec; border-color:#bfe6d2; margin:10px 0">
        <b>✅ Student created!</b><br>Give these details to the student —<br>
        📧 Email: <b>${esc(email)}</b><br>🔑 Password: <b>${esc(pass)}</b><br>
        🔗 Link: ashutoshkumarjpg67-ai.github.io/target-academy-platform</div>`;
      toast("Student created 🎓");
      setTimeout(renderUsers, 4000);
    } catch (e) {
      err.textContent = e.message;
      btn.disabled = false; btn.textContent = "Create Student";
    }
  };
  const applyUFilter = () => {
    const q = (document.getElementById("uSearch")?.value || "").trim().toLowerCase();
    const rf = document.getElementById("uRoleFilter")?.value || "";
    let shown = 0;
    $app.querySelectorAll("[data-urow]").forEach(row => {
      const ok = (!rf || row.dataset.urole === rf) && (!q || (row.dataset.usearch || "").includes(q));
      row.style.display = ok ? "" : "none";
      if (ok) shown++;
    });
    const cnt = document.getElementById("uCount");
    if (cnt) cnt.textContent = shown;
  };
  document.getElementById("uSearch").oninput = applyUFilter;
  document.getElementById("uRoleFilter").onchange = applyUFilter;
  document.getElementById("usersCsvBtn").onclick = () => {
    const studs = (users || []).filter(u => u.role === "student");
    if (!studs.length) return toast("No students to download");
    downloadCSV("students.csv", ["Name", "Class", "Phone", "Email", "Father Name", "Date of Birth", "Admission Date", "Address"],
      studs.map(u => [u.full_name, enrOf(u.id).map(className).join(", "), u.phone || "", u.email || "", u.father_name || "", u.dob || "", u.admission_date || "", u.address || ""]));
    toast("CSV downloaded ⬇");
  };
}

/* ---------------- Study: Notes + Materials ---------------- */
let studyClassId = null;
let matFilter = "all";
let studyQuery = "";
let studyLesson = null;
let studyTab = "notes";
let studySubjId = null;
let studyChapId = null;
const KIND_ICON = { pdf: "📕", worksheet: "📝", practice: "✍️", summary: "📋", revision: "🔁", question_bank: "❓", sample_paper: "📄", pyq: "🗂️", image: "🖼️", video_link: "🎬", doc: "📘" };

async function openStoredFile(bucket, path) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) return toast("Could not open the file: " + error.message);
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
  $app.innerHTML = `<div class="loading">Loading…</div>`;
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
  const ytIdOf = (u = "") => (String(u).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/) || [])[1] || null;
  const qLow = studyQuery.trim().toLowerCase();
  const matchQ = (x) => !qLow || (x.title || "").toLowerCase().includes(qLow) || subName(x.subject_id).toLowerCase().includes(qLow);
  const myNotes = (notes || []).filter(inClass).filter(matchQ);
  const myMats = (materials || []).filter(inClass).filter(matchQ);

  // ---- Lesson view (video material, EduPlus-style) ----
  if (studyLesson) {
    const lm = (materials || []).find(m => m.id === studyLesson);
    if (!lm) { studyLesson = null; }
    else {
      const yt = ytIdOf(lm.external_url);
      const relNote = (notes || []).find(n => n.chapter_id && lm.chapter_id && n.chapter_id === lm.chapter_id && n.class_id === lm.class_id && n.body);
      $app.innerHTML = `
        <button class="light small" id="lessonBack">← Back to all Material</button>
        <div class="card" style="margin-top:12px; padding:0; overflow:hidden">
          ${yt ? `<div class="lesson-video"><iframe src="https://www.youtube-nocookie.com/embed/${yt}" title="${esc(lm.title)}" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
               : `<div style="padding:26px 18px; text-align:center"><div style="font-size:44px">🎬</div><p class="muted">This video will open outside</p></div>`}
          <div style="padding:16px">
            <h3 style="border:0; padding-left:0; margin-top:0">🎬 ${esc(lm.title)}</h3>
            <p class="muted">${esc(clsName(lm.class_id))} • ${esc(subName(lm.subject_id))}${lm.chapter_id ? " • " + esc(chapName(lm.chapter_id)) : ""}</p>
            ${lm.description ? `<p>${esc(lm.description)}</p>` : ""}
            <div class="row" style="margin-top:10px">
              ${lm.external_url ? `<button class="gold" id="lessonExt">Open on YouTube ↗</button>` : ""}
              ${!isStaff() ? `<button class="light" id="lessonDone">${isDone("material", lm.id) ? "✓ Read" : "Mark as Read"}</button>` : ""}
            </div>
          </div>
        </div>
        ${relNote ? `<div class="card"><h3>📝 Key Points — Linked Note</h3>
          <div style="font-weight:800">${esc(relNote.title)}</div>
          <div class="note-body" id="lessonNoteBody"></div></div>` : ""}`;
      document.getElementById("lessonBack").onclick = () => { studyLesson = null; renderStudy(); };
      const le = document.getElementById("lessonExt");
      if (le) le.onclick = () => window.open(lm.external_url, "_blank");
      const ld = document.getElementById("lessonDone");
      if (ld) ld.onclick = async () => {
        await sb.from("content_progress").upsert({ user_id: me.id, item_type: "material", item_id: lm.id, completed: !isDone("material", lm.id), last_opened_at: new Date().toISOString() }, { onConflict: "user_id,item_type,item_id" });
        renderStudy();
      };
      const nb = document.getElementById("lessonNoteBody");
      if (nb && relNote) nb.textContent = relNote.body || "";
      return;
    }
  }
  // ---- Student Study (Phase 1 redesign — design photo 4) ----
  if (!isStaff()) {
    const inSubj = (x) => !studySubjId || x.subject_id === studySubjId;
    const inChap = (x) => !studyChapId || x.chapter_id === studyChapId;
    const fNotes = myNotes.filter(inSubj).filter(inChap);
    const fMats = myMats.filter(inSubj).filter(inChap);
    const tabList = studyTab === "notes" ? fNotes.map(x => ({ ...x, _t: "note" }))
      : studyTab === "pdf" ? [...fNotes.filter(n => n.file_path).map(x => ({ ...x, _t: "note" })), ...fMats.filter(m => m.file_path).map(x => ({ ...x, _t: "material" }))]
      : fMats.filter(m => m.kind === "worksheet").map(x => ({ ...x, _t: "material" }));
    const kindMeta = (x) => {
      if (x._t === "note") return x.file_path ? ["📕", "#fdecea", "PDF"] : ["📗", "#e2f4ec", "नोट्स"];
      return ({ pdf: ["📕", "#fdecea", "PDF"], doc: ["📘", "#e8f1fe", "दस्तावेज़"], worksheet: ["📝", "#efe7fd", "वर्कशीट"], video_link: ["🎬", "#fdecea", "Video"], image: ["🖼️", "#e8f1fe", "तस्वीर"], practice: ["✍️", "#fdf3d7", "अभ्यास"], summary: ["📋", "#e2f4ec", "सारांश"], revision: ["🔁", "#e2f4ec", "रिवीज़न"], question_bank: ["❓", "#fdf3d7", "प्रश्न बैंक"], sample_paper: ["📄", "#e8f1fe", "सैंपल पेपर"], pyq: ["🗂️", "#efe7fd", "PYQ"] })[x.kind] || ["📄", "#eef2fa", "मटेरियल"];
    };
    const rowHTML = (x, inRecent = false) => {
      const [ic, bg, kl] = kindMeta(x);
      const dt = x.created_at ? new Date(x.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-") : "";
      return `<div class="sitem">
        <div class="sicon" style="background:${bg}">${ic}</div>
        <div class="stx" data-openrow="${x._t}:${x.id}">
          <div class="st-t">${esc(x.title)}</div>
          <div class="st-s">${kl}${dt ? " • " + dt : ""}${x.chapter_id ? " • अध्याय: " + esc(chapName(x.chapter_id)) : ""}${x.subject_id ? " • " + esc(subName(x.subject_id)) : ""}</div>
        </div>
        <div class="sacts">
          <button class="sact" data-bm="${x._t}:${x.id}" title="Bookmark">${isBm(x._t, x.id) ? "★" : "☆"}</button>
          ${x.file_path ? `<button class="sact" data-open="${x._t}:${x.id}" title="Open / Download">⬇</button>` : ""}
          ${!isDone(x._t, x.id) ? `<button class="sact" data-done="${x._t}:${x.id}" title="Marked as Read">✓</button>` : `<span class="sact isdone" title="Marked as Read">✓</span>`}
        </div>
        ${x._t === "note" && x.body && !inRecent ? `<div class="note-body sbody hidden" id="sbody-${x.id}"></div>` : ""}
      </div>`;
    };
    const recentProg = (prog || []).filter(p => p.last_opened_at).sort((a, b) => new Date(b.last_opened_at) - new Date(a.last_opened_at)).slice(0, 3);
    const recentItems = recentProg.map(p => { const src = p.item_type === "note" ? (notes || []).find(n => n.id === p.item_id) : (materials || []).find(m => m.id === p.item_id); return src ? { ...src, _t: p.item_type } : null; }).filter(Boolean);
    const subjOpts = (subjects || []).filter(s => !studyClassId || s.class_id === studyClassId);
    const chapOpts = (chapters || []).filter(c => !studySubjId || c.subject_id === studySubjId);
    $app.innerHTML = `
      <div class="searchbar"><span>🔍</span><input id="studyQ" placeholder="नोट्स, PDF, विषय खोजें…" value="${esc(studyQuery)}"><button class="small gold" id="studyGo">Search</button></div>
      <div class="seg-tabs">
        ${[["notes", "Notes"], ["pdf", "PDF"], ["worksheet", "Worksheets"]].map(([k, l]) => `<button class="${studyTab === k ? "on" : ""}" data-stab="${k}">${l}</button>`).join("")}
      </div>
      <div class="filter-row">
        <select id="fCls" aria-label="कक्षा"><option value="">कक्षा: सभी</option>${myClasses.map(c => `<option value="${c.id}" ${c.id === studyClassId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        <select id="fSubj" aria-label="विषय"><option value="">विषय: सभी</option>${subjOpts.map(s => `<option value="${s.id}" ${s.id === studySubjId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>
        <select id="fChap" aria-label="अध्याय"><option value="">अध्याय: सभी</option>${chapOpts.map(c => `<option value="${c.id}" ${c.id === studyChapId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      </div>
      ${recentItems.length && !qLow ? `<div class="card"><h3>🕘 हाल में देखे गए</h3>${recentItems.map(x => rowHTML(x, true)).join("")}</div>` : ""}
      <div class="card"><h3>${studyTab === "notes" ? "📗 नोट्स" : studyTab === "pdf" ? "📕 PDF फ़ाइलें" : "📝 वर्कशीट"} (${tabList.length})</h3>
        ${tabList.map(x => rowHTML(x)).join("") || `<p class="muted" style="margin:0">${studyTab === "worksheet" ? "अभी कोई वर्कशीट नहीं है — जल्द आएगी।" : "इस श्रेणी में अभी कुछ नहीं है — जल्द आएगा।"}</p>`}
      </div>
      <div class="card"><h3>📊 विषयों में मेरी प्रगति</h3>
        ${subjOpts.map(s => {
          const si = [...(notes || []).filter(n => n.subject_id === s.id).map(n => ({ ...n, type: "note" })), ...(materials || []).filter(m => m.subject_id === s.id).map(m => ({ ...m, type: "material" }))];
          if (!si.length) return "";
          const sd = si.filter(x => isDone(x.type, x.id)).length;
          const p = Math.round((sd / si.length) * 100);
          const st = subjStyle(s.name);
          return `<div class="subj" style="margin-bottom:8px"><div class="sic" style="background:${st.c}">${st.i}</div><div style="flex:1"><div class="st">${esc(s.name)}</div><div class="ss">${sd}/${si.length} पढ़ा</div><div class="bar"><div style="width:${p}%; background:${st.c}"></div></div></div><div class="sp">${p}%</div></div>`;
        }).join("") || `<p class="muted" style="margin:0">अभी कोई विषय नहीं है।</p>`}
      </div>`;
    document.getElementById("fCls").onchange = (e) => { studyClassId = e.target.value ? +e.target.value : null; studySubjId = null; studyChapId = null; renderStudy(); };
    document.getElementById("fSubj").onchange = (e) => { studySubjId = e.target.value ? +e.target.value : null; studyChapId = null; renderStudy(); };
    document.getElementById("fChap").onchange = (e) => { studyChapId = e.target.value ? +e.target.value : null; renderStudy(); };
    $app.querySelectorAll("[data-stab]").forEach(b => b.onclick = () => { studyTab = b.dataset.stab; renderStudy(); });
    const sq2 = document.getElementById("studyQ");
    const applyQ2 = () => { studyQuery = (sq2?.value || "").trim(); renderStudy(); };
    document.getElementById("studyGo")?.addEventListener("click", applyQ2);
    sq2?.addEventListener("keydown", (e) => { if (e.key === "Enter") applyQ2(); });
    $app.querySelectorAll("[data-openrow]").forEach(el => el.onclick = () => {
      const [type, id] = el.dataset.openrow.split(":");
      const src = type === "note" ? (notes || []).find(n => n.id === +id) : (materials || []).find(m => m.id === +id);
      if (!src) return;
      if (type === "material" && (src.kind === "video_link" || ytIdOf(src.external_url))) { studyLesson = src.id; renderStudy(); return; }
      if (src.body) { const b = document.getElementById("sbody-" + id); if (b) { const show = b.classList.contains("hidden"); b.classList.toggle("hidden", !show); b.textContent = show ? src.body : ""; } return; }
      if (src.file_path) { openStoredFile(type === "note" ? "notes-files" : "materials", src.file_path); return; }
      if (src.external_url) window.open(src.external_url, "_blank");
    });
    $app.querySelectorAll("[data-open]").forEach(b => b.onclick = () => {
      const [type, id] = b.dataset.open.split(":");
      const src = type === "note" ? (notes || []).find(n => n.id === +id) : (materials || []).find(m => m.id === +id);
      if (src?.file_path) openStoredFile(type === "note" ? "notes-files" : "materials", src.file_path);
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
        { user_id: me.id, item_type: type, item_id: +id, completed: true, last_opened_at: new Date().toISOString() },
        { onConflict: "user_id,item_type,item_id" });
      renderStudy();
    });
    return;
  }

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
          ${type === "note" && x.body ? `<button class="small" data-body="${x.id}">Read</button>` : ""}
          ${x.file_path ? `<button class="small" data-open="${type}:${x.id}">Open</button>` : ""}
          ${x.external_url ? (type === "material" && (x.kind === "video_link" || ytIdOf(x.external_url)) ? `<button class="small" data-lesson="${x.id}">▶ Lesson</button>` : `<button class="small" data-ext="${x.id}">Open</button>`) : ""}
        </div>
        ${!isStaff() ? `<button class="light small" data-done="${type}:${x.id}">${isDone(type, x.id) ? "✓ Read" : "Mark as Read"}</button>` : ""}
      </div>
    </div>`;

  $app.innerHTML = `
    <div class="card"><h3>🎓 Choose a Class</h3>
      <div class="row">
        <button class="${!studyClassId ? "" : "light"}" data-cls="">All Classes</button>
        ${myClasses.map(c => `<button class="${c.id === studyClassId ? "" : "light"}" data-cls="${c.id}">${esc(c.name)}</button>`).join("")}
      </div>
      <p class="muted" style="margin-bottom:0">Notes and Material are shown separately for each class.</p>
    </div>
    <div class="card"><h3>📚 Subjects</h3>
      <div class="subj-grid">${mySubjs.map(s => {
        const st = subjStyle(s.name);
        return `<div class="subj"><div class="sic" style="background:${st.c}">${st.i}</div>
          <div style="flex:1"><div class="st">${esc(s.name)}${s.name_hi ? ` • ${esc(s.name_hi)}` : ""}</div>
          <div class="ss">${esc(clsName(s.class_id))} • ${(chapters || []).filter(c => c.subject_id === s.id).length} Chapters • ${myNotes.filter(n => n.subject_id === s.id).length + myMats.filter(m => m.subject_id === s.id).length} items</div></div></div>`;
      }).join("") || `<p class="muted">This class has no subjects yet.</p>`}</div>
    </div>
    ${isStaff() ? `
    <div class="card"><h3>➕ Add Note / Material</h3>
      <label>Type</label>
      <select id="n_kind"><option value="note">📗 Note (written / PDF)</option><option value="material">📕 Study Material (file / link)</option></select>
      <label>Title</label><input id="n_title" placeholder="e.g. Photosynthesis — Summary">
      <label>Class</label><select id="n_class">${myClasses.map(c => `<option value="${c.id}" ${c.id === studyClassId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <label>Subject</label><select id="n_subject"><option value="">— None —</option>${(subjects || []).map(s => `<option value="${s.id}">${esc(s.name)} (${esc(clsName(s.class_id))})</option>`).join("")}</select>
      <label>Chapter</label><select id="n_chapter"><option value="">— None —</option>${(chapters || []).map(ch => `<option value="${ch.id}">${esc(ch.name)}</option>`).join("")}</select>
      <div id="matKindWrap" class="hidden"><label>Material Type</label>
        <select id="n_matkind">${Object.keys(KIND_ICON).map(k => `<option value="${k}">${k}</option>`).join("")}</select></div>
      <label>Note text (only for a Note, may be left blank)</label><textarea id="n_body" placeholder="Write the note here…"></textarea>
      <label>File (PDF / image / doc) — or a link below</label><input id="n_file" type="file">
      <label>External link (video etc.)</label><input id="n_url" placeholder="https://…">
      <label>Status</label><select id="n_status"><option value="published">Published (visible to students)</option><option value="draft">Draft (staff only)</option></select>
      <div class="error" id="n_err"></div>
      <button class="gold" id="n_add" style="width:100%">Add</button>
    </div>` : ""}
    <div class="searchbar"><span>🔍</span><input id="studyQ" placeholder="Search by title or subject…" value="${esc(studyQuery)}"><button class="small gold" id="studyGo">Search</button></div>
    ${qLow ? `<div class="card" style="padding:12px 16px"><b>🔍 “${esc(studyQuery)}”</b> <span class="muted">— ${myNotes.length + myMats.length} results in total</span><button class="link" id="studyClear" style="float:right">✖ Clear search</button></div>` : ""}
    <div class="mtabs">
      ${[["all", "All"], ["notes", "📗 Notes"], ["pdfs", "📕 PDFs / Files"], ["videos", "🎬 Videos"]].map(([k, l]) =>
        `<button class="chip ${matFilter === k ? "on" : ""}" data-mf="${k}">${l}</button>`).join("")}
    </div>
    ${matFilter === "all" || matFilter === "notes" ? `
    <div class="card"><h3>📗 Notes (${myNotes.length})</h3>
      ${myNotes.map(n => itemCard(n, "note")).join("") || "<p>Notes for this class are coming soon.</p>"}</div>` : ""}
    ${matFilter !== "notes" ? `
    <div class="card"><h3>📚 Study Material (${dispMats.length})</h3>
      ${dispMats.map(m => itemCard(m, "material")).join("") || "<p>Material for this class is coming soon.</p>"}</div>` : ""}`;

  const noteById = (id) => (notes || []).find(n => n.id === id);
  const matById = (id) => (materials || []).find(m => m.id === id);
  $app.querySelectorAll("[data-cls]").forEach(b => b.onclick = () => { studyClassId = b.dataset.cls ? +b.dataset.cls : null; studyLesson = null; renderStudy(); });
  $app.querySelectorAll("[data-mf]").forEach(b => b.onclick = () => { matFilter = b.dataset.mf; studyLesson = null; renderStudy(); });
  const sq = document.getElementById("studyQ");
  const applyQ = () => { studyQuery = (sq?.value || "").trim(); renderStudy(); };
  document.getElementById("studyGo")?.addEventListener("click", applyQ);
  sq?.addEventListener("keydown", (e) => { if (e.key === "Enter") applyQ(); });
  document.getElementById("studyClear")?.addEventListener("click", () => { studyQuery = ""; renderStudy(); });
  $app.querySelectorAll("[data-lesson]").forEach(b => b.onclick = () => { studyLesson = +b.dataset.lesson; renderStudy(); });
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
      if (!title) { err.textContent = "Enter a title"; return; }
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
        toast("Added ✅"); renderStudy();
      } catch (e) { err.textContent = e.message; }
    };
  }
}

/* ---------------- Fees (student / parent section) ---------------- */
let feesTab = "monthly"; // v44: student fees tabs (monthly | history)
async function renderFeesStudent() {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
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

  // Student view — monthly fees screen (photo 8)
  if (profile.role !== "parent") {
    const HN = ["जनवरी", "फरवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];
    const EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const TYPE_HI = { monthly: "मासिक फ़ीस", yearly: "वार्षिक फ़ीस", admission: "प्रवेश फ़ीस", exam: "परीक्षा फ़ीस", other: "अन्य फ़ीस" };
    const pIdx = (r) => { const m = /^([A-Za-z]{3}) (\d{4})$/.exec((r.period || "").trim()); if (!m) return null; const i = EN.indexOf(m[1]); return i < 0 ? null : (+m[2]) * 12 + i; };
    const nowD = new Date(); const curIdx = nowD.getFullYear() * 12 + nowD.getMonth();
    const pillOf = (r) => {
      const amt = +r.amount, paid = +r.paid_amount;
      if (paid >= amt) return ["Paid • जमा", "green"];
      if (paid > 0) return ["Partial • आंशिक", "gold"];
      const pi = pIdx(r);
      if (pi !== null && pi > curIdx) return ["Upcoming • आगामी", "grey"];
      return ["Pending • बाकी", "red"];
    };
    const periodHi = (r) => { const pi = pIdx(r); return pi === null ? esc(r.period) : HN[pi % 12] + " " + Math.floor(pi / 12); };
    const nextDue = recs.filter(r => +r.amount - +r.paid_amount > 0 && r.due_date).sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))[0];
    const monthly = recs.filter(r => r.fee_type === "monthly").sort((a, b) => (pIdx(b) ?? -1) - (pIdx(a) ?? -1));
    const others = recs.filter(r => r.fee_type !== "monthly");
    const history = recs.filter(r => +r.paid_amount > 0).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const feeRow = (r) => {
      const [pl, pc] = pillOf(r); const bal = +r.amount - +r.paid_amount;
      return `<div class="item"><div style="display:flex; gap:10px; align-items:center">
          <div class="nicon" style="background:#e8f1fe">🗓️</div>
          <div><div class="t" style="font-size:14.5px">${r.fee_type === "monthly" ? periodHi(r) : esc(TYPE_HI[r.fee_type] || r.fee_type) + " • " + esc(r.period)}</div>
          <div class="s">${esc(TYPE_HI[r.fee_type] || "")} • ₹${(+r.amount).toLocaleString("en-IN")}${+r.paid_amount ? ` • जमा ₹${(+r.paid_amount).toLocaleString("en-IN")}` : ""}${bal > 0 ? ` • <b style="color:var(--bad)">बाकी ₹${bal.toLocaleString("en-IN")}</b>` : ""}${r.due_date ? ` • देय तिथि: ${new Date(r.due_date + "T00:00:00").toLocaleDateString("hi-IN", { day: "numeric", month: "short" })}` : ""}</div></div></div>
          <span class="pill ${pc}">${pl}</span></div>`;
    };
    $app.innerHTML = `
      <div class="card"><h3 style="margin-top:0">💰 फ़ीस विवरण • Fee Details</h3>
        <div class="s muted">कुल बकाया • Total Due</div>
        <div class="due-big" style="color:${totalDue > 0 ? "var(--bad)" : "var(--ok)"}">₹${totalDue.toLocaleString("en-IN")}</div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px">
          <span class="pill ${totalDue > 0 ? "red" : "green"}">${totalDue > 0 ? "Pending • बाकी है" : "सब जमा • All Clear 🎉"}</span>
          ${nextDue ? `<span class="s" style="font-weight:700">अगली देय तिथि: ${new Date(nextDue.due_date + "T00:00:00").toLocaleDateString("hi-IN", { day: "numeric", month: "long", year: "numeric" })}</span>` : ""}
        </div>
        <p class="muted" style="margin:10px 0 0">अब तक कुल जमा: ₹${totalPaid.toLocaleString("en-IN")} • ${recs.length} फ़ीस रिकॉर्ड</p>
      </div>
      <div class="seg-tabs">
        <button class="${feesTab === "monthly" ? "on" : ""}" data-ftab="monthly">Monthly Fees</button>
        <button class="${feesTab === "history" ? "on" : ""}" data-ftab="history">Payment History</button>
      </div>
      ${feesTab === "monthly" ? `
        <div class="card"><h3 style="margin-top:0">🗓️ मासिक फ़ीस • Monthly Fees</h3>
          ${monthly.map(feeRow).join("") || `<p class="muted" style="margin:0">अभी कोई मासिक फ़ीस रिकॉर्ड नहीं है।</p>`}
        </div>
        ${others.length ? `<div class="card"><h3 style="margin-top:0">🧾 अन्य फ़ीस • Other Fees</h3>${others.map(feeRow).join("")}</div>` : ""}`
      : `
        <div class="card"><h3 style="margin-top:0">💰 भुगतान इतिहास • Payment History</h3>
          ${history.map(r => `<div class="item"><div style="display:flex; gap:10px; align-items:center">
            <div class="nicon" style="background:#e0f5ec">💰</div>
            <div><div class="t" style="font-size:14.5px">₹${(+r.paid_amount).toLocaleString("en-IN")} जमा</div>
            <div class="s">${esc(TYPE_HI[r.fee_type] || r.fee_type)} • ${r.fee_type === "monthly" ? periodHi(r) : esc(r.period)} • ${new Date(r.updated_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}${+r.amount - +r.paid_amount > 0 ? ` • <b style="color:var(--bad)">₹${(+r.amount - +r.paid_amount).toLocaleString("en-IN")} बाकी</b>` : " • पूरी जमा ✅"}</div></div></div>
            <span class="pill ${+r.paid_amount >= +r.amount ? "green" : "gold"}">${+r.paid_amount >= +r.amount ? "Paid" : "Partial"}</span></div>`).join("") || `<p class="muted" style="margin:0">अभी कोई भुगतान दर्ज नहीं है।</p>`}
        </div>`}
      <div class="card"><h3 style="margin-top:0">ℹ️ फ़ीस कैसे जमा करें</h3>
        <p class="muted" style="margin:0">फ़ीस Academy कार्यालय (Manikpur, Gopalganj) में जमा करें। जमा होते ही रिकॉर्ड यहाँ दिखने लगेगा और रसीद कार्यालय से मिल जाएगी। Online payment की सुविधा अभी उपलब्ध नहीं है।</p>
      </div>`;
    $app.querySelectorAll("[data-ftab]").forEach(b => b.onclick = () => { feesTab = b.dataset.ftab; renderFeesStudent(); });
    return;
  }
  const byClass = {};
  recs.forEach(r => { (byClass[r.class_id || 0] = byClass[r.class_id || 0] || []).push(r); });

  $app.innerHTML = `
    <div class="card"><h3>💰 ${profile.role === "parent" ? "Children's Fees" : "My Fees"}</h3>
      <div class="stats">
        <div class="stat"><div class="si" style="background:#e2f4ec">✅</div><div class="n">₹${totalPaid.toLocaleString("en-IN")}</div><div class="l">Total Collected</div></div>
        <div class="stat"><div class="si" style="background:#fdecea">⏳</div><div class="n">₹${totalDue.toLocaleString("en-IN")}</div><div class="l">Total Due</div></div>
        <div class="stat"><div class="si" style="background:#e8f1fe">🧾</div><div class="n">${recs.length}</div><div class="l">Records</div></div>
      </div>
      ${totalDue > 0 ? `<p style="color:var(--bad); font-weight:700">⚠️ ₹${totalDue.toLocaleString("en-IN")} is due — please pay it at the academy.</p>` : `<p style="font-weight:700; color:var(--ok)">No dues 🎉</p>`}
    </div>
    ${Object.keys(byClass).length ? Object.entries(byClass).map(([cid, list]) => `
      <div class="card"><h3>🎓 ${esc(clsName(+cid))}</h3>
        ${list.map(r => `<div class="item"><div>
          <div class="t" style="font-size:14px">${esc(r.fee_type)} — ${esc(r.period)}${profile.role === "parent" ? ` • ${esc(nameOf(r.student_id))}` : ""}</div>
          <div class="s">₹${r.paid_amount} of ₹${r.amount} paid${r.due_date ? ` • Due date: ${esc(r.due_date)}` : ""}${+r.amount - +r.paid_amount > 0 ? ` • <b style="color:var(--bad)">Due ₹${+r.amount - +r.paid_amount}</b>` : ""}</div></div>
          <span class="pill ${r.status === "paid" ? "green" : r.status === "partial" ? "gold" : "red"}">${r.status}</span></div>`).join("")}
      </div>`).join("") : `<div class="card"><p class="muted">No fee records yet. When a fee is created, it will appear here.</p></div>`}`;
}

/* ---------------- Test Center ---------------- */
let run = null; // live attempt runtime

async function renderTests() {
  if (run) { renderRun(); return; }
  $app.innerHTML = `<div class="loading">Loading…</div>`;
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
        <div class="s">${esc((myClasses.find(c => c.id === t.class_id) || {}).name || "")} • ⏱ ${t.duration_minutes} min • ${t.total_marks} marks${t.instant_feedback ? " • ⚡ Practice Mode" : ""}${!t.max_attempts ? " • ♾️ Unlimited attempts" : ""}${+t.negative_marking ? ` • −${t.negative_marking} for a wrong answer` : ""}${submitted.length ? `<br>मेरा स्कोर: <b>${submitted[0].score}/${submitted[0].max_score}</b> (${submitted[0].percent}%) ${submitted[0].passed ? "✅ सफल • Pass" : "❌ असफल • Fail"}` : ""}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end">
        <span class="pill ${t.status === "published" ? "green" : "gold"}">${t.status === "published" ? "उपलब्ध • Live" : t.status === "draft" ? "ड्राफ़्ट • Draft" : esc(t.status)}</span>
        ${isStaff() ? `<div class="row" style="flex-wrap:nowrap">
            <button class="light small" data-tpreview="${t.id}">👁 Preview</button>
            <button class="light small" data-tinst="${t.id}:${t.instant_feedback ? 1 : 0}" title="Turn Practice Mode on/off">⚡ ${t.instant_feedback ? "ON" : "OFF"}</button>
            <button class="light small" data-tresults="${t.id}">Results</button>
            <button class="light small" data-tpub="${t.id}:${t.status}">${t.status === "published" ? "Make Draft" : "Publish"}</button>
            <button class="danger small" data-tdel="${t.id}">✕</button></div>`
          : t.status === "published" ? (live
            ? `<button class="gold small" data-tstart="${t.id}">▶ Continue</button>`
            : `${submitted.length ? `<button class="small" data-tresult="${submitted[0].id}:${t.id}">📊 View Result</button>` : ""}${(!t.max_attempts || submitted.length < t.max_attempts) ? `<button class="gold small" data-tstart="${t.id}">${submitted.length ? (t.max_attempts ? `🔁 Retake (${submitted.length}/${t.max_attempts})` : "🔁 Retake") : "▶ Start Test"}</button>` : ""}`) : ""}
      </div></div>`;
  };
  const groupedTests = () => {
    if (!tests || !tests.length) return `<div class="card"><p>No tests yet.</p></div>`;
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
      if (rest.length) html += `<details class="card" open><summary style="font-weight:900; color:var(--navy); font-size:16px; cursor:pointer">📚 Other Tests <span class="muted" style="font-weight:600">(${rest.length})</span></summary>${rest.map(testRow).join("")}</details>`;
      return html;
    }).join("");
  };

  $app.innerHTML = `
    ${isStaff() ? `
    <details class="card"><summary>➕ Create a New Test</summary>
      <label>Test Name</label><input id="t_title" placeholder="e.g. Science — Chapter 5 Test">
      <div class="row">
        <div><label>Class</label><select id="t_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
        <div><label>Time (minutes)</label><input id="t_dur" type="number" value="60" min="1"></div>
      </div>
      <div class="row">
        <div><label>Negative marking (per wrong answer)</label><input id="t_neg" type="number" value="0" min="0" step="0.25"></div>
        <div><label>Pass %</label><input id="t_pass" type="number" value="33" min="0" max="100"></div>
        <div><label>Attempts (0 = Unlimited)</label><input id="t_max" type="number" value="0" min="0"></div>
      </div>
      <label class="checkrow"><input type="checkbox" id="t_instant" checked><span><b>⚡ Practice Mode</b> — as soon as an option is chosen, the student sees correct/wrong + the explanation (the first click counts as the answer; it cannot be changed later)</span></label>
      <label>Choose Questions (from the Question Bank)</label>
      <div id="t_picker" style="max-height:260px; overflow:auto"></div>
      <div class="error" id="t_err"></div>
      <button class="gold" id="t_create" style="width:100%">Create Test (Draft)</button>
      <p class="muted">The test will first be created as a Draft — press Publish in the list to open it for students.</p>
    </details>` : ""}
    <div class="card"><h3>📝 ${isStaff() ? "All Tests" : "मेरे टेस्ट — My Tests"}</h3>
    <p class="muted" style="margin:0">${isStaff() ? "Tests are grouped by subject — open a subject to see its tests." : "टेस्ट विषय के हिसाब से दिए गए हैं — विषय खोलकर अपना टेस्ट चुनें।"}</p></div>
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
        <span><b>${esc(q.question_text.slice(0, 80))}</b><br><span class="muted">${esc(q.qtype)} • ${q.marks} marks</span></span></label>`).join("")
        : `<p class="muted">There are no questions in the Question Bank for this class — first add questions in Manage → Question Bank.</p>`;
    };
    classSel.onchange = drawPicker; drawPicker();
    document.getElementById("t_create").onclick = async () => {
      const err = document.getElementById("t_err"); err.textContent = "";
      const title = document.getElementById("t_title").value.trim();
      const picked = [...picker.querySelectorAll(".tq:checked")].map(x => +x.value);
      if (!title) { err.textContent = "Enter the test name"; return; }
      if (!picked.length) { err.textContent = "Choose at least one question"; return; }
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
        max_attempts: (() => { const v = document.getElementById("t_max").value.trim(); return v === "" ? 1 : Math.max(0, +v); })(),
        instant_feedback: document.getElementById("t_instant").checked,
        total_marks: total, status: "draft",
      }).select().single();
      if (error) { err.textContent = error.message; return; }
      const { error: e2 } = await sb.from("test_questions").insert(picked.map((qid, i) => ({ test_id: t.id, question_id: qid, sort_order: i + 1 })));
      if (e2) { err.textContent = e2.message; return; }
      toast("Test created 📝 — now Publish it"); renderTests();
    };
    $app.querySelectorAll("[data-tpub]").forEach(b => b.onclick = async () => {
      const [id, st] = b.dataset.tpub.split(":");
      const publishing = st !== "published";
      const { error } = await sb.from("tests").update({ status: publishing ? "published" : "draft" }).eq("id", +id);
      if (error) return toast("Error: " + error.message);
      if (publishing) {
        const t = (tests || []).find(x => x.id === +id);
        if (t) await notifyClassStudents(t.class_id, "test", "📝 New Test: " + t.title, "A new test has started — go to the Tests section and take it.");
      }
      renderTests();
    });
    $app.querySelectorAll("[data-tdel]").forEach(b => b.onclick = async () => {
      if (!confirm("This test and all its results will be deleted. Are you sure?")) return;
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
      toast(on === "1" ? "⚡ Practice Mode off — answers will be shown after submission" : "⚡ Practice Mode on — the answer shows as soon as an option is chosen");
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
  host.innerHTML = `<div class="card"><div class="loading">Loading results…</div></div>`;
  const [{ data: attempts }, { data: studs }, { data: testRow }] = await Promise.all([
    sb.from("test_attempts").select("*").eq("test_id", testId).order("percent", { ascending: false }),
    sb.from("profiles").select("id,full_name").eq("role", "student"),
    sb.from("tests").select("title").eq("id", testId).maybeSingle(),
  ]);
  const nameOf = (id) => (studs || []).find(s => s.id === id)?.full_name || "Student";
  const testTitle = testRow?.title || "Test";
  const resStatus = (a) => a.status === "in_progress" ? "In Progress" : (a.passed ? "Pass" : "Fail");
  host.innerHTML = `<div class="card pol-sec v45rows">
    <div class="v45-head"><h3>🏆 Results • परिणाम — ${esc(testTitle)}</h3>
      <span style="display:flex; gap:6px"><button class="light small" id="resCsvBtn">⬇ CSV Download</button><button class="light small" id="resPrintBtn">🖨 Print</button></span></div>
    ${(attempts && attempts.length) ? attempts.map(a => `<div class="item"><div>
      <div class="t">${esc(nameOf(a.student_id))}</div>
      <div class="s">${a.status === "in_progress" ? "⏳ Test in progress" : `${new Date(a.submitted_at).toLocaleString("en-IN")} • ${Math.round((a.time_taken_seconds || 0) / 60)} min`}</div></div>
      ${a.status === "in_progress" ? `<span class="pill gold">LIVE</span>` : `<span class="pill ${a.passed ? "green" : "red"}">${a.score}/${a.max_score} • ${a.percent}%</span>`}
    </div>`).join("") : `<p>No student has taken this test yet.</p>`}
  </div>`;
  document.getElementById("resCsvBtn").onclick = () => {
    const done = (attempts || []).filter(a => a.status !== "in_progress");
    if (!done.length) return toast("No completed results to download");
    downloadCSV("test-results.csv", ["Student", "Test", "Score", "Max Score", "%", "Status", "Submitted", "Time (min)"],
      done.map(a => [nameOf(a.student_id), testTitle, a.score, a.max_score, a.percent, resStatus(a), a.submitted_at ? new Date(a.submitted_at).toLocaleString("en-IN") : "", Math.round((a.time_taken_seconds || 0) / 60)]));
    toast("CSV downloaded ⬇");
  };
  document.getElementById("resPrintBtn").onclick = () => {
    const done = (attempts || []).filter(a => a.status !== "in_progress");
    if (!done.length) return toast("No completed results to print");
    let area = document.getElementById("printArea");
    if (!area) { area = document.createElement("div"); area.id = "printArea"; document.body.appendChild(area); }
    area.innerHTML = `<div class="pq">
      <div class="pq-head"><div class="pq-name">TARGET ACADEMY COACHING CENTRE</div>
        <div class="pq-sub">Manikpur, Gopalganj (Bihar)</div>
        <div class="pq-title">🏆 Test Results — ${esc(testTitle)}</div></div>
      <table><tr><th>#</th><th>Student</th><th>Score</th><th>%</th><th>Status</th><th>Submitted</th></tr>
      ${done.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(nameOf(a.student_id))}</td><td>${a.score}/${a.max_score}</td><td>${a.percent}%</td><td>${resStatus(a)}</td><td>${a.submitted_at ? new Date(a.submitted_at).toLocaleString("en-IN") : ""}</td></tr>`).join("")}
      </table>
      <p class="pq-sub" style="margin-top:10px">Total students: ${done.length} • Printed: ${new Date().toLocaleString("en-IN")}</p>
    </div>`;
    document.body.classList.add("printmode");
    window.print();
    setTimeout(() => document.body.classList.remove("printmode"), 600);
  };
  host.scrollIntoView({ behavior: "smooth" });
}

/* ----- Staff preview of a test (questions + answers, no attempt created) ----- */
async function previewTest(test) {
  if (!test) return;
  $app.innerHTML = `<div class="loading">Opening the test…</div>`;
  curView = "preview"; hidePageHead();
  try { history.pushState({ view: "preview" }, ""); } catch (e) {}
  const { data: tqs } = await sb.from("test_questions").select("question_id, sort_order").eq("test_id", test.id).order("sort_order");
  const ids = (tqs || []).map(x => x.question_id);
  if (!ids.length) { $app.innerHTML = `<div class="card"><p>This test has no questions yet.</p><button class="light" id="pv_back">← Back to Tests</button></div>`; document.getElementById("pv_back").onclick = () => { tab = "tests"; renderShell(); }; return; }
  const { data: qs } = await sb.from("questions").select("*").in("id", ids);
  const byId = {}; (qs || []).forEach(q => byId[q.id] = q);
  const ordered = ids.map(id => byId[id]).filter(Boolean);
  $app.innerHTML = `
    <div class="card">
      <button class="light small" id="pv_back">← Back to Tests</button>
      <h3 style="margin-top:10px">👁 ${esc(test.title)}</h3>
      <p class="muted">${esc((myClasses.find(c => c.id === test.class_id) || {}).name || "")} • ⏱ ${test.duration_minutes} min • ${test.total_marks} marks • ${ordered.length} questions • ${esc(test.status)}</p>
      <p class="muted">This is for checking only — no attempt is created here and no result is saved. The correct answer is shown in green.</p>
    </div>
    ${ordered.map((q, i) => {
      const opts = Array.isArray(q.options) ? q.options : [];
      const corr = Array.isArray(q.correct_answer) ? q.correct_answer.map(String) : [];
      return `<div class="card">
        <div class="t">Question ${i + 1}. ${esc(q.question_text)}</div>
        <div class="s">${esc(q.qtype)} • ${q.marks} marks</div>
        ${opts.length ? opts.map(o => `<div style="margin-top:8px; padding:10px 12px; border-radius:10px; border:1.5px solid ${corr.includes(String(o.key)) ? "var(--green, #1a9e54)" : "#e3e8f2"}; background:${corr.includes(String(o.key)) ? "#e9f9f0" : "#fff"}"><b>${esc(o.key)}.</b> ${esc(o.text)} ${corr.includes(String(o.key)) ? "✅" : ""}</div>`).join("")
          : (corr.length ? `<div style="margin-top:8px; padding:10px 12px; border-radius:10px; background:#e9f9f0; border:1.5px solid var(--green, #1a9e54)"><b>Answer:</b> ${esc(corr.join(", "))}</div>` : "")}
        ${q.explanation ? `<p class="muted" style="margin-top:8px">💡 ${esc(q.explanation)}</p>` : ""}
      </div>`;
    }).join("")}
    <div class="card"><button class="light" id="pv_back2" style="width:100%">← Back to Tests</button></div>`;
  document.getElementById("pv_back").onclick = () => { tab = "tests"; renderShell(); };
  document.getElementById("pv_back2").onclick = () => { tab = "tests"; renderShell(); };
  window.scrollTo({ top: 0 });
}

/* ----- Taking a test ----- */
/* Shuffle (v50, owner's order): every attempt gets its own question order and
   option order. Seeded by the attempt id, so resuming the SAME attempt keeps
   the same arrangement, while every new attempt is arranged differently.
   Options keep their original keys, so saved answers and scoring are unaffected;
   only the display order (and the letter badge, which follows position) changes. */
function attemptRng(seed) {
  let t = (Number(seed) || 1) >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleArr(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function shuffleForAttempt(qs, attemptId) {
  const rnd = attemptRng((Number(attemptId) * 2654435761) % 4294967296 || 1);
  const out = (qs || []).map(q => {
    const c = { ...q };
    if (Array.isArray(q.options) && q.options.length > 1 &&
        (q.qtype === "mcq_single" || q.qtype === "mcq_multi" || q.qtype === "true_false")) {
      c.options = shuffleArr(q.options, rnd);
    }
    return c;
  });
  const keyOf = (q) => isMatchQ(q) ? "match"
    : (q.qtype === "mcq_single" || q.qtype === "mcq_multi") ? "mcq"
    : q.qtype === "fill_blank" ? "fill"
    : q.qtype === "true_false" ? "tf" : "short";
  const res = [];
  let i = 0;
  while (i < out.length) {
    let j = i;
    while (j < out.length && keyOf(out[j]) === keyOf(out[i])) j++;
    res.push(...shuffleArr(out.slice(i, j), rnd));
    i = j;
  }
  return res;
}
async function startTest(test, myAttempts) {
  let attempt = (myAttempts || []).find(a => a.status === "in_progress");
  if (!attempt) {
    const doneCount = (myAttempts || []).filter(a => a.status !== "in_progress").length;
    if (test.max_attempts && doneCount >= test.max_attempts) return toast("All attempts for this test are used up");
    const { data, error } = await sb.from("test_attempts").insert({ test_id: test.id, student_id: me.id }).select().single();
    if (error) return toast("Error: " + error.message);
    attempt = data;
  }
  const { data: qs, error } = await sb.rpc("get_test_questions", { p_test_id: test.id });
  if (error) return toast("Questions not found: " + error.message);
  const { data: saved } = await sb.from("attempt_responses").select("*").eq("attempt_id", attempt.id);
  let subjName = "";
  if (test.subject_id) {
    const { data: sj } = await sb.from("subjects").select("name, name_hi").eq("id", test.subject_id).maybeSingle();
    if (sj) subjName = sj.name + (sj.name_hi ? " • " + sj.name_hi : "");
  }
  run = {
    test, attempt, qs: shuffleForAttempt(qs || [], attempt.id), idx: 0, screen: "run", subjName,
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
  curView = "run"; hidePageHead();
  try { history.pushState({ view: "run" }, ""); } catch (e) {}
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
function runAnsweredCount() {
  if (!run) return 0;
  return run.qs.filter(x => {
    const a = run.answers.get(x.question_id);
    return a !== undefined && a !== null && a[0] !== undefined && a[0] !== null && String(a[0]).trim() !== "";
  }).length;
}
function updateRunMeta() {
  if (!run) return;
  const n = runAnsweredCount(), total = run.qs.length;
  const c = document.getElementById("runCount");
  if (c) c.textContent = `${n} of ${total} answered`;
  const pos = document.getElementById("runPos");
  if (pos) pos.textContent = `प्रश्न ${run.idx + 1} / ${total}`;
  const bar = document.getElementById("runProg");
  if (bar) bar.style.width = (total ? ((run.idx + 1) / total) * 100 : 0) + "%";
}
function qAnswered(q) {
  const a = run.answers.get(q.question_id);
  return a !== undefined && a !== null && a[0] !== undefined && a[0] !== null && String(a[0]).trim() !== "";
}
function palGridHTML() {
  return `<div class="pal-grid">${run.qs.map((q, i) => {
    const cls = ["pal-btn", qAnswered(q) ? "ans" : "", run.review.has(q.question_id) ? "mk" : "", i === run.idx ? "cur" : ""].join(" ");
    return `<button class="${cls}" data-pal="${i}">${i + 1}${run.review.has(q.question_id) ? `<span class="pal-dot"></span>` : ""}</button>`;
  }).join("")}</div>
  <div class="pal-legend">
    <span><i class="lg ans"></i>उत्तर दिया</span>
    <span><i class="lg mk"></i>चिह्नित</span>
    <span><i class="lg cur"></i>वर्तमान प्रश्न</span>
    <span><i class="lg"></i>बाकी</span>
  </div>`;
}
function flushCurrentInput() {
  if (!run) return;
  const q = run.qs[run.idx];
  if (!q) return;
  const inp = document.querySelector(`[data-fillq="${q.question_id}"], [data-textq="${q.question_id}"]`);
  if (inp) {
    const cur = (run.answers.get(q.question_id) || [])[0];
    if (String(inp.value ?? "") !== String(cur ?? "")) onTextAnswer(q.question_id, inp.value);
  }
}
function goQ(i) {
  if (!run) return;
  flushCurrentInput();
  run.idx = Math.max(0, Math.min(run.qs.length - 1, i));
  run.screen = "run";
  renderRun();
  window.scrollTo({ top: 0 });
}
function confirmSubmit() {
  if (!run) return;
  const n = runAnsweredCount(), total = run.qs.length;
  if (confirm(`Submit the test?\n\nAnswered: ${n} of ${total}${n < total ? `\n⚠️ ${total - n} question(s) are still unanswered.` : ""}\n\nYou will not be able to change answers after this.`)) finishTest(false);
}
const MATCH_PREFIX = "Match the following";
function isMatchQ(q) { return q.qtype === "mcq_single" && (q.question_text || "").startsWith(MATCH_PREFIX); }
function matchLabel(q) {
  const t = q.question_text || "";
  const m = t.match(/[“"]([^”"]+)[”"]/);
  if (m) return m[1];
  return t.replace(/^Match the following\s*[—–-]?\s*/, "").replace(/\s*matches with:?\s*$/i, "");
}
function qSections() {
  const secs = [];
  let cur = null;
  const push = (kind, label, q) => {
    if (!cur || cur.kind !== kind) { cur = { kind, label, items: [] }; secs.push(cur); }
    cur.items.push(q);
  };
  for (const q of run.qs) {
    if (isMatchQ(q)) push("match", "🔗 Match the Following", q);
    else if (q.qtype === "mcq_single" || q.qtype === "mcq_multi") push("mcq", "✏️ Multiple Choice — Tick the correct option", q);
    else if (q.qtype === "fill_blank") push("fill", "✍️ Fill in the Blanks", q);
    else if (q.qtype === "true_false") push("tf", "✔️ True or False", q);
    else push("short", "📝 Short Questions — Answer in brief", q);
  }
  return secs;
}
function explHTML(fb) {
  return `<div class="expl-box">${fb.is_correct ? "✅ <b>Correct answer!</b> Very good 🎉" : "❌ <b>Wrong answer</b> — the correct answer is shown in green above."}${fb.explanation ? `<br>💡 <b>Explanation:</b> ${esc(fb.explanation)}` : ""}</div>`;
}
function qBlockHTML(q, n) {
  const fb = (run.test.instant_feedback && run.feedback) ? run.feedback.get(q.question_id) : null;
  const cur = (run.answers.get(q.question_id) || [])[0];
  const opts = Array.isArray(q.options) ? q.options : [];
  if (q.qtype === "mcq_single" || q.qtype === "mcq_multi" || q.qtype === "true_false") {
    const keyLabel = (o, oi) => esc(o.key === "true" ? "✓" : o.key === "false" ? "✗" : ("ABCDEFGH"[oi] || o.key));
    let body;
    if (fb) {
      const rightKey = Array.isArray(fb.correct_answer) ? String(fb.correct_answer[0]) : null;
      body = `<div class="${q.qtype === "true_false" ? "tfrow" : ""}">` + opts.map((o, oi) => `<button class="option ${String(o.key) === rightKey ? "right" : String(cur) === String(o.key) ? "wrong" : ""}" disabled><span class="k">${keyLabel(o, oi)}</span>${esc(o.text)}</button>`).join("") + `</div>` + explHTML(fb);
    } else {
      body = `<div class="${q.qtype === "true_false" ? "tfrow" : ""}">` + opts.map((o, oi) => `<button class="option ${String(cur) === String(o.key) ? "sel" : ""}" data-optq="${q.question_id}" data-opt="${esc(o.key)}"><span class="k">${keyLabel(o, oi)}</span>${esc(o.text)}</button>`).join("") + `</div>`;
    }
    return `<div class="qblock" id="qq-${q.question_id}" data-n="${n}"><div class="qline"><span class="qno">${n}.</span> ${esc(q.question_text)} <span class="qmarks">[${q.marks}]</span></div>${body}</div>`;
  }
  if (q.qtype === "fill_blank") {
    const parts = String(q.question_text).split(/_____+/);
    const sentence = parts.map(p => esc(p)).join(`<input class="blank-in" data-fillq="${q.question_id}" value="${esc(cur ?? "")}" placeholder="……">`);
    return `<div class="qblock" id="qq-${q.question_id}" data-n="${n}"><div class="qline"><span class="qno">${n}.</span> ${sentence} <span class="qmarks">[${q.marks}]</span></div></div>`;
  }
  return `<div class="qblock" id="qq-${q.question_id}" data-n="${n}"><div class="qline"><span class="qno">${n}.</span> ${esc(q.question_text)} <span class="qmarks">[${q.marks}]</span></div>
    <textarea data-textq="${q.question_id}" placeholder="Write your answer here">${esc(cur ?? "")}</textarea>
    <p class="muted" style="margin:4px 0 0">The teacher will check this answer.</p></div>`;
}
function matchRowHTML(q, n) {
  const fb = (run.test.instant_feedback && run.feedback) ? run.feedback.get(q.question_id) : null;
  const cur = (run.answers.get(q.question_id) || [])[0];
  const opts = Array.isArray(q.options) ? q.options : [];
  return `<div class="qblock mrow" id="qq-${q.question_id}" data-n="${n}">
    <div class="mlabel"><span class="qno">${n}.</span> ${esc(matchLabel(q))}</div>
    <select data-matchq="${q.question_id}" class="${fb ? (fb.is_correct ? "mok" : "mbad") : ""}" ${fb ? "disabled" : ""}>
      <option value="">Choose</option>
      ${opts.map((o, oi) => `<option value="${esc(o.key)}" ${String(cur) === String(o.key) ? "selected" : ""}>(${"abcdefgh"[oi] || esc(String(o.key).toLowerCase())}) ${esc(o.text)}</option>`).join("")}
    </select>
    ${fb ? explHTML(fb) : ""}
  </div>`;
}
function bindBlockEl(el, q) {
  if (!el) return;
  el.querySelectorAll("[data-optq]").forEach(b => b.onclick = () => onPickOption(q.question_id, b.dataset.opt));
  el.querySelectorAll("[data-fillq]").forEach(inp => inp.onchange = () => onTextAnswer(q.question_id, inp.value));
  el.querySelectorAll("[data-textq]").forEach(inp => inp.onchange = () => onTextAnswer(q.question_id, inp.value));
  el.querySelectorAll("[data-matchq]").forEach(sel => sel.onchange = () => onPickOption(q.question_id, sel.value || null));
}
function refreshQBlock(q) {
  const host = document.getElementById("qq-" + q.question_id);
  if (!host) return;
  const n = +(host.dataset.n || 1);
  const tmp = document.createElement("div");
  tmp.innerHTML = isMatchQ(q) ? matchRowHTML(q, n) : qBlockHTML(q, n);
  const fresh = tmp.firstElementChild;
  host.replaceWith(fresh);
  bindBlockEl(fresh, q);
}
async function onPickOption(qid, key) {
  if (!run) return;
  const q = run.qs.find(x => x.question_id === qid);
  if (!q) return;
  if (run.test.instant_feedback) {
    if (key === null) return;
    if (run.answers.has(qid) && run.answers.get(qid) !== null) return; // first answer locks
    run.answers.set(qid, [key]);
    await saveAnswer(qid);
    const { data } = await sb.rpc("reveal_answer", { p_attempt_id: run.attempt.id, p_question_id: qid });
    if (data && data[0]) run.feedback.set(qid, data[0]);
    refreshQBlock(q);
    updateRunMeta();
    return;
  }
  if (key === null || String((run.answers.get(qid) || [])[0]) === String(key)) run.answers.delete(qid);
  else run.answers.set(qid, [key]);
  await saveAnswer(qid);
  refreshQBlock(q);
  updateRunMeta();
}
async function onTextAnswer(qid, value) {
  if (!run) return;
  const v = value ?? "";
  if (String(v).trim() === "") run.answers.delete(qid); else run.answers.set(qid, [v]);
  await saveAnswer(qid);
  updateRunMeta();
}
function runHeadHTML() {
  const { test, qs } = run;
  return `<div class="card run-head">
      <div class="run-head-top">
        <div style="flex:1; min-width:0">
          <div class="run-title">${esc(test.title)}</div>
          <div class="run-meta">${run.subjName ? esc(run.subjName) + " • " : ""}${qs.length} प्रश्न • ${test.duration_minutes} मिनट${test.instant_feedback ? " • ⚡ Practice Mode" : ""}</div>
        </div>
        <span class="timer-pill" id="tTimer">⏱ --:--</span>
      </div>
      <div class="run-prog-row"><span id="runPos">प्रश्न ${run.idx + 1} / ${qs.length}</span><span class="run-cnt" id="runCount"></span></div>
      <div class="prog prog-thin"><div id="runProg"></div></div>
    </div>`;
}
function renderRun() {
  if (run.screen === "review") { renderRunReview(); return; }
  const { test, qs } = run;
  const total = qs.length;
  const q = qs[run.idx];
  const n = run.idx + 1;
  const block = isMatchQ(q) ? matchRowHTML(q, n) : qBlockHTML(q, n);
  const last = run.idx === total - 1;
  $app.innerHTML = `
    ${runHeadHTML()}
    <div class="card qcard">
      <p class="muted run-hint">${test.instant_feedback
        ? "⚡ <b>Practice Mode:</b> उत्तर चुनते ही ✅ सही / ❌ गलत + व्याख्या यहीं दिखेगी और वह उत्तर lock हो जाएगा। Fill-in और लिखित उत्तर लिखते ही save हो जाते हैं।"
        : "उत्तर अपने आप save होते रहते हैं। ✅ सही / ❌ गलत और 💡 व्याख्या Submit करने के बाद परिणाम में दिखेगी।"}</p>
      ${block}
      <label class="checkrow markrow"><input type="checkbox" id="markRev" ${run.review.has(q.question_id) ? "checked" : ""}><span>Mark for Review</span></label>
    </div>
    <div class="run-nav">
      <button class="light" id="qPrev" ${run.idx === 0 ? "disabled" : ""}>← Back</button>
      <button class="light" id="qPal">🔢 Question List</button>
      ${last ? `<button class="gold" id="qReview">Review →</button>` : `<button class="gold" id="qNext">Next →</button>`}
    </div>
    <div class="pal-overlay hidden" id="palOverlay">
      <div class="pal-sheet">
        <div class="pal-head"><b>🔢 सभी प्रश्न — Question List</b><button class="light small" id="palClose">✕ Close</button></div>
        <div id="palGrid">${palGridHTML()}</div>
        <button class="gold" id="palReview" style="width:100%; margin-top:14px">📋 Review & Submit Test</button>
      </div>
    </div>`;
  bindBlockEl(document.getElementById("qq-" + q.question_id), q);
  document.getElementById("markRev").onchange = async (e) => {
    if (e.target.checked) run.review.add(q.question_id); else run.review.delete(q.question_id);
    await saveAnswer(q.question_id);
  };
  const prev = document.getElementById("qPrev");
  if (prev) prev.onclick = () => goQ(run.idx - 1);
  const next = document.getElementById("qNext");
  if (next) next.onclick = () => goQ(run.idx + 1);
  const rev = document.getElementById("qReview");
  if (rev) rev.onclick = () => { flushCurrentInput(); run.screen = "review"; renderRun(); window.scrollTo({ top: 0 }); };
  const ov = document.getElementById("palOverlay");
  const bindPal = () => ov.querySelectorAll("[data-pal]").forEach(b => b.onclick = () => goQ(+b.dataset.pal));
  bindPal();
  document.getElementById("qPal").onclick = () => {
    document.getElementById("palGrid").innerHTML = palGridHTML();
    bindPal();
    ov.classList.remove("hidden");
  };
  document.getElementById("palClose").onclick = () => ov.classList.add("hidden");
  ov.onclick = (e) => { if (e.target === ov) ov.classList.add("hidden"); };
  document.getElementById("palReview").onclick = () => { flushCurrentInput(); run.screen = "review"; renderRun(); window.scrollTo({ top: 0 }); };
  updateRunMeta();
  tickTimer();
}
function renderRunReview() {
  const { qs } = run;
  const total = qs.length;
  const ans = runAnsweredCount();
  const mk = run.review.size;
  $app.innerHTML = `
    ${runHeadHTML()}
    <div class="card">
      <h3 style="margin-top:0">📋 समीक्षा — Review</h3>
      <div class="stats rev-stats">
        <div class="stat"><div class="n">${total}</div><div class="l">कुल प्रश्न</div></div>
        <div class="stat"><div class="n">${ans}</div><div class="l">उत्तर दिए</div></div>
        <div class="stat"><div class="n">${total - ans}</div><div class="l">बचे हुए</div></div>
        <div class="stat"><div class="n">${mk}</div><div class="l">चिह्नित</div></div>
      </div>
      <div id="palGrid">${palGridHTML()}</div>
      <p class="muted">किसी नंबर पर tap करके उस प्रश्न पर वापस जा सकते हैं।</p>
      <button class="gold" id="finalSubmit" style="width:100%">✅ Submit Test</button>
      <button class="light" id="backToQ" style="width:100%; margin-top:8px">← Back to Questions</button>
      <p class="muted" style="text-align:center; margin:8px 0 0">जमा करने के बाद उत्तर बदले नहीं जा सकेंगे।</p>
    </div>`;
  $app.querySelectorAll("[data-pal]").forEach(b => b.onclick = () => goQ(+b.dataset.pal));
  document.getElementById("finalSubmit").onclick = () => confirmSubmit();
  document.getElementById("backToQ").onclick = () => { run.screen = "run"; renderRun(); window.scrollTo({ top: 0 }); };
  tickTimer();
}
async function finishTest(auto) {
  if (!run) return;
  const { attempt, test } = run;
  clearInterval(run.timer);
  const { data, error } = await sb.rpc("submit_attempt", { p_attempt_id: attempt.id });
  run = null;
  if (error) { toast("Problem submitting: " + error.message); tab = "tests"; renderShell(); return; }
  if (auto) toast("⏰ Time's up — the test was submitted automatically");
  showResult(data.id, test);
}

/* ----- Result + review ----- */
function reviewRowHTML(r) {
  const mine = Array.isArray(r.my_answer) ? r.my_answer[0] : null;
  const right = Array.isArray(r.correct_answer) ? r.correct_answer[0] : null;
  const opts = Array.isArray(r.options) ? r.options : [];
  return `<div style="padding:14px 0; border-bottom:1px solid var(--line)">
    <div style="font-weight:700">Q${r._i + 1}. ${esc(r.question_text)}</div>
    <div style="margin-top:6px">
      ${r.is_correct === null ? `<span class="pill gold">Teacher will check</span>` : r.is_correct ? `<span class="pill green">✅ Correct • +${r.marks_awarded} marks</span>` : `<span class="pill red">❌ Wrong • ${r.marks_awarded} marks</span>`}
    </div>
    ${opts.length ? opts.map(o => `<div class="option ${String(o.key) === String(right) ? "right" : String(o.key) === String(mine) ? "wrong" : ""}" style="cursor:default"><span class="k">${esc(o.key)}</span>${esc(o.text)}</div>`).join("")
      : `<div class="s" style="margin-top:6px">Your answer: <b>${mine === null || mine === undefined ? "— (not given)" : esc(mine)}</b><br>Correct answer: <b>${esc(right ?? "—")}</b></div>`}
    ${r.explanation ? `<div class="expl-box">💡 <b>Explanation:</b> ${esc(r.explanation)}</div>` : ""}
  </div>`;
}
function drawReview() {
  const box = document.getElementById("revBox");
  if (!box || !revState) return;
  const { rows } = revState;
  const f = revState.filter;
  const filtered = rows.filter(r => f === "all" ? true : f === "right" ? r.is_correct === true : f === "wrong" ? r.is_correct === false : r.is_correct === null);
  const pages = Math.max(1, Math.ceil(filtered.length / REV_PAGE));
  if (revState.page >= pages) revState.page = pages - 1;
  if (revState.page < 0) revState.page = 0;
  const slice = filtered.slice(revState.page * REV_PAGE, revState.page * REV_PAGE + REV_PAGE);
  const cnt = (fn) => rows.filter(fn).length;
  box.innerHTML = `
    <div class="card"><h3>📖 Review Answers</h3>
      <div class="mtabs">
        <button class="chip ${f === "all" ? "on" : ""}" data-rf="all">All (${rows.length})</button>
        <button class="chip ${f === "right" ? "on" : ""}" data-rf="right">✅ Correct (${cnt(r => r.is_correct === true)})</button>
        <button class="chip ${f === "wrong" ? "on" : ""}" data-rf="wrong">❌ Wrong (${cnt(r => r.is_correct === false)})</button>
        ${cnt(r => r.is_correct === null) ? `<button class="chip ${f === "pending" ? "on" : ""}" data-rf="pending">⏳ Checking Pending (${cnt(r => r.is_correct === null)})</button>` : ""}
      </div>
      ${slice.map(reviewRowHTML).join("") || `<p class="muted">No questions in this filter.</p>`}
      <div class="row" style="margin-top:12px; justify-content:space-between; align-items:center">
        <button class="light" data-rp="-1" ${revState.page === 0 ? "disabled" : ""}>← Previous</button>
        <span class="muted">Page ${revState.page + 1} / ${pages} • ${filtered.length} questions</span>
        <button class="light" data-rp="1" ${revState.page >= pages - 1 ? "disabled" : ""}>Next →</button>
      </div>
    </div>`;
  box.querySelectorAll("[data-rf]").forEach(b => b.onclick = () => { revState.filter = b.dataset.rf; revState.page = 0; drawReview(); });
  box.querySelectorAll("[data-rp]").forEach(b => b.onclick = () => { revState.page += +b.dataset.rp; drawReview(); box.scrollIntoView({ behavior: "smooth", block: "start" }); });
}
async function showResult(attemptId, test) {
  tab = "tests";
  curView = "result"; hidePageHead();
  try { history.pushState({ view: "result" }, ""); } catch (e) {}
  $app.innerHTML = `<div class="loading">Loading result…</div>`;
  $tabbar.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.tab === "tests"));
  const { data: attempt } = await sb.from("test_attempts").select("*").eq("id", attemptId).single();
  const { data: review, error } = await sb.rpc("get_attempt_review", { p_attempt_id: attemptId });
  let myTestAttempts = [];
  if (test && !isStaff()) {
    const { data: atts } = await sb.from("test_attempts").select("*").eq("test_id", test.id).eq("student_id", me.id).order("started_at", { ascending: false });
    myTestAttempts = atts || [];
  }
  const submittedCount = myTestAttempts.filter(a => a.status !== "in_progress").length;
  const canRestart = !!test && !isStaff() && (!test.max_attempts || submittedCount < test.max_attempts);
  revState = error ? null : { rows: (review || []).map((r, i) => ({ ...r, _i: i })), filter: "all", page: 0 };
  let resSubj = "";
  if (test && test.subject_id) {
    const { data: sj } = await sb.from("subjects").select("name, name_hi").eq("id", test.subject_id).maybeSingle();
    if (sj) resSubj = sj.name + (sj.name_hi ? " • " + sj.name_hi : "");
  }
  const resClass = test ? ((myClasses.find(c => c.id === test.class_id) || {}).name || "") : "";
  let cntR = null;
  if (revState) {
    const rows = revState.rows;
    const given = (r) => { const a = Array.isArray(r.my_answer) ? r.my_answer[0] : r.my_answer; return a !== null && a !== undefined && String(a).trim() !== ""; };
    cntR = {
      right: rows.filter(r => r.is_correct === true).length,
      wrong: rows.filter(r => r.is_correct === false).length,
      skip: rows.filter(r => !given(r)).length,
      pend: rows.filter(r => r.is_correct === null && given(r)).length,
    };
  }
  const fmtDur43 = (s) => { s = Math.max(0, Math.round(+s || 0)); const m = Math.floor(s / 60), ss = s % 60; return m ? (ss ? `${m} मिनट ${ss} सेकंड` : `${m} मिनट`) : `${ss} सेकंड`; };
  const pct = attempt ? +attempt.percent || 0 : 0;
  const C = 2 * Math.PI * 44;
  $app.innerHTML = `
    <div class="card">
      <div class="ring-wrap" style="flex-wrap:wrap">
        <div class="trophy-c ${attempt?.passed ? "" : "fail"}">${attempt?.passed ? "🏆" : "💪"}</div>
        <div style="flex:1; min-width:170px">
          <h3 style="margin:0 0 4px">${attempt?.passed ? "आप सफल रहे! 🎉" : "इस बार सफल नहीं हुए"}</h3>
          <div style="font-size:27px; font-weight:900; color:var(--navy)">${attempt?.score} / ${attempt?.max_score} <span style="font-size:14px; color:var(--muted)">नंबर</span></div>
          <p class="muted" style="margin:2px 0 0">${attempt?.passed ? "बहुत बढ़िया! ऐसे ही मेहनत जारी रखें।" : "कोई बात नहीं — सभी उत्तर देखकर सीखें और फिर प्रयास करें।"}</p>
        </div>
        <div class="ring">
          <svg width="104" height="104"><circle cx="52" cy="52" r="44" stroke="#e6ecf6" stroke-width="10" fill="none"/>
          <circle cx="52" cy="52" r="44" stroke="${attempt?.passed ? "#0e9f6e" : "#d64541"}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C - (C * pct) / 100}"/></svg>
          <div class="ring-c">${pct}%<br><span style="font-size:11px; color:var(--muted)">${attempt?.passed ? "PASS ✅" : "FAIL ❌"}</span></div>
        </div>
      </div>
    </div>
    <div class="card"><h3 style="margin-top:0">📋 टेस्ट का विवरण</h3>
      <div class="drow"><span class="dl">टेस्ट का नाम</span><span class="dv">${esc(test ? test.title : "Test Result")}</span></div>
      ${resClass ? `<div class="drow"><span class="dl">कक्षा</span><span class="dv">${esc(resClass)}</span></div>` : ""}
      ${resSubj ? `<div class="drow"><span class="dl">विषय</span><span class="dv">${esc(resSubj)}</span></div>` : ""}
      ${attempt?.time_taken_seconds ? `<div class="drow"><span class="dl">समय लगा</span><span class="dv">${fmtDur43(attempt.time_taken_seconds)}</span></div>` : ""}
      ${attempt?.submitted_at ? `<div class="drow"><span class="dl">तारीख़</span><span class="dv">${new Date(attempt.submitted_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></div>` : ""}
    </div>
    ${cntR ? `<div class="card"><h3 style="margin-top:0">📊 विस्तृत परिणाम</h3>
      <div class="stats">
        <div class="stat"><div class="n" style="color:var(--ok)">${cntR.right}</div><div class="l">✅ सही उत्तर</div></div>
        <div class="stat"><div class="n" style="color:var(--bad)">${cntR.wrong}</div><div class="l">❌ गलत उत्तर</div></div>
        <div class="stat"><div class="n">${cntR.skip}</div><div class="l">⏭ छोड़े गए</div></div>
      </div>
      ${cntR.pend ? `<p class="muted" style="margin:10px 0 0">⏳ ${cntR.pend} लिखित उत्तर शिक्षक जाँचेंगे — उनके नंबर बाद में जुड़ सकते हैं।</p>` : ""}
    </div>` : ""}
    <div class="row" style="margin:12px 0">
      <button class="light" id="resBack">← Test List</button>
      ${!error ? `<button class="gold" id="resAll">📖 View All Answers</button>` : ""}
      ${canRestart ? `<button class="gold" id="resRestart">🔁 Retake (${test.max_attempts ? `${submittedCount}/${test.max_attempts} attempts used` : "Unlimited attempts"})</button>` : ""}
    </div>
    ${error ? `<div class="card"><p>A detailed review is not available right now (${esc(error.message)}). Your result is shown above.</p></div>`
    : `<div id="revBox"></div>`}
    <button class="light" id="resBack2" style="width:100%">← Back to Test List</button>`;
  const goBack = () => { tab = "tests"; renderShell(); };
  document.getElementById("resBack").onclick = goBack;
  document.getElementById("resBack2").onclick = goBack;
  const resAll = document.getElementById("resAll");
  if (resAll) resAll.onclick = () => { const b = document.getElementById("revBox"); if (b) b.scrollIntoView({ behavior: "smooth", block: "start" }); };
  if (canRestart) document.getElementById("resRestart").onclick = () => startTest(test, myTestAttempts);
  if (!error) drawReview();
  window.scrollTo({ top: 0 });
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
    <div class="prof-head"><h3 class="prof-title">☰ अधिक • More</h3></div>
    <div class="card" style="text-align:center">
      ${myPhoto
        ? `<img src="${myPhoto}" alt="" class="zoomable" title="Tap to view larger" data-zoom="${myPhoto}" style="width:76px; height:76px; border-radius:50%; object-fit:cover; margin:4px auto 10px; display:block; border:3px solid var(--gold)">`
        : `<div class="avatar" style="width:76px; height:76px; font-size:30px; margin:4px auto 10px">${esc((profile.full_name || "T").trim()[0].toUpperCase())}</div>`}
      <div style="font-size:19px; font-weight:900; color:var(--navy)">${esc(profile.full_name)}</div>
      <div class="muted">${esc(me.email)}</div>
      <div style="margin-top:8px"><span class="pill gold">${esc(roleName(profile.role))}</span></div>
      <div style="margin-top:12px">
        <input type="file" id="morePhotoFile" accept="image/*">
        <button class="gold small" id="morePhotoGo" style="margin-top:8px">📷 Change Photo</button>
      </div>
      ${profile.role === "student" ? `<div class="stats" style="margin-top:14px">
        <div class="stat"><div class="n">${testsGiven}</div><div class="l">दिए गए टेस्ट • Tests</div></div>
        <div class="stat"><div class="n">${avg}%</div><div class="l">औसत अंक • Average</div></div>
        <div class="stat"><div class="n">${classNames.length}</div><div class="l">कक्षाएँ • Classes</div></div>
      </div>` : ""}
    </div>
    ${(profile.role === "student" || profile.role === "parent") ? `
    <div class="card"><h3>💰 ${profile.role === "parent" ? "बच्चे की फ़ीस • Child's Fees" : "मेरी फ़ीस • My Fees"}</h3>
      ${feeDueTotal > 0 ? `<p style="color:var(--bad); font-weight:700">कुल बकाया: ₹${feeDueTotal.toLocaleString("en-IN")}</p>` : `<p class="ok" style="font-weight:700">कोई बकाया नहीं 🎉 • No dues</p>`}
      ${myFees.map(r => `<div class="item"><div><div class="t" style="font-size:14px">${esc(r.fee_type)} — ${esc(r.period)}</div>
        <div class="s">₹${r.paid_amount} जमा / कुल ₹${r.amount}${r.due_date ? ` • अंतिम तिथि: ${esc(r.due_date)}` : ""}</div></div>
        <span class="pill ${r.status === "paid" ? "green" : r.status === "partial" ? "gold" : "red"}">${r.status}</span></div>`).join("") || `<p class="muted">अभी कोई फ़ीस रिकॉर्ड नहीं है।</p>`}
    </div>` : ""}
    <div class="card"><h3>📚 पढ़ाई • Study</h3>
      <div class="hubrow" data-nav="study"><span class="hic" style="background:#e8f1fe">📚</span><span class="hub-tx"><span class="hub-t">Notes & Material</span><span class="hub-d">Class notes, PDFs and videos</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-nav="homework"><span class="hic" style="background:#e2f4ec">📒</span><span class="hub-tx"><span class="hub-t">Homework</span><span class="hub-d">Assignments from your teachers</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-nav="timetable"><span class="hic" style="background:#e8f1fe">🗓️</span><span class="hub-tx"><span class="hub-t">Timetable</span><span class="hub-d">Your class schedule</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-nav="live"><span class="hic" style="background:#fdecea">📺</span><span class="hub-tx"><span class="hub-t">Live Class</span><span class="hub-d">Upcoming live sessions</span></span><span class="arr">›</span></div>
      ${isStaff() ? "" : `<div class="hubrow" data-nav="studio"><span class="hic" style="background:#fdecea">🎬</span><span class="hub-tx"><span class="hub-t">Video Studio</span><span class="hub-d">YouTube lesson → your own notes & MCQs</span></span><span class="arr">›</span></div>`}
    </div>
    <div class="card"><h3>📝 टेस्ट और प्रगति • Tests & Progress</h3>
      <div class="hubrow" data-nav="tests"><span class="hic" style="background:#fff4cf">📝</span><span class="hub-tx"><span class="hub-t">Tests</span><span class="hub-d">Practice tests and exams</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-nav="top"><span class="hic" style="background:#fff4cf">🏆</span><span class="hub-tx"><span class="hub-t">Leaderboard</span><span class="hub-d">Top performers of the academy</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-nav="attendance"><span class="hic" style="background:#e2f4ec">✅</span><span class="hub-tx"><span class="hub-t">Attendance</span><span class="hub-d">Attendance records</span></span><span class="arr">›</span></div>
    </div>
    <div class="card"><h3>💬 मदद • Help</h3>
      <div class="hubrow" data-nav="doubts"><span class="hic" style="background:#fdecea">❓</span><span class="hub-tx"><span class="hub-t">Doubts</span><span class="hub-d">Ask a question, get an answer</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-nav="tutor"><span class="hic" style="background:#e8f1fe">🤖</span><span class="hub-tx"><span class="hub-t">AI Tutor</span><span class="hub-d">Learn anything, step by step</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-nav="notif"><span class="hic" style="background:#fff4cf">🔔</span><span class="hub-tx"><span class="hub-t">Notifications</span><span class="hub-d">All the latest updates</span></span><span class="arr">›</span></div>
    </div>
    ${isStaff() ? `<div class="card"><h3>🛠 बनाएँ और प्रबंधन • Create & Manage</h3>
      <div class="hubrow" data-nav="studio"><span class="hic" style="background:#fdecea">🎬</span><span class="hub-tx"><span class="hub-t">Video Studio</span><span class="hub-d">YouTube lesson → notes & MCQs</span></span><span class="arr">›</span></div>
      <div class="hubrow" data-nav="manage"><span class="hic" style="background:#e8f1fe">🛠️</span><span class="hub-tx"><span class="hub-t">Manage</span><span class="hub-d">Classes, subjects, questions & content</span></span><span class="arr">›</span></div>
      ${profile.role === "admin" ? `<div class="hubrow" data-nav="users"><span class="hic" style="background:#fff4cf">👥</span><span class="hub-tx"><span class="hub-t">Users</span><span class="hub-d">Students, teachers & enrollments</span></span><span class="arr">›</span></div>` : ""}
    </div>` : ""}
    <div class="card"><h3>👤 खाता • Account</h3>
      <div class="hubrow" data-nav="fees"><span class="hic" style="background:#fff4cf">💰</span><span class="hub-tx"><span class="hub-t">My Fees</span><span class="hub-d">Fee records and payments</span>${(profile.role === "student" || profile.role === "parent") && feeDueTotal > 0 ? `<span class="hub-d" style="color:var(--bad); font-weight:700">Total due: ₹${feeDueTotal.toLocaleString("en-IN")}</span>` : ""}</span><span class="arr">›</span></div>
      ${profile.role === "student" ? `<div class="menu-item"><span class="mi">🎓</span>My Classes<span class="arr">${esc(classNames.join(", ") || "—")}</span></div>` : ""}
      <div class="menu-item"><span class="mi">🎯</span>Target Academy<span class="arr">Manikpur, Gopalganj</span></div>
      <div class="menu-item"><span class="mi">👨‍🏫</span>Director<span class="arr">Ashutosh Kumar</span></div>
    </div>
    <button class="danger" style="width:100%" onclick="document.getElementById('logoutBtn').click()">🚪 Logout</button>`;
  $app.querySelectorAll("[data-nav]").forEach(el => el.onclick = () => { tab = el.dataset.nav; renderShell(); });
  const mpf = document.getElementById("morePhotoFile");
  if (mpf) {
    enhanceFilePicker(mpf, { imageOnly: true });
    document.getElementById("morePhotoGo").onclick = async () => {
      const btn = document.getElementById("morePhotoGo");
      btn.disabled = true; btn.textContent = "Uploading…";
      try {
        if (await uploadOwnPhoto(mpf)) { toast("📷 Photo updated"); renderMore(); return; }
      } catch (e) { toast("Error: " + e.message); }
      btn.disabled = false; btn.textContent = "📷 Change Photo";
    };
  }
}

/* ---------------- Student Profile (Phase 1 — design photo 10) ---------------- */
async function renderProfile() {
  if (isStaff()) { renderMore(); return; }
  $app.innerHTML = `<div class="loading">Loading…</div>`;
  let myPhoto = null;
  if (profile.photo_path) {
    const { data } = await sb.storage.from("avatars").createSignedUrl(profile.photo_path, 3600);
    myPhoto = data?.signedUrl || null;
  }
  const classNames = myClasses.map(c => c.name).join(", ");
  const pushOn = pushSupported() && Notification.permission === "granted";
  const row = (nav, ic, bg, t, d) => `<div class="hubrow" data-nav="${nav}"><span class="hic" style="background:${bg}">${ic}</span><span class="hub-tx"><span class="hub-t">${t}</span>${d ? `<span class="hub-d">${d}</span>` : ""}</span><span class="arr">›</span></div>`;
  $app.innerHTML = `
    <div class="prof-head"><h3 class="prof-title">प्रोफ़ाइल</h3><button class="light small prof-gear" id="profGear" aria-label="Settings / Notifications">⚙️</button></div>
    <div class="card" style="text-align:center">
      ${myPhoto
        ? `<img src="${myPhoto}" alt="" class="zoomable" data-zoom="${myPhoto}" style="width:76px; height:76px; border-radius:50%; object-fit:cover; margin:4px auto 10px; display:block; border:3px solid var(--gold)">`
        : `<div class="avatar" style="width:76px; height:76px; font-size:30px; margin:4px auto 10px">${esc((profile.full_name || "T").trim()[0].toUpperCase())}</div>`}
      <div style="font-size:19px; font-weight:900; color:var(--navy)">${esc(profile.full_name)}</div>
      <div class="muted">${classNames ? esc(classNames) + " • " : ""}${esc(roleName(profile.role))}</div>
      <div class="muted">${esc(me.email || "")}</div>
      <div style="margin-top:12px">
        <input type="file" id="profPhotoFile" accept="image/*">
        <button class="gold small" id="profPhotoGo" style="margin-top:8px">📷 Change Photo</button>
      </div>
    </div>
    <div class="card"><h3>📋 मेरी जानकारी</h3>
      <div class="menu-item"><span class="mi">👤</span>नाम<span class="arr">${esc(profile.full_name)}</span></div>
      <div class="menu-item"><span class="mi">✉️</span>ईमेल<span class="arr">${esc(me.email || "—")}</span></div>
      ${profile.phone ? `<div class="menu-item"><span class="mi">📱</span>फ़ोन<span class="arr">${esc(profile.phone)}</span></div>` : ""}
      <div class="menu-item"><span class="mi">🎓</span>कक्षाएँ<span class="arr">${esc(classNames || "—")}</span></div>
      ${profile.created_at ? `<div class="menu-item"><span class="mi">📅</span>खाता बना<span class="arr">${new Date(profile.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span></div>` : ""}
      <div class="menu-item"><span class="mi">🏫</span>Target Academy<span class="arr">Manikpur, Gopalganj</span></div>
      <div class="menu-item"><span class="mi">👨‍🏫</span>Director<span class="arr">Ashutosh Kumar</span></div>
    </div>
    <div class="card"><h3>🔗 जल्दी पहुँच</h3>
      ${row("fees", "💰", "#fff4cf", "फ़ीस विवरण", "फ़ीस की स्थिति और रिकॉर्ड")}
      ${row("attendance", "✅", "#e2f4ec", "उपस्थिति रिपोर्ट", "मेरी हाज़िरी का हाल")}
      ${row("tests", "📝", "#e8f1fe", "परिणाम", "दिए गए टेस्ट और नंबर")}
      ${row("homework", "📒", "#e2f4ec", "होमवर्क", "शिक्षकों के असाइनमेंट")}
      ${row("doubts", "❓", "#fdecea", "मेरे Doubts", "सवाल पूछें, जवाब पाएँ")}
      ${row("tutor", "🤖", "#efe7fd", "AI Tutor", "कदम-दर-कदम सीखें")}
      ${row("studio", "🎬", "#fdecea", "Video Studio", "YouTube video से अपने notes और MCQ बनाएँ")}
      ${row("live", "📺", "#fdecea", "Live Class", "आने वाली लाइव कक्षाएँ")}
      ${row("timetable", "🗓️", "#e8f1fe", "Timetable", "क्लास का समय")}
      ${row("notif", "🔔", "#fff4cf", "नोटिफ़िकेशन", "सभी ताज़ा अपडेट")}
    </div>
    <div class="card"><h3>📲 फ़ोन सूचना</h3>
      ${pushSupported()
        ? (pushOn
          ? `<p style="margin:0">✅ इस फ़ोन पर सूचनाएँ चालू हैं।</p>`
          : `<p class="muted" style="margin-top:0">नई सूचना, टेस्ट और जवाब सीधे फ़ोन पर पाएँ — ऐप बंद होने पर भी।</p><button class="gold" id="profPush" style="width:100%">📲 Enable Phone Notifications</button>`)
        : `<p class="muted" style="margin:0">यह ब्राउज़र फ़ोन सूचना नहीं देता — ऐप को Chrome में खोलें।</p>`}
    </div>
    <div class="card"><h3>🔑 पासवर्ड बदलें</h3>
      <label>नया पासवर्ड</label><input type="password" id="np1" autocomplete="new-password" placeholder="कम से कम 6 अक्षर">
      <label>नया पासवर्ड फिर से</label><input type="password" id="np2" autocomplete="new-password" placeholder="दोबारा लिखें">
      <div class="error" id="npErr"></div>
      <button class="gold" id="npGo" style="width:100%">Change Password</button>
    </div>
    <button class="danger" id="profLogout" style="width:100%">🚪 Logout</button>`;
  document.getElementById("profGear").onclick = () => { tab = "notif"; renderShell(); };
  const ppf = document.getElementById("profPhotoFile");
  if (ppf) {
    enhanceFilePicker(ppf, { imageOnly: true });
    document.getElementById("profPhotoGo").onclick = async () => {
      const btn = document.getElementById("profPhotoGo");
      btn.disabled = true; btn.textContent = "Uploading…";
      try {
        if (await uploadOwnPhoto(ppf)) { toast("📷 Photo updated"); renderProfile(); return; }
      } catch (e) { toast("Error: " + e.message); }
      btn.disabled = false; btn.textContent = "📷 Change Photo";
    };
  }
  $app.querySelectorAll("[data-nav]").forEach(el => el.onclick = () => { tab = el.dataset.nav; renderShell(); });
  const pp = document.getElementById("profPush");
  if (pp) pp.onclick = async () => { await enablePush(); renderProfile(); };
  document.getElementById("npGo").onclick = async () => {
    const err = document.getElementById("npErr"); err.textContent = "";
    const p1 = document.getElementById("np1").value, p2 = document.getElementById("np2").value;
    if (p1.length < 6) { err.textContent = "पासवर्ड कम से कम 6 अक्षरों का रखें"; return; }
    if (p1 !== p2) { err.textContent = "दोनों पासवर्ड एक जैसे नहीं हैं"; return; }
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) { err.textContent = error.message; return; }
    toast("🔑 पासवर्ड बदल गया है");
    document.getElementById("np1").value = ""; document.getElementById("np2").value = "";
  };
  document.getElementById("profLogout").onclick = () => document.getElementById("logoutBtn").click();
}

/* ---------------- Start ---------------- */
sb.auth.onAuthStateChange(() => { /* boot handles routing */ });
boot();

/* ---------------- Notifications / Live / Leaderboard ---------------- */
let annFilter = "सभी";
const ANN_CATS = ["सभी", "परीक्षा", "छुट्टी", "महत्वपूर्ण", "सूचना"];
const ANN_CAT_EN = { "सभी": "All", "परीक्षा": "Exam", "छुट्टी": "Holiday", "महत्वपूर्ण": "Important", "सूचना": "Notice" };
const annCatOf = (a) => ["सूचना", "परीक्षा", "छुट्टी", "महत्वपूर्ण"].includes(a?.category) ? a.category : "सूचना";
const annCatMeta = {
  "सूचना": { ic: "📢", bg: "#e8f1fe", pill: "blue" },
  "परीक्षा": { ic: "📝", bg: "#efe7fd", pill: "purple" },
  "छुट्टी": { ic: "🏖", bg: "#fdf3d7", pill: "gold" },
  "महत्वपूर्ण": { ic: "🔴", bg: "#fdecea", pill: "red" },
};
async function renderNotifs() {
  const [{ data: rows }, { data: anns }] = await Promise.all([
    sb.from("notifications").select("*").eq("user_id", me.id).order("created_at", { ascending: false }).limit(50),
    sb.from("announcements").select("*").order("created_at", { ascending: false }).limit(30),
  ]);
  const annCls = (id) => (myClasses.find(c => c.id === id) || {}).name || "";
  const icons = { announcement: "📢", test: "📝", doubt: "❓", live: "📺", note: "📚", assignment: "📒", fee: "💰", result: "🏆", admission: "✅", welcome: "🎉" };
  const unread = (rows || []).filter(n => !n.is_read).length;
  $app.innerHTML = `
    ${(anns && anns.length) ? `<div class="card"><h3 style="margin:0 0 4px">📢 सूचनाएँ • Academy Notices</h3>
      <div class="row" style="margin:10px 0 4px; gap:6px; flex-wrap:wrap">${ANN_CATS.map(c => `<button type="button" class="chip ${annFilter === c ? "on" : ""}" data-annf="${c}">${ANN_CAT_EN[c] || c}</button>`).join("")}</div>
      ${((annFilter === "सभी" ? (anns || []) : (anns || []).filter(a => annCatOf(a) === annFilter)).length
        ? (annFilter === "सभी" ? (anns || []) : (anns || []).filter(a => annCatOf(a) === annFilter)).map(a => { const bd = a.body ? String(a.body) : ""; const cm = annCatMeta[annCatOf(a)]; return `<div class="item"><div style="display:flex; gap:10px; align-items:flex-start">
          <div class="nicon" style="background:${cm.bg}">${cm.ic}</div>
          <div style="flex:1; min-width:0"><div class="t" style="font-size:14.5px">${esc(a.title)}</div>
          ${bd ? `<div class="s">${esc(bd.length > 120 ? bd.slice(0, 120) + "…" : bd)}</div>` : ""}
          <div class="s muted">${new Date(a.created_at).toLocaleDateString("hi-IN", { day: "numeric", month: "short", year: "numeric" })}${a.class_id && annCls(a.class_id) ? " • " + esc(annCls(a.class_id)) : " • सभी छात्र"}</div></div></div>
          <span class="pill ${cm.pill}">${annCatOf(a)}</span></div>`; }).join("")
        : `<p class="muted" style="margin:8px 0 0">इस श्रेणी में अभी कोई सूचना नहीं है।</p>`)}
    </div>` : ""}
    <div class="card"><h3 style="margin:0">📲 फ़ोन पर सूचना • Notifications on Phone</h3>
      <p class="muted" style="margin:6px 0 0">चालू करने पर हर नई सूचना (नोटिस, टेस्ट, Doubt का जवाब, Live Class) सीधे आपके फ़ोन पर आएगी — ऐप बंद होने पर भी।</p>
      ${pushSupported()
        ? (Notification.permission === "granted"
          ? `<p style="margin:10px 0 0">✅ इस फ़ोन पर सूचनाएँ चालू हैं।</p>`
          : Notification.permission === "denied"
            ? `<p style="margin:10px 0 0">⚠️ ब्राउज़र ने सूचनाएँ रोक रखी हैं — Chrome की Site Settings में Notifications की अनुमति दें।</p>`
            : `<button id="npBtn" style="margin-top:10px">📲 Turn on Phone Notifications</button>`)
        : `<p style="margin:10px 0 0">यह ब्राउज़र फ़ोन सूचना नहीं देता — ऐप को Chrome में खोलें।</p>`}
    </div>
    <div class="card"><h3 style="margin:0">🔔 मेरी सूचनाएँ • My Notifications ${unread ? `<span class="pill green">${unread} नई</span>` : ""}</h3>
      <p class="muted" style="margin:6px 0 0">Academy की सभी ताज़ा जानकारी — नोटिस, नए टेस्ट, Doubt के जवाब — यहाँ मिलेगी।</p>
      ${unread ? `<button class="light" id="nReadAll" style="margin-top:10px">✓ Mark all as read</button>` : ""}
    </div>
    ${(rows || []).map(n => `
      <div class="card" data-nread="${n.id}" style="cursor:pointer;${n.is_read ? "opacity:.72" : ""}">
        <div class="row" style="justify-content:space-between">
          <b>${icons[n.kind] || "🔔"} ${esc(n.title)}</b>${n.is_read ? "" : `<span class="pill green">नया</span>`}
        </div>
        ${n.body ? `<p class="muted" style="margin:6px 0 0">${esc(n.body)}</p>` : ""}
        <div class="s muted" style="margin-top:6px">${new Date(n.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</div>
      </div>`).join("") || `<div class="card"><p class="muted">अभी कोई सूचना नहीं है।</p></div>`}`;
  $app.querySelectorAll("[data-annf]").forEach(b => b.onclick = () => { annFilter = b.dataset.annf; renderNotifs(); });
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
  if (error) { $app.innerHTML = `<div class="card"><h3>📺 Live Class</h3><p class="muted">This feature is still being prepared.</p></div>`; return; }
  const cutoff = Date.now() - 2 * 3600 * 1000;
  const up = (rows || []).filter(r => new Date(r.starts_at).getTime() > cutoff);
  const past = (rows || []).filter(r => new Date(r.starts_at).getTime() <= cutoff).reverse();
  const fmt = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const card = (r, old) => `
    <div class="card" ${old ? `style="opacity:.65"` : ""}>
      <h3 style="margin:0">📺 ${esc(r.title)}</h3>
      <div class="s muted" style="margin-top:4px">${esc(clsName(r.class_id))} • 🕐 ${fmt(r.starts_at)}</div>
      <div class="row" style="margin-top:10px">
        <a href="${esc(r.meet_link)}" target="_blank" rel="noopener"><button>▶ Join</button></a>
        ${isStaff() ? `<button class="danger small" data-lcdel="${r.id}">Delete</button>` : ""}
      </div>
    </div>`;
  $app.innerHTML = `
    ${isStaff() ? `<div class="card"><h3>📺 Schedule a New Live Class</h3>
      <label>Class</label><select id="lc_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <label>Title</label><input id="lc_title" placeholder="e.g. Physics — Optics Revision">
      <label>Join Link (Google Meet / Zoom / YouTube Live)</label><input id="lc_link" placeholder="https://meet.google.com/...">
      <label>Date and Time</label><input id="lc_time" type="datetime-local">
      <p class="err" id="lcErr"></p>
      <button id="lcBtn">📺 Create Live Class</button>
      <p class="muted" style="margin:8px 0 0">As soon as it is created, students of that class will get a notification.</p></div>` : ""}
    <div class="card"><h3 style="margin:0">📺 Upcoming Live Classes</h3></div>
    ${up.map(r => card(r, false)).join("") || `<div class="card"><p class="muted">No live class is scheduled right now.</p></div>`}
    ${past.length ? `<div class="card"><h3 style="margin:0">Past Classes</h3></div>${past.map(r => card(r, true)).join("")}` : ""}`;
  if (isStaff()) {
    document.getElementById("lcBtn").onclick = async () => {
      const err = document.getElementById("lcErr");
      const class_id = +document.getElementById("lc_class").value;
      const title = document.getElementById("lc_title").value.trim();
      const meet_link = document.getElementById("lc_link").value.trim();
      const tval = document.getElementById("lc_time").value;
      if (!title) { err.textContent = "Enter a title"; return; }
      if (!/^https?:\/\//i.test(meet_link)) { err.textContent = "Enter a valid join link (starting with https://)"; return; }
      if (!tval) { err.textContent = "Choose the date and time"; return; }
      const { error } = await sb.from("live_classes").insert({ class_id, title, meet_link, starts_at: new Date(tval).toISOString(), created_by: me.id });
      if (error) { err.textContent = error.message; return; }
      await notifyClassStudents(class_id, "live", "📺 Live Class: " + title, fmt(new Date(tval).toISOString()) + " — you will find the join link in the Live Class section.");
      toast("Live Class created 📺"); renderLive();
    };
    $app.querySelectorAll("[data-lcdel]").forEach(b => b.onclick = async () => {
      if (!confirm("Delete this live class?")) return;
      const { error } = await sb.from("live_classes").delete().eq("id", +b.dataset.lcdel);
      if (error) return toast("Error: " + error.message);
      renderLive();
    });
  }
}

let topClass = "all";
async function renderTop() {
  const { data, error } = await sb.rpc("get_leaderboard", { p_class_id: topClass === "all" ? null : +topClass });
  if (error) { $app.innerHTML = `<div class="card"><h3>🏆 Leaderboard</h3><p class="muted">This feature is still being prepared.</p></div>`; return; }
  const medals = ["🥇", "🥈", "🥉"];
  $app.innerHTML = `
    <div class="card"><h3 style="margin:0">🏆 Leaderboard</h3>
      <p class="muted" style="margin:6px 0 0">Students with the best scores in tests — a salute to hard work!</p>
      <div class="row" style="margin-top:10px">
        <button class="${topClass === "all" ? "" : "light"} small" data-tclass="all">All Classes</button>
        ${myClasses.map(c => `<button class="${String(topClass) === String(c.id) ? "" : "light"} small" data-tclass="${c.id}">${esc(c.name)}</button>`).join("")}
      </div></div>
    ${(data || []).map((r, i) => `
      <div class="card" ${r.student_id === me.id ? `style="border:2px solid var(--gold,#c9a227)"` : ""}>
        <div class="row" style="justify-content:space-between">
          <b>${medals[i] || (i + 1) + "."} ${esc(r.full_name)}${r.student_id === me.id ? " (You)" : ""}</b>
          <span class="pill ${i === 0 ? "green" : ""}">${r.avg_pct}% average</span>
        </div>
        <div class="s muted" style="margin-top:4px">Tests given: ${r.tests_given}</div>
      </div>`).join("") || `<div class="card"><p class="muted">No one has taken a test yet — the ranking will appear here after the first test.</p></div>`}`;
  $app.querySelectorAll("[data-tclass]").forEach(b => b.onclick = () => { topClass = b.dataset.tclass; renderTop(); });
}

/* ---------------- Voice: speak-to-ask + listen-to-answer ---------------- */
function voiceSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
let _rec = null;
function startVoice(target, btn) {
  if (!target) return;
  if (_rec) { try { _rec.stop(); } catch (_) {} return; }
  if (!voiceSupported()) { toast("Voice typing needs Chrome — please open the app in Chrome"); return; }
  const SRC = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SRC(); _rec = rec;
  rec.lang = "hi-IN"; rec.interimResults = true; rec.continuous = true;
  let base = target.value.replace(/\s+$/, ""); if (base) base += " ";
  const oldHTML = btn.innerHTML;
  const done = () => { if (_rec === rec) _rec = null; btn.innerHTML = oldHTML; btn.classList.remove("listening"); };
  btn.innerHTML = "🔴 Listening…"; btn.classList.add("listening");
  rec.onresult = (e) => {
    let fin = "", inter = "";
    for (const r of e.results) { if (r.isFinal) fin += r[0].transcript; else inter += r[0].transcript; }
    target.value = base + fin + inter;
    if (fin) { base = target.value.replace(/\s+$/, ""); if (base) base += " "; }
  };
  rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") toast("Please allow microphone access, then try again"); done(); };
  rec.onend = done;
  try { rec.start(); } catch (_) { done(); }
}
let _sayBtn = null;
function speakText(text, btn) {
  if (!("speechSynthesis" in window)) { toast("Listening isn't supported in this browser"); return; }
  if (speechSynthesis.speaking && _sayBtn === btn) { speechSynthesis.cancel(); return; }
  speechSynthesis.cancel();
  const clean = (text || "").replace(/\$+/g, "").replace(/\\[a-zA-Z]+/g, " ").replace(/[*#_`>~{}]/g, "").slice(0, 1200);
  if (!clean.trim()) return;
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = "hi-IN"; u.rate = 0.98;
  const v = speechSynthesis.getVoices().find(v => (v.lang || "").toLowerCase().startsWith("hi"));
  if (v) u.voice = v;
  if (btn) {
    btn.innerHTML = "⏹ Stop"; _sayBtn = btn;
    const reset = () => { if (_sayBtn === btn) { btn.innerHTML = "🔊 Listen"; _sayBtn = null; } };
    u.onend = reset; u.onerror = reset;
  }
  speechSynthesis.speak(u);
}

/* ---------------- AI Tutor ---------------- */
let tutorChat = [];   // {role:'me'|'ai', text} — kept while the app stays open
let tutorBusy = false;
let tutorMode = "normal";   // normal | easy | exam
let tutorPhoto = null;      // {data, mimeType, url} — pending question photo, IN MEMORY ONLY (never uploaded to Storage, never persisted)
let tutorWeak = [];         // student's weak chapters (<70 avg) for suggestion chips
let tutorWeakLoaded = false;
/* Photo → base64 for the AI Tutor (v49). The photo is compressed in the
   browser (max 1024px, JPEG) and kept ONLY in memory as base64 — it is
   never uploaded to Supabase Storage and never written to localStorage. */
async function photoToBase64(file, maxDim = 1024) {
  let blob = await compressImageFile(file, maxDim, 0.82);
  if (blob.type !== "image/jpeg") {
    try {
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      blob = (await new Promise(r => cv.toBlob(r, "image/jpeg", 0.82))) || blob;
    } catch (_) { /* keep whatever we have */ }
  }
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  return { data: String(url).split(",")[1] || "", mimeType: "image/jpeg", url: String(url) };
}

/* AI answer formatter (v51, owner's complaint: raw $...$, ** and \xrightarrow
   symbols were showing in AI answers). Gemini replies arrive as markdown +
   LaTeX; students must see clean readable text like ChatGPT/Gemini show.
   Everything is escaped FIRST — only this formatter's own tags are added.
   Converts: **bold**, headings, • bullets, and math-lite (sub/superscripts,
   arrows, fractions, Greek letters, chemical formulas like C_6H_{12}O_6). */
function aiMath(t) {
  t = t.replace(/\\text\{([^}]*)\}/g, "$1").replace(/\\mathrm\{([^}]*)\}/g, "$1").replace(/\\mathbf\{([^}]*)\}/g, "$1");
  t = t.replace(/\\xrightarrow\s*(?:\[([^\]]*)\])?\s*(?:\{([^}]*)\})?/g,
    (m, below, above) => { const parts = [below, above].filter(x => x && x.trim()); return parts.length ? ` → (${parts.join(", ")}) ` : " → "; });
  t = t.replace(/\\rightarrow/g, "→").replace(/\\leftarrow/g, "←").replace(/\\to(?![a-zA-Z])/g, "→");
  t = t.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "($1)/($2)");
  t = t.replace(/\\sqrt\{([^}]*)\}/g, "√($1)").replace(/\\sqrt/g, "√");
  t = t.replace(/_\{([^}]*)\}/g, "<sub>$1</sub>").replace(/\^\{([^}]*)\}/g, "<sup>$1</sup>");
  t = t.replace(/_([A-Za-z0-9])/g, "<sub>$1</sub>").replace(/\^([A-Za-z0-9+\-])/g, "<sup>$1</sup>");
  const sym = { "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ", "\\Delta": "Δ", "\\theta": "θ", "\\lambda": "λ", "\\mu": "μ", "\\pi": "π", "\\sigma": "σ", "\\omega": "ω", "\\Omega": "Ω", "\\times": "×", "\\div": "÷", "\\pm": "±", "\\le": "≤", "\\ge": "≥", "\\neq": "≠", "\\ne": "≠", "\\approx": "≈", "\\infty": "∞", "\\degree": "°", "\\circ": "°", "\\cdot": "·" };
  for (const k in sym) t = t.split(k).join(sym[k]);
  t = t.replace(/\\[,;:! ]/g, " ").replace(/\\([A-Za-z]+)/g, "$1").replace(/\\/g, "");
  return t;
}
function aiInline(s) {
  s = s.replace(/\$\$([^$]+)\$\$/g, (m, inner) => aiMath(inner));
  s = s.replace(/\$([^$]+)\$/g, (m, inner) => aiMath(inner));
  s = aiMath(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}
function aiHTML(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let inCode = false, codeBuf = [], listOpen = false;
  const closeList = () => { if (listOpen) { out.push("</div>"); listOpen = false; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) { out.push(`<pre class="ai-code">${esc(codeBuf.join("\n"))}</pre>`); codeBuf = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    const t = line.trim();
    if (!t) { closeList(); continue; }
    const h = t.match(/^#{1,4}\s+(.*)$/);
    if (h) { closeList(); out.push(`<div class="ai-h">${aiInline(esc(h[1]))}</div>`); continue; }
    const b = t.match(/^[•\-\*]\s+(.*)$/);
    if (b) {
      if (!listOpen) { out.push('<div class="ai-list">'); listOpen = true; }
      out.push(`<div class="ai-li">• ${aiInline(esc(b[1]))}</div>`);
      continue;
    }
    closeList();
    out.push(`<div class="ai-p">${aiInline(esc(t))}</div>`);
  }
  if (inCode && codeBuf.length) out.push(`<pre class="ai-code">${esc(codeBuf.join("\n"))}</pre>`);
  closeList();
  return out.join("");
}

async function renderTutor() {
  if (!isStaff() && !tutorWeakLoaded) {
    tutorWeakLoaded = true;
    try {
      const [{ data: atts }, { data: tsts }, { data: chps }] = await Promise.all([
        sb.from("test_attempts").select("test_id,percent").eq("student_id", me.id).neq("status", "in_progress"),
        sb.from("tests").select("id,chapter_id"),
        sb.from("chapters").select("id,name"),
      ]);
      const chapOfTest = {}; (tsts || []).forEach(t => { if (t.chapter_id) chapOfTest[t.id] = t.chapter_id; });
      const agg = {};
      (atts || []).forEach(a => { const cid = chapOfTest[a.test_id]; if (!cid || a.percent == null) return; (agg[cid] = agg[cid] || []).push(+a.percent); });
      const nameOfCh = {}; (chps || []).forEach(c => nameOfCh[c.id] = c.name);
      tutorWeak = Object.entries(agg).map(([cid, arr]) => ({ id: +cid, name: nameOfCh[cid] || "", avg: arr.reduce((s, x) => s + x, 0) / arr.length })).filter(w => w.name && w.avg < 70).sort((a, b) => a.avg - b.avg).slice(0, 3);
    } catch (_) { tutorWeak = []; }
  }
  const chips = ["Explain refraction of light", "What is photosynthesis?", "Why do the angles of a triangle add up to 180°?", "Explain the water cycle", "How do I solve x + 5 = 12?"];
  const bubble = (m, i) => m.role === "me"
    ? `<div class="chatrow me"><div class="bubble me">${m.img ? `<img src="${m.img}" alt="Question photo" style="max-width:190px; width:100%; border-radius:10px; display:block; margin-bottom:${m.text ? "6px" : "0"}">` : ""}${esc(m.text)}</div></div>`
    : `<div class="chatrow"><div class="bubble ai"><b>🤖 AI Tutor</b><br>${aiHTML(m.text)}<br><button type="button" class="light small" data-sayidx="${i}" style="margin-top:6px">🔊 Listen</button></div></div>`;
  $app.innerHTML = `
    <div class="card"><h3 style="margin:0">🤖 AI Tutor</h3>
      <p class="muted" style="margin:6px 0 0">Ask any study question — type it, tap 🎤 to speak, or tap 📷 Photo to ask from a photo of your book or notebook. The AI Tutor will explain it step-by-step in easy Hindi.</p>
      <div class="row" style="margin-top:10px; gap:6px; flex-wrap:wrap">
        <button type="button" class="chip ${tutorMode === "normal" ? "on" : ""}" data-tmode="normal">🎓 Normal</button>
        <button type="button" class="chip ${tutorMode === "easy" ? "on" : ""}" data-tmode="easy">🪜 Easy Language</button>
        <button type="button" class="chip ${tutorMode === "exam" ? "on" : ""}" data-tmode="exam">📝 Exam Style</button>
      </div>
      ${tutorChat.length ? "" : `<div class="row" style="margin-top:10px">${chips.map(c => `<button class="light small" data-tchip="${esc(c)}">${esc(c)}</button>`).join("")}</div>`}
      ${!isStaff() && tutorWeak.length ? `<div style="margin-top:12px"><div class="muted" style="font-weight:700; margin-bottom:6px">🎯 मेरे कमज़ोर अध्याय — Tap करके समझें</div><div class="row" style="gap:6px; flex-wrap:wrap">${tutorWeak.map(w => `<button type="button" class="light small" data-tweak="${esc(w.name)}">🎯 Explain: ${esc(w.name)}</button>`).join("")}</div></div>` : ""}
      <div class="row" style="margin-top:10px; gap:6px; flex-wrap:wrap">
        <button type="button" class="light small" data-tfill="मेरे लिए रोज़ का पढ़ने का Plan बनाओ">📌 Study Plan</button>
        <button type="button" class="light small" data-tfill="मुझे याद करने के आसान तरीके बताओ">🧠 Memory Tips</button>
        <button type="button" class="light small" data-tfill="परीक्षा में उत्तर लिखने की शैली समझाओ">✍️ Answer Writing</button>
      </div>
    </div>
    <div id="tutorMsgs">${tutorChat.map((m, i) => bubble(m, i)).join("")}${tutorBusy ? `<div class="chatrow"><div class="bubble ai">🤖 Typing…</div></div>` : ""}</div>
    <form id="tutorForm" class="card">
      ${tutorPhoto ? `<div class="tut-photo"><img src="${tutorPhoto.url}" alt="Question photo"><span class="muted" style="flex:1">Photo attached — tap Ask, or write a line with it.</span><button type="button" class="light small" id="tutorPhotoX">✕ Remove</button></div>` : ""}
      <div class="row">
        <input id="tutorInput" placeholder="Write or speak your question…" style="flex:1" ${tutorBusy ? "disabled" : ""}>
        <button type="button" class="light" id="tutorPhotoBtn" title="Ask with a photo" ${tutorBusy ? "disabled" : ""}>📷 Photo</button>
        ${voiceSupported() ? `<button type="button" class="light" id="tutorMic" title="Ask by speaking" ${tutorBusy ? "disabled" : ""}>🎤</button>` : ""}
        <button type="submit" ${tutorBusy ? "disabled" : ""}>Ask ➤</button>
      </div>
      <input type="file" id="tutorPhotoFile" accept="image/*" style="display:none">
      ${tutorChat.length ? `<button type="button" class="light small" id="tutorClear" style="margin-top:8px">🧹 Clear chat</button>` : ""}
    </form>`;
  const send = async (text) => {
    const q = (text || "").trim();
    const photo = tutorPhoto;
    if (tutorBusy || (!q && !photo)) return;
    tutorChat.push({ role: "me", text: q, img: photo ? photo.url : null });
    tutorPhoto = null;
    tutorBusy = true; renderTutor();
    const history = tutorChat.slice(0, -1).map(m => ({ role: m.role === "ai" ? "ai" : "user", text: m.text }));
    const modePrefix = { easy: "इसे बहुत आसान भाषा में, रोज़ के उदाहरण से समझाओ: ", exam: "इसे परीक्षा के उत्तर की शैली में, मुख्य बिंदुओं के साथ समझाओ: " };
    const askQ = q || "Explain the question in this photo and give its answer.";
    const outQ = tutorMode === "normal" ? askQ : (modePrefix[tutorMode] || "") + askQ;
    const body = { question: outQ, history };
    if (photo) body.image = { data: photo.data, mimeType: "image/jpeg" };
    const { data, error } = await sb.functions.invoke("ask-tutor", { body });
    tutorBusy = false;
    if (error || !data?.answer) tutorChat.push({ role: "ai", text: "Sorry, I couldn't prepare an answer right now. Please try again in a little while." });
    else tutorChat.push({ role: "ai", text: data.answer });
    renderTutor();
  };
  document.getElementById("tutorForm").onsubmit = (e) => { e.preventDefault(); send(document.getElementById("tutorInput").value); };
  const tpb = document.getElementById("tutorPhotoBtn");
  const tpf = document.getElementById("tutorPhotoFile");
  if (tpb && tpf) {
    tpb.onclick = () => tpf.click();
    tpf.onchange = async () => {
      const f = tpf.files[0]; tpf.value = "";
      if (!f) return;
      try { tutorPhoto = await photoToBase64(f); renderTutor(); }
      catch (_) { toast("Could not read that photo — try another one"); }
    };
  }
  const tpx = document.getElementById("tutorPhotoX");
  if (tpx) tpx.onclick = () => { tutorPhoto = null; renderTutor(); };
  const tmic = document.getElementById("tutorMic");
  if (tmic) tmic.onclick = () => startVoice(document.getElementById("tutorInput"), tmic);
  $app.querySelectorAll("[data-sayidx]").forEach(b => b.onclick = () => speakText(tutorChat[+b.dataset.sayidx].text, b));
  $app.querySelectorAll("[data-tchip]").forEach(b => b.onclick = () => send(b.dataset.tchip));
  $app.querySelectorAll("[data-tmode]").forEach(b => b.onclick = () => { tutorMode = b.dataset.tmode; renderTutor(); });
  $app.querySelectorAll("[data-tweak]").forEach(b => b.onclick = () => send(b.dataset.tweak + " को आसान उदाहरणों से समझाओ"));
  $app.querySelectorAll("[data-tfill]").forEach(b => b.onclick = () => { const inp = document.getElementById("tutorInput"); if (inp) { inp.value = b.dataset.tfill; inp.focus(); } });
  const clr = document.getElementById("tutorClear");
  if (clr) clr.onclick = () => { tutorChat = []; renderTutor(); };
  window.scrollTo(0, document.body.scrollHeight);
}

/* ---------------- Doubts ---------------- */
let doubtTab = "open"; // staff filter: open | answered | all
async function renderDoubts() {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
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
    ? `<span class="pill green">✅ Answered</span>`
    : d.status === "closed" ? `<span class="pill">Closed</span>` : `<span class="pill gold">⏳ Awaiting Reply</span>`;
  const doubtCard = (d, staffView) => `
    <div class="card">
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start">
        <div style="font-weight:700; font-size:15.5px; line-height:1.45">❓ ${esc(d.question_text)}</div>
        ${statusPill(d)}
      </div>
      <p class="muted" style="margin:6px 0 0">${staffView ? `👤 ${esc(nameMap[d.student_id] || "Student")} • ` : ""}${d.class_id ? esc(clsName(d.class_id)) + " • " : ""}${d.subject_id ? esc(subName(d.subject_id)) + " • " : ""}${new Date(d.created_at).toLocaleString("en-IN")}</p>
      ${d.answer_text ? `<div class="expl-box" style="margin-top:10px">💬 <b>Answer${staffView && d.answered_by && nameMap[d.answered_by] ? ` — ${esc(nameMap[d.answered_by])}` : ""}:</b><br><span style="white-space:pre-wrap">${esc(d.answer_text)}</span>${d.answered_at ? `<br><span class="muted">${new Date(d.answered_at).toLocaleString("en-IN")}</span>` : ""}<br><button type="button" class="light small" data-saydoubt="${d.id}" data-kind="ans" style="margin-top:6px">🔊 Listen</button></div>` : ""}
      ${d.ai_answer ? `<div class="expl-box" style="margin-top:10px; background:#eef4ff; border-color:#9db9e8">🤖 <b>AI's Answer:</b><br>${aiHTML(d.ai_answer)}<br><button type="button" class="light small" data-saydoubt="${d.id}" data-kind="ai" style="margin-top:6px">🔊 Listen</button></div>`
        : `<div style="margin-top:10px"><button class="light small" data-dai="${d.id}">🤖 Get AI Answer</button></div>`}
      ${staffView && d.status === "open" ? `
        <label style="margin-top:10px">Write your answer</label>
        <textarea id="da-${d.id}" placeholder="Explain and write the answer…"></textarea>
        <div class="error" id="de-${d.id}"></div>
        <button class="gold" data-dans="${d.id}" style="width:100%">Send Answer</button>` : ""}
    </div>`;

  const wireAI = () => {
    $app.querySelectorAll("[data-dai]").forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = "🤖 Getting the AI answer…";
      const { error } = await sb.functions.invoke("answer-doubt", { body: { doubt_id: +b.dataset.dai } });
      if (error) toast("The AI answer couldn't be fetched right now — Sir will answer");
      renderDoubts();
    });
  };
  const wireSpeak = () => {
    $app.querySelectorAll("[data-saydoubt]").forEach(b => b.onclick = () => {
      const d = list.find(x => x.id === +b.dataset.saydoubt); if (!d) return;
      speakText(b.dataset.kind === "ai" ? d.ai_answer : d.answer_text, b);
    });
  };

  if (isStaff()) {
    const open = list.filter(d => d.status === "open");
    const answered = list.filter(d => d.status !== "open");
    const shown = doubtTab === "open" ? open : doubtTab === "answered" ? answered : list;
    $app.innerHTML = `
      <div class="card"><h3>❓ Students' Doubts</h3>
        <div class="row">
          <button class="${doubtTab === "open" ? "" : "light"}" data-dtab="open">⏳ Awaiting Reply (${open.length})</button>
          <button class="${doubtTab === "answered" ? "" : "light"}" data-dtab="answered">✅ Answered (${answered.length})</button>
          <button class="${doubtTab === "all" ? "" : "light"}" data-dtab="all">All (${list.length})</button>
        </div>
        <p class="muted" style="margin:8px 0 0">Questions students ask appear here. Write and send an answer — the student will see it right away.</p>
      </div>
      ${shown.map(d => doubtCard(d, true)).join("") || `<div class="card"><p class="muted">No doubts in this list yet.</p></div>`}`;
    $app.querySelectorAll("[data-dtab]").forEach(b => b.onclick = () => { doubtTab = b.dataset.dtab; renderDoubts(); });
    $app.querySelectorAll("[data-dans]").forEach(b => b.onclick = async () => {
      const id = +b.dataset.dans;
      const txt = document.getElementById("da-" + id).value.trim();
      const err = document.getElementById("de-" + id);
      if (!txt) { err.textContent = "Write the answer first"; return; }
      const { error } = await sb.from("doubts").update({ answer_text: txt, answered_by: me.id, status: "answered", answered_at: new Date().toISOString() }).eq("id", id);
      if (error) { err.textContent = error.message; return; }
      const d0 = (list || []).find(x => x.id === id);
      if (d0) await notifyUsers([d0.student_id], "doubt", "✅ Your doubt has been answered", (d0.question_text || "").slice(0, 120));
      toast("Answer sent ✅"); renderDoubts();
    });
    wireAI(); wireSpeak();
    return;
  }

  // Student view: ask + my doubts
  const { data: enr } = await sb.from("enrollments").select("class_id").eq("user_id", me.id);
  const enrolledIds = (enr || []).map(e => e.class_id);
  const mySubjs = (subjects || []).filter(s => enrolledIds.includes(s.class_id));
  $app.innerHTML = `
    <div class="card"><h3>❓ Ask Your Doubt</h3>
      <p class="muted" style="margin-top:0">Write or speak here whatever you don't understand in your studies — Sir will answer.</p>
      <label>Subject</label>
      <select id="db_subject"><option value="">— General question —</option>${mySubjs.map(s => `<option value="${s.id}">${esc(s.name)}${s.name_hi ? " • " + esc(s.name_hi) : ""} (${esc(clsName(s.class_id))})</option>`).join("")}</select>
      <label>Write your question</label>
      <textarea id="db_q" placeholder="e.g. What is refraction of light? Explain with an example…"></textarea>
      ${voiceSupported() ? `<button type="button" class="light" id="db_mic" style="width:100%; margin-top:6px">🎤 Ask by Speaking</button>` : ""}
      <div class="error" id="db_err"></div>
      <button class="gold" id="db_ask" style="width:100%">Send Doubt</button>
    </div>
    <div class="card"><h3>🙋 My Doubts (${list.length})</h3>
      <p class="muted" style="margin:0">When an answer arrives, a ✅ will show here.</p>
    </div>
    ${list.map(d => doubtCard(d, false)).join("") || `<div class="card"><p class="muted">You haven't asked any doubt yet.</p></div>`}`;
  document.getElementById("db_ask").onclick = async () => {
    const err = document.getElementById("db_err"); err.textContent = "";
    const q = document.getElementById("db_q").value.trim();
    if (!q) { err.textContent = "Write your question first"; return; }
    const sid = document.getElementById("db_subject").value;
    const subj = mySubjs.find(s => s.id === +sid);
    const { data: nd, error } = await sb.from("doubts").insert({
      student_id: me.id,
      subject_id: subj ? subj.id : null,
      class_id: subj ? subj.class_id : (enrolledIds[0] || null),
      question_text: q,
    }).select().single();
    if (error) { err.textContent = error.message; return; }
    toast("Doubt sent ❓ — 🤖 Getting the AI answer…");
    if (nd) { try { await sb.functions.invoke("answer-doubt", { body: { doubt_id: nd.id } }); } catch (_) { /* AI न आए तो Sir जवाब देंगे */ } }
    renderDoubts();
  };
  const dbmic = document.getElementById("db_mic");
  if (dbmic) dbmic.onclick = () => startVoice(document.getElementById("db_q"), dbmic);
  wireAI(); wireSpeak();
}

/* ---------------- Homework ---------------- */
let hwClassId = null, hwOpenId = null, hwSubmitId = null;
async function renderHomework() {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
  const [{ data: assigns }, { data: subs }, { data: subjects }] = await Promise.all([
    sb.from("assignments").select("*").order("created_at", { ascending: false }),
    sb.from("submissions").select("*"),
    sb.from("subjects").select("*"),
  ]);
  const subName = (id) => (subjects || []).find(s => s.id === id)?.name || "";
  const clsName = (id) => (myClasses.find(c => c.id === id) || {}).name || "";
  const list = (assigns || []).filter(a => !hwClassId || a.class_id === hwClassId);
  const mySub = (aid) => (subs || []).find(s => s.assignment_id === aid && s.student_id === me.id);
  const chips = `<div class="card"><h3>🎓 Choose a Class</h3><div class="row">
    <button class="${!hwClassId ? "" : "light"}" data-hwcls="">All Classes</button>
    ${myClasses.map(c => `<button class="${c.id === hwClassId ? "" : "light"}" data-hwcls="${c.id}">${esc(c.name)}</button>`).join("")}</div></div>`;

  let staffForm = "";
  if (isStaff()) {
    staffForm = `<div class="card"><h3>➕ Give New Homework</h3>
      <label>Title</label><input id="hw_title" placeholder="e.g. Chapter 5, questions 1-10">
      <div class="row">
        <div><label>Class</label><select id="hw_class">${myClasses.map(c => `<option value="${c.id}" ${c.id === hwClassId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
        <div><label>Subject</label><select id="hw_subject"><option value="">— None —</option>${(subjects || []).map(s => `<option value="${s.id}">${esc(s.name)} (${esc(clsName(s.class_id))})</option>`).join("")}</select></div>
      </div>
      <label>Instructions</label><textarea id="hw_ins" placeholder="Write clearly what is to be done…"></textarea>
      <div class="row">
        <div><label>Last Date to Submit</label><input id="hw_due" type="date"></div>
        <div><label>Full Marks</label><input id="hw_marks" type="number" placeholder="e.g. 10"></div>
      </div>
      <div class="error" id="hw_err"></div>
      <button class="gold" id="hw_add" style="width:100%">Send Homework</button></div>`;
  }

  const cards = list.map(a => {
    const mine = !isStaff() ? mySub(a.id) : null;
    const subCount = (subs || []).filter(s => s.assignment_id === a.id).length;
    const overdue = a.due_at && new Date(a.due_at) < new Date();
    return `<div class="card">
      <div style="display:flex; justify-content:space-between; gap:10px">
        <h3 style="margin:0; font-size:16px">📒 ${esc(a.title)}</h3>
        ${a.max_marks ? `<span class="pill gold">${a.max_marks} marks</span>` : ""}
      </div>
      <p class="muted" style="margin:6px 0">${esc(clsName(a.class_id))}${a.subject_id ? " • " + esc(subName(a.subject_id)) : ""}${a.due_at ? ` • Last date: <b style="color:${overdue ? "var(--bad)" : "inherit"}">${new Date(a.due_at).toLocaleDateString("en-IN")}</b>` : ""}</p>
      ${a.instructions ? `<p style="white-space:pre-wrap; margin:6px 0">${esc(a.instructions)}</p>` : ""}
      ${isStaff() ? `<p class="muted">Submitted: <b>${subCount}</b> students</p>
        <button class="light small" data-hwopen="${a.id}">${hwOpenId === a.id ? "Hide Submissions" : "View Submissions"}</button>
        <button class="danger small" data-hwdel="${a.id}">✕ Delete</button>
        ${hwOpenId === a.id ? `<div style="margin-top:10px">${(subs || []).filter(s => s.assignment_id === a.id).map(s => `
          <div class="item"><div style="flex:1"><div class="t" style="font-size:14px" data-subname="${s.student_id}">Student</div>
            <div class="s">${new Date(s.submitted_at).toLocaleString("en-IN")}${s.body ? `<br>${esc(s.body)}` : ""}</div>
            ${s.file_path ? `<button class="small light" data-hwfile="${esc(s.file_path)}">📎 Open File</button>` : ""}
            <div class="row" style="margin-top:6px">
              <div><label>Marks</label><input type="number" id="gm-${s.id}" value="${s.marks ?? ""}" style="width:90px"></div>
              <div style="flex:2"><label>Feedback</label><input id="gf-${s.id}" value="${esc(s.feedback || "")}"></div>
              <div style="flex:0 0 auto"><button class="small gold" data-grade="${s.id}">Save</button></div>
            </div></div>
            <span class="pill ${s.status === "reviewed" ? "green" : "gold"}">${esc(s.status)}</span></div>`).join("") || `<p class="muted">No one has submitted yet.</p>`}</div>` : ""}`
      : mine ? `<p>✅ <b>Submitted</b> — ${new Date(mine.submitted_at).toLocaleString("en-IN")}
          ${mine.status === "reviewed" ? `<br>🏅 Marks: <b>${mine.marks ?? "—"}${a.max_marks ? " / " + a.max_marks : ""}</b>${mine.feedback ? `<br>💬 ${esc(mine.feedback)}` : ""}` : `<br><span class="muted">Awaiting teacher's check</span>`}</p>
          ${mine.file_path ? `<button class="small light" data-hwfile="${esc(mine.file_path)}">📎 My File</button>` : ""}
          ${a.allow_resubmit || mine.status !== "reviewed" ? `<button class="small" data-hwsub="${a.id}">Submit Again</button>` : ""}`
      : `<p style="color:var(--bad); font-weight:700">⏳ Not submitted yet</p>
          <button class="gold small" data-hwsub="${a.id}">📤 Submit Homework</button>`}
      ${hwSubmitId === a.id && !isStaff() ? `<div style="margin-top:10px">
          <label>Write your answer</label><textarea id="sub_body" placeholder="Write your homework here…">${mine ? esc(mine.body || "") : ""}</textarea>
          <label>Photo / File (optional)</label><input id="sub_file" type="file">
          <div class="error" id="sub_err"></div>
          <button class="gold" id="sub_send" style="width:100%">Submit</button></div>` : ""}
    </div>`;
  }).join("");

  $app.innerHTML = chips + staffForm + (cards || `<div class="card"><p class="muted">No homework in this class yet.</p></div>`);

  $app.querySelectorAll("[data-hwcls]").forEach(b => b.onclick = () => { hwClassId = b.dataset.hwcls ? +b.dataset.hwcls : null; renderHomework(); });
  if (isStaff()) {
    document.getElementById("hw_add").onclick = async () => {
      const err = document.getElementById("hw_err"); err.textContent = "";
      const title = document.getElementById("hw_title").value.trim();
      if (!title) { err.textContent = "Enter a title"; return; }
      const due = document.getElementById("hw_due").value;
      const { error } = await sb.from("assignments").insert({
        teacher_id: me.id, title, class_id: +document.getElementById("hw_class").value,
        subject_id: document.getElementById("hw_subject").value ? +document.getElementById("hw_subject").value : null,
        instructions: document.getElementById("hw_ins").value.trim() || null,
        due_at: due ? new Date(due + "T23:59:00").toISOString() : null,
        max_marks: document.getElementById("hw_marks").value ? +document.getElementById("hw_marks").value : null,
        status: "published" });
      if (error) { err.textContent = error.message; return; }
      toast("Homework sent 📒"); renderHomework();
    };
    $app.querySelectorAll("[data-hwdel]").forEach(b => b.onclick = async () => {
      if (!confirm("This homework and all its submissions will be deleted. Are you sure?")) return;
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
      toast("Marks given 🏅"); renderHomework();
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
        hwSubmitId = null; toast("Homework submitted ✅"); renderHomework();
      } catch (e) { err.textContent = e.message; }
    };
  }
  $app.querySelectorAll("[data-hwfile]").forEach(b => b.onclick = () => openStoredFile("avatars", b.dataset.hwfile));
}

/* ---------------- Attendance ---------------- */
let attClassId = null, attDate = null, attMarks = {};
let attMonth = null; // v44: student attendance calendar month (YYYY-MM)
async function renderAttendance() {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
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
      <div class="card pol-sec v45rows"><h3>✅ Mark Attendance • उपस्थिति लगाएँ</h3>
        <div class="row">
          <div><label>Class</label><select id="att_class">${myClasses.map(c => `<option value="${c.id}" ${c.id === attClassId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
          <div><label>Date</label><input id="att_date" type="date" value="${attDate}"></div>
        </div>
        <p class="muted">Choose Present / Absent / Leave for each student, then save.</p>
        ${(studs || []).map(s => `<div class="item"><div class="t" style="font-size:14px">${esc(s.full_name)}</div>
          <div style="display:flex; gap:5px">
            ${[["present", "P", "var(--ok)"], ["absent", "A", "var(--bad)"], ["leave", "L", "#b8860b"]].map(([v, l, col]) => `
              <button class="small ${attMarks[s.id] === v ? "" : "light"}" data-att="${s.id}:${v}" style="${attMarks[s.id] === v ? `background:${col}` : ""}">${l}</button>`).join("")}
          </div></div>`).join("") || `<p class="muted">There is no student in this class.</p>`}
        <button class="gold" id="att_save" style="width:100%; margin-top:10px">Save Attendance</button>
        <button class="light" id="att_csv" style="width:100%; margin-top:8px">⬇ CSV Download — This Day's Attendance</button>
      </div>`;
    document.getElementById("att_class").onchange = (e) => { attClassId = +e.target.value; attMarks = {}; renderAttendance(); };
    document.getElementById("att_date").onchange = (e) => { attDate = e.target.value; attMarks = {}; renderAttendance(); };
    $app.querySelectorAll("[data-att]").forEach(b => b.onclick = () => {
      const [sid, v] = b.dataset.att.split(":"); attMarks[sid] = v; renderAttendance();
    });
    document.getElementById("att_save").onclick = async () => {
      const rows = Object.entries(attMarks).map(([sid, st]) => ({ student_id: sid, class_id: attClassId, on_date: attDate, status: st, marked_by: me.id }));
      if (!rows.length) return toast("Mark the attendance first");
      const { error } = await sb.from("attendance").upsert(rows, { onConflict: "student_id,on_date" });
      if (error) return toast("Error: " + error.message);
      toast(`Attendance saved ✅ (${rows.length} students)`); attMarks = {}; renderAttendance();
    };
    document.getElementById("att_csv").onclick = () => {
      if (!(studs || []).length) return toast("No students to download");
      downloadCSV(`attendance-${attDate}.csv`, ["Student", "Class", "Date", "Status"],
        studs.map(s => [s.full_name, clsName(attClassId), attDate, attMarks[s.id] || "Not marked"]));
      toast("CSV downloaded ⬇");
    };
    return;
  }

  // Student view — month calendar (photo 7)
  if (profile.role !== "parent") {
    if (!attMonth) { const nd = new Date(); attMonth = nd.getFullYear() + "-" + String(nd.getMonth() + 1).padStart(2, "0"); }
    const [ay, am] = attMonth.split("-").map(Number);
    const aPad = (n) => String(n).padStart(2, "0");
    const aLastDay = new Date(ay, am, 0).getDate();
    const { data: mrecs } = await sb.from("attendance").select("*").eq("student_id", me.id)
      .gte("on_date", `${ay}-${aPad(am)}-01`).lte("on_date", `${ay}-${aPad(am)}-${aPad(aLastDay)}`).order("on_date", { ascending: true });
    const mrows = mrecs || [];
    const byDate = {}; mrows.forEach(r => { byDate[r.on_date] = r.status; });
    const mTotal = mrows.length;
    const mPresent = mrows.filter(r => r.status === "present").length;
    const mAbsent = mrows.filter(r => r.status === "absent").length;
    const mLeave = mrows.filter(r => r.status === "leave").length;
    const mPct = mTotal ? Math.round((mPresent / mTotal) * 100) : 0;
    const RC = 2 * Math.PI * 44;
    const moName = new Date(ay, am - 1, 1).toLocaleDateString("hi-IN", { month: "long", year: "numeric" });
    const firstDow = (new Date(ay, am - 1, 1).getDay() + 6) % 7; // Monday-first
    let cells = "";
    for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell empty"></div>`;
    for (let d = 1; d <= aLastDay; d++) {
      const ds = `${ay}-${aPad(am)}-${aPad(d)}`;
      const st = byDate[ds];
      cells += `<div class="cal-cell ${st === "present" ? "p" : st === "absent" ? "a" : st === "leave" ? "l" : ""}${ds === today ? " today" : ""}">${d}</div>`;
    }
    const stPill = { present: ["उपस्थित", "green"], absent: ["अनुपस्थित", "red"], leave: ["छुट्टी", "gold"] };
    $app.innerHTML = `
      <div class="card"><h3 style="margin-top:0">✅ उपस्थिति • Attendance</h3>
        <div class="cal-head"><button class="light small" id="attPrev">‹ Prev Month</button><div class="mo">${moName}</div><button class="light small" id="attNext">Next Month ›</button></div>
        <div class="cal-grid" id="attCalGrid">${["सो", "मं", "बु", "गु", "शु", "श", "र"].map(d => `<div class="cal-dow">${d}</div>`).join("")}${cells}</div>
        <div class="cal-legend"><span><span class="dot" style="background:#0e9f6e"></span>उपस्थित</span><span><span class="dot" style="background:#d64541"></span>अनुपस्थित</span><span><span class="dot" style="background:#f2b705"></span>छुट्टी</span></div>
      </div>
      <div class="card"><div class="ring-wrap" style="flex-wrap:wrap">
        <div style="flex:1; min-width:180px"><h3 style="margin:0 0 4px">📊 इस महीने का सार</h3>
          <div class="drow"><span class="dl">कुल क्लास</span><span class="dv">${mTotal}</span></div>
          <div class="drow"><span class="dl">उपस्थित</span><span class="dv" style="color:var(--ok)">${mPresent}</span></div>
          <div class="drow"><span class="dl">अनुपस्थित</span><span class="dv" style="color:var(--bad)">${mAbsent}</span></div>
          ${mLeave ? `<div class="drow"><span class="dl">छुट्टी</span><span class="dv" style="color:#8a6400">${mLeave}</span></div>` : ""}
        </div>
        <div class="ring">
          <svg width="104" height="104"><circle cx="52" cy="52" r="44" stroke="#e6ecf6" stroke-width="10" fill="none"/>
          <circle cx="52" cy="52" r="44" stroke="#0e9f6e" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${RC}" stroke-dashoffset="${RC - (RC * mPct) / 100}"/></svg>
          <div class="ring-c">${mPct}%<br><span style="font-size:11px; color:var(--muted)">उपस्थिति</span></div>
        </div>
      </div></div>
      <div class="card"><h3 style="margin-top:0">📋 विवरण • Details</h3>
        ${[...mrows].reverse().map(r => `<div class="item"><div><div class="t" style="font-size:14px">${new Date(r.on_date + "T00:00:00").toLocaleDateString("hi-IN", { weekday: "short", day: "numeric", month: "short" })}</div>
          <div class="s">${esc(clsName(r.class_id))}</div></div>
          <span class="pill ${(stPill[r.status] || ["—", "grey"])[1]}">${(stPill[r.status] || ["—"])[0]}</span></div>`).join("") || `<p class="muted" style="margin:0">इस महीने कोई उपस्थिति दर्ज नहीं है।</p>`}
      </div>`;
    const setMonth = (delta) => { const d = new Date(ay, am - 1 + delta, 1); attMonth = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); renderAttendance(); };
    document.getElementById("attPrev").onclick = () => setMonth(-1);
    document.getElementById("attNext").onclick = () => setMonth(1);
    return;
  }

  // Parent view
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
    <div class="card"><h3>✅ ${profile.role === "parent" ? "Children's Attendance" : "My Attendance"}</h3>
      <div class="stats">
        <div class="stat"><div class="si" style="background:#e2f4ec">🙋</div><div class="n">${present}</div><div class="l">Present Days</div></div>
        <div class="stat"><div class="si" style="background:#e8f1fe">📅</div><div class="n">${total}</div><div class="l">Total Days</div></div>
        <div class="stat"><div class="si" style="background:#fdf3d7">📊</div><div class="n">${pct}%</div><div class="l">Attendance</div></div>
      </div></div>
    <div class="card"><h3>Recent Attendance</h3>
      ${mine.map(r => `<div class="item"><div><div class="t" style="font-size:14px">${new Date(r.on_date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</div>
        <div class="s">${esc(clsName(r.class_id))}${profile.role === "parent" ? " • " + esc(nameOf(r.student_id)) : ""}</div></div>
        <span class="pill ${r.status === "present" ? "green" : r.status === "absent" ? "red" : "gold"}">${r.status}</span></div>`).join("") || `<p class="muted">No attendance recorded yet.</p>`}
    </div>`;
}

/* ---------------- Timetable ---------------- */
let ttClassId = null;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
async function renderTimetable() {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
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
    ${isStaff() ? `<div class="card"><h3>➕ Add Period</h3>
      <div class="row">
        <div><label>Day</label><select id="tt_day">${WEEKDAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select></div>
        <div><label>Subject</label><select id="tt_subject">${(subjects || []).filter(s => s.class_id === ttClassId).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("") || `<option value="">— No subject —</option>`}</select></div>
      </div>
      <div class="row">
        <div><label>Start</label><input id="tt_from" type="time" value="09:00"></div>
        <div><label>End</label><input id="tt_to" type="time" value="09:45"></div>
        <div><label>Teacher</label><select id="tt_teacher"><option value="">— None —</option>${(staffList || []).map(s => `<option value="${s.id}">${esc(s.full_name)}</option>`).join("")}</select></div>
      </div>
      <div class="error" id="tt_err"></div>
      <button class="gold" id="tt_add" style="width:100%">Add Period</button></div>` : ""}
    ${WEEKDAYS.map((d, i) => {
      const dayEntries = (entries || []).filter(e => e.weekday === i);
      if (!dayEntries.length) return "";
      return `<div class="card"><h3>${d}</h3>
        ${dayEntries.map(e => `<div class="item"><div><div class="t" style="font-size:14px">${esc(subName(e.subject_id))}</div>
          <div class="s">🕐 ${fmt(e.starts_at)} – ${fmt(e.ends_at)}${e.teacher_id && staffName(e.teacher_id) ? " • 👨‍🏫 " + esc(staffName(e.teacher_id)) : ""}</div></div>
          ${isStaff() ? `<button class="danger small" data-ttdel="${e.id}">✕</button>` : ""}</div>`).join("")}
      </div>`;
    }).join("") || `<div class="card"><p class="muted">This class's timetable has not been made yet.</p></div>`}`;

  $app.querySelectorAll("[data-ttcls]").forEach(b => b.onclick = () => { ttClassId = +b.dataset.ttcls; renderTimetable(); });
  if (isStaff()) {
    document.getElementById("tt_add").onclick = async () => {
      const err = document.getElementById("tt_err"); err.textContent = "";
      const from = document.getElementById("tt_from").value, to = document.getElementById("tt_to").value;
      if (!from || !to) { err.textContent = "Choose the time"; return; }
      const { error } = await sb.from("timetable_entries").insert({
        class_id: ttClassId, weekday: +document.getElementById("tt_day").value,
        subject_id: document.getElementById("tt_subject").value ? +document.getElementById("tt_subject").value : null,
        teacher_id: document.getElementById("tt_teacher").value || null,
        starts_at: from, ends_at: to });
      if (error) { err.textContent = error.message; return; }
      toast("Period added 🗓️"); renderTimetable();
    };
    $app.querySelectorAll("[data-ttdel]").forEach(b => b.onclick = async () => {
      const { error } = await sb.from("timetable_entries").delete().eq("id", +b.dataset.ttdel);
      if (error) return toast("Error: " + error.message);
      renderTimetable();
    });
  }
}

/* ---------------- Video Studio (staff + student personal mode) ----------------
   YouTube video -> AI notes, MCQs, questions & flashcards.
   Generation runs in the video-study Edge Function (Gemini watches the
   video itself — no transcript scraping). A second AI pass re-checks
   every MCQ answer; doubtful MCQs are flagged, never silently trusted.
   Results are stored per-user in studio_generations (own rows only).
   Staff rows may be imported into the shared Question Bank or published
   as class Notes. Student rows are PERSONAL (payload.personal) — the
   import/publish buttons are never rendered for them. */
let studioTab = "notes";   // notes | mcqs | questions | cards | glossary
let studioCurrent = null;  // open studio_generations row
let studioBusy = false;

const ytIdOf = (u) => {
  const m = String(u || "").match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
};
const studioLangLabel = (m) => ({ bilingual: "Hindi + English", hindi: "Hindi", english: "English" }[m] || m || "");

async function renderStudio() {
  if (studioCurrent) { renderStudioResult(); return; }
  $app.innerHTML = `<div class="loading">Loading…</div>`;
  const [gRes, sRes, cRes] = await Promise.all([
    sb.from("studio_generations").select("id,created_at,youtube_url,video_title,class_label,subject,chapter,language_mode,difficulty").eq("user_id", me.id).order("created_at", { ascending: false }).limit(50),
    sb.from("subjects").select("*").order("sort_order"),
    sb.from("chapters").select("*").order("sort_order"),
  ]);
  if (gRes.error) {
    $app.innerHTML = `<div class="card"><h3>🎬 Video Studio</h3><p class="muted">This feature is still being prepared. Please check again shortly.</p></div>`;
    return;
  }
  const gens = gRes.data || [], subjects = sRes.data || [], chapters = cRes.data || [];
  const clsName = (id) => (myClasses.find(c => c.id === id) || {}).name || "";
  const fmtD = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  $app.innerHTML = `
    <div class="card"><h3>🎬 Video Studio — Notes & Questions from a Video</h3>
      ${isStaff()
        ? `<p class="muted" style="margin:0 0 6px">Paste a YouTube lesson link. The AI will watch the video and prepare chapter-wise notes, MCQs, short &amp; long questions and flashcards. Every MCQ answer is double-checked by a second AI pass — doubtful ones are flagged 🚩 for you to verify.</p>`
        : `<p class="muted" style="margin:0 0 6px">Apni padhai ke liye kisi bhi YouTube lesson ka link daalo — AI video dekhkar tumhare liye notes, MCQs, short &amp; long questions aur flashcards bana dega. Har MCQ ka jawab dusri AI jaanch se double-check hota hai — shak wala 🚩 se chinhit rahega. Ye material sirf <b>tumhari personal library</b> me rahega, class me kuch publish nahi hoga. Roz ki limit: <b>5 video</b>.</p>`}
      <label>YouTube Video Link</label><input id="vs_url" placeholder="https://www.youtube.com/watch?v=…">
      <label>Class</label><select id="vs_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <label>Subject</label><select id="vs_subject"><option value="">— None —</option>${subjects.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(clsName(s.class_id))})</option>`).join("")}</select>
      <label>Chapter</label><select id="vs_chapter"><option value="">— None —</option></select>
      <label>Language</label><select id="vs_lang"><option value="bilingual">Hindi + English (Bilingual)</option><option value="hindi">Hindi only</option><option value="english">English only</option></select>
      <label>How many MCQs?</label><select id="vs_count"><option>10</option><option selected>15</option><option>25</option><option>50</option></select>
      <label>Difficulty</label><select id="vs_diff"><option value="mixed">Mixed</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
      <div class="error" id="vs_err"></div>
      <div class="studio-stage hidden" id="vs_stage"></div>
      <button class="gold" id="vs_gen" style="width:100%;margin-top:10px">🎬 Generate Study Material</button>
      <p class="muted" style="margin:8px 0 0">Generation usually takes 1–3 minutes for a full lesson video. Please keep this screen open.</p>
    </div>
    <div class="card"><h3 style="margin:0">🗂️ ${isStaff() ? "My Library" : "My Personal Library"} (${gens.length})</h3></div>
    ${gens.map(g => `
      <div class="card">
        <div style="font-weight:700;font-size:15.5px;line-height:1.45">🎬 ${esc(g.video_title || "YouTube Video")}</div>
        <p class="muted" style="margin:5px 0 0">${esc(g.class_label || "")}${g.subject ? " • " + esc(g.subject) : ""}${g.chapter ? " • " + esc(g.chapter) : ""} • ${esc(studioLangLabel(g.language_mode))} • ${fmtD(g.created_at)}</p>
        <div class="row" style="margin-top:10px">
          <button class="small" data-vsopen="${g.id}">Open</button>
          <a href="${esc(g.youtube_url)}" target="_blank" rel="noopener"><button class="light small" type="button">▶ Video</button></a>
          <button class="danger small" data-vsdel="${g.id}">Delete</button>
        </div>
      </div>`).join("") || `<div class="card"><p class="muted">Nothing generated yet — your study material will appear here.</p></div>`}`;

  const subSel = document.getElementById("vs_subject"), chSel = document.getElementById("vs_chapter");
  const fillChapters = () => {
    const sid = subSel.value ? +subSel.value : null;
    const list = sid ? chapters.filter(c => c.subject_id === sid) : [];
    chSel.innerHTML = `<option value="">— None —</option>` + list.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  };
  subSel.onchange = fillChapters;

  document.getElementById("vs_gen").onclick = async () => {
    if (studioBusy) return;
    const err = document.getElementById("vs_err"); err.textContent = "";
    const url = document.getElementById("vs_url").value.trim();
    if (!ytIdOf(url)) { err.textContent = "Paste a valid YouTube video link"; return; }
    const class_id = +document.getElementById("vs_class").value;
    const subject_id = subSel.value ? +subSel.value : null;
    const chapter_id = chSel.value ? +chSel.value : null;
    const class_label = clsName(class_id);
    const subject = subject_id ? ((subjects.find(s => s.id === subject_id) || {}).name || "") : "";
    const chapter = chapter_id ? ((chapters.find(c => c.id === chapter_id) || {}).name || "") : "";
    const language_mode = document.getElementById("vs_lang").value;
    const mcq_count = +document.getElementById("vs_count").value;
    const difficulty = document.getElementById("vs_diff").value;
    studioBusy = true;
    const btn = document.getElementById("vs_gen"); btn.disabled = true;
    const stageEl = document.getElementById("vs_stage");
    const stages = ["📡 Sending the video to the AI…", "🎬 The AI is watching the video…", "📝 Writing notes, MCQs and questions…", "🔍 Double-checking every MCQ answer…"];
    let si = 0; stageEl.textContent = stages[0]; stageEl.classList.remove("hidden");
    const timer = setInterval(() => { si = Math.min(si + 1, stages.length - 1); stageEl.textContent = stages[si]; }, 12000);
    try {
      const { data, error } = await sb.functions.invoke("video-study", { body: { youtube_url: url, class_label, subject, chapter, language_mode, mcq_count, difficulty, personal: !isStaff() } });
      if (error) {
        // Show the function's REAL error when it sent one; only a bare
        // transport failure (no response — timeout / network) gets the
        // honest retry message. Never disguise the real error.
        let msg = null;
        try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) {}
        if (!msg) msg = /failed to send|fetch|timeout|timed out|network/i.test(error.message || "")
          ? "Generation timed out — try a shorter video or try again."
          : (error.message || "Generation failed");
        throw new Error(msg);
      }
      if (!data || !data.payload) throw new Error("The AI returned nothing — please try again.");
      const payload = isStaff() ? { ...data.payload, class_id, subject_id, chapter_id } : { ...data.payload };
      const { data: row, error: insErr } = await sb.from("studio_generations").insert({
        user_id: me.id, youtube_url: url, video_title: payload.video_title || "YouTube Video",
        class_label, subject, chapter, language_mode, difficulty, payload,
      }).select().single();
      if (insErr) throw insErr;
      studioCurrent = row; studioTab = "notes"; studioBusy = false;
      toast("Study material ready 🎉");
      renderStudioResult();
    } catch (e) {
      err.textContent = e.message || String(e);
    } finally {
      clearInterval(timer); studioBusy = false;
      const b2 = document.getElementById("vs_gen"); if (b2) b2.disabled = false;
      const s2 = document.getElementById("vs_stage"); if (s2) s2.classList.add("hidden");
    }
  };

  $app.querySelectorAll("[data-vsopen]").forEach(b => b.onclick = async () => {
    const { data, error } = await sb.from("studio_generations").select("*").eq("id", +b.dataset.vsopen).single();
    if (error || !data) return toast("Could not open this item");
    studioCurrent = data; studioTab = "notes"; renderStudioResult();
  });
  $app.querySelectorAll("[data-vsdel]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this generated material?")) return;
    const { error } = await sb.from("studio_generations").delete().eq("id", +b.dataset.vsdel);
    if (error) return toast("Error: " + error.message);
    toast("Deleted"); renderStudio();
  });
}

function studioNotesBody(p) {
  const L = [];
  if (p.summary) { L.push("SUMMARY", p.summary, ""); }
  if ((p.key_points || []).length) { L.push("KEY POINTS"); p.key_points.forEach(k => L.push("• " + k)); L.push(""); }
  (p.notes || []).forEach(n => { L.push("== " + (n.title || "Notes") + " =="); (n.points || []).forEach(pt => L.push("• " + pt)); L.push(""); });
  if ((p.glossary || []).length) { L.push("IMPORTANT WORDS (शब्दावली)"); p.glossary.forEach(g => L.push("• " + g.term + " — " + g.meaning)); L.push(""); }
  if ((p.short_questions || []).length) { L.push("SHORT QUESTIONS & ANSWERS"); p.short_questions.forEach((q, i) => { L.push(`Q${i + 1}. ${q.question}`); if (q.answer) L.push("Ans. " + q.answer); }); }
  return L.join("\n").trim();
}

function studioPrint(kind) {
  const g = studioCurrent; if (!g) return;
  const p = g.payload || {};
  const mcqs = p.mcqs || [], shorts = p.short_questions || [], longs = p.long_questions || [];
  const marks = mcqs.length + shorts.length * 3 + longs.length * 5;
  const isKey = kind === "key";
  const secA = mcqs.length ? `<div class="pq-sec">Section A — Multiple Choice Questions (1 mark each)</div>` + mcqs.map((q, i) => `
    <div class="pq-q"><b>Q${i + 1}.</b> ${esc(q.question)}
      <div class="pq-opts">${q.options.map(o => `<span>${o.key}) ${esc(o.text)}${isKey && o.key === q.answer ? " ✓" : ""}</span>`).join("")}</div>
      ${isKey ? `<div class="pq-ans"><b>Answer: ${esc(q.answer)}</b></div>${q.explanation ? `<div class="pq-expl">${esc(q.explanation)}</div>` : ""}` : ""}
    </div>`).join("") : "";
  const secB = shorts.length ? `<div class="pq-sec">Section B — Short Answer Questions (3 marks each)</div>` + shorts.map((q, i) => `
    <div class="pq-q"><b>Q${i + 1}.</b> ${esc(q.question)}${isKey && q.answer ? `<div class="pq-ans"><b>Answer:</b> ${esc(q.answer)}</div>` : ""}</div>`).join("") : "";
  const secC = longs.length ? `<div class="pq-sec">Section C — Long Answer Questions (5 marks each)</div>` + longs.map((q, i) => `
    <div class="pq-q"><b>Q${i + 1}.</b> ${esc(q.question)}${isKey && (q.outline || []).length ? `<div class="pq-ans"><b>Answer points:</b><br>${q.outline.map(pt => "• " + esc(pt)).join("<br>")}</div>` : ""}</div>`).join("") : "";
  let area = document.getElementById("printArea");
  if (!area) { area = document.createElement("div"); area.id = "printArea"; document.body.appendChild(area); }
  area.innerHTML = `<div class="pq">
    <div class="pq-head"><div class="pq-name">TARGET ACADEMY COACHING CENTRE</div>
      <div class="pq-sub">Manikpur, Gopalganj (Bihar)</div>
      <div class="pq-title">${esc(p.video_title || g.video_title || "Question Paper")}${isKey ? " — ANSWER KEY" : ""}</div></div>
    <div class="pq-meta"><span><b>Class:</b> ${esc(g.class_label || "—")}${g.subject ? " &nbsp; <b>Subject:</b> " + esc(g.subject) : ""}${g.chapter ? " &nbsp; <b>Chapter:</b> " + esc(g.chapter) : ""}</span><span><b>Full Marks:</b> ${marks}</span></div>
    ${isKey ? "" : `<div class="pq-meta"><span><b>Name:</b> ______________________________</span><span><b>Roll No.:</b> ______________</span></div>
    <p style="margin:6px 0"><b>General Instructions:</b> All questions are compulsory. Write neat and clear answers.</p>`}
    ${secA}${secB}${secC}
    <p style="margin-top:18px;text-align:center" class="pq-sub">— Source video: ${esc(g.youtube_url)} —</p>
  </div>`;
  document.body.classList.add("printmode");
  window.print();
  setTimeout(() => document.body.classList.remove("printmode"), 600);
}

function renderStudioResult() {
  const g = studioCurrent;
  if (!g) { renderStudio(); return; }
  const p = g.payload || {};
  const personal = !!p.personal;
  const mcqs = p.mcqs || [];
  const doubtful = mcqs.filter(q => q.doubtful).length;
  const checked = mcqs.filter(q => q.verified).length;
  const fmtD = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const tabs = [["notes", "📝 Notes"], ["mcqs", `❓ MCQs (${mcqs.length})`], ["questions", "✍️ Questions"], ["cards", "🃏 Flashcards"], ["glossary", "📖 Glossary"]];
  let body = "";
  if (studioTab === "notes") {
    body = `
      ${p.summary ? `<div class="card"><h3>📌 Summary</h3><div class="note-body">${esc(p.summary)}</div></div>` : ""}
      ${(p.key_points || []).length ? `<div class="card"><h3>⭐ Key Points</h3>${p.key_points.map(k => `<p style="margin:5px 0">• ${esc(k)}</p>`).join("")}</div>` : ""}
      ${(p.notes || []).map(n => `<div class="card"><h3>${esc(n.title || "Notes")}</h3>${(n.points || []).map(pt => `<p style="margin:5px 0">• ${esc(pt)}</p>`).join("")}</div>`).join("")}`;
  } else if (studioTab === "mcqs") {
    const vnote = p.verify_status === "done"
      ? `<div class="card" style="padding:12px 16px"><b>🔍 Answer check:</b> ${checked} of ${mcqs.length} MCQs double-checked OK${doubtful ? ` • <span style="color:var(--bad)"><b>${doubtful} flagged 🚩 — please verify from the video before use</b></span>` : ""}${p.mcq_shortfall ? `<br><span class="muted">Note: ${p.mcq_shortfall} fewer MCQs than requested could be prepared from this video.</span>` : ""}</div>`
      : `<div class="card" style="padding:12px 16px"><b>🔍 Answer check:</b> <span style="color:var(--bad)">The double-check could not run for this video — please review the answers yourself ${personal ? "before studying from them" : "before giving them to students"}.</span></div>`;
    body = vnote + mcqs.map((q, i) => `
      <div class="card">
        <div style="font-weight:700;font-size:15.5px;line-height:1.5"><b>Q${i + 1}.</b> ${esc(q.question)}
          ${q.doubtful ? `<span class="pill red">🚩 Please verify</span>` : q.verified ? `<span class="pill green">✓ Double-checked</span>` : ""}</div>
        <div style="margin-top:8px">${q.options.map(o => `<div class="optrow ${o.key === q.answer ? "opt-right" : ""}"><b>${o.key}.</b> ${esc(o.text)}${o.key === q.answer ? " ✓" : ""}</div>`).join("")}</div>
        ${q.doubtful && q.verify_answer ? `<p class="s" style="color:var(--bad);margin-top:6px">🚩 The double-check pass suggested option <b>${esc(q.verify_answer)}</b> instead — please confirm the correct answer from the video before using this question.</p>` : ""}
        ${q.explanation ? `<div class="expl-box" style="margin-top:8px">💡 <b>Explanation:</b> ${esc(q.explanation)}</div>` : ""}
      </div>`).join("");
  } else if (studioTab === "questions") {
    body = `
      ${(p.short_questions || []).length ? `<div class="card"><h3>✍️ Short Questions (with answers)</h3>${p.short_questions.map((q, i) => `
        <div style="margin:0 0 12px"><div style="font-weight:700">Q${i + 1}. ${esc(q.question)}</div>
        ${q.answer ? `<div class="expl-box" style="margin-top:5px">${esc(q.answer)}</div>` : ""}</div>`).join("")}</div>` : ""}
      ${(p.long_questions || []).length ? `<div class="card"><h3>📜 Long Questions (answer outline)</h3>${p.long_questions.map((q, i) => `
        <div style="margin:0 0 12px"><div style="font-weight:700">Q${i + 1}. ${esc(q.question)}</div>
        ${(q.outline || []).map(pt => `<p style="margin:4px 0 4px 14px">• ${esc(pt)}</p>`).join("")}</div>`).join("")}</div>` : ""}`;
  } else if (studioTab === "cards") {
    body = `<p class="muted" style="margin:2px 2px 10px">Tap a card to flip it and see the answer.</p>
      <div class="flash-grid">${(p.flashcards || []).map((f, i) => `
        <div class="flash" data-flash="${i}"><div class="flash-in">
          <div class="flash-face flash-front"><div>${esc(f.front)}</div><span class="flash-hint">Tap to flip 🔄</span></div>
          <div class="flash-face flash-back"><div>${esc(f.back)}</div></div>
        </div></div>`).join("")}</div>
      ${(p.flashcards || []).length ? "" : `<div class="card"><p class="muted">No flashcards were prepared for this video.</p></div>`}`;
  } else if (studioTab === "glossary") {
    body = `<div class="card"><h3>📖 Important Words</h3>${(p.glossary || []).map(x => `
      <div class="row" style="justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:7px 0">
        <b>${esc(x.term)}</b><span style="text-align:right">${esc(x.meaning)}</span></div>`).join("") || `<p class="muted">No glossary for this video.</p>`}</div>`;
  }
  $app.innerHTML = `
    <button class="light small" id="vs_back">← Back to Video Studio</button>
    <div class="card" style="margin-top:10px"><h3 style="margin:0">🎬 ${esc(p.video_title || g.video_title || "YouTube Video")}</h3>
      <p class="muted" style="margin:6px 0 0">${esc(g.class_label || "")}${g.subject ? " • " + esc(g.subject) : ""}${g.chapter ? " • " + esc(g.chapter) : ""} • ${esc(studioLangLabel(g.language_mode))} • ${fmtD(g.created_at)} • <a href="${esc(g.youtube_url)}" target="_blank" rel="noopener">▶ Watch video</a></p>
      <div class="row" style="margin-top:12px;flex-wrap:wrap">
        <button class="small" id="vs_paper">🖨️ Question Paper (PDF)</button>
        <button class="small light" id="vs_key">📄 Answer Key (PDF)</button>
        ${personal ? "" : `<button class="small gold" id="vs_import">⬇ Import ${mcqs.length} MCQs to Question Bank</button>
        <button class="small light" id="vs_savenotes">📗 Save Notes to Platform</button>`}
      </div>
      ${personal
        ? `<p class="muted" style="margin:8px 0 0">👤 Ye tumhara <b>personal study pack</b> hai — sirf tumhari library me hai, class me publish nahi hua. Print ke liye browser ke "Save as PDF" ka upyog karo.</p>`
        : `<p class="muted" style="margin:8px 0 0">Question Paper has no answers (for students); Answer Key has answers + explanations (for you). Use the browser's "Save as PDF" in the print window.</p>`}
    </div>
    <div class="mtabs">${tabs.map(([k, l]) => `<button class="chip ${studioTab === k ? "on" : ""}" data-vtab="${k}">${l}</button>`).join("")}</div>
    ${body}`;
  document.getElementById("vs_back").onclick = () => { studioCurrent = null; renderStudio(); };
  $app.querySelectorAll("[data-vtab]").forEach(b => b.onclick = () => { studioTab = b.dataset.vtab; renderStudioResult(); });
  $app.querySelectorAll("[data-flash]").forEach(c => c.onclick = () => c.classList.toggle("on"));
  document.getElementById("vs_paper").onclick = () => studioPrint("paper");
  document.getElementById("vs_key").onclick = () => studioPrint("key");
  const vsImportBtn = document.getElementById("vs_import");
  if (vsImportBtn) vsImportBtn.onclick = async () => {
    if (!p.class_id) return toast("No class was selected for this video — generate again with a class");
    if (!mcqs.length) return toast("No MCQs to import");
    if (!confirm(`Import ${mcqs.length} MCQs into the Question Bank (${g.class_label}${g.subject ? " • " + g.subject : ""})? They will be published for test-building.`)) return;
    const rows = mcqs.map(q => ({
      teacher_id: me.id, class_id: p.class_id, subject_id: p.subject_id || null, chapter_id: p.chapter_id || null,
      qtype: "mcq_single", question_text: q.question,
      options: q.options.map(o => ({ key: o.key, text: o.text })),
      correct_answer: [q.answer], explanation: q.explanation || null,
      marks: 1, difficulty: ["easy", "medium", "hard"].includes(q.difficulty) ? q.difficulty : "medium",
      status: "published",
    }));
    const { error } = await sb.from("questions").insert(rows);
    if (error) return toast("Error: " + error.message);
    toast(`✅ ${rows.length} MCQs added to the Question Bank`);
  };
  const vsSaveBtn = document.getElementById("vs_savenotes");
  if (vsSaveBtn) vsSaveBtn.onclick = async () => {
    if (!p.class_id) return toast("No class was selected for this video — generate again with a class");
    const bodyText = studioNotesBody(p);
    if (!bodyText) return toast("No notes to save for this video");
    const { error } = await sb.from("notes").insert({
      teacher_id: me.id, class_id: p.class_id, subject_id: p.subject_id || null, chapter_id: p.chapter_id || null,
      title: (p.video_title || g.video_title || "Video Notes") + " — Notes", body: bodyText, status: "published",
    });
    if (error) return toast("Error: " + error.message);
    toast("📗 Notes saved — students can see them in the Notes section");
  };
}
