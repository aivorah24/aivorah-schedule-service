/**
 * Class Timetable API — the recurring weekly bell schedule for a grade+section
 * (Toddle-style), separate from the date-based /schedule.
 *
 * Permission model (all re-derived server-side, never trusted from the client):
 *   • VIEW    — students/parents of that class, any teacher/admin in the school
 *               (services/classAccess.canViewClass).
 *   • TEMPLATE (period_defs) — school admin (school-scoped) OR the section's
 *               homeroom teacher only.
 *   • SLOT    — homeroom teacher / admin (any slot) OR any teacher in the same
 *               school (their subject slots). Students/parents never write.
 */
const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { getUserContext, canViewClass, requireHomeroomTeacher } = require('../services/classAccess');

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Is this user allowed to own the template (bell times + any slot)?
// school_admin scoped to this school, or the homeroom teacher of the section.
async function canManageTemplate(userCtx, schoolId, grade, section) {
  if (!userCtx || userCtx.school_id !== schoolId) return false;
  if (userCtx.role === 'school_admin' || userCtx.role === 'super_admin') return true;
  if (userCtx.role === 'teacher') {
    const hr = await requireHomeroomTeacher(userCtx.email, schoolId, grade, section);
    return hr.ok;
  }
  return false;
}

// Can this user edit a single slot? Template managers can, plus any teacher in
// the same school (a subject teacher covering/attaching to their period).
async function canEditSlot(userCtx, schoolId, grade, section) {
  if (await canManageTemplate(userCtx, schoolId, grade, section)) return true;
  return !!userCtx && userCtx.school_id === schoolId && userCtx.role === 'teacher';
}

// Loads (or lazily represents) the timetable for a grade+section + its slots.
async function loadTimetable(schoolId, grade, section) {
  const { data: tt, error } = await supabase
    .from('class_timetables')
    .select('id, title, period_defs, updated_at')
    .eq('school_id', schoolId).eq('grade', grade).eq('section', section || '')
    .maybeSingle();
  if (error) throw error;
  if (!tt) return { timetable: null, slots: [] };
  const { data: slots, error: sErr } = await supabase
    .from('timetable_slots')
    .select('id, day_of_week, period_code, subject_name, room_name, teacher_id, material_url, material_name, color')
    .eq('timetable_id', tt.id);
  if (sErr) throw sErr;
  return { timetable: tt, slots: slots || [] };
}

// GET /timetable?email=&schoolId=&grade=&section=
router.get('/', async (req, res) => {
  const { email, schoolId, grade } = req.query;
  const section = req.query.section || '';
  if (!schoolId || !grade) return res.status(400).json({ error: 'schoolId and grade are required' });
  try {
    const userCtx = await getUserContext(email);
    if (!userCtx) return res.status(401).json({ error: 'Unknown user' });
    const allowed = await canViewClass(userCtx, schoolId, grade, section);
    if (!allowed) return res.status(403).json({ error: 'Not allowed to view this timetable' });

    const { timetable, slots } = await loadTimetable(schoolId, grade, section);
    const canManage = await canManageTemplate(userCtx, schoolId, grade, section);
    const canEdit = await canEditSlot(userCtx, schoolId, grade, section);

    // Decorate slots with teacher display names (best-effort).
    const teacherIds = [...new Set(slots.map((s) => s.teacher_id).filter(Boolean))];
    const nameMap = new Map();
    if (teacherIds.length) {
      const { data: teachers } = await supabase.from('users').select('id, name').in('id', teacherIds);
      for (const t of teachers || []) nameMap.set(t.id, t.name);
    }

    res.json({
      grade, section,
      title: timetable?.title || `${grade}${section ? ' ' + section : ''} Timetable`,
      periodDefs: timetable?.period_defs || [],
      days: DAYS,
      slots: slots.map((s) => ({
        id: s.id, day: s.day_of_week, periodCode: s.period_code,
        subject: s.subject_name, room: s.room_name,
        teacherId: s.teacher_id, teacherName: s.teacher_id ? (nameMap.get(s.teacher_id) || null) : null,
        materialUrl: s.material_url, materialName: s.material_name, color: s.color || null,
      })),
      permissions: { canManageTemplate: canManage, canEditSlot: canEdit },
    });
  } catch (err) {
    console.error('[GET /timetable] error:', err.message);
    res.status(500).json({ error: 'Failed to load timetable' });
  }
});

// PUT /timetable/template  { email, schoolId, grade, section, title?, periodDefs:[...] }
// Creates/updates the master bell structure. Admin or homeroom teacher only.
router.put('/template', async (req, res) => {
  const { email, schoolId, grade, title, periodDefs } = req.body || {};
  const section = req.body?.section || '';
  if (!schoolId || !grade) return res.status(400).json({ error: 'schoolId and grade are required' });
  if (!Array.isArray(periodDefs)) return res.status(400).json({ error: 'periodDefs must be an array' });
  try {
    const userCtx = await getUserContext(email);
    if (!(await canManageTemplate(userCtx, schoolId, grade, section))) {
      return res.status(403).json({ error: 'Only a school admin or the homeroom teacher can edit the bell schedule' });
    }
    // Normalize/validate period rows.
    const clean = periodDefs.map((p) => ({
      code: String(p.code || '').trim(),
      start: String(p.start || '').trim(),
      end: String(p.end || '').trim(),
      isBreak: !!p.isBreak,
    })).filter((p) => p.code);
    const { data, error } = await supabase
      .from('class_timetables')
      .upsert({
        school_id: schoolId, grade, section: section || '',
        title: title || null, period_defs: clean,
        updated_by: userCtx.email, updated_at: new Date().toISOString(),
      }, { onConflict: 'school_id,grade,section' })
      .select('id').single();
    if (error) throw error;
    res.json({ ok: true, timetableId: data.id });
  } catch (err) {
    console.error('[PUT /timetable/template] error:', err.message);
    res.status(500).json({ error: 'Failed to save the bell schedule' });
  }
});

// PUT /timetable/slot  { email, schoolId, grade, section, day, periodCode,
//                        subject?, room?, teacherId?, materialUrl?, materialName? }
// Upserts a single day x period cell. Clears the cell when subject is empty.
router.put('/slot', async (req, res) => {
  const { email, schoolId, grade, day, periodCode } = req.body || {};
  const section = req.body?.section || '';
  if (!schoolId || !grade || !day || !periodCode) {
    return res.status(400).json({ error: 'schoolId, grade, day and periodCode are required' });
  }
  if (!DAYS.includes(day)) return res.status(400).json({ error: 'Invalid day' });
  try {
    const userCtx = await getUserContext(email);
    if (!(await canEditSlot(userCtx, schoolId, grade, section))) {
      return res.status(403).json({ error: 'Not allowed to edit this timetable' });
    }
    // The template must exist first (owns the period grid).
    const { data: tt, error: ttErr } = await supabase
      .from('class_timetables').select('id')
      .eq('school_id', schoolId).eq('grade', grade).eq('section', section || '')
      .maybeSingle();
    if (ttErr) throw ttErr;
    if (!tt) return res.status(409).json({ error: 'Set up the bell schedule for this class first.' });

    const subject = req.body?.subject ? String(req.body.subject).trim() : null;
    // Empty subject = clear the cell (delete the slot row).
    if (!subject) {
      const { error } = await supabase.from('timetable_slots')
        .delete().eq('timetable_id', tt.id).eq('day_of_week', day).eq('period_code', periodCode);
      if (error) throw error;
      return res.json({ ok: true, cleared: true });
    }
    const { error } = await supabase.from('timetable_slots').upsert({
      timetable_id: tt.id, day_of_week: day, period_code: periodCode,
      subject_name: subject,
      room_name: req.body?.room ? String(req.body.room).trim() : null,
      teacher_id: req.body?.teacherId || null,
      material_url: req.body?.materialUrl || null,
      material_name: req.body?.materialName || null,
      color: req.body?.color ? String(req.body.color).trim() : null,
      updated_by: userCtx.email, updated_at: new Date().toISOString(),
    }, { onConflict: 'timetable_id,day_of_week,period_code' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[PUT /timetable/slot] error:', err.message);
    res.status(500).json({ error: 'Failed to save the slot' });
  }
});

module.exports = router;
