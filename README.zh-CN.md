# AI Homepage · 中文版

[English](./README.md) | **简体中文**

**一个替你读互联网的新标签页。**

AI Homepage 把 Chrome 的新标签页换成一张为你写的主页。Agent 先看你最近实际在读什么，再用你的登录态打开这些页面，最后根据读到的内容写出一张主页。它在后台定时重新生成，所以每次打开新标签页都是新的。

![晨报风格的主页示例](docs/preview.png)
<sub>示意图。你的主页由你自己的浏览记录生成，内容会不同。</sub>

> 本仓库是 [ThariqS/ai-newtab](https://github.com/ThariqS/ai-newtab) 的分支，改了两处：
>
> 1. **默认中文。** 扩展界面是简体中文。Agent 用简体中文写主页，外文标题和摘要会翻译，产品名、代码和股票代码保留原文。你在设置里写的指令可以覆盖这条。
> 2. **断线后构建不再失败。** 走代理或 VPN 时，会话的事件流常在构建中途被掐断，原版每次都以「Agent produced no homepage」或「network error」告终。现在构建会重新接回会话并继续。原理见 [ARCHITECTURE.md](./ARCHITECTURE.md#surviving-a-dropped-stream)。
>
> 其余全部是上游作者的工作。

> **先说隐私。** 生成主页时，扩展会用你自己的 API key，把浏览历史摘要（访问最多的域名、访问次数、少量页面标题）和最多 8 个页面清洗后的 HTML 发给 Anthropic API。这些页面是在你已登录的浏览器里加载的，可能含私人内容。每次构建结束时，agent 会话和所有上传的页面都会被删除。API key 只存在扩展的本地存储里。细节见 [ARCHITECTURE.md](./ARCHITECTURE.md#privacy)。

---

## 安装

需要 Chrome（或其他 Chromium 浏览器）、[Node.js](https://nodejs.org) 20+ 和一个 [Anthropic API key](https://console.anthropic.com)。

```bash
git clone https://github.com/libaoming/ai-newtab-zh.git
cd ai-newtab-zh
npx pnpm@10.11.1 install
npx pnpm@10.11.1 build
```

然后加载进 Chrome：

1. 打开 `chrome://extensions`。
2. 打开右上角的**开发者模式**。
3. 点**加载未打包的扩展程序**，选择 `apps/extension/.output/chrome-mv3`。

Chrome 问「改回 Google？」时，选**保持现状**。

## 第一张主页

1. 打开新标签页，粘贴 Anthropic API key。
2. 点**生成今天的主页**。
3. 进度页会依次走完五步：准备 Agent、读取浏览历史、在浏览器中打开页面、分析页面、撰写主页。

第一次构建要几分钟。构建跑在扩展的后台 worker 里，可以关掉标签页，之后打开任何新标签页都能看到它。

## 改成你想要的样子

点新标签页右上角的 **⚙️ 设置**。

**常驻指令。** 这里写的内容会进入每一次构建，优先级高于 agent 的默认行为。内容和版式都由它决定：

| 你写 | 你得到 |
| --- | --- |
| 「晨报。衬线字体，大报头，一条头条，一栏简讯。」 | 一张报纸头版 |
| 「单栏，不要图片。五条值得读的内容，每条一句理由。」 | 一份阅读清单 |
| 「信息密集的仪表盘：GitHub PR 和 issue 在最前，然后是 Hacker News，再是其他。」 | 一个工作台 |
| 「黑底绿字的终端，等宽字体，像 1980 年代的 BBS。」 | 就是那样 |
| 「不要体育和政治。永远显示天气和我接下来三个日程。」 | 每天都按你的规则来 |
| 「Write everything in English.」 | 英文主页 |

点**保存并重新生成**立即生效。

**Agent 永不读取的站点。** 每行一个域名，自动包含子域名，支持 `*.example.com`。默认清单已含常见的网页邮箱、登录页和文档站点，可以编辑。屏蔽同时作用于历史摘要和 `getPageHtml` 请求的 URL。页面重定向到被屏蔽的域名时，内容在上传前就被丢弃。本地网络地址（localhost、内网 IP、`.local` 和 `.internal`）永远被屏蔽。

国内用户建议第一次构建前加上：券商和网银、飞书、钉钉、企业微信后台等。

**模型。** 选择由哪个 Claude 模型写主页：

- **Claude Sonnet 5.5**（默认）：质量和成本的平衡点。
- **Claude Haiku 5.5**：最快、最便宜。
- **Claude Opus 5.5**：编辑最细，也最贵。

新模型从下一次构建起生效。

**自动重新生成。** 默认开启。主页超过你选的间隔（6、12、24 或 48 小时）后，扩展在后台重新生成。它只在你手动生成过一次之后才启动。失败的构建要等到下一个间隔才重试，所以不会循环。

右上角的 **↻ 重新生成** 立即重建。

## 需要知道的事

- **费用。** 每次构建是一个 agent 会话，计入你的 API key。费用取决于模型和它读了多少内容。Haiku 最便宜；也可以关掉自动重新生成，只在需要时手动构建。
- **它能看到什么。** 它给历史里的站点排名，每次构建最多打开 8 个。它会跳过搜索引擎、网页邮箱、网银和未登录的营销页。打不开的页面会被如实报告。
- **链接都是真的。** 主页上每个链接都来自 agent 实际读过的页面。它被要求不得编造 URL。
- **构建被中断。** Chrome 在构建中途关闭后，下次打开新标签页会出现**继续被中断的构建**。
- **连接被掐断。** 与 API 的连接在构建中途断开时，活动日志会显示 `stream dropped; reconnecting (n/8)`，构建继续。只有连续 8 次断开且毫无进展时才放弃。
- **更新。** 拉取新代码后重新执行 `npx pnpm@10.11.1 build`，再到 `chrome://extensions` 点扩展卡片上的刷新图标。

## 工作原理

没有服务器。扩展的后台 worker 直接驱动一个 [Claude Managed Agents](https://docs.claude.com) 会话。

```
扩展 service worker                Anthropic agent              沙箱
     │ 创建会话，打开事件流 ───────────▶│                         │
     │ 发送「生成今天的主页」──────────▶│                         │
     │◀── 请求工具 getHistory ─────────┤                         │
     │ 读 chrome.history，按域名聚合排名                           │
     │ 回传历史摘要 ──────────────────▶│                         │
     │◀── 请求工具 getPageHtml（≤8 个 URL）┤                      │
     │ 开一个不抢焦点的窗口，用你的登录态加载页面                    │
     │ 清洗 HTML → 上传 → 挂载 ───────────────────────────────▶ /mnt/session/uploads/pages/*.html
     │ 回传挂载路径 ──────────────────▶│                         │
     │                                 ├── grep / read ─────────▶│
     │                                 ├── write homepage.tsx ──▶│
     │◀── 会话空闲（end_turn）─────────┤                         │
     │ 下载 homepage.tsx，在沙箱 iframe 里渲染                     │
     │ 删除会话和所有上传文件                                      │
```

1. **`getHistory`**：agent 拿到你访问最多的域名的排名摘要。
2. **`getPageHtml`**：它挑最多 8 个页面。扩展在后台窗口打开、清洗，再以文件形式挂进 agent 的沙箱。
3. **`grep` / `read`**：agent 在沙箱里从这些文件中提取标题、帖子和链接。
4. **`write`**：它写出一个 React 组件，由新标签页渲染。

两个自定义工具在扩展里执行，因为它们需要 `chrome.history` 和 `chrome.tabs`。其余都发生在 agent 的沙箱里。沙箱关闭了 shell：抓来的页面是不可信输入。

事件流、目录结构和踩过的坑见 **[ARCHITECTURE.md](./ARCHITECTURE.md)**（英文）。

## 开发

```
packages/agent-core   agent 循环：与宿主无关，不引用 chrome.* 或 node:*
apps/extension        MV3 扩展（WXT + React）
harness               Bun 脚本：在 Chrome 外运行 agent-core，并测试构建出的扩展
```

```bash
pnpm dev                 # WXT 热重载
pnpm typecheck           # 全部包
pnpm test                # 单元测试（不调 API；需要 Bun）
pnpm extension:test      # 把构建出的扩展加载进无头 Chrome（不调 API）

cp .env.example .env     # 填入 ANTHROPIC_API_KEY，然后：
pnpm agent:run           # 用样例历史对真实 API 跑一次完整构建
pnpm agent:verify        # 检查产物确实能渲染
```

## 状态

早期实验项目。它是一个你用自己的 key 自己运行的工具。不要原样发布到应用商店：任何能访问浏览器配置目录的人都能读到存储的 API key。

## 许可证

MIT。原始作品版权归上游作者所有，见 [LICENSE](./LICENSE)。
