"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth";
import { normalisePhone, normaliseWhatsAppUsername, toPesewas } from "@/lib/format";
import { sendBookingToGa4, ga4SendConfigured } from "@/lib/ga4";
import { attributionSchemaReady, claimAttribution, markClickClaimed } from "@/lib/claim-attribution";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const validPhone = (phone: string) => /^\+\d{10,15}$/.test(phone);
const back = (msg: string): never =>
  redirect(`/bookings/quick?error=${encodeURIComponent(msg)}`);

/**
 * One-screen booking capture for a WhatsApp booking that is already agreed.
 *
 * Does in one step what the full flow does in three (enquiry → booking →
 * confirm): matches or creates the client, records the enquiry with its ad
 * attribution, and saves the booking as confirmed so the conversion queue
 * picks it up. Nothing about attribution is guessed: only a pasted WhatsApp
 * ref links to a specific ad click; otherwise the owner's "where from" choice
 * is recorded as the lead source.
 */
export async function quickAddBooking(formData: FormData) {
  const user = await requireRole("owner", "officer");
  const supabase = supabaseServer();

  const rawPhone = s(formData, "phone");
  const phone = normalisePhone(rawPhone);
  const whatsappUsername = normaliseWhatsAppUsername(s(formData, "whatsapp_username"));
  if (rawPhone && !validPhone(phone)) back("That phone number doesn't look right. Use e.g. 024 401 0101.");
  if (!phone && !whatsappUsername) back("Add the client's phone number (or WhatsApp username).");
  if (whatsappUsername.includes(" ")) back("WhatsApp username cannot contain spaces.");

  const serviceId = s(formData, "service_id");
  if (!serviceId) back("Choose the service.");
  const { data: service } = await supabase
    .from("service").select("id, name").eq("id", serviceId).eq("active", true).maybeSingle();
  if (!service) back("That service is no longer available. Choose another.");

  const price = toPesewas(s(formData, "price"));
  if (price <= 0) back("Enter the price agreed with the client.");

  const duration = Number(formData.get("duration_min")) || 60;
  const startsAt = s(formData, "starts_at") ? new Date(s(formData, "starts_at")) : new Date();
  if (Number.isNaN(startsAt.getTime())) back("Check the date and time.");
  const endsAt = new Date(startsAt.getTime() + duration * 60000);

  const fullName = s(formData, "full_name") || (whatsappUsername ? `@${whatsappUsername.replace(/^@/, "")}` : phone);
  const locationType = s(formData, "location_type") === "hotel" ? "hotel" : "home";
  const area = s(formData, "area");
  const stage = s(formData, "stage") === "completed" ? "completed" : "confirmed";
  const paid = formData.get("paid") ? toPesewas(s(formData, "paid_amount")) || price : 0;
  const method = s(formData, "method") || "mobile_money";

  // 1. client — match on either identifier, never guess between two records
  let clientId: string | null = null;
  const lookups: { col: string; val: string }[] = [];
  if (phone) lookups.push({ col: "phone_e164", val: phone });
  if (whatsappUsername) lookups.push({ col: "whatsapp_username", val: whatsappUsername });
  const found = new Set<string>();
  for (const { col, val } of lookups) {
    const { data, error } = await supabase
      .from("client").select("id").eq(col, val).is("archived_at", null).maybeSingle();
    if (error) back(error.message);
    if (data?.id) found.add(data.id);
  }
  if (found.size > 1) back("The phone and WhatsApp username belong to two different clients. Fix the duplicate in Clients first.");
  clientId = [...found][0] ?? null;

  // 2. attribution — a pasted ref is the only thing that links to a click
  const hasAttribution = await attributionSchemaReady(supabase);
  const claimed = await claimAttribution(supabase, hasAttribution ? s(formData, "ad_ref") : "");
  const { utm: _utm, source: claimedSource, campaign: claimedCampaign, ...attribution } = claimed;
  const source = claimedSource || s(formData, "source") || "direct_unknown";
  const campaign = claimedCampaign || (source === "google_search_ads" ? "search2026" : "");

  if (!clientId) {
    const { data: created, error } = await supabase
      .from("client")
      .insert({
        full_name: fullName,
        phone_e164: phone,
        whatsapp_e164: phone,
        whatsapp_username: whatsappUsername,
        location_type: locationType,
        area,
        source,
        first_campaign: campaign,
        pref_service_id: serviceId,
      })
      .select("id").single();
    if (error) back(error.message);
    clientId = created!.id;
  }

  // 3. enquiry — kept so lead-source reporting and ad attribution stay whole
  const { data: enquiry, error: eErr } = await supabase
    .from("enquiry")
    .insert({
      full_name: fullName,
      phone_e164: phone,
      whatsapp_e164: phone,
      whatsapp_username: whatsappUsername,
      channel: "whatsapp",
      source,
      campaign,
      service_id: serviceId,
      duration_min: duration,
      preferred_at: startsAt.toISOString(),
      location_type: locationType,
      area,
      quote_pesewas: price,
      client_id: clientId,
      ...(hasAttribution ? attribution : {}),
      owner_id: user.id,
      status: "booked",
      notes: s(formData, "notes"),
    })
    .select("id").single();
  if (eErr) back(eErr.message);
  await markClickClaimed(supabase, attribution.ad_click_id, enquiry!.id);

  // 4. booking — saved as confirmed so the Google conversion queue sees it
  const { data: booking, error: bErr } = await supabase
    .from("booking")
    .insert({
      client_id: clientId,
      enquiry_id: enquiry!.id,
      service_id: serviceId,
      duration_min: duration,
      guests: 1,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      location_type: locationType,
      area,
      base_pesewas: price,
      transport_pesewas: 0,
      source,
      campaign,
      ...(hasAttribution ? {
        ad_click_id: attribution.ad_click_id,
        gclid: attribution.gclid, gbraid: attribution.gbraid, wbraid: attribution.wbraid,
      } : {}),
      status: stage,
      confirmed_at: new Date().toISOString(),
      confirmed_by: user.id,
      notes_internal: s(formData, "notes"),
      created_by: user.id,
      updated_by: user.id,
    })
    .select("id, ref").single();
  if (bErr) back(bErr.message);

  await supabase.from("enquiry").update({ booking_id: booking!.id }).eq("id", enquiry!.id);
  await supabase.from("enquiry_event").insert({
    enquiry_id: enquiry!.id, type: "status", actor_id: user.id,
    body: `Quick-added as booking ${booking!.ref}. Source: ${source}${attribution.ad_click_id ? " (linked to ad click)" : ""}.`,
  });
  await supabase.from("booking_event").insert({
    booking_id: booking!.id, actor_id: user.id,
    body: `Quick-added, status ${stage}.`,
  });

  // 5. optional payment
  if (paid > 0) {
    await supabase.from("payment").insert({
      booking_id: booking!.id, client_id: clientId,
      amount_pesewas: paid, kind: paid >= price ? "balance" : "deposit",
      method, actor_id: user.id,
    });
  }

  // 6. GA4 revenue, never allowed to fail the save
  if (ga4SendConfigured()) {
    try {
      const sent = await sendBookingToGa4({
        clientId: "", bookingRef: booking!.ref, valuePesewas: price, serviceName: service!.name,
      });
      if (sent.ok) {
        await supabase.from("booking").update({ ga4_reported_at: new Date().toISOString() }).eq("id", booking!.id);
      }
    } catch { /* booking already saved */ }
  }

  revalidatePath("/bookings");
  revalidatePath("/enquiries");
  revalidatePath("/");
  const linked = attribution.ad_click_id ? "1" : "0";
  redirect(`/bookings/quick?saved=${encodeURIComponent(booking!.ref)}&id=${booking!.id}&linked=${linked}`);
}
