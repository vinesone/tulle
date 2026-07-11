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
  /** Layout scroll offset in design px (0 when not a scrolling layout). */
  scrollX: number
  scrollY: number
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

/** A time in seconds (number) or an "mm:ss(.ms)" / "h:mm:ss" string. */
export type TimeLike = number | string

/** Unsubscribe function returned by on()/at()/every(). */
export type Off = () => void

export interface ClipOptions {
  /** Mute the element. Required true (the default) for unattended autoplay. */
  muted?: boolean
  /** play() as soon as the clip is ready. Default false. */
  autoplay?: boolean
  /** Native loop. Changes end/loop event semantics. Default false. */
  loop?: boolean
  /** Set playsinline so iOS doesn't fullscreen-hijack. Default true. */
  playsInline?: boolean
  /** Needed to feed a cross-origin video into WebGL without tainting the canvas. */
  crossOrigin?: '' | 'anonymous' | 'use-credentials'
  /** Passed through to the element. Default 'auto'. */
  preload?: 'none' | 'metadata' | 'auto'
}

/** Payload of the 'ready' event: the first instant the clip has an intrinsic size. */
export interface ClipReady {
  width: number
  height: number
  duration: number
}

export interface ClipEvents {
  /** src assigned, network fetch begun. Latched. */
  load: undefined
  /** First decodable frame and dimensions known. Latched, fires once. */
  ready: ClipReady
  /** Playback truly progressing (past buffering). */
  play: undefined
  pause: undefined
  /** Current playback time, seconds — emitted once per rendered frame. */
  time: number
  /** Non-looping finish. */
  end: undefined
  /** A looping clip wrapped back to the start. */
  loop: { count: number }
  /** Stalled for buffering. */
  waiting: undefined
  error: MediaError | unknown
  /** destroy() was called; fired before teardown. */
  unload: undefined
}

/**
 * A video source with a lifecycle. Wraps an HTMLVideoElement, exposes it as a
 * layer source (texSource), and is an Emitter for lifecycle events and timeline
 * cues. `new Clip(...)` is caller-owned; `tulle.clip(...)` is owned by the Tulle.
 */
export class Clip extends Emitter implements TexSource {
  constructor(src: string | HTMLVideoElement, options?: ClipOptions)

  readonly texSource: HTMLVideoElement
  readonly el: HTMLVideoElement
  /** False until a frame is decodable; the renderer skips uploading an empty video. */
  readonly uploadable: boolean

  /** Intrinsic width in px; 0 until 'ready'. */
  readonly width: number
  /** Intrinsic height in px; 0 until 'ready'. */
  readonly height: number
  /** width / height, or 0 before it is known. */
  readonly aspect: number
  /** Duration in seconds; NaN until metadata. */
  readonly duration: number
  readonly currentTime: number
  readonly playing: boolean
  readonly ready: boolean

  play(): Promise<void>
  pause(): this
  seek(time: TimeLike): this
  rate(x: number): this
  volume(v: number): this
  mute(): this
  unmute(): this
  /** Resolves when ready (immediately if it already is). */
  whenReady(): Promise<Clip>

  /** Fire once when playback crosses `time`. Returns unsubscribe. */
  at(time: TimeLike, handler: (time: number, clip: Clip) => void): Off
  /** Fire every `interval` seconds of playback. Returns unsubscribe. */
  every(interval: number, handler: (time: number, clip: Clip) => void): Off
  clearCues(): this

  /** Sample playback and fire crossed cues. Called once per frame by Tulle. */
  advance(frame?: FrameContext): void
  destroy(): void

  on<K extends keyof ClipEvents>(type: K, handler: (payload: ClipEvents[K]) => void): Off
  on(type: string, handler: (payload?: any) => void): Off
  once<K extends keyof ClipEvents>(type: K, handler: (payload: ClipEvents[K]) => void): Off
  once(type: string, handler: (payload?: any) => void): Off
}

/** Which cues fire moving from `prev` to `curr` seconds. Pure; mutates cue arming state. */
export function dueCues(
  cues: Array<{ at?: number; every?: number; fired?: boolean; handler: Function }>,
  prev: number,
  curr: number,
  continuous: boolean,
): Array<{ handler: Function; time: number }>

/** Coerce seconds or "mm:ss" to seconds. */
export function parseTime(t: TimeLike): number

// ── Layout ─────────────────────────────────────────────────────────────────

/** How a box fills its solved rect. `cover` is not yet clipped and falls back to `contain`. */
export type Fit = 'contain' | 'cover' | 'fill'

/** Offsets for relative/absolute positioning, in design px. Each may be a function of time. */
export interface Offset {
  top?: Animatable<number>
  left?: Animatable<number>
  right?: Animatable<number>
  bottom?: Animatable<number>
}

/** A margin: one number for all sides, or per-side (design px). */
export type Margin = number | { top?: number; right?: number; bottom?: number; left?: number }

export interface BoxOptions {
  /** Force block-level (breaks the inline line). Leaves are inline by default. */
  display?: 'inline' | 'block'
  /** static (flow), relative (nudge, keep the slot), absolute (out of flow, pinned to
   *  the nearest positioned ancestor), fixed (out of flow, pinned to the viewport and
   *  immune to scroll). */
  position?: 'static' | 'relative' | 'absolute' | 'fixed'
  /** Offset for relative/absolute, design px. Each side may be a function of time. */
  offset?: Offset
  /** Space around the box in flow, design px. */
  margin?: Margin
  /** How the source fills its box. Default 'contain'. */
  fit?: Fit
  /** Explicit box width in design px (overrides intrinsic). May be a function of time. */
  width?: Animatable<number>
  /** Explicit box height in design px (overrides intrinsic). May be a function of time. */
  height?: Animatable<number>
  /** Effect chain applied to this box before it is blended. */
  effects?: PipelineStep[]
  /** Blend mode onto the layers below. Ignored on the base (first) box. Default 'over'. */
  blend?: string
  /** Opacity 0..1. May be a function of time. Default 1. */
  opacity?: Animatable<number>
}

export interface ContainerOptions extends BoxOptions {
  /** Space between children, design px. */
  gap?: number
  /** Inset on all four sides, design px. */
  padding?: number
  /** Cross-axis alignment of children. Default 'start'. */
  align?: 'start' | 'center' | 'end'
  /** Main-axis distribution of children. Default 'start'. */
  justify?: 'start' | 'center' | 'end' | 'between'
}

/** A node in a layout tree — a leaf box or a container. */
export type LayoutNode =
  | { kind: 'box'; source: Source; opts: BoxOptions }
  | { kind: 'container'; display: 'inline' | 'block'; children: LayoutNode[]; opts: ContainerOptions }

/** A leaf box wrapping a single source. */
export function box(source: Source, opts?: BoxOptions): LayoutNode
/** A container whose children flow left-to-right and wrap. */
export function inline(children: Array<LayoutNode | Source>, opts?: ContainerOptions): LayoutNode
/** A container whose children stack top-to-bottom, breaking the surrounding line. */
export function block(children: Array<LayoutNode | Source>, opts?: ContainerOptions): LayoutNode

export interface Rect { x: number; y: number; w: number; h: number }

/** Solve a layout tree into one rect per leaf, in paint order. Pure. */
export function solveLayout(
  root: LayoutNode,
  frame: { width: number; height: number },
  measureSource: (source: Source) => { width: number; height: number },
  fctx?: Partial<FrameContext>,
  scroll?: { x?: number; y?: number },
): {
  order: Array<{ source: Source; effects: PipelineStep[]; blend: string; opacity: number; fit: Fit; fixed: boolean; node: LayoutNode }>
  rects: Array<Rect | undefined>
  content: { width: number; height: number }
  scrollMax: { x: number; y: number }
  scroll: { x: number; y: number }
}

/** Map the fullscreen quad onto a design-space rect, in clip space. */
export function rectToMatrix(rect: Rect, frame: { width: number; height: number }): Float32Array
/** Inset a source of aspect `srcAspect` inside its box per the fit rule. */
export function fitRect(box: Rect, srcAspect: number, fit: Fit): Rect
/** The UV crop [offsetX, offsetY, scaleX, scaleY] for `cover` fit; identity means no crop. */
export function coverUV(box: { w: number; h: number }, srcAspect: number): number[]
/** A source's intrinsic size in design px; zero when not yet known. */
export function intrinsicSize(source: Source): { width: number; height: number }
/** A source's aspect ratio, or 0 if unknown. */
export function aspectOf(source: Source): number

// ── Animation (value-of-time) ────────────────────────────────────────────────

/** A param that is either a constant or a function of the frame context. */
export type Animatable<T> = T | ((ctx: FrameContext) => T)

/** An easing name, or a custom curve mapping 0..1 → 0..1. */
export type Ease = keyof typeof easings | ((t: number) => number)

export interface Keyframe<T extends number | number[]> {
  /** Time in seconds (read from the context field named by `by`, default 'time'). */
  t: number
  /** Value at this frame — a number or an array. */
  v: T
  /** Ease shaping the segment ending at this frame. Default linear. */
  ease?: Ease
}

/** Linear interpolation; numbers or equal-length arrays. */
export function lerp(a: number, b: number, t: number): number
export function lerp(a: number[], b: number[], t: number): number[]

/** Easing curves, each mapping progress 0..1 to eased 0..1. */
export const easings: Record<string, (t: number) => number>

/** A keyframe track: a function of the frame context that interpolates by time. */
export function keyframes<T extends number | number[]>(
  frames: Keyframe<T>[],
  options?: { by?: string; loop?: boolean },
): (ctx: FrameContext) => T

/** A sine oscillator between `from` and `to`; a function of the frame context. */
export function wave(
  options?: { from?: number; to?: number; hz?: number; phase?: number; by?: string },
): (ctx: FrameContext) => number

// ── Offline export ───────────────────────────────────────────────────────────

export interface RecordOptions {
  /** Frames per second. Default 30. */
  fps?: number
  /** Length in seconds. Inferred from the longest clip if omitted. */
  duration?: number
  /** Start time in seconds. Default 0. */
  from?: number
  /** WebCodecs codec string. Default 'vp09.00.10.08' (VP9). Use a VP8/VP9/AV1 codec. */
  codec?: string
  /** Target bitrate in bits/second. Default 8_000_000. */
  bitrate?: number
  /** Force a keyframe every N frames. Default ~2 seconds. */
  keyframeInterval?: number
  /** Progress callback, 0..1. */
  onProgress?: (fraction: number) => void
}

export interface FrameMeta {
  index: number
  /** Frame time in seconds. */
  time: number
  /** Frame time in microseconds (for VideoFrame timestamps). */
  timestamp: number
}

/** The exact frame times of a timeline. Pure. */
export function frameTimestamps(options: { fps?: number; duration: number; from?: number }): FrameMeta[]
/** Walk a timeline deterministically, calling onFrame per rendered frame. */
export function walkFrames(
  tulle: Tulle,
  options: { fps?: number; duration?: number; from?: number },
  onFrame: (canvas: HTMLCanvasElement, meta: FrameMeta) => any,
): Promise<number>
/** Render a composition to a WebM video, deterministically. Requires WebCodecs. */
export function record(tulle: Tulle, options?: RecordOptions): Promise<Blob>

/** A minimal, dependency-free WebM (Matroska/EBML) muxer. */
export class WebMWriter {
  constructor(opts: { width: number; height: number; codec?: string; frameRate?: number })
  addFrame(data: Uint8Array, timestampMs: number, key: boolean): void
  finalize(): Blob
}
/** Encode a value as an EBML variable-length integer. */
export function vint(value: number): Uint8Array
/** Minimal big-endian unsigned integer, at least one byte. */
export function uintBytes(n: number): Uint8Array

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
  /** The sources currently composited, in layer order. */
  readonly sources: Source[]
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
  /** A video Clip source, owned by this Tulle (destroyed with it). Keep it to drive playback and cues. */
  clip(src: string | HTMLVideoElement, options?: ClipOptions): Clip
  /** Arrange sources with a flow layout (inline/block, relative/absolute/fixed). Re-solved each frame. */
  layout(
    node: LayoutNode | Array<LayoutNode | Source> | Source,
    options?: { width?: number; height?: number; scroll?: boolean | 'x' | 'y' | 'both' },
  ): this
  /** Scroll the layout to an absolute offset in design px (clamped). */
  scrollTo(x?: number, y?: number): this
  /** Scroll the layout by a delta in design px (clamped). */
  scrollBy(dx?: number, dy?: number): this
  readonly scrollX: number
  readonly scrollY: number
  readonly scrollMax: { x: number; y: number }
  set(name: string, params: Record<string, unknown>): this
  setLayer(index: number, params: Record<string, unknown>): this
  setLayerEffect(index: number, name: string, params: Record<string, unknown>): this
  setLayerTransform(index: number, transform: Transform | Float32Array | number[] | null): this
  /** Set a layer's UV crop [offsetX, offsetY, scaleX, scaleY], or null for none. Used by cover fit. */
  setLayerUV(index: number, uvRect: Float32Array | number[] | null): this

  render(source?: Source): this
  renderAt(time: number, source?: Source): this
  process(source: Source, name: string, params?: Record<string, unknown>): this
  /** Render the composition to a WebM video, deterministically and offline. Requires WebCodecs. */
  record(options?: RecordOptions): Promise<Blob>
  /** Walk the timeline deterministically, calling onFrame per rendered frame. */
  frames(options: { fps?: number; duration?: number; from?: number }, onFrame: (canvas: HTMLCanvasElement, meta: FrameMeta) => any): Promise<number>
  /** Take over the loop and render `source` (or a source-returning function) every frame. */
  play(source?: Source | (() => Source)): () => void

  start(onFrame?: (ctx: FrameContext, tulle: Tulle) => void): () => void
  stop(): this
  destroy(): void
}
