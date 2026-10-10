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
