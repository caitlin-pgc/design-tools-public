---
name: device-views
description: Opens a website (a local site folder, a page in it, a local dev server, or any page on the web) in a browser viewer that shows it at real desktop, iPad and mobile screen sizes, side by side or one at a time, with zoom-out to see a whole layout at a glance. Use when someone wants to "see it on mobile/iPad/desktop", "check how it looks on different devices", "preview the responsive version", "compare screen sizes", or check a change at every width before or after it goes live.
---

# Device views

`viewer.html` (next to this file) shows one page in three frames: Desktop, iPad and Mobile. Each frame is the real page at that device's real screen size, so the site's breakpoints and `svh` heights behave exactly as on the device. Zooming out only shrinks the picture; it never changes the layout. It changes nothing in the site.

`serve.py` (next to this file) serves the site and the viewer from one local address. It needs only Python 3 and writes nothing into the site's folder.

The people using this are often not developers. Tell them what to do in plain words.

## 1. Work out what to show

- **A website folder** (plain HTML files, or a built site such as `dist/`, `build/`, `public/` or `_site/`): this is the usual case. The site folder is the one holding the home page's `index.html`. In a project, it's usually the project's root folder or its build output.
- **A site that runs its own dev server** (Vite, Next.js, Astro, a framework's `npm run dev`): use its address, such as `http://localhost:5173/`. Start the dev server first if it isn't running.
- **A page on the web** (`https://…`): this works too, but many sites refuse to be shown inside a frame. If a frame shows blank, say so and suggest opening the page directly.

"Scroll together" only works for pages served by `serve.py`, because the viewer can only follow a frame's scroll position when both come from the same address. For a dev server or a web page, everything else still works.

## 2. Start it

1. Run the server in the background, giving the site folder:
   ```bash
   python3 "<this folder>/serve.py" "<site folder>"
   ```
   It uses port 8787, or the next free port if that one is busy, and prints the viewer's address (`Viewer: http://127.0.0.1:<port>/__device-views/viewer.html`). Use the address it prints. On Windows the command may be `py` instead of `python3`.
2. Open the viewer with `?src=/` added (Mac: `open "<address>"`; Windows: `start "" "<address>"`; Linux: `xdg-open "<address>"`):
   ```
   http://127.0.0.1:<port>/__device-views/viewer.html?src=/
   ```
   - `src` is the page to show: `/` for the home page, a path such as `/about.html`, or a full address such as `http://localhost:5173/`. Encode it if it contains `&` or `#`.
   - Add `&view=desktop`, `&view=tablet` or `&view=phone` to open straight onto one device. The default is `all`.

For a dev server or a web page you still need `serve.py` to load the viewer. Point it at any folder (the current one is fine) and pass the full address as `src`.

## 3. Check, then hand over

If a Chromium browser (Chrome, Edge, Chromium) is installed, take a screenshot headlessly before saying it's ready, and look at it:

```bash
"<browser>" --headless=new --window-size=1440,900 --virtual-time-budget=4000 --screenshot="<temp folder>/views.png" "<address>"
```

Check all three frames show the page, not a blank or an error. If one is blank, the path is probably wrong: check the file exists in the site folder. If no browser can be found, skip this step and say so.

## 4. Explain how to use it

Keep it short:
- **Tabs** at the top: **All** shows desktop, iPad and mobile side by side. **Desktop**, **iPad** and **Mobile** show one device on its own, larger. Keys 1 to 4 switch between them.
- **Zoom:** each device has − and + buttons and a zoom menu. **Fit** sizes it to the window. In All, desktop and iPad share one scale so they stay in true proportion. Mobile fits the window's height and never goes above 100%, so it stays readable. Pick a percentage to fix a size.
- **Model:** the menu on each device switches between screen sizes (Laptop 1440×900, Large desktop 1920×1080, iPad mini 768×1024, iPad Air 820×1180, iPhone 15 390×844, iPhone SE 375×667 and others). **Rotate** turns the iPad or phone sideways.
- **Scroll** inside any view to move down that view only. To make them move together, tick **Scroll together** (in All): the other views then follow to the same point of the page. It starts unticked.
- **Reload** (or the R key) reloads every view, after a change to the site.
- **↗** opens the page on its own in a new tab.
- **Change page:** type a path or address in the box at the top, or pick one from its list (every HTML page in the site folder), and press Show.

Their choices (tab, models, zoom) are remembered in that browser.

## 5. When they spot a problem

Fix it in the site's own files, then ask them to press Reload. If the site is built (for example into `dist/`), rebuild it first, or use its dev server so changes show straight away. Say which view to look at, and at which model, since some layouts change only between two models (for example between iPad mini at 768 and iPad Air at 820). Use the breakpoints the site already has rather than adding new ones, unless you say why.

## Limits

- Each frame has the device's size, not the device itself. Hover still works, touch-only behaviour and the phone's own browser bars (which change `svh`) aren't simulated, and text is rendered by the computer's browser. For a final check, look on a real phone.
- Zooming below about 33% makes text hard to read. It's for the overall shape of the page.
- Pages that link to files on their live domain will load those parts from the live site, not the local copy.
- Stop the server when they're done, unless they want to keep it.
