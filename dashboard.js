// Read-only sales dashboard for the shop owner. Deliberately separate from app.js/index.html —
// staff never see this page, and it has no write access to anything (pure Firestore reads).
// Security model matches the POS's own cloud sync: whoever has the Firebase config + shop ID can
// read the data, no separate login. Same tradeoff the owner already accepted for menu sync.
(function(){
"use strict";

const CLOUD_KEY = "sk_pos_dashboard_cloud_v1";
let cloudDb = null;
let currentRange = "today";

function fmt(n){ return "RM" + (Math.round((n||0)*100)/100).toFixed(2); }
function pad2(n){ return String(n).padStart(2,"0"); }
function dateInputStr(d){ return d.getFullYear()+"-"+pad2(d.getMonth()+1)+"-"+pad2(d.getDate()); }
function todayStr(){ return dateInputStr(new Date()); }
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
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function loadCloudConfig(){
  try{ return JSON.parse(localStorage.getItem(CLOUD_KEY)) || null; }
  catch(e){ return null; }
}
function saveCloudConfig(cfg){ localStorage.setItem(CLOUD_KEY, JSON.stringify(cfg)); }
function clearCloudConfig(){ localStorage.removeItem(CLOUD_KEY); }

function connectFirestore(configObj){
  if(typeof firebase === "undefined") throw new Error("Firebase 加载失败,请检查网络");
  if(firebase.apps && firebase.apps.length){
    firebase.apps.slice().forEach(a=>{ try{ a.delete(); }catch(e){} });
  }
  const app = firebase.initializeApp(configObj);
  cloudDb = firebase.firestore(app);
}

// order.time is a 12-hour string like "12:30 am" (from toLocaleTimeString on the till). Sorting
// those as plain strings is wrong right around midnight — "12:30 am" (the earliest time of day)
// lexicographically sorts AFTER "01:15 am", since "1" < "2" as characters. Parse to minutes
// since midnight instead so orders display in true chronological order.
function timeToMinutes(timeStr){
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(String(timeStr||"").trim());
  if(!m) return 0;
  let h = parseInt(m[1],10) % 12;
  if(/pm/i.test(m[3])) h += 12;
  return h*60 + parseInt(m[2],10);
}

function fetchOrders(shopId, start, end){
  // Only orderBy the same field the range filter is on (date) — Firestore can satisfy that with
  // its automatic single-field index. Adding a second orderBy(time) would require a manual
  // composite index to be created in the Firebase console before the query works at all, which
  // isn't worth the extra setup step for sorting within a single day; sort by time client-side
  // instead, orders per day are never many for a single small shop.
  return cloudDb.collection("posShops").doc(shopId).collection("orders")
    .where("date", ">=", start).where("date", "<=", end)
    .orderBy("date")
    .get()
    .then(snap=>{
      const orders = [];
      snap.forEach(doc=> orders.push(doc.data()));
      orders.sort((a,b)=> a.date===b.date ? timeToMinutes(a.time)-timeToMinutes(b.time) : a.date.localeCompare(b.date));
      return orders;
    });
}

function computeStats(orders){
  const valid = orders.filter(o=>!o.voided);
  const totalRevenue = valid.reduce((s,o)=>s+(o.total||0),0);
  const cashRevenue = valid.filter(o=>o.paymentMethod==="cash").reduce((s,o)=>s+(o.total||0),0);
  const qrRevenue = valid.filter(o=>o.paymentMethod==="qr").reduce((s,o)=>s+(o.total||0),0);
  const avg = valid.length ? totalRevenue/valid.length : 0;

  const byDay = {};
  valid.forEach(o=>{ byDay[o.date] = (byDay[o.date]||0) + (o.total||0); });
  const dayRows = Object.keys(byDay).sort().map(date=>({date, revenue:byDay[date]}));
  const maxDay = dayRows.reduce((m,r)=>Math.max(m,r.revenue), 0);

  const itemQty = {};
  valid.forEach(o=>{
    (o.items||[]).forEach(it=>{
      itemQty[it.name] = (itemQty[it.name]||0) + (it.qty||0);
    });
  });
  const topItems = Object.keys(itemQty).map(name=>({name, qty:itemQty[name]}))
    .sort((a,b)=>b.qty-a.qty).slice(0,10);

  return { totalRevenue, cashRevenue, qrRevenue, avg, orderCount: valid.length, dayRows, maxDay, topItems };
}

function render(orders){
  const stats = computeStats(orders);
  document.getElementById("statRevenue").textContent = fmt(stats.totalRevenue);
  document.getElementById("statOrders").textContent = stats.orderCount;
  document.getElementById("statAvg").textContent = fmt(stats.avg);
  document.getElementById("statSplit").textContent = `${fmt(stats.cashRevenue)} / ${fmt(stats.qrRevenue)}`;

  const dayChart = document.getElementById("dayChart");
  if(stats.dayRows.length===0){
    dayChart.innerHTML = `<div class="empty-note">这段范围内没有订单</div>`;
  }else{
    dayChart.innerHTML = stats.dayRows.map(r=>{
      const pct = stats.maxDay>0 ? Math.max(4, Math.round(r.revenue/stats.maxDay*100)) : 0;
      return `
        <div class="day-row">
          <span class="day-label">${escapeHtml(r.date)}</span>
          <span class="day-bar-wrap"><span class="day-bar" style="width:${pct}%"></span></span>
          <span class="day-value">${fmt(r.revenue)}</span>
        </div>
      `;
    }).join("");
  }

  const topItemsEl = document.getElementById("topItems");
  topItemsEl.innerHTML = stats.topItems.length===0
    ? `<div class="empty-note">这段范围内没有订单</div>`
    : stats.topItems.map(it=>`
        <div class="top-item-row"><span>${escapeHtml(it.name)}</span><span>x${it.qty}</span></div>
      `).join("");

  const orderTableEl = document.getElementById("orderTable");
  if(orders.length===0){
    orderTableEl.innerHTML = `<div class="empty-note">这段范围内没有订单</div>`;
  }else{
    const rows = orders.slice().reverse().map(o=>`
      <tr class="${o.voided?"voided":""}">
        <td>${escapeHtml(o.orderNo)}</td>
        <td>${escapeHtml(o.date)} ${escapeHtml(o.time)}</td>
        <td>${o.paymentMethod==="cash"?"现金":"电子钱包"}</td>
        <td>${fmt(o.total)}</td>
        <td>${o.voided?"已作废":""}</td>
      </tr>
    `).join("");
    orderTableEl.innerHTML = `
      <div class="order-table-wrap">
        <table>
          <thead><tr><th>订单号</th><th>时间</th><th>付款</th><th>总计</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  document.getElementById("lastRefreshed").textContent = `最后刷新: ${new Date().toLocaleTimeString("en-MY")}`;
}

function currentRangeDates(){
  if(currentRange==="today") return { start: todayStr(), end: todayStr() };
  if(currentRange==="week") return { start: startOfWeekStr(), end: todayStr() };
  if(currentRange==="month") return { start: startOfMonthStr(), end: todayStr() };
  const start = document.getElementById("rangeStart").value || todayStr();
  const end = document.getElementById("rangeEnd").value || todayStr();
  return { start, end };
}

function refresh(){
  const cfg = loadCloudConfig();
  if(!cfg || !cfg.enabled || !cloudDb) return;
  const { start, end } = currentRangeDates();
  document.getElementById("lastRefreshed").textContent = "读取中...";
  fetchOrders(cfg.shopId, start, end)
    .then(orders=> render(orders))
    .catch(err=>{
      document.getElementById("lastRefreshed").textContent = `⚠️ 读取失败: ${err && err.message ? err.message : "未知错误"}`;
    });
}

function showDashboard(){
  document.getElementById("connectView").classList.add("hidden");
  document.getElementById("dashboardView").classList.remove("hidden");
  document.getElementById("btnDisconnect").classList.remove("hidden");
}

function showConnectForm(){
  document.getElementById("connectView").classList.remove("hidden");
  document.getElementById("dashboardView").classList.add("hidden");
  document.getElementById("btnDisconnect").classList.add("hidden");
}

function tryConnect(configObj, shopId){
  try{ connectFirestore(configObj); }
  catch(e){
    document.getElementById("connectStatus").textContent = "Firebase 配置有误,请检查后重新贴上";
    return;
  }
  showDashboard();
  refresh();
}

function init(){
  document.querySelectorAll(".range-btn").forEach(btn=>{
    btn.onclick = ()=>{
      document.querySelectorAll(".range-btn").forEach(b=>b.classList.toggle("active", b===btn));
      currentRange = btn.dataset.range;
      document.getElementById("customRange").classList.toggle("hidden", currentRange!=="custom");
      if(currentRange==="custom"){
        if(!document.getElementById("rangeStart").value){
          document.getElementById("rangeStart").value = todayStr();
          document.getElementById("rangeEnd").value = todayStr();
        }
        return;
      }
      refresh();
    };
  });
  document.querySelector('.range-btn[data-range="today"]').classList.add("active");

  document.getElementById("btnApplyCustomRange").onclick = refresh;
  document.getElementById("btnRefresh").onclick = refresh;

  document.getElementById("btnConnect").onclick = ()=>{
    const configText = document.getElementById("cloudConfigInput").value.trim();
    const shopId = document.getElementById("cloudShopIdInput").value.trim();
    if(!configText || !shopId){
      document.getElementById("connectStatus").textContent = "请贴上 Firebase 配置并填写店铺代号";
      return;
    }
    let configObj;
    try{ configObj = JSON.parse(configText); }
    catch(e){ document.getElementById("connectStatus").textContent = "Firebase 配置格式不对,请确认整段 JSON 都贴上了"; return; }
    saveCloudConfig({ enabled:true, configText, shopId });
    tryConnect(configObj, shopId);
  };

  document.getElementById("btnDisconnect").onclick = ()=>{
    if(!confirm("确定断开?下次要重新贴配置才能查看。")) return;
    if(typeof firebase !== "undefined" && firebase.apps && firebase.apps.length){
      firebase.apps.slice().forEach(a=>{ try{ a.delete(); }catch(e){} });
    }
    cloudDb = null;
    clearCloudConfig();
    document.getElementById("cloudConfigInput").value = "";
    document.getElementById("cloudShopIdInput").value = "";
    document.getElementById("connectStatus").textContent = "";
    showConnectForm();
  };

  const saved = loadCloudConfig();
  if(saved && saved.enabled){
    document.getElementById("cloudConfigInput").value = saved.configText || "";
    document.getElementById("cloudShopIdInput").value = saved.shopId || "";
    let configObj;
    try{ configObj = JSON.parse(saved.configText); }
    catch(e){
      document.getElementById("connectStatus").textContent = "已保存的配置格式有误,请重新贴上";
      return;
    }
    tryConnect(configObj, saved.shopId);
  }
}

document.addEventListener("DOMContentLoaded", init);
})();
