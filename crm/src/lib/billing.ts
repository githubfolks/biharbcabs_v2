import { query, withTransaction } from './db';
import { getCompanyBillingInfo, getRevenueProtectionPolicy, getSplitRules } from './settings';
import { gstIncluded, round2 } from './fare-split';
import { nextDocumentNumber } from './gst-documents';
import { documentTaxSplit, taxColumns } from './place-of-supply';
import { creditLimitFor } from './driver-dues';
import { PoolClient } from 'pg';

export interface FinalBillingInput {
  bookingId: number;
  closingKm?: number;
  tollParking?: number;
  extraHours?: number;
  cashCollectedByDriver: number;
  notes?: string;
}

export interface BillingCalculationResult {
  bookingId: number;
  bookingCode: string;
  baseFare: number;
  extraKmCharges: number;
  extraHourCharges: number;
  tollParking: number;
  totalCustomerPayable: number;
  advancePaid: number;
  balanceCustomerDue: number;
  cashCollectedByDriver: number;
  companyCommission: number;
  driverGrossEarnings: number;
  driverNetSettlement: number;
  settlementType: 'PAYABLE_TO_DRIVER' | 'RECEIVABLE_FROM_DRIVER' | 'SETTLED_EXACT';
  newDriverWalletBalance: number;
  invoiceNumber: string;
  securityReserveDeducted?: number;
  newSecurityReserveBalance?: number;
  streakBonusAwarded?: number;
}

/**
 * Complete a trip, compute the final bill and driver wallet split, and generate an invoice.
 */
export async function completeTripAndSettle(
  input: FinalBillingInput
): Promise<BillingCalculationResult> {
  const companyInfo = await getCompanyBillingInfo();

  return withTransaction(async (client: PoolClient) => {
    // 1. Fetch booking with row lock
    const bookingRes = await client.query(
      `SELECT b.*, d.wallet_balance AS driver_wallet, d.full_name AS driver_name,
              d.security_reserve_balance, d.total_trips_completed, d.streak_qualifying_trips, d.onboarding_status, d.rating AS driver_rating,
              c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.gstin AS customer_gstin
       FROM crm_bookings b
       JOIN crm_drivers d ON d.id = b.assigned_driver_id
       JOIN crm_customers c ON c.id = b.customer_id
       WHERE b.id = $1
       FOR UPDATE`,
      [input.bookingId]
    );

    if (bookingRes.rows.length === 0) {
      throw new Error(`Booking #${input.bookingId} not found or driver not assigned.`);
    }

    const b = bookingRes.rows[0];
    if (b.booking_status === 'COMPLETED_SETTLED') {
      throw new Error(`Booking #${input.bookingId} is already completed and settled.`);
    }
    const baseFare = Number(b.customer_total_fare);
    const advancePaid = Number(b.advance_paid || 0);
    const bookedShare = Number(b.commission_amount || 0);
    const tollParking = Number(input.tollParking || 0);
    const cashCollected = Number(input.cashCollectedByDriver || 0);

    // Extra km / hours calculations if applicable
    let extraKmCharges = 0;
    if (input.closingKm && b.opening_km) {
      const actualKm = input.closingKm - b.opening_km;
      const billedKm = Number(b.distance_km || 0);
      if (actualKm > billedKm) {
        extraKmCharges = (actualKm - billedKm) * 14.0;
      }
    }

    const extraHourCharges = (input.extraHours || 0) * 150.0;
    const totalCustomerPayable = baseFare + extraKmCharges + extraHourCharges + tollParking;

    // Ride GST is BiharCabs' liability (Sec 9(5)), borne by the driver. The share fixed at booking covers the
    // quoted fare; the GST included in any extra km/hour charges is added to it here.
    const splitRules = await getSplitRules();
    const commission = round2(bookedShare + gstIncluded(extraKmCharges + extraHourCharges, splitRules.ride_fare_gst_pct));
    const balanceCustomerDue = Math.max(0, totalCustomerPayable - advancePaid - cashCollected);

    const revPolicy = await getRevenueProtectionPolicy();
    const currentReserve = Number(b.security_reserve_balance || 0);
    const targetReserve = Number(revPolicy.target_security_reserve || 500);
    const driverGrossEarnings = parseFloat((totalCustomerPayable - commission).toFixed(2));
    const baseNetSettlement = parseFloat((driverGrossEarnings - cashCollected).toFixed(2));

    // Rolling Reserve Float: Incrementally deduct up to ₹100 per trip towards ₹500 float
    // ONLY deducted when BiharCabs holds positive payout funds from customer advance (baseNetSettlement > 0)
    let reserveDeduction = 0;
    if (currentReserve < targetReserve && baseNetSettlement > 0) {
      const deficit = targetReserve - currentReserve;
      reserveDeduction = Math.min(Number(revPolicy.reserve_deduction_per_trip || 100), deficit, baseNetSettlement);
    }
    const newReserveBalance = parseFloat((currentReserve + reserveDeduction).toFixed(2));

    // Every trip counts toward the driver's tier.
    const newTrips = Number(b.total_trips_completed || 0) + 1;

    // Ride streak bonus: only trips with a fare of at least streak_min_fare count, on their own counter,
    // so small trips cannot be booked just to farm it. Without a valid minimum no bonus is paid.
    const minFare = revPolicy.streak_min_fare;
    if (minFare === null) console.error('[Billing] streak_min_fare is not set; no streak bonus is paid.');
    const qualifies = minFare !== null && baseFare >= minFare;
    const newQualifyingTrips = Number(b.streak_qualifying_trips || 0) + (qualifies ? 1 : 0);
    let streakBonus = 0;
    if (qualifies && revPolicy.streak_bonus_target_trips > 0 && newQualifyingTrips % revPolicy.streak_bonus_target_trips === 0) {
      streakBonus = Number(revPolicy.streak_bonus_amount);
    }

    // BiharCabs Bidirectional Commission Formula with Reserve & Streak Bonus:
    const driverNetSettlement = parseFloat(
      (baseNetSettlement - reserveDeduction + streakBonus).toFixed(2)
    );

    let settlementType: 'PAYABLE_TO_DRIVER' | 'RECEIVABLE_FROM_DRIVER' | 'SETTLED_EXACT' = 'SETTLED_EXACT';
    if (driverNetSettlement > 0) {
      settlementType = 'PAYABLE_TO_DRIVER';
    } else if (driverNetSettlement < 0) {
      settlementType = 'RECEIVABLE_FROM_DRIVER';
    }

    // Update Driver's Wallet Balance
    const currentWallet = Number(b.driver_wallet);
    const newDriverWalletBalance = parseFloat((currentWallet + driverNetSettlement).toFixed(2));

    // Lift a dues restriction once the driver is back within their tier credit limit: the same rule that
    // restricted them (and that dues payments use).
    let newStatus = b.onboarding_status || 'APPROVED_ACTIVE';
    const creditLimit = creditLimitFor({ rating: b.driver_rating, total_trips_completed: newTrips }, revPolicy);
    if (
      (newStatus === 'RESTRICTED_DIGITAL_ONLY' || newStatus === 'SUSPENDED_UNPAID_DUES') &&
      newDriverWalletBalance >= -creditLimit
    ) {
      newStatus = 'APPROVED_ACTIVE';
    }

    await client.query(
      `UPDATE crm_drivers
       SET wallet_balance = $1,
           security_reserve_balance = $2,
           is_available = true,
           onboarding_status = $3,
           total_trips_completed = $4,
           streak_qualifying_trips = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [newDriverWalletBalance, newReserveBalance, newStatus, newTrips, b.assigned_driver_id, newQualifyingTrips]
    );

    // Update Booking Status
    await client.query(
      `UPDATE crm_bookings
       SET booking_status = 'COMPLETED_SETTLED',
           payment_status = $1,
           cash_collected_by_driver = $2,
           closing_km = $3,
           toll_parking_charges = $4,
           extra_km_charges = $5,
           extra_hour_charges = $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7`,
      [
        balanceCustomerDue === 0 ? 'PAID_IN_FULL' : 'PARTIALLY_PAID',
        cashCollected,
        input.closingKm || null,
        tollParking,
        extraKmCharges,
        extraHourCharges,
        input.bookingId,
      ]
    );

    // Record Ledger Entries
    // 1. Cash collected by driver (if > 0)
    if (cashCollected > 0) {
      await client.query(
        `INSERT INTO crm_payments_ledger 
         (booking_id, driver_id, customer_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
         VALUES ($1, $2, $3, 'CUSTOMER_SETTLEMENT', 'CREDIT', 'CASH', $4, $5, 'Cash collected by driver at drop-off')`,
        [input.bookingId, b.assigned_driver_id, b.customer_id, cashCollected, `CASH-${b.booking_code}`]
      );
    }

    // 2. Commission Settlement entry in driver ledger
    await client.query(
      `INSERT INTO crm_payments_ledger 
       (booking_id, driver_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
       VALUES ($1, $2, $3, $4, 'WALLET', $5, $6, $7)`,
      [
        input.bookingId,
        b.assigned_driver_id,
        settlementType === 'RECEIVABLE_FROM_DRIVER' ? 'DRIVER_COMMISSION_DEDUCTION' : 'DRIVER_PAYOUT',
        settlementType === 'RECEIVABLE_FROM_DRIVER' ? 'DEBIT' : 'CREDIT',
        Math.abs(driverNetSettlement),
        `SETTLE-${b.booking_code}`,
        `Trip settlement: Gross Earnings ₹${driverGrossEarnings}, Commission ₹${commission}, Cash Collected ₹${cashCollected}`
      ]
    );

    // 3. Rolling Security Reserve deposit ledger entry
    if (reserveDeduction > 0) {
      await client.query(
        `INSERT INTO crm_payments_ledger 
         (booking_id, driver_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
         VALUES ($1, $2, 'SECURITY_RESERVE_DEPOSIT', 'DEBIT', 'WALLET', $3, $4, 'Incremental rolling security reserve deposit')`,
        [input.bookingId, b.assigned_driver_id, reserveDeduction, `RES-${b.booking_code}`]
      );
    }

    // 4. Streak milestone bonus ledger entry
    if (streakBonus > 0) {
      await client.query(
        `INSERT INTO crm_payments_ledger 
         (booking_id, driver_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
         VALUES ($1, $2, 'INCENTIVE_STREAK_BONUS', 'CREDIT', 'WALLET', $3, $4, 'Ride streak milestone bonus offset')`,
        [input.bookingId, b.assigned_driver_id, streakBonus, `STRK-${b.booking_code}`]
      );
    }

    // 5. Generate Tax Invoice: the next number in the consecutive ride series (TI). A booking that already
    // has an invoice keeps its number, so a number is never replaced or skipped.
    const existingInvoice = (await client.query(`SELECT invoice_number FROM crm_invoices WHERE booking_id = $1 FOR UPDATE`, [input.bookingId])).rows[0];
    const invoiceNumber: string = existingInvoice?.invoice_number ?? (await nextDocumentNumber(client, 'TI'));
    const lineItems = [
      { description: `Cab Fare (${b.origin_city} to ${b.destination_city || 'Local'})`, amount: baseFare },
    ];
    if (extraKmCharges > 0) lineItems.push({ description: 'Extra Kilometer Charges', amount: extraKmCharges });
    if (extraHourCharges > 0) lineItems.push({ description: 'Extra Hours Charges', amount: extraHourCharges });
    if (tollParking > 0) lineItems.push({ description: 'Toll & Parking (Actuals)', amount: tollParking });

    // BiharCabs' sole customer invoice: line amounts include GST; GST on the ride (fare + extras) is shown
    // separately. Tolls/parking are passed through at actuals without GST.
    const invoiceTax = gstIncluded(totalCustomerPayable - tollParking, splitRules.ride_fare_gst_pct);
    // Place of supply and CGST/SGST or IGST (Rule 46; Section 12(9) IGST Act). When it cannot be known
    // (unlisted pickup city, malformed customer GSTIN, BiharCabs' state not configured), the trip is still
    // settled and the invoice numbered; the invoice waits for staff to choose the state.
    const tax = await documentTaxSplit(b.customer_gstin, b.origin_city, invoiceTax);
    await client.query(
      `INSERT INTO crm_invoices
       (invoice_number, booking_id, line_items, subtotal, tax_amount, total_amount, created_at,
        supplier_state_code, place_of_supply_code, place_of_supply_basis, cgst_amount, sgst_amount, igst_amount)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (booking_id) DO UPDATE
       SET invoice_number = EXCLUDED.invoice_number,
           line_items = EXCLUDED.line_items,
           subtotal = EXCLUDED.subtotal,
           tax_amount = EXCLUDED.tax_amount,
           total_amount = EXCLUDED.total_amount,
           supplier_state_code = EXCLUDED.supplier_state_code,
           place_of_supply_code = EXCLUDED.place_of_supply_code,
           place_of_supply_basis = EXCLUDED.place_of_supply_basis,
           cgst_amount = EXCLUDED.cgst_amount,
           sgst_amount = EXCLUDED.sgst_amount,
           igst_amount = EXCLUDED.igst_amount,
           updated_at = CURRENT_TIMESTAMP`,
      // subtotal = taxable value of the ride (excludes tolls), so subtotal + tax + tolls = total.
      [invoiceNumber, input.bookingId, JSON.stringify(lineItems), round2(totalCustomerPayable - tollParking - invoiceTax), invoiceTax, totalCustomerPayable,
        ...taxColumns(tax)]
    );

    return {
      bookingId: input.bookingId,
      bookingCode: b.booking_code,
      baseFare,
      extraKmCharges,
      extraHourCharges,
      tollParking,
      totalCustomerPayable,
      advancePaid,
      balanceCustomerDue,
      cashCollectedByDriver: cashCollected,
      companyCommission: commission,
      driverGrossEarnings,
      driverNetSettlement,
      settlementType,
      newDriverWalletBalance,
      invoiceNumber,
      securityReserveDeducted: reserveDeduction,
      newSecurityReserveBalance: newReserveBalance,
      streakBonusAwarded: streakBonus,
    };
  });
}

/**
 * Award an incentive / promotion bonus to a driver.
 * Automatically routes the bonus to clear any negative platform balance first.
 */
export async function awardDriverIncentive(
  driverId: number,
  bonusAmount: number,
  reason: string
): Promise<{ success: boolean; newWalletBalance: number; debtCleared: number }> {
  return withTransaction(async (client: PoolClient) => {
    const dRes = await client.query(
      `SELECT wallet_balance, onboarding_status, rating, total_trips_completed FROM crm_drivers WHERE id = $1 FOR UPDATE`,
      [driverId]
    );

    if (dRes.rows.length === 0) {
      throw new Error(`Driver #${driverId} not found.`);
    }

    const currentWallet = Number(dRes.rows[0].wallet_balance);
    const newWalletBalance = parseFloat((currentWallet + bonusAmount).toFixed(2));
    const debtCleared = currentWallet < 0 ? Math.min(Math.abs(currentWallet), bonusAmount) : 0;

    let newStatus = dRes.rows[0].onboarding_status;
    if (
      (newStatus === 'RESTRICTED_DIGITAL_ONLY' || newStatus === 'SUSPENDED_UNPAID_DUES') &&
      newWalletBalance >= -creditLimitFor(dRes.rows[0], await getRevenueProtectionPolicy())
    ) {
      newStatus = 'APPROVED_ACTIVE';
    }

    await client.query(
      `UPDATE crm_drivers
       SET wallet_balance = $1, onboarding_status = $2::varchar,
           is_available = CASE WHEN $2::varchar <> $4::varchar THEN true ELSE is_available END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [newWalletBalance, newStatus, driverId, dRes.rows[0].onboarding_status]
    );

    await client.query(
      `INSERT INTO crm_payments_ledger
       (driver_id, transaction_type, direction, payment_channel, amount, reference_id, notes)
       VALUES ($1, 'INCENTIVE_BONUS', 'CREDIT', 'WALLET', $2, $3, $4)`,
      [driverId, bonusAmount, `INC-${Date.now()}`, `${reason} (Debt cleared: ₹${debtCleared.toFixed(2)})`]
    );

    return {
      success: true,
      newWalletBalance,
      debtCleared,
    };
  });
}

