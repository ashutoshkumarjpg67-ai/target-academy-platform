/* Brand logo — split from app.js (Stage 1 modularisation). */
import { SUPABASE_URL } from "../config.js?v=16";

/* ---------------- Brand logo (v49 — admin-changeable) ----------------
   The admin can upload a new coaching logo (Manage → Coaching Logo). It
   lives in the PUBLIC images bucket at the fixed path branding/logo.png.
   Every logo <img class="brand-logo"> tries that URL first, with a ?v=
   cache-buster taken from localStorage "logo_v" (bumped on each admin
   upload), and falls back to the bundled icon.svg if no custom logo has
   been uploaded yet — so existing installs keep the current logo until
   an admin changes it. The PWA/manifest icon always stays bundled. */
export const BRAND_LOGO_URL = `${SUPABASE_URL}/storage/v1/object/public/images/branding/logo.png`;
export const BUNDLED_LOGO = "icon.svg?v=31";
export const brandLogoURL = () => { let v = ""; try { v = localStorage.getItem("logo_v") || ""; } catch (_) {} return BRAND_LOGO_URL + "?v=" + (v || "1"); };
export function applyBrandLogo(root = document) {
  root.querySelectorAll("img.brand-logo").forEach(img => {
    const url = brandLogoURL();
    img.onerror = () => { img.onerror = null; if (img.getAttribute("src") !== BUNDLED_LOGO) img.src = BUNDLED_LOGO; if ("zoom" in img.dataset) img.dataset.zoom = BUNDLED_LOGO; };
    if (img.getAttribute("src") !== url) img.src = url;
    if ("zoom" in img.dataset) img.dataset.zoom = url;
  });
}
