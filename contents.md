# 目录

## 第一部分：宏观认知

- [第 1 章：项目概览](/chapters/01-overview) -- memory-lancedb-pro 是什么、解决什么问题、核心能力一览
- [第 2 章：架构全景与模块依赖](/chapters/02-architecture) -- 分层架构、32 个源文件的职责划分与依赖关系图

## 第二部分：存储基石

- [第 3 章：LanceDB 存储引擎](/chapters/03-lancedb-store) -- store.ts 的 CRUD 设计、惰性连接与路径校验
- [第 4 章：向量嵌入与分块策略](/chapters/04-embedder) -- 多 Provider 嵌入、LRU 缓存、语义分块与长文本处理
- [第 5 章：BM25 全文索引](/chapters/05-bm25-fts) -- LanceDB FTS 集成、关键词检索与向量检索的互补

## 第三部分：检索与重排

- [第 6 章：混合检索管线](/chapters/06-hybrid-retrieval) -- 向量 + BM25 加权融合的完整调用链
- [第 7 章：Cross-Encoder 重排序](/chapters/07-reranker) -- 六大 Reranker Provider 的统一抽象与容错回退
- [第 8 章：自适应检索与噪声过滤](/chapters/08-adaptive-noise) -- 查询分类、正则噪声过滤与嵌入噪声原型学习
- [第 9 章：检索评分体系](/chapters/09-scoring) -- 长度归一化、生命周期衰减加成、MMR 多样性与硬分阈值

## 第四部分：记忆生命周期

- [第 10 章：智能记忆提取](/chapters/10-smart-extractor) -- LLM 六类提取、两阶段去重、L0/L1/L2 分层构建
- [第 11 章：记忆衰减与层级管理](/chapters/11-decay-tier) -- Weibull 拉伸指数衰减、三级层级晋升与降级
- [第 12 章：记忆反思与会话恢复](/chapters/12-reflection) -- 自动反思摘要、会话目录解析与跨会话连续性

## 第五部分：多作用域与元数据

- [第 13 章：多作用域隔离与权限](/chapters/13-scopes) -- 五种作用域模式、Agent 级 ACL 与默认安全策略
- [第 14 章：智能元数据与分层存储](/chapters/14-smart-metadata) -- SmartMemoryMetadata 结构、L0/L1/L2 索引与向后兼容

## 第六部分：集成接口

- [第 15 章：插件入口与生命周期钩子](/chapters/15-plugin-entry) -- index.ts 的 3500 行全解：配置解析、钩子注册与后台服务
- [第 16 章：Agent 工具系统](/chapters/16-agent-tools) -- 六个核心工具与管理工具的 Schema 设计与实现
- [第 17 章：CLI 与数据迁移](/chapters/17-cli-migrate) -- 十余条子命令、导入导出、批量升级与跨版本迁移

## 附录

- [附录 A：推荐阅读路径](/chapters/appendix-a-reading-path) -- 不同背景读者的最佳阅读顺序
- [附录 B：核心类型速查](/chapters/appendix-b-type-reference) -- 关键接口与类型定义一览
- [附录 C：术语表](/chapters/appendix-c-glossary) -- 中英文术语对照
