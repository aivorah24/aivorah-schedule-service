jest.mock('../../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
  };
  // .from() returns the same chain every time, but each test configures the
  // NEXT terminal call's resolved value — tests order their mockResolvedValueOnce
  // calls to match the real query sequence each function issues.
  return { from: jest.fn(() => chain), _chain: chain };
});

const supabase = require('../../services/supabase');
const { mapRow, getStudentProfile, scopeAllEvents, filterCompleted, notifyScheduleEvent, uuidv4 } = require('../../services/schedule');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('mapRow', () => {
  test('a plain study event maps snake_case to camelCase with default tag "Quick task"', () => {
    const row = { id: '1', title: 'Homework', event_date: '2026-04-15', start_time: '10:00', end_time: '11:00', type: 'study', student_id: 's1', created_by: 'student' };
    const result = mapRow(row);
    expect(result).toEqual(expect.objectContaining({ id: '1', title: 'Homework', date: '2026-04-15', tag: 'Quick task', tagCategory: 'assignment' }));
  });

  test('a deadline event with no explicit tag defaults to "Worksheet"', () => {
    const result = mapRow({ id: '1', type: 'deadline', event_date: '2026-04-20', created_at: '2026-04-10T00:00:00Z' });
    expect(result.tag).toBe('Worksheet');
  });

  test('a challenge event with no explicit tag defaults to "AI Challenge"', () => {
    const result = mapRow({ id: '1', type: 'challenge', event_date: '2026-04-20' });
    expect(result.tag).toBe('AI Challenge');
  });

  test('a lesson event with no explicit tag defaults to "Live Class"', () => {
    const result = mapRow({ id: '1', type: 'lesson', event_date: '2026-04-20' });
    expect(result.tag).toBe('Live Class');
  });

  test('a break event defaults to "Working Day" tag, categorized as "event"', () => {
    const result = mapRow({ id: '1', type: 'break', event_date: '2026-04-20' });
    expect(result.tag).toBe('Working Day');
    expect(result.tagCategory).toBe('event');
  });

  test('a real school-event tag (e.g. "Holidays and vacations") is categorized as "event", not "assignment"', () => {
    const result = mapRow({ id: '1', type: 'study', event_date: '2026-04-20', tag: 'Holidays and vacations' });
    expect(result.tagCategory).toBe('event');
  });

  test('an assignment-style tag (e.g. "Worksheet") stays categorized as "assignment"', () => {
    const result = mapRow({ id: '1', type: 'study', event_date: '2026-04-20', tag: 'Worksheet' });
    expect(result.tagCategory).toBe('assignment');
  });

  test('a deadline event\'s startDate uses created_at (when the deadline was created), not event_date', () => {
    const result = mapRow({ id: '1', type: 'deadline', event_date: '2026-04-20', created_at: '2026-04-10T12:00:00Z' });
    expect(result.startDate).toBe('2026-04-10');
  });

  test('a plain study event\'s startDate falls back to event_date (no created_at logic)', () => {
    const result = mapRow({ id: '1', type: 'study', event_date: '2026-04-20', created_at: '2026-04-01T00:00:00Z' });
    expect(result.startDate).toBe('2026-04-20');
  });

  test('createdBy falls back to student_id when created_by is missing', () => {
    const result = mapRow({ id: '1', type: 'study', event_date: '2026-04-20', student_id: 's1', created_by: null });
    expect(result.createdBy).toBe('s1');
  });

  test('isCompleted is coerced to a real boolean', () => {
    expect(mapRow({ id: '1', event_date: '2026-04-20', isCompleted: 1 }).isCompleted).toBe(true);
    expect(mapRow({ id: '1', event_date: '2026-04-20', isCompleted: undefined }).isCompleted).toBe(false);
  });
});

describe('getStudentProfile', () => {
  test('no studentId -> nulls, no Supabase call', async () => {
    const result = await getStudentProfile(null);
    expect(result).toEqual({ userId: null, curriculum: null, grade: null });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a UUID-format studentId looks up by id', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: { id: 'u1', curriculum: 'IB PYP', grade: 'Grade 4' } });
    const result = await getStudentProfile('123e4567-e89b-12d3-a456-426614174000');
    expect(result).toEqual({ userId: 'u1', curriculum: 'IB PYP', grade: 'Grade 4' });
    expect(supabase._chain.eq).toHaveBeenCalledWith('id', '123e4567-e89b-12d3-a456-426614174000');
  });

  test('an email-format studentId looks up by email', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: { id: 'u2', curriculum: 'NCERT', grade: 'Grade 6' } });
    const result = await getStudentProfile('a@a.com');
    expect(result.userId).toBe('u2');
    expect(supabase._chain.eq).toHaveBeenCalledWith('email', 'a@a.com');
  });

  test('neither UUID nor email format -> nulls, no crash', async () => {
    const result = await getStudentProfile('not-a-real-id');
    expect(result).toEqual({ userId: null, curriculum: null, grade: null });
  });

  test('a lookup that finds no row -> nulls, not a crash', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: null });
    const result = await getStudentProfile('a@a.com');
    expect(result).toEqual({ userId: null, curriculum: null, grade: null });
  });
});

describe('scopeAllEvents — the teacher-broadcast leak-prevention logic', () => {
  test('rows with no teacher "all" broadcasts pass through untouched, no linked-teacher lookup needed', async () => {
    const rows = [{ id: '1', student_id: 's1', created_by: 'student' }];
    const result = await scopeAllEvents(rows, 'u1');
    expect(result).toEqual(rows);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a teacher "all" broadcast from THIS student\'s own linked teacher is kept', async () => {
    const chainResult = Promise.resolve({ data: [{ teacher_id: 'teacher-1' }] });
    supabase.from.mockReturnValueOnce({ ...supabase._chain, eq: jest.fn().mockReturnValue(chainResult) });

    const rows = [{ id: '1', student_id: 'all', created_by: 'teacher', created_by_id: 'teacher-1' }];
    const result = await scopeAllEvents(rows, 'u1');
    expect(result).toEqual(rows);
  });

  test('a teacher "all" broadcast from a DIFFERENT (unlinked) teacher is excluded', async () => {
    const chainResult = Promise.resolve({ data: [{ teacher_id: 'teacher-1' }] });
    supabase.from.mockReturnValueOnce({ ...supabase._chain, eq: jest.fn().mockReturnValue(chainResult) });

    const rows = [{ id: '1', student_id: 'all', created_by: 'teacher', created_by_id: 'teacher-999' }];
    const result = await scopeAllEvents(rows, 'u1');
    expect(result).toEqual([]);
  });

  test('a teacher "all" broadcast with no resolvable userId is excluded, never shown to everyone as a fallback', async () => {
    const rows = [{ id: '1', student_id: 'all', created_by: 'teacher', created_by_id: 'teacher-1' }];
    const result = await scopeAllEvents(rows, null);
    expect(result).toEqual([]);
  });

  test('a teacher "all" broadcast missing created_by_id is excluded (unattributable, never shown to everyone)', async () => {
    const chainResult = Promise.resolve({ data: [] });
    supabase.from.mockReturnValueOnce({ ...supabase._chain, eq: jest.fn().mockReturnValue(chainResult) });

    const rows = [{ id: '1', student_id: 'all', created_by: 'teacher', created_by_id: null }];
    const result = await scopeAllEvents(rows, 'u1');
    expect(result).toEqual([]);
  });
});

describe('filterCompleted', () => {
  test('no userId -> every row marked not completed, no Supabase call', async () => {
    const rows = [{ id: '1', type: 'deadline', assignment_id: 'a1' }];
    const result = await filterCompleted(rows, null);
    expect(result[0].isCompleted).toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('no deadline/challenge rows with assignment_id -> everything marked false, no Supabase call', async () => {
    const rows = [{ id: '1', type: 'study' }];
    const result = await filterCompleted(rows, 'u1');
    expect(result[0].isCompleted).toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a completed assignment deadline is marked isCompleted: true', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'assignment_submissions') {
        return { ...supabase._chain, in: jest.fn().mockReturnValue(Promise.resolve({ data: [{ assignment_id: 'a1' }] })) };
      }
      return { ...supabase._chain, in: jest.fn().mockReturnValue(Promise.resolve({ data: [] })) };
    });
    const rows = [{ id: '1', type: 'deadline', assignment_id: 'a1' }];
    const result = await filterCompleted(rows, 'u1');
    expect(result[0].isCompleted).toBe(true);
  });

  test('an incomplete assignment deadline is marked isCompleted: false', async () => {
    supabase.from.mockImplementation(() => ({ ...supabase._chain, in: jest.fn().mockReturnValue(Promise.resolve({ data: [] })) }));
    const rows = [{ id: '1', type: 'deadline', assignment_id: 'a1' }];
    const result = await filterCompleted(rows, 'u1');
    expect(result[0].isCompleted).toBe(false);
  });

  test('a completed challenge is marked isCompleted: true', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'challenge_assignments') {
        return { ...supabase._chain, in: jest.fn().mockReturnValue(Promise.resolve({ data: [{ id: 'c1' }] })) };
      }
      return { ...supabase._chain, in: jest.fn().mockReturnValue(Promise.resolve({ data: [] })) };
    });
    const rows = [{ id: '1', type: 'challenge', assignment_id: 'c1' }];
    const result = await filterCompleted(rows, 'u1');
    expect(result[0].isCompleted).toBe(true);
  });
});

describe('notifyScheduleEvent', () => {
  // Regression (2026-09-15): the student schedule UI sends createdBy as the
  // student's OWN id (see useScheduleEvents.ts's addEvent: `createdBy:
  // studentId`), never the literal string 'student'. Because notifyScheduleEvent
  // only ever recognized the literal strings 'teacher'/'parent' as valid
  // actors, a student scheduling their own event silently notified no one -
  // the linked parent never saw or was told about it. Bug report: "Student
  // schedules an event -> linked Parent must see the event and receive the
  // notification."
  test('a student-created event (createdBy === studentId, matching what the real UI sends) notifies that student\'s parents', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { id: 's1', name: 'Aanya' } }) };
      if (table === 'parent_children') return { ...supabase._chain, eq: jest.fn().mockReturnValue(Promise.resolve({ data: [{ parent_email: 'parent@a.com' }] })) };
      if (table === 'messages') return { ...supabase._chain, insert: jest.fn().mockResolvedValue({ data: null, error: null }) };
      return supabase._chain;
    });

    await notifyScheduleEvent({ title: 'Study session', date: '2026-04-15', studentId: 's1', createdBy: 's1' });

    const messagesCall = supabase.from.mock.calls.find(c => c[0] === 'messages');
    expect(messagesCall).toBeTruthy();
  });

  // A genuinely unrecognized/garbage actor value (not the student's own id,
  // and not 'teacher'/'parent') must still notify no one - this is NOT a
  // blanket "always notify" change, only student-self-created events
  // (createdBy === studentId) are newly recognized.
  test('an unrecognized actor value that is not the student\'s own id still notifies no one', async () => {
    await notifyScheduleEvent({ title: 'x', date: '2026-04-15', studentId: 's1', createdBy: 'some-other-id' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('no studentId -> never notifies, even for a teacher/parent actor', async () => {
    await notifyScheduleEvent({ title: 'x', date: '2026-04-15', studentId: null, createdBy: 'teacher' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a teacher scheduling for a specific student notifies that student\'s parents with a real card message', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { id: 's1', name: 'Aanya' } }) };
      if (table === 'parent_children') return { ...supabase._chain, eq: jest.fn().mockReturnValue(Promise.resolve({ data: [{ parent_email: 'parent@a.com' }] })) };
      if (table === 'messages') return { ...supabase._chain, insert: jest.fn().mockResolvedValue({ data: null, error: null }) };
      return supabase._chain;
    });

    await notifyScheduleEvent({ title: 'Maths Test', date: '2026-04-15', startTime: '10:00', studentId: 's1', createdBy: 'teacher' });

    const messagesCall = supabase.from.mock.calls.find(c => c[0] === 'messages');
    expect(messagesCall).toBeTruthy();
  });

  test('errors during notification are swallowed (best-effort, never throws)', async () => {
    supabase.from.mockImplementation(() => { throw new Error('db down'); });
    await expect(notifyScheduleEvent({ title: 'x', date: '2026-04-15', studentId: 's1', createdBy: 'teacher' })).resolves.toBeUndefined();
  });

  test('a teacher broadcasting to "all" notifies the parents of every one of THEIR linked students', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') {
        return {
          ...supabase._chain,
          maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'teacher-1' } }),
          in: jest.fn().mockReturnValue(Promise.resolve({ data: [{ id: 's1', name: 'Aanya' }, { id: 's2', name: 'Rohan' }] })),
        };
      }
      if (table === 'teacher_student') return { ...supabase._chain, eq: jest.fn().mockReturnValue(Promise.resolve({ data: [{ student_id: 's1' }, { student_id: 's2' }] })) };
      if (table === 'parent_children') return { ...supabase._chain, eq: jest.fn().mockReturnValue(Promise.resolve({ data: [{ parent_email: 'parent@a.com' }] })) };
      if (table === 'messages') return { ...supabase._chain, insert: jest.fn().mockResolvedValue({ data: null, error: null }) };
      return supabase._chain;
    });

    await notifyScheduleEvent({ title: 'Sports Day', date: '2026-04-20', studentId: 'all', createdBy: 'teacher', creatorEmail: 'T@A.com' });

    const messagesCalls = supabase.from.mock.calls.filter(c => c[0] === 'messages');
    expect(messagesCalls).toHaveLength(2); // one per linked student's parent
  });

  test('a parent-created "all" event never triggers the teacher broadcast branch (parents have no linked students)', async () => {
    await notifyScheduleEvent({ title: 'x', date: '2026-04-15', studentId: 'all', createdBy: 'parent', creatorEmail: 'p@a.com' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a teacher broadcast with no creatorEmail never resolves a teacher id, so nothing is notified', async () => {
    await notifyScheduleEvent({ title: 'x', date: '2026-04-15', studentId: 'all', createdBy: 'teacher' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('an unresolvable teacher email (no matching user row) notifies no one, no crash', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: null }) };
      return supabase._chain;
    });
    await expect(notifyScheduleEvent({ title: 'x', date: '2026-04-15', studentId: 'all', createdBy: 'teacher', creatorEmail: 't@a.com' })).resolves.toBeUndefined();
    const messagesCalls = supabase.from.mock.calls.filter(c => c[0] === 'messages');
    expect(messagesCalls).toHaveLength(0);
  });

  test('a teacher with no linked students at all notifies no one', async () => {
    supabase.from.mockImplementation((table) => {
      if (table === 'users') return { ...supabase._chain, maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'teacher-1' } }) };
      if (table === 'teacher_student') return { ...supabase._chain, eq: jest.fn().mockReturnValue(Promise.resolve({ data: [] })) };
      return supabase._chain;
    });
    await notifyScheduleEvent({ title: 'x', date: '2026-04-15', studentId: 'all', createdBy: 'teacher', creatorEmail: 't@a.com' });
    const messagesCalls = supabase.from.mock.calls.filter(c => c[0] === 'messages');
    expect(messagesCalls).toHaveLength(0);
  });
});

describe('uuidv4', () => {
  test('generates a string prefixed with "ev_"', () => {
    expect(uuidv4()).toMatch(/^ev_/);
  });

  test('generates unique ids across calls', () => {
    expect(uuidv4()).not.toBe(uuidv4());
  });
});
