# Issue tracker: GitHub

本项目的任务、需求规格和缺陷记录使用 GitHub Issues，固定仓库为 `qimoukeji/news-hot`：https://github.com/qimoukeji/news-hot/issues。

## 访问与目标核验

- 优先使用已连接的 GitHub 工具，所有操作明确传入 `repository_full_name: "qimoukeji/news-hot"`，或在搜索条件中限定 `repo:qimoukeji/news-hot`。
- 每次会话首次写入前，通过 GitHub 的 `get_repo` 工具确认目标仓库与当前 `origin` 一致。禁止向上游 `KKKKhazix/AIHOT` 或技能来源 `mattpocock/skills` 创建本项目的任务。
- 若改用 GitHub CLI，所有命令带 `--repo qimoukeji/news-hot`。CLI 不可用时继续使用连接器；两者都不可用时报告缺少的访问能力，不伪造 Issue 编号或成功结果。
- 不将凭据、令牌或私有配置写入任务正文、文件或日志。

## 任务操作

- 读取：获取 Issue 的标题、正文、状态、标签、评论和依赖；正文与评论都参与需求核对，存在冲突时明确指出。
- 搜索：限定本仓库，按编号、关键词、状态和已有标签筛选。不得为了匹配技能假设而自行创建标签。
- 创建：先准备自包含的标题和正文；仅在本次任务明确授权公开创建 Issue 时执行。Markdown 正文通过结构化参数传递；使用 CLI 时写临时文件后传 `--body-file`。
- 评论、关闭、标签、指派及依赖变更属于远端写入，沿用本次授权和根目录 AGENTS.md 的自主边界；初始化配置不构成这些操作的长期授权。
- 父子任务优先使用 GitHub 原生 sub-issues；依赖优先使用原生 issue dependencies。当前工具不支持这些关系时，在正文保存明确的父任务链接和 `Blocked by: #编号`，并说明限制。只有依赖任务都已关闭，才视为解除阻塞。
- Issue 与 PR 共享编号空间；读取裸编号时核对对象类型。

## 技能中的任务用语

- “fetch the relevant ticket”：按明确编号读取本仓库 Issue；若用户给的是仓库内规格文件，也读取该文件，不要求先公开发布才能审查。
- “publish to the issue tracker”：准备或创建本仓库 Issue；实际公开创建仍须符合本次明确授权。
- 已创建任务保存真实编号和链接；创建失败时保留本地内容并报告原因。

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

仅在使用相应技能时采用：一个地图 Issue 关联多个子任务 Issue；研究、原型、讨论和实施分别记录明确任务类型。先查询父子关系、依赖和指派，再选择可执行任务；认领、评论、关闭等操作仍遵守远端写入授权。当前未配置自动标签创建或批量分派。
