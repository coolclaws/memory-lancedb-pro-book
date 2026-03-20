# 第十六章 Agent 工具系统

> 对于 LLM 来说，工具就是它与外部世界交互的双手。memory-lancedb-pro 的六个核心工具——recall、store、update、forget、list、stats——定义了 agent 与记忆系统交互的完整界面。但工具设计的挑战不在于功能实现，而在于如何让一个语言模型"正确地"使用它们。`tools.ts` 的 800 行代码中，一半在处理功能逻辑，另一半在处理一个更微妙的问题：如何通过 schema 设计引导 LLM 的行为。

## 16.1 工具设计的双重受众

传统的 API 设计只需要考虑一类受众：开发者。但 agent 工具的设计需要同时考虑两类受众：**LLM**（调用者）和**系统**（执行者）。

对于 LLM，工具的名称、描述和参数 schema 是它理解"这个工具能做什么"的全部信息。一个命名不当或描述含糊的工具会导致 LLM 在错误的场景下调用它，或者传入不合适的参数。

对于系统，工具的执行函数需要正确地与 `MemoryStore`、`MemoryRetriever`、`ScopeManager` 等子系统交互，处理边界情况，返回格式化的结果。

`tools.ts` 在这两个维度上都下了功夫。

### 核心流程

```
Agent 工具调用完整流程:

LLM 决策调用工具
       |
       v
+------+--------+    +-----------+    +----------+
| 参数 Schema    +--->+ TypeBox   +--->+ 运行时   |
| 验证 (JSON     |    | 校验      |    | 参数解析 |
| Schema)        |    +-----------+    +-----+----+
+---------------+                           |
                                            v
                                    +-------+-------+
                              +-----+ Scope 权限    +-----+
                              |     | 检查          |     |
                              |     +---------------+     |
                              v                           v
                         [有权限]                    [无权限] → 报错

+----+---+---+---+---+---+
|    |   |   |   |   |   |
v    v   v   v   v   v   v
recall store update forget list stats
 |     |     |      |     |    |
 v     v     v      v     v    v
Retriever Store Store  Store Store Store
(混合检索) (写入) (更新+  (删除) (枚举) (统计)
            版本控制)

管理工具 (enableManagementTools=true):
  self_improvement_log ──> 观察行为
  self_improvement_extract_skill ──> 提取技能
  self_improvement_review ──> 回顾改进
```

## 16.2 memory_recall：混合检索的入口

```typescript
// 文件: src/tools.ts L30-120
const memoryRecallTool = {
  name: 'memory_recall',
  description: 'Search and retrieve relevant memories. Use this when you need to ' +
    'recall previously stored information, context, or decisions. Returns ' +
    'matching memories ranked by relevance.',
  parameters: Type.Object({
    query: Type.String({
      description: 'Natural language search query describing what you want to recall'
    }),
    scope: Type.Optional(Type.String({
      description: 'Limit search to specific scope (e.g., "global", "agent:xxx")'
    })),
    category: Type.Optional(Type.String({
      description: 'Filter by category: preference, knowledge, procedure, decision, context, reflection'
    })),
    limit: Type.Optional(Type.Number({
      description: 'Maximum number of results (default: 5)',
      default: 5
    }))
  }),
  execute: async (params, context) => {
    const scopes = params.scope
      ? [params.scope]
      : scopeManager.getAccessibleScopes(context.agentId)

    const results = await retriever.recall({
      query: params.query,
      scopes,
      category: params.category,
      limit: params.limit ?? 5
    })

    return results.map(r => ({
      id: r.id,
      text: r.metadata.l2_content,
      category: r.metadata.memory_category,
      scope: r.scope,
      importance: r.importance,
      score: r.score,
      sources: r.metadata.source_session ? [r.metadata.source_session] : []
    }))
  }
}
```

`memory_recall` 的描述文本经过精心措辞。注意它说的是 "Search and retrieve relevant memories" 而不是 "Query the vector database"。对 LLM 来说，前者是一个认知层面的描述（"回忆相关信息"），后者是一个实现层面的描述（"查询向量数据库"）。LLM 在决定是否调用一个工具时，依赖的是对工具描述的语义理解，因此认知层面的描述更容易让 LLM 在正确的时机调用。

参数设计中，`query` 被描述为 "Natural language search query"。这个措辞引导 LLM 传入自然语言查询（"关于数据库连接的配置"）而非关键词列表（"database connection config"），因为 `MemoryRetriever` 的语义检索对自然语言查询的效果更好。

`scope` 参数是可选的，这一点至关重要。如果 scope 是必填的，LLM 每次召回记忆时都需要先知道自己的 agent ID 和可用作用域——这对 LLM 来说是不必要的认知负担。当 scope 未指定时，系统自动使用 `scopeManager.getAccessibleScopes` 获取该 agent 的所有可访问作用域。

### 设计取舍

工具设计的核心取舍在于**LLM 友好性 vs 系统精确性**。以 `memory_recall` 为例，描述用"Search and retrieve relevant memories"（认知层面）而非"Query the vector database"（实现层面），因为 LLM 依赖语义理解来决定调用时机。`query` 参数描述为"Natural language search query"引导 LLM 传入自然语言而非关键词列表——后者在语义检索中效果更差。`scope` 设为可选而非必填，避免了 LLM 需要额外获取 agent ID 的认知负担。这些设计牺牲了一些系统的显式控制（例如不强制指定 scope 可能导致搜索范围过宽），换取了 LLM 正确调用工具的更高概率。**管理工具的特性开关**也是一个取舍：默认关闭意味着大多数用户无法使用自我改进能力，但在企业合规环境中 agent 自主修改行为模式可能不被允许——安全优先。

返回值的设计同样值得关注。`score` 字段暴露了相关性分数，这让 LLM 可以判断召回结果的质量。如果所有结果的 score 都很低，LLM 可以推断"记忆库中没有与当前问题相关的信息"，从而避免基于低质量召回结果做出错误推断。

## 16.3 memory_store：创建新记忆

```typescript
// 文件: src/tools.ts L130-220
const memoryStoreTool = {
  name: 'memory_store',
  description: 'Store a new memory for future reference. Use this to save important ' +
    'information, decisions, preferences, or procedures that should be ' +
    'remembered across sessions.',
  parameters: Type.Object({
    text: Type.String({
      description: 'The content to memorize. Be specific and include context.'
    }),
    category: Type.Enum(MemoryCategory, {
      description: 'Category: preference, knowledge, procedure, decision, context, reflection'
    }),
    importance: Type.Optional(Type.Number({
      description: 'Importance from 0 to 1 (default: 0.5). Use higher values for critical info.',
      minimum: 0,
      maximum: 1,
      default: 0.5
    })),
    scope: Type.Optional(Type.String({
      description: 'Storage scope (default: uses configured default scope)'
    }))
  }),
  execute: async (params, context) => {
    // 验证写入权限
    const targetScope = params.scope ?? scopeManager.getDefaultScope(context.agentId)
    if (!scopeManager.validateScopeForWrite(context.agentId, targetScope)) {
      throw new Error(`Agent ${context.agentId} cannot write to scope ${targetScope}`)
    }

    // 如果启用了智能提取，增强元数据
    let metadata: Partial<SmartMemoryMetadata> = {
      l2_content: params.text,
      memory_category: params.category,
      tier: 'working'  // 新记忆默认为 working 层级
    }

    if (smartExtractor) {
      const enhanced = await smartExtractor.enhanceMetadata(params.text, params.category)
      metadata = { ...metadata, ...enhanced }
    }

    const id = await memoryStore.store({
      text: params.text,
      metadata,
      importance: params.importance ?? 0.5,
      scope: targetScope
    })

    return { id, scope: targetScope, status: 'stored' }
  }
}
```

`memory_store` 的参数描述中有一个微妙但重要的引导："Be specific and include context"。这不是给人类看的文档——这是给 LLM 的行为指令。没有这个提示，LLM 可能会存储过于简短的记忆（"用 Postgres"），而有了这个提示，它更可能存储带上下文的完整信息（"项目 X 使用 PostgreSQL 16，部署在 AWS RDS 上，选择原因是团队熟悉度"）。

`importance` 参数的设计也很讲究。它被限制在 0 到 1 之间（通过 TypeBox 的 `minimum` 和 `maximum`），默认值是 0.5。为什么默认 0.5 而非更高？因为如果大多数记忆都被标记为高重要性，重要性字段就失去了区分度。0.5 作为中间值，给了 LLM 向上和向下调整的空间。

新记忆的默认 tier 被设为 `'working'` 而非 `'core'`。这与第十四章讨论的设计一致——新记忆还没有经过时间考验，不应直接进入核心层。只有当记忆被反复访问、经过 `TierManager` 的提升逻辑后，才有可能晋升为 `'core'`。

## 16.4 memory_update 与 memory_forget

```typescript
// 文件: src/tools.ts L230-320
const memoryUpdateTool = {
  name: 'memory_update',
  description: 'Update an existing memory by ID. Use this to correct, expand, or ' +
    'adjust importance of a previously stored memory.',
  parameters: Type.Object({
    id: Type.String({ description: 'The memory ID to update' }),
    text: Type.Optional(Type.String({ description: 'New content (replaces existing)' })),
    importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    scope: Type.Optional(Type.String({ description: 'Move memory to different scope' }))
  }),
  execute: async (params, context) => {
    const existing = await memoryStore.get(params.id)
    if (!existing) {
      throw new Error(`Memory ${params.id} not found`)
    }

    // 验证对源 scope 和目标 scope 的权限
    if (!scopeManager.validateScopeForWrite(context.agentId, existing.scope)) {
      throw new Error(`No write access to scope ${existing.scope}`)
    }
    if (params.scope && !scopeManager.validateScopeForWrite(context.agentId, params.scope)) {
      throw new Error(`No write access to scope ${params.scope}`)
    }

    // 如果内容变更，触发时间版本控制
    if (params.text && existing.metadata.fact_key) {
      existing.metadata.invalidated_at = Date.now()
      existing.metadata.superseded_by = params.id
      await memoryStore.update(existing.id, existing)
      // 创建新版本而非就地修改
      // ...
    }

    await memoryStore.update(params.id, {
      text: params.text ?? existing.text,
      importance: params.importance ?? existing.importance,
      scope: params.scope ?? existing.scope
    })

    return { id: params.id, status: 'updated' }
  }
}
```

`memory_update` 的一个重要细节是对 `fact_key` 的处理。如果被更新的记忆有 `fact_key`（即它是一条事实性记忆），更新操作会触发时间版本控制而非简单的就地覆盖。旧版本被标记为 `invalidated_at`，新版本通过 `supersedes`/`superseded_by` 链接到旧版本。这确保了事实的演进历史不会丢失。

权限检查是双重的：agent 必须同时对源 scope 和目标 scope 有写入权限。这防止了通过 "移动到自己能访问的 scope" 来绕过作用域隔离的攻击。

```typescript
// 文件: src/tools.ts L330-380
const memoryForgetTool = {
  name: 'memory_forget',
  description: 'Delete a memory by ID. Use this to remove outdated, incorrect, or ' +
    'no longer relevant memories. This is permanent.',
  parameters: Type.Object({
    id: Type.String({ description: 'The memory ID to delete' })
  }),
  execute: async (params, context) => {
    const existing = await memoryStore.get(params.id)
    if (!existing) {
      throw new Error(`Memory ${params.id} not found`)
    }

    if (!scopeManager.validateScopeForWrite(context.agentId, existing.scope)) {
      throw new Error(`No write access to scope ${existing.scope}`)
    }

    await memoryStore.delete(params.id)
    return { id: params.id, status: 'deleted' }
  }
}
```

`memory_forget` 的描述中显式提到 "This is permanent"。这是对 LLM 的一个警示——删除是不可逆的。在实际使用中，这会让 LLM 在调用 `memory_forget` 前更加谨慎，倾向于先用 `memory_recall` 确认要删除的记忆内容。

## 16.5 memory_list 与 memory_stats

```typescript
// 文件: src/tools.ts L390-500
const memoryListTool = {
  name: 'memory_list',
  description: 'List memories without search. Use to browse available memories ' +
    'by scope or category. Does not use semantic search.',
  parameters: Type.Object({
    scope: Type.Optional(Type.String()),
    category: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number({ default: 20 }))
  }),
  execute: async (params, context) => {
    const scopes = params.scope
      ? [params.scope]
      : scopeManager.getAccessibleScopes(context.agentId)

    return await memoryStore.list({
      scopes,
      category: params.category,
      limit: params.limit ?? 20
    })
  }
}
```

`memory_list` 的描述中特别强调 "Does not use semantic search"。这是为了帮助 LLM 区分 `memory_list` 和 `memory_recall` 的使用场景。`recall` 是基于语义相似度的搜索——当 agent 有一个明确的信息需求时使用；`list` 是枚举式的浏览——当 agent 想要了解记忆库中有什么时使用。

`memory_stats` 工具提供了记忆库的统计概览：

```typescript
// 文件: src/tools.ts L510-580
const memoryStatsTool = {
  name: 'memory_stats',
  description: 'Get statistics about stored memories. Shows counts by category, ' +
    'scope, and tier. Useful for understanding memory usage.',
  parameters: Type.Object({
    scope: Type.Optional(Type.String())
  }),
  execute: async (params, context) => {
    const scopes = params.scope
      ? [params.scope]
      : scopeManager.getAccessibleScopes(context.agentId)

    return await memoryStore.getStats(scopes)
    // 返回: { total, byCategory, byScope, byTier, avgImportance }
  }
}
```

`memory_stats` 看似简单，但在 agent 的自我管理中扮演重要角色。当 agent 发现某个类别的记忆数量异常增长时，它可以主动清理低重要性的记忆。`avgImportance` 字段帮助 agent 判断记忆质量的整体趋势。

## 16.6 TypeBox Schema 验证

所有工具参数都使用 TypeBox 定义 schema。TypeBox 是一个 JSON Schema 构建库，它的优势在于**类型安全和运行时验证的统一**。

```typescript
// 文件: src/tools.ts L10-25
import { Type } from '@sinclair/typebox'
// TypeBox 生成的 schema 同时用于：
// 1. TypeScript 编译时类型检查
// 2. 运行时参数验证
// 3. LLM 的工具参数 schema（JSON Schema 格式）
```

这种三合一的设计消除了类型定义和验证逻辑的重复。传统方案中，你可能需要分别维护 TypeScript 接口、JSON Schema 和 Zod 验证器——三者之间的不一致是 bug 的常见来源。TypeBox 从一个定义生成三种产物。

## 16.7 管理工具与自我改进

```typescript
// 文件: src/tools.ts L600-800
// 以下工具仅在 enableManagementTools 为 true 时注册
const selfImprovementLogTool = {
  name: 'self_improvement_log',
  description: 'Log a self-improvement observation about your own behavior or performance.',
  // ...
}

const selfImprovementExtractSkillTool = {
  name: 'self_improvement_extract_skill',
  description: 'Extract a reusable skill or pattern from a successful interaction.',
  // ...
}

const selfImprovementReviewTool = {
  name: 'self_improvement_review',
  description: 'Review past self-improvement logs and extract actionable insights.',
  // ...
}
```

管理工具是 memory-lancedb-pro 最前沿的功能。`self_improvement_log` 让 agent 记录对自身行为的观察；`self_improvement_extract_skill` 从成功的交互中提取可复用的技能模式；`self_improvement_review` 回顾过去的改进日志，提炼可操作的洞察。

这三个工具构成了一个完整的自我改进循环：观察 -> 提取 -> 回顾 -> 改进。它们被放在 `enableManagementTools` 开关后面，是因为自我改进能力虽然强大，但并非所有使用场景都需要或允许 agent 自主修改自己的行为模式。在受控环境中（如企业部署），管理员可能希望 agent 的行为完全由显式配置决定。

这些管理工具与前文讨论的 `reflection` 作用域（第十三章）和 `agent_end` 生命周期钩子（第十五章）紧密配合。反思产生的洞察存储在反思作用域中，自我改进工具从中读取并转化为可操作的技能模式。这是一个从被动记忆到主动学习的完整闭环。

## 本章小结

`tools.ts` 的 800 行代码定义了 agent 与记忆系统交互的完整界面。六个核心工具（recall、store、update、forget、list、stats）覆盖了记忆的完整生命周期。工具设计的核心挑战在于双重受众——LLM 需要通过描述和 schema 理解何时以及如何使用工具，系统需要正确执行并处理边界情况。TypeBox 统一了类型定义、运行时验证和 LLM schema 三个维度。管理工具通过特性开关控制暴露，为 agent 的自我改进能力提供了选择性启用的机制。每个工具的参数默认值、描述措辞、权限检查都经过精心设计，不仅仅是为了"能用"，更是为了"被正确地使用"。
