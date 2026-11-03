# my-website

个人主页 + **AI 搞钱工作台**（`workbench/`）。

## AI 搞钱工作台

汇总别人用 AI 赚钱的商业思路、正在做的项目，并提供一个个人看板来收藏、记笔记、跟踪自己的想法。

- **情报流**：来自 Hacker News（Show HN / 讨论 MRR 的帖子）、Reddit（r/SideProject、r/indiehackers、r/SaaS 等）、V2EX（分享创造）、Product Hunt 的 AI 相关内容。
  - 自动分类：💰 赚钱思路 / 🛠 正在做
  - 自动识别帖子里的收入数字（如 `$5k MRR`、`月入 2 万`），折算成「≈$/月」，可按收入排序（启发式识别，未经核实）
  - 按商业模式打标签：SaaS、Agent/自动化、内容/自媒体、服务/外包、电商……
- **我的工作台**：收藏的情报 + 自己的想法，按 灵感 → 验证中 → 在做 → 放弃 推进，每条可写笔记；支持导出 / 导入 JSON 备份。
- **AI 拆解（可选）**：在设置里填自己的 Anthropic API Key，就能让 Claude 把一条帖子拆成：商业模式、目标用户、获客、变现、可复制性、第一步。Key 只存在本机浏览器。

### 数据是怎么更新的

- `.github/workflows/update-feed.yml` 每 6 小时运行 `scripts/fetch_feed.py`，把结果合并写入 `workbench/data/feed.json` 并提交（保留最近 45 天，越用越多）。
- 页面打开时，如果数据超过 6 小时或太少，会在浏览器里直接实时拉取 Hacker News（和 Reddit，如果浏览器能访问）。右上角「实时刷新」可手动触发。

### 第一次使用

1. 把这个分支合并到默认分支。
2. 在仓库 **Settings → Pages** 里开启 GitHub Pages（Source 选默认分支 / root）。
3. 在 **Actions** 页面手动运行一次「更新 AI 赚钱情报」，生成第一批数据（如果仓库的 Actions 写权限被关闭，需要在 **Settings → Actions → General → Workflow permissions** 里改成 *Read and write*）。
4. 打开 `https://<用户名>.github.io/my-website/workbench/`。

本地预览：

```bash
python3 -m http.server 8000
```

然后访问 http://localhost:8000/workbench/ 。

想加新的数据源或关键词：改 `scripts/fetch_feed.py` 顶部的 `HN_QUERIES` / `REDDIT_SUBS` / `V2EX_NODES`；分类和标签规则在 `workbench/app.js` 的 `BUILD_RE` / `MONEY_RE` / `TAG_RULES`。
