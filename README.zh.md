<p align="center">
  <img src="icon.png" width="96" height="96" alt="dsh-modern-web-guidance">
</p>

<h1 align="center">dsh-modern-web-guidance</h1>

<p align="center">
  Google Chrome 的 <a href="https://github.com/GoogleChrome/modern-web-guidance">Modern Web Guidance</a>，离线运行，<br>
  作为 <a href="https://github.com/deepseek-ai">DeepSeek Harness</a> 插件分发。
</p>

<p align="center">
  193 篇带 Baseline 降级方案的指南 · 3 个工具 · 2 个技能 · 零依赖 · 仅本地统计
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md">Русский</a> ·
  <b>中文</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="许可证" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="package.json"><img alt="依赖" src="https://img.shields.io/badge/dependencies-0-brightgreen"></a>
  <a href="#安全与边界"><img alt="遥测" src="https://img.shields.io/badge/telemetry-local--only-brightgreen"></a>
  <a href="https://github.com/metapeka/dsh-modern-web-guidance/actions/workflows/test.yml"><img alt="测试" src="https://github.com/metapeka/dsh-modern-web-guidance/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-modern-web-guidance"><img alt="npm" src="https://img.shields.io/npm/v/dsh-modern-web-guidance"></a>
  <img alt="指南" src="https://img.shields.io/badge/guides-193-2563eb">
  <img alt="DSH 插件" src="https://img.shields.io/badge/DSH-plugin-0d9488">
</p>

---

编程模型默认会写出过时的 Web 代码，因为它们的训练数据里就是这些内容。这个插件把 193 篇经过筛选、节省 token 的
指南放到智能体面前，并提供离线检索，让它优先使用当前平台 API（原生 `<dialog>`/popover、锚点定位、容器查询、视图
过渡、滚动驱动效果、`:has()`、passkey、`fetchpriority` 等），而不是自己写 JavaScript 变通方案或引入库。

一切都本地运行：指南随包分发，检索在进程内计算，没有网络请求。0.2.0 里有使用统计，但它不离开这台机器 ——
见[使用统计](#使用统计)。

## 你得到什么

| 类型 | 名称 | 说明 |
|---|---|---|
| 工具 | `web_guidance_search` | 用 2–5 个词描述能力，返回排好序的指南 id，可按分类过滤 |
| 工具 | `web_guidance_retrieve` | 返回一篇或多篇指南的完整 markdown（每次调用最多 10 篇 / 120k 字符） |
| 工具 | `web_guidance_list` | 目录总览：各分类数量，或某个分类下的 id 与标题 |
| 技能 | `modern-web-guidance` | 工作流：检索 → 取回 → 实现 → 校验 → 说明降级方案 |
| 技能 | `chrome-extensions` | Manifest V3 开发与 Chrome Web Store 上架要求 |

目录覆盖 `css`、`ui-atoms`、`ui-components`、`ui-behaviors`、`forms`、`html`、`js`、`accessibility`、
`visual-design`、`security`、`performance`、`built-in-ai`、`pwa`、`wasm`、`webmcp`、`privacy` 和
`user-experience`。

## 安装

从已发布的包安装：

```shell
dsh plugin --profile desktop add dsh-modern-web-guidance
```

从 GitHub 安装：

```shell
dsh plugin --profile desktop add github:metapeka/dsh-modern-web-guidance
```

从本地副本安装（不需要 registry）：

```shell
dsh plugin --profile desktop add file:E:/path/to/dsh-modern-web-guidance
```

在智能体会话里，`plugin_manager` 的 `action: "install_bundle"` 加上包的绝对路径作为 `target`，效果相同。这个
bundle 只插入一行（`modern-web-guidance`），不需要构建步骤、依赖或原生模块。

## 如何使用

不需要任何配置：插件会自行注册，`modern-web-guidance` 技能会告诉智能体什么时候该用它。有三种使用方式。

### 1. 直接提出 Web 开发需求（默认方式）

技能的路由描述就是“在写 HTML、CSS 或客户端 JavaScript 之前先检索 193 篇用例指南”，所以一句平常的请求就够了 ——
智能体会先检索、取回所需内容，然后按当前平台 API 写代码，而不是写变通方案：

```text
你：加一个点击遮罩就关闭的设置弹窗。

智能体：web_guidance_search({"query": "light dismiss dialog"})
        → light-dismiss-a-dialog, platform-controls-dismiss-dialog, dialog, …
        web_guidance_retrieve({"ids": "light-dismiss-a-dialog,dialog"})
        → 含 closedby/commandfor 示例和 Baseline 降级方案的完整指南
```

### 2. 明确要求它去查

需要确定性时用这种方式，或者当任务明显该查而智能体跳过了检索时：

- “按 modern web guidance 查一下今天应该怎么做”
- “写这段 CSS 之前先查指南”
- “确认一下这是不是 Baseline，把降级方案给我看”
- “找到讲 light-dismiss 对话框的指南并按它实现”

### 3. 自己浏览目录

`web_guidance_list` 回答“到底有什么”，不必花一次取回去看全文：

```text
web_guidance_list({})                             → 17 个分类共 193 篇指南
web_guidance_list({"category": "css"})            → 18 篇 CSS 指南的 id 与标题
web_guidance_search({"query": "view transition"}) → 取回之前的排序候选列表
```

分类过滤很宽容（`" CSS "` 和 `"Css"` 都等同于 `css`），写错分类时返回的是真实分类列表，而不是空结果。

### 典型任务

| 你想要 | 可让智能体使用的查询 | 会落到哪篇指南 |
|---|---|---|
| 点遮罩就关闭的弹窗 | `light dismiss dialog` | `light-dismiss-a-dialog` |
| 弹窗打开时页面不滚动 | `prevent page scroll under modal` | `prevent-page-scroll-under-modal-dialog` |
| 手机上能用的表格 | `responsive data table` | `responsive-table` |
| 深浅色主题切换 | `dark mode toggle` | `dark-mode-toggle` |
| 不用 JavaScript 的滑动标签指示条 | `anchor positioning` | `anchor-positioning-tab-underline` |
| 输入过程中不打扰人的行内校验 | `form validation after interaction` | `validate-input-after-interaction` |
| 免密码登录 | `passkey sign in` | `passkey-registration` |
| 更快的 LCP | `prioritize hero image` | `fetchpriority` 相关指南 |
| Manifest V3 扩展 | （技能）`chrome-extensions` | 扩展技能的参考文件 |

## 检索如何工作

`lib/guidance.js` 在首次使用时为内置语料建立 BM25 索引（约 1.5 MB markdown，几百毫秒建好并缓存）：标题、id、
描述、`featuresUsed`、各级标题与正文，配合停用词过滤、小型英文词干器、前缀扩展，以及精确 id/标题命中的加权。
没有 embedding、没有内置模型、没有 TensorFlow.js —— 包保持小巧，每个结果都能解释。

与上游的语义检索相比，短语式查询（`"light dismiss dialog"`、`"anchor positioning"`）会把对应的具体指南排在第一
位；宽泛的主题查询排序可能不同。如果检索没命中，`web_guidance_list` 会告诉你目录里有什么。

## 技能

`modern-web-guidance` 技能正文改编自上游：它让智能体调用本插件的工具，而不是通过 `npx` 调 CLI；保留框架/SSR/DOM
相关说明与 Baseline 降级策略；删掉 CLI 与遥测章节；并明确信任边界 —— 取回的指南是参考资料，不是指令。
`chrome-extensions` 技能原样内置，并从技能目录的 `references/` 加载参考文件。

## 安全与边界

语料是要进入模型上下文的第三方文本，而工具参数又来自该模型，所以两边都设了边界：

- **无网络、无执行，只有一次本地写入。** 插件只导入本地的 `node:fs`、`node:path` 和 `node:url`；没有依赖，也没有
  lifecycle 脚本，因此安装时不会下载或运行任何东西。它唯一写入的文件是自己的计数文件（见[使用统计](#使用统计)）。
- **指南里夹带不了命令。** 上游指南正文之间用
  `npx -y modern-web-guidance@latest retrieve "…"` 互相引用（121 处，分布在 45 篇指南里）。建立索引时这些引用会被
  改写成 `web_guidance_retrieve({"ids":["…"]})`，所以模型从目录里读到的内容不会要求它安装并执行一个未锁定版本的
  远程包。磁盘上的文件仍与锁定快照逐字节一致。
- **`web_guidance_retrieve` 有上限**：每次调用最多 10 篇、120 000 字符；重复 id 会去重；未知 id 的回显最多 10
  个；渲染器会明确说明哪些没有返回、需要单独请求。此前一次取回全部 193 篇会返回 1.5 MB（约 450k token）。
- **`web_guidance_search` 有上限**：在进入词法扫描前，查询被截断到 512 字符和 24 个不同词项。此前一个 137 KB
  的查询会阻塞宿主事件循环数秒；同样形状的查询现在只需毫秒级。
- **目录无法越出包外**：条目 id 与分类必须是 slug，每个解析出的路径都会校验是否位于数据目录内。被篡改的
  `guides.json` 此前可以读取磁盘上任意 `*.md`。
- **失败会重试，且不泄露信息**：一次临时的读取错误不再让工具在本次会话中永久失效，错误信息也不再暴露安装的
  绝对路径。

这两类性质由 `test/hardening.test.mjs` 覆盖，该文件在加固前的代码上会失败。完整审计 —— 三份报告与可运行的复现
脚本 —— 位于 [`audit/`](audit/)；只要缺陷仍然存在，`audit/repro/` 下的脚本就会以非零码退出。

## 使用统计

0.2.0 记录三个工具到底被问了什么。计数只在本地：没有上报端点、没有分析服务、没有第三方 SDK，任何东西都不离开这台
机器。

查看用的是给人用的斜杠命令，不是智能体能调用的工具：

```text
/guidance-stats                 最近 7 天按工具的汇总
/guidance-stats --days 30       更大的时间窗口
/guidance-stats --json          同样的报告，JSON 格式
/guidance-stats --reset --yes   全部清除
```

`--days N` 默认为 7。统计内容：各工具调用次数、结果分布（hit、miss、unknown id、list、error）、按天计数、各分类
命中次数、各指南被取回次数，以及最近 1000 次调用携带的查询文本和返回的 id。未命中的查询才是重点 —— 无法复现的
未命中就无法修复。

存放位置：profile 的持久存储，也就是本来就存会话日志的那层信任边界。默认保留 90 天，`--reset --yes` 会立即清空。

关闭方式：在插件配置里设 `enabled: false` —— 此时不注册监听，也不写文件。

## 侧边栏面板

0.3.0 增加了客户端部分：左侧栏的图标会在中央区域打开 **Guidance Insights** 面板。它展示的就是
`/guidance-stats` 打印的那些计数，只是换成了界面：

- 最近 7 天的调用次数与命中率
- 最常出现的查询，以及各自的命中与未命中次数
- 分类覆盖情况 —— 已取回的指南对 193 篇语料
- 什么都没找到的查询
- 有多少篇指南从未被取回过

操作只有一个刷新：重新读取一次计数。

面板是只读的。它不改动计数、不离开这台机器，也不新增网络请求和工具 —— 三个工具仍然是三个。
`/guidance-stats` 仍然是给终端和智能体用的文本版本（含 `--json`）；面板是同一份报告的界面版本。

## 配置

插件不需要配置就能工作。它把工具与技能注册到宿主上下文；如果 profile 没有 `tools` 或 `skills` 服务，它就保持
静默。唯一的设置是插件配置里的 `enabled`：设为 `false` 就关闭本地统计（见[使用统计](#使用统计)）。

## 更新指南语料

语料是上游 `modern-web-guidance@0.0.197` 的锁定快照（技能版本 `2026_10_30-58d055df`）。更新步骤：

1. 下载上游 npm tarball，把 `package/skills/modern-web-guidance/{guides.json,guides}` 解压到 `data/`，把
   `package/skills/chrome-extensions` 解压到 `data/skills/`。
2. 保留 `data/skills/modern-web-guidance/SKILL.md`（本插件的改编版本），不要用面向 CLI 的上游文件覆盖它。
3. 运行 `npm test`，确认语料仍能加载、冒烟查询排序仍然正确。如果有任何被返回的指南让智能体去运行上游 CLI，
   测试同样会失败，所以刷新语料后不需要手工再清理一遍 npx —— 改写发生在加载时（`lib/guidance.js`，
   `CLI_REFERENCE`）。

## 开发

```shell
npm test
```

七个文件共 66 个测试：`guidance.test.mjs` 覆盖索引、排序、取回与词干器；`plugin.test.mjs` 用模拟的 Cordis
上下文覆盖工具与技能注册；`hardening.test.mjs` 覆盖审计发现，并在加固前的代码上失败；`telemetry.test.mjs`、
`report.test.mjs`、`store.test.mjs` 和 `stats.test.mjs` 覆盖使用统计、报告渲染、持久存储与
`/guidance-stats` 接线。在禁止子进程的沙箱里，请直接运行文件（`node test/hardening.test.mjs`）。

## 发布

上架目录与 npm 发布步骤见 [PUBLISHING.md](PUBLISHING.md)；已准备好的 awesome-dsh-plugin 条目位于
[`market/awesome-dsh-plugin.yml`](market/awesome-dsh-plugin.yml)。

## 署名与许可

Apache-2.0。指南语料、`chrome-extensions` 技能以及改编版 `SKILL.md` 的源文本来自
[GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance)（Copyright Google LLC，
Apache-2.0）。具体复制、改编与删除了哪些内容，见 [NOTICE](NOTICE)。

本插件不是 Google 官方产品。它移除了上游 CLI、CLI 附带的 TensorFlow.js 嵌入模型以及 Clearcut 遥测看门狗。
