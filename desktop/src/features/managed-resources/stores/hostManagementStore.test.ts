import { describe, expect, it, beforeEach } from 'vitest'
import { useHostManagementStore } from './hostManagementStore'

describe('hostManagementStore (M2.2 & M2.4)', () => {
  beforeEach(() => {
    useHostManagementStore.setState({
      hosts: [],
      tags: [],
      selectedHostId: null,
      searchQuery: '',
      selectedTagId: null,
      loading: false,
      error: null,
    })
  })

  it('initializes with default empty state', () => {
    const state = useHostManagementStore.getState()
    expect(state.hosts).toEqual([])
    expect(state.tags).toEqual([])
    expect(state.selectedHostId).toBeNull()
    expect(state.connectionStatus).toBe('disconnected')
  })

  it('filters hosts across all search dimensions: name, address, username, notes, tag name, and applications', () => {
    useHostManagementStore.setState({
      tags: [
        { id: 'tag-prod', namespace: 'host', name: '生产环境', normalizedName: '生产环境', colorToken: 'red', revision: 1, createdAt: '', updatedAt: '' },
        { id: 'tag-db', namespace: 'host', name: '数据库集群', normalizedName: '数据库集群', colorToken: 'blue', revision: 1, createdAt: '', updatedAt: '' },
      ],
      hosts: [
        {
          id: 'host-1',
          name: 'Web-Gateway-01',
          address: '10.0.1.15',
          port: 22,
          username: 'deployer',
          auth: { type: 'password', credentialId: null },
          tagIds: ['tag-prod'],
          initialDirectory: '/var/www',
          applications: [
            {
              id: 'app-1',
              name: 'Nginx Ingress',
              version: '1.24.0',
              installPaths: ['/etc/nginx'],
              accessDescription: 'Edge reverse proxy',
              accessUrls: ['https://example.com'],
              loginUrl: null,
              accounts: [],
              notes: 'Public ingress controller',
            },
          ],
          notes: 'Edge load balancer node',
          revision: 1,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'host-2',
          name: 'DB-Postgres-Master',
          address: '10.0.2.80',
          port: 5432,
          username: 'postgres',
          auth: { type: 'privateKey', credentialId: 'cred-1' },
          tagIds: ['tag-db'],
          initialDirectory: '/var/lib/postgresql',
          applications: [
            {
              id: 'app-2',
              name: 'PostgreSQL 16',
              version: '16.1',
              installPaths: ['/usr/lib/postgresql/16'],
              accessDescription: 'Primary transactional storage',
              accessUrls: [],
              loginUrl: null,
              accounts: [],
              notes: 'WAL replication enabled',
            },
          ],
          notes: 'High performance NVMe storage',
          revision: 1,
          createdAt: '',
          updatedAt: '',
        },
      ],
    })

    const store = useHostManagementStore.getState()
    expect(store.filteredHosts()).toHaveLength(2)

    // 1. Search by host name
    store.setSearchQuery('gateway')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-1'])

    // 2. Search by IP address
    store.setSearchQuery('10.0.2.80')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-2'])

    // 3. Search by username
    store.setSearchQuery('deployer')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-1'])

    // 4. Search by host notes
    store.setSearchQuery('NVMe storage')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-2'])

    // 5. Search by application name
    store.setSearchQuery('Nginx Ingress')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-1'])

    // 6. Search by application notes
    store.setSearchQuery('WAL replication')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-2'])

    // 7. Search by tag name
    store.setSearchQuery('生产环境')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-1'])

    store.setSearchQuery('数据库集群')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-2'])

    // 8. Tag filter + search query combined
    store.setSearchQuery('10.0')
    store.setSelectedTagId('tag-prod')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-1'])

    store.setSelectedTagId('tag-db')
    expect(store.filteredHosts().map(h => h.id)).toEqual(['host-2'])

    // 9. Selected host selector
    store.setSelectedHostId('host-2')
    expect(store.selectedHost()?.name).toBe('DB-Postgres-Master')
  })
})
