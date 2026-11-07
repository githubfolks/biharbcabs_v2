import { query, withTransaction } from './db';
import { getCompanyBillingInfo, getRevenueProtectionPolicy } from './settings';
import { PoolClient } from 'pg';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

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
              d.security_reserve_balance, d.total_trips_completed, d.onboarding_status,
              c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
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
    const baseFare = Number(b.customer_total_fare);
    const advancePaid = Number(b.advance_paid || 0);
    const commission = Number(b.commission_amount || 0);
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

    // Ride Streak Milestone Bonus (e.g. every 5th trip awards ₹150)
    const currentTrips = Number(b.total_trips_completed || 0);
    const newTrips = currentTrips + 1;
    let streakBonus = 0;
    if (revPolicy.streak_bonus_target_trips > 0 && newTrips % revPolicy.streak_bonus_target_trips === 0) {
      streakBonus = Number(revPolicy.streak_bonus_amount || 150);
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

    // Auto-restore driver status if debt was successfully absorbed by this trip
    let newStatus = b.onboarding_status || 'APPROVED_ACTIVE';
    if (
      (newStatus === 'RESTRICTED_DIGITAL_ONLY' || newStatus === 'SUSPENDED_UNPAID_DUES') &&
      newDriverWalletBalance >= -300
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
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [newDriverWalletBalance, newReserveBalance, newStatus, newTrips, b.assigned_driver_id]
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

    // 5. Generate Tax Invoice
    const invoiceNumber = `INV-${b.booking_code}-${Date.now().toString().slice(-4)}`;
    const lineItems = [
      { description: `Cab Fare (${b.origin_city} to ${b.destination_city || 'Local'})`, amount: baseFare },
    ];
    if (extraKmCharges > 0) lineItems.push({ description: 'Extra Kilometer Charges', amount: extraKmCharges });
    if (extraHourCharges > 0) lineItems.push({ description: 'Extra Hours Charges', amount: extraHourCharges });
    if (tollParking > 0) lineItems.push({ description: 'Toll & Parking (Actuals)', amount: tollParking });

    await client.query(
      `INSERT INTO crm_invoices
       (invoice_number, booking_id, line_items, subtotal, tax_amount, total_amount, created_at)
       VALUES ($1, $2, $3, $4, 0.00, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (booking_id) DO UPDATE
       SET invoice_number = EXCLUDED.invoice_number,
           line_items = EXCLUDED.line_items,
           subtotal = EXCLUDED.subtotal,
           total_amount = EXCLUDED.total_amount,
           updated_at = CURRENT_TIMESTAMP`,
      [invoiceNumber, input.bookingId, JSON.stringify(lineItems), totalCustomerPayable]
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
 * Generate a PDF invoice file using PDFKit.
 */
export async function generateInvoicePdf(
  invoiceNumber: string,
  outDir = '/tmp'
): Promise<string> {
  const company = await getCompanyBillingInfo();

  const invoiceRes = await query(
    `SELECT i.*, b.booking_code, b.origin_city, b.destination_city, b.pickup_date, b.trip_type,
            c.full_name AS customer_name, c.phone AS customer_phone, c.gstin AS customer_gstin
     FROM crm_invoices i
     JOIN crm_bookings b ON b.id = i.booking_id
     JOIN crm_customers c ON c.id = b.customer_id
     WHERE i.invoice_number = $1`,
    [invoiceNumber]
  );

  if (invoiceRes.rows.length === 0) {
    throw new Error(`Invoice ${invoiceNumber} not found.`);
  }

  const inv = invoiceRes.rows[0];
  const pdfPath = path.join(outDir, `${invoiceNumber}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(pdfPath);

    doc.pipe(stream);

    // Header
    doc.fillColor('#ea580c').fontSize(22).font('Helvetica-Bold').text(company.trade_name || 'BiharCabs.com');
    doc.fillColor('#333333').fontSize(9).font('Helvetica').text(company.legal_name || 'Bihar Cabs');
    doc.text(company.address || 'Patna, Bihar, India');
    doc.text(`Phone: ${company.phone} | Email: ${company.email}`);
    if (company.gstin) doc.text(`GSTIN: ${company.gstin}`);

    doc.moveDown(1);
    doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(40, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(1);

    // Invoice Meta & Customer Details
    const metaY = doc.y;
    doc.font('Helvetica-Bold').fontSize(12).text(`TAX INVOICE: ${inv.invoice_number}`);
    doc.font('Helvetica').fontSize(9).text(`Booking Code: #${inv.booking_code}`);
    doc.text(`Date: ${new Date(inv.created_at).toLocaleDateString('en-IN')}`);
    doc.text(`Trip: ${inv.origin_city} → ${inv.destination_city || 'Local'} (${inv.trip_type})`);

    doc.font('Helvetica-Bold').fontSize(10).text('Billed To:', 320, metaY);
    doc.font('Helvetica').fontSize(9).text(inv.customer_name || 'Valued Customer', 320);
    doc.text(`Phone: ${inv.customer_phone}`, 320);
    if (inv.customer_gstin) doc.text(`GSTIN: ${inv.customer_gstin}`, 320);

    doc.moveDown(2);

    // Line items table
    const tableTop = doc.y + 15;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Description', 40, tableTop);
    doc.text('Amount (₹)', 480, tableTop, { align: 'right' });
    doc.strokeColor('#cccccc').lineWidth(0.5).moveTo(40, tableTop + 14).lineTo(550, tableTop + 14).stroke();

    let itemY = tableTop + 22;
    const items = inv.line_items || [];
    doc.font('Helvetica').fontSize(9);

    for (const item of items) {
      doc.text(item.description, 40, itemY);
      doc.text(`₹${Number(item.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 480, itemY, { align: 'right' });
      itemY += 20;
    }

    doc.strokeColor('#cccccc').lineWidth(0.5).moveTo(40, itemY).lineTo(550, itemY).stroke();
    itemY += 10;

    // Totals
    doc.font('Helvetica-Bold').fontSize(11);
    doc.text('Total Amount:', 350, itemY);
    doc.text(`₹${Number(inv.total_amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, 480, itemY, { align: 'right' });

    // Footer
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666666')
      .text('Thank you for choosing BiharCabs! For round-the-clock booking assistance, WhatsApp +91 7070992170.', 40, 750, { align: 'center' });

    doc.end();

    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', (err) => reject(err));
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
      `SELECT wallet_balance, onboarding_status FROM crm_drivers WHERE id = $1 FOR UPDATE`,
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
      newWalletBalance >= -300
    ) {
      newStatus = 'APPROVED_ACTIVE';
    }

    await client.query(
      `UPDATE crm_drivers
       SET wallet_balance = $1, onboarding_status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [newWalletBalance, newStatus, driverId]
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

