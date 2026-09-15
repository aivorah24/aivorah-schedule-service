const supabase = require('./supabase');

// ── Row mapper: Supabase snake_case → camelCase ──────────────
function mapRow(e) {
  const startDate = (e.type === 'deadline' || e.type === 'challenge') && e.created_at
    ? e.created_at.split('T')[0]
    : e.event_date;

  let tag = e.tag || null;
  let tagCategory = 'assignment';
  if (!tag) {
    if (e.type === 'challenge') tag = 'AI Challenge';
    else if (e.type === 'deadline') tag = 'Worksheet';
    else if (e.type === 'lesson') tag = 'Live Class';
    else if (e.type === 'break') { tag = 'Working Day'; tagCategory = 'event'; }
    else tag = 'Quick task';
  } else {
    const eventTags = ['Holidays and vacations', 'School holidays', 'Whole school events', 'Curriculum Unit Timeline', 'MYP Unit Timeline', 'Special Assembly', 'Working Day', 'Rotation Day Cycle', 'SmartTask Cycle Tim...'];
    if (eventTags.some(t => String(tag).toLowerCase().includes(t.toLowerCase()))) {
      tagCategory = 'event';
    }
  }

  return {
    id:           e.id,
    title:        e.title,
    date:         e.event_date,
    startTime:    e.start_time,
    endTime:      e.end_time   || '',
    type:         e.type       || 'study',
    note:         e.note       || '',
    studentId:    e.student_id,
    createdBy:    e.created_by || e.student_id,
    tag:          tag,
    tagCategory:  tagCategory,
    assignmentId: e.assignment_id ?? null,
    createdAt:    e.created_at,
    isCompleted:  !!e.isCompleted,
    startDate,
  };
}

// ── Helper: fetch student profile (curriculum + grade) ──────────
async function getStudentProfile(studentId) {
  if (!studentId) return { userId: null, curriculum: null, grade: null };
  // UUID format
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(studentId)) {
    const { data } = await supabase.from('users').select('id,curriculum,grade').eq('id', studentId).single();
    return { userId: data?.id || null, curriculum: data?.curriculum || null, grade: data?.grade || null };
  }
  if (studentId.includes('@')) {
    const { data } = await supabase.from('users').select('id,curriculum,grade').eq('email', studentId).single();
    return { userId: data?.id || null, curriculum: data?.curriculum || null, grade: data?.grade || null };
  }
  return { userId: null, curriculum: null, grade: null };
}

// A teacher's "'all' students" schedule event must only reach the students under
// THAT teacher — not every student in the database. A broadcast whose creator (or
// this student's own profile) can't be resolved is never attributable to "this
// student's teacher" — exclude it rather than falling back to showing it to
// literally everyone (that fallback was the cause of orphaned/unresolved
// broadcasts leaking to the whole database).
async function scopeAllEvents(rows, userId) {
  const teacherAllRows = (rows || []).filter(e => e.student_id === 'all' && e.created_by === 'teacher');
  if (teacherAllRows.length === 0) return rows;

  const linkedTeacherIds = new Set();
  if (userId) {
    const { data: tlinks } = await supabase.from('teacher_student').select('teacher_id').eq('student_id', userId);
    (tlinks || []).forEach(l => { if (l.teacher_id) linkedTeacherIds.add(l.teacher_id); });
  }

  return (rows || []).filter(e => {
    if (e.student_id !== 'all' || e.created_by !== 'teacher') return true;
    if (!e.created_by_id || !userId) return false;
    return linkedTeacherIds.has(e.created_by_id);
  });
}

// A deadline event's underlying assignment/challenge may already be completed by
// THIS student. Instead of deleting the row, we mark it with isCompleted = true
// so the calendar can render it in pastel green with strikethrough OR hide it depending on the toggle.
async function filterCompleted(rows, userId) {
  if (!userId) {
    (rows || []).forEach(e => { e.isCompleted = false; });
    return rows;
  }
  const asgnIds = (rows || []).filter(e => e.type === 'deadline' && e.assignment_id).map(e => e.assignment_id);
  const chalIds = (rows || []).filter(e => e.type === 'challenge' && e.assignment_id).map(e => e.assignment_id);
  if (asgnIds.length === 0 && chalIds.length === 0) {
    (rows || []).forEach(e => { e.isCompleted = false; });
    return rows;
  }

  const [{ data: subs }, { data: chals }] = await Promise.all([
    asgnIds.length > 0
      ? supabase.from('assignment_submissions').select('assignment_id').eq('student_id', userId).eq('status', 'completed').in('assignment_id', asgnIds)
      : Promise.resolve({ data: [] }),
    chalIds.length > 0
      ? supabase.from('challenge_assignments').select('id').eq('status', 'completed').in('id', chalIds)
      : Promise.resolve({ data: [] }),
  ]);
  const completedAsgn = new Set((subs || []).map(s => s.assignment_id));
  const completedChal = new Set((chals || []).map(c => c.id));

  (rows || []).forEach(e => {
    if (e.type === 'deadline' && e.assignment_id) {
      e.isCompleted = completedAsgn.has(e.assignment_id);
    } else if (e.type === 'challenge' && e.assignment_id) {
      e.isCompleted = completedChal.has(e.assignment_id);
    } else {
      e.isCompleted = false;
    }
  });

  return rows;
}

// Fire-and-forget notifications for events scheduled by teacher or parent.
// For a specific student: the student sees it via notifications-summary
// (schedule_events query); parents get a message card in their inbox.
// For 'all': only the teacher's own linked students (scoped by creatorEmail)
// are notified.
async function notifyScheduleEvent({ title, date, startTime, type, studentId, createdBy, creatorEmail }) {
  const actorRole = String(createdBy || '').toLowerCase();
  const isTeacher = actorRole === 'teacher';
  const isParent  = actorRole === 'parent';
  // The student schedule UI sends createdBy as the student's OWN id (see
  // useScheduleEvents.ts's addEvent: `createdBy: studentId`), never the
  // literal string 'student' - so a student scheduling their own event must
  // be recognized here too, or their linked parent never gets notified.
  const isStudent = !!studentId && createdBy === studentId;
  if (!(isTeacher || isParent || isStudent) || !studentId) return;

  try {
    const creatorLabel = isParent ? 'Your parent' : 'Your teacher';
    const msgContent = `${creatorLabel} scheduled "${title}" on ${date}${startTime ? ' at ' + startTime : ''}.`;

    // Students get bell-only notifications (via notifications-summary schedule_events query).
    // Parents get a rich card message in their inbox.
    const notifyParents = async (childId, childName) => {
      const { data: parents } = await supabase.from('parent_children').select('parent_email').eq('child_id', childId);
      // Rich card format: parseable by MessagesScreen renderScheduleCard
      // Format: "SCHEDULE_CARD|childName|title|date|startTime|type"
      const cardContent = `SCHEDULE_CARD|${childName || 'Your child'}|${title}|${date}|${startTime || ''}|${type}`;
      for (const { parent_email } of parents || []) {
        await supabase.from('messages').insert({
          sender_email:    'system@aivorah.com',
          sender_name:     'Aivorah',
          sender_role:     'teacher',
          recipient_email: parent_email,
          recipient_name:  parent_email,
          content:         cardContent,
        });
      }
    };

    if (studentId !== 'all') {
      const { data: stu } = await supabase.from('users').select('id,name').eq('id', studentId).maybeSingle();
      await notifyParents(studentId, stu?.name || 'Your child');
    } else if (isTeacher && creatorEmail) {
      const { data: tRow } = await supabase.from('users').select('id').eq('email', creatorEmail.toLowerCase().trim()).maybeSingle();
      if (tRow?.id) {
        const { data: links } = await supabase.from('teacher_student').select('student_id').eq('teacher_id', tRow.id);
        const sIds = (links || []).map(l => l.student_id).filter(Boolean);
        if (sIds.length > 0) {
          const { data: studs } = await supabase.from('users').select('id,name').in('id', sIds);
          for (const s of studs || []) await notifyParents(s.id, s.name);
        }
      }
    }
  } catch (_) { /* notifications are best-effort */ }
}

function uuidv4() {
  return 'ev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

module.exports = {
  mapRow,
  getStudentProfile,
  scopeAllEvents,
  filterCompleted,
  notifyScheduleEvent,
  uuidv4,
};
