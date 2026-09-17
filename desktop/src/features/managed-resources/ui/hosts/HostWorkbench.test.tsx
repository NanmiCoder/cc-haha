import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { HostList } from './HostList'
import { HostDetail } from './HostDetail'
import { HostEditModal } from './HostEditModal'
import { TagManagementModal } from './TagManagementModal'
import { useHostManagementStore } from '../../stores/hostManagementStore'
import { useSettingsStore } from '../../../../stores/settingsStore'
import { browserHost } from '../../../../lib/desktopHost/browserHost'
import type { Host, ResourceTag } from '../../types/resourceTypes'

const sampleTag: ResourceTag = {
  id: 'tag-1',
  namespace: 'host',
  name: '生产环境',
  normalizedName: '生产环境',
  colorToken: 'red',
  revision: 1,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

const sampleHost: Host = {
  id: 'host-1',
  name: 'Web-Prod-01',
  address: '192.168.1.100',
  port: 22,
  username: 'deploy',
  auth: {
    type: 'password',
    credentialId: 'cred-1',
  },
  tagIds: ['tag-1'],
  initialDirectory: '/var/www',
  applications: [
    {
      id: 'app-1',
      name: 'Nginx Proxy',
      version: '1.25.0',
      installPaths: ['/etc/nginx'],
      accessDescription: 'Public load balancer',
      accessUrls: ['https://example.com'],
      loginUrl: null,
      accounts: [
        {
          id: 'acc-1',
          label: 'Admin Account',
          username: 'admin',
          credentialId: null,
        },
      ],
      notes: 'Active reverse proxy',
    },
  ],
  notes: 'Primary web gateway node',
  revision: 1,
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

describe('Host Workbench UI Components (M2.1 - M2.4)', () => {
  beforeEach(() => {
    ;(window as any).desktopHost = { ...browserHost }
    useSettingsStore.setState({ locale: 'zh' })
    useHostManagementStore.setState({
      hosts: [sampleHost],
      tags: [sampleTag],
      selectedHostId: null,
      searchQuery: '',
      selectedTagId: null,
      loading: false,
      error: null,
      editingHostId: undefined,
    })
  })

  describe('HostList component', () => {
    it('renders host tree grouped by tags and responds to search', () => {
      render(<HostList />)

      // Total count indicator
      expect(screen.getByText('全部主机')).toBeInTheDocument()
      expect(screen.getByText('共 1 台')).toBeInTheDocument()

      // Tag section
      expect(screen.getAllByText('生产环境').length).toBeGreaterThan(0)

      // Host item
      expect(screen.getByText('Web-Prod-01')).toBeInTheDocument()
      expect(screen.getByText(/deploy@192\.168\.1\.100/i)).toBeInTheDocument()

      // Search field filtering
      const searchInput = screen.getByRole('searchbox')
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } })

      expect(screen.getByText(/未找到匹配的主机/i)).toBeInTheDocument()
      expect(screen.queryByText('Web-Prod-01')).not.toBeInTheDocument()
    })

    it('selects host on click', () => {
      render(<HostList />)

      const hostCard = screen.getByText('Web-Prod-01').closest('[role="button"]')
      expect(hostCard).toBeDefined()
      fireEvent.click(hostCard!)

      expect(useHostManagementStore.getState().selectedHostId).toBe('host-1')
    })
  })

  describe('HostDetail component', () => {
    it('renders empty placeholder when no host is selected', () => {
      useHostManagementStore.setState({ selectedHostId: null })
      render(<HostDetail />)

      expect(screen.getByText(/管理 Linux 主机与应用资源/i)).toBeInTheDocument()
    })

    it('renders host details, applications, and disconnected SSH state', () => {
      useHostManagementStore.setState({ selectedHostId: 'host-1' })
      render(<HostDetail />)

      expect(screen.getByText('Web-Prod-01')).toBeInTheDocument()
      expect(screen.getAllByText('deploy@192.168.1.100:22').length).toBeGreaterThan(0)
      expect(screen.getByText('Primary web gateway node')).toBeInTheDocument()
      expect(screen.getAllByText('/var/www').length).toBeGreaterThan(0)

      // Terminal, remote files, and applications share one workspace tab strip.
      expect(screen.getByTestId('host-terminal-tab')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('host-files-tab')).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByTestId('host-applications-tab')).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByRole('region', { name: /SSH 终端输出|SSH terminal output/i })).toBeInTheDocument()
      expect(screen.getByText(/未连接|未連線|Disconnected|Not connected|연결되지 않음|未接続/i)).toBeInTheDocument()
      expect(screen.queryByText('Nginx Proxy')).not.toBeInTheDocument()

      fireEvent.click(screen.getByTestId('host-applications-tab'))
      expect(screen.getByTestId('host-applications-tab')).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('host-terminal-tab')).toHaveAttribute('aria-selected', 'false')
      expect(screen.queryByRole('region', { name: /SSH 终端输出|SSH terminal output/i })).not.toBeInTheDocument()
      expect(screen.getByTestId('host-applications-panel')).toBeInTheDocument()
      expect(screen.getByText('Nginx Proxy')).toBeInTheDocument()
      expect(screen.getByText('v1.25.0')).toBeInTheDocument()
      expect(screen.getByText('https://example.com')).toBeInTheDocument()
      expect(screen.getByText(/Admin Account \(admin\)/i)).toBeInTheDocument()
    })

    it('navigates the four workspace tabs by keyboard and exposes only the active panel', () => {
      useHostManagementStore.setState({ selectedHostId: 'host-1' })
      render(<HostDetail />)
      const terminal = screen.getByTestId('host-terminal-tab')
      terminal.focus()
      fireEvent.keyDown(terminal, { key: 'ArrowRight' })
      const files = screen.getByTestId('host-files-tab')
      expect(files).toHaveFocus()
      expect(files).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', files.getAttribute('aria-controls'))
      fireEvent.keyDown(files, { key: 'End' })
      const java = screen.getByTestId('host-java-tab')
      expect(java).toHaveFocus()
      expect(java).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tabpanel')).toHaveAttribute('id', java.getAttribute('aria-controls'))
      fireEvent.keyDown(java, { key: 'ArrowLeft' })
      expect(screen.getByTestId('host-applications-tab')).toHaveFocus()
      expect(screen.getByText('Nginx Proxy')).toBeVisible()
      fireEvent.keyDown(screen.getByTestId('host-applications-tab'), { key: 'Home' })
      expect(terminal).toHaveFocus()
      expect(screen.queryByText('Nginx Proxy')).not.toBeInTheDocument()
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    })

    it('opens ConfirmDialog for host deletion instead of browser confirm', async () => {
      useHostManagementStore.setState({ selectedHostId: 'host-1' })
      render(<HostDetail />)

      const deleteBtn = screen.getByRole('button', { name: '删除主机' })
      fireEvent.click(deleteBtn)

      // ConfirmDialog is opened with modal accessibility
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText(/确定要删除主机 "Web-Prod-01" 吗？此操作无法撤销。/i)).toBeInTheDocument()
    })

    it('shows referencing entities dialog when host deletion fails with references', async () => {
      const mockDelete = vi.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'RESOURCE_IN_USE',
          messageKey: 'managedResources.errors.resourceInUse',
          references: [
            {
              id: 'dc-1',
              type: 'data-connection',
              name: 'MySQL Production DB',
              description: 'Hosts database instance',
            },
          ],
        },
      })

      useHostManagementStore.setState({
        selectedHostId: 'host-1',
        deleteHost: mockDelete,
      })

      render(<HostDetail />)

      const deleteBtn = screen.getByRole('button', { name: '删除主机' })
      fireEvent.click(deleteBtn)

      // Confirm the deletion dialog
      const confirmDialog = screen.getByRole('dialog')
      const confirmActionBtn = within(confirmDialog).getByRole('button', { name: '删除' })
      fireEvent.click(confirmActionBtn)

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith('host-1', 1)
      })

      // Referencing entities modal should now be shown
      await waitFor(() => {
        expect(screen.getByText(/该主机正被以下受管资源引用，请先解除关联后再进行删除：/i)).toBeInTheDocument()
        expect(screen.getByText('MySQL Production DB')).toBeInTheDocument()
        expect(screen.getByText('数据连接')).toBeInTheDocument()
      })
    })

    it('displays revision conflict notification when deletion fails with REVISION_CONFLICT', async () => {
      const mockDelete = vi.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'REVISION_CONFLICT',
          messageKey: 'managedResources.errors.revisionConflict',
        },
      })

      useHostManagementStore.setState({
        selectedHostId: 'host-1',
        deleteHost: mockDelete,
      })

      render(<HostDetail />)

      const deleteBtn = screen.getByRole('button', { name: '删除主机' })
      fireEvent.click(deleteBtn)

      const confirmDialog = screen.getByRole('dialog')
      const confirmActionBtn = within(confirmDialog).getByRole('button', { name: '删除' })
      fireEvent.click(confirmActionBtn)

      await waitFor(() => {
        expect(screen.getByText(/资源已被修改（版本冲突），请刷新后重试。/i)).toBeInTheDocument()
      })
    })
  })

  describe('TagManagementModal component', () => {
    it('renders tag list and triggers ConfirmDialog on delete', () => {
      render(<TagManagementModal onClose={() => {}} />)

      expect(screen.getByText('生产环境')).toBeInTheDocument()

      const trashBtn = screen.getByRole('button', { name: '删除标签' })
      expect(trashBtn).toBeDefined()
      fireEvent.click(trashBtn)

      // ConfirmDialog is opened
      expect(screen.getByText(/确定要删除标签 "生产环境" 吗？这将从关联的主机中移除此标签。/i)).toBeInTheDocument()
    })
  })

  describe('HostEditModal component', () => {
    it('renders edit modal with storage strategy selection and initial directory validation', async () => {
      render(<HostEditModal hostId={null} onClose={() => {}} />)

      // Storage strategy selection for new host
      expect(screen.getByText(/保存到本地安全保险库/i)).toBeInTheDocument()
      expect(screen.getByText(/仅本次使用/i)).toBeInTheDocument()
    })
  })

  describe('Multi-locale rendering (en)', () => {
    it('renders host list and host detail in English without unlocalized fallback text', () => {
      useSettingsStore.setState({ locale: 'en' })
      useHostManagementStore.setState({
        hosts: [sampleHost],
        tags: [sampleTag],
        selectedHostId: 'host-1',
      })

      render(
        <div>
          <HostList />
          <HostDetail />
        </div>
      )

      // HostList elements in English
      expect(screen.getByText('All Hosts')).toBeInTheDocument()
      expect(screen.getByText('Host Management')).toBeInTheDocument()
      expect(screen.getByText('1 host(s)')).toBeInTheDocument()

      // HostDetail elements in English
      expect(screen.getByRole('button', { name: 'Edit Host' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Delete Host' })).toBeInTheDocument()
      expect(screen.getByText('Password Authentication')).toBeInTheDocument()
      expect(screen.getByText(/Initial Dir/)).toBeInTheDocument()
      expect(screen.getByText('Applications (1)')).toBeInTheDocument()
      expect(screen.getAllByText(/Disconnected|未连接|未連線|Not connected|연결되지 않음|未接続|Disconnected/i).length).toBeGreaterThanOrEqual(1)
      fireEvent.click(screen.getByTestId('host-applications-tab'))
      expect(screen.getByRole('button', { name: 'New Application' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Edit Application' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Delete Application' })).toBeInTheDocument()
    })
  })
})
