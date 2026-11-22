# Phish Finder dashboard

Phone-first brand-protection console for a **private** Phish Finder repo (installable,
light/dark):

- **Home** – what needs attention now (open critical/high, new since last scan, live
  sites), per-brand severity mix and trend, live scan progress, Scan now.
- **Findings** – search, filter (brand, status, new, critical/high, live, login form,
  on feeds), sort, CSV export; a detail sheet per finding with registrar, hosting, IP,
  abuse contact, reasons, and one-tap takedown actions (e-mail the host's abuse desk
  with a ready-made report, Google Safe Browsing, Netcraft, Microsoft, APWG, registrar
  lookup) and investigation links (urlscan, VirusTotal, crt.sh, WHOIS, Wayback).
- **Triage** – Open → Reviewing → Reported → Taken down, False positive (added to the
  brand's `ignore` list so scans stop reporting it), Ours (added to `official`), notes;
  stored in `triage.json` / `brands.yml` in the private repo.
- **Brands** – add / edit / pause / remove; **Schedule** – daily / some days / every
  N hours / off in Bahrain time, depth, free-minutes meter; **Scans** – history with
  NEW counts, live steps, stop / retry; full HTML report viewer.

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
