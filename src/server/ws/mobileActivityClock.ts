/** In-memory timing from accepted turns and actual CLI output, never transcript mtimes. */
export type MobileActivityTiming = { startedAt: number; lastProgressAt: number; completedAt?: number }
export class MobileActivityClock {
  private entries = new Map<string, MobileActivityTiming>()
  constructor(private now: () => number = Date.now) {}
  start(id: string) {
    const now=this.now()
    this.entries.delete(id)
    this.entries.set(id,{startedAt:now,lastProgressAt:now})
    while(this.entries.size>5000) this.entries.delete(this.entries.keys().next().value!)
  }
  progress(id: string) {
    const value=this.entries.get(id)
    if(value && value.completedAt===undefined) value.lastProgressAt=this.now()
  }
  finish(id: string) {
    const value=this.entries.get(id)
    if(value && value.completedAt===undefined) { value.lastProgressAt=this.now();value.completedAt=value.lastProgressAt }
  }
  read(id: string): MobileActivityTiming | undefined { const value=this.entries.get(id);return value?{...value}:undefined }
  delete(id: string) { this.entries.delete(id) }
  clear(){this.entries.clear()}
}
export const mobileActivityClock = new MobileActivityClock()
export const getMobileActivityTiming = (id: string) => mobileActivityClock.read(id)
