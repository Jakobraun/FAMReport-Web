import { DEVICE_FIELDS, SITE_ROOMS, SITES, combineTagImports, siteForId } from './source-import.mjs';

export const WORKBOOK_FORMAT = 'chromebook-dashboard-workbook';
export const WORKBOOK_VERSION = 2;
export const SHEETS = ['Devices', 'Students', 'Rooms', 'Inventory', 'Unmatched Scans', 'App State'];
export const HEADERS = {
  Devices: DEVICE_FIELDS,
  Students: ['School', 'Room', 'Student ID', 'Alt ID 2', 'Name'],
  Rooms: ['School', 'Room', 'Layout', 'Room name', 'Teacher', 'Students', 'Teacher override', 'Student override', 'Student names', 'Removed student names'],
  Inventory: ['School', 'Room', 'Tag', 'Checked at', 'Cycle'],
  'Unmatched Scans': ['School', 'Room', 'Tag', 'Scanned at', 'Cycle'],
  'App State': ['Key', 'Value'],
};
const roomFields = ['rooms', 'archivedRooms', 'deletedRooms', 'roomNames', 'teachers', 'students', 'teacherOverrides', 'studentOverrides', 'roomStudentNames', 'roomRemovedStudentNames'];
const compare = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const uuid = () => globalThis.crypto.randomUUID();
const own = (object, key) => Object.hasOwn(object, key);
function assert(condition, message) { if (!condition) throw new Error(message); }
export function workingFilename(date = new Date()) {
  const pad = n => String(n).padStart(2, '0'), offset = -date.getTimezoneOffset();
  return `ChromebookDashboard_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}.xlsx`;
}
export function createWorkspace(csv, roster, { now = new Date(), workspaceId = uuid(), inventoryCycleId = uuid() } = {}) {
  const combined = csv.sourceEntries ? csv : combineTagImports(Array.isArray(csv) ? csv : [csv]), rosters = Array.isArray(roster) ? roster : [roster];
  assert(!combined.missingFriendlyNames.length, 'Supply the missing friendly product names before creating the workbook.');
  const rosterSites = rosters.map(value => value.site);
  assert(new Set(rosterSites).size === rosterSites.length, 'Choose one current roster per school. Duplicate-school rosters require reconciliation.');
  assert(JSON.stringify(SITES.filter(site => rosterSites.includes(site))) === JSON.stringify(combined.sites), 'The CSV and roster imports must cover the same schools. Add the missing school export or roster.');
  const workspace = { format: WORKBOOK_FORMAT, version: WORKBOOK_VERSION, workspaceId, filename: workingFilename(now), createdAt: now.toISOString(), updatedAt: now.toISOString(), revision: 1, inventoryCycleId, sites: combined.sites, devices: structuredClone(combined.records), students: [], settings: {}, inventory: [], unmatchedScans: [], preferences: {}, sources: {}, baselines: {}, warnings: [...combined.warnings], friendlyNames: { ...combined.friendlyNames }, siteAliases: { ...combined.siteAliases } };
  for (const imported of rosters) {
    const site = imported.site, rooms = Object.keys(imported.rooms).sort(compare);
    const metadata = { site, filename: imported.source.filename, fileDate: imported.source.fileDate, importedAt: now.toISOString(), rowCount: imported.rowCount, studentCount: imported.studentCount, duplicateRows: imported.duplicateRows, rooms: structuredClone(imported.rooms) };
    workspace.settings[site] = { site, rooms, archivedRooms: SITE_ROOMS[site].filter(room => !rooms.includes(room)), deletedRooms: [], teachers: Object.fromEntries(rooms.map(room => [room, imported.rooms[room].teacher])), students: Object.fromEntries(rooms.map(room => [room, imported.rooms[room].students])), teacherOverrides: {}, studentOverrides: {}, roomNames: {}, roomStudentNames: {}, roomRemovedStudentNames: {}, roster: metadata };
    workspace.students.push(...rooms.flatMap(room => imported.rooms[room].studentRecords.map(student => ({ site, room, ...student }))));
    workspace.sources[site] = { csv: combined.sourceEntries.filter(entry => entry.sites.includes(site)).map(entry => ({ ...structuredClone(entry.source), filtering: structuredClone(entry.filtering) })), roster: structuredClone(imported.source) };
    workspace.baselines[site] = { devices: structuredClone(combined.records.filter(row => siteForId(row['Site ID'], combined.siteAliases) === site)), roster: structuredClone(imported.rooms) };
    workspace.warnings.push(...imported.warnings);
  }
  validateWorkspace(workspace); return workspace;
}
export function validateWorkspace(value) {
  assert(value?.format === WORKBOOK_FORMAT && value.version === WORKBOOK_VERSION, 'This is not a supported dashboard working workbook.');
  assert(typeof value.workspaceId === 'string' && value.workspaceId && typeof value.inventoryCycleId === 'string' && value.inventoryCycleId, 'The working file is missing its identifiers.');
  assert(typeof value.filename === 'string' && /^ChromebookDashboard_[\w+.-]+\.xlsx$/.test(value.filename), 'The working filename is invalid.');
  assert(Number.isSafeInteger(value.revision) && value.revision > 0 && [value.createdAt, value.updatedAt].every(date => typeof date === 'string' && !Number.isNaN(Date.parse(date))), 'The working revision or timestamps are invalid.');
  assert(Array.isArray(value.sites) && value.sites.length && new Set(value.sites).size === value.sites.length && value.sites.every(site => SITES.includes(site)), 'The workbook has invalid schools.');
  for (const name of ['devices', 'students', 'inventory', 'unmatchedScans', 'warnings']) assert(Array.isArray(value[name]), `Missing working collection: ${name}.`);
  for (const name of ['settings', 'preferences', 'sources', 'baselines', 'friendlyNames', 'siteAliases']) assert(value[name] && typeof value[name] === 'object' && !Array.isArray(value[name]), `Missing working state: ${name}.`);
  const tags = new Set(), ids = new Set();
  for (const row of value.devices) {
    assert(Object.keys(row).length === DEVICE_FIELDS.length && DEVICE_FIELDS.every(key => typeof row[key] === 'string') && value.sites.includes(siteForId(row['Site ID'], value.siteAliases)) && row['NPS Tag'], 'Invalid working device.');
    const key = JSON.stringify([siteForId(row['Site ID'], value.siteAliases), row['NPS Tag']]); assert(!tags.has(key), 'Duplicate device in the working file.'); tags.add(key);
  }
  for (const row of value.students) {
    assert(value.sites.includes(row.site) && ['room', 'id', 'altId2', 'name'].every(key => typeof row[key] === 'string') && row.id, 'Invalid working student.');
    const key = JSON.stringify([row.site, row.id]); assert(!ids.has(key), 'Duplicate student in the working file.'); ids.add(key);
  }
  for (const site of value.sites) {
    const settings = value.settings[site]; assert(settings?.site === site, 'Working school settings are missing.');
    for (const key of roomFields) assert(settings[key] && typeof settings[key] === 'object' && (['rooms', 'archivedRooms', 'deletedRooms'].includes(key) ? Array.isArray(settings[key]) : !Array.isArray(settings[key])), `Missing or invalid room state: ${key}.`);
    const rooms = [...settings.rooms, ...settings.archivedRooms, ...settings.deletedRooms];
    assert(rooms.every(room => typeof room === 'string' && room) && new Set(rooms).size === rooms.length, 'Invalid or repeated working room.');
    for (const room of rooms) {
      assert(Number.isSafeInteger(settings.students[room] ?? 0) && (settings.students[room] ?? 0) >= 0, 'Invalid student count.');
      for (const key of ['roomStudentNames', 'roomRemovedStudentNames']) if (own(settings[key], room)) assert(Array.isArray(settings[key][room]) && settings[key][room].every(name => typeof name === 'string'), 'Invalid student name list.');
    }
    assert(value.students.filter(row => row.site === site).every(row => rooms.includes(row.room)), 'A student refers to a missing classroom.');
    assert(value.sources[site]?.csv && value.sources[site]?.roster && value.baselines[site]?.devices && value.baselines[site]?.roster, 'The workbook is missing source comparison information.');
  }
  for (const [name, rows] of [['inventory', value.inventory], ['unmatchedScans', value.unmatchedScans]]) {
    const seen = new Set();
    for (const row of rows) {
      assert(value.sites.includes(row.site) && ['room', 'tag', 'at', 'cycle'].every(key => typeof row[key] === 'string') && row.tag && row.cycle === value.inventoryCycleId, 'Invalid inventory record.');
      assert([...value.settings[row.site].rooms, ...value.settings[row.site].archivedRooms, ...value.settings[row.site].deletedRooms].includes(row.room), 'Inventory refers to a missing classroom.');
      if (name === 'inventory') assert(tags.has(JSON.stringify([row.site, row.tag])), 'Inventory refers to a missing device.');
      const key = JSON.stringify([row.site, row.room, row.tag]); assert(!seen.has(key), 'Repeated inventory record.'); seen.add(key);
    }
  }
  return value;
}
export function workspaceToTables(workspace) {
  validateWorkspace(workspace);
  const tables = Object.fromEntries(SHEETS.map(name => [name, [HEADERS[name]]]));
  for (const device of workspace.devices) tables.Devices.push(DEVICE_FIELDS.map(key => device[key]));
  for (const student of workspace.students) tables.Students.push([student.site, student.room, student.id, student.altId2, student.name]);
  const state = structuredClone(workspace); for (const key of ['devices', 'students', 'inventory', 'unmatchedScans']) delete state[key];
  for (const site of workspace.sites) {
    const settings = workspace.settings[site];
    state.settings[site] = Object.fromEntries(Object.entries(settings).filter(([key]) => !roomFields.includes(key)));
    for (const [layout, rooms] of [['active', settings.rooms], ['archived', settings.archivedRooms], ['deleted', settings.deletedRooms]]) for (const room of rooms) {
      const names = key => own(settings[key], room) ? JSON.stringify(settings[key][room]) : '';
      tables.Rooms.push([site, room, layout, settings.roomNames[room] || '', settings.teachers[room] || '', settings.students[room] ?? '', settings.teacherOverrides[room] ? 'true' : '', settings.studentOverrides[room] ? 'true' : '', names('roomStudentNames'), names('roomRemovedStudentNames')]);
    }
  }
  for (const [sheet, key] of [['Inventory', 'inventory'], ['Unmatched Scans', 'unmatchedScans']]) for (const row of workspace[key]) tables[sheet].push([row.site, row.room, row.tag, row.at, row.cycle]);
  const json = JSON.stringify(state);
  tables['App State'].push(['format', WORKBOOK_FORMAT], ['version', String(WORKBOOK_VERSION)], ['chunks', String(Math.ceil(json.length / 30000))]);
  for (let i = 0; i < json.length; i += 30000) tables['App State'].push([`state.${String(i / 30000).padStart(6, '0')}`, json.slice(i, i + 30000)]);
  return tables;
}
export function tablesToWorkspace(tables) {
  assert(Object.keys(tables).length === SHEETS.length && SHEETS.every(name => Array.isArray(tables[name]) && JSON.stringify(tables[name][0]) === JSON.stringify(HEADERS[name])), 'The working workbook sheets or columns do not match the supported schema.');
  const entries = tables['App State'].slice(1), map = new Map(entries);
  assert(entries.every(row => row.length === 2) && map.size === entries.length && map.get('format') === WORKBOOK_FORMAT && map.get('version') === String(WORKBOOK_VERSION), 'The working-file schema marker is missing or unsupported.');
  const chunks = Number(map.get('chunks')); assert(Number.isSafeInteger(chunks) && chunks > 0 && chunks <= 5000 && map.size === chunks + 3, 'Invalid working metadata chunks.');
  let json = ''; for (let i = 0; i < chunks; i++) { const part = map.get(`state.${String(i).padStart(6, '0')}`); assert(typeof part === 'string', 'Missing working metadata chunk.'); json += part; }
  const workspace = JSON.parse(json);
  workspace.devices = tables.Devices.slice(1).map(row => { assert(row.length === DEVICE_FIELDS.length, 'Invalid device columns.'); return Object.fromEntries(DEVICE_FIELDS.map((key, i) => [key, String(row[i] ?? '')])); });
  workspace.students = tables.Students.slice(1).map(row => { assert(row.length === 5, 'Invalid student columns.'); return Object.fromEntries(['site', 'room', 'id', 'altId2', 'name'].map((key, i) => [key, String(row[i] ?? '')])); });
  for (const site of workspace.sites || []) for (const key of roomFields) workspace.settings[site][key] = ['rooms', 'archivedRooms', 'deletedRooms'].includes(key) ? [] : {};
  for (const row of tables.Rooms.slice(1)) {
    assert(row.length === 10, 'Invalid room columns.'); const [site, room, layout, name, teacher, count, teacherOverride, studentOverride, names, removed] = row, settings = workspace.settings[site];
    assert(own(workspace.settings, site) && settings && ['active', 'archived', 'deleted'].includes(layout) && !['__proto__', 'prototype', 'constructor'].includes(room), 'Invalid working room layout.');
    settings[{ active: 'rooms', archived: 'archivedRooms', deleted: 'deletedRooms' }[layout]].push(room);
    if (name) settings.roomNames[room] = name; if (teacher) settings.teachers[room] = teacher;
    if (count !== '') settings.students[room] = Number(count);
    for (const [value, key] of [[teacherOverride, 'teacherOverrides'], [studentOverride, 'studentOverrides']]) { assert(['', 'true'].includes(value), 'Invalid override flag.'); if (value) settings[key][room] = true; }
    if (names !== '') settings.roomStudentNames[room] = JSON.parse(names); if (removed !== '') settings.roomRemovedStudentNames[room] = JSON.parse(removed);
  }
  for (const [sheet, key] of [['Inventory', 'inventory'], ['Unmatched Scans', 'unmatchedScans']]) workspace[key] = tables[sheet].slice(1).map(row => { assert(row.length === 5, 'Invalid inventory columns.'); return Object.fromEntries(['site', 'room', 'tag', 'at', 'cycle'].map((key, i) => [key, String(row[i] ?? '')])); });
  return validateWorkspace(workspace);
}
