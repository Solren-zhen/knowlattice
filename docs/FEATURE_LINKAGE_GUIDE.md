# KNOWLATTICE 功能联动使用指南

## 功能概览

KNOWLATTICE 现已实现 8 个功能联动增强，帮助用户建立"笔记 ↔ 卡片 ↔ 题目"的完整学习闭环。

## 1. 笔记 → 自动生成卡片 📝

### 使用场景
阅读完一篇笔记后，快速生成复习卡片巩固知识点。

### 使用方法
```typescript
import { generateCardsFromNote } from './core/cardAutoGeneration';

// 单篇笔记生成卡片
const cards = generateCardsFromNote({
  path: 'notes/心力衰竭.md',
  content: noteContent,
  title: '心力衰竭'
});

// 批量生成
const allCards = batchGenerateCards(notes);
```

### 提取规则
- **标题规则**: 提取 H2/H3 标题作为卡片标题
- **列表规则**: 识别重要列表项（分类、症状、治疗等）
- **重点规则**: 提取加粗、重点标记的内容

### 示例
笔记内容：
```markdown
## 心力衰竭诱因
- 感染（最常见）
- 心律失常
- 过度劳累
```

生成卡片：
- **标题**: 心力衰竭诱因
- **内容**: 感染（最常见）、心律失常、过度劳累

---

## 2. 做题错误 → 自动生成错题卡片 ❌➡️📋

### 使用场景
做错题目后，自动生成卡片强化记忆。

### 使用方法
```typescript
import { generateCardFromMistake } from './core/mistakeCardGeneration';

const card = generateCardFromMistake({
  qid: 'q123',
  stem: '心衰最常见诱因是？',
  correctAnswer: 'A. 感染',
  userAnswer: 'B. 心律失常',
  explanation: '感染是慢性心衰最常见诱因'
});
```

### 卡片内容
- **标题**: 从题干提取（如"心衰最常见诱因"）
- **正面**: 题干精简版
- **背面**: 正确答案 + 错误分析
- **来源**: 标记错题 ID
- **hints**: 知识点关键词

---

## 3. 卡片复习 → 关联笔记推荐 🔗

### 使用场景
复习卡片遇到困难时，推荐相关笔记深入学习。

### 使用方法
```typescript
import { findRelatedNotes } from './core/cardNoteRecommendation';

const notes = findRelatedNotes(card, allNotes, 3);

// 返回：
// [
//   {
//     path: 'notes/心力衰竭.md',
//     title: '心力衰竭',
//     relevance: 0.95,
//     reason: '标题匹配"心力衰竭"；内容包含"诱因"',
//     preview: '慢性心衰急性加重的诱因...'
//   }
// ]
```

### 匹配规则
1. **标题匹配** (+10分): 卡片标题与笔记标题匹配
2. **章节匹配** (+8分): 来源章节相同
3. **关键词匹配** (+3-5分): 内容包含相同术语
4. **hints 匹配** (+4分): 提示词匹配

---

## 4. 笔记 → AI 提取关键点 → 生成卡片 🤖

### 使用场景
长篇笔记智能提取核心概念，生成高质量卡片。

### 使用方法
```typescript
import { aiExtractAndGenerate } from './core/cardAutoGeneration';

const suggestions = aiExtractAndGenerate(noteContent);

// AI 推荐：
// - "心衰诱因"（重要度 0.9）
// - "临床表现"（重要度 0.85）
// - "治疗原则"（重要度 0.8）

// 用户确认后生成
const cards = confirmAndGenerate(suggestions);
```

---

## 5. 做题错误 → 推荐相关笔记 📚

### 使用场景
做错题后，推荐相关笔记复习薄弱知识点。

### 使用方法
```typescript
import { recommendNotesForMistake } from './core/mistakeNoteRecommendation';

const notes = recommendNotesForMistake(mistake, allNotes, 3);

// 返回：
// [
//   {
//     path: 'notes/心力衰竭.md',
//     relevance: 0.92,
//     reason: '章节匹配"心血管系统"；题干包含"心衰"；新鲜度加分',
//     preview: '慢性心力衰竭是指...'
//   }
// ]
```

### 推荐策略
- **章节优先**: 相同章节笔记优先推荐
- **关键词匹配**: 题干、答案、解析关键词匹配
- **新鲜度加分**: 30 天内修改的笔记优先
- **长度过滤**: 过短笔记（<100字）不推荐

---

## 6. AI 学习路径规划 🗺️

### 使用场景
根据用户时间和薄弱点，自动生成个性化学习计划。

### 使用方法
```typescript
import { 
  generateLearningPath,
  generateTodayPlan,
  generateWeeklyLearningPlan
} from './core/learningPathPlanner';

// 今日计划（60 分钟）
const todayPlan = generateTodayPlan(learningReport, 60);

// 本周计划（每天 60 分钟）
const weekPlan = generateWeeklyLearningPlan(learningReport, 7, 60);

// 周末强化计划（3 小时）
const weekendPlan = generateWeekendIntensivePlan(learningReport);
```

### 计划结构
```typescript
{
  title: '今日学习计划：巩固心血管薄弱点',
  goal: '复习 5 张到期卡片，学习 2 个薄弱知识点，练习 10 道相关题目',
  totalMinutes: 60,
  estimatedCompletion: '预计 18:30 完成',
  steps: [
    {
      type: 'review',
      description: '复习到期卡片',
      cards: ['card1', 'card2'],
      estimatedMinutes: 15
    },
    {
      type: 'note',
      description: '学习笔记：心力衰竭诱因',
      note: { path: '...', title: '...' },
      estimatedMinutes: 20
    },
    {
      type: 'practice',
      description: '练习心血管系统题目',
      chapter: '心血管系统',
      count: 10,
      estimatedMinutes: 20
    }
  ]
}
```

### 规划策略
1. **到期卡片优先**: 必须复习到期卡片
2. **薄弱点强化**: 正确率低的章节优先学习
3. **错题复习**: 推荐相关错题练习
4. **时间优化**: 根据可用时间动态调整
5. **周期调整**: 每 3 天增加复习比重

---

## 7. 复习时展示关联题目 🎯

### 使用场景
复习卡片时，推荐相关题目进行练习巩固。

### 使用方法
```typescript
import { findRelatedQuizzes } from './core/cardRelatedQuizzes';

const quizzes = findRelatedQuizzes(card, allQuestions, 3);

// 返回：
// [
//   {
//     qid: 'q123',
//     relevance: 0.88,
//     reason: '笔记标题匹配章节"心血管系统"；题干包含"心衰"',
//     preview: '慢性心力衰竭最常见的诱因是...'
//   }
// ]
```

### 匹配规则
- **章节匹配**: 卡片章节与题目章节一致
- **关键词匹配**: 标题、内容关键词匹配题干/答案
- **hints 匹配**: 提示词在题干中出现

---

## 8. 成就系统 🏆

### 使用场景
记录学习里程碑，提供正向激励。

### 使用方法
```typescript
import { 
  checkAchievements,
  getAchievementSummary,
  getNearbyAchievements
} from './core/achievementSystem';

// 检查成就
const result = checkAchievements(stats, previousAchievements);

// 新解锁成就
result.newlyUnlocked.forEach(achievement => {
  showNotification(`🎉 解锁成就：${achievement.name}`);
});

// 成就统计
const summary = getAchievementSummary(result.achievements);
// {
//   totalUnlocked: 8,
//   totalAchievements: 23,
//   unlockedByTier: { 1: 2, 2: 3, 3: 2, 4: 1, 5: 0 }
// }

// 接近解锁的成就（进度 >= 80%）
const nearby = getNearbyAchievements(result.achievements);
```

### 成就类型

#### 连续学习成就 🔥
- **初心不改**: 连续 3 天（⭐）
- **一周坚持**: 连续 7 天（⭐⭐）
- **月度冠军**: 连续 30 天（⭐⭐⭐）
- **百日修炼**: 连续 100 天（⭐⭐⭐⭐）
- **全年无休**: 连续 365 天（⭐⭐⭐⭐⭐）

#### 里程碑成就 📚
- **笔记新手**: 10 篇（⭐）
- **勤奋记录者**: 50 篇（⭐⭐）
- **知识宝库**: 100 篇（⭐⭐⭐）
- **复习先锋**: 100 次复习（⭐⭐）
- **复习大师**: 500 次复习（⭐⭐⭐）
- **题海初探**: 100 道题（⭐⭐）
- **刷题达人**: 500 道题（⭐⭐⭐）
- **题库征服者**: 1000 道题（⭐⭐⭐⭐）

#### 掌握度成就 🎖️
- **记忆精准**: 复习正确率 90%（⭐⭐⭐）
- **答题高手**: 做题正确率 80%（⭐⭐⭐）
- **完美主义者**: 50 张卡片首次满分（⭐⭐⭐）
- **知错能改**: 改正 50 个错题（⭐⭐）

#### 速度成就 ⚡
- **专注战士**: 单日学习 3 小时（⭐⭐）
- **学习狂人**: 单日学习 5 小时（⭐⭐⭐）

#### 挑战成就 🌟
- **周末战士**: 周末连续学习（⭐⭐）
- **全能学者**: 一周内完成笔记+复习+做题（⭐⭐⭐）

---

## 完整学习流程示例

### 场景：学习"心力衰竭"主题

#### 1. 创建笔记
```markdown
# 心力衰竭

## 诱因
- 感染（最常见）
- 心律失常
- 过度劳累
- 输液过快

## 症状
- 呼吸困难
- 水肿
- 乏力
```

#### 2. 自动生成卡片
系统自动提取：
- 卡片 1: "心力衰竭诱因"
- 卡片 2: "心力衰竭症状"

#### 3. 做题练习
做题遇到错误：
- 题目: "心衰最常见诱因是？"
- 选错: "心律失常"
- 正确: "感染"

#### 4. 生成错题卡片
系统自动生成错题卡片：
- 标题: "心衰最常见诱因"
- 内容: 错误原因分析

#### 5. 获得推荐
- **笔记推荐**: "心力衰竭" 笔记（匹配度 0.95）
- **题目推荐**: 5 道相关题目

#### 6. 生成学习计划
系统生成今日计划：
1. 复习到期卡片（15 分钟）
2. 学习笔记：心力衰竭（20 分钟）
3. 练习心血管题目（20 分钟）

#### 7. 解锁成就
- 🎉 解锁"笔记新手"（10 篇笔记）
- 🎉 解锁"一周坚持"（连续 7 天）

---

## API 参考

### 核心模块

| 模块 | 文件 | 主要函数 |
|---|---|---|
| 卡片自动生成 | `cardAutoGeneration.ts` | `generateCardsFromNote`, `batchGenerateCards` |
| 错题卡片生成 | `mistakeCardGeneration.ts` | `generateCardFromMistake`, `batchGenerateMistakeCards` |
| 卡片笔记推荐 | `cardNoteRecommendation.ts` | `findRelatedNotes`, `batchFindRelatedNotes` |
| 错题笔记推荐 | `mistakeNoteRecommendation.ts` | `recommendNotesForMistake` |
| 学习路径规划 | `learningPathPlanner.ts` | `generateLearningPath`, `generateTodayPlan`, `generateWeeklyLearningPlan` |
| 卡片题目推荐 | `cardRelatedQuizzes.ts` | `findRelatedQuizzes`, `quickFindRelatedQuizzes` |
| 成就系统 | `achievementSystem.ts` | `checkAchievements`, `getAchievementSummary`, `getNearbyAchievements` |

### 数据结构

详见各模块的 TypeScript 类型定义。

---

## 最佳实践

### 1. 笔记编写
- 使用清晰的标题结构（H2/H3）
- 重要内容使用加粗或列表
- 添加知识点标签

### 2. 卡片管理
- 定期复习到期卡片
- 查看关联笔记加深理解
- 练习关联题目巩固

### 3. 做题策略
- 错题立即查看推荐笔记
- 理解错误原因
- 定期复习错题卡片

### 4. 学习规划
- 每天使用 AI 生成学习计划
- 优先完成到期任务
- 关注薄弱章节

### 5. 成就激励
- 查看接近解锁的成就
- 设定短期目标（如连续学习 7 天）
- 庆祝每个里程碑

---

## 常见问题

### Q: 如何提高推荐准确度？
A: 
- 笔记使用规范的章节标题
- 卡片添加 hints 关键词
- 题目添加 chapter 章节信息

### Q: 学习计划如何调整？
A: 
- 使用 `prioritizeReview: true` 优先复习
- 调整 `availableMinutes` 控制计划长度
- 使用 `generateWeeklyLearningPlan` 生成长期计划

### Q: 成就如何更新？
A: 
- 每次学习后调用 `checkAchievements`
- 传入最新的学习统计数据
- 保留 `previousAchievements` 避免重复解锁

---

**版本**: 1.0.0  
**更新日期**: 2026-10-18  
**维护者**: KNOWLATTICE Team
