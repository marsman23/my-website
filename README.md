# my-website

个人主页 + **搞钱情报工作台**（`workbench/`）。

## 搞钱情报工作台

汇总最新的商业机会、别人怎么赚钱、正在做的项目（不限行业，AI 只是其中一个标签），并提供一个个人看板来收藏、记笔记、跟踪自己的想法。

- **情报流**：来自以下来源的内容，默认只显示「精选」（参考价值 ≥ 3 星），按价值排序。
  - **HN 讨论帖评论**（最有价值）：「你的副业赚多少钱」「What are you working on」等讨论帖里，创业者亲自讲自己在做什么、赚多少
  - Hacker News（热门 Show HN、讨论 MRR / 出售项目 / 商业点子的帖子）、Reddit（r/EntrepreneurRideAlong、r/smallbusiness、r/SideProject、r/Business_Ideas 等）、V2EX（分享创造 / 创业）、Product Hunt
  - 自动分类：💰 赚钱思路 / 🛠 正在做
  - 自动识别帖子里的收入数字（如 `$5k MRR`、`月入 2 万`），折算成「≈$/月」，可按收入排序（启发式识别，未经核实）
  - 按行业 / 商业模式打标签：AI、SaaS、内容/自媒体、服务/外包、电商、本地/线下生意、收购/出售项目、社区/会员……
- **我的工作台**：收藏的情报 + 自己的想法，按 灵感 → 验证中 → 在做 → 放弃 推进，每条可写笔记；支持导出 / 导入 JSON 备份。
- **AI 拆解（可选）**：在设置里填自己的 Anthropic API Key，就能让 Claude 把一条帖子拆成：商业模式、目标用户、获客、变现、可复制性、第一步。Key 只存在本机浏览器。

### 让内容更有价值（可选配置）

在仓库 **Settings → Secrets and variables → Actions** 里添加：

| Secret | 作用 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 定时任务用 Claude 给每条新内容打 1–5 分、判断是不是真实案例，并提炼中文标题、摘要、商业模式、目标用户、获客、收入、启发。默认模型 `claude-opus-5-5`，每次运行最多处理 40 条（已处理的不会重复）。 |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | 走 Reddit 官方 API。Reddit 经常屏蔽 GitHub 服务器的匿名请求，配置后更稳定。在 https://www.reddit.com/prefs/apps 创建一个 *script* 类型的应用即可免费获得。 |

还可以在同一页面的 **Variables** 里设置 `AI_MODEL`（换模型，例如更便宜的 `claude-haiku-5-5`）和 `AI_MAX_ITEMS`（每次最多精炼多少条）。

### 数据是怎么更新的

- `.github/workflows/update-feed.yml` 每 6 小时运行 `scripts/fetch_feed.py`，把结果合并写入 `workbench/data/feed.json` 并提交（普通帖子保留 45 天，讨论帖评论和高价值内容保留 400 天）。
- 页面打开时，如果数据超过 6 小时或太少，会在浏览器里直接实时拉取 Hacker News（和 Reddit，如果浏览器能访问）。右上角「实时刷新」可手动触发。

### 第一次使用

1. 把这个分支合并到默认分支。
2. 在仓库 **Settings → Pages** 里开启 GitHub Pages（Source 选默认分支 / root）。
3. 在 **Actions** 页面手动运行一次「更新搞钱情报」，生成第一批数据（如果仓库的 Actions 写权限被关闭，需要在 **Settings → Actions → General → Workflow permissions** 里改成 *Read and write*）。
4. 打开 `https://<用户名>.github.io/my-website/workbench/`。

本地预览：

```bash
python3 -m http.server 8000
```

然后访问 http://localhost:8000/workbench/ 。

想加新的数据源或关键词：改 `scripts/fetch_feed.py` 顶部的 `HN_QUERIES` / `HN_THREADS` / `REDDIT_SUBS` / `V2EX_NODES`；分类和标签规则在 `workbench/app.js` 的 `BUILD_RE` / `MONEY_RE` / `TAG_RULES`。
