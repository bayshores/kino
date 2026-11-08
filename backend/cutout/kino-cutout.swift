// kino-cutout: finds the subject of each picture with Apple's Vision framework and writes it as a
// matte (white where the subject is, black elsewhere). Nothing leaves the computer and nothing is
// downloaded: the models are part of macOS.
//
// Usage: kino-cutout --width <w> --height <h> --engine subject|person [--quality accurate|balanced] [--instances]
//        kino-cutout --engines      (prints which engines this Mac has, as one JSON line)
//        kino-cutout --version
//        kino-cutout --track --width <w> --height <h> --box <x,y,w,h> [--level accurate|fast]
//        kino-cutout --stabilize motion --input <video> [--side 640]
//        kino-cutout --stabilize render --input <video> --output <mp4> --transforms <file> --zoom <z>
//
// --stabilize motion reads a video file itself (AVFoundation, every frame in order) and measures
// how the picture moved from each frame to the next with VNHomographicImageRegistrationRequest at
// `side` pixels on the long side, reduced to a move, a turn and a scale about the picture's center.
// Standard output gets one line a frame, "m x y r s": the move in the file's pixels (Core Image's
// way, y up), the turn in radians and the scale (the first frame's line is "m 0 0 0 1").
// --stabilize render reads the same frames, moves each by its line of the transforms file (the
// same four numbers: the correction kino worked out in backend/cutout/stabilize.mjs), zooms by
// `zoom` about the center (Core Image) and writes H.264 at the file's size and frame times with
// AVAssetWriter. The sound is copied unchanged. It prints {"frames":n} when done.
//
// --track follows one object through the pictures with VNTrackObjectRequest (macOS 10.13 and
// later). The box is where the object is on the first picture, as fractions of the picture from
// its top-left corner. For each picture, standard output gets one JSON line
// {"x":..,"y":..,"w":..,"h":..,"c":..}: the box found there (the same fractions) and Vision's
// confidence from 0 to 1 (the first picture's line is the box given, at 1). kino feeds the
// pictures backwards to track back in time (backend/cutout/track.mjs).
//
// Standard input gets the pictures one after another as raw BGRA bytes, w × h × 4 bytes each (kino
// decodes them with FFmpeg). For each picture, standard output gets its matte as w × h bytes, one
// byte a pixel from 0 (background) to 255 (subject), in the same order. Errors go to standard error
// with a non-zero exit code.
//
// --instances (subject engine only): after each matte, a second w × h plane of instance labels: 0
// where no instance is, else 1 + the index of the instance strongest at that pixel. kino keeps
// only the instances an agent pointed at (cut_out points, backend/cutout/cutout.mjs).
//
// Engines:
//   subject  VNGenerateForegroundInstanceMaskRequest (macOS 14 and later): every salient object
//            that stands out from the background (a person, an animal, a product, a cup), all
//            instances together. Each picture is looked at on its own; kino smooths the edges
//            over time afterwards (backend/cutout/matte.mjs).
//   person   VNGeneratePersonSegmentationRequest (macOS 12 and later): people only. The request
//            keeps earlier mattes to steady the edges, so one request is used for the whole clip.
import Accelerate
import AVFoundation
import CoreImage
import CoreVideo
import Foundation
import Vision

let version = "5"

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("kino-cutout: \(message)\n".utf8))
    exit(code)
}

func osVersion() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

var arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--version"] {
    print("kino-cutout \(version)")
    exit(0)
}
if arguments == ["--engines"] {
    var subject = false
    if #available(macOS 14.0, *) { subject = true }
    var person = false
    if #available(macOS 12.0, *) { person = true }
    print("{\"version\":\"\(version)\",\"macOS\":\"\(osVersion())\",\"subject\":\(subject),\"person\":\(person),\"track\":true,\"stabilize\":true,\"pick\":true}")
    exit(0)
}

func option(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

// Core Image without colour management: pixels pass through as they are, so steadying never
// shifts the colours.
let plainContext = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
let bgra: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]

func videoTrack(_ asset: AVAsset, _ path: String) -> AVAssetTrack {
    guard let track = asset.tracks(withMediaType: .video).first else { fail("\(path) has no picture") }
    return track
}

func newReader(_ asset: AVAsset, _ path: String) -> AVAssetReader {
    do { return try AVAssetReader(asset: asset) } catch { fail("could not read \(path): \(error.localizedDescription)") }
}

/// --stabilize motion: one "x y r s" line a frame, how the picture moved since the frame before.
func measureMotion(_ path: String, side: Int) {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let track = videoTrack(asset, path)
    let reader = newReader(asset, path)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: bgra)
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { fail("could not read \(path): \(reader.error?.localizedDescription ?? "")") }
    var previous: CVPixelBuffer? = nil
    var previousPeople: [UInt8]? = nil
    var scale = 0.0, w = 0, h = 0
    // People (the walker in front of the camera) move on their own, so they must not drive the
    // camera path: where either frame of a pair has a person, both are painted flat mid-gray.
    var peopleRequest: AnyObject? = nil
    if #available(macOS 12.0, *), option("--people") != "keep" {
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .fast
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        peopleRequest = request
    }
    /// One byte a pixel at w × h: 255 where a person is (grown by 4 px), else 0.
    func people(_ buffer: CVPixelBuffer) -> [UInt8]? {
        guard #available(macOS 12.0, *), let request = peopleRequest as? VNGeneratePersonSegmentationRequest,
              (try? VNImageRequestHandler(cvPixelBuffer: buffer, options: [:]).perform([request])) != nil,
              let mask = request.results?.first?.pixelBuffer else { return nil }
        CVPixelBufferLockBaseAddress(mask, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
        let mw = CVPixelBufferGetWidth(mask), mh = CVPixelBufferGetHeight(mask), stride = CVPixelBufferGetBytesPerRow(mask)
        let base = CVPixelBufferGetBaseAddress(mask)!.assumingMemoryBound(to: UInt8.self)
        var out = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h { for x in 0..<w where base[(y * mh / h) * stride + x * mw / w] > 32 { out[y * w + x] = 255 } }
        // Grow by 4 px (a running maximum across, then down) to cover the person's soft edge.
        let grow = 4
        var across = out
        for y in 0..<h { for x in 0..<w where out[y * w + x] == 255 { for k in max(0, x - grow)...min(w - 1, x + grow) { across[y * w + k] = 255 } } }
        out = across
        for y in 0..<h { for x in 0..<w where across[y * w + x] == 255 { for k in max(0, y - grow)...min(h - 1, y + grow) { out[k * w + x] = 255 } } }
        return out
    }
    /// A copy of `buffer` painted mid-gray where `mask` is set.
    func painted(_ buffer: CVPixelBuffer, _ mask: [UInt8]) -> CVPixelBuffer {
        var made: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &made)
        guard let copy = made else { fail("could not make a picture buffer") }
        CVPixelBufferLockBaseAddress(buffer, .readOnly); CVPixelBufferLockBaseAddress(copy, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly); CVPixelBufferUnlockBaseAddress(copy, []) }
        let from = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self), fromStride = CVPixelBufferGetBytesPerRow(buffer)
        let to = CVPixelBufferGetBaseAddress(copy)!.assumingMemoryBound(to: UInt8.self), toStride = CVPixelBufferGetBytesPerRow(copy)
        for y in 0..<h {
            memcpy(to + y * toStride, from + y * fromStride, w * 4)
            for x in 0..<w where mask[y * w + x] == 255 { let p = to + y * toStride + x * 4; p[0] = 128; p[1] = 128; p[2] = 128 }
        }
        return copy
    }
    while let sample = output.copyNextSampleBuffer() {
        autoreleasepool {
            guard let frame = CMSampleBufferGetImageBuffer(sample) else { return }
            let fw = CVPixelBufferGetWidth(frame), fh = CVPixelBufferGetHeight(frame)
            if scale == 0 {
                scale = min(1, Double(side) / Double(max(fw, fh)))
                w = max(16, Int((Double(fw) * scale).rounded())); h = max(16, Int((Double(fh) * scale).rounded()))
            }
            var made: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &made)
            guard let small = made else { fail("could not make a picture buffer") }
            let image = CIImage(cvPixelBuffer: frame).transformed(by: CGAffineTransform(scaleX: CGFloat(w) / CGFloat(fw), y: CGFloat(h) / CGFloat(fh)))
            plainContext.render(image, to: small)
            let found = people(small)
            defer { previous = small; previousPeople = found }
            guard var before = previous else { print("m 0 0 0 1"); return }
            var now = small
            if found != nil || previousPeople != nil {
                let a = found ?? [UInt8](repeating: 0, count: w * h), b = previousPeople ?? [UInt8](repeating: 0, count: w * h)
                let both = zip(a, b).map { max($0, $1) }
                before = painted(before, both); now = painted(small, both)
            }
            // The current frame is the reference; the warp maps the frame before onto it.
            let request = VNHomographicImageRegistrationRequest(targetedCVPixelBuffer: before, options: [:])
            let handler = VNImageRequestHandler(cvPixelBuffer: now, options: [:])
            guard (try? handler.perform([request])) != nil,
                  let found = request.results?.first as? VNImageHomographicAlignmentObservation else { print("m 0 0 0 1"); return }
            let m = found.warpTransform
            let n = Double(m[2][2] == 0 ? 1 : m[2][2])
            let a = Double(m[0][0]) / n, b = Double(m[0][1]) / n, c = Double(m[1][0]) / n, d = Double(m[1][1]) / n
            let cx = Double(w) / 2, cy = Double(h) / 2
            let wz = (Double(m[0][2]) * cx + Double(m[1][2]) * cy + Double(m[2][2])) / n
            let x = (a * cx + c * cy + Double(m[2][0]) / n) / wz - cx
            let y = (b * cx + d * cy + Double(m[2][1]) / n) / wz - cy
            let turn = atan2(b - c, a + d), size = sqrt(abs(a * d - b * c))
            print(String(format: "m %.3f %.3f %.6f %.6f", x / scale, y / scale, turn, size))
        }
    }
    if reader.status == .failed { fail("could not read \(path): \(reader.error?.localizedDescription ?? "")") }
}

/// --stabilize render: each frame moved by its line of `transformsPath`, zoomed, written as H.264.
func renderSteadied(input: String, output outPath: String, transformsPath: String, zoom: Double) {
    guard let text = try? String(contentsOfFile: transformsPath, encoding: .utf8) else { fail("could not read \(transformsPath)") }
    let moves = text.split(separator: "\n").map { $0.split(separator: " ").compactMap { Double($0) } }.filter { $0.count == 4 }
    let asset = AVURLAsset(url: URL(fileURLWithPath: input))
    let track = videoTrack(asset, input)
    let reader = newReader(asset, input)
    let videoOut = AVAssetReaderTrackOutput(track: track, outputSettings: bgra)
    videoOut.alwaysCopiesSampleData = false
    reader.add(videoOut)
    let fw = Int(track.naturalSize.width.rounded()), fh = Int(track.naturalSize.height.rounded())
    let url = URL(fileURLWithPath: outPath)
    try? FileManager.default.removeItem(at: url)
    let writer: AVAssetWriter
    do { writer = try AVAssetWriter(outputURL: url, fileType: .mp4) } catch { fail("could not write \(outPath): \(error.localizedDescription)") }
    let bitRate = max(10_000_000, Int(Double(track.estimatedDataRate) * 1.3))
    let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: fw, AVVideoHeightKey: fh,
        AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitRate, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel],
    ])
    videoIn.expectsMediaDataInRealTime = false
    videoIn.transform = track.preferredTransform
    writer.add(videoIn)
    var attributes = bgra
    attributes[kCVPixelBufferWidthKey as String] = fw
    attributes[kCVPixelBufferHeightKey as String] = fh
    attributes[kCVPixelBufferIOSurfacePropertiesKey as String] = [String: Any]()
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoIn, sourcePixelBufferAttributes: attributes)
    // The sound as stored (no decoding), when the file has one the MP4 can hold.
    var soundOut: AVAssetReaderTrackOutput? = nil, soundIn: AVAssetWriterInput? = nil
    if let soundTrack = asset.tracks(withMediaType: .audio).first {
        let hint = soundTrack.formatDescriptions.first.map { $0 as! CMFormatDescription }
        let writing = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: hint)
        writing.expectsMediaDataInRealTime = false
        let reading = AVAssetReaderTrackOutput(track: soundTrack, outputSettings: nil)
        if writer.canAdd(writing), reader.canAdd(reading) { writer.add(writing); reader.add(reading); soundIn = writing; soundOut = reading }
    }
    guard reader.startReading() else { fail("could not read \(input): \(reader.error?.localizedDescription ?? "")") }
    guard writer.startWriting() else { fail("could not write \(outPath): \(writer.error?.localizedDescription ?? "")") }
    writer.startSession(atSourceTime: .zero)
    let cx = CGFloat(fw) / 2, cy = CGFloat(fh) / 2
    func placed(_ m: [Double]) -> CGAffineTransform {
        CGAffineTransform(translationX: -cx, y: -cy)
            .concatenating(CGAffineTransform(rotationAngle: CGFloat(m[2])))
            .concatenating(CGAffineTransform(scaleX: CGFloat(m[3]), y: CGFloat(m[3])))
            .concatenating(CGAffineTransform(translationX: CGFloat(m[0]), y: CGFloat(m[1])))
            .concatenating(CGAffineTransform(scaleX: CGFloat(zoom), y: CGFloat(zoom)))
            .concatenating(CGAffineTransform(translationX: cx, y: cy))
    }
    let group = DispatchGroup()
    var frames = 0
    var failure: String? = nil
    group.enter()
    var videoDone = false
    videoIn.requestMediaDataWhenReady(on: DispatchQueue(label: "kino.stabilize.video")) {
        while videoIn.isReadyForMoreMediaData && !videoDone {
            guard let sample = videoOut.copyNextSampleBuffer() else {
                videoDone = true; videoIn.markAsFinished(); group.leave(); return
            }
            autoreleasepool {
                guard let frame = CMSampleBufferGetImageBuffer(sample), let pool = adaptor.pixelBufferPool else { return }
                let move = moves.isEmpty ? [0, 0, 0, 1] : moves[min(frames, moves.count - 1)]
                frames += 1
                let image = CIImage(cvPixelBuffer: frame).clampedToExtent().transformed(by: placed(move)).cropped(to: CGRect(x: 0, y: 0, width: fw, height: fh))
                var made: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made)
                guard let out = made else { failure = "could not make a picture buffer"; return }
                plainContext.render(image, to: out)
                if !adaptor.append(out, withPresentationTime: CMSampleBufferGetPresentationTimeStamp(sample)) {
                    failure = "could not write frame \(frames): \(writer.error?.localizedDescription ?? "")"
                }
            }
            if failure != nil { videoDone = true; videoIn.markAsFinished(); group.leave(); return }
        }
    }
    if let soundIn, let soundOut {
        group.enter()
        var soundDone = false
        soundIn.requestMediaDataWhenReady(on: DispatchQueue(label: "kino.stabilize.sound")) {
            while soundIn.isReadyForMoreMediaData && !soundDone {
                guard let sample = soundOut.copyNextSampleBuffer() else { soundDone = true; soundIn.markAsFinished(); group.leave(); return }
                if !soundIn.append(sample) { soundDone = true; soundIn.markAsFinished(); group.leave(); return }
            }
        }
    }
    group.wait()
    if let failure { writer.cancelWriting(); fail(failure) }
    if reader.status == .failed { writer.cancelWriting(); fail("could not read \(input): \(reader.error?.localizedDescription ?? "")") }
    let finished = DispatchSemaphore(value: 0)
    writer.finishWriting { finished.signal() }
    finished.wait()
    guard writer.status == .completed else { fail("could not finish \(outPath): \(writer.error?.localizedDescription ?? "")") }
    print("{\"frames\":\(frames)}")
}

if let mode = option("--stabilize") {
    guard let input = option("--input") else { fail("--stabilize needs --input <video>", code: 2) }
    if mode == "motion" {
        measureMotion(input, side: Int(option("--side") ?? "") ?? 640)
    } else if mode == "render", let output = option("--output"), let transforms = option("--transforms") {
        renderSteadied(input: input, output: output, transformsPath: transforms, zoom: Double(option("--zoom") ?? "") ?? 1)
    } else {
        fail("usage: kino-cutout --stabilize motion --input <video> | --stabilize render --input <video> --output <mp4> --transforms <file> --zoom <z>", code: 2)
    }
    exit(0)
}
let tracking = arguments.contains("--track")
let instances = arguments.contains("--instances")
let usage = "usage: kino-cutout --width <w> --height <h> --engine subject|person [--quality accurate|balanced]"
guard let width = Int(option("--width") ?? ""), let height = Int(option("--height") ?? ""),
      width > 0, height > 0, width <= 8192, height <= 8192 else { fail(usage, code: 2) }
let engine = option("--engine") ?? "subject"
let quality = option("--quality") ?? "accurate"
guard tracking || ["subject", "person"].contains(engine), ["accurate", "balanced"].contains(quality) else { fail(usage, code: 2) }
if instances && engine != "subject" { fail("--instances needs --engine subject", code: 2) }

let pictureBytes = width * height * 4
let matteBytes = width * height

/// Reads exactly `count` bytes from standard input; false at the end of the input.
func readExactly(_ buffer: UnsafeMutablePointer<UInt8>, _ count: Int) -> Bool {
    var done = 0
    while done < count {
        let got = fread(buffer + done, 1, count - done, stdin)
        if got == 0 {
            if done == 0 { return false }
            fail("the input ended in the middle of a picture (\(done) of \(count) bytes)")
        }
        done += got
    }
    return true
}

func writeExactly(_ buffer: UnsafePointer<UInt8>, _ count: Int) {
    if fwrite(buffer, 1, count, stdout) != count { fail("could not write the matte (the reader stopped)", code: 4) }
}

/// A BGRA pixel buffer holding one picture from standard input.
func pixelBuffer(from bytes: UnsafePointer<UInt8>) -> CVPixelBuffer {
    var made: CVPixelBuffer?
    let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes, &made) == kCVReturnSuccess,
          let buffer = made else { fail("could not make a picture buffer") }
    CVPixelBufferLockBaseAddress(buffer, [])
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    for row in 0..<height { memcpy(base + row * stride, bytes + row * width * 4, width * 4) }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
}

/// Copies a one-channel matte (8-bit or 32-bit float, any size) into `output` at width × height.
func copyMatte(_ matte: CVPixelBuffer, into output: UnsafeMutablePointer<UInt8>) {
    CVPixelBufferLockBaseAddress(matte, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(matte, .readOnly) }
    let w = CVPixelBufferGetWidth(matte), h = CVPixelBufferGetHeight(matte)
    let stride = CVPixelBufferGetBytesPerRow(matte)
    let base = CVPixelBufferGetBaseAddress(matte)!
    // First as 8-bit at the matte's own size.
    var small = [UInt8](repeating: 0, count: w * h)
    switch CVPixelBufferGetPixelFormatType(matte) {
    case kCVPixelFormatType_OneComponent8:
        for row in 0..<h { memcpy(&small[row * w], base + row * stride, w) }
    case kCVPixelFormatType_OneComponent32Float:
        for row in 0..<h {
            let line = (base + row * stride).assumingMemoryBound(to: Float.self)
            for x in 0..<w { small[row * w + x] = UInt8(max(0, min(255, (line[x] * 255).rounded()))) }
        }
    default:
        fail("Vision returned a matte in pixel format \(CVPixelBufferGetPixelFormatType(matte))")
    }
    if w == width && h == height {
        _ = small.withUnsafeBufferPointer { memcpy(output, $0.baseAddress!, matteBytes) }
        return
    }
    // A smaller matte (person segmentation) is scaled up to the picture's size.
    small.withUnsafeMutableBufferPointer { source in
        var from = vImage_Buffer(data: source.baseAddress!, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w)
        var to = vImage_Buffer(data: output, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width)
        let error = vImageScale_Planar8(&from, &to, nil, vImage_Flags(kvImageHighQualityResampling))
        if error != kvImageNoError { fail("could not scale the matte (vImage error \(error))") }
    }
}

let picture = UnsafeMutablePointer<UInt8>.allocate(capacity: pictureBytes)
let matte = UnsafeMutablePointer<UInt8>.allocate(capacity: matteBytes)
let labels = UnsafeMutablePointer<UInt8>.allocate(capacity: matteBytes)
let strongest = UnsafeMutablePointer<UInt8>.allocate(capacity: matteBytes)
let strongestScratch = UnsafeMutablePointer<UInt8>.allocate(capacity: matteBytes)
setvbuf(stdout, nil, _IOFBF, 1 << 20)

if tracking {
    let parts = (option("--box") ?? "").split(separator: ",").compactMap { Double($0) }
    guard parts.count == 4, parts[2] > 0, parts[3] > 0 else { fail("--track needs --box x,y,w,h (fractions of the picture)", code: 2) }
    // Vision's boxes are fractions with a bottom-left origin.
    var last = VNDetectedObjectObservation(boundingBox: CGRect(x: parts[0], y: 1 - parts[1] - parts[3], width: parts[2], height: parts[3]))
    let level: VNRequestTrackingLevel = option("--level") == "fast" ? .fast : .accurate
    let sequence = VNSequenceRequestHandler()
    var first = true
    var lost = false
    func line(_ box: CGRect, _ confidence: Float) {
        let text = String(format: "{\"x\":%.5f,\"y\":%.5f,\"w\":%.5f,\"h\":%.5f,\"c\":%.3f}\n", box.minX, 1 - box.maxY, box.width, box.height, confidence)
        FileHandle.standardOutput.write(Data(text.utf8))
    }
    while readExactly(picture, pictureBytes) {
        autoreleasepool {
            if first { first = false; line(last.boundingBox, 1); return }
            // Once Vision loses the object it is not looked for again: the last box is kept at 0.
            if lost { line(last.boundingBox, 0); return }
            let buffer = pixelBuffer(from: picture)
            let request = VNTrackObjectRequest(detectedObjectObservation: last)
            request.trackingLevel = level
            do {
                try sequence.perform([request], on: buffer)
                if let found = request.results?.first as? VNDetectedObjectObservation {
                    last = found
                    line(found.boundingBox, found.confidence)
                } else { lost = true; line(last.boundingBox, 0) }
            } catch {
                lost = true
                line(last.boundingBox, 0)
            }
        }
    }
    exit(0)
}

if engine == "subject" {
    guard #available(macOS 14.0, *) else { fail("the subject engine needs macOS 14 or later; use --engine person", code: 3) }
    let request = VNGenerateForegroundInstanceMaskRequest()
    while readExactly(picture, pictureBytes) {
        autoreleasepool {
            let buffer = pixelBuffer(from: picture)
            let handler = VNImageRequestHandler(cvPixelBuffer: buffer, options: [:])
            if instances { memset(labels, 0, matteBytes) }
            do {
                try handler.perform([request])
                if let found = request.results?.first, !found.allInstances.isEmpty {
                    let scaled = try found.generateScaledMaskForImage(forInstances: found.allInstances, from: handler)
                    copyMatte(scaled, into: matte)
                    if instances {
                        // Each pixel takes the instance whose own soft mask is strongest there.
                        memset(strongest, 0, matteBytes)
                        for (order, instance) in found.allInstances.sorted().prefix(255).enumerated() {
                            let one = try found.generateScaledMaskForImage(forInstances: IndexSet(integer: instance), from: handler)
                            copyMatte(one, into: strongestScratch)
                            for i in 0..<matteBytes where strongestScratch[i] > strongest[i] {
                                strongest[i] = strongestScratch[i]; labels[i] = UInt8(order + 1)
                            }
                        }
                    }
                } else {
                    memset(matte, 0, matteBytes)
                }
            } catch {
                fail("Vision could not find the subject: \(error.localizedDescription)")
            }
            writeExactly(matte, matteBytes)
            if instances { writeExactly(labels, matteBytes) }
        }
    }
} else {
    guard #available(macOS 12.0, *) else { fail("the person engine needs macOS 12 or later", code: 3) }
    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = quality == "balanced" ? .balanced : .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    let sequence = VNSequenceRequestHandler()
    while readExactly(picture, pictureBytes) {
        autoreleasepool {
            let buffer = pixelBuffer(from: picture)
            do {
                try sequence.perform([request], on: buffer)
                if let found = request.results?.first { copyMatte(found.pixelBuffer, into: matte) }
                else { memset(matte, 0, matteBytes) }
            } catch {
                fail("Vision could not find the person: \(error.localizedDescription)")
            }
            writeExactly(matte, matteBytes)
        }
    }
}
fflush(stdout)
