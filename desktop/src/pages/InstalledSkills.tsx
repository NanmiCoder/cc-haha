import { useEffect } from 'react'
import { SkillList } from '@/components/skills/SkillList'
import { SkillDetail } from '@/components/skills/SkillDetail'
import { useSkillStore } from '@/stores/skillStore'
import { useSessionStore } from '@/stores/sessionStore'

/** Reuses Settings' installed skill browser and its existing uninstall flow. */
export function InstalledSkills() {
  const selectedSkill = useSkillStore((state) => state.selectedSkill)
  const selectedSkillContext = useSkillStore((state) => state.selectedSkillContext)
  const isDetailLoading = useSkillStore((state) => state.isDetailLoading)
  const clearSelection = useSkillStore((state) => state.clearSelection)
  const currentWorkDir = useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId)?.workDir || '',
  )

  // Settings and this view share selection. Enter at the list, and invalidate
  // pending detail requests whenever the active project changes or we leave.
  useEffect(() => {
    clearSelection()
    return clearSelection
  }, [clearSelection, currentWorkDir])

  const showingDetail = selectedSkillContext === currentWorkDir && (selectedSkill || isDetailLoading)
  return showingDetail ? <SkillDetail embedded /> : <SkillList compact />
}
