// Customer ordering page (scan a table QR / tap an NFC sticker).
//
// Data flow (all through Firestore, no login):
//   POS  --publishes-->  publicShops/{publicId}                 menu + drink options + ordersOpen flag
//   this page --create--> publicShops/{publicId}/inbox/{orderId}  one document per order sent
//   POS  --writes-->     publicShops/{publicId}/status/{orderId} accepted / rejected
// The POS never trusts the prices in an inbox document: when staff press 接受 it re-prices every line
// from its own menu, so a tampered page can't change what is charged.
(function(){
"use strict";

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const PID = (qs.get("s") || "").trim();
const PROJECT = (qs.get("p") || "").trim();
const APIKEY = (qs.get("k") || "").trim();
const TABLE = (qs.get("t") || "").trim().slice(0, 12);
const TYPE = TABLE ? "dinein" : "takeaway";          // no table in the link = the take-away QR
const ORDERS_KEY = "sk_cust_orders_v1";
const NAME_KEY = "sk_cust_name_v1";
const CLIENT_KEY = "sk_cust_client_v1";
const MAX_LINES = 30, MAX_QTY = 20;

const round2 = n => Math.round(n * 100) / 100;
const fmt = n => "RM" + round2(n || 0).toFixed(2);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const COLD_RE = /^(冷|冷饮|冻|冷的|cold|iced?)$/i;
const HOT_RE = /^(热|热饮|热的|hot|warm)$/i;
const ICE_GROUP_RE = /冰|ice/i;

let db = null, shopRef = null;
let menu = null;                 // latest publicShops/{id} document
let photos = {}, photosRev = ""; // item id -> small thumbnail (data URL), from publicShops/{id}/photos/*
let activeCat = null;
let cart = [];                   // {key,id,name,base,price,extra,qty,note,opts:[{g,l}],optsText}
let optItem = null, optPick = {};
let sending = false;
let statusUnsub = null;

function safeGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function safeSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }
function toast(msg){
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(()=> t.classList.add("hidden"), 3200);
}
function showMsg(html, isErr){
  const m = $("msg"); m.innerHTML = html; m.classList.toggle("err", !!isErr); m.classList.remove("hidden");
  $("items").innerHTML = ""; $("cats").innerHTML = ""; $("cartBar").classList.add("hidden");
}
function hideMsg(){ $("msg").classList.add("hidden"); }

// ---- drink options (same text format and rules as the POS) ----
function parseOptionGroups(text){
  return String(text || "").split("\n").map(line => {
    const parts = line.split(/[:：]/);
    if(parts.length < 2) return null;
    const name = parts[0].trim();
    const choices = parts.slice(1).join(":").split(/[,，、]/).map(x => x.trim()).filter(Boolean).map(tok => {
      const m = /^(.*?)\s*[+＋]\s*(\d+(?:\.\d+)?)\s*$/.exec(tok);
      return m && m[1] ? { label: m[1].trim(), extra: round2(parseFloat(m[2])) } : { label: tok, extra: 0 };
    });
    return name && choices.length ? { name, choices } : null;
  }).filter(Boolean);
}
const hasCold = it => it.coldPrice != null && it.coldPrice !== "" && isFinite(it.coldPrice);
function choiceExtra(it, ch){
  if(hasCold(it) && COLD_RE.test(ch.label)) return round2(it.coldPrice - it.price);
  return ch.extra || 0;
}
function findItem(id){
  for(const c of (menu && menu.categories) || []) for(const it of c.items || []) if(it.id === id) return { it, cat: c };
  return null;
}

// ---- menu ----
function renderCats(){
  const box = $("cats"); box.innerHTML = "";
  (menu.categories || []).forEach(c => {
    if(!(c.items || []).length) return;
    const b = document.createElement("button");
    b.className = "cat" + (c.id === activeCat ? " active" : "");
    b.textContent = c.name;
    b.onclick = () => { activeCat = c.id; renderCats(); renderItems(); window.scrollTo(0, 0); };
    box.appendChild(b);
  });
}
function priceText(it, isBev){
  if(isBev && hasCold(it) && it.coldPrice !== it.price) return `<small>热 Hot</small> ${fmt(it.price)} · <small>冷 Cold</small> ${fmt(it.coldPrice)}`;
  return fmt(it.price);
}
function renderItems(){
  const cat = (menu.categories || []).find(c => c.id === activeCat);
  const box = $("items"); box.innerHTML = "";
  if(!cat) return;
  cat.items.forEach(it => {
    const off = it.available === false;
    const row = document.createElement("div");
    row.className = "item" + (off ? " off" : "");
    const ph = menu.photoRev ? `<div class="item-photo">${photos[it.id] ? `<img src="${photos[it.id]}" alt="">` : "🍽️"}</div>` : "";
    row.innerHTML = `${ph}
      <div class="item-main">
        <div class="item-name">${esc(it.name)}</div>
        ${it.combo ? `<div class="item-sub">含 ${esc(it.combo)}</div>` : ""}
        <div class="item-price">${priceText(it, cat.beverage)}</div>
      </div>
      ${off ? `<span class="soldout">已售罄<br>Sold out</span>` : `<button class="add" aria-label="加入 add">+</button>`}`;
    if(!off) row.querySelector(".add").onclick = () => onItemTap(it, cat);
    box.appendChild(row);
  });
}
function onItemTap(it, cat){
  const groups = parseOptionGroups(menu.drinkOptions);
  if(cat.beverage && !it.combo && menu.drinkOptionsPrompt !== false && groups.length) openOptions(it, groups);
  else addToCart(it, [], 0, "");
}

// ---- drink option sheet ----
function openOptions(it, groups){
  optItem = it; optPick = {};
  $("optTitle").textContent = it.name;
  const box = $("optGroups"); box.innerHTML = "";
  groups.forEach(g => {
    const row = document.createElement("div");
    row.className = "opt-group"; row.dataset.group = g.name;
    row.innerHTML = `<div class="opt-group-name">${esc(g.name)}</div><div class="opt-choices"></div>`;
    const wrap = row.querySelector(".opt-choices");
    const chs = g.choices.map(c => ({ label: c.label, extra: choiceExtra(it, c) }));
    chs.forEach(ch => {
      const b = document.createElement("button");
      b.className = "opt-choice";
      const isCold = hasCold(it) && COLD_RE.test(ch.label), isHot = hasCold(it) && HOT_RE.test(ch.label);
      const tag = isCold ? fmt(it.coldPrice) : isHot ? fmt(it.price) : (ch.extra > 0 ? "+" + fmt(ch.extra) : "");
      b.innerHTML = esc(ch.label) + (tag ? `<small>${tag}</small>` : "");
      b.onclick = () => {
        if(optPick[g.name] && optPick[g.name].label === ch.label) delete optPick[g.name]; else optPick[g.name] = { g: g.name, l: ch.label, extra: ch.extra };
        wrap.querySelectorAll(".opt-choice").forEach((x, i) => x.classList.toggle("active", !!optPick[g.name] && optPick[g.name].l === chs[i].label));
        syncOptGroups(groups); updateOptTotal();
      };
      wrap.appendChild(b);
    });
    box.appendChild(row);
  });
  updateOptTotal();
  $("optSheet").classList.remove("hidden");
}
// a hot drink has no ice: picking 热 hides the ice-level group and clears it
function syncOptGroups(groups){
  const hot = groups.some(g => optPick[g.name] && HOT_RE.test(optPick[g.name].l));
  document.querySelectorAll("#optGroups .opt-group").forEach(row => {
    const g = groups.find(x => x.name === row.dataset.group);
    const isIce = !!g && ICE_GROUP_RE.test(g.name) && !g.choices.some(c => HOT_RE.test(c.label));
    row.classList.toggle("hidden", hot && isIce);
    if(hot && isIce){ delete optPick[g.name]; row.querySelectorAll(".opt-choice").forEach(x => x.classList.remove("active")); }
  });
}
function optExtra(){ return round2(Object.values(optPick).reduce((s, p) => s + (p.extra || 0), 0)); }
function updateOptTotal(){ $("btnAddOpt").textContent = `加入订单 Add · ${fmt(optItem.price + optExtra())}`; }
$("btnAddOpt").onclick = () => {
  const groups = parseOptionGroups(menu.drinkOptions);
  const picked = groups.map(g => optPick[g.name]).filter(Boolean);
  const it = optItem; optItem = null;
  $("optSheet").classList.add("hidden");
  addToCart(it, picked.map(p => ({ g: p.g, l: p.l })), optExtra(), picked.map(p => p.l).join(" · "));
};

// ---- cart ----
function addToCart(it, opts, extra, optsText){
  const key = it.id + (optsText ? "#" + optsText : "");
  const line = cart.find(l => l.key === key);
  if(line){
    if(line.qty >= MAX_QTY){ toast("每款最多 " + MAX_QTY + " 份 / max " + MAX_QTY + " each"); return; }
    line.qty++;
  }else{
    if(cart.length >= MAX_LINES){ toast("订单项目太多了 / too many items"); return; }
    cart.push({ key, id: it.id, name: it.name, base: it.price, extra, price: round2(it.price + extra), qty: 1, note: "", opts, optsText });
  }
  renderCartBar();
  toast("已加入 Added: " + it.name);
}
const cartCount = () => cart.reduce((s, l) => s + l.qty, 0);
const cartSub = () => round2(cart.reduce((s, l) => s + l.price * l.qty, 0));
function renderCartBar(){
  $("cartBar").classList.toggle("hidden", cart.length === 0 || !menu || !menu.ordersOpen);
  $("cbCount").textContent = cartCount();
  $("cbTotal").textContent = fmt(cartSub());
}
function renderCartSheet(){
  const box = $("cartLines"); box.innerHTML = "";
  if(!cart.length){ box.innerHTML = `<div class="empty">还没有点任何东西 · Nothing yet</div>`; }
  cart.forEach(l => {
    const row = document.createElement("div");
    row.className = "cl";
    const gone = !(findItem(l.id) && findItem(l.id).it.available !== false);
    row.innerHTML = `
      <div class="cl-top"><div class="cl-name">${esc(l.name)}${l.optsText ? `<small>${esc(l.optsText)}</small>` : ""}${gone ? `<small style="color:var(--danger)">已售罄 Sold out — 请删除 please remove</small>` : ""}</div><div class="cl-price">${fmt(l.price * l.qty)}</div></div>
      <div class="cl-bottom">
        <input class="cl-note" maxlength="40" placeholder="备注 note" value="${esc(l.note)}">
        <div class="step"><button class="m">−</button><span>${l.qty}</span><button class="p">+</button></div>
      </div>`;
    row.querySelector(".cl-note").oninput = e => { l.note = e.target.value; };
    row.querySelector(".m").onclick = () => { l.qty--; if(l.qty <= 0) cart = cart.filter(x => x !== l); renderCartSheet(); renderCartBar(); };
    row.querySelector(".p").onclick = () => { if(l.qty < MAX_QTY){ l.qty++; renderCartSheet(); renderCartBar(); } };
    box.appendChild(row);
  });
  $("cartSub").textContent = fmt(cartSub());
  $("nameWrap").classList.toggle("hidden", TYPE !== "takeaway");
  $("btnSubmit").disabled = cart.length === 0 || sending;
}
$("btnOpenCart").onclick = () => { $("custName").value = safeGet(NAME_KEY) || $("custName").value; renderCartSheet(); $("cartSheet").classList.remove("hidden"); };
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => $(b.dataset.close).classList.add("hidden"));

// ---- sending ----
function genCode(){
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for(let i = 0; i < 3; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function clientId(){
  let id = safeGet(CLIENT_KEY);
  if(!id){ id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); safeSet(CLIENT_KEY, id); }
  return id;
}
function recentOrders(){ try{ return JSON.parse(safeGet(ORDERS_KEY)) || []; }catch(e){ return []; } }

async function submit(){
  if(sending || !cart.length) return;
  if(!menu || !menu.ordersOpen){ toast("暂时不接受点单 / Ordering is paused"); return; }
  const name = $("custName").value.trim();
  if(TYPE === "takeaway" && !name){ toast("请填写名字 / Please enter your name"); $("custName").focus(); return; }
  const gone = cart.filter(l => { const f = findItem(l.id); return !f || f.it.available === false; });
  if(gone.length){ toast("有菜品已售罄,请先删除 / Some items are sold out"); renderCartSheet(); return; }
  const last = recentOrders()[0];
  if(last && Date.now() - last.at < 15000){ toast("请稍等几秒再送出 / Please wait a few seconds"); return; }

  sending = true; $("btnSubmit").disabled = true; $("btnSubmit").textContent = "送出中… Sending…";
  const slow = setTimeout(() => toast("网络较慢,仍在送出,请不要重复点击 / Still sending, please don't tap again"), 12000);
  const code = genCode();
  const ref = shopRef.collection("inbox").doc();
  const doc = {
    code,
    orderType: TYPE,
    table: TYPE === "dinein" ? TABLE : null,
    name: TYPE === "takeaway" ? name : "",
    note: $("custNote").value.trim().slice(0, 80),
    items: cart.map(l => ({ id: l.id, name: l.name, qty: l.qty, price: l.price, note: (l.note || "").trim().slice(0, 40), options: l.opts, optionsText: l.optsText })),
    subtotal: cartSub(),
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 2 * 86400000),
    clientId: clientId()
  };
  try{
    await ref.set(doc);
    clearTimeout(slow);
    if(TYPE === "takeaway") safeSet(NAME_KEY, name);
    const sent = { id: ref.id, code, at: Date.now(), table: doc.table, items: doc.items.map(i => `${i.name}${i.optionsText ? " (" + i.optionsText + ")" : ""} x${i.qty}`) };
    safeSet(ORDERS_KEY, JSON.stringify([sent].concat(recentOrders()).slice(0, 5)));
    cart = []; $("custNote").value = "";
    $("cartSheet").classList.add("hidden"); renderCartBar();
    showDone(sent);
  }catch(e){
    clearTimeout(slow);
    toast("送出失败,请检查网络后再试 / Failed to send — check your connection");
  }finally{
    sending = false; $("btnSubmit").textContent = "送出点单 Send order"; $("btnSubmit").disabled = false;
  }
}
$("btnSubmit").onclick = submit;

// ---- after sending: live status ----
function showDone(o){
  $("doneCode").textContent = o.code;
  $("doneItems").innerHTML = (o.items || []).map(esc).join("<br>") + (o.table ? `<br>桌 Table ${esc(o.table)}` : "");
  setStatus(null);
  $("doneSheet").classList.remove("hidden");
  if(statusUnsub){ statusUnsub(); statusUnsub = null; }
  statusUnsub = shopRef.collection("status").doc(o.id).onSnapshot(s => setStatus(s.exists ? s.data().status : null), () => {});
}
function setStatus(st){
  const el = $("doneStatus");
  el.className = "done-status";
  if(st === "accepted"){ el.classList.add("ok"); el.textContent = "✅ 店员已接单,正在准备 / Accepted — we're preparing it"; $("doneIcon").textContent = "✅"; $("doneTitle").textContent = "已接单 Accepted"; }
  else if(st === "rejected"){ el.classList.add("bad"); el.textContent = "😔 抱歉,暂时无法接这张单,请到柜台询问 / Sorry, we couldn't take this order — please ask at the counter"; $("doneIcon").textContent = "⚠️"; $("doneTitle").textContent = "未能接单 Not accepted"; }
  else { el.textContent = "等待店员确认… Waiting for the staff to confirm…"; $("doneIcon").textContent = "📨"; $("doneTitle").textContent = "已送出 Sent"; }
}
$("btnMore").onclick = () => $("doneSheet").classList.add("hidden");

// Photos live in separate chunk documents; fetched once per photoRev (they only change when the shop edits a photo).
function loadPhotos(){
  const rev = (menu && menu.photoRev) || "";
  if(!rev){ photos = {}; photosRev = ""; return; }
  if(rev === photosRev || !menu.ordersOpen) return;
  shopRef.collection("photos").get().then(res => {
    if(!menu || menu.photoRev !== rev) return;
    const m = {};
    res.docs.forEach(d => { const x = d.data(); if(x && x.rev === rev && x.imgs) Object.assign(m, x.imgs); });
    photos = m; photosRev = rev;
    if(menu.ordersOpen) renderItems();
  }).catch(() => {});
}

// ---- start ----
function renderAll(){
  hideMsg();
  $("shopTitle").textContent = menu.shopName || "Menu";
  $("whereBadge").textContent = TYPE === "dinein" ? `桌 Table ${TABLE}` : "外带 Take Away";
  if(!menu.ordersOpen){
    showMsg("暂时不接受扫码点餐,请到柜台点餐。<br>Ordering by QR is paused right now — please order at the counter.", false);
    return;
  }
  if(!activeCat || !(menu.categories || []).some(c => c.id === activeCat)){
    const first = (menu.categories || []).find(c => (c.items || []).length);
    activeCat = first ? first.id : null;
  }
  renderCats(); renderItems(); renderCartBar();
  if(!$("cartSheet").classList.contains("hidden")) renderCartSheet();
}
function init(){
  if(!PID || !PROJECT || !APIKEY){
    showMsg("链接不完整,请重新扫描桌上的二维码。<br>This link is incomplete — please scan the QR code again.", true);
    return;
  }
  if(typeof firebase === "undefined"){
    showMsg("连不上服务器,请检查网络后重新整理页面。<br>Can't reach the server — check your connection and reload.", true);
    return;
  }
  try{
    firebase.initializeApp({ apiKey: APIKEY, projectId: PROJECT });
    db = firebase.firestore();
    try{ db.settings({ experimentalAutoDetectLongPolling: true, merge: true }); }catch(e){}
    shopRef = db.collection("publicShops").doc(PID);
  }catch(e){
    showMsg("链接有误,请重新扫描二维码。<br>Invalid link — please scan the QR code again.", true);
    return;
  }
  $("whereBadge").textContent = TYPE === "dinein" ? `桌 Table ${TABLE}` : "外带 Take Away";
  shopRef.onSnapshot(snap => {
    if(!snap.exists){ menu = null; showMsg("这家店还没有开放扫码点餐。<br>This shop isn't taking QR orders yet.", true); return; }
    menu = snap.data();
    renderAll();
    loadPhotos();
  }, err => {
    showMsg("载入菜单失败,请检查网络后重新整理页面。<br>Couldn't load the menu — check your connection and reload.", true);
  });
}
init();
})();
