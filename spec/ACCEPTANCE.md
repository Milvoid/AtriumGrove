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
