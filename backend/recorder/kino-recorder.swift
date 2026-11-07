// kino-recorder: records a display, a window or an area of the screen for kino, with the pointer
// and the clicks kept apart from the picture so kino can redraw them (backend/recorder/recorder.mjs).
//
//   kino-recorder serve                        JSON lines on stdin and stdout (kino uses this)
//   kino-recorder schema                       every method, its fields and what it does
//   kino-recorder call <method> '<json>'       one call from a shell; "record" runs until a stop rule
//   kino-recorder --version
//
// A recording is a folder: screen.mp4 (fragmented every 2 s, so a crash keeps all but the last
// fragment), recording.json, events.jsonl (pointer, clicks, keys, marks, caret) and cursors/.
// Times are video seconds (pauses cut out); points are from the captured region's top-left.
// The picture is captured with ScreenCaptureKit without the pointer; the pointer is sampled
// every display frame and each pointer image is saved once. Clicks and keys come from a
// listen-only event tap, which also tells a program's posted events (an agent) from hardware
// ones (a person). Without that permission clicks are seen by polling (source "unknown").
import AppKit
import ApplicationServices
import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let VERSION = "kino-recorder 1"

// MARK: - Output

// JSON text with keys sorted and numbers at most 3 decimals (JSONSerialization prints 0.1 as
// 0.10000000000000001, which would triple the size of events.jsonl).
func jsonText(_ value: Any) -> String {
  switch value {
  case let text as String:
    var out = "\""
    for scalar in text.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default: out += scalar.value < 0x20 ? String(format: "\\u%04x", scalar.value) : String(scalar)
      }
    }
    return out + "\""
  case let number as NSNumber:
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
    let double = number.doubleValue
    guard double.isFinite else { return "null" }
    if double == double.rounded(), abs(double) < 1e15 { return String(Int64(double)) }
    var text = String(format: "%.3f", double)
    while text.hasSuffix("0") { text.removeLast() }
    return text
  case let list as [Any]: return "[" + list.map(jsonText).joined(separator: ",") + "]"
  case let object as [String: Any]: return "{" + object.keys.sorted().map { jsonText($0) + ":" + jsonText(object[$0]!) }.joined(separator: ",") + "}"
  default: return "null"
  }
}

let outputLock = NSLock()
func writeLine(_ object: [String: Any]) {
  let data = Data((jsonText(object) + "\n").utf8)
  outputLock.withLock { FileHandle.standardOutput.write(data) }
}

struct RecorderError: Error {
  let code: String
  let message: String
}

func round2(_ value: Double) -> Double { (value * 100).rounded() / 100 }
func round1(_ value: Double) -> Double { (value * 10).rounded() / 10 }
func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }

// MARK: - Permissions

func permissions() -> [String: Any] {
  ["screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "inputMonitoring": CGPreflightListenEventAccess()]
}

func requestPermissions(_ params: [String: Any]) -> [String: Any] {
  let wanted = (params["permissions"] as? [String]) ?? ["screen"]
  if wanted.contains("screen") && !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
  if wanted.contains("inputMonitoring") && !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
  if wanted.contains("accessibility") && !AXIsProcessTrusted() {
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
  }
  return permissions()
}

// MARK: - Screens and windows

func shareableContent() async throws -> SCShareableContent {
  guard CGPreflightScreenCaptureAccess() else {
    throw RecorderError(code: "permission", message: "kino needs Screen Recording permission: System Settings > Privacy & Security > Screen Recording, turn kino on, then try again.")
  }
  return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
}

func pixelsPerPoint(_ displayID: CGDirectDisplayID) -> Double {
  guard let mode = CGDisplayCopyDisplayMode(displayID), mode.width > 0 else { return 1 }
  return Double(mode.pixelWidth) / Double(mode.width)
}

func refreshRate(_ displayID: CGDirectDisplayID) -> Double {
  let rate = CGDisplayCopyDisplayMode(displayID)?.refreshRate ?? 0
  return rate > 1 ? rate : 60
}

func describe(display: SCDisplay) -> [String: Any] {
  ["id": Int(display.displayID), "x": display.frame.origin.x, "y": display.frame.origin.y, "width": display.width, "height": display.height,
   "scale": pixelsPerPoint(display.displayID), "main": CGDisplayIsMain(display.displayID) != 0, "fps": refreshRate(display.displayID)]
}

func listDisplays() async throws -> [String: Any] {
  let content = try await shareableContent()
  return ["displays": content.displays.map(describe(display:))]
}

func usableWindows(_ content: SCShareableContent) -> [SCWindow] {
  content.windows.filter { window in
    window.windowLayer == 0 && window.frame.width >= 50 && window.frame.height >= 50 && window.owningApplication != nil
      && window.owningApplication?.bundleIdentifier != Bundle.main.bundleIdentifier
  }
}

func describe(window: SCWindow) -> [String: Any] {
  let app = window.owningApplication
  var title = window.title ?? ""
  if title.count > 80 { title = String(title.prefix(79)) + "…" }
  return ["id": Int(window.windowID), "app": app?.applicationName ?? "", "bundleId": app?.bundleIdentifier ?? "", "title": title,
          "x": window.frame.origin.x, "y": window.frame.origin.y, "width": window.frame.width, "height": window.frame.height, "onScreen": window.isOnScreen]
}

func listWindows(_ params: [String: Any]) async throws -> [String: Any] {
  let content = try await shareableContent()
  var windows = usableWindows(content)
  if let app = params["app"] as? String, !app.isEmpty {
    let wanted = app.lowercased()
    windows = windows.filter { ($0.owningApplication?.bundleIdentifier.lowercased() == wanted) || ($0.owningApplication?.applicationName.lowercased() == wanted) }
  }
  if params["all"] as? Bool != true { windows = windows.filter { $0.isOnScreen } }
  return ["windows": windows.prefix(60).map(describe(window:))]
}

// MARK: - Cursor images

// The pointer's outline on a 16x16 grid over its visible pixels, and its hotspot as a share of
// that box, so a large (accessibility size) pointer with padding matches the standard one.
let GRID = 16
func outline(_ cursor: NSCursor) -> (cells: [Bool], hot: CGPoint) {
  let size = cursor.image.size
  guard size.width > 0, size.height > 0, let cg = cursor.image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return ([], .zero) }
  let width = cg.width, height = cg.height
  var alpha = [UInt8](repeating: 0, count: width * height)
  let drawn = alpha.withUnsafeMutableBytes { bytes -> Bool in
    guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue) else { return false }
    context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  guard drawn else { return ([], .zero) }
  // Rows run top to bottom in the buffer. Shadows are soft, so only strong pixels count.
  var minX = width, minY = height, maxX = -1, maxY = -1
  for y in 0..<height { for x in 0..<width where alpha[y * width + x] > 200 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } }
  guard maxX >= minX, maxY >= minY else { return ([], .zero) }
  let boxW = Double(maxX - minX + 1), boxH = Double(maxY - minY + 1)
  var cells = [Bool](repeating: false, count: GRID * GRID)
  for gy in 0..<GRID { for gx in 0..<GRID {
    let x = minX + Int((Double(gx) + 0.5) * boxW / Double(GRID)), y = minY + Int((Double(gy) + 0.5) * boxH / Double(GRID))
    cells[gy * GRID + gx] = alpha[min(height - 1, y) * width + min(width - 1, x)] > 200
  } }
  let perPoint = Double(width) / size.width
  let hot = CGPoint(x: (cursor.hotSpot.x * perPoint - Double(minX)) / boxW, y: (cursor.hotSpot.y * perPoint - Double(minY)) / boxH)
  return (cells, hot)
}

func overlap(_ a: [Bool], _ b: [Bool]) -> Double {
  guard a.count == b.count, !a.isEmpty else { return 0 }
  let both = zip(a, b).filter { $0 && $1 }.count, either = zip(a, b).filter { $0 || $1 }.count
  return either == 0 ? 0 : Double(both) / Double(either)
}

final class CursorBook {
  var ids: [Int: String] = [:]
  var entries: [String: [String: Any]] = [:]
  let folder: URL
  // Measured on first use, on the main thread like every pointer read.
  lazy var known: [(outline: [Bool], hot: CGPoint, shape: String)] = {
    let named: [(NSCursor, String)] = [
      (.arrow, "arrow"), (.pointingHand, "pointer"), (.iBeam, "text"), (.crosshair, "crosshair"), (.openHand, "grab"),
      (.closedHand, "grabbing"), (.operationNotAllowed, "notAllowed"), (.resizeLeftRight, "resize"), (.resizeUpDown, "resize"),
      (.resizeLeft, "resize"), (.resizeRight, "resize"), (.resizeUp, "resize"), (.resizeDown, "resize"), (.iBeamCursorForVerticalLayout, "text"),
    ]
    return named.map { cursor, shape in let found = outline(cursor); return (found.cells, found.hot, shape) }
  }()

  init(folder: URL) { self.folder = folder }

  func scores(_ cursor: NSCursor) -> [(Double, String)] {
    let (mine, hot) = outline(cursor)
    return known.map { entry in (overlap(mine, entry.outline) - 0.3 * hypot(hot.x - entry.hot.x, hot.y - entry.hot.y), entry.shape) }
      .sorted { $0.0 > $1.0 }
  }

  // The standard shape whose outline and hotspot are nearest, or other.
  func shape(of cursor: NSCursor) -> String {
    guard let best = scores(cursor).first, best.0 >= 0.55 else { return "other" }
    return best.1
  }

  static func fingerprint(_ cursor: NSCursor) -> Int {
    var hasher = Hasher()
    hasher.combine(cursor.image.tiffRepresentation ?? Data())
    hasher.combine(Int(cursor.hotSpot.x * 10))
    hasher.combine(Int(cursor.hotSpot.y * 10))
    return hasher.finalize()
  }

  /// The id of the system's current pointer image, saving the image the first time it is seen.
  func current() -> String? {
    guard let cursor = NSCursor.currentSystem else { return nil }
    let key = CursorBook.fingerprint(cursor)
    if let id = ids[key] { return id }
    let id = "c\(ids.count + 1)"
    ids[key] = id
    let image = cursor.image
    let best = image.representations.max { $0.pixelsWide < $1.pixelsWide }
    var file: String? = nil
    if let best, let cg = best.cgImage(forProposedRect: nil, context: nil, hints: nil) {
      let rep = NSBitmapImageRep(cgImage: cg)
      if let png = rep.representation(using: .png, properties: [:]) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("\(id).png")
        if (try? png.write(to: url)) != nil { file = "cursors/\(id).png" }
      }
    }
    var entry: [String: Any] = ["hotspot": [round1(cursor.hotSpot.x), round1(cursor.hotSpot.y)], "size": [round1(image.size.width), round1(image.size.height)], "shape": shape(of: cursor)]
    if let file { entry["file"] = file }
    entries[id] = entry
    return id
  }
}

// MARK: - Keys

func keyKind(_ event: CGEvent) -> (kind: String, mods: [String], shortcut: Bool) {
  let flags = event.flags
  var mods: [String] = []
  if flags.contains(.maskCommand) { mods.append("cmd") }
  if flags.contains(.maskControl) { mods.append("ctrl") }
  if flags.contains(.maskAlternate) { mods.append("alt") }
  if flags.contains(.maskShift) { mods.append("shift") }
  let shortcut = flags.contains(.maskCommand) || flags.contains(.maskControl)
  let code = event.getIntegerValueField(.keyboardEventKeycode)
  let named: [Int64: String] = [36: "enter", 76: "enter", 48: "tab", 49: "space", 51: "delete", 117: "delete", 53: "escape", 123: "arrow", 124: "arrow", 125: "arrow", 126: "arrow"]
  if let name = named[code] { return (name, mods, shortcut) }
  let text = NSEvent(cgEvent: event)?.charactersIgnoringModifiers ?? ""
  guard let scalar = text.unicodeScalars.first else { return ("other", mods, shortcut) }
  if CharacterSet.letters.contains(scalar) { return ("letter", mods, shortcut) }
  if CharacterSet.decimalDigits.contains(scalar) { return ("digit", mods, shortcut) }
  if CharacterSet.punctuationCharacters.contains(scalar) || CharacterSet.symbols.contains(scalar) { return ("punctuation", mods, shortcut) }
  return ("other", mods, shortcut)
}

// MARK: - Recording

struct Options {
  var folder: URL
  var kind = "display"
  var displayID: CGDirectDisplayID? = nil
  var windowID: CGWindowID? = nil
  var app: String? = nil
  var area: CGRect? = nil
  var fps = 60.0
  var maxSide = 1920.0
  var codec = "h264"
  var systemAudio = false
  var mic = false
  var keys = "off"
  var caret = true
  var maxSeconds = 600.0
  var idleSeconds = 0.0
  var excludeApps: [String] = []

  init(_ params: [String: Any]) throws {
    guard let folder = params["folder"] as? String, folder.hasPrefix("/") else {
      throw RecorderError(code: "options", message: "folder must be an absolute path for the new recording folder.")
    }
    self.folder = URL(fileURLWithPath: folder)
    let target = params["target"] as? [String: Any] ?? [:]
    if let id = target["window"] as? Int { kind = "window"; windowID = CGWindowID(id) }
    else if let app = target["app"] as? String { kind = "window"; self.app = app }
    else if let area = target["area"] as? [String: Any] {
      kind = "area"
      let number = { (key: String) in (area[key] as? NSNumber)?.doubleValue ?? 0 }
      self.area = CGRect(x: number("x"), y: number("y"), width: number("width"), height: number("height"))
      guard self.area!.width >= 16, self.area!.height >= 16 else { throw RecorderError(code: "options", message: "area needs width and height of at least 16 points.") }
    }
    if let id = target["display"] as? Int { displayID = CGDirectDisplayID(id) }
    if let fps = (params["fps"] as? NSNumber)?.doubleValue { self.fps = min(120, max(1, fps)) }
    if let size = params["size"] as? String, size == "full" { maxSide = 100_000 }
    else if let size = (params["size"] as? NSNumber)?.doubleValue { maxSide = min(8192, max(320, size)) }
    if let codec = params["codec"] as? String {
      guard ["h264", "hevc"].contains(codec) else { throw RecorderError(code: "options", message: "codec must be h264 or hevc.") }
      self.codec = codec
    }
    systemAudio = params["audio"] as? Bool ?? false
    mic = params["mic"] as? Bool ?? false
    if let keys = params["keys"] as? String {
      guard ["off", "kinds", "characters"].contains(keys) else { throw RecorderError(code: "options", message: "keys must be off, kinds or characters.") }
      self.keys = keys
    }
    caret = params["caret"] as? Bool ?? true
    if let seconds = (params["maxSeconds"] as? NSNumber)?.doubleValue { maxSeconds = min(4 * 3600, max(1, seconds)) }
    if let seconds = (params["idleSeconds"] as? NSNumber)?.doubleValue { idleSeconds = max(0, seconds) }
    excludeApps = params["excludeApps"] as? [String] ?? []
  }
}

func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

func retimed(_ sample: CMSampleBuffer, minus offset: CMTime, at forced: CMTime? = nil) -> CMSampleBuffer? {
  var count: CMItemCount = 0
  CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
  guard count > 0 else { return nil }
  var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
  CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
  for index in timing.indices {
    timing[index].presentationTimeStamp = forced ?? CMTimeSubtract(timing[index].presentationTimeStamp, offset)
    timing[index].decodeTimeStamp = .invalid
    if forced != nil { timing[index].duration = .invalid }
  }
  var copy: CMSampleBuffer?
  CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: count, sampleTimingArray: &timing, sampleBufferOut: &copy)
  return copy
}

final class Recording: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let options: Options
  let lock = NSLock()
  let mediaQueue = DispatchQueue(label: "kino.recorder.media")
  let eventQueue = DispatchQueue(label: "kino.recorder.events")
  var onStopped: (([String: Any]) -> Void)?

  var stream: SCStream?
  var writer: AVAssetWriter?
  var videoInput: AVAssetWriterInput?
  var systemInput: AVAssetWriterInput?
  var micInput: AVAssetWriterInput?
  var events: FileHandle?
  var cursors: CursorBook

  var state = "starting"
  var target: [String: Any] = [:]
  var region = CGRect.zero
  var pixelSize = CGSize.zero
  var startedAt = Date()
  var firstFrame: CMTime? = nil
  var pausedTotal = CMTime.zero
  var pausedSince: CMTime? = nil
  var pauses: [[String: Any]] = []
  var lastSample: CMSampleBuffer? = nil
  var lastSampleTime = CMTime.zero
  var holder: DispatchSourceTimer? = nil
  var lastActivity = hostNow()
  var stoppedReason: String? = nil
  var errorText: String? = nil
  var counts: [String: Int] = ["move": 0, "down": 0, "key": 0, "mark": 0, "scroll": 0, "caret": 0]

  var sampler: Timer?
  var watcher: Timer?
  var tap: CFMachPort?
  var tapSource: CFRunLoopSource?
  var buttons = 0
  var lastMove: (x: Double, y: Double, cursor: String?) = (.nan, .nan, nil)
  var lastCaret: CGRect? = nil
  var lastKeyAt = CMTime.zero
  var sampleTick = 0
  var currentCursor: String? = nil

  init(options: Options) {
    self.options = options
    self.cursors = CursorBook(folder: options.folder.appendingPathComponent("cursors"))
  }

  // Video seconds now, or nil before the first frame or while paused.
  func videoTime(_ now: CMTime = hostNow()) -> Double? {
    lock.lock(); defer { lock.unlock() }
    guard let first = firstFrame, pausedSince == nil, state == "recording" else { return nil }
    return CMTimeSubtract(CMTimeSubtract(now, first), pausedTotal).seconds
  }

  func log(_ event: [String: Any]) {
    eventQueue.async { [self] in events?.write(Data((jsonText(event) + "\n").utf8)) }
  }

  func record(_ type: String, _ fields: [String: Any], at now: CMTime = hostNow()) {
    guard let t = videoTime(now) else { return }
    var event = fields
    event["t"] = round3(max(0, t))
    event["type"] = type
    lock.lock(); counts[type, default: 0] += 1; if type != "move" { lastActivity = now }; lock.unlock()
    log(event)
  }

  func local(_ point: CGPoint) -> (Double, Double) {
    lock.lock(); let origin = region.origin; lock.unlock()
    return (round1(point.x - origin.x), round1(point.y - origin.y))
  }

  // MARK: start

  func start() async throws -> [String: Any] {
    let fm = FileManager.default
    if fm.fileExists(atPath: options.folder.path) { throw RecorderError(code: "options", message: "\(options.folder.path) already exists; give a new folder.") }
    let content = try await shareableContent()
    let filter: SCContentFilter
    let config = SCStreamConfiguration()
    var displayID = options.displayID ?? CGMainDisplayID()
    var regionPoints: CGRect

    if options.kind == "window" {
      let windows = usableWindows(content)
      var window: SCWindow?
      if let id = options.windowID { window = windows.first { $0.windowID == id } }
      else if let app = options.app?.lowercased() {
        window = windows.filter { $0.isOnScreen && (($0.owningApplication?.bundleIdentifier.lowercased() == app) || ($0.owningApplication?.applicationName.lowercased() == app)) }
          .max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
      }
      guard let window else { throw RecorderError(code: "target", message: "No such window; windows lists the ones kino can record.") }
      filter = SCContentFilter(desktopIndependentWindow: window)
      regionPoints = window.frame
      if let display = content.displays.first(where: { $0.frame.intersects(window.frame) }) { displayID = display.displayID }
      let app = window.owningApplication
      target = ["kind": "window", "windowId": Int(window.windowID), "app": app?.applicationName ?? "", "bundleId": app?.bundleIdentifier ?? "", "displayId": Int(displayID)]
    } else {
      guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else {
        throw RecorderError(code: "target", message: "No display to record.")
      }
      displayID = display.displayID
      let excluded = content.applications.filter { options.excludeApps.contains($0.bundleIdentifier) }
      filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
      regionPoints = display.frame
      target = ["kind": options.kind, "displayId": Int(displayID)]
      if options.kind == "area", let area = options.area {
        let bounds = CGRect(origin: .zero, size: display.frame.size)
        let clipped = area.intersection(bounds)
        guard clipped.width >= 16, clipped.height >= 16 else { throw RecorderError(code: "target", message: "The area is outside the display (\(Int(bounds.width))x\(Int(bounds.height)) points).") }
        config.sourceRect = clipped
        regionPoints = clipped.offsetBy(dx: display.frame.origin.x, dy: display.frame.origin.y)
      }
    }

    // The picture: the display's pixels, at most maxSide on the long side, even sizes.
    let native = pixelsPerPoint(displayID)
    let fit = min(native, options.maxSide / max(regionPoints.width, regionPoints.height))
    let even = { (value: Double) in max(16, 2 * Int((value / 2).rounded())) }
    let width = even(regionPoints.width * fit), height = even(regionPoints.height * fit)
    let codec: AVVideoCodecType = (options.codec == "hevc" || max(width, height) > 4096) ? .hevc : .h264
    config.width = width
    config.height = height
    config.showsCursor = false
    config.queueDepth = 8
    config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    config.colorSpaceName = CGColorSpace.sRGB
    config.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
    let fps = min(options.fps, refreshRate(displayID))
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps.rounded()))
    if options.systemAudio {
      config.capturesAudio = true
      config.excludesCurrentProcessAudio = true
      config.sampleRate = 48_000
      config.channelCount = 2
    }
    if options.mic {
      guard #available(macOS 15.0, *) else { throw RecorderError(code: "options", message: "Recording the microphone needs macOS 15 or later.") }
      config.captureMicrophone = true
    }

    try fm.createDirectory(at: options.folder, withIntermediateDirectories: true)
    let writer = try AVAssetWriter(outputURL: options.folder.appendingPathComponent("screen.mp4"), fileType: .mp4)
    writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
    writer.shouldOptimizeForNetworkUse = false
    let pixels = Double(width * height)
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: codec, AVVideoWidthKey: width, AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: Int(min(80_000_000, max(2_000_000, pixels * min(fps, 60) * (codec == .hevc ? 0.06 : 0.1)))),
        AVVideoExpectedSourceFrameRateKey: Int(fps.rounded()), AVVideoMaxKeyFrameIntervalKey: Int(fps.rounded()) * 2,
        AVVideoAllowFrameReorderingKey: false,
      ],
      AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
    ])
    video.expectsMediaDataInRealTime = true
    guard writer.canAdd(video) else { throw RecorderError(code: "encoder", message: "The video encoder refused \(width)x\(height).") }
    writer.add(video)
    let audioSettings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 160_000]
    if options.systemAudio {
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
      input.expectsMediaDataInRealTime = true
      if writer.canAdd(input) { writer.add(input); systemInput = input }
    }
    if options.mic {
      let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 96_000])
      input.expectsMediaDataInRealTime = true
      if writer.canAdd(input) { writer.add(input); micInput = input }
    }
    guard writer.startWriting() else { throw RecorderError(code: "encoder", message: writer.error?.localizedDescription ?? "The video writer did not start.") }
    writer.startSession(atSourceTime: .zero)
    self.writer = writer
    self.videoInput = video

    FileManager.default.createFile(atPath: options.folder.appendingPathComponent("events.jsonl").path, contents: nil)
    events = try FileHandle(forWritingTo: options.folder.appendingPathComponent("events.jsonl"))
    lock.withLock {
      region = regionPoints
      pixelSize = CGSize(width: width, height: height)
      startedAt = Date()
    }
    target["codec"] = codec == .hevc ? "hevc" : "h264"
    target["fps"] = fps

    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: mediaQueue)
    if options.systemAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: mediaQueue) }
    if options.mic, #available(macOS 15.0, *) { try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: mediaQueue) }
    self.stream = stream
    lock.withLock { state = "recording" }
    try writeMeta()
    do { try await stream.startCapture() } catch {
      lock.withLock { state = "stopped" }
      writer.cancelWriting()
      try? fm.removeItem(at: options.folder)
      throw RecorderError(code: "capture", message: "Screen capture did not start: \(error.localizedDescription)")
    }
    await MainActor.run { startInput() }
    // A still screen sends no frames: the last picture is repeated so the file keeps a steady
    // frame rate (an editor reads a file's average rate).
    let frame = CMTime(seconds: 1 / fps, preferredTimescale: 60_000)
    let hold = DispatchSource.makeTimerSource(queue: mediaQueue)
    hold.schedule(deadline: .now() + 0.2, repeating: 1.0 / Double(fps), leeway: .milliseconds(2))
    hold.setEventHandler { [weak self] in self?.holdFrame(frame) }
    hold.resume()
    holder = hold
    return status()
  }

  // MARK: media

  // On mediaQueue: repeats the last picture one frame on when the screen sent nothing for two frames.
  func holdFrame(_ frame: CMTime) {
    guard let last = lastSample, let input = videoInput, input.isReadyForMoreMediaData, writer?.status == .writing else { return }
    let (recording, offset) = lock.withLock { (state == "recording" && pausedSince == nil, firstFrame.map { CMTimeAdd($0, pausedTotal) }) }
    guard recording, let offset else { return }
    let next = CMTimeAdd(lastSampleTime, frame)
    guard CMTimeCompare(CMTimeSubtract(hostNow(), offset), CMTimeAdd(next, frame)) > 0 else { return }
    if let copy = retimed(last, minus: .zero, at: next), input.append(copy) { lastSampleTime = next }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard sample.isValid, let writer, writer.status == .writing else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    lock.lock()
    let recording = state == "recording" && pausedSince == nil
    let first = firstFrame
    let offset = first.map { CMTimeAdd($0, pausedTotal) }
    lock.unlock()
    guard recording else { return }
    if type == .screen {
      guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
      if first == nil {
        lock.lock(); firstFrame = pts; lock.unlock()
        DispatchQueue.main.async { [self] in sampleInput() }
      }
      let shift = offset ?? pts
      guard let input = videoInput, input.isReadyForMoreMediaData, let copy = retimed(sample, minus: shift) else { return }
      let time = CMSampleBufferGetPresentationTimeStamp(copy)
      if time <= lastSampleTime && lastSample != nil { return }
      if input.append(copy) { lastSample = sample; lastSampleTime = time; lock.lock(); lastActivity = hostNow(); lock.unlock() }
    } else {
      guard let offset else { return }
      let input = type == .audio ? systemInput : micInput
      guard let input, input.isReadyForMoreMediaData, let copy = retimed(sample, minus: offset) else { return }
      if CMSampleBufferGetPresentationTimeStamp(copy) < .zero { return }
      input.append(copy)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    let closed = options.kind == "window"
    Task { _ = await self.stop(reason: closed ? "windowClosed" : "error", error: closed ? nil : error.localizedDescription) }
  }

  // MARK: pointer, clicks, keys

  func startInput() {
    if options.kind == "window" {
      watcher = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.followWindow() }
    }
    if options.maxSeconds > 0 || options.idleSeconds > 0 {
      Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] timer in
        guard let self else { timer.invalidate(); return }
        self.lock.lock(); let state = self.state; let quiet = CMTimeSubtract(hostNow(), self.lastActivity).seconds; self.lock.unlock()
        if state == "stopping" || state == "stopped" { timer.invalidate(); return }
        if let t = self.videoTime(), t >= self.options.maxSeconds { timer.invalidate(); Task { _ = await self.stop(reason: "maxSeconds") } }
        else if self.options.idleSeconds > 0, state == "recording", quiet >= self.options.idleSeconds { timer.invalidate(); Task { _ = await self.stop(reason: "idle") } }
      }
    }
    guard CGPreflightListenEventAccess() || AXIsProcessTrusted() else { return }
    var mask: CGEventMask = 0
    for type: CGEventType in [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel] { mask |= 1 << type.rawValue }
    if options.keys != "off" { mask |= 1 << CGEventType.keyDown.rawValue }
    let me = Unmanaged.passUnretained(self).toOpaque()
    tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, info in
      guard let info else { return Unmanaged.passUnretained(event) }
      Unmanaged<Recording>.fromOpaque(info).takeUnretainedValue().handle(type, event)
      return Unmanaged.passUnretained(event)
    }, userInfo: me)
    if let tap {
      tapSource = CFMachPortCreateRunLoopSource(nil, tap, 0)
      CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
    }
  }

  func handle(_ type: CGEventType, _ event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { if let tap { CGEvent.tapEnable(tap: tap, enable: true) }; return }
    // Hardware events come from the HID system state; a program's posted ones do not.
    let source = event.getIntegerValueField(.eventSourceStateID) == Int64(CGEventSourceStateID.hidSystemState.rawValue) ? "person" : "agent"
    let (x, y) = local(event.location)
    switch type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      let button = type == .leftMouseDown ? "left" : type == .rightMouseDown ? "right" : "other"
      record("down", ["x": x, "y": y, "button": button, "clicks": Int(event.getIntegerValueField(.mouseEventClickState)), "source": source])
    case .leftMouseUp, .rightMouseUp, .otherMouseUp:
      let button = type == .leftMouseUp ? "left" : type == .rightMouseUp ? "right" : "other"
      record("up", ["x": x, "y": y, "button": button, "source": source])
    case .scrollWheel:
      record("scroll", ["x": x, "y": y, "dx": event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2), "dy": event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1), "source": source])
    case .keyDown:
      if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
      let (kind, mods, shortcut) = keyKind(event)
      var fields: [String: Any] = ["key": kind, "shortcut": shortcut, "source": source]
      if shortcut || options.keys == "characters" {
        let text = NSEvent(cgEvent: event)?.charactersIgnoringModifiers?.lowercased() ?? ""
        if !text.isEmpty && !["enter", "tab", "space", "delete", "escape", "arrow"].contains(kind) { fields["key"] = options.keys == "characters" && !shortcut ? (NSEvent(cgEvent: event)?.characters ?? text) : text }
      }
      if !mods.isEmpty { fields["mods"] = mods }
      record("key", fields)
      lock.lock(); lastKeyAt = hostNow(); lock.unlock()
    default: break
    }
  }

  // Every display frame: the pointer's place and image; clicks by polling when there is no tap.
  func sampleInput() {
    sampler?.invalidate()
    let interval = 1.0 / min(120, max(30, refreshRate(CGDirectDisplayID((target["displayId"] as? Int) ?? Int(CGMainDisplayID())))))
    sampler = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.sampleTickNow() }
    RunLoop.main.add(sampler!, forMode: .common)
  }

  func sampleTickNow() {
    guard videoTime() != nil, let location = CGEvent(source: nil)?.location else { return }
    sampleTick += 1
    if sampleTick % 2 == 1 || currentCursor == nil { currentCursor = cursors.current() ?? currentCursor }
    let (x, y) = local(location)
    if x != lastMove.x || y != lastMove.y || currentCursor != lastMove.cursor {
      var fields: [String: Any] = ["x": x, "y": y]
      if let currentCursor { fields["cursor"] = currentCursor }
      record("move", fields)
      lastMove = (x, y, currentCursor)
    }
    if tap == nil {
      let pressed = NSEvent.pressedMouseButtons
      for (bit, name) in [(0, "left"), (1, "right"), (2, "other")] {
        let now = pressed & (1 << bit) != 0, before = buttons & (1 << bit) != 0
        if now && !before { record("down", ["x": x, "y": y, "button": name, "clicks": 1, "source": "unknown"]) }
        if !now && before { record("up", ["x": x, "y": y, "button": name, "source": "unknown"]) }
      }
      buttons = pressed
    }
    if options.caret, sampleTick % 6 == 0, AXIsProcessTrusted() {
      lock.lock(); let typing = CMTimeSubtract(hostNow(), lastKeyAt).seconds < 3; lock.unlock()
      if typing { sampleCaret() }
    }
  }

  // The focused text field's caret (Accessibility), while keys are being typed.
  func sampleCaret() {
    let system = AXUIElementCreateSystemWide()
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success, let element = focused else { return }
    var range: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element as! AXUIElement, kAXSelectedTextRangeAttribute as CFString, &range) == .success, let range else { return }
    var bounds: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(element as! AXUIElement, kAXBoundsForRangeParameterizedAttribute as CFString, range, &bounds) == .success, let bounds else { return }
    var rect = CGRect.zero
    guard AXValueGetValue(bounds as! AXValue, .cgRect, &rect), rect.height > 0 else { return }
    if let last = lastCaret, abs(last.minX - rect.minX) < 0.5, abs(last.minY - rect.minY) < 0.5 { return }
    lastCaret = rect
    let (x, y) = local(rect.origin)
    record("caret", ["x": x, "y": y, "width": round1(rect.width), "height": round1(rect.height)])
  }

  // A window recording follows the window: points stay relative to its top-left.
  func followWindow() {
    guard let id = target["windowId"] as? Int,
          let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
          let bounds = info.first?[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bounds) else { return }
    lock.lock()
    let resized = abs(rect.width - region.width) > 0.5 || abs(rect.height - region.height) > 0.5
    region = rect
    lock.unlock()
    if resized { record("window", ["width": round1(rect.width), "height": round1(rect.height)]) }
  }

  // MARK: control

  func mark(_ label: String) throws -> [String: Any] {
    guard let t = videoTime() else { throw RecorderError(code: "state", message: "Marks are kept while recording (not paused, and after the first frame).") }
    let clean = String(label.prefix(120))
    record("mark", ["label": clean])
    return ["t": round3(t), "label": clean]
  }

  func pause() throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    guard state == "recording", pausedSince == nil, let first = firstFrame else { throw RecorderError(code: "state", message: "Only a recording that has started can pause.") }
    let now = hostNow()
    pausedSince = now
    pauses.append(["at": round3(CMTimeSubtract(CMTimeSubtract(now, first), pausedTotal).seconds)])
    state = "paused"
    return ["state": state]
  }

  func resume() throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    guard state == "paused", let since = pausedSince else { throw RecorderError(code: "state", message: "The recording is not paused.") }
    let gap = CMTimeSubtract(hostNow(), since)
    pausedTotal = CMTimeAdd(pausedTotal, gap)
    if var last = pauses.popLast() { last["seconds"] = round3(gap.seconds); pauses.append(last) }
    pausedSince = nil
    state = "recording"
    lastActivity = hostNow()
    return ["state": state]
  }

  func duration(_ now: CMTime = hostNow()) -> Double {
    lock.lock(); defer { lock.unlock() }
    guard let first = firstFrame else { return 0 }
    let end = pausedSince ?? now
    return max(0, CMTimeSubtract(CMTimeSubtract(end, first), pausedTotal).seconds)
  }

  func status() -> [String: Any] {
    lock.lock(); let state = self.state; let counts = self.counts; let reason = stoppedReason; lock.unlock()
    var result: [String: Any] = ["state": state, "folder": options.folder.path, "seconds": round2(duration()), "target": target,
                                 "clicks": counts["down"] ?? 0, "keys": counts["key"] ?? 0, "marks": counts["mark"] ?? 0,
                                 "events": tap != nil ? "tap" : "polling"]
    if let reason { result["stopped"] = reason }
    if let errorText { result["error"] = errorText }
    return result
  }

  func writeMeta(finished: Bool = false) throws {
    lock.lock()
    let frame = region, size = pixelSize
    var meta: [String: Any] = [
      "version": 1, "state": finished ? "finished" : "recording", "startedAt": Int(startedAt.timeIntervalSince1970 * 1000),
      "target": target, "frame": ["width": round1(frame.width), "height": round1(frame.height)],
      "scale": round3(Double(size.width) / max(1, Double(frame.width))),
      "video": ["file": "screen.mp4", "width": Int(size.width), "height": Int(size.height), "fps": target["fps"] ?? 60, "codec": target["codec"] ?? "h264"],
      "audio": ["system": options.systemAudio, "mic": options.mic], "keys": options.keys, "pauses": pauses,
    ]
    lock.unlock()
    meta["duration"] = round3(duration())
    meta["cursors"] = cursors.entries
    if let stoppedReason { meta["stopped"] = stoppedReason }
    if let errorText { meta["error"] = errorText }
    try Data((jsonText(meta) + "\n").utf8).write(to: options.folder.appendingPathComponent("recording.json"), options: .atomic)
  }

  func stop(reason: String, error: String? = nil) async -> [String: Any] {
    let begun: (end: CMTime, first: CMTime?)? = lock.withLock {
      if state == "stopping" || state == "stopped" { return nil }
      if let since = pausedSince { pausedTotal = CMTimeAdd(pausedTotal, CMTimeSubtract(hostNow(), since)); pausedSince = nil }
      state = "stopping"
      stoppedReason = reason
      errorText = error
      return (hostNow(), firstFrame)
    }
    guard let (end, first) = begun else { return status() }
    await MainActor.run {
      sampler?.invalidate(); watcher?.invalidate()
      if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }
      if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    }
    try? await stream?.stopCapture()
    let total = first.map { CMTimeSubtract(CMTimeSubtract(end, $0), pausedTotal) } ?? .zero
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      mediaQueue.async { [self] in
        holder?.cancel(); holder = nil
        // A still screen sends no frames: the last picture is held to the end.
        if let last = lastSample, let input = videoInput, total > CMTimeAdd(lastSampleTime, CMTime(value: 1, timescale: 60)),
           let copy = retimed(last, minus: .zero, at: total), input.isReadyForMoreMediaData { input.append(copy) }
        lastSample = nil
        guard let writer, writer.status == .writing else { done.resume(); return }
        if first == nil { writer.cancelWriting(); done.resume(); return }
        videoInput?.markAsFinished(); systemInput?.markAsFinished(); micInput?.markAsFinished()
        writer.endSession(atSourceTime: total)
        writer.finishWriting { done.resume() }
      }
    }
    if first == nil && errorText == nil { errorText = "No frame was captured." }
    if let writer, writer.status == .failed { errorText = writer.error?.localizedDescription ?? "The video writer failed." }
    eventQueue.sync { try? events?.close() }
    lock.withLock { state = "stopped" }
    try? writeMeta(finished: true)
    let summary = status()
    onStopped?(summary)
    return summary
  }
}

// MARK: - Methods

let METHODS: [[String: Any]] = [
  ["name": "version", "about": "The helper's version.", "params": [:]],
  ["name": "permissions", "about": "Whether kino may record the screen (screen), see clicks and keys (inputMonitoring) and read the text caret (accessibility).", "params": [:]],
  ["name": "requestPermissions", "about": "Asks macOS for the permissions named (default screen); macOS shows its own prompt once.", "params": ["permissions": "[screen | inputMonitoring | accessibility]"]],
  ["name": "pointer", "about": "The pointer showing now: its shape and how closely it matches each standard one.", "params": [:]],
  ["name": "displays", "about": "Displays: id, place and size in points, pixels per point, refresh rate.", "params": [:]],
  ["name": "windows", "about": "Windows kino can record: id, app, bundleId, title, place and size in points.", "params": ["app": "app name or bundle id (optional)", "all": "true to include windows not on screen"]],
  ["name": "start", "about": "Starts a recording into a new folder. One at a time.", "params": [
    "folder": "absolute path of the new folder (must not exist)",
    "target": "{display:id} (default the main display) | {window:id} | {app:\"name or bundle id\"} (its largest window) | {area:{x,y,width,height}, display?:id} in display points",
    "fps": "frames a second, at most the display's (default 60)", "size": "longest side in pixels (default 1920) or \"full\"",
    "codec": "h264 (default) | hevc", "audio": "true records the computer's sound", "mic": "true records the microphone (macOS 15+)",
    "keys": "off (default) | kinds (key kinds and shortcuts, no text) | characters", "caret": "follow the text caret while typing (default true)",
    "maxSeconds": "stop after this long (default 600)", "idleSeconds": "stop after this long with no input and no screen change (default off)",
    "excludeApps": "bundle ids left out of a display recording",
  ]],
  ["name": "status", "about": "The recording's state, seconds, clicks, keys and marks.", "params": [:]],
  ["name": "mark", "about": "Labels this moment (\"open Export\"); kino turns marks into cues and zoom targets.", "params": ["label": "a few words"]],
  ["name": "pause", "about": "Pauses: nothing is recorded until resume, and the pause is cut out of the video.", "params": [:]],
  ["name": "resume", "about": "Resumes a paused recording.", "params": [:]],
  ["name": "stop", "about": "Stops and finishes the files; answers the summary.", "params": [:]],
  ["name": "record", "about": "call only: start, then wait for a stop rule, Ctrl-C or a closed stdin, and print the summary.", "params": ["(same as start)": ""]],
]

final class Service: @unchecked Sendable {
  var recording: Recording?
  let lock = NSLock()

  func current() throws -> Recording {
    lock.lock(); defer { lock.unlock() }
    guard let recording else { throw RecorderError(code: "state", message: "Nothing is recording.") }
    return recording
  }

  func handle(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    switch method {
    case "version": return ["version": VERSION]
    case "permissions": return permissions()
    case "requestPermissions": return await MainActor.run { requestPermissions(params) }
    case "pointer":
      return await MainActor.run {
        guard let cursor = NSCursor.currentSystem else { return ["shape": "none"] }
        let book = CursorBook(folder: URL(fileURLWithPath: NSTemporaryDirectory()))
        return ["shape": book.shape(of: cursor), "scores": book.scores(cursor).prefix(4).map { ["shape": $0.1, "score": round3($0.0)] }]
      }
    case "displays": return try await listDisplays()
    case "windows": return try await listWindows(params)
    case "start":
      let options = try Options(params)
      let next: Recording? = lock.withLock {
        if let recording, recording.state != "stopped" { return nil }
        let next = Recording(options: options)
        next.onStopped = { summary in writeLine(["event": "stopped", "summary": summary]) }
        recording = next
        return next
      }
      guard let next else { throw RecorderError(code: "state", message: "A recording is already running; stop it first.") }
      return try await next.start()
    case "status": return try current().status()
    case "mark": return try current().mark((params["label"] as? String) ?? "")
    case "pause": return try current().pause()
    case "resume": return try current().resume()
    case "stop": return try await current().stop(reason: (params["reason"] as? String).map { ["agent", "person"].contains($0) ? $0 : "agent" } ?? "agent")
    default: throw RecorderError(code: "method", message: "Unknown method \(method); schema lists them.")
    }
  }

  func stopForExit() async {
    let recording = lock.withLock { self.recording }
    if let recording, recording.state != "stopped" { _ = await recording.stop(reason: "agent") }
  }
}

let service = Service()

func errorObject(_ error: Error) -> [String: Any] {
  if let error = error as? RecorderError { return ["code": error.code, "message": error.message] }
  return ["code": "failed", "message": error.localizedDescription]
}

func exitAfterStopping(_ code: Int32) {
  Task { await service.stopForExit(); exit(code) }
}

var signalSources: [DispatchSourceSignal] = []
func onSignals(_ action: @escaping () -> Void) {
  for number in [SIGINT, SIGTERM, SIGHUP] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler(handler: action)
    source.resume()
    signalSources.append(source)
  }
}

// Reads JSON lines from stdin: {"id":1,"method":"start","params":{...}}. A closed stdin (kino
// quit) finishes the recording cleanly first.
func serve() {
  onSignals { exitAfterStopping(0) }
  writeLine(["event": "ready", "version": VERSION])
  Thread {
    var pending = Data()
    while true {
      let chunk = FileHandle.standardInput.availableData
      if chunk.isEmpty { break }
      pending.append(chunk)
      while let newline = pending.firstIndex(of: 0x0A) {
        let line = pending.subdata(in: pending.startIndex..<newline)
        pending.removeSubrange(pending.startIndex...newline)
        guard !line.isEmpty else { continue }
        guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let method = request["method"] as? String else {
          writeLine(["error": ["code": "request", "message": "Each line must be {\"id\", \"method\", \"params\"}."]]); continue
        }
        let id = request["id"] ?? NSNull()
        let params = request["params"] as? [String: Any] ?? [:]
        Task {
          do { writeLine(["id": id, "result": try await service.handle(method, params)]) }
          catch { writeLine(["id": id, "error": errorObject(error)]) }
        }
      }
    }
    exitAfterStopping(0)
  }.start()
}

func call(_ method: String, _ json: String) {
  let params = ((try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]) ?? [:]
  Task {
    do {
      if method == "record" {
        onSignals { Task { _ = try? await service.handle("stop", ["reason": "person"]) } }
        _ = try await service.handle("start", params)
        let recording = try service.current()
        recording.onStopped = { summary in writeLine(summary); exit(summary["error"] == nil ? 0 : 1) }
        FileHandle.standardError.write(Data("Recording to \(recording.options.folder.path); Ctrl-C stops.\n".utf8))
      } else {
        writeLine(try await service.handle(method, params))
        exit(0)
      }
    } catch {
      writeLine(["error": errorObject(error)])
      exit(1)
    }
  }
}

let arguments = CommandLine.arguments.dropFirst()
switch arguments.first {
case "--version":
  print(VERSION)
  exit(0)
case "schema":
  writeLine(["version": VERSION, "methods": METHODS])
  exit(0)
case "serve":
  serve()
case "call" where arguments.count >= 2:
  call(arguments[arguments.startIndex + 1], arguments.count >= 3 ? arguments[arguments.startIndex + 2] : "{}")
default:
  FileHandle.standardError.write(Data("usage: kino-recorder serve | schema | call <method> '<json>' | --version\n".utf8))
  exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
