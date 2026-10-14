import type { Change } from "./vault.ts";

export interface Watcher {
  boxId: string;
  tapeId: string | null;
  prefix: string;
  send: (change: Omit<Change, "boxId">) => void;
  close: () => void;
}

/** Fans committed changes out to live watchers. Revoking a tape closes its streams immediately. */
export class Hub {
  private readonly watchers = new Set<Watcher>();

  subscribe(watcher: Watcher): () => void {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  publish(change: Change) {
    const { boxId, ...event } = change;
    for (const w of this.watchers) {
      if (w.boxId === boxId && event.key.startsWith(w.prefix)) w.send(event);
    }
  }

  closeWhere(predicate: (w: Watcher) => boolean) {
    for (const w of [...this.watchers]) {
      if (predicate(w)) {
        this.watchers.delete(w);
        w.close();
      }
    }
  }

  get size() {
    return this.watchers.size;
  }
}
