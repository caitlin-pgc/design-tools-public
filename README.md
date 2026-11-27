# Design tools for Claude Code

Three [Agent Skills](https://code.claude.com/docs/en/skills) for designers and front-end developers, packaged as a Claude Code plugin.

| Skill | What it does |
|---|---|
| `accessibility-checker` | Audits a website against WCAG 2.2 AA in a real Chrome browser: keyboard navigation, colour contrast, moving content you can't pause, and screen-reader support. Opens a report page with the decisions you need to make (colours, wording, motion) first, and writes a fix list Claude works through once you've decided. |
| `colour-wheel` | Places hex colours on a painter's colour wheel, with complements tuned to a contrast target. |
| `device-views` | Shows a website at desktop, iPad and mobile sizes side by side. |

## Install

In Claude Code:

```
/plugin marketplace add caitlin-pgc/design-tools-public
/plugin install design-tools@design-tools-public
```

Or from a terminal:

```bash
claude plugin marketplace add caitlin-pgc/design-tools-public
claude plugin install design-tools@design-tools-public
```

The skills then appear in `/skills` as `design-tools:accessibility-checker`, `design-tools:colour-wheel` and `design-tools:device-views`. Claude uses them when your request matches, or you can call one directly, for example `/design-tools:accessibility-checker https://example.com`.

To update to the latest version: `/plugin marketplace update design-tools-public`.

### Without the plugin system

Copy a skill folder into `~/.claude/skills/` (for all your projects) or into `.claude/skills/` in a project:

```bash
git clone https://github.com/caitlin-pgc/design-tools-public.git
cp -r design-tools-public/accessibility-checker ~/.claude/skills/
```

## Requirements

- **accessibility-checker**: Chrome with the [Claude in Chrome](https://claude.com/chrome) extension connected, and Python 3 for local sites.
- **device-views**: Python 3. Chrome is optional, for the screenshot check.
- **colour-wheel**: a web browser.

## Trying the accessibility checker

`accessibility-checker/test-page.html` is a deliberately broken page. Ask Claude to "check accessibility-checker/test-page.html for WCAG AA problems". It should find every planted problem, and nothing in the page's "Correct things" section.

Each skill has an `evals/evals.json` with test scenarios and the behaviour to expect.

## Licence

MIT. See [LICENSE](LICENSE).
