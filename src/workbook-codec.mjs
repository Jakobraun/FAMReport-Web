import { Unzip, UnzipInflate } from './vendor/fflate-0.8.2.mjs';
import { LIMITS, parseRosterRows } from './source-import.mjs';
import { SHEETS, WORKBOOK_FORMAT, workspaceToTables, tablesToWorkspace } from './working-workbook.mjs';

function fail(message = 'The workbook ZIP structure is invalid.') { throw new Error(message); }
const utf8 = new TextDecoder('utf-8', { fatal: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let crc = -1; for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8); return (crc ^ -1) >>> 0; }
export function inspectZip(bytes, expandedLimit = LIMITS.expandedBytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) fail('Choose a valid .xlsx workbook.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), manifest = new Map(); let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail();
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  if (!count || count > LIMITS.zipEntries || count !== view.getUint16(end + 8, true) || offset + size !== end) fail('The workbook contains an unsupported or oversized ZIP archive.');
  let cursor = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail();
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), compressed = view.getUint32(cursor + 20, true), expanded = view.getUint32(cursor + 24, true), nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true), local = view.getUint32(cursor + 42, true);
    if ((flags & 1) || ![0, 8].includes(method) || compressed === 0xffffffff || expanded === 0xffffffff || local === 0xffffffff || cursor + 46 + nameLength + extra + comment > end) fail('Encrypted, ZIP64, or unsupported workbook archives cannot be imported.');
    const name = utf8.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name || /\\|^\/|^[A-Za-z]:|\x00/.test(name) || name.split('/').includes('..') || manifest.has(name)) fail('The workbook contains unsafe or duplicate ZIP entries.');
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method) fail();
    const localNameLength = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    if (local + 30 + localNameLength + localExtra + compressed > offset || utf8.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) fail();
    total += expanded; if (total > expandedLimit) fail('The expanded workbook exceeds the supported size limit.');
    manifest.set(name, { expanded, crc: view.getUint32(cursor + 16, true) }); cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end || !manifest.has('xl/workbook.xml') || !manifest.has('xl/_rels/workbook.xml.rels')) fail('The file is not an XLSX workbook.');
  return manifest;
}
export function validateWorkbookZip(bytes, expandedLimit = LIMITS.expandedBytes) {
  const manifest = inspectZip(bytes, expandedLimit), completed = new Set(); let total = 0, cells = 0;
  const unzip = new Unzip(file => {
    const expected = manifest.get(file.name); if (!expected || completed.has(file.name)) fail();
    let length = 0; const pieces = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      length += chunk.length; total += chunk.length;
      if (length > expected.expanded || total > expandedLimit) { file.terminate(); fail('The actual expanded workbook exceeds its declared size or the supported limit.'); }
      pieces.push(chunk);
      if (final) {
        if (length !== expected.expanded) fail('A workbook entry has an incorrect expanded size.');
        const data = new Uint8Array(length); let cursor = 0; for (const piece of pieces) { data.set(piece, cursor); cursor += piece.length; }
        if (crc32(data) !== expected.crc) fail('A workbook entry failed its integrity check.');
        if (/\.(?:xml|rels)$/i.test(file.name)) {
          const xml = utf8.decode(data);
          if (/<!DOCTYPE|<!ENTITY/i.test(xml) || /xl\/externalLinks\//i.test(file.name) || /TargetMode\s*=\s*["']External["']/i.test(xml)) fail('External links or XML entities are not supported in imported workbooks.');
          if (/^xl\/worksheets\/.*\.xml$/.test(file.name)) {
            let match, rowCount = 0; const rows = /<(?:\w+:)?row\b/g, references = /<(?:\w+:)?(?:c|dimension)\b[^>]*\b(?:r|ref)=["']([^"']+)["']/g;
            while (rows.exec(xml)) if (++rowCount > LIMITS.rows + 1) fail('The worksheet contains too many rows.');
            while ((match = references.exec(xml))) for (const ref of match[1].split(':')) {
              const parts = ref.match(/^([A-Z]+)(\d+)$/i); if (!parts) fail('Invalid worksheet cell reference.');
              let column = 0; for (const char of parts[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
              if (column > LIMITS.columns || Number(parts[2]) > LIMITS.rows + 1) fail('The worksheet exceeds supported row or column limits.');
            }
            const pattern = /<(?:\w+:)?c\b/g; while (pattern.exec(xml)) if (++cells > LIMITS.cells) fail('The workbook contains too many cells.');
          }
        }
        completed.add(file.name);
      }
    }; file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < bytes.length; i += 4096) unzip.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
  if (completed.size !== manifest.size) fail('The workbook contains incomplete ZIP entries.');
}
function rowsFromSheet(sheet, XLSX) {
  if (!sheet?.['!ref']) return [];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  if (range.e.r >= LIMITS.rows + 1 || range.e.c >= LIMITS.columns) fail('The worksheet exceeds supported row or column limits.');
  const rows = [];
  for (let r = 0; r <= range.e.r; r++) {
    const row = [];
    for (let c = 0; c <= range.e.c; c++) {
      const cell = sheet['!data']?.[r]?.[c] || sheet[XLSX.utils.encode_cell({ r, c })];
      row.push(!cell || cell.v == null ? '' : cell.t === 'n' && /^0+$/.test(cell.z || '') ? XLSX.utils.format_cell(cell) : String(cell.v));
    }
    rows.push(row);
  }
  return rows;
}
function read(bytes, XLSX, expandedLimit) {
  validateWorkbookZip(bytes, expandedLimit);
  return XLSX.read(bytes, { type: 'array', dense: true, cellFormula: false, cellNF: true, cellHTML: false, cellStyles: false, bookVBA: false, sheetRows: LIMITS.rows + 1 });
}
export function readRosterWorkbook(bytes, source, XLSX) {
  if (!bytes.length || bytes.length > LIMITS.rosterBytes) fail('Choose a roster workbook no larger than 10 MiB.');
  const workbook = read(bytes, XLSX, LIMITS.expandedBytes);
  if (workbook.Sheets['App State'] && rowsFromSheet(workbook.Sheets['App State'], XLSX).some(row => row[0] === 'format' && row[1] === WORKBOOK_FORMAT)) fail('This is a working workbook. Choose the original classroom roster for initial creation.');
  return parseRosterRows(rowsFromSheet(workbook.Sheets[workbook.SheetNames[0]], XLSX), source);
}
export function writeWorkingWorkbook(workspace, XLSX) {
  const tables = workspaceToTables(workspace), workbook = XLSX.utils.book_new(); let cells = 0;
  for (const name of SHEETS) {
    if (tables[name].length > LIMITS.rows + 1) fail('The working file contains too many rows.');
    const sheet = {};
    tables[name].forEach((row, r) => row.forEach((value, c) => {
      if (++cells > LIMITS.cells) fail('The working file contains too many cells.');
      const text = String(value ?? ''); if (text.length > 32767) fail('A working-file field exceeds the Excel cell limit.');
      sheet[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: text };
    }));
    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: tables[name].length - 1, c: tables[name][0].length - 1 } });
    sheet['!cols'] = tables[name][0].map(() => ({ wch: 22 })); XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  workbook.Workbook = { Sheets: SHEETS.map(name => ({ name, Hidden: name === 'App State' ? 1 : 0 })) };
  const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true }));
  if (bytes.length > LIMITS.workspaceBytes) fail('The working file exceeds the 32 MiB supported limit.');
  validateWorkbookZip(bytes, LIMITS.workspaceExpandedBytes); return bytes;
}
export function readWorkingWorkbook(bytes, XLSX) {
  if (!bytes.length || bytes.length > LIMITS.workspaceBytes) fail('Choose a working workbook no larger than 32 MiB.');
  const workbook = read(bytes, XLSX, LIMITS.workspaceExpandedBytes);
  if (workbook.SheetNames.length !== SHEETS.length || SHEETS.some(name => !workbook.Sheets[name])) fail('This is not a dashboard working workbook.');
  return tablesToWorkspace(Object.fromEntries(SHEETS.map(name => [name, rowsFromSheet(workbook.Sheets[name], XLSX)])));
}
