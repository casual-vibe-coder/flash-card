// Markup for the capsule. Returns an HTML string injected into the mount root.
// All hooks are classes (.li-*) queried within the root, so multiple instances are safe.

export function TEMPLATE(config) {
  const title = escapeHtml(config.title || "Language Island");
  return `
  <div class="li-bar">
    <div class="li-bar-title">🏝️ ${title} <span class="li-bar-ar">جزيرة اللغة</span></div>
    <button class="li-close" title="Close" aria-label="Close">✕</button>
  </div>
  <p class="li-howto">Pick a unit and level, then <b>generate</b> a set. Read each question aloud, answer in your own words, then reveal the model answer. Every word is fully voweled. Tap <b>generate more</b> any time — sets and your ✓ marks are saved.</p>

  <div class="li-controls">
    <div><label class="li-lbl">Unit · الوحدة</label><select class="li-unit"></select></div>
    <div><label class="li-lbl">Level · المستوى</label><select class="li-level"></select></div>
  </div>
  <p class="li-leveldesc"></p>

  <div class="li-barrow">
    <button class="li-gen">✦ Generate questions</button>
    <span class="li-batchwrap">Per batch
      <select class="li-batch"><option>4</option><option>6</option><option>8</option><option>10</option></select>
    </span>
    <span class="li-seg">
      <button class="li-mode-flash li-on">Flashcard</button>
      <button class="li-mode-list">List</button>
    </span>
    <span class="li-status"></span>
  </div>

  <section class="li-flash">
    <div class="li-cardinner" style="display:none;">
      <div class="li-progress">
        <span class="li-counter">1 / 1</span>
        <button class="li-donebtn">○ Mark done</button>
      </div>
      <div class="li-qar"></div>
      <div class="li-qen"></div>
      <div class="li-revealzone">
        <button class="li-reveal">Reveal model answer · أظهر الإجابة</button>
        <div class="li-answer">
          <div class="li-ahead">
            <span class="li-atag">إجابة مقترحة · model answer</span>
            <button class="li-speak" title="Listen">🔊</button>
          </div>
          <div class="li-aar"></div>
        </div>
      </div>
      <div class="li-nav">
        <button class="li-prev">‹ Prev</button>
        <button class="li-shuffle">⤮ Shuffle</button>
        <button class="li-next">Next ›</button>
      </div>
    </div>
    <div class="li-empty">
      <span class="li-empty-ar">ابدأ بالتوليد</span>
      <p>No questions yet for this unit and level. Generate a set to begin.</p>
      <button class="li-gen li-gen2">✦ Generate questions</button>
    </div>
  </section>

  <section class="li-list"></section>
  `;
}

export function escapeHtml(s) {
  return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
