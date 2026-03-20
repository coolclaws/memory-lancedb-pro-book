# 第三章：LanceDB 存储引擎

> 存储是记忆系统的地基。地基选错了，上面的建筑再精美也会塌。选择 LanceDB 作为存储引擎，不是因为它最流行，而是因为它最适合——嵌入式、列式、向量原生，恰好满足 OpenClaw 插件的全部约束条件。

## 3.1 为什么选择 LanceDB

市面上的向量数据库选择很多——Pinecone、Weaviate、Qdrant、Milvus、Chroma。但对于一个 OpenClaw 插件来说，它们都有一个致命的问题：**需要独立部署**。用户不仅要安装插件，还要搭建和维护一个数据库服务。对于一个旨在"即插即用"的记忆插件，这个门槛太高了。

LanceDB 是嵌入式的（embedded），以库的形式集成到应用中，数据直接存储在本地文件系统上，不需要任何外部服务进程。这和 SQLite 的理念一致——零配置、零运维。但与 SQLite 不同的是，LanceDB 是列式存储且原生支持向量索引。

```
// 文件: src/store.ts L1-20
// LanceDB 基于 Apache Arrow 列式格式，这意味着
// 数据可以在不同语言和工具之间无缝共享。
// 未来如果需要用 Python 脚本分析记忆数据，
// 可以直接读取同一份文件，无需导出导入。
```

## 3.2 懒初始化连接模式

`store.ts` 采用了懒初始化（Lazy Initialization）模式来管理 LanceDB 连接：

```
// 文件: src/store.ts L40-80
// private connection: Connection | null = null;
// private table: Table | null = null;
//
// async getConnection(): Promise<Connection> {
//   if (!this.connection) {
//     this.connection = await lancedb.connect(this.dbPath);
//   }
//   return this.connection;
// }
```

为什么不在插件初始化时就建立连接？首先，并非每次对话都需要访问记忆，懒初始化避免了不必要的 I/O 开销。其次，LanceDB 的连接涉及文件系统操作，在某些环境下需要几十毫秒，将延迟推迟到真正需要时可以加快插件启动速度。最后，懒初始化天然支持"首次使用时创建"的语义。

但懒初始化也引入了连接生命周期管理的问题。`store.ts` 通过异常捕获和重连逻辑来处理——当操作抛出连接相关异常时，清除缓存的连接引用，下一次调用 `getConnection()` 就会自动重建连接。

### 核心流程

```
store.ts CRUD 操作核心流程:

写入 (store):
  调用方 ──+---> store.write(text, vector, metadata, scope)
                    |
                    v
           getConnection() ──[懒初始化]──> lancedb.connect()
                    |
                    v
           getTable() ──[首次使用时创建]──> table.create(schema)
                    |
                    v
           table.add([{id, text, vector, scope, ...}])

更新 (update): 读 ──> 改 ──> 删旧 ──> 写新  (非原子, 单用户可接受)

查询 (search):
  vectorSearch ──+---> table.search(queryVector, "vector")
                 |         .where(scopeFilter)
                 |         .limit(N)
                 v
  bm25Search ──+---> table.search(queryText, "fts")
                         .where(scopeFilter)
                         .limit(N)
```

## 3.3 表结构设计

memory-lancedb-pro 使用单一的 `memories` 表存储所有记忆数据：

```
// 文件: src/store.ts L90-130
// memories 表的 schema：
// {
//   id: string,          // UUID，全局唯一标识
//   text: string,        // 记忆的文本内容
//   vector: float32[],   // 嵌入向量，维度由模型决定
//   category: string,    // 记忆类别（6 类之一）
//   scope: string,       // 作用域标识
//   importance: float32, // 重要性评分 [0, 1]
//   timestamp: int64,    // 创建时间戳（毫秒）
//   metadata: string     // JSON 序列化的元数据
// }
```

**为什么用单表而不是多表？** 跨类别和跨作用域的联合查询是常见需求。单表设计让这类查询只需一次表扫描，而多表设计则需要多次查询和结果合并。在 LanceDB 的列式存储下，通过 `category` 和 `scope` 字段过滤的开销极小。

**为什么 metadata 是 JSON 字符串而不是结构化列？** metadata 的内容在不同版本间会发生变化。序列化为 JSON 字符串意味着修改元数据结构不需要表级 schema migration。代价是无法对 metadata 内的字段建索引——但在当前规模下可以接受。

### 设计取舍

**单表 vs 多表**：多表方案（按 category 或 scope 分表）能提供更好的查询隔离和独立索引，但跨表联合查询需要应用层合并，在 LanceDB 列式存储中列过滤已足够高效，单表的简洁性胜出。**metadata 序列化 vs 结构化列**：结构化列允许对 metadata 内部字段建索引和过滤，但每次 schema 变更都需要表级迁移——对于一个快速迭代的插件来说这是不可接受的。JSON 序列化牺牲了部分查询能力，换取了 schema 演进的零成本。这个选择在数据量达到百万级时可能需要重新评估，但在当前万级规模下是最优解。

```
// 文件: src/store.ts L135-160
// metadata JSON 的典型内容包括：
// - tier: "core" | "working" | "peripheral"
// - accessCount: number
// - lastAccessTime: number
// - source: string (对话 ID 或手动输入标记)
// - L1/L2 层级元数据（来自 smart-metadata.ts）
```

**importance 字段的范围为什么是 [0, 1]？** 归一化让不同来源的重要性判断可以直接比较和组合，为 `decay-engine.ts` 中的综合评分计算提供了统一的输入基础。

## 3.4 CRUD 操作实现

写入操作的核心设计是 store 不负责生成嵌入向量。调用者需要先调用 embedder 生成向量，再将向量连同文本一起传给 store。这种解耦确保了存储层的纯粹性。

```
// 文件: src/store.ts L230-280
// 更新操作较为复杂，因为 LanceDB 不支持原生的
// 行级更新。实现方式是：读取 → 修改 → 删除旧记录 → 写入新记录。
// 这个"读-改-删-写"模式在并发场景下有竞态风险，
// 但对于单用户的 OpenClaw 插件场景来说是可接受的。
```

`patchMetadata` 方法允许只更新 metadata JSON 中的部分字段。它使用浅合并（`Object.assign`）将补丁应用到现有对象上。为什么是浅合并？因为 metadata 中的嵌套对象通常需要整体替换，浅合并的语义更清晰。

```
// 文件: src/store.ts L290-340
// patchMetadata 是 access-tracker.ts 和 tier-manager.ts
// 最常调用的接口——每次访问记忆时更新 accessCount
// 和 lastAccessTime，每次层级变化时更新 tier 字段。
```

## 3.5 向量搜索与全文搜索

`store.ts` 暴露了两个独立的搜索方法：`vectorSearch` 和 `bm25Search`。

```
// 文件: src/store.ts L360-430
// vectorSearch 使用 LanceDB 的 ANN（近似最近邻）索引，
// 内部使用 IVF-PQ 索引加速大规模向量检索。
```

```
// 文件: src/store.ts L440-500
// bm25Search 使用 LanceDB 的全文搜索能力。
// 为什么同时提供两种搜索方法而不是只暴露一个混合搜索？
// 因为 retriever.ts 需要分别获取两路结果，
// 然后按照可配置的权重进行融合。
// 将融合逻辑放在 retriever 而非 store 中，
// 让存储层保持简单，也让检索策略更容易调整。
```

两个搜索方法都支持 `scopeFilter` 参数，过滤条件直接传递给 LanceDB 的查询引擎，利用列式存储的高效过滤能力，避免在应用层全量扫描。

## 3.6 路径验证与符号链接解析

数据库路径的验证逻辑是一个容易被忽视但非常重要的安全特性：

```
// 文件: src/store.ts L550-620
// 路径验证的完整流程：
// 1. 规范化路径（resolve 相对路径为绝对路径）
// 2. 检测并解析符号链接（readlink -f / realpath）
// 3. 验证解析后的路径是否在允许的目录范围内
// 4. 检查目录权限（读/写/执行）
// 5. 如果目录不存在，尝试递归创建
//
// 为什么要解析符号链接？因为符号链接可以指向任意位置。
// 一个看起来在 ~/.openclaw/ 下的路径，实际上可能
// 指向 /etc/ 或其他敏感目录。不解析符号链接就校验路径，
// 攻击者可以通过构造恶意符号链接绕过目录限制。
```

与此配合的是 `workspace-boundary.ts`（200 行），确保不同工作空间的数据不会因路径配置错误而互相覆盖。

## 3.7 单表设计的扩展性

一个 Agent 在长期使用中可能积累数千到数万条记忆——这对于 LanceDB 来说微不足道。LanceDB 使用分片机制组织数据，向量索引的构建和查询都是增量的。

```
// 文件: src/store.ts L640-680
// 即使数据量达到十万级别，LanceDB 的 ANN 查询
// 延迟也在个位数毫秒级别。真正可能成为瓶颈的
// 是 BM25 全文检索——它需要扫描所有文本内容。
// 但考虑到记忆系统的查询频率（每次对话几次），
// 这个延迟在实际使用中几乎不可感知。
```

如果未来确实遇到规模瓶颈，可以引入分区策略（按 scope 或时间范围分表）来水平扩展，而不需要改动上层逻辑。这得益于 store.ts 对外暴露的是抽象接口而非 LanceDB 原生 API。

## 本章小结

`store.ts` 作为 memory-lancedb-pro 的存储引擎，选择 LanceDB 的核心理由是其嵌入式、列式、向量原生的特性，完美契合了 OpenClaw 插件"零运维"的需求。懒初始化模式在启动性能和资源利用之间取得了良好平衡；单表设计以 JSON 序列化的 metadata 字段换取了 schema 演进的灵活性；向量搜索与全文搜索的分离暴露让检索层有了充分的策略自由度；路径验证中的符号链接解析体现了生产级的安全意识。存储层的纯粹性——不依赖嵌入层、不包含业务逻辑——是整个系统可维护性的基石。
