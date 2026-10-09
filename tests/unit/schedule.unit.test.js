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
const { mapRow, getStudentProfile, scopeAllEvents, filterCompleted, uuidv4 } = require('../../services/schedule');

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

describe('uuidv4', () => {
  test('generates a string prefixed with "ev_"', () => {
    expect(uuidv4()).toMatch(/^ev_/);
  });

  test('generates unique ids across calls', () => {
    expect(uuidv4()).not.toBe(uuidv4());
  });
});
