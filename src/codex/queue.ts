const turnQueues = new Map<string, Promise<any>>();
const turnTaskCounts = new Map<string, number>();

export function queueTurnTask(turnId: string, task: () => Promise<any>): Promise<any> {
  const previous = turnQueues.get(turnId) || Promise.resolve();
  turnTaskCounts.set(turnId, (turnTaskCounts.get(turnId) || 0) + 1);

  const next = previous.then(() => task()).catch((err) => {
    console.error(`Error executing task in queue for turn ${turnId}:`, err);
  }).finally(() => {
    const count = (turnTaskCounts.get(turnId) || 0) - 1;
    if (count <= 0) {
      turnTaskCounts.delete(turnId);
      turnQueues.delete(turnId);
    } else {
      turnTaskCounts.set(turnId, count);
    }
  });
  turnQueues.set(turnId, next);
  return next;
}
