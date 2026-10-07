import { normalizePersonLocation } from "./person-names.mjs";

const DEFAULT_CLASSROOMS = Array.from({ length: 45 }, (_, index) => index + 1);
const SCHOOL_SPARE_LOCATIONS = new Set(["ENG", "Z-ENG", "Z-LIB", "Z-LIB2"]);

function cleanLocation(value) { return String(value ?? "").trim().replace(/^Room:\s*/i, ""); }
function sourceLocation(record) {
  const locationId = cleanLocation(record["Location ID"]);
  return locationId || cleanLocation(record.Location ?? record["Location Description"] ?? record["Room Description"] ?? record["Installation Room"]);
}
function recordLocation(record) {
  const locationId = cleanLocation(record["Location ID"]);
  const person = String(record["Location Description"] || "").trim();
  if (/^(?:staff|student)\s*:/i.test(person)) return person;
  if (locationId && (/cart/i.test(String(record["Location Type"] || "")) || /^z/i.test(locationId) || /^(?:inventory|inv_temp)$/i.test(locationId))) return locationId;
  const locationDescription = String(record["Location Description"] || "").trim();
  if (/^room\s*:/i.test(locationDescription)) {
    const room = cleanLocation(locationDescription);
    return /^\d+$/.test(room) ? `Room ${room}` : room;
  }
  return cleanLocation(locationDescription || record.Location || record["Room Description"] || record["Installation Room"]);
}
function cleanTag(value) { return String(value ?? "").replace(/^=\"?|\"$/g, ""); }
function productText(record) { return `${record["Product Type"] || ""} ${record["Product Name"] || ""}`; }
function chromebookGeneration(value) {
  const product = String(value || "");
  if (/fortis\s+G1M\s+11\b/i.test(product)) return "10";
  return product.match(/\bG(10|[5-9])(?:\s*EE)?\b/i)?.[1] || null;
}
function ipadGeneration(value) {
  const product = String(value || "");
  if (/ipad[\s-]*pro(?=\b|\d)/i.test(product)) return null;
  const modelGeneration = product.match(/ipad[\s-]*G(10|9)\b/i)?.[1];
  if (modelGeneration) return modelGeneration;
  return product.match(/ipad[\s-]*(10|9)(?=$|[\s-]|th|gen)/i)?.[1]
    || product.match(/\b(10|9)(?:th)?[\s-]*(?:gen|generation)\b/i)?.[1]
    || null;
}
function classifyDevice(record) {
  const product = productText(record);
  if (/ipad/i.test(product)) return { type: "ipad", generation: ipadGeneration(product) };
  // Fortis models are Chromebooks even when their exported Product Type is not simply "Chromebook".
  if (/chromebook|fortis/i.test(product)) return { type: "chromebook", generation: chromebookGeneration(product) };
  if (/laptop|notebook|zbook|elitebook|probook|thinkpad|latitude/i.test(product) && !/macbook|macos|chromeos/i.test(`${product} ${record.OS || ""}`)) return { type: "windowsLaptop", generation: null };
  return { type: "other", generation: null };
}
function isIpad(record) { return classifyDevice(record).type === "ipad"; }
function isSupportedProduct(record) { return ["chromebook", "ipad"].includes(classifyDevice(record).type); }
function isExcludedStatus(status) { return /\b(?:disposed|lost|stolen|in repair|used for parts)\b/i.test(String(status || "")); }
function isInUse(record, detail) { return /in use/i.test(detail.status) || /^(?:staff|student)\s*:/i.test(String(record["Location Description"] || "")); }

function classroomFor(location) {
  const cleaned = cleanLocation(location);
  const cartMatch = cleaned.match(/^ZI?-0*(\d{1,3})$/i);
  if (cartMatch) return Number(cartMatch[1]);
  const exportedCartMatch = cleaned.match(/cart\b.*?\broom\s*(\d{1,3})\b/i);
  if (exportedCartMatch) return Number(exportedCartMatch[1]);
  return null;
}

function deviceDetail(record) {
  const classification = classifyDevice(record);
  return { tag: cleanTag(record.Tag), serial: String(record.Serial || record["Serial Number"] || "").trim(), location: normalizePersonLocation(recordLocation(record)), sourceLocation: sourceLocation(record), status: record.Status || "", product: record["Product Name"] || record["Product Type"] || "", deviceType: classification.type, generation: classification.generation };
}
function roomKey(room) { return String(room ?? "").trim(); }
function cartRoomKey(room) { return roomKey(room).replace(/^room\s+/i, ""); }
export function assignedRoomsForTag(records, tag) {
  return [...new Set(records.filter(record => cleanTag(record.Tag) === String(tag).trim()).map(record => classroomFor(sourceLocation(record))).filter(Boolean).map(String))];
}
function compareRooms(a, b) { const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b); if (numericA && numericB) return Number(a) - Number(b); if (numericA) return -1; if (numericB) return 1; return a.localeCompare(b); }

export function buildDashboard(records, studentCounts = {}, rooms = DEFAULT_CLASSROOMS) {
  const roster = [...new Set(rooms.map(roomKey).filter(Boolean))].sort(compareRooms);
  const deviceCounts = new Map(roster.map(room => [room, 0]));
  const roomDevices = Object.fromEntries(roster.map(room => [room, []]));
  const cartRoomNames = new Map(roster.map(room => [cartRoomKey(room), room]));
  const detailGroups = { totalDevices: [], classroomDevices: [], schoolSparePool: [], unassignedDevices: [] };
  const inventoryTabs = { repair: [], ipads: [], inUse: [] };

  for (const record of records) {
    const rawDetail = deviceDetail(record);
    if (/in repair/i.test(rawDetail.status)) inventoryTabs.repair.push(rawDetail);
    if (isExcludedStatus(rawDetail.status)) continue;
    const inUse = isInUse(record, rawDetail);
    if (rawDetail.deviceType === "windowsLaptop" && inUse && /^staff\s*:/i.test(rawDetail.location)) inventoryTabs.inUse.push(rawDetail);
    if (!isSupportedProduct(record)) continue;
    if (isIpad(record)) inventoryTabs.ipads.push(rawDetail);
    if (inUse) inventoryTabs.inUse.push(rawDetail);
    const detail = deviceDetail(record);
    const room = classroomFor(detail.sourceLocation);
    const spareLocation = /cart\b.*?\bENG\b/i.test(detail.sourceLocation) ? "ENG" : /cart\b.*?\b(?:LIB|MEDIA CENTER)\b/i.test(detail.sourceLocation) ? "Z-LIB" : detail.sourceLocation.toUpperCase();
    detailGroups.totalDevices.push(detail);
    if (inUse) continue;
    const classroomName = room && cartRoomNames.get(String(room));
    if (classroomName) { deviceCounts.set(classroomName, deviceCounts.get(classroomName) + 1); roomDevices[classroomName].push(detail); detailGroups.classroomDevices.push(detail); }
    else if (!isIpad(record) && (SCHOOL_SPARE_LOCATIONS.has(spareLocation) || /^(?:inventory|inv_temp)$/i.test(spareLocation))) detailGroups.schoolSparePool.push(detail);
    else detailGroups.unassignedDevices.push(detail);
  }

  const classrooms = roster.map(room => {
    const devices = deviceCounts.get(room);
    const students = Math.max(0, Number(studentCounts[room]) || 0);
    return { room, devices, students, spare: devices - students };
  });

  return {
    totalDevices: detailGroups.totalDevices.length,
    classroomDevices: detailGroups.classroomDevices.length,
    schoolSparePool: detailGroups.schoolSparePool.length,
    unassignedDevices: detailGroups.unassignedDevices.length,
    classrooms,
    roomDevices,
    detailGroups,
    inventoryTabs,
  };
}

export function buildRoomDashboard(records, settings) {
  const deleted = new Set(settings.deletedRooms || []);
  const rooms = [...settings.rooms, ...settings.archivedRooms, ...deleted];
  const dashboard = buildDashboard(records, settings.students, rooms);
  return {
    ...dashboard,
    roomsWithCarts: dashboard.classrooms.filter(room => room.devices > 0),
    roomsWithoutDevices: dashboard.classrooms.filter(room => room.devices === 0 && !deleted.has(room.room)),
  };
}
