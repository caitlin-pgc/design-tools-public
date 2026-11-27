---
name: colour-wheel
description: Opens a colour wheel page where people paste hex codes and see every colour placed on a 36-segment painter's wheel (yellow at the top, a pale tint band outside, rings darkening to black toward the centre, complements around the hub), with its segment number, tint or shade ring, complement (with its hex code, made light or dark enough to reach a contrast target set per colour) and whether it's muted. Use when someone wants to "see my colours on a colour wheel", "plot these hex codes", "where do these colours sit", "check if my palette is complementary/analogous", or compare a set of brand colours by hue.
---

# Colour wheel

`wheel.html` (next to this file) is a single page with no server and no dependencies. It works opened straight from the file.

The people using this are often not developers. Tell them what to do in plain words.

## 1. Open it

If they gave hex codes, put them in the link so the wheel opens with them already placed (codes without `#`, comma-separated):

```
file://<absolute path to this folder>/wheel.html#c=1F6F5C,F2C14E,E76F51
```

To open a colour with its own contrast target, add it after a dash, for example `F2C14E-4.5`. Without one, a colour uses 3:1.

Open it with `open "<link>"` on Mac or `start "" "<link>"` on Windows. With no codes, open `wheel.html` on its own. It shows the last list used in that browser.

## 2. Explain how to use it

Keep it short:
- **Add colours** by pasting hex codes into the box (any separator, `#` optional, 3- or 6-digit) and pressing **Add colours** (or Cmd/Ctrl+Enter), or by picking one with the colour picker. Anything that isn't a hex code is listed as skipped.
- **Where each colour sits:** the angle is its hue (segments 1–36; 1 is yellow, 7 red, 13 magenta, 19 blue, 25 cyan, 31 green). The distance from the centre is how light or dark it is compared with the pure colour: lighter goes into the pale outer band, darker goes toward the centre. Greys, black and white have no hue and sit in the black centre.
- **The list** gives each colour's segment, ring, complement segment, and "muted" or "very muted (greyed)" when it is much duller than the wheel colour at the same lightness.
- **Lines to centre / Show complements** draw spokes, and each colour's complement as a dashed dot with the same number, with its hex code in the list (Copy or Add it to the palette). The complement is the hue turned 180° at the same saturation, made lighter or darker, as little as possible, until it reaches that colour's contrast target.
- **Show analogous:** click a colour on the wheel or in the list to select it (click again to deselect). Its two analogous colours, the hue turned 3 segments (30°) each way at the same saturation and lightness, appear as dotted dots labelled with its number plus "a" or "b", with their hex codes in the list (Copy or Add). Selecting a colour turns this on.
- **Contrast** (a slider under each colour, shown with complements on) sets that colour's own target, from 1:1 to 7:1 in steps of 0.5. 1:1 keeps the complement at the same lightness, which clashes but barely contrasts. 3:1 (the default) is enough for large text and icons, 4.5:1 for body text (AA), and 7:1 for body text (AAA). The list shows the contrast the pair actually reaches and an "Aa" sample of the complement on the colour. If a target is too high for that colour (7:1 next to a mid-tone, say), it says so and gives the most it can get. A high target can turn the complement nearly black or white; its dot then sits at the dark or pale end of the opposite spoke.
- **Credit:** the wheel is based on Don Jusko's Real Color Wheel, from a photo by Michael Hernandez (CC BY 2.0). The page credits it under the buttons.
- **Copy link** copies a link that reopens with the same colours and contrast targets. **Download image** saves the wheel with markers as a PNG.

## 3. If they ask what the wheel says

Read the segment numbers from the list. Two colours about 18 segments apart are complements. Colours within about 3 segments of each other are analogous. Three spaced about 12 apart form a triad. Say it in plain words ("your green and terracotta sit almost opposite each other, so they contrast strongly").

## Limits

- The wheel uses screen (RGB) hues spaced evenly, so printed colours, especially cyan and magenta, can sit differently on a painter's or print wheel.
- Position is by hue and lightness only. Dullness is reported in words rather than shown by position, because the wheel has no grey axis.
