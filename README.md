# AuScan — AI Satellite Gold Prospectivity Intelligence

> Multi-sensor terrain analysis for gold exploration. Built on the Anthropic Claude API. Runs entirely in a browser — no server, no build step, no install.

**v2.1** · Adam R. Cagle — AI systems builder, enablement lead, and writer · May 2026

---

## What It Does

AuScan scans satellite imagery of 10 known world-class gold deposits, builds terrain fingerprints from the spectral and structural signatures it finds, then uses those fingerprints to score any region on Earth for gold prospectivity.

During live testing it produced a **72% HIGH-confidence hit at 42.609°N, -119.299°W** — confirmed against USGS MRDS records as the Pueblo Mining District, Harney County, Oregon: a documented past gold producer with 97.81% of claims now closed and no active modern exploration.

---

## Live Demo

AuScan runs as a Claude artifact. To use it:

1. Open [Claude.ai](https://claude.ai)
2. Create a new Project
3. Upload `src/AuScan.jsx` as a file attachment
4. Send the message: `Run this as a React artifact`

That's it. No API key setup — Claude handles authentication automatically inside the artifact environment.

---

## How It Works

```
LEARN → SYNTHESIZE → SEARCH → TARGET
```

**LEARN** — Scan 10 world-class gold deposit regions. Claude Vision analyzes multi-sensor satellite imagery and builds a terrain fingerprint for each: color signatures, spectral anomalies, structural features, alteration footprints.

**SYNTHESIZE** — Feed all fingerprints to Claude in a single synthesis call. Extract cross-deposit patterns, universal prospectivity indicators, and deposit-type signatures. Save as a named pattern set (.md export).

**SEARCH** — Enter any location (city, ZIP, coordinates, mining district name). AuScan builds an NxN grid over the target area and scores each point against your learned patterns. Results stream in live with a heat grid.

**TARGET** — Save HIGH/VERY_HIGH hits with full coordinates, matched features, anomaly radius, and mineral signature. Run USGS MRDS lookup on any hit to pull historic claim records and district info. Export everything as .md.

---

## Features

- **10 built-in training deposits** — Witwatersrand, Carlin Trend, Kalgoorlie, Muruntau, Grasberg, Oyu Tolgoi, Cerro Negro, Red Lake, Kibali, Pueblo Viejo
- **Multi-sensor analysis** — ESRI RGB, NASA EMIT L2B (hyperspectral), Landsat OLI-TIRS C2, ASTER 14-band, Sentinel-2 L2A
- **Scan all 10 regions unattended** — with retry logic, error recovery, and per-scan hard caps
- **Configurable search grid** — 2×2 to 5×5, 10–100 mile radius
- **Pattern save/load/compare** — name and export pattern sets as .md, reload from file, compare side-by-side
- **USGS MRDS lookup** — per search hit, via Claude's knowledge of the Mineral Resources Data System
- **Full session persistence** — analyses, patterns, targets, and search history survive browser close
- **Export everything as .md** — analyses, pattern sets, target lists with GPS coordinates

---

## Data Sources

| Source | Type | Auth |
|--------|------|------|
| ESRI World Imagery | RGB satellite basemap | Free, no key |
| NASA EMIT L2B | Hyperspectral mineralogy | NASA Earthdata token |
| Landsat OLI-TIRS C2 | Multispectral browse | NASA Earthdata token |
| ASTER Surface Reflectance | 14-band thermal + SWIR | NASA Earthdata token |
| Sentinel-2 L2A | 10m multispectral | Free, no key |
| USGS MRDS | Historic claims | Claude knowledge |

NASA Earthdata token is optional. Enter it in the ⚙ Settings tab — it's session-only and never saved to storage.

> **Note on GIBS:** NASA's GIBS WMS is available in Settings but disabled by default. It rate-limits after 1–2 requests per session, causing Claude's server-side image fetching to stall. Enable only for single test scans.

---

## Architecture

AuScan runs entirely inside the Claude.ai artifact sandbox — a browser-isolated React environment where only `api.anthropic.com` is reachable. Every capability routes through that single endpoint:

- **Geocoding** — Claude converts city/ZIP/region names to WGS84 coordinates
- **Satellite data** — Image URLs passed to Claude Vision, fetched server-side (bypasses browser CSP)
- **MRDS lookup** — Claude's training knowledge of USGS mineral records
- **Storage** — `window.storage` (Claude artifact persistent storage API)

The constraint produced a cleaner architecture. One endpoint. One auth layer. No CORS. No credential management.

---

## Resilience

All scan operations use `Promise.race()` against a shared abort promise — not `AbortController`, which cannot interrupt `Response.json()` body parsing. This is the fix for hung scans at 97%.

- Per-scan hard cap: **5 minutes**
- Per-search-point hard cap: **2 minutes**
- Source fetch timeouts: **8 seconds each**
- Retry engine: **3× with exponential backoff** (4s → 6.4s → 10.2s)
- Manual STOP: kills current Claude call immediately via reject function
- Force Reset: appears after 2 minutes for stuck UI state

---

## Repo Structure

```
auscan/
├── src/
│   └── AuScan.jsx          # The entire application — one file
├── docs/
│   ├── WHITEPAPER.md       # Technical whitepaper (Mermaid diagrams, renders on GitHub)
│   └── auscan-whitepaper.html  # Formatted HTML whitepaper for web
├── README.md
├── LICENSE
└── .gitignore
```

---

## Roadmap — CLAW Port

The natural next step is a port to the CLAW architecture (Node.js, Mac Studio, SQLite) for unrestricted data access:

- Direct Sentinel-2 COG tile fetching with pixel-level band ratios
- Full EMIT L2B NetCDF ingest
- USGS MRDS WFS API direct query
- Automated watchlist scanning
- Results fed directly into the CLAW intelligence pipeline

---

## Documentation

- [Technical Whitepaper (Markdown)](docs/WHITEPAPER.md)
- [Technical Whitepaper (HTML)](docs/auscan-whitepaper.html)
- [Live at adamcagle.com](https://adamcagle.com/wpaper/auscan-whitepaper.html)

---

## Part of the Agentic Womb

AuScan is a research prototype in the Agentic Womb suite, alongside:

| Agent | Function |
|-------|----------|
| **AuScan** | Satellite gold prospectivity intelligence |
| **SSIA** | Single-stock equity signal generation (VRT, CRDO) |
| **BEEF** | Multi-asset anomaly correlation trading |
| **Book Agent** | KDP book marketing automation |
| **RED** | Autonomous Reddit persona (u/crawlspace_coffee) |

All agents run on the Anthropic Claude API.

---

## License

MIT — see [LICENSE](LICENSE)

---

## Author

**Adam R. Cagle** · Co-Creative Director, Agency689 · Founder, Agentic689  
[adamcagle.com](https://adamcagle.com)

*Built on the Anthropic Claude API · May 2026*
