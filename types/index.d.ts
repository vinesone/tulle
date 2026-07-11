export type ImageSource =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | ImageData

/** Anything usable as a layer/render source: a raw image, or a Tulle primitive exposing one. */
export type Source = ImageSource | TexSource

/** A primitive (e.g. Text) that stands in for an image by exposing a texImage2D input. */
export interface TexSource {
  readonly texSource: ImageSource
}

/** A uniform type name, or a raw binder for types the table doesn't cover. */
export type UniformType =
  | 'float' | 'int' | 'bool'
  | 'vec2' | 'vec3' | 'vec4'
  | 'mat3' | 'mat4'
  | 'sampler2D'

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
  /** Keep the canvas transparent so alpha lets the page show through. Default true. */
  alpha?: boolean
}

export type PipelineStep = string | { name: string; params?: Record<string, unknown> }

export interface Layer {
  source: Source
  /** Effect chain applied to this layer's source before it is blended. */
  effects?: PipelineStep[]
  /** Blend mode name for combining onto the layers below. Ignored on the base layer. Default 'over'. */
  blend?: string
  /** Upper-layer opacity, 0..1. Default 1. Shorthand for blendParams.opacity. */
  opacity?: number
  /** Additional blend params. */
  blendParams?: Record<string, unknown>
  /** Placement in the frame. Omit for fullscreen. */
  transform?: Transform | Float32Array | number[]
}

/** A 2D affine matrix (column-major 3×3) for placing a layer. Clip-space, centre origin. */
export class Transform {
  constructor(m?: Float32Array)
  static identity(): Transform
  translate(tx: number, ty: number): Transform
  scale(sx: number, sy?: number): Transform
  rotate(rad: number): Transform
  matrix(): Float32Array
}

/** Style and geometry for a Text block. All lengths are in design (pre-DPR) pixels. */
export interface TextOptions {
  /** Design-frame width. Tulle.text() fills this from the canvas. */
  width?: number
  /** Design-frame height. Tulle.text() fills this from the canvas. */
  height?: number
  /** Backing-store multiplier for crisp type. Defaults to devicePixelRatio, capped at 2. */
  dpr?: number

  /** CSS font-family stack. */
  font?: string
  /** Font size in px. */
  size?: number
  /** Font weight, 100..900 or 'bold'. */
  weight?: number | string
  italic?: boolean
  /** CSS colour for the fill. */
  color?: string
  /** Line height as a multiple of size. */
  lineHeight?: number
  /** Extra tracking in px. */
  letterSpacing?: number

  /** Horizontal placement within the frame. */
  align?: 'left' | 'center' | 'right'
  /** Vertical placement within the frame. */
  vAlign?: 'top' | 'middle' | 'bottom'
  /** Inset on all four sides, px. */
  padding?: number
  /** Fraction of frame width (0..1) the block may fill before wrapping. */
  maxWidth?: number | null

  /** CSS colour filling the whole surface, or null for transparent. */
  background?: string | null
  /** Drop shadow for legibility over busy footage. */
  shadow?: { color: string; blur?: number; x?: number; y?: number } | null
  /** Outline drawn under the fill. */
  stroke?: { color: string; width: number } | null
}

export interface TextMeasurement {
  lines: string[]
  lineHeight: number
  blockWidth: number
  blockHeight: number
}

/**
 * A styled block of type rasterised into a canvas, usable directly as a layer source.
 * Restyle live with set()/update(); the change appears on the next rendered frame.
 */
export class Text implements TexSource {
  constructor(text?: string, options?: TextOptions)
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  readonly texSource: HTMLCanvasElement | OffscreenCanvas
  readonly text: string
  readonly width: number
  readonly height: number
  readonly style: Required<TextOptions>
  set(text: string): this
  update(options: TextOptions): this
  resize(width: number, height: number, dpr?: number): this
  measure(): TextMeasurement
}

/** Default Text style and geometry. */
export const TEXT_DEFAULTS: Required<TextOptions>

/** Break text into display lines: honour '\n', then greedily wrap to maxWidth. Pure. */
export function layoutLines(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
): string[]

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
  /** Create a canvas in `target` (selector or element) and a Tulle for it. */
  static mount(target: string | Element, options?: TulleOptions & { width?: number; height?: number }): Tulle

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
  composite(layers: Layer[]): this
  post(steps: PipelineStep[]): this
  /** A text source sized to this canvas. Keep the return value to restyle it live. */
  text(text: string, options?: TextOptions): Text
  set(name: string, params: Record<string, unknown>): this
  setLayer(index: number, params: Record<string, unknown>): this
  setLayerEffect(index: number, name: string, params: Record<string, unknown>): this
  setLayerTransform(index: number, transform: Transform | Float32Array | number[] | null): this

  render(source?: Source): this
  renderAt(time: number, source?: Source): this
  process(source: Source, name: string, params?: Record<string, unknown>): this
  /** Take over the loop and render `source` (or a source-returning function) every frame. */
  play(source?: Source | (() => Source)): () => void

  start(onFrame?: (ctx: FrameContext, tulle: Tulle) => void): () => void
  stop(): this
  destroy(): void
}
