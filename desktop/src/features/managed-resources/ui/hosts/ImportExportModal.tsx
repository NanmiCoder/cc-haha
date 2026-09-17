import { useRef, useState } from 'react'
import { Download, Upload, ShieldCheck, CheckCircle, AlertCircle } from 'lucide-react'
import { useTranslation } from '../../../../i18n'
import { getDesktopHost } from '../../../../lib/desktopHost'
import { useHostManagementStore } from '../../stores/hostManagementStore'
import { Modal } from '../../../../components/ui/Modal'
import { Button } from '../../../../components/ui/Button'
import { resourceErrorMessage } from './resourceErrorMessage'

export type ImportExportModalProps = {
  onClose: () => void
}

export function ImportExportModal({ onClose }: ImportExportModalProps) {
  const t = useTranslation()
  const { fetchHosts, fetchTags } = useHostManagementStore()
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const pending = useRef(false)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleExport = async () => {
    if (pending.current) return
    pending.current = true
    setExporting(true)
    setStatusMessage(null)
    try {
      const res = await getDesktopHost().hostManagement.exportMetadata()
      if (res.ok && res.data) {
        setStatusMessage({ type: 'success', text: t('managedResources.m2.exportComplete', { count: res.data.count, path: res.data.filePath }) })
      } else if (!res.ok && res.error.code !== 'CANCELLED') {
        setStatusMessage({ type: 'error', text: resourceErrorMessage(t, res.error) })
      }
    } catch {
      setStatusMessage({ type: 'error', text: resourceErrorMessage(t) })
    } finally {
      pending.current = false
      setExporting(false)
    }
  }

  const handleImport = async () => {
    if (pending.current) return
    pending.current = true
    setImporting(true)
    setStatusMessage(null)
    try {
      const res = await getDesktopHost().hostManagement.importMetadata()
      if (res.ok && res.data) {
        setStatusMessage({ type: 'success', text: t('managedResources.m2.importComplete', { count: res.data.count }) })
        await fetchHosts()
        await fetchTags()
      } else if (!res.ok && res.error.code !== 'CANCELLED') {
        setStatusMessage({ type: 'error', text: resourceErrorMessage(t, res.error) })
      }
    } catch {
      setStatusMessage({ type: 'error', text: resourceErrorMessage(t) })
    } finally {
      pending.current = false
      setImporting(false)
    }
  }

  const handleClose = () => { if (!pending.current) onClose() }

  return (
    <Modal
      open
      onClose={handleClose}
      closeLabel={t('common.close')}
      title={t('managedResources.importExport') || '资源元数据 导入 / 导出'}
      width={480}
      footer={(
        <Button
          type="button"
          variant="secondary"
          onClick={handleClose}
          disabled={exporting || importing}
        >
          {t('common.close') || '关闭'}
        </Button>
      )}
    >
      <div className="flex flex-col gap-4 text-xs">
        {/* Security Banner */}
        <div className="flex items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container)] p-3 text-[var(--color-text-secondary)]">
          <ShieldCheck size={18} className="mt-0.5 text-[var(--color-brand)] flex-shrink-0" />
          <div>
            <span className="font-semibold text-[var(--color-text-primary)]">
              {t('managedResources.securityRedactionTitle') || '安全去敏机制'}
            </span>
            <p className="mt-0.5 leading-relaxed">
              {t('managedResources.securityRedactionDesc') ||
                '导出的 JSON 仅包含主机结构、标签与应用定义，绝不包含密码、私钥明文或 safeStorage 密文。导入时如检测到凭据数据将直接阻断。'}
            </p>
          </div>
        </div>

        {statusMessage && (
          <div
            role={statusMessage.type === 'error' ? 'alert' : 'status'}
            className={`flex items-center gap-2 rounded-[var(--radius-md)] p-3 ${
              statusMessage.type === 'success'
                ? 'bg-[var(--color-surface-container)] text-[var(--color-brand)]'
                : 'border border-[var(--color-error)] bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
            }`}
          >
            {statusMessage.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
            <span>{statusMessage.text}</span>
          </div>
        )}

        <div className="flex flex-col gap-3 pt-2">
          <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 bg-[var(--color-surface)]">
            <div>
              <span className="font-semibold text-[var(--color-text-primary)]">
                {t('managedResources.exportMetadata') || '导出资源清单'}
              </span>
              <p className="text-[11px] text-[var(--color-text-tertiary)]">
                {t('managedResources.exportMetadataDesc') || '导出为主机、标签与应用脱敏 JSON 文件'}
              </p>
            </div>
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={exporting}
              disabled={importing}
              icon={<Download size={14} />}
              onClick={handleExport}
            >
              {exporting
                ? (t('managedResources.exporting') || '导出中...')
                : (t('managedResources.exportJson') || '导出 JSON')}
            </Button>
          </div>

          <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] p-3 bg-[var(--color-surface)]">
            <div>
              <span className="font-semibold text-[var(--color-text-primary)]">
                {t('managedResources.importMetadata') || '导入资源清单'}
              </span>
              <p className="text-[11px] text-[var(--color-text-tertiary)]">
                {t('managedResources.importMetadataDesc') || '合并或更新现有主机与标签定义'}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={importing}
              disabled={exporting}
              icon={<Upload size={14} />}
              onClick={handleImport}
            >
              {importing
                ? (t('managedResources.importing') || '导入中...')
                : (t('managedResources.importSelectFile') || '选择文件导入')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
