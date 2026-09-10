# 本地运行与恢复

在项目根目录的当前 PowerShell 进程中设置配置；这些值只留在该进程的环境中，不会写入页面、浏览器存储、日志或文件。请不要创建 `.env` 文件。

```powershell
$env:ARK_API_KEY = 'your-ark-key'
$env:DOUBAO_CHAT_MODEL = 'your-doubao-chat-model'

# 可选：仅在需要本地资料的向量嵌入时设置
$env:DOUBAO_EMBEDDING_MODEL = 'your-doubao-embedding-model'

# 可选：仅在允许联网搜索回退时设置
$env:TAVILY_API_KEY = 'your-tavily-key'

.\start.ps1
```

启动脚本会选择一个空闲的本机端口并打开浏览器。终端仅显示本机地址、是否已配置豆包和联网搜索，以及 SQLite 数据库的绝对路径；它不会显示任何变量值。

在相同 PowerShell 窗口中，用启动输出中的端口检查健康状态：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/api/health
```

返回的 `doubaoConfigured` 和 `agentConfigured` 是布尔状态，不包含密钥或模型名称。

## 配置缺失时的本地模式

`TAVILY_API_KEY` 缺失时，联网搜索回退被禁用。`ARK_API_KEY` 缺失时，生成式回答被禁用；但归档搜索、本地反馈和知识库浏览不会被禁用。豆包回答还需要 `DOUBAO_CHAT_MODEL`；没有模型时也会保持为未配置状态。

无需联网或付费调用即可使用本地资料：浏览当日与往期日报、搜索当前内容和往期归档、在详情页保存兴趣/阅读反馈、查看知识卡片/主题 Wiki/兴趣画像，以及从“我的知识库”导出本地数据。SQLite 归档位于 `var/cognitive-daily.sqlite`（及其同目录的 SQLite 辅助文件）；备份或迁移时一并保留它们。

关闭窗口或按 `Ctrl+C` 停止服务后，重新在项目根目录运行 `.\start.ps1` 即可恢复本地归档。导出的 JSON 只包含可恢复的本地知识数据，不包含环境变量或 API 密钥。

## 检索与兴趣操作

Agent 会检索本地文章和 `verified` / `needs_review` 知识卡，保留原始引用。配置 embedding 模型后，首次问答会为缺少向量的本地文章和可用卡片生成缓存；文章内容变化后会重新生成对应向量。配置真实模型时，这些调用属于模型用量。

回答中的“本次检索依据”列出所用本地与联网来源。“联网核实”使用输入框中的问题；输入框为空时使用上一条问题。接口对应 `POST /api/chat` 的可选布尔字段 `verifyWeb`，省略时保持自动判断。搜索未配置或失败时会明确返回未完成核验。二手或未知来源单独支持的内容显示为尚待核验的来源说法。

知识库的创建日期筛选使用卡片记录的 UTC 日期。兴趣画像的“降低推荐”启用所选主题的一条 `lessLikeThis=-1` 信号，重复点击不累加；“清零”移除该主题全部反馈；“停止跟踪”只移除该主题的 `follow`。这些操作使用原有 SQLite `interest_signals` 表，主题级记录的 `article_id` 为空；文章级记录与其他主题不受跨主题清除。接口为 `POST /api/profile/topics/:topic/lower|reset|unfollow`，主题需要 URL 编码。

## 归档移除与导出恢复

同步时，不再出现在日报清单及 JSON 中的文章会记录在 `retired_articles`。其历史文章行保留以维护反馈和知识出处的外键，但不会出现在搜索、文章读取和向量候选中，FTS 与文章主题投影会移除。重新加入同一 ID 会恢复索引。知识卡、来源快照、明确指定的主题、历史文章出处及对话不会被级联删除。

同一网址内容变化会保存独立来源版本，旧卡继续指向旧证据。首次升级会保留原来源与卡片 ID；升级前可在停止服务后备份整个 `var` 目录。

导出格式 `schemaVersion: 2` 保留已有 `sources`、`cards`、`signals`、`conversations`，并添加 `cardRelations`、`cardSourceLinks`、`topicProvenance` 与 `articleReferences`。恢复时按来源/卡片 ID 建立实体，再恢复引用、替代/冲突关系及主题出处；`topicProvenance.explicit` 是明确指定的主题，`articles` 是准确文章出处，`origins` 保存已处理/一次性绑定状态。`articleReferences` 提供这些出处和反馈涉及的最小文章信息，完整日报仍由 `data/*.json` 恢复。导出不含向量、进程环境或完整文章正文；当前未提供自动导入接口。
