// Draws the disk image's window background: `make-background <out-dir>` writes background.png
// and background-2x.png (640 × 400 points), which the build combines into one TIFF.
// The app sits on the left and Applications on the right (see DMG_LAYOUT in build-app.mjs),
// with an arrow between them, as in most Mac app downloads.
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
let size = NSSize(width: 640, height: 400)

func render(scale: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width) * scale, pixelsHigh: Int(size.height) * scale, bitsPerSample: 8,
                             samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = size // Points, so the 2x image is 144 dpi.
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let ctx = NSGraphicsContext.current!.cgContext

  // A soft neutral backdrop, a little lighter at the top. Origin is bottom left.
  let colors = [NSColor(srgbRed: 0.985, green: 0.985, blue: 0.99, alpha: 1).cgColor, NSColor(srgbRed: 0.925, green: 0.93, blue: 0.945, alpha: 1).cgColor]
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size.height), end: .zero, options: [])

  // The arrow, between the icons (centered 190 pt from the top).
  let y = size.height - 190
  let accent = NSColor(srgbRed: 0.33, green: 0.30, blue: 0.90, alpha: 0.85).cgColor
  ctx.setStrokeColor(accent)
  ctx.setLineWidth(5)
  ctx.setLineCap(.round)
  ctx.setLineJoin(.round)
  ctx.move(to: CGPoint(x: 262, y: y))
  ctx.addLine(to: CGPoint(x: 372, y: y))
  ctx.strokePath()
  ctx.move(to: CGPoint(x: 354, y: y + 17))
  ctx.addLine(to: CGPoint(x: 375, y: y))
  ctx.addLine(to: CGPoint(x: 354, y: y - 17))
  ctx.strokePath()

  func text(_ s: String, size points: CGFloat, weight: NSFont.Weight, color: NSColor, top: CGFloat) {
    let style = NSMutableParagraphStyle()
    style.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: points, weight: weight), .foregroundColor: color, .paragraphStyle: style]
    let str = NSAttributedString(string: s, attributes: attrs)
    let h = str.size().height
    str.draw(in: CGRect(x: 0, y: size.height - top - h, width: size.width, height: h))
  }
  text("Drag Messages Agent into Applications", size: 19, weight: .semibold, color: NSColor(white: 0.12, alpha: 1), top: 38)
  text("Then open it from Applications to finish setting up.", size: 13, weight: .regular, color: NSColor(white: 0.42, alpha: 1), top: 296)

  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
try render(scale: 1).write(to: out.appendingPathComponent("background.png"))
try render(scale: 2).write(to: out.appendingPathComponent("background-2x.png"))
