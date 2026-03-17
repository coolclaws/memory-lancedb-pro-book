# 第七章：Cross-Encoder 重排序

> 在检索管线中，向量检索和 BM25 扮演的是"粗筛"角色——它们用各自的方式从海量记忆中快速召回一组候选。但"快速"往往意味着"粗糙"。Bi-encoder 生成的向量是查询和文档各自独立编码的结果，它们之间的交互仅限于最后一步的余弦相似度计算。Cross-encoder 则完全不同：它将查询和候选文本拼接后一起送入 Transformer，让注意力机制在每一层都充分捕捉两者之间的细粒度交互。这种"精读"式的评估代价高昂，但质量提升显著。

## 7.1 Bi-Encoder 的结构性局限

要理解为什么需要 cross-encoder 重排序，我们必须先理解 bi-encoder 的局限。

Bi-encoder（双编码器）是向量检索的基础架构。它将查询和文档分别编码为固定维度的向量，然后通过余弦相似度或点积计算相关性。这种架构的优势是效率——文档向量可以预计算并索引，查询时只需要编码查询向量然后做向量搜索，时间复杂度接近 O(log n)。

但这种效率的代价是**交互的缺失**。查询向量和文档向量在编码阶段完全独立，没有任何信息交换。这意味着 bi-encoder 无法捕捉词级别的精确匹配、否定关系、条件依赖等需要两端文本共同参与才能判断的语义关系。

举个例子：查询是"不使用 Docker 的部署方案"，记忆中有两条：A) "使用 Docker Compose 进行部署" 和 B) "使用 systemd 进行裸机部署"。Bi-encoder 很可能给 A 更高的分数，因为 "Docker" 和 "部署" 这两个核心词都出现了，向量空间中 A 与查询更近。但用户实际想要的是 B——因为查询包含"不使用 Docker"这个否定条件。Cross-encoder 将查询和文档拼接后进行注意力计算，能够捕捉到"不"与 "Docker" 之间的否定关系，从而正确地给 B 更高的分数。

```
// 文件: src/retriever.ts L310-340
// Cross-encoder 重排序的价值：
// - 捕捉查询与文档之间的细粒度语义交互
// - 处理否定、条件、对比等复杂语义关系
// - 在候选池已经很小（20-40 条）时，精确度比效率更重要
```

## 7.2 六大 Reranker 提供商的统一抽象

memory-lancedb-pro 支持六种 reranker 提供商：Jina、SiliconFlow、Voyage、Pinecone、DashScope（阿里云）和 TEI（Text Embeddings Inference）。这些提供商的 API 各有差异，但 `retriever.ts` 通过一个统一的抽象层将它们封装起来。

```
// 文件: src/retriever.ts L350-390
// Reranker 抽象层的核心接口：
// async function rerank(
//   query: string,
//   candidates: MemoryCandidate[],
//   config: RetrievalConfig
// ): Promise<RerankResult[]>
//
// 根据 config.rerankModel 或环境变量选择具体的提供商
// 所有提供商最终返回统一的 {index, score} 数组
```

**为什么要支持这么多提供商？** 这是一个务实的设计决策。不同的用户有不同的供应商偏好和地域限制。在中国大陆部署的用户可能无法访问 Jina 或 Voyage，但可以使用 DashScope（阿里云灵积）或 SiliconFlow。在私有化部署场景中，TEI（Hugging Face 的自托管推理服务）可能是唯一的选择。支持多提供商确保了 memory-lancedb-pro 在全球不同环境中的可用性。

## 7.3 提供商特定的请求与响应处理

虽然抽象层对外提供了统一接口，但每个提供商的内部处理逻辑是不同的。让我们逐一分析。

### Jina

```
// 文件: src/retriever.ts L400-430
// Jina Reranker:
// - 认证: Authorization: Bearer <token>
// - 模型: jina-reranker-v3（默认）
// - 请求体: { model, query, documents: string[] }
// - 响应体: { results: [{ relevance_score, index }] }
// - 文档格式: 纯字符串数组
```

Jina 的 API 设计最为简洁——文档直接以字符串数组传入，响应中的 `relevance_score` 就是相关性得分。`jina-reranker-v3` 是默认模型，它基于大规模语料训练，对多语言支持较好，这对记忆系统中可能混杂中英文内容的场景很重要。

### SiliconFlow

```
// 文件: src/retriever.ts L435-460
// SiliconFlow Reranker:
// - 认证: Authorization: Bearer <token>
// - 请求体: { model, query, documents: string[] }
// - 响应体: { results: [{ relevance_score, index }] }
// - 与 Jina 格式高度相似
```

SiliconFlow 的 API 格式与 Jina 非常相似，这可能是因为它们都遵循了类似的行业标准。对于在中国大陆部署的用户，SiliconFlow 提供了低延迟的重排序服务。

### Voyage

```
// 文件: src/retriever.ts L465-495
// Voyage Reranker:
// - 认证: Authorization: Bearer <token>
// - 模型: rerank-2.5
// - 请求体: { model, query, documents: string[] }
// - 响应体: { data: [{ relevance_score, index }] }
// - 注意: 响应字段是 data 而非 results
```

Voyage 的差异在于响应体的结构——它使用 `data` 数组而非 `results`，得分字段名为 `relevance_score`。这种看似微小的差异正是统一抽象层存在的意义：调用方不需要关心这些细节。

### Pinecone

```
// 文件: src/retriever.ts L500-535
// Pinecone Reranker:
// - 认证: Api-Key: <key>（注意不是 Bearer token）
// - 请求体: { model, query, documents: [{text}] }
// - 响应体: { data: [{ score, index }] }
// - 两个关键差异:
//   1. 认证头不同 (Api-Key vs Authorization)
//   2. 文档格式是对象数组 {text: string} 而非纯字符串
```

Pinecone 的差异更为显著。它使用 `Api-Key` 请求头进行认证，而非标准的 `Bearer` token 模式。文档也不是简单的字符串数组，而是 `{text: string}` 对象数组。这些差异反映了不同公司的 API 设计哲学——Pinecone 倾向于结构化的文档表示，为未来扩展（如添加文档 metadata）留有空间。

### DashScope（阿里云灵积）

```
// 文件: src/retriever.ts L540-575
// DashScope Reranker:
// - 认证: Authorization: Bearer <token>
// - 请求体: { model, input: { query, documents: [{text}] } }
// - 响应体: { output: { results: [{ relevance_score, index }] } }
// - 嵌套层级更深: input.documents, output.results
```

DashScope 的 API 风格是阿里云的典型设计——请求和响应都有一层额外的嵌套（`input` 和 `output`）。文档格式与 Pinecone 类似，使用 `{text}` 对象。在面向中国大陆用户的部署中，DashScope 通常是延迟最低、最稳定的选择。

### TEI（Text Embeddings Inference）

```
// 文件: src/retriever.ts L580-615
// TEI Reranker:
// - 认证: 无认证或 Bearer token（取决于部署配置）
// - 请求体: { query, texts: string[] }
// - 响应体: [{ score, index }]（注意: 按 index 排序，非按 score）
// - 关键差异: 响应是裸数组，需要自行按 score 排序
```

TEI 是 Hugging Face 的开源推理服务器，用于自托管 embedding 和 rerank 模型。它的 API 最为朴素——请求体字段名是 `texts` 而非 `documents`，响应是一个裸数组而非嵌套在对象中。最关键的差异是：TEI 的响应结果是按原始文档 index 排序的，而非按 score 降序排列。memory-lancedb-pro 需要在接收到 TEI 的响应后自行按 score 排序。

TEI 的另一个特殊之处是认证的可选性。在私有网络中部署的 TEI 实例通常不需要认证，而通过公网暴露的实例则需要 Bearer token。代码中通过检测环境变量是否存在来决定是否添加认证头。

## 7.4 得分混合：60% Rerank + 40% Fused

重排序模型返回了新的相关性得分，但 memory-lancedb-pro 并没有完全抛弃之前融合阶段计算的 fusedScore。它采用了一个 60/40 的混合策略：

```
// 文件: src/retriever.ts L620-650
// 得分混合公式:
// finalScore = 0.6 * rerankScore + 0.4 * fusedScore
//
// 为什么不完全使用 rerankScore？
// 1. Cross-encoder 可能对某些领域文本的判断有偏差
// 2. fusedScore 包含了向量+BM25 两路信号的综合判断
// 3. 混合得分比单一来源更鲁棒
```

**为什么是 60/40 而非 80/20 或 50/50？** 60% 的重排序权重表明我们高度信任 cross-encoder 的判断——它确实通常比 bi-encoder 更准确。但保留 40% 的融合得分作为"锚定"，可以防止 cross-encoder 在某些极端情况下（如查询和文档都很短时）产生的得分波动主导最终排序。

这种混合策略在信息检索领域被称为 score interpolation（得分插值），是一种成熟的实践。它的核心思想是：没有单一的评分方法在所有情况下都是最优的，混合多种信号源可以提高整体的鲁棒性。

## 7.5 余弦回退：API 失败时的降级

Cross-encoder 重排序依赖外部 API，而外部 API 不可能保证 100% 的可用性。网络超时、API 限流、认证过期等问题随时可能发生。memory-lancedb-pro 为此设计了余弦回退机制：

```
// 文件: src/retriever.ts L660-700
// 余弦回退逻辑:
// try {
//   rerankResults = await callRerankAPI(provider, ...)
// } catch (error) {
//   // API 调用失败，回退到余弦相似度重排序
//   rerankResults = cosineRerank(queryVector, candidates)
// }
//
// cosineRerank: 直接使用查询向量与候选向量的余弦相似度
// 作为 rerankScore（向量在 Step 1 已经计算过）
```

**为什么选择余弦相似度作为回退而不是直接跳过重排序？** 因为后续管线期望每个候选都有一个经过重排序调整的得分。如果直接跳过重排序（即让 finalScore = fusedScore），管线的行为不会出错，但会失去"精读"阶段的质量提升。余弦回退虽然不如 cross-encoder 精确，但它仍然提供了一个基于向量空间的相关性信号，比完全跳过要好。

更重要的是，余弦回退的计算完全在本地完成，不依赖任何外部服务。查询向量在 Step 1 就已经计算好了，候选的向量存储在 LanceDB 中，直接从检索结果中获取即可。这确保了即使所有外部重排序服务都不可用，检索管线仍然能够正常工作。

## 7.6 rerankModel 配置

`RetrievalConfig` 中的 `rerankModel` 字段决定了使用哪个模型和提供商：

```
// 文件: src/retriever.ts L40-48
// rerankModel: 'jina-reranker-v3'  // 默认值
//
// 模型名称同时隐含了提供商信息：
// jina-reranker-*     → Jina
// rerank-2.5          → Voyage
// bge-reranker-*      → SiliconFlow 或 TEI
// ...
// 也可以通过环境变量显式指定提供商端点
```

选择 `jina-reranker-v3` 作为默认模型是基于几个考量：它的多语言支持优秀（对 CJK 文本友好），API 响应速度快，定价合理，且在公开基准测试中表现出色。但在生产环境中，用户通常会根据自己的访问条件和成本预算选择不同的提供商。

`rerank` 配置项提供了三个级别的选择：`'cross-encoder'` 使用完整的 cross-encoder 重排序；`'lightweight'` 使用更轻量的重排序策略；`'none'` 完全跳过重排序。在延迟敏感的场景中，选择 `'none'` 可以将检索延迟减少 200-500ms（取决于重排序 API 的响应时间），代价是检索质量的轻微下降。

## 本章小结

Cross-encoder 重排序是检索管线中质量提升最显著的环节。它克服了 bi-encoder 无法捕捉查询-文档细粒度交互的结构性局限，通过将两段文本拼接后进行联合编码来实现"精读"。memory-lancedb-pro 支持六种重排序提供商（Jina、SiliconFlow、Voyage、Pinecone、DashScope、TEI），通过统一抽象层封装了各自不同的认证方式、请求格式和响应结构。60/40 的得分混合策略在信任 cross-encoder 判断的同时保留了融合阶段的信号作为鲁棒性锚定。余弦回退机制确保了在外部 API 不可用时，管线仍然能够正常运行。这种"精确但容错"的设计哲学贯穿了 memory-lancedb-pro 的整个架构。
