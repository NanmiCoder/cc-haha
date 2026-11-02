import { useEffect } from 'react'
import { NewTaskModal } from '@/components/tasks/NewTaskModal'
import { Modal } from '@/components/ui/Modal'
import { ErrorState } from '@/components/ui/ErrorState'
import { Spinner } from '@/components/ui/Spinner'
import { useTaskStore } from '@/stores/taskStore'
import { useTranslation } from '@/i18n'

/** One editor shared by task rows, transcript cards and schedule triggers. */
export function TaskEditorHost() {
  const { editorTaskId, closeTaskEditor, tasks, loaded, error, fetchTasks } = useTaskStore()
  const t = useTranslation()
  useEffect(() => {
    if (editorTaskId) void fetchTasks()
  }, [editorTaskId, fetchTasks])
  if (!editorTaskId) return null
  const task = tasks.find(entry => entry.id === editorTaskId)
  if (task) return <NewTaskModal key={editorTaskId} open editTask={task} onClose={closeTaskEditor} />
  return <Modal open onClose={closeTaskEditor} title={t('tasks.editTitle')}>
    {!loaded && !error ? <Spinner label={t('common.loading')} /> :
      <ErrorState title={error ? t('scheduledChat.unavailable') : t('scheduledChat.deleted')} detail={error ?? undefined} onRetry={() => void fetchTasks()} retryLabel={t('common.retry')} />}
  </Modal>
}
