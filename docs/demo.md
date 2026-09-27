# Demo data and walkthrough (FS34)

All demo data is synthetic. Names, phones, addresses and problem descriptions are
invented, and every stored AI analysis is a hand-written sample saved with
`analysisMetadata.model = "synthetic-demo-sample"` and `promptVersion = "demo-seed"`.
Nothing in the demo claims Gemini produced it, and seeding never calls Gemini.

## Running it

```bash
cd apps/api
# in .env: MONGODB_URI pointing at a dedicated demo database, DEMO_COMPANY_ID,
# DEMO_SEED_DATABASE=<that database's name>, DEMO_SEED_PASSWORD=<12+ chars>
pnpm seed:demo            # first time
pnpm seed:demo --reset    # wipe the demo data and recreate it
```

The script refuses to run when `NODE_ENV=production`, when `DEMO_SEED_DATABASE` does
not exactly match the connected database, when `DEMO_COMPANY_ID` is missing, or when
`DEMO_SEED_PASSWORD` is shorter than 12 characters. Without `--reset` it also refuses
to seed over existing demo data. `--reset` deletes only documents whose `companyId` is
the demo company or the second tenant. There is no HTTP endpoint for seeding or
resetting.

Visits, part selections, work results and invoices are created through the real
services, so the demo follows the same stock, pricing and event rules as the API.
Visit times are relative to the moment of the reset (yesterday, today, tomorrow).

## What gets seeded

**Company:** "Chillwork Demo Co." at `DEMO_COMPANY_ID`, timezone `Africa/Cairo`,
currency `EGP`, labor fee 150.00. Public registration (FS04) also lands customers
here.

**Accounts** (all `@demo.chillwork.test`, password = `DEMO_SEED_PASSWORD`):
`admin` (ADMIN), `tech.omar` and `tech.sara` (TECHNICIAN), `customer.mona` and
`customer.karim` (CUSTOMER).

**Parts catalog:** fan motor, capacitor, compressor (stock 2), refrigerant, a control
board that is out of stock (`inStock: false`), and a discontinued remote
(`isActive: false`, hidden from the catalog).

**Requests and visits:**

| Request | State | What it shows |
| ------- | ----- | ------------- |
| Mona, 2 ACs | Visit by Omar, COMPLETED yesterday | One device REPAIRED with a fan motor and a capacitor, one FAILED (part unavailable). Invoice `ISSUED`/`UNPAID`: 450.00 + 80.00 + one 150.00 labor fee = 680.00. The failed device costs nothing. |
| Karim, 1 AC | Visit by Sara, COMPLETED yesterday | Device FAILED. Zero-charge invoice, `CLOSED`/`NOT_REQUIRED`. |
| Mona, 1 AC | Visit by Sara, IN_PROGRESS today | Refrigerant picked, no result yet: try the invoice preview, record a result, complete, issue. |
| Karim, 2 ACs | Visit by Omar, SCHEDULED tomorrow | `allowedActions: ["START_VISIT"]`. |
| Mona, 1 AC | SUBMITTED, unscheduled | For the admin to book with `POST /admin/requests/:id/visits`. |

**Second tenant (isolation test data only):** "Other Tenant (isolation test data)"
with `other.admin` and `other.customer`, one part and one request. Log in as a demo
account and confirm none of it is visible.

## Suggested walkthrough

1. `admin`: check `GET /admin/company-settings` and `GET /admin/parts`, then book the
   unscheduled kitchen request with `tech.omar` (check
   `GET /admin/technicians/:id/availability` first).
2. `customer.mona`: `GET /catalog/parts` and `GET /catalog/pricing` show prices up
   front; create a new request with `POST /requests`.
3. `tech.sara`: open today's in-progress visit, `GET .../invoice-preview`, record the
   result, complete the visit, and `POST .../invoice`. Stock for the refrigerant drops
   by one (`GET /admin/parts` as admin).
4. `tech.omar`: open yesterday's invoiced visit and read `GET .../invoice`; its totals
   stay the same even after the admin changes part prices or the labor fee.

## Shared sample accounts

None of the current endpoints can delete data. The admin can still change prices,
stock and the labor fee on the shared demo company. Run `--reset` after a
walkthrough to put the demo back to its documented state.
