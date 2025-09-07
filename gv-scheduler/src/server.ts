// src/server.ts
import Fastify from "fastify";
import { z } from "zod";
import { google } from "googleapis";
import { v4 as uuidv4 } from "uuid";

/**
 * Minimal Fastify server that schedules a Google Calendar event and emails the invite.
 * Env required:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 * Optional:
 *   PORT (default 4005)
 *   GOOGLE_CALENDAR_ID (default "primary")
 *   TZ (default "America/New_York")
 */

const app = Fastify({ logger: true });

const PORT = Number(process.env.PORT || 4005);
const CAL_ID = process.env.GOOGLE_CALENDAR_ID || "primary";
const DEFAULT_TZ = process.env.TZ || "America/New_York";

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    // Redirect URI not used here; refresh token already obtained
    "http://localhost"
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

/* --------------------------- Request validation --------------------------- */

const ScheduleBody = z
  .object({
    email: z.string().email(),
    label: z.string().optional(),                 // e.g. "Wednesday afternoon", "Tue 11am"
    startIso: z.string().datetime().optional(),   // concrete start datetime
    durationMin: z.number().int().min(15).max(240).optional().default(45),
    tz: z.string().optional().default(DEFAULT_TZ),
    createMeet: z.boolean().optional().default(true),

    // Optional for idempotency/logging
    roomId: z.string().optional(),
    agentId: z.string().optional(),
    externalKey: z.string().optional(),
  })
  .refine(
    (b) => Boolean(b.label) || Boolean(b.startIso),
    { message: "Provide either 'label' or 'startIso'." }
  );

/* ------------------------------ Label parsing ----------------------------- */

function parseLabel(label?: string): { day: string | null; timeText: string | null } {
  if (!label) return { day: null, timeText: null };
  const t = label.trim();

  // Extract first token as potential weekday
  let [first, ...rest] = t.split(/\s+/);

  const day =
    /^sun/i.test(first) ? "Sunday" :
    /^mon/i.test(first) ? "Monday" :
    /^tue/i.test(first) ? "Tuesday" :
    /^wed/i.test(first) ? "Wednesday" :
    /^thu/i.test(first) ? "Thursday" :
    /^fri/i.test(first) ? "Friday" :
    /^sat/i.test(first) ? "Saturday" : null;

  let timeText = rest.join(" ").trim();

  // Friendly words → times
  if (/afternoon/i.test(timeText)) timeText = "3:00 PM";
  else if (/morning/i.test(timeText)) timeText = "10:00 AM";
  // 3pm → 3:00 PM
  else if (/^(\d{1,2})(am|pm)$/i.test(timeText)) {
    const m = timeText.match(/^(\d{1,2})(am|pm)$/i)!;
    timeText = `${m[1]}:00 ${m[2].toUpperCase()}`;
  }
  // 3:30 pm → 3:30 PM
  else if (/^(\d{1,2}):(\d{2})\s*(am|pm)$/i.test(timeText)) {
    const m = timeText.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)!;
    timeText = `${m[1]}:${m[2]} ${m[3].toUpperCase()}`;
  }

  if (!timeText) timeText = null;
  return { day, timeText };
}

function nextOccurrence(day: string, timeText: string): Date {
  // Convert weekday to 0..6 (Sun..Sat)
  const dow =
    day === "Sunday" ? 0 :
    day === "Monday" ? 1 :
    day === "Tuesday" ? 2 :
    day === "Wednesday" ? 3 :
    day === "Thursday" ? 4 :
    day === "Friday" ? 5 : 6; // Saturday

  const now = new Date();
  const d = new Date(now);
  let delta = dow - d.getDay();
  if (delta <= 0) delta += 7; // next week if today has passed
  d.setDate(d.getDate() + delta);

  // Parse "H:MM AM/PM"
  const m = timeText.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i) || ["", "10", "00", "AM"];
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;

  d.setHours(hh, mm, 0, 0);
  return d;
}

function formatWhenText(d: Date, tz: string) {
  const day = new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
  return `${day} at ${time} ${tz}`;
}

/* --------------------------- Dev idempotency set -------------------------- */

const seen = new Set<string>();

/* --------------------------------- Routes -------------------------------- */

app.get("/health", async () => ({ ok: true }));

app.post("/schedule", async (req, reply) => {
  const parsed = ScheduleBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ ok: false, error: parsed.error.flatten() });
  }
  const b = parsed.data;

  // Determine start time
  let start: Date;
  if (b.startIso) {
    start = new Date(b.startIso);
  } else {
    const { day, timeText } = parseLabel(b.label);
    if (!day) {
      return reply.code(400).send({
        ok: false,
        error: "label must include a weekday (e.g., 'Wednesday', 'Tue').",
      });
    }
    start = nextOccurrence(day, timeText || "10:00 AM");
  }
  const end = new Date(start.getTime() + b.durationMin * 60 * 1000);

  // Simple idempotency for dev
  const idemKey = b.externalKey ?? `${b.roomId ?? ""}|${start.toISOString()}`;
  if (idemKey && seen.has(idemKey)) {
    return reply.code(409).send({ ok: false, error: "duplicate", whenText: formatWhenText(start, b.tz) });
  }
  if (idemKey) seen.add(idemKey);

  try {
    const calendar = google.calendar({ version: "v3", auth: getOAuthClient() });

    const event: any = {
      summary: "Grand Villa Tour",
      description:
        "Thanks for scheduling a visit to Grand Villa. This invite includes time, location, and directions.",
      location: "Grand Villa",
      start: { dateTime: start.toISOString(), timeZone: b.tz },
      end:   { dateTime: end.toISOString(),   timeZone: b.tz },

      // IMPORTANT: guests + sendUpdates -> Google emails the invitation
      attendees: [{ email: b.email }],

      reminders: { useDefault: true },
      guestsCanSeeOtherGuests: false,
      guestsCanInviteOthers: false,

      // For your logging/dedupe
      extendedProperties: { private: { externalKey: idemKey } },
    };

    if (b.createMeet) {
      event.conferenceData = {
        createRequest: {
          requestId: uuidv4(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    const { data } = await calendar.events.insert({
      calendarId: CAL_ID,
      requestBody: event,
      sendUpdates: "all",            // <— emails guests
      conferenceDataVersion: 1,      // <— needed when using conferenceData
    });

    const whenText = formatWhenText(start, b.tz);
    req.log.info({ eventId: data.id, htmlLink: data.htmlLink, whenText }, "Calendar invite created");

    return reply.send({
      ok: true,
      eventId: data.id,
      htmlLink: data.htmlLink,
      whenText,
    });
  } catch (err: any) {
    req.log.error({ err: err?.response?.data ?? err }, "Calendar insert failed");
    return reply.code(500).send({ ok: false, error: err?.message ?? "calendar_error" });
  }
});

/* ------------------------------ Server start ------------------------------ */

app.listen({ host: "0.0.0.0", port: PORT }).then(() => {
  app.log.info(`Server listening on http://127.0.0.1:${PORT}`);
});
