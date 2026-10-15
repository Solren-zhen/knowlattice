/**
 * 「未被引用的附件」判定（core/attachmentOrphans）。守三件事：
 *   ① 认得正文里的各种引用写法（`![](...)`、`[文字](...)`、`![[名]]`、`[[名|显示]]`、%20 变体、
 *      甚至代码块里提到的路径）——**判错的方向必须是「当成有人在用」**，少删一个只是没省空间，
 *      误删一个会让正文留下破图；
 *   ② 全角括号与句尾标点不能把路径截断（库里真有「旧笔记（恢复 2026-10-13 2215）.md」这类名字，
 *      按全角右括号截断就会把被引用的图算成孤儿）；
 *   ③ 只有真孤儿进清单，且去重、按路径升序（界面列表才稳定）。
 */
import { describe, expect, it } from 'vitest';
import { findOrphanAttachments, referencedAttachments } from '../attachmentOrphans';

const A = '_attachments/甲.png';
const B = '_attachments/图/乙.png';
/** 空格 + 全角括号：刻意挑最容易把 token 截断的名字 */
const S = '_attachments/第一讲 呼吸（上）.png';
const ORPHAN = '_attachments/没人要.png';
const ALL = [A, B, S, ORPHAN];

/** 用 Set 比较，避免把「按码点升序」的细节写进每条断言 */
const orphanSet = (notes: string[]) => new Set(findOrphanAttachments(ALL, notes).orphans);

describe('未引用附件判定', () => {

  it('正文之外的引用（音频/字幕挂载、题库题图）也算「有人在用」——只看正文会误删', () => {
    // 这类引用在正文里**没有任何字符串**：挂载表（noteMedia）与题库存储各自记着路径。
    // 传进来就必须保住：漏掉它们等于把用户挂着的音频/字幕当垃圾删掉。
    const r = findOrphanAttachments(ALL, [], [S]);
    expect(new Set(r.orphans)).toEqual(new Set([A, B, ORPHAN]));
    expect(r.referenced).toBe(1);
    // 库里不存在的路径传进来不会凭空「保护」什么，也不多算计数
    expect(findOrphanAttachments(ALL, [], ['_attachments/并不存在.mp3']).orphans.length).toBe(4);
  });
  it('认得标准写法：![](...) 与 [文字](...)', () => {
    expect(orphanSet([`看图：![](${A})`, `报告：[报告](${B})`])).toEqual(new Set([S, ORPHAN]));
  });

  it('认得双链/嵌入：![[名]]、![[_attachments/…]]、[[名|显示]] 都按应用的解析规则算引用', () => {
    // 只写文件名 → 按 _attachments/<名> 解析（与 core/livePreview 的嵌入解析一致）
    expect(orphanSet(['![[甲.png]]'])).toEqual(new Set([B, S, ORPHAN]));
    // 目标本身就是附件路径
    expect(orphanSet([`![[${B}]]`])).toEqual(new Set([A, S, ORPHAN]));
    // 双链带显示名（显示名不参与解析）
    expect(orphanSet(['[[甲.png|看这张]]'])).toEqual(new Set([B, S, ORPHAN]));
  });

  it('全角括号/空格的名字不会被截断（这是本模块最容易写错的一处）', () => {
    expect(orphanSet([`![](${S})`])).toEqual(new Set([A, B, ORPHAN]));
  });

  it('%20 编码与句尾标点：两种写法都要认出来', () => {
    expect(orphanSet([`![]( _attachments/第一讲%20呼吸（上）.png )`])).toEqual(new Set([A, B, ORPHAN]));
    expect(orphanSet([`见 ![](${A})。`])).toEqual(new Set([B, S, ORPHAN]));
    expect(orphanSet([`见 ${B}，另外……`])).toEqual(new Set([A, S, ORPHAN]));
  });

  it('写在代码块/行内代码里的路径也算引用（保守：宁可少删）', () => {
    expect(orphanSet(['```\n' + B + '\n```'])).toEqual(new Set([A, S, ORPHAN]));
    expect(orphanSet([`\`${A}\``])).toEqual(new Set([B, S, ORPHAN]));
  });

  it('只有真孤儿进清单；重复给进来的路径不会重复列出；按路径升序', () => {
    const r = findOrphanAttachments([...ALL, A, A], [`![](${A})`]);
    expect(r.total).toBe(4); // 去重后的总数
    expect(r.referenced).toBe(1);
    // ASCII 名字下顺序可预期，单测一条真升序
    expect(findOrphanAttachments(['_attachments/z.png', '_attachments/a.png'], []).orphans)
      .toEqual(['_attachments/a.png', '_attachments/z.png']);
  });

  it('正文里提到但库里不存在的路径不算「被引用」（否则清单会永远漏掉真孤儿）', () => {
    expect(referencedAttachments([`![](_attachments/并不存在.png)`], ALL)).toEqual(new Set());
  });

  it('空输入安全：没有附件、没有笔记、正文为空串都返回空清单', () => {
    expect(findOrphanAttachments([], [])).toEqual({ orphans: [], referenced: 0, total: 0 });
    expect(findOrphanAttachments(ALL, ['', '   '])).toEqual({
      orphans: [A, B, ORPHAN, S].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
      referenced: 0,
      total: 4,
    });
  });
});
