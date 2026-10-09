// Notifications for events a teacher, parent or student puts on a student's calendar.
// V2: one stored notification per recipient via the DB function notify_event()
// (aivorah-db 0006 + 0010), which also fans out to parents and skips the creator.
// Legacy push + parent inbox cards run alongside until V2 push ships. Never throws.
const supabase = require('./supabase');
const { sendPush } = require('./push');

function logEvent(fields) {
  console.log(JSON.stringify({ svc: 'schedule', ...fields }));
}

const norm = (e) => String(e || '').toLowerCase().trim();

// Who created the event. Teachers/parents send createdBy + creatorEmail; the student
// screen sends createdBy = its own id. The users table decides the role, not the client.
async function resolveActor({ createdBy, creatorEmail, studentId }) {
  if (creatorEmail) {
    const { data } = await supabase.from('users').select('id, email, role').eq('email', norm(creatorEmail)).maybeSingle();
    return data ? { id: data.id, email: norm(data.email), role: norm(data.role) } : null;
  }
  if (createdBy && studentId && createdBy === studentId) {
    const { data } = await supabase.from('users').select('id, email, role').eq('id', studentId).maybeSingle();
    return data ? { id: data.id, email: norm(data.email), role: 'student' } : null;
  }
  return null;
}

// Students the event is for. 'all' means the teacher's own linked students, never the
// whole school; a specific student must be linked to the teacher / parent who created it.
async function resolveStudentIds({ studentId, actor }) {
  if (!actor || !studentId) return [];
  if (actor.role === 'teacher') {
    let q = supabase.from('teacher_student').select('student_id').eq('teacher_id', actor.id);
    if (studentId !== 'all') q = q.eq('student_id', studentId);
    const { data } = await q;
    return [...new Set((data || []).map(l => l.student_id).filter(Boolean))];
  }
  if (studentId === 'all') return [];
  if (actor.role === 'parent') {
    // parent_email has no case rule (notify_event compares lower()), so match in JS.
    const { data } = await supabase.from('parent_children').select('parent_email').eq('child_id', studentId);
    return (data || []).some(l => norm(l.parent_email) === actor.email) ? [studentId] : [];
  }
  if (actor.role === 'student') return actor.id === studentId ? [studentId] : [];
  return [];
}

function formatWhen(date, startTime) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = Number.isFinite(d.getTime())
    ? d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    : date;
  return [day, startTime || null].filter(Boolean).join(' · ');
}

const CREATOR_LABEL = { teacher: 'your teacher', parent: 'your parent', student: 'you' };

function scheduleEventNotification(row, { studentIds, actor }) {
  const when = formatWhen(row.event_date, row.start_time);
  return {
    type: 'event_scheduled',
    entity_type: 'schedule_event',
    entity_id: String(row.id),
    version: row.created_at,
    student_ids: studentIds,
    actor_email: actor.email || null,
    actor_role: actor.role,
    title: `New event: ${row.title}`,
    body: [when, `from ${CREATOR_LABEL[actor.role] || 'school'}`].filter(Boolean).join(' · '),
    parent_title: `New event for {child}: ${row.title}`,
    parent_body: when || null,
    data: {
      eventId: String(row.id),
      date: row.event_date,
      startTime: row.start_time || null,
      eventType: row.type || null,
      creatorRole: actor.role,
    },
  };
}

async function createNotificationEvent(evt) {
  const base = { evt: 'notification.create', type: evt.type, entityType: evt.entity_type, entity: evt.entity_id };
  if (!evt.student_ids.length) {
    logEvent({ ...base, ok: true, recipients: 0, inserted: 0, reason: 'no eligible students' });
    return { ok: true, inserted: [] };
  }
  try {
    const { data, error } = await supabase.rpc('notify_event', { p_event: evt });
    if (error) throw new Error(error.message);
    const inserted = data?.inserted ?? [];
    logEvent({ ...base, ok: true, students: evt.student_ids.length, recipients: data?.recipients ?? 0, inserted: inserted.length, duplicates: data?.duplicates ?? 0 });
    return { ok: true, inserted };
  } catch (err) {
    logEvent({ ...base, ok: false, students: evt.student_ids.length, reason: err.message });
    return { ok: false, inserted: [] };
  }
}

// Legacy parent inbox card (MessagesScreen renderScheduleCard). One per parent per child, never to the creator.
async function sendParentCards(row, studentIds, actor) {
  if (!studentIds.length) return;
  const [{ data: kids }, { data: links }] = await Promise.all([
    supabase.from('users').select('id, name').in('id', studentIds),
    supabase.from('parent_children').select('parent_email, child_id').in('child_id', studentIds),
  ]);
  const nameOf = Object.fromEntries((kids || []).map(k => [k.id, k.name]));
  const seen = new Set();
  const cards = [];
  for (const { parent_email, child_id } of links || []) {
    const email = norm(parent_email);
    const key = `${email}|${child_id}`;
    if (!email || email === actor.email || seen.has(key)) continue;
    seen.add(key);
    cards.push({
      sender_email: 'system@aivorah.com',
      sender_name: 'Aivorah',
      sender_role: 'teacher',
      recipient_email: email,
      recipient_name: email,
      content: `SCHEDULE_CARD|${nameOf[child_id] || 'Your child'}|${row.title}|${row.event_date}|${row.start_time || ''}|${row.type}`,
    });
  }
  if (cards.length) await supabase.from('messages').insert(cards);
}

// One push per audience: students get "New event", each parent gets it per child by name.
async function pushInserted(row, inserted) {
  const ids = [...new Set(inserted.flatMap(r => [r.recipient_id, r.child_id]).filter(Boolean))];
  if (!ids.length) return;
  const { data: users } = await supabase.from('users').select('id, email, name').in('id', ids);
  const byId = Object.fromEntries((users || []).map(u => [u.id, u]));
  const groups = new Map();
  for (const r of inserted) {
    const email = byId[r.recipient_id]?.email;
    if (!email) continue;
    const title = r.child_id
      ? `New event for ${byId[r.child_id]?.name || 'your child'}: ${row.title}`
      : `New event: ${row.title}`;
    if (!groups.has(title)) groups.set(title, new Set());
    groups.get(title).add(email);
  }
  const body = formatWhen(row.event_date, row.start_time) || 'Tap to view';
  for (const [title, emails] of groups) {
    // Events sit under the Assignment Alerts toggle, same as the in-app bell.
    await sendPush([...emails], { title, body, data: { type: 'event', eventId: String(row.id) }, prefKey: 'assignmentAlerts' });
  }
}

async function notifyScheduleEvent({ event, createdBy, creatorEmail }) {
  try {
    const actor = await resolveActor({ createdBy, creatorEmail, studentId: event.student_id });
    if (!actor || !['teacher', 'parent', 'student'].includes(actor.role)) {
      logEvent({ evt: 'notification.create', ok: true, entity: String(event.id), inserted: 0, reason: 'creator not a teacher, parent or student' });
      return;
    }
    const studentIds = await resolveStudentIds({ studentId: event.student_id, actor });
    const { inserted } = await createNotificationEvent(scheduleEventNotification(event, { studentIds, actor }));
    await Promise.all([
      pushInserted(event, inserted).catch(() => {}),
      sendParentCards(event, studentIds, actor).catch(() => {}),
    ]);
  } catch (err) {
    logEvent({ evt: 'notification.create', ok: false, entity: String(event?.id), reason: err.message });
  }
}

module.exports = { notifyScheduleEvent, resolveActor, resolveStudentIds, scheduleEventNotification, formatWhen };
