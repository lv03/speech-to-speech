import type { QmdClient } from './qmd-mcp-client'
import type {
  CollectionRecord,
  KnowledgeModelStatus,
  KnowledgeSnapshot,
  PublicKnowledgeSnapshot,
  RetrievalMode,
  RetrievalPreference,
  RetrievalProfile,
  RetrievalProfiles,
  RuntimeState,
  RuntimeStateName,
} from './runtime-types'
import { publicModelStatus, sanitizePublicReason } from './runtime-types'
import { profileAssetIds } from './retrieval-profile'

export type RuntimeManagerErrorCode = 'operation_in_progress'

export class RuntimeManagerError extends Error {
  readonly code: RuntimeManagerErrorCode

  constructor(code: RuntimeManagerErrorCode) {
    super(code === 'operation_in_progress' ? 'Knowledge operation is already running' : 'Knowledge operation failed')
    this.name = 'RuntimeManagerError'
    this.code = code
  }
}

export interface RuntimeModelStore {
  inspect(assetId: string): Promise<{ present: boolean; bytes: number; partialBytes?: number; sha256?: string }>
  ensureInstalled(assetId: string): Promise<string>
  ensure(assetId: string, signal?: AbortSignal): Promise<string>
  cancel(assetId: string): void
  onProgress?(listener: (event: { assetId: string; completed: number; total: number }) => void): () => void
}

export interface RuntimeQmdProcess {
  start(): Promise<{ baseUrl: string; port: number }>
  health(): Promise<boolean>
  stop(): Promise<void>
  onExit?(listener: (event: { unexpected: boolean; code: number | null; signal: NodeJS.Signals | null }) => void): () => void
}

export interface RuntimeKnowledgeService {
  snapshot(): Promise<KnowledgeSnapshot>
  addCollection(root: string, displayName?: string): Promise<CollectionRecord>
  removeCollection(collectionId: string): Promise<void>
  reindex(collectionId: string): Promise<void>
  deleteIndex(collectionId: string): Promise<void>
  setClient?(client: QmdClient | undefined): void
  setRuntimeState?(state: RuntimeState | null): void
  setRetrievalMode?(mode: import('./runtime-types').RetrievalMode): void
  setIndexFingerprint?(fingerprint: string): void
}

export interface RuntimeManagerOptions {
  service: RuntimeKnowledgeService
  modelStore: RuntimeModelStore
  modelAssetId: string
  modelDownloadBytes: number
  modelDiskBytes: number
  modelAssetSizes?: Record<string, number>
  retrievalProfiles?: RetrievalProfiles
  indexFingerprints?: Partial<Record<RetrievalMode, string>>
  retrievalPreference?: RetrievalPreference
  preheatEnabled?: boolean
  modelUnavailableReason?: string
  qmdRuntime: RuntimeQmdProcess
  qmdClient: QmdClient
  invalidateHandles?: () => void
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
  retryDelaysMs?: number[]
  watchdogIntervalMs?: number
}

export interface RuntimeProcessStops {
  voice?: () => Promise<void>
  proxy?: () => Promise<void>
  qmd?: () => Promise<void>
  gateway?: () => Promise<void>
}

export interface RuntimeProcessStarts {
  gateway: () => Promise<void>
  subscribeGatewayEvents?: () => void
  proxy: () => Promise<void>
  restoreIndexes: () => Promise<void>
  voice: () => Promise<void>
}

export async function startProcessesInOrder(starts: RuntimeProcessStarts): Promise<void> {
  await starts.gateway()
  starts.subscribeGatewayEvents?.()
  await starts.proxy()
  try {
    await starts.restoreIndexes()
  } catch {
    // Knowledge restoration is best effort; voice must remain available.
  }
  await starts.voice()
}

export async function stopProcessesInOrder(stops: RuntimeProcessStops): Promise<void> {
  for (const stop of [stops.voice, stops.proxy, stops.qmd, stops.gateway]) {
    if (!stop) continue
    try {
      await stop()
    } catch {
      // A failed child must not prevent later processes from being cleaned up.
    }
  }
}

function isReadyState(name: RuntimeStateName): boolean {
  return name === 'ready_vec' || name === 'ready_hybrid'
}

export class RuntimeManager {
  private readonly service: RuntimeKnowledgeService
  private readonly modelStore: RuntimeModelStore
  private readonly modelAssetId: string
  private readonly modelDownloadBytes: number
  private readonly modelDiskBytes: number
  private readonly modelAssetSizes: Record<string, number>
  private readonly retrievalProfiles: RetrievalProfiles
  private readonly indexFingerprints: Partial<Record<RetrievalMode, string>>
  private readonly modelUnavailableReason: string | undefined
  private readonly qmdRuntime: RuntimeQmdProcess
  private readonly qmdClient: QmdClient
  private readonly invalidateHandles: (() => void) | undefined
  private readonly now: () => Date
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly retryDelaysMs: number[]
  private readonly listeners = new Set<(snapshot: PublicKnowledgeSnapshot) => void>()
  private readonly modelProgress = new Map<string, number>()
  private readonly unsubscribeModelProgress: (() => void) | undefined
  private readonly unsubscribeQmdExit: (() => void) | undefined
  private readonly watchdogTimer?: NodeJS.Timeout
  private operation: Promise<unknown> | null = null
  private recovery: Promise<void> | null = null
  private recoveryRequested = false
  private abortController: AbortController | null = null
  private qmdStarted = false
  private stopped = false
  private retrievalPreference: RetrievalPreference
  private preheatEnabled: boolean
  private currentState: RuntimeState = {
    name: 'no_collection',
    updatedAt: new Date(0).toISOString(),
  }

  constructor(options: RuntimeManagerOptions) {
    this.service = options.service
    this.modelStore = options.modelStore
    this.modelAssetId = options.modelAssetId
    this.modelDownloadBytes = options.modelDownloadBytes
    this.modelDiskBytes = options.modelDiskBytes
    this.modelAssetSizes = options.modelAssetSizes ?? { [options.modelAssetId]: options.modelDiskBytes }
    this.retrievalProfiles = options.retrievalProfiles ?? {
      vecOnly: { mode: 'vec-only', embeddingAssetId: options.modelAssetId },
      hybrid: null,
    }
    this.indexFingerprints = options.indexFingerprints ?? {}
    this.modelUnavailableReason = options.modelUnavailableReason
    this.qmdRuntime = options.qmdRuntime
    this.qmdClient = options.qmdClient
    this.invalidateHandles = options.invalidateHandles
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 4000]
    this.retrievalPreference = options.retrievalPreference ?? 'auto'
    this.preheatEnabled = options.preheatEnabled ?? true
    this.service.setRetrievalMode?.(this.selectedProfile()?.mode ?? 'vec-only')
    const initialFingerprint = this.indexFingerprints[this.selectedProfile()?.mode ?? 'vec-only']
    if (initialFingerprint) this.service.setIndexFingerprint?.(initialFingerprint)
    this.unsubscribeModelProgress = this.modelStore.onProgress?.((event) => {
      if (this.stopped || !this.assetIds().includes(event.assetId)) return
      this.modelProgress.set(event.assetId, event.completed)
      this.currentState = {
        ...this.currentState,
        name: 'downloading',
        progress: { completed: this.completedModelBytes(), total: this.totalModelBytes() },
        updatedAt: this.now().toISOString(),
      }
      this.service.setRuntimeState?.({ ...this.currentState })
      void this.publish()
    })
    this.unsubscribeQmdExit = this.qmdRuntime.onExit?.((event) => {
      if (!event.unexpected) return
      this.scheduleRecovery()
    })
    const watchdogIntervalMs = options.watchdogIntervalMs ?? 5000
    if (watchdogIntervalMs > 0) {
      this.watchdogTimer = setInterval(() => {
        void this.checkQmdHealth()
      }, watchdogIntervalMs)
      this.watchdogTimer.unref?.()
    }
  }

  private setState(name: RuntimeStateName, collectionId?: string, reason?: string): void {
    this.currentState = {
      name,
      ...(collectionId ? { collectionId } : {}),
      ...(reason ? { reason } : {}),
      updatedAt: this.now().toISOString(),
    }
    this.service.setRuntimeState?.({ ...this.currentState })
    void this.publish()
  }

  private async publish(): Promise<void> {
    const snapshot = await this.publicSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private async publicSnapshot(): Promise<PublicKnowledgeSnapshot> {
    const snapshot = await this.service.snapshot()
    const reason = sanitizePublicReason(this.currentState.reason)
    return {
      state: this.currentState.name,
      ...(reason ? { reason } : {}),
      model: publicModelStatus(await this.modelStatus()),
      collections: snapshot.collections.map((collection) => ({
        collectionId: collection.collectionId,
        displayName: collection.displayName,
        directory: collection.root,
        indexState: collection.indexState,
        lastIndexedAt: collection.lastIndexedAt,
      })),
    }
  }

  private selectedProfile(preference = this.retrievalPreference): RetrievalProfile | null {
    if (preference === 'hybrid') return this.retrievalProfiles.hybrid
    return this.retrievalProfiles.vecOnly
  }

  private availableModes(): RetrievalMode[] {
    return [this.retrievalProfiles.vecOnly ? 'vec-only' : null, this.retrievalProfiles.hybrid ? 'hybrid' : null]
      .filter((mode): mode is RetrievalMode => mode !== null)
  }

  private assetIds(profile = this.selectedProfile()): string[] {
    return profile ? profileAssetIds(profile) : []
  }

  private totalModelBytes(profile = this.selectedProfile()): number {
    const ids = this.assetIds(profile)
    if (ids.length === 0) return this.modelDownloadBytes
    return ids.reduce((total, id) => total + (this.modelAssetSizes[id] ?? 0), 0)
  }

  private completedModelBytes(profile = this.selectedProfile()): number {
    return this.assetIds(profile).reduce((total, assetId) => total + (this.modelProgress.get(assetId) ?? 0), 0)
  }

  private async inspectProfile(profile = this.selectedProfile()): Promise<{ present: boolean; completedBytes: number }> {
    const ids = this.assetIds(profile)
    if (ids.length === 0) return { present: false, completedBytes: 0 }
    const inspected = await Promise.all(ids.map((id) => this.modelStore.inspect(id)))
    for (let index = 0; index < ids.length; index += 1) {
      const item = inspected[index]
      if (item) this.modelProgress.set(ids[index], item.present ? item.bytes : item.partialBytes ?? 0)
    }
    return {
      present: inspected.every((item) => item.present),
      completedBytes: inspected.reduce((total, item) => total + (item.present ? item.bytes : item.partialBytes ?? 0), 0),
    }
  }

  private profileKey(profile: RetrievalProfile | null): string {
    return profile ? `${profile.mode}:${this.assetIds(profile).join(',')}` : 'unavailable'
  }

  async setRetrievalPreference(preference: RetrievalPreference): Promise<void> {
    if (!['auto', 'hybrid', 'vec-only'].includes(preference)) throw new Error('Invalid retrieval preference')
    if (preference === 'hybrid' && !this.retrievalProfiles.hybrid) {
      throw new Error('Retrieval mode hybrid is unavailable')
    }
    const previousProfile = this.selectedProfile()
    const nextProfile = this.selectedProfile(preference)
    await this.exclusive(async () => {
      if (this.stopped) throw new Error('Knowledge runtime is stopping')
      this.retrievalPreference = preference
      this.modelProgress.clear()
      this.service.setRetrievalMode?.(nextProfile?.mode ?? 'vec-only')
      const nextFingerprint = this.indexFingerprints[nextProfile?.mode ?? 'vec-only']
      if (nextFingerprint) this.service.setIndexFingerprint?.(nextFingerprint)
      if (this.profileKey(previousProfile) === this.profileKey(nextProfile)) {
        await this.publish()
        return
      }
      const snapshot = await this.service.snapshot()
      const enabled = snapshot.collections.filter((collection) => collection.enabled)
      for (const collection of enabled) await this.service.deleteIndex(collection.collectionId)
      this.invalidateHandles?.()
      this.setState(enabled.length > 0 ? 'needs_consent' : 'no_collection', undefined, enabled.length > 0 ? 'Retrieval profile changed; reindex required' : undefined)
    })
  }

  setPreheatEnabled(enabled: boolean): void {
    this.preheatEnabled = enabled
  }

  private async reconcileState(base: KnowledgeSnapshot): Promise<void> {
    const enabled = base.collections.filter((collection) => collection.enabled)
    if (enabled.length === 0) {
      if (this.currentState.name !== 'no_collection') this.setState('no_collection')
      return
    }
    if (this.operation || this.stopped) return
    if (this.currentState.name === 'failed' || this.currentState.name === 'degraded') return
    if (this.modelUnavailableReason) {
      this.setState('failed', undefined, this.modelUnavailableReason)
      return
    }
    if (!this.selectedProfile()) {
      this.setState('failed', undefined, 'No embedding model is available for the selected retrieval mode')
      return
    }
    const model = await this.inspectProfile()
    if (!model.present) {
      if (this.currentState.name !== 'needs_consent') this.setState('needs_consent')
      return
    }
    if (enabled.some((collection) => collection.indexState !== 'ready')) {
      if (this.currentState.name !== 'indexing') {
        this.setState('indexing', enabled.find((collection) => collection.indexState !== 'ready')?.collectionId)
      }
      return
    }
    if (!isReadyState(this.currentState.name)) this.setState('degraded', undefined, 'QMD daemon is not ready')
  }

  async snapshot(): Promise<KnowledgeSnapshot> {
    const snapshot = await this.service.snapshot()
    await this.reconcileState(snapshot)
    return {
      state: { ...this.currentState },
      collections: snapshot.collections.map((collection) => ({ ...collection })),
    }
  }

  async modelStatus(): Promise<KnowledgeModelStatus> {
    const snapshot = await this.service.snapshot()
    if (!snapshot.collections.some((collection) => collection.enabled)) {
      return { state: 'not_needed', downloadBytes: 0, diskBytes: 0, availableModes: this.availableModes() }
    }
    if (this.modelUnavailableReason) {
      return {
        state: 'failed',
        downloadBytes: this.modelDownloadBytes,
        diskBytes: this.modelDiskBytes,
        reason: this.modelUnavailableReason,
        availableModes: this.availableModes(),
      }
    }
    if (!this.selectedProfile()) {
      return {
        state: 'failed',
        downloadBytes: 0,
        diskBytes: 0,
        reason: 'No embedding model is available for the selected retrieval mode',
        availableModes: this.availableModes(),
      }
    }
    const inspected = this.currentState.name === 'downloading'
      ? { present: false, completedBytes: this.completedModelBytes() }
      : await this.inspectProfile()
    const totalBytes = this.totalModelBytes()
    const mode = this.selectedProfile()?.mode
    const availableModes = this.availableModes()
    if (this.currentState.name === 'downloading') {
      return {
        state: 'downloading',
        downloadBytes: totalBytes,
        diskBytes: totalBytes,
        ...(mode ? { mode } : {}),
        availableModes,
          ...(this.currentState.progress?.completed !== undefined
          ? { completedBytes: this.currentState.progress.completed }
          : inspected.completedBytes > 0 ? { completedBytes: inspected.completedBytes } : {}),
      }
    }
    if (this.currentState.name === 'installing') {
      return { state: 'installing', downloadBytes: totalBytes, diskBytes: totalBytes, ...(mode ? { mode } : {}), availableModes }
    }
    if (this.currentState.name === 'failed') {
      return {
        state: 'failed',
        downloadBytes: totalBytes,
        diskBytes: totalBytes,
        ...(mode ? { mode } : {}),
        availableModes,
        ...(this.currentState.reason ? { reason: this.currentState.reason } : {}),
      }
    }
    if (!inspected.present) {
      return {
        state: 'needs_consent',
        downloadBytes: totalBytes,
        diskBytes: totalBytes,
        completedBytes: inspected.completedBytes,
        ...(mode ? { mode } : {}),
        availableModes,
      }
    }
    return {
      state: 'ready',
      downloadBytes: totalBytes,
      diskBytes: totalBytes,
      completedBytes: inspected.completedBytes,
      ...(mode ? { mode } : {}),
      availableModes,
    }
  }

  subscribe(listener: (snapshot: PublicKnowledgeSnapshot) => void): () => void {
    this.listeners.add(listener)
    void this.publicSnapshot().then(listener)
    return () => this.listeners.delete(listener)
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operation) throw new RuntimeManagerError('operation_in_progress')
    const running = operation()
    this.operation = running
    try {
      await running
    } finally {
      if (this.operation === running) this.operation = null
      this.abortController = null
      if (this.recoveryRequested) {
        this.recoveryRequested = false
        this.scheduleRecovery()
      }
    }
    return await running
  }

  private async startQmdWithRetry(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      if (this.stopped) throw new Error('Knowledge runtime is stopping')
      try {
        await this.qmdRuntime.start()
        this.qmdStarted = true
        return
      } catch (error) {
        lastError = error
        const delay = this.retryDelaysMs[attempt]
        if (delay === undefined) break
        await this.sleep(delay)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('QMD daemon failed to start')
  }

  private async ensureQmdReady(): Promise<void> {
    if (this.qmdStarted) {
      if (await this.qmdRuntime.health()) return
      await this.qmdRuntime.stop()
      this.qmdStarted = false
      this.clearQmdBindings()
    }
    await this.startQmdWithRetry()
  }

  private async verifyQuery(collectionId: string, mode = this.selectedProfile()?.mode ?? 'vec-only'): Promise<void> {
    const status = await this.qmdClient.status()
    if (!status.hasVectorIndex || status.needsEmbedding > 0) {
      throw new Error('QMD vector index is not ready')
    }
    // This is deliberately a bounded, harmless query. It proves that the MCP
    // generation can serve vec queries after a fresh start or reindex.
    if (this.preheatEnabled) await this.qmdClient.query('health check', `kb_${collectionId}`, 1, mode)
  }

  private async setStateAfterIndexing(): Promise<void> {
    const snapshot = await this.service.snapshot()
    const enabled = snapshot.collections.filter((collection) => collection.enabled)
    const pending = enabled.find((collection) => collection.indexState !== 'ready')
    if (pending) {
      this.setState('indexing', pending.collectionId)
    } else if (enabled.length > 0) {
      this.setState(this.selectedProfile()?.mode === 'hybrid' ? 'ready_hybrid' : 'ready_vec')
    } else {
      this.setState('no_collection')
    }
  }

  async addCollection(root: string): Promise<CollectionRecord> {
    return this.exclusive(async () => {
      if (this.stopped) throw new Error('Knowledge runtime is stopping')
      const record = await this.service.addCollection(root)
      this.invalidateHandles?.()
      this.setState('needs_consent')
      return record
    })
  }

  async restoreExistingIndexes(): Promise<void> {
    await this.exclusive(async () => {
      if (this.stopped) throw new Error('Knowledge runtime is stopping')
      const snapshot = await this.service.snapshot()
      const enabled = snapshot.collections.filter((collection) => collection.enabled)
      if (enabled.length === 0) {
        this.setState('no_collection')
        return
      }
      if (this.modelUnavailableReason) {
        this.setState('failed', undefined, this.modelUnavailableReason)
        return
      }

      const model = await this.inspectProfile()
      if (!model.present) {
        this.setState('needs_consent')
        return
      }
      const pending = enabled.find((collection) => collection.indexState !== 'ready')
      if (pending) {
        this.setState(pending.indexState === 'failed' ? 'failed' : 'needs_consent', pending.collectionId)
        return
      }

      try {
        for (const assetId of this.assetIds()) await this.modelStore.ensureInstalled(assetId)
        this.setState('installing')
        await this.ensureQmdReady()
        this.service.setClient?.(this.qmdClient)
        await this.qmdClient.initialize()
        for (const collection of enabled) await this.verifyQuery(collection.collectionId)
        if (!(await this.qmdRuntime.health())) throw new Error('QMD daemon health check failed')
        this.setState(this.selectedProfile()?.mode === 'hybrid' ? 'ready_hybrid' : 'ready_vec')
      } catch {
        this.clearQmdBindings()
        if (this.qmdStarted) {
          await this.qmdRuntime.stop().catch(() => undefined)
          this.qmdStarted = false
        }
        this.setState('degraded', undefined, 'QMD daemon recovery failed')
      }
    })
  }

  async removeCollection(collectionId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.service.removeCollection(collectionId)
      this.invalidateHandles?.()
      const snapshot = await this.service.snapshot()
      const enabled = snapshot.collections.filter((collection) => collection.enabled)
      if (enabled.length === 0 && this.qmdStarted) {
        await this.qmdRuntime.stop()
        this.qmdStarted = false
        this.clearQmdBindings()
      }
      if (enabled.length === 0) {
        this.setState('no_collection')
      } else {
        const ready = enabled.length > 0 && enabled.every((collection) => collection.indexState === 'ready')
        if (ready && this.qmdStarted && await this.qmdRuntime.health()) {
          this.setState(this.selectedProfile()?.mode === 'hybrid' ? 'ready_hybrid' : 'ready_vec')
        }
        else this.setState('needs_consent')
      }
    })
  }

  async deleteIndex(collectionId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.service.deleteIndex(collectionId)
      this.invalidateHandles?.()
      this.setState('needs_consent')
    })
  }

  async reindex(collectionId: string, confirmed = false): Promise<void> {
    await this.exclusive(async () => {
      const model = await this.modelStatus()
      if (model.state === 'needs_consent' && !confirmed) {
        throw new Error('Model download confirmation is required')
      }
      await this.prepare(collectionId)
    })
  }

  async consentAndPrepare(collectionId: string): Promise<void> {
    await this.exclusive(() => this.prepare(collectionId))
  }

  private async prepare(collectionId: string): Promise<void> {
      if (this.stopped) throw new Error('Knowledge runtime is stopping')
      if (!this.selectedProfile()) throw new Error('No embedding model is available for the selected retrieval mode')
      const snapshot = await this.service.snapshot()
      const collection = snapshot.collections.find((candidate) => candidate.collectionId === collectionId)
      if (!collection) throw new Error('Knowledge collection is not configured')
      if (this.modelUnavailableReason) throw new Error(this.modelUnavailableReason)
      const inspected = await this.inspectProfile()
      this.abortController = new AbortController()
      let modelStage = true
      try {
        if (!inspected.present) {
          this.setState('downloading', collectionId)
          for (const assetId of this.assetIds()) {
            const asset = await this.modelStore.inspect(assetId)
            if (!asset.present) await this.modelStore.ensure(assetId, this.abortController.signal)
          }
        } else {
          for (const assetId of this.assetIds()) await this.modelStore.ensureInstalled(assetId)
        }
        modelStage = false
        this.setState('installing', collectionId)
        await this.ensureQmdReady()
        this.service.setClient?.(this.qmdClient)
        await this.qmdClient.initialize()
        await this.qmdClient.status()
        this.setState('indexing', collectionId)
        this.invalidateHandles?.()
        await this.service.reindex(collectionId)
        await this.verifyQuery(collectionId)
        if (!(await this.qmdRuntime.health())) throw new Error('QMD daemon health check failed')
        await this.setStateAfterIndexing()
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === 'AbortError'
        if (!modelStage && !cancelled) {
          this.clearQmdBindings()
          if (this.qmdStarted) {
            await this.qmdRuntime.stop().catch(() => undefined)
            this.qmdStarted = false
          }
        }
        if (cancelled) {
          this.setState('needs_consent', collectionId, 'Knowledge preparation cancelled')
        } else {
          this.setState(modelStage ? 'failed' : 'degraded', collectionId, 'Knowledge preparation failed')
        }
        if (!modelStage && !cancelled) {
          throw new Error('Knowledge preparation failed')
        }
        throw error
      } finally {
        this.abortController = null
      }
  }

  async retry(): Promise<void> {
    await this.exclusive(async () => {
      const snapshot = await this.service.snapshot()
      const enabled = snapshot.collections.filter((candidate) => candidate.enabled)
      const collection = enabled.find((candidate) => candidate.indexState !== 'ready') ?? enabled[0]
      if (!collection) {
        this.setState('no_collection')
        return
      }
      const model = await this.modelStatus()
      if (model.state === 'needs_consent') throw new Error('Model download confirmation is required')
      await this.prepare(collection.collectionId)
    })
  }

  cancel(): void {
    this.abortController?.abort()
    for (const assetId of this.assetIds()) this.modelStore.cancel(assetId)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.setState('stopping')
    this.cancel()
    try {
      await this.operation
    } catch {
      // Stop is best effort; the child runtime still needs to be terminated.
    }
    try {
      await this.qmdRuntime.stop()
    } catch {
      // Cleanup below must run even if the child process reports a stop error.
    } finally {
      this.qmdStarted = false
      this.clearQmdBindings()
      if (this.watchdogTimer) clearInterval(this.watchdogTimer)
      this.unsubscribeModelProgress?.()
      this.unsubscribeQmdExit?.()
    }
  }

  private scheduleRecovery(): void {
    if (this.stopped || !this.qmdStarted || this.recovery) return
    if (this.operation) {
      this.recoveryRequested = true
      return
    }
    this.recovery = this.recoverQmd().finally(() => {
      this.recovery = null
    })
  }

  private async checkQmdHealth(): Promise<void> {
    if (this.stopped || !this.qmdStarted || this.recovery) return
    try {
      if (!(await this.qmdRuntime.health())) this.scheduleRecovery()
    } catch {
      this.scheduleRecovery()
    }
  }

  private async recoverQmd(): Promise<void> {
    if (this.stopped || !this.qmdStarted) return
    const beforeRecovery = await this.service.snapshot()
    const enabledBeforeRecovery = beforeRecovery.collections.filter((candidate) => candidate.enabled)
    if (enabledBeforeRecovery.length === 0 || this.abortController?.signal.aborted) {
      this.qmdStarted = false
      this.clearQmdBindings()
      if (enabledBeforeRecovery.length === 0) this.setState('no_collection')
      return
    }
    this.qmdStarted = false
    this.clearQmdBindings()
    this.setState('degraded', undefined, 'QMD daemon exited unexpectedly')
    try {
      await this.qmdRuntime.stop()
      if (this.stopped) return
      await this.startQmdWithRetry()
      this.service.setClient?.(this.qmdClient)
      await this.qmdClient.initialize()
      await this.qmdClient.status()
      const snapshot = await this.service.snapshot()
      const enabled = snapshot.collections.filter((candidate) => candidate.enabled)
      const pending = enabled.find((candidate) => candidate.indexState !== 'ready')
      if (pending) {
        this.setState('indexing', pending.collectionId)
        return
      }
      for (const collection of enabled) await this.verifyQuery(collection.collectionId)
      this.setState(this.selectedProfile()?.mode === 'hybrid' ? 'ready_hybrid' : 'ready_vec')
    } catch {
      this.qmdStarted = false
      this.clearQmdBindings()
      await this.qmdRuntime.stop().catch(() => undefined)
      this.setState('degraded', undefined, 'QMD daemon recovery failed')
    }
  }

  private clearQmdBindings(): void {
    this.qmdClient.reset()
    this.service.setClient?.(undefined)
    this.invalidateHandles?.()
  }
}
