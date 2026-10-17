// Turns a full-bleed square (source.png) into a macOS app icon: the artwork
// clipped to Apple's rounded-square shape on the standard 1024 grid (an
// 824-point body, 100 of margin), with the usual soft shadow.
//
//   swift make-icon.swift source.png icon.png
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let source = NSImage(contentsOfFile: args[1]) else {
  print("Usage: swift make-icon.swift <source.png> <out.png>")
  exit(1)
}

let size = 1024.0
let body = CGRect(x: 100, y: 100, width: 824, height: 824)

// A superellipse (n = 5) is a close match for Apple's continuous-corner shape;
// a plain rounded rect has visibly sharper shoulders.
func squircle(in rect: CGRect, exponent n: Double = 5) -> CGPath {
  let path = CGMutablePath()
  let steps = 720
  for i in 0...steps {
    let t = Double(i) / Double(steps) * 2 * .pi
    let c = cos(t), s = sin(t)
    let x = pow(abs(c), 2 / n) * (c < 0 ? -1 : 1)
    let y = pow(abs(s), 2 / n) * (s < 0 ? -1 : 1)
    let point = CGPoint(x: rect.midX + x * rect.width / 2, y: rect.midY + y * rect.height / 2)
    if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
  }
  path.closeSubpath()
  return path
}

let context = CGContext(
  data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpace(name: CGColorSpace.displayP3)!,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let shape = squircle(in: body)

// The shadow, drawn under an opaque fill of the shape.
context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: CGColor(gray: 0, alpha: 0.35))
context.addPath(shape)
context.setFillColor(CGColor(gray: 0, alpha: 1))
context.fillPath()
context.restoreGState()

// The artwork, clipped to the shape.
context.saveGState()
context.addPath(shape)
context.clip()
var rect = body
let cgSource = source.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
context.interpolationQuality = .high
context.draw(cgSource, in: body)
context.restoreGState()

let rep = NSBitmapImageRep(cgImage: context.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
