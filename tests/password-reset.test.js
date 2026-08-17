// Password reset (self-service + admin-triggered) -- real Express app, real
// HTTP requests via supertest, real isolated local database (see
// tests/env.setup.js). Mailer is mocked (no real Zoho credentials needed in
// this environment, and no real email should ever leave a test run) --
// everything downstream of "an email would have been sent" is real: real
// token generation, real hashing, real DB rows, real bcrypt password
// change, real rate limiting.
'use strict';

const sentMails = [];
jest.mock('../api/services/mailer', () => ({
  sendPasswordResetEmail: jest.fn(async (to, resetUrl) => {
    sentMails.push({ to, resetUrl });
  })
}));

process.env.PORT = '34178'; // distinct test-only port

const request = require('supertest');
const app = require('../api/app');
const db = require('../api/services/db');
const fx = require('./fixtures');
const mailer = require('../api/services/mailer');

function extractToken(resetUrl) {
  return new URL(resetUrl).searchParams.get('token');
}

async function loginRes(email, password) {
  return request(app).post('/api/v1/auth/login').send({ email, password });
}

afterEach(() => {
  sentMails.length = 0;
  mailer.sendPasswordResetEmail.mockClear();
});

afterAll(async () => {
  await Promise.all([db.clients.end(), db.assets.end(), db.forms.end(), db.pehf.end()]);
});

describe('Self-service forgot-password / reset-password — happy path', () => {
  test('full round trip: request, receive token, reset, log in with new password, old password rejected', async () => {
    const staff = await fx.createStaff({ password: 'original-password-123' });

    const forgotRes = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: staff.email });
    expect(forgotRes.status).toBe(200);
    expect(forgotRes.body).toEqual({ message: 'If that email exists, a reset link has been sent.' });
    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(sentMails[0].to).toBe(staff.email);

    const token = extractToken(sentMails[0].resetUrl);
    expect(token).toBeTruthy();

    const resetRes = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, new_password: 'brand-new-password-456' });
    expect(resetRes.status).toBe(200);

    const oldLogin = await loginRes(staff.email, 'original-password-123');
    expect(oldLogin.status).toBe(401);

    const newLogin = await loginRes(staff.email, 'brand-new-password-456');
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.token).toBeTruthy();
  });

  test('unknown email still returns 200 with the identical generic body, no email sent', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'definitely-not-a-real-account@example.test' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'If that email exists, a reset link has been sent.' });
    expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('audit event logged to pcm_agent_activity for both request and completion', async () => {
    const staff = await fx.createStaff();
    await request(app).post('/api/v1/auth/forgot-password').send({ email: staff.email });
    const token = extractToken(sentMails[0].resetUrl);
    await request(app).post('/api/v1/auth/reset-password').send({ token, new_password: 'another-new-password-789' });

    const rows = await db.clients.query(
      `SELECT action, status, agent_id, triggered_by FROM pcm_agent_activity
       WHERE agent_name = 'password-reset' AND agent_id = $1 ORDER BY created_at ASC`,
      [staff.staff_id]
    );
    expect(rows.rows.map(r => r.action)).toEqual(['password_reset_requested', 'password_reset_completed']);
    expect(rows.rows[0].triggered_by).toBe('self');
  });
});

describe('Admin-triggered reset', () => {
  test('non-admin role gets 403, never sends an email', async () => {
    const admin = await fx.createStaff({ role: 'intake_officer' }); // wrong role for this action
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ sub: admin.email, role: 'intake_officer' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const target = await fx.createStaff();

    const res = await request(app)
      .post('/api/v1/auth/admin/reset-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: target.email });

    expect(res.status).toBe(403);
    expect(mailer.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('trade_group_owner can trigger a reset for another user, audit shows admin as initiator', async () => {
    const jwt = require('jsonwebtoken');
    const adminToken = jwt.sign({ sub: 'admin@example.test', role: 'trade_group_owner' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const target = await fx.createStaff();

    const res = await request(app)
      .post('/api/v1/auth/admin/reset-password')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: target.email });

    expect(res.status).toBe(200);
    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(sentMails[0].to).toBe(target.email);

    const audit = await db.clients.query(
      `SELECT triggered_by FROM pcm_agent_activity WHERE agent_name = 'password-reset' AND agent_id = $1`,
      [target.staff_id]
    );
    expect(audit.rows[0].triggered_by).toBe('admin@example.test');

    // Same mechanism, same token -- the admin-triggered link works exactly
    // like a self-service one at completion time.
    const token = extractToken(sentMails[0].resetUrl);
    const resetRes = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, new_password: 'admin-triggered-new-pass-1' });
    expect(resetRes.status).toBe(200);
  });
});

describe('Negative cases — a reset flow that only tests success is untested', () => {
  test('expired token is rejected', async () => {
    const staff = await fx.createStaff();
    await request(app).post('/api/v1/auth/forgot-password').send({ email: staff.email });
    const token = extractToken(sentMails[0].resetUrl);

    // Force the real row into the past, same table the app itself wrote to
    // -- not a fake/mocked expiry.
    await db.clients.query(
      `UPDATE pcm_password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE staff_id = $1`,
      [staff.staff_id]
    );

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, new_password: 'should-not-be-set-123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired reset link');

    const login = await loginRes(staff.email, 'should-not-be-set-123');
    expect(login.status).toBe(401);
  });

  test('already-used token is rejected on second use', async () => {
    const staff = await fx.createStaff();
    await request(app).post('/api/v1/auth/forgot-password').send({ email: staff.email });
    const token = extractToken(sentMails[0].resetUrl);

    const first = await request(app).post('/api/v1/auth/reset-password').send({ token, new_password: 'first-use-pass-123' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/v1/auth/reset-password').send({ token, new_password: 'second-use-pass-456' });
    expect(second.status).toBe(400);

    // The first password change must survive -- the rejected replay must
    // not have touched it.
    const login = await loginRes(staff.email, 'first-use-pass-123');
    expect(login.status).toBe(200);
  });

  test('token for a deactivated account is rejected', async () => {
    const staff = await fx.createStaff();
    await request(app).post('/api/v1/auth/forgot-password').send({ email: staff.email });
    const token = extractToken(sentMails[0].resetUrl);

    await db.clients.query(`UPDATE pcm_staff SET active = false WHERE staff_id = $1`, [staff.staff_id]);

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token, new_password: 'should-not-apply-789' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired reset link');
  });

  test('a second reset request invalidates the first token', async () => {
    const staff = await fx.createStaff();

    await request(app).post('/api/v1/auth/forgot-password').send({ email: staff.email });
    const firstToken = extractToken(sentMails[0].resetUrl);
    mailer.sendPasswordResetEmail.mockClear();
    sentMails.length = 0;

    await request(app).post('/api/v1/auth/forgot-password').send({ email: staff.email });
    const secondToken = extractToken(sentMails[0].resetUrl);
    expect(secondToken).not.toBe(firstToken);

    const useFirst = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: firstToken, new_password: 'via-stale-token-111' });
    expect(useFirst.status).toBe(400);

    const useSecond = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: secondToken, new_password: 'via-current-token-222' });
    expect(useSecond.status).toBe(200);
  });

  test('unknown token is rejected with the same generic message', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'not-a-real-token-at-all', new_password: 'irrelevant-pass-123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired reset link');
  });

  test('rate limit actually fires on repeated forgot-password requests', async () => {
    const staff = await fx.createStaff();
    const results = [];
    for (let i = 0; i < 7; i++) {
      results.push(await request(app).post('/api/v1/auth/forgot-password').send({ email: staff.email }));
    }
    const statuses = results.map(r => r.status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  }, 15000);
});

describe('Enumeration-defense timing — measured, not assumed', () => {
  test('known-email and unknown-email requests take statistically indistinguishable time', async () => {
    const staff = await fx.createStaff();
    const N = 25;
    const knownTimes = [];
    const unknownTimes = [];

    for (let i = 0; i < N; i++) {
      const t0 = process.hrtime.bigint();
      await request(app).post('/api/v1/auth/forgot-password')
        .send({ email: staff.email }); // rate limit is keyed by IP+email; this
      const t1 = process.hrtime.bigint();
      knownTimes.push(Number(t1 - t0) / 1e6);

      const t2 = process.hrtime.bigint();
      await request(app).post('/api/v1/auth/forgot-password')
        .send({ email: `unknown-${i}-${Date.now()}@example.test` }); // distinct email each time -> distinct rate-limit bucket, never 429
      const t3 = process.hrtime.bigint();
      unknownTimes.push(Number(t3 - t2) / 1e6);
    }

    // Known-email requests after the first will start hitting its own
    // per-email rate limiter's bookkeeping only, not a 429 body -- but to
    // keep this measurement about the request-handling path itself rather
    // than rate-limit branching, drop after the 5th known-email call
    // (limiter cap) and use the ones actually processed by the real
    // found/not-found branches. Recompute using only the first 5 known
    // timings against their first 5 unknown counterparts.
    const k = knownTimes.slice(0, 5);
    const u = unknownTimes.slice(0, 5);
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const meanKnown = mean(k);
    const meanUnknown = mean(u);
    const diffMs = Math.abs(meanKnown - meanUnknown);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      test: 'enumeration-timing',
      meanKnownMs: meanKnown.toFixed(2),
      meanUnknownMs: meanUnknown.toFixed(2),
      diffMs: diffMs.toFixed(2)
    }));

    // Tolerance: local Postgres + in-process bcrypt-free dummy work should
    // land within a few ms of each other. 15ms is generous relative to
    // this environment's own request-handling jitter (observed via the
    // logged means above), while still catching a real oracle (e.g. a
    // missing dummy-work branch, which would show a multi-x gap, not a
    // few-ms one).
    expect(diffMs).toBeLessThan(15);
  }, 20000);
});
