---
fledgling: patch
---

When claiming a brand-new name with `--new` and no repo can be resolved, skip trusted publishing (with a note) instead of erroring out the whole run — you can wire it up later with `fledgling sync`.
