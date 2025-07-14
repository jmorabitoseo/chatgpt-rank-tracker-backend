// testEmail.js
require('dotenv').config();
const nodemailer = require('nodemailer');
const mg = require('nodemailer-mailgun-transport');

// derive the domain from your SMTP login if you haven't set MG_DOMAIN
const domain =
    process.env.MG_DOMAIN ||
    (process.env.MG_SMTP_LOGIN && process.env.MG_SMTP_LOGIN.split('@')[1]);
console.log('domain:----', domain);
console.log('process.env.MG_SMTP_LOGIN:----', process.env.MG_SMTP_LOGIN);
if (!domain) {
    console.error('❌ No Mailgun domain found—please set MG_DOMAIN or MG_SMTP_LOGIN');
    process.exit(1);
}

const auth = {
    auth: {
        api_key: process.env.MG_API_KEY, // your Mailgun API key (key-…)
        domain: domain                        // e.g. mg.chatgptranktracker.com
    }
};

const transporter = nodemailer.createTransport(mg(auth));

async function sendTestEmail() {
    const vars = {
        appUrl: process.env.APP_URL,
        dashboardUrl: `${process.env.APP_URL}/dashboard`,
        snapshotID: 'sd_test_123456',
        status: 'completed',
        unsubscribeUrl: process.env.UNSUBSCRIBE_URL,
        year: new Date().getFullYear(),
        prompts: [
            'Top luxury beachfront hotels',
            'Most popular family resorts',
            'Eco-friendly glamping sites'
        ]
    };

    const msg = {
        from: process.env.EMAIL_FROM,             // e.g. "ChatGPT Rank Tracker <postmaster@mg.chatgptranktracker.com>"
        to: 'hafizmuzammiljo9@gmail.com',            // ← replace with your own
        subject: `🚀 Test: Your batch ${vars.snapshotID} is ${vars.status}!`,
        template: process.env.MAILGUN_TEMPLATE_NAME,  // e.g. "batch_complete_notification"
        'h:X-Mailgun-Variables': JSON.stringify(vars)
    };

    transporter.sendMail(msg, (err, info) => {
        if (err) {
            console.error('❌ sendMail error:', err);
        } else {
            console.log('✅ sendMail info:', info);
        }
    });
}

sendTestEmail();
