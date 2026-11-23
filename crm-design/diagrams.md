# BiharCabs CRM: Flow Diagrams

These diagrams show what the code does as of `main` @ 5e692db (2026-11-20), not the intended design. Each section names the source files it was drawn from. Figures in brackets (e.g. **[3%]**) are the current values in `crm_settings`; they are configurable, not fixed.

1. [Business flow](#1-business-flow)
2. [Business rules](#2-business-rules)
3. [Tax calculations](#3-tax-calculations)
4. [WhatsApp + CRM: end-to-end ride cycle](#4-whatsapp--crm-end-to-end-ride-cycle)

---

## 1. Business flow

How a ride moves from enquiry to money and tax documents. Sources: `whatsapp-bot.ts`, `advance-payments.ts`, `dispatch-engine.ts`, `billing.ts`, `gst-delivery.ts`.

```mermaid
flowchart TD
    subgraph Acquire["1 · Acquire"]
        WEB["Website<br/>(WordPress)"] -->|pre-filled WhatsApp| BOT
        CUST["Customer on<br/>WhatsApp"] --> BOT["WhatsApp bot"]
        STAFF["Staff on<br/>CRM dashboard"] --> PRICE
        BOT --> PRICE["Price from<br/>WordPress rate card"]
    end

    subgraph Book["2 · Book"]
        PRICE --> SPLIT["Fare split<br/>(BiharCabs share vs driver)"]
        SPLIT --> ADV{"Advance<br/>required?"}
        ADV -->|yes| RZP["Razorpay<br/>payment link"]
        ADV -->|no: customer chooses| CHOICE{"Online advance<br/>or full cash?"}
        CHOICE -->|online| RZP
        CHOICE -->|cash| DISP
        RZP -->|signed webhook:<br/>paid| RV["Receipt voucher RV<br/>(18% GST)"]
        RV --> DISP
    end

    subgraph Fulfil["3 · Fulfil"]
        DISP["Broadcast to<br/>eligible drivers"] --> ACC["Driver accepts"]
        ACC --> OTP["Customer gets<br/>trip OTP"]
        OTP --> START["Driver enters OTP<br/>trip starts"]
        START --> DONE["Driver taps<br/>Complete Trip"]
    end

    subgraph Settle["4 · Settle and comply"]
        DONE --> WALLET["Driver wallet<br/>settled"]
        DONE --> TI["Tax invoice TI<br/>(5% GST)"]
        TI --> WADOC["PDF sent on<br/>WhatsApp"]
        WALLET --> OWED{"Wallet"}
        OWED -->|positive| PAYOUT["Finance records<br/>payout to driver"]
        OWED -->|negative| DUES["Driver pays dues<br/>(Razorpay or finance)"]
        DONE --> RATE["Customer<br/>rates driver"]
    end
```

**Who earns what:** the customer pays the fare to BiharCabs (advance) and the driver (cash). BiharCabs keeps its share, and the driver keeps the rest. See [section 3](#3-tax-calculations).

---

## 2. Business rules

### 2a. Booking lifecycle

Every `booking_status` and what moves a booking between them. Sources: `whatsapp-bot.ts`, `advance-payments.ts`, `dispatch-engine.ts`, `trip-otp.ts`, `billing.ts`, `cancellations.ts`, `advance-rules.ts`.

```mermaid
stateDiagram-v2
    direction TB
    [*] --> AWAITING_ADVANCE: online advance
    [*] --> AWAITING_DRIVER: full cash, broadcast now

    AWAITING_ADVANCE --> CONFIRMED_AWAITING_DRIVER: Razorpay paid webhook
    AWAITING_ADVANCE --> ADVANCE_LINK_FAILED: link creation failed
    AWAITING_ADVANCE --> ADVANCE_EXPIRED: link expired
    ADVANCE_LINK_FAILED --> CONFIRMED_AWAITING_DRIVER: finance waives
    ADVANCE_EXPIRED --> CONFIRMED_AWAITING_DRIVER: finance waives
    AWAITING_ADVANCE --> CONFIRMED_AWAITING_DRIVER: finance waives

    CONFIRMED_AWAITING_DRIVER --> AWAITING_DRIVER: broadcast
    AWAITING_DRIVER --> ESCALATED_NO_DRIVER: SLA deadline passed
    ESCALATED_NO_DRIVER --> AWAITING_DRIVER: re-broadcast

    AWAITING_DRIVER --> DRIVER_ASSIGNED: driver accepts
    ESCALATED_NO_DRIVER --> DRIVER_ASSIGNED: staff force-assign
    CONFIRMED_AWAITING_DRIVER --> DRIVER_ASSIGNED: staff force-assign

    DRIVER_ASSIGNED --> TRIP_IN_PROGRESS: correct trip OTP
    TRIP_IN_PROGRESS --> COMPLETED_SETTLED: Complete Trip
    COMPLETED_SETTLED --> [*]

    note right of DRIVER_ASSIGNED
        Staff can reassign here (new trip OTP).
        Any status before TRIP_IN_PROGRESS
        can go to CANCELLED.
        A started trip cannot be cancelled.
    end note
```

`CANCELLED` is left off the chart to keep it readable. It can be reached from `AWAITING_ADVANCE`, `ADVANCE_LINK_FAILED`, `ADVANCE_EXPIRED`, `CONFIRMED_AWAITING_DRIVER`, `AWAITING_DRIVER`, `ESCALATED_NO_DRIVER` and `DRIVER_ASSIGNED`.

### 2b. Is the advance required? How much?

Source: `isAdvanceRequired` in `advance-payments.ts`, `splitFare` in `fare-split.ts`.

```mermaid
flowchart TD
    A["Booking priced"] --> B{"Trip type in<br/>required_trip_types?<br/>[oneway, roundtrip]"}
    B -->|yes| REQ["Advance REQUIRED<br/>online only"]
    B -->|no| C{"Fare ≥ required_above_fare?<br/>[₹3,000]"}
    C -->|yes| REQ
    C -->|no| OPT["Customer chooses:<br/>online advance or full cash"]
    REQ --> AMT["Advance = min(fare, max(min_advance, fare × advance %))<br/>[min ₹200, 10%]"]
    OPT -->|online| AMT
    OPT -->|cash| CASH["Advance ₹0<br/>broadcast at once"]
    AMT --> LINK["Razorpay link<br/>[30-minute window]"]
```

The server decides: a ride that needs the advance can't be switched to cash, whatever the client sends. `advance_paid` holds only money confirmed by a signed Razorpay webhook.

### 2c. Which drivers can get a ride?

The same rules apply at broadcast, at acceptance (re-checked with the driver's row locked) and at staff force-assign. Source: `eligibilityRows` in `dispatch-engine.ts`.

```mermaid
flowchart TD
    D["Driver"] --> S{"Status APPROVED_ACTIVE?<br/>or RESTRICTED_DIGITAL_ONLY<br/>on a fully prepaid ride"}
    S -->|no| X["Not eligible"]
    S -->|yes| AV{"Marked available?"}
    AV -->|no| X
    AV -->|yes| R{"Rating ≥<br/>min_dispatch_rating?"}
    R -->|no| X
    R -->|yes| L{"Licence valid?"}
    L -->|no| X
    L -->|yes| V{"Verified cab of this type,<br/>insurance + fitness + permit valid?"}
    V -->|no| X
    V -->|yes| G{"No other held ride with pickup<br/>&lt; driver_ride_gap_hours apart?<br/>[4 h]"}
    G -->|no| X
    G -->|yes| C{"Credit check:<br/>wallet + open rides' shortfall + this ride's shortfall<br/>within tier limit?<br/>(fully prepaid rides exempt)"}
    C -->|no| X
    C -->|yes| OK["Eligible:<br/>one offer per driver"]
```

### 2d. Driver credit, restriction and incentives

Sources: `driver-dues.ts`, `billing.ts`, `settings` → `revenue_protection_policy`.

```mermaid
flowchart TD
    subgraph Tier["Credit limit by tier"]
        T1["Probation / new<br/>[₹300]"]
        T2["Standard<br/>[≥5 trips, rating ≥4.2 → ₹1,000]"]
        T3["Elite<br/>[≥25 trips, rating ≥4.8 → ₹2,500]"]
    end

    W["Wallet balance<br/>(+ owed to driver, − owed by driver)"] --> Q{"Wallet below<br/>− tier limit?"}
    Q -->|yes, soft mode on| RD["RESTRICTED_DIGITAL_ONLY<br/>(prepaid rides only)"]
    Q -->|yes, soft mode off| SU["SUSPENDED_UNPAID_DUES"]
    RD -->|settlement, incentive or<br/>dues payment brings wallet ≥ − limit| ACT["APPROVED_ACTIVE<br/>+ made available"]
    SU -->|same rule| ACT
```

```mermaid
flowchart TD
    C["Trip completed"] --> F{"Fare ≥ streak_min_fare?<br/>[₹700]"}
    F -->|no| N["total_trips +1 only"]
    F -->|yes| Q["streak_qualifying_trips +1"]
    Q --> M{"Every 5th<br/>qualifying trip?"}
    M -->|yes| B["Streak bonus [₹150]<br/>credited to wallet"]
    M -->|no| N2["No bonus"]
    C --> RS{"Reserve < target [₹500]<br/>and BiharCabs owes driver?"}
    RS -->|yes| DED["Hold up to [₹100]<br/>into security reserve"]
```

### 2e. Cancellation and refund

Sources: `cancellations.ts`, `refunds.ts`, `cancellation-charges.ts`.

```mermaid
flowchart TD
    A["Cancel request"] --> W{"Who?"}
    W -->|"Customer replies CANCEL"| ST{"Trip started?"}
    ST -->|yes| SUP["Refused:<br/>call support"]
    ST -->|no| PREV["Customer sees refund outcome,<br/>confirms Yes, cancel"]
    W -->|"Staff on dispatch board"| FAULT{"Fault chosen"}
    PREV --> CUSTF["Fault: CUSTOMER"]
    FAULT -->|CUSTOMER| CUSTF
    FAULT -->|BIHARCABS| FULL["Full refund<br/>at any time"]
    CUSTF --> H{"≥ free_cancellation_hours<br/>before pickup? [2 h]"}
    H -->|yes| FULL
    H -->|no| KEEP["No refund:<br/>advance kept"]
    FULL --> RF["Razorpay refund<br/>(claimed once: SUBMITTING)"]
    RF -->|refund.processed| RFV["Refund voucher RF<br/>reverses the RV's GST"]
    RF -->|refund.failed| FAIL["FAILED:<br/>finance retries"]
    KEEP --> CC["Cancellation charge CC<br/>[5% GST included]"]
    CC --> EX["Excess GST (18% paid − 5% due)<br/>reclaimed on Form GST RFD-01"]
```

Every cancellation closes any unpaid Razorpay link first. It also closes pending driver offers, clears the trip OTP, and tells the customer and any assigned driver.

---

## 3. Tax calculations

### 3a. Fare split at booking

Source: `splitFare` in `fare-split.ts`, used by every booking and by return-trip discounts. GST treatment per BiharCabs' CA: BiharCabs is liable for the ride GST under CGST Sec 9(5), and the driver bears it.

```mermaid
flowchart TD
    FARE["Customer fare F<br/>(GST-inclusive)"] --> RG["Ride GST = F × pct / (100 + pct)<br/>= F × 5 / 105 [ride_fare_gst_pct 5%]"]
    FARE --> TV["Taxable value = F − Ride GST"]
    FARE --> COM["Commission = round(F × 3%)<br/>[platform_commission_pct]"]
    TF["Tech fee<br/>[₹10]"] --> CG
    COM --> CG["GST on commission + tech fee<br/>= (Commission + Tech fee) × 18%<br/>[gst_on_commission_pct, added on top]"]
    RG --> SHARE
    COM --> SHARE
    TF --> SHARE
    CG --> SHARE["BiharCabs share =<br/>Ride GST + Commission + Tech fee + GST on both"]
    SHARE --> DRV["Driver gross earnings =<br/>F − BiharCabs share"]
```

### 3b. Worked example: ₹2,500 one-way ride, intra-state (Bihar)

These figures were produced by running the real `splitFare` and `splitGst` code with the current settings.

> **GST included in a price:** `GST = amount × pct / (100 + pct)` (`gstIncluded` in `fare-split.ts`).
> The fare already contains the GST: 100 parts ride value plus *pct* parts GST. At 5%, GST is 5 of every 105 rupees, so 2,500 × 5 / 105 = ₹119.05. Taking a plain 5% of ₹2,500 (₹125) would charge GST on the GST.

```mermaid
flowchart TD
    F["Fare<br/>₹2,500.00"] --> RG["Ride GST (5% incl.)<br/>₹119.05"]
    F --> TV["Taxable value<br/>₹2,380.95"]
    F --> C["Commission 3%<br/>₹75.00"]
    T["Tech fee<br/>₹10.00"] --> G["18% on ₹85<br/>₹15.30"]
    C --> G
    RG --> S["BiharCabs share<br/>₹219.35"]
    C --> S
    T --> S
    G --> S
    S --> D["Driver gross<br/>₹2,280.65"]
```

| Step | Amount |
|---|---|
| Advance (oneway → required): max(₹200, 10% of ₹2,500) | ₹250.00 |
| GST in the advance at 18% (receipt voucher RV): amount × pct / (100 + pct) = 250 × 18 / (100 + 18) | ₹38.14 → CGST ₹19.07 + SGST ₹19.07 |
| Cash the driver collects at drop: 2,500 − 250 | ₹2,250.00 |
| Driver net for this trip: gross 2,280.65 − cash 2,250 | **+₹30.65 owed to driver** |
| Security reserve hold (if reserve < ₹500): min(₹100, deficit, ₹30.65) | up to ₹30.65 |
| Tax invoice TI: GST on the fare, amount × pct / (100 + pct) = 2,500 × 5 / (100 + 5) | ₹119.05 → CGST ₹59.53 + SGST ₹59.52 |

### 3c. Settlement and tax documents

Sources: `completeTripAndSettle` in `billing.ts`, `place-of-supply.ts`, `gst-documents.ts`.

```mermaid
flowchart TD
    CT["Complete Trip"] --> EXTRA["Extras:<br/>extra km × ₹14, extra hours × ₹150<br/>(hardcoded in billing.ts)"]
    EXTRA --> TOTAL["Customer total =<br/>fare + extras + tolls/parking"]
    EXTRA --> SH["Share = booked share +<br/>5% GST included in the extras"]
    TOTAL --> GROSS["Driver gross = total − share"]
    SH --> GROSS
    GROSS --> NET["Net = gross − cash collected<br/>− reserve hold + streak bonus"]
    NET --> WAL{"Net"}
    WAL -->|"&gt; 0"| PAY["PAYABLE_TO_DRIVER<br/>wallet up"]
    WAL -->|"&lt; 0"| REC["RECEIVABLE_FROM_DRIVER<br/>wallet down"]
    WAL -->|"= 0"| EQ["SETTLED_EXACT"]

    TOTAL --> INV["Tax invoice TI:<br/>GST = (total − tolls) × 5 / 105<br/>tolls passed through, no GST"]
    INV --> POS{"Place of supply"}
    POS -->|"customer has GSTIN"| GS["State from GSTIN<br/>(first 2 digits)"]
    POS -->|"no GSTIN"| PC["State of pickup city<br/>(place_of_supply_cities)"]
    POS -->|"unknown city /<br/>bad GSTIN"| WAIT["Invoice numbered, waits:<br/>finance chooses state"]
    GS --> SPL{"Same as BiharCabs'<br/>state [10, Bihar]?"}
    PC --> SPL
    SPL -->|yes| INTRA["CGST ½ + SGST ½"]
    SPL -->|no| INTER["IGST full"]
```

**Note:** the rates for extra km (₹14) and extra hours (₹150) are written into the code (`billing.ts:82`, `billing.ts:86`), not read from settings. Today they're only used when settlement receives closing km or extra hours. The WhatsApp **Complete Trip** button sends neither, so a bot-completed trip never charges extras.

### 3d. GST documents and series

```mermaid
flowchart TD
    subgraph Series["Numbering: SERIES + FY + 6 digits, e.g. TI2627000001 · restarts 1 April · no gaps"]
        RV["RV · Receipt voucher<br/>advance received<br/>18% incl."]
        TI["TI · Tax invoice<br/>trip settled<br/>5% incl."]
        RF["RF · Refund voucher<br/>advance refunded<br/>reverses RV GST"]
        CC["CC · Cancellation charge<br/>advance kept<br/>5% incl."]
    end
    RV -->|refund processed| RF
    RV -->|late cancel, kept| CC
    RF -. "inherits place of supply" .- RV
    CC -. "inherits place of supply" .- RV
```

---

## 4. WhatsApp + CRM: end-to-end ride cycle

A WhatsApp booking with an online advance, through completion and delivery of the GST document. Sources: `whatsapp/webhook/route.ts`, `whatsapp-bot.ts`, `advance-payments.ts`, `dispatch-engine.ts`, `trip-otp.ts`, `billing.ts`, `cron-service.ts`, `gst-delivery.ts`, `wa-notify.ts`.

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant WA as WhatsApp (Meta)
    participant CRM as CRM bot + API
    participant WP as WordPress rate card
    participant RZ as Razorpay
    participant DB as PostgreSQL
    actor D as Driver
    participant N8N as n8n scheduler

    Note over WA,CRM: Every inbound event is HMAC-checked (X-Hub-Signature-256)<br/>and processed once per message id

    rect rgba(120,160,255,0.08)
    Note over C,CRM: Booking conversation
    C->>WA: Hi / Patna to Gaya
    WA->>CRM: webhook (signed)
    CRM-->>C: Trip type? One-way / Round / Airport
    C->>CRM: trip type, origin, destination, pickup time
    CRM->>WP: quote route + cab types
    WP-->>CRM: fares
    CRM-->>C: vehicle options with fares
    C->>CRM: choose vehicle, send pickup landmark
    CRM->>DB: create customer + booking (AWAITING_ADVANCE)
    end

    rect rgba(120,200,140,0.08)
    Note over C,RZ: Advance payment
    CRM->>RZ: create payment link
    RZ-->>CRM: short URL
    CRM-->>C: booking summary + pay link
    C->>RZ: pays advance
    RZ->>CRM: payment_link.paid (signed)
    CRM->>DB: verify exact INR amount, receipt voucher RV,<br/>CONFIRMED_AWAITING_DRIVER
    CRM-->>C: advance received, assigning driver
    end

    rect rgba(255,190,90,0.10)
    Note over CRM,D: Dispatch
    CRM->>DB: find eligible drivers, AWAITING_DRIVER + SLA deadline
    CRM-->>D: ride alert [Accept] [Decline]
    D->>CRM: Accept
    CRM->>DB: re-check eligibility (row lock), DRIVER_ASSIGNED,<br/>store hashed trip OTP
    CRM-->>D: trip details, cash to collect [Start Trip]
    CRM-->>C: driver + cab details + trip OTP
    N8N->>CRM: every 5 min: SLA, wake-up checks
    CRM-->>D: 2 h before pickup: wake-up check [I am ready]
    D->>CRM: I am ready
    end

    rect rgba(200,120,255,0.08)
    Note over C,D: Trip
    D->>CRM: Start Trip
    CRM-->>D: ask customer for OTP
    C-->>D: tells OTP in person
    D->>CRM: types OTP
    CRM->>DB: verify hash (5 tries, then locked), TRIP_IN_PROGRESS
    CRM-->>C: trip started
    CRM-->>D: collect cash balance [Complete Trip]
    D->>CRM: Complete Trip
    CRM->>DB: one transaction: settle wallet, ledger entries,<br/>streak / reserve, tax invoice TI, COMPLETED_SETTLED
    CRM-->>D: settlement summary + wallet balance [Returning home]
    CRM-->>C: trip completed, invoice number, rate driver
    C->>CRM: rating
    end

    rect rgba(150,150,150,0.10)
    Note over CRM,C: GST document delivery
    N8N->>CRM: every 5 min: cron (Bearer CRON_SECRET)
    CRM->>DB: pending TI / RV / RF / CC documents
    CRM->>WA: upload PDF, send by media id
    WA-->>C: GST invoice PDF
    CRM->>DB: SENT, or retry (max 3), then FAILED → Failed messages
    end
```

**Outside the 24-hour window:** every message BiharCabs starts goes through `notify()`. Outside the 24-hour window it sends the approved template instead of free text. A template button tap is mapped back to its booking (`crm_wa_template_sends`). Any failed send is logged to `crm_notification_failures` and summarised to admins.

### 4b. Driver-side states inside WhatsApp

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Offered: ride alert
    Offered --> Declined: Decline
    Offered --> Assigned: Accept + eligible
    Offered --> Refused: Accept, no longer eligible
    Assigned --> Ready: I am ready (wake-up)
    Assigned --> AwaitingOTP: Start Trip
    Ready --> AwaitingOTP: Start Trip
    AwaitingOTP --> AwaitingOTP: wrong OTP (tries left)
    AwaitingOTP --> Locked: 5 wrong OTPs, admins alerted
    Locked --> AwaitingOTP: customer replies OTP, new code
    AwaitingOTP --> InTrip: correct OTP
    InTrip --> Settled: Complete Trip
    Settled --> Returning: Returning home (if active)
    Returning --> [*]: Reached home / return ride / timeout
    Settled --> [*]
```
