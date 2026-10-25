// Everything personal lives in this browser: profile, tracked jobs, AI
// settings. Nothing here is ever sent to the AIJobNinja server. Every read
// and write is wrapped, because storage can be unavailable (private mode,
// blocked site data) and the app must still work for the session.

const PREFIX = 'ajn:';
const memory = new Map();

function backend(session) {
  try {
    const s = session ? window.sessionStorage : window.localStorage;
    const probe = PREFIX + 'probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function read(key, fallback, { session = false } = {}) {
  const s = backend(session);
  try {
    const raw = s ? s.getItem(PREFIX + key) : memory.get(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function write(key, value, { session = false } = {}) {
  const raw = JSON.stringify(value);
  const s = backend(session);
  try {
    if (s) s.setItem(PREFIX + key, raw);
    else memory.set(PREFIX + key, raw);
    return true;
  } catch {
    memory.set(PREFIX + key, raw);
    return false; // quota exceeded: kept for this session only
  }
}

export function remove(key, { session = false } = {}) {
  const s = backend(session);
  try { s?.removeItem(PREFIX + key); } catch {}
  memory.delete(PREFIX + key);
}

export const storageAvailable = () => backend(false) !== null;

// ---------------------------------------------------------------- profile
export const EMPTY_PROFILE = { name: '', email: '', phone: '', location: '', links: '', targetRoles: '', dealBreakers: '', preferences: '', cv: '', language: 'English' };
export const getProfile = () => ({ ...EMPTY_PROFILE, ...read('profile', {}) });
export const saveProfile = (p) => write('profile', p);

// ---------------------------------------------------------------- tracked jobs
// Canonical tracker states (templates/states.yml), plus "Saved" for jobs not
// evaluated yet.
export const STATES = ['Saved', 'Evaluated', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];

export const getJobs = () => read('jobs', {});
export const getJob = (key) => getJobs()[key] || null;
export function putJob(job) {
  const all = getJobs();
  const prev = all[job.key] || {};
  all[job.key] = { status: 'Saved', notes: '', savedAt: new Date().toISOString(), ...prev, ...job, updatedAt: new Date().toISOString() };
  const ok = write('jobs', all);
  return { job: all[job.key], ok };
}
export function deleteJob(key) {
  const all = getJobs();
  delete all[key];
  write('jobs', all);
}

// ---------------------------------------------------------------- AI settings
// Keys can be remembered on this device (localStorage) or kept for this tab
// only (sessionStorage). Either way they never leave the browser except in
// the request to the provider the visitor chose.
export function getAiSettings() {
  const s = read('ai', { provider: '', models: {}, remember: true, metaContributor: false });
  const keys = { ...read('keys', {}, { session: true }), ...(s.remember ? read('keys', {}) : {}) };
  return { ...s, keys };
}
export function saveAiSettings({ keys, ...rest }) {
  write('ai', rest);
  if (rest.remember) { write('keys', keys); remove('keys', { session: true }); }
  else { write('keys', keys, { session: true }); remove('keys'); }
}

// ---------------------------------------------------------------- backup
export function exportAll() {
  const ai = read('ai', {});
  return { app: 'AIJobNinja', version: 1, exportedAt: new Date().toISOString(), profile: getProfile(), jobs: getJobs(), ai: { provider: ai.provider, models: ai.models, metaContributor: ai.metaContributor } };
}
export function importAll(data) {
  if (!data || data.app !== 'AIJobNinja' || typeof data.jobs !== 'object') throw new Error('This file is not an AIJobNinja backup');
  if (data.profile) saveProfile({ ...EMPTY_PROFILE, ...data.profile });
  const merged = { ...getJobs(), ...data.jobs };
  write('jobs', merged);
  return Object.keys(data.jobs).length;
}
export function wipeAll() {
  for (const k of ['profile', 'jobs', 'ai', 'keys', 'ui']) remove(k);
  remove('keys', { session: true });
}
