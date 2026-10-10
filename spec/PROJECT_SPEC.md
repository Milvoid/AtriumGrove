# Atrium Grove：跨 Harness 多 Agent 协作平台 — 完整实施 Spec

**v1.0.0 · 2026-10-09**

目标：3个Codex CLI会话 + 2个Claude Code会话，通过WebUI聊天室持续协作，并复用Codex Computer Use。

本文件依次收录产品与系统规格、详细协议、源码调研、验收清单及工程任务。机器可读OpenAPI、JSON Schema、TypeScript接口、SQLite初始迁移、五Agent配置、Prompt模板和校验脚本在配套规格包中。它是一份完整实施设计，不是已经运行的应用；真实Harness与桌面能力必须完成Q0–Q4实机验证。

## 阅读目录

- 第一部分：产品目标、架构决策、运行语义与WebUI。
- 第二部分：协议、调度事务、原生驱动、审批与恢复算法。
- 第三部分：源码证据、参考版本和许可证边界。
- 第四部分：产品、故障注入与实机验收。
- 第五部分：可分派的工程任务。

---

# 第一部分：项目规格

# Atrium Grove 1.0 — 跨 Harness 多 Agent 协作平台完整项目规格

**版本：1.0.0；基准日：2026-10-09；状态：Implementation-ready design，尚未实机验收。**

本规格以用户的五会话协作场景为交付目标：三个 Codex CLI 实例、两个 Claude Code CLI 实例作为持久参与者，在 WebUI 中与人类共同使用频道、讨论线程、任务和工件；拥有权限的 Agent 通过统一工具网关使用本机安装的 Codex Computer Use。Raft 是主要架构参考，不是必须部署的上游服务。

本文的“必须”是开发与验收约束；“默认”是已经替开发者做出的选择，不是待定建议。上游源码事实使用 [Rxx] 标识，详见 RESEARCH.md 和 sources.json。设计要求不是对上游能力已经实机验证的声明。

## 1. 产品定义与交付边界

### 1.1 用户实际得到什么

用户在 WebUI 创建一个 workspace，连接自己的 Mac，选择一个本地 Git 项目，配置五位 Agent 的角色、原生模型与权限，然后在 `#general` 发言。用户可以选择“通知全组”、指定两个 Agent，或者仅记下一条不要求回复的更新。

Agent 可以阅读同一讨论线程，主动提出方案，向另一位 Agent 发出问题，领取任务、发布代码提交和测试结果，并在对方返回时继续处理。全过程有持久记录，浏览器关掉不结束工作。用户能查看每位 Agent 正在执行什么、有哪些输入仍在排队、哪一项授权待处理、哪一位持有桌面控制权，也能暂停整个 workspace 或中断单次运行。

**平台组织的是五个真实 Harness 会话，不是一个模型用五段角色 Prompt 模拟的五个人。** 各 Harness 保有自己的模型调用、工具循环、压缩和原生上下文管理；平台拥有协作身份、消息、工作分配、权限投影和生命周期协调。

### 1.2 v1 必须包括

| 域 | v1 的完整交付 |
|---|---|
| 人类界面 | WebUI、频道和线程、@收件人、附件、流式进度、任务看板、审批中心、Host/桌面状态 |
| Harness | 3 个 Codex + 2 个 Claude Code 可同时进行独立任务；持续会话、恢复、中断、原生错误可见 |
| Agent 协作 | 持久 inbox、明确收件人、异步问答、任务独占领取、共享工件和记忆提案 |
| 持久性 | 控制面重启后恢复投递；Host 事件重放去重；不确定执行进入 UNKNOWN 而非盲目重试 |
| Computer Use | 本机 LCU 提供者接入、原版指令/工具透传、WebUI 应用授权、独占控制、清理确认和隔离故障 |
| 工程性 | OpenAPI、统一 Runtime 契约、版本迁移、脚本化假 Harness、真实兼容门禁、可导出诊断 |

v1 不包括：不可信租户隔离、面向公众的账号系统、私密频道/DM、移动 App、云端原生 Harness 托管、自动购买额度、共享模型隐含推理状态、Desktop 已有聊天会话接管、OpenCLI/CDP 自动填写聊天框、自动批准 OS 权限、Windows/Linux 桌面正式支持。预留 provider 和 host 边界，不提前实现这些功能。

### 1.3 工作环境假设

初始环境为**一名可信人类、单台 macOS Apple Silicon、本地磁盘、已安装且可以合法使用的两个原生 Harness**。一个 control-plane 进程管理一个或多个 workspace，但一个 Agent 只能归属一个 workspace。v1 只验收一台 Host；协议可以扩展多机，不声称已具备分布式租户隔离。

原生登录由本机 Harness 自己完成。WebUI 仅显示登录是否可用及需要用户在本机完成的操作，不收集或转发供应商访问令牌。订阅/SDK/商业分发的授权范围不从“二进制可调用”推导；公开服务化前重新审核上游条款。[R06,R18]

## 2. 固定架构决策

| 决策 | 固定选择 | 原因及后果 |
|---|---|---|
| 控制面 | TypeScript + Node 24、Fastify、单实例 | 一份事务协调消息、任务、事件和命令；不增加微服务运维负担 |
| WebUI | React + Vite，REST + SSE；TanStack Query 管服务器状态 | 长任务不绑定 HTTP 请求；页面重开可重放 |
| 数据库 | 本地 SQLite WAL，单写入所有者，`synchronous=FULL` | 五 Agent 目标不需要 Redis/Postgres；本地磁盘而非网络盘 [R15] |
| Host | 独立 Node 24 `hostd`，本地 SQLite 日志；向控制面发起 WebSocket | CLI 进程与浏览器/控制面生命周期分离 |
| Codex | 官方 App Server 的 stdio 控制接口 | 避免解析 TUI 或 DOM；使用真实 thread/turn 和审批事件 [R04] |
| Claude | 官方 Agent SDK 的流式 `query()`，驱动指定 Claude Code 二进制 | SDK 仍执行真实 Harness；通过回调把审批交给 WebUI [R06,R08,R17] |
| Agent 接口 | 每个 launch 独立 stdio MCP relay，转发到 Host Unix socket | 多模型使用同一协作工具；身份由 relay 绑定而非模型自报 |
| 桌面 | Host 内唯一 Computer Use Gateway；LCU custom client 主实现 | 桌面能力与 Harness 控制解耦；保留原执行层 [R12] |
| 工作目录 | 默认直接共享所选文件夹；显式勾选 Git 工作模式时每 Agent 独立 worktree | 是否隔离由用户选择，不宣称共享目录有文件锁 |
| OAR | 参考其抽象、事件归因与测试；不直接承担默认权限路径 | 当前 Claude launcher 强制跳过审批，不满足本项目的 WebUI 审批合同 [R03] |

TypeScript 包锁定精确依赖版本；依赖锁文件由实现仓库生成，不能用 `latest` 构建生产版本。Native profile 另行锁定可执行路径、版本、SHA-256、架构和验收报告。源码 revision 不等于通过实测的二进制版本。

## 3. 系统拓扑与权威边界

```text
浏览器 WebUI
  │ REST 命令 / SSE 持久事件
  ▼
control-plane ── SQLite: 协作事实、inbox、runs、outbox、审批投影
  │ 经认证 WebSocket: command / receipt / event / ack
  ▼
hostd ───────── SQLite: 本机命令日志、event spool、桌面租约
  ├─ Codex Driver × 3 ── codex app-server × 3
  ├─ Claude Driver × 2 ── SDK Query / Claude Code × 2
  ├─ 各 launch 的 stdio MCP relay
  │     ├─ 协作工具 → control-plane 命令处理器
  │     └─ 桌面工具 → Computer Use Gateway
  └─ Computer Use Gateway
        ├─ LCU shared client → 已安装的原版 Computer Use Runtime
        ├─ 可选 Direct MCP Provider → 官方签名 App Server/组件
        └─ Mock Provider → 确定性测试 oracle
```

控制面是频道、任务、身份与调度的权威；Host 是子进程、工具请求关联和桌面租约的权威；原生 Harness 是原生 turn 终态的权威；Computer Use 上游是实际操作、应用授权与原版清理结果的权威。WebUI 只发送意图和呈现事实，不直接连接原生 app-server，也不自行决定 Run 已完成。

SQLite `events` 是状态变化的持久发布日志，不是独立于业务数据库的第二真相。业务状态与事件必须在**同一个数据库事务**提交。Host event spool 属于传输可靠性，不是另一个任务数据库。

## 4. 核心对象及不变量

| 对象 | 定义 | 必须成立 |
|---|---|---|
| Agent | 稳定角色、权限和工作区身份 | 一名 Agent 只属一个 workspace；模型不能改变自身身份或权限 |
| Session | 一代平台会话，映射原生 session/thread | 同一 Agent 最多一代未关闭会话；恢复原生 ID 不重用旧 launch |
| Launch | 一次 Host 持有的 Harness 进程实例 | UUID 唯一；PID 只作诊断，不能作为身份 |
| Run | 一次平台调度、通常对应一个根 turn | 一名 Agent 最多一个未终结 Run；UNKNOWN 仍占据执行槽 |
| Episode | 由一个人类目标引出的因果讨论单元 | Agent 间转发继承预算，不能自行创建无限新预算 |
| Delivery | 一条消息对一名 Agent 的投递记录 | `(agentId,messageId)` 唯一；投递证据不能靠文本猜测 |
| Task | 带独占执行者与验收要求的工作单 | 原请求最多一个任务；领取原子化；完成需证据 |
| Artifact | 持久文件/截图/报告及哈希 | 消息使用 Artifact ID，而非任意宿主机路径 |
| Approval | 一个原生请求对应的人类授权 | 绑定 launch/run/request/参数哈希；不能跨新会话重放 |
| Desktop lease | Host 对一个交互桌面授予的独占控制 | epoch 单调增长；过期不是实际操作停止的证明 |

所有平台 ID 是 UUID；原生 ID 为不透明字符串。数据库 event seq 是递增整数，HTTP/SSE 用十进制字符串，客户端以 BigInt/字符串比较，不转 JavaScript Number。时间戳仅用于展示与超时，不能取代顺序号。

根 Harness 的原生 subagent 用 `lane` 标识归因；它不是新的聊天室成员，不自动得到另一个 Agent 的身份。使用父进程 MCP 配置的原生子任务仍视作父 Agent 的行为。归因无法验证的后台请求不得使用桌面。

## 5. 聊天与协作行为

### 5.1 发言与收件人

人类发言默认为普通内容；Composer 必须明确显示收件人模式：`仅记录 / 通知指定 Agent / 通知全组`。创建 workspace 后默认选“通知全组”，用户可以修改，提交请求始终携带解析后的 UUID 数组。显示文本中的 `@名字` 不独立触发权限或路由。

有回复要求的消息产生 actionable Delivery；没有回复要求的更新在成员的 context backlog 中保留，不启动模型。后台工具进度和运行输出不是自动广播消息。用户可以将一段进度“分享至频道”，生成有来源的新消息。

Agent 通过 `collab_post` 发布，身份从本次 launch 绑定中取得；请求体不能指定 author、workspace 或任意 run。它可以选择收件人并要求回复，但仅限同 workspace 已允许的成员。异步问题建立 response expectation，目标回答一次后唤醒提问者；重复回答可显示，但不会无限重新激活相同 expectation。

### 5.2 公开消息与运行轨迹分开

运行中的 `message.delta`、工具调用、诊断属于 Run Trace，显示在 Agent 进度面板；只有显式 `collab_post` 或终态 fallback 才进入持久频道时间线。

若模型已在本 Run 向主线程发布 `answer`，终态不再复制一次相同答案。否则根 turn 成功后，将可辨识的根 final 消息聚合成一次 canonical answer，唯一键 `run:<runId>:final`。没有 final 文本的成功 turn，发布“本轮结束，无文字结论”的系统事实，不编造答案。原生 child 输出不能被误当作根答案。

### 5.3 路由与终止策略

频道默认采用 **mention-driven** 模式：人类指定任务、点名问题、任务分派及明确请求的回复能唤醒；Agent 的普通评论和 progress 不唤醒全组。UI 可发起“圆桌讨论”，本质是人类一次给所选专家生成收件人列表，不是永久自动回声模式。

每 Episode 默认预算：32 次根 native turn、因果深度 8、单次 Agent 发问最多 3 个收件人、wall time 60 分钟；人类可一次通知五人。预算可配置，但只有人类控制面命令能提高预算。所有子任务/peer 消息继承 episodeId；超限消息仍保存，Delivery 暂停，UI 显示具体限制。

token 统计若可用只作软阈值；缺失时显示 unknown，不用字符数伪装精确 token，不将订阅额度当成固定货币余额。native 子 Agent 的消耗按供应商可见用量计入，不假设限制根 turn 能硬限制全部模型步骤。

### 5.4 调度公平性

调度器以 round-robin 在有 pending actionable Delivery 的 Agent 中选择，默认并发上限五，每 provider 初始上限 Codex=3、Claude=2。每 Agent 内优先级：人类中断/控制 > 人类输入 > 已请求的回复 > 任务分派 > Agent 问题，同级按消息 seq。不抢占正在运行的 turn，紧急人类 steer 除外。

每个 Run 只有一个 primary actionable message，同时附带最多20条信息更新和相关工件引用。多个独立人类任务不能无提示拼成一个 Prompt。待处理输入超过200条时拒绝继续自动 fanout 并提示背压，不能静默丢弃最旧任务。

## 6. 会话、上下文和记忆

### 6.1 Context Builder

每次 dispatch 构建可重放的 Context Bundle：可信 standing instructions、角色说明、原生项目上下文配置、主消息、此前接受的共识、相关任务状态、增量频道更新、证据工件、未解决问题和允许调用的协作工具。原版 Computer Use instructions 在首次使用前作为独立可信 provider context 注入。

Bundle 文本及引用清单记录为私有 context artifact，保存 sha256 和构建规则版本。模型看到的 Agent 消息必须保留来源和不可信标签，不伪装成用户新授权或系统指令。不同 Harness 内部 role 表达并不完全一致，平台必须明确区分 transport role 与原始 actor，而不是宣称 role:user 就是真人指示。

超过上下文预算时，首先去掉已读工具细节、保留来源引用，再截取最相关线程；不可截掉主消息、未处理授权、任务验收条件和原版工具必要指令。摘要不自动升级为共识；无证据内容只能标记 hypothesis。

### 6.2 三种状态分层

原生 Harness transcript 保存该 Agent 的对话连续性；平台记忆保存有来源、可版本化的事实；workspace 工件保存代码、图片与实验结果。禁止通过把五个原生 transcript 混在一起实现“共享上下文”。

`Memory.scope` 为 workspace、agent 或 thread。Agent 提交 proposed memory，人类接受后才进入所有相关新 Bundle；可选的指定审查者建议不等于自动批准。已 superseded 版本仍保留引用链。

前端将 workspace 呈现为项目，侧边栏以可折叠的项目及其下属对话组成导航树；不再分离工作区下拉框和全局对话列表。聊天空白区域不放创建成员等管理操作，成员页不显示可用／本机默认等常态元信息。协作能力以具名勾选项及说明编辑，不要求用户输入 capability 标识符。短暂连接故障后台重试；仅持续失败或登录失效提示，成功连接不展示状态文字。

成员（Agent）是可管理、可复用的配置对象，用户不需要全局启动、暂停或停止成员。旧 control API 的 start/resume/pause 返回 USE_CHANNEL_PARTICIPATION；stop/reset_session 仅保留为底层故障处置入口，不决定后续对话参与。创建对话时可一次提交名称与参与成员，之后在对话内勾选或取消成员；`channel_members` 是该对话的 active 集合。收到可执行消息时自动创建或恢复原生会话，没有消息时不为勾选动作启动模型。同一成员仍遵守一次只执行一轮的约束。

取消参与只撤销本对话尚未开始的 Delivery，并阻止后续投递；重新加入不会重放已撤销消息。已经接受的当前轮次可继续并回复原对话，需要立即停止时由运行详情中断具体 Run。其他对话的参与关系及执行不受影响。成员不再参与任何对话时，当前运行结束后自动回收其进程；保存空闲成员配置时也自动回收旧进程，确认清理后下一轮使用新配置。异常／UNKNOWN 会话不自动绕过恢复门禁。

v1 所有频道在 workspace 内共享可见性，membership 只决定参与与通知，并非私密访问边界。不能在同一个已阅读私密信息的原生会话上取消成员关系后声称“已遗忘”。未来私密频道必须使用 context scope 隔离或新会话。

### 6.3 恢复与重置

空闲进程可在20分钟后回收，但原生 session ID、平台记忆、worktree 均保留。下一次投递使用同一原生会话恢复，同时重新注入当前 MCP、standing instructions 和权限配置。启动进程成功不是原生 transcript 恢复成功；必须观察 native response/真实测试。

成员配置提供四种权限模式，创建与编辑使用相同选项；新建成员默认选择 Full Access，已有成员保留其保存的权限配置。保存后在下一次原生会话启动／恢复时注入，不修改正在执行的会话：

| UI 名称 | permissionProfile | Codex sandbox / approvalPolicy | Claude Code |
|---|---|---|---|
| Read Only | read-only | read-only / never | plan + PreToolUse 禁止写入、Bash 与未授权外部工具 |
| Ask For Approval | ask-for-approval | read-only / on-request | default + PreToolUse 对修改与命令返回 ask |
| Auto Approve | auto-approve | workspace-write / on-request | acceptEdits + 原生 Bash sandbox 自动批准，禁止未沙箱化命令，沙箱不可用则启动失败 |
| Full Access | full-access | danger-full-access / never | bypassPermissions + allowDangerouslySkipPermissions，关闭 Bash sandbox |

Auto Approve 不是全盘无限权限：额外权限仍可能进入原生审批。Claude 的文件工具在前三档检查真实路径以阻止工作目录逃逸；Bash 由原生沙箱或人工批准约束。用户问题及原生强制审批不伪造答案。旧 review/workspace/desktop 配置仍可读取：workspace/desktop 保留原有 Codex workspace-write/untrusted 行为，review 映射只读；只有用户明确选择新模式才改写配置。桌面网关授权和平台协作 capability 独立检查，Full Access 不绕过这些边界。


`reset_session` 创建新 generation；旧 session 先停止并确认无资源占用。UNKNOWN 不能直接绕过去启动第二个 owner。原生恢复失败时，不可静默丢弃上下文继续；UI 说明原因，由人类选择以可审计 Briefing 冷启动。自动新会话恢复只允许管理员事先选定的明确策略，并产生 recovery 事件。

## 7. Harness 接入规格

### 7.1 Codex App Server Driver

一名 Codex Agent 一个 owned app-server 进程，stdio 传输，不共享同一原生 thread 给多个写入控制者。Host 显式发现可执行文件并记录 profile；可使用独立 CLI 或 Desktop 内附带 CLI，但两者都必须通过相同探针。不能因为路径位于 app bundle 就假定包含或授权 Computer Use。

启动顺序是 initialize、initialized、thread/start 或 thread/resume；运行请求 turn/start；只有原生 turn 终结事件确认结束。支持的 steer/interrupt/approval 字段来自锁定二进制对应的协议 schema。官方方法与实验性方法分开注册，不为普通功能全局启用所有实验特性。[R04,R05]

`developerInstructions`/原生附加指令用于协作 standing instructions，不能用替换全部 baseInstructions 的办法抹去原 Harness。模型菜单来自原生 inventory；模型名返回不等于账号有权使用，Q0 必须完成一个实际请求。

捕获原生 text delta、工具开始/结束、审批、usage、compaction、错误和终态。输出按 `(launchId,runId,lane,messageId,blockIndex)` 合并，不按“最近一段文字”拼接；未知事件保留 native.unmapped 诊断，不自动映射 success。

### 7.2 Claude Code Driver

使用官方 Agent SDK TypeScript `query()` 的异步输入流，一名 Agent 持有一个 Query/真实 Claude Code 子进程；通过 `pathToClaudeCodeExecutable` 绑定 profile。SDK 不是裸模型 API，此路线保留原生工具、上下文管理和会话。[R06,R17]

使用当前稳定 SDK API，不能依赖文档已标记 removed 的 TypeScript V2 接口。SDK、CLI binary、settings 三者组合需要共同验收。以 Claude Code preset 为基础追加协作指令；加载经用户选定的项目/用户设置，不悄悄导入全部私人插件，也不悄悄取消原项目规范。[R10]

`canUseTool` 处理需要审批或 AskUserQuestion 的请求；持续挂起时 Run 显示 waiting_approval。每次工具调用的强制策略必须在 `PreToolUse` 检查，因为已经被 native permission rule 自动允许的调用不一定进入 canUseTool。[R08] 必须禁止默认 `bypassPermissions`、默认跳过权限及未披露的自动确认。

根 `result` 确认 native turn 终态；assistant message 的结束、某个 MCP 调用的返回、原生 child 的 result 都不是根 Run 完成。没有原生 turn ID 时使用 Host 生成的稳定 hostTurnId，nativeTurnId 留空，不冒充供应商 ID。

### 7.3 为什么不直接用 OAR 包办

OAR 是优秀的接口和测试参考，包含统一 records、事件归因、运行控制与脚本化假运行时。但是已阅读版本的 Claude launcher 硬编码 `--dangerously-skip-permissions`，其 queue 是 adapter 内存队列。[R03] v1 不允许未经改造就用它宣称实现 WebUI 审批和持久队列。

可以复用 Apache-2.0 许可下的特定测试模式、projection 思路或经审计的组件；平台公共契约必须由 `contracts/runtime.ts` 决定，不把 OAR 原生类型泄漏到数据库/API。采用它的未来版本须通过同样的 conformance suite。

## 8. Computer Use Gateway

### 8.1 主 provider：LCU custom client

Host 使用 LCU 的 `createCuaClient` 管理上游连接，而非通过 Desktop UI 向另一个模型发自然语言。必须保存并注入 `instructions`、透传 `publicTools()` 的 `js`/`js_reset` 描述和输入 schema、原样保留 tool result 的 content/structuredContent/isError。[R12]

每个 Harness 的 launch 配置注册一个专用 Computer Use MCP relay；relay 的工具目录从 Host 的已探测 provider 获取。工具名命名空间由外层 MCP server 名区分，上游 `js` 参数不自行改名。模型得到真实图像 content；工件预览是额外审计副本，不代替发给模型的图片。

禁止把上游 `turn_ended`、`js_add_node_module_dir`、`set_turn_context` 暴露给模型。生命周期通知由 Host 原生事件驱动；LCU 通用客户端文档要求整轮保持连接并传递 session/turn 关联。[R12] 平台的 Interrupted/Shutdown 是内部原因，必须映射到锁定 provider 明确支持的生命周期合同；不能向上游凭空发送同名字符串。

本机必须安装兼容的官方组件并完成原生系统权限。仅检查文件存在、MCP initialize 成功不能算 desktop qualified；必须在专用测试应用完成观察、输入、返回截图、拒绝授权和停止清理。

### 8.2 独占与状态模型

同一可交互桌面资源默认 `desktop:<hostId>:console`。Host 是租约唯一裁决者。获得租约时原子增加 epoch，绑定 ownerLaunchId、ownerRunId 和 providerSession。所有调用由服务端绑定 epoch，模型不能传入任意 owner 或提升权限。

LCU 的 `js` 能包含多个操作，无法用字符串匹配可靠断言只读。因此**所有 js 调用按潜在写操作处理**，同一桌面只有一个拥有者；多个 Agent 可同时分析已有截图，但不能同时在同一个交互桌面执行 js。初始 lease 随整个根 turn 持有，或由严格的 host-only pause boundary 提前释放；v1 不实现中途交接优化。

租约正常释放条件：根 turn 已终态、所有相关 desktop calls 已结束、没有带资源的已知后台任务、原版 cleanup 收据确认成功。只收到 interrupt ack、不再输出文字、连接断开、TTL 到期，都不足以释放。无证据则进入 `quarantined`，阻止下一名 Agent，用户看到“停止未确认”，而不是“已停止”。

租约有效期用于发现失联并发出停止请求，不用作抢占授权。Host 重启时已有 held/draining 资源默认 quarantine；重建连接、验证进程与状态、清理成功后才能增加 epoch 再授予。过时 epoch 的新请求必须拒绝；已经进入黑盒执行层的动作不能靠 fencing 撤销。

用户手动操作、其他应用或外部自动化可能改变桌面。网关只能仲裁经过自己的请求，不能宣称提供 OS 全局事务。每次重要点击前要求新观察、相同 provider/session 的元素句柄；跨 js_reset、provider 更换或桌面交接后必须重读。

### 8.3 审批与权限

WebUI 使用统一 Approval Center 渲染原版请求。原版提供的标题、应用名称、限制和选项必须保留；仅给出平台支持且上游允许的 once/session/deny/cancel，v1 不提供无期限 always allow。响应携带当前 approvalVersion 和参数哈希，Host 验证后返回上游。

Atrium Grove 不实现“允许全部应用”的隐式策略。Harness 允许调用 js，不代表原版应用权限已允许。上游禁止的应用、macOS TCC、账户条件和本机解锁要求保持原样；模型不得操作审批 UI 来代替用户回答。待人工审批时暂停 tool execution deadline，但不暂停全部系统监控。

### 8.4 可选 direct-mcp provider

`tmustier/codex-computer-use-mcp` 可作为第二后端：通过官方签名 Codex app-server 的 `mcpServer/tool/call` 直接分派，无嵌套模型。[R13] 其工具 vocabulary 与 LCU js 接口不同，Provider 通过 capability manifest 暴露差异；不能把 list_apps 等十工具假装为 LCU 同一 schema。

该桥自身使用 Full Access、没有完整的应用白名单，必须受 Atrium Grove 网关策略控制。禁止在 LCU 出错时自动切换 direct provider 延续旧元素 ID 或授权；切换必须清理、开启新的 provider session、刷新工具描述并重新验收。

## 9. 任务、工作树与整合

Project.workspaceMode 分为 directory 和 git-worktree。新建绑定默认 directory：目录浏览、校验和成员启动不查找 Git，即使目录内或上级已有 Git 也直接使用所选文件夹。多个成员可以共享同一目录；不提供文件互斥锁，任务 claim 只约束任务归属，不能防止不同任务写同一文件。四档权限与目录模式独立。

只有显式勾选 Git 工作模式才查找关联仓库（支持仓库子目录），由 Host 验证真实仓库、baseRef 和提交。未关联或没有提交时提供显式的“初始化 Git 并创建首次提交”操作，加入未被 .gitignore 忽略的当前文件，不推送远端；普通浏览与运行绝不触发初始化。首次提交前界面说明哪些文件会被纳入。已有提交的仓库不自动暂存或提交未提交修改。

Git 模式工作树位于 `<state>/worktrees/<workspaceId>/<agentId>`，分支 `harbor/<agentId>/<generation>`；选择仓库子目录时 cwd 为该工作树内的同一子目录。工作树不以可任意覆盖的请求路径创建，禁止 branch 名/参数 shell 拼接。Git 模式只读评审者同样使用独立 checkout。已有绑定迁移为 git-worktree 以保留原数据；设置页允许显式改为共享目录。切换前需在各对话取消相关成员的参与，等待当前运行结束及会话回收；保留旧 worktree，不把其未合并改动自动搬回原目录，并在下次启动使用新原生会话。

任务由原消息转换或显式创建；同 sourceMessageId 第二次创建返回现有任务。`claim` 使用 expectedVersion 的原子 CAS：只有 todo 或同 owner 可恢复的 blocked 能取得执行，冲突返回409。模型声明“我负责”不构成所有权。租约过期触发 owner 检查和任务 blocked，不把仍运行的旧 worker 与新 worker并行启动。

Task 流程：todo → in_progress → in_review → done；可从进行中变为 blocked，同 owner 恢复；人类可取消。依赖任务未 done 禁止 claim；建依赖时检查 DAG。Owner 在进入 in_review 前提交适用的文件、diff 或 test_report 工件和验收说明；普通目录不要求 Git commit；指定 Reviewer 必须不同于 Owner，done 由 Reviewer 或人类作出。没有独立 Reviewer 时由人类完成验收。

选择 Git 模式时，代码整合使用专门 integrator Agent/worktree，每次基于明确 commit SHA 进行 review、cherry-pick 或 merge；不自动覆盖他人未提交文件，不默认推送远端。整合步骤也是有 Owner、验收条件和日志的 Task。工作树隔离降低误写，不是同一 OS 用户下的强安全隔离。

## 10. Run 生命周期与故障语义

```text
scheduled → dispatching → running ↔ waiting_approval
                                 ↓
                              draining
                            ↙    ↓     ↘
                      completed failed interrupted
任何不确定的执行边界 → unknown → reconciliation → 有证据的状态
```

`nativeOutcome` 与 `Run.state` 独立：native 已 completed，但桌面清理未结束时 Run 仍 draining。所有操作202仅表示 Operation 已持久接受；UI 必须订阅后续事件或轮询 Operation，不将HTTP成功等同执行成功。

对 Native 输入采用“持久意图 + 一次投递尝试 + 收据”而非端到端 exactly-once 承诺。写 stdin 后崩溃可能无法区分已执行与未执行；此时必须保持 unknown，先查询原生 transcript/状态，再决定继续。不可使用相同内容重发来“确保收到”，因为它可能再次修改代码或点击界面。

请求 reconcile 是只读核实，不能启动新模型 turn。若查询有确定终态，按事实投影；若没有，就保留 unknown。用户停止未知运行后，Host 只有在确认自己持有的进程树和资源静止后才能以 interrupted/failed 关闭，不允许把人工点击“完成”变成原生成功证据。

控制面短暂不可用：Host 继续当前已接受的原生运行，缓冲事件；禁止新跨 Agent 任务、禁止新的平台授权。正在等待工具审批保持挂起。Host 与控制面断开超过60秒时对占有桌面的工作请求停止，待 cleanup确认后释放；其他本地代码任务可按用户预设继续，但不允许平台无记录地重新调度。

Host 进程崩溃：stdio 控制通道无法假设可重新接回。按 PID+启动时间+可执行路径验证已拥有的残留进程，尝试停止；不能 `pkill codex` 影响用户其他会话。原生会话恢复用于后续工作，不是把失去的旧进程控制权自动恢复。

## 11. WebUI 详细交互

### 11.1 布局与页面

桌面主布局为左侧 workspace/频道列表、中间消息时间线、右侧可切换线程/Agent详情；顶部显示五位Agent简况和“暂停全部”。窗口较窄时右栏变抽屉，不压缩消息正文。UI 支持浅色/深色及键盘操作，不仿冒 Raft 标识。

| 页面/区域 | 必备元素 | 数据及动作 |
|---|---|---|
| 初始化向导 | Host连接、二进制探测、模型验证、项目绑定、创建五Agent | probe结果分 installed/authenticated/qualified，错误可重试 |
| 聊天 | actor/Harness标识、流式正文、可折叠的工具调用与输入输出、执行耗时/等待审批、工件、收件人、回复线程、发送状态 | 运行中直接消费持久 run.trace；按会话筛选 Run，刷新分页恢复并按 launch/producerSeq 去重；最终消息替换对应流式结论 |
| Agent roster | idle/working/waiting approval/offline/unknown、排队数、当前任务 | start、pause、stop、reset，后两者确认影响 |
| Run详情 | 根/child分道的流式轨迹、工具输入输出、错误、用量、配置快照 | interrupt、明确标识的人工steer、reconcile |
| 任务看板 | todo/in_progress/blocked/in_review/done、Owner、版本、证据 | 原消息转换、原子claim、评审完成 |
| 审批中心 | 原版请求、受影响Agent/工具/应用、once/session/deny | 请求失效后禁用按钮，响应中不能重复点击 |
| 桌面中心 | provider指纹、qualification、Owner、epoch、inflight、截图 | 请求Stop，显示stopping/uncertain；隔离清理流程 |
| Memory | proposed/accepted/superseded、来源、范围 | 人类接受或替代 |
| 运行设置 | 固定模型/profile、权限、并发、预算、可见MCP清单 | 运行中的配置修改先暂停并重新开session |

用户无需打开终端才能批准普通工具请求；OS初次系统权限仍在本机完成。所有消息正文以安全 Markdown 渲染；不执行HTML、脚本、远端图片追踪或任意文件URI。代码块复制保持原文，错误信息可展开但默认脱敏。

### 11.2 状态与空态

“模型静默但进程存活”显示“暂无新进度”，而非失败或成功。等待批准、额度限制、上下文压缩、Host离线、provider不兼容分别展示。token缺失显示“未报告”；模型名、native version、工具清单各有来源标签。

time line乐观显示只存在于发送者本地，clientMessageId相同的服务端确认替换该占位；WebUI刷新后以服务端事实为准。SSE断开显示重连条，历史记录仍可读，命令提交仍使用独立REST。

## 12. 协议、存储与一致性

精确HTTP见 `contracts/openapi.yaml`；内部接口见 `contracts/runtime.ts`；算法见 `PROTOCOLS.md`。禁止实现另一套与这些文件平行但不一致的字段。

HTTP所有写命令要求 Idempotency-Key，所有owner cookie写命令要求CSRF token；`expectedVersion` 用于可变资源。相同key相同body返回原成功响应，相同key不同body返回409。幂等保存和业务状态同事务；工件上传先临时文件/fsync/原子移动，再登记元数据；失败留下孤儿文件由GC处理，不返回虚假的已上传。

SSE eventId、全局seq与Host producerSeq分别管理。snapshot在一个一致性读事务内取得状态和snapshotSeq。订阅只读 `seq>cursor` 的已提交事件，并在通知丢失时继续轮询数据库。不能把“先读取历史，再挂Socket监听”作为无缝同步算法。

SQLite只能由一个control-plane writer管理；Host DB也只有一个Host owner。迁移运行前阻止新任务并创建可恢复备份；使用SQLite在线备份或完整checkpoint后的停机备份，不能只复制仍有WAL事务的主文件。工件目录与DB备份清单包含哈希和版本。

## 13. 身份、权限与信任模型

本项目不是抵抗本机同UID恶意进程的沙箱。可信用户选择的Harness可执行代码，因此工作树、环境变量清理和MCP scopes主要防止误用及远程接口越权；不能宣称它们隔离了一个蓄意读取本机全部文件的攻击者。未来需要不可信Agent时，使用OS用户/VM/容器级隔离并重新设计桌面授权。

control-plane默认只监听127.0.0.1:4310；生成一次性短期登录令牌，由CLI展示，人类在WebUI粘贴交换为HttpOnly、SameSite=Strict cookie及CSRF token。令牌不放URL、日志或浏览器长期localStorage。启用非本机访问是后续功能，必须TLS和独立认证评估，不能仅把监听改为0.0.0.0。

Host enrollment通过本地管理员CLI完成，控制面保存凭据哈希，Host文件0600保存原值；WebSocket升级检查Authorization和Host身份。每launch MCP relay只有本launch短期token，可访问自己的可用工具，不能批准、重置预算或控制其他Agent。模型参数中的agentId只能作为**目标**，从来不是调用者身份。

Permission profiles：`review`为只读项目工具和协作；`workspace`允许已批准的worktree写入/测试，外部副作用另问；旧 `desktop` 不再授予 Computer Use；电脑操作按独立开关与 Auto Approve / Full Access 的 AND 规则判断。profile映射失败时必须拒绝启动，不悄悄降级FullAccess。原生用户插件与MCP必须列出来源；未经用户纳入settingsProfile的工具不自动暴露。

## 14. 运行指标、日志和容量目标

这是验收目标而非已测结果：本机五Agent时，纯平台REST p95<300ms，已落盘事件到WebUI p95<1s；模型与原生工具耗时另计。设计测试使用100,000条消息与500,000条事件验证分页，不把全部trace装入浏览器内存。

默认限制：JSON命令1MiB，每text block最大64KiB UTF-8、单message正文合计128KiB、附件最多16个、总blocks最多32个；单工件25MiB；Host未确认spool达到256MiB或100,000事件时停止接收新Run并请求现有运行有序停止；故障前已持久事件不可删。大tool输出本地内容寻址存储，控制面只传受限预览和artifact引用；不要在SSE发大段base64图片。

指标包括 inbox年龄、dispatch延迟、native运行数、批准等待时长、unknown次数、工具失败、桌面隔离、重放重复、spool长度、每Harness已报告用量。按measurementId去重；累计usage用差分，差分非负及重置处理；不将cumulative多次求和。

默认保留：频道/任务/接受记忆/用户标记证据永久；UI事件30天，raw native诊断7天；截图7天，但任务证据中引用的截图固定保留。删除前维护replay retention frontier，旧cursor410；秘密字段脱敏，原始供应商响应可能含敏感内容，只允许人类授权导出，默认不存完整认证/config响应。

## 15. 仓库布局与开发责任

```text
apps/web/                   React界面、SSE reducer、人工审批
apps/control/               Fastify路由、认证、事务命令、SSE
apps/host/                  WS client、进程监督、spool、MCP broker
packages/contracts/         JSON Schema/OpenAPI/Runtime types生成
packages/domain/            纯状态机、权限、调度选择、预算
packages/persistence/       control SQLite迁移与repository
packages/runtime-codex/     App Server native adapter
packages/runtime-claude/    SDK/CLI native adapter
packages/runtime-testkit/   scripted fake subprocess/oracle
packages/mcp-relay/         per-launch stdio与UDS转发
packages/computer-gateway/  租约、审批、清理、审计
packages/computer-lcu/      锁定LCU custom-client adapter
packages/computer-direct/   可选第二provider
packages/worktrees/         Git生命周期、产物导出
packages/artifacts/         内容寻址、授权读取、保留策略
packages/observability/     结构化日志、metrics、trace导出
fixtures/ tests/ docs/      录制事件、conformance、ADR
```

domain不依赖Node进程或Web框架；WebUI不import native adapter；control不读取本机Harness私有配置；provider不访问任务数据库；任何重试政策只由拥有side effect语义的那一层决定。允许共用TypeScript类型，不允许以循环调用打破这些边界。

## 16. 部署与运维命令合同

实现仓库须提供以下CLI（本包不是这些命令的实现）：`pnpm atrium-grove init` 初始化状态，`pnpm atrium-grove serve` 启动Web/控制面，`pnpm atrium-grove host start` 启动Host，`pnpm atrium-grove doctor` 展示profile和版本门禁，`pnpm atrium-grove login-token` 生成一次性网页登录凭据，`pnpm atrium-grove team import <yaml>` 导入五人配置，`pnpm atrium-grove backup <dir>` 备份，`pnpm atrium-grove export-run <id>` 脱敏导出。

`pnpm atrium-grove init` 默认创建 `<home>/.harbor/{control,host,artifacts,worktrees,logs}`，敏感目录0700，token/config文件0600。Host在用户图形登录session内启动；Docker仅可用于测试和后续控制面部署，不承载macOS原生桌面服务。可选launchd安装必须由用户显式执行，不能在首次Web访问静默安装常驻项。

Native二进制更新、LCU更新、原版工具schema/instructions哈希改变后，原qualification失效，新Run不得继续使用未确认组合。已有运行不强行热换；有序结束后重新探测。可以显式暂时禁用Computer Use保留聊天开发，但这不算完整桌面验收通过。

## 17. 实施顺序与完成定义

| 里程碑 | 必须交付 | 退出条件 |
|---|---|---|
| M0 契约与基础 | workspace/auth/DB/event、fake runtime、WebUI基础 | schema/SQL/事务/重放测试通过 |
| M1 原生五会话 | Codex driver、Claude SDK driver、resume/interrupt/审批 | Q0/Q1通过；五会话身份不串线 |
| M2 协作闭环 | inbox、peer问答、task CAS、memory/artifact、预算 | 无手工复制的跨Harness任务与评审 |
| M3 桌面 | LCU provider、WebUI应用授权、租约和清理 | Q2/Q3通过；真实桌面观察—操作—结果返回 |
| M4 故障与打包 | reconciliation、spool、备份、权限/故障注入、运维向导 | Q4及全部A系列验收通过 |

可以在M1/M2并行开发Computer provider，但不能绕过M3的真实验证。最终v1完成要求不是“能开五个窗口”和“截图成功一次”，而是消息因果、唯一任务Owner、相互协作、WebUI审批、桌面拒绝/取消、控制面重启恢复全都通过。详细测试步骤在 ACCEPTANCE.md。

## 18. 无需再做架构选择即可开始的首批任务

先从本包复制**原创契约与SQL**到新仓库，创建workspace包与CI；实现domain事务及fake Host，打通一个人类消息到两个fake Agent的异步问答、任务独占领取与SSE重连。随后按Runtime契约接两个原生驱动，再接LCU custom client。每步保留同一套contract tests，不为临时能跑另造接口。

唯一必须在用户Mac上补充的环境输入是：真实二进制路径/版本、已登录profile、可用模型ID、Git项目路径、Computer Use组件与系统权限。这些是setup向导与Q0–Q4的输入，不是尚未决定的架构。未实测项明确标为unqualified，不能靠Spec承诺所有当前安装组合天然兼容。

## 19. WebUI审批不能被桌面Agent代点

CSRF和HttpOnly只隔离网络调用，不阻止一个能控制已登录浏览器的桌面Agent点击批准。v1配置必须指定人类控制界面的宿主应用，并将它从Computer Use允许范围排除；同一浏览器应用不能一边运行已登录Atrium Grove控制台，一边交给Agent任意操作，即使使用不同标签或profile。

setup资格检查必须检查原版已有的持续应用授权；人类控制宿主若已有Computer Use许可，要求用户撤销或换到不受自动化控制的宿主，不能仅在wrapper新请求回调里deny却忽略缓存的旧许可。若当前provider无法实施/验证这个边界，必须将可供Agent操纵的本机WebUI审批标记不满足资格，并要求独立的人类在场确认机制后才能启用桌面写操作。不能以模型Prompt“不要点击批准”替代控制。

这是v1可信本地环境的额外防误用边界，不是对任意同UID恶意shell进程的隔离保证。禁止把任何具备任意本机代码执行的Agent产品宣称为仅靠WebUI token即可实现强多租户安全。

### 11.3 Working-directory conversation navigation

The sidebar project is the real Project.rootPath directory, not a renamed Workspace container. Home and New conversation open an unsaved composer. The composer selects a directory and member presets; startConversation atomically creates the directory-bound Channel, membership, and first Message. Its title comes from that message. Folder-level New conversation opens the same draft with its directory preselected, without a modal or an empty Channel. Group conversations by Channel.projectId and show folders only once they contain conversations.

The conversation directory controls native execution. Switching a member between conversations closes the idle native session and resumes only that conversation's transcript; the member preset's default directory must not override the conversation. Infer a legacy channel's folder only when its members share one actual execution project. Ordinary directory mode never inspects or initializes Git; Git work remains explicit opt-in.


### Computer Use 成员授权（2026-10-10）
Computer Use 是每个 Agent 的独立开关，默认关闭。只有开关开启 **且** permissionProfile 为 `auto-approve` 或 `full-access` 时，Host 才注入 `harbor_computer` 并接受电脑操作调用。`read-only`、`ask-for-approval` 和旧 profile 均不得通过此入口调用电脑工具。切换至不支持的模式会在界面关闭开关；以后提高模式也不得自动恢复开关。API 必须拒绝不满足此组合的配置，调用侧再次校验，不能仅隐藏控件。现有成员不批量开启。应用的原生授权仍独立于此开关，不能用 Full Access 自动代答。

---

# 第二部分：详细协议

# Atrium Grove 1.0 — 协议、算法与状态机

本文件规定各模块连接方式和故障行为；数据结构由 `contracts/` 给出。下列伪代码描述算法，不应被误认成上游SDK的逐字API示例。上游调用只有已标明的native方法名具有外部协议含义。

## P01. 编码与验证约定

ID为RFC兼容UUID；nativeSessionId/nativeTurnId不作格式推断。时间用UTC ISO8601，界面按用户时区显示。全局event seq是十进制字符串；producerSeq是launch内递增正整数。对象未知字段默认拒绝，raw native payload与provider inputSchema除外。

HTTP Content-Type是application/json，默认最大1MiB。text block最大64KiB；消息合计UTF-8正文最大128KiB，此业务限制补充JSON Schema。工具返回超过512KiB的文本需生成artifact并返回有明示截断标识的预览，**原版Computer Use返回给调用模型的结果除外**：不得静默截断其原生内容，超出native限制则返回明确错误或经provider支持的资源路径。

idempotency key按principal+route+key作用域，UUID建议但不限UUID。requestHash是规范化JSON的SHA-256；规范化递归按Unicode code point排序对象键，数组顺序保留、UTF-8无空格、禁止NaN/Infinity。二进制上传hash涵盖内容sha256、filename、workspace。native payload不重新规范化后冒充原始字节。

所有事务同时验证workspace/agent/project/channel/thread/task的关联。SQL允许的跨workspace引用不代表业务允许；服务层拒绝与当前认证scope不一致的任何ID。

## P02. 人类发言的原子提交

`POST /v1/channels/{channelId}/messages` 接受 PostMessage。

```text
validate cookie, CSRF, schema, channel/workspace active
BEGIN IMMEDIATE
  lookup(principal, route, Idempotency-Key)
  if exists and hash differs: ROLLBACK, 409 IDEMPOTENCY_CONFLICT
  if exists and hash same: return previously stored response
  resolve thread / reply target and verify same channel
  resolve recipientAgentIds: existent, member, same workspace
  actor := authenticated owner (never body.author)
  episode := allowed human continuationEpisodeId or create new episode
  insert message, message_recipients
  insert each delivery once; actionable vs context-only derived by requestResponse
  append message.created event; set message.published_event_seq
  save exact response in idempotency_keys
COMMIT
signal scheduler and SSE readers (advisory notifications only)
return 201 canonical Message
```

模型发言走同一domain命令，但不是owner REST。Host将BoundToolCaller和当前Run绑定传递给控制面；episode只能继承当前run.episodeId，causalDepth来自primary message+1；agent不能传入任意rootBudget。消息内容保留自然语言，结构化recipient IDs用于路由。

消息v1不可原地修改或删除；更正用新回复，避免已投递内容被静默替换。task和memory更新以版本化实体表达。超过预算只暂停新投递，不丢弃已经提交的发言。

## P03. 调度与投递事务

scheduler每250ms扫描或由持久事件通知唤醒。通知不是唯一驱动。每次扫描最多预约10个任务，round-robin游标保存在controller内存也可从最近run重建；公平性不是严格实时保证。

```text
for agent in readyAgentsRoundRobin:
  BEGIN IMMEDIATE
    verify desiredState=running, workspace active, host online
    verify no active run (including UNKNOWN) and session ready
    primary := oldest highest-priority actionable delivery
    verify episode open, wall deadline, depth, fanout, root-turn budget
    if no quota: episode.paused_budget, append event, COMMIT; continue
    reserve ONE root turn using conditional UPDATE of episodes
    create run scheduled; select <=20 context-only updates
    reserve selected deliveries under reservationId=run.id
    create immutable ContextBundle and context digest reference
    persist Operation + host_command(runtime.submit) + run.scheduled event
  COMMIT
```

Context artifact较大时先写临时文件并原子落盘，再提交引用；不能持有SQLite写锁等待模型、网络、Git或大文件I/O。事务前计算所需上下文版本号，提交时校验未改变，冲突重建。自动扫描失败backoff上限5秒，不阻塞其他Agent。

host_command外发是outbox worker职责。相同commandId超时可以重发，但Host去重保证不重新发起同一副作用。**不能为同一个不确定的native submit生成新commandId重试。**

调用失败的预算处理：在证明native输入未写入前失败可退回一次reservation；写入或unknown均保留占用。取消reservation与预算返还同事务，防止多次回调重复退还。

## P04. Delivery语义与游标

状态与证据分离：state=sent表示已尝试交付，不表示模型看懂。证据可以逐步增加，不强制伪造一个单一路径。

| 证据 | 产生方 | 允许说什么 |
|---|---|---|
| transport_written | Host driver | native输入字节已写入控制通道 |
| native_ack | native reply/echo投影 | 原生接口确认接收该input；尚非认知证明 |
| context_included | ContextBuilder + Host已提交的bundle | 该消息被包含在具体contextDigest中 |
| agent_ack | 本launch的collab_ack调用 | Agent显式回执该delivery；不等于task完成 |

ContextBuilder仅构建成功时不能提前增加last_included_seq；需Host对提交作出written/native_ack证明。cursor只是该Agent已包含/回执的**连续可见前沿**，不能因为读到了seq100就跳过尚未交付seq90。对稀疏事件以delivery_evidence逐条记录，从数据库计算连续消息前沿；SSE事件seq中其他对象的空档不是漏消息。

`collab_read`只读快照，不推进已完成状态；`collab_ack`提交明确delivery ID列表，服务器验证它们属于调用Agent且曾进入当前run的context或读取快照。对信息更新可停止再次投递；对actionable请求，ack不代替run/result/answer，也不免除待办。Agent可把任务标blocked并交代原因，但不能只ack后让任务消失。

## P05. 异步peer问答和防回声

A用collab_post向B发question，requestResponse=true。服务器建立requestMessageId/responderB/requesterA的expectation。B答复必须指定replyToMessageId；该reply属于same episode、same thread且是目标B或人类介入时才满足expectation。

满足时原子将expectation从pending变answered，给A生成reason=requested_reply的delivery；重复回答不再次激活。一般answer不要求再次回复，除非另外发出一个明确question。Agent禁止通过同步`wait_for_agent`工具占住模型回合或桌面租约等待同伴；应该发布问题、记录状态、结束当前turn。收到结果后调度器再启动下一turn。

Root native final的fallback与显式answer去重按run字段/消息ID而非相似文本。显式answer对主消息成立才设置runs.final_message_id；向其他线程发progress不会阻止主回复fallback。

## P06. Host WebSocket协议

路径 `GET /internal/host/v1/connect` 升级WebSocket，仅Host bearer。初次配对由管理员CLI在本地数据库注册随机256-bit credential，并把原值写到host配置0600；控制面只存哈希。v1不开放匿名pairing网络接口，domain的PairHost/HostEnrollment类型为管理CLI序列化，不属于owner Web API。

连接成功后Host发送HostHello。控制面回复：

```json
{"type":"welcome","protocolVersion":"harbor-host.v1","controllerEpoch":"<uuid>","heartbeatMs":10000,"maxBatchEvents":100,"maxFrameBytes":1048576}
```

支持frame：hello/welcome、ping/pong、command、command_receipt、events_batch、events_ack、inventory、resource_snapshot、host_diagnostic、shutdown_notice。每个frame必须带schemaVersion=1，ping/pong除外可以不持久化。协议版本不兼容拒绝连接，不能降级字符串解析。

`command`字段见CommandEnvelope。kind映射：runtime.open/submit/steer/interrupt/close/reconcile；approval.respond；host.probe；desktop.stop/clear_quarantine；artifact.export。payload为对应内部方法参数，通过kind的独立schema验证，不允许任意代码或shell文本作为Host管理命令。

Host接收算法：

```text
verify hostId / current controllerEpoch / expiry / payloadHash / allowed kind
BEGIN Host DB
  if commandId exists:
    if hash differs: refuse COMMAND_ID_CONFLICT
    else return saved receipt; never reinvoke
  insert received_commands(state=received)
COMMIT
before native side effect: persist state=issuing
perform native call once
persist accepted/completed/failed receipt OR unknown on ambiguous channel failure
send receipt
```

command过期只禁止未开始执行的意图；已issuing的命令不因control-plane重连而重新执行。controllerEpoch切换后原accepted工作继续存在；控制面先reconcile再派新工作，不用新epoch清空Host历史。10秒heartbeat、30秒无响应显示Host离线；重连指数退避0.5–30秒加抖动。

### 事件spool

每个launch先把RuntimeEvent写入event_spool，再对外发送。root事件producerSeq全序递增，lane只作归因不重置序号。events_batch包含一个或多个launch事件，控制面对`(launchId,producerSeq)`去重；相同键不同payload哈希属于协议损坏，拒绝并隔离Host，不覆盖旧记录。

控制面把runtime_events、run状态投影和公开events同事务落盘后才回ack，ack为每launch**连续已提交**序号。Host收到ack再标记并清理已确认spool。WS传输重复可接受，应用层按序重放；消息序号跳跃先缓冲并请求缺口。Heartbeat不能推进事件cursor。

如果Host突然退出，已持久spool可重放；尚未从native stdout接收/持久的事件不保证恢复，必须标记相应run trace可能不完整。不要声称磁盘日志解决了任意崩溃瞬间的事件丢失。

## P07. Codex原生适配

必须从锁定二进制生成或取得对应版本的协议TypeScript/JSON Schema，签入adapter fixtures并记录generator版本。通用握手示意：

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"harbor","title":"Atrium Grove","version":"1.0.0"}}}
{"method":"initialized","params":{}}
{"id":2,"method":"thread/start","params":{"cwd":"<owned-worktree>","model":"<verified-model-id>"}}
{"id":3,"method":"turn/start","params":{"threadId":"<native-id>","input":[{"type":"text","text":"<context-bundle>"}]}}
```

此段省略具体native版本要求的可选capabilities/permissions字段；**adapter不是把省略部分猜成默认FullAccess**，而是由qualification profile明确填入并验证。使用官方标准stdio启动方式；不要假定所有binary都接受历史`--stdio`开关。启动参数通过`--help`/protocol探针确定。

responses通过id匹配pending requests；服务器主动request可能也带id，必须根据method与已知方向区分，不能把审批误当作客户端响应。stdout每行一个完整协议对象，stderr作诊断，最大line上限16MiB，超过后终止协议并报错而不是截断JSON继续解析。

| Native信号 | Atrium Grove投影 |
|---|---|
| thread创建/恢复response | 记录nativeSessionId；等待必要工具/权限就绪后session.ready |
| turn/start response、turn/started | input native_ack、turn.started；按nativeTurnId去重 |
| item/agentMessage/delta | message.delta；保留item/message/channel及lane |
| tool item开始/结束 | tool.started/completed；同callId只终结一次 |
| server审批request | ApprovalRequest；挂起native request promise |
| turn/completed | nativeOutcome按status解析，进入draining |
| 进程exit而无终态 | failed或unknown，依是否有未确认副作用决定 |

`turn/steer`仅用于人类显式补充，检查active nativeTurnId；no_active_turn时返回冲突，由UI提示是否作为下一条消息发送，不悄悄丢输入。`turn/interrupt`成功响应不直接设置interrupted终态，要等原生terminal与工具清理。`thread/resume`不是获得其他控制者正在占用thread的许可。

默认禁止平台外的native根自动续跑/goal循环；若收到没有对应Run的根turn，记录spontaneous turn，暂停该Agent并请求停止/人工核实，不静默用掉未计入预算的工作。原生工具内多个model step不等于多个平台Run。

## P08. Claude原生适配

由SDK稳定TypeScript导出驱动：`query({prompt: asyncIterable, options})`。输入queue由Host/controller管理，而非无限向asyncIterable注入新消息。Query对象和消费消息的loop属于一名Agent，不由每次HTTP请求临时创建。

必须配置并编译验证的option意图：pathToClaudeCodeExecutable、cwd、model、resume（恢复时）、保留Claude Code preset的systemPrompt追加、MCP server列表、权限mode、settings profile、canUseTool及PreToolUse。以已安装SDK类型声明为构建门禁，不能把本规格的概念字段直接当成SDK属性。

根SDKUserMessage关联平台inputId；实际native UUID/echo能观察则记录native_ack，仅写入asyncqueue只提供transport证据。消费stream_event做增量投影；最终assistant blocks需要与已流式block去重。根result结束turn；child通过parent_tool_use_id归因。异常错误、is_error、取消必须映射不同终态，不用“有result字段”判成功。

审批实现：PreToolUse负责不可绕过的平台policy；需要人类决策则创建Approval并让canUseTool等待真实回答。返回allow时传入原input作为updatedInput，不默默改参数；禁止将任何model建议的updatedPermissions自动持久化。AskUserQuestion渲染模型提供的问题和选项，答案只返回该请求，不从UI另加未知问题字段。[R08]

SDK中断必须使用锁定版本公开的中断/关闭方法，不通过向对话塞“停止”模拟。生成fakeQuery实现相同消息/异步取消接口做回归。无实时权限回调的CLI profile无法通过interactive approvals门禁，不允许降级“全部同意”。

## P09. Agent工具协议

工具通过stdio MCP暴露；一个relay只代表一个launch。stdout只能有MCP协议，日志写stderr；两端协商MCP版本，并将锁定SDK版本记录在构建锁文件。Host broker通过private UDS接收relay请求，校验peerUID、token、launch存活、run归属。v1本机UDS权限0700目录/0600socket；同UID敌对进程不在隔离保证内。

工具名与schema在 `contracts/tools.schema.json`；下表补充语义。所有成功结果用MCP text content承载JSON，图像读取使用MCP image content，错误设置isError=true并含PlatformError。write工具要求requestKey；重试同key不同参数拒绝。

| 工具 | 关键输入 | 结果与副作用 |
|---|---|---|
| collab_context | 无 | 调用Agent/Run/任务/收件范围、剩余预算和原生能力清单；无secret |
| collab_read | channelId, threadId?, afterSeq?, limit<=50 | 有序messages、nextCursor、readReceiptId；不自动ack |
| collab_post | channelId,threadId?,replyToMessageId?,text,recipients[],requestResponse,kind,requestKey | canonical Message；身份和episode从caller继承 |
| collab_inbox | limit<=50 | 本Agent pending/sent但未ack内容摘要；不挪用他人队列 |
| collab_ack | deliveryIds[],readReceiptId?,requestKey | 接受的IDs和拒绝原因；actionable ack非task完成 |
| task_list | channelId?,status? | 可见Task列表 |
| task_get | taskId | Task、依赖、来源线程及证据引用 |
| task_create | channelId,threadId,sourceMessageId?,title,description,acceptanceCriteria[],dependencies[],requestKey | 原子创建；sourceMessageId幂等 |
| task_claim | taskId,expectedVersion,requestKey | caller自身为owner；返回version与leaseEpoch |
| task_transition | taskId,status,expectedVersion,leaseEpoch,reason?,artifactIds[],requestKey | 状态机校验；不允许owner自审批done |
| artifact_register | localPath,kind,filename,requestKey | Host验证realpath位于允许目录，计算哈希，传输登记 |
| artifact_read | artifactId | 已授权文本或真实MCP image；禁止任意绝对路径读取 |
| memory_propose | scope,ownerId?,title,body,sourceMessageIds[],requestKey | proposed memory，不直接全组接受 |

模型不能调用approve、desktop.clear_quarantine、change_role、change_model、increase_budget、terminate_other_agent。CLI调试接口可调用同一domain逻辑，不另设模型可访问的管理后门。

readReceiptId由服务器签发，绑定Agent+Run+实际返回的消息ID集合，存于有TTL的读receipt表；服务重启后应可继续验证。若不采用receipt，ack只能引用当前ContextBundle里的delivery；不得相信客户端声称读过任意seq。本v1采用后者作为基线，readReceiptId为reserved可选字段，返回null且不扩大可ack范围。

## P10. Task事务和工作树

工作目录模式：Project.workspaceMode 默认为 directory，直接复用所选文件夹，不探测 Git。git-worktree 为显式选择，才解析关联仓库和提交。目录浏览只有 git=true 请求可探测 Git；Git 初始化作为单独、鉴权且可追踪的 Host 命令 project.git.initialize 执行。模式切换必须无活跃会话且成员已停止，原生恢复 ID 不跨模式复用，旧工作树保留。任务 CAS 不代表文件锁，共享目录允许多成员并发工作，由用户决定是否改用 Git 隔离。

原子claim（示意SQL，业务关系先验证）：

```sql
UPDATE tasks
SET status='in_progress', assignee_agent_id=:caller,
    lease_epoch=lease_epoch+1, lease_expires_ms=:expiry,
    version=version+1
WHERE id=:task AND version=:expected
  AND (status='todo' OR (status='blocked' AND assignee_agent_id=:caller));
```

`changes()!=1`返回409并携带最新Task。未完成依赖、无工作区权限先拒绝。相同requestKey重发返原结果，不增加第二次epoch。领取、task.claimed事件、通知原子提交。

人类给Agent领取任务时，创建一个任务分派系统消息 `task:<taskId>:claim:<epoch>` 作为新的primary message，避免原请求先前已投递导致没有新wake。Agent在自己的当前Run领取任务不另开第二Run；更新run.taskId并继续。当一个Run需要多个任务时，v1只允许一个active主任务，其他拆成异步待办。

Task lease默认10分钟，Host每60秒为仍运行且owner匹配的Run续约；控制面只接收对应已登记launch的续约。断线过期变blocked且保留owner，不自动另派；人类重新指派必须先停止旧Owner并确认其工具静止。in_review阶段不需要执行lease，但epoch继续用于拒绝旧执行者变更。

所有依赖添加在事务中做可达性检查，检测反向路径即拒绝CYCLE；仅SQL `task_id<>depends_on_id`不足。任务状态done要求有artifact和验收文本；这些是来源证明，不保证测试本身正确，Reviewer仍必须审查。

## P11. Computer Use生命周期

### 获取和调用

1. Harness启动前Host探测LCU并读取原instructions/public tool schemas；哈希改变使qualification失效。
2. 注册独立MCP server `harbor_computer`，将原instructions纳入本session standing context；工具仍使用上游名js/js_reset。
3. 工具请求到达时从Host active run绑定session/turn，不能让模型填hostTurnId。
4. Host原子获取desktop resource：仅free可分配，epoch+1，owner是launch/run。忙时调用排队最多30秒，超时返回DESKTOP_BUSY和owner概况，模型应让出回合而不是无限等待。
5. 为此Agent保持provider connection，LCU call传`{sessionId:hostSessionId,turnId:hostTurnId}`。有nativeTurnId也另存以审计；Claude无native ID时使用Host逻辑turn ID，不能用每次toolcall随机ID代替。
6. tool请求先登记desktop_calls(executing)和argumentHash再分派；response要保留原content和isError。镜像截图为工件不能更改回给调用者的图片内容。

### 正常停止

root terminal先把Run设draining。等待已知desktop_call返回或取消确认、检查带资源的background tasks。再调用provider endTurn，由LCU适配器按原合同使用`cua.turnEnded({sessionId,turnId,event:'Stop'})`；其他情况映射由provider版本适配测试决定。不确定支持的event不得猜测发送。

cleanup失败、进程失联、原生turn结束后工具排空超时或状态不可证明时设quarantined。即使上游返回result.isError=true，也只能说明本次tool失败，不能据此断言整个provider已经静止。

### 中断/故障

`desktop.stop`是host-only控制：记录stopping意图→取消相关调用/通知上游→请求原生中断→等待terminal和cleanup→最后释放或隔离。用户看到请求已接收后不应看到“桌面已释放”直到有证明。

审批期间execution timeout暂停；10分钟无用户回答默认取消approval并请求终结，UI可延长人工等待（管理员配置而非模型决定）。宿主机锁屏、新系统权限请求或provider native拒绝应保留原错误，不能在wrapper静默视作通过。

`clear_quarantine`必须触发Host检查：不存在仍执行的持有者、原连接关闭/清理有收据、重新打开provider并完成只读健康检查。人类按钮只是请求这一流程，不直接把state改free。检查未通过返回Operation failed/unknown。

### 图片和元素关联

记录截图来源provider/连接/hostTurn/epoch/capturedAt，以及内容sha256。元素序号来自具体上游状态，跨reset/交接不可复用。其他Agent读artifact可得到图片和时间元数据，但没有因此获得活元素索引的操作权。UI展示“历史观察”标签，防止用户误认实时桌面。

## P12. Approval端到端

Host创建pending审批并持久关联nativeRequestId、run、launch、source、argumentHash。控制面落盘并SSE通知。浏览器获取Approval，提交expectedVersion、action、content、scope；服务器检查owner、状态pending、选项属于allowedActions及JSONSchema，不接受客户端自行修改target或参数摘要。

事务将approval变approved/denied/cancelled并创建Host command；状态不立刻叫resolved。Host验证该native请求仍在等待并返回原生形态（Claude allow/deny、Codex native response、LCU elicitation）。只有原生响应投递成功后产生resolved。若进程已换launch返回STALE_APPROVAL，记录unknown/cancelled，绝不把旧授权用到相似的新请求。

两个人类浏览器标签同时回应，只有expectedVersion匹配的一次成功。代理代码里的onElicitation不得返回固定accept。URL授权只呈现原URL并限定scheme；凭据只交给原生认证流程，Atrium Grove不接收密码。表单不支持的schema明确报UNSUPPORTED_APPROVAL_FORM并保留请求，不回空对象伪造用户输入。

## P13. SSE快照与重放

`GET snapshot`在同一read transaction读取当前资源和最大events.seq；返回snapshotSeq。客户端保存workspaceId+cursor（不含敏感内容），订阅`events?after=<snapshotSeq>`；自动重连使用Last-Event-ID。如果两者都存在取合法较新的值，但不能超过服务端最大已提交seq，否则400。

服务端循环查询可见workspace内 `seq>cursor ORDER BY seq LIMIT 500`，逐条发送id/event/data，更新该连接cursor。先查DB再wait通知，等待前再次检查或使用短轮询，默认250ms；这样通知丢失最多影响延迟，不丢事实。15秒心跳不改变cursor。

保留窗口之前的cursor返回410 REPLAY_WINDOW_EXPIRED，客户端重新取snapshot，不将空结果当作没有历史。snapshot需标注本workspace retention frontier，不能以其他workspace的最小seq猜测。客户端重复eventId忽略，按实体version更新，text delta按原关联key附加。工具completed先于对应started出现时先保留待补事件，不丢掉或另造工具。

API分页cursor是base64url(JSON `{version:1,workspaceId,collection,filterHash,lastSortKey,lastId}`)加服务器HMAC。按seq或createdAt+id稳定keyset排序；跨workspace/不同filter重用拒绝。`nextCursor:null`表示本页末尾，不保证后面永远没有新增数据。

## P14. 本地登录、运行配置和权限映射

`pnpm atrium-grove login-token`生成256-bit随机nonce，TTL5分钟。登录页面发送token至auth/exchange；服务端常量时间校验hash、消费nonce、生成cookie与CSRF token。cookie仅传浏览器，不写SSE URL；开发HTTP无Secure标志仅限loopback，任何TLS部署必须Secure。退出会话立刻撤销SSE/REST访问。

Bootstrap creates owner principal+system principal，模型不可拥有owner cookie。WS host bearer独立于owner，不得用于owner REST。relays的短期token保存在受控env/pipe，日志只记录token hash前缀作关联，不能输出明文。

配置优先级：组织/系统原生policy（若存在） > Atrium Grove明确deny > 用户明确许可的profile > 项目指令/skill > peer内容。工具清单必须说明native/project/user/Atrium Grove来源。Codex/Claude权限映射按profile能力检查；不能给不支持的字段传“看起来合理”的字符串。桌面provider不继承全局shell FullAccess作为平台全工具允许。

## P15. 重启、收敛与人工恢复

控制面启动时：迁移→恢复owner配置→暂停scheduler→加载未结束runs/outbox→Host Hello对账→补齐spool→处理可证明的run状态→恢复scheduler。不存在对应Host的run先unknown，不直接重新发turn/start。

Host启动时：取得单实例文件锁→读取launches→核实残留进程身份→把失去stdio的active launch标unknown→取消过期审批→将held/draining桌面隔离→连接controller汇报。不能仅用保存的PID发送kill，必须校验启动时间和可执行路径；不匹配视作PID已重用。

Run reconcile三种结果：已证实running则继续观测；已证实terminal则按native事实投影并清理；无法判断则保持unknown。实际input重复与否无法证明时，人类可以选择终止已验证持有的进程并开启新session，系统必须保存“旧执行结果不确定”的记录。对于副作用任务，再次执行必须新的人类明确命令而非自动重试。

## P16. 错误码与重试分类

| code | 能否自动重试 | 行为 |
|---|---|---|
| HOST_OFFLINE / PROVIDER_UNAVAILABLE | 未分派意图可以延后 | 不创建新native请求 |
| VERSION_CONFLICT / TASK_OWNED | 否，需重新读取 | 不偷偷覆盖当前owner |
| INPUT_REJECTED_BUSY | 仅在明确未接受时可回队列 | 保留原delivery，避免重复预算 |
| SUBMISSION_UNKNOWN | 否 | Run unknown，reconcile |
| STALE_LAUNCH / STALE_APPROVAL | 否 | 关闭旧绑定，不向新会话投递 |
| DESKTOP_BUSY | 允许未来新turn重试 | 当前Agent结束等待，不占另一资源死等 |
| DESKTOP_STOP_UNCONFIRMED | 否 | quarantine，不授予下一epoch |
| NATIVE_SCHEMA_MISMATCH | 否 | profile unqualified，重新验收 |
| BUDGET_EXHAUSTED | 仅人类增加预算 | 消息保存、调度暂停 |
| SPOOL_CAPACITY / DISK_FULL | 否直到运维修复 | 背压、有序停止，不能删未ack事实 |
| AUTH_REQUIRED / MODEL_UNAVAILABLE | 人工/配置修复 | 不无限重启或切换账号 |

错误码正文给开发者可操作原因，原生错误需脱敏保留。在没有可靠终态时默认unknown，而不是将所有异常吞成“可能仍在运行”的普通文本成功响应。

## P17. 五Agent配置导入

`examples/team.yaml`是平台导入格式，不是原生Codex/Claude配置。导入器验证schemaVersion、Agent名称唯一、channels引用存在、policy上限和capabilities白名单。`${NAME}`仅由显式vars JSON逐值替换，不执行shell，不读取任意env；未替换、示例REPLACE占位、无效路径、模型未验证均使导入在产生副作用前失败。

先执行完整dry-run验证和Host probe，再用一个控制面事务创建workspace/project/agents/channels/member映射；Host worktree创建通过outbox逐项执行。部分worktree失败保留可见failed Operation，Agent保持stopped，允许重试相同意图；不能删掉成功worktree中的文件来伪装整个导入未发生。

capability至工具映射：collab.read→context/read/inbox/ack，collab.post→post；task.read→list/get，task.create→create，task.claim→claim，task.transition→状态迁移，task.review→指定Reviewer完成验收；artifact.read/register、memory.propose分别对应同名工具；仅 desktop.request 开启且 profile 为 auto-approve/full-access 才暴露独立 harbor_computer 的公共工具。开关默认关闭，其他模式包括旧 desktop 均不提供此入口。最终许可同时要求profile及capability通过，capability不能扩大原生deny。

`GET /v1/runs/{runId}/events`提供分页的RuntimeTraceRecord；初次Run详情先读持久trace，再通过workspace SSE去重接续。Run返回contextDigest/contextArtifactId/finalMessageId，便于查看准确的输入与公开输出，不让WebUI访问Host原生log路径。

## P18. 控制动作的精确语义

workspace.pause和agent.pause均停止**新Run的调度**，当前Run继续并可完成清理；UI必须提供单独Stop而不是让Pause暗中kill。agent.stop请求当前Run中断、确认静止后关闭进程，保留原生session与worktree；reset_session要求先stop成功再新generation。resume仅恢复调度，不能绕过unknown/待清理锁。episode.close停止新因果投递，既有Run有序结束；已发出的消息不删除。

RunControl.reconcile只读探测，不计新turn，不返回制造的success。steer必须带非空text；interrupt/reconcile不带text。对terminal Run的interrupt返回幂等已终止状态；不发另一个native interrupt。steer在native不支持时422，不退化为静默丢弃。

controllerEpoch变化后，已收到的Host命令以原commandId返回日志事实。Host证明从未收到且日志完整的旧意图可由controller取消旧command并创建新epoch意图；若日志缺失/损坏，不能以“没查到”证明未执行，保持unknown。已issuing命令无论epoch变化均不重发native副作用。

## P19. Native权限映射基线

Codex以本机binary生成的schema为准。枚举必须由本机binary生成的schema验证。0.157.1的实机生成结果为`untrusted`、`on-request`、`read-only`、`workspace-write`；早期调研中的camelCase示例不适用于此binary。不能仅根据CLI拼写猜测RPC枚举。[R04] 基线配置如下：

| Atrium Grove profile | Codex native基线 | Claude native基线 |
|---|---|---|
| review | approvalPolicy=untrusted，sandbox=read-only；禁止未授权升级 | permissionMode=default；PreToolUse拒绝写工具和未经验证的有副作用shell |
| workspace | approvalPolicy=untrusted，sandbox=workspace-write；writableRoots仅本worktree，network默认false | permissionMode=default；仅明确批准规则，PreToolUse边界检查，其他canUseTool |
| desktop（旧） | 保留旧文件策略；不提供 Computer Use | 保留旧文件策略；不提供 Computer Use |

thread/start的`sandbox`与turn/start的`sandboxPolicy`结构不能混用；beta named`permissions`与legacy`sandbox`不可同时传。若本机受managed requirements约束，取更严格结果，无法满足要求则unqualified。只读sandbox并不默认表示“只能读本项目”；需要限制读取范围时显式配置支持的readOnlyAccess，并测试UDS/MCP relay仍可连接。

首次开发可运行`codex app-server generate-ts --out <dir>`与`generate-json-schema --out <dir>`生成原生契约，记录binary hash。[R04] 不暴露`thread/shellCommand`或实验性process/spawn给模型作为普通工具替代，这些client侧接口可能不继承线程sandbox。平台自己管理worktree所需Git命令也只接收结构化argv，不借此执行模型任意shell。

Atrium Grove Session.nativeSessionId在Codex driver中定义为**用于resume的thread.id**；原生thread.sessionId（原生会话树root）如不同，单独存于native metadata，不用它覆盖resume key。v1每Agent新建root thread，不实现跨Agent共享fork树。Claude driver中的同字段保存原生Claude session ID。

## P20. 公开事件目录

`domain.schema.json`的Event通过type条件验证payload；不允许服务端在同名事件随意换格式。所有entity更新发送完整、可序列化、脱敏的DTO，UI按version或事件seq替换，避免前端重复实现服务端状态机。

| event.type | payload字段与类型 |
|---|---|
| workspace.updated / host.updated / agent.updated | workspace:Workspace / host:Host / agent:Agent |
| session.updated / channel.updated / thread.updated | session:Session / channel:Channel / thread:Thread |
| message.created / delivery.updated | message:Message / delivery:Delivery |
| episode.updated | episode:Episode |
| run.scheduled / run.updated | run:Run |
| run.trace | record:RuntimeTraceRecord |
| task.created / task.claimed / task.updated | task:Task |
| approval.updated | approval:Approval |
| artifact.created / memory.updated | artifact:Artifact / memory:Memory |
| desktop.updated / operation.updated | desktop:Desktop / operation:Operation |
| diagnostic | error:Error（脱敏） |

`run.trace.record.payload`保存归一化RuntimeEvent的body，不包含secret和无限大native附件；body的kind与record.kind相同，TypeScript EventBody是它的静态合同。纯raw native未知帧只返回本地reference诊断，不把全部未审计对象暴露给浏览器。

同一Host投影给多个workspace时分别验证可见性、分别产生workspace scoped event，不能让一个workspace看到其他项目的进程细节。operation通过关联的workspace发布；host.probe无workspace context时由HTTP轮询operation/inventory，不向所有workspace广播无关配置。


### 成员删除

`DELETE /v1/agents/{agentId}` 使用 `expectedVersion`、CSRF 和幂等键。删除成员预设会移除所有对话参与关系、撤销尚未派发的投递与待回复关系，并关闭空闲原生会话。正在运行、会话状态未稳定，或仍负责任何未完成任务（执行或审核）的成员不能删除。历史消息、运行、任务和工作文件保留；已删除的成员不得重新参与或被调度，同名新预设使用新的身份。

---

# 第三部分：源码调研

# 源码调研、取舍与证据边界

**检索日期：2026-10-09。** 下列结论来自实际读取的仓库文件、定向源码片段与官方协议文档，不代表已运行全部项目、完成安全审计或在用户的Mac上做过兼容性测试。sources.json记录每项的commit/文件和检查深度。

## 1. Raft：最重要的参考是协作操作系统，而非多角色Prompt

审阅快照：`26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6`，发布标记`v1.21.2-source.1`，2026-10-06。README把Server、Web、CLI、Daemon、Computer和共享契约明确分层，Agent是拥有身份、记忆、能力范围的持久参与者，而非临时函数调用。[R01]

| 实际阅读区域 | 源码给出的信号 | Atrium Grove采用的具体设计 |
|---|---|---|
| `packages/daemon/src/drivers/types.ts` | persistent与per_turn lifecycle；原生投递、错误、telemetry、诊断分开 | Runtime contract显式声明，不以一组模糊boolean推断会话行为 |
| `packages/daemon/src/apmStateMachine.ts` | 输入事实、状态转换、effects、activity投影分离；compaction/review期间投递门控 | 纯状态机决定副作用，Host executor执行；不从UI状态触发native调用 |
| `packages/shared/src/externalAgentIntegration.ts` | 投递证明分层、各证明有来源权威，cursor并非socket收到就推进 | Delivery evidence独立记录，不把CLI成功响应叫“模型已读” |
| `packages/server/src/services/agentInboxEvents.ts` | 投递时重新检查目标权限，刷新任务投影；保留sender原类型 | 队列不是永远可信的旧快照，dispatch前再做版本/权限检查 |
| `packages/daemon/src/drivers/cliTransport.ts` | per-launch wrapper、本地credential proxy、启动身份保护 | stdio relay绑定身份，能力不是请求参数自报 |
| `manual/recipes/technique/task-claim-lock.md`、claim命令 | 先claim再执行；重复创建任务不会获得同一个锁 | canonical sourceMessageId唯一、任务CAS；失败禁止执行 |
| `packages/web/src/store/taskStore.ts` | task revision、keyset分页、连接generation；空但已加载是有效状态 | UI不用“非空数组”判同步成功；旧连接返回的snapshot不可覆盖新状态 |
| `packages/sync-core`及notification定向片段 | 重放、producer冲突、超出窗口显式失败 | 持久seq/SSE重放、duplicate去重、410快照重建 |

[R01]中的Raft使用更多完整产品组件。Atrium Grove保留这些不变量，但主动缩小运行栈：单用户本地SQLite、REST+SSE、单Host。没有必要为五会话复制Raft所有商业集成、移动客户端、历史兼容层和多种runtime form。

任务模型也做了有意区别：Raft已经历message-based task等演化；Atrium Grove用独立tasks表+唯一source_message_id建立稳定映射，不复制旧模型迁移负担。事件日志是同一事务发布记录，不把所有状态都重构成完整event-sourcing系统。

### 许可证不能略过

Raft该版本的LICENSE是FSL-1.1-ALv2。条款明确列出内部使用、非商业教育/研究等允许用途，并对向他人提供具有替代/相似功能的商业产品或服务作出限制；每版本两周年以后才获得未来Apache许可。[R02] 因此“复刻相似产品”不能简单等同“全部源码可按Apache直接复制”。

本规格提供独立的数据模型、协议和实现顺序，不包含Raft源代码搬运。实际复制文件、改造fork、对外发布或服务化时，应保留许可和来源，并针对预期用途确认授权；不能据本规格推断独立重写天然排除了所有知识产权问题。这里给出条款事实和工程分离策略，不作法律保证。

## 2. OAR：很有价值，但不能无条件当作默认执行层

审阅快照`7dc98e08f9c0ba99158ddada29cb0d4c80ef7dc6`，OAR 0.45.1。README与源码显示统一Session/records/events、输入控制、用量投影、脚本测试运行时。它将native child归入agentPath，并保留raw native facts，这些都很适合Atrium Grove的Run详情和conformance测试。[R03]

但是`packages/oar/src/runtimes/claude/launch.ts`当前明确传入`--dangerously-skip-permissions`。`session.ts`的heldQueue在内存中，不能承担控制面崩溃后的持久投递。文档还明确提示：prompt接受、用户消息echo、模型消费是不同证据。[R03]

因此相较此前概念讨论，实施结论需要收紧：**OAR是重要参考与可选适配候选，不是无需审核的“安全、持久、全能力统一层”。** Atrium Grove默认直接接Codex App Server与Claude官方SDK，自己拥有权限和队列合同。未来OAR消除这些限制或使用经审计的配置/补丁后，也必须通过统一测试再启用。

OAR的Apache-2.0与Raft FSL分别处理，不能因为同一组织就假定许可证一样；也不能把OAR宣称支持某runtime当成该用户机器已通过兼容性验证。

## 3. Codex：使用原生App Server，而不是包装TUI

官方文档给出初始化、thread管理、turn控制、流式items、权限请求等接口；源代码定向检索确认`mcpServer/tool/call`确实有协议类型和服务端dispatch，不仅存在于第三方README。[R04,R05]

Atrium Grove依赖核心thread/turn生命周期；direct Computer Use broker才需要额外的MCP direct-call路径。普通App Server能力与实验性扩展需要分别探测，不能笼统把整个App Server叫“实验接口”，也不能因为其中一个方法公开就承诺原版桌面组件对所有CLI可用。

原生响应与CLI签名/权限/组件布局是不同问题。Spec不硬编码某份Homebrew或app-bundled二进制必然成功，而是把路径、hash、native schema、auth状态、一次真实运行纳入ExecutableProfile验证。模型catalog不等于entitlement；当前用户实际可用模型必须测试。

## 4. Claude：SDK仍保留真实Harness，且适合WebUI审批

官方说明Agent SDK运行Claude Code二进制，暴露其工具、会话、hooks与权限，而普通Client SDK只提供模型API。[R06] 这满足用户“两份Claude Code CLI会话”的要求，不是将原Harness换成自行编写的agent loop。

采用稳定`query()`流式输入与会话恢复路径，不采用被文档标为removed的TypeScript V2 API。`pathToClaudeCodeExecutable`在官方公开仓库的CHANGELOG中也有证据。[R07,R09,R17]

权限是关键：`canUseTool`用于原生需要询问人类的调用，已经自动允许的工具不一定进入该回调；每次调用必须执行的控制应使用`PreToolUse`。[R08] 因此Atrium Grove把policy检查与Approval Center分开，而不是仅挂一个审批回调就宣称所有工具都受控制。

SDK行为受system prompt、settingsSources/项目设置、插件与工具配置影响。Atrium Grove要求preserve preset + append，不抹除原生指令，也不默默加载全部个人工具。原生引擎本身并未完整公开；本次没有声称读过其私有实现。[R10,R11,R17]

### 登录和使用范围

截至检索日，Claude帮助中心对SDK、`claude -p`和第三方应用使用订阅的说明有2026-10-07更新；SDK overview仍保留面向第三方提供claude.ai登录/额度的限制。[R06,R18] 这不应被简化成“SDK绝对只能API Key”或“商业产品都能任意继承订阅”。Atrium Grove v1只使用用户本机已授权的原生profile，不实现供应商登录转售或共享token；公开发布的认证方案另行复核。

## 5. LCU：原版Computer Use的Harness适配层

审阅快照`45e5a917e768edddb5c1b6fe737b7cdddc9cbebe`。README、ADAPTERS通用client合同及`adapters/client.mjs`表明：LCU复用本机安装的原版Computer Use runtime，shared client管理连接、授权和生命周期，不由LCU重新实现截图/输入引擎。[R12]

三个必须保留的实现点：初始化instructions不是可有可无的说明文字；js/js_reset tool schemas必须和本机版本一致；turnEnded是host职责而不是模型可自行调用的清理按钮。上游结果content与isError也不能被变成一段不分类型的字符串。

通用client已有`onElicitation`，所以Atrium Grove可以接自己的WebUI，而不必为了审批先安装面向Claude原生UI的mod。client中的approval gate会暂停执行deadline，避免人类尚未决定就误杀工具；这被纳入Atrium Grove的独立approval等待时钟。

LCU连接支持不等于真实桌面验收；Mac架构、本机组件、系统授权、窗口/应用行为仍须测试。Bridge的MIT许可不改变上游原版组件的条款，Atrium Grove发布包不复制或分发这些原版组件。

## 6. Direct Computer Use MCP：可替换底层，不当作无门槛主路径

审阅`dc72bae614dccd01ef9d0ffd8fdcfd42c990fc78`。README及direct-broker/test定向片段确认使用thread/start→mcpServer/tool/call，不需第二个模型做动作规划，并显式检查model-turn activity。[R13]

但其README同样明确：内部Full Access，不额外提供应用白名单或动作门控，依赖签名原生组件和可能变化的实验性通路。其价值是架构简洁与可验证的direct dispatch，而不是等同LCU的全部权限/生命周期功能。Atrium Grove把它列为可选Provider，由网关补授权、独占、停止确认，并独立验证工具列表；不暗中替换默认上游。

## 7. 为什么不把OpenCLI/CDP作为主依赖

此前已分析OpenCLI的Desktop会话选择、输入框提交和DOM读取。此次Spec不依赖那一路径，所以没有将OpenCLI当前版本列作必需的源码锁定项。消息已提交DOM与完整native turn结束之间存在设计层面的不对称；现在用户核心需求是并行真实CLI与Computer Use工具，不需要承担Desktop聊天UI所有权问题。

同理，`codex queue`、Desktop内建connector和任意活动Thread附着，都不是v1持久Agent总线的底层。它们未来可以作为额外AttachedSessionAdapter，但不能改变核心确认、scope和幂等语义。

## 8. 结论与尚未声称完成的事

已经有源码支持的结论：Raft式持久协作架构适用；Codex/Claude具有可编程原生会话接口；LCU有自定义host接入合同；direct broker存在；OAR默认权限路径不能照搬。

尚未完成且必须作为项目验收的事项：用户机器的五原生会话并发、特定账号和模型可用性、LCU组件兼容、WebUI授权回传、原版Computer Use取消/清理、长时间故障恢复。Spec通过预先固定接口和失败状态，使这些验证可以在开发过程中执行，而不是把未知项藏在“肯定能跑”的结论里。

## 来源索引

完整commit与文件清单见 `sources.json`。下列链接为源码/官方技术文档，不是服务购买渠道。

**[R01] Raft** — https://github.com/botiverse/raft-source/blob/26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6/README.md

锁定源码：`26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6`。文件：`README.md`、`LICENSE`、`packages/daemon/src/drivers/types.ts`、`packages/shared/src/externalAgentIntegration.ts`、`packages/daemon/src/drivers/cliTransport.ts`、`packages/daemon/src/apmStateMachine.ts`、`packages/web/src/store/taskStore.ts`、`packages/server/src/services/agentInboxEvents.ts`。

**[R02] Raft task and replay** — https://github.com/botiverse/raft-source/blob/26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6/manual/recipes/technique/task-claim-lock.md

锁定源码：`26f77ef97c40d3d91aa2c5e42b0fd66b8bf39fe6`。文件：`manual/recipes/technique/task-claim-lock.md`、`packages/cli/src/commands/task/claim.ts`、`packages/server/src/services/nativeNotificationService.ts`、`packages/sync-core/src/domains/activity.ts`。

**[R03] OAR** — https://github.com/botiverse/oar/blob/7dc98e08f9c0ba99158ddada29cb0d4c80ef7dc6/README.md

锁定源码：`7dc98e08f9c0ba99158ddada29cb0d4c80ef7dc6`。文件：`README.md`、`docs/runtimes/claude.md`、`packages/oar/src/runtimes/claude/session.ts`、`packages/oar/src/runtimes/claude/launch.ts`。

**[R04] Codex App Server** — https://learn.chatgpt.com/docs/app-server

**[R05] Codex protocol source** — https://github.com/openai/codex/blob/2351d9e1b608e6f9d9a3699b71d7eb39ee41cfa4/codex-rs/app-server-protocol/src/protocol/common.rs

锁定源码：`2351d9e1b608e6f9d9a3699b71d7eb39ee41cfa4`。文件：`codex-rs/app-server-protocol/src/protocol/common.rs`、`codex-rs/app-server-protocol/schema/typescript/v2/McpServerToolCallParams.ts`、`codex-rs/app-server/src/message_processor.rs`。

**[R06] Claude Agent SDK overview** — https://code.claude.com/docs/en/agent-sdk/overview

**[R07] Claude CLI** — https://code.claude.com/docs/en/cli-reference

**[R08] Claude approvals** — https://code.claude.com/docs/en/agent-sdk/user-input

**[R09] Claude streaming input** — https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode

**[R10] Claude system prompt** — https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts

**[R11] Claude MCP** — https://code.claude.com/docs/en/agent-sdk/mcp

**[R12] LCU** — https://github.com/amontlabs/lcu/blob/45e5a917e768edddb5c1b6fe737b7cdddc9cbebe/README.md

锁定源码：`45e5a917e768edddb5c1b6fe737b7cdddc9cbebe`。文件：`README.md`、`docs/ADAPTERS.md`、`adapters/client.mjs`。

**[R13] Direct Computer Use MCP** — https://github.com/tmustier/codex-computer-use-mcp/blob/dc72bae614dccd01ef9d0ffd8fdcfd42c990fc78/README.md

锁定源码：`dc72bae614dccd01ef9d0ffd8fdcfd42c990fc78`。文件：`README.md`、`src/direct-broker.ts`、`test/direct-broker.test.ts`。

**[R14] MCP transport specification** — https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

**[R15] SQLite WAL** — https://sqlite.org/wal.html

**[R16] Official Computer Use** — https://learn.chatgpt.com/docs/computer-use

**[R17] Claude Agent SDK public repository** — https://github.com/anthropics/claude-agent-sdk-typescript/blob/da321bbe62ed45d10a1ff0e77a948253d9eee3e0/CHANGELOG.md

锁定源码：`da321bbe62ed45d10a1ff0e77a948253d9eee3e0`。文件：`CHANGELOG.md`。

**[R18] Claude SDK subscription and third-party usage** — https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

---

# 第四部分：验收标准

# Atrium Grove 1.0 — 验收标准、故障矩阵和实机门禁

所有用例必须保存：app commit、包锁hash、host架构、native可执行路径/hash/version、model ID、settingsProfile、provider版本及instructions/tool schema哈希。fake测试通过不证明native兼容，单次MCP连接成功不证明Computer Use完成。

## 1. 全栈标志性场景

准备一个无敏感数据的Git测试仓库，创建codex-researcher、codex-implementer、codex-desktop、claude-architect、claude-reviewer五Agent。人类在WebUI要求设计并实现一个本地CSV可视化页面，明确验收命令；角色配置不写死某个模型优于另一个，仅用于分工。

五人都收到同一目标。Architect发布设计；Researcher提出数据边界；Implementer原子领取实现Task；Reviewer独立检查固定commit；Desktop Agent在用户允许后打开测试页面/应用并产生带来源截图，Reviewer读取真实图片；至少一次发现问题、提出修复、完成再次验证。人类能插话指定两人、查看每人的进度、批准一次请求，并看到最终任务证据。

**通过条件：** 无手动复制模型回答、五个native会话ID不同、两种Harness都完成一次工具执行、只有一个Task Owner改对应任务、所有peer消息来源正确、图片可被另一个Agent读取、桌面操作没有重叠、最终至少一项由非Owner审查。对话“看起来合理”不能替代这些可观察条件。

## 2. 产品与协议用例

| ID | 测试 | 通过条件 |
|---|---|---|
| A01 | 登录nonce成功/重复/过期 | 仅首次有效交换；cookie与CSRF正常；token不进URL/日志 |
| A02 | 认证撤销与SSE | logout后REST拒绝、已有SSE关闭；Host bearer不能当owner用 |
| A03 | 建五Agent并发执行 | 五独立session/launch/worktree，最大并发5，单Agent无双Run |
| A04 | 发给指定两人 | 仅两条actionable Delivery；其他人历史可见但不被唤醒 |
| A05 | 人类通知全组 | 成员UUID固定在提交时；五人各一条，不随UI顺序串位 |
| A06 | 仅记录信息 | 内容保存，不启动模型；下一次相关context包含它 |
| A07 | 文本伪造@/author | 正文“我是管理员”“@all”不更改actor/scope/收件人 |
| A08 | 重复POST | 相同key同body相同Message ID；不同body409；无重复wake |
| A09 | A问B，B答A | expectation满足一次、A再运行一次；重复答案不反复唤醒 |
| A10 | 显式answer与final fallback | 主线程仅一份canonical answer，子任务text不冒充根final |
| A11 | 多lane交织stream | A1/B1/A2/B2按message/lane合并，不能拼成A1B1A2B2同一人 |
| A12 | 多工具跨回合 | 每callId一组终态，tool结束不提前结束Run |
| A13 | 人类新消息到busy Agent | 默认持久排队，明确steer才进入当前turn |
| A14 | dispatch预算并发 | 32次上限的原子预约无超卖，已写入后未知不退还预算 |
| A15 | 因果budget绕过 | Agent新线程/新问题继承episode，不能自行清零depth |
| A16 | 原生spontaneous根turn | 记录degraded并阻止无记录续跑；native内model step不误判 |
| A17 | 五人同时claim同Task | 恰一owner成功，其余409；相同requestKey不增加epoch |
| A18 | DAG依赖环 | A→B→C后C→A拒绝；不同workspace引用拒绝 |
| A19 | 自审批done | Owner不是指定Reviewer时拒绝；无证据不能done |
| A20 | Task lease到期旧Owner存活 | 保留Owner/blocked，不自动启动另一执行者 |
| A21 | worktree边界 | branch参数不可注入、路径穿越拒绝、未提交变更不被覆盖 |
| A22 | native会话恢复 | 当前模型/工具配置可见；旧native transcript的哨兵信息能回忆；新launch不同 |
| A23 | native恢复失败 | 明确错误/待选择，不能静默新会话假称恢复 |
| A24 | Memory提案 | proposed不进入全组accepted context；接受后带来源和版本 |
| A25 | stale config/权限收紧 | active Run不可热改为另一profile；新session才应用并有事件 |
| A26 | 图片工件 | MCP返回可视image block，另一Agent辨识人工生成的测试图；不是仅拿路径 |
| A27 | artifact权限/路径 | 越workspace、symlink越根、file://注入、HTML执行均拒绝 |
| A28 | 长列表UI | 100k消息分页、不一次拉全部trace；空已加载正确显示 |
| A29 | SSE replay重叠 | DB提交/订阅切换/重复发送无漏消息、无重复视图 |
| A30 | replay过期 | 410触发snapshot重建，不显示空状态覆盖现有内容 |
| A31 | 旧连接snapshot迟到 | connection generation不匹配不得覆盖新状态 |
| A32 | usage delta/cumulative | 累计重复事件不重复求和；未报告不是0美元/0token |
| A33 | approvals双标签 | 一个expectedVersion成功，另一个冲突，不二次执行工具 |
| A34 | 已批准工具绕过callback | PreToolUse仍执行deny策略；测试不能只验证canUseTool |
| A35 | native请求过期后批准 | 拒绝STALE_APPROVAL，不把旧许可给新launch |
| A36 | LCU instructions透传 | 首次工具调用前模型context存在与provider匹配的hash；js schema与上游一致 |
| A37 | host-only工具隐藏 | 模型tools/list无turn_ended/set_turn_context/模块目录管理 |
| A38 | 不支持provider schema | 明确unqualified，禁止猜参数；不静默切换direct provider |

## 3. 故障注入用例

| ID | 注入位置 | 通过条件 |
|---|---|---|
| F01 | 写message后、commit前崩溃 | message、delivery、event均不可见 |
| F02 | commit后、HTTP响应前崩溃 | 重试同key返回原ID，无第二次预算/wake |
| F03 | command送出后receipt丢失 | 重发相同commandId只返回收据，native submit一次 |
| F04 | Host issuing落盘后、stdin写入附近崩溃 | 不确定窗口进入unknown，不能自动二次submit |
| F05 | native终态event上送后ack丢失 | spool重传、数据库source去重、UI终态一次 |
| F06 | 控制面重启，Host仍运行 | 原Run继续，spool补齐；无重复开session |
| F07 | Host重启但CLI残留 | PID+启动时间验证；不能kill用户其他codex/claude进程 |
| F08 | event序号缺口 | 请求缺失事件、停止推进连续ack；相同seq不同payload隔离 |
| F09 | 无输出的长工具 | 只显示暂无进度，不提前completed；可人工interrupt |
| F10 | native审批中断线 | 不自动approve；恢复时仍关联原请求或标unknown |
| F11 | Native terminal已到，GUI call仍执行 | Run draining且desktop held，不能启动下一桌面Owner |
| F12 | 桌面stop仅收到ack | UI stopping，不误称已停止；无cleanup证明则quarantine |
| F13 | 租约TTL过期后旧操作返回 | 不因TTL给新Agent；旧epoch请求被拒绝，旧执行副作用审计保留 |
| F14 | Host失联且用户继续操作桌面 | 重新observe后再执行，不复用旧元素序号 |
| F15 | disk full/spool上限 | 背压与明确错误，未ack事件不删；禁止无日志新任务 |
| F16 | LCU原版组件热更新 | 指纹变化使qualification失效，旧连接不热迁移 |
| F17 | SDK返回未知native事件 | raw诊断保留，不伪造state transition |
| F18 | 原生cancel失败 | interrupted不提前确认，资源保持隔离 |
| F19 | 工件文件写好、DB失败 | 不返回已登记；GC清孤儿，现有引用不损坏 |
| F20 | 备份/恢复 | 一致DB+工件manifest，恢复后校验hash、schema、未完成工作unknown |

F01/F02/F03/F04/F05/F11/F12/F13必须使用确定性fake runtimes自动化，并在真实环境做适当小规模抽样。禁止用sleep固定毫秒数作为唯一完成条件；测试等待事件及状态不变量。

## 4. 原生资格门禁 Q0–Q4

### Q0 — 环境和身份

本机记录Codex/Claude二进制realpath、版本、hash、架构、settings profile和模型；完成最小“返回随机nonce”请求，验证模型真实可用。账号、模型失败必须显示auth/model原因，不重新注册其他账号。SDK绑定的真实binary必须与profile一致。

同时获取LCU provider的version/runtimeFingerprint/instructionsSha256/toolSchemaSha256。尚未安装组件时状态unavailable，基础WebUI可运行，但Q3未通过，不可标记整项目complete。

### Q1 — 五会话与恢复

三个Codex、两个Claude各记住不同随机哨兵，同时调用只读项目工具并完成一个简单任务；第二轮要求返回各自哨兵和所属worktree。全部不同且正确。关闭一个idle session进程并resume验证；一次主动interrupt确认native终态。明确观察CLI/SDK确实是两种真实Harness，不能仅让fake返回不同名字。

### Q2 — 授权与scope

建立一个会触发人工授权但不造成危险后果的测试文件操作。用户拒绝后文件状态不变；允许一次后执行一次；通过WebUI审批，原生终端不需要手动操作。对已auto-approved工具设置PreToolUse deny，仍然被拒绝。

Computer Use首次访问专用测试应用时显示原版应用请求；拒绝后不能通过wrapper自动成功。模型发出的假批准JSON、不带ownerCSRF的HTTP、旧launch审批均无效。

### Q3 — 真实Computer Use

使用专用临时TextEdit文档或测试窗口，里面包含随机文字和简单颜色方块；避免私人聊天、账户页面和业务交易。由Codex Agent观察、经用户允许输入测试nonce、重新观察；将截图作为artifact给Claude reviewer读取确认；然后反向由Claude通过同一个网关完成一个独立操作。此过程证明两个Harness都能直接用provider，而非Claude暗中委托另一个模型。

记录provider的模型turn计数（可观察时），验证网关本身不主动启动嵌套Codex推理。两个Agent同时申请桌面时，日志无重叠owner和无交叉元素句柄；第一名结束且cleanup确认后第二名才能操作。

### Q4 — 故障和清理

测试原生回合完成与桌面cleanup分离；测试用户在运行时Stop；测试UI断线、控制面重启、Host异常退出各一次。无法确认停止时必须quarantine。只有Host能够证明静止并健康检查成功后清除隔离。恢复旧任务不能未经新的人类指令重放不确定的点击/输入。

## 5. 交付验收清单

交付仓库须包含lockfile、DB迁移、native compatibility manifest、所有A/F自动化结果、Q0–Q4实机报告、同一fixture的屏幕录像或截图工件、运维README及许可证清单。报告明确列通过、失败、未测，不把未测写成通过。仅提供mock或OpenAPI服务器不能算满足用户的完整需求。

本规格包附带的`validation-report.json`只验证规格自身结构、SQL约束和样本；不是上述产品用例的执行报告。

## 6. 补充必须通过的控制边界用例

**A39：审批宿主不可自动化。** 人类登录Atrium Grove的浏览器/宿主应用不得被同组Computer Use Agent操作；已有持久授权必须在资格检查中发现。以同浏览器不同profile作为隔离方式不通过。若底层无法验证禁止访问，desktop write保持unqualified，而不是默认为安全。

**A40：Pause与Stop不混淆。** Pause后现有任务可继续但不派新任务；Stop先进入中断/清理状态，再确认关闭。UI必须准确展示这两种动作。

**A41：Native profile字段。** 使用本binary生成的schema验证JSON枚举；将本binary schema不接受的权限枚举传到RPC时测试失败；named permissions与sandbox互斥。

## 7. 工作目录模式补充验收

- 普通文件夹、Git 仓库及仓库子目录在未勾选 Git 模式时，目录浏览和成员启动均不执行 Git 命令，实际 cwd 为所选目录。
- Git 模式能关联父级仓库；显式初始化创建首个提交并尊重 .gitignore，重复请求不重复提交，不推送远端。
- 旧配置迁移保留原工作树；切换模式时有活跃会话则拒绝，停止后允许切换，原生会话不跨模式恢复。
- 五个成员可在同一普通目录中运行；界面说明无文件锁，不使用任务 claim 或 Git 索引锁宣称文件互斥。

---

# 第五部分：工程任务

# 首轮可分派工程任务

本表给实现团队提供可直接开issue的顺序。每个任务的完成条件是对应契约和测试，不以“写了主要代码”作完成依据。先落contracts和fake runtime，再允许多个实现Agent并行工作；每人独立worktree。

| ID | 依赖 | 具体输出 | 验收 |
|---|---|---|---|
| W01 | 无 | pnpm workspace、TS严格模式、CI、契约生成器、SQLite迁移工具 | 本包21项检查可在新仓库复现 |
| W02 | W01 | owner bootstrap、login nonce、cookie/CSRF、loopback listener | A01/A02，token无日志泄漏 |
| W03 | W01 | domain command handlers、幂等表、事务events、分页cursor | A08、F01/F02 |
| W04 | W03 | Host enrollment、WS frame验证、outbox/receipt/spool | F03/F05/F06/F08 |
| W05 | W01 | fake Codex/stdout、fake Claude Query、fake desktop oracle | 可脚本化busy、interleaving、审批、cleanup hang |
| W06 | W03/W04/W05 | Agent/Session/Launch/Run状态机与scheduler | A03/A11–A16、F04/F09 |
| W07 | W04/W05 | Codex App Server driver、native schema生成与profile probe | Q0/Q1的Codex部分，A41 |
| W08 | W04/W05 | Claude SDK driver、Query输入和root/child归因 | Q0/Q1的Claude部分，A22/A23/A34 |
| W09 | W03/W04 | stdio MCP relay、BoundToolCaller、13协作工具 | A04–A10、A07伪造身份拒绝 |
| W10 | W03/W06/W09 | ContextBuilder、持久inbox、peer expectation、预算与memory | A06/A09/A14/A15/A24 |
| W11 | W03/W04/W09 | Worktree服务、Task CAS/DAG、artifact导出和读取 | A17–A21/A26/A27、F19 |
| W12 | W02/W03/W05 | WebUI聊天/Agent roster/Run trace/SSE reducer | A28–A31；不依赖真实模型即可演示 |
| W13 | W02/W04/W07/W08 | Approval Center、native request映射、失效/双标签 | A33–A35、Q2 |
| W14 | W04/W05/W13 | Computer Gateway、LCU custom client、epoch/cleanup/quarantine | A36–A39、F11–F14/F16/F18、Q3 |
| W15 | W06/W07/W08/W14 | reconciliation、pause/stop/reset、配置更新与背压 | A25/A40、F07/F10/F15/F17、Q4 |
| W16 | W10/W11/W12/W13/W14/W15 | 初始化向导、team导入、备份诊断、完整五人场景 | 标志性场景、F20及完整A/F/Q报告 |

建议并行边界：W07与W08分别交给两个原生driver实现者；W12可独立用fake事件开发；W14先用mock provider写租约与审批再接LCU。W03/W04/W06的共享状态机由一名整合者维护，其他Agent只提交版本化契约变更，不能各自修改同一接口后在末尾拼接。

最终集成必须有一位没有实现核心模块的Reviewer根据ACCEPTANCE逐条复核，尤其是不确定提交、被取消但仍运行的工具、同一桌面旧epoch晚到等情况。所有能力声明都需来自profile gate，不从模型回答“我有这个工具”推断。
