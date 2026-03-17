# 第十章 智能记忆提取

> 人类的记忆从不是对经历的逐字录像，而是一个主动的提取与重构过程——我们会自动将一段冗长的对话压缩成几个关键要点，把新信息与已有知识关联整合，并丢弃那些无足轻重的细节。`smart-extractor.ts` 正是这一认知过程的工程实现。这个 700 行的模块承担着记忆系统中最具挑战性的任务：从非结构化的对话流中提取结构化的记忆单元，决定每一条新信息应该创建、合并还是丢弃，并以分层的方式存储以适应不同的检索场景。

## 10.1 六分类体系：为什么不是三个，也不是十个

记忆分类是整个提取系统的基石。`smart-extractor.ts` 将所有可提取的记忆分为六个类别：

```typescript
// 文件: src/smart-extractor.ts L35-55
// 六大记忆类别定义
type MemoryCategory =
  | 'profile'      // 身份事实
  | 'preferences'  // 用户偏好
  | 'entities'     // 命名实体
  | 'events'       // 时间事件
  | 'cases'        // 问题/解决方案
  | 'patterns';    // 行为模式
```

**为什么不是三个（简单分类）？** 一种直觉的简化方案是只分 "事实 / 事件 / 偏好" 三类。但这种粗粒度分类无法区分关键的操作差异：用户的名字（profile）和用户提到的某个公司（entity）虽然都是 "事实"，但它们的去重策略截然不同——名字应该始终合并到同一条记录，而公司信息可能需要保留多条独立记录。三分类会迫使系统在去重逻辑中引入大量条件判断，违反了单一职责原则。

**为什么不是十个（细粒度分类）？** 更细的分类（比如把 profile 拆成 name、role、background 等子类别）确实能提供更精确的控制，但会带来两个严重问题。第一，LLM 在分类任务中的准确率与类别数量成反比——六个类别时分类准确率可以达到 90% 以上，十个类别可能降到 75%，分类错误会导致后续的合并策略完全走偏。第二，每增加一个类别就需要在 `extraction-prompts.ts` 中维护一套完整的提取 prompt、去重 prompt 和合并 prompt，维护成本呈线性增长。

六个类别是在 **区分度** 和 **可维护性** 之间的甜点位置。

## 10.2 每个类别的语义与合并策略

六个类别可以按合并策略分为两组：**可合并类别**（mergeable）和 **仅追加类别**（append-only）。

### 可合并类别

**Profile（身份事实）**：用户的核心身份信息，如姓名、职业、技术栈等。这是唯一一个 **始终合并** 的类别——当系统检测到新的 profile 信息时，会跳过向量预过滤阶段，直接将其与现有的 profile 记录合并。这种激进的合并策略基于一个关键假设：一个用户只有一个身份，所有身份事实应该汇聚到同一条记录中。

```typescript
// 文件: src/smart-extractor.ts L120-128
// Profile 类别跳过向量预过滤，始终执行合并
if (category === 'profile') {
  return await mergeIntoExisting(existingProfile, newExtraction);
}
```

**Preferences（用户偏好）**：编码风格偏好、工具选择、工作习惯等。可合并意味着当用户说 "我喜欢用 Vim" 然后又说 "我现在改用 Neovim 了"，系统应该更新而非追加。偏好的本质是 **可覆盖** 的——最新的表态代表当前的真实状态。

**Entities（命名实体）**：用户提到的人名、项目名、公司名等。可合并但更谨慎——同一个实体的不同信息应该合并（"Alice 是后端工程师" + "Alice 负责支付模块" → 合并），但不同实体必须保持独立。

**Patterns（行为模式）**：系统观察到的用户行为规律，如 "用户倾向于先写测试再写实现"。可合并，因为模式是对行为的总结，新的观察应该丰富而非重复现有的模式描述。

### 仅追加类别

**Events（时间事件）**：具有时间戳的离散事件，如 "2024 年 3 月部署了 v2.0"。仅追加意味着每个事件都是独立的历史记录，即使两个事件看起来相似（比如两次部署），它们也代表不同的时间点，不应合并。在去重决策中，events 只允许 CREATE 或 SKIP。

**Cases（问题/解决方案）**：具体的问题解决案例，如 "Webpack 打包失败，通过升级 Node 版本解决"。同样仅追加——两个看似相似的问题可能有完全不同的上下文和解决方案，合并会丢失关键细节。

```typescript
// 文件: src/smart-extractor.ts L145-155
// Events 和 Cases 仅允许 CREATE 或 SKIP
if (category === 'events' || category === 'cases') {
  const decision = await llmDedupDecision(candidate, existingMemories);
  if (decision !== 'create') return; // skip
  await createNewMemory(candidate);
}
```

## 10.3 L0/L1/L2 分层存储：为什么需要三层

每条记忆被存储为三个层次，这是整个系统中最精妙的设计之一：

- **L0（一句话索引）**：用于搜索的超短摘要，通常不超过一句话
- **L1（结构化 Markdown 摘要）**：中等详细程度的结构化内容
- **L2（完整叙事内容）**：未经压缩的原始详细信息

```typescript
// 文件: src/smart-extractor.ts L200-220
// 三层存储结构
interface ExtractedMemory {
  l0: string;           // "用户偏好 TypeScript 严格模式"
  l1: string;           // "## 编码偏好\n- TypeScript strict mode\n- ..."
  l2: string;           // 完整的对话上下文和推理过程
  category: MemoryCategory;
  importance: number;
  confidence: number;
}
```

**为什么不只用 L0？** L0 用于生成向量嵌入和快速检索，但它过于精简，无法承载记忆的完整语义。当检索系统需要向 LLM 提供上下文时，一句话的 L0 往往不够用。

**为什么不只用 L2？** L2 包含完整信息，但直接对 L2 做向量嵌入会引入大量噪声——长文本中的次要信息会干扰向量的方向，降低检索精度。此外，将所有 L2 内容塞进 LLM 的上下文窗口会浪费宝贵的 token 预算。

**三层设计的精髓** 在于让每一层服务于不同的使用场景：L0 驱动向量搜索（高精度匹配），L1 提供给 LLM 作为上下文（信息密度与 token 效率的平衡），L2 在用户需要深入细节时按需加载。这种设计灵感来自计算机体系结构中的缓存层次——L1 cache、L2 cache、主存各有其访问速度与容量的权衡。

## 10.4 两阶段去重管线

去重是记忆提取中最复杂的环节。如果没有去重，系统会迅速积累大量语义重复的记忆条目，既浪费存储空间，又降低检索质量。memory-lancedb-pro 采用两阶段去重策略，巧妙地平衡了准确性与计算成本。

### Stage 1：向量预过滤

```typescript
// 文件: src/smart-extractor.ts L280-300
// Stage 1: 向量预过滤
const candidates = await vectorSearch(newMemory.l0, {
  threshold: 0.7,
  maxResults: 3
});
```

第一阶段使用向量相似度搜索，以 0.7 的阈值找出最多 3 条可能与新记忆重复的已有记忆。**为什么阈值是 0.7？** 这比检索阶段的阈值（0.35）高很多，因为去重要求更高的相似度——两条记忆必须在语义上高度重叠才值得考虑合并。但 0.7 又不能太高（比如 0.9），否则会遗漏那些措辞不同但含义相同的重复记忆。

**为什么最多 3 条？** 这是一个性能约束。Stage 2 需要调用 LLM 进行语义判断，每多一条候选记忆就意味着更多的 LLM 调用和 token 消耗。实践表明，如果一条新记忆与已有记忆真的重复，最相似的那 1-2 条几乎总能被 top-3 捕获。

### Stage 2：LLM 语义决策

```typescript
// 文件: src/smart-extractor.ts L310-340
// Stage 2: LLM 语义决策
const decision = await llmDecide(newMemory, candidates);
// decision 为以下 7 种之一:
// create | merge | skip | support | contextualize | contradict | supersede
```

Stage 2 将新记忆和 Stage 1 筛出的候选记忆一起发送给 LLM，由 LLM 做出语义级别的决策。七种决策覆盖了所有可能的关系：

- **create**：新信息，无重复，创建新条目
- **merge**：与已有记忆高度重叠，应合并到已有条目中
- **skip**：完全重复，无需任何操作
- **support**：新记忆为已有记忆提供了佐证，增强其可信度
- **contextualize**：新记忆为已有记忆补充了上下文背景
- **contradict**：新记忆与已有记忆矛盾，需标记冲突
- **supersede**：新记忆是已有记忆的更新版本，应替换旧记忆

**为什么需要七种而不是简单的 "合并/创建/跳过" 三种？** 因为记忆之间的关系远比 "相同或不同" 复杂。`support` 和 `contextualize` 不修改已有记忆的内容，但会更新其元数据（confidence 分数或关联链接）。`contradict` 不会删除任何一方，而是标记冲突让上层系统或用户决定。`supersede` 则代表时间维度上的演进——用户的偏好可能改变，最新的表态应该取代旧的。

## 10.5 提示工程：extraction-prompts.ts 的设计哲学

```typescript
// 文件: src/extraction-prompts.ts L1-30
// 300+ 行的提示模板，定义了 6 类记忆的提取 JSON schema
```

`extraction-prompts.ts` 超过 300 行，为每个记忆类别定义了完整的 JSON schema 和提示模板。这些 prompt 的设计遵循几个关键原则：

**结构化输出约束**：使用 JSON schema 而非自由文本输出，确保 LLM 返回的结果可以被程序解析。每个类别的 schema 定义了必需字段和可选字段，LLM 必须在这个框架内工作。

**类别特定的提取指令**：不同类别的提取逻辑差异很大。例如，profile 的提取 prompt 强调 "合并所有身份相关的事实到一个对象中"，而 events 的提取 prompt 则强调 "每个事件必须有明确的时间标记"。

**去重决策 prompt** 是最复杂的部分。它需要向 LLM 展示新记忆和候选重复记忆的对比，并用清晰的判断标准引导 LLM 在七种决策中做出选择。prompt 中包含了每种决策的示例和反例，以提高 LLM 判断的一致性。

## 10.6 Profile 和 Events/Cases 的特殊处理

Profile 类别的特殊性在于它完全跳过 Stage 1 向量预过滤。这不是偷懒，而是有意为之——一个用户的所有 profile 信息都应该汇聚到同一条记录中，无论新信息与旧信息在向量空间中是否相似。用户的名字和用户的技术栈在语义上可能毫无关联（向量相似度很低），但它们都是 profile，应该合并。

```typescript
// 文件: src/smart-extractor.ts L120-135
// Profile 始终合并，跳过向量预过滤
if (category === 'profile') {
  const existingProfile = await getExistingProfile(scope);
  return existingProfile
    ? await mergeIntoExisting(existingProfile, newExtraction)
    : await createNewMemory(newExtraction);
}
```

Events 和 Cases 的特殊性则在于它们是仅追加的。即使 LLM 判断两个事件 "语义相似"，系统也不允许合并——因为每个事件都是历史记录的一部分，合并会破坏时间线的完整性。这种约束通过在去重决策后硬编码逻辑来实现：如果类别是 events 或 cases，且决策不是 create，则一律视为 skip。

## 本章小结

本章深入剖析了 `smart-extractor.ts` 的核心设计。六分类体系在区分度与可维护性之间找到了平衡点，每个类别都有明确的语义定义和对应的合并策略——profile 始终合并、preferences/entities/patterns 可合并、events/cases 仅追加。L0/L1/L2 三层存储借鉴了 CPU 缓存层次的思想，让不同使用场景都能获得最优的信息粒度。两阶段去重管线先用向量预过滤（0.7 阈值、top-3）快速缩小候选范围，再用 LLM 做七种语义决策，在准确性和计算成本之间取得了精妙的平衡。理解 smart-extractor 的设计，就是理解 memory-lancedb-pro 如何将 "信息" 转化为 "记忆" 的关键。
