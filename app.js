const API = "/api";

function qs(k){ return new URLSearchParams(location.search).get(k); }
function byId(id){ return document.getElementById(id); }

async function api(path, opts={}){
  const res = await fetch(API + path, {
    headers: {"Content-Type":"application/json", ...(opts.headers||{})},
    ...opts
  });
  const body = await res.json().catch(()=> ({}));
  if(!res.ok) throw new Error(body.error || ("HTTP " + res.status));
  return body;
}

// ---- LIFF (optional) ----
async function tryGetLineUserId(){
  // Works when opened as a LIFF app (in LINE or external browser depending on settings).
  if(!window.liff) return null;
  await liff.init({ liffId: window.LIFF_ID || "YOUR_LIFF_ID" });
  if(!liff.isLoggedIn()){
    // External browser: triggers LINE Login if allowed in LIFF settings.
    liff.login();
    return null;
  }
  const p = await liff.getProfile();
  return p.userId;
}

window.Hidakko = { api, qs, byId, tryGetLineUserId };
