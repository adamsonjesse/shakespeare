/**
 * In-memory test double that carries acceptance envelopes between profiles.
 * Milestone 6 replaces this. It is not the product transport.
 */
export class TestLoopback {
  private readonly queues = new Map<string, string[]>();

  send(toPublicKey: string, envelope: string): void {
    const queue = this.queues.get(toPublicKey) ?? [];
    queue.push(envelope);
    this.queues.set(toPublicKey, queue);
  }

  receive(publicKey: string): string[] {
    const queue = this.queues.get(publicKey) ?? [];
    this.queues.set(publicKey, []);
    return queue;
  }
}
