import { validateWorkspace } from './working-workbook.mjs';

const DB_NAME = 'chromebook-dashboard-working-v2', STORE = 'workspace', KEY = 'active';
const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
export function openWorkingStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other tabs using this dashboard, then retry.'));
  });
}
function transaction(db, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode), store = tx.objectStore(STORE); let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Browser storage could not complete the change.'));
    tx.onerror = () => reject(tx.error || new Error('Browser storage failed.'));
    Promise.resolve(operation(store)).then(value => { result = value; }).catch(error => { tx.abort(); reject(error); });
  });
}
export function readActive(db) { return transaction(db, 'readonly', async store => await requestResult(store.get(KEY)) || null); }
export function adoptWorkspace(db, workspace, expected = null, savedRevision = 0, fileHash = null) {
  validateWorkspace(workspace);
  return transaction(db, 'readwrite', async store => {
    const current = await requestResult(store.get(KEY));
    if ((current?.workspace?.workspaceId || null) !== (expected?.workspaceId || null) || (current?.workspace?.revision || null) !== (expected?.revision || null)) throw new Error('The working copy changed in another tab. Review it before replacing it.');
    const entry = { workspace: structuredClone(workspace), savedRevision, fileHash };
    await requestResult(store.put(entry, KEY)); return entry;
  });
}
export function commitEdit(db, workspaceId, expectedRevision, edit, { latest = false, now = new Date() } = {}) {
  return transaction(db, 'readwrite', async store => {
    const entry = await requestResult(store.get(KEY));
    if (!entry || entry.workspace.workspaceId !== workspaceId) throw new Error('Another working file is active. Reload before editing.');
    if (!latest && entry.workspace.revision !== expectedRevision) throw new Error('This tab is out of date. The latest browser copy was kept; review it and retry.');
    const next = structuredClone(entry.workspace); edit(next);
    next.revision++; next.updatedAt = now.toISOString(); validateWorkspace(next);
    const updated = { ...entry, workspace: next }; await requestResult(store.put(updated, KEY)); return updated;
  });
}
export function markFileSaved(db, workspaceId, revision, fileHash = null) {
  return transaction(db, 'readwrite', async store => {
    const entry = await requestResult(store.get(KEY));
    if (!entry || entry.workspace.workspaceId !== workspaceId || entry.workspace.revision < revision) throw new Error('A different working file is active.');
    const updated = { ...entry, savedRevision: Math.max(entry.savedRevision || 0, revision), fileHash: fileHash || entry.fileHash || null };
    await requestResult(store.put(updated, KEY)); return updated;
  });
}
export function storeFileHandle(db, workspaceId, handle) {
  return transaction(db, 'readwrite', async store => { await requestResult(store.put({ workspaceId, handle }, 'file-handle')); });
}
export function readFileHandle(db) { return transaction(db, 'readonly', async store => await requestResult(store.get('file-handle')) || null); }
