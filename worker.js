// The real lesson player talks to Ollama from a worker, so test that path too.
self.onmessage = async (event) => {
  const started = performance.now();
  try {
    const res = await fetch(`${event.data.url}/api/tags`);
    self.postMessage({ ok: res.ok, status: res.status, ms: Math.round(performance.now() - started) });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error && error.message || error), ms: Math.round(performance.now() - started) });
  }
};
