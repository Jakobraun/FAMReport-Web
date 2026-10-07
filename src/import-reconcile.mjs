import { DEVICE_FIELDS, siteForId } from './source-import.mjs';

const same = (a, b) => String(a ?? '') === String(b ?? '');
const key = (site, id) => JSON.stringify([site, id]);
const roomOrder = (a, b) => a.localeCompare(b, 'en', { numeric: true });
const studentRows = rooms => Object.entries(rooms).flatMap(([room, data]) => (data.studentRecords || []).map(row => ({ room, ...row })));
const byId = (rows, getId) => new Map(rows.map(row => [getId(row), row]));
const currentDate = source => source?.fileDate ? Date.parse(source.fileDate) : NaN;

function item(site, kind, id, field, baseline, current, incoming, { removal = false, addition = false } = {}) {
  const conflict = !addition && !same(current, baseline) && !same(current, incoming);
  return { key: JSON.stringify([site, kind, id, field]), site, kind, id, field, baseline: baseline ?? '', current: current ?? '', incoming: incoming ?? '', category: removal ? 'removal' : addition ? 'addition' : field === 'room' || field === 'Location' ? 'move' : conflict ? 'conflict' : 'source change', conflict,
    options: removal ? ['Keep', 'Remove'] : addition ? ['Add', 'Skip'] : ['Keep current', 'Use incoming'], decision: null };
}
function fieldChanges(items, site, kind, id, before, current, incoming, fields) {
  for (const field of fields) {
    if (same(before?.[field], incoming?.[field])) continue;
    if (same(current?.[field], incoming?.[field])) continue;
    items.push(item(site, kind, id, field, before?.[field], current?.[field], incoming?.[field]));
  }
}
function sourceWarnings(workspace, site, type, source) {
  const previous = type === 'csv' ? workspace.sources[site].csv : [workspace.sources[site].roster];
  const newest = Math.max(...previous.map(currentDate).filter(Number.isFinite), -Infinity);
  const incoming = currentDate(source);
  return !Number.isFinite(incoming) ? [`${site}: source date is unknown.`] : incoming < newest ? [`${site}: source date is older than the last accepted ${type} export.`] : [];
}
function roomCurrent(workspace, site, room) {
  const state = workspace.settings[site];
  return [...state.rooms, ...state.archivedRooms, ...state.deletedRooms].includes(room)
    ? { teacher: state.teachers[room] || '', students: state.students[room] ?? 0 } : null;
}
export function compareImport(workspace, kind, parsed, { complete = false } = {}) {
  if (!['csv', 'roster'].includes(kind)) throw new Error('Choose a CSV or roster update.');
  const imports = kind === 'csv' ? (parsed.sourceEntries ? parsed : { ...parsed, sourceEntries: [{ sites: parsed.sites, source: parsed.source, filtering: parsed.filtering }] }) : parsed;
  const sites = kind === 'csv' ? imports.sites : [imports.site];
  if (!sites.length || sites.some(site => !workspace.sites.includes(site))) throw new Error('The update contains a school not in this working file.');
  if (kind === 'csv' && imports.missingFriendlyNames?.length) throw new Error('Name the missing products before reviewing this update.');
  const items = [], warnings = [...(imports.warnings || [])], summaries = [];
  for (const site of sites) {
    const source = kind === 'csv' ? imports.sourceEntries.filter(entry => entry.sites.includes(site)).map(entry => entry.source) : [imports.source];
    warnings.push(...source.flatMap(value => sourceWarnings(workspace, site, kind, value)));
    if (kind === 'csv') {
      const baseline = byId(workspace.baselines[site].devices, row => row['NPS Tag']);
      const current = byId(workspace.devices.filter(row => siteForId(row['Site ID'], workspace.siteAliases) === site), row => row['NPS Tag']);
      const incoming = byId(imports.records.filter(row => siteForId(row['Site ID'], workspace.siteAliases) === site), row => row['NPS Tag']);
      for (const [id, row] of incoming) {
        const old = baseline.get(id), now = current.get(id);
        if (!old) { if (!now) items.push(item(site, 'device', id, 'record', '', '', JSON.stringify(row), { addition: true })); else fieldChanges(items, site, 'device', id, {}, now, row, DEVICE_FIELDS); }
        else if (!now) { if (!DEVICE_FIELDS.every(field => same(old[field], row[field]))) items.push(item(site, 'device', id, 'record', JSON.stringify(old), '', JSON.stringify(row), { addition: true })); }
        else fieldChanges(items, site, 'device', id, old, now, row, DEVICE_FIELDS);
      }
      if (complete) for (const [id, old] of baseline) if (!incoming.has(id) && current.has(id)) items.push(item(site, 'device', id, 'record', JSON.stringify(old), JSON.stringify(current.get(id)), '', { removal: true }));
      summaries.push({ site, source, incoming: incoming.size, complete });
    } else {
      const baselineRooms = workspace.baselines[site].roster, incomingRooms = imports.rooms;
      for (const [room, value] of Object.entries(incomingRooms)) {
        const old = baselineRooms[room], now = roomCurrent(workspace, site, room);
        if (!old && !now) items.push(item(site, 'room', room, 'record', '', '', JSON.stringify({ teacher: value.teacher, students: value.students }), { addition: true }));
        else if (old && now) fieldChanges(items, site, 'room', room, { teacher: old.teacher, students: old.students }, now, value, ['teacher', 'students']);
      }
      if (complete) for (const [room, old] of Object.entries(baselineRooms)) if (!incomingRooms[room] && roomCurrent(workspace, site, room)) items.push(item(site, 'room', room, 'record', JSON.stringify({ teacher: old.teacher, students: old.students }), JSON.stringify(roomCurrent(workspace, site, room)), '', { removal: true }));
      const baseline = byId(studentRows(baselineRooms), row => row.id), current = byId(workspace.students.filter(row => row.site === site), row => row.id), incoming = byId(studentRows(incomingRooms), row => row.id);
      for (const [id, row] of incoming) {
        const old = baseline.get(id), now = current.get(id);
        const removed = (workspace.settings[site].removedStudentRecords?.[row.room] || []).some(saved => saved.id === id);
        if (!old) { if (!now && !removed) items.push(item(site, 'student', id, 'record', '', '', JSON.stringify(row), { addition: true })); else if (now) fieldChanges(items, site, 'student', id, {}, now, row, ['room', 'name', 'altId2']); }
        else if (!now) { if (!removed && !['room', 'name', 'altId2'].every(field => same(old[field], row[field]))) items.push(item(site, 'student', id, 'record', JSON.stringify(old), '', JSON.stringify(row), { addition: true })); }
        else fieldChanges(items, site, 'student', id, old, now, row, ['room', 'name', 'altId2']);
      }
      if (complete) for (const [id, old] of baseline) if (!incoming.has(id) && current.has(id)) items.push(item(site, 'student', id, 'record', JSON.stringify(old), JSON.stringify(current.get(id)), '', { removal: true }));
      summaries.push({ site, source, incoming: incoming.size, complete });
    }
  }
  if (!complete) warnings.push('Partial import: records absent from this file will be retained.');
  const totals = Object.fromEntries(['addition', 'source change', 'move', 'conflict', 'removal'].map(category => [category, items.filter(row => row.category === category).length]));
  return { kind, parsed: imports, complete, sites, summaries, warnings, items, totals, baseWorkspaceId: workspace.workspaceId, baseRevision: workspace.revision, noChanges: items.length === 0 };
}

function replaceRoomState(settings, room, incoming) {
  if (![...settings.rooms, ...settings.archivedRooms, ...settings.deletedRooms].includes(room)) settings.rooms.push(room);
  settings.archivedRooms = settings.archivedRooms.filter(value => value !== room);
  settings.deletedRooms = settings.deletedRooms.filter(value => value !== room);
  settings.teachers[room] = incoming.teacher;
  settings.students[room] = incoming.students;
  delete settings.teacherOverrides[room]; delete settings.studentOverrides[room];
}
function removeRoom(settings, room) {
  settings.rooms = settings.rooms.filter(value => value !== room);
  if (!settings.archivedRooms.includes(room) && !settings.deletedRooms.includes(room)) settings.archivedRooms.push(room);
}
export function applyImportReview(workspace, review) {
  if (workspace.workspaceId !== review.baseWorkspaceId || workspace.revision !== review.baseRevision) throw new Error('The working file changed during review. Compare the update again.');
  if (review.items.some(row => !row.options.includes(row.decision))) throw new Error('Choose an action for every proposed change.');
  const { kind, parsed, complete, sites } = review;
  for (const row of review.items) {
    if (['Keep', 'Keep current', 'Skip'].includes(row.decision)) continue;
    const site = row.site;
    if (kind === 'csv') {
      const incoming = parsed.records.find(value => value['NPS Tag'] === row.id && siteForId(value['Site ID'], workspace.siteAliases) === site);
      const index = workspace.devices.findIndex(value => value['NPS Tag'] === row.id && siteForId(value['Site ID'], workspace.siteAliases) === site);
      const existing = workspace.devices[index];
      const oldRoom = existing?.Location?.match(/^Room:\s*(.*)$/i)?.[1]?.trim() || '';
      if (row.decision === 'Remove') { if (index >= 0) workspace.devices.splice(index, 1); workspace.inventory = workspace.inventory.filter(value => !(value.site === site && value.tag === row.id)); continue; }
      if (row.field === 'record') { if (index >= 0) workspace.devices[index] = structuredClone(incoming); else workspace.devices.push(structuredClone(incoming)); }
      else existing[row.field] = incoming[row.field];
      if (row.field === 'Location' || row.field === 'record') {
        const newRoom = incoming?.Location?.match(/^Room:\s*(.*)$/i)?.[1]?.trim() || '';
        if (oldRoom !== newRoom) workspace.inventory = workspace.inventory.filter(value => !(value.site === site && value.tag === row.id));
      }
    } else {
      const settings = workspace.settings[site], incomingRoom = parsed.rooms[row.id];
      if (row.kind === 'room') {
        if (row.decision === 'Remove') { removeRoom(settings, row.id); continue; }
        if (row.field === 'record') replaceRoomState(settings, row.id, incomingRoom);
        else { settings[row.field === 'teacher' ? 'teachers' : 'students'][row.id] = incomingRoom[row.field]; delete settings[row.field === 'teacher' ? 'teacherOverrides' : 'studentOverrides'][row.id]; }
      } else {
        const incoming = studentRows(parsed.rooms).find(value => value.id === row.id);
        const index = workspace.students.findIndex(value => value.site === site && value.id === row.id);
        if (row.decision === 'Remove') { if (index >= 0) workspace.students.splice(index, 1); continue; }
        if (row.field === 'record') { if (index >= 0) workspace.students[index] = { site, ...incoming }; else workspace.students.push({ site, ...incoming }); }
        else workspace.students[index][row.field] = incoming[row.field];
        if (!settings.rooms.includes(incoming.room) && !settings.archivedRooms.includes(incoming.room) && !settings.deletedRooms.includes(incoming.room)) {
          settings.archivedRooms.push(incoming.room); settings.teachers[incoming.room] = parsed.rooms[incoming.room].teacher; settings.students[incoming.room] = parsed.rooms[incoming.room].students;
        }
      }
    }
  }
  for (const site of sites) {
    if (kind === 'csv') {
      const incoming = parsed.records.filter(value => siteForId(value['Site ID'], workspace.siteAliases) === site);
      const old = workspace.baselines[site].devices;
      workspace.baselines[site].devices = complete ? structuredClone(incoming) : [...old.filter(value => !incoming.some(row => row['NPS Tag'] === value['NPS Tag'])), ...structuredClone(incoming)];
      workspace.sources[site].csv = parsed.sourceEntries.filter(entry => entry.sites.includes(site)).map(entry => ({ ...structuredClone(entry.source), filtering: structuredClone(entry.filtering) }));
    } else {
      const previousRooms = workspace.baselines[site].roster;
      workspace.baselines[site].roster = complete ? structuredClone(parsed.rooms) : { ...workspace.baselines[site].roster, ...structuredClone(parsed.rooms) };
      workspace.sources[site].roster = structuredClone(parsed.source);
      workspace.settings[site].roster = { site, filename: parsed.source.filename, fileDate: parsed.source.fileDate, importedAt: new Date().toISOString(), rowCount: parsed.rowCount, studentCount: parsed.studentCount, duplicateRows: parsed.duplicateRows, rooms: structuredClone(parsed.rooms) };
      const settings = workspace.settings[site];
      for (const room of [...settings.rooms, ...settings.archivedRooms, ...settings.deletedRooms]) {
        const names = workspace.students.filter(value => value.site === site && value.room === room).map(value => value.name).filter(Boolean);
        const prior = settings.roomStudentNames[room] || [];
        const baselineNames = Object.values(previousRooms).flatMap(value => value.studentNames || []);
        const manual = prior.filter(value => !baselineNames.includes(value) && !names.includes(value));
        if (prior.length) settings.roomStudentNames[room] = [...new Set([...names, ...manual])];
      }
    }
  }
  return workspace;
}
