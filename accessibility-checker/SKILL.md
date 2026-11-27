---
name: accessibility-checker
description: Audits a website against WCAG 2.2 Level AA by rendering it in Chrome and testing it the way disabled people use it. It covers keyboard navigation (Tab order, visible focus, traps, skip links, mouse-only controls), colour contrast (text, placeholders, links, field edges, focus rings, with passing colour suggestions), moving or auto-playing content that can't be paused, and screen-reader safety (names, roles, states, alt text, labels, headings, landmarks, status messages). It writes a fix list for Claude to work through, and opens a report page that puts the decisions a person must make (colours, wording, motion) first, followed by every change and its before and after code. Use when someone asks to check accessibility or a11y, audit a site for WCAG, check colour contrast, test keyboard navigation or screen-reader support, or review a site before launch. Works on a local site folder, a local dev server or a live URL.
---

# Accessibility checker

Act as a WCAG accessibility auditor with expert design skills and front-end engineering experience. Render the site in a real browser, test it the way disabled people use it, and report the **WCAG 2.2 Level AA** violations you can prove (AA includes every Level A criterion). Mention AAA only as an optional extra, never as a failure.

The people asking may not be developers. Keep the summary plain, and put the technical detail in the findings.

**Every audit ends with two files**, both built by `build_report.py` from the `findings.json` you write (never write either one by hand, and never put the full report only in the chat):
- `accessibility-audit/accessibility-fixes.md`: instructions for Claude. It lists the decisions and every fix with its before and after code, and says how to apply and verify them. A later session (or another agent) works from this file alone.
- `accessibility-audit/accessibility-report.html`: the report for people. The build script opens it in the browser automatically.

**Files next to this one**
- `audit.js`: run it in the page (don't read it to learn how it works). It measures contrast, names, roles, focus styles, Tab order, target sizes and animations, and installs helpers for the keyboard and motion passes. Its output is **leads**: confirm each one by looking before you report it.
- `findings-format.md`: read it before writing up. It explains how to split findings into decisions and fixes, and the `findings.json` structure.
- `build_report.py`: run it to turn `findings.json` into the two outputs and open the report (don't edit the outputs by hand).
- `more-aa-checks.md`: the other AA checks (reflow, zoom, text spacing, hover content, forms, media).
- `test-page.html`: a deliberately broken page. Auditing it should find every planted problem and nothing in its "Correct things" section.

**Needs** Chrome with the Claude in Chrome extension connected, and Python 3 (for serving local files and building the report). Commands below say `python3`. On Windows, where that command often doesn't exist, use `py -3` (or `python` if `python --version` shows 3.x), and write paths with backslashes or in quotes.

## Progress checklist

Copy this list and tick items off as you go:

```
- [ ] 1. Scope: pages and states to test
- [ ] 2. Page rendered and checked by screenshot
- [ ] 3. audit.js run, leads marked and screenshotted
- [ ] 4. Keyboard walk done
- [ ] 5. Contrast confirmed, including hover/focus/error states
- [ ] 6. Motion and autoplay checked (snapshot and compare)
- [ ] 7. Screen-reader tree reviewed, states toggled
- [ ] 8. Other AA checks (more-aa-checks.md)
- [ ] 9. Every finding verified; findings.json written; build_report.py run (fixes .md written, HTML report opened)
- [ ] 10. Cleaned up
```

## 1. Scope

- **Live URL**: use it as given.
- **Local site folder** (with an `index.html`, or built output such as `dist/`, `build/`, `public/`, `_site/`): serve it so the browser loads it as a real website. Run this in the background, and use the address it prints:
  ```bash
  python3 -u -m http.server 0 --bind 127.0.0.1 --directory "<site folder>"
  ```
  Port `0` picks a free port.
- **Framework dev server** (Vite, Next.js, Astro): use its address, and start it first if it isn't running.

Audit the page you were given. For a whole site, take the home page plus one page of each distinct template (an article, a form or checkout, a listing), and no more than 5 unless asked. Report problems in shared parts (header, footer, nav, cookie banner) once, as "on every page". Also test the states people hit: open menus, dialogs, accordions, tabs, and a form submitted empty so its errors show.

## 2. Render

Read the `anthropic-skills:chrome-browser` skill, then load the tools in one ToolSearch call:

```
select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__resize_window,mcp__claude-in-chrome__tabs_close_mcp
```

Open the site in a new tab at 1280×800. Take a screenshot and check the page really loaded (no blank page, login wall or error). If a cookie or consent banner shows, audit it first, then dismiss it **with the keyboard**. Note it as a finding if you can't.

If Claude in Chrome isn't available, say so. A real audit needs a rendered page. Offer a review of the source code instead, labelled "not rendered: contrast, focus and motion unverified".

## 3. Automated pass

Run `audit.js` before clicking anything on the page, because a mouse click changes which focus styles show.

1. **Load it.** Serve this skill's folder in the background with `python3 -u -m http.server 0 --bind 127.0.0.1 --directory "<this folder>"`. For a local site, serve both folders this way and use each printed port. Then run this with `mcp__claude-in-chrome__javascript_tool`:
   ```js
   await new Promise((ok, no) => { const s = document.createElement('script'); s.src = 'http://127.0.0.1:<port>/audit.js?' + Date.now(); s.onload = ok; s.onerror = no; document.head.appendChild(s); }); __a11ySummary()
   ```
   If it throws, the site's security policy blocked the script. Read `audit.js` and pass its entire contents to `mcp__claude-in-chrome__javascript_tool` instead, then run `__a11ySummary()`.
2. **Read the result.** Tool output is cut off at about 1,000 characters, so `__a11ySummary()` returns one short page. When it ends with `MORE: __a11ySummary(n)`, run that call for the next page, and keep going until it says `END`. Read details the same way, in small pieces, for example `JSON.stringify(__a11yAudit.issues[3].instances.slice(0, 3))`. Never return the whole `__a11yAudit` object at once. `__a11yAudit.issues` holds one entry per rule, with `sc` (the WCAG criterion), `severity`, `count` and up to 20 `instances` (`selector`, `html`, measured values, and `mark`). `keyboard.expectedOrder` is the order Tab should follow. `motion` lists animations, carousels, pause controls and reduced-motion support. `screenReader` gives the headings outline, landmarks and live regions. `notes` says what the script can't judge, and `errors` lists any check that failed to run (do that check by hand).
3. **Look.** Run `__a11yMark(true)`, then take screenshots scrolling down the page. Each flagged element gets an outline numbered by its `mark`. Discard false positives now. Run `__a11yMark(false)` when done.

Optional second opinion, if the page allows it: inject `https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js` the same way. Then run `axe.run({ runOnly: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] }).then(r => window.__axe = r)`, and read `window.__axe.violations` in a later call. Merge its findings with yours and remove duplicates.

## 4. Keyboard

Covers 2.1.1 Keyboard, 2.1.2 No Keyboard Trap, 2.1.4 Character Key Shortcuts, 2.4.1 Bypass Blocks, 2.4.3 Focus Order, 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured (Minimum) and 3.2.1 On Focus.

1. Reload without clicking, load `audit.js` again (the reload cleared it), and run `__a11yTabReset()`.
2. Press Tab (`mcp__claude-in-chrome__computer`, `key: "Tab"`), then run `__a11yFocusInfo()` and take a screenshot. Zoom into its `rect` when the focus ring is faint. A result with `skip: true` is not a site stop: the browser tool parks focus in an empty `div` of its own, and focus passes through the browser toolbar between the end and start of the page. Press Tab again. To skip ahead through stops you have already checked, use `repeat` on the key action. Walk every stop if there are 40 or fewer (`keyboard.tabStops`). Otherwise cover the header and nav, each distinct component, and the footer, and say how far you got.
3. At each stop:
   - **Focus visible**: you can see where you are. A slight colour shift doesn't count, and an outline under 3:1 against its surroundings fails 1.4.11.
   - **Order**: focus follows the visual reading order. Jumps, invisible stops (`visible: false`), and stops inside closed menus fail.
   - **Obscured**: `obscuredBy` with no "partly" means a sticky header, banner or chat widget hides the focused element completely (2.4.11).
   - **No surprises**: focus alone doesn't open pages, submit forms or move focus elsewhere (3.2.1).
   - **Traps**: `possibleTrap: true` or a repeating loop means you're stuck. Try Shift+Tab and Escape. If you still can't leave, it is a critical 2.1.2 failure.
4. Operate things. Buttons respond to Enter and Space, and links to Enter. Disclosures and menus toggle `aria-expanded` and close with Escape. Tabs, radios, listboxes and menus move with the arrow keys. Try every `not-keyboard-reachable` and `pointer-not-focusable` lead: if it does something on click that the keyboard can't, that fails 2.1.1.
5. Dialogs: focus moves in, stays inside, Escape closes, and focus returns to the opener.
6. Skip link: it is among the first two stops, appears when focused, and pressing Enter puts the next Tab inside the main content.

## 5. Colour contrast

Covers 1.4.1 Use of Color, 1.4.3 Contrast (Minimum) and 1.4.11 Non-text Contrast.

- Thresholds: 4.5:1 for text, 3:1 for large text (24px and up, or 18.66px and up when bold), and 3:1 for control edges, focus rings, meaningful icons and chart lines. No rounding: 4.49:1 fails. Exempt: logos, disabled controls, decorative text, and text that is incidental to a photo.
- Quote the measured ratio, the colours and the `suggest`ed replacement for each `contrast-text` finding. For brand colours, also offer the lightest passing alternative.
- `contrast-needs-check` means text over an image, gradient or video. Judge the **worst** spot in a zoomed screenshot. The fix is a solid or semi-opaque backing behind the text.
- States the script didn't see: hover and focus the main buttons and links, show error messages and selected tabs, then re-run `audit.js` or measure from the screenshot.
- Colour alone: errors shown only in red, required fields marked only by colour, colour-only chart legends, and links in sentences that aren't underlined (`link-in-text-colour-only`) all fail 1.4.1.

## 6. Moving and auto-playing content

Covers 1.4.2 Audio Control, 2.2.1 Timing Adjustable (auto-advancing steps, session timeouts), 2.2.2 Pause, Stop, Hide and 2.3.1 Three Flashes.

1. Review `motion` in the audit: animations over 5 seconds (`motion-auto`), carousels, autoplaying video and audio, GIFs, canvas and Lottie animations, and any pause controls.
2. For motion driven by scripts: run `__a11yMotionSnapshot()`, wait 6 seconds without touching the page, then run `__a11yMotionCompare()`. Take screenshots before and after. Repeat at each scroll position that has a hero, carousel, ticker or counter.
3. It **fails 2.2.2** when it starts by itself, lasts more than 5 seconds, is shown alongside other content, **and** has no visible pause, stop or hide control that works from the keyboard and has an accessible name. Pausing on hover doesn't count. Auto-updating content (tickers, feeds, rotating quotes) counts. A spinner shown during a wait is fine.
4. When there is a pause control, use it with the keyboard and run the snapshot and compare again to confirm the motion stopped. If it didn't stop, it is still a failure.
5. Audio that plays by itself for more than 3 seconds without a stop or mute control near the top of the page is a critical 1.4.2 failure.
6. Anything flashing more than 3 times a second is a critical 2.3.1 failure (a seizure risk). Don't record a GIF of it.
7. `prefers-reduced-motion` support is a recommendation (AAA 2.3.3). It doesn't replace a pause control.

## 7. Screen reader

Covers 1.1.1, 1.3.1, 1.3.2, 2.4.2, 2.4.4, 2.4.6, 2.5.3, 3.1.1, 3.1.2, 3.3.1, 3.3.2, 4.1.2 and 4.1.3.

1. Read the accessibility tree with `mcp__claude-in-chrome__read_page` and compare it with the screenshot:
   - Every control's name matches its visible label (an icon button announced as "button" fails). Custom widgets expose the right role and state (`expanded`, `pressed`, `checked`, `selected`).
   - **Toggle things and read the tree again.** A state that doesn't change when the menu opens or the box is ticked fails 4.1.2.
   - The headings outline (`screenReader.headings`) reads like a table of contents. Visual headings that aren't marked up as headings fail 1.3.1.
   - There is a main landmark, and the header, nav and footer are landmarks. Tree order matches visual order (1.3.2).
2. Compare each image with its alt text. Meaningful images get alt text that does the image's job. Decorative images get `alt=""`. Text in an image must be in its alt. A linked image's alt says where the link goes.
3. Submit forms empty or with bad values. Errors must be in text, tied to their field (`aria-describedby` or in the label), and announced: through a live region or alert, or by moving focus to an error summary (3.3.1, 4.1.3).
4. Status messages ("Added to basket", "3 results", toasts) must be in a `role="status"` or `aria-live` region (`screenReader.liveRegions`).
5. Closed menus and dialogs must not be reachable. Visible content must not be hidden with `aria-hidden` (`aria-hidden-focusable`).
6. You can't run a real screen reader. Put the VoiceOver check from `findings-format.md` in the report for a person to do.

## 8. Other AA checks

Follow `more-aa-checks.md`.

## 9. Verify, then report

1. Check every finding: a screenshot, tree reading or measurement shows it, it is AA or A (not AAA), and it isn't a duplicate. If one fails that check, re-test it or drop it.
2. Read `findings-format.md`. Write `accessibility-audit/findings.json` in the current project (or next to the audited folder), and save evidence screenshots to `accessibility-audit/screenshots/`. For each fix, find the source file and line when the code is in this project.
   - **One screenshot per visible fix:** run `__a11yShowIssue('<selector>', 'F3', <screenshot frame width>)` (an array of selectors outlines several elements together). It scrolls the element into view, outlines and labels it, and returns a `region`. Take a `zoom` of that region with `save_to_disk: true`, copy the saved file to `accessibility-audit/screenshots/F3.png`, and set the fix's `screenshot` to `screenshots/F3.png`. Skip it for problems with nothing to see (missing `lang`, blocked zoom). Run `__a11yMark(false)` afterwards to remove the outline.
3. Build the outputs. Always do this step, even for a one-page audit or when the person only asked a quick question:
   ```bash
   python3 "<this folder>/build_report.py" accessibility-audit/findings.json
   ```
   It writes `accessibility-fixes.md` and `accessibility-report.html` next to `findings.json`, then opens the report in the default browser. If it stops with a "findings.json problem" message, fix that entry and run it again. If it prints "Could not open a browser", open the file yourself (Mac: `open`; Windows: `start ""`; Linux: `xdg-open`). Pass `--no-open` only when running without a person, such as in evals.
4. The report page lists the decisions first, with recommendations already picked, then everything that will change, then checks and evidence. People use **Copy choices for Claude** to send their decisions back.
5. In the chat, give the summary, the top three fixes, and the full paths to both files. Explain that `accessibility-fixes.md` holds the instructions Claude works from, and that the next step is to make the decisions on the page (or say "use the recommendations").

Don't change the site's code during the audit. When the person comes back with decisions, work through `accessibility-fixes.md` as its instructions say, then re-run the relevant passes to confirm.

## 10. Clean up

Run `__a11yMark(false)`, close the tab you opened, and stop any servers you started.
