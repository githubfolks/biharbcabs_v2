# Driver Plans: Prepaid Commission Balance by Ride Type

**Status:** rules agreed, not built. Prices and the CA questions in section 9 are still open.
**Depends on:** PR #6 (Razorpay Payment Links, webhook, admin roles).

## 1. Why

On a cash ride the driver collects the whole fare, and BiharCabs' share (commission + GST + tech fee) becomes a debt the driver may never pay. Fares range from ₹100 to ₹10,000, so one large ride can create a large debt. Today the system allows debt up to a credit limit, then restricts the driver ([04_billing_commission_and_settlement.mmd](diagrams/04_billing_commission_and_settlement.mmd)).

With a plan, the driver **pays first**:
- BiharCabs' share of each ride is deducted from a prepaid balance, so there is nothing to chase.
- The plan type decides which rides the driver gets.

## 2. Agreed rules

| Rule | Decision |
|---|---|
| Plan types | Three: **Local**, **Outstation**, **Premium** (high fare, with dispatch priority) |
| What a plan is | A prepaid balance. The price paid, GST included, becomes the balance |
| Commission | BiharCabs' share of each ride is deducted from the balance |
| Where the share comes from | **Advance first.** If the customer paid an advance, BiharCabs takes its share from it and owes the driver the rest. The balance pays only the part the advance doesn't cover (all of it on full-cash rides) |
| Ride eligibility | A ride is offered only if the driver's free balance covers **this ride's** uncovered share, so the balance never goes negative |
| End of plan | A plan ends when its balance reaches ₹0. **No time limit** |
| Unpaid dues | Must be cleared before buying a plan |
| Suspension | The plan is paused: no rides while suspended. With no time limit, no balance is lost |
| Refunds | None. Plans are non-refundable |
| Price | GST included |
| GST | **Confirmed by the CA:** 18% GST and a tax invoice **at purchase** (closed-loop service advance). The **balance is the price before GST** (₹1,180 paid = ₹1,000 balance + ₹180 GST). Each ride deducts commission + tech fee **before GST** (already paid at purchase) **plus the ride's 5% fare GST**, which BiharCabs owes under Sec 9(5) and the driver bears. The plan must never become a general-purpose wallet (that would bring RBI prepaid-instrument rules) |
| Minimum plan price | The balance (price before GST) must cover the largest pre-GST share any ride the plan allows can need (share at the plan's fare limit). The admin screen refuses a lower price |
| Upgrade | Allowed. The remaining balance carries over to the new plan |
| Top-up | Allowed: buying the same plan again adds to the balance |
| Downgrade | Allowed. The remaining balance carries over, as on upgrade |
| Low-balance alert | Sent when the free balance can no longer cover the plan's largest possible ride share (the share at its fare limit). No separate amount to configure |
| Switching on plan-only rides | A setting, off at launch. The super admin turns it on once enough drivers hold plans |
| Drivers without a plan, or whose plan reached ₹0 | Commission model with a credit limit (today's rules), and **only commission-type rides**: not plan-only rides |
| Full-cash outstation rides | **Plan-only**: offered only to drivers with an active plan covering them |

## 3. Plan definitions (configuration, not code)

Each plan is a row in `crm_subscription_plans`, editable by the super admin. The values below are **proposals to confirm** (section 9).

| Plan | Trip types | Fare limit per ride | Dispatch priority | Price (GST incl.) |
|---|---|---|---|---|
| Local | local, airport | up to ₹ *(to set)* | normal | ₹ *(to set)* |
| Outstation | oneway, roundtrip, local, airport | up to ₹ *(to set)* | normal | ₹ *(to set)* |
| Premium | all rides | up to ₹ *(to set: needed for the minimum price rule)* | offered first | ₹ *(to set)* |

The minimum price is computed from the plan's fare limit at today's commission settings. For example, a ₹10,000 limit means a pre-GST share of ₹310 (3% commission + ₹10 tech fee). The balance must be at least ₹310, so the price must be at least ₹365.80 with 18% GST. If commission settings change later, plans priced below the new minimum are flagged for the super admin.

What BiharCabs takes per ride, at today's settings (3% commission + 18% GST + ₹10 tech fee), shows how far a balance goes:

| Fare | BiharCabs' share | Advance held (10%, min ₹200) | Taken from the plan balance |
|---|---|---|---|
| ₹500 | ₹27.70 | ₹200 if paid online, else 0 | ₹0 if advance paid, else ₹27.70 |
| ₹2,500 | ₹98.50 | ₹250 / 0 | ₹0 / ₹98.50 |
| ₹10,000 | ₹364 | ₹1,000 / 0 | ₹0 / ₹364 |

On rides where the advance is paid online, BiharCabs already holds more than its share, so **the plan balance mostly pays for full-cash rides**.

## 4. How the money moves on one ride

```
share        = booking.commission_amount         (commission + GST + tech fee, fixed at booking)
held         = booking.advance_paid              (confirmed by Razorpay, or 0)
from_advance = min(share, held)                  (GST invoiced per ride on this part, as today)
uncovered    = share - from_advance
from_plan    = uncovered converted to pre-GST    (GST on it was paid at plan purchase; reserved at
                                                  acceptance, taken at completion)
owed_driver  = held - from_advance               (credited to the driver's wallet, paid out by finance)
```

On a full-cash ride, `from_plan` = commission + tech fee. Where the advance covers only part of the share, the uncovered part is converted to its pre-GST amount. **The exact split (which part of the tech fee carries GST, and how a partly covered share is invoiced) needs the CA's confirmation before build.**

- **At acceptance:** reserve `from_plan` on the driver's plan. Free balance = balance − reservations. This stops two accepted rides from spending the same money.
- **At completion:** turn the reservation into a deduction and write a ledger entry. If the balance is now ₹0, the plan ends (`EXHAUSTED`) and the driver gets a WhatsApp "buy a new plan" link.
- **If the ride is cancelled or reassigned:** release the reservation.
- **The billing model is fixed when the ride is accepted:** the booking records "plan" or "commission" and the plan id. A change afterwards doesn't affect that ride.

## 5. Driver journey (WhatsApp)

1. The driver sends **PLANS** and sees the three plans with prices and what each covers.
2. If they have unpaid dues, the bot shows the amount and a pay link; a plan can't be bought until dues are cleared.
3. They pick a plan and get a Razorpay Payment Link. This reuses PR #6: `crm_payment_links` gets a `purpose` column (advance or plan), and the same webhook confirms it.
4. Once the webhook confirms payment, the plan is `ACTIVE` with balance = price, and the driver gets a confirmation and a GST invoice.
5. After each ride, the trip summary shows the amount deducted and the balance left. A low-balance warning is sent below a set amount (setting).
6. At ₹0, the plan ends and the driver gets a buy-again message.

## 6. Dispatch

For each ride, a plan driver is eligible when all of these hold:
- the plan is `ACTIVE` (not paused or exhausted);
- the plan covers the ride's trip type and fare;
- free balance ≥ the ride's `from_plan` amount (advance-paid rides usually need ₹0).

Each ride is one of two kinds:
- **Plan-only:** full-cash outstation rides (`payment_mode = FULL_CASH` and trip type oneway or roundtrip). Only drivers with an active plan covering the ride are offered it.
- **Open:** every other ride. It goes to plan drivers whose plan covers it, and to commission drivers within their credit limit (today's rules).

Premium plan drivers are offered rides first. A driver whose plan reaches ₹0 becomes a commission driver: open rides only, within their credit limit. These checks read live data; they don't depend on a scheduled job having run.

Suspension sets the plan to `PAUSED`, and re-activation sets it back to `ACTIVE`. The hooks are the existing places drivers are suspended: expired documents, ratings, dues.

## 7. Data model (sketch)

- `crm_subscription_plans`:
  - code, name, price (GST incl.), trip types allowed, maximum fare (nullable), priority rank;
  - minimum balance for a low-balance alert;
  - active flag, created and updated times.
- `crm_driver_plans`:
  - driver, plan, and a copy of the plan's terms at purchase;
  - status (`PENDING_PAYMENT`, `ACTIVE`, `PAUSED`, `EXHAUSTED`);
  - amount paid, balance, reserved amount;
  - payment link, activated and exhausted times.
  - **At most one non-exhausted plan per driver.**
    - A top-up adds to that plan's balance.
    - An upgrade or downgrade closes it and opens the new plan with the balance carried over.
    - Open reservations move with the balance.
- `crm_driver_plan_movements`: append-only (`PURCHASE`, `TOPUP`, `CARRY_OVER_OUT`, `CARRY_OVER_IN`, `RESERVE`, `RELEASE`, `DEDUCT`), with booking, amount and balance after. Every change is auditable, and the balance can be rebuilt from it. A purchase records price paid, taxable value and GST.
- `crm_bookings`: new fields `billing_model` (`PLAN` or `COMMISSION`), `driver_plan_id`, `plan_amount_reserved`.
- `crm_payment_links`: new field `purpose`, and a nullable `driver_plan_id`.

Every balance change runs in one transaction with a row lock on the plan, as settlement already does for wallets.

## 8. Prerequisites and phases

| Phase | Scope |
|---|---|
| **0. Prerequisite** | **Record driver payouts.** Today the wallet is credited when BiharCabs owes a driver money, but nothing records the actual payment (amount, UPI reference, who paid). "Advance first" creates such payouts on advance-paid rides. **Combine the two commission settings:** the settings page edits `commission_model` (12%), but bookings use `revenue_protection_policy.platform_commission_pct` (3%) |
| **1. MVP** | Plans table and admin screen; WhatsApp PLANS purchase; webhook activation; reserve, deduct and release; dispatch eligibility and Premium priority; pause on suspension; trip summary with balance; low-balance and exhausted messages; finance view of plan sales and deductions |
| **2.** | Upgrades and top-ups (if agreed); plan revenue per driver against the commission model; GST invoice automation for plan purchases |

## 9. Open questions

Decided:
- Balance carries over on upgrade. Top-up and downgrade are allowed.
- Commission fallback (open rides only) when a plan ends.
- Full-cash outstation rides are plan-only.
- GST is counted once, at purchase.
- The minimum price covers the largest share.
- Outstation includes local rides; Premium covers all rides.

- Downgrade carries the balance over.
- The low-balance alert is based on the plan's largest share.
- Plan-only rides are switched on by a setting.

Still open:

1. **Prices and fare limits** for Local, Outstation and Premium. Premium needs a fare limit for the minimum-price rule.
2. **For the CA:**
   - confirm GST at purchase on a prepaid, non-refundable balance;
   - which part of the ₹10 tech fee carries GST;
   - how a ride whose share is partly covered by the advance is invoiced;
   - how to account for an unused balance, including consumer-law exposure.

## 10. Risks

- **Adoption.** Drivers have to pay upfront. A low entry price for Local, and advance-paid rides costing them almost nothing from the balance, make this easier.
- **Payout workload** grows with "advance first", which is why payout recording comes first.
- **Rules must stay in one place.** Eligibility and deduction belong in the backend (dispatch engine and billing) and nowhere else.
