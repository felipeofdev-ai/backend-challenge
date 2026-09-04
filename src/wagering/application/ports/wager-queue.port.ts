/**
 * Port for enqueueing wager commands (HTTP enqueue mode).
 */
export interface WagerQueuePort {
  enqueue(body: string, groupId: string, dedupId: string): Promise<void>;
}
