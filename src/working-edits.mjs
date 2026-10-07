import { renameRoom } from './room-names.mjs';

function settingsFor(workspace, site, room) {
  const settings = workspace.settings[site];
  if (!settings || ![...settings.rooms, ...settings.archivedRooms].includes(room)) throw new Error('That classroom is no longer active. Reload and retry.');
  return settings;
}
export function editRoom(workspace, site, room, { name, teacher, students }) {
  const settings = settingsFor(workspace, site, room);
  if (name !== undefined && !renameRoom(settings, room, name)) throw new Error('Enter a room name.');
  if (teacher !== undefined) { settings.teachers[room] = String(teacher).trim(); settings.teacherOverrides[room] = true; }
  if (students !== undefined) {
    if (!Number.isSafeInteger(students) || students < 0 || students > 10000) throw new Error('Enter a student count from 0 to 10,000.');
    settings.students[room] = students; settings.studentOverrides[room] = true;
  }
}
export function addRoom(workspace, site, room) {
  const settings = workspace.settings[site], key = String(room || '').trim();
  if (!settings || !key || key.length > 80 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Enter a valid room name or number.');
  if (settings.rooms.includes(key)) throw new Error('That room already exists.');
  const restoring = [...settings.deletedRooms, ...settings.archivedRooms].includes(key);
  settings.deletedRooms = settings.deletedRooms.filter(item => item !== key);
  settings.archivedRooms = settings.archivedRooms.filter(item => item !== key);
  settings.rooms.push(key);
  if (!restoring) { settings.students[key] = 0; settings.teachers[key] = ''; }
}
export function deleteRoom(workspace, site, room) {
  const settings = settingsFor(workspace, site, room);
  settings.rooms = settings.rooms.filter(item => item !== room);
  settings.archivedRooms = settings.archivedRooms.filter(item => item !== room);
  if (!settings.deletedRooms.includes(room)) settings.deletedRooms.push(room);
}
export function addStudent(workspace, site, room, { id, name, altId2 = '' }) {
  const settings = settingsFor(workspace, site, room), studentId = String(id || '').trim(), label = String(name || '').trim();
  if (!studentId || studentId.length > 80 || !label || label.length > 160 || workspace.students.some(item => item.site === site && item.id === studentId)) throw new Error('Enter a unique Student ID and a name.');
  const existingNames = workspace.students.filter(item => item.site === site && item.room === room).map(item => item.name).filter(Boolean);
  const manualNames = (settings.roomStudentNames[room] || existingNames).filter(item => !existingNames.includes(item));
  workspace.students.push({ site, room, id: studentId, name: label, altId2: String(altId2).trim() });
  settings.students[room]++; settings.studentOverrides[room] = true;
  settings.roomStudentNames[room] = [...workspace.students.filter(item => item.site === site && item.room === room).map(item => item.name).filter(Boolean), ...manualNames];
}
export function removeStudent(workspace, site, room, id) {
  const settings = settingsFor(workspace, site, room), index = workspace.students.findIndex(item => item.site === site && item.room === room && item.id === id);
  if (index < 0) throw new Error('Student no longer appears in this room.');
  const existingNames = workspace.students.filter(item => item.site === site && item.room === room).map(item => item.name).filter(Boolean);
  const manualNames = (settings.roomStudentNames[room] || existingNames).filter(item => !existingNames.includes(item));
  const [removed] = workspace.students.splice(index, 1);
  settings.students[room] = Math.max(0, settings.students[room] - 1); settings.studentOverrides[room] = true;
  if (removed.name) settings.roomRemovedStudentNames[room] = [...new Set([...(settings.roomRemovedStudentNames[room] || []), removed.name])];
  settings.removedStudentRecords ||= {}; settings.removedStudentRecords[room] ||= []; settings.removedStudentRecords[room].push(removed);
  settings.roomStudentNames[room] = [...workspace.students.filter(item => item.site === site && item.room === room).map(item => item.name).filter(Boolean), ...manualNames];
}
export function addManualStudentName(workspace, site, room, name) {
  const settings = settingsFor(workspace, site, room), label = String(name || '').trim();
  if (!label || label.length > 160) throw new Error('Enter a student name.');
  const names = settings.roomStudentNames[room] || workspace.students.filter(item => item.site === site && item.room === room).map(item => item.name).filter(Boolean);
  if (names.includes(label)) throw new Error('That student name is already listed.');
  settings.roomStudentNames[room] = [...names, label]; settings.students[room]++; settings.studentOverrides[room] = true;
}
export function removeManualStudentName(workspace, site, room, name) {
  const settings = settingsFor(workspace, site, room), names = settings.roomStudentNames[room] || [];
  if (!names.includes(name)) throw new Error('That student name is no longer listed.');
  settings.roomStudentNames[room] = names.filter(item => item !== name);
  settings.roomRemovedStudentNames[room] = [...new Set([...(settings.roomRemovedStudentNames[room] || []), name])];
  settings.students[room] = Math.max(0, settings.students[room] - 1); settings.studentOverrides[room] = true;
}
export function restoreRemovedStudent(workspace, site, room, name) {
  const settings = settingsFor(workspace, site, room), removed = settings.roomRemovedStudentNames[room] || [];
  if (!removed.includes(name)) throw new Error('That removed name is no longer listed.');
  const saved = settings.removedStudentRecords?.[room] || [], index = saved.findIndex(item => item.name === name);
  if (index >= 0) {
    const [student] = saved.splice(index, 1);
    if (workspace.students.some(item => item.site === site && item.id === student.id)) throw new Error('Student ID already exists in this school.');
    workspace.students.push(student);
  }
  settings.roomRemovedStudentNames[room] = removed.filter(item => item !== name);
  settings.roomStudentNames[room] = [...new Set([...(settings.roomStudentNames[room] || []), name])];
  settings.students[room]++; settings.studentOverrides[room] = true;
}
export function setInventory(workspace, site, room, tag, counted, knownTags) {
  settingsFor(workspace, site, room);
  const key = String(tag || '').trim(); if (!key) throw new Error('Enter an NPS tag.');
  const known = knownTags.includes(key), collection = known ? workspace.inventory : workspace.unmatchedScans;
  const index = collection.findIndex(item => item.site === site && item.room === room && item.tag === key);
  if (counted && index < 0) collection.push({ site, room, tag: key, at: new Date().toISOString(), cycle: workspace.inventoryCycleId });
  if (!counted && index >= 0) collection.splice(index, 1);
  return known;
}
export function resetRoomInventory(workspace, site, room) {
  const settings = settingsFor(workspace, site, room);
  workspace.inventory = workspace.inventory.filter(item => item.site !== site || item.room !== room);
  settings.students[room] = 0; settings.studentOverrides[room] = true;
}
