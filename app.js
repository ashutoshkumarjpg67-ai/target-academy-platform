import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $app = document.getElementById("app");
const $tabbar = document.getElementById("tabbar");
const $logout = document.getElementById("logoutBtn");
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
const roleName = (r) => ({admin:"Admin • व्यवस्थापक", teacher:"Teacher • शिक्षक", student:"Student • छात्र", parent:"Parent • अभिभावक"}[r] || r);

/* ---------------- Auth screens ---------------- */
function renderAuth(mode = "login") {
  $tabbar.classList.add("hidden"); $logout.classList.add("hidden");
  $app.innerHTML = `
    <div class="hero">
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
  renderShell();
}
$logout.onclick = async () => { await sb.auth.signOut(); location.reload(); };

/* ---------------- Shell + tabs ---------------- */
function renderShell() {
  const tabs = [
    { id: "home", ic: "🏠", label: "Home" },
    { id: "study", ic: "📚", label: "Study" },
    { id: "tests", ic: "📝", label: "Tests" },
    ...(isStaff() ? [{ id: "manage", ic: "🛠️", label: "Manage" }] : []),
    ...(profile.role === "admin" ? [{ id: "users", ic: "👥", label: "Users" }] : []),
    { id: "more", ic: "☰", label: "More" },
  ];
  $tabbar.innerHTML = tabs.map(t => `<button data-tab="${t.id}" class="${tab === t.id ? "active" : ""}"><span class="ic">${t.ic}</span>${t.label}</button>`).join("");
  $tabbar.classList.remove("hidden");
  $tabbar.querySelectorAll("button").forEach(b => b.onclick = () => { tab = b.dataset.tab; renderShell(); });
  ({ home: renderHome, study: renderStudy, tests: renderTests, manage: renderManage, users: renderUsers, more: renderMore }[tab] || renderHome)();
}

/* ---------------- Home ---------------- */
async function renderHome() {
  $app.innerHTML = `
    <div class="hero">
      <span class="badge">${esc(roleName(profile.role))}</span>
      <h1>नमस्ते, ${esc(profile.full_name.split(" ")[0])} 🙏</h1>
      <p>${isStaff() ? "आज की classes, tests और announcements यहाँ से संभालें।" : "आपकी पढ़ाई का आज का हाल — notes, tests और notices एक जगह।"}</p>
    </div>
    <div id="homeBody"><div class="loading">लोड हो रहा है…</div></div>`;
  const body = document.getElementById("homeBody");
  let html = "";

  if (!isStaff()) {
    const { data: enr } = await sb.from("enrollments").select("class_id").eq("user_id", me.id);
    const enrolledIds = (enr || []).map(e => e.class_id);
    const mine = myClasses.filter(c => enrolledIds.includes(c.id));
    html += `<div class="card"><h3>🎓 मेरी Class</h3>` +
      (mine.length
        ? mine.map(c => `<div class="item"><div><div class="t">${esc(c.name)}</div><div class="s">Target Academy</div></div><span class="pill green">Enrolled</span></div>`).join("")
        : `<p>अभी किसी class में enrollment नहीं है। Academy में संपर्क करें — आपका नाम आपकी class में जोड़ दिया जाएगा।</p>`) + `</div>`;
  } else {
    const [{ count: sc }, { count: qc }, { count: tc }] = await Promise.all([
      sb.from("profiles").select("*", { count: "exact", head: true }).eq("role", "student"),
      sb.from("questions").select("*", { count: "exact", head: true }),
      sb.from("tests").select("*", { count: "exact", head: true }),
    ]);
    html += `<div class="card"><h3>📊 Academy एक नज़र में</h3>
      <div class="row">
        <div><div class="t" style="font-size:22px;font-weight:800">${sc ?? 0}</div><div class="s muted">Students</div></div>
        <div><div class="t" style="font-size:22px;font-weight:800">${qc ?? 0}</div><div class="s muted">Questions</div></div>
        <div><div class="t" style="font-size:22px;font-weight:800">${tc ?? 0}</div><div class="s muted">Tests</div></div>
      </div></div>`;
  }

  const { data: anns } = await sb.from("announcements").select("*").order("created_at", { ascending: false }).limit(5);
  html += `<div class="card"><h3>📢 Notices / घोषणाएँ</h3>` +
    ((anns && anns.length)
      ? anns.map(a => `<div class="item"><div><div class="t">${esc(a.title)}</div><div class="s">${esc(a.body || "")}</div></div><span class="pill">${new Date(a.created_at).toLocaleDateString("hi-IN")}</span></div>`).join("")
      : `<p>अभी कोई notice नहीं है।</p>`) + `</div>`;

  body.innerHTML = html;
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
    toast("Notice भेज दिया गया 📢"); tab = "home"; renderShell();
  };
  renderQBank(subjects || [], chapters || []);
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

  $app.innerHTML = `<div class="card"><h3>👥 सभी Users (${(users || []).length})</h3>
    <p>Role बदलना और student को class में जोड़ना यहीं से होगा।</p>
    ${(users || []).map(u => `
      <div class="item">
        <div>
          <div class="t">${esc(u.full_name)} ${u.id === me.id ? '<span class="pill gold">आप</span>' : ""}</div>
          <div class="s">${esc(roleName(u.role))}${u.role === "student" ? " • " + (enrOf(u.id).map(className).join(", ") || "कोई class नहीं") : ""}</div>
        </div>
        <div class="row" style="flex:0 0 auto; align-items:center">
          <select data-role="${u.id}" style="width:auto; padding:7px">
            ${["student","teacher","parent","admin"].map(r => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}
          </select>
          ${u.role === "student" ? `<select data-enroll="${u.id}" style="width:auto; padding:7px">
            <option value="">+ Class…</option>
            ${myClasses.filter(c => !enrOf(u.id).includes(c.id)).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}
          </select>` : ""}
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
    toast("Student class में जुड़ गया 🎓"); renderUsers();
  });
}

/* ---------------- Study: Notes + Materials ---------------- */
let studyClassId = null;
const KIND_ICON = { pdf: "📕", worksheet: "📝", practice: "✍️", summary: "📋", revision: "🔁", question_bank: "❓", sample_paper: "📄", pyq: "🗂️", image: "🖼️", video_link: "🎬", doc: "📘" };

async function openStoredFile(bucket, path) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) return toast("File खुल नहीं रही: " + error.message);
  window.open(data.signedUrl, "_blank");
}
async function uploadTo(bucket, classId, file) {
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
  const isBm = (type, id) => (bms || []).some(b => b.item_type === type && b.item_id === id);
  const isDone = (type, id) => (prog || []).some(p => p.item_type === type && p.item_id === id && p.completed);
  if (!studyClassId && myClasses.length) studyClassId = myClasses[0].id;
  const inClass = (x) => !studyClassId || x.class_id === studyClassId;
  const myNotes = (notes || []).filter(inClass);
  const myMats = (materials || []).filter(inClass);

  const itemCard = (x, type) => `
    <div class="item">
      <div>
        <div class="t">${type === "material" ? (KIND_ICON[x.kind] || "📄") + " " : "📗 "}${esc(x.title)}</div>
        <div class="s">${esc(subName(x.subject_id))}${x.chapter_id ? " • " + esc(chapName(x.chapter_id)) : ""}${x.difficulty ? " • " + esc(x.difficulty) : ""}${x.description ? "<br>" + esc(x.description) : ""}</div>
        ${type === "note" && x.body ? `<div class="s" id="body-${x.id}" style="white-space:pre-wrap"></div>` : ""}
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
      <div class="row">${myClasses.map(c => `<button class="${c.id === studyClassId ? "" : "light"}" data-cls="${c.id}">${esc(c.name)}</button>`).join("") || "<p>कोई class नहीं है।</p>"}</div>
    </div>
    ${isStaff() ? `
    <div class="card"><h3>➕ Note / Material जोड़ें</h3>
      <label>प्रकार</label>
      <select id="n_kind"><option value="note">📗 Note (लिखा हुआ / PDF)</option><option value="material">📕 Study Material (file / link)</option></select>
      <label>शीर्षक</label><input id="n_title" placeholder="जैसे: प्रकाश संश्लेषण — सारांश">
      <label>Class</label><select id="n_class">${myClasses.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
      <label>Subject</label><select id="n_subject"><option value="">— कोई नहीं —</option>${(subjects || []).map(s => `<option value="${s.id}">${esc(s.name)} (${esc((myClasses.find(c => c.id === s.class_id) || {}).name || "")})</option>`).join("")}</select>
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
    <div class="card"><h3>📗 Notes (${myNotes.length})</h3>
      ${myNotes.map(n => itemCard(n, "note")).join("") || "<p>इस class के notes जल्द आ रहे हैं।</p>"}</div>
    <div class="card"><h3>📚 Study Material (${myMats.length})</h3>
      ${myMats.map(m => itemCard(m, "material")).join("") || "<p>इस class का material जल्द आ रहा है।</p>"}</div>`;

  const noteById = (id) => (notes || []).find(n => n.id === id);
  const matById = (id) => (materials || []).find(m => m.id === id);
  $app.querySelectorAll("[data-cls]").forEach(b => b.onclick = () => { studyClassId = +b.dataset.cls; renderStudy(); });
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

/* ---------------- Tests (Test Center next phase) ---------------- */
async function renderTests() {
  $app.innerHTML = `<div class="loading">लोड हो रहा है…</div>`;
  const { data: tests } = await sb.from("tests").select("*").order("created_at", { ascending: false });
  $app.innerHTML = `
    <div class="card"><h3>📝 Tests</h3>
    <p>Online test देने की सुविधा (timer, auto-submit, तुरंत result) Test Center phase में यहीं आएगी।</p>
    ${(tests && tests.length)
      ? tests.map(t => `<div class="item"><div><div class="t">${esc(t.title)}</div>
        <div class="s">${esc((myClasses.find(c => c.id === t.class_id) || {}).name || "")} • ${t.duration_minutes} मिनट • ${t.total_marks} अंक</div></div>
        <span class="pill ${t.status === "published" ? "green" : ""}">${esc(t.status)}</span></div>`).join("")
      : `<p>अभी कोई test नहीं बनाया गया है।</p>`}
    </div>`;
}

/* ---------------- More ---------------- */
async function renderMore() {
  let extra = "";
  if (profile.role === "student") {
    const { data: enr } = await sb.from("enrollments").select("class_id").eq("user_id", me.id);
    const names = (enr || []).map(e => (myClasses.find(c => c.id === e.class_id) || {}).name).filter(Boolean);
    extra = `<div class="item"><div><div class="t">मेरी Classes</div><div class="s">${names.join(", ") || "—"}</div></div></div>`;
  }
  $app.innerHTML = `
    <div class="card"><h3>👤 मेरी Profile</h3>
      <div class="item"><div><div class="t">${esc(profile.full_name)}</div><div class="s">${esc(me.email)}</div></div><span class="pill gold">${esc(profile.role)}</span></div>
      ${extra}
    </div>
    <div class="card"><h3>🎯 Target Academy Coaching Centre</h3>
      <p>Manikpur, Gopalganj, Bihar<br>Director: Ashutosh Kumar</p>
      <p class="muted">Platform version: Phase 1 (Foundation) — login, roles, dashboards व academic structure live है।</p>
    </div>`;
}

/* ---------------- Start ---------------- */
sb.auth.onAuthStateChange(() => { /* boot handles routing */ });
boot();
