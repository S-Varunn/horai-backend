/**
 * Placeholder for email service.
 * In a real app, you would use Nodemailer, SendGrid, Resend, etc.
 */
async function send2FACode(email, code) {
  console.log(`[EMAIL SERVICE] Sending 2FA code ${code} to ${email}`);
  
  // Example with Nodemailer (commented out):
  /*
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: '"Timesheet Tracker" <noreply@timesheet.tracker>',
    to: email,
    subject: "Your 2FA Verification Code",
    text: `Your verification code is: ${code}. It expires in 10 minutes.`,
  });
  */
}

module.exports = { send2FACode };
