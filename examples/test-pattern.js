/**
 * A generated source image, so every example has something to render without
 * asking the user for a file first.
 *
 * Deliberately busy: hard colour edges reveal chromatic aberration, the fine
 * grid reveals blur, and the flat dark corners reveal grain and vignetting.
 */
export function createTestPattern(width = 600, height = 400) {
  const canvas = document.createElement('canvas')
  canvas.width  = width
  canvas.height = height
  draw(canvas.getContext('2d'), width, height)
  return canvas
}

function draw(ctx, w, h) {
  const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 1.5)
  bg.addColorStop(0,   '#3b1f6e')
  bg.addColorStop(0.4, '#1a0a40')
  bg.addColorStop(1,   '#000')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.lineWidth = 1
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke() }
  for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke() }

  const bands = [
    ['rgba(255,60,60,0.6)',  w * 0.2],
    ['rgba(60,255,120,0.6)', w * 0.5],
    ['rgba(60,120,255,0.6)', w * 0.8],
  ]
  for (const [color, cx] of bands) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.ellipse(cx, h * 0.5, 120, 120, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  const dot = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, 60)
  dot.addColorStop(0, 'rgba(255,255,255,0.9)')
  dot.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = dot
  ctx.beginPath()
  ctx.arc(w / 2, h / 2, 60, 0, Math.PI * 2)
  ctx.fill()
}
