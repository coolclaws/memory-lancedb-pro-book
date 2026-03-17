# 第十七章 CLI 与数据迁移

> 再强大的记忆系统，如果只能通过 agent 工具操作，就像一个只能通过语音控制的电脑——日常使用没问题，但批量管理和数据迁移时就捉襟见肘了。`cli.ts` 提供了 10 余个命令行子命令，让开发者可以直接与记忆库交互。而 `migrate.ts` 和 `memory-upgrader.ts` 则解决了系统演进中最棘手的问题：如何将旧数据无损地迁移到新架构。

## 17.1 CLI 的设计定位

CLI 工具（命令行前缀 `openclaw memory-pro`）面向的是开发者和管理员，而非 LLM。这意味着它的设计优先级与 agent 工具截然不同。agent 工具追求"让 LLM 正确调用"，CLI 追求"让人类高效操作"。

具体来说，CLI 需要支持：批量操作（agent 工具一次处理一条记忆，CLI 需要处理成百上千条）、数据导入导出（agent 无需关心持久化格式，但管理员需要备份和恢复）、系统诊断（agent 只需要 `memory_stats`，管理员需要更详细的健康状态信息）。

```typescript
// 文件: cli.ts L20-60
// CLI 命令注册结构
program
  .name('openclaw memory-pro')
  .description('Memory management CLI for memory-lancedb-pro')
  .version(packageVersion)

// CRUD 命令
program.command('list')
program.command('search')
program.command('delete')
program.command('delete-bulk')
program.command('forget')   // delete 的别名
program.command('update')

// 数据管理
program.command('export')
program.command('import')
program.command('stats')

// 系统维护
program.command('reembed')
program.command('upgrade')
program.command('migrate')

// 认证
program.command('auth')
program.command('version')
```

## 17.2 CRUD 命令的工程细节

### list 与 search

```typescript
// 文件: cli.ts L80-160
program
  .command('list')
  .option('--scope <scope>', 'Filter by scope')
  .option('--category <category>', 'Filter by category')
  .option('--limit <n>', 'Maximum results', '50')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const store = await initMemoryStore()
    const memories = await store.list({
      scopes: options.scope ? [options.scope] : undefined,
      category: options.category,
      limit: parseInt(options.limit)
    })

    if (options.json) {
      console.log(JSON.stringify(memories, null, 2))
    } else {
      // 表格格式输出，人类友好
      printMemoryTable(memories)
    }
  })
```

`list` 和 `search` 的一个关键区别：`list` 的默认 limit 是 50（比 agent 工具的默认 20 更大），因为 CLI 用户通常需要浏览更多结果。`--json` 标志在所有输出命令中都存在，这使得 CLI 的输出可以被其他脚本处理（piped to `jq`、`grep` 等）。

### delete-bulk：批量删除的安全设计

```typescript
// 文件: cli.ts L200-280
program
  .command('delete-bulk')
  .requiredOption('--scope <scope>', 'Target scope')
  .option('--before <date>', 'Delete memories created before this date')
  .option('--dry-run', 'Show what would be deleted without actually deleting')
  .action(async (options) => {
    const store = await initMemoryStore()

    const candidates = await store.list({
      scopes: [options.scope],
      before: options.before ? new Date(options.before).getTime() : undefined
    })

    if (options.dryRun) {
      console.log(`Would delete ${candidates.length} memories:`)
      printMemoryTable(candidates)
      return
    }

    // 二次确认
    const confirmed = await promptConfirmation(
      `Delete ${candidates.length} memories from scope "${options.scope}"?`
    )
    if (!confirmed) {
      console.log('Cancelled.')
      return
    }

    let deleted = 0
    for (const memory of candidates) {
      await store.delete(memory.id)
      deleted++
    }
    console.log(`Deleted ${deleted} memories.`)
  })
```

`delete-bulk` 的安全设计值得特别关注。首先，`--scope` 是 `requiredOption`——不允许在不指定作用域的情况下执行批量删除，防止意外删除全局数据。其次，`--dry-run` 标志让用户在实际删除前预览受影响的记忆。最后，即使没有 `--dry-run`，系统仍然会要求二次确认。

这种三重保护（必填 scope + dry-run 预览 + 二次确认）在数据库管理工具中是最佳实践。对于一个存储了 agent 知识库的系统，误删的代价可能比误删普通数据更高——那些被 agent 通过多次交互积累的知识，无法简单地从其他数据源重建。

### forget 别名

```typescript
// 文件: cli.ts L290-310
program
  .command('forget <id>')
  .description('Delete a memory by ID (alias for delete)')
  .action(async (id) => {
    // 内部调用与 delete 相同的逻辑
    await deleteMemory(id)
  })
```

`forget` 作为 `delete` 的别名存在，原因在于语义一致性。在 agent 工具中，删除记忆的工具叫 `memory_forget`（遗忘比删除更符合记忆的隐喻）。CLI 提供 `forget` 别名，使得习惯了 agent 工具命名的用户可以无缝切换到 CLI。

## 17.3 export 和 import：数据生命周期管理

```typescript
// 文件: cli.ts L350-450
program
  .command('export')
  .option('--scope <scope>', 'Export specific scope only')
  .option('--output <file>', 'Output file path', 'memories-export.json')
  .action(async (options) => {
    const store = await initMemoryStore()
    const memories = await store.list({
      scopes: options.scope ? [options.scope] : undefined,
      limit: Infinity  // 导出所有
    })

    // 导出包含完整元数据但不包含向量嵌入
    const exportData = memories.map(m => ({
      id: m.id,
      text: m.text,
      metadata: m.metadata,
      importance: m.importance,
      scope: m.scope,
      created_at: m.created_at
    }))

    fs.writeFileSync(options.output, JSON.stringify(exportData, null, 2))
    console.log(`Exported ${exportData.length} memories to ${options.output}`)
  })

program
  .command('import <file>')
  .option('--scope <scope>', 'Override scope for all imported memories')
  .option('--dry-run', 'Validate without importing')
  .action(async (file, options) => {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))

    if (options.dryRun) {
      console.log(`Would import ${data.length} memories`)
      // 验证数据格式
      const errors = validateImportData(data)
      if (errors.length > 0) {
        console.error('Validation errors:', errors)
      }
      return
    }

    const store = await initMemoryStore()
    let imported = 0
    for (const item of data) {
      await store.store({
        text: item.text,
        metadata: item.metadata,
        importance: item.importance,
        scope: options.scope ?? item.scope
        // 向量嵌入在导入时重新生成
      })
      imported++
    }
    console.log(`Imported ${imported} memories.`)
  })
```

导出时**不包含向量嵌入**，导入时**重新生成嵌入**。这个设计决策乍看起来低效——为什么不直接复制嵌入向量？原因有三：

第一，嵌入向量与模型强绑定。如果导出时使用 `text-embedding-ada-002` 生成的向量被导入到一个使用 `text-embedding-3-small` 的环境中，向量空间不兼容，检索结果将毫无意义。

第二，导出文件的体积。每个嵌入向量通常有 1536 维（以 OpenAI 模型为例），以 float32 存储需要约 6KB。1000 条记忆的向量数据约 6MB，而文本数据可能只有几百 KB。不包含向量可以大幅减小导出文件体积。

第三，可读性。不含向量的 JSON 文件可以被人类阅读和编辑，这在调试和数据修复场景中非常有用。

`--scope` 覆盖选项让管理员可以在导入时将所有记忆统一归入某个作用域。这在将一个 agent 的记忆迁移到另一个 agent 时特别有用。

## 17.4 reembed：嵌入模型迁移

```typescript
// 文件: cli.ts L500-580
program
  .command('reembed')
  .requiredOption('--source-db <path>', 'Source database path')
  .option('--batch-size <n>', 'Batch size for re-embedding', '50')
  .option('--skip-existing', 'Skip memories that already have embeddings')
  .action(async (options) => {
    const sourceDb = await LanceDB.connect(options.sourceDb)
    const embedder = createEmbedder(config.embedding)
    const batchSize = parseInt(options.batchSize)

    const memories = await sourceDb.list({ limit: Infinity })
    console.log(`Found ${memories.length} memories to re-embed`)

    let processed = 0
    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize)

      if (options.skipExisting) {
        // 过滤已有嵌入的记忆
      }

      const texts = batch.map(m => m.metadata?.l1_overview ?? m.text)
      const embeddings = await embedder.embedBatch(texts)

      for (let j = 0; j < batch.length; j++) {
        await sourceDb.updateEmbedding(batch[j].id, embeddings[j])
      }

      processed += batch.length
      console.log(`Progress: ${processed}/${memories.length}`)
    }
  })
```

`reembed` 命令解决的是嵌入模型迁移问题。当团队决定从 OpenAI 的嵌入模型切换到 Ollama 本地模型时，所有现有记忆的向量需要用新模型重新生成。

批量处理（`--batch-size`）是必须的，因为嵌入 API 通常有速率限制。太大的 batch 可能触发限流，太小的 batch 则效率低下。默认的 50 条是一个经验值，适用于大多数 API 提供商的限速策略。

注意嵌入使用的文本是 `l1_overview`（而非 `l2_content`）。回顾第十四章的讨论——L1 概要比 L2 完整内容更紧凑、语义更集中，生成的嵌入向量检索效果更好。这里体现了 smart metadata 三层模型的实际收益。

## 17.5 三阶段迁移：从内置插件到 Pro

```typescript
// 文件: src/migrate.ts L30-100
// 三阶段迁移流程
program
  .command('migrate')
  .argument('<phase>', 'Migration phase: check | run | verify')
  .option('--source <path>', 'Source database path (built-in memory-lancedb)')
  .action(async (phase, options) => {
    switch (phase) {
      case 'check':
        await migrateCheck(options.source)
        break
      case 'run':
        await migrateRun(options.source)
        break
      case 'verify':
        await migrateVerify(options.source)
        break
    }
  })
```

从内置的 `memory-lancedb` 迁移到 `memory-lancedb-pro` 是一个高风险操作——用户积累的记忆数据不能丢失。三阶段设计将风险分散到三个独立步骤中，每个步骤都可以安全中断和重试。

### Phase 1: check（兼容性检查）

```typescript
// 文件: src/migrate.ts L110-170
async function migrateCheck(sourcePath: string) {
  const sourceDb = await LanceDB.connect(sourcePath)
  const schema = await sourceDb.getSchema()

  // 检查源数据库 schema 兼容性
  const issues: string[] = []

  if (!schema.hasField('text')) {
    issues.push('Missing required field: text')
  }
  if (!schema.hasField('vector')) {
    issues.push('Missing required field: vector')
  }

  // 检查向量维度兼容性
  const sampleVector = await sourceDb.getSampleVector()
  if (sampleVector.length !== config.embedding.dimensions) {
    issues.push(
      `Vector dimension mismatch: source=${sampleVector.length}, ` +
      `target=${config.embedding.dimensions}. Re-embedding will be required.`
    )
  }

  const totalMemories = await sourceDb.count()
  console.log(`Source database: ${totalMemories} memories`)
  console.log(`Issues found: ${issues.length}`)
  issues.forEach(i => console.log(`  - ${i}`))

  if (issues.length === 0) {
    console.log('Migration is compatible. Run "migrate run" to proceed.')
  }
}
```

`check` 阶段不修改任何数据。它读取源数据库的 schema，检查字段兼容性和向量维度匹配。如果向量维度不同（例如从 OpenAI 的 1536 维切换到另一个模型的 768 维），会提示需要重新嵌入——这意味着迁移时间会显著增加。

### Phase 2: run（数据传输）

```typescript
// 文件: src/migrate.ts L180-260
async function migrateRun(sourcePath: string) {
  const sourceDb = await LanceDB.connect(sourcePath)
  const targetStore = await initMemoryStore()

  const memories = await sourceDb.listAll()
  let migrated = 0, errors = 0

  for (const memory of memories) {
    try {
      // Schema 转换：内置格式 -> Pro 格式
      const proMemory = {
        text: memory.text,
        metadata: normalizeMetadata({
          l2_content: memory.text,
          memory_category: mapLegacyCategory(memory.category),
          // 内置插件没有 L0/L1，由 normalizeMetadata 自动填充
        }),
        importance: memory.importance ?? 0.5,
        scope: 'global'  // 内置插件没有作用域概念，默认全局
      }

      // 如果向量兼容，直接复制；否则重新嵌入
      if (vectorsCompatible) {
        await targetStore.storeWithVector(proMemory, memory.vector)
      } else {
        await targetStore.store(proMemory)  // 触发重新嵌入
      }

      migrated++
    } catch (err) {
      console.error(`Failed to migrate memory ${memory.id}:`, err)
      errors++
    }
  }

  console.log(`Migrated: ${migrated}, Errors: ${errors}`)
}
```

`run` 阶段的核心是 schema 转换。内置的 `memory-lancedb` 使用扁平的数据结构，而 `memory-lancedb-pro` 使用 `SmartMemoryMetadata`。`normalizeMetadata` 函数（第十四章详述）负责填充缺失字段的默认值。

注意，内置插件没有作用域概念，所有迁移的记忆默认归入 `'global'`。这是唯一安全的选择——在不知道原始记忆的组织结构时，将它们放在最宽泛的作用域确保不会有记忆在迁移后变得不可访问。管理员可以在迁移后使用 `update --scope` 手动重新分类。

错误处理采用"跳过并继续"策略，而非"遇错即停"。在迁移数百条记忆时，单条失败不应阻止整个迁移过程。所有错误被记录，用户可以在迁移后针对性修复。

### Phase 3: verify（完整性校验）

```typescript
// 文件: src/migrate.ts L270-320
async function migrateVerify(sourcePath: string) {
  const sourceDb = await LanceDB.connect(sourcePath)
  const targetStore = await initMemoryStore()

  const sourceCount = await sourceDb.count()
  const targetCount = await targetStore.count()

  console.log(`Source: ${sourceCount}, Target: ${targetCount}`)

  if (targetCount < sourceCount) {
    console.warn(`Warning: ${sourceCount - targetCount} memories may not have migrated`)
  }

  // 抽样验证内容完整性
  const samples = await sourceDb.sample(10)
  for (const sample of samples) {
    const target = await targetStore.findByText(sample.text)
    if (!target) {
      console.warn(`Content mismatch: "${sample.text.substring(0, 50)}..." not found in target`)
    }
  }

  console.log('Verification complete.')
}
```

`verify` 阶段通过计数比较和抽样验证两个手段确认迁移的完整性。抽样验证随机选取 10 条记忆，检查它们的内容是否存在于目标数据库中。这不是百分百的验证，但在实际操作中，如果随机 10 条都能找到，迁移出错的概率极低。

## 17.6 Memory Upgrader：智能元数据批量升级

```typescript
// 文件: src/memory-upgrader.ts L30-120
class MemoryUpgrader {
  async upgrade(options: {
    dryRun?: boolean
    batchSize?: number
    noLlm?: boolean
    limit?: number
  }) {
    const memories = await this.store.list({
      limit: options.limit ?? Infinity
    })

    // 过滤出需要升级的记忆（缺少 smart metadata 字段）
    const needsUpgrade = memories.filter(m =>
      !m.metadata?.l0_abstract ||
      !m.metadata?.l1_overview ||
      !m.metadata?.memory_category
    )

    console.log(`${needsUpgrade.length}/${memories.length} memories need upgrade`)

    if (options.dryRun) return

    for (let i = 0; i < needsUpgrade.length; i += (options.batchSize ?? 20)) {
      const batch = needsUpgrade.slice(i, i + (options.batchSize ?? 20))

      for (const memory of batch) {
        let enhanced: Partial<SmartMemoryMetadata>

        if (options.noLlm) {
          // 仅元数据升级：从现有文本生成 L0/L1
          enhanced = {
            l0_abstract: memory.text.substring(0, 100),
            l1_overview: memory.text.substring(0, 300),
            l2_content: memory.text,
            memory_category: mapLegacyCategory(memory.category) ?? 'knowledge',
            tier: 'working',
            confidence: 0.5  // 低于默认值，因为是自动推断
          }
        } else {
          // LLM 增强升级：使用 LLM 生成高质量摘要和分类
          enhanced = await this.llmEnhance(memory.text)
        }

        await this.store.updateMetadata(memory.id, enhanced)
      }

      // 进度追踪（支持中断后续恢复）
      await this.saveProgress(i + batch.length)
      console.log(`Upgraded ${Math.min(i + batch.length, needsUpgrade.length)}/${needsUpgrade.length}`)
    }
  }
}
```

`memory-upgrader.ts` 解决的是系统内部的演进问题。当 `SmartMemoryMetadata` 增加了新字段时，旧记忆需要被升级以填充这些字段。

**`--no-llm` 模式的存在**揭示了一个务实的权衡。LLM 增强升级可以生成高质量的 L0 摘要和精确的分类，但代价是 API 调用费用和时间。对于有数千条记忆的用户，LLM 升级可能需要数小时和显著的 API 费用。`--no-llm` 模式通过简单的文本截断生成 L0/L1，虽然质量较低（`confidence` 设为 0.5 而非默认的 0.7），但速度快且零成本。

**进度追踪与断点续传**。`saveProgress` 将当前升级进度持久化。如果升级过程因网络中断或用户取消而停止，下次运行时可以从上次中断处继续，避免重复处理。在处理大量记忆时，这种可恢复性是必不可少的。

## 17.7 auth 命令：OAuth 认证

```typescript
// 文件: cli.ts L900-1000
program
  .command('auth')
  .argument('<action>', 'login | status | logout')
  .action(async (action) => {
    switch (action) {
      case 'login':
        // 启动 OAuth 流程
        await startOAuthFlow()
        break
      case 'status':
        const token = await getStoredToken()
        console.log(token ? `Logged in as ${token.email}` : 'Not logged in')
        break
      case 'logout':
        await clearStoredToken()
        console.log('Logged out.')
        break
    }
  })
```

`auth` 命令为需要云端服务（如托管嵌入 API 或云端备份）的场景提供 OAuth 认证。三个子命令覆盖了认证的完整生命周期。`login` 启动浏览器 OAuth 流程，`status` 显示当前认证状态，`logout` 清除本地存储的 token。

## 本章小结

CLI 和迁移工具是 memory-lancedb-pro 面向人类操作者的界面。`cli.ts` 的 10 余个子命令覆盖了 CRUD 操作、数据导入导出、嵌入模型迁移和系统认证。`delete-bulk` 的三重安全保护（必填 scope + dry-run + 二次确认）体现了对数据安全的重视。`export`/`import` 选择不包含向量嵌入，确保了跨模型的可移植性。`migrate.ts` 的三阶段设计（check/run/verify）将高风险的数据迁移分解为可控的步骤。`memory-upgrader.ts` 的 `--no-llm` 模式在质量和成本之间提供了灵活选择，而进度追踪机制保证了大规模升级的可恢复性。这些工具共同确保了 memory-lancedb-pro 不仅是一个功能强大的运行时系统，也是一个可管理、可维护、可演进的工程产品。
