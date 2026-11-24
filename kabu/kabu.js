"use strict";
// 株スクリーナー — 非公開リポジトリの data ブランチにある jp.json / us.json を読んで絞り込む。
// このファイルにはデータを書かない。
(() => {
  const KEY = "kabu-app:v1";
  const KAKEIBO_KEY = "kakeibo-app:v1:settings";
  const PAGE = 50;

  // ---------- 保存 ----------
  const mem = {};
  const store = {
    get(k) {
      try { const v = localStorage.getItem(KEY + ":" + k); if (v != null) return JSON.parse(v); } catch (_) { /* 使えない */ }
      return k in mem ? mem[k] : null;
    },
    set(k, v) { mem[k] = v; try { localStorage.setItem(KEY + ":" + k, JSON.stringify(v)); return true; } catch (_) { return false; } }
  };
  function kakeiboSettings() {
    try { return JSON.parse(localStorage.getItem(KAKEIBO_KEY)) || null; } catch (_) { return null; }
  }

  // ---------- 小道具 ----------
  const $ = s => document.querySelector(s);
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  }
  const clear = e => { while (e.firstChild) e.firstChild.remove(); return e; };
  let toastTimer = 0;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800); }
  function notice(kind, title, ...body) { return h("div", { class: "notice " + kind }, title ? h("div", { class: "t", text: title }) : null, ...body); }

  const fmt = (n, d = 1) => n == null ? "—" : n.toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = (n, d = 1) => n == null ? "—" : (n > 0 ? "+" : n < 0 ? "−" : "") + fmt(Math.abs(n), d);
  function bigMoney(n, cur) {
    if (n == null) return "—";
    const u = cur === "JPY" ? "円" : cur === "USD" ? "ドル" : cur;
    if (n >= 1e12) return fmt(n / 1e12, 2) + "兆" + u;
    if (n >= 1e8) return fmt(Math.round(n / 1e8), 0) + "億" + u;
    return fmt(Math.round(n / 1e4), 0) + "万" + u;
  }
  const price = (n, cur) => n == null ? "—" : (cur === "USD" ? "$" + fmt(n, 2) : cur === "JPY" ? "¥" + fmt(n, n < 1000 ? 1 : 0) : fmt(n, 2) + " " + cur);
  const dateOf = ts => { if (!ts) return "—"; const d = new Date(ts * 1000); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };

  // ---------- 指標（絞り込みに使えるもの） ----------
  // unit の換算: 時価総額は「億」、売買代金は「百万」（どちらも現地通貨）
  const METRICS = [
    { k: "dy", label: "配当利回り", unit: "%" },
    { k: "per", label: "PER（実績）", unit: "倍" },
    { k: "fper", label: "PER（予想）", unit: "倍" },
    { k: "pbr", label: "PBR", unit: "倍" },
    { k: "roe", label: "ROE（概算）", unit: "%" },
    { k: "epsg", label: "予想EPS成長（概算）", unit: "%" },
    { k: "mcapU", label: "時価総額", unit: r => r === "jp" ? "億円" : "億ドル" },
    { k: "turnU", label: "売買代金（1日平均）", unit: r => r === "jp" ? "百万円" : "百万ドル" },
    { k: "c52", label: "1年の値動き", unit: "%" },
    { k: "h52", label: "52週高値からの差", unit: "%" },
    { k: "ma200", label: "200日線からの差", unit: "%" },
    { k: "ma50", label: "50日線からの差", unit: "%" },
    { k: "rating", label: "アナリスト評価", unit: "1強気〜5" },
    { k: "price", label: "株価", unit: r => r === "jp" ? "円" : "ドル" }
  ];
  const unitOf = (m, r) => typeof m.unit === "function" ? m.unit(r) : m.unit;

  // 条件の例（おすすめではなく、よく使われる絞り込みのひな形）
  const PRESETS = [
    { id: "all", label: "すべて", f: {} },
    { id: "div", label: "高配当", f: { dy: [3.5, null], per: [null, 20], turnU: [100, null] }, us: { dy: [3, null], per: [null, 25], turnU: [10, null] } },
    { id: "value", label: "割安", f: { per: [null, 12], pbr: [null, 1], roe: [5, null] }, us: { per: [null, 15], pbr: [null, 2], roe: [8, null] } },
    { id: "roe", label: "高ROE", f: { roe: [15, null], per: [null, 25], mcapU: [300, null] }, us: { roe: [20, null], per: [null, 30] } },
    { id: "growth", label: "増益予想", f: { epsg: [15, null], per: [null, 40], mcapU: [300, null] }, us: { epsg: [15, null], per: [null, 40] } },
    { id: "trend", label: "上昇トレンド", f: { ma200: [0, null], ma50: [0, null], h52: [-10, null] } },
    { id: "dip", label: "高値から下落", f: { h52: [null, -30], mcapU: [300, null] }, us: { h52: [null, -30] } }
  ];
  const presetFilters = (p, r) => (r === "us" && p.us) ? p.us : p.f;
  function describe(f, r) {
    const parts = [];
    for (const m of METRICS) {
      const v = f[m.k]; if (!v) continue;
      const [lo, hi] = v, u = unitOf(m, r);
      if (lo != null && hi != null) parts.push(`${m.label} ${lo}〜${hi}${u}`);
      else if (lo != null) parts.push(`${m.label} ${lo}${u}以上`);
      else if (hi != null) parts.push(`${m.label} ${hi}${u}以下`);
    }
    return parts.join("・");
  }

  const SORTS = [
    { k: "mcap", label: "時価総額が大きい順", dir: -1 },
    { k: "dy", label: "配当利回りが高い順", dir: -1 },
    { k: "per", label: "PERが低い順", dir: 1 },
    { k: "pbr", label: "PBRが低い順", dir: 1 },
    { k: "roe", label: "ROEが高い順", dir: -1 },
    { k: "epsg", label: "予想EPS成長が高い順", dir: -1 },
    { k: "c52", label: "1年の値上がりが大きい順", dir: -1 },
    { k: "h52", label: "52週高値に近い順", dir: -1 },
    { k: "chg", label: "前日比が大きい順", dir: -1 },
    { k: "turn", label: "売買代金が多い順", dir: -1 }
  ];

  // ---------- 状態 ----------
  const st = Object.assign({ region: "jp", preset: "all", filters: {}, mkts: [], sector: "", sort: "mcap", star: false }, store.get("state") || {});
  const stars = new Set(store.get("stars") || []);
  const data = { jp: null, us: null };
  let shown = PAGE, openSym = null;
  const saveState = () => store.set("state", { region: st.region, preset: st.preset, filters: st.filters, mkts: st.mkts, sector: st.sector, sort: st.sort, star: st.star });

  // ---------- GitHub ----------
  class AppError extends Error { constructor(m, status = 0) { super(m); this.status = status; } }
  function conn() {
    const own = store.get("settings") || {};
    const kk = kakeiboSettings();
    const token = own.token || kk?.token || "";
    const repo = own.repo || (kk?.repo ? kk.repo.split("/")[0] + "/kabu-data" : "");
    return { token, repo };
  }
  async function readJson(path) {
    const c = conn();
    if (!c.token || !/^[\w.-]+\/[\w.-]+$/.test(c.repo)) throw new AppError("接続の設定がありません。家計簿アプリで接続するか、設定画面で入れてください。", -1);
    const [o, r] = c.repo.split("/");
    const url = `https://api.github.com/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=data`;
    let res;
    try {
      res = await fetch(url, { cache: "no-store", referrerPolicy: "no-referrer", headers: { Authorization: "Bearer " + c.token, Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" } });
    } catch (_) { throw new AppError("GitHubに接続できませんでした。電波の状態を確認してください。"); }
    if (res.status === 401) throw new AppError("トークンが無効か期限切れです。", 401);
    if (res.status === 403) throw new AppError("権限がないか、利用回数の上限です。", 403);
    if (res.status === 404) throw new AppError(`データが見つかりません。トークンの対象リポジトリに「${c.repo}」が入っているか確認してください。`, 404);
    if (!res.ok) throw new AppError(`GitHubのエラー（${res.status}）`, res.status);
    return res.json();
  }

  // 前回のデータを端末に置いておき、更新があったときだけ読み直す
  function cacheGet(region) { try { return JSON.parse(localStorage.getItem(KEY + ":data:" + region)); } catch (_) { return null; } }
  function cachePut(region, doc) { try { localStorage.setItem(KEY + ":data:" + region, JSON.stringify(doc)); } catch (_) { /* 容量不足なら置かない */ } }

  function prepare(doc) {
    const ix = Object.fromEntries(doc.fields.map((f, i) => [f, i]));
    const g = (r, k) => (k in ix ? r[ix[k]] : null);
    doc.items = doc.rows.map(r => {
      const o = {};
      for (const f of doc.fields) o[f] = g(r, f);
      o.epsg = (o.per > 0 && o.fper > 0) ? Math.round((o.per / o.fper - 1) * 1000) / 10 : null;
      o.mcapU = o.mcap != null ? o.mcap / 1e8 : null;
      o.turnU = o.turn != null ? o.turn / 1e6 : null;
      o.code = doc.region === "jp" ? String(o.sym).replace(/\.T$/, "") : o.sym;
      o.mktG = doc.region === "jp" ? (/^プライム/.test(o.mkt) ? "プライム" : /^スタンダード/.test(o.mkt) ? "スタンダード" : /^グロース/.test(o.mkt) ? "グロース" : "その他")
        : (/Nasdaq/i.test(o.mkt) ? "Nasdaq" : /NYSE/i.test(o.mkt) ? "NYSE" : "その他");
      o.sec = o.sec || "（不明）";
      o.hay = (o.name + " " + o.code + " " + o.sym).toLowerCase();
      return o;
    });
    return doc;
  }

  let loading = false;
  async function load(force) {
    if (loading) return;
    loading = true; $("#reload").disabled = true;
    $("#status").textContent = "読み込み中…";
    try {
      const meta = await readJson("data/meta.json");
      for (const region of ["jp", "us"]) {
        if (!meta[region]) continue;
        const cached = !force && cacheGet(region);
        let doc = cached && cached.updated === meta[region].updated ? cached : null;
        if (!doc) { doc = await readJson(`data/${region}.json`); cachePut(region, doc); }
        data[region] = prepare(doc);
      }
      $("#status").textContent = statusText();
      render();
    } catch (e) {
      $("#status").textContent = "読み込めませんでした";
      for (const region of ["jp", "us"]) { const c = cacheGet(region); if (c && !data[region]) data[region] = prepare(c); }
      if (data.jp || data.us) render();
      const list = clear($("#list"));
      list.before(notice("err", "最新のデータを読み込めませんでした", e.message || String(e)));
      if (e.status === -1 || e.status === 404 || e.status === 401) show("settings");
    } finally { loading = false; $("#reload").disabled = false; }
  }
  function statusText() {
    const t = r => { const d = data[r]; if (!d) return ""; const u = new Date(d.updated); return `${r === "jp" ? "日本" : "米国"} ${u.getMonth() + 1}/${u.getDate()} ${u.getHours()}:${String(u.getMinutes()).padStart(2, "0")}`; };
    return [t("jp"), t("us")].filter(Boolean).join("・") + " 更新";
  }

  // ---------- 絞り込み ----------
  function activeFilters() { return st.filters || {}; }
  function filtered() {
    const d = data[st.region]; if (!d) return [];
    const q = $("#q").value.trim().toLowerCase();
    const f = activeFilters();
    const keys = Object.keys(f).filter(k => f[k] && (f[k][0] != null || f[k][1] != null));
    const sort = SORTS.find(s => s.k === st.sort) || SORTS[0];
    return d.items.filter(o => {
      if (q && !o.hay.includes(q)) return false;
      if (st.star && !stars.has(o.sym)) return false;
      if (st.mkts.length && !st.mkts.includes(o.mktG)) return false;
      if (st.sector && o.sec !== st.sector) return false;
      for (const k of keys) {
        const v = o[k], [lo, hi] = f[k];
        if (v == null) return false;
        if (lo != null && v < lo) return false;
        if (hi != null && v > hi) return false;
      }
      return true;
    }).sort((a, b) => {
      const x = a[sort.k], y = b[sort.k];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * sort.dir;
    });
  }

  // ---------- 描画 ----------
  function renderPresets() {
    const box = clear($("#presets"));
    for (const p of PRESETS) {
      box.append(h("button", {
        type: "button", class: "chip", "aria-pressed": String(st.preset === p.id), text: p.label,
        onclick: () => { st.preset = p.id; st.filters = JSON.parse(JSON.stringify(presetFilters(p, st.region))); shown = PAGE; saveState(); render(); }
      }));
    }
    const f = activeFilters(), d = describe(f, st.region);
    const p = PRESETS.find(x => x.id === st.preset);
    $("#preset-desc").textContent = d ? `条件: ${d}${p && p.id !== "all" && JSON.stringify(presetFilters(p, st.region)) === JSON.stringify(f) ? "（条件の例です。おすすめではありません）" : ""}` : "条件なし";
  }

  function renderFilters() {
    const d = data[st.region];
    // 市場区分
    const groups = st.region === "jp" ? ["プライム", "スタンダード", "グロース", "その他"] : ["NYSE", "Nasdaq", "その他"];
    const mbox = clear($("#mkts"));
    for (const g of groups) {
      mbox.append(h("button", {
        type: "button", class: "chip sm", "aria-pressed": String(st.mkts.includes(g)), text: g,
        onclick: () => { st.mkts = st.mkts.includes(g) ? st.mkts.filter(x => x !== g) : [...st.mkts, g]; shown = PAGE; saveState(); render(); }
      }));
    }
    // 業種
    const sel = clear($("#sector"));
    sel.append(h("option", { value: "", text: "すべての業種" }));
    if (d) {
      const cnt = new Map();
      for (const o of d.items) cnt.set(o.sec, (cnt.get(o.sec) || 0) + 1);
      [...cnt.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja")).forEach(([s, n]) => sel.append(h("option", { value: s, text: `${s}（${n}）` })));
    }
    sel.value = st.sector;
    if (sel.value !== st.sector) { st.sector = ""; sel.value = ""; }
    // 数値の範囲
    const rbox = $("#ranges");
    if (!rbox.dataset.built || rbox.dataset.built !== st.region) {
      clear(rbox); rbox.dataset.built = st.region;
      for (const m of METRICS) {
        const mk = (i, ph) => {
          const inp = h("input", { class: "input", inputmode: "decimal", "aria-label": `${m.label}の${i ? "上限" : "下限"}`, placeholder: ph, "data-k": m.k, "data-i": String(i) });
          inp.addEventListener("change", () => {
            const raw = inp.value.trim().replace(/[，,]/g, "").replace(/[０-９．－]/g, c => ({ "．": ".", "－": "-" }[c] || String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
            const v = raw === "" ? null : Number(raw);
            if (raw !== "" && !Number.isFinite(v)) { inp.value = ""; return; }
            const cur = (st.filters[m.k] || [null, null]).slice();
            cur[i] = v;
            if (cur[0] == null && cur[1] == null) delete st.filters[m.k]; else st.filters[m.k] = cur;
            st.preset = "custom"; shown = PAGE; saveState(); render();
          });
          return inp;
        };
        rbox.append(h("div", { class: "range" }, h("div", { class: "rl" }, m.label, h("small", { text: unitOf(m, st.region) })), mk(0, "下限"), h("span", { class: "tilde", text: "〜" }), mk(1, "上限")));
      }
    }
    for (const inp of rbox.querySelectorAll("input")) {
      const v = (st.filters[inp.dataset.k] || [])[+inp.dataset.i];
      if (document.activeElement !== inp) inp.value = v == null ? "" : String(v);
    }
    $("#only-star").checked = st.star;
    const n = Object.keys(st.filters).length + (st.mkts.length ? 1 : 0) + (st.sector ? 1 : 0) + (st.star ? 1 : 0);
    $("#filter-count").textContent = n ? `${n}件の条件` : "";
  }

  function renderSort() {
    const sel = $("#sort");
    if (!sel.options.length) SORTS.forEach(s => sel.append(h("option", { value: s.k, text: s.label })));
    sel.value = st.sort;
  }

  function kpi(label, value, hit) { return h("span", { class: hit ? "hit" : null }, label + " ", h("b", { text: value })); }

  function stockItem(o) {
    const f = activeFilters(), hit = k => !!f[k];
    const open = openSym === o.sym;
    const li = h("li", { class: "stock" });
    const head = h("button", { type: "button", class: "head", "aria-expanded": String(open) },
      h("div", { class: "nm", text: (stars.has(o.sym) ? "★ " : "") + o.name }),
      h("div", { class: "px", text: price(o.price, o.cur) }),
      h("div", { class: "meta", text: `${o.code}・${o.mkt}・${o.sec}` }),
      h("div", { class: "chg " + (o.chg > 0 ? "up" : o.chg < 0 ? "down" : ""), text: o.chg == null ? "" : sign(o.chg, 2) + "%" }),
      h("div", { class: "kpis" },
        kpi("PER", o.per == null ? "—" : fmt(o.per), hit("per")),
        kpi("PBR", o.pbr == null ? "—" : fmt(o.pbr, 2), hit("pbr")),
        kpi("利回り", o.dy == null ? "—" : fmt(o.dy, 2) + "%", hit("dy")),
        kpi("ROE", o.roe == null ? "—" : fmt(o.roe) + "%", hit("roe")),
        kpi("時価総額", bigMoney(o.mcap, o.cur), hit("mcapU"))));
    head.addEventListener("click", () => { openSym = open ? null : o.sym; renderList(); });
    li.append(head);
    if (open) li.append(detail(o));
    return li;
  }

  function detail(o) {
    const row = (k, v) => h("div", null, h("dt", { text: k }), h("dd", { text: v }));
    const jp = st.region === "jp";
    const links = jp
      ? [["Yahoo!ファイナンス", `https://finance.yahoo.co.jp/quote/${encodeURIComponent(o.sym)}`], ["株探", `https://kabutan.jp/stock/?code=${encodeURIComponent(o.code)}`]]
      : [["Yahoo Finance", `https://finance.yahoo.com/quote/${encodeURIComponent(o.sym)}`]];
    const starBtn = h("button", { type: "button", class: "star", "aria-pressed": String(stars.has(o.sym)), text: stars.has(o.sym) ? "★ 付けた" : "☆ ★を付ける" });
    starBtn.addEventListener("click", () => {
      if (stars.has(o.sym)) stars.delete(o.sym); else stars.add(o.sym);
      store.set("stars", [...stars]); renderList();
    });
    return h("div", { class: "detail" },
      h("dl", null,
        row("PER（実績）", o.per == null ? "—" : fmt(o.per) + "倍"),
        row("PER（予想）", o.fper == null ? "—" : fmt(o.fper) + "倍"),
        row("PBR", o.pbr == null ? "—" : fmt(o.pbr, 2) + "倍"),
        row("配当利回り", o.dy == null ? "—" : fmt(o.dy, 2) + "%"),
        row("ROE（概算）", o.roe == null ? "—" : fmt(o.roe) + "%"),
        row("予想EPS成長", o.epsg == null ? "—" : sign(o.epsg) + "%"),
        row("EPS（実績）", o.eps == null ? "—" : fmt(o.eps, 2)),
        row("時価総額", bigMoney(o.mcap, o.cur)),
        row("売買代金/日", bigMoney(o.turn, o.cur)),
        row("1年の値動き", o.c52 == null ? "—" : sign(o.c52) + "%"),
        row("52週高値から", o.h52 == null ? "—" : sign(o.h52) + "%"),
        row("200日線から", o.ma200 == null ? "—" : sign(o.ma200) + "%"),
        row("50日線から", o.ma50 == null ? "—" : sign(o.ma50) + "%"),
        row("アナリスト評価", o.rating == null ? "—" : fmt(o.rating) + "（1強気〜5）"),
        row("次の決算（予定）", dateOf(o.earn))),
      h("div", { class: "links" }, links.map(([t, u]) => h("a", { href: u, target: "_blank", rel: "noopener noreferrer", text: t + " ↗" })), starBtn));
  }

  let lastList = [];
  function renderList() {
    const ul = clear($("#list"));
    for (const n of document.querySelectorAll("#view-screen > .notice")) n.remove();
    const d = data[st.region];
    if (!d) { $("#count").textContent = "データを読み込んでいます…"; $("#more").hidden = true; return; }
    lastList.slice(0, shown).forEach(o => ul.append(stockItem(o)));
    $("#count").textContent = `${lastList.length.toLocaleString("ja-JP")}銘柄（全${d.items.length.toLocaleString("ja-JP")}銘柄中）`;
    $("#more").hidden = lastList.length <= shown;
    $("#more").textContent = `さらに表示（残り${(lastList.length - shown).toLocaleString("ja-JP")}）`;
    $("#source").textContent = `データ: ${d.source}・${statusText()}。株価は遅れていることがあります。`;
  }

  function render() {
    for (const b of document.querySelectorAll("[data-region]")) b.setAttribute("aria-pressed", String(b.dataset.region === st.region));
    renderPresets(); renderFilters(); renderSort();
    lastList = filtered();
    renderList();
  }

  // ---------- 画面 ----------
  function show(v) {
    for (const s of document.querySelectorAll(".view")) s.hidden = s.id !== "view-" + v;
    for (const b of document.querySelectorAll(".tabs button")) { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }
    if (v === "settings") {
      const own = store.get("settings") || {}, c = conn();
      $("#s-repo").value = own.repo || c.repo;
      $("#s-token").value = own.token || "";
    }
    window.scrollTo(0, 0);
  }

  // ---------- 起動 ----------
  for (const b of document.querySelectorAll("[data-region]")) b.addEventListener("click", () => {
    if (st.region === b.dataset.region) return;
    st.region = b.dataset.region; st.mkts = []; st.sector = ""; openSym = null; shown = PAGE;
    const p = PRESETS.find(x => x.id === st.preset);
    if (p) st.filters = JSON.parse(JSON.stringify(presetFilters(p, st.region)));
    saveState(); render();
  });
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => show(b.dataset.view));
  let qTimer = 0;
  $("#q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { shown = PAGE; lastList = filtered(); renderList(); }, 200); });
  $("#sector").addEventListener("change", e => { st.sector = e.target.value; shown = PAGE; saveState(); render(); });
  $("#sort").addEventListener("change", e => { st.sort = e.target.value; shown = PAGE; saveState(); render(); });
  $("#only-star").addEventListener("change", e => { st.star = e.target.checked; shown = PAGE; saveState(); render(); });
  $("#reset").addEventListener("click", () => { st.filters = {}; st.mkts = []; st.sector = ""; st.star = false; st.preset = "all"; shown = PAGE; saveState(); render(); });
  $("#more").addEventListener("click", () => { shown += PAGE; renderList(); });
  $("#reload").addEventListener("click", () => load(true));
  $("#s-save").addEventListener("click", async () => {
    const repo = $("#s-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
    const token = $("#s-token").value.trim();
    const msg = clear($("#s-msg"));
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { msg.append(notice("err", "リポジトリは「持ち主/名前」の形で入れてください")); return; }
    store.set("settings", { repo, token });
    await load(true);
    if (data.jp || data.us) { msg.append(notice("ok", "読み込めました")); show("screen"); }
  });

  render();
  load(false);
})();
