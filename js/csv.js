/* CSV export — split from app.js (Stage 1 modularisation). No app-state dependencies. */
/* ---------------- CSV export (v45 — client-side, only data already loaded on screen) ---------------- */
export function downloadCSV(filename, headers, rows) {
  const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = "\uFEFF" + [headers, ...rows].map(r => r.map(q).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
