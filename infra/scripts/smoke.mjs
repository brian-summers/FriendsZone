#!/usr/bin/env node
/**
 * Smoke-test a deployment by doing what users do, including writing.
 *
 *   node infra/scripts/smoke.mjs https://<distribution>
 *
 * Health checks and a registration prove the process is up and the users
 * table works; none of them touch a table with row-level security, so none of
 * them would notice a deploy that cannot save a calendar
 * (docs/adr/0031-rls-request-scope.md). So this registers two throwaway
 * accounts, befriends them, writes on both sides of the friendship - including
 * a cross-owner write - reads each from the other, and deletes both accounts
 * whether or not anything failed.
 *
 * What it leaves behind is what any deleted account leaves: two tombstoned
 * user ids (docs/adr/0022-export-and-deletion.md). It prints no event content
 * and no credentials.
 */

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!base.startsWith('https://') && !base.startsWith('http://localhost')) {
  console.error('usage: node infra/scripts/smoke.mjs https://<distribution>');
  process.exit(2);
}
const api = `${base}/api`;

const tag = Math.random().toString(36).slice(2, 8);
const step = async (name, fn) => {
  try {
    await fn();

    console.log(`  ok    ${name}`);
  } catch (error) {

    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
};
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};

async function call(method, path, { cookie, body } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON is itself a finding; callers check the status first.
  }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] };
}

function at(daysAhead, hour) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}
const windowQs = `start=${encodeURIComponent(at(-1, 0))}&end=${encodeURIComponent(at(13, 0))}`;

async function register(name) {
  const handle = `smoke${name}${tag}`;
  const res = await call('POST', '/v1/auth/register', {
    body: {
      email: `${handle}@example.com`,
      password: `${crypto.randomUUID()}-${crypto.randomUUID()}`,
      handle,
      displayName: `Smoke test ${name}`,
    },
  });
  expect(res.status === 200, `register ${name}: ${res.status}`);
  const cookie = res.setCookie[0]?.split(';')[0];
  expect(cookie, `register ${name}: no session cookie`);
  const me = await call('GET', '/v1/me', { cookie });
  expect(me.status === 200 && me.json?.id, `me ${name}: ${me.status}`);
  return { id: me.json.id, handle, cookie };
}

const people = [];
let failed = false;

console.log(`Smoke test against ${base}`);
try {
  await step('API is ready (database reachable)', async () => {
    const res = await call('GET', '/readyz');
    expect(res.status === 200, `readyz: ${res.status}`);
  });

  let a;
  let b;
  await step('register two accounts', async () => {
    a = await register('a');
    people.push(a);
    b = await register('b');
    people.push(b);
  });

  await step('befriend them', async () => {
    const asked = await call('POST', `/v1/people/${b.id}/friend-request`, { cookie: a.cookie, body: {} });
    expect(asked.status === 200, `request: ${asked.status}`);
    const answered = await call('POST', `/v1/me/friend-requests/${a.id}`, {
      cookie: b.cookie,
      body: { decision: 'ACCEPT' },
    });
    expect(answered.status === 200, `accept: ${answered.status}`);
  });

  let eventId;
  await step('write an event, and read it back as its owner', async () => {
    const created = await call('POST', '/v1/events', {
      cookie: a.cookie,
      body: { title: 'Smoke test', timeRange: { start: at(2, 14), end: at(2, 15) }, exclusive: true },
    });
    expect(created.status === 200, `create: ${created.status} ${JSON.stringify(created.json)}`);
    eventId = created.json.id;
    const own = await call('GET', `/v1/users/${a.id}/calendar?${windowQs}`, { cookie: a.cookie });
    expect(own.status === 200, `own calendar: ${own.status}`);
    expect(own.json.details.some((e) => e.id === eventId), 'owner cannot see their own event');
  });

  await step("see the friend's event as busy", async () => {
    const view = await call('GET', `/v1/users/${a.id}/calendar?${windowQs}`, { cookie: b.cookie });
    expect(view.status === 200, `friend view: ${view.status}`);
    const start = Date.parse(at(2, 14));
    expect(
      view.json.busy.some((r) => Date.parse(r.start) <= start && Date.parse(r.end) > start),
      'friend sees no busy time where the event is',
    );
  });

  await step('save quiet hours, and show them to the friend', async () => {
    const saved = await call('PUT', '/v1/me/quiet-hours', {
      cookie: a.cookie,
      body: { quietHours: { startMinute: 1380, endMinute: 420, timeZone: 'UTC' } },
    });
    expect(saved.status === 200, `save: ${saved.status}`);
    const view = await call('GET', `/v1/users/${a.id}/calendar?${windowQs}`, { cookie: b.cookie });
    expect(view.json.quietHours?.startMinute === 1380, 'friend does not see the window');
  });

  await step('book a hangout onto both calendars (a cross-owner write)', async () => {
    const proposed = await call('POST', '/v1/hangouts', {
      cookie: b.cookie,
      body: { inviteeId: a.id, title: 'Smoke hangout', proposedSlots: [{ start: at(3, 12), end: at(3, 13) }] },
    });
    expect(proposed.status === 200, `propose: ${proposed.status}`);
    const accepted = await call('POST', `/v1/hangouts/${proposed.json.id}/respond`, {
      cookie: a.cookie,
      body: { decision: 'ACCEPT', slotIndex: 0 },
    });
    expect(accepted.status === 200, `accept: ${accepted.status}`);
    expect(accepted.json.resultingEventIds?.length === 2, 'not booked on both calendars');
  });
} catch {
  failed = true;
} finally {
  for (const person of people) {
    const res = await call('POST', '/v1/me/delete', {
      cookie: person.cookie,
      body: { confirmHandle: person.handle },
    }).catch((error) => ({ status: String(error) }));
    if (res.status === 200) {
      console.log(`  ok    delete ${person.handle}`);
    } else {
      failed = true;
      console.log(`  FAIL  delete ${person.handle}: ${res.status} - delete it by hand`);
    }
  }
}

console.log(failed ? 'SMOKE TEST FAILED' : 'Smoke test passed');
process.exit(failed ? 1 : 0);
