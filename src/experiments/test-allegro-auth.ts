// Minimal Allegro auth test with verbose logging
// Run: npx tsx src/experiments/test-allegro-auth.ts

import 'dotenv/config';

const CLIENT_ID = process.env.ALLEGRO_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.ALLEGRO_CLIENT_SECRET ?? '';
const AUTH_HEADER = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

async function main() {
  console.log(`Client ID: ${CLIENT_ID.slice(0, 8)}...`);

  // Step 1: Get device code
  const dcRes = await fetch('https://allegro.pl/auth/oauth/device', {
    method: 'POST',
    headers: {
      'Authorization': AUTH_HEADER,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'client_id=' + CLIENT_ID,
  });

  console.log(`Device code response: ${dcRes.status}`);
  const dcBody = await dcRes.text();
  console.log(`Body: ${dcBody.slice(0, 500)}`);

  if (!dcRes.ok) {
    console.error('Failed to get device code');
    return;
  }

  const dc = JSON.parse(dcBody);
  console.log(`\nOpen: ${dc.verification_uri_complete}`);
  console.log(`Code: ${dc.user_code}`);
  console.log(`Interval: ${dc.interval}s`);
  console.log(`Expires: ${dc.expires_in}s`);
  console.log('\nWaiting for authorization...\n');

  // Step 2: Poll for token
  let interval = dc.interval || 5;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const tokenRes = await fetch('https://allegro.pl/auth/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': AUTH_HEADER,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${dc.device_code}`,
    });

    const tokenBody = await tokenRes.text();
    console.log(`Poll ${i + 1}: ${tokenRes.status} — ${tokenBody.slice(0, 200)}`);

    if (tokenRes.status === 200) {
      const token = JSON.parse(tokenBody);
      // Save it
      const { writeFileSync, mkdirSync } = await import('fs');
      mkdirSync('.local/sessions', { recursive: true });
      writeFileSync('.local/sessions/allegro-token.json', JSON.stringify({
        ...token,
        expires_at: Date.now() + token.expires_in * 1000,
      }, null, 2), { encoding: 'utf-8' });
      console.log('\nToken saved to .local/sessions/allegro-token.json');
      console.log(`Expires in: ${Math.round(token.expires_in / 3600)}h`);
      return;
    }

    const parsed = JSON.parse(tokenBody);
    if (parsed.error === 'slow_down') interval += 1;
    if (parsed.error === 'expired_token') { console.error('Expired'); return; }
    if (parsed.error === 'access_denied') { console.error('Denied'); return; }
  }
}

main().catch(console.error);
