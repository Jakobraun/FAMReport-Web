export function roomLabel(settings, room) {
  const key = String(room);
  return settings.roomNames?.[key] || (/^\d+$/.test(key) ? `Room ${key}` : key);
}

export function renameRoom(settings, room, name) {
  const key = String(room), label = String(name || "").trim();
  if (!label) return false;
  settings.roomNames ||= {};
  if (label === key || label === (/^\d+$/.test(key) ? `Room ${key}` : key)) delete settings.roomNames[key];
  else settings.roomNames[key] = label;
  return true;
}
