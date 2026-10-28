# 变更日志

本文件记录 CMLG Office 的所有对外可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 记录约定

每次改动都在最上方新增一节，不要改写历史条目：

- **新增** — 新功能、新能力。
- **变更** — 已有行为的变化（含默认值、文案、交互）。
- **修复** — 缺陷修复。
- **移除** — 已经下线的能力。
- **安全** — 认证、凭据、权限相关的改动。

条目写"用户能感知到什么"，而不是"改了哪个文件"。每个条目后面用括号标注受影响的范围
（例如 `shell`、`docs`、`sheets`、`打包`），方便回溯。仅在内部可见的重构不单独成条，
合并进它服务的那条变更里。

---

## [未发布]

### 新增

- **平台账号体系**：设置里的账户改为登录「CMLG AI 数字员工平台」
  (`ai-staff.folidaymall.com`)。登录窗捕获平台的 `ultrarag_auth` 会话，用 `/api/auth/me`
  校验后存到 `~/.genoffice/platform.json`，全应用的用户名、邮箱、头像统一取这份资料。
  （`shell`）
- **平台模型只读展示**：设置 › AI 模型 改为登录后从平台拉取的模型列表，只读，不可编辑。
  列表为空时明确提示"当前账号在平台上还没有模型配置"。（`shell`）
- **AI 推理接入平台网关**：推理不再走 Genspark，而是把平台下发的模型配置
  （`base_url` / `model` / `api_protocol` / `temperature` / `max_output_tokens`）
  合成为 `custom` provider 的端点，凭据取自员工在平台申请的 API Key
  （`/api/enterprise/api-key-applications/mine`）。平台的 temperature 通过
  `bodyExtras` 覆盖协议层默认值，`max_output_tokens` 成为该模型的输出上限；
  对采样固定的模型族（GPT-5/6、Gemini 3、Kimi K3）不下发 temperature。
  （`shell` `docs` `ai-provider`）
- **未同步模型时禁用 AI 并给出指引**：平台没有同步到可用模型、没有下发 API Key、
  或用户未登录时，`ai:stream` / `ai:chat` 直接拒绝并返回对应语言的提示，引导去数字员工
  平台配置；此时设置页也不再下发任何可用 provider，避免面板出现无法使用的发送入口。
  提示文案覆盖 22 种语言。（`shell` `docs`）
- **统一的打包入口**：根目录 `npm run dist` 取代原先并列的三条命令，脚本会依次生成
  第三方声明、构建全部 workspace、在打 mac 包时补齐 universal xlsx sidecar，最后调用
  electron-builder。支持 `--target mac|win|linux|all`、`--dir`、`--no-build`、
  `--no-notices`、`--dry-run`，未识别的参数原样透传给 electron-builder
  （例如 `--publish never`）。（`打包`）
- **GitHub Actions 打包流水线**：新增 `.github/workflows/dist.yml`，在 Actions 里手动触发
  （或推 `v*` 标签）就能产出 macOS arm64 + x64 与 Windows 安装包；版本号可由输入框覆盖。
  Electron、electron-builder、cargo 默认走国内镜像（仓库变量 `DIST_MIRROR=off` 可切回官方源），
  Linux 不在该流水线内。（`打包`）
- **一键发布**：`npm run release` 会把最近一次成功的打包 run 的产物下载下来，建成 / 补全对应 tag
  的 GitHub Release 并上传安装包，最后把直链与 `SHA256SUMS.txt` 地址打印出来。支持 `--run`、
  `--tag`、`--draft`、`--dry-run`、`--refresh`、`--keep`。推 `v*` 标签时流水线自动执行这一步，
  并把下载链接写进 run 页面摘要。（`打包`）

### 变更

- 打包产物与安装目录改名为 **CMLG Office**：`.app` / `.exe` 名称、安装路径
  `/opt/CMLG Office`、Linux 可执行名 `cmlg-office`、桌面入口与 MIME 声明的同步名、
  artifact 命名（`CMLG-Office-<v>-<arch>.dmg`、`CMLG-Office-Setup-<v>.exe`、
  `cmlg-office_<v>_amd64.deb`、`cmlg-office-<v>.x86_64.rpm`）以及更新 feed 一并改名。
  （`打包`）
- 默认保存文件夹改为 `CMLGOffice`；升级用户原有的 `GenOffice` 目录会被迁移而不是丢弃。
  （`shell`）
- 界面上的 GenOffice 字样统一改为 CMLG Office，Ribbon 的「Genspark AI」改为
  「CMLG AI」。（全部编辑器）
- 设置里的「集成」和「生图媒体」两节隐藏，不再对外暴露。（`shell`）
- 打包相关的文档与 21 种语言的 README 同步到新的 `npm run dist` 用法。（`文档`）
- 首页左上角的品牌名改为 **CMLGOffice**。图标与品牌名拆成两个元素（图标仍跟随主题反色），
  品牌名变成可编辑文本，以后改名不用重画字形。（`shell`）
- AI 面板标题前的品牌图标移除，六个编辑器只保留标题文字；面板折叠后的侧边小按钮仍保留该图标。
  （`docs` `sheets` `slides` `pdf` `markdown` `html`）
- 六个编辑器的 AI 面板标题统一为 **CMLG AI**（HTML / PDF / Markdown / Excel 此前仍硬编码旧厂商名）。
  （`docs` `sheets` `slides` `pdf` `markdown` `html`）
- 首页文件搜索的语义重排改用 **CMLG AI 数字员工平台**的决策模型
  （`POST /api/v1/decisions/predict`，按登录员工的 `sd_live_*` API Key 计费，无需另配密钥）：
  Jev / TypeSafe / OpenRouter 两条路由移除，历史设置文件里的旧端点自动落到平台；
  平台未下发可用密钥时重排静默跳过并保留本地顺序。端点选项、结果徽标、22 种语言的文案
  与帮助手册、README 同步更新。（`shell` `文档`）

### 修复

- 修复从菜单/右键删除表格列没有反应的问题：命令表此前直接返回了命令工厂函数而不是
  命令本身，点击后不会产生任何改动。同时修正「删除列保留列宽网格」测试里的节点类型
  标注，使该套测试重新纳入类型检查。（`docs`）

### 移除

- 设置 › 关于不再展示「开源项目」一行（仓库地址、Star 数与「去 GitHub 点 Star」按钮）。
  这个构建分发时不指向该仓库，关于页只保留版本、更新通道与自动检查开关。（`shell`）
- 设置里的「关于」整节移除。版本号改由系统菜单的「关于 CMLG Office」查看；更新相关的三项
  （可用更新、更新通道、自动检查更新）移入「通用」底部，功能不变。（`shell`）
- 设置 › 账户不再展示租户 ID。（`shell`）
- 移除匿名使用统计上报（Google Analytics 4）及其全部代码：设置 › 通用里的「发送匿名使用统计」
  开关、引导页的说明、首启事件与上报模块一并删除，打包也不再注入 GA4 凭据。应用不再发送任何
  使用统计，PRIVACY.md、README 及各语言帮助文档同步更新。（`shell` `文档`）
- 设置 › 通用里的「更新通道」与「自动检查更新」两项移除；「有可用更新」入口保留，启动后仍按
  现有配置静默检查。（`shell`）

### 安全

- 平台 API Key 只在主进程内存中缓存，按平台 token 记忆 30 秒；登出、重新登录、平台
  拒绝会话时立即失效，不写入 `ai-settings.json`。仍可用 `CMLG_PLATFORM_API_KEY`
  环境变量显式覆盖（开发与线下发号场景）。（`shell`）

---

## 更早的版本

CMLG 定制开始之前的版本历史在 GenOffice 上游仓库维护，本文件从这次改造开始记录。
