#!/usr/bin/env python3
"""抓取「别人怎么赚钱 / 最新的商业机会 / 正在做的事」并写入 workbench/data/feed.json。

在 GitHub Actions 里定时运行。每次运行会与已有的 feed.json 合并（按 id 去重），
慢慢积累成一个情报库。

数据源（任何一个失败都不会影响其他）：
  - HN 讨论帖评论（价值最高）：「你的副业赚多少钱」「What are you working on」这类
    Ask HN 讨论帖里，大量创业者亲自讲自己在做什么、赚了多少。逐条抽取其中的一手案例。
  - Hacker News 帖子：热门 Show HN、讨论 MRR / 收入 / 出售项目 / 商业点子的帖子
  - Reddit：r/EntrepreneurRideAlong、r/smallbusiness、r/SideProject、r/Business_Ideas 等
    （配置了 REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET 时走官方 API，更稳定）
  - V2EX：分享创造 / 奇思妙想 / 创业 节点
  - Product Hunt：每天新上线的产品

不限于 AI：AI 只是其中一个标签。

可选：配置了 ANTHROPIC_API_KEY 时，用 Claude 给新内容打分（1–5）、判断是不是
真实案例，并提炼中文标题、摘要、商业模式、获客、收入、启发。每次运行最多处理
AI_MAX_ITEMS 条，已处理过的不会重复处理。
"""
from __future__ import annotations

import base64
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "workbench" / "data" / "feed.json"

RETAIN_DAYS = 45  # 普通帖子保留天数
RETAIN_DAYS_CASES = 800  # 讨论帖评论、AI 判定为高价值的内容保留更久
MAX_ITEMS = 2000
TEXT_LIMIT = 700
COMMENT_TEXT_LIMIT = 1200
UA = "Mozilla/5.0 (compatible; ai-money-workbench/1.0; +https://github.com/marsman23/my-website)"

AI_MODEL = os.environ.get("AI_MODEL") or "claude-opus-5-5"
AI_MAX_ITEMS = int(os.environ.get("AI_MAX_ITEMS") or 40)
AI_BATCH = 8

AI_RE = re.compile(
    r"(?<![a-z])(ai|a\.i\.|llm|llms|gpt|gpt-\d\w*|chatgpt|openai|claude|anthropic|gemini|llama|mistral|"
    r"agent|agents|agentic|copilot|genai|machine learning|rag|embeddings?|diffusion|midjourney|"
    r"prompts?|whisper|cursor|automation|automated|ai-powered)(?![a-z])|人工智能|大模型|智能体|自动化|提示词|AIGC",
    re.IGNORECASE,
)
MONEY_RE = re.compile(
    r"\b(mrr|arr|revenue|profit\w*|paying (customers|users)|paid users|customers|subscribers|"
    r"per month|/mo\b|/month|a month|income|sales|bootstrapp\w*|ramen)\b|\$\s?\d|"
    r"赚|变现|收入|营收|流水|盈利|付费|客户|月入|年入",
    re.IGNORECASE,
)
STRONG_MONEY_RE = re.compile(
    r"\b(mrr|arr|revenue|profit\w*|paying customers|paid users)\b|\$\s?\d[\d,.]*\s?k?\s?(/|per|a)\s?(mo|month|year|yr)|"
    r"月入|年入|收入|营收|流水|盈利",
    re.IGNORECASE,
)
BUILD_RE = re.compile(
    r"\b(i built|i made|i'm building|i am building|we built|we're building|i created|i launched|"
    r"we launched|working on|my side project|my startup|my app|my saas|just shipped)\b|"
    r"做了一个|写了一个|开发了|上线了|在做",
    re.IGNORECASE,
)
FIRST_PERSON_RE = re.compile(r"\b(i|i'm|i've|we|we're|we've|my|our)\b|我们?", re.IGNORECASE)
NEWS_RE = re.compile(
    r"\b(openai|google|microsoft|meta|nvidia|apple|amazon|anthropic|deepmind|raises|raised|funding|"
    r"series [abc]|acquires|acquired|lawsuit|sues|layoffs|regulation|announces|unveils|report|ipo|valuation)\b",
    re.IGNORECASE,
)

# ---- HN 帖子：(查询词, tags, 最近几天, 最少分数)；查询词为空 = 该分类下的热门 ----
HN_QUERIES = [
    ("", "show_hn", 21, 60),  # 最近的热门 Show HN：大家正在做什么
    ("AI", "show_hn", 30, 15),
    ("MRR", "story", 120, 3),
    ("side project", "story", 120, 5),
    ("bootstrapped", "story", 180, 5),
    ("paying customers", "story", 180, 5),
    ("profitable", "story", 120, 10),
    ("sold my", "story", 365, 10),
    ("acquired my", "story", 365, 10),
    ("business idea", "story", 365, 5),
    ("indie hacker", "story", 180, 5),
    ("small business", "story", 90, 20),
    ("niche", "story", 180, 20),
    ("making money", "ask_hn", 365, 5),
    ("business idea", "ask_hn", 365, 5),
    ("side income", "ask_hn", 365, 5),
    ("startup idea", "ask_hn", 365, 5),
]

# ---- HN 讨论帖：(查询词, 最近几天, 最少分数, 取前几个帖子, 是否按时间取最新) ----
HN_THREADS = [
    ("What are you working on", 75, 20, 1, True),  # 每月一期的「你在做什么」
    ("side projects revenue", 730, 30, 3, False),
    ("generate revenue", 730, 50, 2, False),
    ("side project income", 730, 30, 2, False),
    ("MRR", 730, 30, 2, False),
    ("making money online", 730, 30, 2, False),
    ("passive income", 730, 30, 2, False),
    ("profitable solo", 730, 30, 2, False),
    ("make money with AI", 730, 10, 2, False),
    ("side hustle", 730, 20, 2, False),
    ("business ideas", 730, 30, 2, False),
]
# 只要标题和赚钱 / 副业 / 在做什么有关的讨论帖，避免「你想学什么技能」这类跑题帖子
THREAD_TITLE_RE = re.compile(
    r"revenue|\$\s?\d|money|income|profit|side[- ]?(project|hustle|business)|working on|building|mrr|\barr\b|earn|"
    r"making a living|(solo|small|online|web|own|one[- ]person|internet) business|business ideas?|bootstrap|indie|paying customers",
    re.IGNORECASE,
)
THREAD_MAX_COMMENTS = 80

REDDIT_SUBS = [
    "EntrepreneurRideAlong",
    "SideProject",
    "indiehackers",
    "smallbusiness",
    "Entrepreneur",
    "sidehustle",
    "Business_Ideas",
    "SaaS",
    "microsaas",
    "startups",
    "passive_income",
    "ecommerce",
    "AI_Agents",
]

V2EX_NODES = ["create", "ideas", "startup"]

PRODUCTHUNT_FEED = "https://www.producthunt.com/feed"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def http_get(url: str, *, accept: str = "application/json", headers: dict | None = None, retries: int = 2) -> bytes:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, **(headers or {})})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last = exc
            if 400 <= exc.code < 500 and exc.code != 429:
                break  # 403/404 之类重试也没用
            time.sleep(2 * (attempt + 1))
        except Exception as exc:  # noqa: BLE001 - 其他网络错误重试
            last = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def get_json(url: str, headers: dict | None = None):
    return json.loads(http_get(url, headers=headers).decode("utf-8"))


def clean_text(raw: str | None, limit: int = TEXT_LIMIT) -> str:
    if not raw:
        return ""
    text = re.sub(r"<(br|p|/p|li|/li)[^>]*>", "\n", raw, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    if len(text) > limit:
        text = text[:limit].rstrip() + "…"
    return text


def is_ai(*parts: str) -> bool:
    return any(p and AI_RE.search(p) for p in parts)


def first_sentence(text: str, limit: int = 100) -> str:
    line = text.strip().split("\n", 1)[0]
    m = re.match(r"(.{20,}?[.!?。！？])(\s|$)", line)
    s = m.group(1) if m else line
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def priority(it: dict) -> float:
    """不调用 AI 时的价值估计，用于挑选优先交给 AI 的内容、以及超出上限时的取舍。"""
    ai = it.get("ai")
    if ai:
        return ai.get("value", 0) * 2 + (3 if ai.get("is_case") else -5)
    blob = f"{it.get('title', '')}\n{it.get('text', '')}"
    s = 0.0
    if STRONG_MONEY_RE.search(blob):
        s += 4
    elif MONEY_RE.search(blob):
        s += 1
    if FIRST_PERSON_RE.search(blob):
        s += 1
    if BUILD_RE.search(blob):
        s += 1
    if len(it.get("text") or "") > 300:
        s += 1
    if "hn_comment" in (it.get("hints") or []):
        s += 1
    if (it.get("score") or 0) >= 50 or (it.get("comments") or 0) >= 30:
        s += 1
    if NEWS_RE.search(it.get("title") or "") and not FIRST_PERSON_RE.search(it.get("title") or ""):
        s -= 3
    return s


# ---------------------------------------------------------------- collectors


def hn_search(query: str, tags: str, days: int, min_points: int, *, by_date: bool = False, hits: int = 50) -> list[dict]:
    now = int(time.time())
    params = {
        "query": query,
        "tags": tags,
        "hitsPerPage": str(hits),
        "numericFilters": f"created_at_i>{now - days * 86400},points>={min_points}",
    }
    endpoint = "search_by_date" if by_date else "search"
    return get_json(f"https://hn.algolia.com/api/v1/{endpoint}?" + urllib.parse.urlencode(params)).get("hits", [])


def collect_hn() -> list[dict]:
    now = int(time.time())
    items: dict[str, dict] = {}
    for query, tags, days, min_points in HN_QUERIES:
        for hit in hn_search(query, tags, days, min_points):
            oid = hit.get("objectID")
            title = hit.get("title") or ""
            if not oid or not title:
                continue
            text = clean_text(hit.get("story_text"))
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


def collect_hn_threads() -> list[dict]:
    """从「大家的副业赚多少钱」「你在做什么」这类讨论帖里，逐条抽取和 AI 相关的一手经验评论。"""
    threads: dict[str, dict] = {}
    for query, days, min_points, take, by_date in HN_THREADS:
        hits = [
            h
            for h in hn_search(query, "ask_hn", days, min_points, by_date=by_date, hits=20)
            if h.get("objectID") and THREAD_TITLE_RE.search(h.get("title") or "")
        ]
        if not by_date:
            hits.sort(key=lambda h: h.get("num_comments") or 0, reverse=True)
        for h in hits[:take]:
            threads.setdefault(h["objectID"], h)
        time.sleep(0.3)

    items: list[dict] = []
    for tid, th in threads.items():
        try:
            tree = get_json(f"https://hn.algolia.com/api/v1/items/{tid}")
        except Exception as exc:  # noqa: BLE001
            log(f"  hn thread {tid}: {exc}")
            continue
        thread_title = th.get("title") or tree.get("title") or ""
        working_on = "working on" in thread_title.lower()
        picked = []
        for c in tree.get("children") or []:  # 只看顶层评论：通常是作者在讲自己的项目
            if c.get("type") != "comment" or not c.get("text") or not c.get("author"):
                continue
            text = clean_text(c["text"], COMMENT_TEXT_LIMIT)
            if len(text) < 120:
                continue
            if working_on:
                # 「你在做什么」帖：只要像是在做产品 / 生意的（有链接、有用户或在讲自己的项目）
                if not (BUILD_RE.search(text) or MONEY_RE.search(text) or "http" in text):
                    continue
            # 赚钱类讨论帖：只要谈到收入、客户、利润
            elif not MONEY_RE.search(text):
                continue
            replies = len(c.get("children") or [])
            picked.append((replies, c, text))
        picked.sort(key=lambda x: (STRONG_MONEY_RE.search(x[2]) is not None, x[0]), reverse=True)
        for replies, c, text in picked[:THREAD_MAX_COMMENTS]:
            cid = c["id"]
            link = f"https://news.ycombinator.com/item?id={cid}"
            items.append(
                {
                    "id": f"hnc-{cid}",
                    "source": "hn",
                    "title": first_sentence(text),
                    "url": link,
                    "discuss_url": link,
                    "author": c.get("author") or "",
                    "score": 0,
                    "comments": replies,
                    "created": c.get("created_at_i") or th.get("created_at_i") or int(time.time()),
                    "text": text,
                    "context": thread_title,
                    "hints": ["hn_comment"],
                }
            )
        time.sleep(0.5)
    if not threads:
        raise RuntimeError("没有找到讨论帖")
    return items


def reddit_token() -> str | None:
    cid, secret = os.environ.get("REDDIT_CLIENT_ID"), os.environ.get("REDDIT_CLIENT_SECRET")
    if not cid or not secret:
        return None
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    req = urllib.request.Request(
        "https://www.reddit.com/api/v1/access_token",
        data=b"grant_type=client_credentials",
        headers={"User-Agent": UA, "Authorization": f"Basic {auth}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode()).get("access_token")


def collect_reddit() -> list[dict]:
    token = None
    try:
        token = reddit_token()
    except Exception as exc:  # noqa: BLE001
        log(f"  reddit oauth failed, falling back to public JSON: {exc}")
    base = "https://oauth.reddit.com" if token else "https://www.reddit.com"
    headers = {"Authorization": f"Bearer {token}"} if token else None
    suffix = "" if token else ".json"

    items: dict[str, dict] = {}
    for sub in REDDIT_SUBS:
        params = {"t": "week", "limit": "50", "raw_json": "1"}
        url = f"{base}/r/{sub}/top{suffix}?" + urllib.parse.urlencode(params)
        try:
            data = get_json(url, headers=headers)
        except Exception as exc:  # noqa: BLE001
            log(f"  reddit r/{sub}: {exc}")
            continue
        for child in (data.get("data") or {}).get("children", []):
            d = child.get("data") or {}
            if d.get("stickied") or d.get("over_18"):
                continue
            title = d.get("title") or ""
            text = clean_text(d.get("selftext"))
            if (d.get("score") or 0) < 5:
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
        time.sleep(1 if token else 2)
    if not items:
        hint = "" if token else "（可以配置 REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET 走官方 API）"
        raise RuntimeError(f"Reddit 没有返回任何数据，可能被限流或屏蔽了数据中心 IP{hint}")
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
        raise RuntimeError("V2EX 没有返回数据")
    return list(items.values())


def collect_producthunt() -> list[dict]:
    raw = http_get(PRODUCTHUNT_FEED, accept="application/atom+xml, application/xml, text/xml")
    root = ET.fromstring(raw)
    ns = {"a": "http://www.w3.org/2005/Atom"}
    items = []
    for e in root.findall("a:entry", ns):
        title = (e.findtext("a:title", default="", namespaces=ns) or "").strip()
        content = clean_text(e.findtext("a:content", default="", namespaces=ns))
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
    "hn_threads": collect_hn_threads,
    "hn": collect_hn,
    "reddit": collect_reddit,
    "v2ex": collect_v2ex,
    "producthunt": collect_producthunt,
}

# ---------------------------------------------------------------- AI 精炼（可选）

AI_SYSTEM = """你在帮一位寻找商业机会、想做副业或小生意的中文用户筛选情报（不限行业，AI 只是其中一类）。用户会给你若干条来自 Hacker News、Reddit、V2EX、Product Hunt 的帖子或评论，每条带有 id。

对每一条，判断它对这位用户的参考价值，并用简体中文提炼要点：
- 价值高：讲了一个具体的项目、生意或市场机会，最好有真实数据（收入、用户数、转化率、成本），说清楚了怎么获客、怎么收费，普通人有机会借鉴。
- 价值低：新闻、融资、大公司动态、泛泛的观点、纯技术讨论、没有任何商业信息的产品发布。

只依据原文，不要编造；原文没提到的字段留空字符串。每条输入都要有一条对应的输出，id 原样返回。"""

AI_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "is_case": {
                        "type": "boolean",
                        "description": "是否是一个具体的、有人在做的项目/生意或赚钱经验（而不是新闻、观点或纯技术讨论）",
                    },
                    "value": {
                        "type": "integer",
                        "description": "对寻找商业机会的普通人的参考价值，1（几乎没用）到 5（非常值得细看）",
                    },
                    "title_zh": {"type": "string", "description": "中文标题，30 字以内，点出项目和关键数字"},
                    "summary_zh": {"type": "string", "description": "一到两句中文摘要"},
                    "model": {"type": "string", "description": "商业模式 / 怎么收费，如：SaaS 订阅 $29/月"},
                    "customer": {"type": "string", "description": "目标用户"},
                    "acquisition": {"type": "string", "description": "获客方式"},
                    "revenue": {"type": "string", "description": "原文中的收入或用户规模数据"},
                    "takeaway": {"type": "string", "description": "一句话：对想做类似事情的人有什么启发"},
                },
                "required": [
                    "id", "is_case", "value", "title_zh", "summary_zh",
                    "model", "customer", "acquisition", "revenue", "takeaway",
                ],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

SOURCE_NAMES = {"hn": "Hacker News", "reddit": "Reddit", "v2ex": "V2EX", "producthunt": "Product Hunt"}


def ai_enrich(items: list[dict]) -> dict:
    """给还没处理过的内容加上 ai 字段。返回状态信息。"""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {"ok": False, "error": "未配置 ANTHROPIC_API_KEY，跳过 AI 精炼"}
    try:
        import anthropic
    except ImportError:
        return {"ok": False, "error": "未安装 anthropic SDK"}

    client = anthropic.Anthropic()
    todo = sorted((it for it in items if "ai" not in it), key=priority, reverse=True)[:AI_MAX_ITEMS]
    done = 0
    errors: list[str] = []
    for i in range(0, len(todo), AI_BATCH):
        batch = todo[i : i + AI_BATCH]
        parts = []
        for it in batch:
            src = SOURCE_NAMES.get(it["source"], it["source"])
            if it.get("context"):
                src += f"，讨论帖《{it['context']}》下的评论"
            elif it.get("sub"):
                src += f" r/{it['sub']}"
            parts.append(
                f"<item id=\"{it['id']}\">\n来源：{src}\n标题：{it['title']}\n"
                f"热度：{it.get('score') or 0} 赞，{it.get('comments') or 0} 回复\n正文：{it.get('text') or '（无）'}\n</item>"
            )
        try:
            resp = client.beta.messages.create(
                model=AI_MODEL,
                max_tokens=16000,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=AI_SYSTEM,
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": AI_SCHEMA}},
                messages=[{"role": "user", "content": "\n\n".join(parts)}],
            )
        except anthropic.AuthenticationError as exc:
            return {"ok": False, "error": f"API Key 无效：{exc}"}
        except anthropic.APIError as exc:
            errors.append(str(exc)[:120])
            log(f"  ai batch failed: {exc}")
            continue
        if resp.stop_reason in ("refusal", "max_tokens"):
            errors.append(f"stop_reason={resp.stop_reason}")
            continue
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            results = json.loads(text).get("items", [])
        except ValueError:
            errors.append("返回的 JSON 无法解析")
            continue
        by_id = {it["id"]: it for it in batch}
        for r in results:
            it = by_id.get(r.get("id"))
            if not it:
                continue
            r.pop("id", None)
            r["value"] = max(1, min(5, int(r.get("value") or 1)))
            it["ai"] = r
            done += 1
    status = {"ok": done > 0 or not todo, "count": done, "model": AI_MODEL}
    if errors:
        status["error"] = "; ".join(errors[:3])
    return status


# ---------------------------------------------------------------- main


def main() -> int:
    existing: dict[str, dict] = {}
    if OUT.exists():
        try:
            for it in json.loads(OUT.read_text("utf-8")).get("items", []):
                existing[it["id"]] = it
        except (ValueError, KeyError) as exc:
            log(f"existing feed unreadable, starting fresh: {exc}")

    status: dict[str, dict] = {}
    for name, fn in COLLECTORS.items():
        log(f"collecting {name} …")
        try:
            got = fn()
            for it in got:
                # 合并时保留较新的分数/评论数，以及已有的 AI 结果
                existing[it["id"]] = {**existing.get(it["id"], {}), **it}
            status[name] = {"ok": True, "count": len(got)}
            log(f"  {name}: {len(got)} items")
        except Exception as exc:  # noqa: BLE001
            status[name] = {"ok": False, "error": str(exc)[:200]}
            log(f"  {name} FAILED: {exc}")

    now = time.time()

    def keep(it: dict) -> bool:
        # 清理早期版本从跑题讨论帖里抓到的评论
        if "hn_comment" in (it.get("hints") or []) and not THREAD_TITLE_RE.search(it.get("context") or ""):
            return False
        long_lived = "hn_comment" in (it.get("hints") or []) or (it.get("ai") or {}).get("value", 0) >= 4
        days = RETAIN_DAYS_CASES if long_lived else RETAIN_DAYS
        return it.get("created", 0) >= now - days * 86400

    items = [it for it in existing.values() if keep(it)]
    # 超过上限时，先舍弃价值低的
    items.sort(key=lambda it: (priority(it), it.get("created", 0)), reverse=True)
    items = items[:MAX_ITEMS]

    log("ai enrich …")
    status["ai"] = ai_enrich(items)
    log(f"  ai: {status['ai']}")

    items.sort(key=lambda it: it.get("created", 0), reverse=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": status,
        "items": items,
    }
    # 每条一行：文件更小，git 增量也更小
    body = ",\n".join(json.dumps(it, ensure_ascii=False, separators=(",", ":")) for it in items)
    head = json.dumps({k: v for k, v in payload.items() if k != "items"}, ensure_ascii=False)[:-1]
    OUT.write_text(f'{head}, "items": [\n{body}\n]}}\n', "utf-8")
    log(f"wrote {len(items)} items -> {OUT}")
    collected_ok = any(s["ok"] for k, s in status.items() if k != "ai")
    return 0 if collected_ok else 1


if __name__ == "__main__":
    sys.exit(main())
