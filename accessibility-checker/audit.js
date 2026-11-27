/*
 * Accessibility checker: in-page audit against WCAG 2.2 AA.
 *
 * Run the whole file in the rendered page (Claude in Chrome's javascript_tool,
 * the DevTools console, or a <script> tag). It evaluates to a JSON string and
 * installs these helpers on window:
 *
 *   __a11yAudit              the last result, as an object
 *   __a11yMark(true|false)   draw (or remove) numbered badges on flagged elements
 *   __a11yFocusInfo()        describe the focused element; call after each Tab press
 *   __a11yTabReset()         clear the Tab log before a new keyboard walk
 *   __a11yMotionSnapshot()   record positions, transforms, text and images...
 *   __a11yMotionCompare()    ...and, a few seconds later, report what moved by itself
 *
 * Findings are leads to verify, not verdicts. The audit changes nothing in the
 * page except: it briefly focuses elements to compare their focus styles (the
 * previous focus is restored), and __a11yMark adds an overlay.
 * Limits: closed shadow roots and cross-origin iframes are not inspected.
 */
(() => {
  'use strict';
  const W = window;
  const D = document;
  const OVERLAY = 'data-a11y-checker';
  // WCAG 2.2 AA thresholds (from the success criteria themselves).
  const TEXT_MIN = 4.5;           // 1.4.3 normal text
  const LARGE_TEXT_MIN = 3;       // 1.4.3 large text
  const NON_TEXT_MIN = 3;         // 1.4.11 control edges, focus rings, icons
  const LARGE_PX = 24;            // 18pt at 96 CSS px per inch
  const LARGE_BOLD_PX = 18.66;    // 14pt bold
  const BOLD_WEIGHT = 700;
  const TARGET_PX = 24;           // 2.5.8 minimum target size and spacing
  const MOTION_LIMIT_MS = 5000;   // 2.2.2: motion lasting more than 5 seconds needs a pause
  // Output and performance budgets: keep the JSON readable and the run under a few seconds.
  const MAX_PER_RULE = 20;        // instances listed per rule (count still covers all)
  const MAX_ELEMENTS = 15000;     // bigger DOMs are almost always repeated list items
  const MAX_TEXT_ELEMENTS = 5000; // contrast checks; each costs a few style lookups
  const MAX_FOCUS_TESTS = 200;    // focusing elements can trigger page scripts, so cap it
  const MAX_TARGETS = 500;        // target spacing is pairwise (n²)
  const MAX_MOTION_ELEMENTS = 8000;
  const MOVE_TOLERANCE_PX = 2;    // ignore sub-pixel layout jitter in the motion check
  const t0 = performance.now();

  // ---------- colour ----------
  const canvas = D.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const colourCache = new Map();

  function parseColour(str) {
    if (!str) return [0, 0, 0, 0];
    if (colourCache.has(str)) return colourCache.get(str);
    let v;
    const m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) {
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      v = [+m[1], +m[2], +m[3], a];
    } else if (str === 'transparent') {
      v = [0, 0, 0, 0];
    } else {
      // oklch(), color(display-p3 ...), lab() etc: let the canvas convert to sRGB.
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = str;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      v = [d[0], d[1], d[2], d[3] / 255];
    }
    colourCache.set(str, v);
    return v;
  }
  function blend(fg, bg) {
    const a = fg[3] + bg[3] * (1 - fg[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map(i => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / a).concat(a);
  }
  function lum(c) {
    const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function ratio(a, b) {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  const round2 = n => Math.floor(n * 100) / 100; // floor so 4.499 never shows as 4.5
  function hex(c) {
    return '#' + c.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }
  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToRgb([h, s, l]) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }
  // Nearest colour with the same hue and saturation that reaches `need` against bg.
  function suggest(fg, bg, need) {
    const hsl = rgbToHsl(fg);
    // 0.179 is the luminance where black and white give equal contrast, so it decides the direction.
    const towardDark = lum(bg) > 0.179;
    for (let i = 1; i <= 100; i++) {
      const l = towardDark ? hsl[2] - i / 100 : hsl[2] + i / 100;
      if (l < 0 || l > 1) break;
      const c = hslToRgb([hsl[0], hsl[1], l]);
      if (ratio(c, bg) >= need) return hex(c);
    }
    return towardDark ? '#000000' : '#ffffff';
  }

  // ---------- element helpers ----------
  const esc = s => (W.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const uniqueId = el => el.id && D.querySelectorAll('#' + esc(el.id)).length === 1;
  function sel(el) {
    if (!el || el.nodeType !== 1) return '';
    if (uniqueId(el)) return '#' + esc(el.id);
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== D.documentElement && parts.length < 5) {
      if (n !== el && uniqueId(n)) { parts.unshift('#' + esc(n.id)); break; }
      let p = n.localName;
      const cls = [...n.classList].filter(c => /^[a-zA-Z_-][\w-]*$/.test(c) && c.length < 40).slice(0, 2);
      if (cls.length) p += '.' + cls.join('.');
      const par = n.parentElement;
      if (par) {
        const sib = [...par.children].filter(c => c.localName === n.localName);
        if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(n) + 1})`;
      }
      parts.unshift(p);
      n = par;
    }
    return parts.join(' > ');
  }
  function snip(el) {
    const h = el.outerHTML || '';
    let open = h.slice(0, h.indexOf('>') + 1);
    if (open.length > 180) open = open.slice(0, 180) + '…>';
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t ? `${open} ${t.slice(0, 60)}${t.length > 60 ? '…' : ''}` : open;
  }
  const inOverlay = el => !!(el.closest && el.closest('[' + OVERLAY + ']'));
  function rendered(el) {
    if (!el || el.nodeType !== 1 || inOverlay(el)) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function seen(el) { // rendered and not transparent
    if (!rendered(el)) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility({ opacityProperty: true, checkOpacity: true });
    return true;
  }
  function srOnly(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return true;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/rect\(\s*0/.test(cs.clip) || /inset\(\s*50%/.test(cs.clipPath)) return true;
      if (n === D.body) break;
    }
    return false;
  }
  const hiddenFromAT = el => !!el.closest('[aria-hidden="true"],[inert]');
  const opacityCache = new Map();
  function cumOpacity(el) {
    if (!el || el.nodeType !== 1) return 1;
    if (opacityCache.has(el)) return opacityCache.get(el);
    const v = parseFloat(getComputedStyle(el).opacity) * cumOpacity(el.parentElement);
    opacityCache.set(el, v);
    return v;
  }
  const bgCache = new Map();
  // Background behind el, composited from ancestors' background colours.
  function bgOf(el) {
    if (bgCache.has(el)) return bgCache.get(el);
    const layers = [];
    let uncertain = null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (!uncertain && cs.backgroundImage && cs.backgroundImage !== 'none') {
        uncertain = (cs.backgroundImage.includes('gradient') ? 'gradient background on ' : 'background image on ') + sel(n);
      }
      if (!uncertain && cs.backdropFilter && cs.backdropFilter !== 'none') uncertain = 'backdrop-filter on ' + sel(n);
      const c = parseColour(cs.backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let base = [255, 255, 255, 1]; // canvas default
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    const res = { color: base, uncertain };
    bgCache.set(el, res);
    return res;
  }
  // Is el painted over something that is not one of its ancestors (a hero image, a video)?
  function overlayUnder(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 20), y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    const stack = D.elementsFromPoint(x, y);
    const i0 = stack.indexOf(el);
    if (i0 < 0) return null;
    for (let i = i0 + 1; i < stack.length; i++) {
      const n = stack[i];
      if (inOverlay(n)) continue;
      const cs = getComputedStyle(n);
      const opaque = parseColour(cs.backgroundColor)[3] >= 1;
      if (n.contains(el)) { if (opaque || cs.backgroundImage !== 'none') return null; continue; }
      if (/^(img|video|canvas|svg|picture|iframe|object|embed)$/.test(n.localName) || cs.backgroundImage !== 'none') return 'text sits over ' + n.localName + ' ' + sel(n);
      if (opaque) return 'text sits over another element ' + sel(n);
    }
    return null;
  }

  // ---------- roles and names ----------
  const ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox comment complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc graphics-document graphics-object graphics-symbol').split(' '));
  const sectioning = el => !!el.parentElement && !!el.parentElement.closest('article,aside,main,nav,section');
  function role(el) {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit) return explicit;
    switch (el.localName) {
      case 'a': case 'area': return el.hasAttribute('href') ? 'link' : '';
      case 'button': case 'summary': return 'button';
      case 'input': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        return { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox', number: 'spinbutton', hidden: '' }[t] ?? 'textbox';
      }
      case 'select': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'header': return sectioning(el) ? '' : 'banner';
      case 'footer': return sectioning(el) ? '' : 'contentinfo';
      case 'form': return 'form';
      case 'search': return 'search';
      case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      case 'dialog': return 'dialog';
      case 'iframe': return 'iframe';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      default: return '';
    }
  }
  const NAME_FROM_CONTENT = /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|option|checkbox|radio|switch|heading|treeitem|cell|gridcell|columnheader|rowheader|tooltip|row)$/;
  const PUA = /[-]/g; // icon-font glyphs: screen readers read nothing useful
  function pseudo(el, which) {
    const c = getComputedStyle(el, which).content;
    if (!c || c === 'none' || c === 'normal') return '';
    const m = c.match(/^"(.*)"$/);
    return m ? m[1].replace(PUA, '') : '';
  }
  function textOf(node, depth) {
    let s = node.nodeType === 1 ? pseudo(node, '::before') : '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { s += c.textContent; continue; }
      if (c.nodeType !== 1 || c.getAttribute('aria-hidden') === 'true') continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (/^(img|svg|input|select|textarea)$/.test(c.localName) || c.hasAttribute('aria-label') || c.hasAttribute('aria-labelledby')) s += ' ' + nameOf(c, depth + 1) + ' ';
      else s += ' ' + textOf(c, depth + 1) + ' ';
    }
    if (node.nodeType === 1) s += pseudo(node, '::after');
    return s.replace(PUA, '').replace(/\s+/g, ' ').trim();
  }
  function nameOf(el, depth = 0) {
    if (depth > 4) return '';
    const lb = el.getAttribute('aria-labelledby');
    if (lb && depth === 0) {
      const t = lb.split(/\s+/).map(id => D.getElementById(id)).filter(Boolean).map(n => n.getAttribute('aria-label') || textOf(n, depth + 1)).join(' ').trim();
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const tag = el.localName;
    if (tag === 'img' || tag === 'area' || (tag === 'input' && el.type === 'image')) {
      const a = el.getAttribute('alt');
      if (a !== null) return a.trim();
    }
    if (tag === 'input' && /^(button|submit|reset)$/.test(el.type)) return (el.value || { submit: 'Submit', reset: 'Reset' }[el.type] || '').trim();
    if ((tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'meter' || tag === 'progress') && el.labels && el.labels.length) {
      const t = [...el.labels].map(l => textOf(l, depth + 1)).join(' ').trim();
      if (t) return t;
    }
    if (tag === 'svg') {
      const t = el.querySelector(':scope > title');
      if (t && t.textContent.trim()) return t.textContent.trim();
    }
    if (tag === 'fieldset') { const l = el.querySelector(':scope > legend'); if (l) return textOf(l, depth + 1); }
    if (tag === 'table') { const c = el.querySelector(':scope > caption'); if (c) return textOf(c, depth + 1); }
    if (tag === 'figure') { const c = el.querySelector(':scope > figcaption'); if (c) return textOf(c, depth + 1); }
    const r = role(el);
    if (NAME_FROM_CONTENT.test(r) || /^(a|button|summary|h[1-6]|label|legend|td|th|option)$/.test(tag) || depth > 0) {
      const t = textOf(el, depth);
      if (t) return t;
    }
    const ti = el.getAttribute('title');
    if (ti && ti.trim()) return ti.trim();
    if ((tag === 'input' || tag === 'textarea') && el.placeholder) return el.placeholder.trim();
    return '';
  }
  const labelled = el => !!(el.getAttribute('aria-label') || '').trim() || !!el.getAttribute('aria-labelledby') || (el.labels && [...el.labels].some(l => textOf(l, 1))) || !!(el.getAttribute('title') || '').trim();

  // ---------- result collection ----------
  const out = {
    tool: 'accessibility-checker audit.js', standard: 'WCAG 2.2 AA',
    url: location.href, title: D.title, ranAt: new Date().toISOString(),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio },
    summary: {}, errors: [], issues: [], document: {}, keyboard: {}, motion: {}, screenReader: {}, notes: [],
  };
  const rules = new Map();
  const marks = [];
  function add(rule, sc, severity, message, el, extra) {
    let r = rules.get(rule);
    if (!r) { r = { rule, sc, severity, message, count: 0, instances: [] }; rules.set(rule, r); }
    r.count++;
    if (r.instances.length >= MAX_PER_RULE) return;
    const inst = Object.assign({}, extra || {});
    if (el && el.nodeType === 1) {
      inst.mark = marks.length + 1;
      inst.selector = sel(el);
      inst.html = snip(el);
      marks.push({ n: inst.mark, el, severity, rule });
    }
    r.instances.push(inst);
  }
  const all = [...D.body.querySelectorAll('*')].filter(el => !inOverlay(el) && !(el.localName === 'div' && el.parentElement === D.body && !el.attributes.length && !el.childNodes.length)).slice(0, MAX_ELEMENTS);
  if (all.length >= MAX_ELEMENTS) out.notes.push(`Very large page: only the first ${MAX_ELEMENTS} elements were checked.`);

  let mains = [], controls = [], ordered = [], pauseControls = [];
  let focusTested = 0, contrastChecked = 0, contrastUncertain = 0;
  // Each check runs on its own: if one throws on an unusual page, the rest still run
  // and the failure is reported in `errors` instead of losing the whole audit.
  function section(name, fn) {
    try { fn(); } catch (e) { out.errors.push(`${name}: ${e && e.message ? e.message : e}. That check is incomplete; test it by hand.`); }
  }

  // ---------- document ----------
  section('document', () => {
  const lang = D.documentElement.getAttribute('lang');
  out.document.lang = lang;
  if (!lang || !lang.trim()) add('html-lang-missing', '3.1.1 Language of Page (A)', 'serious', 'The <html> element has no lang attribute, so screen readers may read the page in the wrong voice and pronunciation.');
  else if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(lang.trim())) add('html-lang-invalid', '3.1.1 Language of Page (A)', 'serious', 'The lang attribute is not a valid language tag.', null, { value: lang });
  if (!D.title.trim()) add('document-title', '2.4.2 Page Titled (A)', 'serious', 'The page has no <title>.');
  const vp = D.querySelector('meta[name="viewport"]');
  if (vp) {
    const c = (vp.getAttribute('content') || '').toLowerCase().replace(/\s/g, '');
    const max = c.match(/maximum-scale=([\d.]+)/);
    if (/user-scalable=(no|0)/.test(c) || (max && parseFloat(max[1]) < 2)) add('viewport-zoom-blocked', '1.4.4 Resize Text (AA)', 'critical', 'The viewport meta tag stops people pinch-zooming on mobile.', vp, { content: vp.getAttribute('content') });
  }

  });

  // ---------- headings, landmarks ----------
  section('headings, landmarks', () => {
  const headings = all.filter(el => role(el) === 'heading' && rendered(el) && !hiddenFromAT(el)).map(el => ({ el, level: parseInt(el.getAttribute('aria-level') || (el.localName.match(/^h([1-6])$/) || [, 2])[1], 10), text: nameOf(el) }));
  out.screenReader.headings = headings.slice(0, 80).map(h => `${'  '.repeat(h.level - 1)}h${h.level}: ${h.text.slice(0, 90) || '(empty)'}`);
  if (!headings.some(h => h.level === 1)) add('no-h1', '1.3.1 Info and Relationships (A) / 2.4.6 Headings and Labels (AA)', 'moderate', 'The page has no level-1 heading, so screen-reader users lose the quickest way to find the main content.');
  headings.forEach((h, i) => {
    if (!h.text) add('heading-empty', '2.4.6 Headings and Labels (AA)', 'moderate', 'A heading has no text, so it is announced as an empty heading.', h.el);
    if (i > 0 && h.level > headings[i - 1].level + 1) add('heading-skip', '1.3.1 Info and Relationships (A)', 'minor', 'A heading level is skipped, which makes the outline confusing to navigate (best practice; a failure only if it misrepresents the structure).', h.el, { from: 'h' + headings[i - 1].level, to: 'h' + h.level });
  });
  const LANDMARK = /^(banner|main|navigation|contentinfo|complementary|search|form|region)$/;
  const landmarks = all.filter(el => LANDMARK.test(role(el)) && rendered(el) && !hiddenFromAT(el) && (role(el) !== 'form' || labelled(el)));
  out.screenReader.landmarks = landmarks.slice(0, 40).map(el => { const n = (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && nameOf(el) || '').slice(0, 50); return `${role(el)}${n ? ' "' + n + '"' : ''} ${sel(el)}`; });
  mains = landmarks.filter(el => role(el) === 'main');
  if (!mains.length) add('no-main', '1.3.1 Info and Relationships (A) / 2.4.1 Bypass Blocks (A)', 'moderate', 'There is no <main> landmark, so screen-reader users cannot jump straight to the content.');
  if (mains.length > 1) add('multiple-main', '1.3.1 Info and Relationships (A)', 'moderate', 'There is more than one main landmark.', mains[1]);
  const navs = landmarks.filter(el => role(el) === 'navigation');
  if (navs.length > 1) navs.filter(n => !n.getAttribute('aria-label') && !n.getAttribute('aria-labelledby')).forEach(n => add('nav-unlabelled', '1.3.1 Info and Relationships (A)', 'minor', 'Several navigation landmarks without labels sound identical ("navigation") in a screen reader. Give each an aria-label (best practice).', n));
  out.screenReader.liveRegions = all.filter(el => el.hasAttribute('aria-live') || /^(status|alert|log|timer|marquee)$/.test(role(el))).slice(0, 20).map(el => `${role(el) || 'aria-live=' + el.getAttribute('aria-live')} ${sel(el)}`);
  const langParts = all.filter(el => el.hasAttribute('lang')).slice(0, 10).map(el => `${el.getAttribute('lang')} ${sel(el)}`);
  if (langParts.length) out.screenReader.languageChanges = langParts;

  });

  // ---------- ARIA validity ----------
  section('ARIA validity', () => {
  const ids = new Map();
  all.forEach(el => { if (el.id) ids.set(el.id, (ids.get(el.id) || 0) + 1); });
  all.forEach(el => {
    const r = el.getAttribute('role');
    if (r !== null) {
      const first = r.trim().split(/\s+/)[0];
      if (!first || !ROLES.has(first)) add('aria-role-invalid', '4.1.2 Name, Role, Value (A)', 'serious', 'An element has a role that does not exist, so assistive technology ignores it.', el, { role: r });
    }
    ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant'].forEach(a => {
      const v = el.getAttribute(a);
      if (!v) return;
      v.split(/\s+/).forEach(id => {
        if (!ids.has(id)) add('aria-ref-missing', '1.3.1 Info and Relationships (A) / 4.1.2 Name, Role, Value (A)', a === 'aria-labelledby' ? 'serious' : 'moderate', 'An ARIA attribute points at an id that is not on the page.', el, { attribute: a, id });
        else if (ids.get(id) > 1) add('aria-ref-duplicate-id', '1.3.1 Info and Relationships (A)', 'moderate', 'An ARIA attribute points at an id used more than once, so the wrong element may be read.', el, { attribute: a, id });
      });
    });
    const rr = role(el);
    const need = { checkbox: 'aria-checked', switch: 'aria-checked', radio: 'aria-checked', menuitemcheckbox: 'aria-checked', menuitemradio: 'aria-checked', slider: 'aria-valuenow', scrollbar: 'aria-valuenow', heading: null, combobox: 'aria-expanded', option: null }[rr];
    if (need && el.getAttribute('role') && !el.hasAttribute(need) && !/^(input)$/.test(el.localName)) add('aria-required-attr', '4.1.2 Name, Role, Value (A)', 'serious', 'A custom widget is missing the attribute that tells screen readers its state.', el, { role: rr, missing: need });
  });
  D.querySelectorAll('label[for]').forEach(l => {
    const id = l.getAttribute('for');
    if (id && ids.get(id) > 1) add('label-duplicate-id', '1.3.1 Info and Relationships (A)', 'serious', 'A label points at an id used more than once, so it may label the wrong field.', l, { for: id });
  });

  });

  // ---------- images ----------
  section('images', () => {
  all.forEach(el => {
    if (!rendered(el) || hiddenFromAT(el)) return;
    const tag = el.localName;
    if (tag === 'img') {
      if (el.closest('a,button') && nameOf(el.closest('a,button'))) { /* named by the control */ }
      const alt = el.getAttribute('alt');
      if (alt === null && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && el.getAttribute('role') !== 'presentation' && el.getAttribute('role') !== 'none') {
        add('img-alt-missing', '1.1.1 Non-text Content (A)', 'serious', 'An image has no alt attribute. Screen readers will read the file name or say "image". Add alt text, or alt="" if it is decorative.', el, { src: (el.currentSrc || el.src || '').slice(-80) });
      } else if (alt && (/\.(png|jpe?g|gif|svg|webp|avif)$/i.test(alt.trim()) || /^(image|img|photo|picture|graphic|icon|logo|banner|untitled|dsc_?\d+)$/i.test(alt.trim()))) {
        add('img-alt-meaningless', '1.1.1 Non-text Content (A)', 'moderate', 'The alt text does not describe the image.', el, { alt });
      }
    } else if (tag === 'input' && el.type === 'image' && !nameOf(el)) {
      add('input-image-alt', '1.1.1 Non-text Content (A)', 'critical', 'An image button has no alt text, so it has no name.', el);
    } else if (el.getAttribute('role') === 'img' && !nameOf(el)) {
      add('role-img-name', '1.1.1 Non-text Content (A)', 'serious', 'An element with role="img" has no accessible name.', el);
    } else if (tag === 'svg' && !el.closest('a,button,[role="button"],[role="link"],label,svg svg') && el.parentElement && el.parentElement.closest('svg') === null) {
      const r = el.getBoundingClientRect();
      if (!nameOf(el) && r.width >= TARGET_PX && r.height >= TARGET_PX && el.getAttribute('focusable') !== 'false') add('svg-check', '1.1.1 Non-text Content (A)', 'minor', 'A standalone SVG has no name and is not hidden. If it carries meaning give it role="img" and a name; if decorative add aria-hidden="true".', el);
    } else if ((tag === 'iframe' || tag === 'frame') && !nameOf(el)) {
      add('frame-title', '4.1.2 Name, Role, Value (A)', 'serious', 'An iframe has no title, so screen readers cannot say what it contains.', el, { src: (el.src || '').slice(0, 100) });
    }
  });
  out.notes.push('Images used as CSS backgrounds, text inside images, and whether each alt text actually fits its image can only be judged by looking.');

  });

  // ---------- controls, links, forms ----------
  section('controls, links, forms', () => {
  const CONTROL = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="radio"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="slider"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="spinbutton"],[role="listbox"],[role="treeitem"]';
  controls = all.filter(el => el.matches(CONTROL) && rendered(el) && !hiddenFromAT(el));
  const GENERIC = /^(click here|here|read more|more|learn more|find out more|see more|view more|details|more info|continue|link|go|this|click)$/i;
  const linkNames = new Map();
  controls.forEach(el => {
    const r = role(el);
    const n = nameOf(el);
    const field = /^(textbox|searchbox|combobox|listbox|spinbutton|slider|checkbox|radio|switch)$/.test(r) || /^(input|select|textarea)$/.test(el.localName);
    if (field && !(el.localName === 'input' && /^(button|submit|reset|image)$/.test(el.type))) {
      const namedByContent = el.getAttribute('role') && /^(checkbox|radio|switch)$/.test(r) && !!textOf(el, 1);
      if (!labelled(el) && !namedByContent) {
        if (el.placeholder) add('label-placeholder-only', '3.3.2 Labels or Instructions (A) / 1.3.1 (A)', 'serious', 'A form field is labelled only by placeholder text, which disappears when people type and is often low contrast.', el, { placeholder: el.placeholder });
        else add('label-missing', '4.1.2 Name, Role, Value (A) / 1.3.1 (A) / 3.3.2 (A)', 'critical', 'A form field has no label, so screen readers announce only "edit text" or similar.', el, { type: el.type || r });
      }
      if (el.localName === 'input' && /^(email|tel)$/.test(el.type) && !el.hasAttribute('autocomplete')) add('autocomplete-missing', '1.3.5 Identify Input Purpose (AA)', 'minor', 'A personal-details field has no autocomplete attribute. Check name, email, phone and address fields use the right autocomplete token.', el, { type: el.type });
      return;
    }
    if (!n) {
      add('control-name-missing', r === 'link' ? '2.4.4 Link Purpose (A) / 4.1.2 Name, Role, Value (A)' : '4.1.2 Name, Role, Value (A)', 'critical', `A ${r || el.localName} has no accessible name. Screen readers announce only "${r || 'button'}". Icon-only controls need an aria-label or visually hidden text.`, el);
      return;
    }
    if (r === 'link') {
      if (GENERIC.test(n.replace(/[.…→»›]+$/, '').trim())) add('link-generic', '2.4.4 Link Purpose (In Context) (A)', 'moderate', 'Link text like "read more" means nothing out of context (screen-reader users often list links on their own). Passes only if the surrounding sentence or list item makes it clear.', el, { text: n });
      const href = el.getAttribute('href');
      const key = n.toLowerCase();
      if (!linkNames.has(key)) linkNames.set(key, new Set());
      linkNames.get(key).add(href);
    }
    // 2.5.3 Label in Name: visible text should appear in the accessible name.
    const visible = textOf(el, 1).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    const nm = n.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    if (el.getAttribute('aria-label') && visible && visible.length > 2 && !nm.includes(visible)) add('label-in-name', '2.5.3 Label in Name (A)', 'serious', 'The accessible name does not contain the visible label, so voice-control users saying what they see will not activate it.', el, { visible: textOf(el, 1), name: n });
  });
  linkNames.forEach((hrefs, name) => { if (hrefs.size > 1 && GENERIC.test(name)) out.notes.push(`${hrefs.size} links are all called "${name}" but go to different places.`); });
  // Radio groups without a group
  const radios = new Map();
  all.forEach(el => { if (el.localName === 'input' && el.type === 'radio' && el.name) { if (!radios.has(el.name)) radios.set(el.name, []); radios.get(el.name).push(el); } });
  radios.forEach(group => { if (group.length > 1 && !group[0].closest('fieldset,[role="radiogroup"],[role="group"]')) add('radio-group', '1.3.1 Info and Relationships (A)', 'moderate', 'A set of radio buttons is not wrapped in a fieldset with a legend (or role="radiogroup" with a label), so the question they answer is not announced.', group[0], { name: group[0].name }); });
  // Data tables
  all.forEach(el => {
    if (el.localName !== 'table' || !rendered(el) || /^(presentation|none)$/.test(el.getAttribute('role') || '')) return;
    if (el.rows.length > 1 && el.rows[0].cells.length > 1 && !el.querySelector('th,[role="columnheader"],[role="rowheader"]')) add('table-headers', '1.3.1 Info and Relationships (A)', 'moderate', 'A table has no header cells (<th>). If it holds data, screen readers cannot say which column or row a cell belongs to. If it is for layout, add role="presentation".', el);
  });

  });

  // ---------- keyboard ----------
  section('keyboard', () => {
  const tabbables = all.filter(el => el.tabIndex >= 0 && (el.matches('a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable],audio[controls],video[controls]')) && !el.matches(':disabled') && !el.closest('[inert]') && rendered(el));
  const positive = tabbables.filter(el => el.tabIndex > 0);
  positive.forEach(el => add('tabindex-positive', '2.4.3 Focus Order (A)', 'serious', 'tabindex greater than 0 forces this element ahead of the normal order, which almost always makes the Tab order jump around.', el, { tabindex: el.tabIndex }));
  ordered = positive.sort((a, b) => a.tabIndex - b.tabIndex).concat(tabbables.filter(el => el.tabIndex === 0));
  out.keyboard.tabStops = ordered.length;
  out.keyboard.expectedOrder = ordered.slice(0, 60).map((el, i) => {
    const r = el.getBoundingClientRect();
    return `${i + 1}. ${role(el) || el.localName} "${nameOf(el).slice(0, 50)}" at (${Math.round(r.left + scrollX)},${Math.round(r.top + scrollY)}) ${sel(el)}`;
  });
  const firstLink = ordered[0];
  out.keyboard.firstTabStop = firstLink ? `${role(firstLink)} "${nameOf(firstLink).slice(0, 50)}" ${firstLink.getAttribute('href') || ''}` : null;
  const hasSkip = ordered.slice(0, 3).some(el => /^#./.test(el.getAttribute('href') || '') && /skip|jump|main|content/i.test(nameOf(el)));
  out.keyboard.skipLink = hasSkip;
  const navLinks = all.filter(el => el.matches('header a[href], nav a[href], [role="banner"] a[href], [role="navigation"] a[href]')).length;
  if (!hasSkip && navLinks >= 5) add('skip-link-missing', '2.4.1 Bypass Blocks (A)', mains.length ? 'minor' : 'serious', `No "skip to content" link before ${navLinks} header and navigation links. Keyboard users must Tab through all of them on every page. A main landmark helps screen-reader users but not sighted keyboard users.`);
  // Focusable things screen readers can't see
  all.forEach(el => {
    if (el.getAttribute('aria-hidden') !== 'true') return;
    const inside = [el, ...el.querySelectorAll('*')].filter(n => n.tabIndex >= 0 && n.matches('a[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]') && !n.matches(':disabled') && rendered(n));
    inside.slice(0, 3).forEach(n => add('aria-hidden-focusable', '4.1.2 Name, Role, Value (A) / 1.3.1 (A)', 'serious', 'A keyboard-focusable element is inside aria-hidden="true". Keyboard users land on it but screen readers say nothing. Add inert, or tabindex="-1", to hidden content.', n));
  });
  // Mouse-only controls: something looks clickable but isn't keyboard-reachable.
  const native = 'a[href],button,input,select,textarea,summary,label,option,area[href],video,audio,iframe,details';
  all.forEach(el => {
    if (el.matches(native) || el.tabIndex >= 0 || el.closest(native) || !rendered(el) || hiddenFromAT(el)) return;
    const r = role(el);
    const widget = /^(button|link|checkbox|switch|radio|tab|menuitem|option|slider|treeitem|combobox)$/.test(r) && el.getAttribute('role');
    const onclick = el.hasAttribute('onclick');
    let pointer = false;
    if (!widget && !onclick) {
      const cs = getComputedStyle(el);
      pointer = cs.cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
    }
    if (widget && /^(option|menuitem|tab|treeitem|radio)$/.test(r) && el.closest('[aria-activedescendant],[role="listbox"],[role="menu"],[role="tablist"],[role="tree"],[role="radiogroup"]')) return; // roving focus managed by the container
    if (widget || onclick) add('not-keyboard-reachable', '2.1.1 Keyboard (A)', 'critical', 'This looks like a control (it has a widget role or a click handler) but cannot be reached with Tab. Use a real <button> or <a href>, or add tabindex="0" plus Enter/Space handling.', el, { role: r || null });
    else if (pointer && textOf(el, 1).length < 80) add('pointer-not-focusable', '2.1.1 Keyboard (A)', 'serious', 'Shows a pointer (hand) cursor but cannot be reached with Tab. Probably a click-only control; try it during the keyboard walk.', el);
  });

  });

  // ---------- focus styles (programmatic; confirm in the Tab walk) ----------
  section('focus styles', () => {
  const FOCUS_PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderTopColor', 'borderBottomColor', 'borderTopWidth', 'borderBottomWidth', 'backgroundColor', 'color', 'textDecorationLine', 'transform', 'filter', 'opacity'];
  const snap = (el, p) => { const cs = getComputedStyle(el, p); return FOCUS_PROPS.map(k => cs[k]).join('|'); };
  const fullSnap = el => [snap(el), snap(el, '::before'), snap(el, '::after'), el.parentElement ? snap(el.parentElement) : '', el.firstElementChild ? snap(el.firstElementChild) : ''].join('#');
  const prevFocus = D.activeElement;
  try {
  for (const el of ordered.slice(0, MAX_FOCUS_TESTS)) {
    if (el.localName === 'iframe') continue;
    const before = fullSnap(el);
    try { el.focus({ preventScroll: true, focusVisible: true }); } catch (e) { continue; }
    if (D.activeElement !== el) continue;
    focusTested++;
    const after = fullSnap(el);
    const cs = getComputedStyle(el);
    if (before === after) {
      add('focus-not-visible', '2.4.7 Focus Visible (AA)', 'serious', 'No style changes when this element is focused, so keyboard users cannot see where they are. Confirm during the Tab walk (the screenshot is the evidence).', el);
    } else if (cs.outlineStyle !== 'none' && cs.outlineStyle !== 'auto' && parseFloat(cs.outlineWidth) > 0) {
      const oc = parseColour(cs.outlineColor);
      const bg = bgOf(el.parentElement || el).color;
      const rr = ratio(blend(oc, bg), bg);
      if (rr < NON_TEXT_MIN) add('focus-indicator-contrast', '1.4.11 Non-text Contrast (AA)', 'moderate', 'The focus outline has less than 3:1 contrast with the background around it.', el, { ratio: round2(rr), outline: hex(oc), background: hex(bg), suggest: suggest(oc, bg, NON_TEXT_MIN) });
    }
  }
  } finally {
  try {
    if (prevFocus && prevFocus !== D.body && prevFocus.focus) prevFocus.focus({ preventScroll: true });
    else if (D.activeElement && D.activeElement.blur) D.activeElement.blur();
  } catch (e) { /* the page may have removed the element; nothing to restore */ }
  }
  out.keyboard.focusStylesTested = focusTested;

  });

  // ---------- target size (2.5.8, AA in 2.2) ----------
  section('target size', () => {
  const targets = controls.filter(el => {
    if (!seen(el)) return false;
    if (el.localName === 'a' && el.closest('p,li,td,dd,blockquote') && (el.closest('p,li,td,dd,blockquote').textContent.trim().length > nameOf(el).length + 15)) return false; // inline link: exempt
    return true;
  }).slice(0, MAX_TARGETS).map(el => ({ el, r: el.getBoundingClientRect() }));
  targets.forEach(({ el, r }) => {
    if (r.width >= TARGET_PX && r.height >= TARGET_PX) return;
    if (el.localName === 'input' && /^(checkbox|radio)$/.test(el.type) && el.labels && el.labels.length) return; // label enlarges the target
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const crowded = targets.some(o => o.el !== el && !o.el.contains(el) && !el.contains(o.el) && Math.hypot(o.r.left + o.r.width / 2 - cx, o.r.top + o.r.height / 2 - cy) < TARGET_PX);
    if (crowded) add('target-size', '2.5.8 Target Size (Minimum) (AA)', 'moderate', 'A control is smaller than 24×24 px and sits within 24 px of another control, so it is easy to hit the wrong one.', el, { size: `${Math.round(r.width)}×${Math.round(r.height)}` });
  });

  });

  // ---------- colour contrast ----------
  section('colour contrast', () => {
  const textEls = new Set();
  const walker = D.createTreeWalker(D.body, NodeFilter.SHOW_TEXT, { acceptNode: n => (/\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  while (walker.nextNode() && textEls.size < MAX_TEXT_ELEMENTS) {
    const el = walker.currentNode.parentElement;
    if (el && !/^(script|style|noscript|template|option|title)$/.test(el.localName)) textEls.add(el);
  }
  textEls.forEach(el => {
    if (inOverlay(el) || !seen(el) || srOnly(el)) return;
    if (el.closest(':disabled,[aria-disabled="true"]')) return; // disabled controls are exempt
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (!size) return;
    let fg = parseColour(cs.color);
    let uncertain = null;
    const fill = cs.webkitTextFillColor;
    if (fill && fill !== cs.color) { const f = parseColour(fill); if (f[3] === 0) uncertain = 'gradient or image text (background-clip: text)'; else fg = f; }
    fg = [fg[0], fg[1], fg[2], fg[3] * cumOpacity(el)];
    const bgInfo = bgOf(el);
    const bg = bgInfo.color;
    const fgOnBg = blend(fg, bg);
    const r = ratio(fgOnBg, bg);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= LARGE_PX || (size >= LARGE_BOLD_PX && weight >= BOLD_WEIGHT);
    const need = large ? LARGE_TEXT_MIN : TEXT_MIN;
    uncertain = uncertain || bgInfo.uncertain || overlayUnder(el);
    contrastChecked++;
    const detail = { text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50), ratio: round2(r), required: need, text_colour: hex(fgOnBg), background: hex(bg), font: `${Math.round(size * 10) / 10}px/${weight}${large ? ' (large)' : ''}` };
    if (cs.textShadow && cs.textShadow !== 'none') detail.textShadow = cs.textShadow;
    if (uncertain) {
      contrastUncertain++;
      add('contrast-needs-check', '1.4.3 Contrast (Minimum) (AA)', 'moderate', 'Text over an image, gradient or overlapping element: the ratio below uses the nearest solid colour and may be wrong. Zoom a screenshot and judge the worst spot.', el, Object.assign(detail, { why: uncertain }));
    } else if (r < need) {
      add('contrast-text', '1.4.3 Contrast (Minimum) (AA)', 'serious', `Text contrast is below ${need}:1.`, el, Object.assign(detail, { suggest: suggest(fgOnBg, bg, need) }));
    }
  });
  // Placeholder text
  all.forEach(el => {
    if (!/^(input|textarea)$/.test(el.localName) || !el.placeholder || !seen(el)) return;
    const pc = parseColour(getComputedStyle(el, '::placeholder').color);
    const bg = bgOf(el).color;
    const r = ratio(blend(pc, bg), bg);
    if (r < TEXT_MIN) add('contrast-placeholder', '1.4.3 Contrast (Minimum) (AA)', labelled(el) ? 'moderate' : 'serious', 'Placeholder text is below 4.5:1. It counts as text when it carries information (an example format, or the only label).', el, { placeholder: el.placeholder, ratio: round2(r), text_colour: hex(blend(pc, bg)), background: hex(bg), suggest: suggest(blend(pc, bg), bg, TEXT_MIN) });
  });
  // Field boundaries (1.4.11)
  all.forEach(el => {
    if (!el.matches('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="range"]):not([type="color"]),select,textarea') || !seen(el)) return;
    const cs = getComputedStyle(el);
    const outer = bgOf(el.parentElement || D.body).color;
    const own = blend(parseColour(cs.backgroundColor), outer);
    let best = ratio(own, outer);
    let source = 'field background';
    ['Top', 'Right', 'Bottom', 'Left'].forEach(s => {
      if (parseFloat(cs[`border${s}Width`]) >= 1 && cs[`border${s}Style`] !== 'none') {
        const rr = ratio(blend(parseColour(cs[`border${s}Color`]), outer), outer);
        if (rr > best) { best = rr; source = `${s.toLowerCase()} border`; }
      }
    });
    if (best < NON_TEXT_MIN && cs.boxShadow === 'none') add('field-boundary-contrast', '1.4.11 Non-text Contrast (AA)', 'serious', 'The edge of this form field has less than 3:1 contrast with its surroundings, so people with low vision may not see where to type.', el, { ratio: round2(best), strongest: source, background: hex(outer) });
    else if (best < NON_TEXT_MIN) add('field-boundary-check', '1.4.11 Non-text Contrast (AA)', 'minor', 'The field edge is drawn with a box-shadow; check it reaches 3:1 in a screenshot.', el, { boxShadow: cs.boxShadow });
  });
  // Links told apart by colour alone (1.4.1)
  all.forEach(el => {
    if (el.localName !== 'a' || !el.hasAttribute('href') || !seen(el)) return;
    const block = el.closest('p,li,td,dd,blockquote');
    if (!block || block.textContent.trim().length <= el.textContent.trim().length + 15 || el.closest('nav,[role="navigation"]')) return;
    const cs = getComputedStyle(el), ps = getComputedStyle(el.parentElement);
    if (cs.textDecorationLine.includes('underline') || ps.textDecorationLine.includes('underline') || parseFloat(cs.borderBottomWidth) > 0 || (cs.backgroundImage !== 'none')) return;
    if ((parseInt(cs.fontWeight, 10) || 400) - (parseInt(ps.fontWeight, 10) || 400) >= 300) return;
    const bg = bgOf(el).color;
    const r = ratio(blend(parseColour(cs.color), bg), blend(parseColour(ps.color), bg));
    if (r < NON_TEXT_MIN) add('link-in-text-colour-only', '1.4.1 Use of Color (A)', 'serious', 'A link inside a sentence is shown only by colour, with less than 3:1 contrast against the text around it. Underline it (or add another non-colour cue).', el, { ratio_vs_text: round2(r) });
  });
  out.notes.push('Contrast was measured for the page as it is now: check hover, focus, active, visited, selected, error and disabled-looking states, icons, charts and text in images by eye or by re-running the audit with that state showing.');

  });

  // ---------- motion, autoplay, flashing ----------
  section('motion, autoplay, flashing', () => {
  pauseControls = controls.filter(el => /\b(pause|stop|play|freeze|halt|resume|turn off animation|reduce motion)\b/i.test(nameOf(el)));
  out.motion.pauseControls = pauseControls.slice(0, 15).map(el => `${role(el)} "${nameOf(el)}" ${sel(el)}`);
  const anims = typeof D.getAnimations === 'function' ? D.getAnimations() : [];
  const byTarget = new Map();
  anims.forEach(a => {
    if (a.playState !== 'running' || !a.effect || !a.effect.target) return;
    const tgt = a.effect.target;
    if (!(tgt instanceof Element) || inOverlay(tgt) || !seen(tgt)) return;
    const t = a.effect.getComputedTiming();
    const total = t.endTime;
    if (total !== Infinity && total <= MOTION_LIMIT_MS) return;
    if (byTarget.has(tgt)) return;
    byTarget.set(tgt, { kind: a.constructor.name, name: a.animationName || a.id || null, duration_ms: Math.round(t.duration), iterations: t.iterations === Infinity ? 'infinite' : t.iterations });
  });
  // Report only the outermost animated elements.
  byTarget.forEach((info, el) => {
    if ([...byTarget.keys()].some(o => o !== el && o.contains(el))) return;
    const r = el.getBoundingClientRect();
    const tiny = r.width < 48 && r.height < 48;
    const ownPause = pauseControls.some(p => (el.parentElement || el).closest('section,article,div,aside,header,footer,main')?.contains(p));
    add('motion-auto', '2.2.2 Pause, Stop, Hide (A)', tiny ? 'minor' : ownPause ? 'moderate' : 'serious', tiny ? 'A small element animates for more than 5 seconds (a spinner or decoration?). A loading indicator during a wait is usually fine; decoration that never stops needs a way to stop it.' : 'Something animates by itself for more than 5 seconds. WCAG needs a visible, keyboard-operable way to pause, stop or hide it.' + (ownPause ? ' A pause-like control was found nearby: check it works with the keyboard.' : ' No pause control was found nearby.'), el, Object.assign(info, { size: `${Math.round(r.width)}×${Math.round(r.height)}` }));
  });
  all.forEach(el => {
    const tag = el.localName;
    if (tag === 'marquee' || tag === 'blink') add('marquee-blink', '2.2.2 Pause, Stop, Hide (A)', 'critical', `A <${tag}> element moves or blinks with no way to stop it.`, el);
    if (tag === 'video' && rendered(el)) {
      const playing = !el.paused || el.autoplay;
      if (!playing) return;
      if (!el.muted && el.autoplay) add('autoplay-audio', '1.4.2 Audio Control (A)', 'critical', 'A video plays automatically with sound. Sound that starts by itself for more than 3 seconds needs a way to stop it or turn it down, and should be muted by default.', el);
      const long = el.loop || !isFinite(el.duration) || el.duration > 5;
      if (long && !el.controls && !pauseControls.length) add('autoplay-video', '2.2.2 Pause, Stop, Hide (A)', 'serious', 'A video plays by itself (for more than 5 seconds or on loop) with no visible pause control.', el, { loop: el.loop, muted: el.muted, duration: isFinite(el.duration) ? Math.round(el.duration) : null });
    }
    if (tag === 'audio' && (el.autoplay || !el.paused)) add('autoplay-audio', '1.4.2 Audio Control (A)', 'critical', 'Audio plays automatically.', el);
    if (tag === 'img' && rendered(el) && /\.gif(\?|#|$)/i.test(el.currentSrc || el.src || '')) {
      const r = el.getBoundingClientRect();
      if (r.width > 48 || r.height > 48) add('gif-check', '2.2.2 Pause, Stop, Hide (A)', 'minor', 'An animated GIF may loop for more than 5 seconds with no way to pause it. Check by watching it.', el);
    }
    if (/^(lottie-player|dotlottie-player|dotlottie-wc)$/.test(tag) || (tag === 'canvas' && rendered(el) && el.getBoundingClientRect().width > 200)) add('canvas-animation-check', '2.2.2 Pause, Stop, Hide (A)', 'minor', 'A canvas or Lottie animation: script-driven motion is invisible to this audit. Use the motion snapshot to see whether it moves.', el);
    if (tag === 'iframe' && /youtube|vimeo|wistia|loom/i.test(el.src || '') && /autoplay=1/.test(el.src || '')) add('embed-autoplay', '2.2.2 Pause, Stop, Hide (A) / 1.4.2 Audio Control (A)', 'serious', 'An embedded video is set to autoplay.', el, { src: el.src.slice(0, 120) });
  });
  const CAROUSEL = /carousel|slider|slideshow|swiper|slick|splide|glide|flickity|embla|keen-slider|owl-|marquee|ticker|scroller|rotator|hero-slides/i;
  const carousels = all.filter(el => rendered(el) && ((el.getAttribute('aria-roledescription') || '').match(/carousel/i) || (typeof el.className === 'string' && CAROUSEL.test(el.className) && !CAROUSEL.test(el.parentElement && typeof el.parentElement.className === 'string' ? el.parentElement.className : ''))));
  out.motion.carousels = carousels.slice(0, 10).map(el => {
    const pause = [...el.querySelectorAll('button,[role="button"]')].find(b => /pause|stop|play/i.test(nameOf(b)));
    return `${sel(el)}: ${pause ? 'has "' + nameOf(pause) + '" control' : 'no pause/stop control inside'}`;
  });
  let reducedMotionCss = false, unreadableSheets = 0;
  const scan = rules => { for (const r of rules) { if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) reducedMotionCss = true; else if (r.conditionText && /prefers-reduced-motion/.test(r.conditionText)) reducedMotionCss = true; if (r.cssRules) scan(r.cssRules); } };
  for (const s of D.styleSheets) { try { scan(s.cssRules); } catch (e) { unreadableSheets++; } }
  out.motion.respectsReducedMotionInCss = reducedMotionCss;
  out.motion.prefersReducedMotionNow = W.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (unreadableSheets) out.motion.note = `${unreadableSheets} cross-origin stylesheet(s) could not be read for prefers-reduced-motion rules.`;
  out.notes.push('JavaScript-driven motion (carousels on timers, tickers, counters, parallax) is not in the animation list. Run __a11yMotionSnapshot(), wait 6 seconds without touching the page, then run __a11yMotionCompare(). Flashing more than 3 times a second (2.3.1) can only be judged by watching.');

  });

  // ---------- finish ----------
  const ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  out.issues = [...rules.values()].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.count - a.count);
  out.summary = {
    issues_by_severity: out.issues.reduce((o, r) => { o[r.severity] = (o[r.severity] || 0) + r.count; return o; }, {}),
    rules_triggered: out.issues.length,
    elements: all.length, text_elements_checked_for_contrast: contrastChecked, contrast_needing_visual_check: contrastUncertain,
    tab_stops: ordered.length, focus_styles_tested: focusTested,
    ms: Math.round(performance.now() - t0),
  };
  W.__a11yAudit = out;

  // ---------- helpers for the interactive passes ----------
  const COLOURS = { critical: '#b00020', serious: '#d14900', moderate: '#7a5c00', minor: '#3557a6' };
  W.__a11yMark = (on = true) => {
    D.querySelectorAll('[' + OVERLAY + ']').forEach(n => n.remove());
    if (!on) return 'overlay removed';
    const layer = D.createElement('div');
    layer.setAttribute(OVERLAY, '');
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    let drawn = 0;
    marks.forEach(({ n, el, severity }) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const c = COLOURS[severity];
      const box = D.createElement('div');
      box.style.cssText = `position:absolute;left:${r.left + scrollX - 2}px;top:${r.top + scrollY - 2}px;width:${r.width + 4}px;height:${r.height + 4}px;outline:2px solid ${c};outline-offset:0;box-sizing:border-box;`;
      const tag = D.createElement('div');
      tag.textContent = n;
      tag.style.cssText = `position:absolute;left:-2px;top:-18px;font:700 11px/16px system-ui,sans-serif;color:#fff;background:${c};padding:0 4px;border-radius:3px;`;
      box.appendChild(tag);
      layer.appendChild(box);
      drawn++;
    });
    D.body.appendChild(layer);
    return `${drawn} marks drawn (numbers match "mark" in the issue list)`;
  };
  // Tool outputs can be cut off at about 1,000 characters, so the result is read in pages.
  const PAGE_CHARS = 900;
  const short = s => (s || '').replace(/^body > /, '').replace(/div\.wrap(:nth-of-type\(\d+\))? > /g, '');
  W.__a11ySummary = (from = 0) => {
    const lines = [];
    if (from === 0) {
      const sv = out.summary.issues_by_severity;
      lines.push(`${out.issues.length} rules, ${Object.entries(sv).map(([k, v]) => `${v} ${k}`).join(', ')}. Tab stops ${out.summary.tab_stops}. Errors: ${out.errors.length ? out.errors.join(' | ') : 'none'}`);
    }
    let i = from;
    for (; i < out.issues.length; i++) {
      const r = out.issues[i];
      const inst = r.instances.slice(0, 3).map(x => `#${x.mark ?? '-'} ${short(x.selector)}${x.ratio !== undefined ? ` ${x.ratio}:1` : ''}${x.suggest ? `→${x.suggest}` : ''}${x.size ? ` ${x.size}` : ''}`).join('; ');
      const line = `${i}. ${r.severity} ${r.rule} ×${r.count} [${r.sc.split(' (')[0]}] ${inst}`;
      if (lines.join('\n').length + line.length > PAGE_CHARS && lines.length) break;
      lines.push(line);
    }
    lines.push(i < out.issues.length ? `MORE: __a11ySummary(${i})` : 'END. Details: __a11yAudit.issues[n].instances, __a11yAudit.keyboard, .motion, .screenReader, .notes');
    return lines.join('\n');
  };
  // Highlight one problem for its own screenshot. `selectors` is a CSS selector or an array of
  // them (their boxes are joined). `frameWidth` is the screenshot's coordinate-frame width, which
  // can differ from CSS pixels; the returned `region` is in that frame, ready for a zoom capture.
  const SHOT_PAD_X = 160;  // CSS px of context either side of the problem
  const SHOT_PAD_Y = 90;   // CSS px of context above and below
  const SHOT_MIN_W = 560;  // keep crops wide enough to see where on the page they are
  W.__a11yShowIssue = (selectors, label, frameWidth) => {
    D.querySelectorAll('[' + OVERLAY + ']').forEach(n => n.remove());
    const list = (Array.isArray(selectors) ? selectors : [selectors]).flatMap(q => { try { return [...D.querySelectorAll(q)].slice(0, 1); } catch (e) { return []; } });
    const els = list.filter(el => rendered(el));
    if (!els.length) return JSON.stringify({ error: list.length ? 'element is not visible on the page' : 'no element matches ' + JSON.stringify(selectors) });
    els[0].scrollIntoView({ block: 'center', inline: 'nearest' });
    const rects = els.map(el => el.getBoundingClientRect());
    const box = { l: Math.min(...rects.map(r => r.left)), t: Math.min(...rects.map(r => r.top)), r: Math.max(...rects.map(r => r.right)), b: Math.max(...rects.map(r => r.bottom)) };
    const layer = D.createElement('div');
    layer.setAttribute(OVERLAY, '');
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = `position:fixed;left:${box.l - 5}px;top:${box.t - 5}px;width:${box.r - box.l + 10}px;height:${box.b - box.t + 10}px;border:3px solid #d1006b;box-shadow:0 0 0 3px #fff,inset 0 0 0 2px #fff;border-radius:4px;z-index:2147483647;pointer-events:none;`;
    const tag = D.createElement('div');
    tag.textContent = label || '';
    tag.style.cssText = 'position:absolute;left:-3px;bottom:100%;margin-bottom:4px;font:700 13px/20px system-ui,sans-serif;color:#fff;background:#d1006b;padding:0 6px;border-radius:3px;white-space:nowrap;';
    if (label) layer.appendChild(tag);
    D.body.appendChild(layer);
    const w = Math.max(SHOT_MIN_W, box.r - box.l + 2 * SHOT_PAD_X);
    const cx = (box.l + box.r) / 2;
    let x0 = Math.max(0, cx - w / 2), x1 = Math.min(innerWidth, x0 + w);
    x0 = Math.max(0, x1 - w);
    const y0 = Math.max(0, box.t - SHOT_PAD_Y - 24), y1 = Math.min(innerHeight, box.b + SHOT_PAD_Y);
    const k = frameWidth ? frameWidth / innerWidth : 1;
    return JSON.stringify({ region: [x0, y0, x1, y1].map(v => Math.round(v * k)), found: els.length });
  };
  W.__a11yTabReset = () => { W.__a11yTabLog = []; return 'tab log cleared'; };
  // Browser automation can append an empty, attribute-less div to <body> and focus it before
  // sending keys. It isn't part of the site, so the Tab walk skips it.
  const automationNode = el => el && el.localName === 'div' && el.parentElement === D.body && !el.attributes.length && !el.childNodes.length && el.tabIndex < 0;
  W.__a11yFocusInfo = () => {
    const el = D.activeElement;
    W.__a11yTabLog = W.__a11yTabLog || [];
    if (automationNode(el)) return JSON.stringify({ step: W.__a11yTabLog.length, focused: '(browser automation element, not the site: press Tab again)', skip: true });
    if (!el || el === D.body || el === D.documentElement) return JSON.stringify({ step: W.__a11yTabLog.length, focused: '(nothing in the page: focus is on the page itself or in the browser toolbar; press Tab again. If this repeats mid-page, focus was lost)', skip: true });
    const s = sel(el);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    let obscuredBy = null;
    if (inView && r.width && r.height) {
      const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2]];
      const covered = pts.map(([x, y]) => { const hit = D.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, x)), Math.max(0, Math.min(innerHeight - 1, y))); return hit && !el.contains(hit) && !hit.contains(el) && !inOverlay(hit) ? hit : null; });
      if (covered.every(Boolean)) obscuredBy = sel(covered[0]);
      else if (covered.some(Boolean)) obscuredBy = 'partly: ' + sel(covered.find(Boolean));
    }
    const prevIdx = W.__a11yTabLog.lastIndexOf(s);
    W.__a11yTabLog.push(s);
    const recent = W.__a11yTabLog.slice(-8);
    const distinctRecent = new Set(recent).size;
    return JSON.stringify({
      step: W.__a11yTabLog.length,
      focused: `${role(el) || el.localName} "${nameOf(el).slice(0, 80)}"`,
      selector: s,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: inView, visible: seen(el) && r.width > 1 && r.height > 1, obscuredBy,
      focusVisibleMatches: el.matches(':focus-visible'),
      style: { outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, boxShadow: cs.boxShadow },
      state: ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-current', 'aria-haspopup', 'aria-controls'].filter(a => el.hasAttribute(a)).map(a => `${a}=${el.getAttribute(a)}`).join(' ') || null,
      seenBefore: prevIdx >= 0 ? `yes, at step ${prevIdx + 1}` : 'no',
      possibleTrap: W.__a11yTabLog.length >= 8 && distinctRecent <= 3,
      inDialog: !!el.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]'),
    });
  };
  W.__a11yMotionSnapshot = () => {
    const m = new Map();
    [...D.body.querySelectorAll('*')].slice(0, MAX_MOTION_ELEMENTS).forEach(e => {
      if (inOverlay(e)) return;
      const r = e.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const cs = getComputedStyle(e);
      m.set(e, { x: r.left + scrollX, y: r.top + scrollY, t: cs.transform, o: cs.opacity, v: cs.visibility, sl: e.scrollLeft, st: e.scrollTop, src: e.currentSrc || e.getAttribute('src') || '', txt: e.childElementCount === 0 ? (e.textContent || '').trim().slice(0, 120) : null, vt: e.localName === 'video' ? e.currentTime : null });
    });
    W.__a11yMotionState = { m, at: Date.now(), sx: scrollX, sy: scrollY };
    return `snapshot of ${m.size} elements. Wait at least 6 seconds without scrolling or moving the mouse, then run __a11yMotionCompare().`;
  };
  W.__a11yMotionCompare = () => {
    const st = W.__a11yMotionState;
    if (!st) return 'run __a11yMotionSnapshot() first';
    const changed = new Map();
    st.m.forEach((a, e) => {
      if (!e.isConnected) return;
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      const why = [];
      if (Math.abs(r.left + scrollX - a.x) > MOVE_TOLERANCE_PX || Math.abs(r.top + scrollY - a.y) > MOVE_TOLERANCE_PX) why.push('moved');
      if (cs.transform !== a.t) why.push('transform changed');
      if (cs.opacity !== a.o || cs.visibility !== a.v) why.push('faded/shown/hidden');
      if (Math.abs(e.scrollLeft - a.sl) > MOVE_TOLERANCE_PX || Math.abs(e.scrollTop - a.st) > MOVE_TOLERANCE_PX) why.push('scrolled itself');
      if ((e.currentSrc || e.getAttribute('src') || '') !== a.src) why.push('image changed');
      if (a.txt !== null && e.childElementCount === 0 && (e.textContent || '').trim().slice(0, 120) !== a.txt) why.push('text changed');
      if (a.vt !== null && e.currentTime !== a.vt) why.push('video playing');
      if (why.length) changed.set(e, why);
    });
    const top = [...changed.keys()].filter(e => { for (let p = e.parentElement; p; p = p.parentElement) if (changed.has(p)) return false; return true; });
    // Siblings that change together (carousel slides) are reported as their container.
    const byParent = new Map();
    top.forEach(e => { const p = e.parentElement; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(e); });
    const regions = [];
    byParent.forEach((kids, p) => {
      if (kids.length > 1 && p && p !== D.body) regions.push([p, [`${kids.length} children ${[...new Set(kids.flatMap(k => changed.get(k)))].join(', ')}`]]);
      else kids.forEach(k => regions.push([k, changed.get(k)]));
    });
    const secs = Math.round((Date.now() - st.at) / 100) / 10;
    return JSON.stringify({
      seconds_between: secs,
      page_scrolled: scrollX !== st.sx || scrollY !== st.sy,
      changed_regions: regions.slice(0, 25).map(([e, why]) => { const r = e.getBoundingClientRect(); return { selector: sel(e), what: why.join(', '), size: `${Math.round(r.width)}×${Math.round(r.height)}`, html: snip(e) }; }),
      note: regions.length ? 'Each region changed by itself. If it keeps going past 5 seconds (or updates automatically) it needs a pause, stop or hide control that works with the keyboard (2.2.2).' : 'Nothing changed by itself in that time.',
    });
  };

  return JSON.stringify(out);
})();
