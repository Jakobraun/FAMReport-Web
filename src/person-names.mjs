function nameCase(value) {
  return value.toLocaleLowerCase().replace(/(^|[\s'’-])\p{L}/gu, match => match.toLocaleUpperCase());
}

export function normalizePersonName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  // Support both First Middle Last and Last, First Middle exports.
  const comma = text.indexOf(",");
  const parts = text.split(/\s+/).filter(Boolean);
  const first = comma >= 0 ? text.slice(comma + 1).trim().split(/\s+/)[0] : parts[0];
  const last = comma >= 0 ? text.slice(0, comma).trim() : parts.length > 1 ? parts.at(-1) : "";
  return nameCase([first, last].filter(Boolean).join(" "));
}

export function normalizePersonLocation(value) {
  const text = String(value || "");
  const match = text.trim().match(/^(staff|student)\s*:\s*(.+)$/i);
  return match ? `${nameCase(match[1])}: ${normalizePersonName(match[2])}` : text;
}

export function formatTeacherName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const comma = text.indexOf(",");
  const parts = text.split(/\s+/);
  const first = comma >= 0 ? text.slice(comma + 1).trim().split(/\s+/)[0] : parts.length > 1 ? parts[0] : "";
  const last = comma >= 0 ? text.slice(0, comma).trim() : parts.at(-1);
  return `${nameCase(last)}${first ? `, ${first[0].toLocaleUpperCase()}` : ""}`;
}

export function formatTeacherList(value) {
  const names = Array.isArray(value) ? value : String(value || "").split(";");
  return [...new Set(names.map(formatTeacherName).filter(Boolean))].join("; ");
}

export function inUseLocationLabel(location) {
  const normalized = normalizePersonLocation(location);
  const match = normalized.match(/^(Staff|Student): (.+)$/);
  if (!match) return { label: "", name: normalized || "Unspecified location", sortKey: normalized.toLocaleLowerCase() };
  const parts = match[2].split(/\s+/);
  return { label: `${match[1]}:`, name: match[2], sortKey: `${parts.at(-1)}, ${parts[0]}`.toLocaleLowerCase() };
}
