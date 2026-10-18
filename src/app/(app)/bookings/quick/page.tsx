import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { Card, Field, PageHead, ErrorNote } from "@/components/ui";
import { quickAddBooking } from "./actions";

export const dynamic = "force-dynamic";

/** "YYYY-MM-DDTHH:mm" in Accra (UTC+0, no daylight saving) for datetime-local. */
const nowLocal = () => new Date().toISOString().slice(0, 16);

export default async function QuickAddBookingPage({
  searchParams,
}: { searchParams: { error?: string; saved?: string; id?: string; linked?: string } }) {
  await requireRole("owner", "officer");
  const supabase = supabaseServer();

  const [{ data: services }, { data: sources }, { data: methods }] = await Promise.all([
    supabase.from("service").select("id, name").eq("active", true).order("sort_order"),
    supabase.from("lookup_value").select("value, label").eq("kind", "lead_source").order("sort_order"),
    supabase.from("lookup_value").select("value, label").eq("kind", "payment_method").order("sort_order"),
  ]);

  return (
    <>
      <PageHead
        title="Quick add booking"
        blurb="For a booking already agreed on WhatsApp. Takes about 30 seconds."
        actions={<Link className="btn" href="/bookings">All bookings</Link>}
      />
      <ErrorNote message={searchParams.error} />

      {searchParams.saved && (
        <div className="alert ok" style={{ marginBottom: 12 }}>
          <span aria-hidden="true">✓</span>
          <span>
            Saved <Link href={`/bookings/${searchParams.id}`}><b>{searchParams.saved}</b></Link>
            {searchParams.linked === "1"
              ? " and linked to the Google ad they clicked. Google will be told about it."
              : "."}
            {" "}Add the next one below.
          </span>
        </div>
      )}

      <form action={quickAddBooking}>
        <Card>
          <div className="fsec">
            <h4>Client</h4>
            <div className="fgrid">
              <Field label="Phone" name="phone" hint="Or use the WhatsApp username below.">
                <input className="inp" id="phone" name="phone" inputMode="tel" placeholder="024 401 0101" autoFocus />
              </Field>
              <Field label="Name (optional)" name="full_name">
                <input className="inp" id="full_name" name="full_name" placeholder="Akosua" />
              </Field>
            </div>
          </div>

          <div className="fsec">
            <h4>Booking</h4>
            <div className="fgrid">
              <Field label="Service" name="service_id">
                <select className="inp" id="service_id" name="service_id" required defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {(services ?? []).map((sv) => <option key={sv.id} value={sv.id}>{sv.name}</option>)}
                </select>
              </Field>
              <Field label="Price (GHS)" name="price">
                <input className="inp num" id="price" name="price" type="number" inputMode="decimal"
                       step="0.01" min="1" required placeholder="600" />
              </Field>
              <Field label="Date & time" name="starts_at">
                <input className="inp" id="starts_at" name="starts_at" type="datetime-local" defaultValue={nowLocal()} required />
              </Field>
              <Field label="Minutes" name="duration_min">
                <input className="inp num" id="duration_min" name="duration_min" type="number" defaultValue={60} min={15} step={15} />
              </Field>
            </div>
          </div>

          <div className="fsec">
            <h4>Where they came from</h4>
            <div className="fgrid">
              <Field label="WhatsApp ref" name="ad_ref"
                     hint="If their first message ends with [ref: XXXXXX], paste it (or the whole message). This is what tells Google the ad worked.">
                <input className="inp mono" id="ad_ref" name="ad_ref" placeholder="K7QP2M" autoComplete="off" />
              </Field>
              <Field label="How they found you" name="source" hint="Used when there's no ref.">
                <select className="inp" id="source" name="source" defaultValue="direct_unknown">
                  {(sources ?? []).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </Field>
            </div>
          </div>

          <details className="fsec">
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>More (optional)</summary>
            <div className="fgrid" style={{ marginTop: 10 }}>
              <Field label="Status" name="stage">
                <select className="inp" id="stage" name="stage" defaultValue="confirmed">
                  <option value="confirmed">Confirmed (upcoming)</option>
                  <option value="completed">Already done</option>
                </select>
              </Field>
              <Field label="WhatsApp username" name="whatsapp_username" hint="Only if there's no phone number.">
                <input className="inp" id="whatsapp_username" name="whatsapp_username" placeholder="@akosua" autoComplete="off" />
              </Field>
              <Field label="Home or hotel" name="location_type">
                <select className="inp" id="location_type" name="location_type" defaultValue="home">
                  <option value="home">Home</option>
                  <option value="hotel">Hotel</option>
                </select>
              </Field>
              <Field label="Area" name="area">
                <input className="inp" id="area" name="area" placeholder="East Legon" />
              </Field>
              <Field label="Paid" name="paid">
                <label className="row" style={{ fontSize: 12.5 }}>
                  <input id="paid" type="checkbox" name="paid" /> Payment received
                </label>
              </Field>
              <Field label="Amount paid (GHS)" name="paid_amount" hint="Blank = full price.">
                <input className="inp num" id="paid_amount" name="paid_amount" type="number" step="0.01" min="0" />
              </Field>
              <Field label="Method" name="method">
                <select className="inp" id="method" name="method" defaultValue="mobile_money">
                  {(methods ?? []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ marginTop: 11 }}>
              <Field label="Notes" name="notes" hint="Access notes and preferences. No medical history.">
                <textarea className="inp" id="notes" name="notes" />
              </Field>
            </div>
          </details>

          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn pri" type="submit">Save booking</button>
          </div>
        </Card>
      </form>
    </>
  );
}
