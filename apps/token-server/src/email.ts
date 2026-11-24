// Booking confirmation email, sent with Resend.
// Without a verified domain, Resend only delivers to the address that owns the Resend account,
// so other recipients fail. That failure is logged and never undoes a paid booking.
import { formatPeso } from '@hello-po/shared';
import { Resend } from 'resend';
import type { BookingRecord } from './bookings.ts';

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM ?? 'Isla Azul Beach Resort <onboarding@resend.dev>';
const resend = apiKey ? new Resend(apiKey) : undefined;

export const emailEnabled = Boolean(resend);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

export function renderConfirmation(b: BookingRecord) {
  const balance = b.total_amount - b.amount_paid;
  const rows: [string, string][] = [
    ['Booking code', b.code],
    ['Guest', b.guest_name],
    ['Room', b.room_type_name],
    ['Check-in', `${longDate(b.check_in)}, from 2 PM`],
    ['Check-out', `${longDate(b.check_out)}, by 12 noon`],
    ['Guests', String(b.guests)],
    ['Total', formatPeso(b.total_amount)],
    ['Paid', formatPeso(b.amount_paid)],
    ['Due at check-in', formatPeso(balance)],
  ];
  const subject = `Booking confirmed: ${b.code} at Isla Azul Beach Resort`;
  const html = `<!doctype html>
<html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#0e7490;color:#ffffff;padding:24px">
          <div style="font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:.85">Isla Azul Beach Resort</div>
          <div style="font-size:22px;font-weight:bold;margin-top:6px">Your stay is confirmed</div>
        </td></tr>
        <tr><td style="padding:24px">
          <p style="margin:0 0 16px">Hi ${escapeHtml(b.guest_name.split(' ')[0] ?? b.guest_name)}, thank you for booking with us. Here are your details:</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
            ${rows
              .map(
                ([k, v]) =>
                  `<tr><td style="padding:8px 0;color:#64748b;border-bottom:1px solid #e2e8f0">${k}</td><td style="padding:8px 0;text-align:right;font-weight:bold;border-bottom:1px solid #e2e8f0">${escapeHtml(v)}</td></tr>`,
              )
              .join('')}
          </table>
          <p style="margin:16px 0 0;font-size:13px;color:#64748b">Free cancellation up to 7 days before arrival; after that the first night is charged. Questions? Call the front desk any time, 24 hours a day.</p>
        </td></tr>
        <tr><td style="padding:16px 24px;background:#f8fafc;font-size:12px;color:#94a3b8">This is a demo booking from the Hello Po portfolio project. No real reservation or payment was made.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  const text = [
    'Your stay at Isla Azul Beach Resort is confirmed.',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    'This is a demo booking from the Hello Po portfolio project. No real reservation or payment was made.',
  ].join('\n');
  return { subject, html, text };
}

export async function sendConfirmation(b: BookingRecord): Promise<boolean> {
  if (!resend || !b.guest_email) {
    console.log(
      `[email] skipped for ${b.code} (${resend ? 'no address' : 'RESEND_API_KEY not set'})`,
    );
    return false;
  }
  const { subject, html, text } = renderConfirmation(b);
  const { error } = await resend.emails.send({ from, to: b.guest_email, subject, html, text });
  if (error) {
    console.warn(`[email] ${b.code} not sent: ${error.message}`);
    return false;
  }
  console.log(`[email] confirmation for ${b.code} sent`);
  return true;
}
