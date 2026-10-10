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
