const MAP_VIEWBOX = "0 130 1210 610";
export function fitTeacherName(card) {
  const name = card.querySelector('.cart-teacher-name');
  if (!name || !name.clientWidth) return;
  name.style.removeProperty('font-size');
  const available = name.clientWidth, required = name.scrollWidth;
  if (required > available) name.style.fontSize = `${parseFloat(getComputedStyle(name).fontSize) * available / required}px`;
}
export async function loadWillardRoomMap() {
  return loadRoomMap(new URL('./willard-map.svg', import.meta.url).href, {site:'Willard', viewBox:MAP_VIEWBOX});
}
async function loadRoomMap(path, options) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) return null;
    const source = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
    if (source.querySelector("parsererror") || source.documentElement.localName !== "svg") return null;
    return createRoomMap(source.documentElement, options);
  } catch { return null; }
}
export async function loadLakewoodRoomMaps() {
  const assets = await Promise.all([1,2,3].map(asset => loadRoomMap(new URL(`./ADL_floor_${asset}.svg`, import.meta.url).href, {site:'Lakewood', viewBox:'0 28 297 166'})));
  if (assets.some(map => !map)) return null;
  const maps = [101,201,301].map(room => assets.find(map => map.hasRoom(room)));
  if (maps.some(map => !map)) return null;
  let floor = 1, last, navigating = false;
  const floorForRoom = room => maps.findIndex(map => map.hasRoom(room)) + 1 || Math.min(3, Math.max(1, Math.floor(parseInt(room, 10) / 100))) || 1;
  const controller = {
    selectRoom(room) { floor = floorForRoom(room); },
    render(...args) {
      last = args;
      const [container, rooms, makeCard, makeFallbackCard, searching] = args;
      if (!navigating && searching && rooms.length && !rooms.some(room => floorForRoom(room.room) === floor)) controller.selectRoom(rooms[0].room);
      maps.forEach(map => map.dispose());
      maps[floor - 1].render(container, rooms.filter(room => floorForRoom(room.room) === floor), makeCard, makeFallbackCard, searching);
      const navigation = document.createElement('nav'); navigation.className = 'room-floor-navigation'; navigation.setAttribute('aria-label','Lakewood floor navigation');
      const label = document.createElement('strong'); label.textContent = `Floor ${floor}`; label.setAttribute('aria-live','polite');
      const arrow = (direction, text) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.setAttribute('aria-label', direction < 0 ? 'Previous floor' : 'Next floor'); button.disabled = direction < 0 ? floor === 1 : floor === 3;
        button.onclick = () => { floor += direction; navigating = true; controller.render(...last); navigating = false; container.querySelector('.room-floor-navigation button:not(:disabled)')?.focus(); }; return button;
      };
      navigation.append(arrow(-1,'←'), label, arrow(1,'→')); container.querySelector('.room-map').prepend(navigation);
    },
  };
  return controller;
}
function createRoomMap(art, {site, viewBox}) {
  const [, , viewWidth, viewHeight] = viewBox.split(/\s+/).map(Number);
  let resizeObserver, hideTimer;
  return {
    hasRoom(room) { return !!art.querySelector(`[id="room-${CSS.escape(String(room))}"]`); },
    dispose() { resizeObserver?.disconnect(); clearTimeout(hideTimer); },
    render(container, rooms, makeCard, makeFallbackCard, searching) {
      resizeObserver?.disconnect(); clearTimeout(hideTimer);
      const panel = document.createElement("section"); panel.className = "room-map"; panel.setAttribute("aria-label", `${site} carts floor map`);
      const instructions = document.createElement("p"); instructions.className = "room-map-instructions"; instructions.textContent = "Hover a room for its cart · Click to open";
      const viewport = document.createElement("div"); viewport.className = "room-map-viewport";
      viewport.style.aspectRatio = `${viewWidth} / ${viewHeight}`;
      const svg = document.importNode(art, true); svg.classList.add("room-map-art"); svg.removeAttribute("width"); svg.removeAttribute("height");
      svg.setAttribute("role", "group"); svg.setAttribute("aria-label", `${site} rooms; tab to a cart room to show its teacher tile`);
      svg.setAttribute("viewBox", viewBox); svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      viewport.append(svg); panel.append(instructions, viewport); container.replaceChildren(panel);
      const unmatched = []; let active = null;
      const hide = () => { if (active) { active.card.hidden = true; active.group.setAttribute("aria-expanded", "false"); active = null; } };
      const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!active?.card.matches(":hover, :focus-within") && !active?.group.matches(":hover, :focus-within")) hide(); }, 120); };
      const position = ({group, card}) => {
        const bounds = group.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
        const scale = Math.min(frame.width / viewWidth, frame.height / viewHeight) * viewWidth / 1210;
        card.style.setProperty("--cart-size", `${Math.max(48, 72 * scale)}px`);
        card.style.setProperty("--cart-font", `${Math.max(9, Math.min(14, 12 * scale))}px`);
        const size = card.offsetWidth;
        fitTeacherName(card);
        card.style.left = `${Math.max(0, Math.min(frame.width - size, bounds.x - frame.x + bounds.width / 2 - size / 2))}px`;
        card.style.top = `${Math.max(0, Math.min(frame.height - size, bounds.y - frame.y + bounds.height / 2 - size / 2))}px`;
      };
      for (const room of rooms) {
        const shape = svg.querySelector(`[id="room-${CSS.escape(String(room.room))}"]`);
        if (!shape || shape.localName !== "polygon") { unmatched.push(room); continue; }
        const group = document.createElementNS(svg.namespaceURI, "g"); group.classList.add("map-room"); group.dataset.room = room.room; group.classList.toggle("map-room--match", searching);
        group.setAttribute("tabindex", "0"); group.setAttribute("role", "button"); group.setAttribute("aria-expanded", "false"); group.setAttribute("aria-label", `Open cart for Room ${room.room}, ${room.students} students, ${room.devices} devices`);
        const outline = shape.cloneNode(true); outline.removeAttribute("id"); outline.removeAttribute("style"); outline.classList.add("map-room-shape"); group.append(outline); svg.append(group);
        const card = makeCard(room); card.classList.add("map-cart-popout"); card.hidden = true; card.id = `map-cart-${room.room}`; group.setAttribute("aria-controls", card.id); viewport.append(card);
        const placement = {group, card};
        const show = () => { clearTimeout(hideTimer); if (active !== placement) hide(); active = placement; card.hidden = false; group.setAttribute("aria-expanded", "true"); position(placement); };
        group.addEventListener("mouseenter", show); group.addEventListener("focusin", show); group.addEventListener("mouseleave", scheduleHide); group.addEventListener("focusout", scheduleHide);
        card.addEventListener("mouseenter", () => clearTimeout(hideTimer)); card.addEventListener("mouseleave", scheduleHide); card.addEventListener("focusout", scheduleHide);
        group.addEventListener("click", () => card.click());
        group.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); card.click(); } if (event.key === "Escape") { clearTimeout(hideTimer); hide(); } });
        card.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); group.focus(); hide(); } });
      }
      resizeObserver = new ResizeObserver(() => { if (active) position(active); }); resizeObserver.observe(viewport);
      if (unmatched.length) {
        const fallback = document.createElement("section"); fallback.className = "room-map-unmapped";
        const title = document.createElement("h3"); title.textContent = "Carts in rooms not shown on the map";
        const cards = document.createElement("div"); cards.className = "room-map-unmapped-cards";
        cards.append(...unmatched.map(makeFallbackCard)); fallback.append(title, cards); panel.append(fallback);
      }
    },
  };
}
