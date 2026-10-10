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
