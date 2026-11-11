# 部署

## 重置监控升级

v2 保留所有时间字段名。`event.time`、`updates[].time` 和 `announcedResetTime` 使用 BusinessTime 对象：`instant {at}`、`date {date,timeZone}`、`range {from,through}`、`deadline {at}`，这些字段拒绝标量和中文展示时间；`resetTime` 和 `predictedResetTime` 仅使用 UTC ISO 8601 时间字符串或 null，严格拒绝旧对象格式。`publishedAt`、`generatedAt` 继续使用 ISO 时间戳。调用方必须同步升级，不提供兼容模式。接口接入示例见 [v2 契约](reset-monitor-v2.md)。

### 非连续帖子与未知预告时间

同作者独立帖子可按明确事项、承诺与轮次关联，不要求相邻；原始回复、引用仍优先。每轮发放独立计为事件，一条来源可确认前轮并预告后轮。预告没有明确或可解析时间时保存 null，不再补发帖日期、不自动确认。公开 event.time 与 announce 的 time 支持 null，总览新增必填 hasAnnouncement；调用方与静态 OpenAPI 必须同步更新。未知时间按 publishedAt 排序和归日，展示为时间未公布，不能用统计预测代替。无需新增列或迁移 SQL。

已有明确时间及统计口径不变。历史曾由旧规则补齐的预告时间不按数值或文案自动还原，须有原始备份证据并单独预览；旧补日期工具不得用于新记录。历史定点修复保留原事件及动作 ID，核验备份与记录版本，抑制历史通知，不批量重跑其他帖子。

普通 amend 保留事件当前状态、预告计划和确认结果；明确改期及后台计划时间更正使用 announce。amend 缺时间时先将最早有效来源时间戳转为 UTC，保存不早于发帖时刻的最近一个 10:00 UTC；当日未到或恰好到点取当天，过点顺延次日，跨月和跨年同样处理。此规则不批量改写已有修订时间；历史曾以 amend 表达明确改期的记录须在备份、预览和单独授权后核验更正，不能按 time 非空自动转换。

### 总览单点时间与自动确认

此更新不新增数据库列或迁移 SQL。新自动确认保存到期边界的 instant：时刻和截止取 at、区间取 through、纯日期取当天北京时间18点；原始预告、动作 ID 和创建时间保持不变。resetTime 只取最新有效确认的单一时刻，predictedResetTime 为该点加典型间隔，过期保留原时间点；三类事件及官方、管理员、自动推定的既定混合统计口径不变。

已有自动确认须在停写、完整备份及恢复演练后修复。先运行只读预览：`node --env-file-if-exists=.env modules/reset-monitor/scripts/repair-inferred-time.ts --output <新预览目录>`。核对 preview.json 的逐监控清单和问题项；存在无法证明原始计划的记录时不执行。工具仅处理有生成身份和原预告证据的无来源自动确认，不修改官方确认、管理员核对或已有官方补证的动作。

既有标量转 JSONB 的升级保留动作 ID，离线工具按原生成公式核验这些历史 ID；这不是运行时格式兼容。曾补齐原始空预告时间的记录，预览时还须加 `--prior-defaults <原默认值修复的备份目录>`，提供各平台原 `*-before.json`。工具仅提取原时间为 null 的动作 ID、事件、顺序、来源和发布时间证据，要求当前日期仍是同一来源的北京时间日期，并唯一复现原生成 ID；证据随预览保存，执行时不能替换证据或按文案猜测。

确认方案并获得目标数据库修复授权后，用新目录执行：`node --env-file-if-exists=.env modules/reset-monitor/scripts/repair-inferred-time.ts --apply --preview <预览目录>/preview.json --worker-stopped --database-backup <完整custom备份> --output <新执行目录>`。停止 API 写入、Worker 和 Webhook 投递；应用前恢复验证完整备份，重新核对全部监控指纹，再在同一事务更新动作、有效概述与翻译绑定及通知基线。受影响事件尚未发送的 pending/sending/failed 投递取消，已发送历史保留，不补发历史通知。可用进程环境变量配合 `--verification-database-env <变量名>` 指定独立恢复验证库，不修改 .env。备份、预览和执行目录保留用于核验与恢复。

news-hot 与 when-reset 的新校验、页面和 OpenAPI 一起切换，旧对象式总览与旧游标直接拒绝。公开出口及缓存均从新投影生成，读请求不修复数据。修复失败先保留日志与现场，不删除唯一备份或把已修复数据交给旧契约程序。

### 首次升级到 JSONB 动作时间

数据库最终列名仍为 `monitor_event_actions.time`，类型改为 JSONB。这是需要停写、备份与独立数据转换的升级，不能直接在有数据的旧库执行完整 `db:migrate`。工具和 SQL 的准备不授权实际 schema 修改、数据转换、真实模型调用、推送或部署，执行前须取得使用者的具体授权。

1. 停止全部 API 写入、Worker、Webhook 投递和管理员操作。备份整个数据库，在独立副本上恢复并演练以下步骤；保留旧程序及其备份，切换完成前不要启动新旧任一写入实例。
2. 只执行新增临时 JSONB 列的迁移：`npm run db:migrate -- --through 0146_monitor_actions_business_time.sql`。执行器遇到尚未完成转换的有数据旧库，会在整批清理前拒绝，而不是隐式丢弃旧时间。
3. 预览转换：`node --env-file-if-exists=.env modules/reset-monitor/scripts/migrate-business-time.ts --output .data/local-preview/business-time-preview`。工具只读取数据库，将无原帖全文和凭据的记录快照写入新目录，从写出的副本验证转换和公开投影；任何异常记录都会中止。输出目录必须不存在，避免覆盖备份。
4. 核对预览及完整备份副本后，经授权使用新的输出目录执行：`node --env-file-if-exists=.env modules/reset-monitor/scripts/migrate-business-time.ts --output .data/local-preview/business-time-apply --apply --worker-stopped --database-backup <完整custom格式备份文件>`。每次执行前，工具复用完整备份校验：检查 custom 格式、全部业务表和数据清单，并实际恢复到新临时测试库；校验失败不写目标数据。执行环境须有 `pg_restore`，恢复验证账号须有建库权限，验证临时库在结束后删除。目标账号无需为演练增加权限：可在进程环境中设置独立验证连接（例如 `BUSINESS_TIME_VERIFY_DATABASE_URL`），附加 `--verification-database-env BUSINESS_TIME_VERIFY_DATABASE_URL`；参数只传变量名，连接和密码不放命令行，也不修改 `.env`。验证连接只用于创建、恢复和删除临时库，表清单核对与迁移始终使用目标连接。默认每批 200 条，`--batch-size` 可设置 1–1000。历史时间戳转为 `instant`，日期按已有行为转为 `date` 加 `Asia/Shanghai`，区间转为 `range`；原先丢失的来源时区和截止语义不猜测、不重新识别。业务记录时间戳、事件/动作/来源 ID 不变。部分回填后中断，可在仍停写时换一个新输出目录重复执行，已正确回填的记录按同值保留，冲突中止。
5. 转换工具最后核验全部记录，同事务升级原本有效的概述事实绑定、同版本失败翻译状态及 Webhook 指纹，写入与动作快照绑定的完成记录。过期概述不会恢复，既有失败版本不会因格式变化重新调用模型。旧契约 `pending`、`sending`、`failed` 投递改为 `cancelled`，已发送记录保留审计，历史通知不补发；过期队列作业即使运行也不能重新投递这些记录。
6. 确认工具完成后执行 `npm run db:migrate`：`0147–0150` 分别安装和验证 JSONB 形状及来源约束，`0151` 删除旧来源约束，`0152` 删除旧 text 列，`0153` 将临时列重命名为 `time`。执行器在清理前及持锁执行删除前再次核验逐行转换和完成摘要；任一记录变动都会拒绝清理。新装空库可以直接执行完整迁移。迁移不改历史 SQL，不执行整表类型重写。
7. 切换新程序，检查 v2、公开页、后台选择器和本地 smoke，再按原有授权恢复业务任务。保留完整数据库备份及预览/执行目录。切换失败时停写，将完整备份恢复到独立数据库，用旧程序连接恢复库核验后再切回；不尝试从已删除的旧列回退，也不把新代码连接到标量时间数据库。

自动发布脚本按完整迁移路径识别待执行的 `0152`，在发布计划中输出 `needsBusinessTimeUpgrade` 并纳入审批摘要；缺少 `0146` 或转换工具时在停服前拒绝。批准后停止写入并备份，依次执行截止到 `0146` 的迁移、转换 CLI、完整 setup。转换只读挂载完整 dump，使用宿主 UID/GID 和私有输出目录，结果与备份一同保留。开始迁移后失败保持停服并记录 blocked-release，不让旧程序连接已转换的库。已完成转换的库和普通迁移沿用原发布流程。发布计划及脚本就绪不代表授权实际迁移或部署。

纯日期预告仍在该日期北京时间 18:00 自动确认；日期所属时区保留供展示，程序边界不补成官方承诺的精确时刻。未明确或无法解析时间时，announce 保存 null，不触发自动确认；amend 保存不早于来源发帖时刻的最近一个 10:00 UTC，confirm、progress 保存发帖时刻。公开事件及预告动作 time 可空，总览 hasAnnouncement 区分无预告与时间未公布。`scope.note` 保留简洁七语言用户标签，结构化范围代码和摘要中的实际限制不变。现有分钟 Worker 的概述生成仍经过模型安全阀、预算和回执；仅生成概述不另发业务通知。

历史 action-defaults 修复目录仅保留为原始缺失时间及恢复证据；不要再用旧工具将空预告时间补为发帖日期。已有默认时间只能在可核验备份、预览与明确授权下定点还原，不能凭当前值与发帖时间相同推断。

当前版本仅支持当前动作模型的数据库，运行时不探测或兼容旧三表、旧人工核实字段、旧来源关系或旧动作类型。本版不提供旧监控库的原地转换路径；旧结构部署按[重新部署与数据导入](#重新部署与数据导入)从已核验的当前结构备份恢复到空库。新安装正常运行完整迁移，已发布的 SQL 文件保留且不修改。

`0143–0145` 分别删除 `monitor_event_posts`、`monitor_posts`、`monitor_events`。新安装中这些历史表为空，当前结构备份中应已不存在。迁移执行器发现待删除表非空时，在应用待执行文件前停止；执行删表时持锁复核，不隐式删除旧记录。迁移文件准备不代表授权执行，业务库迁移仍需使用者另行明确授权。

事件确认、独立翻译、上下文采集与订阅投递按下文运行规则配置；代码清理不授权数据库写入、真实模型调用、推送或部署。

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/KKKKhazix/AIHOT.git myhot
cd myhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。

启动前检查 `.env` 的 `SITE_URL`：本机试用保留 `http://localhost:3000`；部署到服务器时改成读者实际访问的地址。例如通过服务器 IP 访问时（把示例 IP 换成自己的）：

```dotenv
SITE_URL=http://192.0.2.10:3000
```

RSS、分享链接、站点地图和 Agent Markdown 中的绝对链接都使用这个值，不会随浏览器访问的地址自动改变。使用域名和 HTTPS 时按下方「配域名和 HTTPS」设置。

配置完成后启动：

```bash
docker compose up -d --build
```

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、评分、结构化、写标题摘要，再归组）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。`web` 只接收网站地址、API 地址等网页配置，通过 HTTP 读取 API；数据库、模型和管理员密钥，以及数据卷，只交给后端容器。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源和图片时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `site/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接、RSS、分享图和 MCP 都用它。

MCP 默认接受 `SITE_URL` 的主机以及 `localhost`、`127.0.0.1`、`[::1]`。额外主机用 `MCP_ALLOWED_HOSTS` 配置，以逗号分隔，例如 `extra.example:8443,[2001:db8::1]`。主机名不区分大小写，IPv6 必须加方括号；可带 0–65535 的十进制端口，匹配时忽略端口。包含路径、用户信息或非法端口的配置不会生效。`127.1` 等别名需要明确列入；此配置只影响 Host 校验，不扩大浏览器 Origin 许可。

前面有 Nginx、CDN 这类缓存时，要遵循应用返回的缓存期限（`Cache-Control`）：公开网页、导航数据、API、RSS、条目 Markdown、报告分享图、站点地图，以及接入说明 `/api/v1/agent` 和 `/openapi-v1.json`（五分钟到期后也要重新验证），都不要另加更长的缓存期，不要在到期后离线返回旧内容，也不要在转发旧响应时重新起算它的寿命；不要让代理和 CDN 叠加缓存动态内容。框架不代管自建站的 CDN，也不替它清缓存。

### 更新

事件 Webhook 订阅需要新增模块迁移 `0092`–`0096`：三张独立表和两个并发索引，不修改已有业务表或删除数据。应用迁移后启动 API／worker，历史事件自动建立比较基线，不补发旧事件。新增 `WEBHOOK_PUSH_ENABLED=false`，默认不发送；管理员在 `/admin/reset-subscriptions` 创建订阅，配置接收方验签后再启用订阅与安全阀。安全阀关闭期间保留待发记录，重新开启会继续投递；要取消待发内容应停用订阅。备份包含订阅签名密钥，应按其他凭据保护。数据库迁移、真实通知与生产部署分别按授权执行，详见[订阅协议](reset-monitor-webhooks.md)。

额度监控全面使用 [v2 动作契约](reset-monitor-v2.md)：站点、公开 API、Agent、MCP、飞书和 Webhook 共用事件结果与动作来源。监控 v1、旧站点快照、轮询接口及回执核对功能已退出，新闻 v1 保留。旧结构部署按[重新部署与数据导入](#重新部署与数据导入)恢复当前结构的完整备份；当前版本不提供旧格式探测或转换，不得混用新旧写入。

转换保留最终帖子的原文及可核验单层引用，删除旧关系、重复全文翻译、原始响应副本、无用字段、回执核对专属记录及审计中的原文；保留内部付费回执、无关人工记录和必要运行检查点，历史通知只建立基线、不补发。代码升级不自动授权生产迁移、转换、真实采集、模型调用、通知或部署。
正文原生视频修复会为已有可用视频补播放控件，并去掉空播放器，不写回文章、不调用模型。旧版清洗时已经丢弃的媒体地址无法从存档恢复；升级不批量重新抽取，已有成功正文会跳过抽取，内容哈希相同时重新抽取也可能保留原 HTML。后续新正文按[信源说明](sources.md)保留原生视频，文件继续由浏览器直连原站，签名地址可能过期。

先按下方 [备份](#备份) 一节备份。旧监控结构不能直接执行下面的 setup 全量迁移，应先完成[重新部署与数据导入](#重新部署与数据导入)；当前结构的常规更新在构建完成后停止旧服务，再运行迁移和新版服务：

```bash
git pull
docker compose build
docker compose stop api worker web
docker compose run --rm setup && docker compose up -d
```

迁移成功后再启动服务；迁移失败时先查看错误，不要继续启动。使用 HTTPS 配置的站点继续保留 `--profile https`。旧的 API 和 worker 要在迁移前停下：迁移可能删表删列，旧代码还在跑会出错；正常关闭 worker 会等进行中的付费调用收尾（最长三分多钟）。非 Docker 部署也按“备份、构建、停止 API/worker/web、迁移（`scripts/migrate.ts`）、种子数据（`scripts/seed.ts`）、启动”的顺序更新。

新迁移遇到长期占锁会报出文件名和等待超时，先处理占锁事务，再重跑 setup，不要跳过迁移或改写迁移账本。并发索引创建中断可能留下无效索引：核实报错中的对象后，用 `DROP INDEX CONCURRENTLY <索引名>` 清理该失败索引再重跑；有效但定义不同的同名索引须先核对差异。这些保护不改变上述 Docker 更新顺序，跨旧版本升级仍可能执行历史上的破坏性迁移。

下面按时间从新到旧列出每次更新要注意的事。

日报缺期告警按北京时间的具体日期跟踪，跨午夜不会自动恢复；只有对应日报存在才发恢复通知。新缺期检查最近 7 个日历日（含今天），不早于最早的日报或 reports.compose 运行记录；没有历史记录时只检查今天。已告警的日期即使超出 7 天仍保留，关闭采集/模型或 worker 启动宽限期也不会把缺期当成恢复。旧的 report.daily 状态自动按首次告警时间迁移，保留提醒间隔。出刊后两小时告警、每小时提醒及飞书开关保持不变；无需数据库迁移。自定义 responder 若按旧 `report.daily` 精确匹配，需改为识别 `report.daily:YYYY-MM-DD` 日期键。

#### 原帖展示与引擎同步（2026 年 10 月 6 日）

没有新增必填环境变量或数据库迁移。自己维护 `site/site.ts` 的站点需补上 `REPORTS.quiet`，可对照示范配置：日报时段内有资料经过评判、但没有新大事时照常出刊，用这两句做标题与导语；导语的 `{start}`、`{end}` 是时段起止。没有任何资料经过评判仍算采集或判断失败，不伪装成平静的一天。

空正文、纯链接的 X 帖子保留原来的链接、图片和引用，不调用写作或翻译模型；来源允许展示全文时，纯图片帖子也可以显示，现有展示与再分发许可继续生效。已取得实际正文的 X 长文照常处理。旧译文也不会再出现在这些原帖的公开页面里。已生成过错误标题摘要的帖子，可在更新后用 `packages/backend/src/publication/publish.ts` 的 `publishArticle(id)` 重建公开内容，不需要重新调用模型。

MCP 的 `subscriptions/listen` 现在立即返回 HTTP 404 和 JSON-RPC `-32601 Method not found`。服务从不推送变更，普通工具调用照常使用；客户端收到这个回答后不应重试建立常驻订阅。

无需数据库的测试改为 `*.standalone.test.ts`；`npm test` 仍运行全部后端测试，只给需要数据库的文件建副本。可用 `npm run test:standalone` 单独运行这些测试。

#### 社区修复、时间规则与读取优化（2026 年 10 月 4 日）

公开接口版本仍是 4.0.0。没有必填的新环境变量；新增一个选填的 `LLM_REASONING_TOKENS`，见下面 `site/models.ts` 一条。

**开关只认 `true`**：`.env` 里所有 `*_ENABLED` 开关（`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_*_ENABLED`、`INDEXNOW_SUBMIT_ENABLED` 等）只有写成小写的 `true` 才打开。以前写 `1` 或 `TRUE` 也算打开，现在都当作关闭；升级前检查 `.env`，改成 `true`。

**迁移**：新增六个迁移，按上面的步骤等 setup 跑完即可。它们都不删数据，不重写文章或已有向量，也不调用模型；迁移按完整文件名记账，编号相同的不同文件各自执行。

- `0055_publication_selected_published_idx.sql`、`0056_analyses_composite_id_idx.sql`、`0056_publications_pool_category_timeline_idx.sql`、`0057_publications_pool_channel_timeline_idx.sql`：并发建立查询索引，不阻塞正常读写。
- `0056_publication_release_selection_stats.sql`、`0057_analyze_publication_release_selection.sql`：为公开列表创建并收集查询统计。

这次连同这些索引一起减少了公开读取与事件召回的数据库开销，接口内容、搜索权重和事件候选范围不变。

**自己改过这些文件的站，合并时对照新文件**：

- `site/site.ts` 多了几项：
  - `EDITION_TIMES`、`EDITION_WHEN`：日报、周报、月报的出刊时间，原来写死在代码里；排程、日报的时间窗口、缺期告警和提到时间的文案都读它。`public/` 里的文件用占位 `{{dailyTime}}`、`{{weeklyTime}}`、`{{monthlyTime}}`。
  - `ITEM_COPY`：推荐理由叫什么，网页和分享图上显示不显示评分。
  - `REPORTS.descriptions`、`entry`、`metricUnits`、`shareUnit`：报告页面的描述和版面上的说法。
  - `ABOUT`、`CARDS` 里提到出刊时间和推荐理由的文案改成引用上面几项。
  - `DEPLOYMENT.directImageHosts` 改名为 `directFetchHosts`，采集和图片共用这份直连名单。
  - `SITE.feedbackLead`、`SITE.feedbackEmailHint`：反馈页标题下的一句话和邮箱框提示，原来写死在代码里。
  - `ABOUT.lead` 里 `{sources}` 两边不再写空格，页面会自动加。
- `site/models.ts`：推理模型的额度改成明确配置。默认模型设 `LLM_REASONING_TOKENS`，具名模型写 `reasoningTokens`。原来只有名字以 `-think` 结尾的具名模型会多给 4000，这个做法去掉了；自己加过这类模型的，补上 `reasoningTokens: 4000` 才保持原来的额度。推理模型把额度用光时，报错会写明 `finish_reason=length` 和该改哪一项。
- `industry/prompts/story-digest.md`：事件概览换了写法，第一句讲清核心变化和目前的结论，再补必要背景，分成短段，不按日期复述下方的时间线，不评论报道本身，也不再写死行业。已有综述不会被批量重写，随新报道逐步换成新写法；想让某几个事件立即重写，见 [综述评测](story-digest-evaluation.md) 的最后一节（`rewriteStoryDigest`，每个事件一次模型调用）。
- 自己维护的 Compose 文件可以删去 `LOCAL_ROUTER_URL`：分享图预热现在直接复用后端渲染器，不再请求固定的本机端口，没有代码再读这一项，自带的 `docker-compose.yml` 已经去掉。分享图地址、格式和缓存约定不变。

**采集与发布时间**：

- **首次导入之后不再收信源的存档**：以前新信源首次导入后，第二次抓取会把订阅里剩下的旧条目全部当历史内容收进来，逐条付费分析（示范源一次就有上千条）。现在之后的抓取只收发布时间在信源第一次导入前 48 小时以内或之后的条目；没有日期的照收，X 账号不受影响，见 [信源](sources.md#规则旧文不刷屏) 的“旧文不刷屏”。升级前已经收进来的旧条目按原文时间归档，不进“今天”和日报，分析也早已跑完，不用处理。
- **没有可信发布时间的新资料先不公开**：先不进公开列表、精选、报告、热点和推送，从原信源或原文页读到日期后再判断新旧。日期未知时，文章页、结构化数据和 Agent Markdown 标“收录时间”，RSS 不写 `pubDate`；OpenAPI 注明事件时间线和日报快讯的 `publishedAt` 这时是收录时间。
- **JSON 接口里不带时区的时间**（如 `2026-09-30 17:43:58`）按信源的 `publishedAtUtcOffset` 读，默认 `+08:00`。以前按服务器时区读，Docker 里是 UTC，所以已有这类信源的新条目时间会提前 8 小时，变成正确值。
- **文章页日期使用同一来源时区**：详情页补日期与正文提取先用 `detail.publishedAtUtcOffset`，未设则继承信源的 `publishedAtUtcOffset`，再默认 `+08:00`。只作用于之后的采集和补日期，不批量重写已有发布时间。
- **详情补全**：失败或超出本轮次数限制的日期、标题、摘要会在后续采集中补齐，已确认的正文保持原样；信源请求成功却漏掉日期、标题或正文时也会补全，并记进信源健康。Jina 详情规则要与实际返回格式匹配；固定采集起点、Intercom 日期章节及视频描述的配置见 [信源](sources.md)。
- **视频播放页不当正文**：对所有信源生效，YouTube、Vimeo 播放页不再作为文章正文抓取，YouTube 视频页也不再被当成图片。RSS 的视频描述只作摘要，订阅直接提供的真实文字保留。升级不会批量删除或重新分析已有正文；旧视频记录混入播放器导航的，先逐条核实，可在后台“内容诊断”的详情页设为仅摘要，停止展示错误正文。
- **RSS**：确认摘要就是全文的文字订阅可以设 `summaryIsBody`（Atom 的 `summary` 也算）。没有网页的播客单集，原文链接改为音频或视频文件，不再去抓网页。
- **预览和正式采集用同一组过滤**：后台“预览抓取”也套用地址前缀、分类、噪声词、地址改写和 `publishedAfter`，预览里看到的条目就是正式采集会存下的。
- **关掉采集后不再取信源图标**：`COLLECT_ENABLED` 不是 `true` 时，每天 04:40 取信源图标的任务也停下，不再访问信源网站。
- **已核实的历史日期可以纠正**：运维脚本先调用 `admin/content.ts` 的 `previewPublicationDateCorrection`，再按预览给出的版本和校验值调用 `correctPublicationDate`，并记录操作者与理由。只接受新旧日期都早于七天窗口的明确更正；保留材料修订、选稿与归组，不重跑模型。材料或日期已变化，或这次纠正会改变其他公开决定时，会拒绝操作并要求重新核对；没有批量回填，也没有新增公开接口。

**公开出口**：

- **按类别筛选按 `PUBLIC_CATEGORIES` 走**：API、RSS 和 MCP 的 `category` 取所有在公开接口里算作这一类的类别。不合并分类的站（默认就是），按 `tip` 查不再带出观点；没有 `tip` 类别的行业也能通过类型检查。
- **往期报告仍需重新验证**：日期、周和月份确定的是哪一期，不代表内容永久不变。报告保留出刊时写下的标题和摘要，来源名和引用时间跟随当前公开资料；已撤回的引用及依赖它的导读、封面不再分发。保留报告副本的客户端在 `Cache-Control` 到期后带 `If-None-Match` 重新请求。
- **自行配置过 Nginx 或 CDN 缓存的站点要检查规则**：按 [配域名和 HTTPS](#配域名和-https) 末尾的要求核对，并在更新时清理这些路径已有的代理和 CDN 缓存，包括接入说明 `/api/v1/agent` 和 `/openapi-v1.json`。
- **站点地图重建失败时不再无限沿用旧文件**：进程、磁盘副本和 HTTP 响应共用原来的五分钟期限，过期且无法重建时返回 `503` 和 `Retry-After`。MCP 继续使用 `no-store`；API 和 Agent 内容到期后重新验证。

**工具与修复**：

- **综述评测**：`scripts/eval-story-digests.ts` 从库里导出真实事件，在同一批事件上把现有提示词和候选提示词并排跑，见 [综述评测](story-digest-evaluation.md)。三个评测脚本共用 `scripts/eval-tools.ts`；`eval-selection.ts` 的 `--n`、`--concurrency` 和模型名写错时直接报错。
- **迁移不阻塞读写**：新迁移每个文件只放一条允许在线执行的语句，不整表回填或重写，建索引用 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`；CI 用 `scripts/check-migrations.ts` 检查。统计维护只针对明确的表和列，规则见 [架构](architecture.md#数据库迁移)。
- MCP 请求有大小上限，错误日志去掉凭据。
- 桌面侧栏放大后显示细滚动条。
- 测试按每一步实际的提示词认请求、从 `industry/selection.ts` 读门槛，换行业改写提示词和门槛后不再误报；架构测试不再受路径分隔符影响。

#### 站点文件搬进 `site/`（2026 年 10 月 4 日）

公开接口没有变化，版本仍是 4.0.0。

- **站点自己的文件从 `industry/` 搬到了 `site/`**：`site.ts`、`models.ts`、`brand/`、`pages/`、`public/`、`changelog.json`。`industry/` 只留行业知识：`taxonomy.ts`、`topics.json`、`sources.json`、`prompts/`、`selection.ts`。自己改过这些文件的，合并时把改动挪到 `site/` 下的同名文件。
- **`site.ts` 多了几项**，都可以不填：`SITE.github`、`SITE.llmsIntro`、`SITE.rootIcons`，`POLICY.terms.license`、`POLICY.terms.headers`，`ABOUT.termsAnchor`（二维码卡片可以写 `alias`），以及 `ACCESS`、`ADMIN`、`DEPLOYMENT`、`FEED_COPY`、`PUBLIC_CATEGORIES`，说明见 [把它改成你的行业](customize.md)。`PUBLIC_CATEGORIES` 取代了 4.0.0 时的 `publicAs`：原来在类别上写 `publicAs: "tip"` 的，改在 `PUBLIC_CATEGORIES.merge` 里写（键是这个类别的 key，值是 `"tip"`）。
- **`DEPLOYMENT.requiredSecrets`** 是生产 API 启动时额外检查的凭据清单，默认空；基本会话、图片签名和管理员登录校验仍然生效。只有你的部署要求某个可选集成必须配置时才填写。
- **只属于你这个站的功能可以做成模块**：放进 `modules/<名字>/`，在 `site/modules/` 的清单里启用，见 [架构](architecture.md) 的“模块”。框架本身不带模块。
- **Agent 接入页默认打开 MCP**，页面列出 MCP、RSS 和 API 三种接入方式。Agent Markdown 接口仍在 `/api/v1/agent`，可从页面下方“Agent 使用说明”进入。
- **图片代理可以设流量上限**：`IMGPROXY_UPSTREAM_MB_PER_MINUTE`、`IMGPROXY_UPSTREAM_GB_PER_DAY`（或 `site.ts` 的 `DEPLOYMENT.imageUpstreamBudget`），默认不设。
- **修复**：同样的数据每次给出同样的字节（排序遇到并列时补上唯一的次序，API 和 RSS 的 ETag 不再无故变化）；网页转给 api 的请求不再带上逐跳头，`Connection: close` 不再让下一个 POST 失败；`llms.txt` 的接入方式按实际数，不再写成四种。

#### 升级到公开接口 4.0.0（2026 年 10 月 3 日）

- **模型榜和主题页的大事记不再是框架的一部分**，相关表和设置的历史迁移保持原样，升级前备份需要保留的数据。公司主题页的标志使用公司名首字母。本站额度监控以独立模块安装，按下方“重置监控”章节升级。
- **行业包有几处变化**，自己改过 `industry/` 的站，合并时对照新文件补上：
  - `site.ts` 多了 `topicsTitle`、`feedbackExample`、`keywords`、`since`、`interfaceVersion`、`POLICY`（使用规则和隐私说明两页的名字与简介、X 帖子算不算全文）、`ABOUT.description`、`ABOUT.sourcesFallback`、`AGENT`、`REPORTS`、`ALERTS`、`SOURCE_DEFAULTS`、`COMMUNITY_FEEDS`、`CARDS`；作者块的两张二维码卡片加了 `kind`，`ABOUT.copyright` 改成反馈页链接前后的两段。
  - 新增 `models.ts`：具名的模型和每一步默认用哪个，原来写在代码里。
  - 网页左上角的标志从 `apps/web/app/components/Logo.tsx` 搬到 `industry/brand/Logo.tsx`（后来搬到 `site/` 下，见上方）。
  - 新增 `public/`：`robots.txt`、`manifest.webmanifest` 原来在代码里生成，OpenAPI 说明原来在 `reference/`，现在都是这里的文件。原来填了 `contactEmail` 就会生成的 `/.well-known/security.txt`，现在要自己放一份 `public/.well-known/security.txt`（后来搬到 `site/` 下，见上方）。
  - 删掉了 `features.ts`、`chronicle.ts` 和 `chronicles/`；`topics.json` 里的 `orgNames`、`leaderboardProvider`、`chronicleTerms` 不再使用，可以删掉。
  - `taxonomy.ts` 的类别可以写 `feedLabel`（分类 RSS 标题里的名字，示例站用“AI 模型”这样的说法）；`ENTITIES` 加了几家公司。当时类别上还可以写 `publicAs`，让它在公开接口里并进另一类；这个字段后来删掉了，改成 `site/site.ts` 的 `PUBLIC_CATEGORIES.merge`（见上方），再写 `publicAs` 通不过类型检查。
- **推送接口的限流可以设置**：`/api/ingest/items` 每个客户端每分钟最多推几次由 `INGEST_RATE_LIMIT` 决定，`docker compose` 默认 10，和以前一样；不用 Docker 时默认不限，前面没有代理限流的话在 `.env` 里设上。
- **不再使用的环境变量**：`ARTIFICIAL_ANALYSIS_API_KEY`，可以从 `.env` 删掉。

#### 升级到公开接口 3.0.0（2026 年 10 月 3 日）

- **安全阀默认关**：`COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 只有写成 `true` 才打开，没写就是关。用 `scripts/init-env.ts` 生成的 `.env` 已经有这两行；自己写的 `.env` 没有的话要补上，否则升级后不再采集、不再调用模型。
- **周报月报接口换了形状**：`/api/v1/weeklies`、`/api/v1/monthlies` 的列表和每一期都带 `periodStart`、`periodEnd`，正文改成 `sections[]`（每栏 `label`、`summary`、`items`），不再有 `title`、`themes`，列表的 `limit` 最多 60。读这两个接口的程序要跟着改；MCP 和 `/openapi-v1.json` 的版本号随之升到 3.0.0。
- **精选的机器出口每条新闻一条**：API 的 `mode=selected`、同步接口和精选 RSS 里，同一条新闻只留代表报道，其他报道以 `remove` 出现在同步的变更里（`mode=all` 里还在）。升级前已经入选的旧报道不会被重新整理，等这条新闻再有报道发布时才归并。
- **精选要等去重确认**：分数够了的资料，要等归组确认它不是精选里已有新闻的重复、带来了新信息，才进精选；确认之前只在“全部动态”。归组用的模型回答不合格式时会停在那里，后台“运行”页能看到。
- **一手只看分级**：`T1` 就是一手，`first_party` 不再单独设置；以前单独标成一手的 `T1_5`、`T2` 信源不再算一手，要算就改成 `T1`。
- **行业包多了几项**：`taxonomy.ts` 新增 `RELEASE`、`PLAIN_TERMS`，评论类的类别标 `commentary: true`，`ENTITIES` 可以写 `otherNames`，`CATEGORY_BY_ITEM_TYPE` 不再使用。已经换成别的行业的站，合并时对照 [把它改成你的行业](customize.md) 补上。
- **主题只读 `industry/topics.json`**：迁移会删掉数据库里的 `topics` 表。只改过数据库、没改文件的主题，升级前先写进文件。公司主题只看 `entityId`，`related` 不再使用。
- **日报不再调用模型**：日报按规则编排，周报月报从日报汇编，模型只写总述和栏目导读；已经出过的各期不重写。
- **提示词有改动**：`industry/prompts/` 里的 `structure.md`、`group-*.md`、`story-digest.md`、`report-period.md` 换成了新的写法，`report-daily-lead.md` 删掉了，新加了 `report-period-sections.md`。改过这些提示词的，对照着把自己的改动搬过去。
- **删掉的脚本**：`scripts/delete-sources.ts`、`scripts/regroup-events.ts`、`scripts/enqueue-analysis.ts`。不要的信源在后台暂停；单篇的重新评估、重新归组在后台“内容诊断”里打开这一篇操作。
- **管理员会话绑定登录方式**（迁移 `0041`）：从还没有会话绑定的版本升级后，未绑定的旧会话需要重新登录。此前已试用会话绑定迁移的数据库可直接升级，已有列和绑定会被保留，无需手动修改迁移记录。之后的规则见下方“管理员会话与配置变更”。
- **3.x 的 `/agent` 默认打开 Agent Markdown**，MCP 的接入说明在 `/agent?tab=mcp`；当前接入页见上方“站点文件搬进 `site/`”。
- **飞书内容群只推 `T1`、`T1_5` 信源的精选。**

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。`DB_BACKUP_STORE_SECRET_ID`、`DB_BACKUP_STORE_SECRET_KEY`、`DB_BACKUP_STORE_BUCKET`、`DB_BACKUP_STORE_REGION` 四项都要填；不填 `DB_BACKUP_STORE_DOMAIN` 时按腾讯云 COS 拼地址（`<桶名>.cos.<地域>.myqcloud.com`），用其他 S3 兼容存储时，把这个存储桶的访问域名（含桶名，例如 AWS S3 的 `<桶名>.s3.<地域>.amazonaws.com`）填进 `DB_BACKUP_STORE_DOMAIN`。

一次完整备份包含同一时间戳的数据库 `.dump` 和文件包 `.tar.gz`，文件名取自数据库名：Docker 里数据库叫 `aihot`，所以是 `aihot-<时间>.dump` 和 `aihot-files-<时间>.tar.gz`。文件包保留 `uploads/` 以及仍存本地的 `feedback-screenshots/`，不包含图片缓存或本地备份目录。已经转发到飞书的图片只保留数据库中的外部引用，文件包不保存飞书上的图片。

恢复时同时取回这一对文件：使用与数据库版本兼容的 `pg_restore` 将 `.dump` 恢复到空数据库，再把文件包解压到数据目录根目录（Docker 中为 `/data`，非 Docker 使用 `AIHOT_DATA_DIR`，默认 `.data`），保留包内的子目录结构，并确保运行进程可读取这些文件。只恢复数据库不能找回仍由 `local:` 引用的反馈截图；旧备份中没有包含的文件也无法凭数据库引用恢复。

下面的手动导出只包含数据库，不包含上述附件目录：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 重新部署与数据导入

本站从测试环境 `newshot` 的当前动作结构备份恢复到新的空库，不把旧部署库直接迁移到新版。本站具体导入工具与审计流程见 [deploy/news-hot/README.md](../deploy/news-hot/README.md#重新部署并导入测试环境数据)。以下是执行顺序，删除旧构建、容器、数据库挂载、迁移数据及公开上线仍在实际部署时分别核对目标并授权：

1. 固定已测试的代码提交；开发分支提交并推送后，与远端核对一致，确保工作区干净。源库的迁移账本须与该提交的迁移文件完全匹配，不修改账本伪造一致。
2. 停止测试环境的 API、worker 和其他写入，用匹配源库主版本的 `pg_dump` 导出完整 custom-format 数据库包；同时打包实际数据目录中的 `uploads/`、`feedback-screenshots/`，生成数据库内容、序列、附件引用与文件校验清单。保留测试环境本身，导出不删除源库。
3. 在独立空库完整恢复，检查全部表、数据、序列、外键、附件和迁移账本；启动同一提交的 API/web 做冒烟检查。所有采集、模型和推送开关保持关闭，不启动 worker。恢复失败先处理源备份或代码，不删除旧部署。
4. 停止旧部署的 API、worker 及人工写入，单独备份旧数据库、附件、私有配置及发布状态，保留可恢复的旧版本。核对项目专属的构建、容器、镜像、数据库卷或 bind mount 的真实位置；只清理本项目明确列出的目标，不用全局 prune，不删除其他项目的卷、证书、测试源库或备份。首次导入工具拒绝已有部署状态，需把旧 current 及初始化状态移到带时间戳的归档，保留 shared/.env 和 release.lock，不能只删数据库卷后沿用旧 initialized 标记。
5. 用全新构建和空数据库挂载部署，恢复与演练相同的数据库包和附件包，再次核对内容清单。恢复完整 schema 的目标库不先运行 setup 建表；导入后也不重复初始化或隐式执行未批准的迁移。
6. 保留部署环境专用 `.env`、签名密钥和生产地址；测试环境 `.env` 不上传、不随代码覆盖部署配置。完整数据库备份包含会话、Webhook 订阅、待发任务、回执和检查点，验收时逐项核对目标地址与通知积压；未批准前安全阀关闭，worker 保持停止，不补发历史通知。
7. 验证前后台、v2、RSS、MCP、附件及重启。公开上线和恢复采集、模型、通知分别授权；失败时保持新应用停写，用保留的旧备份及匹配代码恢复，不能把新结构数据库交回旧代码直接启动。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

### 管理员会话与配置变更

会话绑定登录方式、登录时的管理员凭据或飞书身份。修改管理员密码、飞书管理员名单或会话密钥后，应重启所有 API 进程，使它们加载相同的新配置；只编辑配置文件不代表正在运行的进程已生效，混用旧代码或旧配置的进程不能提供统一撤权。

有效配置改变后，密码会话不再接受旧密码的授权，飞书会话按登录时实际取得的 union ID 或邮箱检查当前名单（两者任一仍获授权即可）。停用飞书登录应用或更换应用 ID 会使飞书会话失效；只轮换同一应用的 secret 不会使仍获授权的飞书会话退出。轮换或移除 `SESSION_SECRET` 会使两种会话都失效。

鉴权时确认失效的会话会被删除，恢复旧配置也不会让它复活。系统不记录全局凭据变更历史：某次配置变化若从未被进程加载，或在恢复前从未被会话检查观察到，不能据此追溯撤销会话。

## 花多少钱

- **模型**：每条新资料先预筛一次；过了预筛的再评两次分、做一次结构化、写一次标题摘要，然后归组（有相近的报道时才调用），另外还有事件综述、周报月报的总述和精选的全文翻译。空正文、纯链接的 X 帖子不调用写作或翻译模型。日报按规则编排，不调用模型。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 付费请求上限”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17，系统用 Linux 或 macOS；Windows 上请在 WSL2 里运行，或者用上面的 Docker 方式。

```bash
npm ci
node scripts/init-env.ts --llm-key <你的模型 API Key>
createdb myhot
```

在 `.env` 里加上：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

NODE_ENV=production node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
NODE_ENV=production node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程都要带 `NODE_ENV=production`。api 和 worker 不带它就按开发环境运行：启动时不检查生产密钥和管理员密码，`DEV_AUTH_ROLE` 免登录也会生效。

三个进程要一直运行，生产环境用 systemd 或 pm2 守护（守护配置里同样设 `NODE_ENV=production`）。停止 worker 时至少给它 210 秒（systemd 的 `TimeoutStopSec`、pm2 的 `kill_timeout`），让进行中的付费调用收尾；被提前杀掉的调用结果不明，要等至少半小时自动放行后才会重试。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。

## 重置监控

### 动作模型与 v2 切换

三个产品后台基础页分为“事件列表”和“帖子列表”两个 tab，默认事件列表。事件下默认展开动作时间线及全部来源，帖子列表包含已关联与未关联帖子，各自分页。`kind=events/posts` 切换列表，只保留北京时间开始日期 from、结束日期 to 筛选（包含当天），切换保留日期并清除页码；事件按最新来源时间筛选，帖子按发布时间筛选。`/events/:id` 是共用时间线的事件详情；帖子通过列表弹框编辑和管理关联，保留及人工完成复核仍有理由和影响预览。旧 `/posts/:id/review` 和独立 `/posts` 页面均不提供。Codex 后台与 API 基础路径分别为 `/admin/codex-reset`、`/api/admin/codex-reset`，不保留旧路径或 tab/manage 查询方式。

最终业务只有三张表：帖子 monitor_source_posts、事件 monitor_event_records、动作 monitor_event_actions。关系为事件包含动作、动作以 sources 的 {postId} 引用帖子，不保留帖子事件绑定或独立动作来源表。动作的 sequence 是事件内事实顺序，增删来源不改变顺序；不保存 result、scope、fact_key，影响范围只保存在事件。

帖子保存原文 text、必要的单层随帖引用 quoted_post、七语言标题摘要及处理记录，不保存全文翻译或供应商原始 JSON。运行识别直接读取帖子，不从采集回执恢复正文。原文只供后台管理员读取，不进入动作、事件、公开响应或业务审计；供应商响应仍保留在内部付费回执，供计费与请求续处理。正文与引用分开，不能把引用当作外层帖子的动作依据。

事件摘要直接使用保存值，空值不回退动作摘要，不保存 summary_edited。独立翻译能力按编辑版本补全七语言，使用已配置的监控模型，仅受 MODEL_CALLS_ENABLED 控制，不依赖采集开关。站点允许 `cron.codex-reset.translate`、`cron.claude-reset.translate`、`cron.grok-reset.translate` 三个独立分钟任务；事件、动作和全部识别状态的帖子在创建或编辑后补齐标题、摘要及事件范围说明的缺失语言，原帖全文不进入翻译输入。保留已填写语言和业务字段，旧翻译不能覆盖新编辑；相同完整版本不重复请求，失败版本等待人工处理，新编辑形成新版本后重新判断。缺失语言在完成前仍使用安全公开文案，不会在采集 tick 补跑翻译。事件文案编辑不要求原因；动作、来源和重排操作仍要求理由、影响预览和相关记录版本核验。

数据库升级先在独立测试副本验证，再按使用者本次授权执行。正式写入前停止相关服务和脚本，验证完整备份并保留可恢复代码，不修改历史迁移或迁移账本。维护工具的备份校验要求 custom-format 包含所有业务表的结构和数据，并实际恢复到同一数据库服务中的独立空库；恢复成功或失败均删除该临时库。运行维护工具的连接账号须能建库；无权限或恢复失败则拒绝清理和修复，不回退到只检查文件目录。当前维护工具按各自文档要求核验停写条件、备份和预览。

#### 当前结构与维护

业务数据统一保存在 monitor_source_posts、monitor_event_records、monitor_event_actions。动作只保存来源 postId、业务时间与事件内顺序；帖子处理状态为 pending、processed、needs_attention、failed。旧格式转换器与分阶段迁移入口已退出，不能用新代码直接转换未升级的历史库。迁移执行器按完整文件名执行，历史 SQL 及在线 DDL 校验保持不变。

现行 v2 文案导入导出、离线历史重建与上下文定点修复继续使用各自的预览、版本或指纹核验、完整备份和审计，不依赖旧格式转换模块。完整备份由独立 backup.ts 校验，失败不得继续写入。原帖、付费回执、通知去重基线与审计不是本次代码清理对象。

后台事件详情与列表共用时间线和编辑弹框；旧 /posts/:id/review 页面、GET 后台 /events 和 /events/options 已移除，不提供兼容别名。帖子在列表管理关联弹框中完成保留和人工复核，动作顺序在事件详情单独预览提交。

### 上下文与按串识别升级

新增 `0142_monitor_posts_context_only.sql` 为帖子添加默认 false 的 context_only。先停止 worker，按本次授权执行该增量迁移，再启动同一版本 API 与 worker；不修改历史迁移，不自动回填或重识别历史记录。辅助上下文不进入独立识别、默认业务帖子统计或官方动作来源。主采结果与完整引用按 ID 规范化保存，补齐必要父帖后按真实关系分组，每组调用一次模型并一次事务保存；付费回执在持久化失败时复用。完整规则见[采集与按串识别](reset-monitor-collection.md)。

已发生漏采时使用 `node --env-file-if-exists=.env modules/reset-monitor/scripts/thread-repair.ts --platform codex --receipts 35 --targets 2115273253711409208,2115330127886463244` 生成只读预览。确认备份和指纹后，停止 worker 并保持采集、模型、通知关闭，增加 `--apply --worker-stopped --fingerprint <指纹> --backup <完整备份.dump>` 应用。工具只恢复指定引用及父帖证据、将指定待复核帖子重新设为 pending，不调用付费接口、不回退成功检查点、不改已处理帖子或事件动作。历史目标保存通知抑制标记，后续识别不补发历史通知；新真实付费识别另须明确授权。

### 增量采集与运行

账号、显示名与 collection 在 `site/reset-monitors.ts`。主帖始终开启，includeReplies（回复他人）、includeSelfReplies（自回复）与 resetOnly 分别控制，三个平台可独立修改；本站 includeSelfReplies=true，其余两项为 false；关键词按字面 OR 查询，模型复用现有调用确认三类额度事件及其后续消息。英文忽略大小写、不自动扩展词形，中文按包含匹配；启用过滤时词表非空。“All done”等未命中关键词的相关短回复可能遗漏，模型无法补回。

两个回复开关均关闭时只采主帖；只开 includeReplies 时加采回复他人，只开 includeSelfReplies 时加采自回复，两者都开时加采全部回复。仅采配置账号自己发布的内容，不采其他人的回复；纯转推排除，引用帖保留。第三方查询负责回复类别筛选，本地不重复判断，目标账号缺失不丢弃帖子。reply_to 保存供应商提供的父帖 ID 和账号，引用对象保留自身回复关系；上下文先复用本轮响应和当前监控已存材料，缺失时按明确父帖或引用 ID 付费补采，不抓整个评论区。明确无关且无需复核的帖子保留 filtered_out，后台默认隐藏未关联帖子，可切换“采集记录”查看、人工保留或作为动作来源；文案编辑不解除过滤。

升级时在各平台 collection 中补上 includeSelfReplies。旧配置 includeReplies=true 曾包含全部回复；若要保持原范围，升级后须同时设 includeReplies=true、includeSelfReplies=true。本站三个平台设为 includeReplies=false、includeSelfReplies=true，采集主帖及自回复。此项配置拆分不需要数据库迁移，不删除已有数据，不重置成功截止，也不回补历史回复；修改后重启 API 与 worker。

升级新增 `0131_monitor_posts_reply_to.sql` 与 `0132_monitor_posts_filtered_out.sql`，分别添加可空的 reply_to 和默认 false 的 filtered_out；不删除数据、不回填或重新识别历史。已有动作模型库先按上节完成至 0130，再运行正常迁移并重启 API、worker。本地实施只在隔离测试库验证，不自动迁移现有库。

配置修改不重置成功截止，不回补已完成窗口的历史回复或漏词帖子，不重筛已完成记录；未完成窗口和待识别记录使用当前配置。新增或重新添加账号先保存观察起点，已有账号沿成功截止补齐完整窗口；失败不移动起点或跳过停机数据。空结果或全部被过滤可正常完成窗口，不恢复旧处理模式、历史初始化和每日查漏。

采集在发起付费请求前持久保存固定窗口和执行标识。搜索页失败后停止当前账号，本次不重发，其他账号继续；停机、安全阀和预算拒绝立即停止。下一次任务保留窗口、查询与续页位置，已收到并保存的页面直接复用。明确未受理的可重试 HTTP 拒绝沿原 key 恢复；网络结果未知的搜索页保留原回执与计费未知记录，下一次任务使用关联原回执的新请求身份补采，可能再次计费，仍计入每轮搜索请求上限并检查预算和安全阀。收到响应但 schema 无效或不可重试的拒绝等待人工处理，不反复购买。上下文补采、识别和翻译的计费未知请求不适用搜索页恢复规则。固定窗口全部采集与识别持久完成后才推进截止并清除窗口状态。

此修复不需要数据库迁移或更改环境变量。旧版留下的失败窗口按原成功截止恢复，保留回执、帖子及成功页面，不删除数据或把截止直接改为当前时间。旧窗口尚未记录恢复身份时，第一次执行保存失败页的恢复信息，下一次定时执行发起补采。运行页显示失败账号、回执、计费是否未知及下一步；lastAttemptAt 为本次实际执行时间，windowStartedAt 为固定窗口时间。

付费请求经过回执、预算和安全阀。worker 只识别 pending 帖子，成功、待人工处理或失败写入均核验本轮原始版本及 pending 状态，过期任务不能覆盖人工处理。成功无论有无动作均为 processed；动作更正、来源增删和重排不改识别状态，帖子处理入口明确完成识别才设 processed 并清空 review_reason。翻译只补文案，不改帖子处理状态。采集完成且识别结果已保存才推进检查点；已收到模型响应的结构失败和文案待复核不阻断截止。持久化失败复用 received 响应，同版本翻译任务待复核不反复购买，计费未知不自动重发。

发卡识别使用完整 JSON Schema；付费响应中可辨认的动作按模型类型保存并展示，校验问题留在来源帖待人工修订。使用截止不进入发放计划，未知预告保留空时间。无法核实的范围保存 unknown，不扩大为全体用户。后台更正动作类型后保持已有事件可展示；编辑动作可原位调整到同类型未撤回事件，保留动作 ID、来源、创建时间及帖子回执，预览和事务提交覆盖新旧事件。此更新无需数据库迁移或新增环境变量。发布前查三个监控是否有 `recognition:pending:` 在途组，优先由旧 worker 写入已收到的响应；旧版本在途组若未完成，切换后转人工复核并保留回执，不重新付费。新识别组使用新规则，已有待人工处理记录不会自动重跑。历史定点恢复须先备份和预览，不回退成功截止或补发历史通知；重新付费识别须单独得到授权。

本站采集队列为 `cron.monitor.tick`、`cron.claude-reset.tick`、`cron.grok-reset.tick`；多语言补全分别由 `cron.codex-reset.translate`、`cron.claude-reset.translate`、`cron.grok-reset.translate` 每分钟独立执行。另外保留事件确认检查和订阅 sweep、deliver 队列。`site/site.ts` 的 `DEPLOYMENT.queues` 限制所有生产者、消费者和定时注册，`engineSchedules=[]` 停用框架定时任务；新闻处理、通用全文翻译及运维队列不会因 worker 重启或后台请求重新创建。禁用任务的后台操作返回明确的站点配置停用错误。三个采集 cron 在采集和模型安全阀关闭时仍保留定义，执行立即跳过；翻译 cron 仅在模型安全阀打开时注册，关闭后重启 worker 会移除对应定时定义，不在 tick 中补跑。

调整任务时保持全部 worker 停止，先运行 `node --env-file=.env scripts/reconcile-schedules.ts` 查看只读清单，再在核对后加 `--apply --worker-stopped` 同步；存在活跃 cron 时拒绝操作。同步不执行任务、不启动调度、不改 schema、不删除付费回执、运行审计和非 cron 队列。清空测试业务与付费记录另须明确授权并先备份，不以任务配置替代数据清理。

Webhook 扫描每分钟维护比较基线及待发任务，仅在 `WEBHOOK_PUSH_ENABLED=true` 时投递，首次内容须符合当前动作契约。转换清理旧格式待发内容后不补发历史通知；普通停用订阅、安全阀关闭及恢复行为见[订阅协议](reset-monitor-webhooks.md)。生产转换、通知和公开部署分别按授权执行。

### 帖子人工核对通知

使用 Server酱 Turbo 的微信通道，在其控制台完成微信绑定并获取 Turbo SendKey。后端从环境变量或凭据目录的 `integrations.env` 读取 `SERVERCHAN_SENDKEY`，只在 `SERVERCHAN_ENABLED=true` 且凭据齐全时启用。SendKey 不写入代码、日志或 Git。本系统默认独占该 SendKey 的免费额度；其他程序共用会减少实际可用额度。

独立分钟任务 `cron.reset-review.notify` 已加入本站白名单，不依赖采集、模型和读者订阅开关，不需要 schema 迁移。worker 在注册任务前核对开关，首次启用建立起点，只通知之后新进入 `needs_attention` 或 `failed` 的帖子。历史定点修复和关闭期间的帖子不产生通知资格。

停用时先停止全部 worker，将 worker 的 `SERVERCHAN_ENABLED` 设为 `false`，再在同一部署的后端运行环境执行 `node modules/reset-monitor/scripts/disable-review-notifications.ts --worker-stopped`。直接运行时可以在 `node` 后加 `--env-file=.env` 载入本环境配置。此命令持久作废旧待发资格，不发送通知；重新启用前也须完成这一步，即使关闭期间没有启动 worker。若已经以关闭配置启动 worker，启动检查也会登记停用。再次启用后旧待发不补发。

三平台合计按北京时间每天最多 5 次发送尝试，失败及中断导致的未知结果计次；明确未发起请求的取消不占额度。单帖单次，不汇总、不催办；当天超额及跨日未发送永久跳过。同帖退出异常后再次进入可以重新通知，编辑和翻译不触发。已发起的请求保留结果，失败、超时和未知均不重试。后台“运行”的人工核对通知模块显示发送、失败、未知、取消和跳过数量，以及近期需要查看的轮次。

通知只发送固定原因及原帖和后台链接，详细原因须由管理员登录后台查看。开发与测试保持 `SERVERCHAN_ENABLED=false`；实现、测试不代表授权配置真实凭据、打开推送或部署。

### 平台配置

Codex、Claude、Grok 统一支持直接重置、重置卡和奖励额度。初始账号、采集规则和平台专属事件规则分别见 [Codex](../modules/codex-reset/README.md)、[Claude](../modules/claude-reset/README.md)、[Grok](../modules/grok-reset/README.md)。新监控使用共享表并由 `monitor_id` 复合关系隔离，不复制业务实现或另建产品表。

### 影响范围契约切换

事件 `scope` 只保留 `type`、`note`，总览移除 `catalog`。产品、套餐、额度周期和具体资格保存在已有七语言事件摘要及动作摘要中，不新增表或列。保留 v2 路径和 Webhook `schemaVersion=2`，但字段精简是不兼容变更，`news-hot` 与 `when-reset` 及其他接收方须在同一窗口切换。新 API 和 worker 启动会检查旧字段及旧通知基线，未完成清理时拒绝启动。

先在旧契约下只读盘点，命令只生成指定的新文件，不更改数据库、不调用模型或发送通知：

```bash
node --env-file=.env modules/reset-monitor/scripts/scope-cutover.ts --inventory .data/scope-inventory.json
```

清单列出需要核对的旧代码、现有范围和摘要、动作及来源链接，以及在途识别、待发回调、待发布变化和接收方数量，不输出订阅密钥或回调地址。人工核对每个事件的原帖与已有摘要；资格必须保存在对应动作的完整七语言摘要中，已有文案写清就保留，缺失时补进对应动作摘要，不能根据旧代码推断完整资格或重跑历史识别。有来源事件仍要求有来源动作保留资格；只有无来源确认的事件允许使用经核对的确认摘要，保留 sources=[]，不补造来源或作为官方事实送模型。复制 `reviewTemplate` 为 `.data/scope-reviewed.json`，每项核对后设 `reviewed=true`；需要补充时填写 `actions:[{id,summary}]`，也可同时填写事件 `summary`。原 `scope.note` 含实际产品、套餐、周期或具体资格时，核对摘要保留事实后，在清单填写新的 `scope:{type,note}`；`note` 为七语言简短用户说明或 null，`selected_users` 不能为 null。仅补事件摘要不能应用，后续官方概述仍只从有来源动作生成。不能省略、重复或增加清单以外的事件；来源或资格有歧义的条目先人工核对。

仍用旧代码处理待发、发送中 Webhook、已收到的识别响应，以及 `unpublishedEvents` 中尚未进入旧通知基线的真实变化；无法处理的项列给管理员，不直接丢弃或改成新格式重发。停止全部 API、worker 和其他写入方后，重新盘点并核对最终清单，制作当前完整备份并验证可恢复，之后才可在获得数据修改授权时应用：

```bash
node --env-file=.env modules/reset-monitor/scripts/scope-cutover.ts --apply .data/scope-reviewed.json --worker-stopped --database-backup .data/scope-before.dump
```

应用前保持采集、模型、Webhook、Server酱、飞书和 IndexNow 安全阀关闭。备份核验可用 `--verification-database-env SCOPE_VERIFY_DATABASE_URL` 指定隔离验证库环境变量名，不在命令中公开连接串。工具在单事务内加锁、核验清单指纹；写入期间有变化、存在待发回调、在途识别、待发布变化或未配置平台旧记录时拒绝操作。旧格式指纹只在离线工具中重建并与原基线比较，不在运行接口或通知中兼容旧格式。

操作删除事件范围 JSON 中的 `productCodes`、`planCodes`、`quotaWindowCodes`，仅写入人工批准的摘要补充；保留事件、动作、来源、业务时间、付费回执、订阅及已发通知。比较基线按新投影重建，保留修订号，不产生 `updated` 或历史补发。旧失败回调保留审计记录，不能在新契约下重试；若需处理，切换前由管理员在旧契约下核对。没有有效旧字段的记录不须逐条修改，但旧基线仍需切换。

隔离演练及两仓联调通过后再执行已授权的发布，并核对历史摘要、总览统计及新事件签名回调。回滚使用切换前的完整备份及对应旧代码一起恢复，不能只切回旧代码读取已清理的数据。执行数据修改、真实通知、推送和部署仍须分别获得授权。

## 离线重建重置监控

仅在使用者明确授权清理当前测试库后执行。先停 API 和 worker 写入，制作当前完整备份并在隔离测试库验证恢复。`modules/reset-monitor/scripts/offline-import.ts` 默认预览；应用需匹配目标库、清理指纹、备份文件及停写声明。只清空 `monitor_event_actions`、`monitor_event_records`、`monitor_source_posts`、`monitor_state`、`monitor_webhook_deliveries`、`monitor_webhook_notifications`，不使用 CASCADE；保留 Webhook 订阅、付费回执、预算、审计及其他业务数据。此操作删除已有监控内容与运行状态，恢复须使用操作前完整备份。

外部接口只提供平台与来源 URL/帖子 ID，不使用其事件事实。Chrome 核验时切回原文，读取精确时间、引用与回复关系；缺少必需字段不得猜测。离线识别按正式提示词与 JSON schema 整理，并走共用事实校验；数据库回执为空，本地清单记录浏览器证据与识别来源。此入口不调用付费服务，不新增队列，不改变线上采集配置，不将定点导入记为完整搜索窗口。完成后以现有通知机制建立历史基线，再恢复服务，采集、模型与推送保持关闭。

## 开发环境的监控自动翻译

用户明确开启后，只在开发 worker 的启动进程中设置 `MODEL_CALLS_ENABLED=true`，保持 `COLLECT_ENABLED=false`、`WEBHOOK_PUSH_ENABLED=false`、`SERVERCHAN_ENABLED=false`、`FEISHU_*_ENABLED=false`、`INDEXNOW_SUBMIT_ENABLED=false`；API 和页面进程保持模型关闭。启动配置不得把模型开关重新硬编码为 false；可以使用该进程的启动参数或环境覆盖，无需修改 `.env`。使用现有监控模型、付费回执和预算控制，不另建翻译服务。

保存事件、动作和帖子的文案后，下一分钟翻译任务补齐 en、zh、zh-Hant、ja、ko、ru、es，并在版本仍一致时提交；编辑状态和业务字段不随翻译改变。读取页面不会调用模型。后台显示与公开接口可能受最长 60 秒缓存影响，完整译文到齐后公开展示和现有通知基线按原规则更新；开发环境不打开真实推送。
