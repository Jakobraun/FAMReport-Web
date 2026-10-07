import { formatTeacherName, normalizePersonName } from './person-names.mjs';
import { friendlyProductName, productKey } from './friendly-products.mjs';

export const SITES = ['Willard Elementary', 'Lakewood Academy'];
export const SITE_ROOMS = {
  'Willard Elementary': Array.from({ length: 45 }, (_, i) => String(i + 1)),
  'Lakewood Academy': [[101, 113], [201, 231], [301, 316]].flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i))),
};
export const LIMITS = Object.freeze({ csvBytes: 10 * 1024 * 1024, rosterBytes: 10 * 1024 * 1024, expandedBytes: 50 * 1024 * 1024, workspaceBytes: 32 * 1024 * 1024, workspaceExpandedBytes: 100 * 1024 * 1024, rows: 100000, columns: 128, cells: 1000000, zipEntries: 512, timeoutMs: 60000 });
export const SITE_IDS = Object.freeze({ '015': 'Willard Elementary', '152': 'Willard Elementary', '172': 'Lakewood Academy' });
export const DEVICE_FIELDS = ['Site ID', 'Product Type', 'Product Name', 'NPS Tag', 'Serial Number', 'Last Login Date', 'Last Login User', 'Location', 'Status'];
const PRODUCT_TYPES = new Map(['Chromebook', 'Desktop', 'iPad', 'iMac', 'Laptop'].map(value => [value.toLowerCase(), value]));
const STATUSES = new Map(['Available', 'In Use', 'In Repair', 'Lost'].map(value => [value.toLowerCase(), value]));
export function plainExportText(value) { return String(value ?? '').trim().replace(/^="([^"\r\n]*)"$/, '$1'); }
export function siteForId(value, aliases = {}) { return SITE_IDS[plainExportText(value)] || aliases[plainExportText(value)] || null; }
const header = value => String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase();
const compare = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
export function detectSite(value) {
  const matches = SITES.filter(site => new RegExp(`\\b${site.split(' ')[0]}\\b`, 'i').test(String(value)));
  if (matches.length !== 1) throw new Error('A row has an unknown or ambiguous school. Use a Willard or Lakewood export.');
  return matches[0];
}
export function sourceInfo(filename, modified, fingerprint = '') {
  const match = String(filename).match(/(20\d{2})[-_](\d{2})[-_](\d{2})/) || String(filename).match(/(\d{1,2})[-_](\d{1,2})[-_](\d{2,4})/);
  let date = null;
  if (match) {
    const parts = match[1].length === 4 ? [match[1], match[2], match[3]] : [match[3].length === 2 ? `20${match[3]}` : match[3], match[1], match[2]];
    const candidate = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    const parsed = new Date(`${candidate}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) throw new Error('The source filename contains an invalid date.');
    date = candidate;
  }
  const modifiedAt = modified ? new Date(modified) : null;
  if (modifiedAt && Number.isNaN(modifiedAt.getTime())) throw new Error('The file modification date is invalid.');
  return { filename: String(filename), fileDate: date || modifiedAt?.toISOString() || null, dateBasis: date ? 'filename' : modifiedAt ? 'file modification' : 'unknown', sha256: fingerprint };
}
export function parseCsvRows(text) {
  const rows = []; let row = [], field = '', quoted = false, closed = false, cells = 0;
  const cell = () => { row.push(field); field = ''; closed = false; if (row.length > LIMITS.columns || ++cells > LIMITS.cells) throw new Error('The CSV contains too many columns or cells.'); };
  const line = () => { cell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > LIMITS.rows + 1) throw new Error('The CSV contains too many rows.'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') { quoted = false; closed = true; } else field += c; }
    else if (c === ',' ) cell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; line(); }
    else if (c === '"') { if (field || closed) throw new Error('The CSV contains an unexpected quotation mark.'); quoted = true; }
    else { if (closed) throw new Error('The CSV contains text after a closing quotation mark.'); field += c; }
  }
  if (quoted) throw new Error('The CSV contains an unfinished quoted field.');
  if (field || row.length || closed) line();
  return rows;
}
function headerMap(row) {
  const map = new Map(); row.forEach((value, i) => { const key = header(value); if (!key) return; if (map.has(key)) throw new Error(`Duplicate column: ${value}.`); map.set(key, i); }); return map;
}
export function parseTagCsv(text, source = {}, { friendlyNames = {}, siteAliases = {} } = {}) {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('Choose a CSV with device records.');
  const names = rows.shift(), map = headerMap(names);
  const aliases = { 'NPS Tag': ['tag', 'nps tag'], 'Serial Number': ['serial', 'serial number'], Location: ['location description', 'location'] };
  const columns = Object.fromEntries(DEVICE_FIELDS.map(key => {
    const options = aliases[key] || [header(key)], match = options.find(name => map.has(name));
    if (!match) throw new Error(`The CSV must include ${key}.`);
    return [key, map.get(match)];
  }));
  const seen = new Set(), records = [], sites = new Set(), missing = new Map();
  const filtering = { inputRows: rows.length, keptRows: 0, discardedRows: 0, reasons: { unsupportedSite: 0, productType: 0, location: 0, status: 0 }, unsupportedSiteIds: {} };
  rows.forEach((row, i) => {
    if (row.length !== names.length) throw new Error(`CSV row ${i + 2} has a different number of columns than the header.`);
    const record = Object.fromEntries(DEVICE_FIELDS.map(key => [key, plainExportText(row[columns[key]])]));
    const site = siteForId(record['Site ID'], siteAliases), type = PRODUCT_TYPES.get(record['Product Type'].toLowerCase()), status = STATUSES.get(record.Status.toLowerCase().replace(/\s+/g, ' '));
    let rejected = !site ? 'unsupportedSite' : !type ? 'productType' : !/^(?:Room|Staff|Student):\s*\S/i.test(record.Location) ? 'location' : !status ? 'status' : null;
    if (rejected) { filtering.reasons[rejected]++; filtering.discardedRows++; if (!site) filtering.unsupportedSiteIds[record['Site ID']] = (filtering.unsupportedSiteIds[record['Site ID']] || 0) + 1; return; }
    record['Product Type'] = type; record.Status = status;
    if (!record['NPS Tag']) throw new Error(`CSV row ${i + 2} is missing an NPS tag.`);
    const identity = JSON.stringify([site, record['NPS Tag']]);
    if (seen.has(identity)) throw new Error(`The CSV repeats NPS tag ${record['NPS Tag']} at ${site}. Resolve the duplicate before importing.`);
    seen.add(identity); sites.add(site);
    const rawName = record['Product Name']; if (!rawName) throw new Error(`CSV row ${i + 2} is missing Product Name.`);
    const friendly = friendlyProductName(type, rawName, friendlyNames);
    if (friendly) record['Product Name'] = friendly;
    else { const key = productKey(type, rawName); if (!missing.has(key)) missing.set(key, { key, type, product: rawName, count: 0 }); missing.get(key).count++; }
    filtering.keptRows++; records.push(record);
  });
  if (!records.length) throw new Error(`No rows match the required school, product, location, and status rules. Site IDs found: ${Object.keys(filtering.unsupportedSiteIds).join(', ') || 'supported sites only'}.`);
  const orderedSites = SITES.filter(site => sites.has(site)), warnings = source.fileDate ? [] : ['CSV source date is unknown.'];
  if (filtering.discardedRows) warnings.push(`${filtering.discardedRows} rows discarded by the import rules.`);
  return { site: orderedSites.length === 1 ? orderedSites[0] : null, sites: orderedSites, records, source, filtering, missingFriendlyNames: [...missing.values()], friendlyNames: { ...friendlyNames }, siteAliases: { ...siteAliases }, warnings };
}
export function combineTagImports(imports) {
  if (!imports.length) throw new Error('Select at least one CSV.');
  const records = [], seen = new Map(), sites = new Set(), missing = new Map(), warnings = [], sourceEntries = []; let combinedDuplicates = 0;
  for (const parsed of imports) {
    parsed.sites.forEach(site => sites.add(site)); warnings.push(...parsed.warnings); sourceEntries.push({ sites: parsed.sites, source: parsed.source, filtering: parsed.filtering });
    for (const item of parsed.missingFriendlyNames) { if (!missing.has(item.key)) missing.set(item.key, { ...item, count: 0 }); missing.get(item.key).count += item.count; }
    for (const record of parsed.records) {
      const key = JSON.stringify([siteForId(record['Site ID'], parsed.siteAliases), record['NPS Tag']]);
      if (seen.has(key)) { if (JSON.stringify(seen.get(key)) !== JSON.stringify(record)) throw new Error(`Selected CSVs disagree for tag ${record['NPS Tag']}. Import one current export per school; conflicting updates need reconciliation.`); combinedDuplicates++; }
      else { seen.set(key, record); records.push(structuredClone(record)); }
    }
  }
  if (combinedDuplicates) warnings.push(`${combinedDuplicates} identical records across selected CSVs were combined.`);
  const orderedSites = SITES.filter(site => sites.has(site));
  return { site: orderedSites.length === 1 ? orderedSites[0] : null, sites: orderedSites, records, sourceEntries, missingFriendlyNames: [...missing.values()], warnings, friendlyNames: Object.assign({}, ...imports.map(value => value.friendlyNames)), siteAliases: Object.assign({}, ...imports.map(value => value.siteAliases)) };
}
export function toDashboardRecords(records, site, aliases = {}) {
  return records.filter(row => !site || siteForId(row['Site ID'], aliases) === site).map(row => {
    let room = /^Room:/i.test(row.Location) ? row.Location.replace(/^Room:\s*/i, '').trim() : '';
    if (/^\d+$/.test(room)) room = `Z-${room}`;
    return { 'Site Name': siteForId(row['Site ID'], aliases), Tag: row['NPS Tag'], Serial: row['Serial Number'], 'Product Type': row['Product Type'], 'Product Name': row['Product Name'], 'Location ID': room, 'Location Description': row.Location, Status: row.Status };
  });
}
export function normalizeRoom(value) { const room = String(value ?? '').trim().replace(/^room\s*:?\s*/i, ''); return /^\d+(?:\.0+)?$/.test(room) ? String(Number(room)) : room; }
export function parseRosterRows(rows, source = {}) {
  const index = rows.slice(0, 20).findIndex(row => ['student id', 'staff name', 'room name'].every(key => row.some(value => header(value) === key)));
  if (index < 0) throw new Error('The workbook must include Student ID, Staff Name, and Room Name within its first 20 rows.');
  const map = headerMap(rows[index]), groups = new Map(), identities = new Map(); let rowCount = 0, duplicateRows = 0;
  for (const row of rows.slice(index + 1)) {
    const get = key => String(row[map.get(key)] ?? '').trim(), room = normalizeRoom(get('room name')); if (!room) continue;
    rowCount++; if (!groups.has(room)) groups.set(room, { teachers: [], records: new Map() });
    const group = groups.get(room), id = get('student id'), first = get('first name') || get('student first name'), last = get('last name') || get('student last name');
    const name = first && last ? `${normalizePersonName(first.split(/\s+/)[0])} ${last.toLocaleLowerCase().replace(/(^|[\s'’-])\p{L}/gu, match => match.toLocaleUpperCase())}` : normalizePersonName(get('student name'));
    if (name && !id) throw new Error('A named student is missing Student ID. Correct the roster before importing.');
    if (id) {
      const incoming = { id, altId2: get('alt id 2'), name }, old = identities.get(id);
      if (old && (old.room !== room || (old.name && name && old.name !== name) || (old.altId2 && incoming.altId2 && old.altId2 !== incoming.altId2))) throw new Error(`Student ID ${id} has conflicting classroom or identity values.`);
      if (group.records.has(id)) duplicateRows++;
      const record = { id, name: old?.name || name, altId2: old?.altId2 || incoming.altId2 };
      group.records.set(id, record); identities.set(id, { ...record, room });
    }
    const teacher = formatTeacherName(get('staff name')); if (teacher && !group.teachers.includes(teacher)) group.teachers.push(teacher);
  }
  if (!groups.size) throw new Error('The workbook contains no classroom rows.');
  const matching = SITES.filter(site => [...groups.keys()].every(room => SITE_ROOMS[site].includes(room)));
  if (matching.length !== 1) throw new Error('Roster rooms do not identify one supported school. Check unknown or mixed-school room numbers.');
  const site = matching[0], rooms = {}, warnings = [];
  for (const [room, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const studentRecords = [...group.records.values()].sort((a, b) => a.name.localeCompare(b.name) || compare(a.id, b.id));
    rooms[room] = { teacher: group.teachers.join('; '), teachers: group.teachers, students: studentRecords.length, studentNames: studentRecords.map(row => row.name).filter(Boolean).sort((a, b) => a.localeCompare(b)), studentRecords, missingStudentNames: studentRecords.filter(row => !row.name).length, multipleTeachers: group.teachers.length > 1 };
    if (rooms[room].multipleTeachers) warnings.push(`Room ${room}: multiple teachers — review.`);
    if (rooms[room].missingStudentNames) warnings.push(`Room ${room}: ${rooms[room].missingStudentNames} students have no name.`);
  }
  if (duplicateRows) warnings.push(`${duplicateRows} repeated roster rows were combined by Student ID.`);
  if (!source.fileDate) warnings.push('Roster source date is unknown.');
  return { site, rooms, rowCount, studentCount: identities.size, duplicateRows, source, warnings };
}
