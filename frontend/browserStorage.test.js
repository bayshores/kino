import test from 'node:test';
import assert from 'node:assert/strict';
import { getSetting, setSetting } from './browserStorage.js';

test('settings are saved and read under the kino- prefix',()=>{
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  assert.equal(getSetting('last-project', storage), null);
  assert.equal(setSetting('last-project', 'project-3', storage), true);
  assert.equal(values.get('kino-last-project'), 'project-3');
  assert.equal(getSetting('last-project', storage), 'project-3');
});
