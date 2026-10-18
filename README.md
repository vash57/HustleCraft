# ✨ HustleCraft

**Open-source AI Side Hustle Toolkit** for freelancers, indie hackers and micro-business owners.

Winning freelance proposals, high-converting WhatsApp & social ad copy, and defensible pricing
estimations — generated with open-weight models (Gemma 2 / Llama 3) via **Groq cloud**, a **local
Ollama proxy**, or a zero-config **offline engine**. Dark, glassmorphic, heavily animated UI with a
streaming typewriter, particle canvas, execution traces and a floating deal coach.

```
python3 server.py
```

> No `pip install`. No build step. Pure Python standard library + vanilla HTML/CSS/JS.

---

## 🚀 Quick start

```bash
# 1. optional: configure a model provider
cp .env.example .env          # then add GROQ_API_KEY=...  (or point OLLAMA_URL)

# 2. run
python3 server.py

# 3. open
#    local:    http://127.0.0.1:8000/
#    network:  http://<auto-detected-gateway>:8000/   (WSL friendly)
```

Arguments: `python3 server.py --host 0.0.0.0 --port 8000` (env vars `HC_HOST` / `HC_PORT` /
`PORT` also work).

### Model resolution order

| # | Provider | Trigger | Notes |
|---|----------|---------|-------|
| 1 | **Groq** | `GROQ_API_KEY` set | `llama-3.3-70b-versatile` by default, swap via `GROQ_MODEL` |
| 2 | **Ollama** | `http://<gateway>:11434` reachable | `OLLAMA_MODEL` (default `gemma2:9b`) |
| 3 | **Local heuristic** | always available | deterministic templates, still streams with a typewriter effect |

---

## 📡 API

### `GET /api/health`
Server health, active model status and capabilities.

```json
{
  "status": "ok",
  "gateway_ip": "172.22.224.1",
  "model": { "provider": "groq", "name": "llama-3.3-70b-versatile", "available": true },
  "capabilities": { "streaming": true, "modes": ["proposal","adcopy","chat","pricing"] }
}
```

### `POST /api/generate`
Server-Sent Events stream. Request body:

```json
{
  "mode": "proposal | adcopy | chat | pricing",
  "inputs": { "description": "...", "budget": "$1,500", "skills": "React, Stripe" }
}
```

Stream events:

```
data: {"type":"meta","provider":"groq","model":"llama-3.3-70b-versatile", ...}
data: {"type":"token","text":"## Winning Proposal"}
data: {"type":"trace","id":"trace_...","steps":[{"name":"first-token","ms":241.5}], "tokens":{...}}
data: {"type":"done","status":"ok","id":"trace_..."}
```

### `POST /api/trace`
Logs a Mastra / Sentry style execution trace (step latency, model, token usage) in memory and
returns `{ "ok": true, "id": "trace_..." }`. `GET /api/trace` returns the 20 most recent entries.

---

## 🧩 Frontend features

| Feature | Where |
|---|---|
| **Proposal & Pitch Generator** — structured pitch, key selling points, risk assessment, pricing | `Proposal & Pitch` tab |
| **WhatsApp & Social Ad Copywriter** — 3 emoji/CTA variants per platform & tone | `WhatsApp & Social Ads` tab |
| **Pricing Estimator** — live rate math + AI package/anchor breakdown | left column, proposal tab |
| **Floating AI Deal Coach** — negotiation & pricing chat drawer | bottom-right FAB |
| **Mastra / Sentry Trace Viewer** — step latency, model, token counters | `Traces` panel |
| **Local History** — auto-saved outputs with animated restore/delete | `History` panel |
| **Hacktoberfest 2026 drawer** — prize badges + 1-click DEV.to Markdown exporter | header 🎁 button |
| **Particle canvas** — drifting pixels with cursor repulsion & connective threads | background |
| **Streaming typewriter + shimmer skeletons** | every generator |

Everything is stored in `localStorage` — generated content never leaves the browser.

---

## 📁 Project layout

```
HustleCraft/
├── server.py            # stdlib HTTP server: static, /api/health, /api/generate (SSE), /api/trace
├── static/
│   ├── index.html       # app shell: tabs, drawers, chat, trace viewer, showcase
│   ├── style.css        # zinc-950 glassmorphism, gradient borders, 25+ keyframe sets
│   └── app.js           # particles, SSE consumer, typewriter, history, traces, chat
├── .env.example
└── README.md
```

## 🎁 Hacktoberfest 2026 tracks

| Track | Prize | Focus |
| --- | --- | --- |
| 🥇 Gemma | **$200** | Best use of Gemma 2 open-weight models |
| 🥇 Render | **$200** | Cleanest deploy + developer experience |
| 🥈 Mastra | **$100** | Agent traces & workflow observability |
| 🥈 Atlas | **$100** | Docs, samples and contributor onboarding |

Use the in-app **Export DEV.to Markdown** button to generate a front-matter packed article from your
current session (outputs + live trace stats + prize tracks).

## 🧪 Verification

```bash
python3 -m py_compile server.py          # server syntax
node --check static/app.js               # frontend syntax
python3 server.py &                      # boot
curl -s localhost:8000/api/health         # health JSON
curl -sN -X POST localhost:8000/api/generate \
     -H 'content-type: application/json' \
     -d '{"mode":"adcopy","inputs":{"offer":"$149 IG audit for cafés"}}' | head
```

## 📄 License

MIT — contributions welcome during Hacktoberfest 2026.
