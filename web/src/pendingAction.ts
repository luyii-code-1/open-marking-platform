export class PendingAction {
  key: string | null = null

  async run<T>(key: string, work: () => Promise<T>, changed: (key: string | null) => void): Promise<T | undefined> {
    if (this.key !== null) return
    this.key = key
    changed(key)
    try { return await work() }
    finally { this.key = null; changed(null) }
  }
}
