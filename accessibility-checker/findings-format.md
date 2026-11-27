# Findings format

Write the audit results to `accessibility-audit/findings.json`, then build the outputs with `build_report.py`. ALWAYS use this structure: the script checks it and stops with a message naming any problem.

## Contents

- Decisions or fixes
- File structure
- Decisions
- Fixes
- Severity
- Writing guidance
- VoiceOver check for a person

## Decisions or fixes

Each problem becomes one **fix**: a change Claude can make in the code. When a fix needs something only a person can decide, it also gets a **decision**, and the fix points to it with `depends_on`. Make a decision for:

- **Colours**: any new text, border, focus-ring or background colour. Offer the lightest passing option (closest to the current look) and a stronger one. Give each option its measured ratio.
- **Words**: alt text, labels, link text, headings, button names, frame titles, group legends, and language.
- **Behaviour and design**: whether motion stays (with a pause button) or goes, carousel behaviour, target sizes, focus-ring style, and whether hidden content should be shown or removed.

Pure code fixes have no decision. Examples: swapping a `<div>` for a `<button>`, fixing a misspelt role, removing a positive tabindex, unblocking zoom, adding `autocomplete`, fixing a broken ARIA reference, correcting a heading level.

Always pick a recommended option, so a person can accept everything at once. For words you can't know (what an image shows), recommend the safest choice and let the person type the real wording.

## File structure

```json
{
  "site": "Example Shop",
  "date": "27 November 2026",
  "standard": "WCAG 2.2 Level AA",
  "browser": "Chrome, 1280×800",
  "pages": ["https://example.com/", "https://example.com/basket"],
  "summary": "2-4 plain sentences: the overall state, who is most affected, what to fix first.",
  "screenshots": [{"path": "screenshots/marked-issues.jpg", "caption": "What it shows"}],
  "decisions": [ … ],
  "fixes": [ … ],
  "passed": ["**Criterion:** what was checked and passed"],
  "manual_checks": ["what a person still needs to check"],
  "not_tested": ["pages, states or criteria outside this audit"]
}
```

Screenshot paths are relative to `findings.json`. Save evidence screenshots into `accessibility-audit/screenshots/`. In lists and text fields, `**bold**` and `` `code` `` are formatted.

## Decisions

```json
{
  "id": "D1",
  "title": "Body text colour",
  "type": "colour",
  "needs": 4.5,
  "question": "Which text colour should article text use?",
  "why": "#999999 on white is 2.84:1; body text needs 4.5:1.",
  "wcag": "1.4.3 Contrast (Minimum) (AA)",
  "where": "`.article p`, every article page",
  "current": {"fg": "#999999", "bg": "#ffffff", "ratio": "2.84"},
  "options": [
    {"label": "Lightest passing grey", "value": "#767676", "fg": "#767676", "bg": "#ffffff", "ratio": "4.54", "detail": "Closest to the current look", "recommended": true},
    {"label": "Darker grey", "value": "#595959", "fg": "#595959", "bg": "#ffffff", "ratio": "7.00"}
  ]
}
```

- `type`:
  - `colour` shows a sample of each option (`fg` text on `bg`, which can be a CSS gradient) with its ratio checked against `needs`. Put the failing colours in `current`.
  - `text` adds a text box, filled in with the recommended `value`. An option with `"uses_text": false` (such as "It's decorative") ignores the box. Set `text_label` for the box.
  - `choice` is a plain list of options.
- `value` is what goes into the code. A fix uses it by writing `{{D1}}` in its `after` code.
- IDs run D1, D2, … in the order the person should answer them: colours first, then words, then behaviour.

## Fixes

```json
{
  "id": "F1",
  "title": "Make \"Add to basket\" a real button",
  "area": "keyboard",
  "severity": "critical",
  "wcag": "2.1.1 Keyboard (A)",
  "where": {"file": "src/components/BuyBox.tsx", "line": 42, "selector": "div.add-to-basket", "page": "every product page"},
  "problem": "A `<div>` with a click handler: Tab skips it (Tab walk steps 14–15).",
  "who": "Keyboard, switch and screen-reader users.",
  "depends_on": [],
  "change": {
    "summary": "Use a `<button>` and keep the handler.",
    "lang": "html",
    "before": "<div class=\"add-to-basket\" onClick={add}>Add to basket</div>",
    "after": "<button type=\"button\" class=\"add-to-basket\" onClick={add}>Add to basket</button>"
  },
  "verify": "Tab reaches it, and Enter and Space add the item."
}
```

- `area` is one of `keyboard`, `contrast`, `motion`, `screen-reader` or `other`.
- `screenshot` (optional) is a path relative to `findings.json`, such as `screenshots/F1.png`: a crop with the problem outlined and labelled with the fix ID (SKILL.md step 9 says how to take it). It shows next to the fix on the report page.
- `where.file` and `where.line` point at the source, when it's in the current project. Find them by searching the code for the selector, class or text. Otherwise give the page and selector.
- `before` and `after` are the smallest code snippets that show the change. Use `…` for unchanged parts. Every `{{Dn}}` in `after` must match a decision listed in `depends_on`.
- `verify` is a check Claude can run after the fix: usually re-running a named audit rule, a Tab-walk step, or the motion check.
- List fixes most severe first. Within a severity, list them in the order Claude should apply them.

## Severity

- **critical**: blocks a task completely for some people. Examples: a keyboard trap, an unlabelled form field, a mouse-only control, sound that plays by itself, flashing, blocked zoom.
- **serious**: makes a task very hard or confusing. Examples: body text below 4.5:1, no visible focus, motion that can't be paused, missing alt text on content images.
- **moderate**: real friction, or a failure in a less important place.
- **minor**: best practice, or a borderline case worth fixing. AAA items go here, labelled as recommendations.

## Writing guidance

- Say what you observed, with measured values ("#999 on white is 2.84:1", "Tab skips it at step 14").
- Merge duplicates. Write one fix per problem, and say if it appears "on every page".
- Prefer native HTML to ARIA in fixes.
- Never call a site "WCAG compliant" or "fully accessible". The page footer says what the report is and isn't.

## VoiceOver check for a person

Put this in `manual_checks`:

> **VoiceOver (10 minutes, Mac):** Cmd+F5 turns it on. Control+Option+U opens the rotor: check that the headings, links, landmarks and form controls lists make sense on their own. Control+Option+Right Arrow reads the next item. Go through the main navigation, one form (submit it empty and listen for the errors) and one dialog. Cmd+F5 turns it off.
