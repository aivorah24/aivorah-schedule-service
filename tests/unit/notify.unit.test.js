// notifyScheduleEvent against a small in-memory Supabase fake, so recipient scoping is really exercised.
const db = {};
const rpcCalls = [];
const inserts = [];

jest.mock('../../services/supabase', () => {
  const query = (table) => {
    const filters = [];
    const q = {
      select: () => q,
      eq: (col, val) => { filters.push(r => r[col] === val); return q; },
      in: (col, vals) => { filters.push(r => vals.includes(r[col])); return q; },
      insert: (rows) => { inserts.push({ table, rows }); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: rows()[0] || null }),
      then: (res, rej) => Promise.resolve({ data: rows() }).then(res, rej),
    };
    const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
    return q;
  };
  return {
    from: jest.fn(query),
    // Mirrors notify_event: students + each linked parent, never the actor.
    rpc: jest.fn(async (fn, { p_event: e }) => {
      rpcCalls.push(e);
      const actor = e.actor_email;
      const emailOf = id => db.users.find(u => u.id === id)?.email;
      const inserted = [];
      for (const sid of e.student_ids) {
        if (emailOf(sid) !== actor) inserted.push({ recipient_id: sid, recipient_role: 'student' });
        for (const l of db.parent_children.filter(pc => pc.child_id === sid && pc.parent_email !== actor)) {
          const p = db.users.find(u => u.email === l.parent_email);
          inserted.push({ recipient_id: p.id, recipient_role: 'parent', child_id: sid });
        }
      }
      return { data: { inserted, recipients: inserted.length, duplicates: 0 }, error: null };
    }),
  };
});
jest.mock('../../services/push', () => ({ sendPush: jest.fn().mockResolvedValue({ sent: 1 }) }));

const { sendPush } = require('../../services/push');
const supabase = require('../../services/supabase');
const { notifyScheduleEvent, formatWhen } = require('../../services/notify');

const event = (over = {}) => ({
  id: 'ev_1', title: 'Math class', event_date: '2026-10-10', start_time: '09:00', type: 'lesson',
  student_id: 'all', created_at: '2026-10-09T11:28:28.574Z', ...over,
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  rpcCalls.length = 0;
  inserts.length = 0;
  jest.clearAllMocks();
  Object.assign(db, {
    users: [
      { id: 'tA', email: 'teacher.a@x.com', role: 'teacher' },
      { id: 'tB', email: 'teacher.b@x.com', role: 'teacher' },
      { id: 's1', email: 's1@x.com', role: 'student', name: 'Asha' },
      { id: 's2', email: 's2@x.com', role: 'student', name: 'Ravi' },
      { id: 's3', email: 's3@x.com', role: 'student', name: 'Other class' },
      { id: 'p1', email: 'mom@x.com', role: 'parent' },
      { id: 'p2', email: 'dad@x.com', role: 'parent' },
      { id: 'adm', email: 'admin@x.com', role: 'super_admin' },
    ],
    teacher_student: [
      { teacher_id: 'tA', student_id: 's1' }, { teacher_id: 'tA', student_id: 's2' },
      { teacher_id: 'tB', student_id: 's3' },
    ],
    parent_children: [
      { parent_email: 'mom@x.com', child_id: 's1' }, { parent_email: 'dad@x.com', child_id: 's1' },
      { parent_email: 'mom@x.com', child_id: 's1' }, // duplicate link row
    ],
  });
});

const cardRecipients = () => inserts.filter(i => i.table === 'messages').flatMap(i => i.rows.map(r => r.recipient_email)).sort();

describe('notifyScheduleEvent', () => {
  test("teacher 'all' event goes only to that teacher's own students", async () => {
    await notifyScheduleEvent({ event: event(), createdBy: 'teacher', creatorEmail: 'Teacher.A@x.com' });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual(expect.objectContaining({
      type: 'event_scheduled', entity_type: 'schedule_event', entity_id: 'ev_1',
      version: '2026-10-09T11:28:28.574Z', actor_email: 'teacher.a@x.com', actor_role: 'teacher',
      title: 'New event: Math class',
    }));
    expect(rpcCalls[0].student_ids.sort()).toEqual(['s1', 's2']);
  });

  test('teacher event for a specific linked student reaches that student only', async () => {
    await notifyScheduleEvent({ event: event({ student_id: 's2' }), createdBy: 'teacher', creatorEmail: 'teacher.a@x.com' });
    expect(rpcCalls[0].student_ids).toEqual(['s2']);
  });

  test("teacher event for another teacher's student notifies no one", async () => {
    await notifyScheduleEvent({ event: event({ student_id: 's3' }), createdBy: 'teacher', creatorEmail: 'teacher.a@x.com' });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(sendPush).not.toHaveBeenCalled();
    expect(cardRecipients()).toEqual([]);
  });

  test('parent event reaches the child and the other parent, never the creating parent', async () => {
    await notifyScheduleEvent({ event: event({ student_id: 's1' }), createdBy: 'parent', creatorEmail: 'mom@x.com' });
    expect(rpcCalls[0].student_ids).toEqual(['s1']);
    expect(rpcCalls[0].actor_email).toBe('mom@x.com');
    expect(cardRecipients()).toEqual(['dad@x.com']);
    const pushes = Object.fromEntries(sendPush.mock.calls.map(([emails, o]) => [o.title, emails]));
    expect(pushes).toEqual({ 'New event: Math class': ['s1@x.com'], 'New event for Asha: Math class': ['dad@x.com'] });
  });

  test('parent link check ignores email case (stored Mom@X.com)', async () => {
    db.parent_children[0].parent_email = 'Mom@X.com';
    await notifyScheduleEvent({ event: event({ student_id: 's1' }), createdBy: 'parent', creatorEmail: 'mom@x.com' });
    expect(rpcCalls[0].student_ids).toEqual(['s1']);
  });

  test("parent event for a child that isn't theirs notifies no one", async () => {
    await notifyScheduleEvent({ event: event({ student_id: 's2' }), createdBy: 'parent', creatorEmail: 'mom@x.com' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("parent 'all' event notifies no one", async () => {
    await notifyScheduleEvent({ event: event(), createdBy: 'parent', creatorEmail: 'mom@x.com' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('student own event notifies their parents (each once), not themselves', async () => {
    await notifyScheduleEvent({ event: event({ student_id: 's1' }), createdBy: 's1' });
    expect(rpcCalls[0].actor_email).toBe('s1@x.com');
    expect(cardRecipients()).toEqual(['dad@x.com', 'mom@x.com']);
    expect(sendPush.mock.calls[0][0]).not.toContain('s1@x.com');
  });

  test('the role comes from the users table, not the client: an admin claiming teacher notifies no one', async () => {
    await notifyScheduleEvent({ event: event(), createdBy: 'teacher', creatorEmail: 'admin@x.com' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('unknown creator email or a garbage createdBy notifies no one', async () => {
    await notifyScheduleEvent({ event: event(), createdBy: 'teacher', creatorEmail: 'ghost@x.com' });
    await notifyScheduleEvent({ event: event({ student_id: 's1' }), createdBy: 'someone-else' });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test('push goes only to newly inserted recipients', async () => {
    supabase.rpc.mockResolvedValueOnce({ data: { inserted: [], recipients: 3, duplicates: 3 }, error: null });
    await notifyScheduleEvent({ event: event(), createdBy: 'teacher', creatorEmail: 'teacher.a@x.com' });
    expect(sendPush).not.toHaveBeenCalled();
  });

  test('a failing notify_event never throws and still sends the parent cards', async () => {
    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    await expect(notifyScheduleEvent({ event: event({ student_id: 's1' }), createdBy: 'teacher', creatorEmail: 'teacher.a@x.com' })).resolves.toBeUndefined();
    expect(cardRecipients()).toEqual(['dad@x.com', 'mom@x.com']);
  });

  test('a database outage never throws', async () => {
    supabase.from.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(notifyScheduleEvent({ event: event(), createdBy: 'teacher', creatorEmail: 'teacher.a@x.com' })).resolves.toBeUndefined();
  });
});

describe('formatWhen', () => {
  test('formats date and time', () => {
    expect(formatWhen('2026-10-10', '09:00')).toBe('Sat, 10 Oct · 09:00');
  });
  test('falls back to the raw date when unparseable', () => {
    expect(formatWhen('soon', '')).toBe('soon');
  });
});
