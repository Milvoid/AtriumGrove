# Atrium Grove — 跨 Harness 协作平台实施规格包

**规格版本：1.0.0 · 调研基准日：2026-10-09 · 工作代号：Atrium Grove**

目标：在本机同时运行 3 个 Codex CLI 会话和 2 个 Claude Code 会话；通过 WebUI 的频道、讨论线程、任务和进度视图协作；通过可替换的工具提供者复用 Codex Computer Use。

## 阅读与实现顺序

1. `SPEC.md`：产品边界、已定架构、运行与一致性语义、UI、部署和实施顺序。
2. `RESEARCH.md`：逐项目源码结论、明确不照搬的默认行为、来源及许可证边界。
3. `PROTOCOLS.md`：控制面—Host—Harness—工具的详细协议和恢复算法。
4. `ACCEPTANCE.md`：功能、并发、故障和真实桌面验收。
5. `contracts/openapi.yaml`、`contracts/domain.schema.json`、`contracts/runtime.ts`：HTTP、数据与内部接口；`db/schema.sql`、`db/host.sql`：初始数据库。
6. `examples/`、`prompts/`：五 Agent 示例、事件样本、协作指令模板。

正文中 MUST/必须 为验收要求，SHOULD/应 为可通过 ADR 覆盖的默认；正文写明“后续”者不属于 v1 交付。默认技术决策均已给出，不需要开发者重新选择架构。上游二进制兼容性必须通过 Q0–Q4 门禁，不得把“协议可连接”当作“已完成真实运行验收”。

本包是**可实施规格与接口基线，不是已经实现的应用**。附带校验只检查规格产物的 SQL、JSON Schema、API 引用和 TypeScript 契约，不代表五会话及 Computer Use 已实机验证。

## 规范优先级

`SPEC.md` / `PROTOCOLS.md` 的行为与权限规定 > OpenAPI/JSON Schema 的线缆格式 > SQL 存储格式 > 示例。SQL 的跨实体业务校验在服务事务中执行；不得以 SQL 能插入为由跳过行为规范。若发现冲突，必须提交 ADR 并同时修改相关契约与测试，不能悄悄选择一版。

所有资源 ID 使用 UUID；例外：原生 Harness ID 为不透明字符串，SSE 序号是十进制字符串。`harbor://` URI 仅为平台工件引用，不是浏览器可下载 URL。

## 验证本规格包

```bash
python -m pip install jsonschema PyYAML
python scripts/validate.py
# Node / TypeScript 已安装时：
tsc --strict --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext contracts/runtime.ts
```

实现项目必须建立自己的包管理锁文件和真实 Harness 兼容矩阵；不要将本包中的源码 revision 当成已通过本机测试的发行版。

## 文件使用

`PROJECT_SPEC.md` 是四份正文合并的单文件阅读版；`IMPLEMENTATION_PLAN.md` 将实施拆成16个有依赖与验收的工程任务。机器契约包括70个领域定义、51个HTTP操作、21种公开事件类型和13个Agent协作工具；原版Computer Use工具目录在运行时从已验证provider读取。

修改契约后可运行 `python scripts/generate_contracts.py` 和 `python scripts/generate_tools_examples.py` 更新生成产物，再运行校验。生成器只生成规格/样本，不实现Atrium Grove服务。SDK/CLI版本兼容模板见 `examples/compatibility-manifest.example.json`，所有原生门禁初始均为NOT_RUN。
