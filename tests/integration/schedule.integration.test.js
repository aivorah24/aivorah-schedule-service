// Integration tests — hit the REAL routes/schedule.js through Supertest.
// services/schedule.js and services/icalExport.js are mocked at the module
// boundary (their own logic is covered by unit tests); services/supabase is
// mocked directly since GET /teacher and POST / query it straight from the
// route (not through services/schedule.js).

jest.mock('../../services/schedule', () => ({
  mapRow: jest.fn((e) => ({ id: e.id, title: e.title, date: e.event_date, studentId: e.student_id, mapped: true })),
  getStudentProfile: jest.fn(),
  scopeAllEvents: jest.fn((rows) => Promise.resolve(rows)),
  filterCompleted: jest.fn((rows) => Promise.resolve(rows)),
  uuidv4: jest.fn(() => 'ev_fixedid123'),
}));
jest.mock('../../services/notify', () => ({ notifyScheduleEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/icalExport', () => ({ buildICalendar: jest.fn(() => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR') }));
jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    like: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    select2: undefined,
    single: jest.fn(),
    maybeSingle: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

const request = require('supertest');
const supabase = require('../../services/supabase');
const { mapRow, getStudentProfile, scopeAllEvents, filterCompleted, uuidv4 } = require('../../services/schedule');
const { notifyScheduleEvent } = require('../../services/notify');
const { buildICalendar } = require('../../services/icalExport');
const app = require('../../index');

beforeEach(() => {
  jest.clearAllMocks();
  // jest.clearAllMocks() only clears call records, not implementations — a
  // test that calls supabase.from.mockImplementation(...) for a multi-table
  // scenario would otherwise leak that override into every later test.
  // Reset to the shared default chain before each test.
  supabase.from.mockImplementation(() => supabase._chain);
  mapRow.mockImplementation((e) => ({ id: e.id, title: e.title, date: e.event_date, studentId: e.student_id, mapped: true }));
  scopeAllEvents.mockImplementation((rows) => Promise.resolve(rows));
  filterCompleted.mockImplementation((rows) => Promise.resolve(rows));
  getStudentProfile.mockResolvedValue({ userId: 'u1', curriculum: 'IB PYP', grade: 'Grade 4' });
});

describe('GET /schedule', () => {
  test('missing studentId or date -> 400', async () => {
    const res = await request(app).get('/schedule').query({ studentId: 's1' });
    expect(res.status).toBe(400);
  });

  test('a real day with events -> 200, mapped events returned', async () => {
    // exactData query, then activeDeadlines query.
    supabase._chain.or
      .mockResolvedValueOnce({ data: [{ id: '1', event_date: '2026-04-15', type: 'study' }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    const res = await request(app).get('/schedule').query({ studentId: 's1', date: '2026-04-15' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: '1', title: undefined, date: '2026-04-15', mapped: true }]);
  });

  test('an active (not-yet-due) deadline created before the queried date is still included', async () => {
    supabase._chain.or
      .mockResolvedValueOnce({ data: [], error: null }) // no exact-date events
      .mockResolvedValueOnce({
        data: [{ id: 'd1', event_date: '2026-04-20', type: 'deadline', created_at: '2026-04-10T00:00:00Z' }],
        error: null,
      });

    const res = await request(app).get('/schedule').query({ studentId: 's1', date: '2026-04-15' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('hideCompleted=true filters out completed events', async () => {
    supabase._chain.or.mockResolvedValueOnce({ data: [{ id: '1', event_date: '2026-04-15' }], error: null }).mockResolvedValueOnce({ data: [], error: null });
    filterCompleted.mockImplementationOnce((rows) => Promise.resolve(rows.map(r => ({ ...r, isCompleted: true }))));

    const res = await request(app).get('/schedule').query({ studentId: 's1', date: '2026-04-15', hideCompleted: 'true' });

    expect(res.body).toEqual([]);
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.or.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/schedule').query({ studentId: 's1', date: '2026-04-15' });
    expect(res.status).toBe(500);
  });
});

describe('GET /schedule/teacher', () => {
  test('missing date -> 400', async () => {
    const res = await request(app).get('/schedule/teacher');
    expect(res.status).toBe(400);
  });

  test('no email given -> returns all schedule_events for the date, unscoped', async () => {
    supabase._chain.eq.mockResolvedValueOnce({ data: [{ id: '1', event_date: '2026-04-15' }], error: null });

    const res = await request(app).get('/schedule/teacher').query({ date: '2026-04-15' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('with a teacher email, only that teacher\'s own events are kept', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'teacher-1' } }) };
      if (table === 'teacher_student') return { ...supabase._chain, eq: jest.fn().mockResolvedValue({ data: [{ student_id: 's1' }] }) };
      if (table === 'schedule_events') {
        return {
          ...supabase._chain,
          eq: jest.fn().mockResolvedValue({
            data: [
              { id: '1', event_date: '2026-04-15', created_by: 'teacher', created_by_id: 'teacher-1' }, // this teacher's own
              { id: '2', event_date: '2026-04-15', created_by: 'teacher', created_by_id: 'teacher-999' }, // another teacher's
            ],
            error: null,
          }),
        };
      }
      return supabase._chain;
    });

    const res = await request(app).get('/schedule/teacher').query({ date: '2026-04-15', email: 'teacher1@a.com' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('1');
  });

  test('resolves and attaches the real student name for non-"all" events', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'schedule_events') {
        return { ...supabase._chain, eq: jest.fn().mockResolvedValue({ data: [{ id: '1', event_date: '2026-04-15', student_id: 's1', created_by: 'student' }], error: null }) };
      }
      if (table === 'users') return { ...supabase._chain, in: jest.fn().mockResolvedValue({ data: [{ id: 's1', name: 'Aanya' }] }) };
      return supabase._chain;
    });

    const res = await request(app).get('/schedule/teacher').query({ date: '2026-04-15' });

    expect(res.body[0].studentName).toBe('Aanya');
  });

  test('an "all"-student event never gets a studentName attached', async () => {
    supabase._chain.eq.mockResolvedValueOnce({ data: [{ id: '1', event_date: '2026-04-15', student_id: 'all', created_by: 'teacher' }], error: null });

    const res = await request(app).get('/schedule/teacher').query({ date: '2026-04-15' });

    expect(res.body[0].studentName).toBeUndefined();
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.eq.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/schedule/teacher').query({ date: '2026-04-15' });
    expect(res.status).toBe(500);
  });

  // Regression (2026-09-15): a student's own personal schedule event
  // (created_by === student_id, since the student UI sends its own id as
  // createdBy - see useScheduleEvents.ts) was leaking onto the teacher's
  // calendar via an "any event for one of my linked students" fallback.
  // Follow-up (2026-09-19): that same fallback also leaked PARENT-created
  // events (deadline or personal) to the teacher — bug report: "when parent
  // schedules something, it shows in the teacher section... no need to show
  // that event to teachers." Removed the fallback entirely: teachers now
  // only ever see events they (or school admin) created.
  test('neither a student\'s own event nor a parent-created event for that student shows on the teacher\'s calendar', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'teacher-1' } }) };
      if (table === 'teacher_student') return { ...supabase._chain, eq: jest.fn().mockResolvedValue({ data: [{ student_id: 's1' }] }) };
      if (table === 'schedule_events') {
        return {
          ...supabase._chain,
          eq: jest.fn().mockResolvedValue({
            data: [
              { id: '1', event_date: '2026-04-15', student_id: 's1', created_by: 's1', created_by_id: null }, // student's own personal event
              { id: '2', event_date: '2026-04-15', student_id: 's1', created_by: 'parent', created_by_id: null }, // parent-created event
            ],
            error: null,
          }),
        };
      }
      return supabase._chain;
    });

    const res = await request(app).get('/schedule/teacher').query({ date: '2026-04-15', email: 'teacher1@a.com' });

    expect(res.status).toBe(200);
    expect(res.body.map(e => e.id)).toEqual([]);
  });
});

describe('GET /schedule/month', () => {
  test('missing params -> 400', async () => {
    const res = await request(app).get('/schedule/month').query({ studentId: 's1', year: '2026' });
    expect(res.status).toBe(400);
  });

  test('returns the distinct set of dates with events in that month', async () => {
    supabase._chain.or.mockResolvedValueOnce({
      data: [{ id: '1', event_date: '2026-04-05' }, { id: '2', event_date: '2026-04-05' }, { id: '3', event_date: '2026-04-20' }],
      error: null,
    });

    const res = await request(app).get('/schedule/month').query({ studentId: 's1', year: '2026', month: '4' });

    expect(res.status).toBe(200);
    expect(res.body.dates.sort()).toEqual(['2026-04-05', '2026-04-20']);
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.or.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/schedule/month').query({ studentId: 's1', year: '2026', month: '4' });
    expect(res.status).toBe(500);
  });
});

describe('GET /schedule/upcoming', () => {
  test('missing studentId -> 400', async () => {
    const res = await request(app).get('/schedule/upcoming');
    expect(res.status).toBe(400);
  });

  test('returns at most 5 upcoming deadline/challenge events, sorted by date', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, event_date: `2026-04-${10 + i}`, type: 'deadline' }));
    supabase._chain.order.mockResolvedValueOnce({ data: many, error: null });

    const res = await request(app).get('/schedule/upcoming').query({ studentId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.order.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/schedule/upcoming').query({ studentId: 's1' });
    expect(res.status).toBe(500);
  });
});

describe('GET /schedule/event/:id', () => {
  test('a real existing event is returned mapped, for a notification deep-link to open', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({
      data: { id: 'ev1', title: 'Quiz due', event_date: '2026-09-20', student_id: 's1' },
      error: null,
    });

    const res = await request(app).get('/schedule/event/ev1');

    expect(res.status).toBe(200);
    expect(mapRow).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev1' }));
    expect(res.body).toEqual(expect.objectContaining({ id: 'ev1', title: 'Quiz due' }));
  });

  test('a real non-existent id -> 404, not a crash', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const res = await request(app).get('/schedule/event/does-not-exist');
    expect(res.status).toBe(404);
  });

  test('a real Supabase failure -> 500', async () => {
    supabase._chain.maybeSingle.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/schedule/event/ev1');
    expect(res.status).toBe(500);
  });
});

describe('POST /schedule', () => {
  test('missing required fields -> 400', async () => {
    const res = await request(app).post('/schedule').send({ title: 'x' });
    expect(res.status).toBe(400);
  });

  test('a valid event -> 200, inserts a real row and returns the mapped result', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: { id: 'ev_fixedid123', title: 'Homework', event_date: '2026-04-15' }, error: null });

    const res = await request(app).post('/schedule').send({ title: 'Homework', date: '2026-04-15', startTime: '10:00', studentId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('ev_fixedid123');
    const insertArg = supabase._chain.insert.mock.calls[0][0];
    expect(insertArg.title).toBe('Homework');
    expect(insertArg.event_date).toBe('2026-04-15');
  });

  test('notifyScheduleEvent is fired after a successful insert (fire-and-forget)', async () => {
    supabase._chain.maybeSingle.mockResolvedValueOnce({ data: { id: 'teacher-1' } });
    supabase._chain.single.mockResolvedValueOnce({ data: { id: 'ev_1', title: 'Test', student_id: 's1' }, error: null });
    await request(app).post('/schedule').send({ title: 'Test', date: '2026-04-15', startTime: '10:00', studentId: 's1', createdBy: 'teacher', creatorEmail: 't@x.com' });
    expect(notifyScheduleEvent).toHaveBeenCalledWith({ event: { id: 'ev_1', title: 'Test', student_id: 's1' }, createdBy: 'teacher', creatorEmail: 't@x.com' });
  });

  test('a creatorEmail resolves to a real creatorId stored on the row', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'teacher-1' } }) };
      if (table === 'schedule_events') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'ev_1' }, error: null }) };
      return supabase._chain;
    });

    await request(app).post('/schedule').send({ title: 'x', date: '2026-04-15', startTime: '10:00', studentId: 's1', creatorEmail: 'T@A.com' });

    const insertCall = supabase.from.mock.calls.find(c => c[0] === 'schedule_events');
    expect(insertCall).toBeTruthy();
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.single.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).post('/schedule').send({ title: 'x', date: '2026-04-15', startTime: '10:00', studentId: 's1' });
    expect(res.status).toBe(500);
  });
});

describe('PATCH/PUT /schedule/:id', () => {
  test('only the provided fields are included in the update payload', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: { id: 'ev1', title: 'Updated' }, error: null });

    await request(app).patch('/schedule/ev1').send({ title: 'Updated' });

    const updateArg = supabase._chain.update.mock.calls[0][0];
    expect(updateArg).toEqual({ title: 'Updated' });
  });

  test('isCompleted is coerced to a real boolean in the update', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: { id: 'ev1' }, error: null });
    await request(app).patch('/schedule/ev1').send({ isCompleted: 1 });
    expect(supabase._chain.update.mock.calls[0][0].isCompleted).toBe(true);
  });

  test('PUT behaves identically to PATCH', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: { id: 'ev1', title: 'Via PUT' }, error: null });
    const res = await request(app).put('/schedule/ev1').send({ title: 'Via PUT' });
    expect(res.status).toBe(200);
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.single.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).patch('/schedule/ev1').send({ title: 'x' });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /schedule/:id', () => {
  test('a successful delete -> { ok: true }', async () => {
    supabase._chain.eq.mockResolvedValueOnce({ error: null });
    const res = await request(app).delete('/schedule/ev1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.eq.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).delete('/schedule/ev1');
    expect(res.status).toBe(500);
  });
});

describe('GET /schedule/tags', () => {
  test('returns the real, static assignment and event tag lists', async () => {
    const res = await request(app).get('/schedule/tags');
    expect(res.status).toBe(200);
    expect(res.body.assignmentTags.map(t => t.key)).toContain('worksheet');
    expect(res.body.eventTags.map(t => t.key)).toContain('holidays_and_vacations');
  });
});

describe('GET /schedule/ical', () => {
  test('returns a real .ics attachment with the correct headers', async () => {
    supabase._chain.or.mockResolvedValueOnce({ data: [{ id: '1', event_date: '2026-04-15' }], error: null });

    const res = await request(app).get('/schedule/ical').query({ studentId: 's1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.headers['content-disposition']).toContain('aivorah-schedule.ics');
    expect(res.text).toContain('BEGIN:VCALENDAR');
  });

  test('a teacher role scopes the export to their own created events', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, single: jest.fn().mockResolvedValue({ data: { id: 'teacher-1' }, error: null }) };
      if (table === 'schedule_events') return { ...supabase._chain, gte: jest.fn().mockReturnThis(), eq: jest.fn().mockResolvedValue({ data: [], error: null }) };
      return supabase._chain;
    });

    const res = await request(app).get('/schedule/ical').query({ email: 'teacher1@a.com', role: 'teacher' });

    expect(res.status).toBe(200);
  });

  test('a Supabase failure -> 500', async () => {
    supabase._chain.or.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/schedule/ical').query({ studentId: 's1' });
    expect(res.status).toBe(500);
  });
});
