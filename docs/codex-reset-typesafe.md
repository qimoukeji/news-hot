# codex-reset 接入 TypeSafe AI 可行性调研

调研日期：2026-10-09。范围：当前工作区的 codex-reset 实现、已保存的实帖评测、TypeSafe 官方文档和官方 JavaScript SDK v0.6.0 源码。此次未发送模型或采集请求，未安装依赖，未修改运行配置或业务数据；没有 TypeSafe 实测结果。

## 结论

**项目决定：codex-reset 不接入 TypeSafe AI，保留现有模型识别流程。不开展 TypeSafe 旁路评测、过滤器或局部替换。** 本报告保留能力边界与成本分析，不作为待执行的接入计划。

**TypeSafe AI 可以承担封闭选项判断、评分和抽取结果核验，但不能直接替换生成式结构化抽取。** Jev 不生成自由文本；把它接入应用需要将任务改成明确的 Choice、Score、Noul 问题。官方也明确说明，它不是聊天或代码生成 LLM。[Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents)

不接入的依据是：翻译与开放字段抽取仍需要生成模型，节省总成本的空间尚未证明；TypeSafe 对本模块难点的准确性提升没有实测证据；第二家服务的回执、预算、恢复和分歧处理会增加维护成本。不能只改 MONITOR_MODEL、地址和模型名完成接入。[官方生成能力边界](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

TypeSafe 是提供 Jev 判断模型的托管服务及其 SDK，不是能统一调用任意大模型的通用接入库。它的结构化输入与类型化答案，不等于现有 Zod Schema 所描述的自由抽取输出。[API reference](https://docs.typesafe.ai/api)

## 与当前模块逐项对照

当前流程是 `processPending → recognizePost → chatJson → paidRequest → applyRecognition`。一次模型调用同时做判断、抽取和中文表达；代码再负责证据核验、时间换算、去重、范围保护和事件写入。

本地依据：[识别器与 Schema](../modules/codex-reset/backend/recognize.ts#L72)、[按时间顺序识别](../modules/codex-reset/backend/scan.ts#L327)、[事件组装](../modules/codex-reset/backend/assemble.ts#L184)、[模型 HTTP 接入](../packages/backend/src/providers/llm.ts#L149)。

| 当前输出或职责 | TypeSafe 能否承担 | 接入条件 |
| --- | --- | --- |
| relevant、real、kindExplicit、outage | 可以局部替换 | Noul/Choice；相关性要涵盖重置、重置卡和 Codex 故障，不能只看 reset 关键词 |
| 每条命题的 kind、action、role | 可以局部替换 | Choice；必须先明确是哪条命题，帖级单一 action 无法表示同帖多个动作 |
| relatesTo、timeSourceId、duplicateOf | 适合候选选择 | 给定有效事件 ID、上下文 ID 或已有命题编号，加 none/ambiguous；选完仍由代码校验 |
| count、plans | 可以改为有限候选判断 | count 用明确数值候选，不能四舍五入 Score；plans 可逐套餐判断，但不能丢失非套餐对象条件 |
| statedTime | 有条件可拆解 | 先识别原文时间部件和来源，再交给现有代码计算；复杂否定、跨日回复与区间需实测 |
| excerpt、audienceSource | 不能直接生成任意原文片段 | 规则或生成模型先给候选，Choice 再选；候选完整性是新增工作 |
| translationZh、contextZh、excerptZh、audienceZh、productsZh | 不能等价替换 | Jev 不做自由文本生成；完整中文翻译和任意对象条件仍需生成模型 |
| 变长 propositions、同帖多个事件及重复解释 | 不能直接生成整份列表 | 先找完整命题候选，再逐项判断和组装；不能把每个句子机械当成独立事件 |
| expectedLanding 的时间与中文 note | 不能原样替换 | 可以继续用现有规则估计，但会改变模型估计能力，不能冒充等价迁移 |

当前 `openEvents` 优先保留回复和引用原帖关联的全部有效事件，再补充最多 8 件近期事件；总数不固定为 8。若改为 Choice，应检查完整候选集合是否满足选项上限。选择关联候选仍需结合回复关系、范围与原话，不能将低置信度简单解释成没有关联。[候选读取](../modules/codex-reset/backend/scan.ts)、[Choice](https://docs.typesafe.ai/primitives/choice)

当前代码已有原文校验、多个关联候选转复核、同次补偿去重、父帖日期溯源及原话截止保护。接入 TypeSafe 不应删除这些业务规则；它的类型保证解决答案形式，不能保证语义正确。[动作证据与时间来源](../modules/codex-reset/backend/evidence.ts)、[事件组装](../modules/codex-reset/backend/assemble.ts)、[时间换算](../modules/codex-reset/backend/time.ts)

## API 能做什么

HTTP 接口是 `POST https://api.typesafe.ai/v1/systemone`，输入 `state`、`model` 和命名 `questions`，输出对应 `answers`、实际模型版本与 `usage.input_tokens/output_tokens`。它不是 OpenAI Chat Completions 或 Responses 协议。[API reference](https://docs.typesafe.ai/api)

| 原语 | 返回值 | 适用范围 | 边界 |
| --- | --- | --- | --- |
| Choice | 一个候选、每个候选概率、confidence | 类型、角色、关联哪个既有事件 | 每题最多 255 个候选；候选由调用者提供 |
| Noul | 是的概率，0–1 | 是否真实消息、是否关联、某字段是否错误 | 不能返回解释文本；没有单独 confidence |
| Score | 等级概率加权值、等级概率、confidence | 按明确标准评分 | 2–10 个等级；不能用插值重建精确数字 |

以上原语和返回类型来自 [API reference](https://docs.typesafe.ai/api)，SDK 的 `Question` 联合类型也只有这三类，可在 [types.ts v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/types.ts) 复核。将 instructions/criteria 写成 JSON 只是组织问题，不会让答案支持任意 JSON Schema。[Advanced: structure](https://docs.typesafe.ai/primitives/advanced)

`confidence` 是模型概率分布的统计量，并非已在本项目验证的正确率。Choice 的计算是 `(pMax - 1/n) / (1 - 1/n)`；Noul 用概率本身判断不确定性。不同字段与不同模型版本需要各自校准门槛，不能直接复制示例的 0.60 或 0.70。[Confidence](https://docs.typesafe.ai/confidence)

## 开放文本、列表与时间抽取

开放文本可先用正则找候选原文片段，再让 Choice 选择正确片段；代码按候选复制并归一化。官方的 email、电话、金额 cookbook 就是这个流程。**候选遗漏时，Jev 无法补出缺失文本**，需要 `none` 选项和明确的处理规则。[Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)

变长列表不能作为新的开放答案直接生成。可以由代码先枚举候选，逐项问 Noul 再组装列表；候选数量和列表完整性仍归代码负责。官方承认 Jev 计数不可靠，并建议逐项判断后在代码中求和。[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

官方日期示例将日期拆为 7 个 Choice：写法、月、日、年、相对日锚点、星期、周偏移。程序使用固定参考日期计算并校验，取使用到的部件中最低 confidence。示例年的候选范围是 1900–2050，另有缺失/越界出口；相对日期仅示范今天、明天、后天及星期。它使用 `jev-1.12`，公开演示是 4 个短文档中的 6 次日期查询。[Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook)

因此，此 cookbook 是可借鉴的拆解方法，尚不能证明小时、分钟、时区、时间区间以及中文复杂时间表达的准确性。应用必须自行定义缺失年份、相对时间、时区和边界含义，再在代码中做运算；该判断是对示例范围的推断。

## 官方 SDE cascade 实际替代了什么

官方流程是 `OpenAI mini 抽取 → Jev 逐字段核验 → 必要时 OpenAI reasoning 重抽取`。TypeSafe 的 Noul 判断字段是否虚构、偏离目标等，仍由生成模型输出自由文本 JSON。演示第一条错误抽取是为了重现而写死的；100 条结果是厂商内部实验，图表成本也说明是历史快照。**该 cookbook 支持“便宜的核验层”，不能作为“Jev 独立完成任意结构化抽取”的证据。**[SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade)

## Node.js 与回执接入的技术要求

以下说明接入所需的工程工作，用于评估成本，不安排实施。

官方提供 `@typesafe-ai/sdk`，Node.js 要求 >=20，支持 ESM、CommonJS 和 TypeScript 类型推断。官方文档链接的源码标签是 v0.6.0，仓库 package.json 同样是该版本；Node.js 24 满足声明的运行要求，但本次未运行集成测试。[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)、[package.json v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/package.json)

源码可验证的接入行为：

- 默认每次尝试超时 10 秒，失败后额外重试 2 次；重试 408、429、5xx、连接错误及超时。默认尊重服务器重试头，最多等待 60 秒。[retry.ts v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/retry.ts)
- `timeout` 是每次尝试上限，不是整个请求预算。`signal` 能取消请求及重试等待；可注入 `fetch` 用于本地假服务与运输层观察。[RequestOptions](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions)、[TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig)
- `withResponse()` 可读完整响应、解析结果及 `x-typesafe-request-id`；请求 ID 可能缺失。[api-promise.ts v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/api-promise.ts)
- 客户端解析响应后直接断言为泛型类型，没有完整业务响应校验；接入层仍应检查字段、候选、概率和 token 用量。debug 日志包含请求和响应 body。[client.ts v0.6.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.6.0/src/client.ts)

工程建议：初次验证直接使用 Node.js 24 的 fetch 即可，无需增加依赖。选择 SDK 时，关闭隐藏重试（`retry: { maxRetries: 0 }`），让每次 HTTP 尝试都进入项目已有付费回执机制；若保留重试，必须逐次记录和预算检查。设置总调用期限，保存实际模型版本、请求 ID 和 usage，日志不含凭据。这是接入设计建议，未实施。

本项目还需处理下列接入点：

- 新建 TypeSafe 专用请求适配，不把 `/systemone` 硬塞进只处理 `/chat/completions` 的 chatJson；现有模型预设和后台选择也不能把 Jev 当作通用生成模型。[现有请求格式](../packages/backend/src/providers/llm.ts#L161)、[模型预设](../site/models.ts)
- 保持 MODEL_CALLS_ENABLED 安全阀，在 paidRequest 中保存原始响应后再校验。回执 identity 包含模型固定版本、问题版本、state、questions 和候选，确保问题或关联候选变更时不会复用错误结果。[回执身份](../packages/backend/src/providers/receipts.ts#L93)
- TypeSafe 新 service 必须有明确 budgets 条目。当前 checkBudget 在找不到条目时直接放行；只包 paidRequest 并不能形成预算上限。可复用已有预算表和管理入口，不需要为了接入创建新表。[预算检查](../packages/backend/src/providers/receipts.ts#L108)、[预算管理](../packages/backend/src/admin/settings.ts#L68)
- 校验答案键、type、选项、概率范围和必要字段；无法使用的响应记为拒绝。Codex 监控的超时等结果不明请求标记失败并中止本轮，由下一轮正常扫描补齐，不使用恢复或重试。[现有回执规则](../packages/backend/src/providers/receipts.ts)
- 当前 Recognition 只携带一个 receiptId，applyRecognition 在业务事务中完成它。若识别与核验共同决定写入，需要关联并完成两个回执，不能覆盖原来的 receiptId 或让核验回执永久停在 received。[识别结果](../modules/codex-reset/backend/recognize.ts#L116)、[事务完成回执](../modules/codex-reset/backend/assemble.ts#L395)
- 保持上下文补齐和按发帖时间顺序处理；可在单条帖子内批量提问，不能并行判定多个依赖前序事件状态的帖子。[识别顺序](../modules/codex-reset/backend/scan.ts#L327)

## 当前模型、费用与数据处理

官方当前列出 `jev-1.13.0`，`jev-latest` 和 `jev-preview` 均指向它。价格为 **$0.042 / 百万输入 token，输出免费**。公布限流为 100K token/秒、80 请求/秒，并声明可无通知动态变化。请求总窗口 64K token；state 加最长问题最多 32K。只接收文本，无图片、音频和视频输入。英文是主要训练语言，中文等 CJK 支持但准确性不等同英文，需要业务样本验证。[Models](https://docs.typesafe.ai/models)

官方承认数字精度、日期比较、多层推理、大量无关上下文、恶意诱导和候选顺序等弱点。将 Jev 定义为快速、校准的判断模型是官方主张；这些主张尚未通过本项目样本验证。[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

隐私政策承诺不使用 Input 训练或微调模型，Input 可提供给服务供应商；服务托管在美国。默认保留期限是“合理必要”，未给固定天数。企业可申请零数据保留，不能假定普通账户已开启。[Privacy policy](https://typesafe.ai/legal/privacy-policy)、[Legal](https://docs.typesafe.ai/legal)

## 尚未确定

- 本项目真实样本的中文准确率、遗漏率、错误关联率、概率校准情况及 P95 延迟。
- 本项目重新拆问题后的 token 数量；原服务 token 数不能直接用于新服务报价。
- 失败、超时、中断及重复请求是否计费；请求是否支持去重或幂等计费；免费额度、预付充值和账单导出细节。已读 API/模型文档未明确这些规则。[API reference](https://docs.typesafe.ai/api)、[Models](https://docs.typesafe.ai/models)
- 普通账户原始请求/响应保留的确切期限、子处理商及地域承诺。DPA 指向 trust center 子处理商页面，但本次可访问页面没有返回清单。[DPA](https://typesafe.ai/legal/data-processing)、[Subprocessors](https://trust.typesafe.ai/subprocessors)

## 成本与已有评测的意义

已保存的原始 100 条 deepseek-flash API 测试：输入 215139 token、输出 22797 token，单请求耗时中位数 1619 ms、P95 2765 ms；API/Schema 成功 100/100。80/100 是与 Agent 标注的分类一致率，不是准确率。这些是旧提示词 .1 的历史统计，不是当前 .3 的实时表现。[原始 API 报告](../.data/local-preview/recognition-api-100-report.md)

最终代码复放得到 32 条有效事件动作、17 条仅相关、44 条无关、7 条需复核。它使用 100 条 .2 实测响应，加 12 条 .3 问题样本响应，不能称作 .3 全量独立准确率评测；也不能认为它们就是人工真值。[固定样本验证](../.data/local-preview/recognition-fixed-100-report.md)

TypeSafe 单次判断价格很低：**假设**平均每条使用 2000 个计费输入 token，100 条约 $0.0084；用 215139 这个旧服务计数做数量级示意则约 $0.0090。实际 tokenizer、state 和 questions 均不同，必须以 TypeSafe usage 核对，以上不是报价或实际账单。[当前价格](https://docs.typesafe.ai/models)

完整流程的收益取决于用法：

| 用法 | 总成本与时延的变化 | 判断 |
| --- | --- | --- |
| 现有识别后再核验 | 增加 TypeSafe 请求、费用和延迟 | 价值是减少错误接受或改善复核，不能宣称省钱 |
| TypeSafe 先过滤明确无关帖 | 只有成功跳过足够多原模型请求才省钱 | 先证明不漏事件、故障和应保留的相关内容；否则过滤造成不可见遗漏 |
| 用 TypeSafe 替换部分枚举字段，生成模型仍做翻译/抽取 | 模型仍被调用，节省输入/输出量尚不确定 | 需比较总费用、延迟和维护成本，不能只比较每百万 token 单价 |
| 整份识别重写为候选与原语 | 候选提取、时间、列表与翻译仍需实现 | 当前没有证据支持承担这次改造成本 |

如果以过滤省钱为目标，简化条件是 `C_TypeSafe < 可跳过比例 × C_原识别`。44 条无关仅说明固定样本存在过滤空间；样本偏向候选，不代表全部帖子能跳过 44%。相关帖仍要翻译，不能将“没有新事件”当作“完全无关”。

## 现有方案的优化方向

继续围绕现有识别流程处理实际问题：人工核对固定样本中影响事件数、到账状态、范围和时间的分歧，统计运行中的误报、漏报和复核量，再针对具体错误改善提示词、上下文和代码规则。Agent 标注不能直接当作人工真值，帖级分类一致率也不能替代业务指标。

关键行为包括同次补偿去重、同帖另一轮预告、条件政策、隐含惊喜、Business 子集进度、父帖跨午夜 tomorrow、精确钟点与多个关联候选。[关键行为测试](../modules/codex-reset/tests/monitor-identification.test.ts)

本次交付仅为调研与项目决定记录。没有新增 TypeSafe 代码、依赖、凭据配置、数据库状态或定时任务，因此没有接入实现需要清理；未重新执行工程测试，已有测试结果仅作为历史评测证据引用。
