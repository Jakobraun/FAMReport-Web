import { LIMITS } from './source-import.mjs';
export function runImportWorker(data, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Import canceled.', 'AbortError')); return; }
    const worker = new Worker(new URL('./import-worker.js', import.meta.url));
    const finish = (error, result) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); error ? reject(error) : resolve(result); };
    const abort = () => finish(new DOMException('Import canceled.', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Processing took too long. Choose a smaller file or retry.')), LIMITS.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
    worker.onerror = event => { event.preventDefault(); finish(new Error('The browser file worker could not start or process this file. Reload and retry.')); };
    worker.postMessage(data, data.bytes ? [data.bytes] : []);
  });
}
