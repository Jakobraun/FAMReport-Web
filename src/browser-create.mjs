import { runImportWorker } from './import-client.mjs';
import { LIMITS, SITE_ROOMS, SITES, combineTagImports, toDashboardRecords, siteForId } from './source-import.mjs';
import { buildRoomDashboard } from './dashboard-core.mjs';
import { loadWillardRoomMap, loadLakewoodRoomMaps } from './room-map.mjs';
import { isRosterStale } from './roster-core.mjs';
import { openWorkingStore, readActive, adoptWorkspace, commitEdit, markFileSaved, storeFileHandle, readFileHandle } from './working-store.mjs';
import { editRoom, addRoom, deleteRoom, addStudent, removeStudent, addManualStudentName, removeManualStudentName, restoreRemovedStudent, setInventory, resetRoomInventory } from './working-edits.mjs';
import { compareImport, applyImportReview } from './import-reconcile.mjs';

const $ = selector => document.querySelector(selector);
const dialog = $('#create-dialog'), candidates = { csv: null, roster: null }, jobs = new Map();
let activeWorkspace = null, activeSite = null, selectedRoom = null, creating = null, editPending = 0, maps = {}, friendlyNames = {}, fileHandle = null, fileHash = null, savedRevision = 0;
const dbReady = openWorkingStore();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('chromebook-dashboard-working-v2') : null;
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
function workspaceStatus(message = '') {
  if (!activeWorkspace) { $('#workspace-status').textContent = message; return; }
  const state = activeWorkspace.revision > savedRevision ? 'Saved in this browser; waiting for file save' : 'File save confirmed';
  $('#workspace-status').textContent = `${activeWorkspace.filename} · revision ${activeWorkspace.revision} · ${state}${message ? ` · ${message}` : ''}`;
}
function activate(entry, { site = null } = {}) {
  if (activeWorkspace && activeWorkspace.workspaceId !== entry.workspace.workspaceId) fileHandle = null;
  activeWorkspace = entry.workspace; savedRevision = entry.savedRevision || 0;
  fileHash = entry.fileHash || null;
  activeSite = site && activeWorkspace.sites.includes(site) ? site : activeWorkspace.sites[0]; selectedRoom = null;
  $('#preview-site').replaceChildren(...activeWorkspace.sites.map(value => { const option = document.createElement('option'); option.value = option.textContent = value; return option; }));
  $('#preview-site').value = activeSite;
  $('#start-create').disabled = true; $('#empty-state').hidden = true; $('#working-preview').hidden = false;
  $('#save-working').hidden = $('#download-working').hidden = false; $('#download-working').href = '#';
  $('#preview-room').hidden = true; workspaceStatus(); renderPreview();
}
async function applyEdit(change, { latest = false } = {}) {
  if (!activeWorkspace) return;
  editPending++; $('#working-preview').inert = true;
  try {
    const entry = await commitEdit(await dbReady, activeWorkspace.workspaceId, activeWorkspace.revision, change, { latest });
    activeWorkspace = entry.workspace; savedRevision = entry.savedRevision || 0; workspaceStatus();
    channel?.postMessage({ workspaceId: activeWorkspace.workspaceId, revision: activeWorkspace.revision });
    await renderPreview(); if (selectedRoom && activeWorkspace.settings[activeSite].rooms.includes(selectedRoom)) showRoom(selectedRoom);
  } catch (error) {
    const entry = await readActive(await dbReady); if (entry) activate(entry, { site: activeSite });
    workspaceStatus(error.message);
  } finally { editPending--; if (!editPending) $('#working-preview').inert = false; }
}
const status = (text, error = false) => { $('#import-status').textContent = text; $('#import-status').dataset.error = String(error); };
const dateLabel = source => source.fileDate ? `${new Date(source.fileDate.length === 10 ? `${source.fileDate}T12:00:00` : source.fileDate).toLocaleDateString()} (${source.dateBasis})` : 'Unknown';
function updateReview() {
  const { csv, roster } = candidates, warnings = [...(csv?.warnings || []), ...(roster || []).flatMap(value => value.warnings)];
  const rosterSites = (roster || []).map(value => value.site), duplicate = new Set(rosterSites).size !== rosterSites.length;
  for (const imported of roster || []) {
    if (imported.source.fileDate && isRosterStale(imported.source.fileDate)) warnings.push(`${imported.site}: the roster is more than one calendar month old.`);
    if (csv?.sites.includes(imported.site)) {
      const dashboard = buildRoomDashboard(toDashboardRecords(csv.records, imported.site, csv.siteAliases), { rooms: Object.keys(imported.rooms), archivedRooms: SITE_ROOMS[imported.site].filter(room => !Object.hasOwn(imported.rooms, room)), deletedRooms: [], students: Object.fromEntries(Object.entries(imported.rooms).map(([room, value]) => [room, value.students])) });
      for (const room of dashboard.roomsWithCarts) if (!room.students) warnings.push(`Room ${room.room}: devices assigned but no students — review (${imported.site}).`);
    }
  }
  $('#import-warnings').replaceChildren(...warnings.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  const mismatch = csv && roster && JSON.stringify(csv.sites) !== JSON.stringify(SITES.filter(site => rosterSites.includes(site)));
  $('#confirm-create').disabled = !csv || !roster || !!mismatch || duplicate || !!csv?.missingFriendlyNames.length || jobs.size > 0 || !!creating;
  $('#apply-friendly-names').disabled = jobs.size > 0 || !!creating;
  if (duplicate) status('Choose one current roster per school. Conflicting updates need reconciliation.', true);
  else if (mismatch) status('The CSV and roster imports identify different schools. Include a roster for each imported school.', true);
  else if (csv?.missingFriendlyNames.length && !jobs.size) status('Enter the missing friendly product names below.');
  else if (csv && roster && !jobs.size && !creating) status(`Ready to create one workbook for ${csv.sites.join(' and ')}.`);
}
function showMissingNames() {
  const missing = candidates.csv?.missingFriendlyNames || [];
  $('#friendly-name-review').hidden = !missing.length;
  $('#friendly-name-fields').replaceChildren(...missing.map((item, index) => {
    const wrapper = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input');
    input.id = `friendly-${index}`; input.type = 'text'; input.maxLength = 100; input.dataset.productKey = item.key;
    input.value = friendlyNames[item.key] || ''; label.htmlFor = input.id; label.textContent = `${item.type}: ${item.product} (${item.count})`;
    wrapper.append(label, input); return wrapper;
  }));
}
async function selectFile(kind, input) {
  jobs.get(kind)?.abort(); candidates[kind] = null;
  const label = $(`#${kind}-summary`), files = [...input.files];
  if (kind === 'csv') showMissingNames();
  if (!files.length) { jobs.delete(kind); label.textContent = `No ${kind === 'csv' ? 'CSV' : 'roster'} selected.`; updateReview(); return; }
  const controller = new AbortController(); jobs.set(kind, controller);
  label.textContent = `Reading ${files.length} file(s)…`; status('Reading and validating the selected files…'); updateReview();
  try {
    if (files.length > 20) throw new Error('Select no more than 20 files at a time.');
    const parsedFiles = [], summaries = [];
    for (const file of files) {
      if (!(kind === 'csv' ? /\.csv$/i : /\.xlsx$/i).test(file.name)) throw new Error(`Choose .${kind === 'csv' ? 'csv' : 'xlsx'} files.`);
      if (!file.size || file.size > (kind === 'csv' ? LIMITS.csvBytes : LIMITS.rosterBytes)) throw new Error('Choose nonempty files no larger than 10 MiB each.');
      const bytes = await file.arrayBuffer(); if (controller.signal.aborted) return;
      const parsed = await runImportWorker({ action: kind, bytes, filename: file.name, modified: file.lastModified, friendlyNames }, { signal: controller.signal });
      if (controller.signal.aborted) return; parsedFiles.push(parsed);
      summaries.push(`${file.name} · ${kind === 'csv' ? `${parsed.sites.join(' and ')} · ${parsed.records.length} device records · ${parsed.filtering.discardedRows} rows discarded` : `${parsed.site} · ${parsed.studentCount} students · ${Object.keys(parsed.rooms).length} rooms`} · ${dateLabel(parsed.source)}`);
    }
    candidates[kind] = kind === 'csv' ? combineTagImports(parsedFiles) : parsedFiles;
    label.textContent = summaries.join('\n'); if (kind === 'csv') showMissingNames();
  } catch (error) { if (error.name !== 'AbortError' && !controller.signal.aborted) { label.textContent = error.message; status(error.message, true); } }
  finally { if (jobs.get(kind) === controller) jobs.delete(kind); updateReview(); }
}
$('#apply-friendly-names').onclick = () => {
  const proposed = { ...friendlyNames };
  for (const input of $('#friendly-name-fields').querySelectorAll('input')) {
    const value = input.value.trim();
    if (!value || value.length > 100 || /[\r\n\x00]/.test(value)) { status('Enter a name of 1–100 characters for each product.', true); input.focus(); return; }
    proposed[input.dataset.productKey] = value;
  }
  friendlyNames = proposed; selectFile('csv', $('#initial-csv'));
};
function cancelCreation() {
  jobs.forEach(job => job.abort()); jobs.clear(); creating?.abort(); creating = null;
  candidates.csv = candidates.roster = null; $('#create-form').reset(); showMissingNames(); $('#csv-summary').textContent = 'No CSV selected.'; $('#roster-summary').textContent = 'No roster selected.'; status(''); updateReview(); dialog.close();
}
$('#start-create').onclick = () => { if (activeWorkspace) return; dialog.showModal(); };
$('#initial-csv').onchange = event => selectFile('csv', event.target);
$('#initial-roster').onchange = event => selectFile('roster', event.target);
$('#cancel-create').onclick = cancelCreation;
dialog.addEventListener('cancel', event => { event.preventDefault(); cancelCreation(); });
$('#create-form').onsubmit = async event => {
  event.preventDefault(); if ($('#confirm-create').disabled) return;
  const controller = new AbortController(); creating = controller; updateReview();
  $('#initial-csv').disabled = $('#initial-roster').disabled = true; status('Creating and checking your working workbook…');
  try {
    const result = await runImportWorker({ action: 'create', csv: candidates.csv, roster: candidates.roster }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    const entry = await adoptWorkspace(await dbReady, result.workspace, null, 0, await digest(result.bytes));
    activate(entry); dialog.close();
    channel?.postMessage({ workspaceId: activeWorkspace.workspaceId, revision: activeWorkspace.revision });
    await downloadBytes(result.bytes, activeWorkspace.filename);
  } catch (error) { if (error.name !== 'AbortError') status(error.message, true); }
  finally { if (creating === controller) creating = null; $('#initial-csv').disabled = $('#initial-roster').disabled = false; updateReview(); }
};
function table(headers, rows, title) {
  const wrapper = document.createElement('div'), heading = document.createElement('h4'); heading.textContent = title; wrapper.append(heading);
  const element = document.createElement('table'), head = element.createTHead().insertRow();
  for (const text of headers) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = text; head.append(cell); }
  const body = element.createTBody(); for (const values of rows) { const row = body.insertRow(); for (const value of values) row.insertCell().textContent = value; }
  if (!rows.length) { const cell = body.insertRow().insertCell(); cell.colSpan = headers.length; cell.textContent = 'No records'; }
  wrapper.append(element); return wrapper;
}
function showRoom(room) {
  selectedRoom = room;
  const site = activeSite, settings = activeWorkspace.settings[site], dashboard = buildRoomDashboard(toDashboardRecords(activeWorkspace.devices, site, activeWorkspace.siteAliases), settings);
  $('#preview-room').hidden = false; $('#room-title').textContent = `${settings.roomNames[room] || `Room ${room}`} · ${settings.teachers[room] || 'No teacher listed'}`;
  const devices = dashboard.roomDevices[room] || [], tags = devices.map(item => item.tag);
  const students = activeWorkspace.students.filter(row => row.room === room && row.site === site);
  const counted = new Set(activeWorkspace.inventory.filter(item => item.site === site && item.room === room).map(item => item.tag));
  const unmatched = activeWorkspace.unmatchedScans.filter(item => item.site === site && item.room === room);
  const editor = document.createElement('div');
  editor.innerHTML = '<h4>Edit classroom</h4><form class="working-inline" data-room-form><label>Room name <input name="name" maxlength="80" required></label><label>Teacher <input name="teacher" maxlength="160"></label><label>Student count <input name="students" type="number" min="0" max="10000" required></label><button type="submit">Save room</button></form><button type="button" data-delete-room>Delete room</button><h4>Add student</h4><form class="working-inline" data-student-form><label>Student ID <input name="id" required maxlength="80"></label><label>Name <input name="name" required maxlength="160"></label><label>Alt ID 2 <input name="altId2" maxlength="80"></label><button type="submit">Add student</button></form><form class="working-inline" data-name-form><label>Name only <input name="name" required maxlength="160"></label><button type="submit">Add name without ID</button></form><h4>Inventory</h4><form class="working-inline" data-scan-form><label>Scan NPS tag <input name="tag" required autocomplete="off"></label><button type="submit">Check tag</button><button type="button" data-reset-inventory>Reset count to 0</button></form><p data-room-message role="status"></p>';
  editor.querySelector('[data-room-form] [name=name]').value = settings.roomNames[room] || (/^\d+$/.test(room) ? `Room ${room}` : room);
  editor.querySelector('[data-room-form] [name=teacher]').value = settings.teachers[room] || '';
  editor.querySelector('[data-room-form] [name=students]').value = settings.students[room] ?? 0;
  editor.querySelector('[data-room-form]').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; applyEdit(workspace => editRoom(workspace, site, room, { name: form.elements.name.value, teacher: form.elements.teacher.value, students: Number(form.elements.students.value) })); };
  editor.querySelector('[data-delete-room]').onclick = () => { applyEdit(workspace => deleteRoom(workspace, site, room)); selectedRoom = null; $('#preview-room').hidden = true; };
  editor.querySelector('[data-student-form]').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; applyEdit(workspace => addStudent(workspace, site, room, { id: form.elements.id.value, name: form.elements.name.value, altId2: form.elements.altId2.value })); };
  editor.querySelector('[data-name-form]').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; applyEdit(workspace => addManualStudentName(workspace, site, room, form.elements.name.value)); };
  editor.querySelector('[data-scan-form]').onsubmit = event => { event.preventDefault(); const form = event.currentTarget, tag = form.elements.tag.value.trim(); form.reset(); applyEdit(workspace => {
    const current = buildRoomDashboard(toDashboardRecords(workspace.devices, site, workspace.siteAliases), workspace.settings[site]);
    setInventory(workspace, site, room, tag, true, (current.roomDevices[room] || []).map(item => item.tag));
  }, { latest: true }); };
  editor.querySelector('[data-reset-inventory]').onclick = () => applyEdit(workspace => resetRoomInventory(workspace, site, room), { latest: true });
  const rosterList = document.createElement('div'), rosterHeading = document.createElement('h4'); rosterHeading.textContent = 'Classroom roster'; rosterList.append(rosterHeading);
  for (const student of students) { const line = document.createElement('p'), button = document.createElement('button'); button.type = 'button'; button.textContent = 'Remove'; button.onclick = () => applyEdit(workspace => removeStudent(workspace, site, room, student.id)); line.append(document.createTextNode(`${student.name || 'Name not supplied'} · ${student.id}${student.altId2 ? ` · ${student.altId2}` : ''} `), button); rosterList.append(line); }
  if (!students.length) rosterList.append(document.createTextNode('No students listed.'));
  const removed = settings.roomRemovedStudentNames[room] || [];
  if (removed.length) { const heading = document.createElement('h4'); heading.textContent = 'Removed students'; rosterList.append(heading); for (const name of removed) { const line = document.createElement('p'), button = document.createElement('button'); button.type = 'button'; button.textContent = 'Restore'; button.onclick = () => applyEdit(workspace => restoreRemovedStudent(workspace, site, room, name)); line.append(document.createTextNode(`${name} `), button); rosterList.append(line); } }
  const manualNames = (settings.roomStudentNames[room] || []).filter(name => !students.some(student => student.name === name));
  if (manualNames.length) { const heading = document.createElement('h4'); heading.textContent = 'Names without Student ID'; rosterList.append(heading); for (const name of manualNames) { const line = document.createElement('p'), button = document.createElement('button'); button.textContent = 'Remove'; button.onclick = () => applyEdit(workspace => removeManualStudentName(workspace, site, room, name)); line.append(document.createTextNode(`${name} `), button); rosterList.append(line); } }
  const inventoryList = document.createElement('div'), inventoryHeading = document.createElement('h4'); inventoryHeading.textContent = `Cart devices checked: ${counted.size} / ${devices.length}`; inventoryList.append(inventoryHeading);
  for (const device of devices) { const line = document.createElement('p'), button = document.createElement('button'); button.type = 'button'; button.textContent = counted.has(device.tag) ? 'Checked — undo' : 'Check'; button.onclick = () => applyEdit(workspace => {
    const current = buildRoomDashboard(toDashboardRecords(workspace.devices, site, workspace.siteAliases), workspace.settings[site]);
    const currentTags = (current.roomDevices[room] || []).map(item => item.tag);
    setInventory(workspace, site, room, device.tag, !workspace.inventory.some(item => item.site === site && item.room === room && item.tag === device.tag), currentTags);
  }, { latest: true }); line.append(document.createTextNode(`${device.tag} · ${device.product} · ${device.serial} `), button); inventoryList.append(line); }
  if (unmatched.length) { const heading = document.createElement('h4'); heading.textContent = 'Scanned tags not in this room'; inventoryList.append(heading); for (const row of unmatched) { const line = document.createElement('p'), button = document.createElement('button'); button.textContent = 'Remove'; button.onclick = () => applyEdit(workspace => setInventory(workspace, site, room, row.tag, false, []), { latest: true }); line.append(document.createTextNode(`${row.tag} `), button); inventoryList.append(line); } }
  $('#room-tables').replaceChildren(editor, rosterList, inventoryList);
}
function cartCard(room) {
  const settings = activeWorkspace.settings[activeSite], card = document.createElement('article');
  card.className = `room-card preview-cart ${room.spare < 0 ? 'preview-cart--short' : room.spare > 1 ? 'preview-cart--spare' : ''}`; card.tabIndex = 0; card.setAttribute('role', 'button');
  const title = document.createElement('h3'), teacher = document.createElement('p'), ratio = document.createElement('p');
  title.className = 'cart-room-label'; title.textContent = settings.roomNames[room.room] || `Room ${room.room}`; teacher.className = 'cart-teacher-name'; teacher.textContent = settings.teachers[room.room] || 'No teacher listed'; ratio.className = 'cart-count-ratio'; ratio.textContent = `${room.students} / ${room.devices}`; ratio.title = `${room.students} students / ${room.devices} devices`;
  card.append(title, teacher, ratio); card.onclick = () => showRoom(room.room); card.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); showRoom(room.room); } }; return card;
}
async function renderPreview() {
  if (!activeWorkspace) return;
  const site = activeSite, settings = activeWorkspace.settings[site], devices = toDashboardRecords(activeWorkspace.devices, site, activeWorkspace.siteAliases), students = activeWorkspace.students.filter(row => row.site === site), dashboard = buildRoomDashboard(devices, settings);
  $('#preview-title').textContent = `${site} — imported dashboard`;
  $('#preview-metrics').replaceChildren(...[['Device records', devices.length], ['Dashboard devices', dashboard.totalDevices], ['In classrooms', dashboard.classroomDevices], ['Students', students.length]].map(([label, count]) => { const card = document.createElement('div'), text = document.createElement('span'), number = document.createElement('strong'); text.textContent = label; number.textContent = count.toLocaleString(); card.append(text, number); return card; }));
  const query = $('#preview-search').value.trim().toLowerCase();
  const matches = room => !query || [room.room, settings.teachers[room.room], ...students.filter(row => row.room === room.room).flatMap(row => [row.name, row.id, row.altId2]), ...(dashboard.roomDevices[room.room] || []).flatMap(row => [row.tag, row.serial])].some(value => String(value || '').toLowerCase().includes(query));
  const rooms = dashboard.roomsWithCarts.filter(matches), map = maps[site];
  if (map) map.render($('#preview-map'), rooms, cartCard, cartCard, !!query);
  else { $('#preview-map').classList.add('preview-grid'); $('#preview-map').replaceChildren(...rooms.map(cartCard)); }
  $('#preview-empty-rooms').replaceChildren(table(['Room', 'Teacher', 'Students'], dashboard.roomsWithoutDevices.filter(matches).map(row => [row.room, settings.teachers[row.room] || '', String(row.students)]), 'Current classroom list'));
  const details = [['Repair', dashboard.inventoryTabs.repair], ['iPads', dashboard.inventoryTabs.ipads], ['In use', dashboard.inventoryTabs.inUse], ['School spares', dashboard.detailGroups.schoolSparePool], ['Other locations', dashboard.detailGroups.unassignedDevices]];
  if ($('#device-details').closest('details').open) $('#device-details').replaceChildren(...details.map(([title, rows]) => table(['Tag', 'Product', 'Location', 'Status'], rows.map(row => [row.tag, row.product, row.location, row.status]), `${title} (${rows.length})`)));
  else $('#device-details').replaceChildren();
  const matchesDevice = row => [row['NPS Tag'], row['Serial Number'], row['Product Name'], row.Location, row.Status].some(value => String(value).toLowerCase().includes(query));
  const matchingDevices = query ? activeWorkspace.devices.filter(row => siteForId(row['Site ID'], activeWorkspace.siteAliases) === site && matchesDevice(row)).slice(0, 100) : [];
  $('#search-results').replaceChildren(...(query ? [table(['Tag', 'Product', 'Location', 'Status'], matchingDevices.map(row => [row['NPS Tag'], row['Product Name'], row.Location, row.Status]), `Matching devices${matchingDevices.length === 100 ? ' (first 100)' : ''}`)] : []));
  $('#all-rooms').replaceChildren(...settings.rooms.map(room => { const button = document.createElement('button'); button.type = 'button'; button.textContent = settings.roomNames[room] || (/^\d+$/.test(room) ? `Room ${room}` : room); button.onclick = () => showRoom(room); return button; }));
  if (settings.deletedRooms.length) { const heading = document.createElement('span'); heading.textContent = 'Deleted: '; $('#all-rooms').append(heading); for (const room of settings.deletedRooms) { const button = document.createElement('button'); button.type = 'button'; button.textContent = `Restore ${room}`; button.onclick = () => applyEdit(workspace => addRoom(workspace, site, room)); $('#all-rooms').append(button); } }
}
$('#preview-search').oninput = () => renderPreview();
$('#device-details').closest('details').addEventListener('toggle', () => renderPreview());
$('#preview-site').onchange = event => { activeSite = event.target.value; selectedRoom = null; $('#preview-search').value = ''; $('#preview-room').hidden = true; renderPreview(); };
$('#add-room-form').onsubmit = event => { event.preventDefault(); const room = $('#new-room').value.trim(); if (!room) return; applyEdit(workspace => addRoom(workspace, activeSite, room)); $('#new-room').value = ''; };
async function downloadBytes(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  workspaceStatus('Download offered; confirm the file was retained in your Downloads folder.');
}
async function serialize(workspace) { return (await runImportWorker({ action: 'serialize', workspace })).bytes; }
async function chooseWorkingCopy(incoming, current) {
  const dialog = $('#recovery-dialog');
  $('#recovery-message').textContent = `The browser holds ${current.workspace.filename} (revision ${current.workspace.revision}); the opened file is ${incoming.filename} (revision ${incoming.revision}). Choose which copy to keep active. The unchosen file is not deleted.`;
  dialog.showModal();
  return new Promise(resolve => {
    const finish = decision => { dialog.close(); resolve(decision); };
    $('#keep-browser').onclick = () => finish('browser'); $('#use-opened').onclick = () => finish('file'); $('#cancel-recovery').onclick = () => finish('cancel');
    dialog.oncancel = event => { event.preventDefault(); finish('cancel'); };
  });
}
async function openSelectedFile(file, handle = null) {
  try {
    if (!file || !/\.xlsx$/i.test(file.name) || !file.size || file.size > LIMITS.workspaceBytes) throw new Error('Choose a working XLSX file no larger than 32 MiB.');
    const bytes = await file.arrayBuffer(), hash = await digest(bytes), incoming = await runImportWorker({ action: 'read-working', bytes });
    const db = await dbReady, current = await readActive(db);
    if (current && JSON.stringify(current.workspace) !== JSON.stringify(incoming)) {
      const choice = await chooseWorkingCopy(incoming, current.workspace ? current : null);
      if (choice !== 'file') { if (choice === 'browser') activate(current, { site: activeSite }); return; }
    }
    const entry = current && JSON.stringify(current.workspace) === JSON.stringify(incoming)
      ? await markFileSaved(db, incoming.workspaceId, incoming.revision, hash)
      : await adoptWorkspace(db, incoming, current?.workspace || null, incoming.revision, hash);
    activate(entry, { site: activeSite }); fileHandle = handle; fileHash = hash;
    if (handle) try { await storeFileHandle(db, incoming.workspaceId, handle); } catch { /* Re-selection remains available if the browser cannot store handles. */ }
    channel?.postMessage({ workspaceId: incoming.workspaceId, revision: incoming.revision });
    workspaceStatus('Opened working file.');
  } catch (error) { workspaceStatus(error.message); }
}
$('#open-working').onclick = async () => {
  if (typeof window.showOpenFilePicker === 'function') {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Dashboard workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }] });
      await openSelectedFile(await handle.getFile(), handle); return;
    } catch (error) { if (error.name === 'AbortError') return; }
  }
  $('#open-working-input').click();
};
$('#open-working-input').onchange = async event => { await openSelectedFile(event.target.files[0]); event.target.value = ''; };
$('#download-working').onclick = async event => {
  event.preventDefault();
  try { const current = await readActive(await dbReady); if (current) await downloadBytes(await serialize(current.workspace), current.workspace.filename); }
  catch (error) { workspaceStatus(`Download failed: ${error.message}`); }
};
async function performFileSave({ allowPicker = true } = {}) {
    const current = await readActive(await dbReady); if (!current) throw new Error('Open a working file first.');
    const snapshot = current.workspace, bytes = await serialize(snapshot);
    if (!fileHandle && allowPicker && typeof window.showSaveFilePicker === 'function') {
      fileHandle = await window.showSaveFilePicker({ suggestedName: snapshot.filename, types: [{ description: 'Dashboard workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }] });
    }
    if (!fileHandle) { await downloadBytes(bytes, snapshot.filename); return; }
    if (typeof fileHandle.queryPermission === 'function' && await fileHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      if (typeof fileHandle.requestPermission !== 'function' || await fileHandle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('File write permission was not granted. Browser changes remain available.');
    }
    const existing = await fileHandle.getFile();
    const baselineHash = current.fileHash || fileHash;
    if (baselineHash && existing.size && await digest(await existing.arrayBuffer()) !== baselineHash) throw new Error('The selected file changed outside this app. Open it to compare copies, or download the browser copy.');
    if (!baselineHash && existing.size) {
      const other = await runImportWorker({ action: 'read-working', bytes: await existing.arrayBuffer() });
      if (JSON.stringify(other) !== JSON.stringify(snapshot)) throw new Error('That file has different contents. Choose a new filename or open it to compare copies.');
    }
    const writable = await fileHandle.createWritable(); await writable.write(bytes); await writable.close();
    const saved = await fileHandle.getFile(); fileHash = await digest(await saved.arrayBuffer());
    if (fileHash !== await digest(bytes)) throw new Error('The file could not be verified after saving. Browser changes remain available.');
    const entry = await markFileSaved(await dbReady, snapshot.workspaceId, snapshot.revision, fileHash);
    try { await storeFileHandle(await dbReady, snapshot.workspaceId, fileHandle); } catch { /* Re-selection remains available if the browser cannot store handles. */ }
    activeWorkspace = entry.workspace; savedRevision = entry.savedRevision; workspaceStatus();
    if (savedRevision >= activeWorkspace.revision) navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAN_OLD_CACHES', safeToUpdate: true });
}
$('#save-working').onclick = async () => {
  const button = $('#save-working'); button.disabled = true;
  try {
    if (navigator.locks?.request) await navigator.locks.request(`dashboard-file-save-${activeWorkspace.workspaceId}`, performFileSave);
    else await performFileSave();
  } catch (error) { if (error.name !== 'AbortError') workspaceStatus(`Save failed: ${error.message}`); }
  finally { button.disabled = false; }
};
let updateCandidate = null, pendingReview = null, updateFiles = [], updateKind = null;
const updateStatus = message => { $('#update-status').textContent = message; };
const updateDate = value => value?.fileDate ? `${dateLabel(value)} · ${value.filename}` : `${value?.filename || 'Source'} · date unknown`;
function renderUpdateReview() {
  const review = pendingReview, body = $('#update-rows'); body.replaceChildren();
  $('#update-review').hidden = !review || review.noChanges;
  $('#update-apply').disabled = !review || review.noChanges || review.items.some(row => !row.decision);
  if (!review) return;
  $('#update-date').textContent = review.summaries.map(summary => `${summary.site}: ${summary.source.map(updateDate).join('; ')}`).join(' | ');
  $('#update-summary').textContent = `${review.kind === 'csv' ? 'Device CSV' : 'Roster XLSX'} · ${review.sites.join(' and ')} · ${review.complete ? 'complete' : 'partial'} export`;
  $('#update-warnings').replaceChildren(...review.warnings.map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
  if (review.noChanges) { updateStatus('No changes. The working file has not been modified.'); return; }
  $('#update-totals').textContent = `${review.items.length} decisions · ${Object.entries(review.totals).filter(([, count]) => count).map(([name, count]) => `${count} ${name}`).join(', ')}. Moves reset checks for affected devices; unchanged devices retain checks.`;
  updateStatus('Review each proposed change. Conflicts and removals require an explicit choice.');
  for (const row of review.items) {
    const tr = body.insertRow();
    for (const value of [row.site, `${row.kind} ${row.id}`, row.field, row.current, row.incoming]) tr.insertCell().textContent = String(value);
    const cell = tr.insertCell(), select = document.createElement('select');
    const prompt = document.createElement('option'); prompt.value = ''; prompt.textContent = 'Choose action'; select.append(prompt);
    for (const action of row.options) { const option = document.createElement('option'); option.value = option.textContent = action; select.append(option); }
    select.value = row.decision || '';
    select.setAttribute('aria-label', `${row.site} ${row.kind} ${row.id} ${row.field} action`);
    select.onchange = () => { row.decision = select.value || null; $('#update-apply').disabled = review.items.some(item => !item.decision); };
    if (row.conflict) tr.classList.add('review-conflict');
    cell.append(select);
  }
}
function buildUpdateReview() {
  if (!activeWorkspace || !updateCandidate) return;
  try { pendingReview = compareImport(activeWorkspace, updateKind, updateCandidate, { complete: $('#update-complete').checked }); renderUpdateReview(); }
  catch (error) { pendingReview = null; renderUpdateReview(); updateStatus(error.message); }
}
async function parseUpdateFiles() {
  if (!updateFiles.length || !activeWorkspace) return;
  updateStatus('Reading and comparing the source file…'); $('#update-apply').disabled = true;
  try {
    const parsed = [];
    for (const file of updateFiles) {
      if (!file.size || file.size > (updateKind === 'csv' ? LIMITS.csvBytes : LIMITS.rosterBytes)) throw new Error('Choose a nonempty source file no larger than 10 MiB.');
      if (!(updateKind === 'csv' ? /\.csv$/i : /\.xlsx$/i).test(file.name)) throw new Error('Choose a file with the correct extension.');
      parsed.push(await runImportWorker({ action: updateKind, bytes: await file.arrayBuffer(), filename: file.name, modified: file.lastModified, friendlyNames: { ...activeWorkspace.friendlyNames, ...friendlyNames }, siteAliases: activeWorkspace.siteAliases }));
    }
    if (updateKind === 'roster' && parsed.length !== 1) throw new Error('Choose one roster at a time.');
    updateCandidate = updateKind === 'csv' ? combineTagImports(parsed) : parsed[0];
    const missing = updateCandidate.missingFriendlyNames || [];
    $('#update-names').hidden = !missing.length;
    $('#update-name-fields').replaceChildren(...missing.map((row, index) => { const label = document.createElement('label'), input = document.createElement('input'); label.textContent = `${row.type}: ${row.product} (${row.count})`; input.type = 'text'; input.maxLength = 100; input.dataset.productKey = row.key; input.id = `updated-friendly-${index}`; label.htmlFor = input.id; label.append(input); return label; }));
    if (missing.length) { pendingReview = null; renderUpdateReview(); updateStatus('Enter a friendly name for each new product before comparing.'); }
    else buildUpdateReview();
  } catch (error) { updateCandidate = pendingReview = null; renderUpdateReview(); updateStatus(error.message); }
}
function cancelUpdate() { updateCandidate = pendingReview = null; updateFiles = []; $('#update-csv-input').value = $('#update-roster-input').value = ''; $('#update-dialog').close(); }
$('#update-csv').onclick = () => $('#update-csv-input').click();
$('#update-roster').onclick = () => $('#update-roster-input').click();
for (const kind of ['csv', 'roster']) $(`#update-${kind}-input`).onchange = event => {
  updateKind = kind; updateFiles = [...event.target.files]; if (!updateFiles.length) return;
  $('#update-complete').checked = false; $('#update-names').hidden = true; $('#update-review').hidden = true;
  $('#update-date').textContent = ''; $('#update-summary').textContent = '';
  $('#update-dialog').showModal(); parseUpdateFiles();
};
$('#update-complete').onchange = buildUpdateReview;
$('#update-apply-names').onclick = () => {
  const names = {};
  for (const input of $('#update-name-fields').querySelectorAll('input')) {
    const value = input.value.trim();
    if (!value || /[\r\n\x00]/.test(value)) { updateStatus('Enter a friendly name for every product.'); input.focus(); return; }
    names[input.dataset.productKey] = value;
  }
  friendlyNames = { ...friendlyNames, ...names }; parseUpdateFiles();
};
$('#update-accept-clear').onclick = () => {
  if (!pendingReview) return;
  for (const row of pendingReview.items) if (!row.conflict && row.category !== 'removal') row.decision = row.category === 'addition' ? 'Add' : 'Use incoming';
  renderUpdateReview();
};
$('#update-cancel').onclick = cancelUpdate;
$('#update-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelUpdate(); });
$('#update-apply').onclick = async () => {
  const review = pendingReview; if (!review || review.noChanges || review.items.some(row => !row.decision)) return;
  $('#update-apply').disabled = true; updateStatus('Applying the reviewed changes…');
  try {
    const current = await readActive(await dbReady);
    if (!current || current.workspace.workspaceId !== review.baseWorkspaceId || current.workspace.revision !== review.baseRevision) {
      if (current) activate(current, { site: activeSite }); buildUpdateReview(); throw new Error('The working file changed during review. The comparison was refreshed; review it again.');
    }
    const entry = await commitEdit(await dbReady, review.baseWorkspaceId, review.baseRevision, workspace => {
      applyImportReview(workspace, review);
      if (review.kind === 'csv') workspace.friendlyNames = { ...workspace.friendlyNames, ...friendlyNames };
    });
    activate(entry, { site: activeSite }); channel?.postMessage({ workspaceId: entry.workspace.workspaceId, revision: entry.workspace.revision });
    cancelUpdate(); workspaceStatus('Reviewed import applied. Save the working file.');
    try { await performFileSave({ allowPicker: false }); } catch (error) { workspaceStatus(`Import saved in browser; file save needs attention: ${error.message}`); }
  } catch (error) { updateStatus(error.message); if (pendingReview) $('#update-apply').disabled = pendingReview.items.some(row => !row.decision); }
};
dbReady.then(async db => { const entry = await readActive(db); if (entry) { activate(entry); const savedHandle = await readFileHandle(db); if (savedHandle?.workspaceId === entry.workspace.workspaceId) fileHandle = savedHandle.handle; } }).catch(error => workspaceStatus(`Browser storage is unavailable: ${error.message}`));
channel?.addEventListener('message', async () => {
  const entry = await readActive(await dbReady);
  if (entry && (!activeWorkspace || entry.workspace.workspaceId !== activeWorkspace.workspaceId || entry.workspace.revision > activeWorkspace.revision)) {
    activate(entry, { site: activeSite }); workspaceStatus('Updated from another tab.');
  }
});
Promise.all([loadWillardRoomMap(), loadLakewoodRoomMaps()]).then(([willard, lakewood]) => { maps = { 'Willard Elementary': willard, 'Lakewood Academy': lakewood }; renderPreview(); });
async function prepareOffline() {
  const indicator = $('#offline-status');
  if (!('serviceWorker' in navigator) || !('caches' in window) || !window.isSecureContext) { indicator.textContent = 'Offline setup needs a secure web address.'; return; }
  try {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'OFFLINE_STATUS') indicator.textContent = event.data.ready ? 'Ready for offline use' : `Offline setup incomplete (${event.data.count}/${event.data.expected} files)`;
    });
    const check = () => navigator.serviceWorker.controller?.postMessage({ type: 'CHECK_OFFLINE' });
    navigator.serviceWorker.addEventListener('controllerchange', check);
    await navigator.serviceWorker.register('./service-worker.js');
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) check();
    else indicator.textContent = 'Offline files cached; reload once to activate.';
  } catch (error) { indicator.textContent = `Offline setup failed: ${error.message}`; }
}
prepareOffline();
