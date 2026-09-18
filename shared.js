// shared.js — Supabase-backed data layer shared between the customer site
// (index.html) and the Admin Panel (admin.html).
//
// Data now lives in a real Supabase project (Postgres + Storage + Auth), not in
// browser localStorage — every device/browser sees the same data, and Admin has
// a real login (Supabase Auth), not a password checked in JS. Row Level Security
// (RLS) policies on the Supabase side (see supabase-setup.sql / supabase-addon.sql)
// enforce that only a logged-in Admin can read full seller records (NRC, address,
// phone) — the public "Seller List" page only ever sees the safe public_sellers view.

// ---------------------------------------------------------------------------
// SUPABASE CONFIG — from Project Settings > API. The "anon" key is DESIGNED to be
// public/embedded in client-side code like this — Supabase's security model relies
// on the RLS policies (server-side), not on keeping this key secret.
// ---------------------------------------------------------------------------
const SUPABASE_URL = "https://mdtpxneznyqvzfszwlvi.supabase.co"; // double-check this against Project Settings > API — it must end in ".co"
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kdHB4bmV6bnlxdnpmc3p3bHZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzMzk1MjYsImV4cCI6MjEwNDkxNTUyNn0.vInqTfwuYE6UiQ_KVq_AZyWOXQQ2UBN-0r5mXjHH3l4";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); // `supabase` here is the global from the supabase-js CDN script tag

const SHOP_TELEGRAM = "@KaiZoroShop"; // Change this to the real KaiZoro Shop Telegram handle.
const MAX_LISTING_IMAGES = 10; // cap on Account Screenshots per listing
const STORAGE_BUCKET = "listing-images"; // the public Storage bucket created during setup

// ---------------------------------------------------------------------------
// OPTIONAL: forward every new Seller Registration (name, age, NRC number, address,
// phone, Telegram handle, and the NRC photo itself) straight to an Admin's Telegram
// via the Telegram Bot API. NRC photos are NEVER uploaded to Supabase Storage or
// saved in the database — Telegram is the only place they ever go.
//
// SETUP:
//   1. Message @BotFather on Telegram -> /newbot -> copy the token it gives you.
//   2. Message your NEW bot once (anything), then visit
//      https://api.telegram.org/bot<TOKEN>/getUpdates in a browser to find your
//      numeric "chat":{"id": ...} — that is TELEGRAM_ADMIN_CHAT_ID (works for a
//      group chat's id too, once the bot has been added to that group).
//   3. Paste both values below. Leave TELEGRAM_BOT_TOKEN empty to keep this off.
//
// SECURITY NOTE: this token sits in shared.js in plain text, visible to anyone who
// views page source. A leaked token lets someone send messages AS your bot (spam
// risk to whoever it messages), but it does not hand out sellers' NRC data to
// strangers — Telegram only pushes messages the bot receives TO your admin chat.
// ---------------------------------------------------------------------------
const TELEGRAM_BOT_TOKEN = ""; // e.g. "123456789:AAExampleTokenFromBotFather"
const TELEGRAM_ADMIN_CHAT_ID = ""; // e.g. "987654321" or a group's negative chat id

async function notifyAdminTelegram(seller){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID){
    return { ok:false, detail:"TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID not set in shared.js" };
  }
  const caption =
    "\ud83c\udd95 New Seller Registration\n" +
    "Name: " + seller.name + "\n" +
    "Age: " + seller.age + "\n" +
    "NRC: " + seller.nrc + "\n" +
    "Address: " + seller.address + "\n" +
    "Phone: " + seller.phone + "\n" +
    "Telegram: " + seller.telegram;
  try{
    const photos = [seller.idPhotoFront, seller.idPhotoBack].filter(Boolean);
    let resp;
    if(photos.length === 2){
      const form = new FormData();
      form.append("chat_id", TELEGRAM_ADMIN_CHAT_ID);
      const media = [];
      for(let i=0;i<photos.length;i++){
        const blob = await (await fetch(photos[i])).blob();
        const fieldName = "photo" + i;
        form.append(fieldName, blob, (i===0 ? "nrc-front.jpg" : "nrc-back.jpg"));
        const entry = { type:"photo", media: "attach://" + fieldName };
        if(i===0) entry.caption = caption;
        media.push(entry);
      }
      form.append("media", JSON.stringify(media));
      resp = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMediaGroup", { method:"POST", body: form });
    } else if(photos.length === 1){
      const blob = await (await fetch(photos[0])).blob();
      const form = new FormData();
      form.append("chat_id", TELEGRAM_ADMIN_CHAT_ID);
      form.append("caption", caption);
      form.append("photo", blob, "nrc-photo.jpg");
      resp = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendPhoto", { method:"POST", body: form });
    } else {
      resp = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_ADMIN_CHAT_ID, text: caption })
      });
    }
    const body = await resp.json().catch(()=>null);
    if(!resp.ok || !body || body.ok === false){
      console.error("KaiZoro Shop: Telegram API rejected the request", body);
      return { ok:false, detail: body && body.description ? body.description : ("HTTP " + resp.status) };
    }
    return { ok:true, detail:"sent" };
  }catch(err){
    console.error("KaiZoro Shop: could not notify admin via Telegram", err);
    return { ok:false, detail: (err && err.message) ? err.message : String(err) };
  }
}

const rankColors = {
  "Warrior":"#8a8578","Elite":"#2f4cff","Master":"#1f9e5c","Grandmaster":"#1f9e5c",
  "Epic":"#8a4cff","Legend":"#ffb000","Mythic":"#ff4b3e","Mythical Honor":"#ffb000","Mythical Glory":"#ff4b3e"
};

function fmt(n){ return Number(n).toLocaleString() + " Ks"; }

function esc(str){
  return String(str==null?"":str).replace(/[&<>"']/g, function(ch){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch];
  });
}

function telegramLink(handle){
  if(!handle) return null;
  let h = handle.trim();
  if(!h) return null;
  if(h.startsWith("http")) return h;
  h = h.replace(/^@/, "");
  return "https://t.me/" + h;
}

// Puts the current logo (a public Storage URL, or null for the default "KZ" mark)
// into every .brand-mark element on the page — used by both index.html's and
// admin.html's headers.
function applyBrandLogo(logoUrl){
  document.querySelectorAll(".brand-mark").forEach(el=>{
    if(logoUrl){
      el.innerHTML = `<img src="${logoUrl}" alt="logo">`;
      el.classList.add("has-logo");
    } else {
      el.textContent = "KZ";
      el.classList.remove("has-logo");
    }
  });
}

// ---------------------------------------------------------------------------
// Image handling: photos are resized/compressed client-side (canvas) before ever
// leaving the browser — this keeps uploads fast and avoids Supabase Storage's
// free-tier space getting eaten by raw multi-MB phone screenshots.
// ---------------------------------------------------------------------------
const IMAGE_MAX_DIM = 1440; // longest side, in pixels, after resizing
const IMAGE_QUALITY = 0.8;  // JPEG quality (0-1)

// Resizes an image file down to IMAGE_MAX_DIM on its longest side, re-encodes it as
// a JPEG at IMAGE_QUALITY, and returns the result as a Blob via callback (ready to
// upload directly to Supabase Storage). Falls back to the original file if anything
// goes wrong reading/decoding it as an image.
function compressImageFile(file, maxDim, quality, cb){
  let done = false;
  const finish = (result) => { if(done) return; done = true; cb(result); };
  // Safety net: if anything in the compression pipeline below hangs (e.g. an image
  // decode that never fires onload/onerror on some odd WebView), fall back to the
  // original file after 8s instead of leaving the caller's counter stuck forever.
  const timeoutId = setTimeout(() => {
    console.error("KaiZoro Shop: image compression timed out, using original file");
    finish(file);
  }, 8000);
  const reader = new FileReader();
  reader.onload = function(e){
    const img = new Image();
    img.onload = function(){
      try{
        let width = img.width, height = img.height;
        if(width > maxDim || height > maxDim){
          if(width > height){ height = Math.round(height * (maxDim / width)); width = maxDim; }
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        // Using toDataURL + fetch()->blob() instead of canvas.toBlob(): toDataURL is far
        // more universally supported (some stripped-down WebViews, e.g. in-app code editor
        // previews, lack toBlob or silently never fire its callback, which stalls the whole
        // upload flow with the "0/10 selected" counter never moving).
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        fetch(dataUrl).then(r => r.blob()).then(blob => { clearTimeout(timeoutId); finish(blob); }).catch(function(err){
          console.error("KaiZoro Shop: toDataURL->blob conversion failed, using original file", err);
          clearTimeout(timeoutId); finish(file);
        });
      }catch(err){
        console.error("KaiZoro Shop: image compression failed, using original file", err);
        clearTimeout(timeoutId); finish(file);
      }
    };
    img.onerror = function(){ clearTimeout(timeoutId); finish(file); }; // fallback: upload the original file unmodified
    img.src = e.target.result;
  };
  reader.onerror = function(){ clearTimeout(timeoutId); finish(null); };
  reader.readAsDataURL(file);
}

// Reads a single <input type="file"> as a data URL (used ONLY for NRC photos, which
// go straight to Telegram via notifyAdminTelegram and are never uploaded to Storage
// or saved anywhere else).
function fileToDataUrl(input, cb){
  if(!input.files || !input.files[0]){ cb(null); return; }
  const reader = new FileReader();
  reader.onload = e => cb(e.target.result);
  reader.onerror = () => cb(null);
  reader.readAsDataURL(input.files[0]);
}

// Uploads a compressed image Blob to the public Storage bucket and returns its
// public URL (or null on failure).
async function uploadToStorage(blob, folder){
  if(!blob) return null;
  const path = folder + "/" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".jpg";
  const { error } = await sb.storage.from(STORAGE_BUCKET).upload(path, blob, { contentType: "image/jpeg" });
  if(error){
    console.error("KaiZoro Shop: upload failed", error);
    throw error; // let the caller decide how to surface this to the user
  }
  const { data } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// ---- Sellers ----------------------------------------------------------------
// fetchApprovedSellers() is what the PUBLIC site (index.html) uses — it reads the
// public_sellers VIEW, which excludes nrc/address/phone (Admin-only, RLS-enforced).
async function fetchApprovedSellers(){
  const { data, error } = await sb.from("public_sellers").select("*").order("sold_count", { ascending:false });
  if(error){ console.error(error); return []; }
  return data;
}
// fetchAllSellers() is Admin-only — RLS only allows an authenticated session to
// SELECT the full sellers table.
async function fetchAllSellers(){
  const { data, error } = await sb.from("sellers").select("*").order("created_at", { ascending:false });
  if(error){ console.error(error); return []; }
  return data;
}
async function insertSeller(seller){
  // Uses the register_seller() SECURITY DEFINER function (see supabase-fix2.sql) instead
  // of a direct table insert — a plain .insert().select() would fail with a row-level
  // security error here, because anon has no SELECT policy on sellers (by design, to
  // keep NRC/address/phone private) and Postgres requires one to return the new row.
  const { data, error } = await sb.rpc("register_seller", {
    p_name: seller.name, p_age: seller.age, p_nrc: seller.nrc, p_address: seller.address,
    p_telegram: seller.telegram, p_phone: seller.phone, p_password: seller.password
  });
  if(error) return { data:null, error };
  return { data: (data && data[0]) || null, error: null };
}
async function updateSellerStatus(id, status){
  const patch = { status };
  if(status === "approved") patch.trust = 100;
  const { error } = await sb.from("sellers").update(patch).eq("id", id);
  return !error;
}
async function deleteSellerRow(id){
  const { error } = await sb.from("sellers").delete().eq("id", id);
  return !error;
}
// Lets a seller log back in (phone/telegram + password) WITHOUT anon ever getting
// direct SELECT access to the sellers table — this calls a security-definer
// Postgres function (see supabase-addon.sql) that only returns id/name/status.
async function sellerLogin(identifier, password){
  const { data, error } = await sb.rpc("seller_login", { p_identifier: identifier, p_password: password });
  if(error){ console.error(error); return null; }
  return (data && data[0]) || null;
}

// ---- Listings -----------------------------------------------------------------
async function fetchApprovedListings(){
  const { data, error } = await sb.from("listings").select("*").eq("status","approved").order("created_at",{ascending:false});
  if(error){ console.error(error); return []; }
  return data;
}
async function fetchAllListings(){
  const { data, error } = await sb.from("listings").select("*").order("created_at",{ascending:false});
  if(error){ console.error(error); return []; }
  return data;
}
// Admin-only direct insert — Admin is `authenticated` and already has a full SELECT
// policy on listings, so .select() after insert works fine here without an RPC.
async function insertListing(listing){
  const { data, error } = await sb.from("listings").insert(listing).select().single();
  return { data, error };
}
// Buyer/seller-facing insert (anon) — routed through submit_listing_public() (see
// supabase-fix2.sql) for the same RLS/RETURNING reason as insertSeller above. Also
// hardcodes status='pending' server-side so anon can never self-approve a listing.
async function submitListingPublic(listing){
  const { data, error } = await sb.rpc("submit_listing_public", {
    p_title: listing.title, p_rank: listing.rank, p_server: listing.server,
    p_heroes: listing.heroes, p_skins: listing.skins, p_bind: listing.bind,
    p_price: listing.price, p_seller_id: listing.seller_id, p_images: listing.images,
    p_description: listing.description
  });
  if(error) return { data:null, error };
  return { data: (data && data[0]) || null, error: null };
}
async function updateListingStatus(id, status){
  const { error } = await sb.from("listings").update({status}).eq("id", id);
  return !error;
}
async function deleteListingRow(id){
  const { error } = await sb.from("listings").delete().eq("id", id);
  return !error;
}

// ---- Reports --------------------------------------------------------------
async function fetchAllReports(){
  const { data, error } = await sb.from("reports").select("*").order("created_at",{ascending:false});
  if(error){ console.error(error); return []; }
  return data;
}
async function insertReport(report){
  // Routed through submit_report() (see supabase-fix2.sql) for the same RLS/RETURNING
  // reason as insertSeller above — anon has no SELECT policy on reports at all.
  const { data, error } = await sb.rpc("submit_report", {
    p_reporter_name: report.reporter_name, p_reporter_contact: report.reporter_contact,
    p_against_type: report.against_type, p_against: report.against,
    p_listing_id: report.listing_id, p_description: report.description, p_evidence: report.evidence
  });
  if(error) return { data:null, error };
  return { data: (data && data[0]) || null, error: null };
}
async function updateReportStatus(id, status){
  const { error } = await sb.from("reports").update({status}).eq("id", id);
  return !error;
}

// ---- Site settings / logo -----------------------------------------------
async function fetchSiteLogo(){
  const { data, error } = await sb.from("site_settings").select("logo_url").eq("id",1).single();
  if(error){ console.error(error); return null; }
  return data ? data.logo_url : null;
}
async function updateSiteLogo(url){
  const { error } = await sb.from("site_settings").update({logo_url:url}).eq("id",1);
  return !error;
}

// ---- Admin auth (real Supabase Auth — replaces the old JS password check) ------
async function adminSignIn(email, password){
  return await sb.auth.signInWithPassword({ email, password });
}
async function adminSignOut(){
  await sb.auth.signOut();
}
async function getAdminSession(){
  const { data } = await sb.auth.getSession();
  return data.session;
}

// ---- Realtime: calls `cb` whenever a row in `table` changes (insert/update/delete),
// so every open tab/device stays in sync automatically. ----
function subscribeToTable(table, cb){
  return sb.channel("changes-" + table)
    .on("postgres_changes", { event: "*", schema: "public", table }, cb)
    .subscribe();
}
