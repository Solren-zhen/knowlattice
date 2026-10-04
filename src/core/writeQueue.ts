/**
 * 同路径写串行队列。
 *
 * 背景（2026-10-04 审计 H2）：保存是异步的，两次写同一文件可能在磁盘上交错——
 * Tauri 端是「先写 .tmp 再 rename」，后完成的 rename 覆盖先完成的，于是
 * 「先发出的新内容」可能被「后发出的旧内容」吃掉。按路径排队后，同一路径的
 * 写入严格按调用顺序落盘；不同路径互不等待，不影响批量导入的吞吐。
 */

/** path → 该路径上最后一个落盘 Promise（完成信号，不带异常） */
const writeQueues = new Map<string, Promise<void>>();

/** 把 op 排到该路径的写入链尾，返回 op 本身的 Promise（成功/失败都原样透传）。
 *  前一次写失败只影响它自己的调用方，不会阻塞后续写。 */
export function enqueueWrite<T>(path: string, op: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.then(op, op);
  writeQueues.set(path, next.then(() => undefined, () => undefined));
  // 链上存的是「完成信号」，rejection 已在 next 里由调用方承接；这里兜住避免 unhandled
  void next.catch(() => {});
  return next;
}

/** 测试用：清空队列状态（各用例间隔离） */
export function resetWriteQueuesForTests(): void {
  writeQueues.clear();
}
