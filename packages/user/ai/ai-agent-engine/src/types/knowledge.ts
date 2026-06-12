/**
 * 主题知识库类型定义
 */

/**
 * 主题内容维度
 */
export interface TopicScope {
  id: string;
  label: string;
  reason: string;
}

/**
 * 主题分类条目
 */
export interface TopicEntry {
  /** 主题名称 */
  name: string;
  /** 一级分类 */
  category: string;
  /** 别名列表 */
  aliases: string[];
  /** 关联主题 */
  related: string[];
  /** 内容维度（如：游戏本体、视频、直播、攻略等） */
  scopes: TopicScope[];
  /** 关键词列表 */
  keywords: string[];
}

/**
 * 一级分类定义
 */
export interface CategoryDefinition {
  id: string;
  label: string;
  keywords: string[];
  description: string;
}

/**
 * 主题知识库
 */
export interface TopicKnowledgeBase {
  categories: CategoryDefinition[];
  topics: TopicEntry[];
  version: string;
}
