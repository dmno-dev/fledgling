---
'fledgling': patch
---

Read npm's own `NPM_CONFIG_OTP` env var as a fallback for `--otp`, so a 2FA code supplied that way also suppresses the interactive browser-approval prompt instead of fledgling assuming it still needs one. Docs now lead with npm's browser flow — approving with a passkey or security key is how most people will do this, and npm is moving away from authenticator codes — with the `--otp` / `--otp-secret` options kept but framed as the legacy fallback.
