# Other WCAG 2.2 AA checks

Quick checks outside the four main passes. Do them unless the person asked for only the main four, and report the results under "Other AA criteria".

- **Reflow (1.4.10)**: resize the window to 320px wide with `mcp__claude-in-chrome__resize_window`, then check `innerWidth`. Chrome often won't shrink a window that far (it stays wide). If so, load the same page in a 320px-wide `<iframe data-a11y-checker>` fixed over the page, compare its `contentDocument.documentElement.scrollWidth` with 320, screenshot it, and remove it afterwards. Text content must not need horizontal scrolling, and no content or function may be lost. Large tables, maps and diagrams are exempt.
- **Resize text (1.4.4)**: at 200% zoom, nothing is cut off or overlapping. The audit flags a viewport tag that blocks zoom (`viewport-zoom-blocked`).
- **Text spacing (1.4.12)**: run this in the page, take a screenshot, and look for text that is clipped or overlapping:
  ```js
  document.head.insertAdjacentHTML('beforeend', '<style data-a11y-checker>*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}</style>')
  ```
  Remove it afterwards with `document.querySelectorAll('style[data-a11y-checker]').forEach(s => s.remove())`.
- **Content on hover or focus (1.4.13)**: tooltips and hover menus can be dismissed with Escape, stay open while the pointer moves onto them, and don't disappear on their own.
- **Target size (2.5.8)**: confirm the `target-size` findings in a screenshot. Inline links in sentences are exempt.
- **Orientation (1.3.4)**: the layout works both portrait and landscape (a phone-width window turned sideways).
- **Consistency across pages (3.2.3, 3.2.4, 3.2.6)**: navigation, repeated components and help links stay in the same order and use the same names on every page.
- **Forms and sign-in (3.3.3, 3.3.4, 3.3.7, 3.3.8)**: error messages suggest a fix, legal or financial submissions can be checked or undone, information already entered isn't asked for again, and signing in doesn't depend on a memory or puzzle test unless an alternative is offered. Pasting into password fields must work.
- **Media (1.2.2, 1.2.4, 1.2.5)**: videos have captions and audio description (or a full text alternative), and live video has live captions. Check only that they exist and are switched on in the player. Judging their quality is outside this audit.
