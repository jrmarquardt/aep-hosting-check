// AEP course update test: receives signed course update files and applies the
// rules planned for the real player:
// - one file = one complete course; installing it replaces that course entirely
// - other courses are untouched
// - older version than installed: refused; same version: "already up to date"
// - progress is kept for lessons still in the course, deleted for removed lessons
// - only files signed with the teacher's key are accepted
'use strict';

const $ = (id) => document.getElementById(id);
const DB_NAME = 'aep-course-update-test';
const PROGRESS_PREFIX = 'aep-course-test-progress:';
const LOG_KEY = 'aep-course-test-log';
// The log is kept in storage so every tab an update file opens adds to one list.
let log = [];
try { log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { log = []; }

// ---- log ------------------------------------------------------------------
function note(line) {
  try { log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { /* keep in-memory log */ }
  log.push(`${new Date().toLocaleTimeString()}  ${line}`);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch { /* storage blocked */ }
  refreshLog();
}
function refreshLog() {
  $('log').value = [`AEP course update test · ${location.origin} · ${navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).filter((b) => !/Not.?A.?Brand/i.test(b)).join(', ') || navigator.userAgent}`, ...log, '', courseSummary()].join('\n');
}
let lastCourses = [];
function courseSummary() {
  if (!lastCourses.length) return 'Installed now: (none)';
  return 'Installed now:\n' + lastCourses.map((c) => `  ${c.course.title} v${c.course.version}: ${c.lessons.map((l) => `${l.title}${isDone(c.course.id, l.id) ? ' [done]' : ''}`).join(', ')}`).join('\n');
}
function setStatus(text, kind) {
  $('status').textContent = text;
  $('status').className = kind || '';
}

// ---- storage --------------------------------------------------------------
function db() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('courses', { keyPath: 'course.id' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function tx(mode, fn) {
  const database = await db();
  try {
    return await new Promise((resolve, reject) => {
      const t = database.transaction('courses', mode);
      const result = fn(t.objectStore('courses'));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
    });
  } finally { database.close(); }
}
const getCourse = (id) => tx('readonly', (s) => s.get(id));
const allCourses = () => tx('readonly', (s) => s.getAll());
const putCourse = (record) => tx('readwrite', (s) => s.put(record));
const deleteCourse = (id) => tx('readwrite', (s) => s.delete(id));

const progressKey = (courseId, lessonId) => `${PROGRESS_PREFIX}${courseId}:${lessonId}`;
function isDone(courseId, lessonId) { try { return localStorage.getItem(progressKey(courseId, lessonId)) === 'done'; } catch { return false; } }
function setDone(courseId, lessonId, done) {
  try { done ? localStorage.setItem(progressKey(courseId, lessonId), 'done') : localStorage.removeItem(progressKey(courseId, lessonId)); } catch { /* storage blocked */ }
}
function clearProgress(courseId, keepLessonIds = []) {
  const prefix = `${PROGRESS_PREFIX}${courseId}:`;
  const removed = [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const lessonId = key.slice(prefix.length);
      if (!keepLessonIds.includes(lessonId)) { localStorage.removeItem(key); removed.push(lessonId); }
    }
  } catch { /* storage blocked */ }
  return removed;
}

// ---- signature + validation ----------------------------------------------
function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function verifyPackage(pkg) {
  if (!pkg || pkg.format !== 'aep-course-update-v1' || typeof pkg.payload !== 'string' || typeof pkg.signature !== 'string') {
    throw new Error('This is not an AEP lesson update file.');
  }
  const key = await crypto.subtle.importKey('jwk', window.AEP_UPDATE_PUBLIC_KEY, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const bytes = base64ToBytes(pkg.payload);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64ToBytes(pkg.signature), bytes);
  if (!ok) throw new Error('This file was not signed by your teacher, so it was not installed.');
  const data = JSON.parse(new TextDecoder().decode(bytes));
  const course = data.course;
  if (!course || !/^[a-z0-9-]+$/.test(course.id || '') || !/^\d+\.\d+\.\d+$/.test(course.version || '') || !course.title) throw new Error('The course details in this file are not valid.');
  if (!Array.isArray(data.lessons) || !data.lessons.length) throw new Error('This file contains no lessons.');
  const ids = new Set();
  for (const lesson of data.lessons) {
    if (!lesson?.id || !lesson.title || ids.has(lesson.id)) throw new Error('A lesson in this file is missing or duplicated.');
    ids.add(lesson.id);
  }
  return data;
}
function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// ---- apply an update --------------------------------------------------------
async function applyPackage(pkg, via) {
  const sizeMb = (JSON.stringify(pkg).length / 1e6).toFixed(1);
  try {
    const data = await verifyPackage(pkg);
    const { course } = data;
    const installed = await getCourse(course.id);
    let result;
    if (installed && compareVersions(course.version, installed.course.version) < 0) {
      result = { ok: false, text: `Not installed: you already have a newer version of ${installed.course.title} (v${installed.course.version}). This file is v${course.version}.` };
    } else if (installed && compareVersions(course.version, installed.course.version) === 0) {
      result = { ok: true, text: `${course.title} is already up to date (v${course.version}). Nothing changed.` };
    } else {
      const keep = data.lessons.map((l) => l.id);
      await putCourse({ course, lessons: data.lessons, publishedAt: data.publishedAt, installedAt: new Date().toISOString() });
      const dropped = installed ? clearProgress(course.id, keep) : [];
      const removedLessons = installed ? installed.lessons.filter((l) => !keep.includes(l.id)).map((l) => l.title) : [];
      result = {
        ok: true,
        text: installed
          ? `${course.title} updated from v${installed.course.version} to v${course.version}: ${data.lessons.length} lessons.`
            + (removedLessons.length ? ` Removed: ${removedLessons.join(', ')}.` : '')
            + (dropped.length ? ` Progress removed for ${dropped.length} removed lesson(s).` : '')
          : `${course.title} v${course.version} installed: ${data.lessons.length} lessons.`,
      };
    }
    setStatus(result.text, result.ok ? 'ok' : 'bad');
    await render();
    note(`${result.ok ? 'OK ' : 'NO '} [${via}, ${sizeMb} MB] ${result.text}`);
    return result;
  } catch (error) {
    const text = error.message || String(error);
    setStatus(text, 'bad');
    note(`NO  [${via}, ${sizeMb} MB] ${text}`);
    return { ok: false, text };
  }
}

// ---- receive from an update file -------------------------------------------
// The update file opens this page and waits for "ready", then sends the package.
// Anyone could send a message, which is why only signed packages are accepted.
window.addEventListener('message', async (event) => {
  if (event.data?.type !== 'aep-course-update') return;
  const result = await applyPackage(event.data.package, 'double-click');
  try { event.source?.postMessage({ type: 'aep-course-update-result', ...result }, '*'); } catch { /* file tab closed */ }
});

function packageFromHtml(text) {
  const match = text.match(/<script type="application\/json" id="aep-update">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('This is not an AEP lesson update file.');
  return JSON.parse(match[1]);
}
async function importFile(file, via) {
  try { await applyPackage(packageFromHtml(await file.text()), via); }
  catch (error) { setStatus(error.message, 'bad'); note(`NO  [${via}] ${error.message}`); }
}
$('pick').addEventListener('change', (event) => { if (event.target.files[0]) importFile(event.target.files[0], 'chosen file'); event.target.value = ''; });
document.addEventListener('dragover', (event) => { event.preventDefault(); document.body.classList.add('dropping'); });
document.addEventListener('dragleave', (event) => { if (!event.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dropping');
  const file = event.dataTransfer?.files?.[0];
  if (file) importFile(file, 'dragged file');
});

// ---- course list ------------------------------------------------------------
async function render() {
  lastCourses = (await allCourses()).sort((a, b) => a.course.title.localeCompare(b.course.title));
  const host = $('courses');
  host.textContent = '';
  if (!lastCourses.length) { host.innerHTML = '<p>No courses installed yet.</p>'; refreshLog(); return; }
  for (const record of lastCourses) {
    const card = document.createElement('div');
    card.className = 'course';
    const h = document.createElement('h3');
    h.textContent = `${record.course.title} · v${record.course.version}`;
    const meta = document.createElement('p');
    meta.className = 'detail';
    meta.textContent = `Installed ${new Date(record.installedAt).toLocaleString()}`;
    const list = document.createElement('ul');
    for (const lesson of record.lessons) {
      const li = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = isDone(record.course.id, lesson.id);
      box.addEventListener('change', () => { setDone(record.course.id, lesson.id, box.checked); note(`Marked ${lesson.title} ${box.checked ? 'done' : 'not done'}`); });
      label.append(box, ` ${lesson.title}`);
      li.appendChild(label);
      if (lesson.attachment) {
        const size = document.createElement('span');
        size.className = 'detail';
        size.textContent = ` (includes ${(lesson.attachment.length / 1e6).toFixed(1)} MB of test content)`;
        li.appendChild(size);
      }
      list.appendChild(li);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = `Remove ${record.course.title}`;
    remove.addEventListener('click', async () => {
      if (!confirm(`Remove ${record.course.title} and its progress from this computer?`)) return;
      await deleteCourse(record.course.id);
      clearProgress(record.course.id);
      setStatus(`${record.course.title} removed.`, 'ok');
      await render();
      note(`OK  Removed ${record.course.title}`);
    });
    card.append(h, meta, list, remove);
    host.appendChild(card);
  }
  refreshLog();
}

$('reset').addEventListener('click', async () => {
  if (!confirm('Remove all test courses, progress, and results so the test can start over?')) return;
  for (const record of await allCourses()) { await deleteCourse(record.course.id); clearProgress(record.course.id); }
  log = [];
  try { localStorage.removeItem(LOG_KEY); } catch { /* storage blocked */ }
  setStatus('Test reset. Start again with test file 1.', 'ok');
  await render();
});

$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('log').value); $('copied').textContent = 'Copied.'; }
  catch { $('log').select(); $('copied').textContent = 'Press Ctrl+C to copy the selected text.'; }
});

render().then(() => {
  note('Page opened' + (window.opener ? ' by an update file' : ''));
  // Tell the update file that opened this page that it can send the lessons.
  if (window.opener) { try { window.opener.postMessage({ type: 'aep-ready' }, '*'); } catch { /* opener gone */ } }
}).catch((error) => { setStatus(`Storage is not available: ${error.message}`, 'bad'); note(`NO  Storage: ${error.message}`); });
