# 附录 C：术语表

本术语表收录了全书中频繁出现的中英文术语，按拼音首字母排序。每个术语标注了英文原文与简要说明，方便读者在阅读过程中随时查阅。

---

| 术语 | English | 说明 |
|------|---------|------|
| BM25 全文索引 | BM25 Full-Text Index | 基于词频与逆文档频率的经典全文检索算法，本项目中作为混合检索的文本匹配分支。见 Ch5。 |
| Cross-Encoder 重排序 | Cross-Encoder Reranking | 将 query 与 candidate 拼接后送入 Transformer 模型计算相关性分数的精排方法，精度高但开销大。见 Ch7。 |
| 半衰期 | Half-Life | 记忆衰减模型中的核心参数，表示记忆分数衰减到一半所需的时间（天数），由 `baseHalfLifeDays` 配置。见 Ch11。 |
| 边缘记忆 | Peripheral Memory | `MemoryTier` 中最低优先级的层级，衰减最快，长期不访问可能被自动清理。见 Ch11。 |
| 层级管理 | Tier Management | 将记忆按重要程度分为 core、working、peripheral 三个层级，控制衰减速率与检索优先级的机制。见 Ch11。 |
| 粗排 | Candidate Retrieval | 检索管线的第一阶段，从全量记忆中快速筛选出候选集合，由 `candidatePoolSize` 控制大小。见 Ch6。 |
| 分块 | Chunking | 将长文本切分为适合向量嵌入的小段的过程，影响检索粒度与召回质量。见 Ch4。 |
| 工作记忆 | Working Memory | `MemoryTier` 中的中间层级，表示当前活跃使用的记忆。见 Ch11。 |
| 工作区边界 | Workspace Boundary | 按项目目录或自定义标识符隔离记忆的机制，防止不同工作区的记忆交叉污染。见 Ch13。 |
| 核心记忆 | Core Memory | `MemoryTier` 中最高优先级的层级，衰减最慢，存放最重要的长期记忆。见 Ch11。 |
| 混合检索 | Hybrid Retrieval | 同时使用向量相似度搜索与 BM25 全文检索，通过加权融合提升召回率与精度的检索策略。见 Ch6。 |
| 记忆反思 | Memory Reflection | 在会话结束时由 LLM 对积累的记忆进行回顾、归纳与整合的机制。见 Ch12。 |
| 记忆分类 | Memory Category | 将记忆按语义分为 profile、preferences、entities、events、cases、patterns 六类的分类体系。见 Ch10、Ch14。 |
| 记忆关系 | Memory Relation | 记忆之间的语义关联（supports、contradicts、extends、related），用于构建记忆图谱。见 Ch14。 |
| 记忆衰减 | Memory Decay | 模拟人类遗忘曲线，随时间推移降低记忆分数的机制，由 `DecayConfig` 配置。见 Ch11。 |
| 精排 | Reranking | 检索管线的第二阶段，对粗排候选使用更精确的模型重新评分排序。见 Ch7。 |
| 噪声过滤 | Noise Filtering | 识别并过滤低质量、重复或无关的记忆候选，提升最终检索结果的信噪比。见 Ch8。 |
| 噪声原型 | Noise Prototype | 预定义的噪声模式模板，用于快速识别常见的低质量内容，如寒暄、确认等。见 Ch8。 |
| 强化因子 | Reinforcement Factor | 被频繁访问的记忆获得的分数提升系数，由 `reinforcementFactor` 配置。见 Ch9。 |
| 去重决策 | Deduplication Decision | 智能提取阶段判断新记忆与已有记忆关系的决策，包括 create、merge、skip 等七种类型。见 Ch10。 |
| 生命周期钩子 | Lifecycle Hook | 插件在 OpenClaw 框架中的初始化、激活、销毁等关键时机的回调函数。见 Ch15。 |
| 事实键 | Fact Key | 记忆元数据中的唯一事实标识符，用于快速判断两条记忆是否描述同一事实。见 Ch10。 |
| 时间衰减 | Time Decay | 基于记忆创建或最后访问时间的评分衰减机制，由 `timeDecayHalfLifeDays` 控制。见 Ch9。 |
| 数据迁移 | Data Migration | 在插件版本升级时将旧数据结构转换为新格式的过程，由 `migrate.ts` 和 `memory-upgrader.ts` 实现。见 Ch17。 |
| 向量嵌入 | Vector Embedding | 将文本转换为高维向量表示的过程，使语义相似的文本在向量空间中距离接近。见 Ch4。 |
| 向量权重 | Vector Weight | 混合检索中向量相似度分数的权重系数，默认 0.7，由 `vectorWeight` 配置。见 Ch6。 |
| 长度归一化 | Length Normalization | 对不同长度的文本块进行评分校准的机制，防止长文本在评分中获得不公平的优势，锚点由 `lengthNormAnchor` 设置。见 Ch9。 |
| 置信度 | Confidence | 记忆元数据中表示该条记忆可靠程度的数值（0-1），由 LLM 提取时评估。见 Ch10。 |
| 智能提取 | Smart Extraction | 由 LLM 驱动的记忆提取流程，能自动从对话中识别值得记忆的信息并结构化存储。见 Ch10。 |
| 自适应检索 | Adaptive Retrieval | 根据查询特征动态调整检索策略（如切换模式、调整阈值）的机制。见 Ch8。 |
| 作用域 | Scope | 记忆的隔离命名空间，不同作用域的记忆互不可见，由 `ScopeConfig` 配置。见 Ch13。 |
| Agent 工具 | Agent Tool | 暴露给 AI Agent 调用的记忆操作接口，如存储记忆、检索记忆、删除记忆等。见 Ch16。 |
| ANN 索引 | Approximate Nearest Neighbor Index | 近似最近邻索引，用于在高维向量空间中快速找到与查询向量最相似的记录。见 Ch3。 |
| LanceDB | LanceDB | 本项目使用的嵌入式列式向量数据库，支持向量搜索与结构化查询。见 Ch3。 |
| OAuth 认证 | OAuth Authentication | 用于 LLM API 访问的授权协议，由 `llm-oauth.ts` 实现。见 Ch10。 |
| OpenClaw | OpenClaw | 本插件所集成的 AI Agent 框架，提供插件化架构与生命周期管理。见 Ch1、Ch15。 |

---

> **关于中英文混排的约定：** 本书在行文中遵循"中文与英文之间加空格"的排版惯例，例如写作"使用 LanceDB 存储"而非"使用LanceDB存储"。术语表中的中文术语名也遵循此规则。
