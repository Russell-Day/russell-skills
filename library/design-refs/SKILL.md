---
name: design-refs
description: Before building a UI pattern (settings page, sidebar, chat composer, empty state...), look at 3-4 really good working examples first - the user's saved design collection (design_refs_search, if the TEDI MCP server has it), free galleries (component.gallery, shadcn blocks, 21st.dev) and screenshots of best-in-class apps at phone and desktop size - then show them side by side, say what each borrows, and build. Includes ready scripts to screenshot URLs and make the side-by-side image.
---

# Design references before you build

Models build generic UI from memory. Building from a few real, well-made
examples of the same pattern gets much closer to "good" on the first try. This
skill is how to find them fast, show them, and borrow from them.

**When:** a new screen, component or flow, or a redesign ("build a settings
page", "make the composer feel better"). **Skip it** for tiny tweaks (a color,
a padding, a bug fix), or when the user already gave you a reference. It is a
guide, not a gate: 5-10 minutes, then build.

## 1. Name the pattern

Write the pattern in 1-3 plain words the way a gallery would file it:
`chat composer`, `settings page`, `sidebar`, `command palette`, `empty state`,
`onboarding`, `pricing table`, `data table`, `bottom sheet`. Note the device
that matters most (phone first or desktop first) from the project's own rules.

## 2. The user's own collection first

If the TEDI MCP server is connected and has a `design_refs_search` tool, call
it with the pattern words (try a synonym too: `composer`, `chat input`):

```
design_refs_search(query="chat composer", limit=10)
```

Each hit has the url, the user's note, design tags ("frosted sheet, dense
list") and absolute paths to its phone (393x852) and desktop (1440x900)
screenshots. **Open the screenshot files and look at them** (your file-read
tool shows images); the note and tags say what the user liked about it. Their
saved picks outrank anything you find yourself. If the tool isn't there or
finds nothing, say so in one line and go on.

## 3. Free galleries and best-in-class apps

Pick whichever fits the pattern; you rarely need more than two sources.

| Source | Good for | How |
|---|---|---|
| Real apps you know are best-in-class for the pattern | Anything: composers (chatgpt.com, perplexity.ai, v0.app), lists and issue views (linear.app), docs (stripe.com/docs), settings (github.com/settings needs login: pick public pages) | Screenshot with `scripts/shoot.py` (below) |
| [component.gallery](https://component.gallery/components/) | How 50+ real design systems do one component (states, sizes, naming) | `https://component.gallery/components/<name>/` e.g. `textarea`, `tabs`, `accordion`; open the examples it links |
| [shadcn/ui blocks](https://ui.shadcn.com/blocks) | Working React + Tailwind app blocks (sidebar, login, signup, dashboard), MIT | Category pages `/blocks/sidebar`; each block has a standalone preview at `/view/new-york-v4/<block>` (e.g. `sidebar-07`) that shoots cleanly; `npx shadcn@latest add <block>` installs code |
| [21st.dev](https://21st.dev/community/components) (optional) | Community React/Tailwind components, MIT | Browse `https://21st.dev/community/components/s/<tag>` (e.g. `ai-chat`) and screenshot; their MCP is only for projects that already set it up (free tier is a few calls a day) |
| Landing/marketing pages only | [godly.design](https://godly.design), [land-book.com](https://land-book.com), [minimal.gallery](https://minimal.gallery) | Browse, pick, screenshot |

Free sources only. Don't sign up for anything, log in, or use paid galleries.

Pick pages that **show the pattern logged out**: many apps show a login wall to
a fresh browser (claude.ai does), so check the shot and swap in another app or a
gallery page if the pattern isn't on screen.

### Screenshot script

`scripts/shoot.py` takes URLs and writes two PNGs per URL: phone 393x852 (iPhone
user agent, touch) and desktop 1440x900, above the fold. Fresh browser context,
no cookies or logins; clicks common cookie banners away. It needs Python with
Playwright; `uv run` installs it on the fly:

```bash
S=<this skill's folder>/scripts
uv run "$S/shoot.py" chatgpt.com perplexity.ai https://ui.shadcn.com/view/new-york-v4/sidebar-07 --out /tmp/refs
# or: python3 "$S/shoot.py" ...   (when playwright is already installed)
```

Options: `--only phone|desktop`, `--full` (whole page), `--dark`, `--dpr 2`
(sharper phone shot), `--wait 3000` (slow hero animations), `--keep-banners`.
It prints one JSON line per URL with the PNG paths (or the error), and keeps
going when one site fails. First run on a new machine may ask for
`uv run --with playwright playwright install --only-shell chromium`.

Then **look at every shot** before using it. Drop ones where a banner, login
wall or loading spinner hides the pattern.

## 4. Optional: exact tokens from a site the user picked

When the user points at a site and says "make it feel like this", pull its real
tokens (colors, type scale, spacing, radii, shadows) instead of eyeballing:

```bash
npx -y dembrandt https://linear.app --json-only > /tmp/refs/linear-tokens.json
npx -y dembrandt https://linear.app --tailwind /tmp/refs/linear-theme.css   # Tailwind v4 @theme
```

`--mobile` reads the phone viewport, `--dark-mode` the dark palette. Map the
values onto the project's own tokens; don't paste a foreign theme over them.

## 5. Show 3-4 side by side, then build

Put the best 3-4 references in **one image** with a one-line caption each
saying what you will borrow, and show it to the user (or put its path in your
report). People judge designs by looking, not by reading a list of URLs.

```bash
uv run "$S/grid.py" --out /tmp/refs/composer-refs.png --title "Chat composer: references" \
  "/tmp/refs/perplexity.ai-phone.png=perplexity.ai: composer docked at the bottom, tools inside the box" \
  "/tmp/refs/chatgpt.com-phone.png=chatgpt.com: one pill, + on the left, voice on the right" \
  "/tmp/refs/v0.app-phone.png=v0.app: two rows, send disabled until there is text"
```

Each argument is `IMAGE=caption`; all images go in one row at 640 px height
(`--height`, `--cols 2` to wrap). It also writes the same grid as an `.html`
page beside the PNG. The user's saved screenshots from step 2 go in the same
grid.

Then build. Borrow **structure and proportions** (where things sit, density,
hierarchy, which controls are visible vs tucked away), not brand: keep the
project's own tokens, fonts, components and rules (its UI skill wins on
conflicts). In the final report, name which reference each main decision came
from.

## 6. Found something really good?

If a reference you found is worth keeping for next time, add it to the user's
collection if a save route exists in your tools (a TEDI chat message such as
"nice design <url>" saves it there). Otherwise list it under **Worth saving**
in your final report: url + one line on what is good about it, so the user can
save it.

## Checklist

- [ ] Pattern named in plain words; phone or desktop first decided
- [ ] `design_refs_search` tried (or noted as unavailable)
- [ ] 3-4 shots looked at; blocked/login-wall shots dropped
- [ ] One side-by-side image with a borrow line per reference, shown
- [ ] Built in the project's own tokens; report says what came from where
- [ ] Really good finds listed under "Worth saving"
