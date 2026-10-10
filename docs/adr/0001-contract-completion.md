# ADR 0001 开工前补齐跨模块合同

状态：提案，尚未采纳或修改原始 Spec。日期：2026-10-09。

Atrium Grove 1.0 的架构保持不变。为避免控制面、Host、WebUI 和原生适配器在实现时各自解释缺失字段，应先收敛 [对齐报告中的 C01–C10](../DEVELOPMENT_READINESS.md)。本 ADR 是待实施的合同清单，不表示这些缺口已修复。

## 建议决策

1. 建立单一版本化 Host wire schema，覆盖现有 frame、按 kind 区分的 command payload、协作 RPC、task lease 续约、事件缺口请求及工件传输。协作 RPC 由 Host 验证 relay 后构造 BoundToolCaller，控制面再次验证已登记的 launch/run。
2. project 验证和 worktree 创建以结构化 Host command 执行，并用 outbox 与持久收据确认；控制面不直接操作项目文件，也不在数据库事务中等待 Git。
3. Snapshot 增加 `retentionFrontier`，定义为“最小仍可接受的 after cursor”，与 `snapshotSeq` 同用十进制字符串；每 workspace 独立保存，清理事务更新。具体字段进入生成器及客户端类型。
4. 审批响应增加 `argumentHash` 并贯穿 HumanDecision；服务端比对原请求，仍以认证 owner、expectedVersion、launch 和原生请求存活状态作为放行条件，不能只比 hash。
5. 消息采用 P01 的细粒度上限：单 text block 64 KiB UTF-8，消息所有 text 合计 128 KiB，附件最多 16。更新 SPEC 14；blocks 的整体上限同时明确，避免“1 文本加 16 附件”被误拒。此项是对冲突的拟议裁决，尚非生效行为。
6. 在现有 collab_post 增加受 workspace scope 验证的工件引用，在 task_create 增加可选 Reviewer；同时定义原消息无 thread 时转换为任务的线程建立流程。人类重新分派仍须证明旧 Owner 静止。
7. qualification 增加可审计的 gate 状态和审批宿主排除证据；provider 无法检查持续授权时不能 qualified。真实 profile 必须保存架构、SDK/binary/provider 版本、schema/instructions hash 和报告引用。
8. 为 team 导入、工作区 policy、context artifact 私有范围及截图 provenance 增加明确 schema 和持久存储。配置变化使用版本号，不热替换 active Run 的权限或 native profile。
9. 将 Run draining 与 Desktop 状态分别定义：有可追踪的执行且仍在排空时保持独占；失联、排空超时、取消失败或 cleanup 无证据时 quarantine。两者均拒绝新 Owner。

## 采纳要求

每项可以独立拆分后续 ADR。实施时修改生成器源、对应正文、生成的 OpenAPI/Schema/TypeScript、SQL 迁移及例子，并新增正反测试；重新生成 PROJECT_SPEC 和 SHA256SUMS。不能只手改生成 JSON。

Schema 新字段、frame 新类型和语义变化必须有版本策略，严格拒绝额外字段的旧客户端不能被假定兼容。初始无已部署客户端，也仍应记录基线和升级边界。

## 验证要求

- 原始 21 项规格检查持续通过，生成器输出可重现。
- 每个 WS frame 有合法样本、错误方向/身份/字段样本和重复请求测试。
- 快照 frontier、审批参数 hash、UTF-8 长度与附件上限有边界回归。
- 两个 fake Agent 能共享图片工件并由指定非 Owner Reviewer 完成评审。
- 清理竞态证明终态先到、调用晚到、取消失败时都不出现重叠桌面 Owner。

真实 SDK 或 provider 限制导致无法实现拟议方案时，保留 unqualified 并记录具体不支持的能力，不用静默降级替代决策。
