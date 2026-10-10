# Atrium Grove

本机跨 Harness 协作工作室：React WebUI、Fastify 控制面、独立 Host、SQLite、Codex App Server、Claude Agent SDK 和受资格门禁保护的 LCU 桌面网关。

**当前是可运行的开发版本，尚未达到 Spec 1.0 完整验收。** 已通过五个真实会话的双回合记忆，以及两个 Harness 的关闭后恢复、中断。真实人工工具审批、双 Harness 桌面操作和完整 CSV 场景仍待完成。规格及计划见 [开发准备度](docs/DEVELOPMENT_READINESS.md) 和 [逐项验收](docs/reports/acceptance-matrix.json)。逐项验收文件是历史计划，不代表当前全部测试结果。

产品名称为 **Atrium Grove**，仓库名为 **AtriumGrove**。状态目录 `~/.harbor`、`HARBOR_*` 环境变量及 MCP 标识沿用原协议；公开版 macOS 服务名为 `org.atriumgrove.harbor.*`。CLI 使用 `pnpm atrium-grove`，旧的 `pnpm harbor` 仍可用。

此公开副本包含导出时的源码、规格和测试；不携带原 Git 历史、本机状态、认证配置、原生会话、日志或截图。原生验收报告需在自己的环境中重新生成，历史测试结论不代表本机已获得资格。

## 快速演示

需要 Git 和 npm；项目固定 Node 24.21.0、pnpm 11.19.0。演示和 CI 不需要登录原生 CLI。

```sh
sh scripts/bootstrap.sh
export PATH="$PWD/.tools/runtime/node_modules/.bin:$PATH"
pnpm preview
```

命令创建专用临时 Git 仓库并启动控制面与 fake Host，打印 loopback 地址和有效期五分钟的一次性登录码。登录后在对话中选择参与成员即可发消息并查看轨迹。回答有 `[FAKE RUNTIME]` 标识，不会调用模型。

## 真实运行

预先安装并登录 Codex、Claude CLI。在两个终端中使用同一个状态目录：

```sh
pnpm atrium-grove init --state .tools/harbor-local --port 4317
pnpm atrium-grove serve --state .tools/harbor-local --port 4317
# 另一个终端，同样先设置上面的 PATH
pnpm atrium-grove host start --state .tools/harbor-local
```

打开 `http://127.0.0.1:4317`，输入 `init` 打印的登录码。过期后执行 `pnpm atrium-grove login-token --state .tools/harbor-local`。在侧边栏创建项目，选择本机工作目录，再进入「成员 → 创建成员」配置名称、Harness、模型、职责与权限。目录默认不要求 Git，仅勾选 Git 工作时检查或初始化仓库并使用 worktree。

成员是可复用配置，没有全局启动开关。新建对话时勾选参与成员，之后通过对话顶部「参与者」调整；只有收到待回复消息时才自动连接模型。参与者使用各自配置的工作目录。取消参与会撤销本对话未开始的消息，当前一轮继续完成，其他对话不受影响；立即中断在具体运行中操作。空闲时可编辑成员配置，下一轮自动应用。

`default` 使用本机 CLI 默认模型。本机已实测 Codex 0.157.1 / gpt-6-astra、Claude Code 2.1.205 / claude-opus-5-5。该记录不代表其他机器或升级后的组件自动获得资格。

## 局域网访问与密码登录

局域网地址示例为 `http://atrium-grove.local:4317`，请替换为自己机器可解析的名称；状态目录默认为 `~/.harbor`。密码不写入源码、前端产物或文档。

需要重新配置时，从标准输入提供密码（终端输入时关闭回显），避免把密码放在命令参数里：

```sh
pnpm atrium-grove access --state ~/.harbor --public-url http://atrium-grove.local:4317 --password-stdin
pnpm atrium-grove serve --state ~/.harbor --port 4317
# 在另一个终端启动执行主机
pnpm atrium-grove host start --state ~/.harbor
```

`access.json` 保存带随机盐的 scrypt 密码哈希，权限为 0600。配置后撤销旧会话并重启控制面。服务显式监听所有 IPv4 网卡，只接受配置的 hostname:port 和 loopback；同源校验、CSRF、HttpOnly 会话以及登录限流保持启用。未配置访问地址的实例仍仅监听 loopback。当前地址使用 HTTP；同一局域网的设备须能解析 Bonjour/mDNS `.local` 名称。

前端按 Ochrelune 设计统一重做，覆盖聊天、任务、运行、审批、记忆、主机、登录和成员配置；只使用本地 SVG 与系统字体。窄屏使用可展开导航。

## 界面语言

侧边栏工作台保留成员、任务和审批；左下角 Settings 集中提供通用设置（语言、站点信息、登出）、项目设置、共享记忆、运行记录与执行电脑。

WebUI 支持简体中文、繁體中文和 English，默认按浏览器首选语言列表选择；`zh-TW`、`zh-HK`、`zh-MO` 使用繁体中文，未支持的语言回退到英语。可在「Settings → 通用」或登录页切换语言，选择保存在当前浏览器；选回「跟随浏览器」即恢复自动选择。切换即时生效，保留正在输入的草稿。聊天内容、目录名称、文件路径和模型原始输出保持原文。

空白首页的输入框上方会从三句简短标题中随机选择一句，新建对话时更新，输入过程中不变。翻译词典位于 `apps/web/src/locales/`，新增界面文案需同步更新三个词典；`tests/i18n.test.ts` 检查语言匹配、词条完整性、插值参数和未翻译的界面文字。

## 验证

```sh
pnpm check
pnpm test:report > docs/reports/automated-tests.tap
pnpm qualify:continuity       # 真实五会话，会消耗模型用量
pnpm qualify:tools            # 遇到人工审批会停止并报告
# 跨进程恢复验收需要显式保留上一阶段数据；生命周期验收结束后自动清理。
pnpm qualify:continuity --keep-state
pnpm exec tsx scripts/qualify-lifecycle.ts
```

测试目录集中在系统临时目录下的 `harbor-tests-*`，退出时自动删除；真实 Codex 验收结束后归档本次测试会话。只有显式传入 `--keep-state` 才保留目录供后续验收使用。新生成的测试报告保存在 `docs/reports`，默认不纳入 Git。

规格生成和校验：

```sh
python3 -m venv .venv-spec
.venv-spec/bin/python -m pip install jsonschema==4.23.0 PyYAML==6.0.2
PATH="$PWD/node_modules/.bin:$PATH" .venv-spec/bin/python scripts/sync_spec.py
PATH="$PWD/node_modules/.bin:$PATH" .venv-spec/bin/python scripts/audit_spec.py
pnpm generate
```

原始规格基线保存在 Git。修订见 [ADR 0001](docs/adr/0001-contract-completion.md)。规格检查不等于真实产品验收。

## 结构与运维

- `apps/control`：认证、51 个 HTTP 操作、事件 replay、调度、审批与恢复。
- `apps/host`：认证 WebSocket、命令收据、事件 spool、进程身份和私有 UDS relay。
- `apps/web`：聊天、定向通知、任务、轨迹、审批、记忆、主机及初始化界面。
- `packages/runtime-*`：真实驱动、锁定 schema 和确定性测试进程。
- `packages/persistence`、`artifacts`：独立数据库、迁移、备份恢复和不可变工件。
- `packages/computer-*`：LCU 原版 client 与独占桌面租约；未通过资格门禁时不开放桌面。

```sh
pnpm atrium-grove doctor --state .tools/harbor-local
pnpm atrium-grove team import spec/examples/team.yaml --vars /absolute/path/vars.json --dry-run
pnpm atrium-grove backup /absolute/path/new-backup --state .tools/harbor-local
pnpm atrium-grove restore /absolute/path/new-backup --state /absolute/path/new-state
pnpm atrium-grove export-run RUN_UUID --state .tools/harbor-local
```

恢复只写新目录，校验哈希后撤销旧登录和 Host 凭据；未结束工作保留 `unknown`，不自动重放。详见 [运维说明](docs/OPERATIONS.md)、[依赖说明](THIRD_PARTY_NOTICES.md) 与 [完整规格](spec/PROJECT_SPEC.md)。

工作区设置中的「暂停新执行」阻止新的会话和消息执行，当前运行继续，任务分配不变。成员的「本轮后暂停」只暂停后续执行；「停止成员」会请求关闭原生进程并等待资源清理。目录浏览指 Atrium Grove 服务所在电脑，当前要求选择有提交记录的 Git 仓库根目录。

### 工作目录模式

默认直接使用选中的文件夹，不需要 Git；已有 `.git` 或父级仓库也不会自动启用 Git 模式。多个成员共享该目录，Atrium Grove 不提供文件互斥锁。用户可在“工作区设置 → 工作目录 → 设置”切换工作方式（先停止该目录的成员）。

勾选“Git 工作模式”后才查找关联仓库并使用独立 worktree。没有仓库或首个提交时，可显式点击“初始化 Git 并创建首次提交”；这会提交未被 `.gitignore` 忽略的当前文件，不推送远端。已有仓库未提交的文件不会自动复制到 worktree。旧绑定继续使用已有 worktree；切换模式保留旧工作副本，模型会话重新开始。CLI team 配置通过 `project.workspaceMode: directory | git-worktree` 选择，省略为 directory。

侧边栏按「项目 → 对话」展示，可折叠项目、在项目行新建对话，或直接切换其他项目的对话。原 workspace 数据在界面中统一称为项目，成员和任务仍按所属项目管理；工作目录是项目内的目录绑定。成员协作权限使用带中文说明的勾选项。正常连接状态不占用页面，短暂中断静默重试，持续故障或登录过期才显示提示。
