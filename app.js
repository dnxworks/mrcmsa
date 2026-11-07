// ===== 1. SETUP =====
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const STAFF = ['mrc', 'principal', 'officer', 'fellow'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

let me = null;            // the logged-in person (row from "profiles")
let facilities = [];      // MPH and MPC
let rotation = [];        // weekday evening sports
let facId = null;         // facility chosen on the calendar
let selDate = '';         // date chosen on the calendar (YYYY-MM-DD)
let calYear = 0, calMonth = 0;
let slots = [];           // booked slots of the visible month
let currentView = 'book';
let openBookingId = null; // booking shown on the summary page
let adminTab = 'pending';
let known = {};           // booking id -> last known status (to tell the student when it changes)
let channel = null;       // live updates

// Status texts and colors
const STATUS = {
  pending:    { icon: '⏳', title: 'Waiting for MRC approval', tag: 'Pending', cls: '' },
  approved:   { icon: '✅', title: 'Booking confirmed by MRC', tag: 'Approved', cls: 'green' },
  rejected:   { icon: '❌', title: 'Rejected by MRC', tag: 'Rejected', cls: 'red' },
  cancelled:  { icon: '🚫', title: 'Cancelled', tag: 'Cancelled', cls: 'grey' },
  overridden: { icon: '📢', title: 'Cancelled by MRC for a program', tag: 'Overridden', cls: 'red' },
  no_show:    { icon: '⚠️', title: 'Marked as no-show or late', tag: 'No-show', cls: 'red' },
};

// Small helpers
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hm = (t) => t.slice(0, 5);
const ref = (id) => 'SR-' + String(id).padStart(5, '0');
const isStaff = () => STAFF.includes(me.role);
const isMrc = () => me.role === 'mrc';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }); // YYYY-MM-DD
const isoDow = (d) => ((new Date(d + 'T00:00:00').getDay() + 6) % 7) + 1; // Monday = 1
const prettyDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const prettyStamp = (t) => new Date(t).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' });
const tag = (status) => `<span class="tag ${STATUS[status].cls}">${STATUS[status].tag}</span>`;

function say(text) { // short message at the top
  $('msg').textContent = text;
  $('msg').classList.remove('hidden');
  clearTimeout(say.t);
  say.t = setTimeout(() => $('msg').classList.add('hidden'), 4000);
}

// ===== 2. LOGIN =====
$('googleBtn').onclick = () => db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
$('logout').onclick = () => db.auth.signOut();

$('adminForm').onsubmit = async (e) => {
  e.preventDefault();
  const { error } = await db.auth.signInWithPassword({ email: $('aEmail').value, password: $('aPass').value });
  if (error) say(error.message);
};

// Runs on page load, login and logout
db.auth.onAuthStateChange((event, session) => {
  setTimeout(async () => { // setTimeout avoids a known Supabase freeze
    if (!session) {
      me = null;
      if (channel) { db.removeChannel(channel); channel = null; }
      $('login').classList.remove('hidden');
      $('app').classList.add('hidden');
      $('logout').classList.add('hidden');
      $('hello').textContent = 'MPH and MPC booking';
      return;
    }
    if (me && me.id === session.user.id) return; // already started
    await refreshMe(session.user.id);
    startApp();
  }, 0);
});

async function refreshMe(id) {
  const { data } = await db.from('profiles').select('*').eq('id', id || me.id).single();
  me = data;
  showBan();
}

async function startApp() {
  const f = await db.from('facilities').select('*').order('id');
  const r = await db.from('rotation').select('*').order('weekday');
  facilities = f.data || [];
  rotation = r.data || [];
  facId = facilities[0]?.id;

  // facility drop-downs and tabs
  const options = facilities.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  ['pFac', 'fbFac', 'oFac'].forEach((id) => ($(id).innerHTML = options));
  $('facTabs').innerHTML = facilities.map((x) => `<button type="button" data-id="${x.id}">${esc(x.name)}</button>`).join('');
  document.querySelectorAll('#facTabs button').forEach((b) => (b.onclick = () => { facId = Number(b.dataset.id); loadCalendar(); }));

  // role based screen
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  $('hello').textContent = `Hi, ${me.full_name || me.email} (${me.role})`;
  document.querySelectorAll('.staff-only').forEach((el) => el.classList.toggle('hidden', !isStaff()));
  document.querySelectorAll('.mrc-only').forEach((el) => el.classList.toggle('hidden', !isMrc()));
  $('eveningText').textContent = EVENING_TEXT;

  // dates and saved details
  const t = today();
  selDate = t;
  calYear = Number(t.slice(0, 4));
  calMonth = Number(t.slice(5, 7)) - 1;
  ['bDate', 'pDate', 'fbDate', 'oDate'].forEach((id) => { $(id).value = t; });
  ['bDate', 'pDate', 'oDate'].forEach((id) => { $(id).min = t; });
  $('fbDate').max = t;
  fillMyDetails();

  listenLive();
  show(isStaff() ? 'admin' : 'book');
}

function fillMyDetails() { // saved details from the last booking
  $('bName').value = $('pPerson').value = me.full_name || '';
  $('bMatric').value = $('pMatric').value = me.matric || '';
  $('bPhone').value = $('pPhone').value = me.phone || '';
  $('bRoom').value = $('pRoom').value = me.room || '';
  $('bClub').value = me.club || '';
}

function showBan() { // red notice if the person is banned
  const banned = me.banned_until && today() < me.banned_until;
  const text = `You cannot make bookings until ${prettyDate(me.banned_until)} because of a no-show, late arrival or late cancellation.`;
  [$('banBox'), $('banBox2')].forEach((box) => {
    box.textContent = banned ? text : '';
    box.classList.toggle('hidden', !banned);
  });
}

// ===== 3. SWITCHING SCREENS =====
const LOADERS = { book: loadCalendar, program: loadProgram, mine: loadMine, summary: loadSummary, feedback: loadFeedback, rules: loadRules, admin: loadAdmin };

function show(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(view).classList.remove('hidden');
  const navView = view === 'summary' ? 'mine' : view;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === navView));
  window.scrollTo(0, 0);
  LOADERS[view]();
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => show(b.dataset.view)));
document.querySelectorAll('[data-go]').forEach((el) => (el.onclick = (e) => { e.preventDefault(); show(el.dataset.go); }));

function refreshView() { // reload the screen the person is looking at
  if (me && ['book', 'mine', 'admin', 'summary'].includes(currentView)) LOADERS[currentView]();
}

// ===== 4. LIVE UPDATES =====
function listenLive() {
  if (channel) db.removeChannel(channel);
  channel = db.channel('live-bookings')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, (payload) => {
      const b = payload.new;
      if (b && b.id && b.user_id === me.id && known[b.id] && known[b.id] !== b.status) {
        say(`${ref(b.id)}: ${STATUS[b.status].title}`);
        if (b.status === 'no_show') refreshMe();
      }
      if (b && b.id) known[b.id] = b.status;
      refreshView();
    })
    .subscribe();
}
setInterval(() => { if (me) refreshView(); }, 30000); // safety: refresh every 30 seconds

// ===== 5. CALENDAR + BOOKING FORM =====
async function loadCalendar() {
  document.querySelectorAll('#facTabs button').forEach((b) => b.classList.toggle('on', Number(b.dataset.id) === facId));
  const from = `${calYear}-${pad(calMonth + 1)}-01`;
  const to = `${calYear}-${pad(calMonth + 1)}-${pad(new Date(calYear, calMonth + 1, 0).getDate())}`;
  const { data } = await db.rpc('calendar_slots', { p_from: from, p_to: to });
  slots = data || [];
  drawCalendar();
  drawSlots();
  ruleHint();
}

function drawCalendar() {
  $('monthTitle').textContent = new Date(calYear, calMonth, 1).toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
  const first = (new Date(calYear, calMonth, 1).getDay() + 6) % 7; // Monday first
  const total = new Date(calYear, calMonth + 1, 0).getDate();
  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dn">${d}</div>`).join('');
  html += '<div></div>'.repeat(first);
  for (let d = 1; d <= total; d++) {
    const date = `${calYear}-${pad(calMonth + 1)}-${pad(d)}`;
    const day = slots.filter((s) => s.facility_id === facId && s.booking_date === date);
    const dots = (day.some((s) => s.status === 'pending') ? '<span class="dot gold"></span>' : '')
      + (day.some((s) => s.status === 'approved' && s.kind === 'court') ? '<span class="dot red"></span>' : '')
      + (day.some((s) => s.kind === 'program') ? '<span class="dot blue"></span>' : '');
    const cls = ['day', date === today() ? 'today' : '', date === selDate ? 'sel' : ''].join(' ');
    html += `<button type="button" class="${cls}" data-date="${date}" ${date < today() ? 'disabled' : ''}>${d}<span class="dots">${dots}</span></button>`;
  }
  $('calendar').innerHTML = html;
  document.querySelectorAll('#calendar button.day').forEach((b) => (b.onclick = () => pickDate(b.dataset.date)));
  $('prevMonth').disabled = calYear + '-' + pad(calMonth + 1) <= today().slice(0, 7);
}

function drawSlots() { // list of what is already booked on the chosen day
  $('dayTitle').textContent = `Booked on ${prettyDate(selDate)}`;
  const day = slots.filter((s) => s.facility_id === facId && s.booking_date === selDate);
  $('slots').innerHTML = day.length
    ? day.map((s) => `<div class="item"><b>${hm(s.start_time)} to ${hm(s.end_time)}</b>
        <span>${esc(s.label)} ${s.kind === 'program' ? '<span class="tag blue">Program</span>' : ''}
        <span class="tag ${s.status === 'approved' ? 'red' : ''}">${s.status === 'approved' ? 'Booked' : 'Waiting approval'}</span></span></div>`).join('')
    : '<p>No bookings yet. The whole day is free.</p>';
}

function pickDate(date) {
  selDate = date;
  $('bDate').value = date;
  drawCalendar();
  drawSlots();
  ruleHint();
}

$('prevMonth').onclick = () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } loadCalendar(); };
$('nextMonth').onclick = () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } loadCalendar(); };
$('bDate').onchange = () => {
  if (!$('bDate').value) return;
  selDate = $('bDate').value;
  calYear = Number(selDate.slice(0, 4));
  calMonth = Number(selDate.slice(5, 7)) - 1;
  loadCalendar();
};

function ruleHint() { // tells the student the evening rule for the chosen day
  const fac = facilities.find((f) => f.id === facId);
  let text = '';
  if (fac && fac.evening_rules && selDate) {
    const dow = isoDow(selDate);
    if (dow >= 6) text = `${DAY_NAMES[dow - 1]} evening (${EVENING_TEXT}) is only for University Bodies programs. Use the Program tab for those.`;
    else {
      const r = rotation.find((x) => x.weekday === dow);
      if (r) text = `${DAY_NAMES[dow - 1]} evening (${EVENING_TEXT}) is for ${r.sport}.`;
    }
  }
  $('hint').textContent = text;
  $('hint').classList.toggle('hidden', !text);
}

$('bookForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!$('agree').checked) return say('Please tick that you have read the rules.');
  const { data, error } = await db.rpc('request_booking', {
    p_facility: facId, p_date: $('bDate').value, p_start: $('bStart').value, p_end: $('bEnd').value,
    p_sport: $('bSport').value, p_purpose: $('bPurpose').value,
    p_name: $('bName').value, p_matric: $('bMatric').value, p_phone: $('bPhone').value,
    p_room: $('bRoom').value, p_club: $('bClub').value,
    p_residency: $('bRes').value, p_participants: Number($('bPeople').value),
    p_kind: 'court',
  });
  if (error) return say(error.message);
  await refreshMe();
  say('Request sent. Waiting for MRC approval.');
  openSummary(data);
};

// ===== 6. PROGRAM BOOKING =====
function loadProgram() {
  $('docList').innerHTML = PROGRAM_DOCUMENTS.map((d) => `<div class="item">
      <span><b>${esc(d.name)}</b><br><small>${esc(d.note)}</small></span>
      ${d.file ? `<a class="btn" href="${esc(d.file)}" target="_blank" rel="noopener">Download</a>` : ''}</div>`).join('');
}

$('progForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!$('pAgree').checked) return say('Please tick that you have filled in the documents.');
  const { data, error } = await db.rpc('request_booking', {
    p_facility: Number($('pFac').value), p_date: $('pDate').value, p_start: $('pStart').value, p_end: $('pEnd').value,
    p_sport: null, p_purpose: $('pPurpose').value,
    p_name: $('pPerson').value, p_matric: $('pMatric').value, p_phone: $('pPhone').value,
    p_room: $('pRoom').value, p_club: $('pClub').value,
    p_residency: null, p_participants: Number($('pPeople').value),
    p_kind: 'program', p_program_name: $('pName').value, p_docs_link: $('pDocs').value,
  });
  if (error) return say(error.message);
  await refreshMe();
  say('Program request sent. Waiting for MRC approval.');
  openSummary(data);
};

// ===== 7. MY BOOKINGS =====
async function loadMine() {
  const { data } = await db.from('bookings').select('*, facilities(name)').eq('user_id', me.id)
    .order('booking_date', { ascending: false }).order('start_time', { ascending: false });
  (data || []).forEach((b) => (known[b.id] = b.status));
  $('myBookings').innerHTML = (data || []).map((b) => `<div class="item">
      <span><b>${esc(b.facilities.name)}</b> ${tag(b.status)}<br>
        <small>${ref(b.id)} · ${prettyDate(b.booking_date)}, ${hm(b.start_time)} to ${hm(b.end_time)}${b.kind === 'program' ? ' · Program' : ''}</small></span>
      <span class="btns"><button class="alt small-btn" onclick="openSummary(${b.id})">${b.status === 'approved' ? 'Slip' : 'View'}</button>
      ${['pending', 'approved'].includes(b.status) && b.booking_date >= today()
        ? `<button class="small-btn" onclick="cancelMine(${b.id},'${b.status}','${b.booking_date}','${b.start_time}')">Cancel</button>` : ''}</span></div>`).join('')
    || '<p>No bookings yet. Go to Book to make one.</p>';
}

async function cancelMine(id, status, date, start) {
  let warning = 'Cancel this booking?';
  if (status === 'approved' && new Date(`${date}T${start}`) - new Date() < 3 * 3600 * 1000) {
    warning = 'This is less than 3 hours before your booking. If you cancel now, you cannot book for 3 days. Cancel anyway?';
  }
  if (!confirm(warning)) return;
  const { data, error } = await db.rpc('cancel_booking', { p_id: id });
  if (error) return say(error.message);
  if (data === 'late') { await refreshMe(); say('Cancelled. You cannot book for 3 days.'); } else say('Booking cancelled.');
  refreshView();
}

// ===== 8. SUMMARY AND BOOKING SLIP =====
function openSummary(id) { openBookingId = id; show('summary'); }

async function loadSummary() {
  const { data: b } = await db.from('bookings').select('*, facilities(name)').eq('id', openBookingId).single();
  if (!b) { $('sumBody').innerHTML = '<p>Booking not found.</p>'; return; }
  known[b.id] = b.status;
  const s = STATUS[b.status];
  const sub = {
    pending: 'This page updates by itself when the MRC replies.',
    approved: 'Show the slip below at the court. Print it or save it as PDF.',
    rejected: b.admin_note ? `Reason: ${esc(b.admin_note)}` : 'You can send a new request for another time.',
    overridden: esc(b.admin_note || ''),
    cancelled: 'This booking was cancelled.',
    no_show: 'You cannot book for 3 days.',
  }[b.status];

  let html = `<div class="status ${b.status}"><div class="big">${s.icon}</div><h2>${s.title}</h2><div>${sub}</div></div>`;
  if (b.status === 'approved') {
    html += slipHTML(b) + '<button class="noprint" style="width:100%" onclick="window.print()">Print or save as PDF</button>';
  } else {
    html += `<div class="card"><h2>Booking summary</h2>${rowsHTML(b)}</div>`;
  }
  $('sumBody').innerHTML = html;
}

function detailRows(b) { // the details shown in the summary and on the slip
  return [
    ['Reference', ref(b.id)],
    ['Name', b.full_name], ['Matric no.', b.matric], ['Phone', b.phone], ['Room', b.room],
    ['Club', b.club || '-'],
    ['Facility', b.facilities.name],
    ...(b.kind === 'program' ? [['Program', b.program_name]] : [['Activity', b.sport]]),
    ['Purpose', b.purpose],
    ['Date', prettyDate(b.booking_date)],
    ['Time', `${hm(b.start_time)} to ${hm(b.end_time)}`],
    ['Participants', b.participants],
    ...(b.residency ? [['Resident?', b.residency === 'resident' ? 'Resident' : 'Non-resident']] : []),
  ];
}
const rowsHTML = (b) => detailRows(b).map(([k, v]) => `<div class="item"><span>${k}</span><b>${esc(v)}</b></div>`).join('');

function slipHTML(b) {
  return `<div class="slip">
    <div class="slip-head"><img src="assets/logo.jpeg" alt=""><div><b>Mahallah Salahuddin Al-Ayyubi</b><br>Facility Booking Slip</div></div>
    <div class="stamp">CONFIRMED BY MRC</div>
    ${rowsHTML(b)}
    <div class="item"><span>Confirmed by</span><b>${esc(b.approved_by_name)}</b></div>
    <div class="item"><span>Confirmed on</span><b>${prettyStamp(b.reviewed_at)}</b></div>
    <p class="small" style="margin-top:10px">Please start on time. A no-show, arriving more than 15 minutes late or a last-minute cancellation can lead to a 3-day booking ban.</p>
  </div>`;
}

// ===== 9. FEEDBACK =====
$('fbForm').onsubmit = async (e) => {
  e.preventDefault();
  const issue = $('fbIssue').value;
  const { error } = await db.from('feedback').insert({
    user_id: me.id, full_name: me.full_name, facility_id: $('fbFac').value, used_on: $('fbDate').value,
    rating: Number($('fbRate').value), issue_type: issue, comment: $('fbText').value,
    status: issue === 'No problem' ? 'none' : 'open',
  });
  if (error) return say(error.message);
  say('Thank you for your feedback.');
  $('fbText').value = '';
  loadFeedback();
};

async function loadFeedback() {
  $('fbListTitle').textContent = isStaff() ? 'All feedback' : 'My feedback';
  const { data } = await db.from('feedback').select('*, facilities(name)').order('created_at', { ascending: false }).limit(100);
  const list = data || [];

  // staff see the average rating per facility and the open issues
  if (isStaff() && list.length) {
    const open = list.filter((f) => ['open', 'in_progress'].includes(f.status)).length;
    const avg = (list.reduce((sum, f) => sum + f.rating, 0) / list.length).toFixed(1);
    $('fbStats').innerHTML = `<div><b>${list.length}</b>feedback</div><div><b>${avg} / 5</b>average rating</div><div><b>${open}</b>open issues</div>`;
  } else $('fbStats').innerHTML = '';

  const label = { none: '', open: 'Open', in_progress: 'In progress', fixed: 'Fixed' };
  const color = { open: 'red', in_progress: '', fixed: 'green' };
  $('fbList').innerHTML = list.map((f) => `<div class="item">
      <span><b>${esc(f.facilities?.name)}</b> · ${'★'.repeat(f.rating)}<br>
        <small>${f.used_on} · ${esc(f.issue_type)}${isStaff() ? ' · ' + esc(f.full_name) : ''}</small><br>${esc(f.comment)}</span>
      <span>${f.status === 'none' ? '' : `<span class="tag ${color[f.status]}">${label[f.status]}</span>`}
      ${isMrc() && f.status !== 'none' ? `<select onchange="setFeedback(${f.id}, this.value)">
          ${['open', 'in_progress', 'fixed'].map((s) => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${label[s]}</option>`).join('')}</select>` : ''}</span></div>`).join('')
    || '<p>No feedback yet.</p>';
}

async function setFeedback(id, status) {
  const { error } = await db.from('feedback').update({ status }).eq('id', id);
  if (error) say(error.message); else loadFeedback();
}

// ===== 10. RULES + ROTATION =====
function loadRules() {
  $('rotationView').innerHTML = rotation.map((r) => `<div class="item"><span>${DAY_NAMES[r.weekday - 1]}</span><b>${esc(r.sport)}</b></div>`).join('')
    || '<p>Rotation not set yet.</p>';
  $('contacts').innerHTML = CONTACTS.map((c) => `<div class="item"><span>${esc(c.name)}<br><small>${esc(c.phone)}</small></span>
      <a class="btn" href="https://wa.me/${c.wa}" target="_blank" rel="noopener">WhatsApp</a></div>`).join('');
  if (isMrc()) {
    $('rotationEdit').innerHTML = rotation.map((r) => `<label for="rot${r.weekday}">${DAY_NAMES[r.weekday - 1]}</label>
      <select id="rot${r.weekday}">${['Volleyball', 'Netball', 'Futsal'].map((s) => `<option ${s === r.sport ? 'selected' : ''}>${s}</option>`).join('')}</select>`).join('')
      + '<button class="alt" style="margin-top:14px" onclick="saveRotation()">Save rotation</button>';
  }
}

async function saveRotation() {
  const rows = rotation.map((r) => ({ weekday: r.weekday, sport: $('rot' + r.weekday).value }));
  const { error } = await db.from('rotation').upsert(rows);
  if (error) return say(error.message);
  rotation = rows;
  say('Rotation saved.');
  loadRules();
}

// ===== 11. ADMIN: REQUESTS, APPROVE/REJECT, NO-SHOW, OVERRIDE =====
document.querySelectorAll('#adminTabs button').forEach((b) => (b.onclick = () => { adminTab = b.dataset.tab; loadAdmin(); }));

async function loadAdmin() {
  document.querySelectorAll('#adminTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === adminTab));
  let q = db.from('bookings').select('*, facilities(name)').limit(100);
  if (adminTab === 'pending') q = q.eq('status', 'pending').order('booking_date').order('start_time');
  else if (adminTab === 'approved') q = q.eq('status', 'approved').order('booking_date', { ascending: false }).order('start_time');
  else q = q.order('created_at', { ascending: false });
  const { data } = await q;
  $('adminList').innerHTML = (data || []).map(adminCard).join('') || '<p>Nothing here.</p>';
}

function adminCard(b) {
  const started = new Date(`${b.booking_date}T${b.start_time}`) <= new Date();
  let buttons = '';
  if (isMrc() && b.status === 'pending') {
    buttons = `<button class="green small-btn" onclick="review(${b.id},'approved')">Approve</button>
      ${b.kind === 'program' ? `<button class="alt small-btn" onclick="review(${b.id},'approved',true)">Approve + override</button>` : ''}
      <button class="small-btn" onclick="review(${b.id},'rejected')">Reject</button>`;
  } else if (isMrc() && b.status === 'approved') {
    buttons = (started ? `<button class="small-btn" onclick="noShow(${b.id})">No-show / late</button>` : '')
      + `<button class="ghost small-btn" onclick="adminCancel(${b.id})">Cancel</button>`;
  }
  return `<div class="item" style="align-items:flex-start">
    <span><b>${esc(b.facilities.name)}</b> ${tag(b.status)} ${b.kind === 'program' ? '<span class="tag blue">Program</span>' : ''}<br>
      <small>${ref(b.id)} · ${prettyDate(b.booking_date)}, ${hm(b.start_time)} to ${hm(b.end_time)}</small><br>
      ${esc(b.full_name)} · ${esc(b.matric)} · ${esc(b.phone)} · Room ${esc(b.room)}<br>
      ${b.kind === 'program'
        ? `<b>${esc(b.program_name)}</b> (${esc(b.club)}) · ${b.participants || '-'} people ${b.docs_link ? `· <a href="${esc(b.docs_link)}" target="_blank" rel="noopener">Documents</a>` : ''}`
        : `${esc(b.sport)} · ${esc(b.purpose)} · ${b.participants} people · ${b.residency === 'resident' ? 'Resident' : 'Non-resident'}${b.club ? ' · ' + esc(b.club) : ''}`}
      ${b.admin_note ? `<br><small>Note: ${esc(b.admin_note)}</small>` : ''}</span>
    <span class="btns">${buttons}</span></div>`;
}

async function review(id, decision, override = false) {
  let note = null;
  if (decision === 'rejected') {
    note = prompt('Reason for rejecting (the student will see this):');
    if (note === null) return;
  }
  if (override && !confirm('Approve this program and cancel any other bookings at the same time?')) return;
  const { error } = await db.rpc('review_booking', { p_id: id, p_decision: decision, p_note: note, p_override: override });
  if (error) return say(error.message);
  say(decision === 'approved' ? 'Booking approved.' : 'Booking rejected.');
  loadAdmin();
}

async function noShow(id) {
  if (!confirm('Mark as no-show or late? This person cannot book for 3 days.')) return;
  const { error } = await db.rpc('mark_no_show', { p_id: id });
  if (error) return say(error.message);
  say('Marked. 3-day booking ban applied.');
  loadAdmin();
}

async function adminCancel(id) {
  if (!confirm('Cancel this approved booking?')) return;
  const { error } = await db.rpc('cancel_booking', { p_id: id });
  if (error) return say(error.message);
  say('Booking cancelled.');
  loadAdmin();
}

$('overrideForm').onsubmit = async (e) => {
  e.preventDefault();
  const fac = Number($('oFac').value);
  // count the student bookings that will be cancelled
  const { data: clash } = await db.from('bookings').select('id').eq('facility_id', fac).eq('booking_date', $('oDate').value)
    .eq('kind', 'court').in('status', ['pending', 'approved']).lt('start_time', $('oEnd').value).gt('end_time', $('oStart').value);
  const n = (clash || []).length;
  if (!confirm(`Reserve this time for the program? ${n} student booking(s) will be cancelled.`)) return;
  const { error } = await db.rpc('admin_program_override', {
    p_facility: fac, p_date: $('oDate').value, p_start: $('oStart').value, p_end: $('oEnd').value,
    p_program_name: $('oName').value, p_club: $('oClub').value, p_note: $('oNote').value || null,
  });
  if (error) return say(error.message);
  say(`Program reserved. ${n} booking(s) cancelled.`);
  e.target.reset();
  $('oDate').value = today();
  loadAdmin();
};
