# 给 Agent 的说明

这是一个行业热点网站的框架：采集信源、用模型筛选和写作、归组事件、出日报周报月报，并通过网站、RSS、公开 API、Agent Markdown 和 MCP 对外提供。默认配置是一个 AI 行业的示例站。先读 README，再按任务读 `docs/` 里对应的文档。

## 最常见的任务：改成另一个行业

按 `docs/customize.md` 的顺序做。这个站自己的东西在 `site/`：站名文案（`site.ts`）、每一步的模型（`models.ts`）、品牌与 Logo（`brand/`）、条款页（`pages/`）、发布在网站根目录的固定文件（`public/`，替换占位符后发布）、更新日志（`changelog.json`）。行业知识在 `industry/`：分类标签（`taxonomy.ts`）、主题（`topics.json`）、示范信源（`sources.json`）、提示词（`prompts/`）、门槛（`selection.ts`）。通常不需要改 `apps/` 和 `packages/`；框架里没有、只有这个站要的功能，做成模块放进 `modules/`（`docs/architecture.md` 的“模块”）。

这些事要问使用者本人，不要替他决定：站名；要盯哪些信源；什么消息重要、什么是噪声；分类怎么分；条款和隐私说明的内容（`site/pages/` 是模板，上线前需要他本人确认）。

改评分标准时保留原有结构（内容类型、五个维度加权、噪声压制、安全边界），替换的是“什么算重要”“什么算噪声”的例子。门槛要用使用者标注的样本重新校准（`docs/selection.md`），不要凭感觉改数字。

## 运行与检查

- Node.js 24 直接运行 TypeScript，后端没有构建步骤。npm workspaces：`apps/*`、`packages/*`、`industry`、`site`、`modules/*`。
- 本机运行和 Docker 见 `docs/deploy.md`。
- 改完至少跑：
  ```bash
  npm run typecheck
  DATABASE_URL=postgres://127.0.0.1:5432/<名字>_test npm test   # 名字必须以 _test 或 _ci 结尾；没有会自动建好并迁移，账号要能建库
  npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts
  node scripts/smoke.ts --base http://localhost:3000             # 站点跑起来以后
  ```
- `tests/` 里部分测试用的是示例行业的分类、标签和公司，改了 `industry/taxonomy.ts` 后把这些例子换成新行业的对应项。

## 要守住的规则

- 前端（`apps/web`）只通过 HTTP 读 `apps/api`，数据库、模型调用和密钥只在后端。
- 所有公开出口都从 `packages/backend/src/publication/` 这一个读取层读，新增公开出口也一样。
- 读者打开页面不触发模型调用；模型只在 worker 的任务里调用。
- 本站任务队列由 `site/site.ts` 的 `DEPLOYMENT.queues` 白名单控制，允许三个平台的 X 采集 cron、各平台独立的多语言翻译 cron、独立的事件确认检查，以及订阅 sweep 和 deliver；其余队列仍停用，不将独立任务并入采集 tick。框架测试用显式测试配置恢复需要的队列，不根据 `NODE_ENV` 绕过站点限制。
- 付费请求都经过回执（`providers/receipts.ts`）和预算熔断，不要绕开。
- 安全阀只有设成 `true` 才打开。开发时默认关闭：`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_*_ENABLED`、`INDEXNOW_SUBMIT_ENABLED`。用户明确授权自动翻译后，可仅在开发 worker 进程开启 `MODEL_CALLS_ENABLED`，采集、识别、真实推送和 IndexNow 仍关闭，API 和页面读取不得触发模型。测试里推送一直关着，采集和模型调用只连本地假服务，不访问任何外部服务。
- 信源默认只展示摘要和原文链接（`site_fulltext` 关）；只有来源明确允许时才打开全文。
- 公开内容匿名，管理员和访客看到的一样；后台只允许管理员。
- 停用或替换一个功能、机制时，同一个改动删掉它的代码、测试、文档和存下的状态（库表与列、定时任务、settings、环境变量和 `.env.example` 里的项）；会删掉使用者已有数据的，在 `docs/deploy.md` 的更新说明里写明。加锁、重试、兼容旧格式、开关和兜底，先要有证据：真实部署里发生过，或平台的语义决定它会发生。
- 数据库迁移放在 `database/migrations/`（只属于某个模块的表放在它的 `migrations/`），按完整文件名排序执行和记账；编号相同的不同文件分别执行，新增迁移使用新的文件名，已经发布的迁移不改。从 `0055` 起，每个文件只放一条允许在线执行的语句，PR 会检查；索引使用 `CONCURRENTLY IF NOT EXISTS`，大批数据回填不放进发布迁移。约束验证和破坏性变更先按 [迁移约定](docs/architecture.md#数据库迁移) 设计，不能修改历史文件或关闭检查绕过。
- 不要提交 `.env`、密钥和 `.data/`。
- 不要使用 AIHOT 的名字和 Logo。

## 写代码

匹配周围代码的写法、命名和注释密度。选能清楚解决问题的简单方案，只定义正在使用的抽象。验证改动涉及的重要行为，不为简单的样式改动写测试。

## 开发与部署分支

- `dev/codex` 是测试环境，该工作区 `.env` 配置的数据库也是测试数据库；不能仅凭数据库在远程服务器或已有服务运行就判定为生产环境。
- 测试与部署工作区各自维护 `.env`。部署时保留 `dev/codex` 的 `.env`，部署环境配置只在 `codex/deploy` 工作区的 `.env` 调整；`.env` 不进入 Git，也不随分支合并覆盖。
- 所有代码、测试、文档和规则修改都在开发分支 `dev/codex` 完成，不在部署分支 `codex/deploy` 直接修改。
- 仅在使用者明确要求部署时，将已验证并推送的 `dev/codex` 合并到 `codex/deploy`，再推送部署分支触发部署；部署结束后回到开发分支。
- 部署前先更新远端引用，检查开发工作区（包括关联 worktree）没有未提交、暂存或未跟踪的待提交变更，且本地 `dev/codex` 与 `origin/dev/codex` 的提交完全一致。开发分支有未推送提交、未提交变更、远端未同步或无法核验远端状态时，禁止合并发布和部署；不能跳过开发分支推送，直接把工作区或本地提交发布。
- 本规则不代表预先授权 push、CI/CD 修改、数据库迁移或公开部署；仍按使用者本次授权和自主边界执行。

## 给本仓库提 PR

要把改动提回 `KKKKhazix/AIHOT` 时，先读 `CONTRIBUTING.md`。下面是评审里最常被退回或返工的情况：

- **只收对所有站都成立的改进。** 新开关、新的配置入口和新功能再小也算产品行为，先开 Issue 讲清场景：每个开关所有站都要长期维护，没讨论就提交的这类 PR 大多没有收。你们站自己的规定、数字和例子留在自己的 `industry/`、`site/`，不写进共享的提示词模板、注释和测试。
- **先找现有的。** 加函数、插口或配置前先搜一遍，常见能力多半已有一份：模块发自己的文件用 `apps/api/src/routes/static.ts` 的 `sendFile`，接中转站填 `LLM_BASE_URL`。再写一份，两处迟早不一致。
- **测试只证明你想到的情况。** 动了采集、日期、正文清洗、精选或归组的，拿一批公开的真实订阅和网页跑改动前后，在 PR 里写有多少条结果变了、变的是否都对。中文网页的时间常不带时区，按信源时区读（默认 `+08:00`），上面的 “CST” 一般指北京时间；测试结果不能取决于运行机器的时区。
- **改全。** 新的环境变量写进 `.env.example`，新的站点配置写进 `site/`；改了配置字段的意思，示例配置跟着改，让已部署的站升级后行为不变（比如改成只给声明了 `vision` 的模型附图，本来就能看图的预设要补上声明）；改一个读者看到的名字或入口，出现它的地方一起改。
