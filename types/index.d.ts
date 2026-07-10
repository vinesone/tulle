export type ImageSource =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | ImageData

/** A uniform type name, or a raw binder for types the table doesn't cover. */
export type UniformType =
  | 'float' | 'int' | 'bool'
  | 'vec2' | 'vec3' | 'vec4'
  | 'mat3' | 'mat4'

export type UniformBinder = (
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation,
  value: unknown,
) => void

/** Live pointer state. `u`/`v` are 0..1 with a bottom-left origin, matching vUv. */
export interface PointerState {
  x: number
  y: number
  u: number
  v: number
  down: boolean
  inside: boolean
  buttons: number
}

export interface WheelPointerState extends PointerState {
  deltaX: number
  deltaY: number
}

export interface FrameContext {
  /** Seconds since the Tulle instance was created. */
  time: number
  /** Seconds since the previous frame, clamped to 0.25. */
  delta: number
  /** Monotonically increasing frame counter. */
  frame: number
  pointer: Pointer | null
}

export interface TulleOptions {
  /** Track the pointer and expose u_pointer / u_pointerDown. Default true. */
  pointer?: boolean
  /** Destroy once the canvas has been in the DOM and is then removed. Default true. */
  autoDestroy?: boolean
}

export type PipelineStep = string | { name: string; params?: Record<string, unknown> }

export interface TulleEvents {
  pointermove: PointerState
  pointerdown: PointerState
  pointerup: PointerState
  pointerenter: PointerState
  pointerleave: PointerState
  click: PointerState
  wheel: WheelPointerState
  frame: FrameContext
  start: undefined
  stop: undefined
  destroy: undefined
  contextlost: undefined
  contextrestored: undefined
  error: unknown
}

export class Pointer implements PointerState {
  x: number
  y: number
  u: number
  v: number
  down: boolean
  inside: boolean
  buttons: number
  snapshot(): PointerState
}

export class Scope {
  readonly disposed: boolean
  add(disposer: () => void): () => void
  own<T extends { destroy(): void }>(resource: T): T
  listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void
  dispose(): void
}

export class Emitter {
  on(type: string, handler: (payload?: any) => void): () => void
  once(type: string, handler: (payload?: any) => void): () => void
  off(type: string, handler?: Function): void
  emit(type: string, payload?: unknown): void
  listenerCount(type: string): number
  clear(): void
}

export const FULLSCREEN_VERT: string

export class Effect {
  static vertSrc: string
  static fragSrc: string | null
  static defaults: Record<string, unknown>
  static uniforms: Record<string, UniformType | UniformBinder>

  readonly gl: WebGL2RenderingContext
  name: string
  readonly params: Record<string, unknown>

  constructor(gl: WebGL2RenderingContext, params?: Record<string, unknown>)
  setParams(next: Record<string, unknown>): void
  draw(inputTex: WebGLTexture, ctx: FrameContext & { width: number; height: number }): void
  destroy(): void
}

export class Tulle {
  constructor(canvas: HTMLCanvasElement, options?: TulleOptions)

  static register(name: string, EffectClass: typeof Effect): typeof Tulle
  static readonly registered: string[]

  readonly canvas: HTMLCanvasElement
  readonly pointer: Pointer | null
  readonly running: boolean
  readonly destroyed: boolean
  readonly pipeline: string[]
  readonly frame: FrameContext

  on<K extends keyof TulleEvents>(type: K, handler: (payload: TulleEvents[K]) => void): () => void
  on(type: string, handler: (payload?: any) => void): () => void
  once<K extends keyof TulleEvents>(type: K, handler: (payload: TulleEvents[K]) => void): () => void
  off(type: string, handler?: Function): this

  apply(name: string, params?: Record<string, unknown>): this
  chain(steps: PipelineStep[]): this
  set(name: string, params: Record<string, unknown>): this

  render(source: ImageSource): this
  renderAt(time: number, source: ImageSource): this
  process(source: ImageSource, name: string, params?: Record<string, unknown>): this

  start(onFrame?: (ctx: FrameContext, tulle: Tulle) => void): () => void
  stop(): this
  destroy(): void
}
