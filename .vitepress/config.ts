import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'memory-lancedb-pro 源码解析',
  description: 'OpenClaw 增强版 LanceDB 记忆插件：混合检索、重排与多作用域隔离全解',
  lang: 'zh-CN',
  base: '/',

  themeConfig: {
    logo: { src: '/logo.png', alt: 'memory-lancedb-pro' },
    nav: [
      { text: '开始阅读', link: '/chapters/01-overview' },
      { text: '目录', link: '/contents' },
      { text: 'GitHub', link: 'https://github.com/coolclaws/memory-lancedb-pro-book' },
    ],
    sidebar: [
      {
        text: '第一部分：宏观认知',
        items: [
          { text: '第 1 章：项目概览', link: '/chapters/01-overview' },
          { text: '第 2 章：架构全景与模块依赖', link: '/chapters/02-architecture' },
        ],
      },
      {
        text: '第二部分：存储基石',
        items: [
          { text: '第 3 章：LanceDB 存储引擎', link: '/chapters/03-lancedb-store' },
          { text: '第 4 章：向量嵌入与分块策略', link: '/chapters/04-embedder' },
          { text: '第 5 章：BM25 全文索引', link: '/chapters/05-bm25-fts' },
        ],
      },
      {
        text: '第三部分：检索与重排',
        items: [
          { text: '第 6 章：混合检索管线', link: '/chapters/06-hybrid-retrieval' },
          { text: '第 7 章：Cross-Encoder 重排序', link: '/chapters/07-reranker' },
          { text: '第 8 章：自适应检索与噪声过滤', link: '/chapters/08-adaptive-noise' },
          { text: '第 9 章：检索评分体系', link: '/chapters/09-scoring' },
        ],
      },
      {
        text: '第四部分：记忆生命周期',
        items: [
          { text: '第 10 章：智能记忆提取', link: '/chapters/10-smart-extractor' },
          { text: '第 11 章：记忆衰减与层级管理', link: '/chapters/11-decay-tier' },
          { text: '第 12 章：记忆反思与会话恢复', link: '/chapters/12-reflection' },
        ],
      },
      {
        text: '第五部分：多作用域与元数据',
        items: [
          { text: '第 13 章：多作用域隔离与权限', link: '/chapters/13-scopes' },
          { text: '第 14 章：智能元数据与分层存储', link: '/chapters/14-smart-metadata' },
        ],
      },
      {
        text: '第六部分：集成接口',
        items: [
          { text: '第 15 章：插件入口与生命周期钩子', link: '/chapters/15-plugin-entry' },
          { text: '第 16 章：Agent 工具系统', link: '/chapters/16-agent-tools' },
          { text: '第 17 章：CLI 与数据迁移', link: '/chapters/17-cli-migrate' },
        ],
      },
      {
        text: '附录',
        items: [
          { text: '附录 A：推荐阅读路径', link: '/chapters/appendix-a-reading-path' },
          { text: '附录 B：核心类型速查', link: '/chapters/appendix-b-type-reference' },
          { text: '附录 C：术语表', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    search: { provider: 'local' },
    footer: {
      message: '基于 MIT 协议发布',
      copyright: 'Copyright © 2025-present',
    },
  },
  markdown: { lineNumbers: true },
})
