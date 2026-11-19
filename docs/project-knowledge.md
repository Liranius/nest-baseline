# 项目知识

工程决策及其来源保存在当前 Git worktree 的 `docs/knowledge/`。Codex、命令行和会话 hooks 共用[启动器](../scripts/knowledge.mjs)，根据 Git 根目录选择 Markdown 和 SQLite 数据库。知识随 Git 审查和合并。开发、构建及 CI 可以在未安装 Basic Memory 的环境中运行。

## 安装与验证

按 [README](../README.md#项目初始化) 准备 Node 和 pnpm，并安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)。运行 `pnpm knowledge:setup` 建立独立的 Python 3.12 环境、安装 Basic Memory 0.24.1、索引项目知识并执行诊断。首次安装需要可用的包和模型下载源或本机缓存。项目固定 Basic Memory 的版本，Python 传递依赖在安装时解析。

默认缓存位于 `~/.cache/equipment-booking-api-memory/`。运行时和模型可跨 worktree 复用，项目配置和数据库按 worktree 路径分别保存。自定义缓存根目录时，对手工命令和 Codex 设置相同的 `EQUIPMENT_BOOKING_MEMORY_CACHE`。启动器可以使用 PATH 中的 uv，或缓存目录下的 `bin/uv`（Windows 为 `bin/uv.exe`）。

从当前仓库打开新的 Codex 会话。通过 `codex mcp get basic-memory` 检查项目级服务配置，在 `/hooks` 中审查项目的 SessionStart 和 PreCompact 命令并确认信任。用 MCP 读取已有决策可验证会话实际使用的知识库。[MCP 配置](../.codex/config.toml) · [会话 hooks](../.codex/hooks.json) · [官方集成说明](https://docs.basicmemory.com/integrations/codex/)

SessionStart 提供当前项目的上下文。PreCompact 在本机缓存记录压缩事件，压缩后的 SessionStart 会提示恢复工作的 agent 保存 checkpoint。`captureFolder` 将 checkpoint 目录设为 `codex/checkpoints/`。准备提交时一并审阅进入 `docs/knowledge/` 的内容。

| 命令                                                     | 用途                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm knowledge:doctor`                                  | 核对 worktree、项目路径、MCP 工具和 SessionStart 输出。      |
| `pnpm knowledge:cli project index equipment-booking-api` | 合并或手工修改知识后，索引本 worktree 的文件。               |
| `pnpm knowledge:find API --limit 5`                      | 按字面查找项目笔记，返回有限数量的标题、状态、来源与摘录。   |
| `pnpm knowledge:check --since <提交>`                    | 查看该提交至今及工作区内的来源变更，列出有待人工复核的笔记。 |

## 日常维护

先按主题查找，再读候选笔记并核对其来源。首次索引或中文语义搜索未返回预期笔记时，改用项目名、标题或 `knowledge:find`。只读问答保持只读。将已确认、后续会用到的决定写入 `codex/decisions/`，在 `sources` 中列出实际核对过的仓库相对文件路径。代码变化使旧决定失效时，修订原笔记或记录替代关系。验收记录和提议各自保留原有状态。[项目知识维护技能](../.agents/skills/project-knowledge/SKILL.md)

## 验证范围

项目使用独立的知识目录、缓存和 MCP 项目标识。首次使用时按上文安装运行时，在本仓库独立确认 hooks 信任，并通过 doctor 与新会话读取核实。基线仓库的宿主信任及验收记录仅属于原仓库。
