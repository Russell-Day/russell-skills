# design-refs

- Written for this library (no upstream repo); MIT like the rest of this repo.
- Created: 2026-11-04
- Kind: has-scripts · status: available

## Files

- `SKILL.md`: the flow (own collection → free galleries / named apps → optional dembrandt tokens → side-by-side image → build)
- `scripts/shoot.py`: URL(s) → phone 393x852 + desktop 1440x900 PNGs (Playwright, fresh context, no logins)
- `scripts/grid.py`: images + captions → one side-by-side PNG (+ the same grid as HTML)

## Notes

Both scripts carry PEP 723 metadata, so `uv run scripts/shoot.py ...` pulls
Playwright on the fly; plain `python3` works where Playwright is installed.
No network calls besides loading the pages you name. `design_refs_search` is a
tool of the TEDI MCP server; the skill works without it.
