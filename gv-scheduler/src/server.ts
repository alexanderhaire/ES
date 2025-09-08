import 'dotenv/config';
import Fastify from 'fastify';
import { z } from 'zod';
import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';

// Environment validation
const REQUIRED_ENV = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_CALENDAR_ID',
] as const;

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Environment variable ${key} is required`);
  }
}

const PORT = Number(process.env.PORT) || 4005;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const DEFAULT_TIMEZONE = process.env.TZ || 'America/New_York';

// Google Calendar setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID!,
  process.env.GOOGLE_CLIENT_SECRET!
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN! });

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Fastify server initialization
const app = Fastify({ logger: true });

// Request validation schema
const ScheduleRequestSchema = z.object({
  email: z.string().email('Invalid email address'),
  label: z.string().optional().describe('e.g., "Monday 1pm"'),
  startIso: z.string().datetime('Invalid ISO datetime').optional(),
  durationMin: z.number().int().min(15).max(240).optional().default(45),
  tz: z.string().optional().default(DEFAULT_TIMEZONE),
  createMeet: z.boolean().optional().default(true),
  roomId: z.string().optional(),
  agentId: z.string().optional(),
  externalKey: z.string().optional(),
}).refine(data => data.label || data.startIso, {
  message: 'Either "label" or "startIso" must be provided',
});

// Label parsing utility
function parseLabel(label?: string): { day: string | null; timeText: string | null } {
  if (!label) return { day: null, timeText: null };

  const dayRegex = new RegExp(
    '(sun|mon|tue|wed|thu|fri|sat|monday|tuesday|wednesday|thursday|friday|saturday|sunday)',
    'i'
  );
  const timeRegex = /(\d{1,2})(:(\d{2}))?\s*(am|pm)?/i;

  const dayMatch = label.match(dayRegex);
  if (!dayMatch) return { day: null, timeText: null };

  let day = dayMatch[0].charAt(0).toUpperCase() + dayMatch[0].slice(1).toLowerCase();
  const dayMap: Record<string, string> = {
    Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
    Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
  };
  day = dayMap[day] || day;

  const start = dayMatch.index! + dayMatch[0].length;
  const after = label.slice(start);
  const timeMatch = after.match(timeRegex);

  let timeText = timeMatch
    ? `${timeMatch[1]}:${timeMatch[3] || '00'} ${timeMatch[4] || ''}`.trim()
    : null;

  if (timeText) {
    if (/^(\d{1,2})(am|pm)$/i.test(timeText)) {
      const m = /^(\d{1,2})(am|pm)$/i.exec(timeText)!;
      timeText = `${m[1]}:00 ${m[2].toUpperCase()}`;
    } else if (/^(\d{1,2}):(\d{2})\s*(am|pm)$/i.test(timeText)) {
      const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(timeText)!;
      timeText = `${m[1]}:${m[2]} ${m[3].toUpperCase()}`;
    }
  }

  if (/afternoon/i.test(label)) timeText = '3:00 PM';
  else if (/morning/i.test(label)) timeText = '10:00 AM';
  if (!timeText) timeText = '10:00 AM';

  return { day, timeText };
}

// Calculate next occurrence
function nextOccurrence(day: string, timeText: string): Date {
  const dowMap: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
    Friday: 5, Saturday: 6,
  };
  const dow = dowMap[day] ?? 0;

  const now = new Date();
  const target = new Date(now);
  let delta = dow - target.getDay();
  if (delta <= 0) delta += 7; // Next week if past today
  target.setDate(target.getDate() + delta);

  const [time, period] = timeText.split(/\s+/);
  const [hh, mm = '00'] = time.split(':');
  let hour = parseInt(hh, 10);
  if (period?.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (period?.toUpperCase() === 'AM' && hour === 12) hour = 0;

  target.setHours(hour, parseInt(mm, 10), 0, 0);
  return target;
}

// Format event time
function formatWhenText(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  }).format(date);
}

// Idempotency set
const seenKeys = new Set<string>();

// Routes
app.get('/health', async (req, reply) => {
  reply.send({ ok: true });
});

app.post('/schedule', async (req, reply) => {
  const parsed = ScheduleRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.status(400).send({ ok: false, error: parsed.error.errors });
  }

  const {
    email,
    label,
    startIso,
    durationMin,
    tz,
    createMeet,
    roomId,
    agentId,
    externalKey,
  } = parsed.data;

  // Determine start time
  let start: Date;
  if (startIso) {
    start = new Date(startIso);
  } else {
    const { day, timeText } = parseLabel(label);
    if (!day) {
      return reply.status(400).send({
        ok: false,
        error: 'Label must include a weekday (e.g., "Wednesday", "Tue").',
      });
    }
    start = nextOccurrence(day, timeText!);
  }
  const end = new Date(start.getTime() + durationMin * 60 * 1000);

  // Check for conflicts
  try {
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    if (response.data.items?.length) {
      req.log.warn({ start: start.toISOString(), conflicts: response.data.items.length }, 'Calendar conflict');
      return reply.status(409).send({
        ok: false,
        error: 'time_conflict',
        conflicts: response.data.items.map((e) => e.summary),
      });
    }
  } catch (err) {
    req.log.error({ err }, 'Failed to check calendar availability');
    return reply.status(500).send({ ok: false, error: 'availability_check_failed' });
  }

  // Idempotency check
  const idempKey = externalKey ?? `${roomId ?? ''}|${start.toISOString()}`;
  if (idempKey && seenKeys.has(idempKey)) {
    return reply.status(409).send({
      ok: false,
      error: 'duplicate',
      whenText: formatWhenText(start, tz),
    });
  }
  if (idempKey) seenKeys.add(idempKey);

  // Create calendar event
  try {
    const event = {
      summary: 'Grand Villa Tour',
      description: 'Thank you for scheduling a visit to Grand Villa. This invite includes time, location, and directions.',
      location: 'Grand Villa',
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
      attendees: [{ email }],
      reminders: { useDefault: true },
      guestsCanSeeOtherGuests: false,
      guestsCanInviteOthers: false,
      extendedProperties: { private: { externalKey: idempKey } },
    };

    if (createMeet) {
      event.conferenceData = {
        createRequest: { requestId: uuidv4(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
      };
    }

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: event,
      sendUpdates: 'all',
      conferenceDataVersion: createMeet ? 1 : 0,
    });

    const whenText = formatWhenText(start, tz);
    req.log.info({ eventId: response.data.id, htmlLink: response.data.htmlLink, whenText }, 'Event created');
    return reply.send({
      ok: true,
      eventId: response.data.id,
      htmlLink: response.data.htmlLink,
      whenText,
    });
  } catch (err) {
    req.log.error({ err: err?.response?.data ?? err }, 'Failed to create calendar event');
    return reply.status(500).send({ ok: false, error: err?.message ?? 'event_creation_failed' });
  }
});

// Server start
app.listen({ host: '0.0.0.0', port: PORT })
  .then(() => app.log.info(`Server listening on http://127.0.0.1:${PORT} and http://192.168.1.245:${PORT}`))
  .catch((err) => {
    app.log.error(err, 'Server failed to start');
    process.exit(1);
  });