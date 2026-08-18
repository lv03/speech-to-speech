import {
  frameAtElapsed,
  frameRect,
  resolveAnimations,
  spriteAnimationForOrbState,
  spriteGeometry,
  type AnimationTrack,
  type Geometry,
  type OrbState,
  type SkinManifest,
} from './sprite-orb'

/** 在 canvas 上循环播放 spritesheet 帧动画（对齐 Codex App 渲染）。 */
export class SpriteRenderer {
  private image: HTMLImageElement | null = null
  private geometry: Geometry | null
  private animations: Record<string, AnimationTrack>
  private track: AnimationTrack | null = null
  private startedAt = 0
  private timer: number | null = null
  private state: OrbState = 'idle'
  private dragging = false

  constructor(
    private canvas: HTMLCanvasElement,
    private manifest: SkinManifest,
    private spritesheetUrl: string,
  ) {
    this.geometry = spriteGeometry(manifest)
    this.animations = resolveAnimations(manifest, this.geometry?.frameCount ?? 0)
  }

  async load(): Promise<void> {
    const image = new Image()
    image.src = this.spritesheetUrl
    await new Promise<void>((resolvePromise, reject) => {
      image.onload = () => resolvePromise()
      image.onerror = () => reject(new Error('皮肤贴图加载失败'))
    })
    this.image = image
    this.track = this.animations[this.animationName()] || this.animations.idle
    this.startedAt = performance.now()
    this.draw()
    this.schedule()
  }

  private animationName(): string {
    return spriteAnimationForOrbState(this.state, this.dragging)
  }

  setState(state: OrbState): void {
    if (this.state === state) return
    this.state = state
    this.track = this.animations[this.animationName()] || this.animations.idle
    this.startedAt = performance.now()
  }

  setDragging(dragging: boolean): void {
    if (this.dragging === dragging) return
    this.dragging = dragging
    this.track = this.animations[this.animationName()] || this.animations.idle
    this.startedAt = performance.now()
  }

  private draw(): number {
    // 返回到下一帧的延时（ms）
    if (!this.image || !this.geometry || !this.track) return 32
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return 32
    const elapsed = performance.now() - this.startedAt
    let frame = frameAtElapsed(this.track, elapsed)
    if (!frame) {
      this.track = this.animations[this.track.fallback] || this.animations.idle
      this.startedAt = performance.now()
      frame = frameAtElapsed(this.track, 0)
      if (!frame) return 32
    }
    const src = frameRect(this.geometry, frame.spriteIndex)
    const scale = Math.min(
      this.canvas.width / this.geometry.width,
      this.canvas.height / this.geometry.height,
    )
    const dw = this.geometry.width * scale
    const dh = this.geometry.height * scale
    const dx = (this.canvas.width - dw) / 2
    const dy = (this.canvas.height - dh) / 2
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.image, src.x, src.y, src.width, src.height, dx, dy, dw, dh)
    return frame.remainingMs
  }

  private schedule(): void {
    const remaining = this.draw()
    this.timer = window.setTimeout(() => this.schedule(), Math.max(16, remaining))
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
