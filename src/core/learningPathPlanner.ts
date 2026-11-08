/**
 * AI 学习路径规划
 *
 * 场景：基于用户的学习历史、掌握度、薄弱点，规划个性化学习路径
 */

import type { WeeklyReport } from './learningDashboard';

export interface LearningPathStep {
  /** 步骤序号 */
  step: number;
  /** 学习活动类型 */
  type: 'review' | 'practice' | 'study' | 'consolidate';
  /** 活动描述 */
  description: string;
  /** 目标章节/主题 */
  target?: string;
  /** 估计时长（分钟） */
  estimatedMinutes: number;
  /** 优先级 1-3（3 最高） */
  priority: 1 | 2 | 3;
  /** 推荐资源（笔记路径、题库 ID 等） */
  resources?: string[];
}

export interface LearningPath {
  /** 路径标题 */
  title: string;
  /** 路径目标 */
  goal: string;
  /** 总估计时长（分钟） */
  totalMinutes: number;
  /** 学习步骤 */
  steps: LearningPathStep[];
  /** 生成时间 */
  generatedAt: number;
}

/**
 * 根据周度学习报告生成学习路径
 *
 * @param report 周度学习报告
 * @param options 配置项
 * @returns 个性化学习路径
 */
export function generateLearningPath(
  report: WeeklyReport,
  options: {
    /** 目标时长（分钟），默认 120 */
    targetMinutes?: number;
    /** 是否优先复习（否则优先练习），默认 false */
    prioritizeReview?: boolean;
  } = {}
): LearningPath {
  const { targetMinutes = 120, prioritizeReview = false } = options;
  const steps: LearningPathStep[] = [];
  let currentStep = 1;
  let accumulatedMinutes = 0;

  // 策略 1: 优先处理待复习卡片（如果有紧急的）
  if (report.dueCards > 0) {
    const urgentReview = Math.min(report.dueCards, 20); // 单次不超过 20 张
    const minutes = Math.ceil(urgentReview * 1.5); // 平均 1.5 分钟/卡

    steps.push({
      step: currentStep++,
      type: 'review',
      description: `复习 ${urgentReview} 张到期卡片`,
      estimatedMinutes: minutes,
      priority: 3,
    });

    accumulatedMinutes += minutes;
  }

  // 策略 2: 针对薄弱点练习（优先级最高）
  for (const weak of report.weakPoints.slice(0, 2)) {
    // 最多针对前 2 个薄弱点
    const practiceCount = Math.ceil(weak.mistakeCount / 2); // 错几道，练几道
    const minutes = Math.max(15, practiceCount * 2); // 最少 15 分钟

    if (accumulatedMinutes + minutes > targetMinutes) break;

    steps.push({
      step: currentStep++,
      type: 'practice',
      description: `针对性练习：${weak.name}（已错 ${weak.mistakeCount} 次）`,
      target: weak.name,
      estimatedMinutes: minutes,
      priority: 3,
      resources: [`qbank:filter:chapter=${weak.name}`],
    });

    accumulatedMinutes += minutes;
  }

  // 策略 3: 复习薄弱章节的笔记（巩固理论）
  for (const weak of report.weakPoints.slice(0, 2)) {
    const minutes = 20;

    if (accumulatedMinutes + minutes > targetMinutes) break;

    steps.push({
      step: currentStep++,
      type: 'study',
      description: `复习笔记：${weak.name}`,
      target: weak.name,
      estimatedMinutes: minutes,
      priority: 2,
      resources: [`notes:search:${weak.name}`],
    });

    accumulatedMinutes += minutes;
  }

  // 策略 4: 如果还有时间，继续复习卡片或做题
  while (accumulatedMinutes < targetMinutes * 0.8) {
    // 预留 20% 缓冲
    if (prioritizeReview && report.dueCards > steps.length * 20) {
      // 还有更多待复习卡片
      steps.push({
        step: currentStep++,
        type: 'review',
        description: '继续复习卡片',
        estimatedMinutes: 20,
        priority: 2,
      });
      accumulatedMinutes += 20;
    } else if (report.masteryStats.quizCount > 0) {
      // 有做题历史，继续练习
      steps.push({
        step: currentStep++,
        type: 'practice',
        description: '综合练习（随机题目）',
        estimatedMinutes: 30,
        priority: 1,
        resources: ['qbank:random'],
      });
      accumulatedMinutes += 30;
    } else {
      // 初学者，建议学习新内容（只给一条：以前会重复塞到时间用完）
      if (steps.some((step) => step.description === '学习新笔记')) break;
      steps.push({
        step: currentStep++,
        type: 'study',
        description: '学习新笔记',
        estimatedMinutes: 30,
        priority: 1,
      });
      accumulatedMinutes += 30;
    }
  }

  // 策略 5: 巩固阶段（总结回顾）
  if (accumulatedMinutes < targetMinutes && steps.length > 0) {
    const remainingMinutes = Math.min(
      20,
      targetMinutes - accumulatedMinutes
    );

    steps.push({
      step: currentStep++,
      type: 'consolidate',
      description: '回顾今日学习内容，总结要点',
      estimatedMinutes: remainingMinutes,
      priority: 2,
    });

    accumulatedMinutes += remainingMinutes;
  }

  return {
    title: determinPathTitle(report, options),
    goal: determinePathGoal(report),
    totalMinutes: accumulatedMinutes,
    steps,
    generatedAt: Date.now(),
  };
}

/**
 * 生成多日学习路径（周计划）
 *
 * @param report 周度学习报告
 * @param days 计划天数（默认 7）
 * @param dailyMinutes 每日学习时长（默认 60）
 * @returns 每日学习路径
 */
export function generateWeeklyLearningPlan(
  report: WeeklyReport,
  days = 7,
  dailyMinutes = 60
): LearningPath[] {
  const plan: LearningPath[] = [];

  for (let day = 1; day <= days; day++) {
    // 根据日期调整策略
    const prioritizeReview = day % 3 === 0; // 每 3 天优先复习一次

    const dailyPath = generateLearningPath(report, {
      targetMinutes: dailyMinutes,
      prioritizeReview,
    });

    dailyPath.title = `Day ${day}: ${dailyPath.title}`;

    plan.push(dailyPath);
  }

  return plan;
}

/**
 * 根据报告确定路径标题
 */
function determinPathTitle(
  report: WeeklyReport,
  options: { prioritizeReview?: boolean }
): string {
  if (report.weakPoints.length > 0) {
    const primaryWeak = report.weakPoints[0].name;
    return `攻克薄弱点：${primaryWeak}`;
  }

  if (report.dueCards > 50) {
    return '清理复习积压';
  }

  if (options.prioritizeReview) {
    return '复习巩固日';
  }

  if (report.masteryStats.quizCount === 0) {
    return '知识探索之旅';
  }

  return '全面提升学习计划';
}

/**
 * 根据报告确定路径目标
 */
function determinePathGoal(report: WeeklyReport): string {
  const goals: string[] = [];

  if (report.weakPoints.length > 0) {
    const top2 = report.weakPoints.slice(0, 2).map((w) => w.name);
    goals.push(`提升「${top2.join('、')}」掌握度`);
  }

  if (report.dueCards > 0) {
    goals.push(`完成 ${report.dueCards} 张到期复习`);
  }

  if (report.masteryStats.quizCount > 0 && report.masteryStats.quizAccuracy < 0.7) {
    goals.push(`提升做题正确率至 70% 以上`);
  }

  if (goals.length === 0) {
    goals.push('保持学习节奏，稳步提升');
  }

  return goals.join('；');
}

/**
 * 快捷方法：生成今日学习计划
 */
export function generateTodayPlan(
  report: WeeklyReport,
  targetMinutes = 60
): LearningPath {
  return generateLearningPath(report, { targetMinutes });
}

/**
 * 快捷方法：生成周末强化计划
 */
export function generateWeekendIntensivePlan(
  report: WeeklyReport
): LearningPath {
  return generateLearningPath(report, {
    targetMinutes: 180, // 3 小时
    prioritizeReview: false, // 优先练习
  });
}
