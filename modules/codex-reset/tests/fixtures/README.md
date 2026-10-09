# 监控离线样本

这里保存公开原帖、直接回复及引用上下文和人工判断，供本地假服务或独立测试数据库验证。文件使用描述性小写连字符名称，JSON 不包含凭据、生产状态或数据库快照。

`review-posts.json` 冻结 17 条历史需复核帖子。`originalPropositions` 保留原判断，`propositions` 是按原文逐条核验后的输入，`decision`、`expectedReview` 和 `reason` 是测试期望。测试不访问外部模型、采集服务，也不修改线上判断；新增样本须先阅读完整直接上下文。
