// 精灵皮肤动画模型：对齐 Codex App 开源实现与 qwen-audio-agent 的 sprite-orb.js。
// 轨道 = { frames: [{spriteIndex, durationMs}], loopStart, fallback }；
// loopStart 为 null 表示 one-shot，播完总时长后交棒 fallback 轨道。

const DEFAULT_COLUMNS = 8
const DEFAULT_FRAME_WIDTH = 192
const DEFAULT_FRAME_HEIGHT = 208
const DEFAULT_ROWS = 9
const V2_ROWS = 11
const DEFAULT_FPS = 8
const MAX_FPS = 60

export interface AnimationFrame {
  spriteIndex: number
  durationMs: number
}

export interface AnimationTrack {
  frames: AnimationFrame[]
  loopStart: number | null
  fallback: string
}

export interface Geometry {
  width: number
  height: number
  columns: number
  rows: number
  frameCount: number
}

export interface SkinManifest {
  spriteVersionNumber?: number
  frame?: { width: number; height: number; columns: number; rows: number }
  animations?: Record<string, { frames: number[]; fps?: number; loop?: boolean; fallback?: string }>
}

function idleAnimation(): AnimationTrack {
  const durations = [1680, 660, 660, 840, 840, 1920]
  return {
    frames: durations.map((durationMs, spriteIndex) => ({ spriteIndex, durationMs })),
    loopStart: 0,
    fallback: 'idle',
  }
}

// 状态动画 = 该行帧序列重复 3 遍 + 拼接 idle 帧，loopStart 指向 idle 段——
// 动作播 3 遍后自动沉降回 idle 循环，持续态不会一直播动作。
function appStateAnimation(
  rowIndex: number,
  frameCount: number,
  frameDurationMs: number,
  finalFrameDurationMs: number,
): AnimationTrack {
  const primary = Array.from({ length: frameCount }, (_, column) => ({
    spriteIndex: rowIndex * DEFAULT_COLUMNS + column,
    durationMs: column === frameCount - 1 ? finalFrameDurationMs : frameDurationMs,
  }))
  return {
    frames: [...primary, ...primary, ...primary, ...idleAnimation().frames],
    loopStart: primary.length * 3,
    fallback: 'idle',
  }
}

// 持续循环的行动画：不拼接 idle 沉降段，状态存续期间一直播放。
function rowLoopAnimation(
  rowIndex: number,
  frameCount: number,
  frameDurationMs: number,
  finalFrameDurationMs: number,
): AnimationTrack {
  const { frames } = appStateAnimation(rowIndex, frameCount, frameDurationMs, finalFrameDurationMs)
  return { frames: frames.slice(0, frameCount), loopStart: 0, fallback: 'idle' }
}

export function defaultAnimations(): Record<string, AnimationTrack> {
  return {
    idle: idleAnimation(),
    'running-right': appStateAnimation(1, 8, 120, 220),
    'running-left': appStateAnimation(2, 8, 120, 220),
    waving: appStateAnimation(3, 4, 140, 280),
    jumping: appStateAnimation(4, 5, 140, 280),
    failed: appStateAnimation(5, 8, 140, 240),
    waiting: appStateAnimation(6, 6, 150, 260),
    running: appStateAnimation(7, 6, 120, 220),
    review: appStateAnimation(8, 6, 150, 280),
    // 后台任务进行中：running-left 行持续循环不沉降
    working: rowLoopAnimation(2, 8, 120, 220),
    // 后台在等你确认：jumping 行持续循环
    attention: rowLoopAnimation(4, 5, 140, 280),
  }
}

export type OrbState =
  | 'idle' | 'listening' | 'thinking' | 'speaking' | 'connecting'
  | 'attention' | 'working' | 'occupied' | 'error' | 'waking' | 'hidden'

/** 语音状态 → 动画名。 */
export function spriteAnimationForOrbState(state: OrbState, dragging = false): string {
  if (dragging) return 'running-right'
  switch (state) {
    case 'listening':
    case 'connecting':
      return 'waiting'
    case 'thinking':
      return 'review'
    case 'occupied':
      return 'running'
    case 'working':
      return 'working'
    case 'attention':
      return 'attention'
    case 'speaking':
    case 'waking':
      return 'waving'
    case 'error':
      return 'failed'
    default:
      return 'idle'
  }
}

export function spriteGeometry(manifest: SkinManifest = {}): Geometry | null {
  const version = manifest.spriteVersionNumber ?? 1
  const frame = manifest.frame && typeof manifest.frame === 'object'
    ? manifest.frame
    : {
        width: DEFAULT_FRAME_WIDTH,
        height: DEFAULT_FRAME_HEIGHT,
        columns: DEFAULT_COLUMNS,
        rows: version === 2 ? V2_ROWS : DEFAULT_ROWS,
      }
  for (const key of ['width', 'height', 'columns', 'rows'] as const) {
    if (!Number.isInteger(frame[key]) || frame[key] <= 0) return null
  }
  return {
    width: frame.width,
    height: frame.height,
    columns: frame.columns,
    rows: frame.rows,
    frameCount: frame.columns * frame.rows,
  }
}

export function frameRect(geometry: Geometry, spriteIndex: number): { x: number; y: number; width: number; height: number } {
  return {
    x: (spriteIndex % geometry.columns) * geometry.width,
    y: Math.floor(spriteIndex / geometry.columns) * geometry.height,
    width: geometry.width,
    height: geometry.height,
  }
}

/** 合并 pet.json 可选 animations 覆盖与默认轨道表，并校验帧索引与 fallback。 */
export function resolveAnimations(manifest: SkinManifest = {}, frameCount = 0): Record<string, AnimationTrack> {
  const animations = defaultAnimations()
  const specs = manifest.animations
  if (specs && typeof specs === 'object' && !Array.isArray(specs)) {
    for (const [name, spec] of Object.entries(specs)) {
      if (!spec || !Array.isArray(spec.frames) || spec.frames.length === 0) {
        throw new Error(`皮肤动画 ${name} 至少要包含一帧`)
      }
      const fps = spec.fps === undefined ? DEFAULT_FPS : spec.fps
      if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS) {
        throw new Error(`皮肤动画 ${name} 的 fps 非法`)
      }
      const durationMs = 1000 / fps
      animations[name] = {
        frames: spec.frames.map((spriteIndex) => ({ spriteIndex, durationMs })),
        loopStart: spec.loop !== false ? 0 : null,
        fallback: spec.fallback || 'idle',
      }
    }
  }
  for (const [name, animation] of Object.entries(animations)) {
    for (const frame of animation.frames) {
      if (!Number.isInteger(frame.spriteIndex) || frame.spriteIndex < 0 || frame.spriteIndex >= frameCount) {
        throw new Error(`皮肤动画 ${name} 引用了越界的帧索引`)
      }
    }
    if (!animations[animation.fallback]) {
      throw new Error(`皮肤动画 ${name} 的 fallback 不存在`)
    }
  }
  return animations
}

function totalDuration(animation: AnimationTrack): number {
  return animation.frames.reduce((sum, frame) => sum + frame.durationMs, 0)
}

/** 无状态帧解析：由动画开始至今的 elapsed 算当前帧与到下一帧的延时。 */
export function frameAtElapsed(
  animation: AnimationTrack,
  elapsedMs: number,
): { spriteIndex: number; remainingMs: number } | null {
  const total = totalDuration(animation)
  if (total <= 0) return null
  let position = Math.max(0, elapsedMs)
  if (position >= total) {
    if (animation.loopStart === null) return null
    const introDuration = animation.frames
      .slice(0, animation.loopStart)
      .reduce((sum, frame) => sum + frame.durationMs, 0)
    const loopDuration = total - introDuration
    if (loopDuration <= 0) return null
    position = introDuration + ((position - total) % loopDuration)
  }
  let cursor = 0
  for (const frame of animation.frames) {
    if (position < cursor + frame.durationMs) {
      return { spriteIndex: frame.spriteIndex, remainingMs: cursor + frame.durationMs - position }
    }
    cursor += frame.durationMs
  }
  return null
}
