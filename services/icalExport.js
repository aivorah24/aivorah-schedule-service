// Builds an RFC 5545 .ics calendar body from mapped schedule events.
function buildICalendar(mappedEvents) {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  let ical = 'BEGIN:VCALENDAR\r\n';
  ical += 'VERSION:2.0\r\n';
  ical += 'PRODID:-//Aivorah//Schedule//EN\r\n';
  ical += 'CALSCALE:GREGORIAN\r\n';
  ical += 'METHOD:PUBLISH\r\n';
  ical += 'X-WR-CALNAME:Aivorah Schedule\r\n';
  ical += 'X-WR-TIMEZONE:Asia/Kolkata\r\n';

  for (const ev of mappedEvents) {
    if (!ev.date) continue;
    const dateVal = ev.date.replace(/-/g, '');
    let stTime = ev.startTime;
    let enTime = ev.endTime;

    let startStr = '';
    let endStr = '';

    if (!stTime) {
      stTime = '00:00';
    }

    if (stTime === '23:59') {
      const nextDate = new Date(ev.date);
      nextDate.setDate(nextDate.getDate() + 1);
      const nextDateStr = nextDate.toISOString().split('T')[0].replace(/-/g, '');
      startStr = `DTSTART;VALUE=DATE:${dateVal}\r\n`;
      endStr = `DTEND;VALUE=DATE:${nextDateStr}\r\n`;
    } else {
      if (!enTime) {
        const [h, m] = stTime.split(':').map(Number);
        enTime = `${pad((h + 1) % 24)}:${pad(m)}`;
      }
      const stTimeVal = stTime.replace(/:/g, '') + '00';
      const enTimeVal = enTime.replace(/:/g, '') + '00';
      startStr = `DTSTART;TZID=Asia/Kolkata:${dateVal}T${stTimeVal}\r\n`;
      endStr = `DTEND;TZID=Asia/Kolkata:${dateVal}T${enTimeVal}\r\n`;
    }

    ical += 'BEGIN:VEVENT\r\n';
    ical += `UID:${ev.id}@aivorah.com\r\n`;
    ical += `DTSTAMP:${dtstamp}\r\n`;
    ical += startStr;
    ical += endStr;
    ical += `SUMMARY:${ev.title || ''}\r\n`;
    if (ev.note) {
      ical += `DESCRIPTION:${ev.note.replace(/\r?\n/g, '\\n')}\r\n`;
    } else {
      ical += `DESCRIPTION:\r\n`;
    }
    if (ev.tag) {
      ical += `CATEGORIES:${ev.tag}\r\n`;
    }
    ical += 'STATUS:CONFIRMED\r\n';
    ical += 'END:VEVENT\r\n';
  }

  ical += 'END:VCALENDAR';
  return ical;
}

module.exports = { buildICalendar };
