// Hand-run check of kino's transcription with the real whisper-cli and model (not part of
// npm test: it needs the model file and takes seconds per file). It writes no transcript beside
// the files; it prints what kino hears, with and without the names.
//
//   node scripts/speech-hear-check.mjs --names "Acme,RTX" voice.wav [more.wav ...]
import { transcribeFile, whisperSetup } from "../backend/speech/transcribe.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--names");
const names = at >= 0 ? args.splice(at, 2)[1].split(",").map((name) => name.trim()).filter(Boolean) : [];
const setup = whisperSetup();
for (const file of args) {
  for (const list of names.length ? [[], names] : [[]]) {
    const started = performance.now();
    const transcript = await transcribeFile(file, setup, { names: list });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`\n${file} (names: ${list.join(", ") || "none"}; ${seconds} s)`);
    console.log(transcript.words.map((word) => word.text).join(" "));
    for (const span of transcript.reheard ?? []) {
      console.log(`  re-heard ${span.start}-${span.end} s, kept ${span.kept} (p ${span.p.join(" vs ")}): "${span.first}" | "${span.second}"`);
    }
  }
}
