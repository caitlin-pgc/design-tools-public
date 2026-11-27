#!/usr/bin/env python3
"""Build the accessibility report from a findings file.

    python3 build_report.py <findings.json> [output folder] [--no-open]

Writes two files into the output folder (default: the folder holding findings.json):
  accessibility-fixes.md     for Claude: instructions and the fixes to apply after the review
  accessibility-report.html  for people: decisions first, then every change

Then opens the HTML report in the default browser. --no-open skips that
(for CI, evals, or a machine with no browser).

The findings format is described in findings-format.md next to this script.
Standard library only.
"""
import html
import json
import os
import pathlib
import re
import shutil
import sys
import webbrowser

AREAS = [
    ('keyboard', 'Keyboard navigation'),
    ('contrast', 'Colour contrast'),
    ('motion', 'Moving and auto-playing content'),
    ('screen-reader', 'Screen readers'),
    ('other', 'Other AA criteria'),
]
SEVERITIES = ['critical', 'serious', 'moderate', 'minor']
TOKEN = re.compile(r'\{\{(D\d+)\}\}')


def fail(msg):
    sys.exit('findings.json problem: ' + msg)


def load(path):
    try:
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
    except FileNotFoundError:
        fail('file not found: ' + path)
    except json.JSONDecodeError as e:
        fail('not valid JSON (line %d, column %d): %s' % (e.lineno, e.colno, e.msg))
    for key in ('site', 'date', 'decisions', 'fixes'):
        if key not in data:
            fail('missing top-level "%s"' % key)
    ids = {d.get('id') for d in data['decisions']}
    for d in data['decisions']:
        for key in ('id', 'title', 'question', 'type', 'options'):
            if key not in d:
                fail('decision %s is missing "%s"' % (d.get('id', '?'), key))
        if d['type'] not in ('colour', 'text', 'choice'):
            fail('decision %s: type must be colour, text or choice' % d['id'])
        if not any(o.get('recommended') for o in d['options']):
            fail('decision %s: mark one option "recommended": true' % d['id'])
    for f in data['fixes']:
        for key in ('id', 'title', 'area', 'severity', 'wcag', 'problem', 'change'):
            if key not in f:
                fail('fix %s is missing "%s"' % (f.get('id', '?'), key))
        if f['area'] not in dict(AREAS):
            fail('fix %s: area must be one of %s' % (f['id'], ', '.join(dict(AREAS))))
        if not isinstance(f.get('where', {}), dict):
            fail('fix %s: "where" must be an object such as {"selector": "…", "page": "…"}' % f['id'])
        if not isinstance(f['change'], dict):
            fail('fix %s: "change" must be an object with "before" and "after"' % f['id'])
        if f['severity'] not in SEVERITIES:
            fail('fix %s: severity must be one of %s' % (f['id'], ', '.join(SEVERITIES)))
        for dep in f.get('depends_on', []):
            if dep not in ids:
                fail('fix %s depends on unknown decision %s' % (f['id'], dep))
        for tok in TOKEN.findall(f['change'].get('after', '')):
            if tok not in ids:
                fail('fix %s uses {{%s}} but there is no such decision' % (f['id'], tok))
            if tok not in f.get('depends_on', []):
                fail('fix %s uses {{%s}}; add "%s" to its depends_on' % (f['id'], tok, tok))
    return data


def recommended(d):
    return next(o for o in d['options'] if o.get('recommended'))


def counts(fixes):
    c = {s: 0 for s in SEVERITIES}
    for f in fixes:
        c[f['severity']] += 1
    return c


def where(f):
    w = f.get('where', {})
    parts = []
    if w.get('file'):
        parts.append(w['file'] + (':%s' % w['line'] if w.get('line') else ''))
    if w.get('selector'):
        parts.append('`%s`' % w['selector'])
    if w.get('page'):
        parts.append(w['page'])
    return ' · '.join(parts)


# ---------------------------------------------------------------- Markdown for Claude
def build_md(data):
    dec = {d['id']: d for d in data['decisions']}
    out = []
    a = out.append
    a('# Accessibility fixes: %s (%s)\n' % (data['site'], data['date']))
    a('Standard: %s. Built by the accessibility-checker skill from `findings.json`.\n' % data.get('standard', 'WCAG 2.2 AA'))
    a('## Instructions for Claude\n')
    a('1. Settle the decisions first. If the person pasted their choices from the report page, use those. If they said to use the recommendations, use the recommended option. Otherwise ask, listing the open decisions by ID. Never invent content a decision asks for (alt text, labels, copy): ask.')
    a('2. Apply the fixes in the order listed. `{{D3}}` in a change means "the value chosen for decision D3".')
    a('3. Make the smallest change that fixes each problem. Keep the existing code style, and prefer native HTML to ARIA.')
    a('4. After each fix, do its **Verify** step. When all are done, run the accessibility-checker audit again on the same pages and confirm the issues are gone.')
    a('5. Tick each fix off below as you finish it, and note anything you could not fix and why.\n')
    c = counts(data['fixes'])
    a('**%d fixes:** %s. **%d decisions** for a person.\n' % (len(data['fixes']), ', '.join('%d %s' % (c[s], s) for s in SEVERITIES if c[s]), len(data['decisions'])))
    a('## Decisions\n')
    for d in data['decisions']:
        r = recommended(d)
        a('### %s. %s\n' % (d['id'], d['title']))
        a('- **Question:** %s' % d['question'])
        if d.get('wcag'):
            a('- **WCAG:** %s' % d['wcag'])
        a('- **Options:**')
        for i, o in enumerate(d['options'], 1):
            extra = ''
            if d['type'] == 'colour' and o.get('ratio'):
                extra = ' (%s:1)' % o['ratio']
            val = o.get('value', '')
            a('  %d. %s%s%s%s%s' % (i, o['label'], extra, ': `%s`' % val if val else ' (empty value)', ' **(recommended)**' if o.get('recommended') else '', ' (%s)' % o['detail'] if o.get('detail') else ''))
        if d['type'] == 'text':
            a('  - Or any other text the person gives.')
        a('- **Chosen:** _not yet. Recommended: %s_' % (('`%s`' % r['value']) if r.get('value') else r['label']))
        users = [f['id'] for f in data['fixes'] if d['id'] in f.get('depends_on', [])]
        if users:
            a('- **Used by:** %s' % ', '.join(users))
        a('')
    a('## Fixes\n')
    for f in data['fixes']:
        a('### [ ] %s. %s\n' % (f['id'], f['title']))
        a('- **Severity:** %s · **WCAG:** %s · **Area:** %s' % (f['severity'], f['wcag'], dict(AREAS)[f['area']]))
        if where(f):
            a('- **Where:** %s' % where(f))
        a('- **Problem:** %s' % f['problem'])
        if f.get('evidence'):
            a('- **Evidence:** %s' % f['evidence'])
        if f.get('screenshot'):
            a('- **Screenshot:** [%s](%s) (the problem is outlined and labelled %s)' % (f['screenshot'], f['screenshot'], f['id']))
        if f.get('depends_on'):
            a('- **Needs decision:** %s' % ', '.join('%s (%s)' % (x, dec[x]['title']) for x in f['depends_on']))
        ch = f['change']
        if ch.get('summary'):
            a('- **Change:** %s' % ch['summary'])
        if ch.get('before'):
            a('\n  Before:\n  ```%s\n%s\n  ```' % (ch.get('lang', ''), indent(ch['before'])))
        if ch.get('after'):
            a('\n  After:\n  ```%s\n%s\n  ```' % (ch.get('lang', ''), indent(ch['after'])))
        if f.get('verify'):
            a('\n- **Verify:** %s' % f['verify'])
        a('')
    for key, title in (('manual_checks', 'Needs a person to check'), ('not_tested', 'Not tested'), ('passed', 'Passed')):
        if data.get(key):
            a('## %s\n' % title)
            for item in data[key]:
                a('- %s' % item)
            a('')
    return '\n'.join(out)


def indent(code):
    return '\n'.join('  ' + line for line in code.split('\n'))


# ---------------------------------------------------------------- HTML for people
CSS = """
:root{--bg:#f7f7f5;--surface:#fff;--ink:#1c1c1a;--muted:#55554f;--line:#d4d4cf;--accent:#1d4ed8;--accent-ink:#fff;
--crit:#a3141c;--crit-bg:#fdecec;--ser:#9a3a00;--ser-bg:#fff0e5;--mod:#6b5200;--mod-bg:#fbf4dc;--min:#2f4d8f;--min-bg:#eaf0fb;
--field:#8a8a84;--code:#f0f0ec;--ok:#14692f;--bad:#a3141c;--focus:#1d4ed8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--surface:#1e1e1c;--ink:#ecece8;--muted:#b4b4ac;--line:#3a3a36;
--accent:#8fb0ff;--accent-ink:#0b1430;--crit:#ffb3b3;--crit-bg:#3a1416;--ser:#ffc199;--ser-bg:#3a2112;--mod:#f2d77a;--mod-bg:#332a0d;--min:#b5c8f5;--min-bg:#18233d;
--field:#7a7a74;--code:#2a2a27;--ok:#8fe0a6;--bad:#ffb3b3;--focus:#8fb0ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:16px;top:-48px;background:var(--accent);color:var(--accent-ink);padding:8px 14px;border-radius:6px;z-index:2}
.skip:focus{top:12px}
header,main,footer{max-width:960px;margin:0 auto;padding:0 16px}
header{padding-top:40px;padding-bottom:8px}
h1{font-size:2rem;line-height:1.2;margin:0 0 8px}
h2{font-size:1.5rem;margin:56px 0 8px;line-height:1.25}
h3{font-size:1.125rem;margin:0;line-height:1.35}
.meta{color:var(--muted);margin:0 0 20px}
.lede{font-size:1.125rem;max-width:68ch}
.counts{display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:20px 0;list-style:none}
.counts li{padding:6px 12px;border-radius:999px;font-weight:600;font-size:.9375rem}
.sev{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.8125rem;font-weight:700;text-transform:capitalize}
.critical{background:var(--crit-bg);color:var(--crit)}.serious{background:var(--ser-bg);color:var(--ser)}
.moderate{background:var(--mod-bg);color:var(--mod)}.minor{background:var(--min-bg);color:var(--min)}
nav.toc ol{display:flex;flex-wrap:wrap;gap:8px 20px;padding:0;margin:0;list-style:none}
.intro{color:var(--muted);max-width:68ch;margin:0 0 20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 16px}
.card-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px;margin-bottom:8px}
.id{font:700 .8125rem/1 ui-monospace,Menlo,monospace;color:var(--muted)}
.why{margin:4px 0 12px;color:var(--muted)}
.facts{margin:0 0 12px;color:var(--muted);font-size:.9375rem}
fieldset{border:0;margin:0;padding:0;min-width:0}
legend{font-weight:600;margin-bottom:8px;padding:0}
.options{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
.opt{position:relative;display:block;border:2px solid var(--line);border-radius:10px;padding:12px 12px 12px 40px;cursor:pointer;background:var(--surface)}
.opt input{position:absolute;left:12px;top:15px;width:18px;height:18px;margin:0;accent-color:var(--accent)}
.opt:has(input:checked){border-color:var(--accent)}
.opt:has(input:focus-visible){outline:3px solid var(--focus);outline-offset:2px}
.opt-label{font-weight:600;display:block}
.opt-detail{display:block;color:var(--muted);font-size:.875rem}
.rec{display:inline-block;margin-left:6px;font-size:.75rem;font-weight:700;color:var(--ok)}
.swatch{display:flex;align-items:center;gap:10px;margin-top:8px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);font-size:1rem}
.swatch b{font-size:1.25rem}
.ratio{margin-left:auto;white-space:nowrap;font:600 .8125rem/1 ui-monospace,Menlo,monospace;padding:4px 6px;border-radius:4px;background:var(--surface);color:var(--ink)}
.pass{color:var(--ok)}.fail{color:var(--bad)}
.text-answer{display:block;margin-top:12px}
.text-answer span{display:block;font-weight:600;margin-bottom:4px}
.text-answer input{width:100%;font:inherit;padding:10px 12px;border:2px solid var(--field);border-radius:8px;background:var(--surface);color:var(--ink)}
.text-answer input:focus-visible{border-color:var(--accent)}
.uses{font-size:.875rem;color:var(--muted);margin:12px 0 0}
pre{background:var(--code);border-radius:8px;padding:12px;overflow-x:auto;font:.875rem/1.5 ui-monospace,Menlo,monospace;margin:4px 0 0;white-space:pre-wrap;word-break:break-word}
.diff{display:grid;gap:12px;grid-template-columns:1fr 1fr;margin-top:12px}
.diff h4{margin:0;font-size:.8125rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.chosen{background:var(--mod-bg);color:var(--ink);border-radius:3px;padding:0 2px}
.bar{position:sticky;bottom:0;background:var(--surface);border-top:1px solid var(--line);padding:12px 16px;margin-top:40px}
.bar-in{max-width:960px;margin:0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.bar p{margin:0;color:var(--muted)}
button.primary{font:inherit;font-weight:600;background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:10px 18px;cursor:pointer;min-height:44px}
button.secondary{font:inherit;background:transparent;color:var(--accent);border:2px solid var(--accent);border-radius:8px;padding:8px 16px;cursor:pointer;min-height:44px}
#copied{font-weight:600;color:var(--ok)}
textarea#out{width:100%;min-height:160px;font:.875rem/1.5 ui-monospace,Menlo,monospace;margin-top:12px;background:var(--code);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:12px}
ul.plain{padding-left:20px}ul.plain li{margin-bottom:6px}
figure{margin:16px 0}figure img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px}
figcaption{color:var(--muted);font-size:.875rem;margin-top:4px}
.shot{margin:12px 0 4px}.shot img{display:block;max-width:100%;max-height:420px;width:auto;object-fit:contain;background:var(--code)}
.page-wide{margin:12px 0 0;padding:8px 12px;border-left:3px solid var(--line);color:var(--muted);font-size:.9375rem}
footer{color:var(--muted);font-size:.875rem;padding-bottom:24px;margin-top:40px}
@media (max-width:640px){.diff{grid-template-columns:1fr}h1{font-size:1.625rem}.bar{padding:8px 16px}.bar-in>p:first-child{display:none}.bar-in>div{display:flex;gap:8px;width:100%}.bar-in>div button{flex:1;padding:8px 10px}}
"""

JS = """
(function(){
  var KEY = 'a11y-report:' + document.body.dataset.key;
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  function valueOf(id){
    var box = document.getElementById(id);
    var picked = box.querySelector('input[type=radio]:checked');
    var text = box.querySelector('input[type=text]');
    if (text && picked && picked.dataset.usesText === '1') return text.value.trim();
    return picked ? picked.value : '';
  }
  function labelOf(id){
    var p = document.getElementById(id).querySelector('input[type=radio]:checked');
    return p ? p.dataset.label : '';
  }
  function refresh(){
    var state = {};
    document.querySelectorAll('.decision').forEach(function(box){
      var id = box.id, v = valueOf(id);
      state[id] = { option: labelOf(id), value: v };
      var t = box.querySelector('input[type=text]');
      if (t) state[id].text = t.value;
      document.querySelectorAll('[data-token="' + id + '"]').forEach(function(s){ s.textContent = v || '(' + id + ' not answered)'; });
    });
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    return state;
  }
  document.querySelectorAll('.decision').forEach(function(box){
    var s = saved[box.id];
    if (s) {
      box.querySelectorAll('input[type=radio]').forEach(function(r){ r.checked = r.dataset.label === s.option; });
      var t = box.querySelector('input[type=text]');
      if (t && typeof s.text === 'string') t.value = s.text;
    }
    box.addEventListener('input', refresh);
    box.addEventListener('change', refresh);
  });
  refresh();
  document.getElementById('copy').addEventListener('click', function(){
    var state = refresh(), lines = ['My accessibility decisions (from the report). Apply the fixes in accessibility-fixes.md with these:'];
    document.querySelectorAll('.decision').forEach(function(box){
      var s = state[box.id];
      lines.push('- ' + box.id + ' ' + box.dataset.title + ': ' + s.option + (s.value ? ' -> ' + s.value : ''));
    });
    var text = lines.join('\\n'), out = document.getElementById('out');
    out.value = text; out.hidden = false;
    function done(){ var c = document.getElementById('copied'); c.textContent = 'Copied. Paste it into Claude.'; }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function(){ out.select(); });
    else { out.select(); try { document.execCommand('copy'); done(); } catch (e) {} }
  });
  document.getElementById('reset').addEventListener('click', function(){
    try { localStorage.removeItem(KEY); } catch (e) {}
    document.querySelectorAll('.decision').forEach(function(box){
      box.querySelectorAll('input[type=radio]').forEach(function(r){ r.checked = r.dataset.rec === '1'; });
      var t = box.querySelector('input[type=text]'); if (t) t.value = t.defaultValue;
    });
    refresh();
    document.getElementById('copied').textContent = 'Back to the recommendations.';
  });
})();
"""


def e(s):
    return html.escape(str(s), quote=True)


def code_with_tokens(code, dec):
    parts = []
    last = 0
    for m in TOKEN.finditer(code):
        parts.append(e(code[last:m.start()]))
        tok = m.group(1)
        parts.append('<span class="chosen" data-token="%s">%s</span>' % (tok, e(recommended(dec[tok]).get('value', ''))))
        last = m.end()
    parts.append(e(code[last:]))
    return ''.join(parts)


def md_inline(s):
    """`code` and **bold** in finding text."""
    s = e(s)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    return re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', s)


def figure(f, caption):
    return '<figure class="shot"><img src="%s" alt="%s: the problem outlined in pink and labelled %s" loading="lazy"><figcaption>%s, outlined and labelled %s</figcaption></figure>' % (
        e(f['screenshot']), e(f['title']), e(f['id']), e(caption), e(f['id']))


def build_html(data, images):
    dec = {d['id']: d for d in data['decisions']}
    c = counts(data['fixes'])
    h = []
    a = h.append
    key = re.sub(r'[^a-z0-9]+', '-', (data['site'] + data['date']).lower())
    a('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">')
    a('<title>Accessibility report: %s</title><style>%s</style></head>' % (e(data['site']), CSS))
    a('<body data-key="%s"><a class="skip" href="#decisions">Skip to decisions</a>' % e(key))
    a('<header><h1>Accessibility report</h1>')
    a('<p class="meta">%s · %s · %s%s</p>' % (e(data['site']), e(data['date']), e(data.get('standard', 'WCAG 2.2 AA')), (' · ' + e(data['browser'])) if data.get('browser') else ''))
    if data.get('summary'):
        a('<p class="lede">%s</p>' % md_inline(data['summary']))
    a('<ul class="counts" aria-label="Problems by severity">%s</ul>' % ''.join('<li class="%s">%d %s</li>' % (s, c[s], s) for s in SEVERITIES if c[s]))
    a('<nav class="toc" aria-label="Sections"><ol><li><a href="#decisions">Your decisions (%d)</a></li><li><a href="#changes">What will change (%d)</a></li>' % (len(data['decisions']), len(data['fixes'])))
    a('<li><a href="#checks">Checks and evidence</a></li></ol></nav></header><main>')

    # Decisions
    a('<section aria-labelledby="decisions"><h2 id="decisions" tabindex="-1">Your decisions</h2>')
    a('<p class="intro">These changes need a person: colours, words and behaviour that are part of the design. Each has a recommended answer already picked. Change any you disagree with, then press <strong>Copy choices for Claude</strong> at the bottom and paste them into Claude. Your picks are remembered in this browser.</p>')
    for d in data['decisions']:
        users = [f for f in data['fixes'] if d['id'] in f.get('depends_on', [])]
        sev = min((SEVERITIES.index(f['severity']) for f in users), default=None)
        a('<article class="card decision" id="%s" data-title="%s"><div class="card-head"><span class="id">%s</span><h3>%s</h3>%s</div>' % (
            e(d['id']), e(d['title']), e(d['id']), e(d['title']), ('<span class="sev %s">%s</span>' % (SEVERITIES[sev], SEVERITIES[sev])) if sev is not None else ''))
        if d.get('why'):
            a('<p class="why">%s</p>' % md_inline(d['why']))
        facts = [x for x in (d.get('wcag'), d.get('where')) if x]
        if facts:
            a('<p class="facts">%s</p>' % ' · '.join(md_inline(x) for x in facts))
        cur = d.get('current')
        if cur and cur.get('fg') and cur.get('bg'):
            a('<p class="facts">Now:</p><span class="swatch" style="color:%s;background:%s;max-width:320px;margin:0 0 12px"><b aria-hidden="true">Aa</b> Sample<span class="ratio fail">%s:1 fails</span></span>' % (e(cur['fg']), e(cur['bg']), e(cur.get('ratio', '?'))))
        shot = next((f for f in users if f.get('screenshot')), None)
        if shot:
            a(figure(shot, 'Where it is on the page'))
        a('<fieldset><legend>%s</legend><div class="options">' % e(d['question']))
        has_text = d['type'] == 'text'
        for i, o in enumerate(d['options']):
            uses_text = has_text and o.get('uses_text', True)
            a('<label class="opt"><input type="radio" name="%s" value="%s" data-label="%s" data-rec="%s" data-uses-text="%s"%s>' % (
                e(d['id']), e(o.get('value', '')), e(o['label']), '1' if o.get('recommended') else '0', '1' if uses_text else '0', ' checked' if o.get('recommended') else ''))
            a('<span class="opt-label">%s%s</span>' % (e(o['label']), '<span class="rec">Recommended</span>' if o.get('recommended') else ''))
            if o.get('detail'):
                a('<span class="opt-detail">%s</span>' % md_inline(o['detail']))
            if d['type'] == 'colour' and o.get('fg') and o.get('bg'):
                need = float(d.get('needs', 4.5))
                ok = float(o.get('ratio', 0)) >= need
                a('<span class="swatch" style="color:%s;background:%s"><b aria-hidden="true">Aa</b> Sample<span class="ratio %s">%s:1 %s</span></span>' % (
                    e(o['fg']), e(o['bg']), 'pass' if ok else 'fail', e(o.get('ratio', '?')), 'passes' if ok else 'fails'))
            a('</label>')
        a('</div>')
        if has_text:
            rec = recommended(d)
            a('<label class="text-answer"><span>%s</span><input type="text" value="%s" autocomplete="off"></label>' % (e(d.get('text_label', 'Your wording')), e(rec.get('value', ''))))
        a('</fieldset>')
        if users:
            a('<p class="uses">Used by %s</p>' % ', '.join('<a href="#%s">%s %s</a>' % (e(f['id']), e(f['id']), e(f['title'])) for f in users))
        a('</article>')
    a('</section>')

    # Changes
    a('<section aria-labelledby="changes"><h2 id="changes">What will change</h2>')
    a('<p class="intro">Everything Claude will change to make the page accessible, grouped by area. Values from your decisions are <span class="chosen">highlighted</span> and update as you pick.</p>')
    for area, title in AREAS:
        fixes = [f for f in data['fixes'] if f['area'] == area]
        if not fixes:
            continue
        a('<h3 style="margin:32px 0 12px;font-size:1.25rem">%s <span class="id">(%d)</span></h3>' % (e(title), len(fixes)))
        for f in fixes:
            a('<article class="card" id="%s"><div class="card-head"><span class="id">%s</span><h4 style="margin:0;font-size:1.0625rem">%s</h4><span class="sev %s">%s</span></div>' % (
                e(f['id']), e(f['id']), e(f['title']), f['severity'], f['severity']))
            a('<p class="facts">%s%s</p>' % (e(f['wcag']), (' · ' + md_inline(where(f))) if where(f) else ''))
            a('<p><strong>Problem:</strong> %s</p>' % md_inline(f['problem']))
            if f.get('screenshot'):
                a(figure(f, 'Where it is on the page'))
            elif f.get('page_wide'):
                a('<p class="page-wide">%s</p>' % md_inline(f['page_wide']))
            if f.get('who'):
                a('<p><strong>Who it affects:</strong> %s</p>' % md_inline(f['who']))
            ch = f['change']
            if ch.get('summary'):
                a('<p><strong>What will change:</strong> %s</p>' % md_inline(ch['summary']))
            if ch.get('before') or ch.get('after'):
                a('<div class="diff"><div><h4>Before</h4><pre>%s</pre></div><div><h4>After</h4><pre>%s</pre></div></div>' % (
                    e(ch.get('before', '')), code_with_tokens(ch.get('after', ''), dec)))
            if f.get('depends_on'):
                a('<p class="uses">Waits on %s</p>' % ', '.join('<a href="#%s">%s %s</a>' % (x, x, e(dec[x]['title'])) for x in f['depends_on']))
            a('</article>')
    a('</section>')

    # Checks
    a('<section aria-labelledby="checks"><h2 id="checks">Checks and evidence</h2>')
    for key2, title in (('manual_checks', 'Needs a person to check'), ('passed', 'Passed'), ('not_tested', 'Not tested')):
        if data.get(key2):
            a('<h3 style="margin:24px 0 8px">%s</h3><ul class="plain">%s</ul>' % (title, ''.join('<li>%s</li>' % md_inline(x) for x in data[key2])))
    for src, caption in images:
        a('<figure><img src="%s" alt="%s" loading="lazy"><figcaption>%s</figcaption></figure>' % (e(src), e(caption), e(caption)))
    a('</section></main>')
    a('<div class="bar" role="region" aria-label="Send your choices"><div class="bar-in"><p>When you are happy with the decisions, send them to Claude.</p>')
    a('<div><button type="button" class="secondary" id="reset">Reset to recommended</button> <button type="button" class="primary" id="copy">Copy choices for Claude</button></div>')
    a('<p id="copied" role="status" aria-live="polite"></p></div><div class="bar-in"><textarea id="out" hidden readonly aria-label="Your choices, ready to paste"></textarea></div></div>')
    a('<footer><p>Made by the accessibility-checker skill. This report covers what was tested and found. It is not a certificate of WCAG conformance.</p></footer>')
    a('<script>%s</script></body></html>' % JS)
    return ''.join(h)


def main():
    args = [a for a in sys.argv[1:] if a != '--no-open']
    auto_open = '--no-open' not in sys.argv[1:]
    if not args:
        sys.exit('Usage: python3 build_report.py <findings.json> [output folder] [--no-open]')
    src = os.path.abspath(args[0])
    data = load(src)
    out = os.path.abspath(args[1]) if len(args) > 1 else os.path.dirname(src)
    os.makedirs(out, exist_ok=True)
    images = []
    for shot in data.get('screenshots', []):
        path = shot['path'] if os.path.isabs(shot['path']) else os.path.join(os.path.dirname(src), shot['path'])
        if not os.path.exists(path):
            print('Skipping missing screenshot: ' + path)
            continue
        rel = os.path.join('screenshots', os.path.basename(path))
        dest = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.abspath(path) != os.path.abspath(dest):
            shutil.copyfile(path, dest)
        images.append((rel.replace(os.sep, '/'), shot.get('caption', 'Screenshot')))
    for f in data['fixes']:
        if not f.get('screenshot'):
            continue
        path = f['screenshot'] if os.path.isabs(f['screenshot']) else os.path.join(os.path.dirname(src), f['screenshot'])
        if not os.path.exists(path):
            print('Missing screenshot for %s: %s (left out of the report)' % (f['id'], path))
            del f['screenshot']
            continue
        rel = os.path.join('screenshots', os.path.basename(path)).replace(os.sep, '/')
        dest = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.abspath(path) != os.path.abspath(dest):
            shutil.copyfile(path, dest)
        f['screenshot'] = rel
    md_path = os.path.join(out, 'accessibility-fixes.md')
    html_path = os.path.join(out, 'accessibility-report.html')
    with open(md_path, 'w', encoding='utf-8') as fh:
        fh.write(build_md(data))
    with open(html_path, 'w', encoding='utf-8') as fh:
        fh.write(build_html(data, images))
    print('Fixes for Claude: ' + md_path)
    print('Report for people: ' + html_path)
    if auto_open:
        try:
            opened = webbrowser.open(pathlib.Path(html_path).as_uri())
        except Exception:
            opened = False
        print('Opened the report in the browser.' if opened else 'Could not open a browser: open the report file yourself.')


if __name__ == '__main__':
    main()
