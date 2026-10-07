// Established labels from the existing dashboard. Additional labels require user input.
export const APPROVED_FRIENDLY_NAMES = Object.freeze({});
export function productKey(type, name) { return `${String(type).trim().toLowerCase()}|${String(name).trim().toLowerCase()}`; }
export function establishedFriendlyName(type, name) {
  const text = String(name || '').trim(), kind = String(type || '').toLowerCase();
  if (kind === 'chromebook') {
    if (/fortis\s+G1M\s+11\b/i.test(text)) return 'Chromebook G10';
    const generation = text.match(/\bG(10|[5-9])(?:\s*EE)?\b/i)?.[1];
    if (generation) return `Chromebook G${generation}`;
  }
  if (kind === 'ipad') {
    if (/ipad[\s-]*pro(?=\b|\d)/i.test(text)) return 'iPadPro';
    const generation = text.match(/ipad[\s-]*G(10|9)\b/i)?.[1] || text.match(/ipad[\s-]*(10|9)(?=$|[\s-]|th|gen)/i)?.[1] || text.match(/\b(10|9)(?:th)?[\s-]*(?:gen|generation)\b/i)?.[1];
    if (generation) return `iPad${generation}`;
  }
  if (kind === 'laptop' && /zbook/i.test(text)) {
    const generation = text.match(/\bG(\d{1,2})\b/i)?.[1];
    if (generation) return `Zbook G${generation}`;
  }
  // Approved names for the models present in the two supplied tag exports.
  if (kind === 'desktop') {
    if (/elitedesk\s*SFF\s*800\s*G9/i.test(text)) return 'Elitedesk G9';
    if (/\bZ2\s*G5\b/i.test(text)) return 'Z2 G5';
    if (/\bZ2\s*G9\b/i.test(text)) return 'Z2 G9';
    if (/elite\s*mini\s*805\s*G8/i.test(text)) return 'G8 Mini';
    if (/\b705\s*G4\b/i.test(text)) return 'G4 Mini';
    if (/elitedesk\s*800\s*G6/i.test(text)) return 'Elitedesk G6';
  }
  if (kind === 'laptop') {
    if (/probook\s*455\s*G9/i.test(text)) return 'Probook G9';
    if (/\b455\s*G10\b/i.test(text)) return 'Probook G10';
    if (/probook\s*4\s*G1a\s*16\s*AI/i.test(text)) return 'Probook G1a 16';
    if (/\b15-dy1043dx\b/i.test(text)) return 'HP15';
  }
  if (kind === 'imac') {
    if (/imac\s*intel\s*5K\s*2019/i.test(text)) return 'iMac2019';
    if (/imac\s*24\s*45K\s*2021/i.test(text)) return 'iMac2021';
  }
  if (kind === 'ipad') {
    if (/ipad\s*A16\s*11\s*Gen/i.test(text)) return 'iPad11';
    for (const generation of [5, 6, 7]) if (new RegExp(`ipad${generation}\\b`, 'i').test(text)) return `iPad${generation}`;
  }
  return null;
}
export function friendlyProductName(type, name, names = {}) {
  const key = productKey(type, name), custom = names[key] ?? APPROVED_FRIENDLY_NAMES[key];
  if (custom !== undefined) {
    const label = String(custom).trim();
    if (!label || label.length > 100 || /[\r\n\x00]/.test(label)) throw new Error('Friendly product names must contain 1–100 characters on one line.');
    return label;
  }
  return establishedFriendlyName(type, name);
}
