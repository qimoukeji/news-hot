# news-hot 部署

发布仓库是 `qimoukeji/news-hot`，发布分支是 `codex/deploy`。服务器通过 SSH 接收 Actions 构建的代码和镜像，不拉取 GitHub。运行 Node.js 24 和 PostgreSQL 18；Docker 卷、管理员凭据及业务数据不经过 GitHub。

## 目录与状态

| 位置 | 用途 |
| --- | --- |
| `incoming/<SHA>/` | 上传包、校验清单、待审批计划及工具；首次主帖流程切换另存私有 `history-plan.json`；仅接收完整 40 位 SHA |
| `releases/<SHA>/` | 对应提交的代码及清单 |
| `shared/.env` | 私有配置，权限 0600；部署账户拥有 |
| `shared/db-image-id` | 首次验证通过的 PostgreSQL 18 镜像内容 ID，更新应用不自动更换数据库镜像 |
| `shared/initialized`、`published-sha`、`current` | 成功初始化及已验收发布状态 |
| `shared/blocked-release` | 迁移、历史清理或回退失败；存在时禁止后续自动发布 |
| `backups/<UTC时间>-<SHA>/` | 数据库、附件、校验值和审批计划 |

根目录固定为 `/opt/news-hot`。数据库与附件分别使用 `news-hot_db` 和 `news-hot_data`。不要运行生产项目的 `down -v`、`docker volume prune` 或全局 `docker system prune`。

## GitHub 设置

1. 在仓库 `Settings → Actions → General` 启用 Actions。
2. 通过 `Settings → Secrets and variables → Actions` 新建仓库 Secret `DEPLOY_SSH_KEY`。使用仅供发布的 Ed25519 私钥，不复用管理员 root 密钥。
3. 新建仓库 Variables：`DEPLOY_HOST=120.79.132.2`、`DEPLOY_PORT=39999`、`DEPLOY_USER=news-hot-deploy`、`DEPLOY_KNOWN_HOSTS`。最后一个值须使用已核实的 `[120.79.132.2]:39999 ssh-ed25519 ...` 主机公钥，不在 CI 临时信任 `ssh-keyscan` 的结果。
4. 在 `Settings → Environments` 创建 `production` 与 `production-migrations`。Deployment branches and tags 选择 Selected branches and tags，只添加 `codex/deploy`。`production` 无审批人；`production-migrations` 的 Required reviewers 添加仓库所有者，允许本人审批，并禁止管理员绕过审批。
5. 审阅并安装完整 Check workflow。推送发布分支时，现有两个检查任务通过后才构建生产镜像，检查 PostgreSQL 18 的初始化、备份恢复和全站 smoke，再上传。
6. 首次导入完成后才允许自动发布；首次上传遇到未初始化状态会停下，不会自动新建空库替代已有数据。

迁移任务在 Actions 中点击 `Review deployments`，核对提交、文件和 SQL 后选择 `Approve and deploy`。审批摘要来自服务器的真实迁移账本，不只比较 Git 的新文件；审批绑定提交、旧发布版本、迁移内容和账本。状态变化后必须重新准备并审批。

## 首次配置与导入

执行前先确认系统账户、私有配置、CI/CD 改动、首次 push 和业务数据迁移。公开域名是独立的审批步骤。

1. 在操作者机器生成专用 Ed25519 密钥，将公钥上传到服务器。以 root 执行 `bash provision.sh <公钥文件>`，创建发布账户、Docker 组权限及独立目录。脚本拒绝覆盖已有账户或目录。Docker 组具有管理 Docker 主机的权限，因此发布分支及私钥仅交给管理员。
2. 使用 `runtime.env.example` 和现有私有配置建立 `/opt/news-hot/shared/.env`。数据库密码使用 64 位随机十六进制；数据库名称和账户固定为 `newshot`。管理员密码至少 12 位，两个签名密钥使用随机安全值。模型凭据仅在服务器保存，外部凭据目录需要另行安全复制，不能保留 Windows 路径。
3. 初始 `SITE_URL=https://news.xinbaihui.top`、`TRUST_PROXY=false`，采集、模型、所有飞书推送及 IndexNow 均关闭。任何脚本都不打印私有配置。
4. 在独立临时 Compose 项目验证完整应用和 PostgreSQL 18；完成初始化、smoke、备份恢复及重启。失败时不导入业务数据、不升级宿主系统。
5. 停止所有连接原库的 API、worker、初始化脚本和人工写入。付费请求必须正常收尾后停写。原库在本服务器的 PostgreSQL 18 中，本机 15432 是到服务器 5432 的 SSH 转发。
   确认原库没有客户端会话，记录数据库原有设置，再由 PostgreSQL 管理员在 `postgres` 库执行 `ALTER DATABASE newshot SET default_transaction_read_only=on`。保持原应用停止；此设置只约束新会话的默认事务，不能替代停写与会话核对。本站原生 PostgreSQL 管理程序位于 `/www/server/pgsql/bin/`，数据库业务账户没有修改数据库设置的权限。
6. 运行 `audit.cjs capture` 输出原库所有业务表的条数、内容哈希、序列状态和本地附件引用。使用 `/www/server/pgsql/bin/pg_dump` 18 导出 custom-format 备份并校验 `pg_restore --list`。密码通过私有 `PGPASSFILE` 提供，不放进命令参数。打包本机 `.data/uploads` 与 `.data/feedback-screenshots`；不存在时使用空 tar 包。停写期间生成数据库、审计文件和附件包，期间不恢复旧应用写入。
7. 上传 SHA 对应发布包，将 `stage-first.sh` 与 `manifest.cjs` 传到同一工具目录，执行 `stage-first.sh <SHA>`，核验 checksum、解包并加载两个镜像。保持原库停写，执行发布目录中的 `rehearse.sh <SHA> <dump> <files.tar.gz> <source-audit.json>`，在 `news-hot-import-rehearsal` 独立库恢复并核对全部内容。它还检查附件引用及逐文件 SHA256；演练卷停止后保留，记录绑定数据库、附件和审计文件三份输入。
8. 执行发布目录中的 `import.sh <SHA> <dump> <files.tar.gz> <source-audit.json>`。它拒绝已有目标卷、未完成演练、变更后的任一输入或开启的采集、模型、飞书、Webhook、IndexNow 开关。恢复后再次核对数据库和附件清单，以 UID 1000 仅启动 API/web，完成 smoke 和重启检查后才写入初始化状态；worker 保持停止，须在后续运营验收后单独恢复。
9. 原库、原备份及演练库都保留。初始仅通过管理员 SSH 隧道访问 `127.0.0.1:3000`，验收三个监控页面、后台、API、检查点、回执和附件引用。源库写入保持暂停，避免两套应用各自推进同一批数据。

业务数据备份与源库审计文件仅在本机及服务器之间传送，不成为 Actions artifacts。当前审计值是参考值；正式迁移必须在停写后重新生成，不能拿不停写时的报告冒充迁移基准。

首次演练要求代码与源库迁移账本完全匹配。发现待迁移文件时先输出 SQL 并拒绝导入；演练库保留供审阅。先确定经过批准的迁移方案或匹配源库的首次提交，再准备新的演练，不在正式导入里隐式迁移。导入中途失败时保留 `import-failed` 和目标卷；按现场情况批准恢复到新的空卷，或批准恢复原应用写入，不删除目标卷重试，也不同时开启两套 worker。

正常切换后保持原库只读。若经批准恢复原应用，先停止新库的 API、worker 和所有人工写入，再由原 PostgreSQL 管理员恢复记录中的数据库设置；原来未设置只读时执行 `ALTER DATABASE newshot RESET default_transaction_read_only`。恢复原应用前确认切换后新库产生的数据如何保留，不能直接忽略新增数据。

通过已有管理员连接建立预览隧道：`ssh -N -L 13000:127.0.0.1:3000 centos-server`，浏览器访问 `http://127.0.0.1:13000`。部署账户的密钥禁止端口转发，预览使用原管理员连接。

## 重新部署并导入测试环境数据

本站重建时，数据源是开发环境 `newshot` 中已核验的当前动作结构。保留测试源库，用数据库与附件的完整备份导入新建空卷；不用旧部署库执行跨结构迁移。准备方案不代表已经授权删除卷、数据导入、push 或公开部署。

1. 先按“更新和失败处理”核对开发分支、工作区和远端提交，源库迁移账本与待发布 SHA 必须完全一致。源库为 PostgreSQL 18，导出与演练使用 PostgreSQL 18 客户端，不用 17 客户端导出 18 数据库。
2. 停止测试环境所有写入后，按“首次配置与导入”生成 custom-format dump、附件包及 `audit.cjs capture` 清单。数据库、附件、审计三份文件计算校验值，后续演练和正式导入必须使用同一组输入；测试源库不删除。
3. 停止旧部署的 API/worker/web 及人工写入，备份旧数据库、附件、`shared/.env`、初始化状态和当前发布标识。列出 `news-hot` 项目的容器、镜像、实际数据库及附件挂载，确认它们是命名卷还是 bind mount，核验绝对路径及 Docker 项目标记；此时保留旧容器、镜像和数据库挂载，演练成功后才按清单处理。
4. 首次导入要求 `/opt/news-hot/current` 和 `shared/initialized` 不存在，且 `news-hot_db`、`news-hot_data` 两个目标卷不存在。旧 `current`、`shared/initialized`、`shared/published-sha` 及故障标记先移入受保护的带时间戳归档；保留 `shared/.env` 和发布锁。故障标记只能在核实旧故障已处置且本次重建已批准后归档。旧发布目录与镜像先保留至少一份可恢复版本，待新站验收后再按清单删除。
5. 准备全新发布包；在独立 `news-hot-import-rehearsal` 项目运行 `rehearse.sh <SHA> <dump> <files.tar.gz> <source-audit.json>`。失败时保留现场且不运行 import。若已存在上次演练卷或记录，先单独审阅并批准处理，不覆盖演练结果。
6. 演练成功后，核对旧数据库及附件已有可恢复备份，且挂载没有其他容器使用。按本次明确批准的对象清单清理旧构建、容器和目标数据库挂载，不执行全局 prune，不处理其他站点、证书、备份及刚验收的新发布包。按“首次配置与导入”使用 `import.sh` 恢复到两个空目标卷。源库备份已经包含 schema，导入前不运行 setup 建表，导入中不隐式迁移。导入后的表内容、序列、附件引用与逐文件哈希必须匹配审计清单。
7. 运行 API/web 验收前后台、公开接口、附件和重启，worker 保持停止。部署专用 `.env` 不用测试配置覆盖；安全阀保持关闭。核对备份中带来的 Webhook 订阅、待发任务、会话和采集检查点，确认生产接收地址及待发内容后再单独批准运营恢复，不能因恢复数据库自动发送测试通知。

若新版本验收失败，停止新实例并保留新卷、日志与备份；恢复旧站必须使用归档的旧数据库、附件及匹配代码，不把新结构数据交给旧代码。保留旧备份和测试源库，不能以重试为由删除唯一可恢复副本。

## 更新和失败处理

所有修改在开发分支 `dev/codex` 完成，部署分支 `codex/deploy` 只接收合并。使用者要求部署后，先执行 `git fetch origin` 更新远端引用，再检查开发工作区（包括关联 worktree）没有未提交、暂存或未跟踪的待提交变更，并确认 `git rev-list --left-right --count dev/codex...origin/dev/codex` 返回 `0 0`。有未推送提交、未提交变更、远端未同步或无法核验远端状态时停止，不合并、不部署。先按授权完成开发分支提交、推送和检查，核验通过后才把开发分支合并到 `codex/deploy` 并推送部署分支。不能绕过开发分支推送，直接发布工作区或仅本地存在的提交；部署结束后回到开发分支。push、CI/CD 修改、数据库迁移及公开部署仍遵循使用者的授权边界。

发布使用服务器锁；准备、校验与审批失败不停止现有应用。正式更新顺序为停止 API/worker/web、验证数据库及附件备份、必要迁移、种子数据、已批准的历史清理、新 API/web 启动、健康检查、smoke、记录发布 SHA。普通发布在验收后恢复此前运行的 worker；发布前已停止的 worker 保持停止，失败恢复也遵守这一状态。

首次从不含 `scripts/cleanup-monitor-history.ts` 的旧发布切换到含该脚本的新发布时，`prepare` 使用新镜像执行只读预览。完整清单只保存在服务器私有 `incoming/<SHA>/history-plan.json`，标准输出仍是计划 JSON，新增 `historyTransition`、`needsHistoryCleanup` 和 `historyFingerprint` 字段。审核要删除的帖子和状态及保留的证据；只有清单存在实际改动时才需要单独的历史清理批准。后续两个版本都已有该脚本的普通发布不会再次清理新采集数据。

```bash
bash release.sh prepare <完整SHA>
# 第三个参数为既有数据库迁移审批摘要，无迁移时传空字符串。
# 第四个参数为另行审核的历史清理 fingerprint；两个审批不能互相替代。
bash release.sh apply <完整SHA> '<迁移approvalDigest或空字符串>' '<历史historyFingerprint>'
```

`apply` 重新生成当前清单并核对指纹，缺少批准或指纹过期时在停止服务前拒绝；现有 CI 没有历史清理批准参数，因此首次切换有数据改动时会安全停止发布，需操作者按上述命令执行已批准的操作。审核前应按运营授权先停止 worker 并暂停后台写入，避免清单在审核期间变化；清理事务仍会再次检查指纹。停止旧 API/worker/web 并验证完整备份后，新镜像才读取只读挂载的备份并执行清理；该次容器使用创建备份的宿主 UID/GID，备份维持私有权限。旧 API 不会读取已变更的状态格式。首次切换发布只启动 API/web，即使此前 worker 正在运行也保持停止；验收事件、来源、公开投影和成功截止后，恢复 worker 需独立运营授权。

未开始迁移或历史清理的更新失败会停止候选版本并重启上一版。迁移或历史清理开始后，包含后续健康检查、smoke 失败在内的任何失败都会保持应用停止并写入 `blocked-release`，不能只切回旧镜像。首先检查 `backups/` 中对应的完整备份，再按批准的恢复方案恢复到新的空数据库卷、导入匹配附件、使用对应旧镜像验证；失败原库及卷保留。确认恢复成功后再解除阻断，不直接删除标记来跳过故障。

不会自动删除历史发布、备份或镜像。空间不足时先列出与本项目相关的对象，保留 current、上一成功版本和迁移前配对备份，再单独批准清理。仅可直接删除已确认不再需要的上传临时包及本次临时测试项目。

## HTTPS 与运营恢复

站名、运营主体、联系方式、使用规则及隐私说明确认后，在宝塔新增 `news.xinbaihui.top` 的静态站点，配置 Let's Encrypt 与续期，用 `nginx.conf.example` 设置反向代理。保留证书和 ACME 路径，动态内容不叠加缓存。检查 Nginx 配置后重载，仅在此时把 `TRUST_PROXY=true`。

验收 HTTPS、RSS、sitemap、API、MCP 和分享链接。采集与模型调用仍需确认预算、提供商和迁移后的检查点；直接恢复增量任务，不重复初始化或自动补采历史。飞书推送和 IndexNow 单独授权。

## 验证命令

```bash
node --test deploy/news-hot/tests/manifest.test.cjs deploy/news-hot/tests/attachments.test.cjs
bash deploy/news-hot/tests/release.integration.sh
bash deploy/news-hot/tests/attachments.integration.sh
bash deploy/news-hot/tests/import.integration.sh
bash deploy/news-hot/tests/audit.pg18.sh
bash deploy/news-hot/tests/bootstrap.sh
for script in deploy/news-hot/*.sh; do bash -n "$script" || exit; done
```

仓库业务代码仍须通过根目录 AGENTS.md 要求的完整检查。`package.sh` 必须运行在目标 SHA 的 checkout，输出目录在源码之外；它不接受工作区内容冒充已提交的发布。
