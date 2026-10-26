import { useEffect } from 'react'
import { useTaskStore } from '@/stores/taskStore'

export function useScheduledTasksSync(ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const refresh = () => {
      if (document.visibilityState === 'hidden' || useTaskStore.getState().isLoading) return
      void useTaskStore.getState().fetchTasks()
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, 30_000)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(timer)
    }
  }, [ready])
}
