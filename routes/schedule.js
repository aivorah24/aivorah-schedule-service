const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const {
  mapRow,
  getStudentProfile,
  scopeAllEvents,
  filterCompleted,
  uuidv4,
} = require('../services/schedule');
const { notifyScheduleEvent } = require('../services/notify');
const { buildICalendar } = require('../services/icalExport');

// ── GET /schedule/teacher?date=YYYY-MM-DD&email=... ──────────────────────────
// schedule_events is the single source of truth for the calendar — assignment
// and challenge deadlines are materialized into it at creation time (see
// assignments.js POST / and challenges.js POST /assign), so this route no
// longer needs to separately re-derive deadline events from those tables.
router.get('/teacher', async (req, res) => {
  const { date, email } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    // Resolve THIS teacher, so the schedule only shows events for the teacher's
    // OWN class — not every event in the system.
    let teacherId = null;
    if (email) {
      const { data: tRow } = await supabase.from('users').select('id').eq('email', String(email).toLowerCase().trim()).maybeSingle();
      teacherId = tRow?.id || null;
    }

    const { data, error } = await supabase
      .from('schedule_events')
      .select('*')
      .eq('event_date', date);
    if (error) throw error;
    let rawEvents = data ?? [];
    // Scope to events THIS teacher created — never every teacher's events in the
    // system. Must filter on the raw created_by_id (a real user id) BEFORE
    // mapRow(), since mapRow's "createdBy" field only carries the role string
    // ('teacher'/'parent'/'student'), not an id — comparing that to teacherId
    // was always false and silently fell through to "any teacher-created event",
    // leaking every teacher's schedule onto every other teacher's calendar.
    if (email && teacherId) {
      // Teachers only see events they (or school admin) created — a parent's
      // events for their child, deadline or personal, are never shown here,
      // even for a student linked to this teacher.
      rawEvents = rawEvents.filter(e => {
        if (e.created_by_id === teacherId || (e.created_by === 'teacher' && !e.created_by_id)) return true;
        if (['school_admin', 'school-admin', 'super_admin'].includes(String(e.created_by || '').toLowerCase())) return true;
        return false;
      });
    }
    let manualEvents = rawEvents.map(mapRow);

    // Resolve student names for non-'all' events
    const studentIds = [...new Set(manualEvents.filter(e => e.studentId && e.studentId !== 'all').map(e => e.studentId))];
    const studentNameMap = {};
    if (studentIds.length > 0) {
      const { data: userRows } = await supabase.from('users').select('id,name').in('id', studentIds);
      (userRows || []).forEach(u => { studentNameMap[u.id] = u.name; });
    }
    manualEvents.forEach(e => {
      if (e.studentId && e.studentId !== 'all') {
        e.studentName = studentNameMap[e.studentId] || null;
      }
    });

    res.json(manualEvents);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /schedule?studentId=xxx&date=YYYY-MM-DD ──────────────
router.get('/', async (req, res) => {
  const { studentId, date, hideCompleted } = req.query;
  if (!studentId || !date) return res.status(400).json({ error: 'studentId and date required' });
  try {
    const [{ data: exactData, error: err1 }, { data: activeDeadlines, error: err2 }, profile] = await Promise.all([
      supabase.from('schedule_events').select('*').eq('event_date', date).or(`student_id.eq.${studentId},student_id.eq.all`),
      supabase.from('schedule_events').select('*').in('type', ['deadline', 'challenge']).gte('event_date', date).or(`student_id.eq.${studentId},student_id.eq.all`),
      getStudentProfile(studentId),
    ]);
    if (err1) throw err1;
    if (err2) throw err2;

    const allMap = new Map();
    (exactData || []).forEach(e => allMap.set(e.id, e));
    (activeDeadlines || []).forEach(e => {
      const start = e.start_date || (e.created_at ? e.created_at.split('T')[0] : e.event_date);
      if (start <= date && e.event_date >= date) {
        allMap.set(e.id, e);
      }
    });
    let rows = Array.from(allMap.values());

    let scopedData = await scopeAllEvents(rows, profile.userId);
    scopedData = await filterCompleted(scopedData, profile.userId);
    if (String(hideCompleted) === 'true') {
      scopedData = scopedData.filter(e => !e.isCompleted);
    }
    res.json((scopedData ?? []).map(mapRow));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /schedule/month?studentId=xxx&year=2026&month=4 ──────
router.get('/month', async (req, res) => {
  const { studentId, year, month, hideCompleted } = req.query;
  if (!studentId || !year || !month) return res.status(400).json({ error: 'studentId, year, month required' });
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  try {
    const [{ data, error }, profile] = await Promise.all([
      supabase.from('schedule_events').select('id,event_date,start_time,end_time,type,note,student_id,created_by,created_by_id,assignment_id,created_at').like('event_date', `${prefix}%`).or(`student_id.eq.${studentId},student_id.eq.all`),
      getStudentProfile(studentId),
    ]);
    if (error) throw error;

    let scopedData = await scopeAllEvents(data, profile.userId);
    scopedData = await filterCompleted(scopedData, profile.userId);
    if (String(hideCompleted) === 'true') {
      scopedData = scopedData.filter(e => !e.isCompleted);
    }
    const dates = [...new Set((scopedData ?? []).map(e => e.event_date))];
    res.json({ dates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /schedule/upcoming?studentId=xxx ────────────────────
router.get('/upcoming', async (req, res) => {
  const { studentId, hideCompleted } = req.query;
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  const today = new Date().toISOString().split('T')[0];
  try {
    // Assignment deadlines are type='deadline', challenge deadlines are type='challenge'.
    const [{ data, error }, profile] = await Promise.all([
      supabase.from('schedule_events').select('*').in('type', ['deadline', 'challenge']).gte('event_date', today).or(`student_id.eq.${studentId},student_id.eq.all`).order('event_date', { ascending: true }),
      getStudentProfile(studentId),
    ]);
    if (error) throw error;

    let scopedData = await scopeAllEvents(data, profile.userId);
    scopedData = await filterCompleted(scopedData, profile.userId);
    if (String(hideCompleted) === 'true') {
      scopedData = scopedData.filter(e => !e.isCompleted);
    }
    const all = (scopedData ?? []).map(mapRow)
      .sort((a, b) => (a.date > b.date ? 1 : -1))
      .slice(0, 5);

    res.json(all);
  } catch (err) { res.status(500).json({ error: err.message }); }

});

// ── GET /schedule/event/:id — single event, for notification deep-links ──
// The day/week/month views only ever fetch events for a date range already
// visible on screen, so a notification pointing at an event outside the
// current week (the common case) had nothing to open it with. This is the
// single-event lookup that was missing.
router.get('/event/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('schedule_events').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Event not found' });
    res.json(mapRow(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /schedule ───────────────────────────────────────────
router.post('/', async (req, res) => {
  const { title, date, startTime, endTime, type = 'study', note, studentId, createdBy, tag, assignmentId, creatorEmail } = req.body;
  if (!title || !date || !startTime || !studentId) {
    return res.status(400).json({ error: 'title, date, startTime, studentId required' });
  }
  const id = uuidv4();
  try {
    // Needed to scope 'all'-student events to just this creator's own linked
    // students (see GET /schedule etc.) — without it, a teacher's "all students"
    // event was visible to every student in the database, not just their class.
    let creatorId = null;
    if (creatorEmail) {
      const { data: creatorRow } = await supabase.from('users').select('id').eq('email', creatorEmail.toLowerCase().trim()).maybeSingle();
      creatorId = creatorRow?.id || null;
    }

    const { data, error } = await supabase
      .from('schedule_events')
      .insert({
        id,
        title,
        event_date:    date,
        start_time:    startTime,
        end_time:      endTime    || '',
        type,
        note:          note       || '',
        student_id:    studentId,
        created_by:    createdBy  || studentId,
        created_by_id: creatorId,
        tag:           tag        || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.json(mapRow(data));

    notifyScheduleEvent({ event: data, createdBy, creatorEmail });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH / PUT /schedule/:id ────────────────────────────────
async function handleUpdateSchedule(req, res) {
  const { id } = req.params;
  const { startTime, endTime, title, date, event_date, type, note, tag, isCompleted, studentId } = req.body;
  try {
    const updates = {};
    if (startTime !== undefined) updates.start_time = startTime;
    if (endTime !== undefined) updates.end_time = endTime;
    if (title !== undefined) updates.title = title;
    if (date !== undefined) updates.event_date = date;
    if (event_date !== undefined) updates.event_date = event_date;
    if (type !== undefined) updates.type = type;
    if (note !== undefined) updates.note = note;
    if (tag !== undefined) updates.tag = tag;
    if (isCompleted !== undefined) updates.isCompleted = !!isCompleted;
    if (studentId !== undefined) updates.student_id = studentId;
    const { data, error } = await supabase.from('schedule_events').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json(mapRow(data));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

router.patch('/:id', handleUpdateSchedule);
router.put('/:id', handleUpdateSchedule);

// ── DELETE /schedule/:id ─────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase.from('schedule_events').delete().eq('id', id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tags', (req, res) => {
  res.json({
    assignmentTags: [
      { key: 'learning_experience', label: 'Learning experience', color: '#7FC29B' },
      { key: 'quick_task', label: 'Quick task', color: '#7FB2D6' },
      { key: 'worksheet', label: 'Worksheet', color: '#E3B24C' },
      { key: 'ai_tutor', label: 'AI Tutor', color: '#9B8FE8' },
      { key: 'video_meeting', label: 'Video meeting', color: '#E58AA6' },
      { key: 'ai_challenge', label: 'AI Challenge', color: '#E58AA6' },
      { key: 'live_class', label: 'Live Class', color: '#7FC29B' },
    ],
    eventTags: [
      { key: 'holidays_and_vacations', label: 'Holidays and vacations', color: '#E58AA6' },
      { key: 'whole_school_events', label: 'Whole school events', color: '#7FC29B' },
      { key: 'curriculum_unit_timeline', label: 'MYP Unit Timeline', color: '#E58AA6' },
      { key: 'special_assembly', label: 'Special Assembly', color: '#7FC29B' },
      { key: 'working_day', label: 'Working Day', color: '#C4BCA9' },
      { key: 'rotation_day_cycle', label: 'Rotation Day Cycle', color: '#7FB2D6' },
      { key: 'smarttask_cycle', label: 'SmartTask Cycle Timeline', color: '#E58AA6' },
    ],
  });
});

router.get('/ical', async (req, res) => {
  try {
    const { studentId, email, role } = req.query;

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 30);
    const dateStr = pastDate.toISOString().split('T')[0];

    let query = supabase.from('schedule_events').select('*').gte('event_date', dateStr);

    if (studentId) {
      query = query.or(`student_id.eq.${studentId},student_id.eq.all`);
    }

    if (role === 'teacher' && email) {
      const { data: userData, error: userError } = await supabase.from('users').select('id').eq('email', email).single();
      if (!userError && userData) {
        query = query.eq('created_by_id', userData.id);
      }
    }

    const { data: events, error } = await query;
    if (error) throw error;

    const ical = buildICalendar((events || []).map(mapRow));

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aivorah-schedule.ics"');
    res.send(ical);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
