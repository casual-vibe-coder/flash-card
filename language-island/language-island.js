// Language Island — Arabic immersion capsule.
// Usage:
//   import { mount } from "./src/language-island.js";
//   const island = mount("#island-root", { apiKey: "sk-ant-..." , onClose: () => island.destroy() });
//
// See README.md for the full config reference and integration examples.

import { BOOKS } from "./data/units.js";
import { LEVELS } from "./data/levels.js";
import { SEED } from "./data/seed.js";
import { createGenerator } from "./core/generator.js";
import { createStore } from "./core/store.js";
import { STYLES, FONT_HREF } from "./ui/styles.js";
import { TEMPLATE, escapeHtml } from "./ui/template.js";

const DEFAULTS = {
  title: "Language Island",
  units: BOOKS,            // override to change/limit topics
  levels: LEVELS,          // override to change difficulty tiers
  seed: SEED,              // offline starter sets, keyed "<book>-<unit>:<levelId>"
  batch: 6,                // default questions added per "generate"
  vocab: null,             // array of known words, OR (levelId) => string[] — personalizes generation
  apiKey: null,            // your Anthropic key (enables built-in generation outside Claude)
  model: "claude-sonnet-4-6",
  endpoint: "https://api.anthropic.com/v1/messages",
  maxTokens: 1024,         // raise when using your own key for bigger batches
  generate: null,          // override: async ({unitAr,unitEn,level,count,vocab}) => [{q,a,en}]
  store: null,             // override: async { get, set, remove }
  storePrefix: "language-island:qa:",
  onClose: null,           // called when the ✕ button is tapped
};

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  if (FONT_HREF && !document.querySelector("link[data-li-fonts]")) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = FONT_HREF; l.setAttribute("data-li-fonts", "");
    document.head.appendChild(l);
  }
  const s = document.createElement("style");
  s.setAttribute("data-li-styles", ""); s.textContent = STYLES;
  document.head.appendChild(s);
  stylesInjected = true;
}

export function mount(root, userConfig = {}) {
  if (typeof root === "string") root = document.querySelector(root);
  if (!root) throw new Error("Language Island: mount target not found");
  injectStyles();
  const inst = new LanguageIsland(root, { ...DEFAULTS, ...userConfig });
  inst.init();
  return inst;
}

class LanguageIsland {
  constructor(root, config) {
    this.root = root;
    this.config = config;
    this.store = createStore(config.store);
    this.gen = config.generate ? { generate: config.generate } : createGenerator(config);
    this.s = { unitVal: null, levelId: null, mode: "flash", idx: 0, order: [], sets: {}, busy: false };
  }

  init() {
    this.root.classList.add("li-root");
    this.root.innerHTML = TEMPLATE(this.config);
    this._cache();
    this._populate();
    this._bind();
    this.s.unitVal = this.config.units[0].n + "-1";
    this.s.levelId = this.config.levels[0].id;
    this.el.unit.value = this.s.unitVal;
    this.el.level.value = this.s.levelId;
    this.el.batch.value = String(this.config.batch);
    this._levelDesc();
    this._loadCurrent();
  }

  _q(sel) { return this.root.querySelector(sel); }

  _cache() {
    const q = (s) => this.root.querySelector(s);
    this.el = {
      unit: q(".li-unit"), level: q(".li-level"), leveldesc: q(".li-leveldesc"),
      gen: q(".li-gen"), gen2: q(".li-gen2"), batch: q(".li-batch"),
      mFlash: q(".li-mode-flash"), mList: q(".li-mode-list"), status: q(".li-status"),
      flash: q(".li-flash"), cardInner: q(".li-cardinner"), empty: q(".li-empty"),
      counter: q(".li-counter"), doneBtn: q(".li-donebtn"),
      qAr: q(".li-qar"), qEn: q(".li-qen"), reveal: q(".li-reveal"),
      answer: q(".li-answer"), aAr: q(".li-aar"), speak: q(".li-speak"),
      prev: q(".li-prev"), next: q(".li-next"), shuffle: q(".li-shuffle"),
      list: q(".li-list"), close: q(".li-close"),
    };
  }

  _populate() {
    this.config.units.forEach((b) => {
      const g = document.createElement("optgroup"); g.label = b.name;
      b.units.forEach((u, i) => {
        const o = document.createElement("option");
        o.value = b.n + "-" + (i + 1);
        o.textContent = (i + 1) + ". " + u[0] + " · " + u[1];
        g.appendChild(o);
      });
      this.el.unit.appendChild(g);
    });
    this.config.levels.forEach((lv) => {
      const o = document.createElement("option"); o.value = lv.id; o.textContent = lv.name;
      this.el.level.appendChild(o);
    });
  }

  _unitInfo() {
    const [b, u] = this.s.unitVal.split("-").map(Number);
    return this.config.units.find((x) => x.n === b).units[u - 1];
  }
  _levelInfo() { return this.config.levels.find((l) => l.id === this.s.levelId); }
  _key() { return this.config.storePrefix + this.s.unitVal + ":" + this.s.levelId; }
  _set() { return this.s.sets[this._key()] || []; }
  _vocab() {
    const v = this.config.vocab;
    return typeof v === "function" ? (v(this.s.levelId) || []) : (v || []);
  }

  _bind() {
    const e = this.el;
    e.unit.addEventListener("change", (ev) => { this.s.unitVal = ev.target.value; this._loadCurrent(); });
    e.level.addEventListener("change", (ev) => { this.s.levelId = ev.target.value; this._levelDesc(); this._loadCurrent(); });
    e.gen.addEventListener("click", () => this._generate());
    e.gen2.addEventListener("click", () => this._generate());
    e.reveal.addEventListener("click", () => e.answer.classList.add("li-show"));
    e.doneBtn.addEventListener("click", () => { this._toggleDone(this.s.order[this.s.idx]); this._renderFlash(); });
    e.speak.addEventListener("click", () => { const p = this._set()[this.s.order[this.s.idx]]; if (p) this._speak(p.a); });
    e.prev.addEventListener("click", () => { if (this.s.idx > 0) { this.s.idx--; this._renderFlash(); } });
    e.next.addEventListener("click", () => { if (this.s.idx < this.s.order.length - 1) { this.s.idx++; this._renderFlash(); } });
    e.shuffle.addEventListener("click", () => {
      const o = this.s.order;
      for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
      this.s.idx = 0; this._renderFlash();
    });
    e.mFlash.addEventListener("click", () => this._mode("flash"));
    e.mList.addEventListener("click", () => this._mode("list"));
    e.list.addEventListener("click", (ev) => { const b = ev.target.closest(".li-rowcheck"); if (b) { this._toggleDone(+b.dataset.i); this._renderList(); } });
    if (e.close) e.close.addEventListener("click", () => { if (this.config.onClose) this.config.onClose(); });
  }

  async _loadStored(k) { try { return await this.store.get(k); } catch (_) { return null; } }
  async _saveStored(k, arr) { try { await this.store.set(k, arr); } catch (_) {} }

  async _loadCurrent() {
    const key = this._key();
    if (this.s.sets[key] === undefined) {
      let arr = await this._loadStored(key);
      if (!arr || !arr.length) {
        const seedKey = this.s.unitVal + ":" + this.s.levelId;
        arr = this.config.seed[seedKey] ? this.config.seed[seedKey].slice() : [];
      }
      this.s.sets[key] = arr;
    }
    this.s.idx = 0;
    this.s.order = this.s.sets[key].map((_, i) => i);
    this._render();
  }

  async _generate() {
    if (this.s.busy) return;
    this.s.busy = true;
    this._status(true, "Generating…"); this._genDisabled(true);
    try {
      const count = parseInt(this.el.batch.value, 10);
      const [ar, en] = this._unitInfo();
      const pairs = await this.gen.generate({ unitAr: ar, unitEn: en, level: this._levelInfo(), count, vocab: this._vocab() });
      const key = this._key();
      if (!this.s.sets[key]) this.s.sets[key] = [];
      const startLen = this.s.sets[key].length;
      this.s.sets[key] = this.s.sets[key].concat(pairs);
      this.s.order = this.s.sets[key].map((_, i) => i);
      await this._saveStored(key, this.s.sets[key]);
      if (this.s.mode === "flash") this.s.idx = startLen;
      this._render();
      this._status(false, "+" + pairs.length + " added · " + this.s.sets[key].length + " total");
    } catch (err) {
      this._status(false, err.message || "Generation failed", true);
    }
    this._genDisabled(false); this.s.busy = false;
  }

  _status(loading, msg, err) {
    const s = this.el.status;
    s.className = "li-status" + (err ? " li-err" : "");
    s.innerHTML = (loading ? '<span class="li-spin"></span>' : "") + (msg || "");
  }
  _genDisabled(d) { this.el.gen.disabled = d; this.el.gen2.disabled = d; }

  _render() {
    const set = this._set(); const has = set.length > 0;
    this.el.gen.textContent = has ? "✦ Generate more" : "✦ Generate questions";
    if (this.s.mode === "flash") {
      this.el.flash.style.display = "flex";
      this.el.list.classList.remove("li-show");
      this.el.cardInner.style.display = has ? "flex" : "none";
      this.el.empty.style.display = has ? "none" : "block";
      if (has) this._renderFlash();
    } else {
      this.el.flash.style.display = has ? "none" : "flex";
      this.el.cardInner.style.display = "none";
      this.el.empty.style.display = has ? "none" : "block";
      this.el.list.classList.toggle("li-show", has);
      if (has) this._renderList();
    }
  }

  _renderFlash() {
    const set = this._set();
    if (this.s.idx >= this.s.order.length) this.s.idx = 0;
    const p = set[this.s.order[this.s.idx]];
    const done = set.filter((x) => x.done).length;
    this.el.counter.textContent = (this.s.idx + 1) + " / " + this.s.order.length + (done ? "  ·  ✓" + done : "");
    this.el.qAr.textContent = p.q;
    this.el.qEn.textContent = p.en || "";
    this.el.aAr.textContent = p.a;
    this.el.answer.classList.remove("li-show");
    this.el.doneBtn.classList.toggle("li-on", !!p.done);
    this.el.doneBtn.textContent = p.done ? "✓ Done" : "○ Mark done";
    this.el.prev.disabled = this.s.idx === 0;
    this.el.next.disabled = this.s.idx === this.s.order.length - 1;
  }

  _renderList() {
    const set = this._set();
    this.el.list.innerHTML = set.map((p, i) => `
      <div class="li-row${p.done ? " li-done" : ""}">
        <div class="li-rowhead">
          <span class="li-num">${i + 1} / ${set.length}</span>
          <button class="li-rowcheck" data-i="${i}">${p.done ? "✓ Done" : "○ Mark done"}</button>
        </div>
        <div class="li-rq">${escapeHtml(p.q)}</div>
        <div class="li-rqen">${escapeHtml(p.en || "")}</div>
        <div class="li-ra">${escapeHtml(p.a)}</div>
      </div>`).join("");
  }

  _toggleDone(i) {
    const set = this._set();
    if (!set[i]) return;
    set[i].done = !set[i].done;
    this._saveStored(this._key(), set);
  }

  _mode(m) {
    this.s.mode = m;
    this.el.mFlash.classList.toggle("li-on", m === "flash");
    this.el.mList.classList.toggle("li-on", m === "list");
    this._render();
  }

  _levelDesc() { this.el.leveldesc.textContent = this._levelInfo().desc; }

  _speak(text) {
    try {
      if (!("speechSynthesis" in window)) return;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ar-SA"; u.rate = 0.9;
      const v = speechSynthesis.getVoices().find((v) => /ar/i.test(v.lang));
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  destroy() {
    this.root.innerHTML = "";
    this.root.classList.remove("li-root");
  }
}

export default { mount };
