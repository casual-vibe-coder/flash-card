// All styles scoped under .li-root so they won't leak into your host app.
// Injected once on first mount. FONT_HREF is added to <head> automatically.

export const FONT_HREF =
  "https://fonts.googleapis.com/css2?family=Amiri:ital,wght@0,400;0,700;1,400&family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap";

export const STYLES = `
.li-root{--li-paper:#F7F4ED;--li-card:#FCFAF4;--li-ink:#20241F;--li-emerald:#15604A;--li-emerald-soft:#E7EFEA;--li-gold:#9A7430;--li-muted:#6F7268;--li-line:#E3DBCB;
  background:var(--li-paper);color:var(--li-ink);font-family:"Inter",system-ui,sans-serif;line-height:1.5;border:1px solid var(--li-line);border-radius:16px;padding:clamp(14px,3vw,26px);}
.li-root *{box-sizing:border-box;}
.li-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.li-bar-title{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:18px;}
.li-bar-ar{font-family:"Amiri",serif;direction:rtl;color:var(--li-muted);font-weight:400;font-size:18px;margin-right:6px;}
.li-close{background:none;border:1px solid var(--li-line);border-radius:8px;width:34px;height:34px;cursor:pointer;color:var(--li-muted);font-size:15px;}
.li-close:hover{border-color:var(--li-emerald);color:var(--li-emerald);}
.li-howto{color:var(--li-muted);font-size:13px;margin:0 0 16px;}
.li-howto b{color:var(--li-ink);font-weight:600;}
.li-controls{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;}
.li-lbl{font-family:"Space Grotesk",sans-serif;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--li-muted);display:block;margin-bottom:5px;}
.li-root select{width:100%;font-family:"Inter",sans-serif;font-size:14.5px;color:var(--li-ink);background:var(--li-card);border:1px solid var(--li-line);border-radius:9px;padding:10px 11px;appearance:none;cursor:pointer;}
.li-leveldesc{font-size:12.5px;color:var(--li-muted);margin:-2px 0 14px;min-height:1.1em;}
.li-barrow{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px;}
.li-gen{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:14px;background:var(--li-emerald);color:#fff;border:0;border-radius:10px;padding:12px 18px;cursor:pointer;}
.li-gen:hover{background:#124e3c;}
.li-gen:disabled{opacity:.55;cursor:default;}
.li-batchwrap{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--li-muted);}
.li-batchwrap select{width:auto;padding:8px 10px;}
.li-seg{display:inline-flex;border:1px solid var(--li-line);border-radius:9px;overflow:hidden;background:var(--li-card);}
.li-seg button{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:13px;border:0;background:transparent;color:var(--li-muted);padding:10px 15px;cursor:pointer;}
.li-seg button.li-on{background:var(--li-emerald);color:#fff;}
.li-status{font-size:13px;color:var(--li-muted);margin-left:auto;}
.li-status.li-err{color:#a23;}
.li-spin{display:inline-block;width:13px;height:13px;border:2px solid #cfe1d8;border-top-color:var(--li-emerald);border-radius:50%;animation:li-sp .7s linear infinite;vertical-align:-2px;margin-right:6px;}
@keyframes li-sp{to{transform:rotate(360deg)}}
.li-flash{background:var(--li-card);border:1px solid var(--li-line);border-top:4px solid var(--li-emerald);border-radius:14px;padding:22px 18px;min-height:240px;display:flex;flex-direction:column;}
.li-cardinner{display:flex;flex-direction:column;flex:1;}
.li-progress{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.li-counter{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:14px;color:var(--li-emerald);}
.li-donebtn{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:12.5px;border:1px solid var(--li-line);background:var(--li-card);color:var(--li-muted);border-radius:20px;padding:6px 13px;cursor:pointer;}
.li-donebtn:hover{border-color:var(--li-emerald);color:var(--li-emerald);}
.li-donebtn.li-on{background:var(--li-emerald);border-color:var(--li-emerald);color:#fff;}
.li-qar{font-family:"Amiri",serif;direction:rtl;text-align:right;font-size:clamp(23px,6vw,31px);line-height:1.85;color:var(--li-ink);}
.li-qen{color:var(--li-muted);font-size:13.5px;margin-top:8px;text-align:right;direction:rtl;}
.li-revealzone{margin-top:auto;padding-top:18px;}
.li-reveal{width:100%;font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:14px;background:var(--li-emerald-soft);color:var(--li-emerald);border:1px solid #cfe1d8;border-radius:10px;padding:13px;cursor:pointer;}
.li-reveal:hover{background:#dcebe4;}
.li-answer{border-top:1px dashed var(--li-line);margin-top:16px;padding-top:14px;display:none;}
.li-answer.li-show{display:block;}
.li-ahead{display:flex;justify-content:space-between;align-items:center;flex-direction:row-reverse;margin-bottom:4px;}
.li-atag{font-family:"Space Grotesk",sans-serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--li-gold);}
.li-aar{font-family:"Amiri",serif;direction:rtl;text-align:right;font-size:clamp(20px,5.2vw,27px);line-height:1.95;color:var(--li-ink);}
.li-speak{background:none;border:0;cursor:pointer;font-size:16px;color:var(--li-muted);padding:2px 6px;border-radius:6px;}
.li-speak:hover{color:var(--li-emerald);background:var(--li-emerald-soft);}
.li-nav{display:flex;gap:10px;margin-top:16px;}
.li-nav button{flex:1;font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:14px;background:var(--li-card);color:var(--li-ink);border:1px solid var(--li-line);border-radius:10px;padding:13px;cursor:pointer;}
.li-nav button:hover:not(:disabled){border-color:var(--li-emerald);color:var(--li-emerald);}
.li-nav button:disabled{opacity:.4;cursor:default;}
.li-nav .li-shuffle{flex:0 0 auto;}
.li-empty{text-align:center;color:var(--li-muted);margin:auto;padding:22px 8px;}
.li-empty-ar{font-family:"Amiri",serif;direction:rtl;font-size:23px;color:var(--li-ink);display:block;margin-bottom:10px;}
.li-empty p{font-size:14px;max-width:42ch;margin:0 auto 16px;}
.li-list{display:none;}
.li-list.li-show{display:block;}
.li-row{background:var(--li-card);border:1px solid var(--li-line);border-right:4px solid var(--li-emerald);border-radius:11px;padding:14px 16px;margin-bottom:11px;}
.li-row.li-done{border-right-color:var(--li-gold);background:#fbfdfa;}
.li-rowhead{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;}
.li-num{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:12px;color:var(--li-muted);}
.li-rowcheck{font-family:"Space Grotesk",sans-serif;font-weight:600;font-size:11.5px;border:1px solid var(--li-line);background:var(--li-card);color:var(--li-muted);border-radius:20px;padding:4px 11px;cursor:pointer;}
.li-rowcheck:hover{border-color:var(--li-emerald);color:var(--li-emerald);}
.li-row.li-done .li-rowcheck{background:var(--li-emerald);border-color:var(--li-emerald);color:#fff;}
.li-rq{font-family:"Amiri",serif;direction:rtl;text-align:right;font-size:21px;line-height:1.9;margin-top:3px;}
.li-rqen{color:var(--li-muted);font-size:12px;text-align:right;direction:rtl;margin-top:2px;}
.li-ra{font-family:"Amiri",serif;direction:rtl;text-align:right;font-size:20px;line-height:1.95;color:var(--li-emerald);margin-top:9px;padding-top:9px;border-top:1px dashed var(--li-line);}
@media (max-width:560px){.li-controls{grid-template-columns:1fr;}.li-status{margin-left:0;width:100%;}}
@media (prefers-reduced-motion:reduce){.li-spin{animation:none;}}
`;
