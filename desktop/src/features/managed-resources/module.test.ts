import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  createManagedResourcesRendererModule,
  type ComposerScope,
  type ManagedContextTrigger,
  type ManagedContextTriggerInput,
  type ManagedResourcesRendererDependencies,
} from './module.js'
import type { ConversationContextSelectionV2 } from './types/resourceTypes.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.resolve(
  HERE,
  '../../../../fixtures/managed-resources/contract-v2.fixture.json',
)

function getFixtureSelection(): ConversationContextSelectionV2 {
  const content = fs.readFileSync(FIXTURE_PATH, 'utf8')
  const parsed = JSON.parse(content)
  return parsed.selection as ConversationContextSelectionV2
}

function createMockDeps(): {
  deps: ManagedResourcesRendererDependencies
  resolveMock: ReturnType<typeof vi.fn>
  moveMock: ReturnType<typeof vi.fn>
  snapshotMock: ReturnType<typeof vi.fn>
} {
  const resolveMock = vi.fn<ManagedResourcesRendererDependencies['resolveManagedContextTrigger']>()
  const moveMock = vi.fn<ManagedResourcesRendererDependencies['moveManagedContextScope']>()
  const snapshotMock = vi.fn<ManagedResourcesRendererDependencies['snapshotManagedContext']>()
  const deps: ManagedResourcesRendererDependencies = {
    resolveManagedContextTrigger: resolveMock,
    moveManagedContextScope: moveMock,
    snapshotManagedContext: snapshotMock,
  }
  return { deps, resolveMock, moveMock, snapshotMock }
}

describe('createManagedResourcesRendererModule', () => {
  it('工厂创建和两个独立实例创建不调用任何依赖', () => {
    const { deps: deps1, resolveMock: r1, moveMock: m1, snapshotMock: s1 } = createMockDeps()
    const { deps: deps2, resolveMock: r2, moveMock: m2, snapshotMock: s2 } = createMockDeps()

    const module1 = createManagedResourcesRendererModule(deps1)
    const module2 = createManagedResourcesRendererModule(deps2)

    expect(module1).toBeDefined()
    expect(module2).toBeDefined()

    expect(r1).toHaveBeenCalledTimes(0)
    expect(m1).toHaveBeenCalledTimes(0)
    expect(s1).toHaveBeenCalledTimes(0)

    expect(r2).toHaveBeenCalledTimes(0)
    expect(m2).toHaveBeenCalledTimes(0)
    expect(s2).toHaveBeenCalledTimes(0)
  })

  it('resolve传入同一input对象并只调用一次，返回同一trigger对象；依赖返回null时原样返回null', () => {
    const { deps, resolveMock } = createMockDeps()
    const input: ManagedContextTriggerInput = {
      text: '/host db-cluster',
      cursorOffset: 16,
      excludedRanges: [{ from: 0, to: 2 }],
      isComposing: false,
    }
    const trigger: ManagedContextTrigger = {
      kind: 'host',
      query: 'db-cluster',
      replacementRange: { from: 0, to: 16 },
    }

    // 1. 返回同一 trigger 对象身份，且仅调用一次
    resolveMock.mockReturnValue(trigger)
    const moduleInstance = createManagedResourcesRendererModule(deps)
    const result = moduleInstance.resolveManagedContextTrigger(input)

    expect(resolveMock).toHaveBeenCalledTimes(1)
    expect(resolveMock).toHaveBeenCalledWith(input)
    expect(resolveMock.mock.calls[0]![0]).toBe(input)
    expect(result).toBe(trigger)

    // 2. 依赖返回 null 时原样返回 null，恰好再次只调用一次
    resolveMock.mockReturnValue(null)
    const nullResult = moduleInstance.resolveManagedContextTrigger(input)

    expect(resolveMock).toHaveBeenCalledTimes(2)
    expect(resolveMock.mock.calls[1]![0]).toBe(input)
    expect(nullResult).toBeNull()
  })

  it('move传入原from/to对象且顺序一致，依赖调用恰好一次；不持有或迁移自己的状态', () => {
    const { deps, moveMock, snapshotMock } = createMockDeps()
    const fromScope: ComposerScope = { kind: 'draft', draftId: 'draft-uuid-001' }
    const toScope: ComposerScope = { kind: 'session', sessionId: 'session-uuid-002' }

    const moduleInstance = createManagedResourcesRendererModule(deps)
    moduleInstance.moveManagedContextScope(fromScope, toScope)

    expect(moveMock).toHaveBeenCalledTimes(1)
    expect(moveMock).toHaveBeenCalledWith(fromScope, toScope)
    expect(moveMock.mock.calls[0]![0]).toBe(fromScope)
    expect(moveMock.mock.calls[0]![1]).toBe(toScope)

    // 证明自身不持有或迁移状态，后续 snapshot 依然完全委托给依赖返回的结果
    snapshotMock.mockReturnValue(undefined)
    const snapshotResult = moduleInstance.snapshotManagedContext(toScope)
    expect(snapshotMock).toHaveBeenCalledTimes(1)
    expect(snapshotMock).toHaveBeenCalledWith(toScope)
    expect(snapshotResult).toBeUndefined()
  })

  it('snapshot返回依赖提供的同一selection对象；undefined原样返回；使用既有fixture获取合法selection，不改变fixture', () => {
    const fixtureBefore = fs.readFileSync(FIXTURE_PATH, 'utf8')
    const validSelection = getFixtureSelection()
    expect(validSelection.schemaVersion).toBe(2)

    const { deps, snapshotMock } = createMockDeps()
    const scope: ComposerScope = { kind: 'session', sessionId: 'session-live-003' }
    const moduleInstance = createManagedResourcesRendererModule(deps)

    // 1. 返回同一 selection 身份
    snapshotMock.mockReturnValue(validSelection)
    const result = moduleInstance.snapshotManagedContext(scope)

    expect(snapshotMock).toHaveBeenCalledTimes(1)
    expect(snapshotMock).toHaveBeenCalledWith(scope)
    expect(snapshotMock.mock.calls[0]![0]).toBe(scope)
    expect(result).toBe(validSelection)

    // 2. undefined 原样返回
    snapshotMock.mockReturnValue(undefined)
    const undefinedResult = moduleInstance.snapshotManagedContext(scope)

    expect(snapshotMock).toHaveBeenCalledTimes(2)
    expect(undefinedResult).toBeUndefined()

    // 验证 fixture 未被改变
    const fixtureAfter = fs.readFileSync(FIXTURE_PATH, 'utf8')
    expect(fixtureAfter).toBe(fixtureBefore)
  })

  it('每种方法依赖抛出的同一Error对象原样传播，不吞异常，不擅自重试', () => {
    const { deps, resolveMock, moveMock, snapshotMock } = createMockDeps()
    const moduleInstance = createManagedResourcesRendererModule(deps)

    const resolveError = new Error('resolve trigger failure')
    const moveError = new Error('move scope failure')
    const snapshotError = new Error('snapshot selection failure')

    // resolve 异常透传且不重试
    resolveMock.mockImplementation(() => {
      throw resolveError
    })
    const input: ManagedContextTriggerInput = {
      text: '/database main',
      cursorOffset: 14,
      excludedRanges: [],
      isComposing: false,
    }
    expect(() => moduleInstance.resolveManagedContextTrigger(input)).toThrow(resolveError)
    expect(resolveMock).toHaveBeenCalledTimes(1)

    // move 异常透传且不重试
    moveMock.mockImplementation(() => {
      throw moveError
    })
    const fromScope: ComposerScope = { kind: 'draft', draftId: 'd-1' }
    const toScope: ComposerScope = { kind: 'session', sessionId: 's-1' }
    expect(() => moduleInstance.moveManagedContextScope(fromScope, toScope)).toThrow(moveError)
    expect(moveMock).toHaveBeenCalledTimes(1)

    // snapshot 异常透传且不重试
    snapshotMock.mockImplementation(() => {
      throw snapshotError
    })
    expect(() => moduleInstance.snapshotManagedContext(toScope)).toThrow(snapshotError)
    expect(snapshotMock).toHaveBeenCalledTimes(1)
  })

  it('两个实例使用不同依赖且互不串用；方法调用保留deps接收者语义', () => {
    let receiverA: unknown = null
    let receiverB: unknown = null

    const triggerA: ManagedContextTrigger = {
      kind: 'concept',
      query: 'architecture',
      replacementRange: { from: 0, to: 10 },
    }
    const triggerB: ManagedContextTrigger = {
      kind: 'redis',
      query: 'sessions',
      replacementRange: { from: 0, to: 8 },
    }

    const selectionA = { schemaVersion: 2 } as unknown as ConversationContextSelectionV2
    const selectionB = { schemaVersion: 2, includePasswords: true } as unknown as ConversationContextSelectionV2

    const depsA: ManagedResourcesRendererDependencies = {
      resolveManagedContextTrigger: vi.fn(function (
        this: unknown,
        _input: ManagedContextTriggerInput,
      ) {
        receiverA = this
        return triggerA
      }),
      moveManagedContextScope: vi.fn(function (
        this: unknown,
        _from: ComposerScope,
        _to: ComposerScope,
      ) {
        receiverA = this
      }),
      snapshotManagedContext: vi.fn(function (
        this: unknown,
        _scope: ComposerScope,
      ) {
        receiverA = this
        return selectionA
      }),
    }

    const depsB: ManagedResourcesRendererDependencies = {
      resolveManagedContextTrigger: vi.fn(function (
        this: unknown,
        _input: ManagedContextTriggerInput,
      ) {
        receiverB = this
        return triggerB
      }),
      moveManagedContextScope: vi.fn(function (
        this: unknown,
        _from: ComposerScope,
        _to: ComposerScope,
      ) {
        receiverB = this
      }),
      snapshotManagedContext: vi.fn(function (
        this: unknown,
        _scope: ComposerScope,
      ) {
        receiverB = this
        return selectionB
      }),
    }

    const moduleA = createManagedResourcesRendererModule(depsA)
    const moduleB = createManagedResourcesRendererModule(depsB)

    const dummyInput: ManagedContextTriggerInput = {
      text: 'test',
      cursorOffset: 4,
      excludedRanges: [],
      isComposing: false,
    }
    const scopeA: ComposerScope = { kind: 'draft', draftId: 'da' }
    const scopeB: ComposerScope = { kind: 'session', sessionId: 'sb' }

    // 1. 调用 moduleA.resolveManagedContextTrigger
    const resA = moduleA.resolveManagedContextTrigger(dummyInput)
    expect(resA).toBe(triggerA)
    expect(depsA.resolveManagedContextTrigger).toHaveBeenCalledTimes(1)
    expect(depsB.resolveManagedContextTrigger).toHaveBeenCalledTimes(0)
    expect(receiverA).toBe(depsA)

    // 2. 调用 moduleB.resolveManagedContextTrigger
    const resB = moduleB.resolveManagedContextTrigger(dummyInput)
    expect(resB).toBe(triggerB)
    expect(depsB.resolveManagedContextTrigger).toHaveBeenCalledTimes(1)
    expect(depsA.resolveManagedContextTrigger).toHaveBeenCalledTimes(1)
    expect(receiverB).toBe(depsB)

    // 3. 调用 move
    moduleA.moveManagedContextScope(scopeA, scopeB)
    expect(depsA.moveManagedContextScope).toHaveBeenCalledTimes(1)
    expect(depsB.moveManagedContextScope).toHaveBeenCalledTimes(0)
    expect(receiverA).toBe(depsA)

    moduleB.moveManagedContextScope(scopeA, scopeB)
    expect(depsB.moveManagedContextScope).toHaveBeenCalledTimes(1)
    expect(depsA.moveManagedContextScope).toHaveBeenCalledTimes(1)
    expect(receiverB).toBe(depsB)

    // 4. 调用 snapshot
    const snapA = moduleA.snapshotManagedContext(scopeA)
    expect(snapA).toBe(selectionA)
    expect(depsA.snapshotManagedContext).toHaveBeenCalledTimes(1)
    expect(depsB.snapshotManagedContext).toHaveBeenCalledTimes(0)
    expect(receiverA).toBe(depsA)

    const snapB = moduleB.snapshotManagedContext(scopeB)
    expect(snapB).toBe(selectionB)
    expect(depsB.snapshotManagedContext).toHaveBeenCalledTimes(1)
    expect(depsA.snapshotManagedContext).toHaveBeenCalledTimes(1)
    expect(receiverB).toBe(depsB)
  })
})
