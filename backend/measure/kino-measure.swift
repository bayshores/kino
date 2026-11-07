// kino-measure: measures pictures with Apple's Vision framework for kino's video fingerprint
// (backend/measure/). Nothing leaves the computer and nothing is downloaded: the models are part
// of macOS. kino does the math on what this prints (backend/measure/fingerprint.mjs); this helper
// only asks Vision and writes down the answers.
//
// Usage: kino-measure --width <w> --height <h>
//        kino-measure --abilities   (prints which requests this Mac has, as one JSON line)
//        kino-measure --version
//
// Standard input gets the pictures one after another. Each picture is one byte of jobs, then
// w × h × 4 bytes of BGRA (kino decodes the video with FFmpeg). The jobs byte adds up:
//    1  flow        optical flow from the previous picture to this one (VNGenerateOpticalFlowRequest,
//                   macOS 11+), averaged into a 16 × 9 grid of arrows, in pixels of this picture
//    2  text        text recognition, fast level (VNRecognizeTextRequest): each line's box and words
//    4  print       an image feature print (VNGenerateImageFeaturePrintRequest): a vector for
//                   "how alike are two pictures"
//    8  saliency    where the eye goes (VNGenerateAttentionBasedSaliencyImageRequest): boxes
//   16  faces       where the faces are (VNDetectFaceRectanglesRequest): boxes, for framing
//                   footage around people (backend/footage/analyze.mjs)
//   32  people      each person (VNDetectHumanRectanglesRequest, whole body, macOS 12+): its box,
//                   and from the body pose (VNDetectHumanBodyPoseRequest) how many head joints
//                   show (nose, eyes, ears), the highest one, a box around the head and the wrists,
//                   for the people checks
//                   (backend/footage/people.mjs)
// (Apple's image aesthetics score is left out on purpose: measured on kino's references, it called
// 24 of 30 good screen-recording frames "utility" pictures, so it says nothing about design.)
// For each picture, standard output gets one JSON line: {"i": n, "flow": …, "text": […], …}.
// A request that fails or that this Mac does not have is left out of the line and named in
// "errors" ({"flow": "why"}); the helper carries on with the next picture. Boxes are fractions of
// the picture with the origin at the top left (Vision's own origin is the bottom left).
// Bad arguments or a broken input end the helper with a message on standard error.
//
// Apple asks for one optical flow request at a time, so every request here runs in turn.
import CoreVideo
import Foundation
import Vision

let version = "3"
let gridColumns = 16
let gridRows = 9

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("kino-measure: \(message)\n".utf8))
    exit(code)
}

func osVersion() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--version"] {
    print("kino-measure \(version)")
    exit(0)
}
if arguments == ["--abilities"] {
    var flow = false
    if #available(macOS 11.0, *) { flow = true }
    var people = false
    if #available(macOS 12.0, *) { people = true }
    print("{\"version\":\"\(version)\",\"macOS\":\"\(osVersion())\",\"flow\":\(flow),\"text\":true,\"print\":true,\"saliency\":true,\"faces\":true,\"people\":\(people)}")
    exit(0)
}

func option(_ name: String) -> String? {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}
let usage = "usage: kino-measure --width <w> --height <h>"
guard let width = Int(option("--width") ?? ""), let height = Int(option("--height") ?? ""),
      width >= 16, height >= 16, width <= 1920, height <= 1920 else { fail(usage, code: 2) }
let pictureBytes = width * height * 4

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

/// Rounds to 3 decimals, so the JSON stays short.
func r3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }

/// A box from Vision (origin bottom left) as [x, y, w, h] with the origin at the top left.
func topLeftBox(_ box: CGRect) -> [Double] {
    [r3(Double(box.minX)), r3(Double(1 - box.maxY)), r3(Double(box.width)), r3(Double(box.height))]
}

/// The flow field averaged into a gridColumns × gridRows grid of arrows, in pixels of the picture.
/// Each cell holds the mean horizontal (u) and vertical (v, down is positive) movement.
func flowGrid(_ flow: CVPixelBuffer) -> [String: Any] {
    CVPixelBufferLockBaseAddress(flow, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(flow, .readOnly) }
    let w = CVPixelBufferGetWidth(flow), h = CVPixelBufferGetHeight(flow)
    let stride = CVPixelBufferGetBytesPerRow(flow)
    let base = CVPixelBufferGetBaseAddress(flow)!
    let format = CVPixelBufferGetPixelFormatType(flow)
    // The field may be smaller than the picture: scale its arrows to the picture's pixels.
    let scaleX = Double(width) / Double(w), scaleY = Double(height) / Double(h)
    var sumU = [Double](repeating: 0, count: gridColumns * gridRows)
    var sumV = [Double](repeating: 0, count: gridColumns * gridRows)
    var count = [Double](repeating: 0, count: gridColumns * gridRows)
    for y in 0..<h {
        let row = base + y * stride
        let cellY = min(gridRows - 1, y * gridRows / h)
        for x in 0..<w {
            var u = 0.0, v = 0.0
            if format == kCVPixelFormatType_TwoComponent32Float {
                let line = row.assumingMemoryBound(to: Float.self)
                u = Double(line[x * 2]); v = Double(line[x * 2 + 1])
            } else if format == kCVPixelFormatType_TwoComponent16Half {
                let line = row.assumingMemoryBound(to: Float16.self)
                u = Double(line[x * 2]); v = Double(line[x * 2 + 1])
            } else {
                fail("Vision returned optical flow in pixel format \(format)")
            }
            if !u.isFinite || !v.isFinite { continue }
            let cell = cellY * gridColumns + min(gridColumns - 1, x * gridColumns / w)
            sumU[cell] += u * scaleX; sumV[cell] += v * scaleY; count[cell] += 1
        }
    }
    let u = (0..<sumU.count).map { count[$0] > 0 ? r3(sumU[$0] / count[$0]) : 0 }
    let v = (0..<sumV.count).map { count[$0] > 0 ? r3(sumV[$0] / count[$0]) : 0 }
    return ["cols": gridColumns, "rows": gridRows, "u": u, "v": v]
}

let picture = UnsafeMutablePointer<UInt8>.allocate(capacity: pictureBytes)
var jobs: UInt8 = 0
var index = 0
var previous: CVPixelBuffer?

while fread(&jobs, 1, 1, stdin) == 1 {
    guard readExactly(picture, pictureBytes) else { fail("the input ended after a jobs byte, before its picture") }
    autoreleasepool {
        let buffer = pixelBuffer(from: picture)
        var line: [String: Any] = ["i": index]
        var errors: [String: String] = [:]
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, options: [:])

        if jobs & 1 != 0 {
            if #available(macOS 11.0, *), let before = previous {
                // Flow from the previous picture (the handler's) to this one (the target).
                let request = VNGenerateOpticalFlowRequest(targetedCVPixelBuffer: buffer, options: [:])
                request.computationAccuracy = .medium
                request.outputPixelFormat = kCVPixelFormatType_TwoComponent32Float
                // Revision 1 gives arrows in pixels of the picture (an 8 px pan measures 8.0) and
                // is the quicker one. Revision 2 (macOS 14) measured the same pan as 3.0 at
                // medium accuracy and 4.3 at very high, so kino asks for revision 1 when it can.
                if VNGenerateOpticalFlowRequest.supportedRevisions.contains(VNGenerateOpticalFlowRequestRevision1) {
                    request.revision = VNGenerateOpticalFlowRequestRevision1
                }
                do {
                    try VNImageRequestHandler(cvPixelBuffer: before, options: [:]).perform([request])
                    if let found = request.results?.first {
                        var grid = flowGrid(found.pixelBuffer)
                        grid["rev"] = request.revision
                        line["flow"] = grid
                    }
                    else { errors["flow"] = "Vision found no flow" }
                } catch { errors["flow"] = error.localizedDescription }
            } else if previous == nil {
                errors["flow"] = "no previous picture"
            } else {
                errors["flow"] = "optical flow needs macOS 11 or later"
            }
        }

        if jobs & 2 != 0 {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .fast
            request.usesLanguageCorrection = false
            do {
                try handler.perform([request])
                line["text"] = (request.results ?? []).compactMap { observation -> [String: Any]? in
                    guard let best = observation.topCandidates(1).first else { return nil }
                    return ["box": topLeftBox(observation.boundingBox), "s": String(best.string.prefix(200)), "c": r3(Double(best.confidence))]
                }
            } catch { errors["text"] = error.localizedDescription }
        }

        if jobs & 4 != 0 {
            let request = VNGenerateImageFeaturePrintRequest()
            do {
                try handler.perform([request])
                if let found = request.results?.first {
                    // The vector as base64 of its raw bytes, and how to read them.
                    line["print"] = ["type": found.elementType == .float ? "f32" : "f64", "n": found.elementCount,
                                     "rev": request.revision, "b64": found.data.base64EncodedString()]
                } else { errors["print"] = "Vision made no feature print" }
            } catch { errors["print"] = error.localizedDescription }
        }

        if jobs & 8 != 0 {
            let request = VNGenerateAttentionBasedSaliencyImageRequest()
            do {
                try handler.perform([request])
                line["saliency"] = (request.results?.first?.salientObjects ?? []).map { topLeftBox($0.boundingBox) }
            } catch { errors["saliency"] = error.localizedDescription }
        }

        if jobs & 16 != 0 {
            let request = VNDetectFaceRectanglesRequest()
            do {
                try handler.perform([request])
                line["faces"] = (request.results ?? []).map { topLeftBox($0.boundingBox) }
            } catch { errors["faces"] = error.localizedDescription }
        }

        if jobs & 32 != 0 {
            if #available(macOS 12.0, *) {
                let bodies = VNDetectHumanRectanglesRequest()
                bodies.upperBodyOnly = false
                let pose = VNDetectHumanBodyPoseRequest()
                do {
                    try handler.perform([bodies, pose])
                    // Each pose: how many head joints show, the highest one and its joints' span across.
                    let poses: [[String: Any]] = (pose.results ?? []).map { found in
                        let points = ((try? found.recognizedPoints(.all)) ?? [:]).filter { $0.value.confidence > 0.3 }
                        let headNames: [VNHumanBodyPoseObservation.JointName] = [.nose, .leftEye, .rightEye, .leftEar, .rightEar]
                        let joints = headNames.compactMap { points[$0] }.map { CGPoint(x: $0.location.x, y: 1 - $0.location.y) }
                        var entry: [String: Any] = ["head": joints.count]
                        if let top = joints.map({ Double($0.y) }).min() { entry["top"] = r3(top) }
                        // Where the head is: around its joints, as wide as the ears (or the neck's reach).
                        if !joints.isEmpty {
                            let xs = joints.map { Double($0.x) }, ys = joints.map { Double($0.y) }
                            let cx = (xs.min()! + xs.max()!) / 2, cy = (ys.min()! + ys.max()!) / 2
                            var r = max((xs.max()! - xs.min()!) * 0.9, 0.02)
                            if let neck = points[.neck] { r = max(r, 0.6 * abs(cy - (1 - Double(neck.location.y)))) }
                            entry["headBox"] = [r3(cx - r), r3(cy - 1.4 * r), r3(2 * r), r3(2.4 * r)]
                        }
                        // Wrists, where the hands (and a held phone) are.
                        let hands = [VNHumanBodyPoseObservation.JointName.leftWrist, .rightWrist].compactMap { points[$0] }
                        if !hands.isEmpty { entry["hands"] = hands.map { [r3(Double($0.location.x)), r3(1 - Double($0.location.y))] } }
                        let xs = points.values.map { Double($0.location.x) }
                        if let low = xs.min(), let high = xs.max() { entry["x"] = (low + high) / 2 }
                        return entry
                    }
                    line["people"] = (bodies.results ?? []).map { body -> [String: Any] in
                        let box = topLeftBox(body.boundingBox)
                        var entry: [String: Any] = ["box": box]
                        // The pose whose joints are centered inside this box.
                        if let match = poses.first(where: { ($0["x"] as? Double).map { $0 >= box[0] && $0 <= box[0] + box[2] } ?? false }) {
                            entry["head"] = match["head"]
                            for key in ["top", "headBox", "hands"] { if let value = match[key] { entry[key] = value } }
                        }
                        return entry
                    }
                } catch { errors["people"] = error.localizedDescription }
            } else { errors["people"] = "finding people needs macOS 12 or later" }
        }

        if !errors.isEmpty { line["errors"] = errors }
        guard let data = try? JSONSerialization.data(withJSONObject: line, options: []) else { fail("could not write picture \(index) as JSON") }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        previous = buffer
        index += 1
    }
}
