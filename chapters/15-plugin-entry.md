# 第十五章 插件入口与生命周期钩子

> 一个 3500 行的文件通常是代码异味的信号，但 `index.ts` 是个例外。作为 memory-lancedb-pro 的插件入口，它承担着配置解析、子系统编排、生命周期管理和工具注册的多重职责。它不是一个应该被拆分的巨型类，而是一个精心设计的指挥中心——所有子系统在这里被初始化、连接、协调。本章将揭示这个指挥中心的运作机制。

## 15.1 插件入口的职责边界

理解 `index.ts` 的关键是认清它的职责不是"做事"，而是"让事情发生"。它本身不实现向量检索、不处理元数据转换、不执行作用域过滤——这些都委托给了专门的子系统。`index.ts` 的核心职责是：

1. 解析配置，将声明式的 `PluginConfig` 转化为运行时参数
2. 按正确的顺序初始化子系统，处理依赖关系
3. 注册生命周期钩子，在正确的时机触发正确的行为
4. 注册 agent 工具，将子系统的能力暴露给 LLM
5. 启动后台服务，处理健康检查和自动备份

这五个职责之间有严格的执行顺序——配置必须先于初始化，初始化必须先于注册，注册必须先于后台服务启动。这就是为什么这些代码需要集中在一个文件中：分散到多个文件会使执行顺序的保证变得脆弱。

## 15.2 配置解析与环境变量

```typescript
// 文件: index.ts L30-80
interface PluginConfig {
  database: {
    uri: string               // LanceDB 数据库路径
    tableName?: string        // 表名，默认 'memories'
  }
  embedding: {
    provider: string          // 'openai' | 'ollama' | 'custom'
    model?: string
    apiKey?: string           // 支持 ${ENV_VAR} 语法
  }
  scopes?: ScopeConfig
  features?: {
    smartMetadata?: boolean
    decayEngine?: boolean
    tierManager?: boolean
    sessionMemory?: boolean
    memoryReflection?: boolean
    workspaceBoundary?: boolean
    enableManagementTools?: boolean
  }
  backup?: {
    enabled?: boolean
    interval?: number         // 毫秒
    format?: 'jsonl'
  }
}
```

`PluginConfig` 的设计体现了"合理默认值 + 渐进式配置"的哲学。大多数字段是可选的，系统为它们提供了合理的默认值。一个最小配置可能只包含数据库路径和嵌入模型的 API key。

环境变量解析是一个值得关注的细节。`apiKey` 字段支持 `${ENV_VAR}` 语法，这意味着敏感信息不需要硬编码在配置文件中。

```typescript
// 文件: index.ts L90-115
function resolveEnvVars(config: PluginConfig): PluginConfig {
  const resolved = JSON.parse(JSON.stringify(config))
  // 递归遍历所有字符串值，替换 ${...} 模式
  walkObject(resolved, (value: string) => {
    return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
      const envValue = process.env[envVar]
      if (!envValue) {
        throw new Error(`Environment variable ${envVar} is not set`)
      }
      return envValue
    })
  })
  return resolved
}
```

注意错误处理策略：当环境变量未设置时，系统**抛出错误**而非静默使用空值。这是一个正确的选择。如果 API key 缺失，嵌入服务将无法工作，所有后续操作都会失败。在初始化阶段就快速失败（fail fast），远好于在运行时遇到莫名其妙的嵌入错误。

## 15.3 子系统初始化顺序

```typescript
// 文件: index.ts L150-250
async function initializePlugin(config: PluginConfig): Promise<PluginInstance> {
  // 第一层：基础设施
  const db = await LanceDB.connect(config.database.uri)
  const embedder = createEmbedder(config.embedding)

  // 第二层：核心存储
  const memoryStore = new MemoryStore(db, config.database.tableName)
  await memoryStore.ensureTable()

  // 第三层：检索与作用域
  const scopeManager = new ScopeManager(config.scopes)
  const retriever = new MemoryRetriever(memoryStore, embedder, scopeManager)

  // 第四层：可选子系统（依赖前三层）
  const smartExtractor = config.features?.smartMetadata
    ? new SmartExtractor(embedder) : null
  const decayEngine = config.features?.decayEngine
    ? new DecayEngine(memoryStore) : null
  const tierManager = config.features?.tierManager
    ? new TierManager(memoryStore) : null
  const accessTracker = new AccessTracker(memoryStore)
  const sessionMemory = config.features?.sessionMemory
    ? new SessionMemory() : null
  const reflection = config.features?.memoryReflection
    ? new MemoryReflection(memoryStore, retriever, scopeManager) : null
  const boundary = config.features?.workspaceBoundary
    ? new WorkspaceBoundary(config) : null

  // ...
}
```

初始化顺序暴露了子系统之间的依赖关系图。这个依赖图是一个有向无环图（DAG），共分四层：

**第一层：基础设施**。LanceDB 连接和 Embedder 是所有后续组件的基础。它们没有对其他子系统的依赖。

**第二层：核心存储**。`MemoryStore` 封装了对 LanceDB 表的 CRUD 操作。`ensureTable()` 调用确保表存在且 schema 正确——这是一个幂等操作，重复调用不会出错。

**第三层：检索与作用域**。`MemoryRetriever` 依赖 `MemoryStore`（数据源）、`Embedder`（向量化）和 `ScopeManager`（权限过滤）。这三个依赖必须在 retriever 初始化前就绪。

**第四层：可选子系统**。这些子系统通过 `config.features` 中的特性开关控制。每个子系统都依赖前三层的某些组件，但彼此之间没有强依赖。这种设计允许用户按需启用功能，最小化资源消耗。

为什么 `AccessTracker` 没有特性开关？因为访问追踪是记忆层级（tier）和衰减（decay）机制的数据基础。即使用户不启用 `DecayEngine`，记录访问数据也是有价值的——当未来启用衰减时，历史访问数据可以立即被利用，而不需要从零开始积累。这是一个典型的"预投资"设计决策。

## 15.4 四个生命周期钩子

生命周期钩子是 `index.ts` 最核心的编排机制。它们将 memory-lancedb-pro 的行为嵌入到 Claude Code 的执行流程中。

### 15.4.1 before_agent_start：自动召回

```typescript
// 文件: index.ts L400-480
hooks: {
  before_agent_start: async (context) => {
    const agentId = context.agentId
    const scopes = scopeManager.getAccessibleScopes(agentId)

    // 自动召回该 agent 可访问的高重要性记忆
    const coreMemories = await retriever.recall({
      query: context.taskDescription ?? '',
      scopes,
      filter: { tier: 'core' },
      limit: 10
    })

    // 如果启用了会话记忆，加载上次会话的上下文
    if (sessionMemory) {
      const lastSession = await sessionMemory.getLastSession(agentId)
      if (lastSession) {
        coreMemories.push(...lastSession.summaries)
      }
    }

    // 将记忆注入到 agent 的系统提示中
    if (coreMemories.length > 0) {
      context.systemPrompt += formatMemoriesForPrompt(coreMemories)
    }
  }
}
```

`before_agent_start` 是整个记忆系统对 agent 体验影响最大的钩子。它在 agent 开始处理用户请求之前执行，将相关记忆"预加载"到 agent 的上下文中。

关键的设计决策是**只召回 `core` 层级的记忆**。为什么不召回所有相关记忆？因为上下文窗口是宝贵的。如果预加载太多记忆，会挤占 agent 处理当前任务的空间。`core` 层级保证了只有最重要、最常用的记忆被自动注入。agent 仍然可以在需要时通过 `memory_recall` 工具主动查询更多记忆。

`context.taskDescription` 的使用也值得注意。它作为自动召回的查询关键词，使得预加载的记忆与当前任务相关，而不是泛泛地加载所有核心记忆。

### 15.4.2 agent_end：自动捕获

```typescript
// 文件: index.ts L500-580
agent_end: async (context) => {
  const agentId = context.agentId

  // 自动捕获本次会话中的关键信息
  if (smartExtractor) {
    const extracted = await smartExtractor.extract(context.conversation)
    for (const memory of extracted) {
      await memoryStore.store({
        ...memory,
        scope: scopeManager.getDefaultScope(agentId)
      })
    }
  }

  // 如果启用了反思，执行会话反思
  if (reflection) {
    await reflection.reflect(agentId, context.conversation)
  }

  // 保存会话摘要
  if (sessionMemory) {
    await sessionMemory.saveSession(agentId, context.conversation)
  }

  // 更新访问统计
  await accessTracker.flush()
}
```

`agent_end` 在 agent 完成一次会话后触发。它的职责是从刚结束的对话中自动提取有价值的记忆。这是 memory-lancedb-pro 的"被动学习"机制——即使 agent 没有显式调用 `memory_store`，系统也能从对话中捕获知识。

`SmartExtractor` 是这个流程的核心。它分析整段对话，识别出值得记忆的信息片段，并自动分类和打标。这个过程通常涉及 LLM 调用，因此是异步的。

反思（`reflection.reflect`）也在这个钩子中执行。agent 在会话结束后"回顾"自己的表现，生成反思性记忆。这些反思被存储在 `reflection:agent:<id>` 作用域中（见第十三章）。

### 15.4.3 command:new 与 command:reset

```typescript
// 文件: index.ts L600-660
'command:new': async (context) => {
  // 新会话开始
  if (sessionMemory) {
    await sessionMemory.startNewSession(context.agentId)
  }
  // 重置工作记忆中的短期状态
  if (tierManager) {
    await tierManager.clearTransientMemories(context.agentId)
  }
},

'command:reset': async (context) => {
  // 完全重置——清除所有非 core 层级的记忆
  if (tierManager) {
    await tierManager.resetToCore(context.agentId)
  }
  if (sessionMemory) {
    await sessionMemory.clearAll(context.agentId)
  }
  // 重置访问计数器
  await accessTracker.resetCounters(context.agentId)
}
```

`command:new` 对应用户在 Claude Code 中开始新对话（`/new` 命令）。它创建一个新的会话上下文，并清除上一个会话的瞬态记忆。注意它不会清除持久化的记忆——那些仍然存在于 LanceDB 中。

`command:reset` 是更激进的操作。它将记忆系统回退到只剩 `core` 层级的状态，相当于"忘掉所有非核心知识"。这在 agent 需要"重新开始"时很有用，比如切换到一个完全不同的项目。

## 15.5 工具注册

```typescript
// 文件: index.ts L700-900
const tools = [
  createRecallTool(retriever, scopeManager),
  createStoreTool(memoryStore, scopeManager, smartExtractor),
  createUpdateTool(memoryStore, scopeManager),
  createForgetTool(memoryStore, scopeManager),
  createListTool(memoryStore, scopeManager),
  createStatsTool(memoryStore, scopeManager)
]

if (config.features?.enableManagementTools) {
  tools.push(
    createSelfImprovementLogTool(memoryStore, reflection),
    createSelfImprovementExtractSkillTool(memoryStore, smartExtractor),
    createSelfImprovementReviewTool(memoryStore, retriever)
  )
}
```

工具注册是 `index.ts` 将子系统能力暴露给 LLM 的桥梁。每个 `createXxxTool` 函数（定义在 `tools.ts` 中，见第十六章）返回一个符合 Claude Code 工具规范的对象，包含名称、描述、参数 schema 和执行函数。

管理工具（Management Tools）被放在一个特性开关后面。这是因为 `self_improvement_*` 系列工具赋予了 agent 自我修改记忆策略的能力——这在某些场景下可能不受欢迎（例如在企业合规环境中，agent 的行为需要是确定性的）。通过特性开关，管理员可以精确控制 agent 的自主性边界。

## 15.6 后台服务

```typescript
// 文件: index.ts L1000-1100
// 后台服务：健康检查 + 自动备份
function startBackgroundServices(config: PluginConfig, memoryStore: MemoryStore) {
  // 健康检查：定期验证 LanceDB 连接
  setInterval(async () => {
    try {
      await memoryStore.healthCheck()
    } catch (err) {
      console.error('[memory-lancedb-pro] Health check failed:', err)
      // 尝试重连
      await memoryStore.reconnect()
    }
  }, 60_000)  // 每 60 秒

  // 自动备份
  if (config.backup?.enabled) {
    const interval = config.backup.interval ?? 3600_000  // 默认每小时
    setInterval(async () => {
      await memoryStore.exportToJsonl(getBackupPath(config))
    }, interval)
  }

  // 升级提示检查
  checkForUpgrades().then(info => {
    if (info.updateAvailable) {
      console.log(`[memory-lancedb-pro] Update available: ${info.latestVersion}`)
    }
  })
}
```

后台服务在插件初始化的最后阶段启动。健康检查每 60 秒执行一次，确保 LanceDB 连接存活。如果检查失败，系统会尝试重连而非直接崩溃——这对长时间运行的 Claude Code 会话至关重要。

自动备份将记忆导出为 JSONL 格式。为什么选择 JSONL 而非 JSON？因为 JSONL（每行一个 JSON 对象）支持追加写入和流式处理。在记忆量很大的情况下，一次性将所有记忆序列化为一个 JSON 数组可能导致内存尖峰，而 JSONL 可以逐条写入。

升级提示检查是一个一次性操作（使用 `.then()` 而非 `setInterval`），在插件启动时检查是否有新版本可用。它只打印提示信息，不会自动升级——自动升级一个正在运行的插件风险太大。

## 15.7 3500 行的合理性

为什么不把 `index.ts` 拆分成多个文件？答案在于**初始化顺序的确定性**。当所有初始化逻辑在一个文件中时，执行顺序由代码的物理位置决定，一目了然。如果分散到多个文件，就需要引入显式的依赖声明和初始化框架（如依赖注入容器），这在复杂度上并不比一个大文件更好。

此外，`index.ts` 虽然行数多，但结构清晰：配置解析、子系统初始化、生命周期钩子、工具注册、后台服务——五个区块各司其职。行数多不等于复杂度高。一个 3500 行的线性流程，比一个分散在 10 个文件中需要追踪初始化顺序的系统更容易理解。

## 本章小结

`index.ts` 是 memory-lancedb-pro 的神经中枢。它通过环境变量解析确保敏感信息不被硬编码；通过四层依赖顺序确保子系统正确初始化；通过四个生命周期钩子（`before_agent_start` 自动召回、`agent_end` 自动捕获、`command:new` 会话切换、`command:reset` 完全重置）将记忆行为无缝嵌入 Claude Code 的执行流程；通过特性开关控制管理工具的暴露范围；通过后台服务保障系统的长期稳定运行。3500 行的体量是编排复杂度的真实反映，而非设计缺陷。理解了这个指挥中心，就理解了 memory-lancedb-pro 的"呼吸节律"。
