# Atrium Grove 运维

## 数据与进程

`HARBOR_HOME`、`--state` 或默认 `~/.harbor` 选择状态目录。控制面独占 `control/control.db`；Host 独占 `host/host.db`。两者使用 WAL、FULL synchronous 和 foreign keys。Host 配置文件为 0600，目录为 0700。备份仍包含任务正文、上下文和审批审计，应保存在可信本机。

控制面与 Host 分开启动。`preview` 是临时 fake 团队，不是守护进程安装器。未配置 `access.json` 时服务仅监听 loopback；显式配置密码与 public URL 后监听所有 IPv4 网卡，按 hostname:port 和同源请求限制访问。局域网配置示例使用 `http://atrium-grove.local:4317`、`~/.harbor`。端口占用时选择新端口，不终止其他软件。密码通过 `pnpm atrium-grove access --password-stdin --public-url URL` 配置，重启后生效。

## UNKNOWN 与停止

`unknown` 保留执行槽和预算预约。控制面重启使用原 launch 和收据对账；相同 commandId 不会再次提交模型。Host 重启失去的进程控制不能靠超时推断完成。

Host 记录 PID、启动时间和可执行文件指纹。显式停止残留进程前核对启动时间；不匹配时拒绝杀进程。只有进程组和受管桌面均静止后才能宣称资源可用。恢复到其他机器时还须确认原机器不会继续执行。

Pause 只暂停新调度。Stop 请求关闭并等待资源确认。重置在确认关闭后清除旧 native ID；工作目录和未提交改动保留。

## 审批与桌面资格

只有认证 owner 携带有效 CSRF、expectedVersion 和 argumentHash 才能处理审批。Host 再检查原 run、launch、哈希和请求存活状态。原版问题和表单保留显示；响应按 schema 校验。过期请求发送 cancel。平台不自动批准原生工具、应用访问或 OS 授权。

本版 LCU 排除检查仅支持 `com.openai.codex` 作为人类审批宿主且禁用 Chrome surface，并检查本机持久 app grants。浏览器不同 profile 不构成应用级隔离。

LCU 由操作者独立安装，原版 OpenAI 组件不随 Atrium Grove 分发。本机 `.tools/lcu-runtime` 仅用于开发探测，未更改全局 Codex/Claude 配置。已记录 instructions、schema、runtime 指纹，但真实 cleanup 资格仍待完成。

Host `lcu` 配置包含 clientModule、clientSha256、command、providerVersion、runtimeFiles、approvalHostBundleId 及带证据的 qualification。不得仅为显示可用而手工设置 `cleanupConfirmed=true`。组件变化后必须重新验收。

模型仅看到原版 `js`、`js_reset`。整轮持有桌面租约；cleanup 属于 Host。未排空或无法证明清理完成时进入 quarantine，TTL 不会把桌面转交给第二位 Agent。

## 备份与诊断

备份包含一致控制面快照、工件清单及可用时的 Host 审计快照。恢复只能写新目录，旧 Host 快照不作为新进程的控制依据，所有认证撤销。当前恢复命令不自动重新绑定项目到新 Host，也不处理旧机器上的进程，需要人工对账后注册。

Host spool 超过 64 MiB 后拒绝新提交，未确认事件不删除。磁盘满实测、完整大帧分片、后台保留策略和大规模 UI 虚拟化仍待补齐，见实现状态文档。

诊断使用 `doctor`、运行轨迹和 `export-run`。未知 native 消息保存在 Host 私有 diagnostics，导出默认不携带原始 payload。未报告的模型费用保持未知。

## Cloudflare Tunnel 与常驻运行

生产入口示例为 `https://agents.example.com`（请替换为自己的域名），Cloudflare Published application 的源站配置为 **HTTP / `127.0.0.1:4317`**。这是正式控制面端口，随机 preview 端口只供验收。Tunnel 保留公网 Host；`access.json.publicUrl` 必须与公网 HTTPS Origin 相同。`allowedOrigins` 可显式保留其他已有入口，按 Host 精确匹配 Origin，不能配置通配符。公网 Cookie 带 Secure；本机 HTTP 登录按自己的 Origin 设置 Cookie，不信任任意 forwarded headers。

`python3 scripts/install-macos-services.py --load` 安装当前用户的两个 LaunchAgent：`org.atriumgrove.harbor.control` 和 `org.atriumgrove.harbor.host`。首次安装前正常退出已有手动进程；更新时先确认没有执行中的 Run，再依次重启。它们随 macOS 用户登录启动，退出终端、关闭浏览器或 Codex 不影响运行；异常退出由 launchd 重启。重启电脑后需要登录该用户，不能声称登录前可用。机器关机、断网或睡眠时服务不可达。常驻机器需自行配置电源与睡眠策略。cloudflared 使用已有的 `com.cloudflare.cloudflared` 用户服务。

查看：`launchctl list | rg 'harbor|cloudflared'`。控制面和 Host 日志在 `~/.harbor/logs/{control,host}.{out,err}.log`。修改后可用 `launchctl kickstart -k gui/$(id -u)/org.atriumgrove.harbor.control` 重启控制面。**有任务执行时不要重启 Host**；模型进程崩溃不会被当成已成功完成，仍须按 UNKNOWN 对账。

SSE 使用 `Content-Type: text/event-stream`、立即写出的连接注释和 15 秒心跳，适用于 Cloudflare 的命名 Tunnel。不要给 `/v1/*` 添加 Cache Everything，也不要改成不支持 SSE 的临时 Quick Tunnel。

## 对话中的执行过程

聊天直接显示公开的中间文字、工具开始/输出/结果、等待批准和错误。事件落盘后通过 SSE 推送；刷新会从对应 Run 的分页轨迹恢复，同一 launch/producerSeq 不重复追加。完成后保留可展开的工具操作，最终答案只显示一次；历史已完成 Run 的轨迹按需加载。子任务轨迹标注“子任务”。不显示 Harness 隐藏思考内容。工具参数/结果只保留受限预览，图片二进制及凭据字段不进入页面。

验收：`pnpm exec tsx scripts/verify-streaming.ts` 在专用临时目录用已登录的默认 Codex 和 Claude 读取测试文件；结果在 `docs/reports/native-streaming.json`。`scripts/preview-streaming.ts` 是隔离的可控模拟事件页面，用于检查进行中、刷新恢复与完成去重，不能当成真实模型验收。

## 目录与对话导航

首页是未保存的聊天草稿。选择实际目录和成员后，首条消息原子创建对话并从正文自动命名；重试不会重复创建。侧边栏按工作文件夹归类，目录旁的 + 只打开带入该目录的新草稿。点击 Atrium Grove 返回空白页；对话 URL 带 conversation 参数，刷新仍回到原对话。成员选择记住在当前浏览器中。

004 迁移保留已有对话、消息和成员，只在历史成员拥有唯一实际执行项目时归类。迁移前的控制库备份位于 ~/.harbor/backups/before-conversation-directory-*.db。对话目录固定后由 Scheduler 传给 Host；成员切换对话会恢复各自 transcript，目录选择不再是纯前端显示。服务更新会主动关闭 SSE 连接，浏览器自动重连，避免长连接阻塞正常退出。

### 实时执行反馈与后台认证

聊天页从消息入队起显示成员等待、模型启动、服务离线或会话异常；模型产生的文本和工具事件通过 SSE 更新。运行列表与队列状态每 2 秒补取，运行中的事件每 1.5 秒补取，断流后不必等待最终答案。已完成的工具操作默认可见，详细输入与输出按需展开。

Host 正常退出会记录已确认停止的进程；重连时仅自动恢复没有未决运行且已确认关闭的会话，执行中失联仍保留未知状态，避免重复执行。

macOS LaunchAgent 不读取 shell 启动文件。安装脚本仅向 Host 的 0600 plist 同步当前 CLI 使用的 Anthropic 认证、地址和模型环境变量，不写入代码库或日志。更新认证后重新运行安装脚本，并在当前任务完成后重启 Host。

## Computer Use

成员的 Computer Use 开关默认关闭，且必须同时使用 Auto Approve 或 Full Access。降低到 Read Only / Ask For Approval 会关闭开关，提高权限不会自动恢复；后端拒绝非法组合。已有成员不会自动启用。Codex 的内建电脑/浏览器、插件入口和未纳入当前会话的 MCP 被禁用；Claude 使用严格 MCP 清单及调用钩子。这个开关控制 Atrium Grove 提供的电脑工具，不把 Full Access 的 shell 变成安全沙箱。

链路是当前 Agent → `harbor_computer` → LCU 原组件 → 应用。不会为了电脑操作额外创建 Codex Desktop Agent 会话。原组件 instructions、js/js_reset schema 和返回的图片原样交给当前模型。Computer Use 授权与应用的原生批准分别处理，Full Access 不替用户回答应用授权。支持原组件提供的单次和当前会话授权，不自动创建永久应用授权。

已安装 LCU 时运行 `pnpm exec tsx scripts/setup-computer.ts --verify`：在明确的交互批准下用 Calculator 检查观察、输入、截图、reset 和原生释放。只在成功后写 Host 配置，不打开成员开关。组件文件、instructions 或 schema 改变后必须重新验证。审批应在原组件禁止控制的 Codex 宿主或独立远端设备中完成；不能把相同本机浏览器的不同 profile 当作隔离。当前默认 LCU 为原生应用模式，不启用 `--chrome`。

对话显示电脑操作及可展开的历史截图。截图副本含 provider、连接、run、lease epoch、时间和摘要；保存失败会显示错误，但不改动返回模型的原始图像。截图为当时观察，不是实时桌面视频。

“执行电脑”显示占用、清理与异常隔离状态。停止会同时取消当前电脑请求并中断对应模型，只有原组件确认结束才显示空闲；另一成员的停止不会影响桌面 Owner。争用最多等待 30 秒，超时明确返回占用者。进程丢失或重启后无法证明旧连接已清理时保持隔离，“重新确认释放”不会强制清锁。

验收报告：`computer-qualification.json`（原组件）、`computer-harnesses.json`（两个默认模型通过 Host 的截图往返）、`computer-stop.json`（操作中中断）、`computer-denial.json`（拒绝应用授权）、`computer-tests.tap`（自动测试）。验收脚本只在用户明确授权 Calculator 后使用 `--calculator-authorized`，测试会话退出时归档，临时目录自动删除。
