"use strict";
// 家計簿アプリ — GitHubの非公開リポジトリにあるCSVを直接読み書きする。
// このファイルにはデータを一切書かない（口座名・金額などはすべて実行時にCSVから読む）。
(() => {
  const KEY = "kakeibo-app:v1";
  const FILES = { tx: "取引.csv", acc: "口座.csv", card: "カード.csv", inst: "分割払い.csv", sal: "給与.csv" };
  const BASE_CATS = {
    支出: ["食費", "外食", "日用品", "交通", "趣味", "交際", "通信", "サブスク", "医療", "教育", "住居", "水道光熱", "立替", "その他"],
    収入: ["給与", "その他収入", "立替精算"]
  };
  // 2025年（令和7年）改正後の壁
  const WALLS = [["所得税・扶養の壁", 1230000], ["社会保険の壁", 1300000]];
  const APP_MARK = "（アプリ入力）";

  // ---------- 保存（使えない端末ではメモリだけ） ----------
  const mem = {};
  const store = {
    get(k) {
      try { const v = localStorage.getItem(KEY + ":" + k); if (v != null) return JSON.parse(v); } catch (_) { /* 使えない */ }
      return k in mem ? mem[k] : null;
    },
    set(k, v) {
      mem[k] = v;
      try { localStorage.setItem(KEY + ":" + k, JSON.stringify(v)); return true; } catch (_) { return false; }
    },
    del(k) {
      delete mem[k];
      try { localStorage.removeItem(KEY + ":" + k); } catch (_) { /* 使えない */ }
    }
  };

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
  const yen = n => (n < 0 ? "−" : "") + "¥" + Math.abs(n).toLocaleString("ja-JP");
  const dayIso = (offset = 0) => new Date(Date.now() + 9 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);
  const thisMonth = () => dayIso().slice(0, 7);
  const md = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const monthLabel = ym => {
    const [y, m] = ym.split("-");
    return (y !== thisMonth().slice(0, 4) ? `${y}年` : "") + `${+m}月`;
  };
  const nextMonth = ym => {
    let [y, m] = ym.split("-").map(Number);
    m++; if (m > 12) { m = 1; y++; }
    return `${y}-${String(m).padStart(2, "0")}`;
  };
  const daysIn = ym => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const clear = e => { while (e.firstChild) e.firstChild.remove(); return e; };

  let toastTimer = 0;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function setStatus(msg) { $("#status").textContent = msg; }
  function notice(kind, title, ...body) {
    return h("div", { class: "notice " + kind, role: kind === "err" ? "alert" : null },
      title ? h("div", { class: "t", text: title }) : null, ...body);
  }

  // ---------- CSV ----------
  function parseCsv(text) {
    const rows = []; let row = [], cell = "", quoted = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); cell = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  const csvCell = s => /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const csvLine = r => r.map(v => csvCell(String(v))).join(",");

  // ---------- GitHub ----------
  class AppError extends Error { constructor(m, status = 0) { super(m); this.status = status; } }
  let S = store.get("settings");

  function fileUrl(name) {
    const [owner, repo] = S.repo.split("/");
    const parts = [...(S.dir || "").split("/").filter(Boolean), name].map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${parts}`;
  }
  const refQ = () => "?ref=" + encodeURIComponent(S.branch || "main");

  function explain(status, msg) {
    if (status === 401) return "トークンが無効か期限切れです。設定で入れ直してください。";
    if (status === 403) return /rate limit/i.test(msg)
      ? "GitHubの利用回数の上限に達しました。少し待ってからやり直してください。"
      : "このトークンには権限がありません（Contents の Read and write が必要です）。";
    if (status === 404) return "リポジトリかファイルが見つかりません。設定のリポジトリ名・ブランチ・フォルダと、トークンの対象リポジトリを確認してください。";
    if (status === 409 || status === 422) return "ほかの書き込みとぶつかりました。";
    return `GitHubのエラー（${status}）${msg ? "：" + msg : ""}`;
  }

  async function gh(url, { method = "GET", accept = "application/vnd.github+json", body } = {}) {
    let res;
    try {
      res = await fetch(url, {
        method, cache: "no-store", referrerPolicy: "no-referrer",
        headers: {
          Authorization: "Bearer " + S.token,
          Accept: accept,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (_) {
      throw new AppError("GitHubに接続できませんでした。電波の状態を確認してください。");
    }
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.json()).message || ""; } catch (_) { /* 本文なし */ }
      throw new AppError(explain(res.status, msg), res.status);
    }
    return res;
  }

  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  function b64encode(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function readText(name) {
    const r = await gh(fileUrl(name) + refQ(), { accept: "application/vnd.github.raw+json" });
    return r.text();
  }
  async function readWithSha(name) {
    const j = await (await gh(fileUrl(name) + refQ())).json();
    if (j.encoding !== "base64" || typeof j.content !== "string" || (j.size > 0 && !j.content))
      throw new AppError("ファイルが大きすぎて書き込めません（1MB超）。Claudeに分割を頼んでください。");
    return { text: b64decode(j.content), sha: j.sha };
  }
  async function writeText(name, text, sha, message) {
    await gh(fileUrl(name), { method: "PUT", body: { message, content: b64encode(text), sha, branch: S.branch || "main" } });
  }
  const conflict = e => e instanceof AppError && (e.status === 409 || e.status === 422);

  // 取引.csv の末尾に行を足す。ぶつかったら読み直して最大3回
  async function appendTx(rows, message) {
    for (let attempt = 1; ; attempt++) {
      const { text, sha } = await readWithSha(FILES.tx);
      const eol = /\r\n$/.test(text) ? "\r\n" : "\n";
      const base = text === "" || text.endsWith("\n") ? text : text + eol;
      const block = rows.map(csvLine).join(eol) + eol;
      try { await writeText(FILES.tx, base + block, sha, message); return block; }
      catch (e) { if (conflict(e) && attempt < 3) continue; throw e; }
    }
  }
  // 直前に足した行を消す（行がそのまま残っているときだけ）
  async function removeBlock(block, message) {
    for (let attempt = 1; ; attempt++) {
      const { text, sha } = await readWithSha(FILES.tx);
      let i = text.lastIndexOf(block);
      while (i > 0 && text[i - 1] !== "\n") i = text.lastIndexOf(block, i - 1);
      if (i < 0) throw new AppError("取引.csvに該当の行が見つかりません（すでに直されています）。取り消しはClaudeに頼んでください。");
      try { await writeText(FILES.tx, text.slice(0, i) + text.slice(i + block.length), sha, message); return; }
      catch (e) { if (conflict(e) && attempt < 3) continue; throw e; }
    }
  }

  // ---------- データ ----------
  let D = null;
  async function loadAll() {
    const [tx, acc, card, inst, sal] = await Promise.all([
      readText(FILES.tx), readText(FILES.acc), readText(FILES.card),
      readText(FILES.inst).catch(() => ""), readText(FILES.sal).catch(() => "")
    ]);
    const skipped = [];
    const body = t => parseCsv(t).slice(1);
    D = {
      tx: body(tx).flatMap((r, i) => {
        if (r.length < 6 || !/^\d{4}-\d\d-\d\d$/.test(r[0]) || !/^\d+$/.test(r[2]) || (r[1] !== "収入" && r[1] !== "支出")) {
          skipped.push(i + 2); return [];
        }
        return [{ d: r[0], type: r[1], amt: Number(r[2]), acc: r[3], cat: r[4], memo: r[5] }];
      }),
      acc: body(acc).map(r => ({ name: r[0], kind: r[1] || "", init: Number(r[2]) || 0 })),
      cards: body(card).map(r => ({ name: r[0], payAcc: r[1] || "", payDay: r[3] || "", base: Number(r[6]) || 0 })),
      inst: body(inst).filter(r => r.length >= 6).map(r => ({ card: r[1], item: r[2], amt: Number(r[3]) || 0, ym: r[4], state: r[5] })),
      sal: body(sal).filter(r => /^\d{4}-\d\d$/.test(r[0])).map(r => ({ ym: r[0], amt: Number(r[1]) || 0, forecast: /^\s*【見込み?】/.test(r[4] || "") })),
      skipped,
      loadedAt: new Date()
    };
    compute();
  }

  function compute() {
    const bal = new Map(D.acc.map(a => [a.name, a.init]));
    const flow = new Map(D.cards.map(c => [c.name, 0]));
    const unknown = new Set();
    for (const t of D.tx) {
      const s = t.type === "収入" ? t.amt : -t.amt;
      if (bal.has(t.acc)) bal.set(t.acc, bal.get(t.acc) + s);
      else if (flow.has(t.acc)) flow.set(t.acc, flow.get(t.acc) - s); // カードは支出で増える
      else unknown.add(t.acc);
    }
    D.balances = D.acc.map(a => ({ ...a, bal: bal.get(a.name) }));
    D.unpaid = D.cards.map(c => {
      const instLeft = D.inst.filter(x => x.card === c.name && x.state.startsWith("未払")).reduce((s, x) => s + x.amt, 0);
      return { ...c, unpaid: c.base + flow.get(c.name) - instLeft };
    });
    D.unknown = [...unknown];
    D.liquid = D.balances.filter(a => a.kind !== "証券").reduce((s, a) => s + a.bal, 0);
    D.invest = D.balances.filter(a => a.kind === "証券").reduce((s, a) => s + a.bal, 0);
    D.debt = D.unpaid.reduce((s, c) => s + c.unpaid, 0);
  }
  const balanceOf = name => {
    const a = D.balances.find(x => x.name === name); if (a) return { kind: "口座", v: a.bal };
    const c = D.unpaid.find(x => x.name === name); if (c) return { kind: "カード", v: c.unpaid };
    return null;
  };
  const monthSpend = ym => D.tx.filter(t => t.d.startsWith(ym) && t.type === "支出" && t.cat !== "振替").reduce((s, t) => s + t.amt, 0);
  const monthIncome = ym => D.tx.filter(t => t.d.startsWith(ym) && t.type === "収入" && t.cat !== "振替").reduce((s, t) => s + t.amt, 0);
  function monthList() {
    if (!D.tx.length) return [thisMonth()];
    let m = D.tx.reduce((a, t) => t.d < a ? t.d : a, D.tx[0].d).slice(0, 7);
    const last = [thisMonth(), ...D.tx.map(t => t.d.slice(0, 7))].sort().pop();
    const out = [];
    for (; m <= last; m = nextMonth(m)) out.push(m);
    return out;
  }

  // ---------- 画面切り替え ----------
  let view = "input";
  function show(v) {
    view = v;
    for (const s of document.querySelectorAll(".view")) s.hidden = s.id !== "view-" + v;
    for (const b of document.querySelectorAll(".tabs button")) {
      if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    }
    render();
    window.scrollTo(0, 0);
  }
  function render() {
    if (!D) return;
    if (view === "input") renderInput();
    else if (view === "dash") renderDash();
    else if (view === "tx") renderTx();
  }

  // ---------- 記帳 ----------
  const F = { mode: "支出", cat: "", custom: false, dupOk: false, busy: false };
  const lastPick = () => store.get("last") || {};

  function txItem(t) {
    const isMove = t.cat === "振替";
    const li = h("li", { tabindex: "0" },
      h("div", { class: "main" }, h("span", { class: "tag", text: t.cat }), t.memo.replace(APP_MARK, "") || t.acc),
      h("div", { class: "amt" + (isMove ? " mv" : t.type === "収入" ? " in" : ""), text: (t.type === "収入" ? "+" : "−") + yen(t.amt).replace("−", "") }),
      h("div", { class: "sub", text: `${md(t.d)}・${t.acc}${t.memo ? "・" + t.memo : ""}` })
    );
    const toggle = () => li.classList.toggle("open");
    li.addEventListener("click", toggle);
    li.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    return li;
  }

  function accountOptions(sel, names, groups, picked) {
    clear(sel);
    sel.append(h("option", { value: "", text: "選んでください" }));
    for (const [label, list] of groups) {
      if (!list.length) continue;
      sel.append(h("optgroup", { label }, list.map(n => h("option", { value: n, text: n }))));
    }
    sel.value = names.includes(picked) ? picked : "";
  }
  function usageRank(type) {
    const since = dayIso(-90), count = new Map();
    for (const t of D.tx) if (t.d >= since && t.type === type) count.set(t.acc, (count.get(t.acc) || 0) + 1);
    return count;
  }

  function fillSelects() {
    const accs = D.acc.map(a => a.name), cards = D.cards.map(c => c.name), all = [...accs, ...cards];
    const last = lastPick();
    if (F.mode === "振替") {
      accountOptions($("#f-from"), all, [["口座", accs], ["カード", cards]], last.from);
      accountOptions($("#f-to"), all, [["カード（引落）", cards], ["口座", accs]], last.to);
    } else {
      const rank = usageRank(F.mode);
      const often = [...rank.entries()].filter(([n]) => all.includes(n)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
      const rest = n => !often.includes(n);
      const groups = F.mode === "支出"
        ? [["よく使う", often], ["カード", cards.filter(rest)], ["口座", accs.filter(rest)]]
        : [["よく使う", often], ["口座", accs.filter(rest)], ["カード（キャッシュバック・取消）", cards.filter(rest)]];
      accountOptions($("#f-account"), all, groups, last[F.mode] || often[0]);
    }
  }

  function fillCats() {
    const box = clear($("#f-cats"));
    if (!BASE_CATS[F.mode]) return; // 振替はカテゴリ固定
    const freq = new Map();
    for (const t of D.tx) if (t.type === F.mode && t.cat !== "振替") freq.set(t.cat, (freq.get(t.cat) || 0) + 1);
    const cats = [...new Set([...[...freq.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c), ...BASE_CATS[F.mode]])];
    const shown = cats.slice(0, 14);
    if (F.cat && !F.custom && !shown.includes(F.cat)) F.cat = "";
    for (const c of shown) {
      box.append(h("button", {
        type: "button", class: "chip", "aria-pressed": String(!F.custom && F.cat === c), text: c,
        onclick: () => { F.cat = c; F.custom = false; $("#f-cat-custom").hidden = true; fillCats(); update(); }
      }));
    }
    box.append(h("button", {
      type: "button", class: "chip", "aria-pressed": String(F.custom), text: "その他…",
      onclick: () => { F.custom = true; F.cat = ""; const i = $("#f-cat-custom"); i.hidden = false; i.value = ""; i.focus(); fillCats(); update(); }
    }));
  }

  function setMode(m) {
    F.mode = m; F.cat = ""; F.custom = false; F.dupOk = false;
    for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
    $("#fld-account").hidden = m === "振替";
    $("#fld-transfer").hidden = m !== "振替";
    $("#fld-cat").hidden = m === "振替";
    $("#f-cat-custom").hidden = true;
    $("#fld-account label").textContent = m === "収入" ? "入金された口座" : "支払った口座・カード";
    fillSelects(); fillCats(); update();
  }

  function amountValue() {
    const raw = $("#f-amount").value.replace(/[,，\s円¥￥]/g, "").replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    return /^\d+$/.test(raw) ? Number(raw) : NaN;
  }

  // 入力から、取引.csvに足す行を作る（足せないときは理由を返す）
  function buildRows() {
    const amt = amountValue(), d = $("#f-date").value;
    const memo0 = $("#f-memo").value.replace(/[\r\n]+/g, " ").trim();
    if (!(amt > 0)) return { why: "金額を入れてください" };
    if (!/^\d{4}-\d\d-\d\d$/.test(d)) return { why: "日付を選んでください" };
    if (F.mode === "振替") {
      const from = $("#f-from").value, to = $("#f-to").value;
      if (!from || !to) return { why: "出金元と入金先を選んでください" };
      if (from === to) return { why: "出金元と入金先が同じです" };
      const toCard = D.cards.some(c => c.name === to);
      let memo = memo0;
      if (toCard && !memo.startsWith(to)) memo = `${to} ${md(d)}引落${memo ? " " + memo : ""}`;
      memo = (memo ? memo + " " : "") + APP_MARK;
      return { rows: [[d, "支出", amt, from, "振替", memo], [d, "収入", amt, to, "振替", memo]], toCard, key: from };
    }
    const acc = $("#f-account").value;
    const cat = F.custom ? $("#f-cat-custom").value.replace(/[\r\n,]+/g, " ").trim() : F.cat;
    if (!acc) return { why: "口座・カードを選んでください" };
    if (!cat) return { why: "カテゴリを選んでください" };
    if (cat === "振替") return { why: "口座間の移動は「振替・引落」から入れてください" };
    const memo = (memo0 ? memo0 + " " : "") + APP_MARK;
    return { rows: [[d, F.mode, amt, acc, cat, memo]], key: acc };
  }

  function update() {
    const b = buildRows();
    const pv = $("#f-preview"), dup = clear($("#f-dup")), hint = clear($("#f-hint"));
    pv.textContent = b.rows ? b.rows.map(csvLine).join("\n") : b.why;
    let blocked = !b.rows;
    if (b.rows) {
      const [d, , amt] = b.rows[0];
      const same = D.tx.filter(t => t.d === d && t.amt === amt && t.acc === b.key);
      if (same.length) {
        const cb = h("input", { type: "checkbox", onchange: e => { F.dupOk = e.target.checked; update(); } });
        cb.checked = F.dupOk;
        dup.append(notice("warn", "同じ日・同じ金額・同じ口座の取引がすでにあります",
          h("ul", { class: "txlist" }, same.slice(0, 3).map(txItem)),
          h("label", null, cb, "別の取引なので記帳する")));
        if (!F.dupOk) blocked = true;
      }
      if (b.toCard) hint.append(notice("ok", null, "カードの引落として、出金と入金の2行を記帳します。分割払いの分が含まれている場合は、あとで分割払い.csvを「支払済」に直す必要があります（Claudeに頼んでください）。"));
      if (!F.custom && F.cat === "立替") hint.append(notice("warn", null, "「立替」は、実際に返してもらうものだけに使います。"));
    }
    $("#f-submit").disabled = blocked || F.busy;
  }

  async function submit() {
    const b = buildRows();
    if (!b.rows || F.busy) return;
    F.busy = true; update();
    const btn = $("#f-submit"); btn.textContent = "記帳しています…";
    const [d, type, amt, acc] = b.rows[0];
    try {
      const msg = `家計簿: アプリから記帳 ${d} ${F.mode === "振替" ? "振替" : type} ${amt}円 ${acc}`;
      const block = await appendTx(b.rows, msg);
      for (const r of b.rows) D.tx.push({ d: r[0], type: r[1], amt: r[2], acc: r[3], cat: r[4], memo: r[5] });
      compute();
      const last = lastPick();
      if (F.mode === "振替") { last.from = b.rows[0][3]; last.to = b.rows[1][3]; } else last[F.mode] = acc;
      store.set("last", last);
      showResult(b.rows, block);
      $("#f-amount").value = ""; $("#f-memo").value = ""; F.dupOk = false;
      toast("記帳しました");
    } catch (e) {
      clear($("#result")).append(notice("err", "記帳できませんでした", e.message || String(e)));
    } finally {
      F.busy = false; btn.textContent = "記帳する"; update(); renderRecent();
    }
  }

  function showResult(rows, block) {
    const box = clear($("#result"));
    const ym = rows[0][0].slice(0, 7);
    const names = [...new Set(rows.map(r => r[3]))];
    const undo = h("button", { type: "button", class: "btn secondary", text: "この記帳を取り消す" });
    undo.addEventListener("click", async () => {
      undo.disabled = true; undo.textContent = "取り消しています…";
      try {
        await removeBlock(block, `家計簿: アプリの記帳を取り消し ${rows[0][0]} ${rows[0][2]}円 ${rows[0][3]}`);
        for (const r of rows.slice().reverse()) {
          for (let i = D.tx.length - 1; i >= 0; i--) {
            const t = D.tx[i];
            if (t.d === r[0] && t.type === r[1] && t.amt === r[2] && t.acc === r[3] && t.cat === r[4] && t.memo === r[5]) { D.tx.splice(i, 1); break; }
          }
        }
        compute(); clear(box).append(notice("ok", "取り消しました")); renderRecent();
      } catch (e) {
        undo.disabled = false; undo.textContent = "この記帳を取り消す";
        box.append(notice("err", "取り消せませんでした", e.message || String(e)));
      }
    });
    box.append(h("div", { class: "card" },
      h("h2", { text: "記帳しました" }),
      h("ul", { class: "txlist" }, rows.map(r => txItem({ d: r[0], type: r[1], amt: r[2], acc: r[3], cat: r[4], memo: r[5] }))),
      h("div", { class: "bars mt8" }, names.map(n => {
        const b = balanceOf(n);
        return b ? h("div", { class: "meter-row" }, h("span", { text: `${n} の${b.kind === "カード" ? "未払い" : "残高"}` }), h("strong", { text: yen(b.v) })) : null;
      }),
      h("div", { class: "meter-row" }, h("span", { text: `${monthLabel(ym)}の支出合計` }), h("strong", { text: yen(monthSpend(ym)) })),
      h("div", { class: "meter-row" }, h("span", { text: "使えるお金 − カード未払い" }), h("strong", { text: yen(D.liquid - D.debt) }))),
      h("div", { class: "mt8" }, undo)));
  }

  function renderRecent() {
    const ul = clear($("#recent"));
    D.tx.slice(-10).reverse().forEach(t => ul.append(txItem(t)));
  }
  let inputReady = false;
  function renderInput() {
    if (!inputReady) {
      inputReady = true;
      $("#f-date").value = dayIso();
      setMode(F.mode);
    } else { fillSelects(); fillCats(); update(); }
    renderRecent();
  }

  // ---------- ダッシュボード ----------
  let dashMonth = null;
  function monthChips(box, current, onPick) {
    clear(box);
    for (const m of monthList()) {
      box.append(h("button", { type: "button", class: "chip", "aria-pressed": String(m === current), text: monthLabel(m), onclick: () => onPick(m) }));
    }
    const on = box.querySelector('[aria-pressed="true"]');
    if (on) box.scrollLeft = on.offsetLeft - box.clientWidth + on.offsetWidth + 16;
  }
  function barRow(label, sub, v, max, cls) {
    const fill = h("div", { class: "fill" + (v === 0 ? " zero" : "") + (cls ? " " + cls : "") });
    if (v !== 0) fill.style.width = Math.max(1, Math.abs(v) / (max || 1) * 100) + "%";
    return h("div", { class: "bar" },
      h("div", { class: "l", title: label }, label, sub ? h("small", { text: sub }) : null),
      h("div", { class: "track" }, fill),
      h("div", { class: "v", text: yen(v) }));
  }
  function tile(k, v, n, neg) {
    return h("div", { class: "tile" }, h("div", { class: "k", text: k }), h("div", { class: "v" + (neg ? " neg" : ""), text: v }), h("div", { class: "n", text: n }));
  }

  function renderDash() {
    const months = monthList();
    if (!dashMonth || !months.includes(dashMonth)) dashMonth = months.includes(thisMonth()) ? thisMonth() : months[months.length - 1];
    const ym = dashMonth;
    monthChips($("#d-months"), ym, m => { dashMonth = m; renderDash(); });

    clear($("#d-tiles")).append(
      tile(`${monthLabel(ym)}の支出`, yen(monthSpend(ym)), `収入 ${yen(monthIncome(ym))}（振替を除く）`),
      tile("使えるお金", yen(D.liquid), `現金・預金・電子マネー（証券 ${yen(D.invest)} は除く）`),
      tile("カード未払い", yen(-D.debt), `${D.unpaid.filter(c => c.unpaid > 0).length}枚の合計`, true),
      tile("差し引き", yen(D.liquid - D.debt), "使えるお金 − カード未払い", D.liquid - D.debt < 0));

    const warns = [];
    if (D.unknown.length) warns.push(`口座.csv・カード.csvに無い口座名が取引にあります：${D.unknown.join("、")}`);
    for (const c of D.unpaid) if (c.unpaid < 0) warns.push(`${c.name} の未払いが計算上マイナス（${yen(c.unpaid)}）です。引落の二重記帳か、利用の記帳漏れかもしれません。`);
    const stale = D.inst.filter(x => x.state.startsWith("未払") && x.ym < thisMonth());
    if (stale.length) warns.push(`分割払い.csvに、請求月を過ぎても「未払」のままの行が${stale.length}件あります。`);
    if (D.skipped.length) warns.push(`取引.csvの読めなかった行：${D.skipped.slice(0, 5).join("、")}行目`);
    clear($("#d-warn")).append(...(warns.length ? [notice("warn", "確認が必要なこと", h("ul", { class: "small" }, warns.map(w => h("li", { text: w }))))] : []));

    // カテゴリ
    $("#d-cat-title").textContent = `${monthLabel(ym)}のカテゴリ別の支出`;
    const sums = new Map();
    for (const t of D.tx) if (t.d.startsWith(ym) && t.type === "支出" && t.cat !== "振替") sums.set(t.cat, (sums.get(t.cat) || 0) + t.amt);
    const cats = [...sums.entries()].sort((a, b) => b[1] - a[1]);
    const cbox = clear($("#d-cats"));
    if (!cats.length) cbox.append(h("p", { class: "desc", text: `${monthLabel(ym)}の支出はまだありません。` }));
    cats.forEach(([c, v]) => cbox.append(barRow(c, null, v, cats[0][1])));

    renderDaily(ym);

    // 口座
    const abox = clear($("#d-accounts"));
    const amax = Math.max(1, ...D.balances.map(a => Math.abs(a.bal)));
    D.balances.forEach(a => abox.append(barRow(a.name, a.kind, a.bal, amax, a.bal < 0 ? "neg" : "")));

    // カード
    const kbox = clear($("#d-cards"));
    const active = D.unpaid.filter(c => c.unpaid !== 0).sort((a, b) => b.unpaid - a.unpaid);
    const kmax = Math.max(1, ...active.map(c => Math.abs(c.unpaid)));
    active.forEach(c => kbox.append(barRow(c.name, `${c.payAcc.replace("銀行", "")} ${/^\d+$/.test(c.payDay) ? c.payDay + "日" : c.payDay}`, c.unpaid, kmax, c.unpaid < 0 ? "neg" : "")));
    const zero = D.unpaid.filter(c => c.unpaid === 0).map(c => c.name);
    if (zero.length) kbox.append(h("p", { class: "desc", text: "未払いなし：" + zero.join("、") }));

    renderInst();
    renderFuyou();
  }

  function renderDaily(ym) {
    $("#d-daily-title").textContent = `${monthLabel(ym)}の日別の支出`;
    const box = clear($("#d-daily")), detail = clear($("#d-daydetail"));
    const n = daysIn(ym), by = Array.from({ length: n }, () => ({ total: 0, items: [] }));
    for (const t of D.tx) if (t.d.startsWith(ym) && t.type === "支出" && t.cat !== "振替") {
      const x = by[+t.d.slice(8, 10) - 1]; x.total += t.amt; x.items.push(t);
    }
    const max = Math.max(...by.map(x => x.total));
    if (!max) { box.append(h("p", { class: "desc", text: `${monthLabel(ym)}の支出はまだありません。` })); return; }
    const step = max > 50000 ? 20000 : max > 20000 ? 10000 : 5000;
    const top = Math.ceil(max / step) * step;
    const grid = h("div", { class: "vgrid" });
    for (let v = step; v <= top; v += step) {
      const gl = h("div", { class: "gl" }, h("span", { text: (v / 1000) + "k" }));
      gl.style.bottom = (v / top * 100) + "%";
      grid.append(gl);
    }
    const gl0 = h("div", { class: "gl" }); gl0.style.bottom = "0"; grid.append(gl0);
    const bars = h("div", { class: "vbars" }), labels = h("div", { class: "vlabels" });
    const pick = (i, btn) => {
      for (const b of bars.children) b.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-pressed", "true");
      const x = by[i];
      clear(detail).append(h("div", { class: "meter-row" }, h("strong", { text: `${+ym.slice(5)}/${i + 1}` }), h("strong", { text: yen(x.total) })),
        x.items.length ? h("ul", { class: "txlist" }, x.items.map(txItem)) : h("p", { class: "desc", text: "支出なし" }));
    };
    by.forEach((x, i) => {
      const b = h("div", { class: "b" }); b.style.height = (x.total / top * 100) + "%";
      const btn = h("button", { type: "button", class: "vbar" + (x.total ? "" : " empty"), "aria-pressed": "false", "aria-label": `${i + 1}日 ${yen(x.total)}` }, b);
      btn.addEventListener("click", () => pick(i, btn));
      bars.append(btn);
      labels.append(h("span", { text: (i === 0 || (i + 1) % 5 === 0) ? String(i + 1) : "" }));
    });
    box.append(grid, bars, labels);
    const today = dayIso();
    const idx = today.startsWith(ym) ? +today.slice(8, 10) - 1 : by.findIndex(x => x.total === max);
    pick(idx, bars.children[idx]);
  }

  let instAll = false;
  function renderInst() {
    const box = clear($("#d-inst"));
    const left = D.inst.filter(x => x.state.startsWith("未払"));
    const by = new Map();
    for (const x of left) { if (!by.has(x.ym)) by.set(x.ym, []); by.get(x.ym).push(x); }
    const months = [...by.keys()].sort();
    if (!months.length) { $("#d-inst-desc").textContent = "未払いの分割払いはありません。"; return; }
    const total = left.reduce((s, x) => s + x.amt, 0);
    const last = months[months.length - 1];
    $("#d-inst-desc").textContent = `残り合計 ${yen(total)}・最後の請求は${last.slice(0, 4)}年${+last.slice(5)}月。月をタップすると内訳が出ます`;
    const sums = months.map(m => by.get(m).reduce((s, x) => s + x.amt, 0));
    const max = Math.max(...sums);
    const shown = instAll ? months : months.slice(0, 12);
    shown.forEach((m, i) => {
      const items = by.get(m).slice().sort((a, b) => b.amt - a.amt);
      box.append(h("details", null,
        h("summary", null, barRow(`${m.slice(0, 4)}年${+m.slice(5)}月`, `${items.length}件`, sums[i], max)),
        h("div", { class: "items" }, items.map(x => h("div", null, h("span", { text: `${x.item}（${x.card}）` }), h("span", { text: yen(x.amt) }))))));
    });
    if (months.length > 12) {
      box.append(h("button", { type: "button", class: "chip sm mt8", text: instAll ? "12か月だけ表示" : `すべて表示（${months.length}か月）`, onclick: () => { instAll = !instAll; renderInst(); } }));
    }
  }

  function renderFuyou() {
    const year = thisMonth().slice(0, 4);
    $("#d-fuyou-title").textContent = `扶養の壁（${year}年）`;
    const box = clear($("#d-fuyou"));
    const rows = D.sal.filter(x => x.ym.startsWith(year));
    if (!rows.length) { box.append(h("p", { class: "desc", text: "給与.csvに今年の記録がありません。" })); return; }
    const got = rows.filter(x => !x.forecast).reduce((s, x) => s + x.amt, 0);
    const fc = rows.filter(x => x.forecast).reduce((s, x) => s + x.amt, 0);
    box.append(h("div", { class: "meter-row" }, h("span", { text: `受取済み（${rows.filter(x => !x.forecast).length}回）` }), h("strong", { text: yen(got) })));
    if (fc) box.append(h("div", { class: "meter-row" }, h("span", { text: "見込み" }), h("strong", { text: "+" + yen(fc).replace("−", "") })));
    for (const [name, wall] of WALLS) {
      const f = h("div", { class: "f" }), f2 = h("div", { class: "f2" });
      f.style.width = Math.min(100, got / wall * 100) + "%";
      f2.style.left = Math.min(100, got / wall * 100) + "%";
      f2.style.width = Math.max(0, Math.min(100, (got + fc) / wall * 100) - Math.min(100, got / wall * 100)) + "%";
      box.append(
        h("div", { class: "meter-row" }, h("span", { text: `${name} ${yen(wall)}` }), h("span", null, "残り ", h("strong", { text: yen(wall - got - fc) }), fc ? "（見込み込み）" : "")),
        h("div", { class: "meter", role: "img", "aria-label": `${name}まで ${Math.round((got + fc) / wall * 100)}%` }, f, f2));
    }
  }

  // ---------- 明細 ----------
  let txMonth = null, txCat = "すべて";
  function renderTx() {
    const months = monthList();
    if (!txMonth || !months.includes(txMonth)) txMonth = months.includes(thisMonth()) ? thisMonth() : months[months.length - 1];
    monthChips($("#t-months"), txMonth, m => { txMonth = m; txCat = "すべて"; renderTx(); });
    const q = $("#t-search").value.trim().toLowerCase();
    const base = q ? D.tx.filter(t => (t.memo + " " + t.acc + " " + t.cat).toLowerCase().includes(q)) : D.tx.filter(t => t.d.startsWith(txMonth));
    const cats = ["すべて", ...new Set(base.map(t => t.cat))];
    if (!cats.includes(txCat)) txCat = "すべて";
    const cbox = clear($("#t-cats"));
    cats.forEach(c => cbox.append(h("button", { type: "button", class: "chip sm", "aria-pressed": String(c === txCat), text: c, onclick: () => { txCat = c; renderTx(); } })));
    const list = base.filter(t => txCat === "すべて" || t.cat === txCat).slice().sort((a, b) => b.d.localeCompare(a.d));
    const spend = list.filter(t => t.type === "支出" && t.cat !== "振替").reduce((s, t) => s + t.amt, 0);
    $("#t-count").textContent = `${q ? "全期間で検索" : monthLabel(txMonth)}：${list.length}件・支出計 ${yen(spend)}（振替を除く）`;
    const ul = clear($("#t-list"));
    list.slice(0, 300).forEach(t => ul.append(txItem(t)));
    if (list.length > 300) ul.append(h("li", null, h("div", { class: "sub", text: `ほか${list.length - 300}件（検索で絞り込んでください）` })));
  }

  // ---------- 設定 ----------
  function fillSettings() {
    $("#s-repo").value = S?.repo || "";
    $("#s-branch").value = S?.branch || "";
    $("#s-dir").value = S ? S.dir : "家計簿";
    $("#s-token").value = S?.token || "";
  }
  let clearArmed = false;
  async function saveSettings() {
    const msg = clear($("#s-msg"));
    const repo = $("#s-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
    const token = $("#s-token").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { msg.append(notice("err", "リポジトリは「持ち主/名前」の形で入れてください")); return; }
    if (!token) { msg.append(notice("err", "トークンを入れてください")); return; }
    S = { repo, branch: $("#s-branch").value.trim() || "main", dir: $("#s-dir").value.trim().replace(/^\/|\/$/g, ""), token };
    const kept = store.set("settings", S);
    $("#s-save").disabled = true;
    try {
      await reload();
      msg.append(notice("ok", "接続できました", `取引 ${D.tx.length}件・口座 ${D.acc.length}・カード ${D.cards.length}を読み込みました。`,
        kept ? "" : " ※この端末では保存できないため、ページを閉じると設定が消えます。"));
    } catch (e) {
      msg.append(notice("err", "接続できませんでした", e.message || String(e)));
    } finally { $("#s-save").disabled = false; }
  }
  function clearSettings() {
    const b = $("#s-clear");
    if (!clearArmed) {
      clearArmed = true; b.textContent = "もう一度押すと消します";
      setTimeout(() => { clearArmed = false; b.textContent = "この端末から接続情報を消す"; }, 4000);
      return;
    }
    clearArmed = false; b.textContent = "この端末から接続情報を消す";
    store.del("settings"); store.del("last");
    S = null; D = null; fillSettings();
    clear($("#s-msg")).append(notice("ok", "消しました", "この端末には接続情報が残っていません。"));
    setStatus("未接続");
  }

  // ---------- 読み込み ----------
  let loading = false;
  async function reload() {
    if (!S || loading) return;
    loading = true; $("#reload").disabled = true; setStatus("読み込み中…");
    try {
      await loadAll();
      const t = D.loadedAt;
      setStatus(`${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")} 時点`);
      render();
    } catch (e) {
      setStatus("読み込めませんでした");
      throw e;
    } finally { loading = false; $("#reload").disabled = false; }
  }
  async function reloadSafe() {
    try { await reload(); } catch (e) { toast(e.message || String(e)); }
  }

  // ---------- 起動 ----------
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => show(b.dataset.view));
  for (const b of document.querySelectorAll(".seg button")) b.addEventListener("click", () => setMode(b.dataset.mode));
  for (const b of document.querySelectorAll("[data-day]")) b.addEventListener("click", () => { $("#f-date").value = dayIso(Number(b.dataset.day)); F.dupOk = false; update(); });
  for (const id of ["#f-amount", "#f-memo", "#f-cat-custom"]) $(id).addEventListener("input", () => { if (id === "#f-amount") F.dupOk = false; update(); });
  for (const id of ["#f-date", "#f-account", "#f-from", "#f-to"]) $(id).addEventListener("change", () => { F.dupOk = false; update(); });
  $("#f-submit").addEventListener("click", submit);
  $("#t-search").addEventListener("input", () => renderTx());
  $("#reload").addEventListener("click", reloadSafe);
  $("#s-save").addEventListener("click", saveSettings);
  $("#s-clear").addEventListener("click", clearSettings);
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (S && hiddenAt && Date.now() - hiddenAt > 120000 && !F.busy) reloadSafe();
  });

  fillSettings();
  if (!S) {
    setStatus("未接続");
    show("settings");
    $("#s-msg").append(notice("warn", "最初に接続の設定をしてください", "GitHubのリポジトリとアクセストークンを入れると使えるようになります。"));
  } else {
    show("input");
    reloadSafe();
  }
})();
