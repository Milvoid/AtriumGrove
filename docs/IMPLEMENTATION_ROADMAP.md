# Atrium Grove 完整实施路线与验收映射

本路线沿用 [原工程任务 W01–W16](../spec/IMPLEMENTATION_PLAN.md)，将它们安排为可逐步运行和验证的交付批次。所有任务当前为 NOT_STARTED；依赖满足、验收通过后才标记完成。

开发先完成领域合同及确定性 fake 流程，再接入真实 Harness 和桌面。提前做环境探测以暴露外部限制；探测通过不代替真实集成。当前路线不要求启动额外 Agent，后续如采用多人开发须先稳定共享合同并使用独立 worktree。

## 完整交付路径

| 阶段 | 工程范围 | 可使用的结果 | 退出条件 |
|---|---|---|---|
| M0 基础 | W01–W05、W06/W09/W10/W11 的最小流程、W12 基础 | 登录、发消息、两个 fake Agent 异步问答、任务唯一领取、SSE 重连 | 契约、事务、幂等、重放和 fake 崩溃测试通过 |
| M1 原生会话 | W06–W09、W13 原生审批部分 | 三个 Codex 与两个 Claude 真实会话并发、恢复、中断、工具调用 | Q0/Q1 通过，运行身份与 lane 无串线 |
| M2 协作闭环 | W09–W12 完整实现 | 人类消息驱动 peer 问答、任务依赖、记忆提案、代码和图像工件评审 | 协作用例通过，跨 Harness 无手工搬运 |
| M3 桌面 | W13/W14 | 两种 Harness 共用 LCU，WebUI 人工授权、独占、停止与清理 | Q2/Q3、A33–A39 及桌面故障用例通过 |
| M4 交付 | W15/W16 及全量回归 | 恢复、背压、配置更新、向导、CLI、备份、诊断与文档 | Q4、全部 A/F、五人标志场景、性能及独立复核通过 |

M0 引入后续任务的最小实现不表示这些任务已全部完成。M1 的 Q0 环境记录应同时记录 LCU 是否可用；Q3 尚未通过时整项目仍未完成。

## 工程任务与完成条件

| 任务 | 前置 | 具体交付 | 验证与证据 |
|---|---|---|---|
| W01 工程与契约 | 无 | 初始化 Git、项目 Node 24、固定 pnpm、TS strict workspace、精确依赖锁、contracts 生成器、CI、双 DB 迁移工具；收敛首批 C01/C03/C05/C08 | 原始 21 项复现、契约生成无漂移、迁移重启及版本处理；干净环境可构建 |
| W02 本地身份 | W01 | owner/system bootstrap、nonce TTL/单次交换、cookie、CSRF、logout 撤销、loopback listener；CLI login-token | A01/A02；SSE 撤销，凭据不入日志/URL |
| W03 持久命令 | W01 | command handlers、scope、幂等 hash、message/delivery/event 事务、keyset/HMAC cursor、snapshot/frontier、持久发布日志 | A08、F01/F02；rollback 与 commit 后重试；大序号不丢精度 |
| W04 Host 通信 | W03 | 本地 enrollment、完整 frame 校验、单实例日志、outbox、持久 command receipt、spool/连续 ACK、缺口补齐、协作 RPC | F03/F05/F06/F08；旧 epoch、重复命令、同 seq 异 payload 隔离 |
| W05 确定性测试环境 | W01 | fake Codex 子进程、fake Claude Query、fake desktop；可控时钟、执行屏障、断连/退出/晚到/挂起注入 | 不调用模型也可复现 busy、交织、审批、stdin 不确定窗口、cleanup hang |
| W06 会话与调度 | W03/W04/W05 | Agent/Session/Launch/Run 状态机、优先级与 RR、公平并发、单主消息、预算预约、spontaneous turn 检测 | A03/A11–A16、F04/F09；UNKNOWN 占槽；未写入才允许退款 |
| W07 Codex 驱动 | W04/W05 | 本机 schema 生成、profile 校验、握手、start/resume、submit/steer/interrupt、审批、root/lane 投影 | Q0/Q1 Codex 部分、A22/A23/A41；固定 binary/schema/model 证据 |
| W08 Claude 驱动 | W04/W05 | 精确 SDK 版本与 CLI 绑定、persistent Query、异步输入、root/child、PreToolUse/canUseTool、resume/cancel | Q0/Q1 Claude 部分、A22/A23/A34；auto-approved 工具仍执行 deny |
| W09 MCP 协作工具 | W03/W04 | 每 launch stdio relay、私有 UDS、token/peer 校验、BoundToolCaller、13 工具、错误与幂等映射 | A04–A10/A07；伪造身份、跨 workspace、工具越权拒绝；stdout 仅协议 |
| W10 上下文与因果 | W03/W06/W09 | context artifact/digest、来源序列化、持续 inbox、expectation 一次满足、预算继承、accepted memory | A06/A09/A14/A15/A24；read 不等于 ack，ack 不等于任务完成 |
| W11 任务与工件 | W03/W04/W09 | Host worktree、固定 commit checkout、task CAS/DAG/lease/review、内容寻址、真实 image block、权限与 GC | A17–A21/A26/A27、F19；包含任务证据与上下文私有范围 |
| W12 WebUI | W02/W03/W05 | 三栏聊天、线程、Composer 收件模式、roster、分 lane trace、任务板、memory、SSE generation reducer、主题/键盘/空态 | A28–A31；100k 消息分页、旧 snapshot 不回滚、trace 按需加载 |
| W13 审批中心 | W02/W04/W07/W08 | 原版表单/问题/URL、CAS、参数 hash、native pending promise、失效与 resolved 回执；LCU 回调接入 W14 | A33–A35、Q2；双标签仅一次生效；旧 launch 不可批准 |
| W14 桌面网关 | W04/W05/W13 | provider qualification、原版 instructions/tools/result、lease epoch、calls/background 跟踪、endTurn/cleanup/quarantine、审批宿主排除 | A36–A39、F11–F14/F16/F18、Q3；两种 Harness 都直接使用同一网关 |
| W15 恢复与运行控制 | W06/W07/W08/W14 | 重启对账、只读 reconcile、进程身份核实、pause/stop/reset、配置版本失效、spool 背压、usage 去重 | A25/A32/A40、F07/F10/F15/F17、Q4；unknown 不变造 success |
| W16 打包与交付 | W10/W11/W12/W13/W14/W15 | setup、team dry-run/import、全部 CLI、备份恢复、脱敏导出、运维 README、许可证清单、兼容矩阵与验收汇总 | F20、全栈五人场景、所有 A/F/Q；未测明确标 NOT_RUN |

W06 与 W10 共同实现预算：前者负责原子 reservation 与调度，后者负责来源继承和 bundle。W03 提供持久事件查询，W12 负责 UI 合并，W04 负责 Host spool；三者不可各自建立第二套状态真相。

A32 用量处理补入 W15，不能因原 W 表遗漏该编号而漏测。未知/未报告用量保留 unknown；累计值不能重复求和。

## 首批实施的具体顺序

1. 建立 Git 基线和可重现的 Node 24 工程。把本轮报告保留为初始证据；不创建远程仓库或推送作为隐含步骤。
2. 处理契约补齐 ADR，确立生成器唯一来源。W01 的 contracts package 导出 wire validators、DTO 和 runtime 类型；UI 不依赖 native 类型。
3. 建立 control/host 两套独立 migration runner；验证 WAL、FULL、foreign_keys、重启和回滚。选定 SQLite 库后确认 64 位 seq 读取不会经过不安全 Number 转换。
4. 构建 W05：先有可控制收据、终态、spool ACK 和 cleanup 的确定性测试设施，再编写副作用处理器。
5. 实现登录、workspace、channel、两名 fake Agent、消息提交与持续事件；每一步有真正数据库事务。
6. 接上 Host command ledger 和 scheduler，打通一个主消息到一个 Run，验证写入窗口崩溃进入 UNKNOWN。
7. 加入 peer expectation、任务 CAS、最小工件、canonical answer，完成两个 fake Agent 的异步协作。
8. 接入 WebUI snapshot/SSE 并验证断线恢复；完成 M0 评审后扩展至五个真实 Harness。

真实 binary/schema 与 LCU 的只读探测可在基础开发中提前进行，阻碍真实环境的发现应及时记录。不要把 native 兼容问题拖到全部 UI 完成后才检查。

## 模块边界与工程规则

源码目录沿用 SPEC 15：`apps/web`、`apps/control`、`apps/host`，以及 contracts、domain、persistence、runtime-codex、runtime-claude、runtime-testkit、mcp-relay、computer-gateway、computer-lcu、worktrees、artifacts、observability 等包。

`domain` 只决定合法转换和 effects，不依赖 Node 子进程或 Fastify。控制面唯一拥有任务数据库，Host 唯一拥有进程和桌面账本，provider 不读取任务库。WebUI 所有完成状态来自服务器事实。

Host native callback 必须在初始化进程前接好持久事件路径。副作用由其所有者决定重试策略，不能由 HTTP、WS、driver 三层各自重试。协议和 schema 的变更在模块实现前完成一致性更新。

所有 Git 命令使用参数数组、受控 root 和 baseRef。每名 Agent 的工作树与评审 commit 明确记录，整合也作为带 Owner 和验收条件的任务；不覆盖未提交更改。

## 自动化与真实验收

| 层次 | 范围 | 运行策略 |
|---|---|---|
| 规格检查 | schema、引用、SQL 约束、生成器漂移、TypeScript | 每次契约变更及 CI |
| 领域测试 | scope、CAS、DAG、预算、因果、状态机、usage | 纯状态与数据库事务测试 |
| 进程集成 | Host receipt/spool、MCP、native 协议投影 | fake 子进程与可控时钟，等待事件或状态 |
| Web E2E | 登录、通知、trace、审批、断线、旧 snapshot | fake 后端，独立浏览器上下文 |
| 故障注入 | F01–F20 | 显式执行屏障、崩溃点、重复/丢失消息；固定 sleep 不作为唯一依据 |
| 原生门禁 | Q0–Q4 | 专用测试 Git 项目和应用，保存版本/hash/model/profile/工件证据 |
| 容量与性能 | 100k 消息、500k 事件 | 固定 fixture、分页和有界内存；平台 REST p95 <300ms、落盘到 UI p95 <1s |

F01/F02/F03/F04/F05/F11/F12/F13 必须有确定性 fake 自动化并进行适当 native 抽样。真实门禁中需要的人类审批、原生登录及 OS 授权由人类完成，不能由 Agent 代点。

产品验收清单为 41 个 A 用例、20 个 F 用例、5 个 Q 门禁，另有完整五人标志性场景。逐项负责人、阶段、依赖与初始状态记录于 [acceptance-matrix.json](reports/acceptance-matrix.json)。这些是测试计划，不是已存在的产品测试代码。

原始 Spec 的 A19 标题为自审批，正文存在 Owner 与 Reviewer 关系表述；实现以 SPEC 9 的“Reviewer 必须不同于 Owner，或由人类验收”为准，补显式负例，不允许指定自己绕过。

## 原生兼容验证步骤

Q0 记录实际 binary realpath/hash/version/architecture、SDK 版本、model ID、settingsProfile、provider 指纹与 schema/instructions hash；通过随机 nonce 的真实调用验证账号/模型。未安装组件显示 unavailable。

Q1 启动三 Codex、两 Claude，各自记住不同哨兵并报告自己的 worktree；验证只读工具、后续哨兵回忆、idle 回收后恢复和一次原生中断。不同供应商名称的 fake 输出不能通过此门禁。

Q2 验证拒绝无副作用、单次允许仅执行一次、原生工具自动许可仍受 PreToolUse deny、LCU 原版应用请求回传及旧 launch 审批失效。

Q3 在专用 TextEdit 文档或测试应用观察、输入 nonce、再次观察，将图像交另一 Harness 阅读，并反向操作；记录无重叠桌面 Owner、无嵌套模型代理调用、无跨 epoch 元素复用。

Q4 验证 native 终态与 cleanup 分离，运行中 Stop、UI 断线、控制面重启、Host 异常退出；不能确认静止就 quarantine，不自动重放不确定的点击/输入。

## 最终交付物与完成定义

最终仓库应包含精确 lockfile、构建与启动说明、版本化迁移、兼容 manifest、完整 A/F 自动化结果及 Q0–Q4 实机报告、同一 fixture 的截图或录像、诊断和备份恢复流程、许可证清单。

必须提供 `pnpm atrium-grove init`、`pnpm atrium-grove serve`、`pnpm atrium-grove host start`、`pnpm atrium-grove doctor`、`pnpm atrium-grove login-token`、`pnpm atrium-grove team import`、`pnpm atrium-grove backup`、`pnpm atrium-grove export-run`。初始化敏感目录 0700、凭据文件 0600；launchd 安装为人类显式选择。

最终场景为五 Agent 协作实现 CSV 可视化页面：设计、边界讨论、唯一任务领取、桌面验证、独立评审、至少一次修复与再次验证。保存五个不同原生会话 ID、工具执行、消息来源、Owner 和图片读取证据。

由未实现核心模块的 Reviewer 按 ACCEPTANCE 独立复核。只有全部必做能力有可观察证据后标记完整交付；fake 演示、能启动服务或文档齐全均属于阶段进展。
