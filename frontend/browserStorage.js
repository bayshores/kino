const PREFIX = 'kino-';

function defaultStorage() {
  return globalThis.kinoDesktop?.storage ?? globalThis.localStorage;
}

export function getSetting(key, storage) {
  try {
    storage ??= defaultStorage();
    return storage.getItem(PREFIX + key);
  } catch { return null; }
}

export function setSetting(key, value, storage) {
  try { storage ??= defaultStorage(); storage.setItem(PREFIX + key, value); return true; }
  catch { return false; }
}
