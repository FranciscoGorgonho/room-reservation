const $ = (id) => document.getElementById(id);

const PENDING_KEY = 'room-reservation.pending';
const MAX_SLOTS = 16;
const RETRY_DELAYS_MS = [400, 1200, 3000];
const REQUEST_TIMEOUT_MS = 8000;

const state = {
  room: null,
  availability: null,
  selection: null, // { from, to } em índices de slots
  mine: [],
  takenUntil: new Map(), // início do slot -> até quando tratá-lo como ocupado
  confirming: false,
  unresolved: false, // confirmação sem resposta, aguardando nova verificação
};

/* ---------- utilidades ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('aria') || key === 'role') node.setAttribute(ariaName(key), value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

function ariaName(key) {
  return key === 'role' ? key : `aria-${key.slice(4).toLowerCase()}`;
}

const userId = () => $('user').value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatTime(iso, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone }).format(new Date(iso));
}

function formatDay(iso, timeZone) {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    timeZone,
  }).format(new Date(iso));
}

function localDate(date = new Date()) {
  return date.toLocaleDateString('en-CA');
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error('api'), { status: response.status, body });
  return body;
}

function userHeaders() {
  return { 'x-user-id': userId() };
}

/* ---------- salas e agenda ---------- */

let searchTimer;
async function loadRooms() {
  const q = $('search').value.trim();
  const { rooms } = await api(`/api/rooms?q=${encodeURIComponent(q)}`);
  $('room-list').replaceChildren(
    ...rooms.map((room) => {
      const button = el(
        'button',
        { type: 'button', onclick: () => selectRoom(room) },
        room.name,
        el('small', {}, `${room.city} · até ${room.capacity} pessoas`),
      );
      if (state.room?.id === room.id) button.setAttribute('aria-current', 'true');
      return el('li', {}, button);
    }),
  );
  if (rooms.length === 0) {
    $('room-list').replaceChildren(el('li', { className: 'muted small' }, 'Nenhuma sala encontrada.'));
  }
  if (!state.room && rooms[0]) selectRoom(rooms[0], false);
}

function selectRoom(room, chosenByPerson = true) {
  state.room = room;
  state.selection = null;
  state.takenUntil.clear();
  $('room-title').textContent = room.name;
  $('room-meta').textContent = `${room.city} · até ${room.capacity} pessoas · ${room.timezone}`;
  for (const button of $('room-list').querySelectorAll('button')) {
    if (button.firstChild.textContent === room.name) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  // A seleção automática ao abrir a página não pode apagar o desfecho de uma confirmação.
  if (chosenByPerson && !state.unresolved && !state.confirming) clearResult();
  refreshAvailability();
}

async function refreshAvailability() {
  if (!state.room) return;
  const room = state.room;
  const date = $('date').value;
  try {
    const availability = await api(`/api/rooms/${room.id}/availability?date=${date}`);
    if (state.room !== room || $('date').value !== date) return;
    state.availability = availability;
    renderSlots();
  } catch {
    $('freshness').textContent = 'Não foi possível atualizar a agenda agora.';
  }
}

function slotState(slot) {
  const start = new Date(slot.start).getTime();
  const end = new Date(slot.end).getTime();
  const mine = state.mine.some(
    (r) =>
      r.status === 'confirmed' &&
      r.roomId === state.room.id &&
      new Date(r.start).getTime() < end &&
      new Date(r.end).getTime() > start,
  );
  if (mine) return 'mine';
  if (start <= Date.now()) return 'past';
  const takenUntil = state.takenUntil.get(slot.start);
  if (!slot.available || (takenUntil && takenUntil > Date.now())) return 'busy';
  return 'free';
}

const STATE_LABEL = { free: 'livre', busy: 'ocupado', mine: 'sua reserva', past: 'encerrado' };

function renderSlots() {
  const availability = state.availability;
  if (!availability) return;
  const buttons = availability.slots.map((slot, index) => {
    const slotKind = slotState(slot);
    const time = formatTime(slot.start, availability.timezone);
    const selected =
      state.selection && index >= state.selection.from && index <= state.selection.to;
    const button = el(
      'button',
      {
        type: 'button',
        className: 'slot',
        disabled: slotKind !== 'free',
        dataset: { state: slotKind },
        ariaLabel: `${time}, ${STATE_LABEL[slotKind]}`,
        title: STATE_LABEL[slotKind],
        onclick: () => toggleSlot(index),
      },
      time,
    );
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    return button;
  });
  $('slots').replaceChildren(...buttons);

  const asOf = formatSeconds(availability.asOf);
  $('freshness').textContent =
    `Agenda de ${asOf} · pode atrasar até ${availability.maxStalenessSeconds} s · ` +
    'o horário é validado no momento da confirmação.';
  renderSelection();
}

function formatSeconds(iso) {
  return new Intl.DateTimeFormat('pt-BR', { timeStyle: 'medium' }).format(new Date(iso));
}

function toggleSlot(index) {
  const selection = state.selection;
  if (!selection) {
    state.selection = { from: index, to: index };
  } else if (index === selection.to + 1 && selection.to - selection.from + 1 < MAX_SLOTS) {
    selection.to = index;
  } else if (index === selection.from - 1 && selection.to - selection.from + 1 < MAX_SLOTS) {
    selection.from = index;
  } else if (index >= selection.from && index <= selection.to) {
    state.selection = null;
  } else {
    state.selection = { from: index, to: index };
  }
  renderSlots();
}

function selectedInterval() {
  const { selection, availability } = state;
  if (!selection || !availability) return null;
  const first = availability.slots[selection.from];
  const last = availability.slots[selection.to];
  if (!first || !last) return null;
  return { start: first.start, end: last.end };
}

function renderSelection() {
  const interval = selectedInterval();
  $('confirm-bar').hidden = !interval;
  $('race').disabled = !interval;
  if (!interval) return;
  const { timezone } = state.availability;
  $('selection-text').textContent =
    `${state.room.name}, ${formatDay(interval.start, timezone)}, ` +
    `${formatTime(interval.start, timezone)} às ${formatTime(interval.end, timezone)}. ` +
    'Clique no horário vizinho para aumentar.';
  // Com uma confirmação em aberto, resolver essa vem antes de iniciar outra.
  $('confirm').disabled = state.confirming || state.unresolved;
}

/* ---------- confirmação: nunca deixar a pessoa em dúvida ---------- */

function showResult(kind, title, detail, action) {
  const box = $('result');
  box.dataset.kind = kind;
  box.hidden = false;
  box.replaceChildren(el('div', {}, el('strong', {}, title), detail ?? ''), ...(action ? [action] : []));
}

function clearResult() {
  $('result').hidden = true;
}

function loadPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY));
  } catch {
    return null;
  }
}

function savePending(pending) {
  try {
    if (pending) localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    // Sem armazenamento, a tentativa só não sobrevive a recarregar a página.
  }
}

async function attempt(pending) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('/api/reservations', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-user-id': pending.userId,
        'idempotency-key': pending.key,
      },
      body: JSON.stringify({ roomId: pending.roomId, start: pending.start, end: pending.end }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

async function submit(pending) {
  if (state.confirming) return;
  state.confirming = true;
  state.unresolved = false;
  savePending(pending);
  renderSelection();
  showResult('wait', 'Confirmando sua reserva…', 'Aguarde a resposta antes de considerar o horário seu.');

  let outcome = await attempt(pending);
  for (const delay of RETRY_DELAYS_MS) {
    if (outcome.status !== 0 && outcome.status < 500) break;
    await sleep(delay);
    // Repete com a MESMA chave: se a anterior já gravou, recebe a mesma reserva.
    outcome = await attempt(pending);
  }

  state.confirming = false;
  if (outcome.status === 200 || outcome.status === 201) {
    savePending(null);
    showResult(
      'ok',
      'Reserva confirmada',
      `${pending.label}. O e-mail de aviso chega em seguida; esta confirmação já é a garantia.`,
    );
    state.selection = null;
    await loadMine();
  } else if (outcome.status === 0 || outcome.status >= 500) {
    // Continua pendente: a chave fica guardada e a pergunta segue aberta, de forma explícita.
    state.unresolved = true;
    showResult(
      'wait',
      'Ainda sem confirmação: não considere este horário reservado',
      'Não recebemos resposta do servidor. Verificar de novo é seguro e nunca cria uma segunda reserva.',
      el('button', { type: 'button', onclick: () => submit(pending) }, 'Verificar agora'),
    );
  } else {
    savePending(null);
    const message = outcome.body?.error?.message ?? 'A reserva não foi feita.';
    showResult('bad', 'Reserva não realizada', message);
    if (outcome.status === 409) markTaken(pending);
    state.selection = null;
  }
  renderSlots();
  refreshAvailability();
}

function markTaken(pending) {
  const ttl = (state.availability?.maxStalenessSeconds ?? 5) * 1000;
  const start = new Date(pending.start).getTime();
  const end = new Date(pending.end).getTime();
  for (const slot of state.availability?.slots ?? []) {
    const slotStart = new Date(slot.start).getTime();
    if (slotStart >= start && slotStart < end) {
      state.takenUntil.set(slot.start, Date.now() + ttl);
    }
  }
}

function confirmSelection() {
  const interval = selectedInterval();
  if (!interval || state.confirming) return;
  const { timezone } = state.availability;
  submit({
    key: crypto.randomUUID(),
    userId: userId(),
    roomId: state.room.id,
    start: interval.start,
    end: interval.end,
    label:
      `${state.room.name}, ${formatDay(interval.start, timezone)}, ` +
      `${formatTime(interval.start, timezone)} às ${formatTime(interval.end, timezone)}`,
  });
}

/* ---------- minhas reservas e cancelamento ---------- */

async function loadMine() {
  try {
    const { reservations } = await api('/api/me/reservations', { headers: userHeaders() });
    state.mine = reservations;
  } catch {
    state.mine = [];
  }
  renderMine();
  renderSlots();
}

function renderMine() {
  const active = state.mine.filter(
    (r) => r.status === 'confirmed' && new Date(r.end).getTime() > Date.now(),
  );
  if (active.length === 0) {
    $('mine').replaceChildren(el('li', { className: 'muted small' }, 'Nenhuma reserva futura.'));
    return;
  }
  $('mine').replaceChildren(...active.map(renderReservation));
}

function renderReservation(reservation) {
  const { timezone } = reservation;
  const started = new Date(reservation.start).getTime() <= Date.now();
  const button = el('button', { type: 'button', disabled: started }, 'Cancelar');
  button.title = started ? 'A reserva já começou' : '';
  let armed = false;
  button.onclick = async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Confirmar?';
      button.classList.add('danger');
      return;
    }
    button.disabled = true;
    await cancel(reservation);
  };
  return el(
    'li',
    {},
    el(
      'div',
      {},
      el('strong', {}, reservation.roomName),
      el(
        'small',
        {},
        `${formatDay(reservation.start, timezone)}, ` +
          `${formatTime(reservation.start, timezone)} às ${formatTime(reservation.end, timezone)}`,
      ),
    ),
    button,
  );
}

async function cancel(reservation) {
  try {
    await api(`/api/reservations/${reservation.id}/cancel`, {
      method: 'POST',
      headers: userHeaders(),
    });
    showResult('ok', 'Reserva cancelada', `${reservation.roomName}: o horário já está liberado.`);
  } catch (err) {
    showResult(
      'bad',
      'Não foi possível confirmar o cancelamento',
      err.body?.error?.message ?? 'Confira a lista abaixo e tente de novo se ela ainda aparecer.',
    );
  }
  await loadMine();
  refreshAvailability();
}

/* ---------- laboratório ---------- */

async function runRace() {
  const interval = selectedInterval();
  if (!interval) return;
  $('race').disabled = true;
  $('race-result').textContent = 'Disparando…';
  const roomId = state.room.id;
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      fetch('/api/reservations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': String(1000 + i),
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({ roomId, ...interval }),
      })
        .then((r) => r.status)
        .catch(() => 0),
    ),
  );
  const won = results.filter((s) => s === 201).length;
  const lost = results.filter((s) => s === 409).length;
  const other = results.length - won - lost;
  $('race-result').textContent =
    `${won} confirmada · ${lost} recusadas` + (other ? ` · ${other} sem resposta` : '');
  if (won + lost > 0) markTaken(interval);
  state.selection = null;
  renderSlots();
  refreshAvailability();
}

async function loadLab() {
  let status;
  try {
    status = await api('/api/dev/status');
  } catch {
    $('lab').hidden = true;
    return false;
  }
  $('lab').hidden = false;
  $('email-down').checked = status.emailDown;
  $('count-pending').textContent = status.pending;
  $('count-sent').textContent = status.sent;
  $('emails').replaceChildren(...status.recent.map((m) => el('li', {}, `${m.to}: ${m.subject}`)));
  return true;
}

/* ---------- início ---------- */

function resumePending() {
  const pending = loadPending();
  if (pending) submit(pending);
}

function init() {
  const now = new Date();
  $('date').value = now.getHours() >= 19 ? addDays(localDate(now), 1) : localDate(now);

  try {
    $('user').value = localStorage.getItem('room-reservation.user') ?? '1';
  } catch {
    // Mantém o valor padrão.
  }

  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadRooms, 200);
  });
  $('user').addEventListener('change', () => {
    try {
      localStorage.setItem('room-reservation.user', userId());
    } catch {
      // Preferência só desta sessão.
    }
    clearResult();
    loadMine();
  });
  const changeDate = (days) => {
    $('date').value = addDays($('date').value, days);
    onDateChange();
  };
  const onDateChange = () => {
    state.selection = null;
    state.availability = null;
    refreshAvailability();
  };
  $('date').addEventListener('change', onDateChange);
  $('prev-day').addEventListener('click', () => changeDate(-1));
  $('next-day').addEventListener('click', () => changeDate(1));
  $('confirm').addEventListener('click', confirmSelection);
  $('race').addEventListener('click', runRace);
  $('email-down').addEventListener('change', async (event) => {
    await api('/api/dev/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ down: event.target.checked }),
    });
    loadLab();
  });

  loadRooms();
  loadMine();
  resumePending();
  loadLab().then((enabled) => {
    if (enabled) setInterval(loadLab, 2000);
  });
  setInterval(() => {
    if (!document.hidden && !state.confirming) refreshAvailability();
  }, 5000);
}

init();
