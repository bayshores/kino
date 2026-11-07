// kino-voice: keeps the voice in a sound file with Apple's sound isolation audio unit
// (AUSoundIsolation, part of macOS 13 and later), rendered offline as fast as the Mac allows.
// Nothing leaves the computer.
//
// Usage: kino-voice <input.wav> <output.wav> [--mode high-quality|voice]
//        kino-voice --version
//
// kino gives it 48 kHz mono 32-bit float WAV and reads the same format back. The audio unit's
// output arrives late by a few thousand samples, so the output is longer than the input by a tail
// of silence that lets the late part come out; kino measures the delay by cross-correlation and
// trims it (backend/voice/lag.mjs). The mix is always 100% isolated voice; kino blends in the
// original itself so every engine treats "amount" the same way.
//
// Standard output gets "progress <0..1>" lines and, at the end, one "result {json}" line.
// Errors go to standard error with a non-zero exit code.
import AVFoundation
import AudioToolbox
import Foundation

let version = "1"

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("kino-voice: \(message)\n".utf8))
    exit(code)
}

var arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["--version"] {
    print("kino-voice \(version)")
    exit(0)
}
var requestedMode = "high-quality"
if let index = arguments.firstIndex(of: "--mode") {
    guard index + 1 < arguments.count else { fail("--mode needs high-quality or voice", code: 2) }
    requestedMode = arguments[index + 1]
    arguments.removeSubrange(index...(index + 1))
}
guard arguments.count == 2, ["high-quality", "voice"].contains(requestedMode) else {
    fail("usage: kino-voice <input.wav> <output.wav> [--mode high-quality|voice]", code: 2)
}
guard #available(macOS 13.0, *) else { fail("needs macOS 13 or later", code: 3) }

// High-quality voice isolation arrived in macOS 15; older systems use the plain voice mode.
var soundType = Float(kAUSoundIsolationSoundType_Voice)
var mode = "voice"
if requestedMode == "high-quality", #available(macOS 15.0, *) {
    soundType = Float(kAUSoundIsolationSoundType_HighQualityVoice)
    mode = "high-quality"
}

do {
    let input = try AVAudioFile(forReading: URL(fileURLWithPath: arguments[0]))
    let format = input.processingFormat
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let isolation = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
        componentType: kAudioUnitType_Effect,
        componentSubType: kAudioUnitSubType_AUSoundIsolation,
        componentManufacturer: kAudioUnitManufacturer_Apple,
        componentFlags: 0, componentFlagsMask: 0))
    engine.attach(player)
    engine.attach(isolation)
    engine.connect(player, to: isolation, format: format)
    engine.connect(isolation, to: engine.mainMixerNode, format: format)
    try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)

    for (parameter, value) in [(kAUSoundIsolationParam_SoundToIsolate, soundType),
                               (kAUSoundIsolationParam_WetDryMixPercent, Float(100))] {
        let status = AudioUnitSetParameter(isolation.audioUnit, AudioUnitParameterID(parameter),
                                           kAudioUnitScope_Global, 0, value, 0)
        if status != noErr { fail("could not set sound isolation parameter \(parameter) (status \(status))") }
    }
    var latency: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    AudioUnitGetProperty(isolation.audioUnit, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0, &latency, &size)

    try engine.start()
    player.scheduleFile(input, at: nil)
    player.play()

    let output = try AVAudioFile(forWriting: URL(fileURLWithPath: arguments[1]), settings: format.settings,
                                 commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat,
                                        frameCapacity: engine.manualRenderingMaximumFrameCount) else {
        fail("could not make an audio buffer")
    }
    // One second of tail, or twice the reported latency if that is longer, lets the late output out.
    let tail = AVAudioFramePosition(format.sampleRate * max(1.0, 2 * latency))
    let total = input.length + tail
    var reported = -1
    while engine.manualRenderingSampleTime < total {
        let frames = min(AVAudioFrameCount(total - engine.manualRenderingSampleTime), buffer.frameCapacity)
        switch try engine.renderOffline(frames, to: buffer) {
        case .success:
            try output.write(from: buffer)
        case .error:
            fail("the sound isolation render failed")
        default:
            break
        }
        let percent = Int(100 * engine.manualRenderingSampleTime / max(total, 1))
        if percent / 5 != reported / 5 {
            reported = percent
            print("progress \(Double(percent) / 100)")
            fflush(stdout)
        }
    }
    engine.stop()
    let osVersion = ProcessInfo.processInfo.operatingSystemVersionString
    let result: [String: Any] = [
        "mode": mode, "sampleRate": format.sampleRate, "inputFrames": input.length,
        "outputFrames": total, "reportedLatencySeconds": latency, "macOS": osVersion,
    ]
    let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print("result \(String(decoding: json, as: UTF8.self))")
} catch {
    fail(error.localizedDescription)
}
