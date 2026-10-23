/** URLs for the local SQS queues; read at runtime so deployments can override them. */
export function queueUrls() {
  return {
    wagers: process.env.WAGER_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo',
    deadLetters: process.env.WAGER_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    events: process.env.EVENT_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-events.fifo',
  };
}
