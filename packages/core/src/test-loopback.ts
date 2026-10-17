/**
 * In-memory test double that carries acceptance envelopes between profiles.
 * Invite tests still use this harness. Club events use the local relay.
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
