# TokenJuice 真实 Agent 输入 token 节省评测设计

## 结论

截至本研究快照，**不能声称 TokenJuice 已被证明会在真实 Agent 任务中节省模型输入 token**。`v0.8.5` 已证明 reducer 能把已观察到的终端文本变短；现有统计的单位也是 `rawChars`、`reducedChars`。这只是 *gross reducer character savings*，不是模型 API 所报的 input token，更不是完整任务所有请求之和的净节省。

对 Codex 尤其不能从字符数外推：当前 hook 把摘要放入 `hookSpecificOutput.additionalContext`，并把本次记录明确标为 `deliveryMode: "original-plus-additional-context"`、`measurement: "pre-delivery-summary-characters"`。按 v0.8.5 adapter 自己的交付合约，它没有抑制原始 tool result，而是在旁边再加摘要；因此这条 upstream 集成**不应被预期会省 token，且很可能增加上下文**。仍应对被测 Codex 版本做 sentinel preflight，因为最终 host 行为可能变化；未通过“原文不再进入后续请求”的版本不得进入节省统计。[`src/hosts/codex/index.ts:921-941`](../src/hosts/codex/index.ts:921) [`src/hosts/codex/index.ts:1537-1557`](../src/hosts/codex/index.ts:1537) [upstream PR #214](https://github.com/vincentkoc/tokenjuice/pull/214)

本设计的结论口径如下：只有在同一完整任务的 A/B/C 对照中，C（omit）既达到预注册的答案质量门槛，又在所有模型请求汇总后有正的、置信区间下界大于零的 input-token 差值，才可说“在该任务集、该 host/provider/model 配置下节省了 net end-to-end input tokens”。不把 reducer 字符节省、单次 tool 输出字符数或 UI transcript 字符数改称 token 节省。

## 范围、版本与证据规则

- 基线为 `upstream/main` tag `v0.8.5`，commit `001d5975184ea33f49441ed8724714472e4fca26`；本 checkout 的 `HEAD` 与此一致。
- 用户给出的 `/data/code/tokenjuice/candidate-v4` 在研究时不存在。可读的相邻 worktree 是 `/data/code/tokenjuice/candidate-v4-r2`，HEAD 为 `9a1ed34591c5ad6777f345458ef6eeed020f9fe5`（tag `fork-candidate/v0.8.1-migration-r2`），与基线的 merge-base 为 `49bdcf1755833ff1e02e44e6e7fe91c0fb44c16e`。下文把它称为“相邻候选 fork”，不把它误写成 v0.8.5 的线性后继，也不据此替代缺失的 `candidate-v4`。
- Lighthouse helper 研究快照为 `7c70eb2bb679ec42635b828ab6e79640ca7d31db`；其 `.agents/skills/cls` 是 symlink，实际共享 skill 来源为 LightCloud Skills commit `72b957581b099640e1a4a4206ceda6d2188ba293`。
- 除特别标明外，仓库行号都指向上述 v0.8.5 commit。相邻候选 fork 的引文同时给出其 commit。外部链接只使用一手资料；不能从一手资料确认的 host 行为标为“未知”。
- 本文是评测设计，不执行真实 CLS、GitHub 或生产业务查询，不保存真实业务日志、凭证、请求 ID 或用户数据。

## 现状：TokenJuice 做了什么，尚未测到什么

### 设计边界

TokenJuice 的定位是命令已执行后，对观察到的终端输出做确定性、规则驱动的压缩；`reduce` 处理已有文本，`wrap` 执行命令后压缩输出，`reduce-json` 给 host adapter 机器协议。README 也把 host adapter 定义为薄层，核心依据规则分类、变换、保留模式和 head/tail。[`README.md:9-11`](../README.md:9) [`README.md:190-201`](../README.md:190) [`docs/spec.md:58-78`](spec.md:58)

核心 reducer 先构造 stdout/stderr 的 raw 文本，按 rule 进行 ANSI 清理、过滤、重写、计数和 head/tail，然后产生 `inlineText`；`rawChars` 与 `reducedChars` 是去 ANSI 后的 grapheme 字符计数。默认 `maxInlineChars` 也是字符上限，而非模型 tokenizer 上限。[`src/core/reduce.ts:21-35`](../src/core/reduce.ts:21) [`src/core/reduce.ts:55-166`](../src/core/reduce.ts:55) [`src/core/reduce.ts:330-338`](../src/core/reduce.ts:330)

这一区分很关键：字符、UTF-8 bytes、某一模型的 tokens、缓存命中的计费 token 都不是可互换的单位；同一输出还可能在 host 中被追加、重排、截断或同时放入多个上下文位置。

### 现有 benchmark 与 telemetry 的盲点

| 现有机制 | 实际测量 | 不能回答的问题 |
| --- | --- | --- |
| `scripts/bench.mjs` | 遍历内置 fixture 调 reducer 或 fixture verification 的 wall-clock | 没有 Agent、模型请求、provider usage、缓存、重试、任务正确性或 A/B/C。 |
| `CompactResult.stats`、artifact metadata、`tokenjuice stats` | `rawChars`、`reducedChars`、ratio，按 reducer/命令/日期聚合 | 没有 provider/model/request ID、input/cache/output tokens、任务 ID、答案质量或 raw recovery 因果。 |
| Codex hook history | hook 计算的字符节省和 rewrite/skip 原因 | 不表示该摘要实际取代了原始 tool result，也不表示后续请求采用了它。 |
| `analyze-codex-logs.mjs` | 从工具输出文本匹配 `Original token count:`，再与 hook 字符统计拼接 | 不是 provider 对每个模型请求返回的 usage；当前还读取旧的 `tokenjuice-hook.history.jsonl`，而 hook 已写 bounded `history-v1` 目录。 |

`scripts/bench.mjs` 的两个模式只循环 reducer fixture 或 `verifyBuiltinFixtures()`。[`scripts/bench.mjs:12-45`](../scripts/bench.mjs:12) `CompactResult` 和存储 metadata 的字段也只定义字符统计与分类信息。[`src/types.ts:118-173`](../src/types.ts:118) `statsArtifacts` 对这些字段求和，并排除 capture-truncated 条目；这应继续叫 reducer 字符统计。[`src/core/analysis.ts:315-418`](../src/core/analysis.ts:315)

为保护本地命令内容，telemetry 写入前删除 `command`、只尝试保留安全的 `commandFamily`；这是合理的隐私取舍，但也说明它不能独立做逐请求、逐任务归因。[`src/core/artifacts.ts:141-179`](../src/core/artifacts.ts:141) Codex hook 的 debug 同样只写 `rawChars/reducedChars/savedChars/ratio/matchedReducer/compaction`。[`src/hosts/codex/index.ts:1519-1529`](../src/hosts/codex/index.ts:1519)

`analyze-codex-logs.mjs` 将字符串 `Original token count: (\d+)` 当作工具输出中的可解析文本，而不是 API usage；hook history 的路径也仍是旧 JSONL 文件。它适合探索开发日志，不可作为本设计的主指标来源。[`scripts/analyze-codex-logs.mjs:7-15`](../scripts/analyze-codex-logs.mjs:7) [`scripts/analyze-codex-logs.mjs:164-194`](../scripts/analyze-codex-logs.mjs:164) [`scripts/analyze-codex-logs.mjs:363-465`](../scripts/analyze-codex-logs.mjs:363)

### GitHub CLI reducer 的含义

`cloud/gh` 规则匹配 `gh`/`ghx`，清除 ANSI、去相邻重复并执行 head/tail；非零退出时提高保留头尾行数。[`src/rules/cloud/gh.json:1-29`](../src/rules/cloud/gh.json:1) formatter 会将 JSON record 投影成编号、标题、状态、分支、labels、日期等字段；`--no-omit` 对 labels 只放宽列表截断，不会把 JSON 原字节返回。[`src/core/reduce-formatters.ts:177-230`](../src/core/reduce-formatters.ts:177) `gh run view --log` 的 signal filter 又会仅保留信号行和邻近上下文。[`src/core/reduce-formatters.ts:574-638`](../src/core/reduce-formatters.ts:574)

因此现有 `cloud/gh` fixture 只能证明此 reducer 的文本行为，不能证明真实 GitHub Agent 任务的 token 节省。[`src/rules/fixtures/cloud/gh.fixture.json:1-16`](../src/rules/fixtures/cloud/gh.fixture.json:1)

## `--no-omit`、metadata 与 Codex hook 风险

### B 组不是未经验证的 byte-lossless 组

相邻候选 fork 有 `TOKENJUICE_NO_OMISSION`，truthy 值启用 no-omit；CLI 也解析 `--no-omit` / `--allow-omit` 并拒绝二者同用。候选 Codex runtime 将 policy 传给共享 compactor。[候选 `9a1ed345` `src/core/env.ts:1-5`] [候选 `9a1ed345` `src/cli/main.ts:495-509,581-585`] [候选 `9a1ed345` `src/hosts/codex/index.ts:1149-1169,1242-1262`]

这不是可从现有 worktree 断言为“仅 fork 新增”的能力：v0.8.5 也定义相同环境变量，并把 CLI flag/env 解析为 `noOmit` 后传入 reducer/Codex hook。[`src/core/env.ts:1-5`](../src/core/env.ts:1) [`src/cli/main.ts:517-523`](../src/cli/main.ts:517) [`src/cli/main.ts:788-790`](../src/cli/main.ts:788) [`src/hosts/codex/index.ts:1376-1508`](../src/hosts/codex/index.ts:1376) 由于用户指定的 fork worktree 缺失且相邻 fork 与基线分叉较早，本文只记录其已核验的 policy 与 Code Mode replacement 演进；关于缺失路径的精确 diff 为未知。

它确实关闭了 head/tail 与字符 clip 的省略：这些路径返回全部文本并标为 `no-omit-*-passthrough`。当前 upstream 亦如此。[`src/core/text.ts:181-206`](../src/core/text.ts:181) [`src/core/text.ts:218-263`](../src/core/text.ts:218) [`src/core/compaction-metadata.ts:17-55`](../src/core/compaction-metadata.ts:17)

但 no-omit 不等于统一的 byte-lossless：reducer 仍可能 pretty-print JSON、strip ANSI、trim 空边、重写 `git status`；`gh` JSON 路径仍是字段投影，no-omit 仅保留更多 labels/status-check 项。[`src/core/reduce.ts:62-69`](../src/core/reduce.ts:62) [`src/core/reduce.ts:102-121`](../src/core/reduce.ts:102) [`src/core/reduce-formatters.ts:177-230`](../src/core/reduce-formatters.ts:177) [`src/core/reduce-formatters.ts:640-681`](../src/core/reduce-formatters.ts:640)

故本设计将 B 的正式名称定为 **TokenJuice no-omit（内容保留待测）**。每个 fixture 都须有 preservation oracle：对承诺 byte 原样的命令比较 SHA-256，对结构化输出比较预注册的必需字段和顺序。若需要真正 byte-lossless control，应另设 raw pass-through，不把 B 自动当作它。

已有一个直接反例足以阻止把 B 命名为 lossless：`gh pr view ... --json number,title,url,headRefOid` 的对象即使设置 `noOmit=true`，`formatGhJsonRecord` 仍只生成类似 `#42 Example` 的投影，`url` 与 `headRefOid` 不会出现在结果中，且 metadata 仍可能是 `authoritative:false`。这应成为第一条 fidelity regression；在修复前，B 组只能评估“现有 no-omit 行为”，不能代表“不丢失信息”。[`src/core/reduce-formatters.ts:177-230`](../src/core/reduce-formatters.ts:177) [`src/core/compaction-metadata.ts:25-55`](../src/core/compaction-metadata.ts:25)

`CompactionMetadata.authoritative/kinds` 是 reducer 对省略类别的声明，而不是“模型已少读多少 token”的证据。[`src/core/compaction-metadata.ts:17-55`](../src/core/compaction-metadata.ts:17) 它应作为二级解释变量记录，例如分析“hashed-middle-clip 是否更常导致 recovery”，不能作为主节省指标。

### Codex：摘要存在不代表原文不在模型上下文

当前 v0.8.5 的 Codex hook 会把 JSON 包装的 compacted observation 写进 `additionalContext`，没有输出替换 decision；成功路径的 debug 明说它是 `original-plus-additional-context`。这不是一个可用于宣称节省的交付路径：upstream 合并的 PR #214 也明确写明“does not claim ... command suppression”。[`src/hosts/codex/index.ts:872-941`](../src/hosts/codex/index.ts:872) [`src/hosts/codex/index.ts:1537-1557`](../src/hosts/codex/index.ts:1537) [upstream PR #214](https://github.com/vincentkoc/tokenjuice/pull/214)

相邻候选 fork 曾针对 Code Mode 调整过这一路径：commit `9aec1c3c7c9d25457e861df40cec4f27eb416f4f` 将 `continue:false` 改为 `decision:"block"`，源码注释称前者只替换 native path，outer `custom_tool_call_output` 仍会泄漏原 Bash 输出；候选文档记录同一限制。该方案在 upstream PR #212 有完整的一手问题描述，但 PR 最终关闭、未合并，所以不能把 fork 的替换保证套到 v0.8.5。[upstream PR #212](https://github.com/vincentkoc/tokenjuice/pull/212) [候选 commit `9aec1c3c7c9d25457e861df40cec4f27eb416f4f`] [候选 `9a1ed345` `src/hosts/codex/index.ts:778-794`] [候选 `9a1ed345` `docs/codex-integration.md:8-32`]

该 fork 的 live E2E 使用真实 Codex 加 fake `gh`，检查 transcript 中 raw marker 不出现于 `function_call_output`，这是有价值的**交付合约**验证；但它最后相加的是字符长度，并没有读取每次 provider 请求的 input/cache/output usage，不能升级为 token 节省证据。[候选 `9a1ed345` `scripts/codex-live-e2e.mjs:244-305`]

官方 Codex Hooks 文档也应作为实现前的 host contract 来源：[PostToolUse](https://learn.chatgpt.com/docs/hooks#posttooluse) 与 [large hook output](https://learn.chatgpt.com/docs/hooks#large-hook-output)。它们只用于核对 hook 返回语义与大小限制；测试结论仍以被测版本的真实请求记录为准，因为 host 行为会随版本变化。

### raw recovery 与重试必须另计

v0.8.5 可以识别显式 `tokenjuice wrap --raw/--full` bypass，并在 opt-in `TOKENJUICE_CODEX_STORE` 时留 artifact，但现有字段不能表达“Agent 因为先前摘要不够而第几次恢复了原始证据”。[`src/hosts/codex/index.ts:842-870`](../src/hosts/codex/index.ts:842) [`src/hosts/codex/index.ts:1287-1290`](../src/hosts/codex/index.ts:1287) [`src/hosts/codex/index.ts:1473-1481`](../src/hosts/codex/index.ts:1473) 新 harness 必须将 raw rerun、artifact read 和普通失败重试分成事件，避免 C 组表面压缩、实际用更多工具调用把成本取回。

## 评测问题、边界与 A/B/C 协议

### 一次 run 的边界

一个 run 从同一版本的 agent 收到固定任务提示开始，到它提交通过机器 oracle 的最终答案为止；中间的**所有**模型请求、工具调用、工具重试、raw recovery、模型重试和 host error 都归入该 run。达到 request/tool/时间预算但未答对也结束，记为失败并保留已消耗 token；不得只比较“第一次大输出后的下一次请求”。

三个 arm 只改变 shell-result delivery，其他均固定：模型与版本、agent 版本、system/developer prompt、任务文本、fixture SHA、工具 schema、工作目录、环境变量白名单、并发槽位和最大预算。

| Arm | shell result 到 agent 的交付 | 用途 | 不可预设的结论 |
| --- | --- | --- | --- |
| A：baseline | 不装、不调用 TokenJuice；fixture tool 的 stdout/stderr 原样按 host 的普通路径返回 | 基准成本和质量 | 原始输出一定进入全部后续模型请求。必须由 gateway 观测。 |
| B：no-omit | 对相同工具结果调用 TokenJuice，`noOmit=true` / `--no-omit`；记录完整 reducer metadata | 分离“有 reducer/格式化”与“允许 omission” | byte-lossless 或 token 为零变化。按 fixture oracle 判断。 |
| C：omit | 相同 reducer、默认 omission 和相同 inline budget | 评估产品目标 | `rawChars-reducedChars` 就是 net token 节省。 |

主实验应先用**harness-owned shell adapter**执行三个 arm，而非直接依赖某个不透明 host hook：它可以记录 raw result、TokenJuice delivery result 和结果的 fixture hash，同时 provider gateway 记录模型请求。Codex hook 则是单独的 host-delivery acceptance：它复用 C 的含 raw sentinel fixture，验证 host 版本在下一次模型请求中真正替换而非追加；只有通过后，才可把该 Codex host 纳入主 A/B/C 数据。

每个 arm 的 tool adapter 都要发出下列不含真实内容的事件：`run_id`、`task_id`、`arm`、`tool_call_id`、命令类别/fixture ID、exit code、raw/delivered UTF-8 bytes、字符数、SHA-256、reducer ID、compaction kinds、capture-truncated、`delivery_claim`。fixture 模式只允许记录预先审过的合成文本；未来生产采样默认只写 hash、大小、类别和 IDs。

### 必经的交付 sentinel 测试

每个大输出 fixture 在“应被 C 省略的中段”植入唯一合成 token，例如 `RAW_ONLY_SENTINEL_7F3A`，在保留的关键证据中植入 `RETAINED_EVIDENCE_91C2`。工具返回后，扫描**下一次及其后的每个实际 provider 请求的最终请求体**：

1. A 应观察到 raw sentinel（若 host 把 tool result server-side 引入导致 body 中不可见，则此项标为不可观察，并以 provider usage 加 transcript adapter 佐证）。
2. C 必须没有 raw sentinel，且有 retained evidence 和正确答案所需事实；否则是“未证实交付替换”，该 host/fixture 的 token 成绩无效。
3. B 按 fixture 的 preservation oracle 检查，而非假定 raw sentinel 必然逐字出现。
4. 检查所有后续请求而非只检查紧邻的一次，以捕获 host 重新注入历史、自动上下文压缩或 retry replay。

sentinel 是合成固定值，只用于隔离的 benchmark；不得在任何真实日志或 GitHub canary 中插入或搜索它。

## 场景矩阵

核心数据集必须是版本化、离线、可复现的 fixture。所有 case 产物记录 `fixture_id`、SHA-256、生成器版本和 expected-answer 版本。

| 场景 | Agent 要完成的任务 | fixture 工具/高噪声来源 | 正确性 oracle | A/B/C 主指标 |
| --- | --- | --- | --- | --- |
| CLS 风格日志调查（主场景） | 依据时间窗、request/flow 关联，给出失败原因、是否重试成功、最终状态和下一步 | 本地 `cls_fixture_query` 模拟 `cls_query.py` 的 target/component/query/time/limit/sort/output；含同窗无关日志、重试链和最终事件 | 严格 JSON：`root_cause_code`、`attempt_count`、`final_status`、`evidence_event_ids` 全匹配 | 总模型 usage、工具次数、窄化查询是否正确、raw recovery。 |
| GitHub PR/issue JSON | 从列表判断唯一需要处理的 PR/issue 并给出编号、状态和标签证据 | PATH 中 fake `gh` 校验 argv，返回固定 JSON/JSONL | 严格 JSON 字段和必需 ID | `cloud/gh` 投影/no-omit 对质量、input/cache/output、重试的影响。 |
| GitHub Actions failed log | 找到失败 step、命令和错误类别，不把成功噪声当根因 | fake `gh run view --log-failed` 返回固定、含 signal/非 signal 行的长日志 | 精确 step/error/行动建议；保留 signal sentinel | signal filter 是否真实降低输入且不损质量。 |
| 通用诊断控制 | 解释一份固定测试失败或 `rg` 结果并定位文件/行/失败断言 | 已审计的内置 fixture 派生的本地命令 | 文件、行、错误类别和结论 | 验证结果不只由 GH/CLS formatter 驱动。 |

场景按“任务完成至正确答案”计分，不能让 agent 在看到大输出后直接回复一句“已阅读”。每个任务预注册最大 12 个模型请求、20 次工具调用、10 分钟墙钟；超过预算是失败而不是悄悄重试到成功。具体上限在 pilot 后只能整体版本化调整，不能按 arm 调整。

### 可重复且不泄露业务数据的 CLS 风格 benchmark

Lighthouse helper 的 `cls` symlink 指向共享 LightCloud Skills；该 skill 给出了可迁移的调查形状：target/component 选择、query、窄时间窗、limit、排序，默认 `summary` 输出；它要求保留 request ID/错误码、限制窗口和条数、输出脱敏，且凭证只从环境/.env 读取，不进入参数或结果。[LightCloud Skills `72b9575` `skills/cls/SKILL.md:6-21,34-43,74-76`] 脚本也要求 `--query`，限制 `--limit` 为 1..1000，并提供 `summary`、`api-events`、`redacted-json`、`raw-json` 格式。[LightCloud Skills `72b9575` `skills/cls/scripts/cls_query.py:180-249`]

这里有一个必须隔离的上游变量：CLS CLI 默认 `summary` 本身就是有损的，只展示前 5 条记录、每条 preview 默认 240 字符，并显式统计 `OmittedFetchedRecordCount`。[LightCloud Skills `72b9575` `skills/cls/scripts/cls_runtime/output.py:10-11,408-438`] 因此“TokenJuice 单因素”主实验要让 fake CLI 输出完整的 `redacted-json`；另设一个“真实默认栈”次级场景使用 `summary`，衡量 CLS 自己的摘要与 TokenJuice 叠加后的整体效果，但不能把前者造成的遗漏归因给 TokenJuice。

基准不复制 helper 的真实案例文本，也不调用 CLS。生成器产生一份合成 JSONL：

- 使用固定的虚构 `req-bench-*`、`flow-bench-*`、服务名、时间戳和错误码；绝不保留真实 UIN、实例 ID、域名、IP、request ID、SQL、Cookie 或错误消息。
- 固定注入一条失败、两次有因果关联的 retry、一个最终 success/abort 事件、同时间窗至少 20 倍无关噪声，以及中段 raw sentinel；再用 deterministic PRNG 生成重复噪声。seed 写入 fixture metadata。
- fake CLI 仅实现该 skill 已展示的只读参数子集；拒绝网络、拒绝读取环境凭证、拒绝任意 Topic ID。它根据 fixture 返回排序和 limit 后的合成记录，并实现 `summary`/`redacted-json` 两种离线输出。
- 建库测试扫描 fixture 和运行产物，拒绝常见 secret 前缀、私网/公网 IP、真实 UUID、邮箱、`CLS_SECRET_`、`Authorization`、用户标识以及未列入 allowlist 的字符串；失败即不打包。

这保留了“先宽查、再窄查、串联 retry 与最终状态”的 Agent 推理压力，同时将业务泄露风险降到 fixture 生成时，而不是依靠结果展示时临时脱敏。helper worktree 当前有未提交用户改动，故上面的引文只说明研究时已读的工作区材料，不将其未提交内容复制入本仓。

## GitHub CLI：固定核心回归，少量 live canary

核心回归一律固定 fixture/mock：fake `gh` 由临时 PATH 优先解析，断言完整 argv，返回带 fixture SHA 的固定 stdout/stderr/exit code；网络禁用、GitHub token 不传给子进程。JSON list、分页边界、`run view --log-failed`、非零退出和包含 raw sentinel 的长日志都覆盖在版本控制数据中。这样 A/B/C 的差异来自 reducer 与 Agent 决策，而不是仓库更新、issue 状态、API 限流、网络延迟或 GitHub CLI 版本。

live canary 不进入节省统计，只做 1--3 个串行、预算很小的检查：确认经认证的 `gh` 可执行、当前 TokenJuice/Codex hook 能触发、provider gateway 的 correlation 没有断裂。canary 应选只读且不依赖具体 issue/PR 结论的公开元数据；输出只记录成功状态、版本、HTTP/CLI 错误类别与 token availability，不保存响应正文。原因是 live 调用能检验集成存活，却会把网络波动、GitHub 数据变化、认证和 rate limit 混进核心效应。

## 主指标、质量和统计方法

### 原始记录与标准化 usage

`ProviderUsageAdapter` 对每次真实模型请求保留 provider 原始 usage JSON（在合成 fixture 试验中可保留；其他模式仅保留字段白名单），并规范化为以下可空字段：

| 字段 | 规则 |
| --- | --- |
| `input_tokens_reported` | provider 明确返回的 input/prompt token 原生值；没有就为 `null`，不得由 chars 推算后伪装为 reported。 |
| `cached_input_tokens_reported`、`cache_write_tokens_reported` | 单独原样映射；不同 provider 的定义不同，不在公共层盲目相减。 |
| `logical_input_tokens` | 由版本化 provider adapter 按该 provider 的官方语义规范化；语义未知时为 `null`。这是同一 provider/model 内 A/B/C 的主 token 指标。 |
| `billable_input_cost` | 使用冻结的 provider/model 价格快照，将普通/cache-read/cache-write 分项计算；价格或字段未知时为 `null`。 |
| `output_tokens_reported`、`reasoning_tokens_reported` | 逐请求保存；reasoning 若已包含在 output，adapter 记录该 provider 的包含关系为 `unknown/known`，不重复相加。 |
| `provider_request_id`、`response_id`、HTTP status、model、service tier | 用于去重、retry 链与跨 run 审计。 |
| `usage_status` | `final`、`missing`、`partial`、`error`；stream 未等到最终 usage 不能补零。 |

例如 OpenAI Responses 的 adapter 将 `input_tokens` 作为 logical input，并把 `input_tokens_details.cached_tokens/cache_write_tokens` 作为其分项；官方 prompt-caching 示例中二者位于 `input_tokens` 总量内。Anthropic Messages 的官方说明则把 `input_tokens` 定义为既未 cache-read、也未 cache-create 的尾部 token，因此 logical input 需按 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` 计算。公共 schema 必须保留这种差异，不能用一个跨 provider 的减法。[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching) [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

流式请求必须在收到终结 event/response 后才关闭 usage record；中断、连接断开或 provider 不返回 usage 都标 `missing`，并单列 coverage。OpenAI Responses 官方 reference 说明 response 可以流式返回、会话项可由服务端自动加入后续 response；因此只有抓取最终实际请求/响应并保留 provider semantics，才能避免把客户端可见文本当成完整上下文。[OpenAI Responses Create（官方）](https://developers.openai.com/api/reference/resources/responses/methods/create)

### 指标定义

对一个完成或失败的 run，令 (R) 为所有实际模型请求集合。主计量不做 tokenizer 估算：

```text
gross_reducer_saved_chars
  = Σ（每个实际 rewrite 的 rawChars - reducedChars）

end_to_end_logical_input_tokens
  = Σr∈R logical_input_tokens(r)

end_to_end_cached_input_tokens_reported
  = Σr∈R cached_input_tokens_reported(r)

end_to_end_output_tokens_reported
  = Σr∈R output_tokens_reported(r)

net_input_saving(A, X)
  = logical_input_tokens(A) - logical_input_tokens(X), X ∈ {B, C}
```

`gross_reducer_saved_chars` 只能作机制诊断和按 reducer 分层，绝不放到“token saved”列。主表报告 A、B、C 的原生 `input/cache/output`、adapter 规范化的 logical input、冻结价格下的 cost 和 `net_input_saving`；缓存字段同时显示，不用“cache 命中”掩盖 input 增加。主结论只在同一 provider/model/version 内比较；若 adapter 无法确认 logical-input 语义，该 provider 的 token 主指标为未知，而不是套用另一个 provider 的公式。

二级指标：任务完成率、质量分、模型请求数、工具调用数、非零工具退出数、模型 transport retry 数、tool retry 数、`wrap --raw/--full` rerun 数、artifact-read recovery 数、墙钟、hook latency、delivery-sentinel 通过率，以及 coverage/missing usage 率。raw rerun 与 artifact read 的定义不可混用：前者重新执行命令，后者仅读已留存原文。

质量采用确定性 JSON schema + exact field oracle；自由文本仅作辅助解释并由不知道 arm 的 reviewer 抽样复核。主分析为 intention-to-treat：失败、超时、重试都保留成本。仅成功 run 的“quality-qualified”分析可作为次级敏感性分析，不能替代主分析，因为它会隐藏 compression 导致的失败。

### 随机化、缓存控制与推断

- 每个 `task × fixture_sha × model_config × seed/block` 运行 A、B、C 各一次，arm 顺序随机；固定 agent 和提示，隔离临时工作目录。模型不支持固定 seed 时记录其为 `unsupported`，以相邻时间块而不是虚假配对处理。
- 先进行每场景 10 个三元组的 pilot，只估方差、缺失 usage 和 delivery。主实验 token 差值至少 30 个三元组/主场景；最终样本量由 pilot 方差和质量非劣效界共同做 power calculation。若要支持“质量最多下降 5 个百分点”的置信区间，通常需要远多于 30 个 run，不能拿 30/30 成功直接宣称满足该门槛。有效不等于只答对：必须有完整 usage coverage；质量失败仍留在 ITT 分母。
- 预注册 cold 与 warm 两个 cache strata。cold 用独立会话/缓存命名空间；warm 使用同样固定前缀和预热脚本。若 provider 无法隔离 cache，保留原始 cache 字段、将该 strata 标为受污染，不比较其缓存拆分。
- 对配对差 `A-X` 做 block-stratified bootstrap（10,000 次）给均值、median、95% percentile CI；同时给每 task 的散点/分布和总和比率。不要只报 p 值，也不要用“每次平均字符比”代替总 token 比。
- 任何重复 HTTP attempt 都是单独请求；adapter 以 provider request ID、response ID、时间窗和 body hash 建 parent/retry 链，去重只能用于已证实同一日志事件的重复采集，不能抹掉实际计费 retry。

## 薄观察模块：网关、adapter 与 harness 的职责

### 架构

```text
HarnessRunner ── tool adapter ── fixture command / TokenJuice ── ToolDeliveryEvent
     │
     ├── benchmark metadata/header ──> model gateway ──> provider
     │                                      │
     │                                      └── ProviderUsageAdapter ──> ModelRequestEvent
     │
     └── final-answer oracle + retry/recovery classifier ──> RunReport
```

最小实现是 benchmark 专用的 pass-through gateway，而非修改生产流量：runner 把自身可配置的 provider base URL 指向它；gateway 透传请求/响应，只记录 request body hash/byte length、白名单 correlation header、provider IDs 和最终 usage。v1 只支持 OpenAI Responses 的 HTTP + SSE，并在 benchmark 配置中禁用/不启用 WebSocket；Anthropic Messages 是第二个真实 adapter，WebSocket 等 transport 只有出现真实被测 host 后再加。合成 fixture 的 sentinel delivery test 允许在受控磁盘短暂解析请求 body；其余模式默认不存 prompt/tool 文本。TLS、凭证、保留期和 egress 仅限专用测试账号与临时目录。

若必须观察实际 Codex hook，追加一个**可选、只在 benchmark 注入**的 `ToolDeliveryEvent` 写点即可：在 `compactBashResult` 的 caller 记录 raw/delivered hash 与 metadata，在 host 写出最终 hook payload 前记录 `delivery_claim`。`compactBashResult` 已是后置 Bash integrations 的共享收敛点，适合提供不改变 reducer 行为的 observation callback；但网关仍是 token 主真值。[`src/core/integrations/compact-bash-result.ts:76-144`](../src/core/integrations/compact-bash-result.ts:76)

### 职责切分

| 组件 | 必须负责 | 不应负责 |
| --- | --- | --- |
| `HarnessRunner` | 固定 fixture/环境/arm、生成 `run_id/task_id/attempt`、调度并发、收集工具 retry/recovery、最终答案 oracle、汇总 A/B/C | 解析某 provider 私有 usage schema，或从字符数估计主指标。 |
| `ProviderUsageAdapter` | 对一个 provider 的已支持 transport 取最终 usage，保留原生字段和规范化可空字段，建立 request/retry correlation | 判定任务是否答对，或假设不同 provider 的 cache 字段相同。 |
| `Benchmark gateway` | 观察最终离开 agent 的请求、响应终态与 provider ID；按 `run_id` 安全写事件 | 修改 prompts/结果、做 TokenJuice 压缩、把缺失 usage 补为零。 |
| TokenJuice/host observation hook | 描述 reducer 输入、输出、mode、metadata、raw-recovery 信号 | 宣称模型看到的最终内容或自行计算 provider token。 |

`run_id` 应出现在 runner metadata/header，并在每条事件带 `request_seq`、`thread_id`、`turn_id`、`tool_call_id`（有则填）。并发下只按时间关联是不够的；header 被 host/provider 丢弃时，须以 response ID、父 response ID、会话 ID、单调序号和受控测试 prompt 的 run marker 交叉关联，并将模糊关联标为 `unresolved`。

### 网关的价值与硬限制

网关的价值是它观测到 host **构造完成后实际发送**的模型请求，因而能汇总所有 turn、retry、cache/output usage，并用 raw sentinel 直接检验“原工具结果是否仍被送入模型”。这比 reducer 自报字符数强得多。

它仍看不见：

- 完全没有进入模型请求的本地 tool output；这在成本上可能是零，但网关不能说明 host 为什么丢弃它。
- host 内部的历史裁剪、摘要、隐式 system/developer 消息、UI transcript 渲染、server-side conversation state 与 hosted tool 内部上下文；`previous_response_id`/conversation 类 API 还可能不重发历史正文。
- 不能配置 base URL 的封闭客户端、直连绕过、非 HTTP transport、TLS pinning、另一个进程或本地模型；不得以通用 MITM 取代专用 test gateway。
- provider 未返回、流断开前尚未返回或只给账单汇总的 usage；只能报告未知/partial，不可推算。
- 跨 provider 的 cache 定义、输入是否含 cached tokens、reasoning 是否包含在 output、价格与隐藏服务端开销；原生字段必须同归档保留。

故 gateway 是“端到端请求计量的最强可用证据”，不是整个 host 内部状态的全知探针。它必须与 ToolDeliveryEvent 和真实 host transcript acceptance 一起解释。

## 分阶段实施与 go/no-go

| 阶段 | 交付物 | 通过条件 | 停止/返工条件 |
| --- | --- | --- | --- |
| 0. 计量可行性 | 事件 schema、gateway、一个 provider adapter、合成 sentinel fixture、A/B/C dry run | 100% 可归因模型请求有 final usage 或明确 `missing`；sentinel 可判定；不写真实文本 | 不知道请求属于哪个 run、stream completion 丢失、或需要从 chars 补 token。 |
| 1. 交付正确性 | harness shell adapter；每个候选 host 的 transcript/gateway acceptance | C 中 raw sentinel 在后续请求不出现、保留证据出现；B 通过自己的 preservation oracle | C 仍追加原始结果、no-omit 丢失必需字段、host 更新后行为变更。该 host 不进入 token 对比。 |
| 2. 离线 pilot | 四个固定场景各 10 个随机三元组 | 质量、usage coverage、cache strata、retry 分类和方差均可报告 | 任一 arm 的隐性环境差异、fixture 泄露检查失败、缺失 usage 影响主结论。 |
| 3. 主回归 | 每主场景 token 差值至少 30 个三元组，并按 pilot 完成质量门槛的 power calculation；bootstrap 报告；冻结 fixture/model/agent 版本 | 见下方 go 门槛 | 仅有 gross chars 正值、样本量不足、未达到质量或 delivery 门槛。 |
| 4. live canary | 极小只读 GitHub/Codex 集成检查 | 能发现认证、CLI、hook、gateway 断裂并与主指标隔离 | 把 canary 波动并入 core token 回归。 |

初次 **go** 门槛（全部满足）为：

1. 主场景中可计量请求覆盖率至少 99%，其余 1% 也有明确 `missing` 原因；不以估算补齐。
2. 每个纳入统计的 host/fixture 的 C 都 100% 通过 sentinel replacement；B 通过预注册内容保留 oracle。
3. C 的质量完成率相对 A 的双侧 95% CI 下界不低于 -5 个百分点，且没有任何必需证据字段系统性缺失。
4. 预注册主场景合并后，C 相对 A 的 paired `net_input_saving` median 至少 10%，且 bootstrap 95% CI 下界大于 0；同时完整报告 cache、output、总请求和 retry，不能只挑选成功任务。
5. C 的 raw-rerun recovery 不超过通过任务的 5%，且总工具调用的 CI 上界不高于 A 10% 以上。超出时即使 input 下降，也需先判断质量/操作成本的取舍。

任一条件不满足的结论是 **no-go / 尚不能宣称真实 token 节省**，并按失败点修复交付、fixture 保留语义或计量，而不是调低统计门槛。B 的结果应单独展示：它是诊断“格式化/无 omission”影响的 control，不要求一定节省 token。

## 一手资料索引

### v0.8.5（`001d5975184ea33f49441ed8724714472e4fca26`）

- 产品边界和 raw/store/stats：[`README.md:9-11`](../README.md:9)、[`README.md:190-201`](../README.md:190)、[`docs/spec.md:150-169`](spec.md:150)。
- reducer、无省略分支、shared post-tool primitive：[`src/core/reduce.ts:55-166`](../src/core/reduce.ts:55)、[`src/core/text.ts:181-263`](../src/core/text.ts:181)、[`src/core/integrations/compact-bash-result.ts:76-144`](../src/core/integrations/compact-bash-result.ts:76)。
- 统计/telemetry：[`src/types.ts:118-173`](../src/types.ts:118)、[`src/core/artifacts.ts:141-179`](../src/core/artifacts.ts:141)、[`src/core/analysis.ts:315-418`](../src/core/analysis.ts:315)、[`scripts/analyze-codex-logs.mjs:7-15`](../scripts/analyze-codex-logs.mjs:7)、[`scripts/analyze-codex-logs.mjs:363-465`](../scripts/analyze-codex-logs.mjs:363)。
- Codex delivery：[`src/hosts/codex/index.ts:872-941`](../src/hosts/codex/index.ts:872)、[`src/hosts/codex/index.ts:1376-1557`](../src/hosts/codex/index.ts:1376)、[`scripts/local-host-e2e.mjs:139-205`](../scripts/local-host-e2e.mjs:139)。
- GitHub reducer/fixture：[`src/rules/cloud/gh.json:1-29`](../src/rules/cloud/gh.json:1)、[`src/core/reduce-formatters.ts:177-230`](../src/core/reduce-formatters.ts:177)、[`src/core/reduce-formatters.ts:574-681`](../src/core/reduce-formatters.ts:574)、[`src/rules/fixtures/cloud/gh.fixture.json:1-16`](../src/rules/fixtures/cloud/gh.fixture.json:1)。

### 相邻候选 fork（不是缺失的 `candidate-v4`）

- 当前可读版本：`candidate-v4-r2` commit `9a1ed34591c5ad6777f345458ef6eeed020f9fe5`；policy 源码见其 `src/core/env.ts:1-5`、`src/hosts/codex/index.ts:1149-1288`，live E2E 见 `scripts/codex-live-e2e.mjs:197-305`。
- Code Mode replacement 演进：commit `9aec1c3c7c9d25457e861df40cec4f27eb416f4f`（`decision:"block"`）及其 `src/hosts/codex/index.ts` diff；no-omit policy 演进：commit `f4110139290c3b43ec98169936b660270d4d6c29`、`dd3d317780f957419164d6575ed506bec7826780`。

### Lighthouse / LightCloud Skills 研究快照

- helper 消费仓：`7c70eb2bb679ec42635b828ab6e79640ca7d31db`；其 `.agents/skills/cls` 为 symlink。
- 共享 CLS skill 实际来源：LightCloud Skills `72b957581b099640e1a4a4206ceda6d2188ba293`，`skills/cls/SKILL.md:6-21,34-43,74-76`。
- 参数、limit、输出模式与执行：同 commit 的 `skills/cls/scripts/cls_query.py:180-249`；默认 summary 有损行为：`skills/cls/scripts/cls_runtime/output.py:10-11,408-438`。

### 外部一手资料

- [OpenAI Responses Create API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [OpenAI Codex Hooks: PostToolUse](https://learn.chatgpt.com/docs/hooks#posttooluse)
- [OpenAI Codex Hooks: large hook output](https://learn.chatgpt.com/docs/hooks#large-hook-output)
- [TokenJuice upstream PR #214：当前 Codex 路径不宣称 suppression](https://github.com/vincentkoc/tokenjuice/pull/214)
- [TokenJuice upstream PR #212：fork replacement 问题、验证与未合并结局](https://github.com/vincentkoc/tokenjuice/pull/212)
