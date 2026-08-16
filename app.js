(function(){
"use strict";

const STORAGE_KEY = "sk_pos_state_v1";
const HISTORY_KEY = "sk_pos_orders_v1";
const HELD_KEY = "sk_pos_held_v1";

const DEFAULT_STATE = {
  settings:{
    shopName:"Soo's Kitchen",
    taxEnabled:false,
    taxRate:6,
    qrImage:"",
    pin:"0000",
    discountPinRequired:false,
    deviceLabel:"",
    paperWidth:"58",
    autoPrintKitchen:true,
    promotions:[]
  },
  menu:[
    { id:"cat1", name:"主食 Mains", items:[
      { id:"i1", name:"招牌炒饭", price:9.90, available:true, image:"" },
      { id:"i2", name:"咖喱鸡饭", price:11.50, available:true, image:"" },
      { id:"i3", name:"叉烧饭", price:10.00, available:true, image:"" }
    ]},
    { id:"cat2", name:"饮料 Drinks", items:[
      { id:"i4", name:"美禄冰", price:4.50, available:true, image:"" },
      { id:"i5", name:"拉茶", price:3.50, available:true, image:"" },
      { id:"i6", name:"矿泉水", price:2.00, available:true, image:"" }
    ]},
    { id:"cat3", name:"小吃 Snacks", items:[
      { id:"i7", name:"炸鸡翅 (3pcs)", price:7.00, available:true, image:"" }
    ]}
  ],
  nextOrderSeq:1,
  lastOrderDate:"",
  lastModified:"",
  recentlyDeleted:[]
};

// JSON round-trip instead of structuredClone() — structuredClone was only added to Chrome in
// 2022 (v98), so it's undefined on the older Android WebView/Chrome builds some cheap tablets
// still ship with. DEFAULT_STATE is plain JSON-safe data, so this is a safe substitute.
function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return deepClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return Object.assign(deepClone(DEFAULT_STATE), parsed, {
      settings: Object.assign({}, DEFAULT_STATE.settings, parsed.settings||{})
    });
  }catch(e){ return deepClone(DEFAULT_STATE); }
}
function saveState(){
  state.lastModified = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if(!applyingRemoteCloudState) scheduleCloudPush();
}

function loadHistory(){
  try{ return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch(e){ return []; }
}
function saveHistory(){ localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }

function loadHeldOrders(){
  try{ return JSON.parse(localStorage.getItem(HELD_KEY)) || []; }
  catch(e){ return []; }
}
function saveHeldOrders(){ localStorage.setItem(HELD_KEY, JSON.stringify(heldOrders)); }

let state = loadState();
let history = loadHistory();
let heldOrders = loadHeldOrders();
let cart = []; // {itemId, name, price, qty, note}
let activeCategory = state.menu[0] ? state.menu[0].id : null;
let unlockedSettings = false;
let discount = null; // {type:'percent'|'amount', value:number}

function fmt(n){ return "RM" + (Math.round(n*100)/100).toFixed(2); }
function round2(n){ return Math.round(n*100)/100; }
function roundToNickel(n){ return Math.round(n*20)/20; }
function todayStr(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }

function ensureOrderSeq(){
  const t = todayStr();
  if(state.lastOrderDate !== t){
    state.lastOrderDate = t;
    state.nextOrderSeq = 1;
    saveState();
  }
}
function peekOrderNo(){
  ensureOrderSeq();
  const prefix = state.settings.deviceLabel ? state.settings.deviceLabel.trim()+"-" : "";
  return prefix + "#" + String(state.nextOrderSeq).padStart(3,"0");
}

// ---------- Rendering: menu ----------
function renderCategoryTabs(){
  const nav = document.getElementById("categoryTabs");
  nav.innerHTML = "";
  state.menu.forEach(cat=>{
    const btn = document.createElement("button");
    btn.className = "cat-tab" + (cat.id===activeCategory?" active":"");
    btn.textContent = cat.name;
    btn.onclick = ()=>{ activeCategory = cat.id; renderCategoryTabs(); renderItemGrid(); };
    nav.appendChild(btn);
  });
}

function isCombo(item){
  return !!(item.comboItems && item.comboItems.length>0);
}
// Resolves an item's comboItems (stored as {itemId,qty}) against the current menu, returning
// {name, qty} pairs. A component that's since been deleted from the menu is skipped.
function resolveComboContents(item){
  if(!isCombo(item)) return [];
  return item.comboItems.map(ci=>{
    const found = findMenuItemById(ci.itemId);
    return found ? { name: found.name, qty: ci.qty } : null;
  }).filter(Boolean);
}
// comboContents stores the per-ONE-combo component quantity (e.g. "1 drink per combo"). Every
// place that displays it against a cart/order LINE must scale by that line's own qty, or ordering
// 2x a combo silently under-reports what's actually included — kitchen ticket already did this
// scaling correctly; cart/receipt/print-receipt didn't, so centralize it here instead of leaving
// each call site to remember the multiply.
function comboContentsLabel(comboContents, lineQty){
  return comboContents.map(c=>{
    const totalQty = c.qty * lineQty;
    return c.name + (totalQty>1 ? "x"+totalQty : "");
  }).join("、");
}

function findCombosUsingItem(itemId){
  const names = [];
  state.menu.forEach(cat=>{
    cat.items.forEach(i=>{
      if(isCombo(i) && i.comboItems.some(ci=>ci.itemId===itemId)) names.push(i.name);
    });
  });
  return names;
}

function findMenuItemById(id){
  for(const cat of state.menu){
    const found = cat.items.find(i=>i.id===id);
    if(found) return found;
  }
  return null;
}

function renderItemGrid(){
  const grid = document.getElementById("itemGrid");
  grid.innerHTML = "";
  const cat = state.menu.find(c=>c.id===activeCategory);
  if(!cat) return;
  cat.items.forEach(item=>{
    const card = document.createElement("div");
    card.className = "item-card" + (item.available===false ? " unavailable" : "");
    const photoInner = item.image
      ? `<img src="${item.image}" alt="">`
      : `<span class="photo-placeholder">🍽️</span>`;
    const toggleLabel = item.available===false ? "↺ 恢复上架" : "🚫";
    const combo = isCombo(item);
    const comboContents = combo ? resolveComboContents(item) : [];
    card.innerHTML = `
      <div class="item-photo">
        ${photoInner}
        ${item.available===false ? `<div class="badge">已售罄</div>` : ""}
        ${combo ? `<span class="combo-corner">🍱 套餐</span>` : ""}
        <button class="item-quick-toggle" title="标记售罄/恢复">${toggleLabel}</button>
      </div>
      <div class="name">${escapeHtml(item.name)}</div>
      <div class="price">${fmt(item.price)}</div>
      ${combo ? `<div class="combo-contents">含: ${comboContents.map(c=>escapeHtml(c.name)+(c.qty>1?"x"+c.qty:"")).join("、")}</div>` : ""}
    `;
    if(item.available!==false){
      card.onclick = ()=> addToCart(item);
    }
    card.querySelector(".item-quick-toggle").onclick = (e)=>{
      e.stopPropagation();
      item.available = item.available===false ? true : false;
      saveState();
      renderItemGrid();
      alertToast(item.available===false ? `${item.name} 已标记售罄` : `${item.name} 已恢复上架`);
    };
    grid.appendChild(card);
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// ---------- Cart ----------
// A split is "in progress" once confirmSplit() has locked in groups but not every group has paid yet.
// While true, the cart contents are frozen (group totals were computed from them) and the only way
// forward is to keep paying from splitPayModal, or to clear the whole order.
function splitInProgress(){
  return !!splitGroups && !splitGroups.every(g=>g.paid);
}
function blockIfSplitInProgress(){
  if(!splitInProgress()) return false;
  alertToast("还有账单未结清,请先在「分单结账」完成付款,或清空订单");
  renderSplitPayList();
  showModal("splitPayModal");
  return true;
}
function resetOrderState(){
  discount = null;
  activeOrderNo = null;
  splitGroups = null;
}

function addToCart(item){
  if(blockIfSplitInProgress()) return;
  const existing = cart.find(c=>c.itemId===item.id);
  if(existing){ existing.qty++; }
  else{ cart.push({ itemId:item.id, name:item.name, price:item.price, qty:1, note:"", comboContents: resolveComboContents(item) }); }
  renderCart();
}
function changeQty(itemId, delta){
  if(blockIfSplitInProgress()) return;
  const line = cart.find(c=>c.itemId===itemId);
  if(!line) return;
  line.qty += delta;
  if(line.qty<=0){ cart = cart.filter(c=>c.itemId!==itemId); }
  renderCart();
}
function removeLine(itemId){
  if(blockIfSplitInProgress()) return;
  cart = cart.filter(c=>c.itemId!==itemId);
  renderCart();
}
function clearCart(){
  cart = [];
  resetOrderState();
  renderCart();
}
function cartSubtotal(){ return cart.reduce((s,c)=>s+c.price*c.qty,0); }
function discountAmount(){
  if(!discount) return 0;
  const sub = cartSubtotal();
  let amt = discount.type==="percent" ? sub*discount.value/100 : discount.value;
  return Math.min(Math.max(amt,0), sub);
}
function discountedSubtotal(){ return cartSubtotal() - discountAmount(); }
function cartTax(){ return state.settings.taxEnabled ? discountedSubtotal()*state.settings.taxRate/100 : 0; }
function cartTotal(){ return discountedSubtotal()+cartTax(); }
function cartCount(){ return cart.reduce((s,c)=>s+c.qty,0); }

function renderCart(){
  const list = document.getElementById("cartList");
  list.innerHTML = "";
  if(cart.length===0){
    list.innerHTML = `<div class="cart-empty">尚未点餐<br>点击左侧菜品加入订单</div>`;
  }else{
    cart.forEach(line=>{
      const row = document.createElement("div");
      row.className = "cart-item";
      row.innerHTML = `
        <div class="ci-info">
          <div class="ci-name">${escapeHtml(line.name)}${line.comboContents && line.comboContents.length ? ` <span class="combo-tag">套餐</span>` : ""}</div>
          <div class="ci-price">${fmt(line.price)} x ${line.qty} = ${fmt(line.price*line.qty)}</div>
          ${line.comboContents && line.comboContents.length ? `<div class="combo-contents" style="padding:0;margin:2px 0;">含: ${escapeHtml(comboContentsLabel(line.comboContents, line.qty))}</div>` : ""}
          <div class="ci-note">
            ${line.note ? `<span class="ci-note-text">📝 ${escapeHtml(line.note)}</span>` : ""}
            <button class="ci-note-btn" data-act="note">${line.note ? "修改备注" : "+ 加备注"}</button>
          </div>
        </div>
        <div class="qty-stepper">
          <button data-act="minus">−</button>
          <span>${line.qty}</span>
          <button data-act="plus">+</button>
        </div>
        <button class="ci-remove" data-act="remove">🗑</button>
      `;
      row.querySelector('[data-act="minus"]').onclick = ()=>changeQty(line.itemId,-1);
      row.querySelector('[data-act="plus"]').onclick = ()=>changeQty(line.itemId,1);
      row.querySelector('[data-act="remove"]').onclick = ()=>removeLine(line.itemId);
      row.querySelector('[data-act="note"]').onclick = ()=>openItemNoteModal(line.itemId);
      list.appendChild(row);
    });
  }

  document.getElementById("subtotalVal").textContent = fmt(cartSubtotal());

  const rowDiscount = document.getElementById("rowDiscount");
  const rowDiscountAdd = document.getElementById("rowDiscountAdd");
  if(discount){
    rowDiscount.classList.remove("hidden");
    rowDiscountAdd.classList.add("hidden");
    const label = discount.name ? `折扣 (${escapeHtml(discount.name)})` : (discount.type==="percent" ? `折扣 (${discount.value}%)` : "折扣");
    rowDiscount.querySelector("span:first-child").innerHTML = `${label} <button id="btnRemoveDiscount" class="mini-x">✕</button>`;
    document.getElementById("btnRemoveDiscount").onclick = removeDiscount;
    document.getElementById("discountVal").textContent = "-" + fmt(discountAmount());
  }else{
    rowDiscount.classList.add("hidden");
    rowDiscountAdd.classList.remove("hidden");
  }

  const rowTax = document.getElementById("rowTax");
  if(state.settings.taxEnabled){
    rowTax.style.display = "flex";
    document.getElementById("taxLabel").textContent = `服务税 (${state.settings.taxRate}%)`;
    document.getElementById("taxVal").textContent = fmt(cartTax());
  }else{
    rowTax.style.display = "none";
  }
  document.getElementById("totalVal").textContent = fmt(cartTotal());
  document.getElementById("orderNoLabel").textContent = activeOrderNo || peekOrderNo();

  const hasItems = cart.length>0;
  document.getElementById("btnCheckout").disabled = !hasItems;
  document.getElementById("btnSplitBill").disabled = !hasItems;
  document.getElementById("cartFabCount").textContent = cartCount();
  document.getElementById("cartFabTotal").textContent = fmt(cartTotal());
}

// ---------- Hold / park order ----------
function holdCurrentOrder(){
  if(cart.length===0) return;
  if(blockIfSplitInProgress()) return;
  const label = prompt("给这张挂起的单起个名字(例如桌号/顾客名),留空则自动编号") || "";
  heldOrders.push({
    id: uid(),
    label: label.trim() || ("挂单 " + (heldOrders.length+1)),
    cart: cart.map(c=>Object.assign({}, c)),
    discount: discount ? Object.assign({}, discount) : null,
    heldAt: Date.now()
  });
  saveHeldOrders();
  cart = [];
  resetOrderState();
  renderCart();
  renderHeldBadge();
  closeMobileCart();
  alertToast("已挂单: " + heldOrders[heldOrders.length-1].label);
}

function renderHeldBadge(){
  const badge = document.getElementById("heldCountBadge");
  const btn = document.getElementById("btnHeldOrders");
  badge.textContent = heldOrders.length;
  badge.classList.toggle("hidden", heldOrders.length===0);
  btn.disabled = heldOrders.length===0;
}

function openHeldOrdersModal(){
  renderHeldOrdersList();
  showModal("heldOrdersModal");
}

function renderHeldOrdersList(){
  const list = document.getElementById("heldOrdersList");
  if(heldOrders.length===0){
    list.innerHTML = `<div class="cart-empty">目前没有挂起的订单</div>`;
    return;
  }
  list.innerHTML = "";
  heldOrders.forEach(h=>{
    const sub = h.cart.reduce((s,c)=>s+c.price*c.qty,0);
    const detail = h.cart.map(c=>`${c.name} x${c.qty}`).join("、");
    const row = document.createElement("div");
    row.className = "held-item";
    row.innerHTML = `
      <div>
        <div class="hd-label">${escapeHtml(h.label)} · ${fmt(sub)}</div>
        <div class="hd-detail">${escapeHtml(detail)}</div>
      </div>
      <div class="h-actions">
        <button class="resume">恢复</button>
        <button class="void">删除</button>
      </div>
    `;
    row.querySelector(".resume").onclick = ()=> resumeHeldOrder(h.id);
    row.querySelector(".void").onclick = ()=>{
      if(confirm(`确定删除挂起的订单「${h.label}」？`)){
        heldOrders = heldOrders.filter(x=>x.id!==h.id);
        saveHeldOrders();
        renderHeldOrdersList();
        renderHeldBadge();
      }
    };
    list.appendChild(row);
  });
}

function resumeHeldOrder(id){
  if(blockIfSplitInProgress()) return;
  // Always confirm, even when the cart is currently empty — a conditional-only confirm here was
  // the exact same gap that let a mis-tap on reopenOrder's "重开" silently blow away the cart with
  // no checkpoint (fixed separately); this sibling function had the identical bug.
  const warnExtra = cart.length>0 ? "\n\n当前购物车还有内容,会被覆盖。" : "";
  if(!confirm(`确定恢复这张挂起的订单吗?${warnExtra}`)) return;
  const idx = heldOrders.findIndex(h=>h.id===id);
  if(idx<0) return;
  const held = heldOrders[idx];
  cart = held.cart.map(c=>Object.assign({}, c));
  resetOrderState();
  discount = held.discount ? Object.assign({}, held.discount) : null;
  heldOrders.splice(idx,1);
  saveHeldOrders();
  renderCart();
  renderHeldBadge();
  hideModal("heldOrdersModal");
}

// ---------- Discount ----------
let discountType = "percent";

function openDiscountModal(){
  if(cart.length===0) return;
  if(blockIfSplitInProgress()) return;
  document.getElementById("discountPinInput").value = "";
  document.getElementById("discountPinError").classList.add("hidden");
  document.getElementById("discountInput").value = discount ? String(discount.value) : "";
  discountType = discount ? discount.type : "percent";
  pendingPromoName = discount ? discount.name || null : null;
  document.querySelectorAll("#discountModal .pay-tab").forEach(b=>b.classList.toggle("active", b.dataset.dtype===discountType));
  buildDiscountQuick();
  buildPromoPresets();
  updateDiscountPreview();
  if(state.settings.discountPinRequired){
    document.getElementById("discountPinGate").classList.remove("hidden");
    document.getElementById("discountBody").classList.add("hidden");
  }else{
    document.getElementById("discountPinGate").classList.add("hidden");
    document.getElementById("discountBody").classList.remove("hidden");
  }
  showModal("discountModal");
}

let pendingPromoName = null;

function buildPromoPresets(){
  const wrap = document.getElementById("promoPresetWrap");
  const box = document.getElementById("promoPresets");
  const promos = state.settings.promotions || [];
  if(promos.length===0){
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  box.innerHTML = "";
  promos.forEach(p=>{
    const btn = document.createElement("button");
    btn.textContent = p.type==="percent" ? `${p.name} (${p.value}%)` : `${p.name} (-RM${p.value})`;
    btn.onclick = ()=>{
      discountType = p.type;
      pendingPromoName = p.name;
      document.querySelectorAll("#discountModal .pay-tab").forEach(b=>b.classList.toggle("active", b.dataset.dtype===discountType));
      buildDiscountQuick();
      document.getElementById("discountInput").value = p.value;
      updateDiscountPreview();
    };
    box.appendChild(btn);
  });
}

function buildDiscountQuick(){
  const box = document.getElementById("discountQuick");
  box.innerHTML = "";
  const opts = discountType==="percent" ? [5,10,15,20] : [1,2,5,10];
  opts.forEach(v=>{
    const btn = document.createElement("button");
    btn.textContent = discountType==="percent" ? v+"%" : "RM"+v;
    btn.onclick = ()=>{ pendingPromoName = null; document.getElementById("discountInput").value = v; updateDiscountPreview(); };
    box.appendChild(btn);
  });
}

function updateDiscountPreview(){
  const val = parseFloat(document.getElementById("discountInput").value) || 0;
  const sub = cartSubtotal();
  let amt = discountType==="percent" ? sub*val/100 : val;
  amt = Math.min(Math.max(amt,0), sub);
  const discSub = sub - amt;
  const tax = state.settings.taxEnabled ? discSub*state.settings.taxRate/100 : 0;
  document.getElementById("discountPreviewTotal").textContent = fmt(discSub+tax);
}

function applyDiscount(){
  const val = parseFloat(document.getElementById("discountInput").value) || 0;
  if(val<=0){ removeDiscount(); hideModal("discountModal"); return; }
  discount = { type:discountType, value:val, name: pendingPromoName || null };
  renderCart();
  hideModal("discountModal");
}
function removeDiscount(){
  discount = null;
  renderCart();
}

// ---------- Item notes ----------
const NOTE_CHIPS = ["不要辣","少辣","加辣","不要葱","不要蒜","走冰","少冰","少甜","少油","多汤","打包外带"];
let noteEditItemId = null;

function openItemNoteModal(itemId){
  const line = cart.find(c=>c.itemId===itemId);
  if(!line) return;
  noteEditItemId = itemId;
  document.getElementById("itemNoteTitle").textContent = `${line.name} · 备注`;
  document.getElementById("itemNoteInput").value = line.note || "";
  const chipsBox = document.getElementById("noteChips");
  chipsBox.innerHTML = "";
  NOTE_CHIPS.forEach(chip=>{
    const btn = document.createElement("button");
    btn.textContent = chip;
    const isActive = (line.note||"").includes(chip);
    btn.className = isActive ? "active" : "";
    btn.onclick = ()=>{
      const input = document.getElementById("itemNoteInput");
      const parts = input.value.split("、").map(s=>s.trim()).filter(Boolean);
      const idx = parts.indexOf(chip);
      if(idx>=0){ parts.splice(idx,1); } else { parts.push(chip); }
      input.value = parts.join("、");
      btn.classList.toggle("active");
    };
    chipsBox.appendChild(btn);
  });
  showModal("itemNoteModal");
}

function saveItemNote(){
  const line = cart.find(c=>c.itemId===noteEditItemId);
  if(line){ line.note = document.getElementById("itemNoteInput").value.trim(); renderCart(); }
  hideModal("itemNoteModal");
}

// ---------- Checkout (generalized: full cart OR a split-bill group) ----------
let currentPayMethod = "cash";
let checkoutCtx = null; // {label, items, subtotal, discountShare, tax, taxRate, total}
let currentReceiptOrder = null;
let activeOrderNo = null;
let splitGroups = null; // array of {label, lines:[{itemId,name,price,qty}], subtotal, discountShare, tax, total, paid}

function buildFullCartCtx(){
  return {
    label: null,
    items: cart.map(c=>({name:c.name, price:c.price, qty:c.qty, note:c.note||"", comboContents:c.comboContents||[]})),
    subtotal: cartSubtotal(),
    discountShare: discountAmount(),
    discountName: discount ? discount.name : null,
    tax: cartTax(),
    taxRate: state.settings.taxEnabled ? state.settings.taxRate : 0,
    total: cartTotal()
  };
}

function openCheckout(ctx){
  if(cart.length===0) return;
  if(!ctx && blockIfSplitInProgress()) return;
  if(activeOrderNo===null) activeOrderNo = peekOrderNo();
  checkoutCtx = ctx || buildFullCartCtx();
  checkoutCtx.cashDue = roundToNickel(checkoutCtx.total);
  document.getElementById("dueAmount").textContent = fmt(checkoutCtx.cashDue);
  document.getElementById("dueAmountQr").textContent = fmt(checkoutCtx.total);
  const roundNote = document.getElementById("cashRoundingNote");
  if(Math.abs(checkoutCtx.cashDue - checkoutCtx.total) >= 0.001){
    roundNote.textContent = `现金四舍五入至最近5分 (原价 ${fmt(checkoutCtx.total)})`;
    roundNote.classList.remove("hidden");
  }else{
    roundNote.classList.add("hidden");
  }
  document.getElementById("cashReceived").value = "";
  document.getElementById("changeVal").textContent = fmt(0);
  document.getElementById("btnConfirmCash").disabled = true;
  buildQuickAmounts();
  switchPayTab("cash");
  const qrImg = document.getElementById("qrImage");
  if(state.settings.qrImage){
    qrImg.src = state.settings.qrImage;
    qrImg.style.display = "block";
    document.getElementById("qrHint").textContent = "出示二维码给顾客扫描付款";
  }else{
    qrImg.style.display = "none";
    document.getElementById("qrHint").textContent = "尚未设置收款二维码,请到「设置」上传";
  }
  showModal("checkoutModal");
}

function switchPayTab(method){
  currentPayMethod = method;
  document.querySelectorAll("#checkoutModal .pay-tab").forEach(b=>b.classList.toggle("active", b.dataset.method===method));
  document.getElementById("payCash").classList.toggle("hidden", method!=="cash");
  document.getElementById("payQr").classList.toggle("hidden", method!=="qr");
}

function buildQuickAmounts(){
  const total = checkoutCtx.cashDue;
  const box = document.getElementById("quickAmounts");
  box.innerHTML = "";
  const exact = { label:"刚好", value: total };
  const roundUps = [10,20,50,100].map(v=>({label:"RM"+v, value:v}))
    .filter(o=>o.value >= total);
  const opts = [exact, ...roundUps].slice(0,4);
  const seen = new Set();
  opts.forEach(o=>{
    const key = o.value.toFixed(2);
    if(seen.has(key)) return;
    seen.add(key);
    const btn = document.createElement("button");
    btn.textContent = o.label;
    btn.onclick = ()=>{
      document.getElementById("cashReceived").value = o.value.toFixed(2);
      updateChange();
    };
    box.appendChild(btn);
  });
}

function updateChange(){
  const received = parseFloat(document.getElementById("cashReceived").value) || 0;
  const total = checkoutCtx.cashDue;
  const change = received - total;
  const changeEl = document.getElementById("changeVal");
  changeEl.textContent = fmt(Math.abs(change));
  changeEl.classList.toggle("negative", change < -0.001);
  document.getElementById("btnConfirmCash").disabled = received + 0.001 < total;
}

function finalizeOrder(paymentMethod, extra){
  const ctx = checkoutCtx;
  const orderNo = activeOrderNo + (ctx.label ? "-"+ctx.label : "");
  const finalTotal = paymentMethod==="cash" ? ctx.cashDue : ctx.total;
  const order = {
    orderNo,
    date: todayStr(),
    time: new Date().toLocaleTimeString("en-MY",{hour:"2-digit",minute:"2-digit"}),
    items: ctx.items,
    subtotal: ctx.subtotal,
    discount: ctx.discountShare,
    discountName: ctx.discountName || null,
    tax: ctx.tax,
    taxRate: ctx.taxRate,
    total: finalTotal,
    roundingAdj: paymentMethod==="cash" ? round2(finalTotal - ctx.total) : 0,
    paymentMethod,
    cashReceived: extra && extra.cashReceived,
    change: extra && extra.change,
    isSplit: !!ctx.label,
    splitKind: ctx.splitKind || null,
    voided: false
  };
  history.unshift(order);
  saveHistory();
  hideModal("checkoutModal");

  if(splitGroups){
    const grp = splitGroups.find(g=>g.label===ctx.label);
    if(grp) grp.paid = true;
    const allPaid = splitGroups.every(g=>g.paid);
    hideModal("splitPayModal");
    showReceipt(order, !allPaid);
    if(allPaid){
      state.nextOrderSeq++;
      saveState();
      clearCart();
    }
  }else{
    state.nextOrderSeq++;
    saveState();
    showReceipt(order, false);
    maybeAutoPrintKitchen(order.orderNo, order.items);
    clearCart();
    closeMobileCart();
  }
}

function maybeAutoPrintKitchen(orderNo, items){
  if(!(state.settings.autoPrintKitchen && btPrinterChar)) return;
  printKitchenTicketBT({ orderNo, time: new Date().toLocaleTimeString("en-MY",{hour:"2-digit",minute:"2-digit"}), items });
}

function showReceipt(order, returnToSplitList){
  const el = document.getElementById("receiptContent");
  const isEqualSplit = order.isSplit && order.splitKind==="equal";
  const comboLine = it => it.comboContents && it.comboContents.length
    ? `<div class="r-line" style="padding:0 0 4px 12px;"><span style="font-size:12px;color:var(--text-mute);">含: ${escapeHtml(comboContentsLabel(it.comboContents, it.qty))}</span></div>`
    : "";
  const itemsBlock = isEqualSplit
    ? `<p class="hint" style="text-align:left;margin:0 0 8px;">均分账单 · 整单内容: ${order.items.map(it=>escapeHtml(it.name)+" x"+it.qty).join("、")}</p><hr>`
    : `${order.items.map(it=>`
        <div class="r-line"><span>${escapeHtml(it.name)} x${it.qty}${it.note?` <i style="color:var(--brand);font-style:normal;">(${escapeHtml(it.note)})</i>`:""}</span><span>${fmt(it.price*it.qty)}</span></div>
        ${comboLine(it)}
      `).join("")}<hr>`;
  el.innerHTML = `
    <div class="r-shop">${escapeHtml(state.settings.shopName)}</div>
    <div class="r-meta">订单 ${escapeHtml(order.orderNo)} · ${order.date} ${order.time}</div>
    <hr>
    ${itemsBlock}
    <div class="r-line"><span>${isEqualSplit ? "本账单应付 (均分)" : "小计"}</span><span>${fmt(order.subtotal)}</span></div>
    ${order.discount>0?`<div class="r-line"><span>折扣${order.discountName?` (${escapeHtml(order.discountName)})`:""}</span><span>-${fmt(order.discount)}</span></div>`:""}
    ${order.tax>0?`<div class="r-line"><span>服务税 (${order.taxRate}%)</span><span>${fmt(order.tax)}</span></div>`:""}
    ${order.roundingAdj?`<div class="r-line"><span>现金四舍五入</span><span>${order.roundingAdj>0?"+"+fmt(order.roundingAdj):"-"+fmt(Math.abs(order.roundingAdj))}</span></div>`:""}
    <div class="r-line r-total"><span>总计</span><span>${fmt(order.total)}</span></div>
    <div class="r-line"><span>付款方式</span><span>${order.paymentMethod==="cash"?"现金":"DuitNow / 电子钱包"}</span></div>
    ${order.paymentMethod==="cash"?`
      <div class="r-line"><span>实收</span><span>${fmt(order.cashReceived)}</span></div>
      <div class="r-line"><span>找零</span><span>${fmt(order.change)}</span></div>
    `:""}
    <div class="r-footer">谢谢光临 ， THANK YOU .</div>
  `;
  document.getElementById("btnNewOrder").dataset.returnSplit = returnToSplitList ? "1" : "";
  currentReceiptOrder = order;
  // Equal-split receipts carry the WHOLE order's items (shown above for reference only, not this
  // guest's share) — the kitchen ticket for that already printed once when the split was confirmed,
  // so a "reprint" button here would resend the entire order's dishes to the kitchen every time any
  // one guest's receipt is reopened. Only item-mode splits (this guest's actual dishes) make sense to reprint.
  document.getElementById("btnPrintKitchen").classList.toggle("hidden", isEqualSplit);
  showModal("receiptModal");
}

// ---------- Generic PIN confirm ----------
let pinConfirmCallback = null;
function requestPinConfirm(title, callback){
  pinConfirmCallback = callback;
  document.getElementById("pinConfirmTitle").textContent = title;
  document.getElementById("pinConfirmInput").value = "";
  document.getElementById("pinConfirmError").classList.add("hidden");
  showModal("pinConfirmModal");
}

// ---------- History ----------
// The order list itself stays visible to staff without a PIN (needed to confirm a specific order
// went through, or to void/reopen — each of those already has its own PIN check). Only the
// aggregate revenue summary is gated, since owners often don't want staff seeing total sales at a
// glance; it re-locks every time the history modal is (re)opened rather than staying unlocked for
// the rest of the session.
let historyStatsUnlocked = false;

function renderHistoryStats(todays){
  const box = document.getElementById("historySummary");
  if(!historyStatsUnlocked){
    box.innerHTML = `<button id="btnUnlockStats" class="secondary-btn" style="flex:1;">🔒 需要密码查看营业额统计</button>`;
    document.getElementById("btnUnlockStats").onclick = ()=>{
      requestPinConfirm("查看营业额统计", ()=>{
        historyStatsUnlocked = true;
        renderHistoryStats(todays);
      });
    };
    return;
  }
  const valid = todays.filter(o=>!o.voided);
  const totalSales = valid.reduce((s,o)=>s+o.total,0);
  const cashSales = valid.filter(o=>o.paymentMethod==="cash").reduce((s,o)=>s+o.total,0);
  const qrSales = valid.filter(o=>o.paymentMethod==="qr").reduce((s,o)=>s+o.total,0);
  box.innerHTML = `
    <div class="stat">订单数<b>${valid.length}</b></div>
    <div class="stat">总营业额<b>${fmt(totalSales)}</b></div>
    <div class="stat">现金<b>${fmt(cashSales)}</b></div>
    <div class="stat">电子钱包<b>${fmt(qrSales)}</b></div>
  `;
}

function openHistory(){
  const t = todayStr();
  const todays = history.filter(o=>o.date===t);
  historyStatsUnlocked = false;
  renderHistoryStats(todays);

  const list = document.getElementById("historyList");
  if(todays.length===0){
    list.innerHTML = `<div class="cart-empty">今天还没有订单</div>`;
  }else{
    list.innerHTML = "";
    todays.forEach(o=>{
      const row = document.createElement("div");
      row.className = "history-item" + (o.voided ? " voided" : "");
      row.innerHTML = `
        <div>
          <div class="h-no">${escapeHtml(o.orderNo)} · ${fmt(o.total)}</div>
          <div class="h-method">${o.time} · ${o.paymentMethod==="cash"?"现金":"电子钱包"}${o.isSplit?" · 分单":""}</div>
        </div>
        ${o.voided ? `<span class="h-voided-tag">已作废</span>` : `
          <div class="h-actions">
            <button class="print">打印</button>
            <button class="reopen">重开</button>
            <button class="void">作废</button>
          </div>
        `}
      `;
      if(!o.voided){
        row.querySelector(".print").onclick = ()=>{ hideModal("historyModal"); showReceipt(o, false); };
        row.querySelector(".reopen").onclick = ()=> reopenOrder(o.orderNo);
        row.querySelector(".void").onclick = ()=> voidOrder(o.orderNo);
      }
      list.appendChild(row);
    });
  }
  showModal("historyModal");
}

function voidOrder(orderNo){
  requestPinConfirm(`作废订单 ${orderNo}`, ()=>{
    const ord = history.find(o=>o.orderNo===orderNo);
    if(!ord) return;
    if(!confirm(`确定作废订单 ${orderNo} (${fmt(ord.total)})？此操作会保留记录但不计入今日营业额。`)) return;
    ord.voided = true;
    saveHistory();
    openHistory();
    alertToast("订单已作废");
  });
}

function findMenuItemByName(name){
  for(const cat of state.menu){
    const found = cat.items.find(i=>i.name===name);
    if(found) return found;
  }
  return null;
}

function reopenOrder(orderNo){
  if(blockIfSplitInProgress()) return;
  requestPinConfirm(`重开订单 ${orderNo} 到购物车`, ()=>{
    const ord = history.find(o=>o.orderNo===orderNo);
    if(!ord) return;
    // Always confirm before touching the cart, even when it's currently empty (the common case
    // right after finishing an order) — a mis-tap on 重开 next to 作废 previously slipped straight
    // through with no checkpoint at all when the cart happened to be empty.
    const warnExtra = cart.length>0 ? "\n\n当前购物车还有内容,会被覆盖。" : "";
    if(!confirm(`确定把订单 ${orderNo} 的内容重新放入购物车吗?${warnExtra}`)) return;
    cart = ord.items.map(it=>{
      const menuItem = findMenuItemByName(it.name);
      // When a live menu item is matched, price it at the item's CURRENT price rather than the
      // historical price on the old order. addToCart merges new taps of the same dish into this
      // line by itemId alone (it doesn't re-check price), so if we kept the historical price here
      // any units added afterward via the menu grid would silently inherit the stale price too.
      return { itemId: menuItem ? menuItem.id : "reopen_"+it.name, name: it.name, price: menuItem ? menuItem.price : it.price, qty: it.qty, note: it.note||"", comboContents: it.comboContents||[] };
    });
    resetOrderState();
    renderCart();
    hideModal("historyModal");
    // Surface the reopened cart immediately (relevant on mobile widths where the cart pane is
    // otherwise tucked behind the FAB) so it's obvious what just happened, not just a quiet
    // change behind the item grid.
    document.getElementById("cartPane").classList.add("open");
    alertToast("已把该订单内容放入购物车,请核实后重新结账");
  });
}

// ---------- Split bill ----------
let splitMode = "equal";
let splitEqualN = 2;
let splitUnits = null; // [{unitKey,itemId,name,price}]
let splitUnitAssign = {}; // unitKey -> groupIndex
let splitDraftGroups = []; // [{label}]
let activeSplitGroupIdx = 0;

function openSplitModal(){
  if(cart.length===0) return;
  if(blockIfSplitInProgress()) return;
  splitMode = "equal";
  splitEqualN = 2;
  document.querySelectorAll("#splitModal .pay-tab").forEach(b=>b.classList.toggle("active", b.dataset.split==="equal"));
  document.getElementById("splitEqual").classList.remove("hidden");
  document.getElementById("splitItems").classList.add("hidden");
  renderSplitEqual();
  buildSplitUnits();
  splitDraftGroups = [{label:"A"},{label:"B"}];
  activeSplitGroupIdx = 0;
  renderSplitItems();
  showModal("splitModal");
}

function switchSplitMode(mode){
  splitMode = mode;
  document.querySelectorAll("#splitModal .pay-tab").forEach(b=>b.classList.toggle("active", b.dataset.split===mode));
  document.getElementById("splitEqual").classList.toggle("hidden", mode!=="equal");
  document.getElementById("splitItems").classList.toggle("hidden", mode!=="items");
}

function renderSplitEqual(){
  const box = document.getElementById("splitEqualCount");
  box.innerHTML = "";
  [2,3,4,5,6].forEach(n=>{
    const btn = document.createElement("button");
    btn.textContent = n + " 人";
    btn.className = n===splitEqualN ? "active" : "";
    if(n===splitEqualN){ btn.style.background="var(--brand)"; btn.style.color="#fff"; btn.style.borderColor="var(--brand)"; }
    btn.onclick = ()=>{ splitEqualN = n; renderSplitEqual(); };
    box.appendChild(btn);
  });

  const shares = computeEqualShares(splitEqualN);
  const prev = document.getElementById("splitEqualPreview");
  prev.innerHTML = shares.map((s,i)=>`<div class="sp-row"><span>第 ${i+1} 份</span><span>${fmt(s)}</span></div>`).join("");
}

function computeEqualShares(n){
  const total = cartTotal();
  const base = Math.floor((total/n)*100)/100;
  const shares = new Array(n).fill(base);
  let remainder = round2(total - base*n);
  let i = 0;
  while(remainder > 0.001 && i < n){
    shares[i] = round2(shares[i] + 0.01);
    remainder = round2(remainder - 0.01);
    i++;
  }
  return shares;
}

function buildSplitUnits(){
  splitUnits = [];
  cart.forEach(line=>{
    for(let i=0;i<line.qty;i++){
      splitUnits.push({ unitKey: line.itemId+"_"+i, itemId: line.itemId, name: line.name, price: line.price, note: line.note||"", comboContents: line.comboContents||[] });
    }
  });
  splitUnitAssign = {};
}

function renderSplitItems(){
  const tabsBox = document.getElementById("splitGroupTabs");
  tabsBox.innerHTML = "";
  splitDraftGroups.forEach((g, idx)=>{
    const sub = splitUnits.filter(u=>splitUnitAssign[u.unitKey]===idx).reduce((s,u)=>s+u.price,0);
    const btn = document.createElement("button");
    btn.className = "split-group-tab" + (idx===activeSplitGroupIdx?" active":"");
    btn.textContent = `账单 ${g.label} (${fmt(sub)})`;
    btn.onclick = ()=>{ activeSplitGroupIdx = idx; renderSplitItems(); };
    tabsBox.appendChild(btn);
  });

  const list = document.getElementById("splitItemList");
  list.innerHTML = "";
  splitUnits.forEach(u=>{
    const assignedIdx = splitUnitAssign[u.unitKey];
    const row = document.createElement("div");
    row.className = "split-unit-row" + (assignedIdx!==undefined ? " assigned" : "");
    const badgeText = assignedIdx!==undefined ? splitDraftGroups[assignedIdx].label : "未分配";
    row.innerHTML = `
      <div>
        <div class="su-name">${escapeHtml(u.name)}</div>
        <div class="su-price">${fmt(u.price)}</div>
      </div>
      <span class="su-badge">${badgeText}</span>
    `;
    row.onclick = ()=>{
      if(splitUnitAssign[u.unitKey]===activeSplitGroupIdx){
        delete splitUnitAssign[u.unitKey];
      }else{
        splitUnitAssign[u.unitKey] = activeSplitGroupIdx;
      }
      renderSplitItems();
    };
    list.appendChild(row);
  });

  const unassignedCount = splitUnits.filter(u=>splitUnitAssign[u.unitKey]===undefined).length;
  document.getElementById("splitItemsHint").textContent = unassignedCount>0
    ? `点选账单标签,再点菜品分配 · 还有 ${unassignedCount} 项未分配`
    : `全部菜品已分配完毕`;
}

function addSplitGroup(){
  const nextLetter = String.fromCharCode(65 + splitDraftGroups.length);
  if(splitDraftGroups.length>=8) return;
  splitDraftGroups.push({label: nextLetter});
  renderSplitItems();
}

function confirmSplit(){
  const cartSub = cartSubtotal();
  const totalDiscount = discountAmount();
  const taxEnabled = state.settings.taxEnabled;
  const taxRate = state.settings.taxRate;

  let groups = [];
  if(splitMode==="equal"){
    const shares = computeEqualShares(splitEqualN);
    // Derive subtotal/tax FROM each share's (already-exact) total, rather than dividing
    // cartSub/discount independently, so subtotal - discountShare + tax === total for every
    // row even after cent rounding — this guarantees each printed receipt's own numbers add up,
    // which matters more than the shares summing back to the cart-level aggregate.
    groups = shares.map((total,i)=>{
      const discountShare = round2(totalDiscount/splitEqualN);
      const discSub = taxEnabled ? round2(total/(1+taxRate/100)) : total;
      const tax = round2(total - discSub);
      const subtotal = round2(discSub + discountShare);
      return {
        label: String(i+1),
        items: cart.map(c=>({name:c.name, price:c.price, qty:c.qty, note:c.note||"", comboContents:c.comboContents||[]})),
        subtotal,
        discountShare,
        discountName: discount ? discount.name : null,
        tax,
        total,
        splitKind:"equal"
      };
    });
  }else{
    const unassigned = splitUnits.filter(u=>splitUnitAssign[u.unitKey]===undefined);
    if(unassigned.length>0){
      alertToast(`还有 ${unassigned.length} 项未分配到账单`);
      return;
    }
    if(splitDraftGroups.length<2){
      alertToast("至少需要 2 个账单");
      return;
    }
    groups = splitDraftGroups.map((g, idx)=>{
      const unitsInGroup = splitUnits.filter(u=>splitUnitAssign[u.unitKey]===idx);
      const groupSub = round2(unitsInGroup.reduce((s,u)=>s+u.price,0));
      const groupDiscountShare = cartSub>0 ? round2(totalDiscount * (groupSub/cartSub)) : 0;
      const discSub = groupSub - groupDiscountShare;
      const tax = taxEnabled ? round2(discSub*taxRate/100) : 0;
      // aggregate units back into item lines for the receipt
      const linesMap = {};
      unitsInGroup.forEach(u=>{
        if(!linesMap[u.itemId]) linesMap[u.itemId] = {name:u.name, price:u.price, qty:0, note:u.note||"", comboContents:u.comboContents||[]};
        linesMap[u.itemId].qty++;
      });
      return {
        label: g.label,
        items: Object.values(linesMap),
        subtotal: groupSub,
        discountShare: groupDiscountShare,
        discountName: discount ? discount.name : null,
        tax,
        total: round2(discSub+tax),
        splitKind:"items"
      };
    });
  }

  // Reconcile rounding so the groups sum exactly to cartTotal(). The diff is folded into the
  // last group's subtotal (not just total), so that group's own subtotal-discount+tax still
  // equals its total — patching total alone would leave that one receipt internally inconsistent.
  // (Adjusting subtotal rather than tax avoids conjuring a nonzero tax line when tax is disabled.)
  const target = round2(cartTotal());
  const sum = round2(groups.reduce((s,g)=>s+g.total,0));
  const diff = round2(target - sum);
  if(Math.abs(diff)>=0.01 && groups.length>0){
    const last = groups[groups.length-1];
    last.subtotal = round2(last.subtotal + diff);
    last.total = round2(last.total + diff);
  }

  splitGroups = groups.map(g=>Object.assign({paid:false}, g));
  activeOrderNo = peekOrderNo();
  maybeAutoPrintKitchen(activeOrderNo, cart.map(c=>({name:c.name, qty:c.qty, note:c.note||""})));
  hideModal("splitModal");
  renderSplitPayList();
  showModal("splitPayModal");
}

function renderSplitPayList(){
  const list = document.getElementById("splitPayList");
  list.innerHTML = "";
  splitGroups.forEach(g=>{
    const row = document.createElement("div");
    row.className = "split-pay-row";
    row.innerHTML = `
      <div>
        <div class="sp-label">账单 ${g.label}</div>
        <div class="sp-amt">${fmt(g.total)}</div>
      </div>
      ${g.paid ? `<span class="sp-paid">✅ 已结账</span>` : `<button>结账</button>`}
    `;
    if(!g.paid){
      row.querySelector("button").onclick = ()=>{
        hideModal("splitPayModal");
        openCheckout({
          label: g.label,
          items: g.items,
          subtotal: g.subtotal,
          discountShare: g.discountShare,
          discountName: g.discountName,
          tax: g.tax,
          taxRate: state.settings.taxEnabled ? state.settings.taxRate : 0,
          total: g.total,
          splitKind: g.splitKind
        });
      };
    }
    list.appendChild(row);
  });
}

// ---------- Settings ----------
function openSettings(){
  unlockedSettings = false;
  document.getElementById("pinGate").classList.remove("hidden");
  document.getElementById("settingsBody").classList.add("hidden");
  document.getElementById("pinInput").value = "";
  document.getElementById("pinError").classList.add("hidden");
  showModal("settingsModal");
}

function trySubmitPin(){
  const val = document.getElementById("pinInput").value;
  if(val === state.settings.pin){
    unlockedSettings = true;
    document.getElementById("pinGate").classList.add("hidden");
    document.getElementById("settingsBody").classList.remove("hidden");
    populateSettingsForm();
  }else{
    document.getElementById("pinError").classList.remove("hidden");
  }
}

function populateSettingsForm(){
  document.getElementById("inputShopName").value = state.settings.shopName;
  document.getElementById("inputTaxEnabled").checked = state.settings.taxEnabled;
  document.getElementById("inputTaxRate").value = state.settings.taxRate;
  document.getElementById("inputDiscountPinRequired").checked = state.settings.discountPinRequired;
  document.getElementById("inputDeviceLabel").value = state.settings.deviceLabel || "";
  document.getElementById("inputPaperWidth").value = state.settings.paperWidth || "58";
  document.getElementById("inputAutoPrintKitchen").checked = state.settings.autoPrintKitchen!==false;
  document.getElementById("inputNewPin").value = "";
  updatePrinterStatus();
  if(!navigator.bluetooth){
    document.getElementById("btnConnectPrinter").disabled = true;
    document.getElementById("btnTestPrint").disabled = true;
    document.getElementById("printerStatus").textContent = "此浏览器不支持蓝牙打印 (iOS/Safari 不支持,请用 Android + Chrome)";
  }
  const preview = document.getElementById("qrPreview");
  if(state.settings.qrImage){
    preview.src = state.settings.qrImage;
    preview.classList.remove("hidden");
  }else{
    preview.classList.add("hidden");
  }
  renderMenuEditor();
  renderComboListEditor();
  renderPromoEditor();
  renderLastBackupStatus();
  renderCloudSyncStatus();
  if(!document.getElementById("csvStartDate").value) setCsvRange("today");
}

function renderPromoEditor(){
  const list = document.getElementById("promoEditorList");
  list.innerHTML = "";
  (state.settings.promotions||[]).forEach(promo=>{
    const row = document.createElement("div");
    row.className = "promo-editor-row";
    row.innerHTML = `
      <input type="text" value="${escapeHtml(promo.name)}" placeholder="优惠名称,例如：会员9折">
      <select>
        <option value="percent">%</option>
        <option value="amount">RM</option>
      </select>
      <input type="number" step="0.1" min="0" value="${promo.value}">
      <button data-act="delpromo">🗑</button>
    `;
    const nameInput = row.querySelector('input[type="text"]');
    const typeSelect = row.querySelector("select");
    const valueInput = row.querySelector('input[type="number"]');
    typeSelect.value = promo.type;
    nameInput.onchange = ()=>{ promo.name = nameInput.value.trim()||promo.name; saveState(); };
    typeSelect.onchange = ()=>{ promo.type = typeSelect.value; saveState(); };
    valueInput.onchange = ()=>{ promo.value = Math.max(0, parseFloat(valueInput.value)||0); valueInput.value = promo.value; saveState(); };
    row.querySelector('[data-act="delpromo"]').onclick = ()=>{
      if(!confirm(`确定删除优惠「${promo.name}」?`)) return;
      state.settings.promotions = state.settings.promotions.filter(p=>p.id!==promo.id);
      pushToTrash("promo", promo, {});
      saveState();
      renderPromoEditor();
    };
    list.appendChild(row);
  });
}

function addPromo(){
  if(!state.settings.promotions) state.settings.promotions = [];
  state.settings.promotions.push({ id: uid(), name: "新优惠", type: "percent", value: 10 });
  saveState();
  renderPromoEditor();
}

function saveGeneralSettings(){
  state.settings.shopName = document.getElementById("inputShopName").value.trim() || "Soo's Kitchen";
  state.settings.taxEnabled = document.getElementById("inputTaxEnabled").checked;
  state.settings.taxRate = parseFloat(document.getElementById("inputTaxRate").value) || 0;
  state.settings.discountPinRequired = document.getElementById("inputDiscountPinRequired").checked;
  state.settings.deviceLabel = document.getElementById("inputDeviceLabel").value.trim();
  state.settings.paperWidth = document.getElementById("inputPaperWidth").value;
  state.settings.autoPrintKitchen = document.getElementById("inputAutoPrintKitchen").checked;
  const newPin = document.getElementById("inputNewPin").value.trim();
  if(newPin.length>=4){ state.settings.pin = newPin; }
  saveState();
  document.getElementById("shopName").textContent = state.settings.shopName;
  renderCart();
  alertToast("设置已保存");
}

function handleQrFile(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    state.settings.qrImage = reader.result;
    saveState();
    const preview = document.getElementById("qrPreview");
    preview.src = reader.result;
    preview.classList.remove("hidden");
    alertToast("二维码已更新");
  };
  reader.readAsDataURL(file);
}

// ---------- Backup / restore ----------
function downloadBlob(content, filename, mime){
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Backup reminders ----------
// Everything lives in this device's localStorage with no server copy, so if the device is lost or
// breaks and a backup was never taken, the data is very likely gone for good. This nudges the
// habit rather than solving it outright (that would need cloud sync, a separate bigger project).
const LAST_BACKUP_KEY = "sk_pos_last_backup";
const BACKUP_REMIND_DAYS = 3;

function markBackedUp(){
  localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  renderLastBackupStatus();
}

function daysSinceLastBackup(){
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  if(!raw) return Infinity;
  const d = new Date(raw);
  if(isNaN(d)) return Infinity;
  return (Date.now() - d.getTime()) / 86400000;
}

function renderLastBackupStatus(){
  const el = document.getElementById("lastBackupStatus");
  if(!el) return;
  const raw = localStorage.getItem(LAST_BACKUP_KEY);
  const days = daysSinceLastBackup();
  if(!raw){
    el.textContent = "⚠️ 还没有导出过备份 — 万一这台设备坏了,数据会全部遗失";
    el.style.color = "var(--danger)";
  }else if(days >= BACKUP_REMIND_DAYS){
    el.textContent = `⚠️ 上次备份是 ${new Date(raw).toLocaleDateString("en-MY")},已经 ${Math.floor(days)} 天没备份了`;
    el.style.color = "var(--danger)";
  }else{
    el.textContent = `上次备份: ${new Date(raw).toLocaleString("en-MY")}`;
    el.style.color = "var(--text-mute)";
  }
}

function maybeShowBackupReminder(){
  if(daysSinceLastBackup() >= BACKUP_REMIND_DAYS){
    alertToast("已经好几天没备份了,建议去设置导出一次");
  }
}

// ---------- Cloud sync (Firebase Firestore) ----------
// Optional: only syncs the editable/shared subset of state (menu + settings, including
// promotions) across devices. Sales history, held orders, and the order-number counter stay
// local per device on purpose (they're not meant to be merged across two tills). Uses an
// unguessable shop-ID document path instead of real auth — acceptable tradeoff for a single
// low-value-target shop, not a multi-tenant SaaS.
const CLOUD_KEY = "sk_pos_cloud_v1";
let cloudDb = null;
let cloudUnsub = null;
let cloudPushTimer = null;
let applyingRemoteCloudState = false;
let cloudLastError = null;
let cloudPushInFlight = false;

function loadCloudConfig(){
  try{ return JSON.parse(localStorage.getItem(CLOUD_KEY)) || null; }
  catch(e){ return null; }
}
function saveCloudConfig(cfg){ localStorage.setItem(CLOUD_KEY, JSON.stringify(cfg)); }
function clearCloudConfig(){ localStorage.removeItem(CLOUD_KEY); }

function genShopId(){
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for(let i=0;i<16;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

// Only the fields that are meant to be shared across devices — not orders/held/seq. The PIN is
// deliberately left out: this Firestore doc's only access control is knowing the shop ID, so
// syncing the till-unlock PIN into it would leak the PIN to anyone who obtains that ID. The PIN
// stays per-device instead — each till keeps whatever PIN was set on it locally.
function cloudSyncableSnapshot(){
  const settings = Object.assign({}, state.settings);
  delete settings.pin;
  return {
    settings: settings,
    menu: state.menu,
    lastModified: state.lastModified
  };
}

function cloudDocRef(shopId){
  return cloudDb.collection("posShops").doc(shopId);
}

function renderCloudSyncStatus(){
  const statusEl = document.getElementById("cloudSyncStatus");
  const connectBtn = document.getElementById("btnCloudConnect");
  const disconnectBtn = document.getElementById("btnCloudDisconnect");
  if(!statusEl) return;
  const cfg = loadCloudConfig();
  if(cfg && cfg.enabled){
    document.getElementById("cloudConfigInput").value = cfg.configText || "";
    document.getElementById("cloudShopIdInput").value = cfg.shopId || "";
    connectBtn.classList.add("hidden");
    disconnectBtn.classList.remove("hidden");
    if(cloudLastError){
      statusEl.textContent = `⚠️ 连接失败: ${cloudLastError} — 请检查配置、店铺代号和 Firestore 规则`;
      statusEl.style.color = "var(--danger)";
    }else if(!cloudDb){
      statusEl.textContent = "⚠️ 未连接 (刷新页面后会自动重连)";
      statusEl.style.color = "var(--danger)";
    }else{
      const last = cfg.lastSyncedAt ? new Date(cfg.lastSyncedAt).toLocaleString("en-MY") : "尚未同步";
      statusEl.textContent = `✅ 已连接 — 店铺代号: ${cfg.shopId} — 上次同步: ${last}`;
      statusEl.style.color = "var(--text-mute)";
    }
  }else{
    connectBtn.classList.remove("hidden");
    disconnectBtn.classList.add("hidden");
    statusEl.textContent = "尚未连接";
    statusEl.style.color = "var(--text-mute)";
  }
}

function connectCloudSync(configObj, shopId, isReconnect){
  if(typeof firebase === "undefined"){
    alertToast("云端功能加载失败,请检查网络后重新整理页面");
    return;
  }
  cloudLastError = null;
  try{
    // Reusing an existing app with a different config (e.g. user pasted a new project after a
    // previous connect, without reloading the page) would silently keep talking to the old
    // project — delete any existing app first so initializeApp always picks up the latest config.
    if(firebase.apps && firebase.apps.length){
      firebase.apps.slice().forEach(a=>{ try{ a.delete(); }catch(e){} });
    }
    const app = firebase.initializeApp(configObj);
    cloudDb = firebase.firestore(app);
  }catch(e){
    alertToast("Firebase 配置有误,请检查后重新贴上");
    return;
  }

  if(cloudUnsub){ cloudUnsub(); cloudUnsub = null; }
  cloudUnsub = cloudDocRef(shopId).onSnapshot(snap=>{
    // "lastSyncedAt" means "last time we successfully heard from Firestore", not "last time
    // data actually changed" — otherwise two devices that already agree (e.g. right after the
    // first connect, before either has edited anything) would show "尚未同步" forever even
    // though the live connection is healthy, which reads as broken to a non-technical user.
    cloudLastError = null;
    const cfg = loadCloudConfig();
    if(cfg){ cfg.lastSyncedAt = new Date().toISOString(); saveCloudConfig(cfg); }

    if(snap.metadata.hasPendingWrites){
      // Our own optimistic write echoing back before Firestore has confirmed it server-side —
      // not new data from another device, so there's nothing to apply here.
      renderCloudSyncStatus();
      return;
    }

    if(!snap.exists){
      pushCloudState();
      renderCloudSyncStatus();
      return;
    }

    if(cloudPushTimer || cloudPushInFlight){
      // This device has a local edit that hasn't reached the server yet (still debouncing or
      // mid-request). Deliberately not comparing timestamps to decide who "wins" here — cheap
      // tablets often have inaccurate clocks with no reliable time sync, which made an earlier
      // version of this check silently ignore genuinely newer updates. Instead: whichever edit
      // reaches the server last wins, and we simply skip applying incoming data while our own
      // change is still in flight so it can't be clobbered before it's even sent.
      renderCloudSyncStatus();
      return;
    }

    const remote = snap.data();
    if(!remote){ renderCloudSyncStatus(); return; }

    applyingRemoteCloudState = true;
    state.settings = Object.assign({}, state.settings, remote.settings||{});
    if(Array.isArray(remote.menu)) state.menu = remote.menu;
    if(remote.lastModified) state.lastModified = remote.lastModified;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    applyingRemoteCloudState = false;

    document.getElementById("shopName").textContent = state.settings.shopName;
    renderCategoryTabs();
    renderItemGrid();
    renderCart();
    if(!document.getElementById("settingsModal").classList.contains("hidden")) populateSettingsForm();
    renderCloudSyncStatus();
    if(!isReconnect) alertToast("已从云端同步最新数据");
  }, err=>{
    cloudLastError = (err && err.message) ? err.message : "未知错误";
    renderCloudSyncStatus();
  });

  if(!isReconnect) alertToast("云端同步已连接");
}

function startCloudSync(){
  const configText = document.getElementById("cloudConfigInput").value.trim();
  const shopId = document.getElementById("cloudShopIdInput").value.trim();
  if(!configText || !shopId){
    alertToast("请先贴上 Firebase 配置并填写店铺代号");
    return;
  }
  let configObj;
  try{ configObj = JSON.parse(configText); }
  catch(e){ alertToast("Firebase 配置格式不对,请确认整段 JSON 都贴上了"); return; }

  saveCloudConfig({ enabled:true, configText, shopId, lastSyncedAt:"" });
  connectCloudSync(configObj, shopId, false);
  renderCloudSyncStatus();
}

function stopCloudSync(){
  if(!confirm("确定断开云端同步?本机数据不会被删除。")) return;
  if(cloudUnsub){ cloudUnsub(); cloudUnsub = null; }
  if(typeof firebase !== "undefined" && firebase.apps && firebase.apps.length){
    firebase.apps.slice().forEach(a=>{ try{ a.delete(); }catch(e){} });
  }
  cloudDb = null;
  cloudLastError = null;
  if(cloudPushTimer){ clearTimeout(cloudPushTimer); cloudPushTimer = null; }
  if(cloudRetryTimer){ clearTimeout(cloudRetryTimer); cloudRetryTimer = null; }
  cloudPushInFlight = false;
  clearCloudConfig();
  renderCloudSyncStatus();
  alertToast("云端同步已断开");
}

let cloudRetryTimer = null;

function scheduleCloudPush(){
  const cfg = loadCloudConfig();
  if(!cfg || !cfg.enabled) return;
  if(cloudRetryTimer){ clearTimeout(cloudRetryTimer); cloudRetryTimer = null; }
  if(cloudPushTimer) clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(pushCloudState, 1200);
}

function pushCloudState(){
  cloudPushTimer = null;
  if(cloudRetryTimer){ clearTimeout(cloudRetryTimer); cloudRetryTimer = null; }
  const cfg = loadCloudConfig();
  if(!cfg || !cfg.enabled) return;
  if(!cloudDb){
    // Firestore isn't ready yet (still connecting) — try again shortly instead of dropping
    // this edit silently until some unrelated later save happens to reschedule it.
    cloudRetryTimer = setTimeout(pushCloudState, 5000);
    return;
  }
  cloudPushInFlight = true;
  cloudDocRef(cfg.shopId).set(cloudSyncableSnapshot(), {merge:true}).then(()=>{
    cloudPushInFlight = false;
    cloudLastError = null;
    // Re-read the config rather than reuse the `cfg` captured before this async write started —
    // if the user disconnected while the write was in flight, this must not resurrect it.
    const freshCfg = loadCloudConfig();
    if(freshCfg && freshCfg.enabled){
      freshCfg.lastSyncedAt = new Date().toISOString();
      saveCloudConfig(freshCfg);
    }
    renderCloudSyncStatus();
  }).catch(err=>{
    cloudPushInFlight = false;
    cloudLastError = (err && err.message) ? err.message : "推送失败";
    renderCloudSyncStatus();
    // Transient network failures shouldn't strand an edit client-side forever.
    cloudRetryTimer = setTimeout(pushCloudState, 15000);
  });
}

function initCloudSyncOnLoad(){
  const cfg = loadCloudConfig();
  if(!cfg || !cfg.enabled) return;
  let configObj;
  try{ configObj = JSON.parse(cfg.configText); }
  catch(e){ return; }
  connectCloudSync(configObj, cfg.shopId, true);
}

function exportBackup(){
  const payload = { exportedAt: new Date().toISOString(), state, history, heldOrders };
  downloadBlob(JSON.stringify(payload, null, 2), `soos-kitchen-pos-backup-${todayStr()}.json`, "application/json");
  markBackedUp();
  alertToast("备份已导出");
}

// Fills the same textarea the paste-import reads from, with the current backup as text — for
// kiosk/lockdown browsers where file downloads may also be restricted. Uses select() rather than
// the Clipboard API since that can be blocked too; the operator selects-all and copies manually.
function exportBackupAsText(){
  const payload = { exportedAt: new Date().toISOString(), state, history, heldOrders };
  const area = document.getElementById("importPasteArea");
  area.value = JSON.stringify(payload);
  area.focus();
  area.select();
  markBackedUp();
  alertToast("备份文字已生成,长按全选复制");
}

// ---------- Sales report export (date-range CSV) ----------
function dateInputStr(d){
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function startOfWeekStr(){
  const d = new Date();
  const dow = (d.getDay()+6)%7; // Mon=0..Sun=6
  d.setDate(d.getDate()-dow);
  return dateInputStr(d);
}
function startOfMonthStr(){
  const d = new Date();
  return dateInputStr(new Date(d.getFullYear(), d.getMonth(), 1));
}
function earliestHistoryDateStr(){
  if(history.length===0) return todayStr();
  return history.reduce((min,o)=> o.date<min ? o.date : min, history[0].date);
}

function setCsvRange(range){
  const startInput = document.getElementById("csvStartDate");
  const endInput = document.getElementById("csvEndDate");
  const today = todayStr();
  if(range==="today"){ startInput.value = today; endInput.value = today; }
  else if(range==="week"){ startInput.value = startOfWeekStr(); endInput.value = today; }
  else if(range==="month"){ startInput.value = startOfMonthStr(); endInput.value = today; }
  else if(range==="all"){ startInput.value = earliestHistoryDateStr(); endInput.value = today; }
}

function exportHistoryCsv(){
  const start = document.getElementById("csvStartDate").value || earliestHistoryDateStr();
  const end = document.getElementById("csvEndDate").value || todayStr();
  const filtered = history.filter(o=> o.date>=start && o.date<=end);
  if(filtered.length===0){ alertToast("这段范围内没有订单记录"); return; }
  const rows = [["订单号","日期","时间","付款方式","小计","折扣","服务税","现金四舍五入","总计","是否分单","是否作废"]];
  filtered.forEach(o=> rows.push([
    o.orderNo, o.date, o.time, o.paymentMethod==="cash"?"现金":"电子钱包",
    o.subtotal, o.discount||0, o.tax||0, o.roundingAdj||0, o.total,
    o.isSplit?"是":"否", o.voided?"是":"否"
  ]));
  const validRows = filtered.filter(o=>!o.voided);
  rows.push([]);
  rows.push(["合计 (不含已作废)","","","", "", "", "", "", validRows.reduce((s,o)=>s+o.total,0).toFixed(2), "", ""]);
  const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\r\n");
  downloadBlob("﻿"+csv, `sales-${start}_to_${end}.csv`, "text/csv;charset=utf-8");
  alertToast("销售记录已导出");
}

// Shared by both import paths (native file picker and the paste-text fallback below). Kiosk/
// lockdown browsers (e.g. Fully Kiosk Browser) often disable the native file chooser entirely as
// part of their lockdown, so <input type="file"> alone isn't a reliable import path on this app's
// actual target hardware — the paste-text route works anywhere a textarea does.
function applyBackupJson(jsonText){
  let payload;
  try{ payload = JSON.parse(jsonText); }
  catch(err){ alertToast("内容不是有效的备份格式,无法导入"); return; }
  if(!payload || !payload.state || !payload.state.menu){ alertToast("备份内容不完整,无法导入"); return; }
  const fmtTime = iso => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString("en-MY") : "未知时间"; };
  const incomingTime = fmtTime(payload.state.lastModified || payload.exportedAt);
  const localTime = fmtTime(state.lastModified);
  if(!confirm(`即将导入的备份最后修改于:\n${incomingTime}\n\n本机现有数据最后修改于:\n${localTime}\n\n导入会完全覆盖本机的菜单、设置与销售记录,确定要继续吗？`)) return;
  state = Object.assign(deepClone(DEFAULT_STATE), payload.state, {
    settings: Object.assign({}, DEFAULT_STATE.settings, payload.state.settings||{})
  });
  history = Array.isArray(payload.history) ? payload.history : [];
  heldOrders = Array.isArray(payload.heldOrders) ? payload.heldOrders : [];
  saveState(); saveHistory(); saveHeldOrders();
  activeCategory = state.menu[0] ? state.menu[0].id : null;
  document.getElementById("shopName").textContent = state.settings.shopName;
  renderCategoryTabs(); renderItemGrid(); renderCart(); renderHeldBadge(); renderTrashBadge();
  populateSettingsForm();
  alertToast("备份已还原");
}

function importBackup(file){
  const reader = new FileReader();
  reader.onload = (e)=> applyBackupJson(e.target.result);
  reader.readAsText(file);
}

function importBackupFromPaste(){
  const text = document.getElementById("importPasteArea").value.trim();
  if(!text){ alertToast("请先把备份文字贴进来"); return; }
  applyBackupJson(text);
  document.getElementById("importPasteArea").value = "";
}

// ---------- Bluetooth thermal printer ----------
const PRINTER_SERVICE_CANDIDATES = [
  "000018f0-0000-1000-8000-00805f9b34fb",
  "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  "0000ff00-0000-1000-8000-00805f9b34fb",
  "0000ffe0-0000-1000-8000-00805f9b34fb"
];
let btPrinterDevice = null;
let btPrinterChar = null;

function updatePrinterStatus(){
  const el = document.getElementById("printerStatus");
  if(!el) return;
  if(btPrinterChar){
    el.textContent = "已连接: " + (btPrinterDevice && btPrinterDevice.name ? btPrinterDevice.name : "蓝牙打印机");
  }else{
    el.textContent = "尚未连接打印机";
  }
}

async function connectBluetoothPrinter(){
  if(!navigator.bluetooth){
    alertToast("此浏览器不支持蓝牙打印,需要 Android 手机/平板上的 Chrome 浏览器");
    return;
  }
  try{
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: PRINTER_SERVICE_CANDIDATES
    });
    const server = await device.gatt.connect();
    let writableChar = null;

    for(const svcUuid of PRINTER_SERVICE_CANDIDATES){
      try{
        const service = await server.getPrimaryService(svcUuid);
        const chars = await service.getCharacteristics();
        writableChar = chars.find(c=>c.properties.write || c.properties.writeWithoutResponse);
        if(writableChar) break;
      }catch(e){ /* this service isn't on this device, try next candidate */ }
    }
    if(!writableChar){
      try{
        const services = await server.getPrimaryServices();
        for(const service of services){
          const chars = await service.getCharacteristics();
          writableChar = chars.find(c=>c.properties.write || c.properties.writeWithoutResponse);
          if(writableChar) break;
        }
      }catch(e){ /* some devices refuse to enumerate all services */ }
    }
    if(!writableChar) throw new Error("找不到可写入的蓝牙通道,此打印机可能不兼容 Web Bluetooth");

    btPrinterDevice = device;
    btPrinterChar = writableChar;
    device.addEventListener("gattserverdisconnected", ()=>{
      btPrinterChar = null;
      updatePrinterStatus();
      alertToast("打印机已断开连接");
    });
    updatePrinterStatus();
    alertToast("打印机已连接: " + (device.name||"未知设备"));
  }catch(err){
    if(err && err.name==="NotFoundError") return; // user cancelled the device picker
    alertToast("连接失败: " + (err && err.message ? err.message : err));
  }
}

async function sendBytesToPrinter(bytes){
  if(!btPrinterChar) throw new Error("打印机未连接");
  const CHUNK = 180;
  const noResponse = !!btPrinterChar.properties.writeWithoutResponse;
  for(let i=0;i<bytes.length;i+=CHUNK){
    const chunk = bytes.slice(i, i+CHUNK);
    if(noResponse){
      // writeValueWithoutResponse doesn't wait for the printer to actually consume the bytes,
      // so cheap printer clones with small buffers need a throttling delay here.
      await btPrinterChar.writeValueWithoutResponse(chunk);
      await new Promise(r=>setTimeout(r, 20));
    }else{
      // writeValue already awaits the printer's acknowledgment, so it provides its own
      // backpressure — no extra delay needed on top of that.
      await btPrinterChar.writeValue(chunk);
    }
  }
}

function paperWidthPx(){
  return state.settings.paperWidth==="80" ? 576 : 384;
}

// Renders lines of text to a canvas, then converts to an ESC/POS raster bit-image and sends it.
// Rendering as an image (rather than sending encoded text) avoids codepage/Chinese-character
// compatibility issues that vary across cheap thermal-printer clones.
function renderTicketCanvas(blocks){
  const width = paperWidthPx();
  const lineHeight = 30;
  const measureCanvas = document.createElement("canvas");
  const mctx = measureCanvas.getContext("2d");
  let totalHeight = 20;
  const wrapped = [];
  blocks.forEach(b=>{
    const size = b.size==="lg" ? 26 : b.size==="sm" ? 16 : 20;
    const weight = b.bold ? "700" : "400";
    mctx.font = `${weight} ${size}px "Microsoft YaHei","PingFang SC",sans-serif`;
    const maxW = width - 24;
    const words = (b.text||"").split("");
    let line = "";
    const linesForBlock = [];
    words.forEach(ch=>{
      const test = line + ch;
      if(mctx.measureText(test).width > maxW && line){
        linesForBlock.push(line);
        line = ch;
      }else{
        line = test;
      }
    });
    linesForBlock.push(line);
    linesForBlock.forEach(l=>{
      wrapped.push({ text:l, size, weight, align: b.align||"left" });
      totalHeight += size + 10;
    });
    if(b.spacingAfter) totalHeight += b.spacingAfter;
  });
  totalHeight += 30;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0,0,width,totalHeight);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";

  let y = 16;
  let bi = 0, consumed = 0;
  for(let i=0;i<wrapped.length;i++){
    const w = wrapped[i];
    ctx.font = `${w.weight} ${w.size}px "Microsoft YaHei","PingFang SC",sans-serif`;
    const tw = ctx.measureText(w.text).width;
    let x = 12;
    if(w.align==="center") x = Math.max(12, (width-tw)/2);
    else if(w.align==="right") x = Math.max(12, width-tw-12);
    ctx.fillText(w.text, x, y);
    y += w.size + 10;
  }
  return canvas;
}

function canvasToEscPosRaster(canvas){
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const img = ctx.getImageData(0,0,width,height).data;
  const bytesPerRow = Math.ceil(width/8);
  const raster = new Uint8Array(bytesPerRow*height);
  for(let y=0;y<height;y++){
    for(let x=0;x<width;x++){
      const idx = (y*width+x)*4;
      const lum = 0.299*img[idx] + 0.587*img[idx+1] + 0.114*img[idx+2];
      const isBlack = lum < 180;
      if(isBlack){
        raster[y*bytesPerRow + (x>>3)] |= (0x80 >> (x%8));
      }
    }
  }
  const header = new Uint8Array([
    0x1D,0x76,0x30,0x00,
    bytesPerRow & 0xFF, (bytesPerRow>>8) & 0xFF,
    height & 0xFF, (height>>8) & 0xFF
  ]);
  const out = new Uint8Array(header.length + raster.length);
  out.set(header,0);
  out.set(raster, header.length);
  return out;
}

const ESC_INIT = new Uint8Array([0x1B,0x40]);
const ESC_FEED_CUT = new Uint8Array([0x0A,0x0A,0x0A,0x0A,0x1D,0x56,0x00]);

async function printBlocks(blocks){
  if(!btPrinterChar){
    alertToast("请先在设置里连接蓝牙打印机");
    return false;
  }
  try{
    const canvas = renderTicketCanvas(blocks);
    const raster = canvasToEscPosRaster(canvas);
    const payload = new Uint8Array(ESC_INIT.length + raster.length + ESC_FEED_CUT.length);
    payload.set(ESC_INIT,0);
    payload.set(raster, ESC_INIT.length);
    payload.set(ESC_FEED_CUT, ESC_INIT.length+raster.length);
    await sendBytesToPrinter(payload);
    return true;
  }catch(err){
    alertToast("打印失败: " + (err && err.message ? err.message : err));
    return false;
  }
}

function testPrint(){
  printBlocks([
    { text: state.settings.shopName, size:"lg", bold:true, align:"center" },
    { text: "打印测试页", align:"center", spacingAfter:10 },
    { text: new Date().toLocaleString("en-MY"), size:"sm", align:"center", spacingAfter:10 },
    { text: "如果这张纸能正常打印出来,", align:"left" },
    { text: "说明打印机已经连接成功。", align:"left" }
  ]);
}

function receiptToPrintBlocks(order){
  const blocks = [];
  blocks.push({ text: state.settings.shopName, size:"lg", bold:true, align:"center" });
  blocks.push({ text: `订单 ${order.orderNo}`, bold:true, align:"center" });
  blocks.push({ text: `${order.date} ${order.time}`, size:"sm", align:"center", spacingAfter:10 });
  order.items.forEach(it=>{
    blocks.push({ text: `${it.name} x${it.qty}${it.note?" ("+it.note+")":""}` });
    blocks.push({ text: `  ${fmt(it.price*it.qty)}`, align:"right" });
    if(it.comboContents && it.comboContents.length){
      blocks.push({ text: `  含: ${comboContentsLabel(it.comboContents, it.qty)}`, size:"sm" });
    }
  });
  blocks.push({ text: "--------------------------------", spacingAfter:4 });
  blocks.push({ text: `小计  ${fmt(order.subtotal)}`, align:"right" });
  if(order.discount>0) blocks.push({ text: `折扣${order.discountName?" ("+order.discountName+")":""}  -${fmt(order.discount)}`, align:"right" });
  if(order.tax>0) blocks.push({ text: `服务税  ${fmt(order.tax)}`, align:"right" });
  if(order.roundingAdj) blocks.push({ text: `四舍五入  ${order.roundingAdj>0?"+":"-"}${fmt(Math.abs(order.roundingAdj))}`, align:"right" });
  blocks.push({ text: `总计  ${fmt(order.total)}`, bold:true, size:"lg", align:"right", spacingAfter:6 });
  blocks.push({ text: `付款方式: ${order.paymentMethod==="cash"?"现金":"DuitNow/电子钱包"}` });
  if(order.paymentMethod==="cash"){
    blocks.push({ text: `实收 ${fmt(order.cashReceived)}  找零 ${fmt(order.change)}` });
  }
  blocks.push({ text: "谢谢光临 ， THANK YOU .", align:"center", spacingAfter:6 });
  return blocks;
}

function kitchenTicketToPrintBlocks(order){
  const blocks = [];
  blocks.push({ text: `订单 ${order.orderNo}`, size:"lg", bold:true, align:"center" });
  blocks.push({ text: `${order.time}`, size:"sm", align:"center", spacingAfter:10 });
  order.items.forEach(it=>{
    blocks.push({ text: `${it.name}  x${it.qty}`, size:"lg", bold:true });
    if(it.note) blocks.push({ text: `>> ${it.note}`, bold:true });
    if(it.comboContents && it.comboContents.length){
      it.comboContents.forEach(c=>{
        blocks.push({ text: `  - ${c.name} x${c.qty*it.qty}` });
      });
    }
  });
  blocks.push({ text: "" , spacingAfter:6});
  return blocks;
}

function printReceiptBT(order){ return printBlocks(receiptToPrintBlocks(order)); }
function printKitchenTicketBT(order){ return printBlocks(kitchenTicketToPrintBlocks(order)); }

function resizeImageFile(file, maxSize, quality, callback){
  const reader = new FileReader();
  reader.onload = (e)=>{
    const img = new Image();
    img.onload = ()=>{
      let w = img.width, h = img.height;
      const scale = Math.min(1, maxSize/Math.max(w,h));
      w = Math.round(w*scale); h = Math.round(h*scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL("image/jpeg", quality));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ---------- Menu editor ----------
function uid(){ return "id" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

// ---------- Recently-deleted trash / undo ----------
// Menu items, categories, combos, and promotions all go through this before being permanently
// gone, so a mis-tapped delete button (dense rows, small icons, no PIN re-check per action) is
// always recoverable rather than a silent, permanent loss.
const TRASH_LABELS = { item:"菜品", category:"分类", combo:"套餐", promo:"优惠" };

function pushToTrash(type, data, meta){
  if(!state.recentlyDeleted) state.recentlyDeleted = [];
  state.recentlyDeleted.unshift({ id: uid(), type, data, meta: meta||{}, deletedAt: new Date().toISOString() });
  if(state.recentlyDeleted.length > 30) state.recentlyDeleted = state.recentlyDeleted.slice(0,30);
  renderTrashBadge();
}

function renderTrashBadge(){
  const badge = document.getElementById("trashCountBadge");
  if(!badge) return;
  const n = (state.recentlyDeleted||[]).length;
  badge.textContent = n;
  badge.classList.toggle("hidden", n===0);
}

function openTrashModal(){
  // btnShowTrash lives in the settingsModal header, outside the pinGate/settingsBody split, so it
  // was reachable (and could restore any deleted item/category/combo/promo) without ever entering
  // the settings PIN. Gate it explicitly rather than relying on modal position.
  requestPinConfirm("需要管理密码才能查看最近删除", ()=>{
    renderTrashList();
    showModal("trashModal");
  });
}

function renderTrashList(){
  const list = document.getElementById("trashList");
  const entries = state.recentlyDeleted||[];
  if(entries.length===0){
    list.innerHTML = `<div class="cart-empty">最近没有删除任何东西</div>`;
    return;
  }
  list.innerHTML = "";
  entries.forEach(entry=>{
    const row = document.createElement("div");
    row.className = "trash-row";
    const when = new Date(entry.deletedAt).toLocaleString("en-MY");
    row.innerHTML = `
      <div>
        <div class="tr-name">${escapeHtml(entry.data.name||"")} <span class="combo-tag">${TRASH_LABELS[entry.type]||entry.type}</span></div>
        <div class="tr-when">删除于 ${when}</div>
      </div>
      <button data-act="restore">恢复</button>
    `;
    row.querySelector('[data-act="restore"]').onclick = ()=> restoreFromTrash(entry.id);
    list.appendChild(row);
  });
}

function restoreFromTrash(trashId){
  const entry = (state.recentlyDeleted||[]).find(e=>e.id===trashId);
  if(!entry) return;
  let landedInCatName = null;
  if(entry.type==="item" || entry.type==="combo"){
    let cat = state.menu.find(c=>c.id===entry.meta.catId);
    if(!cat){ cat = state.menu[0]; landedInCatName = cat && cat.name; }
    if(!cat){ alertToast("没有可用的分类,请先新增一个分类再恢复"); return; }
    cat.items.push(entry.data);
  }else if(entry.type==="category"){
    state.menu.push(entry.data);
  }else if(entry.type==="promo"){
    if(!state.settings.promotions) state.settings.promotions = [];
    state.settings.promotions.push(entry.data);
  }
  state.recentlyDeleted = state.recentlyDeleted.filter(e=>e.id!==trashId);
  saveState();
  renderMenuEditor();
  renderComboListEditor();
  renderPromoEditor();
  renderCategoryTabs();
  renderItemGridIfNeeded();
  renderTrashList();
  renderTrashBadge();
  if(landedInCatName){
    alertToast(`已恢复: ${entry.data.name||""}(原分类已不存在,放入了「${landedInCatName}」)`);
  }else{
    alertToast("已恢复: " + (entry.data.name||""));
  }
}

// Swaps item with its visual neighbor (skipping over combos, which aren't shown in this list)
// among the *actual* cat.items array positions, so ordering here also reorders the customer-facing grid.
function moveMenuItem(cat, item, direction){
  const visibleItems = cat.items.filter(i=>!isCombo(i));
  const visIdx = visibleItems.findIndex(i=>i.id===item.id);
  const swapWith = visibleItems[visIdx+direction];
  if(!swapWith) return;
  const realIdxA = cat.items.findIndex(i=>i.id===item.id);
  const realIdxB = cat.items.findIndex(i=>i.id===swapWith.id);
  const tmp = cat.items[realIdxA];
  cat.items[realIdxA] = cat.items[realIdxB];
  cat.items[realIdxB] = tmp;
  saveState();
  renderMenuEditor();
  renderItemGridIfNeeded();
}

// Drag-to-reorder via Pointer Events (not native HTML5 drag/drop, which Android Chrome doesn't
// fire from touch) — the row follows the finger/pointer visually, and on release we work out how
// many row-heights it moved and reorder from there, rather than doing a live per-frame DOM swap
// (simpler and more robust on the low-end/older tablets this app also has to run on).
let dragCtx = null;

function cleanupDragVisual(){
  if(!dragCtx) return;
  dragCtx.row.style.transform = "";
  dragCtx.row.classList.remove("dragging-row");
}

function finalizeDrag(){
  if(!dragCtx) return;
  const { cat, item, origIndex, rowHeight, count, startY, lastY } = dragCtx;
  cleanupDragVisual();
  const shift = Math.round((lastY-startY) / rowHeight);
  const targetIdx = Math.max(0, Math.min(count-1, origIndex+shift));
  dragCtx = null;
  if(targetIdx !== origIndex) reorderMenuItem(cat, item, targetIdx);
}

// Finalizing on document (matched by pointerId) rather than only on the row's own handle means a
// drag still ends cleanly even if the handle-specific pointerup/pointercancel never fires — e.g.
// setPointerCapture failing on an older Android build, or the finger lifting off after sliding
// past the handle. Without this, a failed capture could leave a row permanently stuck mid-drag.
document.addEventListener("pointerup", (e)=>{ if(dragCtx && e.pointerId===dragCtx.pointerId) finalizeDrag(); });
document.addEventListener("pointercancel", (e)=>{ if(dragCtx && e.pointerId===dragCtx.pointerId) finalizeDrag(); });

function attachDragHandle(handle, row, cat, item){
  handle.style.touchAction = "none";
  handle.addEventListener("pointerdown", (e)=>{
    e.preventDefault();
    // A previous drag could still be "active" here if its own pointerup/pointercancel never
    // fired (the exact failure mode the document-level fallback above exists for, but belt and
    // braces) — clear it before starting a new one so nothing is ever left permanently stuck.
    if(dragCtx) cleanupDragVisual();
    const listEl = row.parentElement;
    const rows = Array.from(listEl.children);
    dragCtx = {
      cat, item, row,
      pointerId: e.pointerId,
      startY: e.clientY,
      lastY: e.clientY,
      origIndex: rows.indexOf(row),
      rowHeight: row.getBoundingClientRect().height || 60,
      count: rows.length
    };
    row.classList.add("dragging-row");
    try{ handle.setPointerCapture(e.pointerId); }catch(err){ /* fine without it: the document-level fallback still finalizes on pointerup */ }
  });
  handle.addEventListener("pointermove", (e)=>{
    if(!dragCtx || dragCtx.row!==row || e.pointerId!==dragCtx.pointerId) return;
    dragCtx.lastY = e.clientY;
    row.style.transform = `translateY(${e.clientY - dragCtx.startY}px)`;
  });
}

// Moves `item` to `targetVisIdx` among its category's non-combo items, keeping any combo items
// in their original slots (rebuilt by walking cat.items and refilling each non-combo slot from
// the newly-ordered visible-items queue) so dragging dishes doesn't scramble combo positions.
function reorderMenuItem(cat, item, targetVisIdx){
  const visibleItems = cat.items.filter(i=>!isCombo(i));
  const fromIdx = visibleItems.findIndex(i=>i.id===item.id);
  if(fromIdx<0 || fromIdx===targetVisIdx) return;
  visibleItems.splice(fromIdx,1);
  visibleItems.splice(targetVisIdx,0,item);
  let vi = 0;
  cat.items = cat.items.map(i=> isCombo(i) ? i : visibleItems[vi++]);
  saveState();
  renderMenuEditor();
  renderItemGridIfNeeded();
}

function renderMenuEditor(){
  const container = document.getElementById("categoryEditorList");
  container.innerHTML = "";
  state.menu.forEach(cat=>{
    const box = document.createElement("div");
    box.className = "cat-editor";
    box.innerHTML = `
      <div class="cat-editor-head">
        <input type="text" value="${escapeHtml(cat.name)}" data-cat="${cat.id}" class="cat-name-input">
        <button data-act="delcat" data-cat="${cat.id}">🗑</button>
      </div>
      <div class="item-editor-list" data-list="${cat.id}"></div>
      <button class="add-item-btn" data-act="additem" data-cat="${cat.id}">+ 新增菜品</button>
    `;
    container.appendChild(box);

    const list = box.querySelector(`[data-list="${cat.id}"]`);
    const visibleItems = cat.items.filter(item=>!isCombo(item));
    visibleItems.forEach((item, visIdx)=>{
      const row = document.createElement("div");
      row.className = "item-editor-row";
      const photoInner = item.image ? `<img src="${item.image}" alt="">` : `<span>📷</span>`;
      row.innerHTML = `
        <div class="ie-drag-handle" title="按住拖拉排序">⠿</div>
        <div class="ie-photo">${photoInner}</div>
        <input type="file" accept="image/*" class="ie-photo-input hidden">
        <div class="ie-fields">
          <div class="ie-line1">
            <input type="text" value="${escapeHtml(item.name)}" placeholder="菜品名称">
            <button data-act="moveup" title="上移" ${visIdx===0?"disabled":""}>▲</button>
            <button data-act="movedown" title="下移" ${visIdx===visibleItems.length-1?"disabled":""}>▼</button>
            <button data-act="delitem">🗑</button>
          </div>
          <div class="ie-line2">
            <button class="avail-toggle" title="上架/售罄">${item.available===false?"🚫":"✅"}</button>
            <input type="number" step="0.10" min="0" value="${item.price}" placeholder="价格">
          </div>
        </div>
      `;
      const photoBtn = row.querySelector(".ie-photo");
      const photoInput = row.querySelector(".ie-photo-input");
      const nameInput = row.querySelector('input[type="text"]');
      const priceInput = row.querySelector('input[type="number"]');
      const availBtn = row.querySelector(".avail-toggle");
      const delBtn = row.querySelector('[data-act="delitem"]');
      const upBtn = row.querySelector('[data-act="moveup"]');
      const downBtn = row.querySelector('[data-act="movedown"]');
      upBtn.onclick = ()=> moveMenuItem(cat, item, -1);
      downBtn.onclick = ()=> moveMenuItem(cat, item, 1);
      attachDragHandle(row.querySelector(".ie-drag-handle"), row, cat, item);

      photoBtn.onclick = ()=> photoInput.click();
      photoInput.onchange = (e)=>{
        const file = e.target.files[0];
        if(!file) return;
        resizeImageFile(file, 400, 0.75, dataUrl=>{
          item.image = dataUrl;
          saveState(); renderMenuEditor(); renderItemGridIfNeeded();
        });
      };
      availBtn.onclick = ()=>{
        item.available = item.available===false ? true : false;
        saveState(); renderMenuEditor(); renderItemGridIfNeeded();
      };
      nameInput.onchange = ()=>{ item.name = nameInput.value.trim()||item.name; saveState(); renderComboListEditor(); renderItemGridIfNeeded(); };
      priceInput.onchange = ()=>{ item.price = Math.max(0, parseFloat(priceInput.value)||0); priceInput.value = item.price; saveState(); renderItemGridIfNeeded(); };
      delBtn.onclick = ()=>{
        const usedInCombos = findCombosUsingItem(item.id);
        const comboWarning = usedInCombos.length
          ? `\n\n注意:这道菜是「${usedInCombos.join("、")}」套餐的内容之一,删除后套餐里会少这一样。`
          : "";
        if(!confirm(`确定删除「${item.name}」?${comboWarning}`)) return;
        cat.items = cat.items.filter(i=>i.id!==item.id);
        pushToTrash("item", item, { catId: cat.id });
        saveState(); renderMenuEditor(); renderComboListEditor(); renderItemGridIfNeeded();
      };
      list.appendChild(row);
    });

    box.querySelector('[data-act="delcat"]').onclick = ()=>{
      if(!confirm(`确定删除分类「${cat.name}」及其所有菜品?`)) return;
      state.menu = state.menu.filter(c=>c.id!==cat.id);
      pushToTrash("category", cat, {});
      if(activeCategory===cat.id){ activeCategory = state.menu[0]?state.menu[0].id:null; }
      saveState(); renderMenuEditor(); renderComboListEditor(); renderCategoryTabs(); renderItemGrid();
    };
    box.querySelector('[data-act="additem"]').onclick = ()=>{
      cat.items.push({ id:uid(), name:"新菜品", price:0, available:true, image:"" });
      saveState(); renderMenuEditor(); renderItemGridIfNeeded();
    };
    box.querySelector(".cat-name-input").onchange = (e)=>{
      cat.name = e.target.value.trim() || cat.name;
      saveState(); renderMenuEditor(); renderCategoryTabs();
    };
  });
}

// ---------- Combo (set meal) management ----------
// Combos are managed on their own dedicated 套餐管理 settings page, separate from regular menu
// items — this holds the item being edited (null while creating a new combo) and its original
// category id (so we can move it if the category dropdown changes, or remove it on delete).
let comboEditItem = null;
let comboEditOrigCatId = null;
let comboEditDraft = {}; // itemId -> qty

function allCombos(){
  const out = [];
  state.menu.forEach(cat=>{
    cat.items.forEach(item=>{ if(isCombo(item)) out.push({item, cat}); });
  });
  return out;
}

function renderComboListEditor(){
  const list = document.getElementById("comboListEditor");
  const combos = allCombos();
  if(combos.length===0){
    list.innerHTML = `<div class="cart-empty">还没有套餐,点上面「+ 新增套餐」建立第一个</div>`;
    return;
  }
  list.innerHTML = "";
  combos.forEach(({item, cat})=>{
    const contents = resolveComboContents(item);
    const row = document.createElement("div");
    row.className = "combo-list-row";
    row.innerHTML = `
      <div>
        <div class="cl-name">${escapeHtml(item.name)} <span class="combo-tag">${escapeHtml(cat.name)}</span></div>
        <div class="cl-detail">含: ${contents.map(c=>escapeHtml(c.name)+(c.qty>1?"x"+c.qty:"")).join("、")||"(尚未选内容)"}</div>
      </div>
      <div class="cl-price">${fmt(item.price)}</div>
      <button data-act="editcombo">编辑</button>
    `;
    row.querySelector('[data-act="editcombo"]').onclick = ()=> openComboEditModal(item, cat.id);
    list.appendChild(row);
  });
}

function populateComboCategorySelect(selectedCatId){
  const sel = document.getElementById("comboCategorySelect");
  sel.innerHTML = state.menu.map(cat=>`<option value="${cat.id}">${escapeHtml(cat.name)}</option>`).join("");
  sel.value = selectedCatId || (state.menu[0] ? state.menu[0].id : "");
}

function openComboEditModal(item, catId){
  if(state.menu.length===0){
    alertToast("请先在「菜单管理」新增至少一个分类");
    return;
  }
  comboEditItem = item || null;
  comboEditOrigCatId = catId || null;
  comboEditDraft = {};
  (item && item.comboItems || []).forEach(ci=>{ comboEditDraft[ci.itemId] = ci.qty; });
  document.getElementById("comboEditTitle").textContent = item ? "编辑套餐" : "新增套餐";
  document.getElementById("comboNameInput").value = item ? item.name : "";
  document.getElementById("comboPriceInput").value = item ? item.price : "";
  populateComboCategorySelect(catId);
  document.getElementById("btnDeleteCombo").classList.toggle("hidden", !item);
  document.getElementById("btnUncombo").classList.toggle("hidden", !item);
  renderComboEditList();
  showModal("comboEditModal");
}

// Reverts an existing combo back into a plain single-priced menu item — keeps the item (name,
// price, photo) but clears comboItems, unlike deleteCombo() which removes it entirely.
function uncombo(){
  if(!comboEditItem) return;
  if(!confirm(`确定把「${comboEditItem.name}」变回单点菜品?套餐组合内容会被清空,但这道菜本身会保留,价格不变。`)) return;
  comboEditItem.comboItems = [];
  saveState();
  renderComboListEditor();
  renderMenuEditor();
  renderItemGridIfNeeded();
  hideModal("comboEditModal");
  alertToast("已变回单点菜品");
}

function renderComboEditList(){
  const list = document.getElementById("comboEditList");
  list.innerHTML = "";
  const selfId = comboEditItem ? comboEditItem.id : null;
  state.menu.forEach(cat=>{
    const eligible = cat.items.filter(i=>i.id!==selfId && !isCombo(i));
    if(eligible.length===0) return;
    const label = document.createElement("div");
    label.className = "combo-cat-label";
    label.textContent = cat.name;
    list.appendChild(label);
    eligible.forEach(i=>{
      const qty = comboEditDraft[i.id] || 0;
      const row = document.createElement("div");
      row.className = "combo-item-row";
      row.innerHTML = `
        <div>
          <div class="ci-label">${escapeHtml(i.name)}</div>
          <div class="ci-price">${fmt(i.price)}</div>
        </div>
        <div class="combo-qty-stepper">
          <button data-act="minus">−</button>
          <span>${qty}</span>
          <button data-act="plus">+</button>
        </div>
      `;
      row.querySelector('[data-act="minus"]').onclick = ()=>{
        comboEditDraft[i.id] = Math.max(0, (comboEditDraft[i.id]||0)-1);
        renderComboEditList();
      };
      row.querySelector('[data-act="plus"]').onclick = ()=>{
        comboEditDraft[i.id] = (comboEditDraft[i.id]||0)+1;
        renderComboEditList();
      };
      list.appendChild(row);
    });
  });
}

function saveCombo(){
  const name = document.getElementById("comboNameInput").value.trim();
  const price = Math.max(0, parseFloat(document.getElementById("comboPriceInput").value)||0);
  const newCatId = document.getElementById("comboCategorySelect").value;
  const comboItems = Object.keys(comboEditDraft)
    .filter(id=>comboEditDraft[id]>0)
    .map(id=>({itemId:id, qty:comboEditDraft[id]}));
  if(!name){ alertToast("请输入套餐名称"); return; }
  if(comboItems.length===0){ alertToast("请至少勾选一样套餐内含的菜品"); return; }
  const newCat = state.menu.find(c=>c.id===newCatId);
  if(!newCat){ alertToast("请选择套餐所属分类"); return; }

  if(comboEditItem){
    comboEditItem.name = name;
    comboEditItem.price = price;
    comboEditItem.comboItems = comboItems;
    if(newCatId !== comboEditOrigCatId){
      const oldCat = state.menu.find(c=>c.id===comboEditOrigCatId);
      if(oldCat) oldCat.items = oldCat.items.filter(i=>i.id!==comboEditItem.id);
      newCat.items.push(comboEditItem);
    }
  }else{
    newCat.items.push({ id:uid(), name, price, available:true, image:"", comboItems });
  }
  saveState();
  renderComboListEditor();
  renderMenuEditor();
  renderItemGridIfNeeded();
  hideModal("comboEditModal");
  alertToast("套餐已保存");
}

function deleteCombo(){
  if(!comboEditItem) return;
  if(!confirm(`确定删除套餐「${comboEditItem.name}」?`)) return;
  const cat = state.menu.find(c=>c.id===comboEditOrigCatId);
  if(cat) cat.items = cat.items.filter(i=>i.id!==comboEditItem.id);
  pushToTrash("combo", comboEditItem, { catId: comboEditOrigCatId });
  saveState();
  renderComboListEditor();
  renderMenuEditor();
  renderItemGridIfNeeded();
  hideModal("comboEditModal");
  alertToast("套餐已删除");
}

function renderItemGridIfNeeded(){
  renderCategoryTabs();
  renderItemGrid();
}

function addCategory(){
  const cat = { id:uid(), name:"新分类", items:[] };
  state.menu.push(cat);
  if(!activeCategory) activeCategory = cat.id;
  saveState();
  renderMenuEditor();
  renderCategoryTabs();
}

// ---------- Modal helpers ----------
// All .modal elements share the same z-index and are full-screen overlays, so when two are open
// at once, plain DOM order decides which one is actually visible/clickable — not which one was
// opened more recently. Every modal here can be triggered from inside another already-open modal
// (PIN confirm from history/settings, combo editor from settings, etc.), so relying on each
// modal's fixed position in the HTML was wrong: several ended up silently unreachable on a real
// tap even though .click()-based testing never caught it (synthetic clicks skip hit-testing).
// Moving the modal to the end of <body> every time it's shown guarantees it always paints on top
// of whatever else is open, regardless of where it was declared.
function showModal(id){
  const el = document.getElementById(id);
  document.body.appendChild(el);
  el.classList.remove("hidden");
}
function hideModal(id){ document.getElementById(id).classList.add("hidden"); }

function alertToast(msg){
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#2b2118;color:#fff;padding:10px 18px;border-radius:20px;font-size:14px;z-index:99;opacity:0.95;";
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 1600);
}

// ---------- Mobile cart drawer ----------
function toggleMobileCart(){
  document.getElementById("cartPane").classList.toggle("open");
}
function closeMobileCart(){
  document.getElementById("cartPane").classList.remove("open");
}

// ---------- Clock ----------
function tickClock(){
  const el = document.getElementById("clock");
  const d = new Date();
  el.textContent = d.toLocaleDateString("en-MY",{weekday:"short",year:"numeric",month:"short",day:"numeric"}) + " " +
    d.toLocaleTimeString("en-MY",{hour:"2-digit",minute:"2-digit"});
}

// ---------- Wire up events ----------
function init(){
  document.getElementById("shopName").textContent = state.settings.shopName;
  ensureOrderSeq();
  renderCategoryTabs();
  renderItemGrid();
  renderCart();
  renderHeldBadge();
  renderTrashBadge();
  maybeShowBackupReminder();
  tickClock();
  setInterval(tickClock, 15000);
  initCloudSyncOnLoad();

  document.getElementById("btnClearCart").onclick = ()=>{
    if(cart.length===0) return;
    if(confirm("确定清空当前订单?")) clearCart();
  };
  document.getElementById("btnCheckout").onclick = ()=> openCheckout(null);
  document.getElementById("btnCartMobile").onclick = toggleMobileCart;
  document.getElementById("btnHoldOrder").onclick = holdCurrentOrder;
  document.getElementById("btnHeldOrders").onclick = openHeldOrdersModal;
  document.getElementById("btnShowTrash").onclick = openTrashModal;

  document.getElementById("btnSaveNote").onclick = saveItemNote;

  document.getElementById("btnPinConfirmSubmit").onclick = ()=>{
    const val = document.getElementById("pinConfirmInput").value;
    if(val === state.settings.pin){
      hideModal("pinConfirmModal");
      const cb = pinConfirmCallback;
      pinConfirmCallback = null;
      if(cb) cb();
    }else{
      document.getElementById("pinConfirmError").classList.remove("hidden");
    }
  };

  document.getElementById("btnExportBackup").onclick = exportBackup;
  document.getElementById("btnExportCsv").onclick = exportHistoryCsv;
  document.getElementById("btnExportText").onclick = exportBackupAsText;
  document.querySelectorAll("[data-range]").forEach(btn=>{
    btn.onclick = ()=> setCsvRange(btn.dataset.range);
  });
  document.getElementById("inputImportBackup").addEventListener("change", (e)=>{
    const file = e.target.files[0];
    if(file) importBackup(file);
    e.target.value = "";
  });
  document.getElementById("btnImportPaste").onclick = importBackupFromPaste;

  document.querySelectorAll("#checkoutModal .pay-tab").forEach(btn=>{
    btn.onclick = ()=> switchPayTab(btn.dataset.method);
  });
  document.getElementById("cashReceived").addEventListener("input", updateChange);
  document.getElementById("btnConfirmCash").onclick = ()=>{
    const received = parseFloat(document.getElementById("cashReceived").value) || 0;
    const total = checkoutCtx.cashDue;
    if(received + 0.001 < total) return;
    finalizeOrder("cash", { cashReceived:received, change: round2(received-total) });
  };
  document.getElementById("btnConfirmQr").onclick = ()=>{
    finalizeOrder("qr", {});
  };

  document.getElementById("btnHistory").onclick = openHistory;
  document.getElementById("btnSettings").onclick = openSettings;
  document.getElementById("btnPinSubmit").onclick = trySubmitPin;
  document.getElementById("pinInput").addEventListener("keydown", e=>{ if(e.key==="Enter") trySubmitPin(); });

  document.querySelectorAll("[data-close]").forEach(btn=>{
    btn.onclick = ()=>{
      hideModal(btn.dataset.close);
      if(btn.dataset.close==="checkoutModal" && splitGroups && checkoutCtx && checkoutCtx.label){
        renderSplitPayList();
        showModal("splitPayModal");
      }
    };
  });
  document.getElementById("btnNewOrder").onclick = ()=>{
    const returnSplit = document.getElementById("btnNewOrder").dataset.returnSplit === "1";
    hideModal("receiptModal");
    if(returnSplit){
      renderSplitPayList();
      showModal("splitPayModal");
    }else{
      // Jump back to the first category tab for the next customer, instead of leaving the item
      // grid wherever the previous order happened to be browsing (e.g. still on 小吃 Snacks).
      activeCategory = state.menu[0] ? state.menu[0].id : null;
      renderCategoryTabs();
      renderItemGrid();
    }
  };
  document.getElementById("btnPrintReceipt").onclick = ()=>{
    if(btPrinterChar && currentReceiptOrder){ printReceiptBT(currentReceiptOrder); }
    else{ window.print(); }
  };
  document.getElementById("btnPrintKitchen").onclick = ()=>{
    if(!currentReceiptOrder) return;
    printKitchenTicketBT(currentReceiptOrder);
  };
  document.getElementById("btnConnectPrinter").onclick = connectBluetoothPrinter;
  document.getElementById("btnTestPrint").onclick = testPrint;

  document.querySelectorAll(".settings-tab").forEach(tab=>{
    tab.onclick = ()=>{
      document.querySelectorAll(".settings-tab").forEach(t=>t.classList.toggle("active", t===tab));
      document.getElementById("tabGeneral").classList.toggle("hidden", tab.dataset.tab!=="general");
      document.getElementById("tabMenu").classList.toggle("hidden", tab.dataset.tab!=="menu");
      document.getElementById("tabCombo").classList.toggle("hidden", tab.dataset.tab!=="combo");
      document.getElementById("tabPromo").classList.toggle("hidden", tab.dataset.tab!=="promo");
      document.getElementById("tabCloud").classList.toggle("hidden", tab.dataset.tab!=="cloud");
    };
  });
  document.getElementById("btnSaveGeneral").onclick = saveGeneralSettings;
  document.getElementById("inputQrFile").addEventListener("change", handleQrFile);
  document.getElementById("btnAddCategory").onclick = addCategory;
  document.getElementById("btnAddPromo").onclick = addPromo;
  document.getElementById("btnGenShopId").onclick = ()=>{ document.getElementById("cloudShopIdInput").value = genShopId(); };
  document.getElementById("btnCloudConnect").onclick = startCloudSync;
  document.getElementById("btnCloudDisconnect").onclick = stopCloudSync;
  document.getElementById("btnAddCombo").onclick = ()=> openComboEditModal(null, null);
  document.getElementById("btnSaveCombo").onclick = saveCombo;
  document.getElementById("btnDeleteCombo").onclick = deleteCombo;
  document.getElementById("btnUncombo").onclick = uncombo;
  document.getElementById("btnClearHistory").onclick = ()=>{
    if(confirm("确定清空今天的所有订单记录?此操作无法撤销。")){
      const t = todayStr();
      history = history.filter(o=>o.date!==t);
      saveHistory();
      alertToast("今日记录已清空");
      openHistory();
    }
  };

  // Discount
  document.getElementById("btnAddDiscount").onclick = openDiscountModal;
  document.querySelectorAll("#discountModal .pay-tab").forEach(btn=>{
    btn.onclick = ()=>{
      discountType = btn.dataset.dtype;
      pendingPromoName = null;
      document.querySelectorAll("#discountModal .pay-tab").forEach(b=>b.classList.toggle("active", b===btn));
      buildDiscountQuick();
      updateDiscountPreview();
    };
  });
  document.getElementById("discountInput").addEventListener("input", ()=>{ pendingPromoName = null; updateDiscountPreview(); });
  document.getElementById("btnApplyDiscount").onclick = applyDiscount;
  document.getElementById("btnDiscountPinSubmit").onclick = ()=>{
    const val = document.getElementById("discountPinInput").value;
    if(val === state.settings.pin){
      document.getElementById("discountPinGate").classList.add("hidden");
      document.getElementById("discountBody").classList.remove("hidden");
    }else{
      document.getElementById("discountPinError").classList.remove("hidden");
    }
  };

  // Split bill
  document.getElementById("btnSplitBill").onclick = openSplitModal;
  document.querySelectorAll("#splitModal .pay-tab").forEach(btn=>{
    btn.onclick = ()=> switchSplitMode(btn.dataset.split);
  });
  document.getElementById("btnAddSplitGroup").onclick = addSplitGroup;
  document.getElementById("btnConfirmSplit").onclick = confirmSplit;

  // click outside modal box closes modal
  document.querySelectorAll(".modal").forEach(modal=>{
    modal.addEventListener("click", e=>{
      if(e.target!==modal) return;
      modal.classList.add("hidden");
      if(modal.id==="checkoutModal" && splitGroups && checkoutCtx && checkoutCtx.label){
        renderSplitPayList();
        showModal("splitPayModal");
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", init);

// Registering a (deliberately no-cache) service worker is what lets Android Chrome offer a real
// full-screen "Install" instead of a plain bookmark shortcut that still shows the URL bar. Feature-
// detected and non-fatal — older browsers without SW support, or a failed registration, just fall
// back to the same in-browser experience as before.
if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("sw.js").catch(()=>{ /* not fatal, app still works normally */ });
  });
}
})();
