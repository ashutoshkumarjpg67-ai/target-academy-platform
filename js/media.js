/* Photo pick/compress + photo viewer — split from app.js (Stage 1 modularisation).
   Only browser/DOM APIs are used here; no app-state dependencies. */
/* ---------------- Photo pick (Camera / Gallery) + auto-compress ----------------
   Compression runs 100% inside the browser (Canvas) — free, no server/AI
   cost. A 3-5 MB camera photo typically becomes 150-350 KB, so storage
   use drops ~90%. Non-image files pass through untouched. */
export const fmtKB = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

export async function compressImageFile(file, maxDim = 1280, quality = 0.82) {
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


// Turns a plain <input type=file> into a "📷 Camera / 🖼️ Gallery" picker.
// The chosen file is placed back into the original input, so existing
// save handlers keep reading input.files[0] unchanged.
export function enhanceFilePicker(input, { imageOnly = false } = {}) {
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

/* ---------------- Photo viewer (click → बड़ा) ---------------- */
export function viewPhoto(url) {
  if (!url) return;
  closePhoto();
  const d = document.createElement("div");
  d.className = "lightbox"; d.id = "photoLightbox";
  d.innerHTML = `<button class="lb-x" aria-label="Close">✕</button><img src="${url}" alt="photo">`;
  d.onclick = () => closePhoto();
  document.body.appendChild(d);
}
export function closePhoto() { const d = document.getElementById("photoLightbox"); if (d) d.remove(); }
document.addEventListener("click", (e) => {
  const t = e.target.closest ? e.target.closest("[data-zoom]") : null;
  if (t) viewPhoto(t.dataset.zoom);
});
