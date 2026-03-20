# 第十四章 智能元数据与分层存储

> 一条记忆不仅仅是一段文本。它有生命周期，有重要性层级，有与其他记忆的关联，有被创建和被废弃的时刻。`smart-metadata.ts` 定义的 `SmartMemoryMetadata` 接口，是 memory-lancedb-pro 从"简单键值存储"进化为"智能记忆系统"的关键跃迁。本章将逐一拆解这个接口的每一个字段，解释它们为何存在，以及它们如何协同工作。

## 14.1 从扁平文本到结构化元数据

早期的记忆插件将每条记忆视为一个扁平的文本块：一段内容加上一个向量嵌入。这种简单模型在小规模使用时工作良好，但随着记忆量增长，问题开始浮现。

当记忆库中积累了数百条记忆时，每次召回都需要对所有记忆进行向量相似度计算。更严重的是，过时的信息会与最新的信息以相同的权重参与排序——上周被修正的错误认知可能因为向量相似度高而被优先召回。

`SmartMemoryMetadata` 的设计目标是为每条记忆附加足够的结构化信息，使得检索系统可以做出更智能的决策：哪些记忆应该优先召回？哪些已经过时？哪些可以被合并？哪些只在特定上下文中相关？

### 核心流程

```
SmartMemoryMetadata 在记忆生命周期中的作用:

创建时:
  对话 ──+---> smart-extractor ──+---> 生成 L0/L1/L2
                |                      |
                v                      v
          分类 (6 categories)    normalizeMetadata()
                |                填充默认值:
                v                tier=working
          设置 importance         confidence=0.7
          + confidence            valid_from=now()

检索时:
  L0 ──+---> 驱动向量嵌入, 高精度匹配
  L1 ──+---> 提供给重排序, 信息密度与 token 效率平衡
  L2 ──+---> 最终返回给 Agent, 完整上下文

版本更新时:
  旧记忆                          新记忆
  invalidated_at = now()     <──  supersedes = 旧 ID
  superseded_by = 新 ID      ──>  valid_from = now()
           \                      /
            +-- fact_key 相同 ---+
            (同一事实的不同版本)
```

## 14.2 L0/L1/L2 三层内容模型

```typescript
// 文件: src/smart-metadata.ts L20-35
interface SmartMemoryMetadata {
  l0_abstract: string       // 索引行——一句话摘要
  l1_overview: string       // 概要——几句话的上下文
  l2_content: string        // 完整内容
  // ...
}
```

三层内容模型是 `SmartMemoryMetadata` 最具创新性的设计之一。它借鉴了信息检索中"渐进式披露"（Progressive Disclosure）的思想。

**L0 `l0_abstract`** 是一句话的索引摘要。它的设计目的有两个：第一，在 `memory_list` 等枚举操作中，agent 可以快速浏览大量记忆而不需要加载完整内容；第二，在多阶段检索中，L0 可以作为初筛依据，避免对完整内容进行开销更大的语义匹配。

**L1 `l1_overview`** 是几句话的概要。它提供了比 L0 更多的上下文，但比 L2 更紧凑。在典型的 `memory_recall` 流程中，检索系统先用向量相似度从全量记忆中筛选出候选集，然后用 L1 进行重排序（re-ranking），最终将 L2 返回给 agent。L1 在这个重排序阶段发挥关键作用——它足够简短以支持批量处理，又足够详细以提供语义区分度。

**L2 `l2_content`** 是完整内容。只有最终被选中的记忆才需要加载 L2。在记忆量大的场景中，这种延迟加载策略可以显著减少上下文窗口的消耗。

这种三层设计的工程价值在于**解耦了检索粒度和展示粒度**。传统方案中，用于生成嵌入向量的文本和最终返回给 agent 的文本是同一段内容。但在 smart metadata 模型中，嵌入向量可以基于 L0 或 L1 生成（更紧凑，语义更集中），而返回内容使用 L2（更完整，信息更丰富）。

### 设计取舍

**L0/L1/L2 三层 vs 单一文本**的核心取舍是存储空间和维护成本的增加换取检索效率和展示灵活性的提升。单一文本方案实现最简单，但嵌入向量基于完整内容生成时会引入噪声（长文本中的次要信息干扰向量方向），且将全部 L2 内容塞入 LLM 上下文浪费 token 预算。三层设计解耦了"用什么搜索"（L0/L1）和"展示什么"（L2）的关注点。**时间版本控制**（supersedes 链）的替代方案是直接覆盖旧记忆。直接覆盖实现简单但丢失了历史信息——无法回答"三个月前项目用的什么数据库"。保留版本链的代价是存储空间增加（旧版本不删除）和查询时需要过滤 invalidated 记录，但对于记忆系统来说，"时间旅行"查询的能力远比节省几 KB 存储更有价值。

## 14.3 记忆分类体系

```typescript
// 文件: src/memory-categories.ts L10-50
type MemoryCategory =
  | 'preference'      // 用户/项目偏好
  | 'knowledge'       // 事实性知识
  | 'procedure'       // 操作流程
  | 'decision'        // 设计决策与理由
  | 'context'         // 环境上下文
  | 'reflection'      // 自我反思
```

六分类体系的设计反映了对 AI agent 记忆使用模式的深入观察。为什么是这六类，而不是更多或更少？

**`preference`** 捕捉偏好性信息——"用户喜欢 TypeScript 而非 JavaScript"、"项目要求使用 tabs 而非 spaces"。这类记忆的特征是主观性强、变化频率中等。

**`knowledge`** 存储事实性知识——"项目使用 PostgreSQL 16"、"API 端点在 /api/v2 下"。事实性知识的关键挑战是时效性，这就是为什么 temporal versioning（见 14.4 节）对这一类别尤为重要。

**`procedure`** 记录操作流程——"部署步骤：先运行测试，再构建 Docker 镜像，最后推送到 ECR"。流程性记忆往往是多步骤的，L2 内容通常较长。

**`decision`** 保存决策及其理由——"选择 LanceDB 而非 Pinecone，因为需要本地部署且不想依赖外部服务"。决策记忆的独特价值在于它记录了 "why"，而不仅仅是 "what"。当未来有人质疑某个技术选型时，decision 类记忆可以提供历史上下文。

**`context`** 存储环境上下文——"当前处于 feature-x 分支的开发阶段"、"这是一个微服务架构项目"。上下文记忆的生命周期通常较短。

**`reflection`** 是 agent 的自我反思——"我在处理并发问题时容易忽略 race condition"。这类记忆配合第十三章介绍的反思作用域使用。

```typescript
// 文件: src/memory-categories.ts L55-80
// 旧版 5 分类到新版 6 分类的映射
const LEGACY_CATEGORY_MAP: Record<string, MemoryCategory> = {
  'user_preference': 'preference',
  'project_knowledge': 'knowledge',
  'workflow': 'procedure',
  'architecture_decision': 'decision',
  'general': 'context'
  // 旧版没有 'reflection' 类别
}
```

从 5 分类到 6 分类的迁移映射揭示了系统演进的历史。旧版使用更长的分类名（`user_preference` vs `preference`），且没有 `reflection` 类别——这说明自我反思能力是在后续版本中加入的。映射表的存在确保了升级过程中已有记忆不会丢失分类信息。

## 14.4 时间版本控制

```typescript
// 文件: src/smart-metadata.ts L50-80
interface SmartMemoryMetadata {
  // ...
  valid_from: number          // 记忆生效的时间戳
  invalidated_at?: number     // 记忆失效的时间戳
  fact_key?: string           // 去重键
  supersedes?: string         // 本条记忆替代的旧记忆 ID
  superseded_by?: string      // 替代本条记忆的新记忆 ID
  // ...
}
```

这组字段共同构成了一个轻量级的时间版本控制系统。理解它的最佳方式是通过一个例子。

假设 agent 在 1 月存储了一条记忆："项目数据库使用 PostgreSQL 14"（fact_key: `project.database.version`）。三个月后，项目升级到了 PostgreSQL 16。agent 存储新记忆："项目数据库使用 PostgreSQL 16"（同一个 fact_key）。

此时系统的行为是：旧记忆的 `invalidated_at` 被设置为当前时间戳，`superseded_by` 指向新记忆的 ID；新记忆的 `supersedes` 指向旧记忆的 ID，`valid_from` 设置为当前时间戳。

**为什么不直接删除旧记忆？** 因为时间版本控制支持"时间旅行"查询。当 agent 需要理解"三个月前项目的技术栈是什么样的"时，它可以查询在特定时间点有效的记忆。这在调试历史问题、理解项目演进时非常有用。

**`fact_key` 的去重作用**。`fact_key` 是一个语义标识符，表示"这条记忆描述的是什么事实"。两条 `fact_key` 相同的记忆被视为同一事实的不同版本。这让系统可以自动检测事实更新并建立版本链，而不需要 agent 显式指定"我要更新哪条旧记忆"。

**`invalidated_at` 的可选性**。这个字段是可选的（`?`），因为大多数记忆不会被显式废弃。偏好类记忆（"用户喜欢深色主题"）通常不会过时，它们只是随时间积累。只有事实性知识（`knowledge` 类别）才频繁涉及版本更替。

## 14.5 记忆层级与访问追踪

```typescript
// 文件: src/smart-metadata.ts L85-110
interface SmartMemoryMetadata {
  // ...
  tier: MemoryTier              // core | working | peripheral
  access_count: number          // 累计访问次数
  confidence: number            // 置信度 0-1
  last_accessed_at: number      // 最后访问时间戳
  // ...
}

type MemoryTier = 'core' | 'working' | 'peripheral'
```

三层记忆层级（tier）是另一个源自认知科学的设计。

**`core`** 层存储高频访问、高重要性的记忆。这些是 agent 的"核心知识"——几乎每次会话都会用到的信息。例如项目的基本技术栈、核心架构模式。

**`working`** 层存储中频访问、中等重要性的记忆。这是 agent 的"工作记忆"——在当前工作周期内频繁使用，但可能在项目阶段切换后降低重要性。

**`peripheral`** 层存储低频访问、低重要性的记忆。这些是"边缘记忆"——曾经有用但现在很少被召回的信息。

层级不是静态的。`DecayEngine` 和 `TierManager`（可选子系统，将在后续章节详述）会根据 `access_count` 和 `last_accessed_at` 动态调整记忆层级。一条记忆如果长期不被访问，会从 `working` 衰减到 `peripheral`；如果突然被频繁召回，又会被提升回 `working` 甚至 `core`。

**`confidence`** 字段（0 到 1 之间的浮点数）表示系统对这条记忆准确性的置信度。新存储的记忆默认置信度较高，但如果后续出现矛盾信息，置信度会被降低。这为检索系统提供了一个额外的排序信号——在向量相似度相近的情况下，高置信度的记忆应该被优先返回。

## 14.6 实体关系与记忆网络

```typescript
// 文件: src/smart-metadata.ts L120-150
interface MemoryRelation {
  target_id: string           // 关联记忆的 ID
  relation_type: string       // 关系类型
  weight: number              // 关系强度
}

interface SmartMemoryMetadata {
  // ...
  relations?: MemoryRelation[]  // 实体关联
  source_session?: string       // 来源会话 ID
  // ...
}
```

`relations` 字段将孤立的记忆条目编织成一个有向图。为什么需要这个？

向量检索擅长找到"语义相似"的记忆，但有些关联是语义上不相似却逻辑上紧密相关的。例如，"使用 React Router v6" 和 "路由配置在 src/routes.tsx 文件中" 在向量空间中可能距离较远（一个讨论技术选型，一个讨论文件位置），但它们在逻辑上紧密相关——知道前者的同时通常也需要知道后者。

`relations` 提供了一种显式的关联机制来补充向量检索的不足。当 `memory_recall` 返回一条记忆时，系统可以沿着 `relations` 链接加载相关记忆，实现"图增强检索"（Graph-Augmented Retrieval）。

`source_session` 字段记录了记忆的来源会话。这看似简单，但在调试和审计场景中非常有价值。当一条记忆的准确性受到质疑时，`source_session` 可以帮助追溯到原始对话上下文，理解这条记忆是在什么情境下被创建的。

## 14.7 向后兼容策略

```typescript
// 文件: src/smart-metadata.ts L300-350
function normalizeMetadata(raw: Partial<SmartMemoryMetadata>): SmartMemoryMetadata {
  return {
    l0_abstract: raw.l0_abstract ?? raw.l2_content?.substring(0, 100) ?? '',
    l1_overview: raw.l1_overview ?? raw.l0_abstract ?? '',
    l2_content: raw.l2_content ?? '',
    memory_category: mapLegacyCategory(raw.memory_category) ?? 'knowledge',
    tier: raw.tier ?? 'working',
    access_count: raw.access_count ?? 0,
    confidence: raw.confidence ?? 0.7,
    last_accessed_at: raw.last_accessed_at ?? Date.now(),
    valid_from: raw.valid_from ?? Date.now(),
    invalidated_at: raw.invalidated_at,
    fact_key: raw.fact_key,
    supersedes: raw.supersedes,
    superseded_by: raw.superseded_by,
    relations: raw.relations ?? [],
    source_session: raw.source_session
  }
}
```

`normalizeMetadata` 函数是整个 smart metadata 系统的"防御层"。它处理了两种情况：旧版本记忆升级后缺少新字段，以及新记忆创建时部分字段未提供。

每个 fallback 策略都经过仔细考量。`l0_abstract` 在缺失时从 `l2_content` 的前 100 个字符截取——这不是完美的摘要，但至少提供了可用的索引信息。`tier` 默认为 `'working'` 而非 `'core'`——新记忆还没有经过时间检验，不应直接进入核心层。`confidence` 默认 0.7 而非 1.0——留出空间让后续的验证机制调整。

这种"优雅降级"（Graceful Degradation）的策略确保了系统可以渐进式升级，而不需要一次性迁移所有现有数据。旧数据在被访问时按需补全新字段，新数据则从创建时就携带完整元数据。

## 本章小结

`SmartMemoryMetadata` 接口是 memory-lancedb-pro 智能化的基石。L0/L1/L2 三层内容模型解耦了检索效率和展示质量；六分类体系从旧版五分类平滑演进，新增的 `reflection` 类别支持了 agent 自省能力；时间版本控制（`valid_from`、`invalidated_at`、`supersedes` 链）让记忆系统具备了事实演进的感知能力；`tier` 和访问追踪字段为衰减引擎提供了决策依据；`relations` 将孤立记忆编织成知识图谱。而贯穿所有这些设计的，是 `normalizeMetadata` 所体现的向后兼容哲学——系统可以演进，但已有数据永远不会被抛弃。
