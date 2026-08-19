const { buildICalendar } = require('../../services/icalExport');

function baseEvent(overrides = {}) {
  return { id: 'ev1', title: 'Maths class', date: '2026-04-15', startTime: '10:00', endTime: '', note: '', tag: null, ...overrides };
}

describe('buildICalendar', () => {
  test('wraps events in a real VCALENDAR envelope with the correct headers', () => {
    const ical = buildICalendar([]);
    expect(ical).toContain('BEGIN:VCALENDAR');
    expect(ical).toContain('VERSION:2.0');
    expect(ical).toContain('PRODID:-//Aivorah//Schedule//EN');
    expect(ical).toContain('END:VCALENDAR');
  });

  test('an event with no date is skipped entirely', () => {
    const ical = buildICalendar([baseEvent({ date: null })]);
    expect(ical).not.toContain('BEGIN:VEVENT');
  });

  test('a normal timed event gets real DTSTART/DTEND in Asia/Kolkata', () => {
    const ical = buildICalendar([baseEvent({ startTime: '10:00', endTime: '11:30' })]);
    expect(ical).toContain('DTSTART;TZID=Asia/Kolkata:20260415T100000');
    expect(ical).toContain('DTEND;TZID=Asia/Kolkata:20260415T113000');
  });

  test('no endTime given -> defaults to one hour after startTime', () => {
    const ical = buildICalendar([baseEvent({ startTime: '10:00', endTime: '' })]);
    expect(ical).toContain('DTEND;TZID=Asia/Kolkata:20260415T110000');
  });

  test('startTime of 23:59 crossing midnight wraps the hour correctly (23 -> 00)', () => {
    const ical = buildICalendar([baseEvent({ startTime: '23:30', endTime: '' })]);
    expect(ical).toContain('DTEND;TZID=Asia/Kolkata:20260415T003000'); // (23+1)%24 = 0
  });

  test('no startTime at all -> defaults to midnight', () => {
    const ical = buildICalendar([baseEvent({ startTime: null, endTime: '' })]);
    expect(ical).toContain('DTSTART;TZID=Asia/Kolkata:20260415T000000');
  });

  test('startTime of exactly 23:59 is treated as an all-day event spanning to the next day', () => {
    const ical = buildICalendar([baseEvent({ startTime: '23:59' })]);
    expect(ical).toContain('DTSTART;VALUE=DATE:20260415');
    expect(ical).toContain('DTEND;VALUE=DATE:20260416');
  });

  test('a real title and note are included, with newlines in the note escaped', () => {
    const ical = buildICalendar([baseEvent({ title: 'Science fair', note: 'Bring poster\nand samples' })]);
    expect(ical).toContain('SUMMARY:Science fair');
    expect(ical).toContain('DESCRIPTION:Bring poster\\nand samples');
  });

  test('no note -> an empty DESCRIPTION line, not omitted', () => {
    const ical = buildICalendar([baseEvent({ note: '' })]);
    expect(ical).toContain('DESCRIPTION:\r\n');
  });

  test('a real tag becomes a CATEGORIES line; no tag omits it', () => {
    const withTag = buildICalendar([baseEvent({ tag: 'Worksheet' })]);
    expect(withTag).toContain('CATEGORIES:Worksheet');

    const withoutTag = buildICalendar([baseEvent({ tag: null })]);
    expect(withoutTag).not.toContain('CATEGORIES:');
  });

  test('every event gets a unique UID based on its real id', () => {
    const ical = buildICalendar([baseEvent({ id: 'ev-abc123' })]);
    expect(ical).toContain('UID:ev-abc123@aivorah.com');
  });

  test('multiple events each produce their own VEVENT block', () => {
    const ical = buildICalendar([baseEvent({ id: 'ev1' }), baseEvent({ id: 'ev2', date: '2026-04-16' })]);
    expect((ical.match(/BEGIN:VEVENT/g) || []).length).toBe(2);
  });
});
