// Draws the app icon into an .iconset folder: `make-icon <out.iconset>`, then `iconutil -c icns`.
// A speech bubble with a small robot face: messages, read by an agent.
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px) / 1024
  let ctx = NSGraphicsContext.current!.cgContext
  ctx.scaleBy(x: s, y: s)

  // The standard macOS icon body: 824pt rounded square, centered, with a soft shadow.
  let body = CGRect(x: 100, y: 100, width: 824, height: 824)
  let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.3).cgColor)
  ctx.addPath(shape)
  ctx.setFillColor(NSColor.black.cgColor)
  ctx.fillPath()
  ctx.restoreGState()

  ctx.saveGState()
  ctx.addPath(shape)
  ctx.clip()
  let colors = [NSColor(srgbRed: 0.20, green: 0.36, blue: 0.96, alpha: 1).cgColor, NSColor(srgbRed: 0.42, green: 0.20, blue: 0.84, alpha: 1).cgColor]
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(gradient, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
  ctx.restoreGState()

  // The bubble, with its tail at the bottom left.
  let bubble = CGMutablePath()
  bubble.addRoundedRect(in: CGRect(x: 230, y: 330, width: 564, height: 420), cornerWidth: 150, cornerHeight: 150)
  bubble.move(to: CGPoint(x: 300, y: 380))
  bubble.addQuadCurve(to: CGPoint(x: 250, y: 250), control: CGPoint(x: 300, y: 290))
  bubble.addQuadCurve(to: CGPoint(x: 420, y: 340), control: CGPoint(x: 360, y: 280))
  bubble.closeSubpath()
  ctx.addPath(bubble)
  ctx.setFillColor(NSColor.white.cgColor)
  ctx.fillPath()

  // The robot: a rounded head with an antenna, two eyes and a small smile, in one line weight.
  let ink = NSColor(srgbRed: 0.28, green: 0.30, blue: 0.92, alpha: 1).cgColor
  ctx.setStrokeColor(ink)
  ctx.setFillColor(ink)
  ctx.setLineWidth(40)
  ctx.setLineCap(.round)
  ctx.setLineJoin(.round)
  ctx.addPath(CGPath(roundedRect: CGRect(x: 382, y: 415, width: 260, height: 205), cornerWidth: 62, cornerHeight: 62, transform: nil))
  ctx.move(to: CGPoint(x: 512, y: 620))
  ctx.addLine(to: CGPoint(x: 512, y: 664))
  ctx.strokePath()
  ctx.fillEllipse(in: CGRect(x: 488, y: 662, width: 48, height: 48))
  for x in [459, 565] { ctx.fillEllipse(in: CGRect(x: x - 24, y: 513, width: 48, height: 48)) }
  ctx.setLineWidth(26)
  ctx.move(to: CGPoint(x: 476, y: 474))
  ctx.addQuadCurve(to: CGPoint(x: 548, y: 474), control: CGPoint(x: 512, y: 452))
  ctx.strokePath()

  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
  try render(size).write(to: out.appendingPathComponent("icon_\(size)x\(size).png"))
  try render(size * 2).write(to: out.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
