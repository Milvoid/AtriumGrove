# Atrium Grove 开发对齐与准备情况

基准日期：2026-10-09。规格版本：1.0.0。当前结论：产品范围与架构足以启动基础开发；跨进程契约有若干缺口，应在依赖模块接入前补齐。完整产品交付仍以真实五会话和 Computer Use 验收为准。

本轮已完成阅读、结构复核、本机工具版本探测和开发拆解。应用实现尚未开始，原始规格未修改。本文中的补齐方案为工程提案，正式采用时须同步 ADR、契约和测试。

## 产品目标与交付边界

用户在本地 WebUI 中管理持久的 Agent 团队：发目标、指定收件人、讨论设计、领取任务、交换代码和图片证据、独立评审，并处理工具与应用授权。浏览器关闭后，已接受的任务仍可运行。

五名参与者必须是三个真实 Codex App Server 会话及两个通过官方 Agent SDK 驱动的真实 Claude Code 会话。平台负责协作身份、任务、消息和生命周期，各 Harness 保留自己的推理、工具循环、压缩与原生上下文。

v1 的完整范围包括聊天及线程、13 个协作工具、持久 inbox、异步问答、任务 CAS 与依赖图、独立 worktree、工件与共享记忆提案、审批中心、桌面网关、恢复与诊断、初始化及备份命令。Direct MCP 是可选后端，不是首版主线的必做依赖。

首版运行边界为一名可信人类、一台 Apple Silicon Mac、本地磁盘；公网服务、多租户安全隔离、私密频道、移动端和 Windows/Linux 桌面均不在此次交付范围。

依据：[SPEC 第 1、8、16、17 节](../spec/SPEC.md)、[完整验收标准](../spec/ACCEPTANCE.md)。

## 固定技术方案

| 模块 | 已确定的选择 | 实施责任 |
|---|---|---|
| 控制面 | Node 24、TypeScript、Fastify，单实例 | 认证、领域事务、调度、事件、outbox |
| WebUI | React、Vite、TanStack Query，REST 与 SSE | 展示事实、提交意图、快照及增量合并 |
| 控制面数据库 | SQLite WAL、FULL、单写入所有者 | 业务状态和公开事件同事务提交 |
| Host | 独立 Node 24 进程、本地 SQLite、主动连接 WS | 子进程、原生请求关联、命令去重、spool |
| Codex 驱动 | App Server stdio | 一名 Agent 一个 owned process，使用真实 thread/turn |
| Claude 驱动 | 稳定 `query()`、异步输入流、绑定真实 CLI | 根 result 终态、子任务归因、PreToolUse 与 canUseTool |
| MCP relay | 每 launch 独立 stdio，连接 Host 私有 UDS | 身份绑定、capability 校验、工具转发 |
| Computer Use | Host 唯一网关、LCU custom client | 原版指令/schema/result、应用授权、独占及清理 |
| 代码隔离 | 每 Agent 独立 Git worktree | 固定 commit 评审，整合任务有明确 Owner |

不再重新选择上述架构。SQLite 库、测试框架、具体依赖版本等实现细节在 W01 确定并锁定，不假装原 Spec 已指定这些包。

## 开发中必须保持的不变量

1. Agent、Session、Launch、Run、Episode 独立建模；UNKNOWN Run 继续占据执行槽。
2. 人类或 Agent 的身份来自认证绑定；正文中的角色声明、`@all` 和工具参数不能扩大权限。
3. Message、Delivery、Event、幂等响应在同一事务中提交。状态成功后才发布事实。
4. 原生输入已写入或结果不确定时不自动再次提交；只重放同一个 Host command 的收据。
5. 每个 Run 只有一个主 actionable message；其他信息进入有界 context。peer 回复满足 expectation 一次。
6. 全局 SSE 序号用十进制字符串；重连、重复事件、过期 cursor、旧 snapshot 都有明确处理。
7. Task 领取使用 CAS；lease 过期保留旧 Owner；完成必须有证据并由指定 Reviewer 或人类验收。
8. 根 native turn 终态和资源清理分开。interrupt ACK、TTL、静默都不是静止证明。
9. 所有 LCU `js` 按可能写操作处理；同一桌面仅一个 Owner，清理不能证明时 quarantine。
10. 人类审批宿主应用必须可验证地排除在 Computer Use 范围之外，已有持续授权也要检查。
11. 原始截图以 MCP image content 返回；工件路径和文字描述不能代替图像。
12. 能力声明来自本机 profile 门禁；fake 通过、模型目录可读、组件文件存在均不能替代 Q0–Q4。

默认数值沿用 Spec：并发 5（Codex 3、Claude 2）；每 Episode 32 根 turn、深度 8、Agent 发问最多 3 个收件人、60 分钟；每 Run 最多 20 条信息更新；待处理输入上限 200；空闲回收 20 分钟；task lease 10 分钟、60 秒续约；桌面等待最多 30 秒。

## 规格与本机复核结果

| 项目 | 本轮事实 | 实施含义 |
|---|---|---|
| 仓库内容 | 初始只有 `spec/`，无应用源码或包锁文件 | 从 W01 开始建立工程 |
| Git | 当前目录尚非 Git 仓库 | W01 初始化本地仓库；worktree 前必须有基线 commit |
| 规格完整性 | SHA256SUMS 的 26 项全部匹配 | 原始包可作为可追溯基线 |
| 合并版 | 五份正文均完整包含于 PROJECT_SPEC | 以后编辑源正文并重建合并版，避免双份漂移 |
| 机器契约 | 70 个领域定义、51 个 HTTP 操作、21 种公开事件、13 个工具 | 统一生成，避免客户端与服务端自造字段 |
| 原始校验 | 21 项全部通过，含 TypeScript strict | 仅覆盖规格结构、样本和部分 SQL 约束 |
| 默认 Node | v25.8.0 | W01 为项目固定 Node 24，保留用户全局环境 |
| pnpm | 11.19.0 可执行 | 项目版本需验证与 Node 24 匹配，再锁定 |
| Python | 3.9.6；默认环境无 jsonschema/PyYAML | 本次在临时 venv 安装审计依赖 |
| TypeScript | 默认 PATH 未找到 tsc | 本次临时安装 5.9.3 运行规格类型检查 |
| Codex CLI | 0.157.1，已记录 realpath 与 hash | 尚未验证模型调用、恢复或审批 |
| Claude Code | 2.1.205，已记录 realpath 与 hash | SDK 尚未选版并联合验证 |
| LCU 与原版组件 | 本轮未完成 provider 探测 | 保持未验收，不能据当前聊天工具推断 Atrium Grove 可用 |
| 原生门禁 | Q0–Q4 全部 NOT_RUN | 在专用测试项目及测试应用内执行 |

详细值和执行输出见 [规格审计报告](reports/spec-audit.json)。本轮没有重新审核上游仓库或其授权条款；`RESEARCH.md` 是现有规格提供的调研基线，原生适配时须核对锁定 SDK、二进制 schema 与 provider 实际合同。

## 需要在对应模块开工前收敛的契约问题

以下区分直接冲突、缺失合同及服务层待实现的校验。原始验证器通过并不能排除这些问题。

| 编号 | 现有证据与影响 | 建议处理和截止点 |
|---|---|---|
| C01 | P06 列出 WS frame，但只有部分 TS 接口，`CommandEnvelope.payload` 是通用对象；缺少所有 kind 的运行时 schema。Host 到 control 的协作调用、task 续约、缺口请求也未定义完整帧 | W01/W04 前补齐版本化双向 discriminated union、请求关联、认证与错误合同；不借用 owner cookie |
| C02 | P17 要求 worktree 经 outbox 创建，但命令 kind 没有对应操作；project 验证、工件传输也缺少端到端结果协议 | W04/W11 前定义结构化 project/worktree 命令、幂等收据和工件传输；Host 独占本地文件副作用 |
| C03 | P13 要求 snapshot 包含本 workspace retention frontier，Snapshot schema 未定义且拒绝额外字段 | W03/W12 前新增 frontier 字段及持久保存策略，验证 410 和多 workspace 场景 |
| C04 | SPEC 8.3 要求审批响应携带参数 hash；ResolveApproval 和 HumanDecision 没有此字段 | W13 前通过 ADR 统一，以服务端保存的 launch/run/native request/hash 验证响应，加入参数变更及旧审批测试 |
| C05 | SPEC 14 写单消息 64 KiB，P01 写每 block 64 KiB、合计 128 KiB；schema `maxLength` 是字符数；总 blocks 上限 16 又可能阻止正文加 16 附件 | W01/W03 前统一 UTF-8 字节限制与附件计数。补中文、多 block、边界值用例 |
| C06 | collab_post 仅接受 text，无法发结构化 ArtifactBlock；task_create 无 reviewer 字段，现有 API 无 Reviewer 后设动作 | W09/W11 前明确 Agent 分享图像/报告与指定独立 Reviewer 的完整路径，保持工具总数可不变 |
| C07 | A39 要检查审批宿主及持续授权；DesktopQualification 无对应结果字段。ExecutableProfile/RuntimeInventory 也未完整表达架构、schema 指纹和 gate 证据 | W07/W08/W14 前补 qualification DTO、证据存储和失效判定；不能仅以 available=true 放行 |
| C08 | team.yaml 有并发、回收和 provider policy，但没有 team schema；Workspace/SQL/API 未完整描述设置持久化及编辑方式 | W01/W06/W16 前定义导入 schema、配置版本和 owner 设置命令，并规定 active Run 固定配置快照 |
| C09 | SPEC 6.1 的 context artifact 是私有输入；当前 Artifact/SQL 只有 workspace 与 creator，缺少明确的 session/run 可见性规则和截图来源结构 | W10/W11/W14 前定义 context 读取权限及持久 provenance；共享图片不得顺带公开其他 Agent 的输入上下文 |
| C10 | SPEC 8.2、F11 描述 draining 期间保持租约；P11 又写原生结束而工具仍执行时 quarantine，缺少阶段分界 | W14 前统一正常排空、超时、失联、清理失败的转换表；任何路径都不得提前释放 Owner |

C01、C02、C08 属于接口补齐；C03、C04、C05、C10 涉及正文与契约的一致性；C06、C07、C09 涉及完整产品流程与可验证性。它们不阻塞建立 workspace 和 fake runtime，但阻塞对应模块宣布完成。

此外，RunControl 对空 steer、interrupt 携带 text 的限制，task DAG、跨 workspace 引用、角色权限与预算继承等必须由命令处理器验证。Schema 暂时接受这些输入不等于产品允许，不能只靠 JSON Schema 代替领域规则。

## 无需用户重新决定的事项

产品名称采用 Atrium Grove；采用原 Spec 固定架构与五人配置；默认只监听 loopback；源码独立实现；从契约、持久性和 fake 垂直流程开始。不会为开发方便默认开启 Full Access、自动批准、绕过 UNKNOWN 或把 mock 标为真实兼容。

真实 setup 后续需要选定：测试 Git 项目、经验证的模型 ID、本机 settings profile、LCU 组件路径/版本，以及供人类审批且不能被自动化操作的宿主应用。优先由探测和初始化向导获取；只有账号登录、OS 授权及实际人工审批需要用户亲自完成。这些输入不阻塞 M0。

## 本轮交付与开工入口

开发路线已覆盖 W01–W16、A01–A41、F01–F20、Q0–Q4 及标志性场景。产品用例初始均为 NOT_RUN，不把本轮规格审计当作产品通过证据。

下一批实施从 W01 开始：项目 Node 24 与 pnpm 锁定、严格 TS monorepo、契约生成及漂移检查、双 SQLite 迁移、CI、fake runtime 基础。首先收敛 C01/C03/C05/C08，然后完成“人类发言 → 两个 fake Agent 异步协作 → 原子任务领取 → SSE 重连”的可运行流程。
