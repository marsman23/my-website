// 搞钱情报工作台 —— 纯前端，无需构建。
// 数据 = workbench/data/feed.json（GitHub Actions 定时抓取） + 浏览器里实时抓取的 HN / Reddit。
// 个人数据（收藏、笔记、状态、AI 拆解、设置）只存在本机 localStorage。

const SOURCES = {
  hn: { label: 'Hacker News', short: 'HN' },
  reddit: { label: 'Reddit', short: 'Reddit' },
  v2ex: { label: 'V2EX', short: 'V2EX' },
  producthunt: { label: 'Product Hunt', short: 'PH' },
  hn_threads: { label: 'HN 讨论帖评论', short: 'HN 讨论' },
  mine: { label: '我的想法', short: '我的' },
};

const STATUSES = [
  { id: 'idea', label: '💡 灵感' },
  { id: 'validating', label: '🔍 验证中' },
  { id: 'doing', label: '🚀 在做' },
  { id: 'dropped', label: '🗄 放弃/归档' },
];

const DEFAULT_KEYWORDS = ['MRR', 'side project revenue', 'bootstrapped', 'paying customers', 'business idea', 'sold my business'];
const LIVE_REDDIT_SUBS = ['EntrepreneurRideAlong', 'smallbusiness', 'SideProject', 'Business_Ideas', 'sidehustle', 'indiehackers'];
const PAGE_SIZE = 60;
const STORE_KEY = 'aiwb.v1';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm';
const MODEL = 'claude-opus-5-5';

// ------------------------------------------------------------------ 本地存储

function loadStore() {
  const empty = { saved: {}, analysis: {}, settings: { keywords: DEFAULT_KEYWORDS } };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return empty;
    const s = JSON.parse(raw);
    return { ...empty, ...s, settings: { ...empty.settings, ...(s.settings || {}) } };
  } catch {
    return empty;
  }
}
const store = loadStore();
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) {
    console.warn('localStorage 不可用，数据不会被保存', e);
  }
}

// ------------------------------------------------------------------ 识别与分类

const AI_RE = /(?<![a-z])(ai|llm|llms|gpt|chatgpt|openai|claude|anthropic|gemini|llama|agent|agents|agentic|copilot|genai|rag|diffusion|midjourney|prompt|whisper|automation)(?![a-z])|人工智能|大模型|智能体|自动化|提示词|AIGC/i;

const BUILD_RE = /\b(show hn|i built|i made|i'm building|im building|we built|we're building|i created|i launched|we launched|just launched|launching|just shipped|introducing|my side project|open[- ]sourced|beta)\b|做了一个|写了一个|开发了|上线了|发布了|开源了|独立开发|分享创造|我的产品/i;
const MONEY_RE = /\b(mrr|arr|revenue|profit|profitable|paying customers|paid users|customers|make money|making money|made \$|earn|income|side hustle|monetiz\w*|business idea|bootstrapp\w*|ramen)\b|\$\d|赚钱|变现|副业|收入|商业模式|思路|搞钱|盈利|月入|付费用户|客户/i;

const TAG_RULES = [
  ['AI', AI_RE],
  ['SaaS 订阅', /\b(saas|subscription|mrr|recurring)\b|订阅/i],
  ['Agent / 自动化', /\b(agents?|agentic|automation|automate|workflow|n8n|zapier|make\.com|rpa)\b|自动化|智能体|工作流/i],
  ['内容 / 自媒体', /\b(youtube|tiktok|newsletter|content|blog|seo|instagram|twitter|faceless)\b|自媒体|小红书|抖音|公众号|视频号|内容/i],
  ['开发者工具 / API', /\b(api|developer|devtool|sdk|cli|github|coding|code review|ide)\b|开发者|编程/i],
  ['浏览器插件', /\b(chrome extension|browser extension|extension)\b|插件|扩展/i],
  ['服务 / 外包', /\b(agency|freelanc\w*|consult\w*|done[- ]for[- ]you|services?)\b|外包|接单|代运营|咨询|服务/i],
  ['电商', /\b(shopify|e-?commerce|amazon|etsy|dropship\w*|store)\b|电商|带货|跨境|淘宝|闲鱼/i],
  ['图像 / 视频生成', /\b(image|photo|headshots?|avatar|video gen\w*|text[- ]to[- ](image|video)|stable diffusion|midjourney)\b|图片|头像|视频生成|绘画/i],
  ['教育 / 课程', /\b(course|tutor\w*|education|learning|students?|teach\w*)\b|课程|教育|培训|学习/i],
  ['移动 App', /\b(ios|android|app store|mobile app|iphone)\b|小程序|安卓|苹果/i],
  ['数字产品', /\b(templates?|ebook|prompts? pack|notion template|digital product)\b|模板|电子书|提示词/i],
  ['B2B / 企业', /\b(b2b|enterprise|smb|small business|sales team|crm|leads?)\b|企业|商家|获客/i],
  ['语音 / 电话', /\b(voice|phone|call|receptionist|speech|tts)\b|语音|电话|客服/i],
  ['本地 / 线下生意', /\b(local business|restaurant|cafe|salon|plumb\w*|landscap\w*|cleaning|laundromat|car wash|vending|storefront|brick and mortar|franchise|food truck)\b|门店|实体店|线下|餐饮|加盟|摆摊/i],
  ['收购 / 出售项目', /\b(acquired|acquisition|sold (my|our|the)|exit|flippa|acquire\.com|buy(ing)? a business)\b|收购|出售|转让/i],
  ['社区 / 会员', /\b(community|membership|discord|patreon|paid group|cohort)\b|社群|会员|知识星球|付费群/i],
  ['金融 / 交易', /\b(trading|stocks?|crypto|invest\w*|real estate|rental|dividend)\b|交易|股票|加密|投资|房产|理财/i],
  ['实体产品 / 硬件', /\b(hardware|physical product|manufactur\w*|3d print\w*|kickstarter|inventory)\b|硬件|实体产品|工厂|供应链/i],
  ['游戏', /\b(game|gaming|steam|indie game)\b|游戏/i],
];

const PRICE_CONTEXT = /(pric\w*|plan|cost\w*|charg\w*|only|just|at|@|starts? at|subscription|tier|fee|pay\w*|budget|spend\w*|bill\w*|定价|售价|会员|价格|只要|仅需)\W*\S*\W*$/i;

function toNumber(numStr, unit) {
  let n = parseFloat(String(numStr).replace(/,/g, ''));
  if (!isFinite(n)) return 0;
  const u = (unit || '').toLowerCase();
  if (u === 'k' || u === 'thousand' || u === '千') n *= 1e3;
  else if (u === 'm' || u === 'mm' || u === 'million') n *= 1e6;
  else if (u === '万' || u === 'w') n *= 1e4;
  return n;
}

// 从文字里找收入信号，返回 { monthlyUsd, raw } 或 null。只是启发式识别，不保证准确。
function extractRevenue(text) {
  if (!text) return null;
  const found = [];
  const push = (monthlyUsd, raw) => {
    if (monthlyUsd >= 50 && monthlyUsd < 5e7) found.push({ monthlyUsd, raw: raw.trim() });
  };

  // $5k MRR / $3,000/month / $1.2M ARR / $500 in revenue
  const enA = /(?:US)?\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|million|thousand)?\b\s*\+?\s*(?:in\s+)?(mrr|arr|\/\s?mo(?:nth)?\b|per month|a month|monthly|\/\s?y(?:ea)?r\b|per year|a year|annually|revenue|in sales|sales|profit)/gi;
  for (const m of text.matchAll(enA)) {
    const kw = m[3].toLowerCase();
    const strong = /mrr|arr|revenue|sales|profit/.test(kw);
    if (!strong && PRICE_CONTEXT.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    let v = toNumber(m[1], m[2]);
    if (!strong && v < 300) continue; // 「$29/month」这类小额多半是定价而不是收入
    if (/arr|y(ea)?r|annually/.test(kw)) v /= 12;
    else if (/revenue|sales|profit/.test(kw)) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 25).toLowerCase();
      if (/(\/\s?mo|per month|a month|monthly|每月)/.test(after)) { /* monthly */ }
      else if (/(\/\s?y|per year|a year|annual|this year|last year)/.test(after)) v /= 12;
      else v /= 12; // 周期不明，按总额保守折算
    }
    push(v, m[0]);
  }

  // MRR of $5k / revenue: $12,000 / making $3k
  const enB = /\b(mrr|arr|revenue|making|earning|earned|made|profit)\b\D{0,14}?\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|million)?\b(\s*(?:\/\s?mo\w*|per month|a month|monthly|\/\s?y\w*|per year|a year))?/gi;
  for (const m of text.matchAll(enB)) {
    const kw = m[1].toLowerCase();
    const period = (m[4] || '').toLowerCase();
    let v = toNumber(m[2], m[3]);
    if (kw === 'arr' || /y/.test(period)) v /= 12;
    else if (kw !== 'mrr' && !/mo|month/.test(period)) v /= 12;
    push(v, m[0]);
  }

  // 5k MRR（没有 $ 符号）
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s?(k|m)\s?(mrr|arr)\b/gi)) {
    let v = toNumber(m[1], m[2]);
    if (m[3].toLowerCase() === 'arr') v /= 12;
    push(v, m[0]);
  }

  // 中文：月入 3 万 / 月收入 5000 美元 / 年入 100w / 赚了 2 万
  const cn = /(月入|月收入|月流水|月营收|月利润|月赚|年入|年收入|年营收|年流水|收入|营收|流水|利润|盈利|赚了|赚到|变现)[^\d$\n]{0,6}(\$|＄)?\s*(\d+(?:\.\d+)?)\s*(万|千|w|W|k|K)?\s*(美元|美金|刀|U|元|块|人民币|RMB|rmb)?/g;
  for (const m of text.matchAll(cn)) {
    const kw = m[1];
    let v = toNumber(m[3], m[4]);
    const usd = m[2] || /美元|美金|刀|U/.test(m[5] || '');
    if (!usd) v /= 7.2;
    if (kw.startsWith('年')) v /= 12;
    else if (!kw.startsWith('月')) v /= 12;
    push(v, m[0]);
  }

  if (!found.length) return null;
  return found.sort((a, b) => b.monthlyUsd - a.monthlyUsd)[0];
}

function fmtUsd(n) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `$${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

const STRONG_MONEY_RE = /\b(mrr|arr|revenue|profit\w*|paying customers|paid users)\b|月入|年入|收入|营收|流水|盈利/i;
const FIRST_PERSON_RE = /\b(i|i'm|i've|we|we're|we've|my|our)\b|我们?/i;
const NEWS_RE = /\b(openai|google|microsoft|meta|nvidia|apple|amazon|anthropic|deepmind|raises|raised|funding|series [abc]|acquires|acquired|lawsuit|sues|layoffs|regulation|announces|unveils|report|ipo|valuation)\b/i;

// 没有 AI 打分时的价值估计（1–5）：有收入数字、第一人称经验、细节多的加分；新闻类减分。
function heuristicValue(item, blob, rev) {
  let s = 0;
  if (rev || STRONG_MONEY_RE.test(blob)) s += 4;
  else if (MONEY_RE.test(blob)) s += 1;
  if (FIRST_PERSON_RE.test(blob)) s += 1;
  if (BUILD_RE.test(blob)) s += 1;
  if ((item.text || '').length > 300) s += 1;
  if ((item.hints || []).includes('hn_comment')) s += 1;
  if ((item.score || 0) >= 50 || (item.comments || 0) >= 30) s += 1;
  if (NEWS_RE.test(item.title) && !FIRST_PERSON_RE.test(item.title)) s -= 3;
  return s >= 8 ? 5 : s >= 6 ? 4 : s >= 4 ? 3 : s >= 2 ? 2 : 1;
}

function enrich(item) {
  if (item._e) return item._e;
  const ai = item.ai;
  const blob = `${item.title}\n${item.text || ''}`;
  const aiBlob = ai ? `${ai.title_zh}\n${ai.summary_zh}\n${ai.model}\n${ai.customer}\n${ai.acquisition}` : '';
  const hints = item.hints || [];
  const rev = extractRevenue(blob) || (ai?.revenue ? extractRevenue(ai.revenue) : null);
  const building =
    BUILD_RE.test(blob) ||
    hints.includes('show_hn') ||
    hints.includes('launch') ||
    hints.some((h) => /分享创造/.test(h)) ||
    item.source === 'producthunt' ||
    (item.context || '').toLowerCase().includes('working on');
  const money = !!rev || !!ai?.revenue || MONEY_RE.test(blob);
  let kind = money && building ? 'both' : money ? 'money' : building ? 'building' : 'talk';
  if (ai && !ai.is_case) kind = 'talk';
  const tags = TAG_RULES.filter(([, re]) => re.test(blob) || (aiBlob && re.test(aiBlob))).map(([t]) => t);
  const value = ai ? (ai.is_case ? ai.value : Math.min(ai.value, 2)) : heuristicValue(item, blob, rev);
  const ageH = Math.max(0, (Date.now() / 1000 - item.created) / 3600);
  const points = (item.score || 0) + 2 * (item.comments || 0) + (item.source === 'producthunt' ? 20 : 0) + (rev ? 30 : 0) + 1;
  const hot = points / Math.pow(ageH + 4, 0.7);
  item._e = { rev, kind, tags, hot, value, searchBlob: `${blob}\n${aiBlob}\n${item.author}\n${item.context || ''}`.toLowerCase() };
  return item._e;
}

// ------------------------------------------------------------------ 数据获取

const items = new Map();
const sourceStatus = {}; // name -> {state:'ok'|'fail'|'wait', text}

function addItems(list) {
  for (const it of list) {
    if (!it || !it.id || !it.title) continue;
    const prev = items.get(it.id);
    items.set(it.id, prev ? { ...prev, ...it, _e: undefined } : it);
  }
}

function stripHtml(s, limit = 700) {
  if (!s) return '';
  const doc = new DOMParser().parseFromString(s.replace(/<(br|p)[^>]*>/gi, '\n'), 'text/html');
  const t = (doc.body.textContent || '').replace(/\n{2,}/g, '\n').trim();
  return t.length > limit ? t.slice(0, limit) + '…' : t;
}

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let feedMeta = null;
async function loadStaticFeed() {
  try {
    const data = await getJson(`data/feed.json?t=${Date.now()}`);
    feedMeta = data;
    addItems(data.items || []);
    for (const [name, s] of Object.entries(data.sources || {})) {
      if (name === 'ai') {
        sourceStatus.ai = s.ok
          ? { state: 'ok', text: `🤖 AI 已精炼 ${(data.items || []).filter((it) => it.ai).length} 条` }
          : { state: 'wait', text: '🤖 未开启 AI 精炼', title: s.error };
        continue;
      }
      sourceStatus[name] = s.ok
        ? { state: 'ok', text: `${SOURCES[name]?.label || name} · ${s.count} 条（定时抓取）` }
        : { state: 'fail', text: `${SOURCES[name]?.label || name} 定时抓取失败`, title: s.error };
    }
  } catch (e) {
    console.warn('feed.json 读取失败', e);
  }
}

function hnHitToItem(hit) {
  const id = hit.objectID;
  const discuss = `https://news.ycombinator.com/item?id=${id}`;
  const tags = hit._tags || [];
  return {
    id: `hn-${id}`,
    source: 'hn',
    title: hit.title || '',
    url: hit.url || discuss,
    discuss_url: discuss,
    author: hit.author || '',
    score: hit.points || 0,
    comments: hit.num_comments || 0,
    created: hit.created_at_i,
    text: stripHtml(hit.story_text),
    hints: ['show_hn', 'ask_hn'].filter((t) => tags.includes(t)),
  };
}

async function liveHN() {
  const now = Math.floor(Date.now() / 1000);
  const kws = (store.settings.keywords || DEFAULT_KEYWORDS).filter(Boolean);
  const queries = [
    { query: '', tags: 'show_hn', days: 14, min: 60 },
    { query: 'AI', tags: 'show_hn', days: 14, min: 15 },
    ...kws.map((k) => ({ query: k, tags: 'story', days: 120, min: 5 })),
  ];
  const results = await Promise.allSettled(
    queries.map((q) => {
      const p = new URLSearchParams({
        query: q.query,
        tags: q.tags,
        hitsPerPage: '50',
        numericFilters: `created_at_i>${now - q.days * 86400},points>=${q.min}`,
      });
      return getJson(`https://hn.algolia.com/api/v1/search?${p}`).then((d) =>
        (d.hits || [])
          .filter((h) => h.title)
          .map(hnHitToItem),
      );
    }),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error(results[0]?.reason?.message || '请求失败');
  const list = ok.flatMap((r) => r.value);
  addItems(list);
  return new Set(list.map((it) => it.id)).size;
}

async function liveReddit() {
  const results = await Promise.allSettled(
    LIVE_REDDIT_SUBS.map((sub) => {
      const p = new URLSearchParams({ t: 'week', limit: '40', raw_json: '1' });
      return getJson(`https://www.reddit.com/r/${sub}/top.json?${p}`).then((d) =>
        ((d.data && d.data.children) || [])
          .map((c) => c.data || {})
          .filter((d) => !d.stickied && !d.over_18 && d.title && (d.score || 0) >= 5)
          .map((d) => {
            const discuss = `https://www.reddit.com${d.permalink || ''}`;
            const text = (d.selftext || '').slice(0, 700);
            return {
              id: `rd-${d.id}`,
              source: 'reddit',
              sub: d.subreddit,
              title: d.title,
              url: d.url_overridden_by_dest || d.url || discuss,
              discuss_url: discuss,
              author: d.author || '',
              score: d.score || 0,
              comments: d.num_comments || 0,
              created: Math.floor(d.created_utc || Date.now() / 1000),
              text,
              hints: [`r/${d.subreddit}`],
            };
          })
      );
    }),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error('浏览器无法直接访问 Reddit（可能被拦截），依赖定时抓取的数据');
  const list = ok.flatMap((r) => r.value);
  addItems(list);
  return new Set(list.map((it) => it.id)).size;
}

// 「大家的副业赚多少钱」「What are you working on」这类讨论帖里，抽取和 AI 相关的一手经验评论
async function liveHNThreads() {
  const now = Math.floor(Date.now() / 1000);
  const search = (query, days, minPoints, byDate) => {
    const p = new URLSearchParams({
      query,
      tags: 'ask_hn',
      hitsPerPage: '20',
      numericFilters: `created_at_i>${now - days * 86400},points>=${minPoints}`,
    });
    return getJson(`https://hn.algolia.com/api/v1/${byDate ? 'search_by_date' : 'search'}?${p}`).then((d) => d.hits || []);
  };
  const [latest, revenue] = await Promise.all([
    search('What are you working on', 75, 20, true),
    search('side projects revenue', 730, 30, false),
  ]);
  revenue.sort((a, b) => (b.num_comments || 0) - (a.num_comments || 0));
  const threads = [latest[0], revenue[0], revenue[1]].filter(Boolean);
  if (!threads.length) throw new Error('没有找到讨论帖');
  const trees = await Promise.allSettled(threads.map((t) => getJson(`https://hn.algolia.com/api/v1/items/${t.objectID}`, 30000)));
  const list = [];
  trees.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const title = threads[i].title || '';
    const workingOn = title.toLowerCase().includes('working on');
    for (const c of r.value.children || []) {
      if (c.type !== 'comment' || !c.text || !c.author) continue;
      const text = stripHtml(c.text, 1200);
      if (text.length < 120) continue;
      if (workingOn ? !(BUILD_RE.test(text) || MONEY_RE.test(text) || text.includes('http')) : !MONEY_RE.test(text)) continue;
      const link = `https://news.ycombinator.com/item?id=${c.id}`;
      const first = text.split('\n')[0];
      const m = first.match(/^(.{20,}?[.!?。！？])(\s|$)/);
      let t = m ? m[1] : first;
      if (t.length > 100) t = t.slice(0, 99) + '…';
      list.push({
        id: `hnc-${c.id}`,
        source: 'hn',
        title: t,
        url: link,
        discuss_url: link,
        author: c.author,
        score: 0,
        comments: (c.children || []).length,
        created: c.created_at_i || threads[i].created_at_i,
        text,
        context: title,
        hints: ['hn_comment'],
      });
    }
  });
  addItems(list);
  return new Set(list.map((it) => it.id)).size;
}

async function liveRefresh() {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = '⟳ 刷新中…';
  const jobs = { hn: liveHN, hn_threads: liveHNThreads, reddit: liveReddit };
  for (const name of Object.keys(jobs)) sourceStatus[`live-${name}`] = { state: 'wait', text: `${SOURCES[name].label} 实时抓取中…` };
  renderStatus();
  await Promise.all(
    Object.entries(jobs).map(async ([name, fn]) => {
      try {
        const n = await fn();
        sourceStatus[`live-${name}`] = { state: 'ok', text: `${SOURCES[name].label} · ${n} 条（实时）` };
      } catch (e) {
        sourceStatus[`live-${name}`] = { state: 'fail', text: `${SOURCES[name].label} 实时抓取失败`, title: e.message };
      }
      renderStatus();
      renderFeed(true);
    }),
  );
  btn.disabled = false;
  btn.textContent = '⟳ 实时刷新';
}

// ------------------------------------------------------------------ 渲染：情报流

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const filters = { q: '', kind: 'all', source: 'all', range: 3650, sort: 'value', revOnly: false, picked: true, tag: null };
let page = 1;

function timeAgo(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString('zh-CN');
}

const KIND_LABEL = { money: '💰 赚钱思路', building: '🛠 正在做', both: '💰🛠 在做且有收入', talk: '💬 讨论' };

function baseFiltered() {
  const cutoff = Date.now() / 1000 - filters.range * 86400;
  const q = filters.q.trim().toLowerCase();
  return [...items.values()].filter((it) => {
    if (it.created < cutoff) return false;
    if (filters.source !== 'all' && it.source !== filters.source) return false;
    const e = enrich(it);
    if (filters.kind === 'money' && !(e.kind === 'money' || e.kind === 'both')) return false;
    if (filters.kind === 'building' && !(e.kind === 'building' || e.kind === 'both')) return false;
    if (filters.revOnly && !e.rev) return false;
    if (filters.picked && e.value < 3) return false;
    if (q && !e.searchBlob.includes(q)) return false;
    return true;
  });
}

function sorted(list) {
  const by = {
    value: (a, b) => enrich(b).value - enrich(a).value || enrich(b).hot - enrich(a).hot,
    hot: (a, b) => enrich(b).hot - enrich(a).hot,
    new: (a, b) => b.created - a.created,
    revenue: (a, b) => (enrich(b).rev?.monthlyUsd || 0) - (enrich(a).rev?.monthlyUsd || 0) || enrich(b).hot - enrich(a).hot,
  };
  return list.sort(by[filters.sort]);
}

function renderStats(all) {
  const money = all.filter((it) => ['money', 'both'].includes(enrich(it).kind)).length;
  const building = all.filter((it) => ['building', 'both'].includes(enrich(it).kind)).length;
  const rev = all.filter((it) => enrich(it).rev).length;
  const stats = [
    [all.length, filters.picked ? '精选情报（≥3★）' : '当前范围内的情报'],
    [money, '💰 赚钱思路 / 经验'],
    [building, '🛠 正在做 / 新上线'],
    [rev, '带收入数字的帖子'],
    [Object.keys(store.saved).length, '⭐ 我收藏的'],
  ];
  const el = $('#stats');
  el.replaceChildren(
    ...stats.map(([n, l]) => {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="n"></div><div class="l"></div>';
      d.firstChild.textContent = n.toLocaleString('zh-CN');
      d.lastChild.textContent = l;
      return d;
    }),
  );
}

function renderStatus() {
  const el = $('#source-status');
  el.replaceChildren(
    ...Object.values(sourceStatus).map((s) => {
      const c = document.createElement('span');
      c.className = `chip ${s.state}`;
      c.textContent = s.text;
      if (s.title) c.title = s.title;
      return c;
    }),
  );
  const tip = $('#setup-tip');
  const actions = 'https://github.com/marsman23/my-website/actions/workflows/update-feed.yml';
  if (!feedMeta?.generated_at) {
    tip.innerHTML = `⚠️ 定时抓取还没运行过，现在只显示浏览器实时拉到的 Hacker News 内容。去 <a target="_blank" rel="noopener">Actions</a> 手动运行一次「更新搞钱情报」，就会有讨论帖评论、Reddit、V2EX、Product Hunt 的内容。`;
    tip.querySelector('a').href = actions;
    tip.classList.remove('hidden');
  } else if (!feedMeta.sources?.ai?.ok) {
    tip.innerHTML = `💡 在仓库 Settings → Secrets and variables → Actions 里添加 <code>ANTHROPIC_API_KEY</code>，定时任务就会用 Claude 给每条内容打分、判断是不是真实案例，并提炼成中文（标题、摘要、商业模式、获客、收入、启发）。`;
    tip.classList.remove('hidden');
  } else tip.classList.add('hidden');

  const upd = $('#updated');
  upd.textContent = feedMeta?.generated_at ? `数据更新于 ${new Date(feedMeta.generated_at).toLocaleString('zh-CN')}` : '';
}

function renderTags(list) {
  const counts = new Map();
  for (const it of list) for (const t of enrich(it).tags) counts.set(t, (counts.get(t) || 0) + 1);
  const row = $('#tag-row');
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (filters.tag && !counts.has(filters.tag)) entries.unshift([filters.tag, 0]);
  row.replaceChildren(
    ...entries.map(([t, c]) => {
      const b = document.createElement('button');
      b.className = 'tag-btn' + (filters.tag === t ? ' active' : '');
      b.textContent = t;
      const span = document.createElement('span');
      span.className = 'c';
      span.textContent = c;
      b.append(span);
      b.onclick = () => {
        filters.tag = filters.tag === t ? null : t;
        renderFeed(true);
      };
      return b;
    }),
  );
}

function buildCard(it, { inBoard = false } = {}) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const e = it.source === 'mine' ? { rev: extractRevenue(`${it.title}\n${it.text || ''}`), kind: 'talk', tags: [] } : enrich(it);
  const ai = it.ai;
  const src = $('.src', node);
  src.textContent =
    it.source === 'reddit' && it.sub
      ? `r/${it.sub}`
      : (it.hints || []).includes('hn_comment')
        ? SOURCES.hn_threads.short
        : SOURCES[it.source]?.short || it.source;
  if (e.value) {
    const v = $('.val', node);
    v.classList.remove('hidden');
    v.textContent = '★'.repeat(e.value) + '☆'.repeat(5 - e.value);
    v.title = ai ? `AI 评估的参考价值：${e.value}/5` : `按规则估计的参考价值：${e.value}/5（配置 AI 精炼后会更准）`;
  }
  const kind = $('.kind', node);
  if (it.source === 'mine') kind.remove();
  else {
    kind.textContent = KIND_LABEL[e.kind];
    kind.classList.add(`k-${e.kind}`);
  }
  if (e.rev) {
    const r = $('.rev', node);
    r.classList.remove('hidden');
    r.textContent = `≈${fmtUsd(e.rev.monthlyUsd)}/月`;
    r.title = `从原文识别：「${e.rev.raw}」（自动识别，未核实）`;
  }
  const a = $('.title', node);
  a.textContent = ai?.title_zh || it.title;
  if (it.url) a.href = it.url;
  else a.removeAttribute('href');
  const orig = $('.orig', node);
  if (ai?.title_zh && it.source !== 'mine') orig.textContent = it.title;
  else orig.remove();

  const facts = $('.facts', node);
  if (ai) {
    const summary = document.createElement('p');
    summary.className = 'summary';
    summary.textContent = ai.summary_zh;
    facts.before(summary);
    for (const [k, v] of [['模式', ai.model], ['用户', ai.customer], ['获客', ai.acquisition], ['收入', ai.revenue], ['启发', ai.takeaway]]) {
      if (!v) continue;
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      facts.append(dt, dd);
    }
  }
  if (!facts.children.length) facts.remove();

  const ex = $('.excerpt', node);
  if (!it.text) ex.remove();
  else if (ai) {
    // 有 AI 摘要时，原文默认折叠
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = '原文';
    ex.textContent = it.text;
    ex.classList.add('open');
    ex.replaceWith(det);
    det.append(sum, ex);
  } else {
    ex.textContent = it.text;
    ex.onclick = () => ex.classList.toggle('open');
  }
  const tags = $('.tags', node);
  for (const t of e.tags) {
    const s = document.createElement('span');
    s.textContent = t;
    tags.append(s);
  }
  const meta = $('.meta', node);
  const parts = [];
  if (it.author) parts.push(`@${it.author}`);
  if (it.score) parts.push(`▲ ${it.score}`);
  if (it.comments) parts.push(`💬 ${it.comments}`);
  if (it.created) parts.push(timeAgo(it.created));
  if (it.context) parts.push(`来自讨论帖「${it.context}」`);
  meta.textContent = parts.join('  ·  ');

  const discuss = $('.discuss', node);
  if (it.discuss_url && it.discuss_url !== it.url) discuss.href = it.discuss_url;
  else discuss.remove();

  const star = $('.star', node);
  const syncStar = () => {
    const on = !!store.saved[it.id];
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('on', on);
    star.title = on ? '已收藏（再点取消）' : '收藏到工作台';
  };
  syncStar();
  star.onclick = () => {
    toggleSave(it);
    syncStar();
    if (inBoard) renderBoard();
  };

  const analysisEl = $('.analysis', node);
  const showAnalysis = (txt, err = false) => {
    analysisEl.textContent = txt;
    analysisEl.classList.toggle('err', err);
    analysisEl.classList.remove('hidden');
  };
  if (store.analysis[it.id]) showAnalysis(store.analysis[it.id]);
  const btn = $('.analyze', node);
  if (store.settings.apiKey) {
    btn.classList.remove('hidden');
    if (store.analysis[it.id]) btn.textContent = '🤖 重新拆解';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '🤖 拆解中…';
      showAnalysis('Claude 正在阅读这条帖子，通常需要十几秒…');
      try {
        const txt = await analyze(it);
        store.analysis[it.id] = txt;
        saveStore();
        showAnalysis(txt);
        btn.textContent = '🤖 重新拆解';
      } catch (err) {
        showAnalysis(`拆解失败：${err.message || err}`, true);
        btn.textContent = '🤖 AI 拆解';
      }
      btn.disabled = false;
    };
  }

  if (inBoard) attachBoardControls(node, it);
  return node;
}

function renderFeed(resetPage = false) {
  if (resetPage) page = 1;
  const base = baseFiltered();
  renderStats(base);
  renderTags(base);
  const list = sorted(filters.tag ? base.filter((it) => enrich(it).tags.includes(filters.tag)) : base);
  const shown = list.slice(0, page * PAGE_SIZE);
  $('#feed').replaceChildren(...shown.map((it) => buildCard(it)));
  $('#more').classList.toggle('hidden', shown.length >= list.length);
  const empty = $('#feed-empty');
  if (!list.length) {
    empty.classList.remove('hidden');
    empty.textContent = items.size
      ? '没有符合条件的内容，试试放宽筛选条件。'
      : '还没有数据。点右上角「实时刷新」从 Hacker News / Reddit 拉取，或等待 GitHub Actions 定时任务生成数据。';
  } else empty.classList.add('hidden');
}

// ------------------------------------------------------------------ 工作台

function snapshot(it) {
  const { _e, ...rest } = it;
  return rest;
}

function toggleSave(it) {
  if (store.saved[it.id]) delete store.saved[it.id];
  else store.saved[it.id] = { item: snapshot(it), status: 'idea', note: '', savedAt: Date.now() };
  saveStore();
  updateSavedCount();
}

function updateSavedCount() {
  $('#saved-count').textContent = Object.keys(store.saved).length;
}

function attachBoardControls(node, it) {
  const entry = store.saved[it.id];
  if (!entry) return;
  const wrap = document.createElement('div');
  wrap.style.display = 'grid';
  wrap.style.gap = '6px';

  const note = document.createElement('textarea');
  note.rows = 3;
  note.placeholder = '我的笔记：能不能复制？我的优势？第一步做什么？';
  note.value = entry.note || '';
  let t;
  note.oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      entry.note = note.value;
      saveStore();
    }, 400);
  };

  const row = document.createElement('div');
  row.className = 'row';
  const sel = document.createElement('select');
  for (const s of STATUSES) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label;
    sel.append(o);
  }
  sel.value = entry.status;
  sel.onchange = () => {
    entry.status = sel.value;
    saveStore();
    renderBoard();
  };
  const del = document.createElement('button');
  del.className = 'btn sm';
  del.textContent = '移除';
  del.onclick = () => {
    if (!confirm('从工作台移除这一条？笔记也会一起删除。')) return;
    delete store.saved[it.id];
    saveStore();
    updateSavedCount();
    renderBoard();
  };
  const date = document.createElement('span');
  date.className = 'muted small';
  date.textContent = `收藏于 ${new Date(entry.savedAt).toLocaleDateString('zh-CN')}`;
  row.append(sel, del, date);
  wrap.append(note, row);
  $('.actions', node).after(wrap);
}

function renderBoard() {
  const board = $('#board');
  const entries = Object.values(store.saved).sort((a, b) => b.savedAt - a.savedAt);
  board.replaceChildren(
    ...STATUSES.map((s) => {
      const col = document.createElement('div');
      col.className = 'col';
      const list = entries.filter((e) => e.status === s.id);
      const h = document.createElement('h3');
      h.textContent = s.label;
      const c = document.createElement('span');
      c.className = 'muted';
      c.textContent = list.length;
      h.append(c);
      col.append(h);
      if (!list.length) {
        const p = document.createElement('p');
        p.className = 'muted small';
        p.style.margin = '4px';
        p.textContent = s.id === 'idea' ? '在情报流里点 ☆ 收藏，或记下自己的想法。' : '—';
        col.append(p);
      }
      for (const e of list) col.append(buildCard(items.get(e.item.id) || e.item, { inBoard: true }));
      return col;
    }),
  );
}

// ------------------------------------------------------------------ AI 拆解（可选，使用用户自己的 Key）

let sdkPromise = null;
async function analyze(it) {
  const apiKey = store.settings.apiKey;
  if (!apiKey) throw new Error('请先在「设置」里填写 API Key');
  sdkPromise ||= import(SDK_URL);
  let Anthropic;
  try {
    ({ default: Anthropic } = await sdkPromise);
  } catch (e) {
    sdkPromise = null;
    throw new Error(`加载 Anthropic SDK 失败：${e.message}`);
  }
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const system =
    '你是一位务实的独立开发 / 小生意顾问。用户会给你一条来自 Hacker News、Reddit、V2EX 或 Product Hunt 的帖子，' +
    '内容通常是某人在做的项目、生意，或赚钱的经验（不一定和 AI 有关）。请用简体中文拆解，严格按下面 7 个小标题输出，每项 1–3 句，' +
    '纯文本，不要用 Markdown 符号。只依据帖子内容，帖子没提到的就写「帖子未提及」，不要编造数字。\n' +
    '【一句话概括】\n【商业模式】\n【目标用户】\n【获客方式】\n【变现与收入】\n【可复制性与门槛】\n【如果我要做，第一步】';
  const user = [
    `来源：${SOURCES[it.source]?.label || it.source}${it.sub ? ` r/${it.sub}` : ''}`,
    `标题：${it.title}`,
    it.url ? `链接：${it.url}` : '',
    it.score || it.comments ? `热度：${it.score || 0} 赞，${it.comments || 0} 评论` : '',
    `正文摘录：\n${it.text || '（无正文，只有标题和链接）'}`,
    store.saved[it.id]?.note ? `我的笔记：${store.saved[it.id].note}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const msg = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (msg.stop_reason === 'refusal') {
    throw new Error(`模型拒绝了这个请求${msg.stop_details?.explanation ? `：${msg.stop_details.explanation}` : ''}`);
  }
  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('没有返回内容');
  return text;
}

// ------------------------------------------------------------------ 事件绑定

function applyTheme() {
  const t = store.settings.theme;
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function bind() {
  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
      if (tab.dataset.tab === 'board') renderBoard();
      if (tab.dataset.tab === 'feed') renderFeed();
    }),
  );

  let qt;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      filters.q = e.target.value;
      renderFeed(true);
    }, 200);
  });
  $$('#kind-seg button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#kind-seg button').forEach((x) => x.classList.toggle('active', x === b));
      filters.kind = b.dataset.kind;
      renderFeed(true);
    }),
  );
  $('#source').onchange = (e) => ((filters.source = e.target.value), renderFeed(true));
  $('#range').onchange = (e) => ((filters.range = Number(e.target.value)), renderFeed(true));
  $('#sort').onchange = (e) => ((filters.sort = e.target.value), renderFeed(true));
  $('#rev-only').onchange = (e) => ((filters.revOnly = e.target.checked), renderFeed(true));
  $('#picked').onchange = (e) => ((filters.picked = e.target.checked), renderFeed(true));
  $('#more').onclick = () => {
    page += 1;
    renderFeed();
  };
  $('#refresh').onclick = liveRefresh;
  $('#theme').onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    store.settings.theme = dark ? 'light' : 'dark';
    saveStore();
    applyTheme();
  };

  // 我的想法
  const form = $('#idea-form');
  $('#add-idea').onclick = () => {
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) form.elements.title.focus();
  };
  $('#idea-cancel').onclick = () => form.classList.add('hidden');
  form.onsubmit = (e) => {
    e.preventDefault();
    const id = `my-${Date.now()}`;
    const f = form.elements;
    const url = f.url.value.trim();
    store.saved[id] = {
      item: { id, source: 'mine', title: f.title.value.trim(), url: /^https?:\/\//.test(url) ? url : '', text: '', created: Math.floor(Date.now() / 1000) },
      status: 'idea',
      note: f.note.value.trim(),
      savedAt: Date.now(),
    };
    saveStore();
    form.reset();
    form.classList.add('hidden');
    updateSavedCount();
    renderBoard();
  };

  // 导出 / 导入
  $('#export').onclick = () => {
    const { apiKey, ...settings } = store.settings; // 不导出 Key
    const blob = new Blob([JSON.stringify({ ...store, settings }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ai-workbench-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      Object.assign(store.saved, data.saved || {});
      Object.assign(store.analysis, data.analysis || {});
      if (data.settings?.keywords) store.settings.keywords = data.settings.keywords;
      saveStore();
      updateSavedCount();
      renderBoard();
      alert(`导入完成：${Object.keys(data.saved || {}).length} 条收藏`);
    } catch (err) {
      alert(`导入失败：${err.message}`);
    }
    e.target.value = '';
  };

  // 设置
  $('#api-key').value = store.settings.apiKey || '';
  $('#save-key').onclick = () => {
    const v = $('#api-key').value.trim();
    if (v) store.settings.apiKey = v;
    else delete store.settings.apiKey;
    saveStore();
    $('#key-msg').textContent = v ? '已保存，回到情报流即可使用「AI 拆解」' : '已清除';
  };
  $('#clear-key').onclick = () => {
    delete store.settings.apiKey;
    $('#api-key').value = '';
    saveStore();
    $('#key-msg').textContent = '已清除';
  };
  $('#keywords').value = (store.settings.keywords || DEFAULT_KEYWORDS).join('\n');
  $('#save-kw').onclick = () => {
    store.settings.keywords = $('#keywords')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);
    saveStore();
    $('#kw-msg').textContent = '已保存，下次「实时刷新」生效';
  };
  $('#wipe').onclick = () => {
    if (!confirm('确定清除这台设备上的全部收藏、笔记和设置吗？此操作不可撤销。')) return;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}
    location.reload();
  };
}

// ------------------------------------------------------------------ 启动

async function main() {
  applyTheme();
  bind();
  updateSavedCount();
  await loadStaticFeed();
  renderStatus();
  renderFeed(true);
  const stale = !feedMeta?.generated_at || Date.now() - new Date(feedMeta.generated_at).getTime() > 6 * 3600 * 1000;
  if (stale || items.size < 20) liveRefresh();
}

main();
