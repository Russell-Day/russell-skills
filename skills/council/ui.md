# UI council

The council loop from [SKILL.md](SKILL.md), set up for a screen's look and
feel. Use it when the user asks for a council on UI or design ("UI council",
"council the design", "get this page to 9/10"). Members, dispatch, the
cheapest-first loop, unavailable members and the 9/10 bar stay the same. What
changes: members score fresh screenshots next to reference apps, category by
category, and the work ends with a before/after image that shows what
changed.

The method comes from Theo's design council (video "Agents Sucked At UI
(Until Today)", 2026-11-03, and pingdotgg/t3code PR #24865). He found three
things. Scored alone, a screen gets about 9. Put next to good apps, the same
screen drops to about 7, which is the honest score. Telling members the
target makes their scores drift toward it. And without numbered callouts, even
the owner couldn't see what had changed.

## Before round 1

1. **Owner calls.** List the user's taste decisions that stay, in their own
   words (a look they like, a color, a density). Add one line on what the
   screen is for and who uses it, and on what device. Every member brief
   carries both, and the lead turns down findings that go against an owner
   call.
2. **Before shots, before any edit.** Capture every main state of the screen
   (empty, busy, open item, menus, dialogs, errors) at the sizes and themes
   the user actually uses, the main one first. Use real or seeded data that
   looks like real use, not lorem ipsum. Name the files
   `before-<viewport>-<theme>-<state>.png` and keep them in one folder.
3. **Same data for before and after.** Before and after shots must show the
   same content, or the change is lost among new list items. Seed fixed data,
   or shoot both in one session against the same backend: run the base commit
   from a separate worktree on its own port.
4. **References.** Add 2 to 4 good apps that do the same job, shot at the same
   sizes. They show what a 9/10 looks like. They are not something to copy:
   members never suggest copying a reference's layout, look, names or
   branding.

## The UI member brief

Use a plain brief, not the code review prompt: what the screen is for, the
owner calls, and the paths of the before shots, the current after shots and
the reference shots. Add the diff when there is one. Then add:

> You are one member of a design council. Work read-only. Score the current
> screen and each reference from 1 to 10 in each category: hierarchy,
> typography, spacing and alignment, color and contrast, iconography,
> consistency, and flow (clicks to do the main task, states, feedback).
> Score phone fit too when phone shots are included. Give the scores as a
> table with a row for each category and a column for this screen and for
> each reference. Then list your findings, most serious first, each with the
> screenshot, the spot on it and the file if you know it. Judge the screen by
> how well it does its job, using the references only to calibrate. Finish
> with exactly these two lines, where N is this screen's lowest category
> score:
> `SCORE: N/10`
> `Short of 10 because: <one line>`

Never tell members the bar they need to clear, or what other members
scored.

## Each round

- **Fresh after shots every round.** Shoot the same states at the same sizes on
  the same data, after the fixes. A member scoring stale shots wastes a
  round.
- **Watch for drift.** Before each recheck, look at the new shots next to the
  before shots and the owner calls yourself. Councils tend to push toward gray,
  neutral, look-like-the-reference screens. Turn down findings that strip out
  the product's own look.
- **Keep the bar at 9 unless the user names a higher one.** Theo's 9.5 pass
  took ten more rounds than reaching 9.
- When you report progress mid-council, attach that round's before/after
  image (below), not a list of class names.

## The before/after (required at the end)

When the council passes, make a before/after image that shows the user what
changed without hunting:

- For each main state that changed, show the before and after side by side,
  main size and theme first.
- Number every change, draw a box around it in the after shot and around the
  same spot in the before shot, and give a legend that says what changed in
  plain words ("Project, model and effort move from three selects into chips
  in the composer").
- Add close-ups (`"zoom": true`) for changes too small to see at full size,
  like a font weight, a radius, an icon stroke or a contrast step.
- Leave out states that didn't change.

[scripts/before_after.py](scripts/before_after.py) builds it from a small
JSON spec (`uv run scripts/before_after.py spec.json --out compare.png`; the
spec format is in the script's docstring). Take box coordinates from the DOM
while capturing (`locator.bounding_box()` times the device scale factor).
Failing that, run `--grid shot.png` to get a coordinate grid you can read off
by eye.

Show it everywhere the scores go:
- the final reply, with the image embedded and the legend as text under it;
- any chat or channel post about the council, with the image attached as a
  picture (the project's post script or upload), not only its path: the user
  reads these on a phone and can't open a repo path;
- the PR description, with images and the legend;
- the commit body, with the legend lines and the image path.

## Recording

Use the Council table from SKILL.md (scores are each member's lowest
category). Add one table for the final round:

```markdown
| Member | Lowest category | This screen | <Reference A> | <Reference B> |
|---|---|---|---|---|
| Opus 5.5 (high) | 9 (spacing) | 9.3 | 8.8 | 9.0 |
```

Then list the owner calls that stayed and the findings you turned down
because of them.
