// AEP hosting check: can a hosted page use local Ollama and local storage
// while the Content-Security-Policy blocks every other connection?
// Reports only technical results (no names, no typed text).
'use strict';

const OLLAMA_HOSTS = ['http://localhost:11434', 'http://127.0.0.1:11434'];
const PREFERRED_MODEL = 'qwen3.5:4b';
const $ = (id) => document.getElementById(id);
const results = [];

// ---- visit counter (runs on every page load, before any button) ----------
const visit = (() => {
  try {
    const previous = JSON.parse(localStorage.getItem('aep-hosting-check') || 'null');
    const now = new Date().toISOString();
    const next = { visits: (previous?.visits || 0) + 1, first: previous?.first || now, last: now, previousVisit: previous?.last || null };
    localStorage.setItem('aep-hosting-check', JSON.stringify(next));
    return next;
  } catch (error) {
    return { error: String(error.message || error) };
  }
})();

// ---- helpers --------------------------------------------------------------
function add(status, title, detail = '') {
  results.push({ status, title, detail });
  const li = document.createElement('li');
  li.className = status;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = { pass: 'PASS', warn: 'CHECK', fail: 'FAIL', info: 'INFO' }[status];
  const body = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  body.appendChild(strong);
  if (detail) {
    const p = document.createElement('div');
    p.className = 'detail';
    p.textContent = detail;
    body.appendChild(p);
  }
  li.append(tag, body);
  $('results').appendChild(li);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function timed(fn) {
  const started = performance.now();
  try { return { value: await fn(), ms: Math.round(performance.now() - started) }; }
  catch (error) { return { error: String(error?.message || error), name: error?.name, ms: Math.round(performance.now() - started) }; }
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).filter((b) => !/Not.?A.?Brand/i.test(b)) || [];
  return brands.length ? brands.join(', ') : navigator.userAgent;
}

// ---- checks ---------------------------------------------------------------
function checkEnvironment() {
  add('info', `Site address: ${location.origin}`,
    `Browser: ${browserName()} · Secure (https) context: ${window.isSecureContext ? 'yes' : 'NO'}`);
  if (!window.isSecureContext) add('fail', 'Page is not served over https', 'Offline caching and some permissions need https.');
}

async function checkSecurityPolicy() {
  let violation = null;
  const listener = (event) => { violation = `${event.violatedDirective} blocked ${event.blockedURI}`; };
  document.addEventListener('securitypolicyviolation', listener);
  const attempt = await timed(() => fetch('https://example.com/', { cache: 'no-store' }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  document.removeEventListener('securitypolicyviolation', listener);
  if (attempt.error && violation) add('pass', 'Security policy blocks connections to other websites', violation);
  else if (attempt.error) add('warn', 'Connection to another website failed, but not clearly because of the security policy', attempt.error);
  else add('fail', 'Security policy did NOT block a connection to another website', 'Student data would not be protected by the browser.');
}

async function permissionState() {
  const states = [];
  for (const name of ['local-network-access', 'loopback-network', 'local-network']) {
    try { states.push(`${name}: ${(await navigator.permissions.query({ name })).state}`); }
    catch { /* name not supported by this browser */ }
  }
  return states.length ? states.join(', ') : 'browser does not report a local-access permission';
}

async function checkOllamaFromPage() {
  for (const host of OLLAMA_HOSTS) {
    const t = withTimeout(10000);
    const r = await timed(async () => {
      const res = await fetch(`${host}/api/tags`, { signal: t.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
    t.done();
    if (!r.error) {
      const models = (r.value.models || []).map((m) => m.name);
      add('pass', `Page can talk to Ollama at ${host}`, `${r.ms} ms · models: ${models.join(', ') || 'none installed'}`);
      return { host, models };
    }
  }

  // Both failed. Tell apart "Ollama refused this site" from "could not reach Ollama".
  const t = withTimeout(10000);
  const probe = await timed(() => fetch(`${OLLAMA_HOSTS[0]}/api/tags`, { mode: 'no-cors', signal: t.signal, cache: 'no-store' }));
  t.done();
  const permission = await permissionState();
  if (!probe.error) {
    add('fail', 'Ollama is running but refused this site', `Ollama needs OLLAMA_ORIGINS set to ${location.origin} (see step 2). Local-access permission: ${permission}`);
    $('setxCommand').textContent = `setx OLLAMA_ORIGINS "${location.origin}"`;
    $('originHelp').hidden = false;
  } else {
    add('fail', 'Could not reach Ollama on this computer',
      `Either Ollama is not installed/running for this account, or Edge blocked local access. Local-access permission: ${permission}. Error: ${probe.error}`);
  }
  return null;
}

function checkOllamaFromWorker(host) {
  return new Promise((resolve) => {
    let worker;
    try { worker = new Worker('worker.js'); } catch (error) {
      add('fail', 'Could not start a background worker', String(error.message || error));
      resolve(); return;
    }
    const timer = setTimeout(() => { add('fail', 'Background worker did not answer within 15 s'); worker.terminate(); resolve(); }, 15000);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      const r = event.data;
      if (r.ok) add('pass', 'Background worker can talk to Ollama (the lesson player uses this path)', `${r.ms} ms`);
      else add('fail', 'Background worker could not talk to Ollama', r.error || `HTTP ${r.status}`);
      worker.terminate();
      resolve();
    };
    worker.postMessage({ url: host });
  });
}

async function checkGeneration(host, models) {
  if (!models.length) { add('warn', 'No AI model is installed for this account', `Run: ollama pull ${PREFERRED_MODEL}`); return; }
  const model = models.find((m) => m === PREFERRED_MODEL || m === `${PREFERRED_MODEL}:latest`)
    || models.find((m) => /^qwen/i.test(m)) || models[0];
  $('busy').textContent = `Asking ${model} for a short reply (first use can take a minute)…`;
  const ask = async (withThinkFlag) => {
    const t = withTimeout(180000);
    try {
      const body = { model, stream: false, messages: [{ role: 'user', content: 'Reply with one short sentence in simple past tense about yesterday.' }], options: { num_predict: 40 } };
      if (withThinkFlag) body.think = false;
      const res = await fetch(`${host}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: t.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } finally { t.done(); }
  };
  let r = await timed(() => ask(true));
  if (r.error && /think/i.test(r.error)) r = await timed(() => ask(false));
  if (r.error) add('fail', `AI reply from ${model} failed`, `${r.ms} ms · ${r.error}`);
  else {
    const text = (r.value.message?.content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    add(text ? 'pass' : 'warn', `AI reply from ${model} worked`, `${(r.ms / 1000).toFixed(1)} s · "${text || '(empty reply)'}"`);
  }
}

async function checkStorage() {
  if (visit.error) { add('fail', 'Browser storage is blocked', visit.error); return; }
  const when = visit.previousVisit ? `previous visit ${new Date(visit.previousVisit).toLocaleString()}` : 'first visit with this account';
  add(visit.visits > 1 ? 'pass' : 'info', `Saved data: visit ${visit.visits} on this account`, `${when} · first seen ${new Date(visit.first).toLocaleString()}`);

  const idb = await timed(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('aep-hosting-check', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const get = store.get('runs');
      get.onsuccess = () => { const runs = (get.result || 0) + 1; store.put(runs, 'runs'); tx.oncomplete = () => { open.result.close(); resolve(runs); }; };
      tx.onerror = () => reject(tx.error);
    };
  }));
  if (idb.error) add('fail', 'Course storage (IndexedDB) is blocked', idb.error);
  else add('pass', `Course storage (IndexedDB) works · run ${idb.value}`);

  let persisted = 'not supported';
  try { persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()) ? 'yes' : 'no (browser may clear it if the disk is full)'; } catch { /* unsupported */ }
  let quota = '';
  try { const e = await navigator.storage.estimate(); quota = ` · space available to this site: ${Math.round(e.quota / 1e6)} MB`; } catch { /* unsupported */ }
  add('info', `Protected from automatic clearing: ${persisted}`, quota.slice(3));
}

async function checkOfflineCache() {
  if (!('serviceWorker' in navigator)) { add('fail', 'Offline caching is not available'); return; }
  const r = await timed(async () => {
    await navigator.serviceWorker.register('sw.js');
    return navigator.serviceWorker.ready;
  });
  if (r.error) add('fail', 'Offline caching could not be set up', r.error);
  else if (navigator.serviceWorker.controller) add('pass', 'Offline caching is active for this page');
  else add('info', 'Offline caching was set up', 'Reload the page and run again to confirm it is active.');
}

// ---- run ------------------------------------------------------------------
async function run() {
  $('run').disabled = true;
  $('copy').disabled = true;
  $('results').textContent = '';
  results.length = 0;
  $('busy').textContent = 'Running…';
  try {
    checkEnvironment();
    await checkSecurityPolicy();
    const ollama = await checkOllamaFromPage();
    if (ollama) {
      await checkOllamaFromWorker(ollama.host);
      await checkGeneration(ollama.host, ollama.models);
    }
    await checkStorage();
    await checkOfflineCache();
  } catch (error) {
    add('fail', 'The check itself stopped unexpectedly', String(error?.stack || error));
  }
  $('busy').textContent = 'Done.';
  $('report').value = [
    `AEP hosting check · ${new Date().toISOString()}`,
    ...results.map((r) => `[${{ pass: 'PASS', warn: 'CHECK', fail: 'FAIL', info: 'INFO' }[r.status]}] ${r.title}${r.detail ? `\n       ${r.detail}` : ''}`),
    '',
    'Did Edge show a prompt about accessing apps/services on this device? (yes/no): ',
  ].join('\n');
  $('copy').disabled = false;
  $('run').disabled = false;
}

$('run').addEventListener('click', run);
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('report').value); $('copied').textContent = 'Copied.'; }
  catch { $('report').select(); $('copied').textContent = 'Press Ctrl+C to copy the selected text.'; }
});
