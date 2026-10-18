#!/usr/bin/env python3
"""HustleCraft — open-source AI Side Hustle Toolkit.

Pure Python standard-library HTTP server. No pip installs required.

    python3 server.py

Endpoints
    GET  /api/health   -> server health, model status, capabilities
    POST /api/generate -> Server-Sent Events stream of AI output
    POST /api/trace    -> Mastra / Sentry style execution traces
    GET  /api/trace    -> recent recorded traces (debug/UI convenience)

Providers (auto-detected, in order):
    1. Groq cloud API  (set GROQ_API_KEY)  — Gemma 2 / Llama 3 open-weight models
    2. Local Ollama    (OLLAMA_URL proxy, default http://172.22.224.1:11434)
    3. Built-in offline heuristic generator (always works, zero config)
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from urllib.parse import unquote, urlparse

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

SERVICE = "hustlecraft"
VERSION = "1.0.0"
MAX_BODY_BYTES = 262_144
MODES: Tuple[str, ...] = ("proposal", "adcopy", "chat", "pricing")

DEFAULTS: Dict[str, str] = {
    "HC_HOST": "0.0.0.0",
    "HC_PORT": "8000",
    "GROQ_API_KEY": "",
    "GROQ_MODEL": "llama-3.3-70b-versatile",
    "GROQ_URL": "https://api.groq.com/openai/v1/chat/completions",
    "OLLAMA_URL": "http://172.22.224.1:11434",
    "OLLAMA_MODEL": "gemma2:9b",
    "HC_TIMEOUT": "60",
    "HC_GATEWAY_IP": "",
    "HC_ACCESS_LOG": "1",
    "HC_OFFLINE_MS": "11",
}

_TRACES: deque = deque(maxlen=64)
_STARTED_AT = time.time()
_TRACE_LOCK = threading.Lock()
_TRACE_SEQ = 0


def load_env_file() -> None:
    """Parse a dotenv style .env file without overriding real env vars."""
    path = BASE_DIR / ".env"
    if not path.is_file():
        return
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


def cfg(key: str) -> str:
    value = os.environ.get(key)
    if value:
        return value
    return DEFAULTS.get(key, "")


def cfg_int(key: str, fallback: int) -> int:
    try:
        return int(str(cfg(key)).strip() or fallback)
    except (TypeError, ValueError):
        return fallback


load_env_file()


def host_bind() -> str:
    return os.environ.get("HC_HOST") or os.environ.get("HOST") or DEFAULTS["HC_HOST"]


def port_bind() -> int:
    raw = os.environ.get("HC_PORT") or os.environ.get("PORT") or DEFAULTS["HC_PORT"]
    try:
        return int(raw)
    except ValueError:
        return 8000


# --------------------------------------------------------------------------
# WSL / container gateway detection
# --------------------------------------------------------------------------

_GATEWAY_CACHE: Optional[str] = None


def _ip_from_hex(hex_ip: str) -> Optional[str]:
    """Little-endian hex (as found in /proc/net/route) -> dotted quad."""
    if len(hex_ip) != 8:
        return None
    try:
        octets = bytes.fromhex(hex_ip)
    except ValueError:
        return None
    if len(octets) != 4:
        return None
    ip = ".".join(str(b) for b in reversed(octets))
    if ip == "0.0.0.0" or ip.startswith("127."):
        return None
    return ip


def _gateway_from_proc() -> Optional[str]:
    try:
        with open("/proc/net/route", "r", encoding="utf-8", errors="replace") as fh:
            header = fh.readline()
            if not header:
                return None
            best: Optional[Tuple[int, str]] = None
            for line in fh:
                parts = line.split()
                if len(parts) < 4:
                    continue
                if parts[1] != "00000000":
                    continue
                ip = _ip_from_hex(parts[2])
                if not ip:
                    continue
                flags = int(parts[3], 16) if re.fullmatch(r"[0-9A-Fa-f]+", parts[3]) else 0
                metric = int(parts[6]) if len(parts) > 6 and parts[6].isdigit() else 0
                if not (flags & 0x1):  # RTF_UP
                    continue
                if best is None or metric < best[0]:
                    best = (metric, ip)
            if best:
                return best[1]
    except OSError:
        pass
    return None


def _run(cmd: List[str], timeout: float = 2.0) -> Optional[str]:
    import subprocess  # local import: only used on POSIX fallback paths

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = (proc.stdout or "").strip()
    return out or None


def _gateway_from_ip_route() -> Optional[str]:
    out = _run(["ip", "route", "show", "default"])
    if out:
        match = re.search(r"via\s+(\d{1,3}(?:\.\d{1,3}){3})", out)
        if match:
            return match.group(1)
    out = _run(["route", "-n"])
    if out:
        for line in out.splitlines():
            parts = line.split()
            if parts and parts[0] == "0.0.0.0" and len(parts) > 1:
                return parts[1]
    return None


def detect_gateway_ip(force: bool = False) -> str:
    """Resolve the host/WSL gateway IP with layered fallbacks."""
    global _GATEWAY_CACHE
    if _GATEWAY_CACHE and not force:
        return _GATEWAY_CACHE

    candidates: List[Optional[str]] = [
        cfg("HC_GATEWAY_IP") or None,
        _gateway_from_proc(),
        _gateway_from_ip_route(),
        _nat_gateway_wsl(),
        _local_ip(),
        "127.0.0.1",
    ]
    result = "127.0.0.1"
    for candidate in candidates:
        if candidate:
            result = candidate
            break
    _GATEWAY_CACHE = result
    return result


def _nat_gateway_wsl() -> str:
    """Classic WSL2 NAT host ranges (winhost reachable via these gateways)."""
    ip = _local_ip()
    if ip and ip.startswith("172."):
        parts = ip.split(".")
        return f"172.{parts[1]}.{parts[2]}.1"
    if ip and ip.startswith("192.168."):
        parts = ip.split(".")
        return f"192.168.{parts[1]}.{parts[2]}.1"
    return "172.22.224.1"


def _local_ip() -> Optional[str]:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(0.4)
            sock.connect(("10.255.255.255", 1))
            ip = sock.getsockname()[0]
        finally:
            sock.close()
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    return None


# --------------------------------------------------------------------------
# Model / provider detection
# --------------------------------------------------------------------------

_OLLAMA_STATE: Dict[str, Any] = {"ok": False, "checked": 0.0, "models": 0}
_OLLAMA_LOCK = threading.Lock()


def ollama_url() -> str:
    return cfg("OLLAMA_URL").strip().rstrip("/")


def ollama_available(timeout: float = 1.2, refresh: bool = False) -> bool:
    with _OLLAMA_LOCK:
        if not refresh and time.time() - _OLLAMA_STATE["checked"] < 15.0:
            return bool(_OLLAMA_STATE["ok"])
    ok = False
    models = 0
    url = ollama_url()
    if url:
        try:
            with urllib.request.urlopen(f"{url}/api/tags", timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace") or "{}")
                models = len(payload.get("models") or [])
                ok = True
        except Exception:
            ok = False
    with _OLLAMA_LOCK:
        _OLLAMA_STATE.update({"ok": ok, "checked": time.time(), "models": models})
    return ok


def groq_available() -> bool:
    return bool(cfg("GROQ_API_KEY"))


def resolve_provider(refresh: bool = False) -> Tuple[str, str, bool]:
    """Return (provider, model, available). Ollama probes are cached 15s."""
    if groq_available():
        return "groq", cfg("GROQ_MODEL"), True
    if ollama_available(timeout=1.0, refresh=refresh):
        return "ollama", cfg("OLLAMA_MODEL"), True
    return "local", "hustlecraft-heuristic-v1", True


def health_payload() -> Dict[str, Any]:
    provider, model, available = resolve_provider(refresh=True)
    gateway = detect_gateway_ip()
    endpoint = cfg("GROQ_URL") if provider == "groq" else (
        ollama_url() if provider == "ollama" else "in-process"
    )
    return {
        "status": "ok",
        "service": SERVICE,
        "version": VERSION,
        "time": datetime.now(timezone.utc).isoformat(),
        "uptime_s": round(time.time() - _STARTED_AT, 2),
        "python": sys.version.split()[0],
        "gateway_ip": gateway,
        "model": {
            "provider": provider,
            "name": model,
            "available": available,
            "endpoint": endpoint,
            "groq_key": groq_available(),
            "ollama": {
                "url": ollama_url(),
                "reachable": bool(_OLLAMA_STATE["ok"]),
                "models": _OLLAMA_STATE.get("models", 0),
            },
        },
        "capabilities": {
            "streaming": True,
            "modes": list(MODES),
            "endpoints": ["/api/health", "/api/generate", "/api/trace"],
            "features": [
                "proposal-writer",
                "ad-copywriter",
                "pricing-estimator",
                "negotiation-chat",
                "execution-traces",
            ],
            "traces_recorded": len(_TRACES),
        },
    }


# --------------------------------------------------------------------------
# Prompt engineering
# --------------------------------------------------------------------------

def _skills(data: Dict[str, Any]) -> List[str]:
    raw = data.get("skills", "")
    if isinstance(raw, list):
        items = [str(s) for s in raw]
    else:
        items = re.split(r"[,;\n]+", str(raw))
    return [s.strip() for s in items if s.strip()][:10]


def _clean(value: Any, limit: int = 8000) -> str:
    text = str(value or "").strip()
    return text[:limit]


def _money_values(text: str) -> List[float]:
    values: List[float] = []
    for match in re.finditer(r"(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?", text or ""):
        try:
            num = float(match.group(1).replace(",", ""))
        except ValueError:
            continue
        suffix = (match.group(2) or "").lower()
        if suffix == "k":
            num *= 1000
        elif suffix == "m":
            num *= 1_000_000
        if 0 < num <= 10_000_000:
            values.append(num)
    return values


RATE_BANDS: Dict[str, Tuple[float, float]] = {
    "beginner": (25.0, 55.0),
    "intermediate": (55.0, 95.0),
    "expert": (95.0, 175.0),
}


def _estimate(data: Dict[str, Any]) -> Dict[str, Any]:
    desc = _clean(data.get("description") or data.get("scope") or data.get("offer"))
    skills = _skills(data)
    experience = str(data.get("experience") or "intermediate").lower()
    if experience not in RATE_BANDS:
        experience = "intermediate"
    low_rate, high_rate = RATE_BANDS[experience]

    hours = data.get("hours")
    try:
        hours = max(2, min(400, int(hours)))
    except (TypeError, ValueError):
        words = len(desc.split()) if desc else 40
        hours = max(8, min(180, 12 + words // 3 + 4 * len(skills)))

    budget_vals = _money_values(str(data.get("budget") or ""))
    budget_low = budget_vals[0] if budget_vals else None
    budget_high = budget_vals[1] if len(budget_vals) > 1 else None

    est_low = round(hours * low_rate / 10.0) * 10
    est_high = round(hours * high_rate / 10.0) * 10
    recommended = round(((est_low + est_high) / 2) / 10.0) * 10
    if budget_low and budget_high:
        midpoint = (budget_low + budget_high) / 2
        if est_high and midpoint < est_low:
            recommended = est_low
        elif budget_low and budget_low > est_high:
            recommended = round(est_high * 1.05 / 10.0) * 10
    elif budget_low:
        if budget_low < est_low:
            recommended = est_low
        elif budget_low > est_high:
            recommended = round(est_high * 1.05 / 10.0) * 10
        else:
            recommended = round(budget_low / 10.0) * 10

    rush = bool(data.get("rush")) or str(data.get("deadline") or "").strip() != ""
    if rush and budget_low is None:
        recommended = round(recommended * 1.15 / 10.0) * 10
        est_low = round(est_low * 1.15 / 10.0) * 10
        est_high = round(est_high * 1.15 / 10.0) * 10

    return {
        "hours": hours,
        "experience": experience,
        "rate_low": low_rate,
        "rate_high": high_rate,
        "est_low": est_low,
        "est_high": est_high,
        "recommended": recommended,
        "budget_low": budget_low,
        "budget_high": budget_high,
        "skills": skills,
        "rush": rush,
        "description": desc,
    }


def system_prompt(mode: str, data: Dict[str, Any]) -> str:
    if mode == "proposal":
        return (
            "You are a top-rated freelance proposal strategist. You write concise, "
            "client-winning proposals for platforms like Upwork, Contra and Fiverr.\n"
            "Output GitHub-flavoured Markdown ONLY. Structure exactly as:\n"
            "## Winning Proposal (a ready-to-send message: hook, understanding, "
            "plan, proof, closing CTA)\n"
            "## Key Selling Points (4-6 bullets, concrete and specific)\n"
            "## Risk Assessment (3-5 risks, each with a one-line mitigation)\n"
            "## Pricing Estimation (a fair range, the rationale, a payment "
            "schedule, and an anchor strategy)\n"
            "Never pad with filler. No preamble before the first heading."
        )
    if mode == "adcopy":
        return (
            "You are a direct-response social copywriter. Output GitHub-flavoured "
            "Markdown ONLY with exactly three variants, each under its own "
            "heading: '## Variant 1 - Emoji Scroller', '## Variant 2 - Short & "
            "Punchy', '## Variant 3 - Story to Offer'.\n"
            "Every variant: 2-5 short lines, natural emojis, one clear "
            "call-to-action. Match the requested platform and tone. Add a final "
            "heading '## Posting Tips' with 3 bullets. No preamble."
        )
    if mode == "pricing":
        return (
            "You are a freelance pricing consultant. Output GitHub-flavoured "
            "Markdown ONLY with headings: '## Rate Card', '## Package Tiers' "
            "(3 packages with price + what is included), '## Scope Guardrails' "
            "(bullet list that prevents scope creep), '## Negotiation Anchors' "
            "(3 short scripted lines). Be concrete with numbers derived from the "
            "given hours, rate and budget."
        )
    return (
        "You are HustleCraft's side-hustle advisor inside a chat drawer. Give "
        "tight, practical answers about pricing, negotiation and closing deals. "
        "Use at most 120 words, Markdown bullets where useful, and end with one "
        "actionable next step. No preamble."
    )


def user_prompt(mode: str, data: Dict[str, Any]) -> str:
    if mode == "proposal":
        skills = ", ".join(_skills(data)) or "not specified"
        return (
            f"Job description:\n{_clean(data.get('description')) or '(client posted a short brief)'}\n\n"
            f"Budget: {_clean(data.get('budget')) or 'not specified'}\n"
            f"Skills: {skills}\n"
            f"Experience: {_clean(data.get('experience')) or 'intermediate'}\n"
            f"Deadline: {_clean(data.get('deadline')) or 'flexible'}"
        )
    if mode == "adcopy":
        return (
            f"Offer / service:\n{_clean(data.get('offer'))}\n\n"
            f"Audience: {_clean(data.get('audience')) or 'general'}\n"
            f"Platform: {_clean(data.get('platform')) or 'WhatsApp'}\n"
            f"Tone: {_clean(data.get('tone')) or 'friendly and confident'}"
        )
    if mode == "pricing":
        est = _estimate(data)
        return (
            f"Scope: {est['description'] or 'general freelance project'}\n"
            f"Estimated hours: {est['hours']}\n"
            f"Target hourly rate: ${est['rate_low']}-${est['rate_high']}/hr "
            f"({est['experience']})\n"
            f"Client budget: {est['budget_low'] or 'unknown'}"
            f"{'-' + str(est['budget_high']) if est['budget_high'] else ''}\n"
            f"Recommended project price: ${est['recommended']}\n"
            f"Rush: {est['rush']}"
        )
    history = data.get("history") or []
    turns = []
    if isinstance(history, list):
        for item in history[-4:]:
            if isinstance(item, dict):
                turns.append(
                    f"{item.get('role', 'user')}: {_clean(item.get('content'), 400)}"
                )
    joined = "\n".join(turns)
    message = _clean(data.get("message"), 1500) or "Give me a pricing tip."
    return (f"Recent chat:\n{joined}\n\n" if joined else "") + f"User: {message}"


def build_messages(mode: str, data: Dict[str, Any]) -> List[Dict[str, str]]:
    return [
        {"role": "system", "content": system_prompt(mode, data)},
        {"role": "user", "content": user_prompt(mode, data)},
    ]


# --------------------------------------------------------------------------
# Offline heuristic generator (zero-config fallback)
# --------------------------------------------------------------------------

def _first_line(text: str, limit: int = 70) -> str:
    line = (text or "").strip().splitlines()[0] if text.strip() else ""
    line = re.sub(r"\s+", " ", line).strip()
    if len(line) > limit:
        line = line[: limit - 1].rstrip() + "…"
    return line


def _topic(data: Dict[str, Any]) -> str:
    desc = _clean(data.get("description") or data.get("scope") or data.get("offer"))
    return _first_line(desc) or "your project"


def local_proposal(data: Dict[str, Any]) -> str:
    est = _estimate(data)
    skills = est["skills"]
    skill_line = ", ".join(skills[:5]) if skills else "the skills your brief calls for"
    deadline = _clean(data.get("deadline"))
    topic = _topic(data)
    exp = est["experience"]
    exp_label = {"beginner": "an early-career specialist", "intermediate": "a proven mid-level specialist", "expert": "a senior specialist"}[exp]

    risks: List[Tuple[str, str]] = [
        ("Scope creep — the brief quietly grows after kickoff.",
         f"I cap revisions at 2 rounds and write new work into a change order at ${int(est['rate_low'])}/hr."),
        ("Payment delay or a milestone that never gets approved.",
         "40% up front, milestone billing, and a signed scope before the first deliverable."),
        ("Unclear success criteria from the client.",
         "I agree measurable acceptance criteria in writing during the kickoff call."),
    ]
    lowered = desc_lower = (est["description"] or "").lower()
    if any(k in lowered for k in ("app", "website", "site", "api", "stack", "code", "software")):
        risks.insert(1, ("Technical debt from an unfamiliar stack or legacy code.",
                         "I start with a paid 1-day audit and document every architectural choice."))
    if any(k in lowered for k in ("seo", "content", "post", "blog", "copy", "marketing")):
        risks.append(("Content that ranks slowly and cannot be attributed to effort.",
                      "I ship a 30-day test calendar with leading indicators instead of promised rankings."))

    points = [
        f"**Direct fit:** {skill_line} maps to this brief.",
        f"**Scoped fast:** a written plan with milestones inside the first 24 hours.",
        f"**{exp.title()} track record:** {exp_label} with delivery discipline and async updates.",
        "**Risk-visible communication:** you always know what is done, next and blocked.",
        "**Fixed communication rhythm:** daily summary, one shared board, zero chasing.",
        f"**Price integrity:** quote anchored to value, not to the lowest hourly line item.",
    ]

    payment = (
        "50% up front, 50% on delivery"
        if est["est_low"] < 500
        else "40% up front, 30% at midpoint, 30% on sign-off"
    )

    lines = [
        "## Winning Proposal",
        "",
        f"**Subject:** {_first_line(topic, 60)} — delivered on scope, on time",
        "",
        "Hi there,",
        "",
        f"Thanks for the brief — {_first_line(topic, 120)} is exactly the kind of work I take on. "
        f"Before proposing anything, here is what I heard: you need {skill_line} turned into a "
        "finished, measurable result — not a pile of drafts.",
        "",
        "**My plan:**",
        "1. **Day 0 — Kickoff:** lock scope, success criteria and the single metric that defines done.",
        "2. **Day 1–2 — Foundation:** first working slice in your hands so direction is proven early.",
        "3. **Midpoint — Build & review:** you review a real deliverable, not a promise.",
        "4. **Final — Handover:** polished result, source files, and a short Loom walkthrough.",
        "",
        f"Timeline: {deadline + ' delivery' if deadline else 'first draft within 48 hours, full delivery within the window we agree at kickoff'}.",
        "",
        "You will get async updates you never have to chase, and every decision documented so the project survives handover.",
        "",
        "Happy to jump on a 10-minute call today and start this week.",
        "",
        "Best,",
        "— HustleCraft freelancer",
        "",
        "## Key Selling Points",
        "",
    ]
    lines += [f"- {point}" for point in points]
    lines += [
        "",
        "## Risk Assessment",
        "",
    ]
    lines += [f"- **Risk:** {r} **Mitigation:** {m}" for r, m in risks]
    lines += [
        "",
        "## Pricing Estimation",
        "",
        f"- **Recommended quote:** ${int(est['recommended']):,} for ~{est['hours']}h of work.",
        f"- **Fair range:** ${int(est['est_low']):,} – ${int(est['est_high']):,} "
        f"(${int(est['rate_low'])}–${int(est['rate_high'])}/hr at {exp} level).",
    ]
    if est["budget_low"]:
        if est["budget_high"] and est["budget_high"] != est["budget_low"]:
            band = f"${int(est['budget_low']):,}–${int(est['budget_high']):,}"
        else:
            band = f"${int(est['budget_low']):,}"
        lines.append(f"- **Client budget given:** {band} — quote inside that band with a clear deliverable list.")
    lines += [
        f"- **Payment schedule:** {payment}.",
        "- **Anchor strategy:** open ~15% above your target, then trade scope (not price) for movement.",
        "- **Overage rule:** anything outside the agreed scope is billed hourly with a written estimate first.",
        "",
        "---",
        "",
        "_Generated offline by HustleCraft's local heuristic engine. Configure `GROQ_API_KEY` "
        "or an Ollama endpoint in `.env` for full LLM output._",
    ]
    return "\n".join(lines)


def local_adcopy(data: Dict[str, Any]) -> str:
    offer = _clean(data.get("offer")) or "your next best offer"
    audience = _clean(data.get("audience")) or "people who keep putting it off"
    platform = _clean(data.get("platform")) or "WhatsApp"
    tone = _clean(data.get("tone")) or "friendly and confident"
    hook = _first_line(offer, 48)
    one_liner = re.sub(r"\s+", " ", offer).strip()
    if len(one_liner) > 90:
        one_liner = one_liner[:89].rstrip(" ,.;") + "…"

    return "\n".join(
        [
            "## Variant 1 - Emoji Scroller",
            "",
            f"🚨 {hook}",
            "",
            f"Built for {audience} who are done waiting for \u201csomeday\u201d.",
            f"✅ {one_liner}",
            "⚡ Spots open this week only",
            "",
            "👉 **Tap the link and claim yours →**",
            "",
            "## Variant 2 - Short & Punchy",
            "",
            f"**{hook}.**",
            "",
            f"{one_liner} No fluff, no fake urgency — just {tone} results.",
            "",
            "**Reply SEND and I'll send the details.**",
            "",
            "## Variant 3 - Story to Offer",
            "",
            f"Most {audience} lose weeks to the same loop: research, doubt, delay.",
            "",
            f"So we built the shortcut: {one_liner}",
            "",
            " You get the outcome, the timeline is honest, and the first step takes under 2 minutes.",
            "",
            f"🔥 Ready? **Message us \u201c{hook[:18].strip()}\u201d on {platform} and start today.**",
            "",
            "## Posting Tips",
            "",
            f"- **{platform}:** send to warm contacts first, then post the short variant as a status/broadcast.",
            "- Put the CTA in the last line only — one call-to-action per post converts better than three.",
            "- Reuse Variant 1 as the visual caption and Variant 3 as the story/reel voiceover.",
        ]
    )


def local_pricing(data: Dict[str, Any]) -> str:
    est = _estimate(data)
    low_tier = int(round(est["recommended"] * 0.7 / 5.0) * 5)
    mid_tier = int(round(est["recommended"] / 5.0) * 5)
    high_tier = int(round(est["recommended"] * 1.4 / 5.0) * 5)
    skills = ", ".join(est["skills"][:4]) or "your core deliverables"
    return "\n".join(
        [
            "## Rate Card",
            "",
            f"- **Hourly:** ${int(est['rate_low'])}–${int(est['rate_high'])}/hr "
            f"({est['experience']} band) × **{est['hours']}h** estimated = "
            f"${int(est['est_low']):,}–${int(est['est_high']):,}.",
            f"- **Recommended project price:** **${mid_tier:,}** — anchored to value, not hours alone.",
            "- **Rush multiplier:** +15% when the deadline is inside 7 days.",
            f"- **Scope notes:** {skills}. Anything outside the brief is billed at "
            f"${int(est['rate_low'])}/hr with written approval first.",
            "",
            "## Package Tiers",
            "",
            f"### 🥉 Starter — ${low_tier:,}",
            "- Core deliverable only, 1 revision round, async updates.",
            "",
            f"### 🥈 Growth — ${mid_tier:,} *(most clients pick this)*",
            "- Everything in Starter, plus 2 revisions, source files and a handover walkthrough.",
            "",
            f"### 🥇 Premium — ${high_tier:,}",
            "- Everything in Growth, plus priority turnaround, a 30-day support window and a strategy call.",
            "",
            "## Scope Guardrails",
            "",
            "- Revisions beyond round 2 are quoted as a change order before work starts.",
            "- New features/pages/channels are a fresh scope line, never a \u201cquick favour\u201d.",
            "- Feedback is consolidated from one named client contact, once per round.",
            "- Deadlines assume feedback inside 48 hours; delays move the delivery date, not the price.",
            "",
            "## Negotiation Anchors",
            "",
            f"1. \u201cBased on the outcome you described, this is a ${mid_tier:,} project — I can flex "
            f"to ${low_tier:,} if we cut the scope to the core deliverable.\u201d",
            "2. \u201cI can lower the number, or I can protect the deadline — which one matters more "
            "to you?\u201d",
            "3. \u201cIf the budget is fixed at your number, tell me the feature list you can drop and "
            "I'll make it fit.\u201d",
        ]
    )


def local_chat(data: Dict[str, Any]) -> str:
    message = _clean(data.get("message"), 1500).lower()
    if not message:
        message = "give me a pricing tip"
    est = _estimate(data)
    anchor = int(est["recommended"])

    if any(k in message for k in ("raise", "rate", "hourly", "charge more", "underpriced")):
        return "\n".join(
            [
                "**Raise rates in steps, not leaps:**",
                "- Quote new clients +20% immediately — they have no memory of your old rate.",
                "- Renewing clients: +10–15% at the next milestone, framed as a scope change.",
                "- Never apologise for the number. State it, then be silent.",
                "",
                f"→ **Next step:** put ${int(est['rate_high'])}/hr on your next three quotes.",
            ]
        )
    if any(k in message for k in ("negotiat", "client says", "too expensive", "budget", "push back", "counter")):
        return "\n".join(
            [
                "**Negotiation script that works:**",
                "1. Acknowledge: \u201cI hear the budget constraint.\u201d",
                "2. Reframe: trade scope, not price — \u201cIf we drop X, I can do it for Y.\u201d",
                "3. Anchor first with a number, then stop talking.",
                "",
                f"→ **Next step:** open {anchor} USD, expect to land near {int(anchor * 0.85)} USD.",
            ]
        )
    if any(k in message for k in ("close", "sign", "convert", "win", "proposal", "follow up")):
        return "\n".join(
            [
                "**Closing moves:**",
                "- Send the proposal with a date: \u201cI can hold this slot until Friday.\u201d",
                "- Ask a small yes-question: \u201cWant the Starter or Growth scope?\u201d",
                "- Follow up with value, not \u201cjust checking in\u201d — share one concrete idea.",
                "",
                "→ **Next step:** send a 3-line follow-up today with a single question.",
            ]
        )
    if any(k in message for k in ("price", "pricing", "cost", "how much", "quote", "estimate")):
        return "\n".join(
            [
                "**Pricing shortcut:**",
                f"- Estimate: {est['hours']}h × ${int(est['rate_low'])}–${int(est['rate_high'])}/hr.",
                f"- Anchor high, quote ${anchor:,}, hold 10% for scope concessions.",
                "- Package it into 3 tiers so the client picks *which*, not *whether*.",
                "",
                f"→ **Next step:** send a 3-tier quote with ${anchor:,} highlighted as recommended.",
            ]
        )
    if any(k in message for k in ("hi", "hello", "hey", "start")):
        return ("Hey! I'm HustleCraft's deal coach 💼\n\n"
                "Ask me about pricing, negotiation scripts or closing a client.\n\n"
                "→ **Try:** \u201cHow much should I charge for a landing page?\u201d")
    return "\n".join(
        [
            "**Quick playbook:**",
            "- Price the outcome, not the hours — clients buy the result.",
            "- Always present three options; the middle tier wins most of the time.",
            "- Get paid up front for anything under $1,000.",
            "- Walk away from clients who haggle before scoping.",
            "",
            "→ **Next step:** tell me the project type and I'll price it for you.",
        ]
    )


LOCAL_GENERATORS: Dict[str, Callable[[Dict[str, Any]], str]] = {
    "proposal": local_proposal,
    "adcopy": local_adcopy,
    "pricing": local_pricing,
    "chat": local_chat,
}


def local_generate(mode: str, data: Dict[str, Any]) -> str:
    generator = LOCAL_GENERATORS.get(mode, local_chat)
    return generator(data)


# --------------------------------------------------------------------------
# Upstream streaming
# --------------------------------------------------------------------------

def _http_post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str],
                    timeout: float) -> Any:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    return urllib.request.urlopen(req, timeout=timeout)


def stream_groq(messages: List[Dict[str, str]], stats: Dict[str, Any]) -> Iterable[str]:
    url = cfg("GROQ_URL") or DEFAULTS["GROQ_URL"]
    model = cfg("GROQ_MODEL")
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.75,
        "max_tokens": 2048,
        "stream": True,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg('GROQ_API_KEY')}",
        "Accept": "text/event-stream",
    }
    t_connect = time.perf_counter()
    resp = _http_post_json(url, payload, headers, cfg_int("HC_TIMEOUT", 60))
    stats["connect_ms"] = round((time.perf_counter() - t_connect) * 1000, 2)
    with resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except ValueError:
                continue
            usage = obj.get("usage")
            if isinstance(usage, dict):
                stats["usage"] = usage
            choices = obj.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if content:
                yield content
            if choices[0].get("finish_reason"):
                stats["finish"] = choices[0]["finish_reason"]


def stream_ollama(messages: List[Dict[str, str]], stats: Dict[str, Any]) -> Iterable[str]:
    url = ollama_url()
    model = cfg("OLLAMA_MODEL")
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {"temperature": 0.75, "num_predict": 2048},
    }
    headers = {"Content-Type": "application/json"}
    t_connect = time.perf_counter()
    resp = _http_post_json(f"{url}/api/chat", payload, headers, cfg_int("HC_TIMEOUT", 60))
    stats["connect_ms"] = round((time.perf_counter() - t_connect) * 1000, 2)
    with resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("done"):
                stats["usage"] = {
                    "prompt_tokens": obj.get("prompt_eval_count"),
                    "completion_tokens": obj.get("eval_count"),
                }
                stats["finish"] = "stop"
                continue
            content = (obj.get("message") or {}).get("content")
            if content:
                yield content


def stream_local(mode: str, data: Dict[str, Any], stats: Dict[str, Any]) -> Iterable[str]:
    t0 = time.perf_counter()
    text = local_generate(mode, data)
    stats["connect_ms"] = round((time.perf_counter() - t0) * 1000, 2)
    stats["finish"] = "stop"
    step = 7
    delay = max(0.0, cfg_int("HC_OFFLINE_MS", 11) / 1000.0)
    index = 0
    length = len(text)
    while index < length:
        yield text[index:index + step]
        index += step
        if delay:
            time.sleep(delay)


UPSTREAM_ERRORS = (
    urllib.error.HTTPError,
    urllib.error.URLError,
    ConnectionError,
    OSError,
    ValueError,
)


def guarded_stream(stream: Iterable[str], mode: str, data: Dict[str, Any],
                   stats: Dict[str, Any]) -> Iterable[str]:
    """Relay an upstream stream; fall back to the offline engine if it dies
    before producing a single token."""
    iterator = iter(stream)
    started = False
    while True:
        try:
            chunk = next(iterator)
        except StopIteration:
            return
        except UPSTREAM_ERRORS as exc:
            reason = f"{type(exc).__name__}: {exc}"
            stats["error"] = reason
            if started:
                stats["finish"] = "truncated"
                return
            stats["provider"] = "local"
            stats["model"] = "hustlecraft-heuristic-v1"
            stats["connect_ms"] = 0.0
            yield from stream_local(mode, data, stats)
            return
        started = True
        if chunk:
            yield chunk


def open_stream(mode: str, data: Dict[str, Any],
                stats: Dict[str, Any]) -> Iterable[str]:
    t_detect = time.perf_counter()
    provider, model, _ = resolve_provider()
    stats["provider"] = provider
    stats["model"] = model
    messages = build_messages(mode, data)
    stats["prompt_chars"] = sum(len(m.get("content", "")) for m in messages)
    stats["detect_ms"] = round((time.perf_counter() - t_detect) * 1000, 2)
    if provider == "groq":
        return guarded_stream(stream_groq(messages, stats), mode, data, stats)
    if provider == "ollama":
        return guarded_stream(stream_ollama(messages, stats), mode, data, stats)
    return stream_local(mode, data, stats)


# --------------------------------------------------------------------------
# Trace store
# --------------------------------------------------------------------------

def record_trace(entry: Dict[str, Any]) -> str:
    global _TRACE_SEQ
    with _TRACE_LOCK:
        _TRACE_SEQ += 1
        trace_id = f"trace_{int(time.time() * 1000)}_{_TRACE_SEQ}"
    entry = dict(entry)
    entry["id"] = trace_id
    entry["ts"] = datetime.now(timezone.utc).isoformat()
    with _TRACE_LOCK:
        _TRACES.append(entry)
    return trace_id


def recent_traces(limit: int = 20) -> List[Dict[str, Any]]:
    with _TRACE_LOCK:
        items = list(_TRACES)[-limit:]
    return list(reversed(items))


def estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4) if text else 0


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class HustleCraftHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"HustleCraft/{VERSION}"

    # -- helpers -----------------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:
        if cfg("HC_ACCESS_LOG") == "1":
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._security_headers()
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _read_body(self) -> bytes:
        header = self.headers.get("Content-Length")
        if not header:
            return b""
        try:
            length = int(header)
        except ValueError:
            raise ValueError("invalid Content-Length")
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("payload too large")
        return self.rfile.read(length)

    def _json_body(self) -> Dict[str, Any]:
        raw = self._read_body()
        if not raw:
            raise ValueError("empty body")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError(f"invalid JSON: {exc}")
        if not isinstance(payload, dict):
            raise ValueError("JSON object expected")
        return payload

    def _sse(self, event: Dict[str, Any]) -> None:
        data = json.dumps(event, ensure_ascii=False)
        self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
        self.wfile.flush()

    # -- GET ---------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        try:
            path = unquote(urlparse(self.path).path)
            if path == "/api/health":
                self._send_json(200, health_payload())
                return
            if path == "/api/trace":
                self._send_json(200, {"ok": True, "traces": recent_traces(20)})
                return
            if path.startswith("/api/"):
                self._send_json(404, {"error": "unknown endpoint", "path": path})
                return
            self._serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    # -- POST --------------------------------------------------------------
    def do_POST(self) -> None:  # noqa: N802
        try:
            path = unquote(urlparse(self.path).path)
            if path == "/api/generate":
                self._handle_generate()
            elif path == "/api/trace":
                self._handle_trace()
            else:
                self._send_json(404, {"error": "unknown endpoint", "path": path})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})

    # -- endpoints ---------------------------------------------------------
    def _handle_trace(self) -> None:
        payload = self._json_body()
        steps = payload.get("steps")
        if not isinstance(steps, list):
            steps = []
        entry = {
            "mode": str(payload.get("mode", "unknown"))[:32],
            "model": str(payload.get("model", "unknown"))[:80],
            "provider": str(payload.get("provider", "unknown"))[:32],
            "client": str(payload.get("client", "browser"))[:48],
            "steps": [
                {
                    "name": str(s.get("name", "step"))[:48],
                    "ms": round(float(s.get("ms", 0) or 0), 2),
                }
                for s in steps
                if isinstance(s, dict)
            ],
            "tokens": payload.get("tokens") if isinstance(payload.get("tokens"), dict) else {},
            "latency_ms": round(float(payload.get("latency_ms", 0) or 0), 2),
            "status": str(payload.get("status", "ok"))[:24],
        }
        trace_id = record_trace(entry)
        self._send_json(
            200,
            {"ok": True, "id": trace_id, "stored": len(_TRACES), "entry": entry},
        )

    def _handle_generate(self) -> None:
        started = time.perf_counter()
        try:
            payload = self._json_body()
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
            return

        mode = str(payload.get("mode", "chat") or "chat").lower()
        if mode not in MODES:
            self._send_json(400, {"error": f"mode must be one of {list(MODES)}"})
            return
        data = payload.get("inputs")
        if not isinstance(data, dict):
            data = {k: v for k, v in payload.items() if k != "mode"}
        if not isinstance(data, dict):
            data = {}

        # begin SSE
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self._security_headers()
            self.end_headers()
            self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            return

        stats: Dict[str, Any] = {"provider": "local", "model": "hustlecraft-heuristic-v1"}
        status = "ok"
        completion_chars = 0
        prompt_chars = 0
        first_token_ms: Optional[float] = None

        try:
            stream = open_stream(mode, data, stats)
            announced = stats.get("provider")
            self._sse(
                {
                    "type": "meta",
                    "mode": mode,
                    "provider": stats.get("provider"),
                    "model": stats.get("model"),
                    "resolved": True,
                    "server_time": datetime.now(timezone.utc).isoformat(),
                }
            )

            for chunk in stream:
                if not chunk:
                    continue
                if first_token_ms is None:
                    first_token_ms = round((time.perf_counter() - started) * 1000, 2)
                completion_chars += len(chunk)
                self._sse({"type": "token", "text": chunk})

            if stats.get("provider") != announced:
                self._sse(
                    {
                        "type": "meta",
                        "mode": mode,
                        "provider": stats.get("provider"),
                        "model": stats.get("model"),
                        "resolved": True,
                        "fallback": True,
                    }
                )
            if stats.get("error"):
                self._sse(
                    {
                        "type": "notice",
                        "message": (
                            f"{announced} unavailable — streamed with the offline engine "
                            f"instead ({stats['error']})."
                        ),
                    }
                )
        except (BrokenPipeError, ConnectionResetError):
            status = "aborted"
        except Exception as exc:  # keep the stream alive and explain
            status = "error"
            try:
                self._sse(
                    {
                        "type": "error",
                        "message": f"{type(exc).__name__}: {exc}",
                    }
                )
            except (BrokenPipeError, ConnectionResetError):
                status = "aborted"

        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        usage = stats.get("usage") or {}
        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        if not isinstance(prompt_tokens, int):
            prompt_tokens = max(1, int(stats.get("prompt_chars", 0) or 0) // 4)
        if not isinstance(completion_tokens, int):
            completion_tokens = estimate_tokens(" " * completion_chars)

        steps = [
            {"name": "provider-detect", "ms": round(stats.get("detect_ms", 0.0), 2)},
            {"name": "model-connect", "ms": round(stats.get("connect_ms", 0.0), 2)},
            {
                "name": "first-token",
                "ms": first_token_ms if first_token_ms is not None else latency_ms,
            },
            {
                "name": "token-stream",
                "ms": round(latency_ms - (first_token_ms or latency_ms), 2),
            },
            {"name": "total", "ms": latency_ms},
        ]

        trace_entry = {
            "mode": mode,
            "provider": stats.get("provider"),
            "model": stats.get("model"),
            "status": status,
            "steps": steps,
            "tokens": {
                "prompt": prompt_tokens,
                "completion": completion_tokens,
                "total": (prompt_tokens or 0) + (completion_tokens or 0),
            },
            "latency_ms": latency_ms,
            "first_token_ms": first_token_ms,
            "chars": completion_chars,
        }
        if stats.get("error"):
            trace_entry["upstream_error"] = str(stats.get("error"))[:200]
        trace_id = record_trace(trace_entry)

        try:
            self._sse(
                {
                    "type": "trace",
                    "id": trace_id,
                    "mode": mode,
                    "provider": stats.get("provider"),
                    "model": stats.get("model"),
                    "status": status,
                    "steps": steps,
                    "tokens": trace_entry["tokens"],
                    "latency_ms": latency_ms,
                    "first_token_ms": first_token_ms,
                    "chars": completion_chars,
                }
            )
            self._sse({"type": "done", "status": status, "id": trace_id})
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- static ------------------------------------------------------------
    def _serve_static(self, path: str) -> None:
        if path in ("", "/"):
            rel = "index.html"
        elif path.startswith("/static/"):
            rel = path[len("/static/"):]
        else:
            rel = path.lstrip("/")
        rel = rel.split("#", 1)[0].split("?", 1)[0]
        if not rel or rel.endswith("/"):
            rel = (rel + "index.html") if rel else "index.html"

        try:
            target = (STATIC_DIR / rel).resolve()
        except (OSError, RuntimeError):
            self._send_json(403, {"error": "forbidden path"})
            return
        if not target.is_relative_to(STATIC_DIR.resolve()):
            self._send_json(403, {"error": "forbidden path"})
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self._send_json(
                404,
                {"error": "not found", "hint": "run from the project root; static/ is missing"},
            )
            return

        try:
            body = target.read_bytes()
        except OSError:
            self._send_json(500, {"error": "unable to read file"})
            return

        mime, _ = mimetypes.guess_type(str(target))
        if target.suffix in (".js", ".mjs"):
            mime = "text/javascript; charset=utf-8"
        elif target.suffix == ".css":
            mime = "text/css; charset=utf-8"
        elif target.suffix == ".html":
            mime = "text/html; charset=utf-8"
        elif not mime:
            mime = "application/octet-stream"

        try:
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self._security_headers()
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def parse_args(argv: List[str]) -> Tuple[Optional[str], Optional[int]]:
    host: Optional[str] = None
    port: Optional[int] = None
    args = list(argv)
    while args:
        arg = args.pop(0)
        if arg in ("--host", "-H") and args:
            host = args.pop(0)
        elif arg in ("--port", "-p") and args:
            try:
                port = int(args.pop(0))
            except ValueError:
                print("invalid --port", file=sys.stderr)
        elif arg in ("--help", "-h"):
            print("usage: python3 server.py [--host 0.0.0.0] [--port 8000]")
            raise SystemExit(0)
    return host, port


def main() -> None:
    arg_host, arg_port = parse_args(sys.argv[1:])
    host = arg_host or host_bind()
    port = arg_port or port_bind()

    if not STATIC_DIR.is_dir():
        print(f"[warn] static directory not found at {STATIC_DIR}", file=sys.stderr)

    gateway = detect_gateway_ip()

    httpd = ThreadingHTTPServer((host, port), HustleCraftHandler)
    httpd.daemon_threads = True

    print("", file=sys.stderr)
    print("  ██ HustleCraft — AI Side Hustle Toolkit", file=sys.stderr)
    print(f"  ├─ local    http://127.0.0.1:{port}/", file=sys.stderr)
    print(f"  ├─ network  http://{gateway}:{port}/", file=sys.stderr)
    print("  ├─ provider detecting… (groq key > ollama > offline)", file=sys.stderr)
    print(f"  ├─ ollama   {ollama_url()}", file=sys.stderr)
    print("  └─ Ctrl+C to stop", file=sys.stderr)
    print("", file=sys.stderr)

    def _warmup() -> None:
        provider, model, available = resolve_provider(refresh=True)
        print(
            f"  ├─ active   {provider} :: {model} (available={available})",
            file=sys.stderr,
        )

    threading.Thread(target=_warmup, name="model-warmup", daemon=True).start()

    try:
        httpd.serve_forever(poll_interval=0.4)
    except KeyboardInterrupt:
        print("\n[shutting down]", file=sys.stderr)
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
