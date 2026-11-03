#!/usr/bin/env python3
"""抓取「别人用 AI 赚钱的思路 / 正在做的事」并写入 workbench/data/feed.json。

只用标准库，适合在 GitHub Actions 里定时运行。
每次运行会与已有的 feed.json 合并（按 id 去重），保留最近 RETAIN_DAYS 天，
这样即使各平台 API 只返回最近一小段时间的数据，本地也能慢慢积累成一个情报库。

数据源（任何一个失败都不会影响其他）：
  - Hacker News（Algolia API）：Show HN 上的 AI 产品、讨论 MRR / 收入的帖子
  - Reddit：r/SideProject、r/indiehackers、r/SaaS 等子版块里和 AI 相关的热帖
  - V2EX：分享创造 / 奇思妙想 节点里和 AI 相关的帖子
  - Product Hunt：RSS 里和 AI 相关的新产品

前端（workbench/app.js）负责收入信号提取、分类和打标签，这里只做采集和清洗。
"""
from __future__ import annotations

import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "workbench" / "data" / "feed.json"

RETAIN_DAYS = 45
MAX_ITEMS = 1500
TEXT_LIMIT = 700
UA = "Mozilla/5.0 (compatible; ai-money-workbench/1.0; +https://github.com/marsman23/my-website)"

AI_RE = re.compile(
    r"(?<![a-z])(ai|a\.i\.|llm|llms|gpt|chatgpt|openai|claude|anthropic|gemini|llama|mistral|"
    r"agent|agents|agentic|copilot|genai|machine learning|ml|rag|embedding|diffusion|midjourney|"
    r"prompt|whisper|cursor|automation)(?![a-z])|人工智能|大模型|智能体|自动化|提示词|AIGC",
    re.IGNORECASE,
)

# ---- HN：(查询词, tags, 最近几天, 最少分数) ----
HN_QUERIES = [
    ("AI", "show_hn", 30, 15),
    ("LLM", "show_hn", 30, 10),
    ("agent", "show_hn", 30, 10),
    ("MRR", "story", 120, 3),
    ("AI revenue", "story", 90, 5),
    ("AI side project", "story", 120, 3),
    ("AI startup profitable", "story", 180, 5),
    ("paying customers AI", "story", 120, 3),
    ("making money AI", "ask_hn", 365, 3),
    ("AI business", "ask_hn", 180, 3),
    ("bootstrapped AI", "story", 180, 5),
]

REDDIT_SUBS = [
    "SideProject",
    "indiehackers",
    "EntrepreneurRideAlong",
    "SaaS",
    "sidehustle",
    "Entrepreneur",
    "startups",
    "AI_Agents",
    "microsaas",
]
REDDIT_QUERY = 'AI OR GPT OR LLM OR agent OR "ChatGPT" OR "Claude"'

V2EX_NODES = ["create", "ideas", "startup"]

PRODUCTHUNT_FEED = "https://www.producthunt.com/feed"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def http_get(url: str, *, accept: str = "application/json", retries: int = 2) -> bytes:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
            with urllib.request.urlopen(req, timeout=25) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001 - 任何网络错误都重试
            last = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def get_json(url: str):
    return json.loads(http_get(url).decode("utf-8"))


def clean_text(raw: str | None) -> str:
    if not raw:
        return ""
    text = re.sub(r"<(br|p|/p|li|/li)[^>]*>", "\n", raw, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    if len(text) > TEXT_LIMIT:
        text = text[:TEXT_LIMIT].rstrip() + "…"
    return text


def is_ai(*parts: str) -> bool:
    return any(p and AI_RE.search(p) for p in parts)


# ---------------------------------------------------------------- collectors


def collect_hn() -> list[dict]:
    now = int(time.time())
    items: dict[str, dict] = {}
    for query, tags, days, min_points in HN_QUERIES:
        params = {
            "query": query,
            "tags": tags,
            "hitsPerPage": "50",
            "numericFilters": f"created_at_i>{now - days * 86400},points>={min_points}",
        }
        url = "https://hn.algolia.com/api/v1/search?" + urllib.parse.urlencode(params)
        data = get_json(url)
        for hit in data.get("hits", []):
            oid = hit.get("objectID")
            title = hit.get("title") or ""
            if not oid or not title:
                continue
            text = clean_text(hit.get("story_text"))
            if tags != "show_hn" and not is_ai(title, text, query):
                continue
            hn_tags = hit.get("_tags") or []
            discuss = f"https://news.ycombinator.com/item?id={oid}"
            items[f"hn-{oid}"] = {
                "id": f"hn-{oid}",
                "source": "hn",
                "title": title,
                "url": hit.get("url") or discuss,
                "discuss_url": discuss,
                "author": hit.get("author") or "",
                "score": hit.get("points") or 0,
                "comments": hit.get("num_comments") or 0,
                "created": hit.get("created_at_i") or now,
                "text": text,
                "hints": [t for t in ("show_hn", "ask_hn") if t in hn_tags],
            }
        time.sleep(0.3)
    return list(items.values())


def collect_reddit() -> list[dict]:
    items: dict[str, dict] = {}
    for sub in REDDIT_SUBS:
        params = {
            "q": REDDIT_QUERY,
            "restrict_sr": "1",
            "sort": "top",
            "t": "month",
            "limit": "40",
            "raw_json": "1",
        }
        url = f"https://www.reddit.com/r/{sub}/search.json?" + urllib.parse.urlencode(params)
        try:
            data = get_json(url)
        except Exception as exc:  # noqa: BLE001
            log(f"  reddit r/{sub}: {exc}")
            continue
        for child in (data.get("data") or {}).get("children", []):
            d = child.get("data") or {}
            if d.get("stickied") or d.get("over_18"):
                continue
            title = d.get("title") or ""
            text = clean_text(d.get("selftext"))
            if not is_ai(title, text):
                continue
            pid = d.get("id")
            discuss = "https://www.reddit.com" + (d.get("permalink") or "")
            link = d.get("url_overridden_by_dest") or d.get("url") or discuss
            items[f"rd-{pid}"] = {
                "id": f"rd-{pid}",
                "source": "reddit",
                "sub": d.get("subreddit") or sub,
                "title": title,
                "url": link,
                "discuss_url": discuss,
                "author": d.get("author") or "",
                "score": d.get("score") or 0,
                "comments": d.get("num_comments") or 0,
                "created": int(d.get("created_utc") or time.time()),
                "text": text,
                "hints": [f"r/{d.get('subreddit') or sub}"],
            }
        time.sleep(2)  # Reddit 对未登录请求限流较严
    if not items:
        raise RuntimeError("Reddit 没有返回任何数据（可能被限流或屏蔽了数据中心 IP）")
    return list(items.values())


def collect_v2ex() -> list[dict]:
    items: dict[str, dict] = {}
    for node in V2EX_NODES:
        url = "https://www.v2ex.com/api/topics/show.json?" + urllib.parse.urlencode({"node_name": node})
        try:
            data = get_json(url)
        except Exception as exc:  # noqa: BLE001
            log(f"  v2ex {node}: {exc}")
            continue
        if not isinstance(data, list):
            continue
        for t in data:
            title = t.get("title") or ""
            text = clean_text(t.get("content_rendered") or t.get("content"))
            if not is_ai(title, text):
                continue
            tid = t.get("id")
            link = t.get("url") or f"https://www.v2ex.com/t/{tid}"
            items[f"v2-{tid}"] = {
                "id": f"v2-{tid}",
                "source": "v2ex",
                "title": title,
                "url": link,
                "discuss_url": link,
                "author": (t.get("member") or {}).get("username", ""),
                "score": 0,
                "comments": t.get("replies") or 0,
                "created": int(t.get("created") or time.time()),
                "text": text,
                "hints": [f"v2ex/{(t.get('node') or {}).get('title') or node}"],
            }
        time.sleep(1)
    if not items:
        raise RuntimeError("V2EX 没有返回 AI 相关数据")
    return list(items.values())


def collect_producthunt() -> list[dict]:
    raw = http_get(PRODUCTHUNT_FEED, accept="application/atom+xml, application/xml, text/xml")
    root = ET.fromstring(raw)
    ns = {"a": "http://www.w3.org/2005/Atom"}
    items = []
    entries = root.findall("a:entry", ns)
    for e in entries:
        title = (e.findtext("a:title", default="", namespaces=ns) or "").strip()
        content = clean_text(e.findtext("a:content", default="", namespaces=ns))
        if not is_ai(title, content):
            continue
        # 注意：Element 没有子节点时布尔值为 False，不能用 `or` 连接
        link_el = e.find("a:link[@rel='alternate']", ns)
        if link_el is None:
            link_el = e.find("a:link", ns)
        link = link_el.get("href") if link_el is not None else ""
        eid = e.findtext("a:id", default=link, namespaces=ns) or link
        published = e.findtext("a:published", default="", namespaces=ns) or e.findtext(
            "a:updated", default="", namespaces=ns
        )
        try:
            created = int(datetime.fromisoformat(published.replace("Z", "+00:00")).timestamp())
        except ValueError:
            created = int(time.time())
        author = e.findtext("a:author/a:name", default="", namespaces=ns) or ""
        slug = re.sub(r"[^0-9A-Za-z]+", "-", eid)[-60:]
        items.append(
            {
                "id": f"ph-{slug}",
                "source": "producthunt",
                "title": title,
                "url": link,
                "discuss_url": link,
                "author": author,
                "score": 0,
                "comments": 0,
                "created": created,
                "text": content,
                "hints": ["launch"],
            }
        )
    return items


COLLECTORS = {
    "hn": collect_hn,
    "reddit": collect_reddit,
    "v2ex": collect_v2ex,
    "producthunt": collect_producthunt,
}


def main() -> int:
    existing: dict[str, dict] = {}
    if OUT.exists():
        try:
            for it in json.loads(OUT.read_text("utf-8")).get("items", []):
                existing[it["id"]] = it
        except (ValueError, KeyError) as exc:
            log(f"existing feed unreadable, starting fresh: {exc}")

    status: dict[str, dict] = {}
    fresh = 0
    for name, fn in COLLECTORS.items():
        log(f"collecting {name} …")
        try:
            got = fn()
            for it in got:
                # 合并时保留较新的分数/评论数
                existing[it["id"]] = {**existing.get(it["id"], {}), **it}
            status[name] = {"ok": True, "count": len(got)}
            fresh += len(got)
            log(f"  {name}: {len(got)} items")
        except Exception as exc:  # noqa: BLE001
            status[name] = {"ok": False, "error": str(exc)[:200]}
            log(f"  {name} FAILED: {exc}")

    cutoff = time.time() - RETAIN_DAYS * 86400
    items = [it for it in existing.values() if it.get("created", 0) >= cutoff]
    items.sort(key=lambda it: it.get("created", 0), reverse=True)
    items = items[:MAX_ITEMS]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": status,
        "items": items,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", "utf-8")
    log(f"wrote {len(items)} items ({fresh} fetched this run) -> {OUT}")
    # 全部数据源都失败时返回非 0，方便在 Actions 里看到
    return 0 if any(s["ok"] for s in status.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
