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

// ── Draw ─────────────────────────────────────────────────────────────────────

/** The frame context handed to a Draw painter, plus the surface size. */
export type DrawFrame = Partial<FrameContext> & { width: number; height: number }

/** Painter callback: repaint the surface for this frame. */
export type Painter = (ctx: CanvasRenderingContext2D, frame: DrawFrame) => void

/**
 * A canvas source painted by a callback, re-run once per rendered frame.
 * Canvas 2D is the drawing API; Draw owns only the lifecycle. `new Draw(...)`
 * is caller-owned; `tulle.draw(...)` is owned by the Tulle.
 */
export class Draw implements TexSource {
  constructor(fn: Painter, options: { width: number; height: number })
  readonly texSource: HTMLCanvasElement
  readonly canvas: HTMLCanvasElement
  readonly width: number
  readonly height: number
  /** Resize the surface (clears it). */
  resize(width: number, height: number): this
  /** Swap the painter; the next frame paints with it. */
  set(fn: Painter): this
  /** Repaint. Called once per rendered frame by Tulle. */
  advance(frame?: FrameContext): void
  destroy(): void
}

/** A gradient stop: an [offset, color] pair (0..1), or a bare color spread evenly. */
export type GradientStop = [number, string] | string

/**
 * A dithered linear-gradient canvas — banding-free backdrops. `angle` is in
 * degrees: 0 sweeps left→right, 90 top→bottom (default 90).
 */
export function gradient(
  stops: GradientStop[],
  options: { width: number; height: number; angle?: number; dither?: boolean },
): HTMLCanvasElement

// ── Gaussian splats ─────────────────────────────────────────────────────────

export type Vec3 = [number, number, number]

/** Decoded splats: plain typed arrays, one entry per splat. */
export interface SplatData {
  count: number
  /** 3 per splat — x y z. */
  positions: Float32Array
  /** 3 per splat — linear std-dev along each local axis. */
  scales: Float32Array
  /** 4 per splat — unit quaternion, w x y z. */
  rotations: Float32Array
  /** 4 per splat — r g b a, 0..255, straight alpha. */
  colors: Uint8Array
}

/** SplatData you build yourself: anything but `positions` may be omitted. */
export interface SplatDataInput {
  count?: number
  positions: Float32Array | number[]
  scales?: Float32Array | number[]
  rotations?: Float32Array | number[]
  colors?: Uint8Array | number[]
}

/** A window camera: the rectangle it sees on the plane through `target` stays pinned to the screen. */
export interface SplatCamera {
  position: Vec3
  target: Vec3
  /** Default [0, 1, 0]; auto-framed captures use [0, -1, 0] (COLMAP y-down). */
  up?: Vec3
  /** Vertical field of view, degrees. Default 50. */
  fov?: number
  near?: number
  far?: number
}

/** Eye offset from neutral in screen half-heights: x right, y up, z away from the screen. */
export interface HeadOffset { x: number; y: number; z: number }

/** Anything a Splat can track — a HeadTracker, or your own `{ offset }`. */
export interface HeadLike { readonly offset: HeadOffset }

export interface SplatBounds { min: number[]; max: number[]; center: number[]; radius: number }

export interface SplatOptions {
  /** Surface size in px. `tulle.splat()` fills these from the canvas. */
  width?: number
  height?: number
  /** A camera, or a function of the frame returning one. Omit to frame the scene on load. */
  camera?: SplatCamera | ((frame: Partial<FrameContext>) => SplatCamera)
  head?: HeadLike
  /** How strongly the head moves the eye. Default 1; 0 freezes the view. */
  parallax?: number
  /** `[r, g, b, a]` 0..1, or null (default) for transparent. */
  background?: [number, number, number, number] | null
  /** Back-to-front sort on a worker (default) or this thread. */
  sort?: 'worker' | 'sync'
  /** Std-dev for splats with no scale (point clouds). Default 0.01. */
  pointSize?: number
  /** Passed to fetch() when `src` is a URL. */
  fetch?: RequestInit
}

export interface SplatEvents {
  load: void
  progress: { loaded: number; total: number }
  ready: { count: number; bounds: SplatBounds }
  error: unknown
  unload: void
}

export type SplatSource = string | ArrayBuffer | ArrayBufferView | Blob | SplatDataInput

/**
 * A 3D Gaussian Splatting scene as a source: loads `.ply` / `.splat`, renders
 * through a window camera, optionally coupled to a head tracker.
 * `new Splat(...)` is caller-owned; `tulle.splat(...)` is owned by the Tulle.
 */
export class Splat extends Emitter implements TexSource {
  constructor(src: SplatSource | null, options: SplatOptions & { width: number; height: number })
  readonly texSource: HTMLCanvasElement
  readonly canvas: HTMLCanvasElement
  readonly width: number
  readonly height: number
  /** Splats loaded; 0 before 'ready'. */
  readonly count: number
  readonly bounds: SplatBounds | null
  readonly ready: boolean
  readonly head: HeadLike | null
  camera: SplatOptions['camera'] | null
  parallax: number
  on<K extends keyof SplatEvents>(type: K, handler: (payload: SplatEvents[K]) => void): () => void
  on(type: string, handler: (payload?: any) => void): () => void
  /** Couple the view to a head tracker; null detaches. */
  track(head: HeadLike | null): this
  /** Merge into the current camera. */
  look(camera: Partial<SplatCamera>): this
  /** Frame the scene's bounds from `distance` radii back along +z, y-down. */
  fit(options?: { distance?: number; fov?: number }): this
  resize(width: number, height: number): this
  /** Replace the scene; resolves once it is on the GPU. */
  load(src: SplatSource): Promise<this>
  whenReady(): Promise<this>
  /** Export hook: waits for the scene and sorts the next frame synchronously. */
  seekTo(time: number): Promise<this>
  advance(frame?: FrameContext): void
  destroy(): void
}

export function parseSplatFile(buffer: ArrayBuffer, options?: { pointSize?: number }): SplatData
export function parseSplat(buffer: ArrayBuffer): SplatData
export function parsePly(buffer: ArrayBuffer, options?: { pointSize?: number }): SplatData
export function toSplatData(input: SplatDataInput, options?: { pointSize?: number }): SplatData
/** Write SplatData as a `.splat` file (the inverse of parseSplat). */
export function encodeSplat(data: SplatData): ArrayBuffer
export function packSplats(data: SplatData): { data: Uint32Array; width: number; height: number }
/** Splat indices back to front for a view matrix. */
export function sortSplats(positions: Float32Array, count: number, view: ArrayLike<number>, out?: Uint32Array): Uint32Array
export function boundsOf(positions: Float32Array, count: number): SplatBounds

// ── Image → splats ───────────────────────────────────────────────────────────

/** Relative depth for an image: disparity, larger = nearer. Any scale; it is normalised. */
export interface DepthMap { data: ArrayLike<number>; width: number; height: number }

export const DEPTH_DEFAULTS: {
  /** transformers.js ESM build to import. */
  module: string
  /** Hugging Face model id (a depth-estimation model). */
  model: string
  device: string
  dtype: string
  /** Assigned onto transformers.js `env` (e.g. remoteHost, allowRemoteModels); `wasmPaths`/`numThreads` go to ONNX Runtime. */
  env: Record<string, unknown> | null
}

export interface ImageSplatOptions {
  /** 'model' (default) estimates depth; 'flat' makes a card; or supply a map / a function returning one. */
  depth?: 'model' | 'flat' | DepthMap | ((canvas: HTMLCanvasElement) => DepthMap | Promise<DepthMap>)
  /** Longest side of the sampled grid, px — one splat per pixel. Default 640. */
  maxSize?: number
  /** Vertical field of view the photo is assumed to have, degrees. Default 50. */
  fov?: number
  /** Farthest depth relative to the nearest (1). Larger = deeper. Default 3. */
  far?: number
  /** Coarse plate behind foreground edges, so leaning reveals background, not holes. Default true. */
  backfill?: boolean
  /** How far the plate reaches under foreground, as a fraction of the long side. Default 0.08. */
  reach?: number
  /** How much tighter the returned camera frames than the photo. Default 0.08. */
  overscan?: number
  model?: Partial<typeof DEPTH_DEFAULTS>
  onProgress?: (p: { stage: 'model' | 'depth' | 'build'; loaded?: number; total?: number; file?: string }) => void
}

/**
 * Turn a photo into splats: estimate depth (in a worker), lift each pixel onto
 * its ray. `camera` reproduces the photo's framing with the median depth on the glass.
 */
export function imageToSplat(
  image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | Blob | string,
  options?: ImageSplatOptions,
): Promise<{ data: SplatData; camera: SplatCamera; width: number; height: number }>

/** Depth Anything V2 (via transformers.js, from a CDN) on a canvas. */
export function estimateDepth(
  canvas: HTMLCanvasElement,
  options?: { model?: Partial<typeof DEPTH_DEFAULTS>; onProgress?: ImageSplatOptions['onProgress'] },
): Promise<DepthMap>

/** The pure core: RGBA pixels + 0..1 disparity in, splats and a matching camera out. */
export function splatFromDepth(
  input: { pixels: ArrayLike<number>; disparity: ArrayLike<number>; width: number; height: number },
  options?: Pick<ImageSplatOptions, 'fov' | 'far' | 'backfill' | 'reach' | 'overscan'>,
): { data: SplatData; camera: SplatCamera }

/** Snap depth-edge ramps to their near or far side, so edges don't leave pixels floating. */
export function snapEdges(z: Float32Array, width: number, height: number, footprint: number, radius?: number): Float32Array

/** Resample a depth map to width×height (bilinear) and stretch it to 0..1. */
export function normalizeDepth(map: DepthMap, width: number, height: number): Float32Array

// ── Head tracking ────────────────────────────────────────────────────────────

/** An eye position in mm from the camera: x the viewer's right, y up, z distance. */
export interface HeadPose { x: number; y: number; z: number }

export interface HeadTrackerOptions {
  source?: 'webcam' | 'pointer' | 'manual'
  /** For the pointer source and fallback; `tulle.head()` passes the Tulle's own. */
  pointer?: PointerState | null
  /** When the webcam can't start: switch to the pointer (default) or reject (null). */
  fallback?: 'pointer' | null
  /** Physical screen height in mm — the unit offsets are measured in. Default 190. */
  screenHeight?: number
  /** Webcam horizontal field of view, degrees. Default 60. */
  cameraFov?: number
  /** Interpupillary distance, mm. Default 63. */
  ipd?: number
  /** One Euro filter params. Defaults { minCutoff: 1, beta: 0.01 }. */
  smoothing?: { minCutoff?: number; beta?: number }
  /** Seconds without a face before 'lost'. Default 0.5. */
  lostAfter?: number
  /** A ready MediaPipe FaceLandmarker in VIDEO mode. */
  landmarker?: unknown
  /** A custom detector replacing MediaPipe: return a pose in mm, or null for no face. */
  detect?: (video: HTMLVideoElement, timeMs: number) => HeadPose | null
  /** Override where MediaPipe is loaded from. */
  vision?: Partial<typeof VISION_DEFAULTS>
}

export interface HeadTrackerEvents {
  start: { source: 'webcam' | 'pointer' | 'manual' }
  stop: void
  pose: { pose: HeadPose; offset: HeadOffset }
  found: void
  lost: void
  /** The webcam couldn't start; the pointer took over. */
  fallback: unknown
  error: unknown
  destroy: void
}

export const VISION_DEFAULTS: { module: string; wasm: string; model: string }

/** Where the viewer's eyes are relative to the screen — webcam, pointer, or fed by hand. */
export class HeadTracker extends Emitter implements HeadLike {
  constructor(options?: HeadTrackerOptions)
  readonly source: 'webcam' | 'pointer' | 'manual'
  readonly running: boolean
  readonly tracking: boolean
  /** The webcam stream's <video>, for a preview. */
  readonly video: HTMLVideoElement | null
  /** Smoothed eye position in mm from the camera. */
  readonly pose: HeadPose | null
  readonly neutral: HeadPose | null
  readonly offset: HeadOffset
  on<K extends keyof HeadTrackerEvents>(type: K, handler: (payload: HeadTrackerEvents[K]) => void): () => void
  on(type: string, handler: (payload?: any) => void): () => void
  /** Begin tracking. For the webcam this prompts for camera access. */
  start(): Promise<this>
  stop(): this
  /** Make the current head position the neutral one. */
  recenter(): this
  /** Feed a raw pose (mm from the camera). The input path for the 'manual' source. */
  update(pose: HeadPose, timeMs?: number): this
  destroy(): void
}

/** The One Euro low-pass filter: smooth at rest, responsive in motion. */
export class OneEuro {
  constructor(options?: { minCutoff?: number; beta?: number; dCutoff?: number })
  filter(value: number, timeSeconds: number): number
  reset(): this
}

/** Eye midpoint in mm from normalised MediaPipe FaceMesh landmarks. */
export function poseFromLandmarks(
  landmarks: Array<{ x: number; y: number; z?: number }>,
  camera: { width: number; height: number; fov?: number; ipd?: number },
): HeadPose

// ── Camera math ──────────────────────────────────────────────────────────────

/** The off-axis window camera: `offset` moves the eye, the window stays pinned to the screen. */
export function windowCamera(
  camera: SplatCamera & { aspect?: number },
  offset?: Partial<HeadOffset> | null,
  parallax?: number,
): { view: Float32Array; proj: Float32Array; eye: Vec3 }
export function lookAt(position: Vec3, target: Vec3, up?: Vec3): Float32Array
export function perspective(fov: number, aspect: number, near: number, far: number): Float32Array
export function frustum(l: number, r: number, b: number, t: number, n: number, f: number): Float32Array

// ── Layout ─────────────────────────────────────────────────────────────────

/** How a box fills its solved rect: `contain` letterboxes, `cover` centre-crops via UV, `fill` stretches. */
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
  /** Paint-time rotation about the box centre, radians, counter-clockwise.
   *  CSS-transform semantics: the box keeps its flow slot. May be a function of time. */
  rotate?: Animatable<number>
  /** Paint-time scale about the box centre — a factor, or [sx, sy]. Keeps the flow
   *  slot. May be a function of time. Default 1. */
  scale?: Animatable<number | [number, number]>
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

/** Map the fullscreen quad onto a design-space rect, in clip space. `rotate` (radians,
 *  counter-clockwise) and `scale` apply about the rect centre, after layout. */
export function rectToMatrix(
  rect: Rect,
  frame: { width: number; height: number },
  rotate?: number,
  scale?: number | [number, number],
): Float32Array
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

export interface TweenOptions {
  /** Length of the transition in seconds. Default 0.6. */
  duration?: number
  /** Seconds to wait after the start before moving. Default 0. */
  delay?: number
  /** Easing name or curve. Default 'outCubic'. */
  ease?: Ease
  /** Explicit start time in seconds. Omit to latch on first evaluation. */
  at?: number
  /** Context field to read time from. Default 'time'. */
  by?: string
}

/**
 * A one-shot transition from `from` to `to`; a function of the frame context.
 * The start latches on first evaluation unless `at` pins it.
 */
export function tween(
  options?: TweenOptions & { from?: number | number[]; to?: number | number[] },
): (ctx: FrameContext) => number | number[]

/** Opacity 0 → 1. */
export function fadeIn(options?: TweenOptions): (ctx: FrameContext) => number
/** Opacity 1 → 0. */
export function fadeOut(options?: TweenOptions): (ctx: FrameContext) => number
/** From `distance` px away, settling at the flow position — drive an offset side. */
export function slideFrom(distance: number, options?: TweenOptions): (ctx: FrameContext) => number
/** From the flow position, departing to `distance` px away. */
export function slideTo(distance: number, options?: TweenOptions): (ctx: FrameContext) => number
/** From `factor` of the box size, settling at full size — drive the box `scale`. */
export function scaleFrom(factor: number, options?: TweenOptions): (ctx: FrameContext) => number
/** From full size, ending at `factor` of the box size. */
export function scaleTo(factor: number, options?: TweenOptions): (ctx: FrameContext) => number
/** From `angle` radians (counter-clockwise), settling upright — drive the box `rotate`. */
export function rotateFrom(angle: number, options?: TweenOptions): (ctx: FrameContext) => number
/** From upright, ending at `angle` radians. */
export function rotateTo(angle: number, options?: TweenOptions): (ctx: FrameContext) => number

/**
 * Scroll-linked progress: 0 before `start`, 1 after `end`, eased in between.
 * `start > end` runs in reverse. `by` defaults to 'scrollY'.
 */
export function scrollRange(
  start: number,
  end: number,
  options?: { ease?: Ease; by?: string },
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
  /** A Draw source sized to this canvas, owned by this Tulle — repainted by `fn` once per rendered frame. */
  draw(fn: Painter, options?: { width?: number; height?: number }): Draw
  /** A 3D Gaussian Splatting source sized to this canvas, owned by this Tulle. */
  splat(src: SplatSource, options?: SplatOptions): Splat
  /** A head tracker (webcam, falling back to this canvas' pointer), owned by this Tulle. Call start(). */
  head(options?: HeadTrackerOptions): HeadTracker
  /** A dithered linear-gradient canvas sized to this canvas. */
  gradient(stops: GradientStop[], options?: { width?: number; height?: number; angle?: number; dither?: boolean }): HTMLCanvasElement
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
