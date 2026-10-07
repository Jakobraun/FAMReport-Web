function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function rosterExpiresAt(value) {
  const source = validDate(value);
  if (!source) return null;
  const day = source.getUTCDate();
  const deadline = new Date(source);
  deadline.setUTCDate(1);
  deadline.setUTCMonth(deadline.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(deadline.getUTCFullYear(), deadline.getUTCMonth() + 1, 0)).getUTCDate();
  deadline.setUTCDate(Math.min(day, lastDay));
  return deadline;
}

export function isRosterStale(value, now = new Date()) {
  const deadline = rosterExpiresAt(value);
  return Boolean(deadline && now > deadline);
}

export function roomReviewState(classroom, settings) {
  const room = String(classroom.room);
  const source = settings.roster?.rooms?.[room];
  const teacherOverride = Boolean(settings.teacherOverrides?.[room]);
  const reasons = [];
  if (source?.multipleTeachers && !teacherOverride) reasons.push("Multiple teachers — review");
  if (source && classroom.students === 0 && classroom.devices > 0) reasons.push("Devices assigned but no students — review");
  return { reasons };
}
