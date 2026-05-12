import request from 'supertest';
import { app } from '../src/app';
import { createUser, createGroup } from './helpers/seed';

describe('GET /v1/groups/:group_id/basket', () => {

  it('returns basket overview for admin', async () => {
    // Scenario: admin of a newly created (empty) group fetches the basket —
    //           response must include balance fields and a basket_id UUID.
    // Arrange
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);

    // Act
    const res = await request(app)
      .get(`/v1/groups/${group_id}/basket`)
      .set('Authorization', `Bearer ${admin.token}`);

    // Assert
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(typeof data.basket_id).toBe('string');
    expect(typeof data.current_balance).toBe('number');
    expect(typeof data.total_credited).toBe('number');
    expect(typeof data.total_lent_out).toBe('number');
    expect(typeof data.total_debited).toBe('number');
  });

  it('returns 401 without a token', async () => {
    // Scenario: request arrives with no Authorization header —
    //           auth middleware must reject before any DB query runs.
    const res = await request(app).get('/v1/groups/00000000-0000-0000-0000-000000000000/basket');
    expect(res.status).toBe(401);
  });

});



// ─── shared Arrange helper ────────────────────────────────────────────────────
// repayLoan tests all need: user → group → basket funded → loan disbursed.
// Extracting avoids repeating 4 steps in every it() block.
// Returns everything the repay/update tests need.
async function arrangeActiveLoan() {
  const admin = await createUser();
  const { group_id, invitation_code } = await createGroup(admin.token);

  // A fresh group has zero balance — fund it before disbursing.
  await request(app)
    .post(`/v1/groups/${group_id}/basket/adjustments`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ direction: 'C', amount: 10000, notes: 'Initial credit' });

  // Disburse to the admin (group creator is automatically an active member).
  // monthly_interest_rate = 5% (seed default), so:
  //   first_month_interest = round(5000 × 5%) = 250
  //   net_disbursed        = 5000 - 250        = 4750
  //   basket after         = 10000 - 4750       = 5250
  const disburseRes = await request(app)
    .post(`/v1/groups/${group_id}/loans`)
    .set('Authorization', `Bearer ${admin.token}`)
    .send({ borrower_user_id: admin.id, principal: 5000, expected_close_date: '2027-01-01' });

  const loan_id = disburseRes.body.data.loan_id as string;
  const basketAfterDisburse = 5250;

  return { admin, group_id, loan_id, basketAfterDisburse, invitation_code };
}

describe('POST /v1/groups/:group_id/loans', () => {

  it('admin can disburse a loan to a member', async () => {
    // Scenario: basket has ₹10000, admin disburses ₹5000 to themselves (valid member) —
    //           first month interest (5% = ₹250) is deducted upfront, only ₹4750 leaves the basket.
    // Arrange
    const admin = await createUser();
    const { group_id } = await createGroup(admin.token);

    // Credit the basket first — a fresh group has zero balance and disbursement
    // will fail with BASKET_INSUFFICIENT without this step.
    await request(app)
      .post(`/v1/groups/${group_id}/basket/adjustments`)  // backticks, not single quotes
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ direction: 'C', amount: 10000, notes: 'Initial credit' });

    // Act — admin is already a member (group creator), so admin.id is a valid borrower.
    // interest_rate must be within the group's 1–5 range set in createGroup defaults.
    // expected_close_date must be in the future.
    const res = await request(app)
      .post(`/v1/groups/${group_id}/loans`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        borrower_user_id:    admin.id,
        principal:           5000,
        expected_close_date: '2027-01-01',
        notes:               'Test loan',
      });

    // Assert — successful disbursement returns 201 with loan details.
    // res.body.data (not res.body) because the API wraps all responses in { data: ... }.
    expect(res.status).toBe(201);

    // first month interest is deducted upfront at disbursement
    // monthly_interest_rate = 5% (group default), principal = 5000
    // first_month_interest = round(5000 × 5%) = 250
    // amount_disbursed_to_borrower = 5000 - 250 = 4750
    // basket_balance_after = 10000 - 4750 = 5250
    const data = res.body.data;
    expect(typeof data.loan_id).toBe('string');
    expect(data.principal).toBe(5000);
    expect(data.first_month_interest).toBe(250);
    expect(data.amount_disbursed_to_borrower).toBe(4750);
    expect(data.status).toBe('Active');
    expect(data.basket_balance_after).toBe(5250);
  });

  it('returns 409 when borrower is not a group member', async () => {
    // Scenario: admin tries to disburse to a user who exists in the system
    //           but has never joined this group — service must reject before touching the basket.
    // Arrange
    const admin  = await createUser();
    const outsider = await createUser(); // different user, not added to the group
    const { group_id } = await createGroup(admin.token);

    await request(app)
      .post(`/v1/groups/${group_id}/basket/adjustments`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ direction: 'C', amount: 10000, notes: 'Initial credit' });

    // Act
    const res = await request(app)
      .post(`/v1/groups/${group_id}/loans`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({
        borrower_user_id:    outsider.id,  // not a member
        principal:           5000,
        expected_close_date: '2027-01-01',
      });

    // Assert
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BORROWER_NOT_MEMBER');
  });

});

describe('POST /v1/groups/:group_id/loans/:loan_id/repay', () => {

  it('admin can record an interest-only payment — loan stays Active', async () => {
    // Scenario: active loan exists, admin records a ₹200 interest payment with no principal —
    //           loan must remain Active, basket increases by ₹200, total_interest_paid updates.
    // Arrange: get a funded group with an active loan
    const { admin, group_id, loan_id, basketAfterDisburse } = await arrangeActiveLoan();

    // Act: pay interest only — principal_repaid is omitted (defaults to 0 in the service)
    // txn_date is required by the validator — it's the date the cash was physically received
    const res = await request(app)
      .post(`/v1/groups/${group_id}/loans/${loan_id}/repay`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ interest_paid: 200, txn_date: '2026-06-01' });

    // Assert: 200 because repay is not a creation — it updates an existing resource
    expect(res.status).toBe(200);

    const data = res.body.data;
    // loan stays Active because principal was not included in this repayment
    expect(data.status).toBe('Active');
    expect(data.total_interest_paid).toBe(200);
    // basket goes up by the interest amount (money flows back in)
    expect(data.basket_balance_after).toBe(basketAfterDisburse + 200); // 5250 + 200 = 5450
  });

  it('admin can fully repay a loan — status becomes Repaid', async () => {
    // Scenario: admin repays full principal (₹5000) plus ₹100 interest in one call —
    //           loan must close (status = Repaid), full amount returns to basket.
    const { admin, group_id, loan_id, basketAfterDisburse } = await arrangeActiveLoan();

    // Act: repay full principal (must match exactly — partial repayment is not allowed)
    // plus some interest accumulated this month
    const res = await request(app)
      .post(`/v1/groups/${group_id}/loans/${loan_id}/repay`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ principal_repaid: 5000, interest_paid: 100, txn_date: '2026-06-01' });

    expect(res.status).toBe(200);

    const data = res.body.data;
    // including principal in the repayment triggers loan closure
    expect(data.status).toBe('Repaid');
    expect(data.total_interest_paid).toBe(100);
    // basket gets back the full principal + interest
    expect(data.basket_balance_after).toBe(basketAfterDisburse + 5000 + 100); // 5250 + 5100 = 10350
  });

  it('returns 409 when trying to repay a partial principal', async () => {
    // Scenario: admin sends ₹2500 when the loan principal is ₹5000 —
    //           service enforces all-or-nothing repayment, rejects anything less than the full amount.
    const { admin, group_id, loan_id } = await arrangeActiveLoan();

    // Act: send 2500 instead of the full 5000 — service rejects partial repayment
    const res = await request(app)
      .post(`/v1/groups/${group_id}/loans/${loan_id}/repay`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ principal_repaid: 2500, txn_date: '2026-06-01' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PARTIAL_REPAYMENT_NOT_ALLOWED');
  });

  it('returns 409 when loan is already Repaid', async () => {
    // Scenario: loan is fully repaid (status = Repaid), then a second repayment is attempted —
    //           service must block any further payments on a closed loan.
    const { admin, group_id, loan_id } = await arrangeActiveLoan();

    // First repayment closes the loan
    await request(app)
      .post(`/v1/groups/${group_id}/loans/${loan_id}/repay`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ principal_repaid: 5000, txn_date: '2026-06-01' });

    // Second repayment on an already-closed loan should be rejected
    const res = await request(app)
      .post(`/v1/groups/${group_id}/loans/${loan_id}/repay`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ interest_paid: 100, txn_date: '2026-06-02' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LOAN_CLOSED');
  });

});

// ─── PATCH /v1/groups/:group_id/loans/:loan_id ───────────────────────────────
// YOUR TURN — implement all three cases below.
// Hints for each test:
//   Arrange: use arrangeActiveLoan() — you get admin, group_id, loan_id
//   Method:  PATCH (not POST)
//   Body:    either { status: 'WrittenOff' } OR { expected_close_date: 'YYYY-MM-DD' }
//   Return:  full loan object — check status, closed_at, expected_close_date fields
describe('PATCH /v1/groups/:group_id/loans/:loan_id', () => {

  it('admin can write off an active loan — status becomes WrittenOff', async () => {
    // Scenario: admin decides the borrower cannot repay — writes off the active loan.
    //           status must become WrittenOff, closed_at must be set, total_lent_out decreases.
    // TODO: implement
  });

  it('admin can extend the expected_close_date', async () => {
    // Scenario: borrower needs more time — admin pushes the due date forward.
    //           status stays Active, only expected_close_date changes.
    // TODO: implement
  });

  it('returns 409 when trying an invalid status transition', async () => {
    // Scenario: admin sends { status: 'Repaid' } via PATCH — only WrittenOff is a valid
    //           PATCH transition (Repaid happens automatically through the repay endpoint).
    // TODO: implement
  });

});

// ─── GET /v1/groups/:group_id/loans/:loan_id ─────────────────────────────────
describe('GET /v1/groups/:group_id/loans/:loan_id', () => {

  it('admin can fetch full loan detail including transaction history', async () => {
    // Scenario: admin fetches a loan that has had one repayment recorded —
    //           response must include the full loan object plus a non-empty transactions array.
    const { admin, group_id, loan_id } = await arrangeActiveLoan();
    
    const res = await request(app)
      .get(`/v1/groups/${group_id}/loans/${loan_id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);

    const data = res.body.data;
    expect(data.loan_id).toBe(loan_id);
    expect(Array.isArray(data.transactions)).toBe(true);
    expect(data.transactions.length).toBeGreaterThan(0);
    expect(data.borrower.user_id).toBe(admin.id);
  });

  it('returns 403 when a non-borrower member tries to fetch the loan', async () => {
    // Scenario: a second user joins the group but is not the borrower on this loan —
    //           they must be blocked even though they are an active member.
    const { group_id, loan_id, invitation_code } = await arrangeActiveLoan();
    const member = await createUser();

    // POST /v1/groups/join — not /groups/:id/members (that route doesn't exist)
    await request(app)
      .post('/v1/groups/join')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ invitation_code });

    const res = await request(app)
      .get(`/v1/groups/${group_id}/loans/${loan_id}`)
      .set('Authorization', `Bearer ${member.token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

});

// ─── GET /v1/groups/:group_id/loans ──────────────────────────────────────────
describe('GET /v1/groups/:group_id/loans', () => {

  it('admin sees all loans in the group', async () => {
    // Scenario: group has one active loan, admin lists loans with no filters —
    //           must return an array containing that loan with loan_id and status fields.
    const { admin, group_id } = await arrangeActiveLoan();
    
    const res = await request(app)
      .get(`/v1/groups/${group_id}/loans`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toHaveProperty('loan_id');
    expect(res.body.data[0]).toHaveProperty('status');
  });

  it('member only sees their own loans', async () => {
    // Scenario: two members each have a loan, second member lists loans —
    //           must only see their own loan, not the admin's.
    const { admin, group_id, invitation_code } = await arrangeActiveLoan();
    const member = await createUser();

    await request(app)
      .post('/v1/groups/join')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ invitation_code });

    // Disburse a second loan to the member — now the group has 2 loans total.
    // Basket has 5250 after arrangeActiveLoan, so 2000 is safely within balance.
    await request(app)
      .post(`/v1/groups/${group_id}/loans`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ borrower_user_id: member.id, principal: 2000, expected_close_date: '2027-01-01' });

    const res = await request(app)
      .get(`/v1/groups/${group_id}/loans`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    // member sees exactly 1 loan (theirs), not 2 — admin's loan is filtered out
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].borrower_user_id).toBe(member.id);
  });

});

// ─── GET /v1/groups/:group_id/basket/transactions ────────────────────────────
describe('GET /v1/groups/:group_id/basket/transactions', () => {

  it('admin sees all basket transactions', async () => {
    // Scenario: a loan has been disbursed (creates LOAN_DISBURSED + INTEREST_ACCRUED txns),
    //           admin lists all transactions — must get both entries with txn_type, direction, amount.
    // Note: this endpoint is paginated — response is { data: { data: [...], next_cursor } }
    const { admin, group_id } = await arrangeActiveLoan();

    const res = await request(app)
      .get(`/v1/groups/${group_id}/basket/transactions`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const items = res.body.data.data;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty('txn_type');
    expect(items[0]).toHaveProperty('direction');
    expect(items[0]).toHaveProperty('amount');
  });

  it('member only sees transactions they are counterparty to', async () => {
    // Scenario: basket has a loan transaction (borrower = admin) and an ADJUSTMENT (no counterparty).
    //           a second member lists transactions — must not see either (they're counterparty to none).
    const { group_id, invitation_code } = await arrangeActiveLoan();
    const member = await createUser();

    await request(app)
      .post('/v1/groups/join')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ invitation_code });

    const res = await request(app)
      .get(`/v1/groups/${group_id}/basket/transactions`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    const items = res.body.data.data;
    expect(Array.isArray(items)).toBe(true);
    // ADJUSTMENT has no counterparty; admin's loan txns have counterparty = admin — member sees nothing
    expect(items.length).toBe(0);
  });

});
