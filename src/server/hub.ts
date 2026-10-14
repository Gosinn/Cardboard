/**
 * Fans committed events out to live watchers (server-sent event streams).
 * Box changes go out on `box:<id>`, dock parcels on `dock:<id>`. Each watcher
 * decides with `accept` which events are for it. Revoking a tape, undocking
 * or shredding closes the matching streams immediately.
 */
export interface Watcher {
  channel: string;
  boxId: string;
  tapeId: string | null;
  accept: (event: any) => boolean;
  send: (event: unknown) => void;
  close: () => void;
}

export class Hub {
  private readonly watchers = new Set<Watcher>();

  subscribe(watcher: Watcher): () => void {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  publish(channel: string, event: unknown) {
    for (const w of this.watchers) {
      if (w.channel !== channel) continue;
      try {
        if (w.accept(event)) w.send(event);
      } catch {
        // One broken stream must not stop the others.
      }
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
