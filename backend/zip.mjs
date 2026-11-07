import { createReadStream } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const CLASSIC_ZIP_MAX_SIZE = 0x1_0000_0000;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC_TABLE.length; value += 1) {
  let remainder = value;
  for (let bit = 0; bit < 8; bit += 1) {
    remainder =
      (remainder & 1) === 1
        ? 0xedb88320 ^ (remainder >>> 1)
        : remainder >>> 1;
  }
  CRC_TABLE[value] = remainder >>> 0;
}

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    const error = new Error("ZIP archive export was cancelled");
    error.name = "AbortError";
    error.cause = signal.reason;
    throw error;
  }
}

function updateCrc(crc, chunk) {
  let result = crc;
  for (const byte of chunk) {
    result = CRC_TABLE[(result ^ byte) & 0xff] ^ (result >>> 8);
  }
  return result >>> 0;
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > UINT16_MAX) {
    throw new RangeError("ZIP archives support between 0 and 65535 entries");
  }

  const files = new Set();
  const directories = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError("Each ZIP entry must include a name and file path");
    }
    const { name, path } = entry;
    if (typeof path !== "string" || path.length === 0) {
      throw new TypeError("Each ZIP entry must include a file path");
    }
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes(":") ||
      /[\u0000-\u001f\u007f]/u.test(name)
    ) {
      throw new TypeError("ZIP entry names must be safe relative paths");
    }
    const parts = name.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new TypeError("ZIP entry names must be safe relative paths");
    }
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.toString("utf8") !== name || nameBytes.length > UINT16_MAX) {
      throw new TypeError("ZIP entry names must be valid UTF-8 and at most 65535 bytes");
    }

    // Reject names that collide on common case-insensitive, Unicode-normalizing
    // filesystems, including a file used as another entry's parent directory.
    const keyParts = name.normalize("NFC").toLowerCase().split("/");
    const key = keyParts.join("/");
    if (files.has(key) || directories.has(key)) {
      throw new TypeError(`ZIP entry name collides with another path: ${name}`);
    }
    let parent = "";
    for (const part of keyParts.slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part;
      if (files.has(parent)) {
        throw new TypeError(`ZIP entry name collides with another path: ${name}`);
      }
    }
    files.add(key);
    parent = "";
    for (const part of keyParts.slice(0, -1)) {
      parent = parent ? `${parent}/${part}` : part;
      directories.add(parent);
    }

    return {
      nameBytes,
      path,
      flags: nameBytes.some((byte) => byte > 0x7f) ? 0x0800 : 0,
    };
  });
}

async function inspectFile(path, signal) {
  abortIfNeeded(signal);
  const details = await lstat(path);
  if (!details.isFile()) {
    throw new Error(`ZIP source is not a regular file: ${path}`);
  }
  if (details.size > UINT32_MAX) {
    throw new RangeError("ZIP source exceeds the classic ZIP 4 GiB limit");
  }

  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of createReadStream(path, { signal })) {
    abortIfNeeded(signal);
    size += chunk.length;
    if (size > UINT32_MAX) {
      throw new RangeError("ZIP source exceeds the classic ZIP 4 GiB limit");
    }
    crc = updateCrc(crc, chunk);
  }
  abortIfNeeded(signal);
  if (size !== details.size) {
    throw new Error("ZIP source changed while it was being archived");
  }
  return { crc: (crc ^ 0xffffffff) >>> 0, size };
}

async function writeAt(handle, buffer, position, signal) {
  let written = 0;
  while (written < buffer.length) {
    abortIfNeeded(signal);
    const result = await handle.write(
      buffer,
      written,
      buffer.length - written,
      position + written,
    );
    if (result.bytesWritten === 0) {
      throw new Error("Could not write the ZIP archive");
    }
    written += result.bytesWritten;
  }
}

async function writeFileData(handle, path, expected, position, signal) {
  let size = 0;
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(path, { signal })) {
    abortIfNeeded(signal);
    size += chunk.length;
    if (size > expected.size || size > UINT32_MAX) {
      throw new Error("ZIP source changed while it was being archived");
    }
    crc = updateCrc(crc, chunk);
    await writeAt(handle, chunk, position + size - chunk.length, signal);
  }
  abortIfNeeded(signal);
  if (size !== expected.size || ((crc ^ 0xffffffff) >>> 0) !== expected.crc) {
    throw new Error("ZIP source changed while it was being archived");
  }
  return size;
}

function localHeader(nameBytes, flags, { crc, size }) {
  const header = Buffer.alloc(30 + nameBytes.length);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(0, 8); // stored without compression
  header.writeUInt16LE(0, 10); // deterministic DOS time
  header.writeUInt16LE(0x0021, 12); // 1980-01-01
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  nameBytes.copy(header, 30);
  return header;
}

function centralDirectoryEntry(nameBytes, flags, { crc, size, offset }) {
  const entry = Buffer.alloc(46 + nameBytes.length);
  entry.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  entry.writeUInt16LE(20, 4); // DOS host, ZIP version 2.0
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(flags, 8);
  entry.writeUInt16LE(0, 10);
  entry.writeUInt16LE(0, 12);
  entry.writeUInt16LE(0x0021, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(size, 20);
  entry.writeUInt32LE(size, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt16LE(0, 30); // extra length
  entry.writeUInt16LE(0, 32); // comment length
  entry.writeUInt16LE(0, 34); // disk number
  entry.writeUInt16LE(0, 36); // internal attributes
  entry.writeUInt32LE(0, 38); // external attributes
  entry.writeUInt32LE(offset, 42);
  nameBytes.copy(entry, 46);
  return entry;
}

function endOfCentralDirectory(entryCount, directorySize, directoryOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(directorySize, 12);
  record.writeUInt32LE(directoryOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

/** Stream files into a deterministic, uncompressed classic ZIP archive. */
export async function archiveFiles(entries, output, { signal } = {}) {
  if (typeof output !== "string" || output.length === 0) {
    throw new TypeError("ZIP archive output path is required");
  }
  const sources = validateEntries(entries);
  abortIfNeeded(signal);

  let handle;
  let created = false;
  try {
    handle = await open(output, "wx", 0o600);
    created = true;
    let position = 0;
    let directorySize = 0;
    const entriesInArchive = [];

    for (const source of sources) {
      abortIfNeeded(signal);
      const details = await inspectFile(source.path, signal);
      const offset = position;
      if (offset > UINT32_MAX) {
        throw new RangeError("ZIP archive exceeds the classic ZIP 4 GiB limit");
      }
      const header = localHeader(source.nameBytes, source.flags, details);
      const nextDirectorySize = directorySize + 46 + source.nameBytes.length;
      if (
        position +
          header.length +
          details.size +
          nextDirectorySize +
          22 >
        CLASSIC_ZIP_MAX_SIZE
      ) {
        throw new RangeError("ZIP archive exceeds the classic ZIP 4 GiB limit");
      }
      await writeAt(handle, header, position, signal);
      position += header.length;
      position += await writeFileData(handle, source.path, details, position, signal);
      entriesInArchive.push(
        centralDirectoryEntry(source.nameBytes, source.flags, { ...details, offset }),
      );
      directorySize = nextDirectorySize;
    }

    abortIfNeeded(signal);
    const directoryOffset = position;
    if (directoryOffset + directorySize + 22 > CLASSIC_ZIP_MAX_SIZE) {
      throw new RangeError("ZIP archive exceeds the classic ZIP 4 GiB limit");
    }
    for (const entry of entriesInArchive) {
      await writeAt(handle, entry, position, signal);
      position += entry.length;
    }
    const endRecord = endOfCentralDirectory(
      sources.length,
      directorySize,
      directoryOffset,
    );
    if (position + endRecord.length > CLASSIC_ZIP_MAX_SIZE) {
      throw new RangeError("ZIP archive exceeds the classic ZIP 4 GiB limit");
    }
    await writeAt(handle, endRecord, position, signal);
    await handle.close();
    handle = undefined;
    return { path: output, size: position + endRecord.length, entryCount: sources.length };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    if (created) {
      await rm(output, { force: true }).catch(() => {});
    }
    throw error;
  }
}
