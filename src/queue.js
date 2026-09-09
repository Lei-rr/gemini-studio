/**
 * 高并发排队调度器 (FIFO Queue with Concurrency Limit)
 * 保护上游服务不被压垮，支持大量用户同时提交请求并按序分配通道
 */
class ConcurrencyQueue {
  constructor(maxConcurrent = 10, maxQueueLength = 100) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueueLength = maxQueueLength;
    this.activeWorkers = 0;
    this.waitingQueue = [];
    this.totalProcessed = 0;
  }

  get stats() {
    return {
      activeWorkers: this.activeWorkers,
      waitingCount: this.waitingQueue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueLength: this.maxQueueLength,
      totalProcessed: this.totalProcessed,
    };
  }

  /**
   * 获取执行令牌 (Promise)，如当前无并发余量则进入排队队列
   */
  acquire() {
    return new Promise((resolve, reject) => {
      // 1. 并发未达上限，立即放行
      if (this.activeWorkers < this.maxConcurrent) {
        this.activeWorkers++;
        return resolve(() => this.release());
      }

      // 2. 队列满载，防御性熔断
      if (this.waitingQueue.length >= this.maxQueueLength) {
        return reject(new Error(`生图通道繁忙，排队队列已满 (${this.maxQueueLength}人)，请稍后重试`));
      }

      // 3. 进入排队队列
      this.waitingQueue.push({
        resolve: () => {
          this.activeWorkers++;
          resolve(() => this.release());
        },
        reject,
      });
    });
  }

  /**
   * 任务完成或异常中断，释放令牌并调度下一个排队任务
   */
  release() {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    this.totalProcessed++;

    if (this.waitingQueue.length > 0 && this.activeWorkers < this.maxConcurrent) {
      const nextTask = this.waitingQueue.shift();
      if (nextTask) {
        nextTask.resolve();
      }
    }
  }
}

module.exports = ConcurrencyQueue;
