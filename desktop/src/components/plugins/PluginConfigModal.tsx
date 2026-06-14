import { useEffect, useState } from 'react'
import { Modal } from '../shared/Modal'
import { Button } from '../shared/Button'
import { useUIStore } from '../../stores/uiStore'
import { pluginsApi } from '../../api/plugins'

type OptionSchema = {
  type: string
  title?: string
  description?: string
  required?: boolean
  sensitive?: boolean
  default?: unknown
}

type Props = {
  open: boolean
  pluginId: string
  pluginName: string
  schema: Record<string, OptionSchema>
  onClose: () => void
  onSaved?: () => void
}

export function PluginConfigModal({
  open,
  pluginId,
  pluginName,
  schema,
  onClose,
  onSaved,
}: Props) {
  const addToast = useUIStore((s) => s.addToast)
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)

  // Load existing values when modal opens (only on open transition)
  const [wasOpen, setWasOpen] = useState(false)
  useEffect(() => {
    if (!open || wasOpen) return
    setWasOpen(true)
    setFetching(true)
    pluginsApi
      .getOptions(pluginId)
      .then((res) => {
        const merged: Record<string, string> = {}
        const masked = new Set<string>()
        for (const key of Object.keys(schema)) {
          const existing = res.values[key]
          if (schema[key]?.sensitive && existing === '********') {
            masked.add(key)
          }
          merged[key] = existing != null ? String(existing) : ''
        }
        setValues(merged)
        setMaskedKeys(masked)
      })
      .catch(() => {
        const empty: Record<string, string> = {}
        for (const key of Object.keys(schema)) {
          empty[key] = ''
        }
        setValues(empty)
      })
      .finally(() => setFetching(false))
  }, [open, wasOpen, pluginId, schema])

  // Reset wasOpen when modal closes
  useEffect(() => {
    if (!open && wasOpen) {
      setWasOpen(false)
    }
  }, [open, wasOpen])

  // Track which values came from the server as masked '********' so we can skip them on save
  const [maskedKeys, setMaskedKeys] = useState<Set<string>>(new Set())

  const handleSave = async () => {
    setLoading(true)
    try {
      // Filter out sensitive fields that user didn't modify (still contain mask value)
      const toSave: Record<string, string> = {}
      for (const [key, value] of Object.entries(values)) {
        if (maskedKeys.has(key) && value === '********') {
          continue // Don't overwrite real API key with mask string
        }
        toSave[key] = value
      }
      await pluginsApi.saveOptions(pluginId, toSave)
      addToast({ type: 'success', message: `${pluginName} configuration saved` })
      onSaved?.()
      onClose()
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save configuration',
      })
    } finally {
      setLoading(false)
    }
  }

  const entries = Object.entries(schema)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Configure ${pluginName}`}
      width={520}
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} loading={loading}>
            <span className="material-symbols-outlined text-[16px]">save</span>
            Save
          </Button>
        </div>
      }
    >
      {fetching ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin w-5 h-5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            Configure options for <span className="font-semibold">{pluginName}</span>.
            Sensitive values are stored securely.
          </p>

          {entries.map(([key, field]) => (
            <div key={key} className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-[var(--color-text-primary)]">
                {field.title || key}
                {field.required && (
                  <span className="text-[var(--color-error)] ml-1">*</span>
                )}
                {field.sensitive && (
                  <span className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
                    <span className="material-symbols-outlined text-[10px]">lock</span>
                    secure
                  </span>
                )}
              </label>

              {field.description && (
                <p className="text-xs text-[var(--color-text-tertiary)] leading-4">
                  {field.description}
                </p>
              )}

              {field.type === 'boolean' ? (
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={values[key] === 'true'}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [key]: String(e.target.checked) }))
                    }
                    className="h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-brand)] accent-[var(--color-brand)]"
                  />
                  <span className="text-sm text-[var(--color-text-secondary)]">
                    {values[key] === 'true' ? 'Enabled' : 'Disabled'}
                  </span>
                </label>
              ) : field.type === 'string' && key.toLowerCase().includes('json') ? (
                <textarea
                  value={values[key] || ''}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  placeholder={field.default != null ? String(field.default) : ''}
                  rows={4}
                  spellCheck={false}
                  className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)] focus:outline-none resize-y"
                />
              ) : field.type === 'directory' || field.type === 'file' ? (
                <input
                  type="text"
                  value={values[key] || ''}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  placeholder={field.default != null ? String(field.default) : field.type === 'directory' ? '/path/to/directory' : '/path/to/file'}
                  spellCheck={false}
                  className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)] focus:outline-none"
                />
              ) : (
                <input
                  type={field.sensitive ? 'password' : 'text'}
                  value={values[key] || ''}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [key]: e.target.value }))
                  }
                  placeholder={field.default != null ? String(field.default) : ''}
                  spellCheck={false}
                  className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)] focus:outline-none"
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
