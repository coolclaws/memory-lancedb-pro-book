# 第十三章 多作用域隔离与权限

> 当一个系统同时服务于多个 agent、多个用户、多个项目时，"谁能看到什么"就不再是一个可以推迟回答的问题。作用域（Scope）机制是 memory-lancedb-pro 在多租户场景下保持记忆隔离与安全访问的核心防线。本章将深入剖析 `scopes.ts` 的设计哲学，揭示六种作用域模式背后的工程权衡。

## 13.1 为什么需要多作用域

在最简单的场景中，一个 agent 对应一份记忆，不存在隔离问题。但现实远比这复杂。考虑以下几种典型场景：

第一，多 agent 协作。一个开发团队可能同时运行代码审查 agent、文档生成 agent 和测试 agent。代码审查 agent 总结出的代码风格偏好不应该污染文档生成 agent 的写作风格记忆。每个 agent 需要独立的记忆空间。

第二，多用户共享。当多个开发者共享同一个 Claude Code 项目配置时，用户 A 的个人偏好（比如偏好 Vim 风格的快捷键说明）不应出现在用户 B 的记忆召回中。

第三，跨项目隔离。一个咨询师可能同时参与多个客户项目，项目 A 的技术栈选型决策不应泄露到项目 B 的上下文中。

第四，反思与自省。agent 对自身行为的反思记录（"上次我在处理 TypeScript 类型推断时犯了错误"）应该只对该 agent 自己可见，而不是暴露给所有 agent。

这四种需求催生了 memory-lancedb-pro 的六种内置作用域模式。关键的设计目标是：**默认安全**——在没有显式配置的情况下，记忆应该被隔离而非共享。

### 核心流程

```
作用域访问控制流程:

写入时:
+--------+    +------------+    +---------+    +--------+
| Agent   +--->+ validate   +--->+ scope   +--->+ 写入    |
| 写入请求 |    | ScopeFor   |    | 标签注入 |    | LanceDB|
+--------+    | Write()    |    | 到记录   |    +--------+
              +-----+------+    +---------+
                    |
               [无权限] → 拒绝操作

读取时:
+--------+    +-------------+    +-----------+    +--------+
| Agent   +--->+ getAccessible+--->+ scope     +--->+ 检索   |
| 查询请求 |    | Scopes()    |    | 过滤注入   |    | 结果   |
+--------+    +------+------+    | 到 LanceDB |    +--------+
                     |           | 查询条件    |
                     v           +-----------+
              agentId = system? → 返回全部 scopes
              有显式 ACL?      → 返回 ACL 列表
              默认             → [global, agent:<id>,
                                  reflection:agent:<id>]
```

## 13.2 六种内置作用域模式

```typescript
// 文件: src/scopes.ts L15-45
// 六种内置作用域模式及其标识符格式
type BuiltInScope =
  | 'global'                    // 全局共享
  | `agent:${string}`           // 单 agent 隔离
  | `user:${string}`            // 单用户隔离
  | `project:${string}`         // 单项目隔离
  | `custom:${string}`          // 自定义命名空间
  | `reflection:agent:${string}` // agent 反思隔离
```

这六种模式的设计并非拍脑袋决定的，每一种都对应着真实的使用场景。

**`global`** 是最宽泛的作用域。存储在 `global` 下的记忆对所有 agent 和用户可见。适用于团队级别的共识性知识，比如"本项目使用 pnpm 而非 npm"这类所有参与者都需要知道的信息。

**`agent:<id>`** 为每个 agent 创建独立的记忆空间。agent ID 通常由 Claude Code 框架自动分配。这解决了多 agent 协作时的记忆污染问题。一个专注于安全审计的 agent 积累的漏洞模式库不会干扰一个 UI 设计 agent 的组件偏好记忆。

**`user:<id>`** 实现用户级隔离。在共享工作站或团队 Claude Code 实例中，每个用户的个人偏好、工作习惯都被隔离存储。

**`project:<id>`** 按项目划分记忆。这在咨询或外包场景中尤为重要——不同客户项目之间必须严格隔离。

**`custom:<name>`** 提供了一个逃生舱。当内置的四种模式无法满足需求时，开发者可以自定义任意命名空间。例如 `custom:frontend-team` 可以为前端小组创建专属记忆空间。

**`reflection:agent:<id>`** 是最有趣的一种。它为 agent 的自我反思创建了一个私密空间。为什么不直接用 `agent:<id>`？因为反思记忆的性质与普通工作记忆不同。反思记忆记录的是 agent 对自身行为的元认知（"我倾向于在错误处理中遗漏 edge case"），这类信息在普通的记忆召回中出现反而会造成干扰。将反思隔离到专用作用域，让 agent 可以在需要自省时主动查询，而不是在每次普通召回中被这些元认知信息淹没。

### 设计取舍

六种作用域模式的设计否定了两个替代方案。**极简方案**（只有 global 和 agent 两种）无法满足多用户、多项目的隔离需求。**RBAC 方案**（基于角色的完整访问控制）功能强大但复杂度过高——需要定义角色、权限矩阵、继承关系，对于一个记忆插件来说是过度工程。六种命名模式 + 显式 ACL 覆盖的设计，用最小的概念复杂度覆盖了 95% 的真实场景。`custom:<name>` 作为逃生舱处理剩余 5%。**默认访问三域**（global + agent + reflection）的选择也是一个取舍：更安全的默认值是只给 `agent:<id>`（不包含 global），但这会导致团队级共识知识无法被共享，大幅降低单 agent 场景的开箱体验。团队选择了"可用性优先、安全可配置"的策略。

## 13.3 ScopeConfig 的设计

```typescript
// 文件: src/scopes.ts L55-80
interface ScopeConfig {
  default: string                           // 默认作用域
  definitions: Record<string, {
    description: string                     // 人类可读描述
  }>
  agentAccess: Record<string, string[]>     // 显式 ACL
}
```

`ScopeConfig` 的设计体现了三个层次的配置能力。

**`default`** 字段决定了当 agent 存储记忆时不指定 scope 的默认行为。默认值是 `'global'`，这看起来似乎与"默认安全"的原则矛盾。但实际上，这是一个务实的权衡。大多数单 agent 场景中，用户不关心作用域，所有记忆放在 `global` 是最直觉的行为。在多 agent 场景中，管理员应该显式配置 `default` 为 `agent:${agentId}`。

**`definitions`** 是一个声明式的作用域注册表。它的 `description` 字段不仅用于文档化，还被传递给 agent 的工具描述，帮助 LLM 理解每个作用域的用途，从而在存储记忆时做出更好的分类决策。这是一个被低估的设计细节——通过在 schema 层面提供语义信息，减少了 agent 误分类的概率。

**`agentAccess`** 是显式的访问控制列表（ACL），它是整个作用域系统的权限覆盖层。当这个字段被设置时，它完全取代默认的访问规则。

## 13.4 默认安全的访问控制

```typescript
// 文件: src/scopes.ts L100-140
function getAccessibleScopes(agentId: string, config: ScopeConfig): string[] {
  // 系统级 ID 拥有全局访问权限
  if (agentId === 'system' || agentId === undefined) {
    return getAllDefinedScopes(config)
  }

  // 检查显式 ACL
  if (config.agentAccess && config.agentAccess[agentId]) {
    return config.agentAccess[agentId]
  }

  // 默认行为：global + 自身 agent scope + 自身 reflection scope
  return [
    'global',
    `agent:${agentId}`,
    `reflection:agent:${agentId}`
  ]
}
```

这段代码揭示了作用域系统最核心的访问控制逻辑，其中蕴含着几个重要的设计决策。

**系统绕过（System Bypass）**。当 `agentId` 为 `'system'` 或 `undefined` 时，返回所有已定义的作用域。为什么需要这个？因为 CLI 工具、管理命令、数据导出等操作需要跨作用域访问。`undefined` 被包含在内是为了处理早期版本中 agent ID 未被传递的兼容情况。这是一个防御性编程的典型案例——与其在每个调用点检查 `agentId` 是否存在，不如在权限层面统一处理。

**显式 ACL 覆盖**。如果 `agentAccess` 中为某个 agent 配置了显式列表，那么默认规则被完全跳过。注意这里没有"合并"逻辑——显式配置是一个完整的替代，而非增量。这是有意为之的。合并逻辑（默认 + 显式）会引入微妙的权限膨胀风险。当管理员为 agent 配置了 `['global', 'project:client-a']` 时，他的意图是"只能访问这两个"，而不是"在默认基础上额外加这两个"。

**默认三域访问**。没有显式配置的 agent 默认可以访问三个作用域：`global`（共享知识）、自身的 `agent:<id>`（私有工作记忆）、自身的 `reflection:agent:<id>`（反思记忆）。这个默认值在安全性和可用性之间取得了良好的平衡。

## 13.5 作用域在记忆操作中的执行

作用域不仅仅是一个标签——它在记忆的每一次读写操作中都被强制执行。

在写入时（`memory_store`），scope 被作为元数据字段持久化到 LanceDB 记录中。如果 agent 尝试写入一个自己无权访问的 scope，操作会被拒绝。

```typescript
// 文件: src/scopes.ts L180-210
function validateScopeForWrite(agentId: string, targetScope: string, config: ScopeConfig): boolean {
  const accessible = getAccessibleScopes(agentId, config)
  return accessible.includes(targetScope)
}
```

在读取时（`memory_recall`），查询会被自动限定在 agent 可访问的作用域范围内。这不是通过应用层过滤实现的，而是通过在 LanceDB 查询中注入 scope 过滤条件实现的。这意味着即使向量相似度检索返回了其他作用域的高相关性结果，它们也会被数据库层面过滤掉，永远不会到达 agent。

这种"查询时注入"的方式比"结果后过滤"更安全，也更高效。安全性在于，即使应用层代码有 bug，数据库查询本身就不会返回越权数据。高效性在于，LanceDB 可以利用 scope 字段的索引来缩小搜索范围，减少不必要的向量距离计算。

## 13.6 反思作用域的深层设计

`reflection:agent:<id>` 值得单独讨论。反思记忆是 memory-lancedb-pro 自我改进子系统（Self-Improvement）的基石。当 agent 在 `agent_end` 生命周期钩子中分析自己本次会话的表现时，产生的反思性洞察被存储在反思作用域中。

为什么不简单地用一个 `category` 字段来区分反思记忆和普通记忆？因为 category 是一个软分类——它影响检索的排序权重，但不影响可见性。而反思记忆需要的是硬隔离。一个 agent 在常规工作中不应该被自己的反思记忆干扰（"我之前犯了错误"这类信息在正常工作流中是噪音），但在需要自省时又能主动访问。

作用域提供了这种"按需可见"的能力。`memory_recall` 默认搜索 `global` 和 `agent:<id>`，只有当 agent 显式指定 `scope: 'reflection:agent:<id>'` 时才会查询反思记忆。这让反思成为一个主动行为，而非被动干扰。

```typescript
// 文件: src/scopes.ts L250-280
// 反思作用域的命名约定确保了与 agent 作用域的对应关系
function getReflectionScope(agentId: string): string {
  return `reflection:agent:${agentId}`
}
```

这个简单的命名约定（`reflection:agent:` 前缀 + agent ID）建立了反思作用域与 agent 作用域之间的一对一映射关系，无需额外的映射表或配置。

## 13.7 自定义作用域的扩展性

`custom:<name>` 模式的存在表明设计者对未来需求保持了开放态度。通过 `ScopeConfig.definitions` 注册自定义作用域，并通过 `agentAccess` 分配访问权限，管理员可以构建任意复杂的权限拓扑。

例如，一个大型团队可能需要这样的配置：前端 agent 和后端 agent 共享一个 `custom:api-contracts` 作用域来存储 API 契约知识，但各自的实现细节隔离在各自的 `agent:<id>` 中。这种"选择性共享"的需求无法用前五种内置模式表达，但通过 `custom` + 显式 ACL 可以轻松实现。

## 本章小结

`scopes.ts` 用大约 300 行代码构建了一套完整的多租户记忆隔离方案。六种内置作用域模式覆盖了从单 agent 到多 agent、多用户、多项目的各种场景。`ScopeConfig` 的三层设计（默认值、定义、ACL）在简洁与灵活之间取得了平衡。默认安全的访问控制确保了在零配置情况下记忆不会越权泄露，而系统绕过 ID 和显式 ACL 则为管理场景和高级需求提供了必要的灵活性。反思作用域的独立设计更是体现了对 AI agent 自我改进场景的深思熟虑。理解了作用域机制，才能理解后续章节中记忆如何在正确的边界内流动。
