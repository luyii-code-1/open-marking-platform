// Share simultaneous reads only. A refresh, session change or write can start a fresh request.
export class ResourceReads {
  private pending = new Map<string, Promise<unknown>>()

  invalidate() { this.pending.clear() }

  read<T>(token: string, path: string, load: () => Promise<T>, refresh = false): Promise<T> {
    const key = JSON.stringify([token, path])
    const existing = this.pending.get(key) as Promise<T> | undefined
    if (existing && !refresh) return existing.then(value => structuredClone(value))
    const result = load().finally(() => {
      if (this.pending.get(key) === result) this.pending.delete(key)
    })
    this.pending.set(key, result)
    return result
  }
}
