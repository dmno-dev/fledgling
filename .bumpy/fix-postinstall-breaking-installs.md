---
fledgling: patch
---

Fix `npx fledgling` (and every other install) doing nothing at all. The `postinstall: lefthook install` script ran on end-user installs, but `lefthook` is a devDependency and isn't there — so the script exited 127, npm aborted the install before ever reaching the `bin`, and since npm swallows script output at the default loglevel you got zero output and no error. Moved git-hook installation to `prepare`, which runs in the repo and before publish but not for consumers installing from the registry.
