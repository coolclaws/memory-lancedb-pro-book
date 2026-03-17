# 附录 B：核心类型速查

本附录汇总了 memory-lancedb-pro 中最重要的 TypeScript 类型定义，按功能域分组，方便在阅读各章时随时查阅。每个类型都标注了所在源文件与关联章节。

---

## 1. 插件配置

### PluginConfig

插件的顶层配置接口，贯穿全书几乎所有章节。

**源文件：** `index.ts`
**关联章节：** Ch1、Ch2、Ch15

```typescript
interface PluginConfig {
  /** 向量嵌入配置 */
  embedding: EmbeddingConfig

  /** LanceDB 数据库路径，默认为项目根目录下 .memory/lancedb */
  dbPath?: string

  /** 是否自动从对话中捕获记忆 */
  autoCapture?: boolean

  /** 是否在对话开始时自动召回相关记忆 */
  autoRecall?: boolean

  /** 检索管线配置 */
  retrieval?: RetrievalConfig

  /** 记忆衰减配置 */
  decay?: DecayConfig

  /** 记忆层级配置 */
  tier?: TierConfig

  /** 是否启用 LLM 驱动的智能提取 */
  smartExtraction?: boolean

  /** LLM 客户端配置（用于智能提取、反思等） */
  llm?: LlmClientConfig

  /** 多作用域配置 */
  scopes?: ScopeConfig

  /** 会话恢复策略 */
  sessionStrategy?: 'memoryReflection' | 'systemSessionMemory' | 'none'

  /** 记忆反思配置 */
  memoryReflection?: MemoryReflectionConfig

  /** Markdown 镜像输出 */
  mdMirror?: { enabled: boolean; dir: string }

  /** 工作区边界配置 */
  workspaceBoundary?: WorkspaceBoundaryConfig
}
```

### EmbeddingConfig

向量嵌入模型的配置。

**源文件：** `src/embedder.ts`
**关联章节：** Ch4

```typescript
interface EmbeddingConfig {
  /** 嵌入模型提供商 */
  provider: 'openai' | 'ollama' | 'custom'

  /** 模型名称，如 "text-embedding-3-small" */
  model: string

  /** 向量维度 */
  dimensions?: number

  /** API 端点（自定义提供商时使用） */
  endpoint?: string

  /** API 密钥 */
  apiKey?: string
}
```

---

## 2. 检索配置

### RetrievalConfig

混合检索管线的完整配置，控制检索模式、权重、重排序与评分阈值。

**源文件：** `src/retriever.ts`
**关联章节：** Ch6、Ch7、Ch8、Ch9

```typescript
interface RetrievalConfig {
  /** 检索模式：hybrid 同时使用向量与 BM25，vector 仅用向量 */
  mode: 'hybrid' | 'vector'

  /** 向量检索权重，默认 0.7 */
  vectorWeight: number

  /** BM25 检索权重，默认 0.3 */
  bm25Weight: number

  /** 最低相关性分数（软阈值），默认 0.3 */
  minScore: number

  /** 重排序策略 */
  rerank: 'cross-encoder' | 'lightweight' | 'none'

  /** 粗排阶段候选池大小，默认 20 */
  candidatePoolSize: number

  /** Cross-Encoder 重排序模型名称 */
  rerankModel: string

  /** 时间衰减半衰期（天），用于 recency 加权，默认 14 */
  recencyHalfLifeDays: number

  /** Recency 评分权重，默认 0.1 */
  recencyWeight: number

  /** 长度归一化锚点（字符数），默认 500 */
  lengthNormAnchor: number

  /** 硬性最低分数阈值，低于此分数直接丢弃，默认 0.35 */
  hardMinScore: number

  /** 全局时间衰减半衰期（天），默认 60 */
  timeDecayHalfLifeDays: number

  /** 强化因子，被访问的记忆获得的分数提升，默认 0.5 */
  reinforcementFactor: number

  /** 最大半衰期倍数，限制强化效果的上限，默认 3 */
  maxHalfLifeMultiplier: number
}
```

---

## 3. 记忆元数据

### SmartMemoryMetadata

每条记忆携带的智能元数据，包含多级摘要、分类、层级与关系信息。

**源文件：** `src/smart-metadata.ts`
**关联章节：** Ch10、Ch14

```typescript
interface SmartMemoryMetadata {
  /** 一句话摘要（Level 0） */
  l0_abstract: string

  /** 段落级概述（Level 1） */
  l1_overview: string

  /** 完整内容（Level 2） */
  l2_content: string

  /** 记忆分类 */
  memory_category: MemoryCategory

  /** 记忆层级 */
  tier: MemoryTier

  /** 访问次数 */
  access_count: number

  /** 置信度，范围 0-1 */
  confidence: number

  /** 最近访问时间（Unix 时间戳） */
  last_accessed_at: number

  /** 生效起始时间（Unix 时间戳） */
  valid_from: number

  /** 失效时间（Unix 时间戳），undefined 表示仍然有效 */
  invalidated_at?: number

  /** 事实键，用于去重判断 */
  fact_key?: string

  /** 本条记忆取代的记忆 ID */
  supersedes?: string

  /** 取代本条记忆的记忆 ID */
  superseded_by?: string

  /** 与其他记忆的关系列表 */
  relations?: MemoryRelation[]

  /** 来源会话 ID */
  source_session?: string
}
```

---

## 4. 枚举与联合类型

### MemoryCategory

记忆的语义分类，共 6 种。

**源文件：** `src/memory-categories.ts`
**关联章节：** Ch10、Ch14

```typescript
type MemoryCategory =
  | 'profile'       // 用户画像（姓名、角色、背景）
  | 'preferences'   // 用户偏好（编码风格、工具选择）
  | 'entities'      // 实体信息（项目、组织、技术栈）
  | 'events'        // 事件记录（会议、决策、里程碑）
  | 'cases'         // 案例经验（问题排查、解决方案）
  | 'patterns'      // 行为模式（工作习惯、交互模式）
```

### MemoryTier

记忆的存储层级，决定衰减速度与检索优先级。

**源文件：** `src/tier-manager.ts`
**关联章节：** Ch11

```typescript
type MemoryTier =
  | 'core'          // 核心记忆：衰减最慢，检索优先级最高
  | 'working'       // 工作记忆：中等衰减速度，活跃使用中
  | 'peripheral'    // 边缘记忆：衰减最快，可能被归档或清理
```

### DedupDecision

智能提取阶段的去重决策类型。

**源文件：** `src/smart-extractor.ts`
**关联章节：** Ch10

```typescript
type DedupDecision =
  | 'create'         // 创建新记忆
  | 'merge'          // 与已有记忆合并
  | 'skip'           // 跳过，已有相同记忆
  | 'support'        // 作为已有记忆的佐证
  | 'contextualize'  // 为已有记忆补充上下文
  | 'contradict'     // 与已有记忆矛盾，需要标记
  | 'supersede'      // 取代已有记忆（信息更新）
```

---

## 5. 衰减与生命周期

### DecayConfig

记忆衰减引擎的配置参数。

**源文件：** `src/decay-engine.ts`
**关联章节：** Ch11

```typescript
interface DecayConfig {
  /** 基础半衰期（天），默认 60 */
  baseHalfLifeDays: number

  /** 重要性调制系数，控制记忆重要性对衰减速度的影响 */
  importanceModulation: number

  /** 时间近因权重 */
  recencyWeight: number

  /** 访问频率权重 */
  frequencyWeight: number

  /** 内在重要性权重 */
  intrinsicWeight: number
}
```

### TierConfig

记忆层级管理配置，定义各层级的行为参数。

**源文件：** `src/tier-manager.ts`
**关联章节：** Ch11

```typescript
interface TierConfig {
  /** 自动升降级是否启用 */
  autoPromote: boolean

  /** 升级为 core 层的访问次数阈值 */
  coreThreshold: number

  /** 降级为 peripheral 层的闲置天数阈值 */
  peripheralAfterDays: number

  /** 是否自动清理过期的 peripheral 记忆 */
  autoCleanup: boolean
}
```

---

## 6. 作用域与权限

### ScopeConfig

多作用域隔离与权限控制配置。

**源文件：** `src/scopes.ts`
**关联章节：** Ch13

```typescript
interface ScopeConfig {
  /** 默认作用域名称 */
  default: string

  /** 作用域定义 */
  definitions: Record<string, {
    description: string
  }>

  /** Agent 访问权限映射：Agent ID → 可访问的作用域列表 */
  agentAccess: Record<string, string[]>
}
```

---

## 7. LLM 客户端

### LlmClientConfig

用于智能提取、反思等功能的 LLM 客户端配置。

**源文件：** `src/llm-client.ts`、`src/llm-oauth.ts`
**关联章节：** Ch10、Ch12

```typescript
interface LlmClientConfig {
  /** LLM 提供商 */
  provider: 'openai' | 'anthropic' | 'ollama'

  /** 模型名称 */
  model: string

  /** API 密钥 */
  apiKey?: string

  /** API 端点 */
  endpoint?: string

  /** OAuth 配置（可选） */
  oauth?: OAuthConfig
}
```

---

## 8. 工作区边界

### WorkspaceBoundaryConfig

工作区边界配置，控制记忆的隔离粒度。

**源文件：** `src/workspace-boundary.ts`
**关联章节：** Ch13、Ch15

```typescript
interface WorkspaceBoundaryConfig {
  /** 是否启用工作区边界隔离 */
  enabled: boolean

  /** 边界策略 */
  strategy: 'directory' | 'project' | 'custom'

  /** 自定义边界标识符 */
  boundaryId?: string
}
```

---

## 9. 会话与反思

### MemoryReflectionConfig

记忆反思机制的配置。

**源文件：** `src/reflection-*.ts`
**关联章节：** Ch12

```typescript
interface MemoryReflectionConfig {
  /** 触发反思的最小记忆条数 */
  minMemories: number

  /** 反思的最大回溯天数 */
  lookbackDays: number

  /** 是否生成会话摘要 */
  generateSummary: boolean

  /** 反思深度 */
  depth: 'shallow' | 'deep'
}
```

---

## 10. 辅助类型

### MemoryRelation

记忆之间的关系描述。

**源文件：** `src/smart-metadata.ts`
**关联章节：** Ch14

```typescript
interface MemoryRelation {
  /** 关系类型 */
  type: 'supports' | 'contradicts' | 'extends' | 'related'

  /** 目标记忆 ID */
  targetId: string

  /** 关系强度，范围 0-1 */
  strength: number
}
```

---

## 类型关系总览

下图展示了核心类型之间的从属关系：

```
PluginConfig
├── EmbeddingConfig
├── RetrievalConfig
├── DecayConfig
├── TierConfig
├── LlmClientConfig
├── ScopeConfig
├── MemoryReflectionConfig
└── WorkspaceBoundaryConfig

SmartMemoryMetadata
├── MemoryCategory
├── MemoryTier
└── MemoryRelation[]

SmartExtractor
└── DedupDecision
```

> **提示：** 在阅读具体章节时，可以随时翻回本附录查阅类型定义。如果你使用支持 TypeScript 的 IDE，也可以直接跳转到源文件查看最新的类型定义——源码永远是最权威的参考。
