# Phish Finder dashboard

Phone-friendly control page for a **private** Phish Finder repo: add / edit / pause /
remove brands, change the scan schedule (Bahrain time), start scans, follow runs and
read the latest findings.

**This repository contains only code.** No brands, findings, reports or keys are
stored here. The page talks straight from your browser to `api.github.com` using a
fine-grained GitHub key that you paste once; the key is kept only in that browser's
local storage and is limited to the one private repo.

- `index.html`, `style.css`, `app.js` – the page
- `dashlib.js` – cron (Bahrain ⇄ UTC), workflow schedule rewrite, `brands.yml` format, zip reader
- `js-yaml.min.js` – js-yaml 4.1.0 (MIT, see `js-yaml.LICENSE`)
- `tests/test.js` – `node tests/test.js`

Security notes: strict Content-Security-Policy (scripts only from this site; network only
to GitHub), all repo data is rendered as text, and the full HTML report opens in a
sandboxed frame that cannot read the key. The CSP also allows the SHA-256 of the
Phish Finder report's inline script so the report renders inside that frame; if the
report template changes, update that hash in `index.html` (or use “Download”).
