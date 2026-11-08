/**
 * Fan-out for live build logs.
 *
 * The pipeline writes a line -> the hub asks the database for the stored text
 * only once (on subscribe) and then pushes deltas. Kept tiny on purpose: it is
 * a Map of sets, nothing more.
 */
export class LogHub {
  private readonly subscribers = new Map<number, Set<(line: string) => void>>();

  publish(deploymentId: number, line: string): void {
    const set = this.subscribers.get(deploymentId);
    if (!set) return;

    for (const callback of set) {
      try {
        callback(line);
      } catch {
        // A dead socket must not stop the others.
      }
    }
  }

  subscribe(deploymentId: number, callback: (line: string) => void): () => void {
    const set = this.subscribers.get(deploymentId) ?? new Set<(line: string) => void>();
    set.add(callback);
    this.subscribers.set(deploymentId, set);

    return () => {
      const current = this.subscribers.get(deploymentId);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) this.subscribers.delete(deploymentId);
    };
  }

  size(): number {
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }
}
