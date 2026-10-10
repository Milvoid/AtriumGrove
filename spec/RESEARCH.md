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
